begin;

-- ============================================================================
-- Puestos Almacen - FASE 6A
-- Expediciones + cola automatica + mesas + ciclo completo del carro.
--
-- Incluye:
-- - carro fisico disponible / picking / preparado / expedicion / expedido / disponible;
-- - reescaneo obligatorio para cerrar Picking y Expedicion;
-- - cola automatica: cubetas, prioridad y orden de preparacion;
-- - reserva transaccional segura para que dos mesas no cojan el mismo carro;
-- - modos de mesa Carro / Exportacion / Apoyo;
-- - tiempos reales y recuperacion de la tarea desde Supabase;
-- - marca de carro de cubetas desde Configuracion Operativa.
--
-- NO incluye todavia el panel maestro, overrides, correcciones ni KPI avanzados
-- del gestor: eso se reserva para FASE 6B.
-- ============================================================================

-- --------------------------------------------------------------------------
-- NORMALIZACION DEL MODELO DE CARROS
-- --------------------------------------------------------------------------
alter table public.warehouse_carts
  add column if not exists is_cubetas boolean not null default false;

create unique index if not exists warehouse_carts_single_cubetas_uidx
  on public.warehouse_carts ((is_cubetas))
  where is_cubetas = true;

alter table public.warehouse_cart_events
  drop constraint if exists warehouse_cart_events_from_state_allowed;

alter table public.warehouse_cart_events
  add constraint warehouse_cart_events_from_state_allowed
  check (
    from_state is null
    or from_state in (
      'available',
      'picking',
      'ready_for_shipping',
      'assigned_to_shipping',
      'shipping',
      'completed'
    )
  );

alter table public.warehouse_cart_events
  drop constraint if exists warehouse_cart_events_to_state_allowed;

alter table public.warehouse_cart_events
  add constraint warehouse_cart_events_to_state_allowed
  check (
    to_state in (
      'available',
      'picking',
      'ready_for_shipping',
      'assigned_to_shipping',
      'shipping',
      'completed'
    )
  );

-- El indice unico de FASE 5 por (picking_job_id, to_state) ya no sirve:
-- Expedicion puede devolver el mismo ciclo a PREPARADO de forma controlada.
drop index if exists public.warehouse_cart_events_picking_state_uidx;

create index if not exists warehouse_cart_events_picking_job_idx
  on public.warehouse_cart_events(picking_job_id, occurred_at, id)
  where picking_job_id is not null;

-- --------------------------------------------------------------------------
-- METADATOS DEL CICLO DE PICKING / COLA
-- La prioridad pertenece al ciclo, no al carro fisico reutilizable.
-- --------------------------------------------------------------------------
alter table public.warehouse_picking_jobs
  add column if not exists priority_code text not null default 'normal',
  add column if not exists shipment_type text,
  add column if not exists queue_override integer,
  add column if not exists prepared_at timestamptz;

alter table public.warehouse_picking_jobs
  drop constraint if exists warehouse_picking_jobs_priority_allowed;

alter table public.warehouse_picking_jobs
  add constraint warehouse_picking_jobs_priority_allowed
  check (priority_code in ('high', 'normal', 'low'));

alter table public.warehouse_picking_jobs
  drop constraint if exists warehouse_picking_jobs_status_allowed;

alter table public.warehouse_picking_jobs
  add constraint warehouse_picking_jobs_status_allowed
  check (status in ('active', 'completed', 'cancelled'));

alter table public.warehouse_picking_jobs
  drop constraint if exists warehouse_picking_jobs_end_consistent;

alter table public.warehouse_picking_jobs
  add constraint warehouse_picking_jobs_end_consistent
  check (
    (status = 'active' and ended_at is null)
    or
    (
      status in ('completed', 'cancelled')
      and ended_at is not null
      and ended_at >= started_at
    )
  );

update public.warehouse_picking_jobs
set prepared_at = ended_at
where job_type = 'cart'
  and status = 'completed'
  and prepared_at is null
  and ended_at is not null;

create index if not exists warehouse_picking_jobs_queue_idx
  on public.warehouse_picking_jobs(
    priority_code,
    queue_override,
    prepared_at,
    id
  )
  where job_type = 'cart' and status = 'completed';

