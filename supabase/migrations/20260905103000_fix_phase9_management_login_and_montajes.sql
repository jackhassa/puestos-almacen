begin;

-- ============================================================================
-- Puestos Almacen - FASE 9.1
-- Correccion integral posterior a FASE 9:
--   1) corrige ambiguedad expires_at en warehouse_management_login;
--   2) separa password de acceso Gestor del antiguo management_code_hash;
--   3) habilita realmente shift_code = montajes en warehouse_start_work_session;
--   4) reafirma restricciones y horario Montajes 05:45-13:45;
--   5) recarga el esquema PostgREST.
--
-- NO modifica migraciones ya aplicadas.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Password Gestor separado del codigo historico de configuracion.
-- En la primera ejecucion se copia el hash actual para no perder acceso.
-- --------------------------------------------------------------------------
alter table public.warehouse_admin_settings
  add column if not exists management_password_hash text;

update public.warehouse_admin_settings as settings
set management_password_hash = settings.management_code_hash
where settings.id = 1
  and (
    settings.management_password_hash is null
    or btrim(settings.management_password_hash) = ''
  );

alter table public.warehouse_admin_settings
  alter column management_password_hash set not null;

alter table public.warehouse_admin_settings
  drop constraint if exists warehouse_admin_settings_management_password_not_blank;

alter table public.warehouse_admin_settings
  add constraint warehouse_admin_settings_management_password_not_blank
  check (btrim(management_password_hash) <> '');

