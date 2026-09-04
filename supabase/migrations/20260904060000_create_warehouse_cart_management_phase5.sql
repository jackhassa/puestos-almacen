begin;

-- ============================================================================
-- Puestos Almacen - FASE 5
-- Gestion de carros:
--   picking -> ready_for_shipping -> assigned_to_shipping -> shipping -> completed
-- Mantiene historial inmutable de transiciones.
-- ============================================================================

create table if not exists public.warehouse_carts (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  state text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint warehouse_carts_code_not_blank
    check (btrim(code) <> ''),
  constraint warehouse_carts_state_allowed
    check (
      state in (
        'picking',
        'ready_for_shipping',
        'assigned_to_shipping',
        'shipping',
        'completed'
      )
    )
);

create unique index if not exists warehouse_carts_code_normalized_uidx
  on public.warehouse_carts ((upper(btrim(code))));

create index if not exists warehouse_carts_state_updated_idx
  on public.warehouse_carts (state, updated_at, id);

drop trigger if exists warehouse_carts_set_updated_at
  on public.warehouse_carts;

create trigger warehouse_carts_set_updated_at
before update on public.warehouse_carts
for each row execute function public.warehouse_set_updated_at();

alter table public.warehouse_carts enable row level security;
revoke all on table public.warehouse_carts from anon, authenticated;

create table if not exists public.warehouse_cart_events (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null
    references public.warehouse_carts(id) on delete restrict,
  picking_job_id uuid
    references public.warehouse_picking_jobs(id) on delete restrict,
  work_session_id uuid
    references public.warehouse_work_sessions(id) on delete restrict,
  employee_id uuid
    references public.employees(id) on delete restrict,
  terminal_id uuid
    references public.warehouse_terminals(id) on delete restrict,
  from_state text,
  to_state text not null,
  event_code text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint warehouse_cart_events_from_state_allowed
    check (
      from_state is null
      or from_state in (
        'picking',
        'ready_for_shipping',
        'assigned_to_shipping',
        'shipping',
        'completed'
      )
    ),
  constraint warehouse_cart_events_to_state_allowed
    check (
      to_state in (
        'picking',
        'ready_for_shipping',
        'assigned_to_shipping',
        'shipping',
        'completed'
      )
    ),
  constraint warehouse_cart_events_event_code_not_blank
    check (btrim(event_code) <> '')
);

create index if not exists warehouse_cart_events_cart_time_idx
  on public.warehouse_cart_events(cart_id, occurred_at, id);

create unique index if not exists warehouse_cart_events_picking_state_uidx
  on public.warehouse_cart_events(picking_job_id, to_state)
  where picking_job_id is not null;

alter table public.warehouse_cart_events enable row level security;
revoke all on table public.warehouse_cart_events from anon, authenticated;

alter table public.warehouse_picking_jobs
  add column if not exists cart_id uuid
    references public.warehouse_carts(id) on delete restrict;

create index if not exists warehouse_picking_jobs_cart_idx
  on public.warehouse_picking_jobs(cart_id, started_at desc);

-- --------------------------------------------------------------------------
-- Backfill de carros ya realizados durante FASE 4.
-- El ultimo trabajo conocido determina el estado actual del carro.
-- --------------------------------------------------------------------------
insert into public.warehouse_carts(code, state, created_at, updated_at)
select
  latest.identifier,
  case
    when latest.status = 'active' then 'picking'
    else 'ready_for_shipping'
  end,
  latest.started_at,
  coalesce(latest.ended_at, latest.started_at)
from (
  select distinct on (upper(btrim(jobs.identifier)))
    jobs.identifier,
    jobs.status,
    jobs.started_at,
    jobs.ended_at
  from public.warehouse_picking_jobs as jobs
  where jobs.job_type = 'cart'
  order by
    upper(btrim(jobs.identifier)),
    jobs.started_at desc,
    jobs.id desc
) as latest
on conflict ((upper(btrim(code)))) do nothing;

