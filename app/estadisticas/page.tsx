"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildDailyPlanning,
  type PlanningAbsence,
  type PlanningDailyOverride,
  type PlanningEmployee,
  type PlanningManagerSetting,
  type PlanningShiftChange,
} from "@/lib/daily-plan-engine";
import {
  OPERATIONAL_AREA_LABELS,
  type OperationalAreaCode,
} from "@/lib/operational-types";
import type { WorkShift } from "@/lib/shift-engine";
import { supabase } from "@/lib/supabase";

const THEORETICAL_SHIFT_SECONDS = 8 * 60 * 60;

type Grouping = "day" | "week" | "month" | "year";

type SummaryRow = {
  worked_employee_rows: number;
  recorded_seconds: number;
  break_count: number;
  break_seconds: number;
  session_effective_seconds: number;
  productive_seconds: number;
  picking_carts: number;
  no_cart_jobs: number;
  shipping_carts: number;
  productive_units: number;
  completed_cycles: number;
  avg_picking_seconds: number;
  avg_shipping_seconds: number;
  avg_total_seconds: number;
  high_priority_cycles: number;
  out_of_sla: number | null;
};

type EmployeeStatsRow = {
  employee_id: string;
  employee_name: string;
  worked_days: number;
  recorded_seconds: number;
  break_count: number;
  break_seconds: number;
  session_effective_seconds: number;
  productive_seconds: number;
  picking_carts: number;
  no_cart_jobs: number;
  shipping_carts: number;
  productive_units: number;
  avg_picking_cart_seconds: number;
  avg_shipping_seconds: number;
  productivity_per_hour: number | null;
};

type AreaStatsRow = {
  area_code: OperationalAreaCode;
  area_label: string;
  workers: number;
  presence_seconds: number;
  productive_seconds: number;
  productive_units: number;
  picking_carts: number;
  no_cart_jobs: number;
  shipping_carts: number;
  avg_job_seconds: number;
  productivity_per_hour: number | null;
};

type DailyStatsRow = {
  operational_date: string;
  workers: number;
  recorded_seconds: number;
  break_count: number;
  break_seconds: number;
  session_effective_seconds: number;
  productive_seconds: number;
  picking_carts: number;
  no_cart_jobs: number;
  shipping_carts: number;
  productive_units: number;
  productivity_per_hour: number | null;
};

type StatisticsSnapshot = {
  from: string;
  to: string;
  sample_now: string;
  cart_sla_minutes: number | null;
  summary: SummaryRow;
  employees: EmployeeStatsRow[];
  areas: AreaStatsRow[];
  daily: DailyStatsRow[];
};

type PlanningRangeSummary = {
  plannedSeconds: number;
  employeePlannedSeconds: Map<string, number>;
  employeePlannedDays: Map<string, number>;
  employeeNames: Map<string, string>;
  areaPlannedSeconds: Map<string, number>;
  dailyPlannedSeconds: Map<string, number>;
};

type EmployeeViewRow = EmployeeStatsRow & {
  planned_seconds: number;
  planned_days: number;
};

type AreaViewRow = AreaStatsRow & {
  planned_seconds: number;
};

type PeriodViewRow = {
  key: string;
  label: string;
  planned_seconds: number;
  recorded_seconds: number;
  session_effective_seconds: number;
  productive_seconds: number;
  break_seconds: number;
  break_count: number;
  productive_units: number;
  picking_carts: number;
  no_cart_jobs: number;
  shipping_carts: number;
};

const EMPTY_SUMMARY: SummaryRow = {
  worked_employee_rows: 0,
  recorded_seconds: 0,
  break_count: 0,
  break_seconds: 0,
  session_effective_seconds: 0,
  productive_seconds: 0,
  picking_carts: 0,
  no_cart_jobs: 0,
  shipping_carts: 0,
  productive_units: 0,
  completed_cycles: 0,
  avg_picking_seconds: 0,
  avg_shipping_seconds: 0,
  avg_total_seconds: 0,
  high_priority_cycles: 0,
  out_of_sla: null,
};

function localDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function addDays(value: string, days: number) {
  const date = parseLocalDate(value);
  date.setDate(date.getDate() + days);
  return localDateValue(date);
}

function startOfWeek(value: string) {
  const date = parseLocalDate(value);
  const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  return localDateValue(date);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parseLocalDate(value));
}

