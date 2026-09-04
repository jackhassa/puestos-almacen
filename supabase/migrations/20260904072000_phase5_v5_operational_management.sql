begin;

-- ============================================================================
-- Puestos Almacen - FASE 5 V4
-- 1) Catalogo maestro de carros y validacion al escanear.
-- 2) Configuracion de pausas desde Gestion Operativa.
-- 3) Gestion Operativa sin segundo codigo/password.
-- 4) Panel del gestor para Entradas, Picking y Mesas.
--
-- No se modifican migraciones ya aplicadas.
-- ============================================================================

-- --------------------------------------------------------------------------
-- CATALOGO DE CARROS
-- --------------------------------------------------------------------------
alter table public.warehouse_carts
  add column if not exists active boolean not null default true;

alter table public.warehouse_carts
  drop constraint if exists warehouse_carts_state_allowed;

alter table public.warehouse_carts
  add constraint warehouse_carts_state_allowed
  check (
    state in (
      'available',
      'picking',
      'ready_for_shipping',
      'assigned_to_shipping',
      'shipping',
      'completed'
    )
  );

create index if not exists warehouse_carts_active_state_idx
  on public.warehouse_carts(active, state, updated_at, id);

-- --------------------------------------------------------------------------
-- ESTADO DE CONFIGURACION SIN SEGUNDO PASSWORD
-- La aplicacion conserva las tablas protegidas por RLS. Estas RPC son el
-- punto de acceso de la interfaz de configuracion.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_admin_get_setup_state_open()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return jsonb_build_object(
    'employees', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'name', e.name,
          'active', e.active,
          'has_credential', c.id is not null,
          'username_code', c.username_code,
          'credential_active', coalesce(c.active, false),
          'locked_until', c.locked_until
        )
        order by e.name
      )
      from public.employees as e
      left join public.warehouse_employee_credentials as c
        on c.employee_id = e.id
    ), '[]'::jsonb),

    'terminals', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'code', t.code,
          'name', t.name,
          'terminal_type', t.terminal_type,
          'fixed_area_code', t.fixed_area_code,
          'active', t.active
        )
        order by t.name, t.code
      )
      from public.warehouse_terminals as t
    ), '[]'::jsonb),

    'carts', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', carts.id,
          'code', carts.code,
          'state', carts.state,
          'active', carts.active,
          'has_history', exists(
            select 1
            from public.warehouse_cart_events as events
            where events.cart_id = carts.id
          )
        )
        order by carts.code
      )
      from public.warehouse_carts as carts
    ), '[]'::jsonb),

    'breaks', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', break_types.id,
          'code', break_types.code,
          'label', break_types.label,
          'active', break_types.active,
          'display_order', break_types.display_order,
          'has_history', exists(
            select 1
            from public.warehouse_work_breaks as breaks
            where breaks.break_type_id = break_types.id
          )
        )
        order by break_types.display_order, break_types.label
      )
      from public.warehouse_break_types as break_types
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.warehouse_admin_get_setup_state_open() from public;
grant execute on function public.warehouse_admin_get_setup_state_open()
  to anon, authenticated;

create or replace function public.warehouse_admin_get_break_types_open()
returns jsonb
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', break_types.id,
        'code', break_types.code,
        'label', break_types.label,
        'active', break_types.active,
        'display_order', break_types.display_order,
        'has_history', exists(
          select 1
          from public.warehouse_work_breaks as breaks
          where breaks.break_type_id = break_types.id
        )
      )
      order by break_types.display_order, break_types.label
    ),
    '[]'::jsonb
  )
  from public.warehouse_break_types as break_types;
$$;