update public.warehouse_picking_jobs as jobs
set cart_id = carts.id
from public.warehouse_carts as carts
where jobs.job_type = 'cart'
  and jobs.cart_id is null
  and upper(btrim(carts.code)) = upper(btrim(jobs.identifier));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'warehouse_picking_jobs_cart_consistent'
      and conrelid = 'public.warehouse_picking_jobs'::regclass
  ) then
    alter table public.warehouse_picking_jobs
      add constraint warehouse_picking_jobs_cart_consistent
      check (
        (job_type = 'cart' and cart_id is not null)
        or
        (job_type = 'no_cart' and cart_id is null)
      ) not valid;
  end if;
end;
$$;

alter table public.warehouse_picking_jobs
  validate constraint warehouse_picking_jobs_cart_consistent;

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
select
  jobs.cart_id,
  jobs.id,
  jobs.work_session_id,
  sessions.employee_id,
  jobs.started_terminal_id,
  null,
  'picking',
  'picking_started',
  jobs.started_at
from public.warehouse_picking_jobs as jobs
join public.warehouse_work_sessions as sessions
  on sessions.id = jobs.work_session_id
where jobs.job_type = 'cart'
  and jobs.cart_id is not null
on conflict (picking_job_id, to_state)
  where picking_job_id is not null
do nothing;

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
select
  jobs.cart_id,
  jobs.id,
  jobs.work_session_id,
  sessions.employee_id,
  jobs.ended_terminal_id,
  'picking',
  'ready_for_shipping',
  'picking_completed',
  jobs.ended_at
from public.warehouse_picking_jobs as jobs
join public.warehouse_work_sessions as sessions
  on sessions.id = jobs.work_session_id
where jobs.job_type = 'cart'
  and jobs.cart_id is not null
  and jobs.status = 'completed'
  and jobs.ended_at is not null
on conflict (picking_job_id, to_state)
  where picking_job_id is not null
do nothing;

