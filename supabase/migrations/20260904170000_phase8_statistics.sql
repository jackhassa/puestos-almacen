begin;

-- ============================================================================
-- Puestos Almacen - FASE 8
-- Estadisticas historicas por trabajador, puesto y periodo.
--
-- Principios:
-- - no duplica datos derivados en tablas nuevas;
-- - calcula a partir de sesiones, pausas, periodos, Picking y Expedicion;
-- - mantiene la planificacion como fuente de verdad fuera de este RPC;
-- - el frontend combina estos datos reales con la planificacion teorica (8 h/dia);
-- - los cronometros abiertos se muestrean con un unico timestamp de base de datos.
-- ============================================================================

create or replace function public.warehouse_statistics_get_snapshot(
  target_from date,
  target_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  sample_now timestamptz := clock_timestamp();
  sla_minutes integer;
  result_value jsonb;
begin
  if target_from is null or target_to is null then
    raise exception 'Las fechas desde y hasta son obligatorias.';
  end if;

  if target_to < target_from then
    raise exception 'La fecha hasta no puede ser anterior a la fecha desde.';
  end if;

  if (target_to - target_from) > 1461 then
    raise exception 'El rango maximo permitido es de 1462 dias.';
  end if;

  select settings.cart_sla_minutes
    into sla_minutes
  from public.warehouse_manager_settings as settings
  where settings.singleton = true;

  with
  session_metrics as (
    select
      sessions.id as work_session_id,
      sessions.employee_id,
      employees.name as employee_name,
      sessions.operational_date,
      sessions.shift_code,
      sessions.planned_assignment_code,
      greatest(
        0::bigint,
        floor(extract(epoch from (
          least(coalesce(sessions.ended_at, sample_now), sample_now)
          - sessions.started_at
        )))::bigint
      ) as recorded_seconds,
      public.warehouse_interval_effective_seconds(
        sessions.id,
        sessions.started_at,
        sessions.ended_at,
        sample_now
      ) as effective_session_seconds,
      (
        select count(*)::bigint
        from public.warehouse_work_breaks as breaks
        where breaks.work_session_id = sessions.id
      ) as break_count
    from public.warehouse_work_sessions as sessions
    join public.employees as employees
      on employees.id = sessions.employee_id
    where sessions.operational_date between target_from and target_to
  ),
  sessions_enriched as (
    select
      session_metrics.*,
      greatest(
        0::bigint,
        session_metrics.recorded_seconds - session_metrics.effective_session_seconds
      ) as break_seconds
    from session_metrics
  ),
  period_metrics as (
    select
      periods.id as work_period_id,
      sessions.work_session_id,
      sessions.employee_id,
      sessions.employee_name,
      sessions.operational_date,
      periods.area_code,
      periods.mode_code,
      public.warehouse_interval_effective_seconds(
        sessions.work_session_id,
        periods.started_at,
        periods.ended_at,
        sample_now
      ) as effective_seconds
    from public.warehouse_work_periods as periods
    join sessions_enriched as sessions
      on sessions.work_session_id = periods.work_session_id
  ),
  non_job_productive_periods as (
    select period_metrics.*
    from period_metrics
    where period_metrics.area_code <> 'picking'
      and not (
        period_metrics.area_code in ('mesa1', 'mesa2', 'mesa3', 'mesa4')
        and period_metrics.mode_code = 'cart'
      )
  ),
  picking_metrics as (
    select
      picking.id as picking_job_id,
      sessions.work_session_id,
      sessions.employee_id,
      sessions.employee_name,
      sessions.operational_date,
      picking.job_type,
      picking.status,
      picking.priority_code,
      picking.started_at,
      picking.ended_at,
      public.warehouse_interval_effective_seconds(
        sessions.work_session_id,
        picking.started_at,
        picking.ended_at,
        sample_now
      ) as effective_seconds
    from public.warehouse_picking_jobs as picking
    join sessions_enriched as sessions
      on sessions.work_session_id = picking.work_session_id
    where picking.status <> 'cancelled'
  ),
  shipping_metrics as (
    select
      shipping.id as shipping_job_id,
      shipping.picking_job_id,
      sessions.work_session_id,
      sessions.employee_id,
      sessions.employee_name,
      sessions.operational_date,
      shipping.area_code,
      shipping.status,
      shipping.started_at,
      shipping.ended_at,
      public.warehouse_interval_effective_seconds(
        sessions.work_session_id,
        shipping.started_at,
        shipping.ended_at,
        sample_now
      ) as effective_seconds
    from public.warehouse_shipping_jobs as shipping
    join sessions_enriched as sessions
      on sessions.work_session_id = shipping.work_session_id
    where shipping.status <> 'cancelled'
  ),
  employee_sessions as (
    select
      sessions.employee_id,
      max(sessions.employee_name) as employee_name,
      count(*)::bigint as worked_days,
      sum(sessions.recorded_seconds)::bigint as recorded_seconds,
      sum(sessions.break_count)::bigint as break_count,
      sum(sessions.break_seconds)::bigint as break_seconds,
      sum(sessions.effective_session_seconds)::bigint as session_effective_seconds
    from sessions_enriched as sessions
    group by sessions.employee_id
  ),
  employee_non_job as (
    select
      periods.employee_id,
      sum(periods.effective_seconds)::bigint as productive_seconds
    from non_job_productive_periods as periods
    group by periods.employee_id
  ),
  employee_picking as (
    select
      picking.employee_id,
      sum(picking.effective_seconds)::bigint as productive_seconds,
      count(*) filter (
        where picking.status = 'completed' and picking.job_type = 'cart'
      )::bigint as picking_carts,
      count(*) filter (
        where picking.status = 'completed' and picking.job_type = 'no_cart'
      )::bigint as no_cart_jobs,
      count(*) filter (
        where picking.status = 'completed'
      )::bigint as completed_jobs,
      coalesce(round(avg(picking.effective_seconds) filter (
        where picking.status = 'completed' and picking.job_type = 'cart'
      ))::bigint, 0::bigint) as avg_picking_cart_seconds
    from picking_metrics as picking
    group by picking.employee_id
  ),
  employee_shipping as (
    select
      shipping.employee_id,
      sum(shipping.effective_seconds)::bigint as productive_seconds,
      count(*) filter (
        where shipping.status = 'completed'
      )::bigint as shipping_carts,
      coalesce(round(avg(shipping.effective_seconds) filter (
        where shipping.status = 'completed'
      ))::bigint, 0::bigint) as avg_shipping_seconds
    from shipping_metrics as shipping
    group by shipping.employee_id
  ),
  employee_rows as (
    select
      employee_sessions.employee_id,
      employee_sessions.employee_name,
      employee_sessions.worked_days,
      employee_sessions.recorded_seconds,
      employee_sessions.break_count,
      employee_sessions.break_seconds,
      employee_sessions.session_effective_seconds,
      (
        coalesce(employee_non_job.productive_seconds, 0::bigint)
        + coalesce(employee_picking.productive_seconds, 0::bigint)
        + coalesce(employee_shipping.productive_seconds, 0::bigint)
      )::bigint as productive_seconds,
      coalesce(employee_picking.picking_carts, 0::bigint) as picking_carts,
      coalesce(employee_picking.no_cart_jobs, 0::bigint) as no_cart_jobs,
      coalesce(employee_shipping.shipping_carts, 0::bigint) as shipping_carts,
      (
        coalesce(employee_picking.completed_jobs, 0::bigint)
        + coalesce(employee_shipping.shipping_carts, 0::bigint)
      )::bigint as productive_units,
      coalesce(employee_picking.avg_picking_cart_seconds, 0::bigint) as avg_picking_cart_seconds,
      coalesce(employee_shipping.avg_shipping_seconds, 0::bigint) as avg_shipping_seconds
    from employee_sessions
    left join employee_non_job
      on employee_non_job.employee_id = employee_sessions.employee_id
    left join employee_picking
      on employee_picking.employee_id = employee_sessions.employee_id
    left join employee_shipping
      on employee_shipping.employee_id = employee_sessions.employee_id
  ),
  area_catalog as (
    select *
    from (values
      ('gestor'::text, 'Gestor'::text, 1),
      ('entradas'::text, 'Entradas'::text, 2),
      ('picking'::text, 'Picking'::text, 3),
      ('mesa1'::text, 'Mesa 1'::text, 4),
      ('mesa2'::text, 'Mesa 2'::text, 5),
      ('mesa3'::text, 'Mesa 3'::text, 6),
      ('mesa4'::text, 'Mesa 4'::text, 7),
      ('montajes'::text, 'Montajes'::text, 8)
    ) as catalog(area_code, area_label, display_order)
  ),
  area_presence as (
    select
      periods.area_code,
      sum(periods.effective_seconds)::bigint as presence_seconds,
      count(distinct periods.employee_id)::bigint as workers
    from period_metrics as periods
    group by periods.area_code
  ),
  area_non_job as (
    select
      periods.area_code,
      sum(periods.effective_seconds)::bigint as productive_seconds
    from non_job_productive_periods as periods
    group by periods.area_code
  ),
  area_picking as (
    select
      'picking'::text as area_code,
      sum(picking.effective_seconds)::bigint as productive_seconds,
      count(*) filter (where picking.status = 'completed')::bigint as productive_units,
      count(*) filter (
        where picking.status = 'completed' and picking.job_type = 'cart'
      )::bigint as picking_carts,
      count(*) filter (
        where picking.status = 'completed' and picking.job_type = 'no_cart'
      )::bigint as no_cart_jobs,
      coalesce(round(avg(picking.effective_seconds) filter (
        where picking.status = 'completed' and picking.job_type = 'cart'
      ))::bigint, 0::bigint) as avg_job_seconds
    from picking_metrics as picking
  ),
  area_shipping as (
    select
      shipping.area_code,
      sum(shipping.effective_seconds)::bigint as productive_seconds,
      count(*) filter (where shipping.status = 'completed')::bigint as productive_units,
      count(*) filter (where shipping.status = 'completed')::bigint as shipping_carts,
      coalesce(round(avg(shipping.effective_seconds) filter (
        where shipping.status = 'completed'
      ))::bigint, 0::bigint) as avg_job_seconds
    from shipping_metrics as shipping
    group by shipping.area_code
  ),
  area_rows as (
    select
      catalog.area_code,
      catalog.area_label,
      catalog.display_order,
      coalesce(area_presence.workers, 0::bigint) as workers,
      coalesce(area_presence.presence_seconds, 0::bigint) as presence_seconds,
      (
        coalesce(area_non_job.productive_seconds, 0::bigint)
        + case when catalog.area_code = 'picking'
            then coalesce(area_picking.productive_seconds, 0::bigint)
            else 0::bigint end
        + coalesce(area_shipping.productive_seconds, 0::bigint)
      )::bigint as productive_seconds,
      (
        case when catalog.area_code = 'picking'
          then coalesce(area_picking.productive_units, 0::bigint)
          else 0::bigint end
        + coalesce(area_shipping.productive_units, 0::bigint)
      )::bigint as productive_units,
      case when catalog.area_code = 'picking'
        then coalesce(area_picking.picking_carts, 0::bigint)
        else 0::bigint end as picking_carts,
      case when catalog.area_code = 'picking'
        then coalesce(area_picking.no_cart_jobs, 0::bigint)
        else 0::bigint end as no_cart_jobs,
      coalesce(area_shipping.shipping_carts, 0::bigint) as shipping_carts,
      case
        when catalog.area_code = 'picking' then coalesce(area_picking.avg_job_seconds, 0::bigint)
        when catalog.area_code in ('mesa1', 'mesa2', 'mesa3', 'mesa4')
          then coalesce(area_shipping.avg_job_seconds, 0::bigint)
        else 0::bigint
      end as avg_job_seconds
    from area_catalog as catalog
    left join area_presence
      on area_presence.area_code = catalog.area_code
    left join area_non_job
      on area_non_job.area_code = catalog.area_code
    left join area_picking
      on area_picking.area_code = catalog.area_code
    left join area_shipping
      on area_shipping.area_code = catalog.area_code
  ),
  daily_sessions as (
    select
      sessions.operational_date,
      count(*)::bigint as workers,
      sum(sessions.recorded_seconds)::bigint as recorded_seconds,
      sum(sessions.break_count)::bigint as break_count,
      sum(sessions.break_seconds)::bigint as break_seconds,
      sum(sessions.effective_session_seconds)::bigint as session_effective_seconds
    from sessions_enriched as sessions
    group by sessions.operational_date
  ),
  daily_non_job as (
    select
      periods.operational_date,
      sum(periods.effective_seconds)::bigint as productive_seconds
    from non_job_productive_periods as periods
    group by periods.operational_date
  ),
  daily_picking as (
    select
      picking.operational_date,
      sum(picking.effective_seconds)::bigint as productive_seconds,
      count(*) filter (where picking.status = 'completed')::bigint as completed_jobs,
      count(*) filter (
        where picking.status = 'completed' and picking.job_type = 'cart'
      )::bigint as picking_carts,
      count(*) filter (
        where picking.status = 'completed' and picking.job_type = 'no_cart'
      )::bigint as no_cart_jobs
    from picking_metrics as picking
    group by picking.operational_date
  ),
  daily_shipping as (
    select
      shipping.operational_date,
      sum(shipping.effective_seconds)::bigint as productive_seconds,
      count(*) filter (where shipping.status = 'completed')::bigint as shipping_carts
    from shipping_metrics as shipping
    group by shipping.operational_date
  ),
  daily_rows as (
    select
      dates.day::date as operational_date,
      coalesce(daily_sessions.workers, 0::bigint) as workers,
      coalesce(daily_sessions.recorded_seconds, 0::bigint) as recorded_seconds,
      coalesce(daily_sessions.break_count, 0::bigint) as break_count,
      coalesce(daily_sessions.break_seconds, 0::bigint) as break_seconds,
      coalesce(daily_sessions.session_effective_seconds, 0::bigint) as session_effective_seconds,
      (
        coalesce(daily_non_job.productive_seconds, 0::bigint)
        + coalesce(daily_picking.productive_seconds, 0::bigint)
        + coalesce(daily_shipping.productive_seconds, 0::bigint)
      )::bigint as productive_seconds,
      coalesce(daily_picking.picking_carts, 0::bigint) as picking_carts,
      coalesce(daily_picking.no_cart_jobs, 0::bigint) as no_cart_jobs,
      coalesce(daily_shipping.shipping_carts, 0::bigint) as shipping_carts,
      (
        coalesce(daily_picking.completed_jobs, 0::bigint)
        + coalesce(daily_shipping.shipping_carts, 0::bigint)
      )::bigint as productive_units
    from generate_series(target_from, target_to, interval '1 day') as dates(day)
    left join daily_sessions
      on daily_sessions.operational_date = dates.day::date
    left join daily_non_job
      on daily_non_job.operational_date = dates.day::date
    left join daily_picking
      on daily_picking.operational_date = dates.day::date
    left join daily_shipping
      on daily_shipping.operational_date = dates.day::date
  ),
  cart_cycles as (
    select
      shipping.id as shipping_job_id,
      shipping.operational_date,
      picking.employee_id as picking_employee_id,
      shipping.employee_id as shipping_employee_id,
      picking.priority_code,
      public.warehouse_interval_effective_seconds(
        picking.work_session_id,
        picking.started_at,
        picking.ended_at,
        sample_now
      ) as picking_effective_seconds,
      shipping.effective_seconds as shipping_effective_seconds,
      greatest(
        0::bigint,
        floor(extract(epoch from (shipping.ended_at - picking_job.started_at)))::bigint
      ) as total_cycle_seconds
    from shipping_metrics as shipping
    join public.warehouse_picking_jobs as picking_job
      on picking_job.id = shipping.picking_job_id
    join picking_metrics as picking
      on picking.picking_job_id = shipping.picking_job_id
    where shipping.status = 'completed'
      and shipping.ended_at is not null
      and picking.status = 'completed'
      and picking.job_type = 'cart'
  ),
  cycle_summary as (
    select
      count(*)::bigint as completed_cycles,
      coalesce(round(avg(cart_cycles.picking_effective_seconds))::bigint, 0::bigint) as avg_picking_seconds,
      coalesce(round(avg(cart_cycles.shipping_effective_seconds))::bigint, 0::bigint) as avg_shipping_seconds,
      coalesce(round(avg(cart_cycles.total_cycle_seconds))::bigint, 0::bigint) as avg_total_seconds,
      count(*) filter (where cart_cycles.priority_code = 'high')::bigint as high_priority_cycles,
      case
        when sla_minutes is null then null
        else count(*) filter (
          where cart_cycles.total_cycle_seconds > sla_minutes * 60
        )::bigint
      end as out_of_sla
    from cart_cycles
  ),
  global_summary as (
    select
      count(*)::bigint as worked_days,
      coalesce(sum(employee_rows.recorded_seconds), 0::bigint) as recorded_seconds,
      coalesce(sum(employee_rows.break_count), 0::bigint) as break_count,
      coalesce(sum(employee_rows.break_seconds), 0::bigint) as break_seconds,
      coalesce(sum(employee_rows.session_effective_seconds), 0::bigint) as session_effective_seconds,
      coalesce(sum(employee_rows.productive_seconds), 0::bigint) as productive_seconds,
      coalesce(sum(employee_rows.picking_carts), 0::bigint) as picking_carts,
      coalesce(sum(employee_rows.no_cart_jobs), 0::bigint) as no_cart_jobs,
      coalesce(sum(employee_rows.shipping_carts), 0::bigint) as shipping_carts,
      coalesce(sum(employee_rows.productive_units), 0::bigint) as productive_units
    from employee_rows
  )
  select jsonb_build_object(
    'from', target_from,
    'to', target_to,
    'sample_now', sample_now,
    'cart_sla_minutes', sla_minutes,
    'summary', jsonb_build_object(
      'worked_employee_rows', coalesce((select count(*) from employee_rows), 0),
      'recorded_seconds', coalesce((select recorded_seconds from global_summary), 0),
      'break_count', coalesce((select break_count from global_summary), 0),
      'break_seconds', coalesce((select break_seconds from global_summary), 0),
      'session_effective_seconds', coalesce((select session_effective_seconds from global_summary), 0),
      'productive_seconds', coalesce((select productive_seconds from global_summary), 0),
      'picking_carts', coalesce((select picking_carts from global_summary), 0),
      'no_cart_jobs', coalesce((select no_cart_jobs from global_summary), 0),
      'shipping_carts', coalesce((select shipping_carts from global_summary), 0),
      'productive_units', coalesce((select productive_units from global_summary), 0),
      'completed_cycles', coalesce((select completed_cycles from cycle_summary), 0),
      'avg_picking_seconds', coalesce((select avg_picking_seconds from cycle_summary), 0),
      'avg_shipping_seconds', coalesce((select avg_shipping_seconds from cycle_summary), 0),
      'avg_total_seconds', coalesce((select avg_total_seconds from cycle_summary), 0),
      'high_priority_cycles', coalesce((select high_priority_cycles from cycle_summary), 0),
      'out_of_sla', (select out_of_sla from cycle_summary)
    ),
    'employees', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'employee_id', employee_rows.employee_id,
          'employee_name', employee_rows.employee_name,
          'worked_days', employee_rows.worked_days,
          'recorded_seconds', employee_rows.recorded_seconds,
          'break_count', employee_rows.break_count,
          'break_seconds', employee_rows.break_seconds,
          'session_effective_seconds', employee_rows.session_effective_seconds,
          'productive_seconds', employee_rows.productive_seconds,
          'picking_carts', employee_rows.picking_carts,
          'no_cart_jobs', employee_rows.no_cart_jobs,
          'shipping_carts', employee_rows.shipping_carts,
          'productive_units', employee_rows.productive_units,
          'avg_picking_cart_seconds', employee_rows.avg_picking_cart_seconds,
          'avg_shipping_seconds', employee_rows.avg_shipping_seconds,
          'productivity_per_hour', case
            when employee_rows.productive_seconds > 0 and employee_rows.productive_units > 0
              then round(
                employee_rows.productive_units::numeric * 3600
                / employee_rows.productive_seconds::numeric,
                2
              )
            else null
          end
        )
        order by employee_rows.employee_name
      )
      from employee_rows
    ), '[]'::jsonb),
    'areas', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'area_code', area_rows.area_code,
          'area_label', area_rows.area_label,
          'workers', area_rows.workers,
          'presence_seconds', area_rows.presence_seconds,
          'productive_seconds', area_rows.productive_seconds,
          'productive_units', area_rows.productive_units,
          'picking_carts', area_rows.picking_carts,
          'no_cart_jobs', area_rows.no_cart_jobs,
          'shipping_carts', area_rows.shipping_carts,
          'avg_job_seconds', area_rows.avg_job_seconds,
          'productivity_per_hour', case
            when area_rows.productive_seconds > 0 and area_rows.productive_units > 0
              then round(
                area_rows.productive_units::numeric * 3600
                / area_rows.productive_seconds::numeric,
                2
              )
            else null
          end
        )
        order by area_rows.display_order
      )
      from area_rows
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'operational_date', daily_rows.operational_date,
          'workers', daily_rows.workers,
          'recorded_seconds', daily_rows.recorded_seconds,
          'break_count', daily_rows.break_count,
          'break_seconds', daily_rows.break_seconds,
          'session_effective_seconds', daily_rows.session_effective_seconds,
          'productive_seconds', daily_rows.productive_seconds,
          'picking_carts', daily_rows.picking_carts,
          'no_cart_jobs', daily_rows.no_cart_jobs,
          'shipping_carts', daily_rows.shipping_carts,
          'productive_units', daily_rows.productive_units,
          'productivity_per_hour', case
            when daily_rows.productive_seconds > 0 and daily_rows.productive_units > 0
              then round(
                daily_rows.productive_units::numeric * 3600
                / daily_rows.productive_seconds::numeric,
                2
              )
            else null
          end
        )
        order by daily_rows.operational_date
      )
      from daily_rows
    ), '[]'::jsonb)
  )
  into result_value;

  return result_value;
end;
$$;

revoke all on function public.warehouse_statistics_get_snapshot(date, date) from public;
grant execute on function public.warehouse_statistics_get_snapshot(date, date)
  to anon, authenticated;

-- Verificacion minima.
do $$
begin
  if to_regprocedure('public.warehouse_statistics_get_snapshot(date,date)') is null then
    raise exception 'No existe warehouse_statistics_get_snapshot tras FASE 8.';
  end if;
end;
$$;

commit;
