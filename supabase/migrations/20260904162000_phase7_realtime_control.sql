begin;

-- ============================================================================
-- PUESTOS ALMACEN - FASE 7
-- Panel de control en tiempo real.
--
-- Objetivos:
--   * señal mínima de cambios para Supabase Realtime;
--   * sin exponer tablas operativas;
--   * refresco inmediato del panel del gestor ante cambios reales;
--   * mantener un refresco de respaldo en cliente.
-- ============================================================================

create table if not exists public.warehouse_live_control_signal (
  id smallint primary key default 1,
  revision bigint not null default 0,
  changed_at timestamptz not null default clock_timestamp(),
  source_table text,
  constraint warehouse_live_control_signal_singleton check (id = 1)
);

insert into public.warehouse_live_control_signal (
  id,
  revision,
  changed_at,
  source_table
)
values (
  1,
  0,
  clock_timestamp(),
  'phase7_initial'
)
on conflict (id) do nothing;

alter table public.warehouse_live_control_signal enable row level security;

revoke all on table public.warehouse_live_control_signal from public;
revoke all on table public.warehouse_live_control_signal from anon;
revoke all on table public.warehouse_live_control_signal from authenticated;

grant select on table public.warehouse_live_control_signal to anon, authenticated;

drop policy if exists warehouse_live_control_signal_read
  on public.warehouse_live_control_signal;

create policy warehouse_live_control_signal_read
  on public.warehouse_live_control_signal
  for select
  to anon, authenticated
  using (id = 1);

create or replace function public.warehouse_touch_live_control_signal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.warehouse_live_control_signal as signal (
    id,
    revision,
    changed_at,
    source_table
  )
  values (
    1,
    1,
    clock_timestamp(),
    tg_table_name
  )
  on conflict (id) do update
    set revision = signal.revision + 1,
        changed_at = excluded.changed_at,
        source_table = excluded.source_table;

  return null;
end;
$$;

revoke all on function public.warehouse_touch_live_control_signal() from public;

do $$
declare
  target_table text;
  trigger_name text;
  watched_tables text[] := array[
    -- Operativa
    'warehouse_work_sessions',
    'warehouse_work_periods',
    'warehouse_work_breaks',
    'warehouse_picking_jobs',
    'warehouse_carts',
    'warehouse_cart_events',
    'warehouse_shipping_jobs',
    'warehouse_corrections',
    -- Fuentes de planificación que afectan al panel
    'employees',
    'year_shift_settings',
    'non_working_days',
    'absence_periods',
    'afternoon_manager_settings',
    'shift_reinforcements',
    'daily_assignment_overrides'
  ];
begin
  foreach target_table in array watched_tables loop
    if to_regclass(format('public.%I', target_table)) is not null then
      trigger_name := 'warehouse_live_signal_' || target_table;

      execute format(
        'drop trigger if exists %I on public.%I',
        trigger_name,
        target_table
      );

      execute format(
        'create trigger %I
           after insert or update or delete
           on public.%I
           for each statement
           execute function public.warehouse_touch_live_control_signal()',
        trigger_name,
        target_table
      );
    end if;
  end loop;
end;
$$;

-- Habilitar únicamente esta tabla segura para Postgres Changes.
do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  )
  and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'warehouse_live_control_signal'
  ) then
    execute
      'alter publication supabase_realtime add table public.warehouse_live_control_signal';
  end if;
end;
$$;

-- Verificación.
do $$
declare
  watched_trigger_count integer;
begin
  if to_regclass('public.warehouse_live_control_signal') is null then
    raise exception 'No existe warehouse_live_control_signal tras FASE 7.';
  end if;

  if to_regprocedure('public.warehouse_touch_live_control_signal()') is null then
    raise exception 'No existe warehouse_touch_live_control_signal().';
  end if;

  select count(*)
    into watched_trigger_count
  from pg_trigger as triggers
  join pg_class as classes
    on classes.oid = triggers.tgrelid
  join pg_namespace as namespaces
    on namespaces.oid = classes.relnamespace
  where namespaces.nspname = 'public'
    and triggers.tgname like 'warehouse_live_signal_%'
    and not triggers.tgisinternal;

  if watched_trigger_count < 8 then
    raise exception
      'FASE 7 esperaba al menos 8 triggers de señal y solo existen %.',
      watched_trigger_count;
  end if;
end;
$$;

commit;