-- --------------------------------------------------------------------------
-- Iniciar trabajo de Picking.
-- Para carro: crea/recupera el carro, bloquea su fila y cambia a picking.
-- Solo un carro completed puede reutilizarse en un nuevo ciclo.
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
  inserted_cart_count integer := 0;
  cart_was_created boolean := false;
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

  if exists (
    select 1
    from public.warehouse_picking_jobs as jobs
    where jobs.work_session_id = target_work_session_id
      and jobs.status = 'active'
  ) then
    raise exception 'Ya existe un trabajo de Picking activo.';
  end if;

  if normalized_job_type = 'cart' then
    insert into public.warehouse_carts(code, state)
    values (normalized_identifier, 'completed')
    on conflict ((upper(btrim(code)))) do nothing;

    get diagnostics inserted_cart_count = row_count;
    cart_was_created := inserted_cart_count = 1;

    select carts.id, carts.state
      into target_cart_id, target_cart_state
    from public.warehouse_carts as carts
    where upper(btrim(carts.code)) = normalized_identifier
    for update;

    if target_cart_id is null then
      raise exception 'No se ha podido obtener el carro.';
    end if;

    if not cart_was_created and target_cart_state <> 'completed' then
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
  ) values (
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
    ) values (
      target_cart_id,
      created_job_id,
      target_work_session_id,
      actor_employee_id,
      actor_terminal_id,
      case when cart_was_created then null else 'completed' end,
      'picking',
      case when cart_was_created then 'picking_started' else 'cart_reused_for_picking' end
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
-- Finalizar Picking.
-- Si es un carro, pasa atomicamente a ready_for_shipping y registra evento.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_finish_picking_job(
  target_session_token text
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
  target_cart_id uuid;
  target_cart_state text;
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

  select jobs.id, jobs.job_type, jobs.cart_id
    into target_job_id, target_job_type, target_cart_id
  from public.warehouse_picking_jobs as jobs
  where jobs.work_session_id = target_work_session_id
    and jobs.status = 'active'
  for update
  limit 1;

  if target_job_id is null then
    raise exception 'No hay ningun trabajo de Picking activo.';
  end if;

  if target_job_type = 'cart' then
    select carts.state
      into target_cart_state
    from public.warehouse_carts as carts
    where carts.id = target_cart_id
    for update;

    if target_cart_state is null then
      raise exception 'El trabajo activo no tiene un carro valido.';
    end if;

    if target_cart_state <> 'picking' then
      raise exception
        'El carro no puede finalizar Picking desde el estado %.',
        target_cart_state;
    end if;
  end if;

  update public.warehouse_picking_jobs
  set
    status = 'completed',
    ended_at = now(),
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
      event_code
    ) values (
      target_cart_id,
      target_job_id,
      target_work_session_id,
      actor_employee_id,
      actor_terminal_id,
      'picking',
      'ready_for_shipping',
      'picking_completed'
    );
  end if;

  update public.warehouse_work_sessions
  set last_terminal_id = actor_terminal_id
  where id = target_work_session_id;

  return target_job_id;
end;
$$;

revoke all on function public.warehouse_finish_picking_job(text) from public;
grant execute on function public.warehouse_finish_picking_job(text)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- Resumen Picking. Añade carros actualmente preparados para Expedicion.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_get_picking_summary(
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
  sample_now timestamptz := clock_timestamp();
  completed_carts_value bigint := 0;
  completed_no_cart_value bigint := 0;
  total_completed_value bigint := 0;
  ready_for_shipping_carts_value bigint := 0;
  avg_cart_effective_seconds_value bigint := 0;
  picking_effective_seconds_value bigint := 0;
  break_seconds_value bigint := 0;
  active_job_value jsonb := null;
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

  select
    count(*) filter (
      where jobs.status = 'completed' and jobs.job_type = 'cart'
    )::bigint,
    count(*) filter (
      where jobs.status = 'completed' and jobs.job_type = 'no_cart'
    )::bigint
    into completed_carts_value, completed_no_cart_value
  from public.warehouse_picking_jobs as jobs
  where jobs.work_session_id = target_work_session_id;

  total_completed_value := completed_carts_value + completed_no_cart_value;

  select count(*)::bigint
    into ready_for_shipping_carts_value
  from public.warehouse_carts as carts
  where carts.state = 'ready_for_shipping';

  select coalesce(
    round(
      avg(
        public.warehouse_interval_effective_seconds(
          jobs.work_session_id,
          jobs.started_at,
          jobs.ended_at,
          sample_now
        )
      )
    )::bigint,
    0::bigint
  )
    into avg_cart_effective_seconds_value
  from public.warehouse_picking_jobs as jobs
  where jobs.work_session_id = target_work_session_id
    and jobs.status = 'completed'
    and jobs.job_type = 'cart';

  select coalesce(
    sum(
      public.warehouse_interval_effective_seconds(
        periods.work_session_id,
        periods.started_at,
        periods.ended_at,
        sample_now
      )
    ),
    0::bigint
  )::bigint
    into picking_effective_seconds_value
  from public.warehouse_work_periods as periods
  where periods.work_session_id = target_work_session_id
    and periods.area_code = 'picking'
    and periods.started_at < sample_now;

  select coalesce(
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
    into break_seconds_value
  from public.warehouse_work_breaks as breaks
  where breaks.work_session_id = target_work_session_id
    and breaks.started_at < sample_now;

  select jsonb_build_object(
    'id', jobs.id,
    'job_type', jobs.job_type,
    'identifier', jobs.identifier,
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
    into active_job_value
  from public.warehouse_picking_jobs as jobs
  where jobs.work_session_id = target_work_session_id
    and jobs.status = 'active'
  order by jobs.started_at desc
  limit 1;

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
        'job_type', jobs.job_type,
        'identifier', jobs.identifier,
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
    from public.warehouse_picking_jobs as jobs
    where jobs.work_session_id = target_work_session_id
      and jobs.status = 'completed'
    order by jobs.started_at desc
    limit 5
  ) as recent;

  return jsonb_build_object(
    'work_session_id', target_work_session_id,
    'server_now', sample_now,
    'completed_carts', completed_carts_value,
    'completed_no_cart', completed_no_cart_value,
    'total_completed', total_completed_value,
    'ready_for_shipping_carts', ready_for_shipping_carts_value,
    'avg_cart_effective_seconds', avg_cart_effective_seconds_value,
    'picking_effective_seconds', picking_effective_seconds_value,
    'break_seconds', break_seconds_value,
    'active_job', active_job_value,
    'recent_jobs', recent_jobs_value
  );
end;
$$;

revoke all on function public.warehouse_get_picking_summary(text) from public;
grant execute on function public.warehouse_get_picking_summary(text)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- Cierre automatico de un periodo Picking.
-- Si existe carro activo, lo deja preparado para Expedicion y registra evento.
-- Los cierres manuales siguen bloqueados hasta finalizar el trabajo.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_guard_active_picking_job()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  active_job_id uuid;
  active_job_type text;
  active_cart_id uuid;
  active_work_session_id uuid;
  active_employee_id uuid;
begin
  if old.ended_at is null
     and new.ended_at is not null
     and old.area_code = 'picking' then

    select
      jobs.id,
      jobs.job_type,
      jobs.cart_id,
      jobs.work_session_id
      into
        active_job_id,
        active_job_type,
        active_cart_id,
        active_work_session_id
    from public.warehouse_picking_jobs as jobs
    where jobs.work_period_id = old.id
      and jobs.status = 'active'
    for update
    limit 1;

    if active_job_id is not null then
      if new.ended_terminal_id is not null then
        raise exception
          'Finaliza el trabajo de Picking activo antes de cambiar de tarea o finalizar la jornada.';
      end if;

      select sessions.employee_id
        into active_employee_id
      from public.warehouse_work_sessions as sessions
      where sessions.id = active_work_session_id;

      if active_job_type = 'cart' then
        perform 1
        from public.warehouse_carts as carts
        where carts.id = active_cart_id
        for update;

        update public.warehouse_carts
        set state = 'ready_for_shipping'
        where id = active_cart_id
          and state = 'picking';
      end if;

      update public.warehouse_picking_jobs
      set
        status = 'completed',
        ended_at = new.ended_at,
        closed_automatically = true,
        close_reason = 'automatic'
      where id = active_job_id;

      if active_job_type = 'cart' then
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
        ) values (
          active_cart_id,
          active_job_id,
          active_work_session_id,
          active_employee_id,
          null,
          'picking',
          'ready_for_shipping',
          'picking_closed_automatically',
          new.ended_at
        )
        on conflict (picking_job_id, to_state)
          where picking_job_id is not null
        do nothing;
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.warehouse_guard_active_picking_job()
  from public, anon, authenticated;

-- Trigger ya existente: se recrea para dejar explicita la version FASE 5.
drop trigger if exists warehouse_work_periods_guard_active_picking_job
  on public.warehouse_work_periods;

create trigger warehouse_work_periods_guard_active_picking_job
before update of ended_at on public.warehouse_work_periods
for each row execute function public.warehouse_guard_active_picking_job();

do $$
begin
  if to_regclass('public.warehouse_carts') is null then
    raise exception 'No existe warehouse_carts tras FASE 5.';
  end if;

  if to_regclass('public.warehouse_cart_events') is null then
    raise exception 'No existe warehouse_cart_events tras FASE 5.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'warehouse_picking_jobs'
      and column_name = 'cart_id'
  ) then
    raise exception 'No existe warehouse_picking_jobs.cart_id tras FASE 5.';
  end if;

  if to_regprocedure('public.warehouse_start_picking_job(text,text,text)') is null then
    raise exception 'No existe warehouse_start_picking_job tras FASE 5.';
  end if;

  if to_regprocedure('public.warehouse_finish_picking_job(text)') is null then
    raise exception 'No existe warehouse_finish_picking_job tras FASE 5.';
  end if;

  if to_regprocedure('public.warehouse_get_picking_summary(text)') is null then
    raise exception 'No existe warehouse_get_picking_summary tras FASE 5.';
  end if;
end;
$$;

commit;