function formatSeconds(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  return `${minutes} min`;
}

function formatHours(seconds: number) {
  return `${(Math.max(0, seconds) / 3600).toLocaleString("es-ES", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} h`;
}

function formatRate(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function percentage(part: number, total: number) {
  if (total <= 0) return "—";
  return `${Math.round((part / total) * 100)} %`;
}

function getRangePreset(preset: "today" | "week" | "month" | "year") {
  const today = new Date();
  const to = localDateValue(today);

  if (preset === "today") return { from: to, to };

  if (preset === "week") {
    const day = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() + (day === 0 ? -6 : 1 - day));
    return { from: localDateValue(monday), to };
  }

  if (preset === "month") {
    return {
      from: localDateValue(new Date(today.getFullYear(), today.getMonth(), 1, 12)),
      to,
    };
  }

  return {
    from: `${today.getFullYear()}-01-01`,
    to,
  };
}

function enumerateDates(from: string, to: string) {
  const dates: string[] = [];
  let current = from;
  let guard = 0;

  while (current <= to && guard <= 1461) {
    dates.push(current);
    current = addDays(current, 1);
    guard += 1;
  }

  return dates;
}

async function loadPlanningRange(from: string, to: string): Promise<PlanningRangeSummary> {
  const dates = enumerateDates(from, to);
  const years = Array.from(new Set(dates.map((item) => Number(item.slice(0, 4)))));

  const [
    employeesResult,
    yearsResult,
    holidaysResult,
    absencesResult,
    managersResult,
    changesResult,
    overridesResult,
  ] = await Promise.all([
    supabase
      .from("employees")
      .select(
        "id,name,shift_mode,rotation_group,manager_type,rotation_reference_date,rotation_reference_position,active",
      )
      .eq("active", true)
      .order("name"),
    supabase
      .from("year_shift_settings")
      .select("year,group_a_january_shift")
      .in("year", years),
    supabase.from("non_working_days").select("date").gte("date", from).lte("date", to),
    supabase
      .from("absence_periods")
      .select("employee_id,start_date,end_date")
      .lte("start_date", to)
      .gte("end_date", from),
    supabase.from("afternoon_manager_settings").select("rotation_group,starter_manager_id"),
    supabase
      .from("shift_reinforcements")
      .select("employee_id,reinforcement_date,target_shift")
      .gte("reinforcement_date", from)
      .lte("reinforcement_date", to),
    supabase
      .from("daily_assignment_overrides")
      .select("employee_id,assignment_date,assignment_code")
      .gte("assignment_date", from)
      .lte("assignment_date", to),
  ]);

  const firstError = [
    employeesResult.error,
    yearsResult.error,
    holidaysResult.error,
    absencesResult.error,
    managersResult.error,
    changesResult.error,
    overridesResult.error,
  ].find(Boolean);

  if (firstError) throw new Error(firstError.message);

  const yearSettings = new Map<number, WorkShift>();
  for (const row of yearsResult.data ?? []) {
    yearSettings.set(row.year, row.group_a_january_shift as WorkShift);
  }

  const missingYear = years.find((year) => !yearSettings.has(year));
  if (missingYear) {
    throw new Error(`No existe configuración de turnos para ${missingYear}.`);
  }

  const employees = (employeesResult.data ?? []) as PlanningEmployee[];
  const employeeNames = new Map(employees.map((employee) => [employee.id, employee.name]));
  const employeePlannedSeconds = new Map<string, number>();
  const employeePlannedDays = new Map<string, number>();
  const areaPlannedSeconds = new Map<string, number>();
  const dailyPlannedSeconds = new Map<string, number>();
  let plannedSeconds = 0;

  for (const targetDate of dates) {
    const januaryShift = yearSettings.get(Number(targetDate.slice(0, 4)));
    if (!januaryShift) continue;

    const planning = buildDailyPlanning({
      targetDate,
      employees,
      groupAJanuaryShift: januaryShift,
      holidays: (holidaysResult.data ?? []).map((item) => item.date),
      absencePeriods: (absencesResult.data ?? []) as PlanningAbsence[],
      managerSettings: (managersResult.data ?? []) as PlanningManagerSetting[],
      shiftChanges: (changesResult.data ?? []) as PlanningShiftChange[],
      dailyOverrides: (overridesResult.data ?? []) as PlanningDailyOverride[],
    });

    for (const assignment of planning) {
      if (!assignment.canStart || !assignment.actualShift) continue;

      plannedSeconds += THEORETICAL_SHIFT_SECONDS;
      dailyPlannedSeconds.set(
        targetDate,
        (dailyPlannedSeconds.get(targetDate) ?? 0) + THEORETICAL_SHIFT_SECONDS,
      );
      employeePlannedSeconds.set(
        assignment.employeeId,
        (employeePlannedSeconds.get(assignment.employeeId) ?? 0) + THEORETICAL_SHIFT_SECONDS,
      );
      employeePlannedDays.set(
        assignment.employeeId,
        (employeePlannedDays.get(assignment.employeeId) ?? 0) + 1,
      );

      if (assignment.areaCode) {
        areaPlannedSeconds.set(
          assignment.areaCode,
          (areaPlannedSeconds.get(assignment.areaCode) ?? 0) + THEORETICAL_SHIFT_SECONDS,
        );
      }
    }
  }

  return {
    plannedSeconds,
    employeePlannedSeconds,
    employeePlannedDays,
    employeeNames,
    areaPlannedSeconds,
    dailyPlannedSeconds,
  };
}

