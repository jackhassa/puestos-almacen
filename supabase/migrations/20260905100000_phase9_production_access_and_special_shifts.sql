begin;

-- FASE 9: acceso Gestor + Montajes + Responsable almacén.

do $$
declare
  column_data_type text;
  column_udt_schema text;
  column_udt_name text;
  check_row record;
begin
  select c.data_type, c.udt_schema, c.udt_name
  into column_data_type, column_udt_schema, column_udt_name
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'employees'
    and c.column_name = 'shift_mode';

  if not found then
    raise exception 'FASE 9: no existe employees.shift_mode.';
  end if;

  if column_data_type = 'USER-DEFINED' then
    execute format(
      'alter type %I.%I add value if not exists %L',
      column_udt_schema, column_udt_name, 'montajes_fixed'
    );
    execute format(
      'alter type %I.%I add value if not exists %L',
      column_udt_schema, column_udt_name, 'warehouse_responsible'
    );
  else
    for check_row in
      select con.conname
      from pg_constraint con
      where con.conrelid = 'public.employees'::regclass
        and con.contype = 'c'
        and pg_get_constraintdef(con.oid) ilike '%shift_mode%'
        and pg_get_constraintdef(con.oid) ilike '%rotating%'
        and pg_get_constraintdef(con.oid) ilike '%morning_fixed%'
        and pg_get_constraintdef(con.oid) ilike '%night_fixed%'
        and pg_get_constraintdef(con.oid) not ilike '%rotation_group%'
        and pg_get_constraintdef(con.oid) not ilike '%manager_type%'
    loop
      execute format(
        'alter table public.employees drop constraint %I',
        check_row.conname
      );
    end loop;

    alter table public.employees
      drop constraint if exists employees_shift_mode_phase9_allowed;

    alter table public.employees
      add constraint employees_shift_mode_phase9_allowed
      check (
        shift_mode in (
          'rotating',
          'morning_fixed',
          'night_fixed',
          'montajes_fixed',
          'warehouse_responsible'
        )
      );
  end if;
end
$$;

alter table public.warehouse_work_sessions
  drop constraint if exists warehouse_work_sessions_shift_allowed;

alter table public.warehouse_work_sessions
  add constraint warehouse_work_sessions_shift_allowed
  check (shift_code in ('morning', 'afternoon', 'night', 'montajes'));

alter table public.warehouse_shift_schedules
  drop constraint if exists warehouse_shift_schedules_shift_allowed;

alter table public.warehouse_shift_schedules
  add constraint warehouse_shift_schedules_shift_allowed
  check (shift_code in ('morning', 'afternoon', 'night', 'montajes'));

insert into public.warehouse_shift_schedules(
  shift_code,
  valid_from,
  valid_to,
  start_time,
  end_time,
  auto_close_grace_minutes,
  active
)
values (
  'montajes',
  date '2026-01-01',
  null,
  time '05:45',
  time '13:45',
  30,
  true
)
on conflict (shift_code, valid_from) do update
set
  valid_to = excluded.valid_to,
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  auto_close_grace_minutes = excluded.auto_close_grace_minutes,
  active = excluded.active,
  updated_at = now();

alter table public.warehouse_admin_settings
  add column if not exists management_username text;

update public.warehouse_admin_settings
set management_username = coalesce(nullif(btrim(management_username), ''), 'gestor')
where id = 1;

alter table public.warehouse_admin_settings
  alter column management_username set default 'gestor';

alter table public.warehouse_admin_settings
  alter column management_username set not null;

alter table public.warehouse_admin_settings
  drop constraint if exists warehouse_admin_settings_username_not_blank;

alter table public.warehouse_admin_settings
  add constraint warehouse_admin_settings_username_not_blank
  check (btrim(management_username) <> '');

create table if not exists public.warehouse_management_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  display_name text not null default 'Gestor',
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint warehouse_management_sessions_expiry_valid
    check (expires_at > started_at),
  constraint warehouse_management_sessions_revoked_valid
    check (revoked_at is null or revoked_at >= started_at)
);

create index if not exists warehouse_management_sessions_active_idx
  on public.warehouse_management_sessions(expires_at desc)
  where revoked_at is null;

alter table public.warehouse_management_sessions enable row level security;
revoke all on table public.warehouse_management_sessions from anon, authenticated;

create or replace function public.warehouse_management_login(
  target_username text,
  target_password text
)
returns table (
  management_session_token text,
  display_name text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  settings_row public.warehouse_admin_settings%rowtype;
  plain_token text;
  expiry_value timestamptz;
begin
  if nullif(btrim(target_username), '') is null
     or nullif(target_password, '') is null then
    raise exception 'Usuario o contraseña incompletos.';
  end if;

  select * into settings_row
  from public.warehouse_admin_settings
  where id = 1
  limit 1;

  if not found
     or lower(settings_row.management_username) <> lower(btrim(target_username))
     or settings_row.management_code_hash <> crypt(target_password, settings_row.management_code_hash) then
    raise exception 'Usuario o contraseña incorrectos.';
  end if;

  update public.warehouse_management_sessions
  set revoked_at = now()
  where revoked_at is null
    and expires_at <= now();

  plain_token := encode(gen_random_bytes(32), 'hex');
  expiry_value := now() + interval '12 hours';

  insert into public.warehouse_management_sessions(
    token_hash,
    display_name,
    expires_at
  )
  values (
    digest(plain_token, 'sha256'),
    'Gestor',
    expiry_value
  );

  return query
  select plain_token, 'Gestor'::text, expiry_value;
end;
$$;

revoke all on function public.warehouse_management_login(text, text) from public;
grant execute on function public.warehouse_management_login(text, text) to anon, authenticated;

create or replace function public.warehouse_management_validate(
  target_session_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  session_row public.warehouse_management_sessions%rowtype;
begin
  select * into session_row
  from public.warehouse_management_sessions
  where token_hash = digest(target_session_token, 'sha256')
    and revoked_at is null
    and expires_at > now()
  limit 1;

  if not found then
    return jsonb_build_object('valid', false);
  end if;

  return jsonb_build_object(
    'valid', true,
    'display_name', session_row.display_name,
    'expires_at', session_row.expires_at
  );
end;
$$;

revoke all on function public.warehouse_management_validate(text) from public;
grant execute on function public.warehouse_management_validate(text) to anon, authenticated;

create or replace function public.warehouse_management_logout(
  target_session_token text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  update public.warehouse_management_sessions
  set revoked_at = now()
  where token_hash = digest(target_session_token, 'sha256')
    and revoked_at is null;
end;
$$;

revoke all on function public.warehouse_management_logout(text) from public;
grant execute on function public.warehouse_management_logout(text) to anon, authenticated;

commit;
