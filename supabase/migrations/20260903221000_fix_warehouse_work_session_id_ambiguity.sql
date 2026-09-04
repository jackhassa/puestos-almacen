-- ============================================================================
-- Puestos Almacen
-- Correccion: referencias ambiguas work_session_id en RPC operativas
-- Fecha: 2026-09-03
--
-- No modifica migraciones ya aplicadas. Sustituye únicamente las funciones
-- afectadas conservando sus firmas y permisos.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Finalizar pausa.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_end_break(target_session_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  target_work_session_id uuid;
  current_break_id uuid;
begin
  select terminal_sessions.employee_id
    into actor_employee_id
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
    and work_sessions.status = 'break'
  for update
  limit 1;

  if target_work_session_id is null then
    raise exception 'No hay una pausa abierta.';
  end if;

  select breaks.id
    into current_break_id
  from public.warehouse_work_breaks as breaks
  where breaks.work_session_id = target_work_session_id
    and breaks.ended_at is null
  for update
  limit 1;

  if current_break_id is null then
    raise exception 'Estado de pausa inconsistente.';
  end if;

  update public.warehouse_work_breaks
  set
    ended_at = now(),
    close_reason = 'operator'
  where id = current_break_id;

  update public.warehouse_work_sessions
  set status = 'working'
  where id = target_work_session_id;
end;
$$;

revoke all on function public.warehouse_end_break(text) from public;
grant execute on function public.warehouse_end_break(text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Finalizar jornada manualmente.
-- Si habia una pausa abierta, se cierra dejando trazabilidad.
-- --------------------------------------------------------------------------
create or replace function public.warehouse_finish_work_session(target_session_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_employee_id uuid;
  actor_terminal_id uuid;
  target_work_session_id uuid;
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
    and work_sessions.status <> 'completed'
  for update
  limit 1;

  if target_work_session_id is null then
    raise exception 'No hay una jornada abierta.';
  end if;

  update public.warehouse_work_breaks
  set
    ended_at = now(),
    closed_automatically = false,
    close_reason = 'session_finished'
  where warehouse_work_breaks.work_session_id = target_work_session_id
    and ended_at is null;

  update public.warehouse_work_periods
  set
    ended_at = now(),
    ended_terminal_id = actor_terminal_id
  where warehouse_work_periods.work_session_id = target_work_session_id
    and ended_at is null;

  update public.warehouse_work_sessions
  set
    status = 'completed',
    ended_at = now(),
    closed_automatically = false,
    last_terminal_id = actor_terminal_id
  where id = target_work_session_id;
end;
$$;

revoke all on function public.warehouse_finish_work_session(text) from public;
grant execute on function public.warehouse_finish_work_session(text) to anon, authenticated;

-- Verificacion de existencia de ambas RPC.
do $$
begin
  if to_regprocedure('public.warehouse_end_break(text)') is null then
    raise exception 'No existe warehouse_end_break(text) tras la correccion.';
  end if;

  if to_regprocedure('public.warehouse_finish_work_session(text)') is null then
    raise exception 'No existe warehouse_finish_work_session(text) tras la correccion.';
  end if;
end;
$$;
