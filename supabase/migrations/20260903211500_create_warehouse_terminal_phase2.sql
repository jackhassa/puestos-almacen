-- ============================================================================
-- Puestos Almacen - FASE 2
-- Terminal de operario + configuracion segura de credenciales y terminales.
-- Requiere FASE 1 aplicada.
-- ============================================================================

create table if not exists public.warehouse_admin_settings (
  id smallint primary key default 1,
  management_code_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warehouse_admin_settings_singleton check (id = 1),
  constraint warehouse_admin_settings_hash_not_blank check (btrim(management_code_hash) <> '')
);

alter table public.warehouse_admin_settings enable row level security;
revoke all on table public.warehouse_admin_settings from anon, authenticated;

drop trigger if exists warehouse_admin_settings_set_updated_at on public.warehouse_admin_settings;
create trigger warehouse_admin_settings_set_updated_at
before update on public.warehouse_admin_settings
for each row execute function public.warehouse_set_updated_at();

create or replace function public.warehouse_admin_is_configured()
returns boolean
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists(select 1 from public.warehouse_admin_settings where id = 1);
$$;

revoke all on function public.warehouse_admin_is_configured() from public;
grant execute on function public.warehouse_admin_is_configured() to anon, authenticated;

create or replace function public.warehouse_admin_initialize(target_management_code text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if length(coalesce(target_management_code, '')) < 6 then
    raise exception 'El codigo de gestion debe tener al menos 6 caracteres.';
  end if;

  if exists(select 1 from public.warehouse_admin_settings where id = 1) then
    raise exception 'La gestion operativa ya esta configurada.';
  end if;

  insert into public.warehouse_admin_settings(id, management_code_hash)
  values (1, crypt(target_management_code, gen_salt('bf', 12)));
end;
$$;

revoke all on function public.warehouse_admin_initialize(text) from public;
grant execute on function public.warehouse_admin_initialize(text) to anon, authenticated;

create or replace function public.warehouse_admin_code_valid(target_management_code text)
returns boolean
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists(
    select 1
    from public.warehouse_admin_settings
    where id = 1
      and management_code_hash = crypt(target_management_code, management_code_hash)
  );
$$;

revoke all on function public.warehouse_admin_code_valid(text) from public, anon, authenticated;

create or replace function public.warehouse_admin_get_setup_state(target_management_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.warehouse_admin_code_valid(target_management_code) then
    raise exception 'Codigo de gestion incorrecto.';
  end if;

  return jsonb_build_object(
    'employees', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'name', e.name,
          'active', e.active,
          'has_credential', c.id is not null,
          'username_code', c.username_code,
          'credential_active', coalesce(c.active, false),
          'locked_until', c.locked_until
        ) order by e.name
      )
      from public.employees e
      left join public.warehouse_employee_credentials c on c.employee_id = e.id
    ), '[]'::jsonb),
    'terminals', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'code', t.code,
          'name', t.name,
          'terminal_type', t.terminal_type,
          'fixed_area_code', t.fixed_area_code,
          'active', t.active
        ) order by t.name, t.code
      )
      from public.warehouse_terminals t
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.warehouse_admin_get_setup_state(text) from public;
grant execute on function public.warehouse_admin_get_setup_state(text) to anon, authenticated;

