-- ============================================================================
-- Puestos Almacen - FASE 1
-- Jornadas operativas, periodos/tareas, pausas, terminales, credenciales
-- y historial de correcciones.
--
-- Principios:
--   * La planificacion existente sigue siendo la fuente de verdad.
--   * La operativa NO modifica la rueda teorica.
--   * Los tiempos reales salen de timestamps de PostgreSQL.
--   * Un trabajador solo puede tener una jornada abierta.
--   * Una jornada solo puede tener un periodo activo y una pausa abierta.
--   * Los terminales no escriben directamente en las tablas: usan RPC.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- Preflight: la aplicacion existente utiliza employees como maestro de personal.
-- Esta fase necesita que employees.id sea UUID para conservar integridad referencial.
-- --------------------------------------------------------------------------
do $$
declare
  employee_id_type text;
begin
  if to_regclass('public.employees') is null then
    raise exception 'FASE 1: no existe public.employees.';
  end if;

  select columns.udt_name
    into employee_id_type
  from information_schema.columns as columns
  where columns.table_schema = 'public'
    and columns.table_name = 'employees'
    and columns.column_name = 'id';

  if employee_id_type is distinct from 'uuid' then
    raise exception 'FASE 1: public.employees.id debe ser uuid; tipo actual: %', coalesce(employee_id_type, 'desconocido');
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- Montajes como asignacion manual existente, SIN introducirlo en la rueda.
-- Soporta tanto assignment_code text como un enum PostgreSQL.
-- --------------------------------------------------------------------------
do $$
declare
  assignment_data_type text;
  assignment_udt_schema text;
  assignment_udt_name text;
  check_row record;
begin
  if to_regclass('public.daily_assignment_overrides') is null then
    raise exception 'FASE 1: no existe public.daily_assignment_overrides.';
  end if;

  select
    columns.data_type,
    columns.udt_schema,
    columns.udt_name
  into
    assignment_data_type,
    assignment_udt_schema,
    assignment_udt_name
  from information_schema.columns as columns
  where columns.table_schema = 'public'
    and columns.table_name = 'daily_assignment_overrides'
    and columns.column_name = 'assignment_code';

  if assignment_data_type = 'USER-DEFINED' then
    execute format(
      'alter type %I.%I add value if not exists %L',
      assignment_udt_schema,
      assignment_udt_name,
      'montajes'
    );
  else
    for check_row in
      select constraints.conname
      from pg_constraint as constraints
      where constraints.conrelid = 'public.daily_assignment_overrides'::regclass
        and constraints.contype = 'c'
        and pg_get_constraintdef(constraints.oid) ilike '%assignment_code%'
    loop
      execute format(
        'alter table public.daily_assignment_overrides drop constraint %I',
        check_row.conname
      );
    end loop;

    alter table public.daily_assignment_overrides
      add constraint daily_assignment_overrides_assignment_code_allowed
      check (
        assignment_code in (
          'mesa1',
          'mesa2',
          'mesa3',
          'mesa4',
          'entradas',
          'picking',
          'montajes',
          'reinforcement_entradas',
          'reinforcement_picking',
          'pending_task'
        )
      );
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- Utilidad updated_at.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_set_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.warehouse_set_updated_at() from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- Terminales fisicos.
-- fixed_pc: el puesto fisico esta fijado en el terminal.
-- rf: el puesto se escanea/selecciona durante el uso.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_terminals (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  terminal_type text not null,
  fixed_area_code text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint warehouse_terminals_code_not_blank
    check (btrim(code) <> ''),
  constraint warehouse_terminals_name_not_blank
    check (btrim(name) <> ''),
  constraint warehouse_terminals_type_allowed
    check (terminal_type in ('fixed_pc', 'rf')),
  constraint warehouse_terminals_area_allowed
    check (
      fixed_area_code is null
      or fixed_area_code in (
        'gestor', 'mesa1', 'mesa2', 'mesa3', 'mesa4',
        'entradas', 'picking', 'montajes'
      )
    ),
  constraint warehouse_terminals_fixed_area_consistent
    check (
      (terminal_type = 'fixed_pc' and fixed_area_code is not null)
      or
      (terminal_type = 'rf' and fixed_area_code is null)
    )
);

drop trigger if exists warehouse_terminals_set_updated_at on public.warehouse_terminals;

create trigger warehouse_terminals_set_updated_at
before update on public.warehouse_terminals
for each row execute function public.warehouse_set_updated_at();