-- --------------------------------------------------------------------------
-- TRABAJOS DE EXPEDICION
-- --------------------------------------------------------------------------
create table if not exists public.warehouse_shipping_jobs (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null
    references public.warehouse_carts(id) on delete restrict,
  picking_job_id uuid not null
    references public.warehouse_picking_jobs(id) on delete restrict,
  work_session_id uuid not null
    references public.warehouse_work_sessions(id) on delete restrict,
  work_period_id uuid not null
    references public.warehouse_work_periods(id) on delete restrict,
  employee_id uuid not null
    references public.employees(id) on delete restrict,
  area_code text not null,
  status text not null default 'shipping',
  claimed_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  started_terminal_id uuid
    references public.warehouse_terminals(id) on delete restrict,
  ended_terminal_id uuid
    references public.warehouse_terminals(id) on delete restrict,
  closed_automatically boolean not null default false,
  close_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint warehouse_shipping_jobs_area_allowed
    check (area_code in ('mesa1', 'mesa2', 'mesa3', 'mesa4')),
  constraint warehouse_shipping_jobs_status_allowed
    check (status in ('shipping', 'completed', 'cancelled')),
  constraint warehouse_shipping_jobs_end_consistent
    check (
      (status = 'shipping' and ended_at is null)
      or
      (
        status in ('completed', 'cancelled')
        and ended_at is not null
        and ended_at >= started_at
      )
    ),
  constraint warehouse_shipping_jobs_close_reason_allowed
    check (
      close_reason is null
      or close_reason in ('operator', 'automatic', 'correction')
    )
);

create unique index if not exists warehouse_shipping_jobs_one_active_per_session_idx
  on public.warehouse_shipping_jobs(work_session_id)
  where status = 'shipping';

create unique index if not exists warehouse_shipping_jobs_one_active_per_cart_idx
  on public.warehouse_shipping_jobs(cart_id)
  where status = 'shipping';

create index if not exists warehouse_shipping_jobs_session_time_idx
  on public.warehouse_shipping_jobs(work_session_id, started_at desc);

create index if not exists warehouse_shipping_jobs_cart_time_idx
  on public.warehouse_shipping_jobs(cart_id, started_at desc);

drop trigger if exists warehouse_shipping_jobs_set_updated_at
  on public.warehouse_shipping_jobs;

create trigger warehouse_shipping_jobs_set_updated_at
before update on public.warehouse_shipping_jobs
for each row execute function public.warehouse_set_updated_at();

alter table public.warehouse_shipping_jobs enable row level security;
revoke all on table public.warehouse_shipping_jobs from anon, authenticated;

alter table public.warehouse_cart_events
  add column if not exists shipping_job_id uuid
    references public.warehouse_shipping_jobs(id) on delete restrict;

create index if not exists warehouse_cart_events_shipping_idx
  on public.warehouse_cart_events(shipping_job_id, occurred_at, id)
  where shipping_job_id is not null;


-- --------------------------------------------------------------------------
-- RANKING DE PRIORIDAD
-- --------------------------------------------------------------------------
create or replace function public.warehouse_cart_priority_rank(
  target_priority text
)
returns integer
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select case target_priority
    when 'high' then 1
    when 'normal' then 2
    when 'low' then 3
    else 99
  end;
$$;

revoke all on function public.warehouse_cart_priority_rank(text)
  from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- PICKING: FINALIZACION CON REESCANEO DEL CARRO
