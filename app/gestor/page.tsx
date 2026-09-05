"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildDailyPlanning,
  type EmployeeDailyAssignment,
  type PlanningAbsence,
  type PlanningDailyOverride,
  type PlanningEmployee,
  type PlanningManagerSetting,
  type PlanningShiftChange,
} from "@/lib/daily-plan-engine";
import { OPERATIONAL_AREA_LABELS, type OperationalAreaCode } from "@/lib/operational-types";
import type { WorkShift } from "@/lib/shift-engine";
import { supabase } from "@/lib/supabase";

type ShiftCode =
  | "morning"
  | "afternoon"
  | "night"
  | "montajes"
  | "responsible";
type LiveStatus = "working" | "break" | "available";
type WorkforceStatus = LiveStatus | "not_started" | "finished" | "incident";
type RealtimeStatus = "connecting" | "live" | "fallback" | "offline";
type ActionFeedback = {
  kind: "success" | "error";
  text: string;
};
type ManagerCartActionResult = {
  cart_id: string;
  code: string;
  state: CartState;
  priority_code: PriorityCode | null;
  shipment_type: string | null;
  queue_override: number | null;
};
type CartState =
  | "available"
  | "picking"
  | "ready_for_shipping"
  | "assigned_to_shipping"
  | "shipping"
  | "completed";
type PriorityCode = "high" | "normal" | "low";

type LiveWorker = {
  employee_id: string;
  employee_name: string;
  shift_code: ShiftCode;
  planned_assignment_code: string;
  area_code: OperationalAreaCode;
  mode_code: string;
  status: LiveStatus;
  task_label: string | null;
  task_started_at: string | null;
  task_effective_seconds: number;
  break_count: number;
  break_seconds: number;
  work_started_at: string;
};

type SessionState = {
  employee_id: string;
  employee_name: string;
  status: "working" | "break" | "completed";
  started_at: string;
  ended_at: string | null;
  shift_code: ShiftCode;
  planned_assignment_code: string;
};

type CartRow = {
  cart_id: string;
  code: string;
  active: boolean;
  is_cubetas: boolean;
  state: CartState;
  priority_code: PriorityCode | null;
  shipment_type: string | null;
  queue_override: number | null;
  prepared_at: string | null;
  picking_job_id: string | null;
  picking_employee_name: string | null;
  picking_shift_code: ShiftCode | null;
  picking_started_at: string | null;
  picking_ended_at: string | null;
  picking_effective_seconds: number;
  shipping_job_id: string | null;
  shipping_employee_name: string | null;
  shipping_area_code: OperationalAreaCode | null;
  shipping_shift_code: ShiftCode | null;
  shipping_started_at: string | null;
  shipping_ended_at: string | null;
  shipping_effective_seconds: number;
  operational_date: string | null;
  total_seconds: number;
};

type OperatorKpi = {
  employee_id: string;
  employee_name: string;
  picking_carts: number;
  shipping_carts: number;
};

type ControlState = {
  server_now: string;
  operational_date: string;
  cart_sla_minutes: number | null;
  summary: {
    picking_carts: number;
    ready_carts: number;
    shipping_carts: number;
    available_carts: number;
    completed_today: number;
    avg_picking_seconds: number;
    avg_shipping_seconds: number;
    avg_total_seconds: number;
    high_priority_cycles: number;
    total_cart_cycles: number;
    out_of_sla: number | null;
  };
  workers: LiveWorker[];
  sessions: SessionState[];
  carts: CartRow[];
  operator_kpis: OperatorKpi[];
};

type CartHistoryItem = {
  kind: "event" | "correction";
  occurred_at: string;
  event_code: string;
  from_state: unknown;
  to_state: unknown;
  actor_name: string | null;
  reason: string | null;
};

type WorkforceRow = {
  employeeId: string;
  employeeName: string;
  shiftCode: ShiftCode | null;
  plannedAssignment: string;
  actualArea: string;
  status: WorkforceStatus;
  taskLabel: string | null;
  taskSeconds: number;
  breakCount: number;
  breakSeconds: number;
};

const SHIFT_LABELS: Record<ShiftCode, string> = {
  morning: "Mañana",
  afternoon: "Tarde",
  night: "Noche",
  montajes: "Montajes",
  responsible: "Responsable almacén",
};

const STATUS_LABELS: Record<WorkforceStatus, string> = {
  working: "TRABAJANDO",
  break: "EN PAUSA",
  available: "DISPONIBLE",
  not_started: "SIN INICIAR",
  finished: "JORNADA TERMINADA",
  incident: "INCIDENCIA",
};