-- --------------------------------------------------------------------------
-- Credenciales de operario para lectura por codigo de barras.
-- username_code puede imprimirse; password_hash NUNCA contiene la clave legible.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_employee_credentials (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null unique
    references public.employees(id) on delete restrict,
  username_code text not null unique,
  password_hash text not null,
  active boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint warehouse_employee_credentials_username_not_blank
    check (btrim(username_code) <> ''),
  constraint warehouse_employee_credentials_password_hash_not_blank
    check (btrim(password_hash) <> ''),
  constraint warehouse_employee_credentials_failed_attempts_nonnegative
    check (failed_attempts >= 0)
);

drop trigger if exists warehouse_employee_credentials_set_updated_at on public.warehouse_employee_credentials;

create trigger warehouse_employee_credentials_set_updated_at
before update on public.warehouse_employee_credentials
for each row execute function public.warehouse_set_updated_at();

-- --------------------------------------------------------------------------
-- Sesion de autenticacion en terminal.
-- Iniciar sesion en otro terminal revoca la anterior, pero NO finaliza la jornada.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_terminal_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null
    references public.employees(id) on delete restrict,
  terminal_id uuid not null
    references public.warehouse_terminals(id) on delete restrict,
  token_hash bytea not null unique,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,

  constraint warehouse_terminal_sessions_expiry_valid
    check (expires_at > started_at),
  constraint warehouse_terminal_sessions_revoked_valid
    check (revoked_at is null or revoked_at >= started_at)
);

create index if not exists warehouse_terminal_sessions_employee_active_idx
  on public.warehouse_terminal_sessions(employee_id, expires_at desc)
  where revoked_at is null;

-- --------------------------------------------------------------------------
-- Jornada operativa.
-- operational_date NO se deriva de started_at para soportar turno de noche.
-- planned_assignment_code es snapshot de lo que indicaba la planificacion al alta.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_work_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null
    references public.employees(id) on delete restrict,
  operational_date date not null,
  shift_code text not null,
  planned_assignment_code text not null,
  status text not null default 'working',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  closed_automatically boolean not null default false,
  started_terminal_id uuid
    references public.warehouse_terminals(id) on delete restrict,
  last_terminal_id uuid
    references public.warehouse_terminals(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint warehouse_work_sessions_shift_allowed
    check (shift_code in ('morning', 'afternoon', 'night')),
  constraint warehouse_work_sessions_assignment_allowed
    check (
      planned_assignment_code in (
        'gestor',
        'mesa1', 'mesa2', 'mesa3', 'mesa4',
        'entradas', 'picking', 'montajes',
        'reinforcement_entradas', 'reinforcement_picking',
        'pending_task'
      )
    ),
  constraint warehouse_work_sessions_status_allowed
    check (status in ('working', 'break', 'completed')),
  constraint warehouse_work_sessions_end_consistent
    check (
      (status <> 'completed' and ended_at is null)
      or
      (status = 'completed' and ended_at is not null and ended_at >= started_at)
    ),
  constraint warehouse_work_sessions_employee_date_unique
    unique (employee_id, operational_date)
);

create unique index if not exists warehouse_work_sessions_one_open_per_employee_idx
  on public.warehouse_work_sessions(employee_id)
  where status <> 'completed';

create index if not exists warehouse_work_sessions_date_shift_idx
  on public.warehouse_work_sessions(operational_date, shift_code, status);

drop trigger if exists warehouse_work_sessions_set_updated_at on public.warehouse_work_sessions;

create trigger warehouse_work_sessions_set_updated_at
before update on public.warehouse_work_sessions
for each row execute function public.warehouse_set_updated_at();

-- --------------------------------------------------------------------------
-- Periodos reales de puesto/tarea.
-- El mismo trabajador puede cambiar de puesto o modo sin cerrar la jornada.
-- Ejemplo: Mesa 4 / Modo Carro -> Mesa 4 / Modo Exportacion -> Montajes.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_work_periods (
  id uuid primary key default gen_random_uuid(),
  work_session_id uuid not null
    references public.warehouse_work_sessions(id) on delete restrict,
  area_code text not null,
  mode_code text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  started_terminal_id uuid
    references public.warehouse_terminals(id) on delete restrict,
  ended_terminal_id uuid
    references public.warehouse_terminals(id) on delete restrict,
  change_source text not null default 'operator',
  created_at timestamptz not null default now(),

  constraint warehouse_work_periods_area_allowed
    check (
      area_code in (
        'gestor', 'mesa1', 'mesa2', 'mesa3', 'mesa4',
        'entradas', 'picking', 'montajes'
      )
    ),
  constraint warehouse_work_periods_mode_allowed
    check (mode_code in ('standard', 'cart', 'export', 'support')),
  constraint warehouse_work_periods_source_allowed
    check (change_source in ('initial', 'operator', 'automatic', 'correction')),
  constraint warehouse_work_periods_end_valid
    check (ended_at is null or ended_at >= started_at)
);