-- --------------------------------------------------------------------------
-- Login Gestor: todas las columnas potencialmente ambiguas van cualificadas.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_management_login(
  target_username text,
  target_password text
)
returns table (
  management_session_token text,
  display_name text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  settings_row public.warehouse_admin_settings%rowtype;
  plain_token text;
  expiry_value timestamptz;
begin
  if nullif(btrim(target_username), '') is null
     or nullif(target_password, '') is null then
    raise exception 'Usuario o contraseña incompletos.';
  end if;

  select settings.*
    into settings_row
  from public.warehouse_admin_settings as settings
  where settings.id = 1
  limit 1;

  if not found
     or lower(settings_row.management_username) <> lower(btrim(target_username))
     or settings_row.management_password_hash
        <> crypt(target_password, settings_row.management_password_hash) then
    raise exception 'Usuario o contraseña incorrectos.';
  end if;

  update public.warehouse_management_sessions as management_sessions
  set revoked_at = clock_timestamp()
  where management_sessions.revoked_at is null
    and management_sessions.expires_at <= now();

  plain_token := encode(gen_random_bytes(32), 'hex');
  expiry_value := now() + interval '12 hours';

  insert into public.warehouse_management_sessions as management_sessions (
    token_hash,
    display_name,
    expires_at
  )
  values (
    digest(plain_token, 'sha256'),
    'Gestor',
    expiry_value
  );

  return query
  select
    plain_token,
    'Gestor'::text,
    expiry_value;
end;
$$;

revoke all on function public.warehouse_management_login(text, text) from public;
grant execute on function public.warehouse_management_login(text, text)
  to anon, authenticated;

create or replace function public.warehouse_management_validate(
  target_session_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  session_row public.warehouse_management_sessions%rowtype;
begin
  select management_sessions.*
    into session_row
  from public.warehouse_management_sessions as management_sessions
  where management_sessions.token_hash = digest(target_session_token, 'sha256')
    and management_sessions.revoked_at is null
    and management_sessions.expires_at > now()
  limit 1;

  if not found then
    return jsonb_build_object('valid', false);
  end if;

  return jsonb_build_object(
    'valid', true,
    'display_name', session_row.display_name,
    'expires_at', session_row.expires_at
  );
end;
$$;

revoke all on function public.warehouse_management_validate(text) from public;
grant execute on function public.warehouse_management_validate(text)
  to anon, authenticated;

create or replace function public.warehouse_management_logout(
  target_session_token text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  update public.warehouse_management_sessions as management_sessions
  set revoked_at = clock_timestamp()
  where management_sessions.token_hash = digest(target_session_token, 'sha256')
    and management_sessions.revoked_at is null;
end;
$$;

revoke all on function public.warehouse_management_logout(text) from public;
grant execute on function public.warehouse_management_logout(text)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- Reafirmar modelo de turnos.
-- --------------------------------------------------------------------------
alter table public.warehouse_work_sessions
  drop constraint if exists warehouse_work_sessions_shift_allowed;

alter table public.warehouse_work_sessions
  add constraint warehouse_work_sessions_shift_allowed
  check (shift_code in ('morning', 'afternoon', 'night', 'montajes'));

alter table public.warehouse_shift_schedules
  drop constraint if exists warehouse_shift_schedules_shift_allowed;

alter table public.warehouse_shift_schedules
  add constraint warehouse_shift_schedules_shift_allowed
  check (shift_code in ('morning', 'afternoon', 'night', 'montajes'));

insert into public.warehouse_shift_schedules(
  shift_code,
  valid_from,
  valid_to,
  start_time,
  end_time,
  auto_close_grace_minutes,
  active
)
values (
  'montajes',
  date '2026-01-01',
  null,
  time '05:45',
  time '13:45',
  30,
  true
)
on conflict (shift_code, valid_from) do update
set
  valid_to = excluded.valid_to,
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  auto_close_grace_minutes = excluded.auto_close_grace_minutes,
  active = excluded.active,
  updated_at = clock_timestamp();

-- --------------------------------------------------------------------------
-- RPC de alta de jornada.
-- FASE 1 validaba solo morning/afternoon/night aunque la tabla ya admita
-- montajes tras FASE 9. Se sustituye la funcion completa conservando firma.
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
    update public.warehouse_work_sessions as work_sessions
    set last_terminal_id = actor_terminal_id
    where work_sessions.id = existing_session_id;

    return existing_session_id;
  end if;

  if target_shift_code not in ('morning', 'afternoon', 'night', 'montajes') then
    raise exception 'Turno no valido.';
  end if;

  if target_area_code not in (
    'gestor', 'mesa1', 'mesa2', 'mesa3', 'mesa4',
    'entradas', 'picking', 'montajes'
  ) then
    raise exception 'Puesto/area no valido.';
  end if;

  if target_shift_code = 'montajes' and target_area_code <> 'montajes' then
    raise exception 'El turno Montajes debe iniciar en el puesto Montajes.';
  end if;

  expected_area :=
    public.warehouse_assignment_expected_area(target_planned_assignment_code);

  if expected_area is null then
    raise exception
      'La planificacion no tiene un puesto operativo concreto. El responsable debe asignarlo antes del alta.';
  end if;

  if expected_area <> target_area_code then
    raise exception
      'Puesto incorrecto. Planificado: %, terminal/area actual: %.',
      expected_area,
      target_area_code;
  end if;

  if actor_terminal_type = 'fixed_pc'
     and actor_fixed_area <> target_area_code then
    raise exception
      'Este PC pertenece a % y no a %.',
      actor_fixed_area,
      target_area_code;
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
  )
  values (
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
  )
  values (
    created_session_id,
    target_area_code,
    effective_mode,
    actor_terminal_id,
    'initial'
  );

  return created_session_id;
end;
$$;

revoke all on function public.warehouse_start_work_session(
  text, date, text, text, text, text
) from public;

grant execute on function public.warehouse_start_work_session(
  text, date, text, text, text, text
) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Verificaciones de estructura antes de cerrar la migracion.
-- --------------------------------------------------------------------------
do $$
declare
  start_function_definition text;
begin
  if to_regprocedure(
    'public.warehouse_management_login(text,text)'
  ) is null then
    raise exception 'No existe warehouse_management_login(text,text).';
  end if;

  if to_regprocedure(
    'public.warehouse_management_validate(text)'
  ) is null then
    raise exception 'No existe warehouse_management_validate(text).';
  end if;

  if to_regprocedure(
    'public.warehouse_management_logout(text)'
  ) is null then
    raise exception 'No existe warehouse_management_logout(text).';
  end if;

  if to_regprocedure(
    'public.warehouse_start_work_session(text,date,text,text,text,text)'
  ) is null then
    raise exception 'No existe warehouse_start_work_session(...).';
  end if;

  select pg_get_functiondef(
    'public.warehouse_start_work_session(text,date,text,text,text,text)'::regprocedure
  )
  into start_function_definition;

  if position(
    'target_shift_code not in (''morning'', ''afternoon'', ''night'', ''montajes'')'
    in start_function_definition
  ) = 0 then
    raise exception 'warehouse_start_work_session no admite Montajes.';
  end if;

  if not exists (
    select 1
    from public.warehouse_shift_schedules as schedules
    where schedules.shift_code = 'montajes'
      and schedules.start_time = time '05:45'
      and schedules.end_time = time '13:45'
      and schedules.active
  ) then
    raise exception 'Horario Montajes no valido.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