-- Para trabajo sin carro no se exige codigo.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_finish_picking_job(
  target_session_token text,
  target_scanned_cart_code text
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
  target_job_id uuid;
  target_job_type text;
  target_identifier text;
  target_cart_id uuid;
  target_cart_state text;
  normalized_scan text := upper(btrim(coalesce(target_scanned_cart_code, '')));
  finished_at timestamptz := clock_timestamp();
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

  select jobs.id, jobs.job_type, jobs.identifier, jobs.cart_id
    into target_job_id, target_job_type, target_identifier, target_cart_id
  from public.warehouse_picking_jobs as jobs
  where jobs.work_session_id = target_work_session_id
    and jobs.status = 'active'
  for update
  limit 1;

  if target_job_id is null then
    raise exception 'No hay ningun trabajo de Picking activo.';
  end if;

  if target_job_type = 'cart' then
    if normalized_scan = '' then
      raise exception 'Vuelve a escanear el carro para finalizar Picking.';
    end if;

    if normalized_scan <> upper(btrim(target_identifier)) then
      raise exception
        'Carro incorrecto. El carro activo es %.',
        target_identifier;
    end if;

    select carts.state
      into target_cart_state
    from public.warehouse_carts as carts
    where carts.id = target_cart_id
    for update;

    if target_cart_state <> 'picking' then
      raise exception
        'El carro no puede finalizar Picking desde el estado %.',
        coalesce(target_cart_state, 'desconocido');
    end if;
  end if;

  update public.warehouse_picking_jobs
  set
    status = 'completed',
    ended_at = finished_at,
    prepared_at = case
      when target_job_type = 'cart' then finished_at
      else prepared_at
    end,
    ended_terminal_id = actor_terminal_id,
    closed_automatically = false,
    close_reason = 'operator'
  where id = target_job_id;

  if target_job_type = 'cart' then
    update public.warehouse_carts
    set state = 'ready_for_shipping'
    where id = target_cart_id;

    insert into public.warehouse_cart_events(
      cart_id,
      picking_job_id,
      work_session_id,
      employee_id,
      terminal_id,
      from_state,
      to_state,
      event_code,
      occurred_at
    )
    values (
      target_cart_id,
      target_job_id,
      target_work_session_id,
      actor_employee_id,
      actor_terminal_id,
      'picking',
      'ready_for_shipping',
      'picking_completed',
      finished_at
    )
    on conflict do nothing;
  end if;

  update public.warehouse_work_sessions
  set last_terminal_id = actor_terminal_id
  where id = target_work_session_id;

  return target_job_id;
end;
$$;

revoke all on function public.warehouse_finish_picking_job(text, text)
  from public;
grant execute on function public.warehouse_finish_picking_job(text, text)
  to anon, authenticated;

-- La firma antigua no debe permitir saltarse el reescaneo.
revoke all on function public.warehouse_finish_picking_job(text)
  from anon, authenticated;

-- --------------------------------------------------------------------------
-- RESUMEN DE EXPEDICION PARA TERMINAL.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_get_shipping_summary(
  target_session_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  target_work_session_id uuid;
  current_period_id uuid;
  current_area_code text;
  current_mode_code text;
  sample_now timestamptz := clock_timestamp();
  break_count_value bigint := 0;
  break_seconds_value bigint := 0;
  completed_carts_value bigint := 0;
  avg_cart_seconds_value bigint := 0;
  shipping_effective_seconds_value bigint := 0;
  waiting_total_value bigint := 0;
  current_job_value jsonb := null;
  next_cart_value jsonb := null;
  waiting_carts_value jsonb := '[]'::jsonb;
  recent_jobs_value jsonb := '[]'::jsonb;
begin
  select terminal_sessions.employee_id
    into actor_employee_id
  from public.warehouse_terminal_sessions as terminal_sessions
  where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
    and terminal_sessions.revoked_at is null
    and terminal_sessions.expires_at > sample_now
  limit 1;

  if not found then
    raise exception 'Sesion de terminal no valida o caducada.';
  end if;

  update public.warehouse_terminal_sessions
  set last_seen_at = sample_now
  where token_hash = digest(target_session_token, 'sha256');

  select work_sessions.id
    into target_work_session_id
  from public.warehouse_work_sessions as work_sessions
  where work_sessions.employee_id = actor_employee_id
    and work_sessions.status <> 'completed'
  order by work_sessions.started_at desc
  limit 1;

  if target_work_session_id is null then
    raise exception 'No hay una jornada abierta.';
  end if;

  select periods.id, periods.area_code, periods.mode_code
    into current_period_id, current_area_code, current_mode_code
  from public.warehouse_work_periods as periods
  where periods.work_session_id = target_work_session_id
    and periods.ended_at is null
  limit 1;

  select
    count(*)::bigint,
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
    )::bigint
    into break_count_value, break_seconds_value
  from public.warehouse_work_breaks as breaks
  where breaks.work_session_id = target_work_session_id
    and breaks.started_at < sample_now;

  select
    count(*) filter (where jobs.status = 'completed')::bigint,
    coalesce(
      round(
        avg(
          public.warehouse_interval_effective_seconds(
            jobs.work_session_id,
            jobs.started_at,
            jobs.ended_at,
            sample_now
          )
        ) filter (where jobs.status = 'completed')
      )::bigint,
      0::bigint
    ),
    coalesce(
      sum(
        public.warehouse_interval_effective_seconds(
          jobs.work_session_id,
          jobs.started_at,
          jobs.ended_at,
          sample_now
        )
      ),
      0::bigint
    )::bigint
    into
      completed_carts_value,
      avg_cart_seconds_value,
      shipping_effective_seconds_value
  from public.warehouse_shipping_jobs as jobs
  where jobs.work_session_id = target_work_session_id
    and jobs.status in ('shipping', 'completed');

  select jsonb_build_object(
    'id', jobs.id,
    'cart_id', carts.id,
    'cart_code', carts.code,
    'area_code', jobs.area_code,
    'started_at', jobs.started_at,
    'ended_at', jobs.ended_at,
    'effective_seconds',
      public.warehouse_interval_effective_seconds(
        jobs.work_session_id,
        jobs.started_at,
        jobs.ended_at,
        sample_now
      )
  )
    into current_job_value
  from public.warehouse_shipping_jobs as jobs
  join public.warehouse_carts as carts
    on carts.id = jobs.cart_id
  where jobs.work_session_id = target_work_session_id
    and jobs.status = 'shipping'
  order by jobs.started_at desc
  limit 1;

  select count(*)::bigint
    into waiting_total_value
  from public.warehouse_carts as carts
  where carts.active = true
    and carts.state = 'ready_for_shipping';

  if current_mode_code = 'cart'
     and current_area_code in ('mesa1', 'mesa2', 'mesa3', 'mesa4')
     and current_job_value is null then

    select jsonb_build_object(
      'id', carts.id,
      'code', carts.code,
      'priority_code', jobs.priority_code,
      'shipment_type', jobs.shipment_type,
      'is_cubetas', carts.is_cubetas,
      'prepared_at', jobs.prepared_at
    )
      into next_cart_value
    from public.warehouse_carts as carts
    join lateral (
      select picking.*
      from public.warehouse_picking_jobs as picking
      where picking.cart_id = carts.id
        and picking.job_type = 'cart'
        and picking.status = 'completed'
        and picking.prepared_at is not null
      order by picking.prepared_at desc, picking.id desc
      limit 1
    ) as jobs on true
    where carts.active = true
      and carts.state = 'ready_for_shipping'
    order by
      carts.is_cubetas desc,
      case when jobs.queue_override is null then 1 else 0 end,
      jobs.queue_override asc nulls last,
      public.warehouse_cart_priority_rank(jobs.priority_code),
      jobs.prepared_at,
      carts.code
    limit 1;
  end if;

  select coalesce(
    jsonb_agg(queue_item.data order by queue_item.queue_order),
    '[]'::jsonb
  )
    into waiting_carts_value
  from (
    select
      row_number() over (
        order by
          carts.is_cubetas desc,
          case when jobs.queue_override is null then 1 else 0 end,
          jobs.queue_override asc nulls last,
          public.warehouse_cart_priority_rank(jobs.priority_code),
          jobs.prepared_at,
          carts.code
      ) as queue_order,
      jsonb_build_object(
        'id', carts.id,
        'code', carts.code,
        'priority_code', jobs.priority_code,
        'shipment_type', jobs.shipment_type,
        'is_cubetas', carts.is_cubetas,
        'prepared_at', jobs.prepared_at
      ) as data
    from public.warehouse_carts as carts
    join lateral (
      select picking.*
      from public.warehouse_picking_jobs as picking
      where picking.cart_id = carts.id
        and picking.job_type = 'cart'
        and picking.status = 'completed'
        and picking.prepared_at is not null
      order by picking.prepared_at desc, picking.id desc
      limit 1
    ) as jobs on true
    where carts.active = true
      and carts.state = 'ready_for_shipping'
    order by
      carts.is_cubetas desc,
      case when jobs.queue_override is null then 1 else 0 end,
      jobs.queue_override asc nulls last,
      public.warehouse_cart_priority_rank(jobs.priority_code),
      jobs.prepared_at,
      carts.code
    limit 6
  ) as queue_item;

  select coalesce(
    jsonb_agg(recent.job_data order by recent.started_at desc),
    '[]'::jsonb
  )
    into recent_jobs_value
  from (
    select
      jobs.started_at,
      jsonb_build_object(
        'id', jobs.id,
        'cart_id', carts.id,
        'cart_code', carts.code,
        'area_code', jobs.area_code,
        'started_at', jobs.started_at,
        'ended_at', jobs.ended_at,
        'effective_seconds',
          public.warehouse_interval_effective_seconds(
            jobs.work_session_id,
            jobs.started_at,
            jobs.ended_at,
            sample_now
          )
      ) as job_data
    from public.warehouse_shipping_jobs as jobs
    join public.warehouse_carts as carts
      on carts.id = jobs.cart_id
    where jobs.work_session_id = target_work_session_id
      and jobs.status = 'completed'
    order by jobs.started_at desc
    limit 5
  ) as recent;

  return jsonb_build_object(
    'work_session_id', target_work_session_id,
    'server_now', sample_now,
    'area_code', current_area_code,
    'mode_code', current_mode_code,
    'break_count', break_count_value,
    'break_seconds', break_seconds_value,
    'completed_carts', completed_carts_value,
    'avg_cart_effective_seconds', avg_cart_seconds_value,
    'shipping_effective_seconds', shipping_effective_seconds_value,
    'waiting_total', waiting_total_value,
    'current_job', current_job_value,
    'next_cart', next_cart_value,
    'waiting_carts', waiting_carts_value,
    'recent_jobs', recent_jobs_value
  );
end;
$$;

revoke all on function public.warehouse_get_shipping_summary(text) from public;
grant execute on function public.warehouse_get_shipping_summary(text)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- COGER SIGUIENTE CARRO
-- La seleccion y reserva se hacen dentro de la misma transaccion.
-- expected_cart_id evita que una pantalla obsoleta coja accidentalmente otro.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_claim_shipping_cart(
  target_session_token text,
  target_expected_cart_id uuid,
  target_scanned_cart_code text
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
  target_area_code text;
  target_mode_code text;
  selected_cart_id uuid;
  selected_cart_code text;
  selected_picking_job_id uuid;
  selected_priority text;
  selected_prepared_at timestamptz;
  created_shipping_job_id uuid;
  normalized_scan text := upper(btrim(coalesce(target_scanned_cart_code, '')));
  sample_now timestamptz := clock_timestamp();
begin
  if target_expected_cart_id is null then
    raise exception 'Actualiza la cola: no hay un siguiente carro valido.';
  end if;

  select terminal_sessions.employee_id, terminal_sessions.terminal_id
    into actor_employee_id, actor_terminal_id
  from public.warehouse_terminal_sessions as terminal_sessions
  where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
    and terminal_sessions.revoked_at is null
    and terminal_sessions.expires_at > sample_now
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
    raise exception 'La jornada no esta en estado trabajando. Finaliza la pausa si existe.';
  end if;

  select periods.id, periods.area_code, periods.mode_code
    into target_work_period_id, target_area_code, target_mode_code
  from public.warehouse_work_periods as periods
  where periods.work_session_id = target_work_session_id
    and periods.ended_at is null
  for update
  limit 1;

  if target_area_code not in ('mesa1', 'mesa2', 'mesa3', 'mesa4') then
    raise exception 'La tarea actual no es una Mesa de Expedicion.';
  end if;

  if target_mode_code <> 'cart' then
    raise exception 'Solo Modo Carro participa en la cola de Expedicion.';
  end if;

  if exists(
    select 1
    from public.warehouse_shipping_jobs as shipping
    where shipping.work_session_id = target_work_session_id
      and shipping.status = 'shipping'
  ) then
    raise exception 'Ya tienes un carro de Expedicion activo.';
  end if;

  select
    carts.id,
    carts.code,
    jobs.id,
    jobs.priority_code,
    jobs.prepared_at
    into
      selected_cart_id,
      selected_cart_code,
      selected_picking_job_id,
      selected_priority,
      selected_prepared_at
  from public.warehouse_carts as carts
  join lateral (
    select picking.*
    from public.warehouse_picking_jobs as picking
    where picking.cart_id = carts.id
      and picking.job_type = 'cart'
      and picking.status = 'completed'
      and picking.prepared_at is not null
    order by picking.prepared_at desc, picking.id desc
    limit 1
  ) as jobs on true
  where carts.active = true
    and carts.state = 'ready_for_shipping'
  order by
    carts.is_cubetas desc,
    case when jobs.queue_override is null then 1 else 0 end,
    jobs.queue_override asc nulls last,
    public.warehouse_cart_priority_rank(jobs.priority_code),
    jobs.prepared_at,
    carts.code
  for update of carts skip locked
  limit 1;

  if selected_cart_id is null then
    raise exception 'No hay carros preparados para Expedicion.';
  end if;

  if selected_cart_id <> target_expected_cart_id then
    raise exception
      'La cola ha cambiado. Actualiza la pantalla y coge el nuevo siguiente carro.';
  end if;

  if normalized_scan <> ''
     and normalized_scan <> upper(btrim(selected_cart_code)) then
    raise exception
      'Carro incorrecto. El siguiente carro es %.',
      selected_cart_code;
  end if;

  update public.warehouse_carts
  set state = 'assigned_to_shipping'
  where id = selected_cart_id
    and state = 'ready_for_shipping';

  if not found then
    raise exception 'El carro ya ha sido cogido por otra mesa. Actualiza la cola.';
  end if;

  insert into public.warehouse_shipping_jobs(
    cart_id,
    picking_job_id,
    work_session_id,
    work_period_id,
    employee_id,
    area_code,
    status,
    claimed_at,
    started_at,
    started_terminal_id
  )
  values (
    selected_cart_id,
    selected_picking_job_id,
    target_work_session_id,
    target_work_period_id,
    actor_employee_id,
    target_area_code,
    'shipping',
    sample_now,
    sample_now,
    actor_terminal_id
  )
  returning id into created_shipping_job_id;

  insert into public.warehouse_cart_events(
    cart_id,
    picking_job_id,
    shipping_job_id,
    work_session_id,
    employee_id,
    terminal_id,
    from_state,
    to_state,
    event_code,
    occurred_at
  )
  values (
    selected_cart_id,
    selected_picking_job_id,
    created_shipping_job_id,
    target_work_session_id,
    actor_employee_id,
    actor_terminal_id,
    'ready_for_shipping',
    'assigned_to_shipping',
    'shipping_assigned',
    sample_now
  );

  update public.warehouse_carts
  set state = 'shipping'
  where id = selected_cart_id;

  insert into public.warehouse_cart_events(
    cart_id,
    picking_job_id,
    shipping_job_id,
    work_session_id,
    employee_id,
    terminal_id,
    from_state,
    to_state,
    event_code,
    occurred_at
  )
  values (
    selected_cart_id,
    selected_picking_job_id,
    created_shipping_job_id,
    target_work_session_id,
    actor_employee_id,
    actor_terminal_id,
    'assigned_to_shipping',
    'shipping',
    'shipping_started',
    sample_now
  );

  update public.warehouse_work_sessions
  set last_terminal_id = actor_terminal_id
  where id = target_work_session_id;

  return created_shipping_job_id;
end;
$$;

revoke all on function public.warehouse_claim_shipping_cart(text, uuid, text)
  from public;
grant execute on function public.warehouse_claim_shipping_cart(text, uuid, text)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- FINALIZAR EXPEDICION REESCANEANDO EL CARRO.
-- completed queda registrado como evento y el estado actual se libera a
-- available para que el mismo carro pueda iniciar un nuevo ciclo.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_finish_shipping_job(
  target_session_token text,
  target_scanned_cart_code text
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
  target_shipping_job_id uuid;
  target_cart_id uuid;
  target_cart_code text;
  target_picking_job_id uuid;
  target_cart_state text;
  normalized_scan text := upper(btrim(coalesce(target_scanned_cart_code, '')));
  finished_at timestamptz := clock_timestamp();
begin
  if normalized_scan = '' then
    raise exception 'Escanea el carro para finalizar Expedicion.';
  end if;

  select terminal_sessions.employee_id, terminal_sessions.terminal_id
    into actor_employee_id, actor_terminal_id
  from public.warehouse_terminal_sessions as terminal_sessions
  where terminal_sessions.token_hash = digest(target_session_token, 'sha256')
    and terminal_sessions.revoked_at is null
    and terminal_sessions.expires_at > finished_at
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
    raise exception 'La jornada no esta en estado trabajando. Finaliza la pausa si existe.';
  end if;

  select
    shipping.id,
    shipping.cart_id,
    carts.code,
    shipping.picking_job_id,
    carts.state
    into
      target_shipping_job_id,
      target_cart_id,
      target_cart_code,
      target_picking_job_id,
      target_cart_state
  from public.warehouse_shipping_jobs as shipping
  join public.warehouse_carts as carts
    on carts.id = shipping.cart_id
  where shipping.work_session_id = target_work_session_id
    and shipping.status = 'shipping'
  for update of shipping, carts
  limit 1;

  if target_shipping_job_id is null then
    raise exception 'No tienes ningun carro de Expedicion activo.';
  end if;

  if normalized_scan <> upper(btrim(target_cart_code)) then
    raise exception
      'Carro incorrecto. El carro activo es %.',
      target_cart_code;
  end if;

  if target_cart_state <> 'shipping' then
    raise exception
      'El carro no puede finalizar Expedicion desde el estado %.',
      target_cart_state;
  end if;

  update public.warehouse_shipping_jobs
  set
    status = 'completed',
    ended_at = finished_at,
    ended_terminal_id = actor_terminal_id,
    closed_automatically = false,
    close_reason = 'operator'
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
    terminal_id,
    from_state,
    to_state,
    event_code,
    occurred_at
  )
  values (
    target_cart_id,
    target_picking_job_id,
    target_shipping_job_id,
    target_work_session_id,
    actor_employee_id,
    actor_terminal_id,
    'shipping',
    'completed',
    'shipping_completed',
    finished_at
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
    terminal_id,
    from_state,
    to_state,
    event_code,
    occurred_at
  )
  values (
    target_cart_id,
    target_picking_job_id,
    target_shipping_job_id,
    target_work_session_id,
    actor_employee_id,
    actor_terminal_id,
    'completed',
    'available',
    'cart_released',
    finished_at
  );

  update public.warehouse_work_sessions
  set last_terminal_id = actor_terminal_id
  where id = target_work_session_id;

  return target_shipping_job_id;
end;
$$;

revoke all on function public.warehouse_finish_shipping_job(text, text)
  from public;
grant execute on function public.warehouse_finish_shipping_job(text, text)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- PROTEGER CAMBIO DE TAREA / FIN DE JORNADA CON CARRO DE EXPEDICION ACTIVO.
-- En cierre automatico se devuelve a la cola para no perder el carro.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_guard_active_shipping_job()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  active_job_id uuid;
  active_cart_id uuid;
  active_picking_job_id uuid;
  active_work_session_id uuid;
  active_employee_id uuid;
begin
  if old.ended_at is null
     and new.ended_at is not null
     and old.area_code in ('mesa1', 'mesa2', 'mesa3', 'mesa4') then

    select
      shipping.id,
      shipping.cart_id,
      shipping.picking_job_id,
      shipping.work_session_id,
      shipping.employee_id
      into
        active_job_id,
        active_cart_id,
        active_picking_job_id,
        active_work_session_id,
        active_employee_id
    from public.warehouse_shipping_jobs as shipping
    where shipping.work_period_id = old.id
      and shipping.status = 'shipping'
    for update
    limit 1;

    if active_job_id is not null then
      if new.ended_terminal_id is not null then
        raise exception
          'Finaliza el carro de Expedicion activo antes de cambiar de tarea o finalizar la jornada.';
      end if;

      update public.warehouse_shipping_jobs
      set
        status = 'cancelled',
        ended_at = new.ended_at,
        closed_automatically = true,
        close_reason = 'automatic'
      where id = active_job_id;

      update public.warehouse_carts
      set state = 'ready_for_shipping'
      where id = active_cart_id
        and state in ('assigned_to_shipping', 'shipping');

      insert into public.warehouse_cart_events(
        cart_id,
        picking_job_id,
        shipping_job_id,
        work_session_id,
        employee_id,
        terminal_id,
        from_state,
        to_state,
        event_code,
        occurred_at
      )
      values (
        active_cart_id,
        active_picking_job_id,
        active_job_id,
        active_work_session_id,
        active_employee_id,
        null,
        'shipping',
        'ready_for_shipping',
        'shipping_requeued_automatic_close',
        new.ended_at
      );
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.warehouse_guard_active_shipping_job()
  from public, anon, authenticated;

drop trigger if exists warehouse_work_periods_guard_active_shipping_job
  on public.warehouse_work_periods;

create trigger warehouse_work_periods_guard_active_shipping_job
before update of ended_at on public.warehouse_work_periods
for each row execute function public.warehouse_guard_active_shipping_job();


-- --------------------------------------------------------------------------
-- CONFIGURACION ABIERTA: incluir marca CUBETAS en el catalogo.
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
          'id', employees.id,
          'name', employees.name,
          'active', employees.active,
          'has_credential', credentials.id is not null,
          'username_code', credentials.username_code,
          'credential_active', coalesce(credentials.active, false),
          'locked_until', credentials.locked_until
        )
        order by employees.name
      )
      from public.employees as employees
      left join public.warehouse_employee_credentials as credentials
        on credentials.employee_id = employees.id
    ), '[]'::jsonb),

    'terminals', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', terminals.id,
          'code', terminals.code,
          'name', terminals.name,
          'terminal_type', terminals.terminal_type,
          'fixed_area_code', terminals.fixed_area_code,
          'active', terminals.active
        )
        order by terminals.name, terminals.code
      )
      from public.warehouse_terminals as terminals
    ), '[]'::jsonb),

    'carts', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', carts.id,
          'code', carts.code,
          'state', carts.state,
          'active', carts.active,
          'is_cubetas', carts.is_cubetas,
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