create unique index if not exists warehouse_work_periods_one_open_per_session_idx
  on public.warehouse_work_periods(work_session_id)
  where ended_at is null;

create index if not exists warehouse_work_periods_session_time_idx
  on public.warehouse_work_periods(work_session_id, started_at);

-- --------------------------------------------------------------------------
-- Tipos de pausa configurables.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_break_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint warehouse_break_types_code_not_blank
    check (btrim(code) <> ''),
  constraint warehouse_break_types_label_not_blank
    check (btrim(label) <> ''),
  constraint warehouse_break_types_display_order_nonnegative
    check (display_order >= 0)
);

drop trigger if exists warehouse_break_types_set_updated_at on public.warehouse_break_types;

create trigger warehouse_break_types_set_updated_at
before update on public.warehouse_break_types
for each row execute function public.warehouse_set_updated_at();

insert into public.warehouse_break_types(code, label, active, display_order)
values
  ('meal', 'Desayuno / Comida / Cena', true, 10),
  ('smoking_vaping', 'Fumar / Vapear', true, 20)
on conflict (code) do update
set
  label = excluded.label,
  active = excluded.active,
  display_order = excluded.display_order;

-- --------------------------------------------------------------------------
-- Pausas individuales.
-- El periodo de puesto permanece abierto durante la pausa; el tiempo efectivo
-- se calculara restando los intervalos de pausa.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_work_breaks (
  id uuid primary key default gen_random_uuid(),
  work_session_id uuid not null
    references public.warehouse_work_sessions(id) on delete restrict,
  break_type_id uuid not null
    references public.warehouse_break_types(id) on delete restrict,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  closed_automatically boolean not null default false,
  close_reason text,
  created_at timestamptz not null default now(),

  constraint warehouse_work_breaks_end_valid
    check (ended_at is null or ended_at >= started_at),
  constraint warehouse_work_breaks_close_reason_valid
    check (
      close_reason is null
      or close_reason in ('operator', 'session_finished', 'automatic', 'correction')
    )
);

create unique index if not exists warehouse_work_breaks_one_open_per_session_idx
  on public.warehouse_work_breaks(work_session_id)
  where ended_at is null;

create index if not exists warehouse_work_breaks_session_time_idx
  on public.warehouse_work_breaks(work_session_id, started_at);

-- --------------------------------------------------------------------------
-- Horarios configurables para el futuro cierre automatico.
-- No se siembran horas: deben definirse con los horarios reales del almacen.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_shift_schedules (
  id uuid primary key default gen_random_uuid(),
  shift_code text not null,
  valid_from date not null,
  valid_to date,
  start_time time not null,
  end_time time not null,
  auto_close_grace_minutes integer not null default 30,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint warehouse_shift_schedules_shift_allowed
    check (shift_code in ('morning', 'afternoon', 'night')),
  constraint warehouse_shift_schedules_dates_valid
    check (valid_to is null or valid_to >= valid_from),
  constraint warehouse_shift_schedules_grace_valid
    check (auto_close_grace_minutes between 0 and 240),
  constraint warehouse_shift_schedules_unique_start
    unique (shift_code, valid_from)
);

drop trigger if exists warehouse_shift_schedules_set_updated_at on public.warehouse_shift_schedules;

create trigger warehouse_shift_schedules_set_updated_at
before update on public.warehouse_shift_schedules
for each row execute function public.warehouse_set_updated_at();

-- --------------------------------------------------------------------------
-- Historial de correcciones (nombre visible en la aplicacion).
-- Se conserva original/nuevo, actor, fecha y motivo. Es inmutable.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_corrections (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  field_name text not null,
  original_value jsonb,
  corrected_value jsonb,
  reason text not null,
  actor_employee_id uuid
    references public.employees(id) on delete restrict,
  actor_name_snapshot text not null,
  created_at timestamptz not null default now(),

  constraint warehouse_corrections_entity_type_allowed
    check (entity_type in ('work_session', 'work_period', 'work_break')),
  constraint warehouse_corrections_field_not_blank
    check (btrim(field_name) <> ''),
  constraint warehouse_corrections_reason_not_blank
    check (btrim(reason) <> ''),
  constraint warehouse_corrections_actor_not_blank
    check (btrim(actor_name_snapshot) <> '')
);

