begin;

-- ============================================================================
-- Puestos Almacen - FASE 6B
-- Panel maestro del gestor, control total de carros, prioridades, cola,
-- correcciones trazables y KPI operativos.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Historial de correcciones: ampliar a carros.
-- --------------------------------------------------------------------------
alter table public.warehouse_corrections
  drop constraint if exists warehouse_corrections_entity_type_allowed;

alter table public.warehouse_corrections
  add constraint warehouse_corrections_entity_type_allowed
  check (entity_type in ('work_session', 'work_period', 'work_break', 'cart'));

-- --------------------------------------------------------------------------
-- Ajustes del panel del gestor.
-- SLA queda sin valor por defecto: no se inventa un objetivo.
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_manager_settings (
  singleton boolean primary key default true,
  cart_sla_minutes integer,
  updated_at timestamptz not null default now(),
  constraint warehouse_manager_settings_singleton_true check (singleton = true),
  constraint warehouse_manager_settings_sla_positive
    check (cart_sla_minutes is null or cart_sla_minutes > 0)
);

insert into public.warehouse_manager_settings(singleton, cart_sla_minutes)
values (true, null)
on conflict (singleton) do nothing;

alter table public.warehouse_manager_settings enable row level security;
revoke all on table public.warehouse_manager_settings from anon, authenticated;

-- --------------------------------------------------------------------------
-- Helper interno de auditoria de acciones de carro.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_manager_log_cart_correction(
  target_cart_id uuid,
  target_field_name text,
  target_original_value jsonb,
  target_corrected_value jsonb,
  target_actor_name text,
  target_reason text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if target_cart_id is null then
    raise exception 'Carro no valido.';
  end if;

  if btrim(coalesce(target_field_name, '')) = '' then
    raise exception 'Campo de correccion no valido.';
  end if;

  if btrim(coalesce(target_actor_name, '')) = '' then
    raise exception 'Indica el responsable de la correccion.';
  end if;

  if btrim(coalesce(target_reason, '')) = '' then
    raise exception 'Indica el motivo de la correccion.';
  end if;

  insert into public.warehouse_corrections(
    entity_type,
    entity_id,
    field_name,
    original_value,
    corrected_value,
    reason,
    actor_name_snapshot
  ) values (
    'cart',
    target_cart_id,
    target_field_name,
    target_original_value,
    target_corrected_value,
    btrim(target_reason),
    btrim(target_actor_name)
  );
end;
$$;

revoke all on function public.warehouse_manager_log_cart_correction(
  uuid, text, jsonb, jsonb, text, text
) from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- Configuracion SLA.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_manager_get_settings_open()
returns jsonb
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'cart_sla_minutes', settings.cart_sla_minutes
  )
  from public.warehouse_manager_settings as settings
  where settings.singleton = true;
$$;

revoke all on function public.warehouse_manager_get_settings_open() from public;
grant execute on function public.warehouse_manager_get_settings_open()
  to anon, authenticated;

create or replace function public.warehouse_manager_set_cart_sla_open(
  target_minutes integer
)
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if target_minutes is not null and target_minutes <= 0 then
    raise exception 'El SLA debe ser mayor que 0 minutos.';
  end if;

  update public.warehouse_manager_settings
  set cart_sla_minutes = target_minutes,
      updated_at = clock_timestamp()
  where singleton = true;

  return target_minutes;
end;
$$;

