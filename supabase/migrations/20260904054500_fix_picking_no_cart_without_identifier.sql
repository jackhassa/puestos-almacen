-- ============================================================================
-- Puestos Almacen - FASE 4.1
-- Correccion Picking sin carro: no requiere albaran ni referencia.
--
-- La migracion de FASE 4 ya esta aplicada y NO se modifica.
-- Para mantener trazabilidad, los trabajos sin carro reciben un identificador
-- tecnico interno generado por la base de datos.
-- ============================================================================

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

  if normalized_job_type is null or normalized_job_type not in ('cart', 'no_cart') then
    raise exception 'Tipo de trabajo de Picking no valido.';
  end if;

  if normalized_job_type = 'cart' then
    normalized_identifier := btrim(target_identifier);

    if normalized_identifier is null or normalized_identifier = '' then
      raise exception 'El codigo del carro es obligatorio.';
    end if;
  else
    -- Identificador exclusivamente tecnico; no se solicita ni se muestra al operario.
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

do $$
begin
  if to_regprocedure('public.warehouse_start_picking_job(text,text,text)') is null then
    raise exception 'No existe warehouse_start_picking_job tras la correccion FASE 4.1.';
  end if;
end;
$$;