create index if not exists warehouse_corrections_entity_idx
  on public.warehouse_corrections(entity_type, entity_id, created_at desc);

create or replace function public.warehouse_guard_corrections_immutable()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  raise exception 'El Historial de correcciones es inmutable.';
end;
$$;

revoke all on function public.warehouse_guard_corrections_immutable() from public, anon, authenticated;

drop trigger if exists warehouse_corrections_immutable on public.warehouse_corrections;

create trigger warehouse_corrections_immutable
before update or delete on public.warehouse_corrections
for each row execute function public.warehouse_guard_corrections_immutable();

-- --------------------------------------------------------------------------
-- Funciones de normalizacion/validacion.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_assignment_expected_area(target_assignment_code text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select case target_assignment_code
    when 'gestor' then 'gestor'
    when 'mesa1' then 'mesa1'
    when 'mesa2' then 'mesa2'
    when 'mesa3' then 'mesa3'
    when 'mesa4' then 'mesa4'
    when 'entradas' then 'entradas'
    when 'picking' then 'picking'
    when 'montajes' then 'montajes'
    when 'reinforcement_entradas' then 'entradas'
    when 'reinforcement_picking' then 'picking'
    else null
  end;
$$;

revoke all on function public.warehouse_assignment_expected_area(text) from public, anon, authenticated;

create or replace function public.warehouse_default_mode(target_area_code text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select case
    when target_area_code in ('mesa1', 'mesa2', 'mesa3', 'mesa4') then 'cart'
    else 'standard'
  end;
$$;

revoke all on function public.warehouse_default_mode(text) from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- LOGIN de terminal por dos codigos: usuario + password.
-- Devuelve un token temporal. En otro terminal revoca el token anterior,
-- pero conserva cualquier jornada abierta.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_terminal_login(
  target_username_code text,
  target_password_code text,
  target_terminal_code text
)
returns table (
  terminal_session_token text,
  employee_id uuid,
  employee_name text,
  terminal_id uuid,
  terminal_type text,
  fixed_area_code text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  credential_row public.warehouse_employee_credentials%rowtype;
  employee_row public.employees%rowtype;
  terminal_row public.warehouse_terminals%rowtype;
  plain_token text;
  expiry_value timestamptz;
begin
  if nullif(btrim(target_username_code), '') is null
     or nullif(target_password_code, '') is null
     or nullif(btrim(target_terminal_code), '') is null then
    raise exception 'Credenciales o terminal incompletos.';
  end if;

  select credentials.*
    into credential_row
  from public.warehouse_employee_credentials as credentials
  where credentials.username_code = btrim(target_username_code)
    and credentials.active
  limit 1;

  if not found then
    raise exception 'Usuario o password incorrectos.';
  end if;

  if credential_row.locked_until is not null
     and credential_row.locked_until > now() then
    raise exception 'Credencial bloqueada temporalmente.';
  end if;

  if credential_row.password_hash <> crypt(target_password_code, credential_row.password_hash) then
    update public.warehouse_employee_credentials
    set
      failed_attempts = failed_attempts + 1,
      locked_until = case
        when failed_attempts + 1 >= 5 then now() + interval '15 minutes'
        else null
      end
    where id = credential_row.id;

    raise exception 'Usuario o password incorrectos.';
  end if;

  select employees.*
    into employee_row
  from public.employees as employees
  where employees.id = credential_row.employee_id
    and employees.active
  limit 1;

  if not found then
    raise exception 'El trabajador no esta activo.';
  end if;

  select terminals.*
    into terminal_row
  from public.warehouse_terminals as terminals
  where terminals.code = btrim(target_terminal_code)
    and terminals.active
  limit 1;

  if not found then
    raise exception 'Terminal no valido o inactivo.';
  end if;

  update public.warehouse_employee_credentials
  set failed_attempts = 0, locked_until = null
  where id = credential_row.id;

  update public.warehouse_terminal_sessions
  set revoked_at = now()
  where warehouse_terminal_sessions.employee_id = employee_row.id
    and revoked_at is null;

  plain_token := encode(gen_random_bytes(32), 'hex');
  expiry_value := now() + interval '16 hours';

  insert into public.warehouse_terminal_sessions(
    employee_id,
    terminal_id,
    token_hash,
    expires_at
  ) values (
    employee_row.id,
    terminal_row.id,
    digest(plain_token, 'sha256'),
    expiry_value
  );

  return query
  select
    plain_token,
    employee_row.id,
    employee_row.name,
    terminal_row.id,
    terminal_row.terminal_type,
    terminal_row.fixed_area_code,
    expiry_value;
end;
$$;

revoke all on function public.warehouse_terminal_login(text, text, text) from public;
grant execute on function public.warehouse_terminal_login(text, text, text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Cerrar autenticacion del terminal SIN cerrar jornada.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_terminal_logout(target_session_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  update public.warehouse_terminal_sessions
  set revoked_at = now()
  where token_hash = digest(target_session_token, 'sha256')
    and revoked_at is null;
end;
$$;

revoke all on function public.warehouse_terminal_logout(text) from public;
grant execute on function public.warehouse_terminal_logout(text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Estado actual para recuperar jornada/pausa/tarea tras recarga o cambio de PC.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_get_current_state(target_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  actor_terminal_id uuid;
  session_row public.warehouse_work_sessions%rowtype;
  period_row public.warehouse_work_periods%rowtype;
  break_row public.warehouse_work_breaks%rowtype;
begin
  select terminal_sessions.employee_id, terminal_sessions.terminal_id
    into actor_employee_id, actor_terminal_id
  from public.warehouse_terminal_sessions as terminal_sessions
  where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
    and terminal_sessions.revoked_at is null
    and terminal_sessions.expires_at > now()
  limit 1;

  if not found then
    raise exception 'Sesion de terminal no valida o caducada.';
  end if;

  update public.warehouse_terminal_sessions
  set last_seen_at = now()
  where token_hash = digest(target_session_token, 'sha256');

  select work_sessions.*
    into session_row
  from public.warehouse_work_sessions as work_sessions
  where work_sessions.employee_id = actor_employee_id
    and work_sessions.status <> 'completed'
  order by work_sessions.started_at desc
  limit 1;

  if session_row.id is null then
    return jsonb_build_object(
      'work_session', null,
      'current_period', null,
      'current_break', null,
      'terminal_id', actor_terminal_id
    );
  end if;

  select periods.*
    into period_row
  from public.warehouse_work_periods as periods
  where periods.work_session_id = session_row.id
    and periods.ended_at is null
  limit 1;

  select breaks.*
    into break_row
  from public.warehouse_work_breaks as breaks
  where breaks.work_session_id = session_row.id
    and breaks.ended_at is null
  limit 1;

  return jsonb_build_object(
    'work_session', to_jsonb(session_row),
    'current_period', case when period_row.id is null then null else to_jsonb(period_row) end,
    'current_break', case when break_row.id is null then null else to_jsonb(break_row) end,
    'terminal_id', actor_terminal_id
  );
end;
$$;

revoke all on function public.warehouse_get_current_state(text) from public;
grant execute on function public.warehouse_get_current_state(text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Tipos de pausa visibles para un terminal autenticado.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_get_break_types(target_session_token text)
returns table (code text, label text, display_order integer)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.warehouse_terminal_sessions as terminal_sessions
    where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
      and terminal_sessions.revoked_at is null
      and terminal_sessions.expires_at > now()
  ) then
    raise exception 'Sesion de terminal no valida o caducada.';
  end if;

  return query
  select break_types.code, break_types.label, break_types.display_order
  from public.warehouse_break_types as break_types
  where break_types.active
  order by break_types.display_order, break_types.label;
end;
$$;

revoke all on function public.warehouse_get_break_types(text) from public;
grant execute on function public.warehouse_get_break_types(text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Iniciar jornada. Si ya existe una abierta, se recupera y no se duplica.
-- La validacion fisica compara puesto planificado (snapshot recibido de la
-- misma logica del monitor) con el area actual. En PC fijo tambien valida el PC.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_start_work_session(
  target_session_token text,
  target_operational_date date,
  target_shift_code text,
  target_planned_assignment_code text,
  target_area_code text,
  target_mode_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  actor_terminal_id uuid;
  actor_terminal_type text;
  actor_fixed_area text;
  expected_area text;
  effective_mode text;
  existing_session_id uuid;
  created_session_id uuid;
begin
  select
    terminal_sessions.employee_id,
    terminal_sessions.terminal_id,
    terminals.terminal_type,
    terminals.fixed_area_code
  into
    actor_employee_id,
    actor_terminal_id,
    actor_terminal_type,
    actor_fixed_area
  from public.warehouse_terminal_sessions as terminal_sessions
  join public.warehouse_terminals as terminals
    on terminals.id = terminal_sessions.terminal_id
  where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
    and terminal_sessions.revoked_at is null
    and terminal_sessions.expires_at > now()
    and terminals.active
  limit 1;

  if not found then
    raise exception 'Sesion de terminal no valida o caducada.';
  end if;

  select work_sessions.id
    into existing_session_id
  from public.warehouse_work_sessions as work_sessions
  where work_sessions.employee_id = actor_employee_id
    and work_sessions.status <> 'completed'
  limit 1;

  if existing_session_id is not null then
    update public.warehouse_work_sessions
    set last_terminal_id = actor_terminal_id
    where id = existing_session_id;

    return existing_session_id;
  end if;

  if target_shift_code not in ('morning', 'afternoon', 'night') then
    raise exception 'Turno no valido.';
  end if;

  if target_area_code not in (
    'gestor', 'mesa1', 'mesa2', 'mesa3', 'mesa4',
    'entradas', 'picking', 'montajes'
  ) then
    raise exception 'Puesto/area no valido.';
  end if;

  expected_area := public.warehouse_assignment_expected_area(target_planned_assignment_code);

  if expected_area is null then
    raise exception 'La planificacion no tiene un puesto operativo concreto. El responsable debe asignarlo antes del alta.';
  end if;

  if expected_area <> target_area_code then
    raise exception 'Puesto incorrecto. Planificado: %, terminal/area actual: %.', expected_area, target_area_code;
  end if;

  if actor_terminal_type = 'fixed_pc' and actor_fixed_area <> target_area_code then
    raise exception 'Este PC pertenece a % y no a %.', actor_fixed_area, target_area_code;
  end if;

  effective_mode := coalesce(
    nullif(target_mode_code, ''),
    public.warehouse_default_mode(target_area_code)
  );

  if effective_mode not in ('standard', 'cart', 'export', 'support') then
    raise exception 'Modo de trabajo no valido.';
  end if;

  insert into public.warehouse_work_sessions(
    employee_id,
    operational_date,
    shift_code,
    planned_assignment_code,
    status,
    started_terminal_id,
    last_terminal_id
  ) values (
    actor_employee_id,
    target_operational_date,
    target_shift_code,
    target_planned_assignment_code,
    'working',
    actor_terminal_id,
    actor_terminal_id
  )
  returning id into created_session_id;

  insert into public.warehouse_work_periods(
    work_session_id,
    area_code,
    mode_code,
    started_terminal_id,
    change_source
  ) values (
    created_session_id,
    target_area_code,
    effective_mode,
    actor_terminal_id,
    'initial'
  );

  return created_session_id;
end;
$$;

revoke all on function public.warehouse_start_work_session(text, date, text, text, text, text) from public;
grant execute on function public.warehouse_start_work_session(text, date, text, text, text, text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Cambiar de puesto/tarea/modo SIN finalizar jornada.
-- Permite hacerlo desde el mismo PC o desde otro PC/RF.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_change_work_context(
  target_session_token text,
  target_area_code text,
  target_mode_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  actor_terminal_id uuid;
  work_session_row public.warehouse_work_sessions%rowtype;
  current_period_row public.warehouse_work_periods%rowtype;
  new_period_id uuid;
begin
  select terminal_sessions.employee_id, terminal_sessions.terminal_id
    into actor_employee_id, actor_terminal_id
  from public.warehouse_terminal_sessions as terminal_sessions
  where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
    and terminal_sessions.revoked_at is null
    and terminal_sessions.expires_at > now()
  limit 1;

  if not found then
    raise exception 'Sesion de terminal no valida o caducada.';
  end if;

  if target_area_code not in (
    'gestor', 'mesa1', 'mesa2', 'mesa3', 'mesa4',
    'entradas', 'picking', 'montajes'
  ) then
    raise exception 'Puesto/area no valido.';
  end if;

  if target_mode_code not in ('standard', 'cart', 'export', 'support') then
    raise exception 'Modo de trabajo no valido.';
  end if;

  select work_sessions.*
    into work_session_row
  from public.warehouse_work_sessions as work_sessions
  where work_sessions.employee_id = actor_employee_id
    and work_sessions.status <> 'completed'
  for update
  limit 1;

  if work_session_row.id is null then
    raise exception 'No hay una jornada abierta.';
  end if;

  if work_session_row.status = 'break' then
    raise exception 'Finaliza la pausa antes de cambiar de tarea.';
  end if;

  select periods.*
    into current_period_row
  from public.warehouse_work_periods as periods
  where periods.work_session_id = work_session_row.id
    and periods.ended_at is null
  for update
  limit 1;

  if current_period_row.id is not null
     and current_period_row.area_code = target_area_code
     and current_period_row.mode_code = target_mode_code then
    update public.warehouse_work_sessions
    set last_terminal_id = actor_terminal_id
    where id = work_session_row.id;

    return current_period_row.id;
  end if;

  if current_period_row.id is not null then
    update public.warehouse_work_periods
    set
      ended_at = now(),
      ended_terminal_id = actor_terminal_id
    where id = current_period_row.id;
  end if;

  insert into public.warehouse_work_periods(
    work_session_id,
    area_code,
    mode_code,
    started_terminal_id,
    change_source
  ) values (
    work_session_row.id,
    target_area_code,
    target_mode_code,
    actor_terminal_id,
    'operator'
  )
  returning id into new_period_id;

  update public.warehouse_work_sessions
  set last_terminal_id = actor_terminal_id
  where id = work_session_row.id;

  return new_period_id;
end;
$$;

revoke all on function public.warehouse_change_work_context(text, text, text) from public;
grant execute on function public.warehouse_change_work_context(text, text, text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Iniciar pausa.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_start_break(
  target_session_token text,
  target_break_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  work_session_row public.warehouse_work_sessions%rowtype;
  break_type_id uuid;
  created_break_id uuid;
begin
  select terminal_sessions.employee_id
    into actor_employee_id
  from public.warehouse_terminal_sessions as terminal_sessions
  where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
    and terminal_sessions.revoked_at is null
    and terminal_sessions.expires_at > now()
  limit 1;

  if not found then
    raise exception 'Sesion de terminal no valida o caducada.';
  end if;

  select work_sessions.*
    into work_session_row
  from public.warehouse_work_sessions as work_sessions
  where work_sessions.employee_id = actor_employee_id
    and work_sessions.status <> 'completed'
  for update
  limit 1;

  if work_session_row.id is null then
    raise exception 'No hay una jornada abierta.';
  end if;

  if work_session_row.status = 'break' then
    raise exception 'Ya existe una pausa abierta.';
  end if;

  select break_types.id
    into break_type_id
  from public.warehouse_break_types as break_types
  where break_types.code = target_break_code
    and break_types.active
  limit 1;

  if break_type_id is null then
    raise exception 'Tipo de pausa no valido.';
  end if;

  insert into public.warehouse_work_breaks(
    work_session_id,
    break_type_id
  ) values (
    work_session_row.id,
    break_type_id
  )
  returning id into created_break_id;

  update public.warehouse_work_sessions
  set status = 'break'
  where id = work_session_row.id;

  return created_break_id;
end;
$$;

revoke all on function public.warehouse_start_break(text, text) from public;
grant execute on function public.warehouse_start_break(text, text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Finalizar pausa.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_end_break(target_session_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  work_session_id uuid;
  current_break_id uuid;
begin
  select terminal_sessions.employee_id
    into actor_employee_id
  from public.warehouse_terminal_sessions as terminal_sessions
  where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
    and terminal_sessions.revoked_at is null
    and terminal_sessions.expires_at > now()
  limit 1;

  if not found then
    raise exception 'Sesion de terminal no valida o caducada.';
  end if;

  select work_sessions.id
    into work_session_id
  from public.warehouse_work_sessions as work_sessions
  where work_sessions.employee_id = actor_employee_id
    and work_sessions.status = 'break'
  for update
  limit 1;

  if work_session_id is null then
    raise exception 'No hay una pausa abierta.';
  end if;

  select breaks.id
    into current_break_id
  from public.warehouse_work_breaks as breaks
  where breaks.work_session_id = work_session_id
    and breaks.ended_at is null
  for update
  limit 1;

  if current_break_id is null then
    raise exception 'Estado de pausa inconsistente.';
  end if;

  update public.warehouse_work_breaks
  set
    ended_at = now(),
    close_reason = 'operator'
  where id = current_break_id;

  update public.warehouse_work_sessions
  set status = 'working'
  where id = work_session_id;
end;
$$;

revoke all on function public.warehouse_end_break(text) from public;
grant execute on function public.warehouse_end_break(text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Finalizar jornada manualmente.
-- Si habia una pausa abierta, se cierra dejando trazabilidad.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_finish_work_session(target_session_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  actor_terminal_id uuid;
  work_session_id uuid;
begin
  select terminal_sessions.employee_id, terminal_sessions.terminal_id
    into actor_employee_id, actor_terminal_id
  from public.warehouse_terminal_sessions as terminal_sessions
  where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
    and terminal_sessions.revoked_at is null
    and terminal_sessions.expires_at > now()
  limit 1;

  if not found then
    raise exception 'Sesion de terminal no valida o caducada.';
  end if;

  select work_sessions.id
    into work_session_id
  from public.warehouse_work_sessions as work_sessions
  where work_sessions.employee_id = actor_employee_id
    and work_sessions.status <> 'completed'
  for update
  limit 1;

  if work_session_id is null then
    raise exception 'No hay una jornada abierta.';
  end if;

  update public.warehouse_work_breaks
  set
    ended_at = now(),
    closed_automatically = false,
    close_reason = 'session_finished'
  where warehouse_work_breaks.work_session_id = work_session_id
    and ended_at is null;

  update public.warehouse_work_periods
  set
    ended_at = now(),
    ended_terminal_id = actor_terminal_id
  where warehouse_work_periods.work_session_id = work_session_id
    and ended_at is null;

  update public.warehouse_work_sessions
  set
    status = 'completed',
    ended_at = now(),
    closed_automatically = false,
    last_terminal_id = actor_terminal_id
  where id = work_session_id;
end;
$$;

revoke all on function public.warehouse_finish_work_session(text) from public;
grant execute on function public.warehouse_finish_work_session(text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Cierre automatico preparado para cron/Edge Function futura.
-- NO se concede a anon/authenticated.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_close_work_session_automatically(
  target_work_session_id uuid,
  target_closed_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.warehouse_work_sessions as work_sessions
    where work_sessions.id = target_work_session_id
      and work_sessions.status <> 'completed'
  ) then
    return;
  end if;

  update public.warehouse_work_breaks
  set
    ended_at = target_closed_at,
    closed_automatically = true,
    close_reason = 'automatic'
  where work_session_id = target_work_session_id
    and ended_at is null;

  update public.warehouse_work_periods
  set ended_at = target_closed_at
  where work_session_id = target_work_session_id
    and ended_at is null;

  update public.warehouse_work_sessions
  set
    status = 'completed',
    ended_at = target_closed_at,
    closed_automatically = true
  where id = target_work_session_id;
end;
$$;

revoke all on function public.warehouse_close_work_session_automatically(uuid, timestamptz) from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- RLS: el nuevo modulo no admite SELECT/INSERT/UPDATE/DELETE directos desde
-- la anon key. La operativa se hace exclusivamente mediante las RPC anteriores.
-- --------------------------------------------------------------------------
alter table public.warehouse_terminals enable row level security;
alter table public.warehouse_employee_credentials enable row level security;
alter table public.warehouse_terminal_sessions enable row level security;
alter table public.warehouse_work_sessions enable row level security;
alter table public.warehouse_work_periods enable row level security;
alter table public.warehouse_break_types enable row level security;
alter table public.warehouse_work_breaks enable row level security;
alter table public.warehouse_shift_schedules enable row level security;
alter table public.warehouse_corrections enable row level security;

revoke all on table public.warehouse_terminals from anon, authenticated;
revoke all on table public.warehouse_employee_credentials from anon, authenticated;
revoke all on table public.warehouse_terminal_sessions from anon, authenticated;
revoke all on table public.warehouse_work_sessions from anon, authenticated;
revoke all on table public.warehouse_work_periods from anon, authenticated;
revoke all on table public.warehouse_break_types from anon, authenticated;
revoke all on table public.warehouse_work_breaks from anon, authenticated;
revoke all on table public.warehouse_shift_schedules from anon, authenticated;
revoke all on table public.warehouse_corrections from anon, authenticated;

-- Aseguramos que las RPC publicas no hereden EXECUTE de PUBLIC.
revoke all on function public.warehouse_terminal_login(text, text, text) from public;
revoke all on function public.warehouse_terminal_logout(text) from public;
revoke all on function public.warehouse_get_current_state(text) from public;
revoke all on function public.warehouse_get_break_types(text) from public;
revoke all on function public.warehouse_start_work_session(text, date, text, text, text, text) from public;
revoke all on function public.warehouse_change_work_context(text, text, text) from public;
revoke all on function public.warehouse_start_break(text, text) from public;
revoke all on function public.warehouse_end_break(text) from public;
revoke all on function public.warehouse_finish_work_session(text) from public;

-- Fin FASE 1.
