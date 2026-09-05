begin;

-- ============================================================================
-- Puestos Almacen - FASE 9.2
-- Gestor:
--   * acciones de carro autenticadas con la sesion Gestor;
--   * elimina la dependencia del campo manual "responsable";
--   * devuelve el estado final del carro tras cada accion;
--   * SLA protegido por la misma sesion.
--
-- No modifica migraciones ya aplicadas.
-- ============================================================================

create or replace function public.warehouse_manager_require_session(
  target_session_token text
)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_name text;
begin
  if nullif(btrim(coalesce(target_session_token, '')), '') is null then
    raise exception 'Sesion de gestion no valida o caducada.';
  end if;

  perform 1
  from public.warehouse_management_sessions as management_sessions
  where management_sessions.token_hash =
        digest(target_session_token, 'sha256')
    and management_sessions.revoked_at is null
    and management_sessions.expires_at > now()
  limit 1;

  if not found then
    raise exception 'Sesion de gestion no valida o caducada.';
  end if;

  select settings.management_username
    into actor_name
  from public.warehouse_admin_settings as settings
  where settings.id = 1
  limit 1;

  return coalesce(nullif(btrim(actor_name), ''), 'Gestor');
end;
$$;

revoke all on function public.warehouse_manager_require_session(text)
  from public, anon, authenticated;


create or replace function public.warehouse_manager_apply_cart_action(
  target_session_token text,
  target_cart_id uuid,
  target_action text,
  target_value text,
  target_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_name text;
  normalized_action text :=
    lower(btrim(coalesce(target_action, '')));
  normalized_reason text :=
    btrim(coalesce(target_reason, ''));
  parsed_position integer;
  result_value jsonb;
begin
  actor_name :=
    public.warehouse_manager_require_session(target_session_token);

  if target_cart_id is null then
    raise exception 'Carro no valido.';
  end if;

  if normalized_reason = '' then
    raise exception 'Indica el motivo de la modificacion.';
  end if;

  if not exists (
    select 1
    from public.warehouse_carts as carts
    where carts.id = target_cart_id
  ) then
    raise exception 'El carro no existe.';
  end if;

  case normalized_action
    when 'priority' then
      perform public.warehouse_manager_set_cart_priority_open(
        target_cart_id,
        target_value,
        actor_name,
        normalized_reason
      );

    when 'queue' then
      if nullif(btrim(coalesce(target_value, '')), '') is null then
        parsed_position := null;
      elsif btrim(target_value) !~ '^[0-9]+$' then
        raise exception
          'La posicion de cola debe ser un numero entero mayor que 0.';
      else
        parsed_position := btrim(target_value)::integer;
      end if;

      perform public.warehouse_manager_set_cart_queue_position_open(
        target_cart_id,
        parsed_position,
        actor_name,
        normalized_reason
      );

    when 'shipment_type' then
      perform public.warehouse_manager_set_cart_shipment_type_open(
        target_cart_id,
        target_value,
        actor_name,
        normalized_reason
      );

    when 'unlock' then
      perform public.warehouse_manager_unlock_cart_open(
        target_cart_id,
        actor_name,
        normalized_reason
      );

    when 'release' then
      perform public.warehouse_manager_release_cart_open(
        target_cart_id,
        actor_name,
        normalized_reason
      );

    when 'return_to_queue' then
      perform public.warehouse_manager_return_cart_to_queue_open(
        target_cart_id,
        actor_name,
        normalized_reason
      );

    when 'complete_shipping' then
      perform public.warehouse_manager_complete_shipping_open(
        target_cart_id,
        actor_name,
        normalized_reason
      );

    else
      raise exception 'Accion de carro no valida.';
  end case;

  select jsonb_build_object(
    'cart_id', carts.id,
    'code', carts.code,
    'state', carts.state,
    'priority_code', latest_picking.priority_code,
    'shipment_type', latest_picking.shipment_type,
    'queue_override', latest_picking.queue_override
  )
    into result_value
  from public.warehouse_carts as carts
  left join lateral (
    select
      picking.priority_code,
      picking.shipment_type,
      picking.queue_override
    from public.warehouse_picking_jobs as picking
    where picking.cart_id = carts.id
      and picking.job_type = 'cart'
    order by picking.started_at desc, picking.id desc
    limit 1
  ) as latest_picking on true
  where carts.id = target_cart_id;

  return result_value;
end;
$$;

revoke all on function public.warehouse_manager_apply_cart_action(
  text, uuid, text, text, text
) from public;

grant execute on function public.warehouse_manager_apply_cart_action(
  text, uuid, text, text, text
) to anon, authenticated;


create or replace function public.warehouse_manager_set_cart_sla(
  target_session_token text,
  target_minutes integer
)
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform public.warehouse_manager_require_session(
    target_session_token
  );

  return public.warehouse_manager_set_cart_sla_open(
    target_minutes
  );
end;
$$;

revoke all on function public.warehouse_manager_set_cart_sla(
  text, integer
) from public;

grant execute on function public.warehouse_manager_set_cart_sla(
  text, integer
) to anon, authenticated;


-- Verificacion estructural.
do $$
begin
  if to_regprocedure(
    'public.warehouse_manager_apply_cart_action(text,uuid,text,text,text)'
  ) is null then
    raise exception 'No existe warehouse_manager_apply_cart_action.';
  end if;

  if to_regprocedure(
    'public.warehouse_manager_set_cart_sla(text,integer)'
  ) is null then
    raise exception 'No existe warehouse_manager_set_cart_sla.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