const CART_STATE_LABELS: Record<CartState, string> = {
  available: "DISPONIBLE",
  picking: "EN PICKING",
  ready_for_shipping: "PREPARADO",
  assigned_to_shipping: "RESERVADO EXP.",
  shipping: "EN EXPEDICIÓN",
  completed: "EXPEDIDO",
};

const PRIORITY_LABELS: Record<PriorityCode, string> = {
  high: "ALTA",
  normal: "NORMAL",
  low: "BAJA",
};

function localDateValue() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatElapsed(seconds: number | null | undefined) {
  const safe = Math.max(0, Math.floor(seconds ?? 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function valueText(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export default function ManagerPage() {
  const [selectedDate, setSelectedDate] = useState(localDateValue);
  const [state, setState] = useState<ControlState | null>(null);
  const [planning, setPlanning] = useState<EmployeeDailyAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const [busyCartId, setBusyCartId] = useState<string | null>(null);
  const [slaInput, setSlaInput] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | CartState>("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | PriorityCode>("all");
  const [shiftFilter, setShiftFilter] = useState<"all" | ShiftCode>("all");
  const [operatorFilter, setOperatorFilter] = useState("");
  const [historyCart, setHistoryCart] = useState<CartRow | null>(null);
  const [history, setHistory] = useState<CartHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");

  const loadPlanning = useCallback(async (targetDate: string) => {
    const year = Number(targetDate.slice(0, 4));

    const [
      employeesResult,
      yearResult,
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
        .select("group_a_january_shift")
        .eq("year", year)
        .maybeSingle(),
      supabase.from("non_working_days").select("date"),
      supabase.from("absence_periods").select("employee_id,start_date,end_date"),
      supabase.from("afternoon_manager_settings").select("rotation_group,starter_manager_id"),
      supabase
        .from("shift_reinforcements")
        .select("employee_id,reinforcement_date,target_shift")
        .eq("reinforcement_date", targetDate),
      supabase
        .from("daily_assignment_overrides")
        .select("employee_id,assignment_date,assignment_code")
        .eq("assignment_date", targetDate),
    ]);

    const firstError = [
      employeesResult.error,
      yearResult.error,
      holidaysResult.error,
      absencesResult.error,
      managersResult.error,
      changesResult.error,
      overridesResult.error,
    ].find(Boolean);

    if (firstError) throw new Error(firstError.message);
    if (!yearResult.data) throw new Error(`No existe configuración de turnos para ${year}.`);

    setPlanning(
      buildDailyPlanning({
        targetDate,
        employees: (employeesResult.data ?? []) as PlanningEmployee[],
        groupAJanuaryShift: yearResult.data.group_a_january_shift as WorkShift,
        holidays: (holidaysResult.data ?? []).map((item) => item.date),
        absencePeriods: (absencesResult.data ?? []) as PlanningAbsence[],
        managerSettings: (managersResult.data ?? []) as PlanningManagerSetting[],
        shiftChanges: (changesResult.data ?? []) as PlanningShiftChange[],
        dailyOverrides: (overridesResult.data ?? []) as PlanningDailyOverride[],
      }),
    );
  }, []);

  const loadControl = useCallback(async (targetDate: string, showError = true) => {
    const { data, error } = await supabase.rpc("warehouse_manager_get_control_state", {
      target_operational_date: targetDate,
    });

    if (error) {
      if (showError) setMessage(error.message);
      return;
    }

    const nextState = data as ControlState;
    setState(nextState);
    setSlaInput(nextState.cart_sla_minutes ? String(nextState.cart_sla_minutes) : "");
    setLastSyncAt(new Date().toISOString());
    if (showError) setMessage("");
  }, []);

  const refreshAll = useCallback(
    async (showError = true) => {
      try {
        await Promise.all([loadControl(selectedDate, showError), loadPlanning(selectedDate)]);
      } catch (error) {
        if (showError) {
          setMessage(error instanceof Error ? error.message : "No se ha podido actualizar el panel.");
        }
      }
    },
    [loadControl, loadPlanning, selectedDate],
  );

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void refreshAll().finally(() => setLoading(false));
    }, 0);

    const refreshTimer = window.setInterval(() => {
      void refreshAll(false);
    }, selectedDate === localDateValue() ? 15000 : 60000);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
    };
  }, [refreshAll, selectedDate]);

  useEffect(() => {
    const clockTimer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(clockTimer);
  }, []);

  useEffect(() => {
    if (selectedDate !== localDateValue()) return;

    let refreshTimer: number | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refreshAll(false);
      }, 120);
    };

    const channel = supabase
      .channel("warehouse-manager-live-control")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "warehouse_live_control_signal",
          filter: "id=eq.1",
        },
        scheduleRefresh,
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeStatus("live");
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setRealtimeStatus("fallback");
        }
      });

    const handleOnline = () => {
      setRealtimeStatus("connecting");
      scheduleRefresh();
    };
    const handleOffline = () => setRealtimeStatus("offline");
    const handleVisibility = () => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
      void supabase.removeChannel(channel);
    };
  }, [refreshAll, selectedDate]);

  const getManagementToken = () =>
    window.localStorage.getItem("warehouse-management-session-token");

  const runCartAction = async (
    cart: CartRow,
    action: string,
    value: string | null,
    successMessage: string,
  ) => {
    const token = getManagementToken();

    if (!token) {
      setActionFeedback({
        kind: "error",
        text: "La sesión de Gestor no está disponible. Vuelve a iniciar sesión.",
      });
      return;
    }

    const reason = window.prompt("Motivo de la modificación:")?.trim();
    if (!reason) return;

    setBusyCartId(cart.cart_id);
    setMessage("");
    setActionFeedback(null);

    try {
      const { data, error } = await supabase.rpc(
        "warehouse_manager_apply_cart_action",
        {
          target_session_token: token,
          target_cart_id: cart.cart_id,
          target_action: action,
          target_value: value,
          target_reason: reason,
        },
      );

      if (error) throw new Error(error.message);

      const updated = data as ManagerCartActionResult | null;

      if (!updated?.cart_id) {
        throw new Error("La acción no ha devuelto el estado final del carro.");
      }

      setState((current) => {
        if (!current) return current;

        return {
          ...current,
          carts: current.carts.map((item) =>
            item.cart_id === updated.cart_id
              ? {
                  ...item,
                  state: updated.state,
                  priority_code: updated.priority_code,
                  shipment_type: updated.shipment_type,
                  queue_override: updated.queue_override,
                }
              : item,
          ),
        };
      });

      setActionFeedback({
        kind: "success",
        text: successMessage,
      });

      await loadControl(selectedDate, false);
    } catch (error) {
      const text =
        error instanceof Error
          ? error.message
          : "No se ha podido realizar la acción.";

      setActionFeedback({
        kind: "error",
        text,
      });
    } finally {
      setBusyCartId(null);
    }
  };

  async function changePriority(cart: CartRow, priority: PriorityCode) {
    if ((cart.priority_code ?? "normal") === priority) return;
    await runCartAction(
      cart,
      "priority",
      priority,
      `Prioridad de ${cart.code} actualizada.`,
    );
  }

  async function changeQueue(cart: CartRow) {
    const raw = window.prompt(
      "Posición forzada en cola. Escribe un número (1, 2, 3...) o déjalo vacío para volver al orden automático:",
      cart.queue_override ? String(cart.queue_override) : "",
    );
    if (raw === null) return;
    const clean = raw.trim();
    const position = clean ? Number(clean) : null;
    if (position !== null && (!Number.isInteger(position) || position <= 0)) {
      setMessage("La posición de cola debe ser un número entero mayor que 0.");
      return;
    }

    await runCartAction(
      cart,
      "queue",
      position === null ? null : String(position),
      `Posición de cola de ${cart.code} actualizada.`,
    );
  }

  async function changeShipmentType(cart: CartRow) {
    const value = window.prompt(
      "Tipo de envío. Ejemplo: Nacional, Export <10, Export >10. Déjalo vacío para borrar:",
      cart.shipment_type ?? "",
    );
    if (value === null) return;

    await runCartAction(
      cart,
      "shipment_type",
      value,
      `Tipo de envío de ${cart.code} actualizado.`,
    );
  }

  async function unlockCart(cart: CartRow) {
    await runCartAction(
      cart,
      "unlock",
      null,
      `${cart.code} desbloqueado.`,
    );
  }

  async function releaseCart(cart: CartRow) {
    if (!window.confirm(`¿Liberar ${cart.code} y dejarlo DISPONIBLE?`)) return;
    await runCartAction(
      cart,
      "release",
      null,
      `${cart.code} liberado.`,
    );
  }

  async function returnToQueue(cart: CartRow) {
    if (!window.confirm(`¿Devolver ${cart.code} a la cola de Expedición?`)) return;
    await runCartAction(
      cart,
      "return_to_queue",
      null,
      `${cart.code} devuelto a PREPARADO.`,
    );
  }

  async function completeShipping(cart: CartRow) {
    if (!window.confirm(`¿Cerrar manualmente la Expedición de ${cart.code}?`)) return;
    await runCartAction(
      cart,
      "complete_shipping",
      null,
      `Expedición de ${cart.code} cerrada por gestor.`,
    );
  }

  async function saveSla() {
    const clean = slaInput.trim();
    const minutes = clean ? Number(clean) : null;
    if (minutes !== null && (!Number.isInteger(minutes) || minutes <= 0)) {
      setMessage("El SLA debe ser un número entero mayor que 0.");
      return;
    }

    const token = getManagementToken();
    if (!token) {
      setActionFeedback({
        kind: "error",
        text: "La sesión de Gestor no está disponible. Vuelve a iniciar sesión.",
      });
      return;
    }

    const { error } = await supabase.rpc("warehouse_manager_set_cart_sla", {
      target_session_token: token,
      target_minutes: minutes,
    });
    if (error) {
      setActionFeedback({
        kind: "error",
        text: error.message,
      });
      return;
    }
    setMessage(minutes ? `SLA configurado en ${minutes} minutos.` : "SLA desactivado.");
    await loadControl(selectedDate, false);
  }

  async function openHistory(cart: CartRow) {
    setHistoryCart(cart);
    setHistory([]);
    setHistoryLoading(true);
    try {
      const { data, error } = await supabase.rpc("warehouse_manager_get_cart_history_open", {
        target_cart_id: cart.cart_id,
      });
      if (error) throw new Error(error.message);
      setHistory((data ?? []) as CartHistoryItem[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido cargar el historial.");
    } finally {
      setHistoryLoading(false);
    }
  }

  const liveDate = selectedDate === localDateValue();
  const liveDeltaSeconds =
    liveDate && state
      ? Math.max(0, Math.floor((nowMs - new Date(state.server_now).getTime()) / 1000))
      : 0;

  const workforceRows = useMemo<WorkforceRow[]>(() => {
    const liveByEmployee = new Map((state?.workers ?? []).map((worker) => [worker.employee_id, worker]));
    const sessionByEmployee = new Map((state?.sessions ?? []).map((session) => [session.employee_id, session]));
    const plannedEmployeeIds = new Set(planning.map((item) => item.employeeId));

    const plannedRows = planning
      .filter((item) => item.actualShift !== null || item.absent)
      .map((item): WorkforceRow => {
        const live = liveByEmployee.get(item.employeeId);
        const session = sessionByEmployee.get(item.employeeId);

        if (live) {
          const taskDelta =
            liveDate && live.status === "working" && live.task_label ? liveDeltaSeconds : 0;
          const breakDelta = liveDate && live.status === "break" ? liveDeltaSeconds : 0;

          return {
            employeeId: item.employeeId,
            employeeName: item.employeeName,
            shiftCode: live.shift_code,
            plannedAssignment: item.assignmentLabel,
            actualArea: OPERATIONAL_AREA_LABELS[live.area_code],
            status: live.status,
            taskLabel: live.task_label,
            taskSeconds: live.task_effective_seconds + taskDelta,
            breakCount: live.break_count,
            breakSeconds: live.break_seconds + breakDelta,
          };
        }

        if (item.absent) {
          return {
            employeeId: item.employeeId,
            employeeName: item.employeeName,
            shiftCode: item.actualShift,
            plannedAssignment: item.assignmentLabel,
            actualArea: "—",
            status: "incident",
            taskLabel: "Ausencia",
            taskSeconds: 0,
            breakCount: 0,
            breakSeconds: 0,
          };
        }

        return {
          employeeId: item.employeeId,
          employeeName: item.employeeName,
          shiftCode: item.actualShift,
          plannedAssignment: item.assignmentLabel,
          actualArea: "—",
          status: session?.status === "completed" ? "finished" : "not_started",
          taskLabel: null,
          taskSeconds: 0,
          breakCount: 0,
          breakSeconds: 0,
        };
      });

    const orphanRows: WorkforceRow[] = (state?.workers ?? [])
      .filter((worker) => !plannedEmployeeIds.has(worker.employee_id))
      .map((worker) => ({
        employeeId: worker.employee_id,
        employeeName: worker.employee_name,
        shiftCode: worker.shift_code,
        plannedAssignment: "SIN PLANIFICACIÓN",
        actualArea: OPERATIONAL_AREA_LABELS[worker.area_code],
        status: "incident",
        taskLabel: worker.task_label
          ? `Sesión no planificada · ${worker.task_label}`
          : "Sesión operativa sin planificación",
        taskSeconds:
          worker.task_effective_seconds +
          (liveDate && worker.status === "working" && worker.task_label ? liveDeltaSeconds : 0),
        breakCount: worker.break_count,
        breakSeconds:
          worker.break_seconds + (liveDate && worker.status === "break" ? liveDeltaSeconds : 0),
      }));

    return [...plannedRows, ...orphanRows].sort((a, b) => {
      const order: Record<string, number> = { morning: 1, afternoon: 2, night: 3 };
      const shiftDiff = (order[a.shiftCode ?? "night"] ?? 9) - (order[b.shiftCode ?? "night"] ?? 9);
      return shiftDiff || a.employeeName.localeCompare(b.employeeName, "es");
    });
  }, [liveDate, liveDeltaSeconds, planning, state]);

  const liveWorkforceSummary = useMemo(() => {
    const summary = {
      working: 0,
      break: 0,
      available: 0,
      notStarted: 0,
      incident: 0,
      entradas: 0,
      picking: 0,
      mesas: 0,
    };

    for (const worker of workforceRows) {
      if (worker.status === "working") summary.working += 1;
      if (worker.status === "break") summary.break += 1;
      if (worker.status === "available") summary.available += 1;
      if (worker.status === "not_started") summary.notStarted += 1;
      if (worker.status === "incident") summary.incident += 1;
    }

    for (const worker of state?.workers ?? []) {
      if (worker.area_code === "entradas") summary.entradas += 1;
      if (worker.area_code === "picking") summary.picking += 1;
      if (["mesa1", "mesa2", "mesa3", "mesa4"].includes(worker.area_code)) summary.mesas += 1;
    }

    return summary;
  }, [state, workforceRows]);

  const filteredCarts = useMemo(() => {
    const operatorNeedle = operatorFilter.trim().toLocaleLowerCase("es");
    return (state?.carts ?? []).filter((cart) => {
      if (stateFilter !== "all" && cart.state !== stateFilter) return false;
      if (priorityFilter !== "all" && (cart.priority_code ?? "normal") !== priorityFilter) return false;
      if (
        shiftFilter !== "all" &&
        cart.picking_shift_code !== shiftFilter &&
        cart.shipping_shift_code !== shiftFilter
      ) {
        return false;
      }
      if (operatorNeedle) {
        const names = `${cart.picking_employee_name ?? ""} ${cart.shipping_employee_name ?? ""}`.toLocaleLowerCase("es");
        if (!names.includes(operatorNeedle)) return false;
      }
      return true;
    });
  }, [operatorFilter, priorityFilter, shiftFilter, state, stateFilter]);

  const highPercent = state?.summary.total_cart_cycles
    ? Math.round((state.summary.high_priority_cycles / state.summary.total_cart_cycles) * 100)
    : 0;

  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-8">
      {actionFeedback ? (
        <div
          className={`fixed bottom-4 right-4 z-[120] max-w-md rounded-2xl border px-5 py-4 shadow-2xl ${
            actionFeedback.kind === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-950"
              : "border-red-300 bg-red-50 text-red-950"
          }`}
        >
          <div className="flex items-start gap-4">
            <p className="font-bold">{actionFeedback.text}</p>
            <button
              type="button"
              className="text-sm font-black"
              onClick={() => setActionFeedback(null)}
            >
              ×
            </button>
          </div>
        </div>
      ) : null}

      <div className="mx-auto max-w-[1700px]">
        <header className="rounded-2xl bg-slate-950 p-6 text-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-slate-400">
                FASE 7 · Control en tiempo real
              </p>
              <h1 className="mt-1 text-3xl font-black">Panel del gestor</h1>
              <p className="mt-2 text-sm text-slate-300">
                Situación operativa del almacén, carros y personal con actualización automática.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs font-black">
                <span
                  className={`rounded-full px-3 py-1 ${
                    !liveDate
                      ? "bg-slate-700 text-slate-200"
                      : realtimeStatus === "live"
                        ? "bg-emerald-400 text-emerald-950"
                        : realtimeStatus === "offline"
                          ? "bg-red-400 text-red-950"
                          : "bg-amber-300 text-amber-950"
                  }`}
                >
                  {!liveDate
                    ? "VISTA HISTÓRICA"
                    : realtimeStatus === "live"
                      ? "EN DIRECTO"
                      : realtimeStatus === "offline"
                        ? "SIN CONEXIÓN"
                        : realtimeStatus === "fallback"
                          ? "ACTUALIZACIÓN DE RESPALDO"
                          : "CONECTANDO"}
                </span>
                <span className="text-slate-400">
                  Última sincronización: {lastSyncAt ? formatDateTime(lastSyncAt) : "—"}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                className="rounded-xl bg-white px-4 py-3 font-bold text-slate-950"
                onChange={(event) => setSelectedDate(event.target.value)}
                type="date"
                value={selectedDate}
              />
              <button
                className="rounded-xl bg-white px-4 py-3 font-bold text-slate-950"
                onClick={() => void refreshAll()}
                type="button"
              >
                ACTUALIZAR
              </button>
              <Link className="rounded-xl border border-slate-600 px-4 py-3 font-bold" href="/configuracion/operativa">
                CONFIGURACIÓN
              </Link>
              <Link className="rounded-xl border border-slate-600 px-4 py-3 font-bold" href="/">
                INICIO
              </Link>
            </div>
          </div>
        </header>

        {message ? (
          <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 font-semibold text-blue-900">
            {message}
          </div>
        ) : null}

        <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <SummaryCard label="Trabajando" value={liveWorkforceSummary.working} />
          <SummaryCard label="En pausa" value={liveWorkforceSummary.break} />
          <SummaryCard label="Disponibles" value={liveWorkforceSummary.available} />
          <SummaryCard label="Sin iniciar" value={liveWorkforceSummary.notStarted} />
          <SummaryCard label="Incidencias" value={liveWorkforceSummary.incident} />
        </section>

        <section className="mt-3 grid gap-3 sm:grid-cols-3">
          <MetricCard label="Entradas · personas activas" value={String(liveWorkforceSummary.entradas)} />
          <MetricCard label="Picking · personas activas" value={String(liveWorkforceSummary.picking)} />
          <MetricCard label="Mesas · personas activas" value={String(liveWorkforceSummary.mesas)} />
        </section>

        <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <SummaryCard label="En Picking" value={state?.summary.picking_carts ?? 0} />
          <SummaryCard label="Preparados" value={state?.summary.ready_carts ?? 0} />
          <SummaryCard label="En Expedición" value={state?.summary.shipping_carts ?? 0} />
          <SummaryCard label="Expedidos hoy" value={state?.summary.completed_today ?? 0} />
          <SummaryCard label="Disponibles" value={state?.summary.available_carts ?? 0} />
        </section>

        <section className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="Media Picking" value={formatElapsed(state?.summary.avg_picking_seconds)} />
          <MetricCard label="Media Expedición" value={formatElapsed(state?.summary.avg_shipping_seconds)} />
          <MetricCard label="Media ciclo total" value={formatElapsed(state?.summary.avg_total_seconds)} />
          <MetricCard label="Prioridad alta" value={`${highPercent}%`} />
          <MetricCard
            label="Fuera SLA"
            value={state?.summary.out_of_sla === null || state?.summary.out_of_sla === undefined ? "—" : String(state.summary.out_of_sla)}
          />
        </section>

        <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <h2 className="text-xl font-black">Gestión y SLA</h2>
              <p className="mt-1 text-sm text-slate-500">
                Las modificaciones quedan vinculadas al Gestor autenticado y siempre solicitan un motivo.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm font-bold text-slate-600">
                SLA carro (min)
                <input
                  className="mt-1 block w-36 rounded-xl border p-3 text-slate-950"
                  min="1"
                  onChange={(event) => setSlaInput(event.target.value)}
                  placeholder="Sin SLA"
                  type="number"
                  value={slaInput}
                />
              </label>
              <button
                className="rounded-xl bg-slate-950 px-5 py-3 font-black text-white"
                onClick={() => void saveSla()}
                type="button"
              >
                GUARDAR SLA
              </button>
            </div>
          </div>
        </section>

        <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-black">Operativa del personal</h2>
              <p className="mt-1 text-sm text-slate-500">
                Estado vivo: sin iniciar, disponible, trabajando, pausa, jornada terminada e incidencia. Los cronómetros avanzan cada segundo desde el último timestamp de Supabase.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-bold">
              {workforceRows.length} personas
            </span>
          </div>

          {loading ? (
            <p className="mt-4 rounded-xl bg-slate-100 p-5">Cargando operativa...</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[1100px] text-left">
                <thead className="border-b text-sm text-slate-500">
                  <tr>
                    <th className="py-3">Operario</th>
                    <th>Turno</th>
                    <th>Planificado</th>
                    <th>Puesto real</th>
                    <th>Estado</th>
                    <th>Tarea actual</th>
                    <th>Tiempo tarea</th>
                    <th>Pausas</th>
                  </tr>
                </thead>
                <tbody>
                  {workforceRows.map((worker) => (
                    <tr className="border-b last:border-0" key={worker.employeeId}>
                      <td className="py-4 font-black">{worker.employeeName}</td>
                      <td>{worker.shiftCode ? SHIFT_LABELS[worker.shiftCode] : "—"}</td>
                      <td>{worker.plannedAssignment}</td>
                      <td>{worker.actualArea}</td>
                      <td><StatusBadge status={worker.status} /></td>
                      <td className="font-semibold">{worker.taskLabel ?? "—"}</td>
                      <td className="font-mono font-black">
                        {worker.taskSeconds ? formatElapsed(worker.taskSeconds) : "—"}
                      </td>
                      <td>{worker.breakCount} · {formatElapsed(worker.breakSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-black">Panel maestro de carros</h2>
              <p className="mt-1 text-sm text-slate-500">
                Estado, prioridad, cola, operarios, tiempos y acciones controladas.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select className="rounded-xl border p-3" onChange={(e) => setStateFilter(e.target.value as "all" | CartState)} value={stateFilter}>
                <option value="all">Todos los estados</option>
                {Object.entries(CART_STATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select className="rounded-xl border p-3" onChange={(e) => setPriorityFilter(e.target.value as "all" | PriorityCode)} value={priorityFilter}>
                <option value="all">Todas las prioridades</option>
                {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <select className="rounded-xl border p-3" onChange={(e) => setShiftFilter(e.target.value as "all" | ShiftCode)} value={shiftFilter}>
                <option value="all">Todos los turnos</option>
                <option value="morning">Mañana</option>
                <option value="afternoon">Tarde</option>
                <option value="night">Noche</option>
              </select>
              <input
                className="rounded-xl border p-3"
                onChange={(event) => setOperatorFilter(event.target.value)}
                placeholder="Filtrar operario"
                value={operatorFilter}
              />
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[1750px] text-left text-sm">
              <thead className="border-b text-slate-500">
                <tr>
                  <th className="py-3">Carro</th>
                  <th>Estado</th>
                  <th>Prioridad</th>
                  <th>Cola</th>
                  <th>Tipo envío</th>
                  <th>Picking</th>
                  <th>T. Picking</th>
                  <th>Expedición</th>
                  <th>Mesa</th>
                  <th>T. Expedición</th>
                  <th>T. Total</th>
                  <th>Preparado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredCarts.map((cart) => (
                  <tr className="border-b align-top last:border-0" key={cart.cart_id}>
                    <td className="py-4 font-black">
                      {cart.code}
                      {cart.is_cubetas ? <span className="ml-2 rounded bg-violet-100 px-2 py-1 text-xs text-violet-800">CUBETAS</span> : null}
                      {!cart.active ? <span className="ml-2 rounded bg-slate-200 px-2 py-1 text-xs">INACTIVO</span> : null}
                    </td>
                    <td><CartStateBadge state={cart.state} /></td>
                    <td>
                      <select
                        className="rounded-lg border p-2 font-bold"
                        disabled={busyCartId === cart.cart_id || !cart.picking_job_id}
                        onChange={(event) => void changePriority(cart, event.target.value as PriorityCode)}
                        value={cart.priority_code ?? "normal"}
                      >
                        <option value="high">ALTA</option>
                        <option value="normal">NORMAL</option>
                        <option value="low">BAJA</option>
                      </select>
                    </td>
                    <td>{cart.queue_override ?? "AUTO"}</td>
                    <td>{cart.shipment_type ?? "—"}</td>
                    <td>{cart.picking_employee_name ?? "—"}</td>
                    <td className="font-mono font-black">{cart.picking_job_id ? formatElapsed(cart.picking_effective_seconds) : "—"}</td>
                    <td>{cart.shipping_employee_name ?? "—"}</td>
                    <td>{cart.shipping_area_code ? OPERATIONAL_AREA_LABELS[cart.shipping_area_code] : "—"}</td>
                    <td className="font-mono font-black">{cart.shipping_job_id ? formatElapsed(cart.shipping_effective_seconds) : "—"}</td>
                    <td className="font-mono font-black">{cart.picking_job_id ? formatElapsed(cart.total_seconds) : "—"}</td>
                    <td>{formatDateTime(cart.prepared_at)}</td>
                    <td>
                      <div className="flex max-w-[360px] flex-wrap gap-1.5">
                        <ActionButton disabled={busyCartId === cart.cart_id || cart.state !== "ready_for_shipping"} onClick={() => void changeQueue(cart)}>REORDENAR</ActionButton>
                        <ActionButton disabled={busyCartId === cart.cart_id || !cart.picking_job_id} onClick={() => void changeShipmentType(cart)}>TIPO ENVÍO</ActionButton>
                        <ActionButton disabled={busyCartId === cart.cart_id || !["picking", "shipping", "assigned_to_shipping"].includes(cart.state)} onClick={() => void unlockCart(cart)}>DESBLOQUEAR</ActionButton>
                        <ActionButton disabled={busyCartId === cart.cart_id || !cart.picking_job_id || !["available", "completed"].includes(cart.state)} onClick={() => void returnToQueue(cart)}>A COLA</ActionButton>
                        <ActionButton disabled={busyCartId === cart.cart_id || cart.state !== "shipping"} onClick={() => void completeShipping(cart)}>CERRAR EXP.</ActionButton>
                        <ActionButton danger disabled={busyCartId === cart.cart_id || cart.state === "available"} onClick={() => void releaseCart(cart)}>LIBERAR</ActionButton>
                        <ActionButton disabled={busyCartId === cart.cart_id} onClick={() => void openHistory(cart)}>HISTORIAL</ActionButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!filteredCarts.length ? (
            <p className="mt-4 rounded-xl bg-slate-100 p-5 text-center font-semibold text-slate-500">
              No hay carros que coincidan con los filtros.
            </p>
          ) : null}
        </section>

        <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="text-xl font-black">Carros por operario · {selectedDate}</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {(state?.operator_kpis ?? []).map((item) => (
              <div className="rounded-xl border p-4" key={item.employee_id}>
                <p className="font-black">{item.employee_name}</p>
                <p className="mt-2 text-sm">Picking: <strong>{item.picking_carts}</strong></p>
                <p className="text-sm">Expedición: <strong>{item.shipping_carts}</strong></p>
              </div>
            ))}
          </div>
          {!(state?.operator_kpis.length ?? 0) ? (
            <p className="mt-4 text-sm font-semibold text-slate-500">Todavía no hay carros finalizados en esta fecha.</p>
          ) : null}
        </section>
      </div>

      {historyCart ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-bold uppercase text-slate-500">Historial de carro</p>
                <h2 className="text-2xl font-black">{historyCart.code}</h2>
              </div>
              <button className="rounded-xl border px-4 py-2 font-black" onClick={() => setHistoryCart(null)} type="button">CERRAR</button>
            </div>

            {historyLoading ? (
              <p className="mt-5 rounded-xl bg-slate-100 p-5">Cargando historial...</p>
            ) : (
              <div className="mt-5 space-y-2">
                {history.map((item, index) => (
                  <div className="rounded-xl border p-4" key={`${item.occurred_at}-${item.event_code}-${index}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-black">{item.kind === "correction" ? "CORRECCIÓN" : item.event_code}</p>
                      <p className="text-sm font-semibold text-slate-500">{formatDateTime(item.occurred_at)}</p>
                    </div>
                    <p className="mt-2 text-sm">{valueText(item.from_state)} → {valueText(item.to_state)}</p>
                    {item.actor_name ? <p className="mt-1 text-sm"><strong>Responsable:</strong> {item.actor_name}</p> : null}
                    {item.reason ? <p className="mt-1 text-sm"><strong>Motivo:</strong> {item.reason}</p> : null}
                  </div>
                ))}
                {!history.length ? <p className="rounded-xl bg-slate-100 p-5 text-center">Sin historial.</p> : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <p className="text-xs font-black uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-4xl font-black text-slate-950">{value}</p>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <p className="text-xs font-black uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 font-mono text-2xl font-black text-slate-950">{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: WorkforceStatus }) {
  const styles: Record<WorkforceStatus, string> = {
    working: "bg-emerald-100 text-emerald-800",
    break: "bg-amber-100 text-amber-800",
    available: "bg-blue-100 text-blue-800",
    not_started: "bg-slate-200 text-slate-700",
    finished: "bg-violet-100 text-violet-800",
    incident: "bg-red-100 text-red-800",
  };

  return <span className={`rounded-full px-3 py-1 text-xs font-black ${styles[status]}`}>{STATUS_LABELS[status]}</span>;
}

function CartStateBadge({ state }: { state: CartState }) {
  const styles: Record<CartState, string> = {
    available: "bg-slate-100 text-slate-700",
    picking: "bg-blue-100 text-blue-800",
    ready_for_shipping: "bg-amber-100 text-amber-800",
    assigned_to_shipping: "bg-orange-100 text-orange-800",
    shipping: "bg-emerald-100 text-emerald-800",
    completed: "bg-violet-100 text-violet-800",
  };

  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-black ${styles[state]}`}>{CART_STATE_LABELS[state]}</span>;
}

function ActionButton({
  children,
  disabled,
  onClick,
  danger = false,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className={`rounded-lg border px-2.5 py-2 text-xs font-black disabled:cursor-not-allowed disabled:opacity-30 ${
        danger ? "border-red-200 bg-red-50 text-red-800" : "border-slate-300 bg-white text-slate-800"
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