revoke all on function public.warehouse_admin_get_setup_state_open()
  from public;
grant execute on function public.warehouse_admin_get_setup_state_open()
  to anon, authenticated;

create or replace function public.warehouse_admin_set_cart_cubetas_open(
  target_cart_id uuid,
  target_cubetas boolean
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists(
    select 1
    from public.warehouse_carts
    where id = target_cart_id
  ) then
    raise exception 'Carro no encontrado.';
  end if;

  if target_cubetas then
    update public.warehouse_carts
    set is_cubetas = false
    where is_cubetas = true
      and id <> target_cart_id;
  end if;

  update public.warehouse_carts
  set is_cubetas = target_cubetas
  where id = target_cart_id;
end;
$$;

revoke all on function public.warehouse_admin_set_cart_cubetas_open(uuid, boolean)
  from public;
grant execute on function public.warehouse_admin_set_cart_cubetas_open(uuid, boolean)
  to anon, authenticated;


-- --------------------------------------------------------------------------
-- VERIFICACIONES FASE 6A
-- --------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.warehouse_shipping_jobs') is null then
    raise exception 'No existe warehouse_shipping_jobs tras FASE 6A.';
  end if;

  if to_regprocedure('public.warehouse_finish_picking_job(text,text)') is null then
    raise exception 'No existe warehouse_finish_picking_job(text,text) tras FASE 6A.';
  end if;

  if to_regprocedure('public.warehouse_get_shipping_summary(text)') is null then
    raise exception 'No existe warehouse_get_shipping_summary tras FASE 6A.';
  end if;

  if to_regprocedure('public.warehouse_claim_shipping_cart(text,uuid,text)') is null then
    raise exception 'No existe warehouse_claim_shipping_cart tras FASE 6A.';
  end if;

  if to_regprocedure('public.warehouse_finish_shipping_job(text,text)') is null then
    raise exception 'No existe warehouse_finish_shipping_job tras FASE 6A.';
  end if;

  if to_regprocedure('public.warehouse_admin_set_cart_cubetas_open(uuid,boolean)') is null then
    raise exception 'No existe warehouse_admin_set_cart_cubetas_open tras FASE 6A.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'warehouse_carts'
      and column_name = 'is_cubetas'
  ) then
    raise exception 'No existe warehouse_carts.is_cubetas tras FASE 6A.';
  end if;
end;
$$;

commit;