revoke all on function public.warehouse_manager_set_cart_sla_open(integer) from public;
grant execute on function public.warehouse_manager_set_cart_sla_open(integer)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- Acciones controladas del gestor.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_manager_set_cart_priority_open(
  target_cart_id uuid,
  target_priority text,
  target_actor_name text,
  target_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_priority text := lower(btrim(coalesce(target_priority, '')));
  target_picking_job_id uuid;
  previous_priority text;
begin
  if normalized_priority not in ('high', 'normal', 'low') then
    raise exception 'Prioridad no valida.';
  end if;

  perform 1
  from public.warehouse_carts as carts
  where carts.id = target_cart_id
  for update;

  if not found then
    raise exception 'El carro no existe.';
  end if;

  select jobs.id, jobs.priority_code
    into target_picking_job_id, previous_priority
  from public.warehouse_picking_jobs as jobs
  where jobs.cart_id = target_cart_id
    and jobs.job_type = 'cart'
  order by jobs.started_at desc, jobs.id desc
  for update
  limit 1;

  if target_picking_job_id is null then
    raise exception 'El carro todavia no tiene un ciclo de Picking.';
  end if;

  if previous_priority = normalized_priority then
    return target_cart_id;
  end if;

  update public.warehouse_picking_jobs
  set priority_code = normalized_priority
  where id = target_picking_job_id;

  perform public.warehouse_manager_log_cart_correction(
    target_cart_id,
    'priority_code',
    to_jsonb(previous_priority),
    to_jsonb(normalized_priority),
    target_actor_name,
    target_reason
  );

  return target_cart_id;
end;
$$;

revoke all on function public.warehouse_manager_set_cart_priority_open(
  uuid, text, text, text
) from public;
grant execute on function public.warehouse_manager_set_cart_priority_open(
  uuid, text, text, text
) to anon, authenticated;

create or replace function public.warehouse_manager_set_cart_queue_position_open(
  target_cart_id uuid,
  target_position integer,
  target_actor_name text,
  target_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  target_picking_job_id uuid;
  target_cart_state text;
  previous_position integer;
begin
  if target_position is not null and target_position <= 0 then
    raise exception 'La posicion de cola debe ser mayor que 0.';
  end if;

  select carts.state
    into target_cart_state
  from public.warehouse_carts as carts
  where carts.id = target_cart_id
  for update;

  if target_cart_state is null then
    raise exception 'El carro no existe.';
  end if;

  if target_cart_state <> 'ready_for_shipping' then
    raise exception 'Solo se puede reordenar un carro PREPARADO.';
  end if;

  select jobs.id, jobs.queue_override
    into target_picking_job_id, previous_position
  from public.warehouse_picking_jobs as jobs
  where jobs.cart_id = target_cart_id
    and jobs.job_type = 'cart'
    and jobs.status = 'completed'
    and jobs.prepared_at is not null
  order by jobs.prepared_at desc, jobs.id desc
  for update
  limit 1;

  if target_picking_job_id is null then
    raise exception 'No existe un ciclo preparado para este carro.';
  end if;

  if previous_position is not distinct from target_position then
    return target_cart_id;
  end if;

  update public.warehouse_picking_jobs
  set queue_override = target_position
  where id = target_picking_job_id;

  perform public.warehouse_manager_log_cart_correction(
    target_cart_id,
    'queue_override',
    to_jsonb(previous_position),
    to_jsonb(target_position),
    target_actor_name,
    target_reason
  );

  return target_cart_id;
end;
$$;

revoke all on function public.warehouse_manager_set_cart_queue_position_open(
  uuid, integer, text, text
) from public;
grant execute on function public.warehouse_manager_set_cart_queue_position_open(
  uuid, integer, text, text
) to anon, authenticated;

create or replace function public.warehouse_manager_set_cart_shipment_type_open(
  target_cart_id uuid,
  target_shipment_type text,
  target_actor_name text,
  target_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_type text := nullif(btrim(coalesce(target_shipment_type, '')), '');
  target_picking_job_id uuid;
  previous_type text;
begin
  perform 1
  from public.warehouse_carts as carts
  where carts.id = target_cart_id
  for update;

  if not found then
    raise exception 'El carro no existe.';
  end if;

  select jobs.id, jobs.shipment_type
    into target_picking_job_id, previous_type
  from public.warehouse_picking_jobs as jobs
  where jobs.cart_id = target_cart_id
    and jobs.job_type = 'cart'
  order by jobs.started_at desc, jobs.id desc
  for update
  limit 1;

  if target_picking_job_id is null then
    raise exception 'El carro todavia no tiene un ciclo de Picking.';
  end if;

  if previous_type is not distinct from normalized_type then
    return target_cart_id;
  end if;

  update public.warehouse_picking_jobs
  set shipment_type = normalized_type
  where id = target_picking_job_id;

  perform public.warehouse_manager_log_cart_correction(
    target_cart_id,
    'shipment_type',
    to_jsonb(previous_type),
    to_jsonb(normalized_type),
    target_actor_name,
    target_reason
  );

  return target_cart_id;
end;
$$;

revoke all on function public.warehouse_manager_set_cart_shipment_type_open(
  uuid, text, text, text
) from public;
grant execute on function public.warehouse_manager_set_cart_shipment_type_open(
  uuid, text, text, text
) to anon, authenticated;

-- Desbloquear: devuelve un carro bloqueado a un estado operativo seguro.
create or replace function public.warehouse_manager_unlock_cart_open(
  target_cart_id uuid,
  target_actor_name text,
  target_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  previous_state text;
  target_state text;
  sample_now timestamptz := clock_timestamp();
  target_shipping_job_id uuid;
  target_picking_job_id uuid;
  target_work_session_id uuid;
  target_employee_id uuid;
begin
  select carts.state
    into previous_state
  from public.warehouse_carts as carts
  where carts.id = target_cart_id
  for update;

  if previous_state is null then
    raise exception 'El carro no existe.';
  end if;

  if previous_state in ('shipping', 'assigned_to_shipping') then
    select shipping.id, shipping.picking_job_id, shipping.work_session_id, shipping.employee_id
      into target_shipping_job_id, target_picking_job_id, target_work_session_id, target_employee_id
    from public.warehouse_shipping_jobs as shipping
    where shipping.cart_id = target_cart_id
      and shipping.status = 'shipping'
    order by shipping.started_at desc
    for update
    limit 1;

    if target_shipping_job_id is not null then
      update public.warehouse_shipping_jobs
      set status = 'cancelled',
          ended_at = sample_now,
          closed_automatically = false,
          close_reason = 'correction'
      where id = target_shipping_job_id;
    end if;

    target_state := 'ready_for_shipping';

    update public.warehouse_carts
    set state = target_state
    where id = target_cart_id;

    insert into public.warehouse_cart_events(
      cart_id,
      picking_job_id,
      shipping_job_id,
      work_session_id,
      employee_id,
      from_state,
      to_state,
      event_code,
      occurred_at
    ) values (
      target_cart_id,
      target_picking_job_id,
      target_shipping_job_id,
      target_work_session_id,
      target_employee_id,
      previous_state,
      target_state,
      'manager_unlocked_to_queue',
      sample_now
    );
  elsif previous_state = 'picking' then
    select jobs.id, jobs.work_session_id
      into target_picking_job_id, target_work_session_id
    from public.warehouse_picking_jobs as jobs
    where jobs.cart_id = target_cart_id
      and jobs.status = 'active'
    order by jobs.started_at desc
    for update
    limit 1;

    if target_picking_job_id is not null then
      update public.warehouse_picking_jobs
      set status = 'cancelled',
          ended_at = sample_now,
          closed_automatically = false,
          close_reason = 'correction'
      where id = target_picking_job_id;
    end if;

    select sessions.employee_id
      into target_employee_id
    from public.warehouse_work_sessions as sessions
    where sessions.id = target_work_session_id;

    target_state := 'available';

    update public.warehouse_carts
    set state = target_state
    where id = target_cart_id;

    insert into public.warehouse_cart_events(
      cart_id,
      picking_job_id,
      work_session_id,
      employee_id,
      from_state,
      to_state,
      event_code,
      occurred_at
    ) values (
      target_cart_id,
      target_picking_job_id,
      target_work_session_id,
      target_employee_id,
      previous_state,
      target_state,
      'manager_unlocked_picking',
      sample_now
    );
  else
    target_state := previous_state;
  end if;

  perform public.warehouse_manager_log_cart_correction(
    target_cart_id,
    'state',
    to_jsonb(previous_state),
    to_jsonb(target_state),
    target_actor_name,
    target_reason
  );

  return target_cart_id;
end;
$$;

revoke all on function public.warehouse_manager_unlock_cart_open(
  uuid, text, text
) from public;
grant execute on function public.warehouse_manager_unlock_cart_open(
  uuid, text, text
) to anon, authenticated;

-- Liberar a DISPONIBLE: cancelacion controlada del trabajo activo si existe.
create or replace function public.warehouse_manager_release_cart_open(
  target_cart_id uuid,
  target_actor_name text,
  target_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  previous_state text;
  sample_now timestamptz := clock_timestamp();
  active_shipping_id uuid;
  active_picking_id uuid;
begin
  select carts.state
    into previous_state
  from public.warehouse_carts as carts
  where carts.id = target_cart_id
  for update;

  if previous_state is null then
    raise exception 'El carro no existe.';
  end if;

  select shipping.id
    into active_shipping_id
  from public.warehouse_shipping_jobs as shipping
  where shipping.cart_id = target_cart_id
    and shipping.status = 'shipping'
  order by shipping.started_at desc
  for update
  limit 1;

  if active_shipping_id is not null then
    update public.warehouse_shipping_jobs
    set status = 'cancelled',
        ended_at = sample_now,
        closed_automatically = false,
        close_reason = 'correction'
    where id = active_shipping_id;
  end if;

  select jobs.id
    into active_picking_id
  from public.warehouse_picking_jobs as jobs
  where jobs.cart_id = target_cart_id
    and jobs.status = 'active'
  order by jobs.started_at desc
  for update
  limit 1;

  if active_picking_id is not null then
    update public.warehouse_picking_jobs
    set status = 'cancelled',
        ended_at = sample_now,
        closed_automatically = false,
        close_reason = 'correction'
    where id = active_picking_id;
  end if;

  update public.warehouse_carts
  set state = 'available'
  where id = target_cart_id;

  insert into public.warehouse_cart_events(
    cart_id,
    from_state,
    to_state,
    event_code,
    occurred_at
  ) values (
    target_cart_id,
    previous_state,
    'available',
    'manager_released_cart',
    sample_now
  );

  perform public.warehouse_manager_log_cart_correction(
    target_cart_id,
    'state',
    to_jsonb(previous_state),
    to_jsonb('available'::text),
    target_actor_name,
    target_reason
  );

  return target_cart_id;
end;
$$;

revoke all on function public.warehouse_manager_release_cart_open(
  uuid, text, text
) from public;
grant execute on function public.warehouse_manager_release_cart_open(
  uuid, text, text
) to anon, authenticated;

-- Devolver a cola un ciclo de Picking ya completado.
create or replace function public.warehouse_manager_return_cart_to_queue_open(
  target_cart_id uuid,
  target_actor_name text,
  target_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  previous_state text;
  target_picking_job_id uuid;
  sample_now timestamptz := clock_timestamp();
begin
  select carts.state
    into previous_state
  from public.warehouse_carts as carts
  where carts.id = target_cart_id
  for update;

  if previous_state is null then
    raise exception 'El carro no existe.';
  end if;

  if previous_state in ('picking', 'assigned_to_shipping', 'shipping') then
    raise exception 'Desbloquea primero el trabajo activo antes de devolver el carro a cola.';
  end if;

  select jobs.id
    into target_picking_job_id
  from public.warehouse_picking_jobs as jobs
  where jobs.cart_id = target_cart_id
    and jobs.job_type = 'cart'
    and jobs.status = 'completed'
    and jobs.prepared_at is not null
  order by jobs.prepared_at desc, jobs.id desc
  limit 1;

  if target_picking_job_id is null then
    raise exception 'No existe un Picking completado que pueda volver a cola.';
  end if;

  update public.warehouse_carts
  set state = 'ready_for_shipping'
  where id = target_cart_id;

  insert into public.warehouse_cart_events(
    cart_id,
    picking_job_id,
    from_state,
    to_state,
    event_code,
    occurred_at
  ) values (
    target_cart_id,
    target_picking_job_id,
    previous_state,
    'ready_for_shipping',
    'manager_returned_to_queue',
    sample_now
  );

  perform public.warehouse_manager_log_cart_correction(
    target_cart_id,
    'state',
    to_jsonb(previous_state),
    to_jsonb('ready_for_shipping'::text),
    target_actor_name,
    target_reason
  );

  return target_cart_id;
end;
$$;

revoke all on function public.warehouse_manager_return_cart_to_queue_open(
  uuid, text, text
) from public;
grant execute on function public.warehouse_manager_return_cart_to_queue_open(
  uuid, text, text
) to anon, authenticated;

-- Cerrar Expedicion sin escaneo cuando el gestor corrige una incidencia.
create or replace function public.warehouse_manager_complete_shipping_open(
  target_cart_id uuid,
  target_actor_name text,
  target_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  target_shipping_job_id uuid;
  target_picking_job_id uuid;
  target_work_session_id uuid;
  target_employee_id uuid;
  previous_state text;
  sample_now timestamptz := clock_timestamp();
begin
  select carts.state
    into previous_state
  from public.warehouse_carts as carts
  where carts.id = target_cart_id
  for update;

  if previous_state is null then
    raise exception 'El carro no existe.';
  end if;

  select shipping.id, shipping.picking_job_id, shipping.work_session_id, shipping.employee_id
    into target_shipping_job_id, target_picking_job_id, target_work_session_id, target_employee_id
  from public.warehouse_shipping_jobs as shipping
  where shipping.cart_id = target_cart_id
    and shipping.status = 'shipping'
  order by shipping.started_at desc
  for update
  limit 1;

  if target_shipping_job_id is null then
    raise exception 'El carro no tiene una Expedicion activa.';
  end if;

  update public.warehouse_shipping_jobs
  set status = 'completed',
      ended_at = sample_now,
      closed_automatically = false,
      close_reason = 'correction'
  where id = target_shipping_job_id;

  update public.warehouse_carts
  set state = 'completed'
  where id = target_cart_id;

  insert into public.warehouse_cart_events(
    cart_id,
    picking_job_id,
    shipping_job_id,
    work_session_id,
    employee_id,
    from_state,
    to_state,
    event_code,
    occurred_at
  ) values (
    target_cart_id,
    target_picking_job_id,
    target_shipping_job_id,
    target_work_session_id,
    target_employee_id,
    previous_state,
    'completed',
    'manager_completed_shipping',
    sample_now
  );

  update public.warehouse_carts
  set state = 'available'
  where id = target_cart_id;

  insert into public.warehouse_cart_events(
    cart_id,
    picking_job_id,
    shipping_job_id,
    work_session_id,
    employee_id,
    from_state,
    to_state,
    event_code,
    occurred_at
  ) values (
    target_cart_id,
    target_picking_job_id,
    target_shipping_job_id,
    target_work_session_id,
    target_employee_id,
    'completed',
    'available',
    'manager_released_after_shipping',
    sample_now
  );

  perform public.warehouse_manager_log_cart_correction(
    target_cart_id,
    'shipping_completion',
    jsonb_build_object('state', previous_state, 'shipping_job_id', target_shipping_job_id),
    jsonb_build_object('state', 'available', 'shipping_job_id', target_shipping_job_id),
    target_actor_name,
    target_reason
  );

  return target_shipping_job_id;
end;
$$;

revoke all on function public.warehouse_manager_complete_shipping_open(
  uuid, text, text
) from public;
grant execute on function public.warehouse_manager_complete_shipping_open(
  uuid, text, text
) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Historial combinado de eventos + correcciones del carro.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_manager_get_cart_history_open(
  target_cart_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    jsonb_agg(history.data order by history.occurred_at desc, history.sort_id desc),
    '[]'::jsonb
  )
  from (
    select
      events.occurred_at,
      events.id::text as sort_id,
      jsonb_build_object(
        'kind', 'event',
        'occurred_at', events.occurred_at,
        'event_code', events.event_code,
        'from_state', events.from_state,
        'to_state', events.to_state,
        'actor_name', employees.name,
        'reason', null
      ) as data
    from public.warehouse_cart_events as events
    left join public.employees as employees
      on employees.id = events.employee_id
    where events.cart_id = target_cart_id

    union all

    select
      corrections.created_at as occurred_at,
      corrections.id::text as sort_id,
      jsonb_build_object(
        'kind', 'correction',
        'occurred_at', corrections.created_at,
        'event_code', corrections.field_name,
        'from_state', corrections.original_value,
        'to_state', corrections.corrected_value,
        'actor_name', corrections.actor_name_snapshot,
        'reason', corrections.reason
      ) as data
    from public.warehouse_corrections as corrections
    where corrections.entity_type = 'cart'
      and corrections.entity_id = target_cart_id
  ) as history;
$$;

revoke all on function public.warehouse_manager_get_cart_history_open(uuid) from public;
grant execute on function public.warehouse_manager_get_cart_history_open(uuid)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- Estado completo del gestor para una fecha operativa.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_manager_get_control_state(
  target_operational_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  sample_now timestamptz := clock_timestamp();
  selected_date date := coalesce(
    target_operational_date,
    (clock_timestamp() at time zone 'Europe/Madrid')::date
  );
  cart_sla_minutes_value integer;
  workers_value jsonb := '[]'::jsonb;
  sessions_value jsonb := '[]'::jsonb;
  carts_value jsonb := '[]'::jsonb;
  operator_kpis_value jsonb := '[]'::jsonb;
  picking_count_value bigint := 0;
  ready_count_value bigint := 0;
  shipping_count_value bigint := 0;
  available_count_value bigint := 0;
  completed_today_value bigint := 0;
  avg_picking_seconds_value bigint := 0;
  avg_shipping_seconds_value bigint := 0;
  avg_total_seconds_value bigint := 0;
  high_priority_cycles_value bigint := 0;
  total_cart_cycles_value bigint := 0;
  out_of_sla_value bigint := 0;
begin
  select settings.cart_sla_minutes
    into cart_sla_minutes_value
  from public.warehouse_manager_settings as settings
  where settings.singleton = true;

  select count(*) filter (where carts.state = 'picking')::bigint,
         count(*) filter (where carts.state = 'ready_for_shipping')::bigint,
         count(*) filter (where carts.state in ('assigned_to_shipping', 'shipping'))::bigint,
         count(*) filter (where carts.state = 'available')::bigint
    into picking_count_value, ready_count_value, shipping_count_value, available_count_value
  from public.warehouse_carts as carts
  where carts.active = true;

  select count(*)::bigint,
         coalesce(round(avg(public.warehouse_interval_effective_seconds(
           shipping.work_session_id,
           shipping.started_at,
           shipping.ended_at,
           sample_now
         )))::bigint, 0::bigint),
         coalesce(round(avg(
           greatest(
             0::bigint,
             floor(extract(epoch from (shipping.ended_at - picking.started_at)))::bigint
           )
         ))::bigint, 0::bigint)
    into completed_today_value, avg_shipping_seconds_value, avg_total_seconds_value
  from public.warehouse_shipping_jobs as shipping
  join public.warehouse_work_sessions as sessions
    on sessions.id = shipping.work_session_id
  join public.warehouse_picking_jobs as picking
    on picking.id = shipping.picking_job_id
  where sessions.operational_date = selected_date
    and shipping.status = 'completed'
    and shipping.ended_at is not null;

  select coalesce(round(avg(public.warehouse_interval_effective_seconds(
           picking.work_session_id,
           picking.started_at,
           picking.ended_at,
           sample_now
         )))::bigint, 0::bigint),
         count(*) filter (where picking.priority_code = 'high')::bigint,
         count(*)::bigint
    into avg_picking_seconds_value, high_priority_cycles_value, total_cart_cycles_value
  from public.warehouse_picking_jobs as picking
  join public.warehouse_work_sessions as sessions
    on sessions.id = picking.work_session_id
  where sessions.operational_date = selected_date
    and picking.job_type = 'cart'
    and picking.status = 'completed';

  if cart_sla_minutes_value is not null then
    select count(*)::bigint
      into out_of_sla_value
    from public.warehouse_shipping_jobs as shipping
    join public.warehouse_work_sessions as sessions
      on sessions.id = shipping.work_session_id
    join public.warehouse_picking_jobs as picking
      on picking.id = shipping.picking_job_id
    where sessions.operational_date = selected_date
      and shipping.status = 'completed'
      and shipping.ended_at is not null
      and extract(epoch from (shipping.ended_at - picking.started_at))
          > cart_sla_minutes_value * 60;
  end if;

  select coalesce(
    jsonb_agg(session_row.data order by session_row.employee_name),
    '[]'::jsonb
  )
    into sessions_value
  from (
    select
      employees.name as employee_name,
      jsonb_build_object(
        'employee_id', employees.id,
        'employee_name', employees.name,
        'status', sessions.status,
        'started_at', sessions.started_at,
        'ended_at', sessions.ended_at,
        'shift_code', sessions.shift_code,
        'planned_assignment_code', sessions.planned_assignment_code
      ) as data
    from public.warehouse_work_sessions as sessions
    join public.employees as employees
      on employees.id = sessions.employee_id
    where sessions.operational_date = selected_date
  ) as session_row;

  select coalesce(
    jsonb_agg(worker_row.data order by worker_row.shift_order, worker_row.area_order, worker_row.employee_name),
    '[]'::jsonb
  )
    into workers_value
  from (
    select
      employees.name as employee_name,
      case sessions.shift_code
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
        'shift_code', sessions.shift_code,
        'planned_assignment_code', sessions.planned_assignment_code,
        'area_code', periods.area_code,
        'mode_code', periods.mode_code,
        'status',
          case
            when sessions.status = 'break' then 'break'
            when periods.area_code = 'picking' and picking_job.id is null then 'available'
            when periods.area_code in ('mesa1','mesa2','mesa3','mesa4')
                 and periods.mode_code = 'cart'
                 and shipping_job.id is null then 'available'
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
            when periods.area_code in ('mesa1','mesa2','mesa3','mesa4') and shipping_job.id is not null
              then 'Carro ' || shipping_cart.code
            when periods.area_code in ('mesa1','mesa2','mesa3','mesa4') and periods.mode_code = 'cart'
              then null
            when periods.area_code in ('mesa1','mesa2','mesa3','mesa4') and periods.mode_code = 'export'
              then 'Exportacion'
            when periods.area_code in ('mesa1','mesa2','mesa3','mesa4') and periods.mode_code = 'support'
              then 'Apoyo'
            when periods.area_code = 'entradas'
              then 'Entradas'
            else 'Trabajo habitual'
          end,
        'task_started_at',
          case
            when periods.area_code = 'picking' then picking_job.started_at
            when periods.area_code in ('mesa1','mesa2','mesa3','mesa4') then shipping_job.started_at
            else periods.started_at
          end,
        'task_effective_seconds',
          case
            when periods.area_code = 'picking' and picking_job.id is null then 0
            when periods.area_code = 'picking' then public.warehouse_interval_effective_seconds(
              picking_job.work_session_id,
              picking_job.started_at,
              picking_job.ended_at,
              sample_now
            )
            when periods.area_code in ('mesa1','mesa2','mesa3','mesa4')
                 and periods.mode_code = 'cart'
                 and shipping_job.id is null then 0
            when periods.area_code in ('mesa1','mesa2','mesa3','mesa4')
                 and shipping_job.id is not null then public.warehouse_interval_effective_seconds(
              shipping_job.work_session_id,
              shipping_job.started_at,
              shipping_job.ended_at,
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
        'work_started_at', sessions.started_at
      ) as data
    from public.warehouse_work_sessions as sessions
    join public.employees as employees
      on employees.id = sessions.employee_id
    join public.warehouse_work_periods as periods
      on periods.work_session_id = sessions.id
     and periods.ended_at is null
    left join lateral (
      select picking.*
      from public.warehouse_picking_jobs as picking
      where picking.work_session_id = sessions.id
        and picking.status = 'active'
      order by picking.started_at desc
      limit 1
    ) as picking_job on true
    left join lateral (
      select shipping.*
      from public.warehouse_shipping_jobs as shipping
      where shipping.work_session_id = sessions.id
        and shipping.status = 'shipping'
      order by shipping.started_at desc
      limit 1
    ) as shipping_job on true
    left join public.warehouse_carts as shipping_cart
      on shipping_cart.id = shipping_job.cart_id
    left join lateral (
      select
        count(*)::bigint as break_count,
        coalesce(sum(greatest(
          0::bigint,
          floor(extract(epoch from (
            least(coalesce(breaks.ended_at, sample_now), sample_now) - breaks.started_at
          )))::bigint
        )), 0::bigint)::bigint as break_seconds
      from public.warehouse_work_breaks as breaks
      where breaks.work_session_id = sessions.id
        and breaks.started_at < sample_now
    ) as break_totals on true
    where sessions.operational_date = selected_date
      and sessions.status <> 'completed'
      and periods.area_code in ('entradas','picking','mesa1','mesa2','mesa3','mesa4')
  ) as worker_row;

  select coalesce(
    jsonb_agg(cart_row.data order by cart_row.code),
    '[]'::jsonb
  )
    into carts_value
  from (
    select
      carts.code,
      jsonb_build_object(
        'cart_id', carts.id,
        'code', carts.code,
        'active', carts.active,
        'is_cubetas', carts.is_cubetas,
        'state', carts.state,
        'priority_code', picking.priority_code,
        'shipment_type', picking.shipment_type,
        'queue_override', picking.queue_override,
        'prepared_at', picking.prepared_at,
        'picking_job_id', picking.id,
        'picking_employee_name', picking_employee.name,
        'picking_shift_code', picking_session.shift_code,
        'picking_started_at', picking.started_at,
        'picking_ended_at', picking.ended_at,
        'picking_effective_seconds',
          case when picking.id is null then 0 else public.warehouse_interval_effective_seconds(
            picking.work_session_id,
            picking.started_at,
            picking.ended_at,
            sample_now
          ) end,
        'shipping_job_id', shipping.id,
        'shipping_employee_name', shipping_employee.name,
        'shipping_area_code', shipping.area_code,
        'shipping_shift_code', shipping_session.shift_code,
        'shipping_started_at', shipping.started_at,
        'shipping_ended_at', shipping.ended_at,
        'shipping_effective_seconds',
          case when shipping.id is null then 0 else public.warehouse_interval_effective_seconds(
            shipping.work_session_id,
            shipping.started_at,
            shipping.ended_at,
            sample_now
          ) end,
        'operational_date', coalesce(picking_session.operational_date, shipping_session.operational_date),
        'total_seconds',
          case
            when picking.started_at is not null then greatest(
              0::bigint,
              floor(extract(epoch from (
                coalesce(shipping.ended_at, case when carts.state = 'available' then picking.ended_at else sample_now end)
                - picking.started_at
              )))::bigint
            )
            else 0
          end
      ) as data
    from public.warehouse_carts as carts
    left join lateral (
      select picking.*
      from public.warehouse_picking_jobs as picking
      join public.warehouse_work_sessions as sessions_filter
        on sessions_filter.id = picking.work_session_id
      where picking.cart_id = carts.id
        and (
          sessions_filter.operational_date = selected_date
          or carts.state <> 'available'
        )
      order by
        case when sessions_filter.operational_date = selected_date then 0 else 1 end,
        picking.started_at desc,
        picking.id desc
      limit 1
    ) as picking on true
    left join public.warehouse_work_sessions as picking_session
      on picking_session.id = picking.work_session_id
    left join public.employees as picking_employee
      on picking_employee.id = picking_session.employee_id
    left join lateral (
      select shipping.*
      from public.warehouse_shipping_jobs as shipping
      join public.warehouse_work_sessions as sessions_filter
        on sessions_filter.id = shipping.work_session_id
      where shipping.cart_id = carts.id
        and (picking.id is null or shipping.picking_job_id = picking.id)
        and (
          sessions_filter.operational_date = selected_date
          or shipping.status = 'shipping'
        )
      order by
        case when shipping.status = 'shipping' then 0 else 1 end,
        shipping.started_at desc,
        shipping.id desc
      limit 1
    ) as shipping on true
    left join public.warehouse_work_sessions as shipping_session
      on shipping_session.id = shipping.work_session_id
    left join public.employees as shipping_employee
      on shipping_employee.id = shipping.employee_id
  ) as cart_row;

  select coalesce(
    jsonb_agg(operator_row.data order by operator_row.employee_name),
    '[]'::jsonb
  )
    into operator_kpis_value
  from (
    select
      employees.name as employee_name,
      jsonb_build_object(
        'employee_id', employees.id,
        'employee_name', employees.name,
        'picking_carts', coalesce(picking_totals.total, 0),
        'shipping_carts', coalesce(shipping_totals.total, 0)
      ) as data
    from public.employees as employees
    left join lateral (
      select count(*)::bigint as total
      from public.warehouse_picking_jobs as picking
      join public.warehouse_work_sessions as sessions
        on sessions.id = picking.work_session_id
      where sessions.employee_id = employees.id
        and sessions.operational_date = selected_date
        and picking.job_type = 'cart'
        and picking.status = 'completed'
    ) as picking_totals on true
    left join lateral (
      select count(*)::bigint as total
      from public.warehouse_shipping_jobs as shipping
      join public.warehouse_work_sessions as sessions
        on sessions.id = shipping.work_session_id
      where shipping.employee_id = employees.id
        and sessions.operational_date = selected_date
        and shipping.status = 'completed'
    ) as shipping_totals on true
    where employees.active = true
      and (coalesce(picking_totals.total, 0) > 0 or coalesce(shipping_totals.total, 0) > 0)
  ) as operator_row;

  return jsonb_build_object(
    'server_now', sample_now,
    'operational_date', selected_date,
    'cart_sla_minutes', cart_sla_minutes_value,
    'summary', jsonb_build_object(
      'picking_carts', picking_count_value,
      'ready_carts', ready_count_value,
      'shipping_carts', shipping_count_value,
      'available_carts', available_count_value,
      'completed_today', completed_today_value,
      'avg_picking_seconds', avg_picking_seconds_value,
      'avg_shipping_seconds', avg_shipping_seconds_value,
      'avg_total_seconds', avg_total_seconds_value,
      'high_priority_cycles', high_priority_cycles_value,
      'total_cart_cycles', total_cart_cycles_value,
      'out_of_sla', case when cart_sla_minutes_value is null then null else out_of_sla_value end
    ),
    'workers', workers_value,
    'sessions', sessions_value,
    'carts', carts_value,
    'operator_kpis', operator_kpis_value
  );
end;
$$;

revoke all on function public.warehouse_manager_get_control_state(date) from public;
grant execute on function public.warehouse_manager_get_control_state(date)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- Verificacion FASE 6B.
-- --------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.warehouse_manager_settings') is null then
    raise exception 'No existe warehouse_manager_settings tras FASE 6B.';
  end if;

  if to_regprocedure('public.warehouse_manager_get_control_state(date)') is null then
    raise exception 'No existe warehouse_manager_get_control_state(date).';
  end if;

  if to_regprocedure('public.warehouse_manager_set_cart_priority_open(uuid,text,text,text)') is null then
    raise exception 'No existe warehouse_manager_set_cart_priority_open.';
  end if;

  if to_regprocedure('public.warehouse_manager_set_cart_queue_position_open(uuid,integer,text,text)') is null then
    raise exception 'No existe warehouse_manager_set_cart_queue_position_open.';
  end if;

  if to_regprocedure('public.warehouse_manager_unlock_cart_open(uuid,text,text)') is null then
    raise exception 'No existe warehouse_manager_unlock_cart_open.';
  end if;

  if to_regprocedure('public.warehouse_manager_release_cart_open(uuid,text,text)') is null then
    raise exception 'No existe warehouse_manager_release_cart_open.';
  end if;

  if to_regprocedure('public.warehouse_manager_return_cart_to_queue_open(uuid,text,text)') is null then
    raise exception 'No existe warehouse_manager_return_cart_to_queue_open.';
  end if;

  if to_regprocedure('public.warehouse_manager_complete_shipping_open(uuid,text,text)') is null then
    raise exception 'No existe warehouse_manager_complete_shipping_open.';
  end if;

  if to_regprocedure('public.warehouse_manager_get_cart_history_open(uuid)') is null then
    raise exception 'No existe warehouse_manager_get_cart_history_open.';
  end if;
end;
$$;

commit;