function periodKey(dateValue: string, grouping: Grouping) {
  if (grouping === "day") return dateValue;
  if (grouping === "week") return startOfWeek(dateValue);
  if (grouping === "month") return dateValue.slice(0, 7);
  return dateValue.slice(0, 4);
}

function periodLabel(key: string, grouping: Grouping) {
  if (grouping === "day") return formatDate(key);
  if (grouping === "week") return `Semana ${formatDate(key)}`;
  if (grouping === "month") {
    const [year, month] = key.split("-").map(Number);
    return new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric" }).format(
      new Date(year, month - 1, 1, 12),
    );
  }
  return key;
}

const DEFAULT_RANGE = getRangePreset("month");

export default function StatisticsPage() {
  const [from, setFrom] = useState(DEFAULT_RANGE.from);
  const [to, setTo] = useState(DEFAULT_RANGE.to);
  const [snapshot, setSnapshot] = useState<StatisticsSnapshot | null>(null);
  const [planning, setPlanning] = useState<PlanningRangeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [areaFilter, setAreaFilter] = useState<"all" | OperationalAreaCode>("all");
  const [grouping, setGrouping] = useState<Grouping>("day");

  const loadStatistics = useCallback(async (rangeFrom: string, rangeTo: string) => {
    if (!rangeFrom || !rangeTo) {
      setMessage("Indica las dos fechas del periodo.");
      return;
    }

    if (rangeTo < rangeFrom) {
      setMessage("La fecha hasta no puede ser anterior a la fecha desde.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const [{ data, error }, planningResult] = await Promise.all([
        supabase.rpc("warehouse_statistics_get_snapshot", {
          target_from: rangeFrom,
          target_to: rangeTo,
        }),
        loadPlanningRange(rangeFrom, rangeTo),
      ]);

      if (error) throw new Error(error.message);

      setSnapshot(data as StatisticsSnapshot);
      setPlanning(planningResult);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se han podido cargar las estadísticas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStatistics(DEFAULT_RANGE.from, DEFAULT_RANGE.to);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadStatistics]);

  const employeeRows = useMemo<EmployeeViewRow[]>(() => {
    const actualById = new Map((snapshot?.employees ?? []).map((row) => [row.employee_id, row]));
    const ids = new Set<string>([
      ...actualById.keys(),
      ...(planning ? planning.employeePlannedSeconds.keys() : []),
    ]);

    const rows = Array.from(ids).map((employeeId): EmployeeViewRow => {
      const actual = actualById.get(employeeId);
      return {
        employee_id: employeeId,
        employee_name:
          actual?.employee_name ?? planning?.employeeNames.get(employeeId) ?? "Trabajador",
        worked_days: actual?.worked_days ?? 0,
        recorded_seconds: actual?.recorded_seconds ?? 0,
        break_count: actual?.break_count ?? 0,
        break_seconds: actual?.break_seconds ?? 0,
        session_effective_seconds: actual?.session_effective_seconds ?? 0,
        productive_seconds: actual?.productive_seconds ?? 0,
        picking_carts: actual?.picking_carts ?? 0,
        no_cart_jobs: actual?.no_cart_jobs ?? 0,
        shipping_carts: actual?.shipping_carts ?? 0,
        productive_units: actual?.productive_units ?? 0,
        avg_picking_cart_seconds: actual?.avg_picking_cart_seconds ?? 0,
        avg_shipping_seconds: actual?.avg_shipping_seconds ?? 0,
        productivity_per_hour: actual?.productivity_per_hour ?? null,
        planned_seconds: planning?.employeePlannedSeconds.get(employeeId) ?? 0,
        planned_days: planning?.employeePlannedDays.get(employeeId) ?? 0,
      };
    });

    const search = employeeFilter.trim().toLocaleLowerCase("es-ES");
    return rows
      .filter((row) => !search || row.employee_name.toLocaleLowerCase("es-ES").includes(search))
      .sort((a, b) => a.employee_name.localeCompare(b.employee_name, "es"));
  }, [employeeFilter, planning, snapshot]);

  const areaRows = useMemo<AreaViewRow[]>(() => {
    return (snapshot?.areas ?? [])
      .map((row) => ({
        ...row,
        planned_seconds: planning?.areaPlannedSeconds.get(row.area_code) ?? 0,
      }))
      .filter((row) => areaFilter === "all" || row.area_code === areaFilter);
  }, [areaFilter, planning, snapshot]);

  const periodRows = useMemo<PeriodViewRow[]>(() => {
    const buckets = new Map<string, PeriodViewRow>();

    for (const row of snapshot?.daily ?? []) {
      const key = periodKey(row.operational_date, grouping);
      const current = buckets.get(key) ?? {
        key,
        label: periodLabel(key, grouping),
        planned_seconds: 0,
        recorded_seconds: 0,
        session_effective_seconds: 0,
        productive_seconds: 0,
        break_seconds: 0,
        break_count: 0,
        productive_units: 0,
        picking_carts: 0,
        no_cart_jobs: 0,
        shipping_carts: 0,
      };

      current.planned_seconds += planning?.dailyPlannedSeconds.get(row.operational_date) ?? 0;
      current.recorded_seconds += row.recorded_seconds;
      current.session_effective_seconds += row.session_effective_seconds;
      current.productive_seconds += row.productive_seconds;
      current.break_seconds += row.break_seconds;
      current.break_count += row.break_count;
      current.productive_units += row.productive_units;
      current.picking_carts += row.picking_carts;
      current.no_cart_jobs += row.no_cart_jobs;
      current.shipping_carts += row.shipping_carts;
      buckets.set(key, current);
    }

    return Array.from(buckets.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [grouping, planning, snapshot]);

  const summary = snapshot?.summary ?? EMPTY_SUMMARY;
  const plannedSeconds = planning?.plannedSeconds ?? 0;
  const highPriorityPercentage = percentage(summary.high_priority_cycles, summary.completed_cycles);

  function applyPreset(preset: "today" | "week" | "month" | "year") {
    const range = getRangePreset(preset);
    setFrom(range.from);
    setTo(range.to);
    if (preset === "today") setGrouping("day");
    if (preset === "week") setGrouping("day");
    if (preset === "month") setGrouping("day");
    if (preset === "year") setGrouping("month");
    void loadStatistics(range.from, range.to);
  }

  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-6">
      <div className="mx-auto max-w-[1600px]">
        <header className="rounded-2xl bg-slate-900 p-6 text-white shadow-sm">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">
                Fase 8 · Estadísticas
              </p>
              <h1 className="mt-2 text-3xl font-black">Productividad operativa</h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-300">
                Planificación, jornada, pausas, tiempo efectivo, Picking y Expedición en una misma vista.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/gestor" className="rounded-xl bg-white px-4 py-3 text-sm font-bold text-slate-900">
                PANEL DEL GESTOR
              </Link>
              <Link href="/" className="rounded-xl border border-slate-600 px-4 py-3 text-sm font-bold text-white">
                INICIO
              </Link>
            </div>
          </div>
        </header>

        <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-[180px_180px_auto]">
              <label className="text-sm font-semibold text-slate-700">
                Desde
                <input
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-normal"
                />
              </label>
              <label className="text-sm font-semibold text-slate-700">
                Hasta
                <input
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-normal"
                />
              </label>
              <button
                type="button"
                onClick={() => void loadStatistics(from, to)}
                className="h-[42px] self-end rounded-xl bg-slate-900 px-5 text-sm font-black text-white"
              >
                ACTUALIZAR
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <PresetButton onClick={() => applyPreset("today")}>HOY</PresetButton>
              <PresetButton onClick={() => applyPreset("week")}>SEMANA</PresetButton>
              <PresetButton onClick={() => applyPreset("month")}>MES</PresetButton>
              <PresetButton onClick={() => applyPreset("year")}>AÑO</PresetButton>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Horas planificadas: jornada teórica de 8 h. La planificación histórica se recalcula con el mismo motor de planificación actual.
          </p>
        </section>

        {message && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 font-semibold text-red-700">
            {message}
          </div>
        )}

        {loading ? (
          <div className="mt-5 rounded-2xl bg-white p-8 text-center font-semibold text-slate-600 shadow-sm">
            Calculando estadísticas...
          </div>
        ) : (
          <>
            <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <MetricCard label="Horas planificadas" value={formatHours(plannedSeconds)} />
              <MetricCard label="Horas registradas" value={formatHours(summary.recorded_seconds)} />
              <MetricCard label="Tiempo efectivo jornada" value={formatHours(summary.session_effective_seconds)} />
              <MetricCard label="Tiempo productivo medido" value={formatHours(summary.productive_seconds)} />
              <MetricCard
                label="Pausas"
                value={`${summary.break_count}`}
                detail={formatSeconds(summary.break_seconds)}
              />
            </section>

            <section className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <MetricCard label="Carros Picking" value={String(summary.picking_carts)} />
              <MetricCard label="Sin carro" value={String(summary.no_cart_jobs)} />
              <MetricCard label="Carros expedidos" value={String(summary.shipping_carts)} />
              <MetricCard label="Media Picking" value={formatSeconds(summary.avg_picking_seconds)} />
              <MetricCard label="Media Expedición" value={formatSeconds(summary.avg_shipping_seconds)} />
              <MetricCard label="Media ciclo total" value={formatSeconds(summary.avg_total_seconds)} />
            </section>

            <section className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="Ciclos completos" value={String(summary.completed_cycles)} />
              <MetricCard label="Prioridad alta" value={highPriorityPercentage} />
              <MetricCard
                label="Fuera de SLA"
                value={summary.out_of_sla === null ? "—" : String(summary.out_of_sla)}
                detail={
                  snapshot?.cart_sla_minutes
                    ? `SLA ${snapshot.cart_sla_minutes} min`
                    : "SLA no configurado"
                }
              />
              <MetricCard
                label="Trabajos productivos"
                value={String(summary.productive_units)}
                detail="Picking + Expedición"
              />
            </section>

            <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-xl font-black text-slate-900">Por trabajador</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Jornada, pausas, trabajo productivo y carros realizados.
                  </p>
                </div>
                <input
                  type="search"
                  value={employeeFilter}
                  onChange={(event) => setEmployeeFilter(event.target.value)}
                  placeholder="Buscar trabajador..."
                  className="w-full rounded-xl border border-slate-300 px-4 py-2 text-sm lg:w-72"
                />
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="min-w-[1450px] w-full text-sm">
                  <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <Th>Trabajador</Th>
                      <Th>Plan</Th>
                      <Th>Registrado</Th>
                      <Th>Pausas</Th>
                      <Th>Efectivo jornada</Th>
                      <Th>Productivo</Th>
                      <Th>Carros Picking</Th>
                      <Th>Sin carro</Th>
                      <Th>Expedición</Th>
                      <Th>Media Picking</Th>
                      <Th>Media Exp.</Th>
                      <Th>Trabajos/h prod.</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {employeeRows.map((row) => (
                      <tr key={row.employee_id} className="border-b border-slate-100">
                        <Td strong>{row.employee_name}</Td>
                        <Td>{formatHours(row.planned_seconds)}</Td>
                        <Td>{formatHours(row.recorded_seconds)}</Td>
                        <Td>{row.break_count} · {formatSeconds(row.break_seconds)}</Td>
                        <Td>{formatHours(row.session_effective_seconds)}</Td>
                        <Td>{formatHours(row.productive_seconds)}</Td>
                        <Td>{row.picking_carts}</Td>
                        <Td>{row.no_cart_jobs}</Td>
                        <Td>{row.shipping_carts}</Td>
                        <Td>{row.avg_picking_cart_seconds ? formatSeconds(row.avg_picking_cart_seconds) : "—"}</Td>
                        <Td>{row.avg_shipping_seconds ? formatSeconds(row.avg_shipping_seconds) : "—"}</Td>
                        <Td>{formatRate(row.productivity_per_hour)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-xl font-black text-slate-900">Por puesto</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Tiempo en puesto frente a tiempo productivo realmente medido.
                  </p>
                </div>
                <select
                  value={areaFilter}
                  onChange={(event) => setAreaFilter(event.target.value as "all" | OperationalAreaCode)}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm"
                >
                  <option value="all">Todos los puestos</option>
                  {Object.entries(OPERATIONAL_AREA_LABELS).map(([code, label]) => (
                    <option key={code} value={code}>{label}</option>
                  ))}
                </select>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="min-w-[1100px] w-full text-sm">
                  <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <Th>Puesto</Th>
                      <Th>Planificado</Th>
                      <Th>Tiempo en puesto</Th>
                      <Th>Productivo medido</Th>
                      <Th>Personas</Th>
                      <Th>Carros Picking</Th>
                      <Th>Sin carro</Th>
                      <Th>Carros Exp.</Th>
                      <Th>Media trabajo</Th>
                      <Th>Trabajos/h prod.</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {areaRows.map((row) => (
                      <tr key={row.area_code} className="border-b border-slate-100">
                        <Td strong>{row.area_label}</Td>
                        <Td>{formatHours(row.planned_seconds)}</Td>
                        <Td>{formatHours(row.presence_seconds)}</Td>
                        <Td>{formatHours(row.productive_seconds)}</Td>
                        <Td>{row.workers}</Td>
                        <Td>{row.picking_carts || "—"}</Td>
                        <Td>{row.no_cart_jobs || "—"}</Td>
                        <Td>{row.shipping_carts || "—"}</Td>
                        <Td>{row.avg_job_seconds ? formatSeconds(row.avg_job_seconds) : "—"}</Td>
                        <Td>{formatRate(row.productivity_per_hour)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Entradas no muestra unidades/hora porque esta app todavía no registra el número real de entradas; conserva el tiempo para cruzarlo posteriormente con esos datos.
              </p>
            </section>

            <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-xl font-black text-slate-900">Evolución por periodo</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Día, semana, mes o año usando la misma base de actividad.
                  </p>
                </div>
                <select
                  value={grouping}
                  onChange={(event) => setGrouping(event.target.value as Grouping)}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm"
                >
                  <option value="day">Día</option>
                  <option value="week">Semana</option>
                  <option value="month">Mes</option>
                  <option value="year">Año</option>
                </select>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="min-w-[1200px] w-full text-sm">
                  <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <Th>Periodo</Th>
                      <Th>Planificado</Th>
                      <Th>Registrado</Th>
                      <Th>Efectivo</Th>
                      <Th>Productivo</Th>
                      <Th>Pausas</Th>
                      <Th>Carros Picking</Th>
                      <Th>Sin carro</Th>
                      <Th>Expedición</Th>
                      <Th>Trabajos/h prod.</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {periodRows.map((row) => (
                      <tr key={row.key} className="border-b border-slate-100">
                        <Td strong>{row.label}</Td>
                        <Td>{formatHours(row.planned_seconds)}</Td>
                        <Td>{formatHours(row.recorded_seconds)}</Td>
                        <Td>{formatHours(row.session_effective_seconds)}</Td>
                        <Td>{formatHours(row.productive_seconds)}</Td>
                        <Td>{row.break_count} · {formatSeconds(row.break_seconds)}</Td>
                        <Td>{row.picking_carts}</Td>
                        <Td>{row.no_cart_jobs}</Td>
                        <Td>{row.shipping_carts}</Td>
                        <Td>
                          {row.productive_seconds > 0 && row.productive_units > 0
                            ? formatRate((row.productive_units * 3600) / row.productive_seconds)
                            : "—"}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-black text-slate-900">{value}</p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </div>
  );
}

function PresetButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
    >
      {children}
    </button>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-3 font-bold">{children}</th>;
}

function Td({ children, strong = false }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <td className={`px-3 py-3 text-slate-700 ${strong ? "font-bold text-slate-900" : ""}`}>
      {children}
    </td>
  );
}
