-- ============================================================================
-- Puestos Almacen - FASE 3
-- Entradas: resumen de tiempo efectivo por jornada y por puesto Entradas.
--
-- No se registran manualmente entradas de mercancia en esta fase.
-- La productividad real podra cruzarse posteriormente con estos tiempos.
-- ============================================================================

create or replace function public.warehouse_get_entries_summary(target_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  target_work_session_id uuid;
  session_started_at timestamptz;
  sample_now timestamptz := clock_timestamp();
  break_count_value bigint := 0;
  break_seconds_value bigint := 0;
  elapsed_seconds_value bigint := 0;
  effective_seconds_value bigint := 0;
  entries_period_count_value bigint := 0;
  entries_gross_seconds_value bigint := 0;
  entries_break_seconds_value bigint := 0;
  entries_effective_seconds_value bigint := 0;
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

  select work_sessions.id, work_sessions.started_at
    into target_work_session_id, session_started_at
  from public.warehouse_work_sessions as work_sessions
  where work_sessions.employee_id = actor_employee_id
    and work_sessions.status <> 'completed'
  order by work_sessions.started_at desc
  limit 1;

  if target_work_session_id is null then
    raise exception 'No hay una jornada abierta.';
  end if;

  elapsed_seconds_value := greatest(
    0,
    floor(extract(epoch from (sample_now - session_started_at)))::bigint
  );

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
      0
    )::bigint
    into break_count_value, break_seconds_value
  from public.warehouse_work_breaks as breaks
  where breaks.work_session_id = target_work_session_id
    and breaks.started_at < sample_now;

  break_seconds_value := greatest(
    0,
    least(break_seconds_value, elapsed_seconds_value)
  );

  effective_seconds_value := greatest(
    0,
    elapsed_seconds_value - break_seconds_value
  );

  select
    count(*)::bigint,
    coalesce(
      sum(
        greatest(
          0::bigint,
          floor(
            extract(
              epoch from (
                least(coalesce(periods.ended_at, sample_now), sample_now)
                - periods.started_at
              )
            )
          )::bigint
        )
      ),
      0
    )::bigint
    into entries_period_count_value, entries_gross_seconds_value
  from public.warehouse_work_periods as periods
  where periods.work_session_id = target_work_session_id
    and periods.area_code = 'entradas'
    and periods.started_at < sample_now
    and least(coalesce(periods.ended_at, sample_now), sample_now) > periods.started_at;

  select
    coalesce(
      sum(
        greatest(
          0::bigint,
          floor(
            extract(
              epoch from (
                least(
                  least(coalesce(periods.ended_at, sample_now), sample_now),
                  least(coalesce(breaks.ended_at, sample_now), sample_now)
                )
                -
                greatest(periods.started_at, breaks.started_at)
              )
            )
          )::bigint
        )
      ),
      0
    )::bigint
    into entries_break_seconds_value
  from public.warehouse_work_periods as periods
  join public.warehouse_work_breaks as breaks
    on breaks.work_session_id = target_work_session_id
  where periods.work_session_id = target_work_session_id
    and periods.area_code = 'entradas'
    and periods.started_at < sample_now
    and breaks.started_at < sample_now
    and breaks.started_at
        < least(coalesce(periods.ended_at, sample_now), sample_now)
    and least(coalesce(breaks.ended_at, sample_now), sample_now)
        > periods.started_at;

  entries_effective_seconds_value := greatest(
    0,
    entries_gross_seconds_value - entries_break_seconds_value
  );

  return jsonb_build_object(
    'work_session_id', target_work_session_id,
    'started_at', session_started_at,
    'server_now', sample_now,
    'break_count', break_count_value,
    'break_seconds', break_seconds_value,
    'elapsed_seconds', elapsed_seconds_value,
    'effective_seconds', effective_seconds_value,
    'entradas_effective_seconds', entries_effective_seconds_value,
    'entradas_period_count', entries_period_count_value
  );
end;
$$;

revoke all on function public.warehouse_get_entries_summary(text) from public;
grant execute on function public.warehouse_get_entries_summary(text) to anon, authenticated;

do $$
begin
  if to_regprocedure('public.warehouse_get_entries_summary(text)') is null then
    raise exception 'No existe warehouse_get_entries_summary(text) tras FASE 3.';
  end if;
end;
$$;
