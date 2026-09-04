begin;

-- FASE 5.2
-- Picking solo cuenta tiempo efectivo cuando hay carro o trabajo sin carro activo.
-- Sin trabajo activo el estado visual es DISPONIBLE.
-- No modifica migraciones ya aplicadas.

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
  break_count_value bigint := 0;
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

  -- Solo suma productividad cuando existe un trabajo de Picking real.
  select coalesce(
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
    into picking_effective_seconds_value
  from public.warehouse_picking_jobs as jobs
  where jobs.work_session_id = target_work_session_id
    and jobs.started_at < sample_now;

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
    'break_count', break_count_value,
    'break_seconds', break_seconds_value,
    'active_job', active_job_value,
    'recent_jobs', recent_jobs_value
  );
end;
$$;

revoke all on function public.warehouse_get_picking_summary(text) from public;
grant execute on function public.warehouse_get_picking_summary(text)
  to anon, authenticated;

do $$
begin
  if to_regprocedure('public.warehouse_get_picking_summary(text)') is null then
    raise exception 'No existe warehouse_get_picking_summary tras FASE 5.2.';
  end if;
end;
$$;

commit;
