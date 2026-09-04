-- ============================================================================
-- Puestos Almacen - FASE 4
-- Picking: trabajos con carro y sin carro.
-- ============================================================================

create table if not exists public.warehouse_picking_jobs (
  id uuid primary key default gen_random_uuid(),
  work_session_id uuid not null
    references public.warehouse_work_sessions(id) on delete restrict,
  work_period_id uuid not null
    references public.warehouse_work_periods(id) on delete restrict,
  job_type text not null,
  identifier text not null,
  status text not null default 'active',
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

  constraint warehouse_picking_jobs_type_allowed
    check (job_type in ('cart', 'no_cart')),
  constraint warehouse_picking_jobs_identifier_not_blank
    check (btrim(identifier) <> ''),
  constraint warehouse_picking_jobs_status_allowed
    check (status in ('active', 'completed')),
  constraint warehouse_picking_jobs_end_consistent
    check (
      (status = 'active' and ended_at is null)
      or
      (status = 'completed' and ended_at is not null and ended_at >= started_at)
    ),
  constraint warehouse_picking_jobs_close_reason_allowed
    check (
      close_reason is null
      or close_reason in ('operator', 'automatic', 'correction')
    )
);

create unique index if not exists warehouse_picking_jobs_one_active_per_session_idx
  on public.warehouse_picking_jobs(work_session_id)
  where status = 'active';

create unique index if not exists warehouse_picking_jobs_active_cart_unique_idx
  on public.warehouse_picking_jobs(upper(identifier))
  where status = 'active' and job_type = 'cart';

create index if not exists warehouse_picking_jobs_session_time_idx
  on public.warehouse_picking_jobs(work_session_id, started_at desc);

drop trigger if exists warehouse_picking_jobs_set_updated_at
  on public.warehouse_picking_jobs;

create trigger warehouse_picking_jobs_set_updated_at
before update on public.warehouse_picking_jobs
for each row execute function public.warehouse_set_updated_at();

alter table public.warehouse_picking_jobs enable row level security;
revoke all on table public.warehouse_picking_jobs from anon, authenticated;

create or replace function public.warehouse_interval_effective_seconds(
  target_work_session_id uuid,
  target_started_at timestamptz,
  target_ended_at timestamptz,
  target_sample_at timestamptz
)
returns bigint
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select greatest(
    0::bigint,
    greatest(
      0::bigint,
      floor(
        extract(
          epoch from (
            least(coalesce(target_ended_at, target_sample_at), target_sample_at)
            - target_started_at
          )
        )
      )::bigint
    )
    -
    coalesce(
      (
        select sum(
          greatest(
            0::bigint,
            floor(
              extract(
                epoch from (
                  least(
                    coalesce(breaks.ended_at, target_sample_at),
                    least(coalesce(target_ended_at, target_sample_at), target_sample_at)
                  )
                  -
                  greatest(breaks.started_at, target_started_at)
                )
              )
            )::bigint
          )
        )::bigint
        from public.warehouse_work_breaks as breaks
        where breaks.work_session_id = target_work_session_id
          and breaks.started_at
              < least(coalesce(target_ended_at, target_sample_at), target_sample_at)
          and least(coalesce(breaks.ended_at, target_sample_at), target_sample_at)
              > target_started_at
      ),
      0::bigint
    )
  );
$$;

revoke all on function public.warehouse_interval_effective_seconds(
  uuid, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;

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
begin
  normalized_job_type := lower(btrim(target_job_type));
  normalized_identifier := btrim(target_identifier);

  if normalized_job_type is null or normalized_job_type not in ('cart', 'no_cart') then
    raise exception 'Tipo de trabajo de Picking no valido.';
  end if;

  if normalized_identifier is null or normalized_identifier = '' then
    raise exception 'El identificador del trabajo es obligatorio.';
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

  if normalized_job_type = 'cart'
     and exists (
       select 1
       from public.warehouse_picking_jobs as jobs
       where jobs.job_type = 'cart'
         and jobs.status = 'active'
         and upper(jobs.identifier) = upper(normalized_identifier)
     ) then
    raise exception 'Este carro ya esta activo en Picking.';
  end if;

  insert into public.warehouse_picking_jobs(
    work_session_id,
    work_period_id,
    job_type,
    identifier,
    started_terminal_id
  ) values (
    target_work_session_id,
    target_work_period_id,
    normalized_job_type,
    normalized_identifier,
    actor_terminal_id
  )
  returning id into created_job_id;

  update public.warehouse_work_sessions
  set last_terminal_id = actor_terminal_id
  where id = target_work_session_id;

  return created_job_id;

exception
  when unique_violation then
    raise exception 'Ya existe un trabajo activo o este carro esta siendo utilizado.';
end;
$$;

revoke all on function public.warehouse_start_picking_job(text, text, text) from public;
grant execute on function public.warehouse_start_picking_job(text, text, text)
  to anon, authenticated;

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

  select jobs.id
    into target_job_id
  from public.warehouse_picking_jobs as jobs
  where jobs.work_session_id = target_work_session_id
    and jobs.status = 'active'
  for update
  limit 1;

  if target_job_id is null then
    raise exception 'No hay ningun trabajo de Picking activo.';
  end if;

  update public.warehouse_picking_jobs
  set
    status = 'completed',
    ended_at = now(),
    ended_terminal_id = actor_terminal_id,
    closed_automatically = false,
    close_reason = 'operator'
  where id = target_job_id;

  update public.warehouse_work_sessions
  set last_terminal_id = actor_terminal_id
  where id = target_work_session_id;

  return target_job_id;
end;
$$;

revoke all on function public.warehouse_finish_picking_job(text) from public;
grant execute on function public.warehouse_finish_picking_job(text)
  to anon, authenticated;

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

create or replace function public.warehouse_guard_active_picking_job()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if old.ended_at is null
     and new.ended_at is not null
     and old.area_code = 'picking'
     and exists (
       select 1
       from public.warehouse_picking_jobs as jobs
       where jobs.work_period_id = old.id
         and jobs.status = 'active'
     ) then

    if new.ended_terminal_id is not null then
      raise exception 'Finaliza el trabajo de Picking activo antes de cambiar de tarea o finalizar la jornada.';
    end if;

    update public.warehouse_picking_jobs
    set
      status = 'completed',
      ended_at = new.ended_at,
      closed_automatically = true,
      close_reason = 'automatic'
    where work_period_id = old.id
      and status = 'active';
  end if;

  return new;
end;
$$;

revoke all on function public.warehouse_guard_active_picking_job()
  from public, anon, authenticated;

drop trigger if exists warehouse_work_periods_guard_active_picking_job
  on public.warehouse_work_periods;

create trigger warehouse_work_periods_guard_active_picking_job
before update of ended_at on public.warehouse_work_periods
for each row execute function public.warehouse_guard_active_picking_job();

do $$
begin
  if to_regclass('public.warehouse_picking_jobs') is null then
    raise exception 'No existe warehouse_picking_jobs tras FASE 4.';
  end if;

  if to_regprocedure('public.warehouse_start_picking_job(text,text,text)') is null then
    raise exception 'No existe warehouse_start_picking_job tras FASE 4.';
  end if;

  if to_regprocedure('public.warehouse_finish_picking_job(text)') is null then
    raise exception 'No existe warehouse_finish_picking_job tras FASE 4.';
  end if;

  if to_regprocedure('public.warehouse_get_picking_summary(text)') is null then
    raise exception 'No existe warehouse_get_picking_summary tras FASE 4.';
  end if;
end;
$$;