create or replace function public.warehouse_admin_set_employee_credential(
  target_management_code text,
  target_employee_id uuid,
  target_username_code text,
  target_password_code text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_username text := upper(btrim(target_username_code));
begin
  if not public.warehouse_admin_code_valid(target_management_code) then
    raise exception 'Codigo de gestion incorrecto.';
  end if;

  if not exists(select 1 from public.employees where id = target_employee_id) then
    raise exception 'Trabajador no valido.';
  end if;

  if length(normalized_username) < 3 then
    raise exception 'El codigo de usuario debe tener al menos 3 caracteres.';
  end if;

  if length(coalesce(target_password_code, '')) < 4 then
    raise exception 'El codigo de password debe tener al menos 4 caracteres.';
  end if;

  insert into public.warehouse_employee_credentials(
    employee_id,
    username_code,
    password_hash,
    active,
    failed_attempts,
    locked_until
  ) values (
    target_employee_id,
    normalized_username,
    crypt(target_password_code, gen_salt('bf', 12)),
    true,
    0,
    null
  )
  on conflict (employee_id) do update
  set
    username_code = excluded.username_code,
    password_hash = excluded.password_hash,
    active = true,
    failed_attempts = 0,
    locked_until = null;
end;
$$;

revoke all on function public.warehouse_admin_set_employee_credential(text, uuid, text, text) from public;
grant execute on function public.warehouse_admin_set_employee_credential(text, uuid, text, text) to anon, authenticated;

create or replace function public.warehouse_admin_set_credential_active(
  target_management_code text,
  target_employee_id uuid,
  target_active boolean
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.warehouse_admin_code_valid(target_management_code) then
    raise exception 'Codigo de gestion incorrecto.';
  end if;

  update public.warehouse_employee_credentials
  set
    active = target_active,
    failed_attempts = case when target_active then 0 else failed_attempts end,
    locked_until = case when target_active then null else locked_until end
  where employee_id = target_employee_id;

  if not found then
    raise exception 'El trabajador no tiene credencial configurada.';
  end if;
end;
$$;

revoke all on function public.warehouse_admin_set_credential_active(text, uuid, boolean) from public;
grant execute on function public.warehouse_admin_set_credential_active(text, uuid, boolean) to anon, authenticated;

create or replace function public.warehouse_admin_upsert_terminal(
  target_management_code text,
  target_terminal_id uuid,
  target_code text,
  target_name text,
  target_terminal_type text,
  target_fixed_area_code text,
  target_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_code text := upper(btrim(target_code));
  result_id uuid;
begin
  if not public.warehouse_admin_code_valid(target_management_code) then
    raise exception 'Codigo de gestion incorrecto.';
  end if;

  if length(normalized_code) < 2 or nullif(btrim(target_name), '') is null then
    raise exception 'Codigo o nombre de terminal no valido.';
  end if;

  if target_terminal_type not in ('fixed_pc', 'rf') then
    raise exception 'Tipo de terminal no valido.';
  end if;

  if target_terminal_type = 'fixed_pc' and target_fixed_area_code not in (
    'gestor', 'mesa1', 'mesa2', 'mesa3', 'mesa4', 'entradas', 'picking', 'montajes'
  ) then
    raise exception 'Un PC fijo necesita un puesto valido.';
  end if;

  if target_terminal_type = 'rf' then
    target_fixed_area_code := null;
  end if;

  if target_terminal_id is null then
    insert into public.warehouse_terminals(code, name, terminal_type, fixed_area_code, active)
    values (normalized_code, btrim(target_name), target_terminal_type, target_fixed_area_code, target_active)
    returning id into result_id;
  else
    update public.warehouse_terminals
    set
      code = normalized_code,
      name = btrim(target_name),
      terminal_type = target_terminal_type,
      fixed_area_code = target_fixed_area_code,
      active = target_active
    where id = target_terminal_id
    returning id into result_id;

    if result_id is null then
      raise exception 'Terminal no encontrado.';
    end if;
  end if;

  return result_id;
end;
$$;

revoke all on function public.warehouse_admin_upsert_terminal(text, uuid, text, text, text, text, boolean) from public;
grant execute on function public.warehouse_admin_upsert_terminal(text, uuid, text, text, text, text, boolean) to anon, authenticated;

create or replace function public.warehouse_get_terminal_info(target_terminal_code text)
returns table (
  terminal_id uuid,
  code text,
  name text,
  terminal_type text,
  fixed_area_code text
)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select t.id, t.code, t.name, t.terminal_type, t.fixed_area_code
  from public.warehouse_terminals t
  where t.code = upper(btrim(target_terminal_code))
    and t.active
  limit 1;
$$;

revoke all on function public.warehouse_get_terminal_info(text) from public;
grant execute on function public.warehouse_get_terminal_info(text) to anon, authenticated;

-- La credencial y el terminal siguen sin tener acceso directo por RLS.
-- Toda la gestion pasa por las RPC anteriores.

create or replace function public.warehouse_resume_terminal_session(
  target_session_token text,
  target_terminal_code text
)
returns table (
  terminal_session_token text,
  employee_id uuid,
  employee_name text,
  terminal_id uuid,
  terminal_type text,
  fixed_area_code text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return query
  select
    target_session_token,
    e.id,
    e.name,
    t.id,
    t.terminal_type,
    t.fixed_area_code,
    s.expires_at
  from public.warehouse_terminal_sessions s
  join public.employees e on e.id = s.employee_id and e.active
  join public.warehouse_terminals t on t.id = s.terminal_id and t.active
  where s.token_hash = digest(target_session_token, 'sha256')
    and s.revoked_at is null
    and s.expires_at > now()
    and t.code = upper(btrim(target_terminal_code))
  limit 1;
end;
$$;

revoke all on function public.warehouse_resume_terminal_session(text, text) from public;
grant execute on function public.warehouse_resume_terminal_session(text, text) to anon, authenticated;