revoke all on function public.warehouse_admin_get_break_types_open() from public;
grant execute on function public.warehouse_admin_get_break_types_open()
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- CREDENCIALES SIN SEGUNDO PASSWORD DE GESTION
-- --------------------------------------------------------------------------
create or replace function public.warehouse_admin_set_employee_credential_open(
  target_employee_id uuid,
  target_username_code text,
  target_password_code text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_username text := upper(btrim(target_username_code));
begin
  if not exists(
    select 1
    from public.employees
    where id = target_employee_id
  ) then
    raise exception 'Trabajador no valido.';
  end if;

  if length(normalized_username) < 3 then
    raise exception 'El codigo de usuario debe tener al menos 3 caracteres.';
  end if;

  if length(coalesce(target_password_code, '')) < 4 then
    raise exception 'El codigo de password debe tener al menos 4 caracteres.';
  end if;

  insert into public.warehouse_employee_credentials(
    employee_id,
    username_code,
    password_hash,
    active,
    failed_attempts,
    locked_until
  )
  values (
    target_employee_id,
    normalized_username,
    crypt(target_password_code, gen_salt('bf', 12)),
    true,
    0,
    null
  )
  on conflict (employee_id) do update
  set
    username_code = excluded.username_code,
    password_hash = excluded.password_hash,
    active = true,
    failed_attempts = 0,
    locked_until = null;
end;
$$;

revoke all on function public.warehouse_admin_set_employee_credential_open(uuid, text, text)
  from public;
grant execute on function public.warehouse_admin_set_employee_credential_open(uuid, text, text)
  to anon, authenticated;

create or replace function public.warehouse_admin_set_credential_active_open(
  target_employee_id uuid,
  target_active boolean
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  update public.warehouse_employee_credentials
  set
    active = target_active,
    failed_attempts = case when target_active then 0 else failed_attempts end,
    locked_until = case when target_active then null else locked_until end
  where employee_id = target_employee_id;

  if not found then
    raise exception 'El trabajador no tiene credencial configurada.';
  end if;
end;
$$;

revoke all on function public.warehouse_admin_set_credential_active_open(uuid, boolean)
  from public;
grant execute on function public.warehouse_admin_set_credential_active_open(uuid, boolean)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- TERMINALES SIN SEGUNDO PASSWORD DE GESTION
-- --------------------------------------------------------------------------
create or replace function public.warehouse_admin_upsert_terminal_open(
  target_terminal_id uuid,
  target_code text,
  target_name text,
  target_terminal_type text,
  target_fixed_area_code text,
  target_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_code text := upper(btrim(target_code));
  result_id uuid;
begin
  if length(normalized_code) < 2 or nullif(btrim(target_name), '') is null then
    raise exception 'Codigo o nombre de terminal no valido.';
  end if;

  if target_terminal_type not in ('fixed_pc', 'rf') then
    raise exception 'Tipo de terminal no valido.';
  end if;

  if target_terminal_type = 'fixed_pc'
     and target_fixed_area_code not in (
       'gestor', 'mesa1', 'mesa2', 'mesa3', 'mesa4',
       'entradas', 'picking', 'montajes'
     ) then
    raise exception 'Un PC fijo necesita un puesto valido.';
  end if;

  if target_terminal_type = 'rf' then
    target_fixed_area_code := null;
  end if;

  if target_terminal_id is null then
    insert into public.warehouse_terminals(
      code,
      name,
      terminal_type,
      fixed_area_code,
      active
    )
    values (
      normalized_code,
      btrim(target_name),
      target_terminal_type,
      target_fixed_area_code,
      target_active
    )
    returning id into result_id;
  else
    update public.warehouse_terminals
    set
      code = normalized_code,
      name = btrim(target_name),
      terminal_type = target_terminal_type,
      fixed_area_code = target_fixed_area_code,
      active = target_active
    where id = target_terminal_id
    returning id into result_id;

    if result_id is null then
      raise exception 'Terminal no encontrado.';
    end if;
  end if;

  return result_id;
end;
$$;

revoke all on function public.warehouse_admin_upsert_terminal_open(
  uuid, text, text, text, text, boolean
) from public;
grant execute on function public.warehouse_admin_upsert_terminal_open(
  uuid, text, text, text, text, boolean
) to anon, authenticated;

-- --------------------------------------------------------------------------
-- ADMINISTRACION DE CARROS
-- --------------------------------------------------------------------------
create or replace function public.warehouse_admin_create_cart_open(
  target_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_code text := upper(btrim(target_code));
  existing_cart public.warehouse_carts%rowtype;
  result_id uuid;
begin
  if length(normalized_code) < 1 then
    raise exception 'El codigo del carro es obligatorio.';
  end if;

  select carts.*
    into existing_cart
  from public.warehouse_carts as carts
  where upper(btrim(carts.code)) = normalized_code
  for update;

  if found then
    if existing_cart.active then
      raise exception 'El carro % ya existe.', normalized_code;
    end if;

    if existing_cart.state not in ('available', 'completed') then
      raise exception
        'El carro % no puede activarse porque esta en estado %.',
        normalized_code,
        existing_cart.state;
    end if;

    update public.warehouse_carts
    set active = true
    where id = existing_cart.id;

    return existing_cart.id;
  end if;

  insert into public.warehouse_carts(code, state, active)
  values (normalized_code, 'available', true)
  returning id into result_id;

  return result_id;
end;
$$;

revoke all on function public.warehouse_admin_create_cart_open(text) from public;
grant execute on function public.warehouse_admin_create_cart_open(text)
  to anon, authenticated;

create or replace function public.warehouse_admin_remove_cart_open(
  target_cart_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  cart_row public.warehouse_carts%rowtype;
  has_history_value boolean;
begin
  select carts.*
    into cart_row
  from public.warehouse_carts as carts
  where carts.id = target_cart_id
  for update;

  if not found then
    raise exception 'Carro no encontrado.';
  end if;

  if cart_row.state in (
    'picking',
    'ready_for_shipping',
    'assigned_to_shipping',
    'shipping'
  ) then
    raise exception
      'El carro % tiene trabajo operativo pendiente y no puede eliminarse ni desactivarse.',
      cart_row.code;
  end if;

  select exists(
    select 1
    from public.warehouse_cart_events as events
    where events.cart_id = target_cart_id
  )
  into has_history_value;

  if has_history_value then
    update public.warehouse_carts
    set active = false
    where id = target_cart_id;

    return 'disabled';
  end if;

  delete from public.warehouse_carts
  where id = target_cart_id;

  return 'deleted';
end;
$$;

revoke all on function public.warehouse_admin_remove_cart_open(uuid) from public;
grant execute on function public.warehouse_admin_remove_cart_open(uuid)
  to anon, authenticated;

create or replace function public.warehouse_admin_set_cart_active_open(
  target_cart_id uuid,
  target_active boolean
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  cart_row public.warehouse_carts%rowtype;
begin
  select carts.*
    into cart_row
  from public.warehouse_carts as carts
  where carts.id = target_cart_id
  for update;

  if not found then
    raise exception 'Carro no encontrado.';
  end if;

  if cart_row.state not in ('available', 'completed') then
    raise exception
      'No se puede cambiar la disponibilidad del carro mientras esta en estado %.',
      cart_row.state;
  end if;

  update public.warehouse_carts
  set active = target_active
  where id = target_cart_id;
end;
$$;

revoke all on function public.warehouse_admin_set_cart_active_open(uuid, boolean)
  from public;
grant execute on function public.warehouse_admin_set_cart_active_open(uuid, boolean)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- ADMINISTRACION DE TIPOS DE PAUSA
-- --------------------------------------------------------------------------
create or replace function public.warehouse_admin_create_break_type_open(
  target_label text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_label text := btrim(target_label);
  generated_code text;
  next_order integer;
  result_id uuid;
begin
  if length(coalesce(normalized_label, '')) < 2 then
    raise exception 'El nombre de la pausa debe tener al menos 2 caracteres.';
  end if;

  if exists(
    select 1
    from public.warehouse_break_types as break_types
    where lower(btrim(break_types.label)) = lower(normalized_label)
  ) then
    raise exception 'Ya existe una pausa con ese nombre.';
  end if;

  generated_code :=
    'pause_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);

  select coalesce(max(display_order), 0) + 10
    into next_order
  from public.warehouse_break_types;

  insert into public.warehouse_break_types(
    code,
    label,
    active,
    display_order
  )
  values (
    generated_code,
    normalized_label,
    true,
    next_order
  )
  returning id into result_id;

  return result_id;
end;
$$;

revoke all on function public.warehouse_admin_create_break_type_open(text)
  from public;
grant execute on function public.warehouse_admin_create_break_type_open(text)
  to anon, authenticated;

create or replace function public.warehouse_admin_remove_break_type_open(
  target_break_type_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  break_row public.warehouse_break_types%rowtype;
  has_history_value boolean;
  other_active_count bigint;
begin
  select break_types.*
    into break_row
  from public.warehouse_break_types as break_types
  where break_types.id = target_break_type_id
  for update;

  if not found then
    raise exception 'Pausa no encontrada.';
  end if;

  select count(*)
    into other_active_count
  from public.warehouse_break_types
  where active = true
    and id <> target_break_type_id;

  if break_row.active and other_active_count = 0 then
    raise exception 'Debe quedar al menos un tipo de pausa activo.';
  end if;

  select exists(
    select 1
    from public.warehouse_work_breaks as breaks
    where breaks.break_type_id = target_break_type_id
  )
  into has_history_value;

  if has_history_value then
    update public.warehouse_break_types
    set active = false
    where id = target_break_type_id;

    return 'disabled';
  end if;

  delete from public.warehouse_break_types
  where id = target_break_type_id;

  return 'deleted';
end;
$$;

revoke all on function public.warehouse_admin_remove_break_type_open(uuid)
  from public;
grant execute on function public.warehouse_admin_remove_break_type_open(uuid)
  to anon, authenticated;

create or replace function public.warehouse_admin_set_break_type_active_open(
  target_break_type_id uuid,
  target_active boolean
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  break_row public.warehouse_break_types%rowtype;
  other_active_count bigint;
begin
  select break_types.*
    into break_row
  from public.warehouse_break_types as break_types
  where break_types.id = target_break_type_id
  for update;

  if not found then
    raise exception 'Pausa no encontrada.';
  end if;

  if not target_active and break_row.active then
    select count(*)
      into other_active_count
    from public.warehouse_break_types
    where active = true
      and id <> target_break_type_id;

    if other_active_count = 0 then
      raise exception 'Debe quedar al menos un tipo de pausa activo.';
    end if;
  end if;

  update public.warehouse_break_types
  set active = target_active
  where id = target_break_type_id;
end;
$$;

revoke all on function public.warehouse_admin_set_break_type_active_open(uuid, boolean)
  from public;
grant execute on function public.warehouse_admin_set_break_type_active_open(uuid, boolean)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- VALIDACION DE CARRO EN PICKING
-- Ya no se crea automaticamente al escanear.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_start_picking_job(
  target_session_token text,
  target_job_type text,
  target_identifier text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  actor_terminal_id uuid;
  target_work_session_id uuid;
  target_work_period_id uuid;
  normalized_job_type text;
  normalized_identifier text;
  created_job_id uuid;
  target_cart_id uuid;
  target_cart_state text;
begin
  normalized_job_type := lower(btrim(target_job_type));

  if normalized_job_type is null
     or normalized_job_type not in ('cart', 'no_cart') then
    raise exception 'Tipo de trabajo de Picking no valido.';
  end if;

  if normalized_job_type = 'cart' then
    normalized_identifier := upper(btrim(target_identifier));

    if normalized_identifier is null or normalized_identifier = '' then
      raise exception 'El codigo del carro es obligatorio.';
    end if;
  else
    normalized_identifier :=
      'SIN-CARRO-' ||
      to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') ||
      '-' ||
      substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  end if;

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
    into target_work_session_id
  from public.warehouse_work_sessions as work_sessions
  where work_sessions.employee_id = actor_employee_id
    and work_sessions.status = 'working'
  order by work_sessions.started_at desc
  for update
  limit 1;

  if target_work_session_id is null then
    raise exception 'No hay una jornada trabajando. Finaliza la pausa si existe.';
  end if;

  select periods.id
    into target_work_period_id
  from public.warehouse_work_periods as periods
  where periods.work_session_id = target_work_session_id
    and periods.ended_at is null
    and periods.area_code = 'picking'
  for update
  limit 1;

  if target_work_period_id is null then
    raise exception 'La tarea actual no es Picking.';
  end if;

  if exists(
    select 1
    from public.warehouse_picking_jobs as jobs
    where jobs.work_session_id = target_work_session_id
      and jobs.status = 'active'
  ) then
    raise exception 'Ya existe un trabajo de Picking activo.';
  end if;

  if normalized_job_type = 'cart' then
    select carts.id, carts.state
      into target_cart_id, target_cart_state
    from public.warehouse_carts as carts
    where upper(btrim(carts.code)) = normalized_identifier
      and carts.active = true
    for update;

    if target_cart_id is null then
      raise exception
        'Carro % no configurado o inactivo. Crealo en Configuracion operativa.',
        normalized_identifier;
    end if;

    if target_cart_state not in ('available', 'completed') then
      raise exception
        'El carro % no esta disponible. Estado actual: %.',
        normalized_identifier,
        target_cart_state;
    end if;

    update public.warehouse_carts
    set state = 'picking'
    where id = target_cart_id;
  end if;

  insert into public.warehouse_picking_jobs(
    work_session_id,
    work_period_id,
    job_type,
    identifier,
    cart_id,
    started_terminal_id
  )
  values (
    target_work_session_id,
    target_work_period_id,
    normalized_job_type,
    normalized_identifier,
    target_cart_id,
    actor_terminal_id
  )
  returning id into created_job_id;

  if normalized_job_type = 'cart' then
    insert into public.warehouse_cart_events(
      cart_id,
      picking_job_id,
      work_session_id,
      employee_id,
      terminal_id,
      from_state,
      to_state,
      event_code
    )
    values (
      target_cart_id,
      created_job_id,
      target_work_session_id,
      actor_employee_id,
      actor_terminal_id,
      target_cart_state,
      'picking',
      case
        when target_cart_state = 'completed' then 'cart_reused_for_picking'
        else 'picking_started'
      end
    );
  end if;

  update public.warehouse_work_sessions
  set last_terminal_id = actor_terminal_id
  where id = target_work_session_id;

  return created_job_id;

exception
  when unique_violation then
    raise exception 'Este carro ya esta activo o el trabajo ya existe.';
end;
$$;

revoke all on function public.warehouse_start_picking_job(text, text, text)
  from public;
grant execute on function public.warehouse_start_picking_job(text, text, text)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- PANEL DEL GESTOR
-- Estado operativo en tiempo real de Entradas, Picking y Mesas.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_manager_get_live_state()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  sample_now timestamptz := clock_timestamp();
  workers_value jsonb := '[]'::jsonb;
  ready_for_shipping_carts_value bigint := 0;
  picking_carts_value bigint := 0;
begin
  select count(*)::bigint
    into ready_for_shipping_carts_value
  from public.warehouse_carts as carts
  where carts.active = true
    and carts.state = 'ready_for_shipping';

  select count(*)::bigint
    into picking_carts_value
  from public.warehouse_carts as carts
  where carts.active = true
    and carts.state = 'picking';

  select coalesce(
    jsonb_agg(worker_row.data order by worker_row.shift_order, worker_row.area_order, worker_row.employee_name),
    '[]'::jsonb
  )
  into workers_value
  from (
    select
      employees.name as employee_name,
      case work_sessions.shift_code
        when 'morning' then 1
        when 'afternoon' then 2
        else 3
      end as shift_order,
      case periods.area_code
        when 'entradas' then 1
        when 'picking' then 2
        when 'mesa1' then 3
        when 'mesa2' then 4
        when 'mesa3' then 5
        when 'mesa4' then 6
        else 99
      end as area_order,
      jsonb_build_object(
        'employee_id', employees.id,
        'employee_name', employees.name,
        'shift_code', work_sessions.shift_code,
        'planned_assignment_code', work_sessions.planned_assignment_code,
        'area_code', periods.area_code,
        'mode_code', periods.mode_code,
        'status',
          case
            when work_sessions.status = 'break' then 'break'
            when periods.area_code = 'picking' and picking_job.id is null then 'available'
            else 'working'
          end,
        'task_label',
          case
            when periods.area_code = 'picking' and picking_job.job_type = 'cart'
              then 'Carro ' || picking_job.identifier
            when periods.area_code = 'picking' and picking_job.job_type = 'no_cart'
              then 'Trabajo sin carro'
            when periods.area_code = 'picking'
              then null
            when periods.area_code = 'entradas'
              then 'Entradas'
            when periods.mode_code = 'cart'
              then 'Modo Carro'
            when periods.mode_code = 'export'
              then 'Modo Exportacion'
            when periods.mode_code = 'support'
              then 'Modo Apoyo'
            else 'Trabajo habitual'
          end,
        'task_started_at',
          case
            when periods.area_code = 'picking'
              then picking_job.started_at
            else periods.started_at
          end,
        'task_effective_seconds',
          case
            when periods.area_code = 'picking' and picking_job.id is null
              then 0
            when periods.area_code = 'picking'
              then public.warehouse_interval_effective_seconds(
                picking_job.work_session_id,
                picking_job.started_at,
                picking_job.ended_at,
                sample_now
              )
            else public.warehouse_interval_effective_seconds(
              periods.work_session_id,
              periods.started_at,
              periods.ended_at,
              sample_now
            )
          end,
        'break_count', coalesce(break_totals.break_count, 0),
        'break_seconds', coalesce(break_totals.break_seconds, 0),
        'work_started_at', work_sessions.started_at
      ) as data
    from public.warehouse_work_sessions as work_sessions
    join public.employees as employees
      on employees.id = work_sessions.employee_id
    join public.warehouse_work_periods as periods
      on periods.work_session_id = work_sessions.id
     and periods.ended_at is null
    left join lateral (
      select jobs.*
      from public.warehouse_picking_jobs as jobs
      where jobs.work_session_id = work_sessions.id
        and jobs.status = 'active'
      order by jobs.started_at desc
      limit 1
    ) as picking_job on true
    left join lateral (
      select
        count(*)::bigint as break_count,
        coalesce(
          sum(
            greatest(
              0::bigint,
              floor(
                extract(
                  epoch from (
                    least(coalesce(breaks.ended_at, sample_now), sample_now)
                    - breaks.started_at
                  )
                )
              )::bigint
            )
          ),
          0::bigint
        )::bigint as break_seconds
      from public.warehouse_work_breaks as breaks
      where breaks.work_session_id = work_sessions.id
        and breaks.started_at < sample_now
    ) as break_totals on true
    where work_sessions.status <> 'completed'
      and periods.area_code in (
        'entradas', 'picking', 'mesa1', 'mesa2', 'mesa3', 'mesa4'
      )
  ) as worker_row;

  return jsonb_build_object(
    'server_now', sample_now,
    'ready_for_shipping_carts', ready_for_shipping_carts_value,
    'picking_carts', picking_carts_value,
    'workers', workers_value
  );
end;
$$;

revoke all on function public.warehouse_manager_get_live_state() from public;
grant execute on function public.warehouse_manager_get_live_state()
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- VERIFICACION DE OBJETOS
-- --------------------------------------------------------------------------
do $$
begin
  if not exists(
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'warehouse_carts'
      and column_name = 'active'
  ) then
    raise exception 'No existe warehouse_carts.active tras FASE 5 V4.';
  end if;

  if to_regprocedure('public.warehouse_admin_get_setup_state_open()') is null then
    raise exception 'No existe warehouse_admin_get_setup_state_open.';
  end if;

  if to_regprocedure('public.warehouse_admin_create_cart_open(text)') is null then
    raise exception 'No existe warehouse_admin_create_cart_open.';
  end if;

  if to_regprocedure('public.warehouse_admin_create_break_type_open(text)') is null then
    raise exception 'No existe warehouse_admin_create_break_type_open.';
  end if;

  if to_regprocedure('public.warehouse_admin_get_break_types_open()') is null then
    raise exception 'No existe warehouse_admin_get_break_types_open.';
  end if;

  if to_regprocedure('public.warehouse_manager_get_live_state()') is null then
    raise exception 'No existe warehouse_manager_get_live_state.';
  end if;
end;
$$;

commit;
