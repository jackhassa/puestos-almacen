"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { Suspense, forwardRef, useEffect, useMemo, useRef, useState, type ForwardedRef, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { loadEmployeeDailyAssignment } from "@/lib/daily-plan-service";
import {
  defaultModeForArea,
  OPERATIONAL_AREA_LABELS,
  WORK_MODE_LABELS,
  type OperationalAreaCode,
  type PlannedAssignmentCode,
  type WorkModeCode,
} from "@/lib/operational-types";
import { supabase } from "@/lib/supabase";

type TerminalInfo = {
  terminal_id: string;
  code: string;
  name: string;
  terminal_type: "fixed_pc" | "rf";
  fixed_area_code: OperationalAreaCode | null;
};

type LoginInfo = {
  terminal_session_token: string;
  employee_id: string;
  employee_name: string;
  terminal_id: string;
  terminal_type: "fixed_pc" | "rf";
  fixed_area_code: OperationalAreaCode | null;
  expires_at: string;
};

type WorkSession = {
  id: string;
  operational_date: string;
  shift_code: "morning" | "afternoon" | "night" | "montajes";
  planned_assignment_code: PlannedAssignmentCode;
  status: "working" | "break" | "completed";
  started_at: string;
};

type WorkPeriod = {
  id: string;
  area_code: OperationalAreaCode;
  mode_code: WorkModeCode;
  started_at: string;
};

type WorkBreak = {
  id: string;
  break_type_id: string;
  started_at: string;
};

type CurrentState = {
  work_session: WorkSession | null;
  current_period: WorkPeriod | null;
  current_break: WorkBreak | null;
  terminal_id: string;
};

type BreakType = {
  code: string;
  label: string;
  display_order: number;
};

type EntrySummary = {
  work_session_id: string;
  started_at: string;
  server_now: string;
  break_count: number;
  break_seconds: number;
  elapsed_seconds: number;
  effective_seconds: number;
  entradas_effective_seconds: number;
  entradas_period_count: number;
};

type PickingJobType = "cart" | "no_cart";

type PickingJobSummaryItem = {
  id: string;
  job_type: PickingJobType;
  identifier: string;
  started_at: string;
  ended_at: string | null;
  effective_seconds: number;
};

type PickingSummary = {
  work_session_id: string;
  server_now: string;
  completed_carts: number;
  completed_no_cart: number;
  total_completed: number;
  ready_for_shipping_carts: number;
  avg_cart_effective_seconds: number;
  picking_effective_seconds: number;
  break_count: number;
  break_seconds: number;
  active_job: PickingJobSummaryItem | null;
  recent_jobs: PickingJobSummaryItem[];
};

type ShippingCartCandidate = {
  id: string;
  code: string;
  priority_code: "high" | "normal" | "low";
  shipment_type: string | null;
  is_cubetas: boolean;
  prepared_at: string;
};

type ShippingJobSummaryItem = {
  id: string;
  cart_id: string;
  cart_code: string;
  area_code: "mesa1" | "mesa2" | "mesa3" | "mesa4";
  started_at: string;
  ended_at: string | null;
  effective_seconds: number;
};

type ShippingSummary = {
  work_session_id: string;
  server_now: string;
  area_code: OperationalAreaCode | null;
  mode_code: WorkModeCode | null;
  break_count: number;
  break_seconds: number;
  completed_carts: number;
  avg_cart_effective_seconds: number;
  shipping_effective_seconds: number;
  waiting_total: number;
  current_job: ShippingJobSummaryItem | null;
  next_cart: ShippingCartCandidate | null;
  waiting_carts: ShippingCartCandidate[];
  recent_jobs: ShippingJobSummaryItem[];
};

type PlanningState = {
  operationalDate: string;
  shiftCode:
    | "morning"
    | "afternoon"
    | "night"
    | "montajes"
    | "responsible";
  plannedAssignmentCode: PlannedAssignmentCode;
  assignmentLabel: string;
  areaCode: OperationalAreaCode;
};

const AREAS: OperationalAreaCode[] = [
  "gestor",
  "entradas",
  "picking",
  "montajes",
  "mesa1",
  "mesa2",
  "mesa3",
  "mesa4",
];

function scannerValue(value: string) {
  return value.trim().replace(/^\*+|\*+$/g, "");
}

function localDateText() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftLabel(shift: WorkSession["shift_code"] | PlanningState["shiftCode"]) {
  if (shift === "morning") return "Mañana";
  if (shift === "afternoon") return "Tarde";
  if (shift === "night") return "Noche";
  if (shift === "montajes") return "Montajes";
  return "Responsable de almacén";
}

function normalizeAreaScan(value: string): OperationalAreaCode | null {
  const normalized = scannerValue(value)
    .toLowerCase()
    .replace(/^area[:-]?/, "")
    .replace(/^puesto[:-]?/, "")
    .replace(/[\s_-]/g, "");

  const map: Record<string, OperationalAreaCode> = {
    gestor: "gestor",
    entradas: "entradas",
    picking: "picking",
    montajes: "montajes",
    mesa1: "mesa1",
    mesa2: "mesa2",
    mesa3: "mesa3",
    mesa4: "mesa4",
  };

  return map[normalized] ?? null;
}

function isTableArea(area: OperationalAreaCode) {
  return area === "mesa1" || area === "mesa2" || area === "mesa3" || area === "mesa4";
}

function formatElapsed(totalSeconds: number) {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function useElapsed(startedAt: string | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!startedAt) return "00:00:00";
  return formatElapsed(Math.floor((now - new Date(startedAt).getTime()) / 1000));
}

function formatStartTime(value: string) {
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function TerminalContent() {
  const params = useSearchParams();
  const terminalCode = (params.get("terminal") ?? "").trim().toUpperCase();

  const [terminal, setTerminal] = useState<TerminalInfo | null>(null);
  const [terminalError, setTerminalError] = useState("");
  const [username, setUsername] = useState("");
  const [passwordCode, setPasswordCode] = useState("");
  const [login, setLogin] = useState<LoginInfo | null>(null);
  const [state, setState] = useState<CurrentState | null>(null);
  const [planning, setPlanning] = useState<PlanningState | null>(null);
  const [selectedArea, setSelectedArea] = useState<OperationalAreaCode | null>(null);
  const [locationScan, setLocationScan] = useState("");
  const [breakTypes, setBreakTypes] = useState<BreakType[]>([]);
  const [entrySummary, setEntrySummary] = useState<EntrySummary | null>(null);
  const [pickingSummary, setPickingSummary] = useState<PickingSummary | null>(null);
  const [shippingSummary, setShippingSummary] = useState<ShippingSummary | null>(null);
  const [pickingJobType, setPickingJobType] = useState<PickingJobType>("cart");
  const [pickingIdentifier, setPickingIdentifier] = useState("");
  const [pickingFinishScan, setPickingFinishScan] = useState("");
  const [shippingScan, setShippingScan] = useState("");
  const [screen, setScreen] = useState<"main" | "change" | "break">("main");
  const [changeArea, setChangeArea] = useState<OperationalAreaCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const locationRef = useRef<HTMLInputElement | null>(null);
  const pickingIdentifierRef = useRef<HTMLInputElement | null>(null);
  const pickingFinishRef = useRef<HTMLInputElement | null>(null);
  const shippingScanRef = useRef<HTMLInputElement | null>(null);

  const workElapsed = useElapsed(state?.work_session?.started_at ?? null);
  const taskElapsed = useElapsed(state?.current_period?.started_at ?? null);
  const breakElapsed = useElapsed(state?.current_break?.started_at ?? null);

  async function loadTerminal(code: string) {
    if (!code) return;
    const { data, error } = await supabase.rpc("warehouse_get_terminal_info", {
      target_terminal_code: code,
    });

    if (error) {
      setTerminalError(error.message);
      return;
    }

    const row = (Array.isArray(data) ? data[0] : null) as TerminalInfo | undefined;
    if (!row) {
      setTerminalError(`El terminal ${code} no existe o está inactivo.`);
      return;
    }

    setTerminal(row);
    setTerminalError("");

    const storedToken = window.sessionStorage.getItem(`warehouse-terminal-session:${row.code}`);
    if (storedToken) {
      await resumeStoredSession(row, storedToken);
    } else {
      window.setTimeout(() => usernameRef.current?.focus(), 50);
    }
  }

  useEffect(() => {
    if (terminalCode) {
      void loadTerminal(terminalCode);
    }
  }, [terminalCode]);

  async function resumeStoredSession(terminalInfo: TerminalInfo, token: string) {
    const { data, error } = await supabase.rpc("warehouse_resume_terminal_session", {
      target_session_token: token,
      target_terminal_code: terminalInfo.code,
    });

    if (error) {
      window.sessionStorage.removeItem(`warehouse-terminal-session:${terminalInfo.code}`);
      window.setTimeout(() => usernameRef.current?.focus(), 50);
      return;
    }

    const row = (Array.isArray(data) ? data[0] : null) as LoginInfo | undefined;
    if (!row) {
      window.sessionStorage.removeItem(`warehouse-terminal-session:${terminalInfo.code}`);
      window.setTimeout(() => usernameRef.current?.focus(), 50);
      return;
    }

    setLogin(row);
    await loadBreakTypes(row.terminal_session_token);

    const { data: stateData, error: stateError } = await supabase.rpc("warehouse_get_current_state", {
      target_session_token: row.terminal_session_token,
    });

    if (stateError) {
      window.sessionStorage.removeItem(`warehouse-terminal-session:${terminalInfo.code}`);
      setLogin(null);
      window.setTimeout(() => usernameRef.current?.focus(), 50);
      return;
    }

    const current = stateData as CurrentState;
    setState(current);

    if (current.work_session) {
      await Promise.all([
        loadEntrySummary(row.terminal_session_token),
        loadPickingSummary(row.terminal_session_token),
        loadShippingSummary(row.terminal_session_token),
      ]);
    } else {
      setEntrySummary(null);
      setPickingSummary(null);
      setShippingSummary(null);
    }

    if (!current.work_session) {
      await autoStartFixedTerminal(
        row.terminal_session_token,
        row.employee_id,
        terminalInfo,
      );
    } else if (terminalInfo.terminal_type === "fixed_pc") {
      setSelectedArea(terminalInfo.fixed_area_code);
    }
  }

  async function loadEntrySummary(token: string) {
    const { data, error } = await supabase.rpc("warehouse_get_entries_summary", {
      target_session_token: token,
    });

    if (error) throw new Error(error.message);
    setEntrySummary(data as EntrySummary);
  }

  async function loadPickingSummary(token: string) {
    const { data, error } = await supabase.rpc("warehouse_get_picking_summary", {
      target_session_token: token,
    });

    if (error) throw new Error(error.message);
    setPickingSummary(data as PickingSummary);
  }

  async function loadShippingSummary(token: string) {
    const { data, error } = await supabase.rpc("warehouse_get_shipping_summary", {
      target_session_token: token,
    });

    if (error) throw new Error(error.message);
    setShippingSummary(data as ShippingSummary);
  }

  async function refreshCurrentState(token: string) {
    const { data, error } = await supabase.rpc("warehouse_get_current_state", {
      target_session_token: token,
    });

    if (error) throw new Error(error.message);
    const current = data as CurrentState;
    setState(current);

    if (current.work_session) {
      await Promise.all([
        loadEntrySummary(token),
        loadPickingSummary(token),
        loadShippingSummary(token),
      ]);
    } else {
      setEntrySummary(null);
      setPickingSummary(null);
      setShippingSummary(null);
    }
  }

  useEffect(() => {
    const token = login?.terminal_session_token;
    const workSessionId = state?.work_session?.id;

    if (!token || !workSessionId) return;

    const timer = window.setInterval(() => {
      void refreshCurrentState(token).catch(() => {
        // Una caída puntual de red no debe sacar al operario de su pantalla.
        // El siguiente refresco recuperará el estado real desde Supabase.
      });
    }, 4000);

    return () => window.clearInterval(timer);
    // refreshCurrentState es una función local estable para este ciclo de sesión.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.terminal_session_token, state?.work_session?.id]);

  async function loadBreakTypes(token: string) {
    const { data, error } = await supabase.rpc("warehouse_get_break_types", {
      target_session_token: token,
    });

    if (error) throw new Error(error.message);
    setBreakTypes((data ?? []) as BreakType[]);
  }

  async function loadPlanning(
    employeeId: string,
    terminalInfo: TerminalInfo,
  ): Promise<PlanningState | null> {
    const today = localDateText();
    const assignment = await loadEmployeeDailyAssignment(employeeId, today);

    if (!assignment.canStart || !assignment.actualShift || !assignment.areaCode || !assignment.assignmentCode) {
      setPlanning(null);
      setMessage(assignment.reason ?? "No hay un puesto operativo asignado.");
      return null;
    }

    const next: PlanningState = {
      operationalDate: assignment.operationalDate,
      shiftCode: assignment.actualShift,
      plannedAssignmentCode: assignment.assignmentCode,
      assignmentLabel: assignment.assignmentLabel,
      areaCode: assignment.areaCode,
    };

    setPlanning(next);

    if (terminalInfo.terminal_type === "fixed_pc") {
      setSelectedArea(terminalInfo.fixed_area_code);
    } else {
      setSelectedArea(null);
      window.setTimeout(() => locationRef.current?.focus(), 50);
    }

    return next;
  }

  async function startPlannedWorkSession(
    sessionToken: string,
    targetPlanning: PlanningState,
    targetArea: OperationalAreaCode,
  ) {
    if (targetArea !== targetPlanning.areaCode) {
      setMessage(
        `Puesto incorrecto. El monitor indica ${targetPlanning.assignmentLabel} y este terminal corresponde a ${OPERATIONAL_AREA_LABELS[targetArea]}.`,
      );
      return false;
    }

    const { error } = await supabase.rpc("warehouse_start_work_session", {
      target_session_token: sessionToken,
      target_operational_date: targetPlanning.operationalDate,
      target_shift_code: targetPlanning.shiftCode,
      target_planned_assignment_code: targetPlanning.plannedAssignmentCode,
      target_area_code: targetArea,
      target_mode_code: defaultModeForArea(targetArea),
    });

    if (error) throw new Error(error.message);

    await refreshCurrentState(sessionToken);
    setPlanning(null);
    setMessage("");
    return true;
  }

  async function autoStartFixedTerminal(
    sessionToken: string,
    employeeId: string,
    terminalInfo: TerminalInfo,
  ) {
    const nextPlanning = await loadPlanning(employeeId, terminalInfo);

    if (!nextPlanning || terminalInfo.terminal_type !== "fixed_pc") {
      return;
    }

    const fixedArea = terminalInfo.fixed_area_code;
    if (!fixedArea) {
      setMessage("Este terminal fijo no tiene un puesto operativo configurado.");
      return;
    }

    await startPlannedWorkSession(sessionToken, nextPlanning, fixedArea);
  }

  async function doLogin() {
    if (!terminal || !username.trim() || !passwordCode) return;
    setBusy(true);
    setMessage("");

    try {
      const { data, error } = await supabase.rpc("warehouse_terminal_login", {
        target_username_code: scannerValue(username).toUpperCase(),
        target_password_code: scannerValue(passwordCode),
        target_terminal_code: terminal.code,
      });

      if (error) throw new Error(error.message);

      const row = (Array.isArray(data) ? data[0] : null) as LoginInfo | undefined;
      if (!row) throw new Error("No se ha recibido la sesión del terminal.");

      setLogin(row);
      window.sessionStorage.setItem(
        `warehouse-terminal-session:${terminal.code}`,
        row.terminal_session_token,
      );
      setUsername("");
      setPasswordCode("");

      const [{ data: stateData, error: stateError }] = await Promise.all([
        supabase.rpc("warehouse_get_current_state", {
          target_session_token: row.terminal_session_token,
        }),
        loadBreakTypes(row.terminal_session_token),
      ]);

      if (stateError) throw new Error(stateError.message);
      const current = stateData as CurrentState;
      setState(current);

      if (current.work_session) {
        await Promise.all([
          loadEntrySummary(row.terminal_session_token),
          loadPickingSummary(row.terminal_session_token),
          loadShippingSummary(row.terminal_session_token),
        ]);
      } else {
        setEntrySummary(null);
        setPickingSummary(null);
        setShippingSummary(null);
      }

      if (!current.work_session) {
        await autoStartFixedTerminal(
          row.terminal_session_token,
          row.employee_id,
          terminal,
        );
      } else {
        setPlanning(null);
        if (terminal.terminal_type === "fixed_pc") {
          setSelectedArea(terminal.fixed_area_code);
        }
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido iniciar sesión.");
    } finally {
      setBusy(false);
    }
  }

  function acceptLocationScan() {
    const area = normalizeAreaScan(locationScan);
    if (!area) {
      setMessage("Código de puesto no reconocido.");
      return;
    }

    setSelectedArea(area);
    setLocationScan("");
    setMessage("");
  }

  async function startWork() {
    if (!login || !planning || !selectedArea) return;

    setBusy(true);
    setMessage("");

    try {
      await startPlannedWorkSession(
        login.terminal_session_token,
        planning,
        selectedArea,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido iniciar la jornada.");
    } finally {
      setBusy(false);
    }
  }

  async function changeContext(area: OperationalAreaCode, mode: WorkModeCode) {
    if (!login) return;

    if (pickingSummary?.active_job) {
      setMessage("Finaliza el trabajo de Picking activo antes de cambiar de tarea.");
      return;
    }

    if (shippingSummary?.current_job) {
      setMessage("Finaliza el carro de Expedición activo antes de cambiar de tarea.");
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const { error } = await supabase.rpc("warehouse_change_work_context", {
        target_session_token: login.terminal_session_token,
        target_area_code: area,
        target_mode_code: mode,
      });

      if (error) throw new Error(error.message);
      await refreshCurrentState(login.terminal_session_token);
      setScreen("main");
      setChangeArea(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido cambiar la tarea.");
    } finally {
      setBusy(false);
    }
  }

  async function startPickingJob(jobType: PickingJobType) {
    if (!login || state?.current_period?.area_code !== "picking" || state.current_break) return;

    const identifier = scannerValue(pickingIdentifier);
    if (jobType === "cart" && !identifier) {
      setMessage("Escanea el código del carro.");
      window.setTimeout(() => pickingIdentifierRef.current?.focus(), 50);
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const { error } = await supabase.rpc("warehouse_start_picking_job", {
        target_session_token: login.terminal_session_token,
        target_job_type: jobType,
        target_identifier: identifier,
      });

      if (error) throw new Error(error.message);

      setPickingIdentifier("");
      setPickingFinishScan("");
      await refreshCurrentState(login.terminal_session_token);
      window.setTimeout(() => pickingIdentifierRef.current?.focus(), 50);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido iniciar el trabajo de Picking.");
    } finally {
      setBusy(false);
    }
  }

  async function finishPickingJob() {
    if (!login || !pickingSummary?.active_job) return;

    const active = pickingSummary.active_job;
    const scannedCode = scannerValue(pickingFinishScan).toUpperCase();

    if (active.job_type === "cart" && !scannedCode) {
      setMessage("Vuelve a escanear el carro para finalizar Picking.");
      window.setTimeout(() => pickingFinishRef.current?.focus(), 50);
      return;
    }

    const label = active.job_type === "cart" ? `carro ${active.identifier}` : "trabajo sin carro";
    if (!window.confirm(`¿Finalizar ${label}?`)) return;

    setBusy(true);
    setMessage("");

    try {
      const { error } = await supabase.rpc("warehouse_finish_picking_job", {
        target_session_token: login.terminal_session_token,
        target_scanned_cart_code: active.job_type === "cart" ? scannedCode : "",
      });

      if (error) throw new Error(error.message);

      setPickingFinishScan("");
      await refreshCurrentState(login.terminal_session_token);
      window.setTimeout(() => pickingIdentifierRef.current?.focus(), 50);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido finalizar el trabajo de Picking.");
      window.setTimeout(() => pickingFinishRef.current?.focus(), 50);
    } finally {
      setBusy(false);
    }
  }

  async function claimShippingCart() {
    if (!login || !shippingSummary?.next_cart) return;

    setBusy(true);
    setMessage("");

    try {
      const { error } = await supabase.rpc("warehouse_claim_shipping_cart", {
        target_session_token: login.terminal_session_token,
        target_expected_cart_id: shippingSummary.next_cart.id,
        target_scanned_cart_code: scannerValue(shippingScan).toUpperCase(),
      });

      if (error) throw new Error(error.message);

      setShippingScan("");
      await refreshCurrentState(login.terminal_session_token);
      window.setTimeout(() => shippingScanRef.current?.focus(), 50);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido coger el carro.");
    } finally {
      setBusy(false);
    }
  }

  async function finishShippingJob() {
    if (!login || !shippingSummary?.current_job) return;

    const scannedCode = scannerValue(shippingScan).toUpperCase();
    if (!scannedCode) {
      setMessage("Escanea el carro actual para finalizar Expedición.");
      window.setTimeout(() => shippingScanRef.current?.focus(), 50);
      return;
    }

    if (!window.confirm(`¿Finalizar Expedición del carro ${shippingSummary.current_job.cart_code}?`)) {
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const { error } = await supabase.rpc("warehouse_finish_shipping_job", {
        target_session_token: login.terminal_session_token,
        target_scanned_cart_code: scannedCode,
      });

      if (error) throw new Error(error.message);

      setShippingScan("");
      await refreshCurrentState(login.terminal_session_token);
      window.setTimeout(() => shippingScanRef.current?.focus(), 50);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido finalizar Expedición.");
      window.setTimeout(() => shippingScanRef.current?.focus(), 50);
    } finally {
      setBusy(false);
    }
  }

  async function startBreak(code: string) {
    if (!login) return;
    setBusy(true);
    setMessage("");

    try {
      const { error } = await supabase.rpc("warehouse_start_break", {
        target_session_token: login.terminal_session_token,
        target_break_code: code,
      });

      if (error) throw new Error(error.message);
      await refreshCurrentState(login.terminal_session_token);
      setScreen("main");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido iniciar la pausa.");
    } finally {
      setBusy(false);
    }
  }

  async function endBreak() {
    if (!login) return;
    setBusy(true);
    setMessage("");

    try {
      const { error } = await supabase.rpc("warehouse_end_break", {
        target_session_token: login.terminal_session_token,
      });
      if (error) throw new Error(error.message);
      await refreshCurrentState(login.terminal_session_token);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido finalizar la pausa.");
    } finally {
      setBusy(false);
    }
  }

  async function finishWork() {
    if (!login) return;

    if (pickingSummary?.active_job) {
      setMessage("Finaliza el trabajo de Picking activo antes de finalizar la jornada.");
      return;
    }

    if (shippingSummary?.current_job) {
      setMessage("Finaliza el carro de Expedición activo antes de finalizar la jornada.");
      return;
    }

    if (!window.confirm("¿Finalizar la jornada?")) return;

    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("warehouse_finish_work_session", {
        target_session_token: login.terminal_session_token,
      });
      if (error) throw new Error(error.message);
      await logout();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido finalizar la jornada.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (login) {
      await supabase.rpc("warehouse_terminal_logout", {
        target_session_token: login.terminal_session_token,
      });
    }

    if (terminal) {
      window.sessionStorage.removeItem(`warehouse-terminal-session:${terminal.code}`);
    }

    setLogin(null);
    setState(null);
    setEntrySummary(null);
    setPickingSummary(null);
    setShippingSummary(null);
    setPickingIdentifier("");
    setPickingFinishScan("");
    setShippingScan("");
    setPickingJobType("cart");
    setPlanning(null);
    setSelectedArea(null);
    setScreen("main");
    setChangeArea(null);
    setMessage("");
    window.setTimeout(() => usernameRef.current?.focus(), 50);
  }

  const physicalMismatch = useMemo(() => {
    if (!terminal || !state?.current_period || terminal.terminal_type !== "fixed_pc") return false;
    return terminal.fixed_area_code !== state.current_period.area_code;
  }, [terminal, state]);

  if (!terminalCode) {
    return (
      <TerminalFrame title="Configurar terminal">
        <p className="text-center text-lg text-slate-600">
          Abre este terminal desde Configuración operativa o utiliza una dirección del tipo
          <strong className="block mt-2">/terminal?terminal=PC-MESA4</strong>
        </p>
      </TerminalFrame>
    );
  }

  if (!terminal && !terminalError) {
    return <TerminalFrame title="Terminal">Cargando terminal...</TerminalFrame>;
  }

  if (terminalError || !terminal) {
    return (
      <TerminalFrame title="Terminal no disponible">
        <Notice tone="error">{terminalError || "Terminal no encontrado."}</Notice>
      </TerminalFrame>
    );
  }

  if (!login) {
    return (
      <TerminalFrame title={terminal.name} subtitle={terminal.code}>
        <div className="mx-auto max-w-xl space-y-5">
          <ScanField
            label="1. Escanear usuario"
            onEnter={() => passwordRef.current?.focus()}
            onValue={setUsername}
            ref={usernameRef}
            value={username}
          />
          <ScanField
            label="2. Escanear password"
            onEnter={() => void doLogin()}
            onValue={setPasswordCode}
            password
            ref={passwordRef}
            value={passwordCode}
          />
          <button
            className="min-h-20 w-full rounded-2xl bg-slate-900 px-6 py-5 text-2xl font-black text-white disabled:opacity-40"
            disabled={busy || !username.trim() || !passwordCode}
            onClick={() => void doLogin()}
            type="button"
          >
            {busy ? "VALIDANDO..." : "ENTRAR"}
          </button>
          {message ? <Notice tone="error">{message}</Notice> : null}
        </div>
      </TerminalFrame>
    );
  }

  if (!state?.work_session) {
    const expected = planning?.areaCode ?? null;
    const mismatch = Boolean(expected && selectedArea && expected !== selectedArea);

    return (
      <TerminalFrame title={login.employee_name} subtitle={`${terminal.name} · ${terminal.code}`}>
        <div className="mx-auto max-w-3xl space-y-5">
          {planning ? (
            <div className="rounded-3xl bg-white p-6 text-center shadow-sm">
              <p className="text-sm font-bold uppercase tracking-wider text-slate-500">Tu puesto según el monitor</p>
              <p className="mt-2 text-4xl font-black text-slate-900">{planning.assignmentLabel}</p>
              <p className="mt-2 text-lg text-slate-600">Turno {shiftLabel(planning.shiftCode)}</p>
            </div>
          ) : null}

          {terminal.terminal_type === "rf" ? (
            <div className="rounded-3xl bg-white p-6 shadow-sm">
              <ScanField
                label="Escanea el puesto en el que estás"
                onEnter={acceptLocationScan}
                onValue={setLocationScan}
                ref={locationRef}
                value={locationScan}
              />
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                {AREAS.map((area) => (
                  <button
                    className="min-h-16 rounded-xl border border-slate-300 bg-slate-50 p-3 text-base font-bold text-slate-800"
                    key={area}
                    onClick={() => setSelectedArea(area)}
                    type="button"
                  >
                    {OPERATIONAL_AREA_LABELS[area]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {selectedArea ? (
            <Notice tone={mismatch ? "error" : "success"}>
              {mismatch
                ? `PUESTO INCORRECTO · Aquí estás marcando ${OPERATIONAL_AREA_LABELS[selectedArea]}`
                : `PUESTO VALIDADO · ${OPERATIONAL_AREA_LABELS[selectedArea]}`}
            </Notice>
          ) : null}

          {message ? <Notice tone="error">{message}</Notice> : null}

          <button
            className="min-h-24 w-full rounded-2xl bg-emerald-600 px-6 py-6 text-3xl font-black text-white disabled:bg-slate-300"
            disabled={busy || !planning || !selectedArea || mismatch}
            onClick={() => void startWork()}
            type="button"
          >
            INICIAR JORNADA
          </button>

          <button className="w-full rounded-xl border border-slate-300 px-5 py-4 font-bold" onClick={() => void logout()} type="button">
            Cambiar operario
          </button>
        </div>
      </TerminalFrame>
    );
  }

  if (state.current_break) {
    return (
      <TerminalFrame title={login.employee_name} subtitle={`${terminal.name} · PAUSA`}>
        <div className="mx-auto max-w-2xl space-y-5 text-center">
          <div className="rounded-3xl bg-amber-100 p-8">
            <p className="text-xl font-bold text-amber-900">PAUSA EN CURSO</p>
            <p className="mt-3 font-mono text-5xl font-black text-amber-950">{breakElapsed}</p>
          </div>
          {state.current_period?.area_code === "entradas" && entrySummary ? (
            <EntrySummaryPanel
              currentBreak={state.current_break}
              currentPeriod={state.current_period}
              summary={entrySummary}
            />
          ) : null}
          {state.current_period?.area_code === "picking" && pickingSummary ? (
            <PickingSummaryPanel
              currentBreak={state.current_break}
              currentPeriod={state.current_period}
              summary={pickingSummary}
            />
          ) : null}
          {state.current_period &&
          isTableArea(state.current_period.area_code) &&
          state.current_period.mode_code === "cart" &&
          shippingSummary ? (
            <ShippingSummaryPanel
              currentBreak={state.current_break}
              currentPeriod={state.current_period}
              summary={shippingSummary}
            />
          ) : null}
          {message ? <Notice tone="error">{message}</Notice> : null}
          <button className="min-h-24 w-full rounded-2xl bg-emerald-600 px-6 text-3xl font-black text-white" disabled={busy} onClick={() => void endBreak()} type="button">
            FINALIZAR PAUSA
          </button>
          <button className="w-full rounded-xl border border-slate-300 px-5 py-4 font-bold" onClick={() => void logout()} type="button">
            Salir del terminal
          </button>
        </div>
      </TerminalFrame>
    );
  }

  if (screen === "break") {
    return (
      <TerminalFrame title="Selecciona pausa" subtitle={login.employee_name}>
        <div className="mx-auto grid max-w-2xl gap-4">
          {breakTypes.map((item) => (
            <button
              className="min-h-28 rounded-2xl bg-amber-500 px-6 text-2xl font-black text-slate-950"
              disabled={busy}
              key={item.code}
              onClick={() => void startBreak(item.code)}
              type="button"
            >
              {item.label}
            </button>
          ))}
          <button className="min-h-16 rounded-xl border border-slate-300 bg-white font-bold" onClick={() => setScreen("main")} type="button">
            VOLVER
          </button>
        </div>
      </TerminalFrame>
    );
  }

  if (screen === "change") {
    if (changeArea) {
      const modes: WorkModeCode[] = isTableArea(changeArea)
        ? ["cart", "export", "support"]
        : ["standard"];

      return (
        <TerminalFrame title={OPERATIONAL_AREA_LABELS[changeArea]} subtitle="Selecciona modo de trabajo">
          <div className="mx-auto grid max-w-2xl gap-4">
            {modes.map((mode) => (
              <button
                className="min-h-24 rounded-2xl bg-slate-900 px-6 text-2xl font-black text-white"
                disabled={busy}
                key={mode}
                onClick={() => void changeContext(changeArea, mode)}
                type="button"
              >
                {WORK_MODE_LABELS[mode]}
              </button>
            ))}
            <button className="min-h-16 rounded-xl border border-slate-300 bg-white font-bold" onClick={() => setChangeArea(null)} type="button">
              VOLVER
            </button>
          </div>
        </TerminalFrame>
      );
    }

    return (
      <TerminalFrame title="Cambiar tarea" subtitle={login.employee_name}>
        <div className="mx-auto grid max-w-4xl grid-cols-2 gap-4 md:grid-cols-4">
          {AREAS.map((area) => (
            <button
              className="min-h-28 rounded-2xl bg-white p-4 text-xl font-black text-slate-900 shadow-sm"
              key={area}
              onClick={() => setChangeArea(area)}
              type="button"
            >
              {OPERATIONAL_AREA_LABELS[area]}
            </button>
          ))}
          <button className="col-span-2 min-h-16 rounded-xl border border-slate-300 bg-white font-bold md:col-span-4" onClick={() => setScreen("main")} type="button">
            VOLVER
          </button>
        </div>
      </TerminalFrame>
    );
  }

  if (state.current_period?.area_code === "entradas" && entrySummary) {
    return (
      <TerminalFrame title={login.employee_name} subtitle={`${terminal.name} · Entradas`}>
        <div className="mx-auto max-w-4xl space-y-5">
          {physicalMismatch ? (
            <Notice tone="info">
              Tu jornada continúa en Entradas. Puedes cambiar la tarea desde este terminal.
            </Notice>
          ) : null}

          <EntrySummaryPanel
            currentBreak={state.current_break}
            currentPeriod={state.current_period}
            summary={entrySummary}
          />

          {message ? <Notice tone="error">{message}</Notice> : null}

          <div className="grid gap-4 md:grid-cols-2">
            <button
              className="min-h-28 rounded-2xl bg-amber-500 px-6 text-2xl font-black text-slate-950"
              onClick={() => setScreen("break")}
              type="button"
            >
              PAUSA
            </button>
            <button
              className="min-h-28 rounded-2xl bg-blue-600 px-6 text-2xl font-black text-white"
              onClick={() => setScreen("change")}
              type="button"
            >
              CAMBIAR TAREA
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <button
              className="min-h-16 rounded-xl border border-slate-300 bg-white px-5 font-bold"
              onClick={() => void logout()}
              type="button"
            >
              CAMBIAR OPERARIO
            </button>
            <button
              className="min-h-16 rounded-xl border border-red-300 bg-red-50 px-5 font-bold text-red-800"
              disabled={busy}
              onClick={() => void finishWork()}
              type="button"
            >
              FINALIZAR JORNADA
            </button>
          </div>
        </div>
      </TerminalFrame>
    );
  }

  if (state.current_period?.area_code === "picking" && pickingSummary) {
    const activeJob = pickingSummary.active_job;

    return (
      <TerminalFrame title={login.employee_name} subtitle={`${terminal.name} · Picking`}>
        <div className="mx-auto max-w-4xl space-y-5">
          {physicalMismatch ? (
            <Notice tone="info">
              Tu jornada continúa en Picking. Puedes seguirla desde este terminal.
            </Notice>
          ) : null}

          <PickingSummaryPanel
            currentBreak={state.current_break}
            currentPeriod={state.current_period}
            summary={pickingSummary}
          />

          {activeJob ? (
            <ActivePickingJobPanel
              currentBreak={state.current_break}
              job={activeJob}
              serverNow={pickingSummary.server_now}
            />
          ) : (
            <section className="rounded-3xl bg-white p-6 shadow-sm md:p-8">
              <p className="text-center text-sm font-black uppercase tracking-[0.2em] text-slate-500">
                Nuevo trabajo
              </p>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  className={`min-h-20 rounded-2xl px-4 text-xl font-black ${
                    pickingJobType === "cart"
                      ? "bg-blue-600 text-white"
                      : "border-2 border-slate-300 bg-white text-slate-800"
                  }`}
                  onClick={() => {
                    setPickingJobType("cart");
                    setPickingIdentifier("");
                    window.setTimeout(() => pickingIdentifierRef.current?.focus(), 50);
                  }}
                  type="button"
                >
                  CON CARRO
                </button>
                <button
                  className={`min-h-20 rounded-2xl px-4 text-xl font-black ${
                    pickingJobType === "no_cart"
                      ? "bg-blue-600 text-white"
                      : "border-2 border-slate-300 bg-white text-slate-800"
                  }`}
                  onClick={() => {
                    setPickingJobType("no_cart");
                    setPickingIdentifier("");
                    window.setTimeout(() => pickingIdentifierRef.current?.focus(), 50);
                  }}
                  type="button"
                >
                  SIN CARRO
                </button>
              </div>

              {pickingJobType === "cart" ? (
                <>
                  <div className="mt-5">
                    <ScanField
                      label="ESCANEAR CARRO"
                      onEnter={() => void startPickingJob("cart")}
                      onValue={setPickingIdentifier}
                      ref={pickingIdentifierRef}
                      value={pickingIdentifier}
                    />
                  </div>

                  <button
                    className="mt-5 min-h-24 w-full rounded-2xl bg-emerald-600 px-6 text-2xl font-black text-white disabled:bg-slate-300"
                    disabled={busy || !scannerValue(pickingIdentifier)}
                    onClick={() => void startPickingJob("cart")}
                    type="button"
                  >
                    INICIAR CARRO
                  </button>
                </>
              ) : (
                <button
                  className="mt-5 min-h-24 w-full rounded-2xl bg-emerald-600 px-6 text-2xl font-black text-white disabled:bg-slate-300"
                  disabled={busy}
                  onClick={() => void startPickingJob("no_cart")}
                  type="button"
                >
                  INICIAR TRABAJO SIN CARRO
                </button>
              )}
            </section>
          )}

          {activeJob?.job_type === "cart" ? (
            <ScanField
              label={`VUELVE A ESCANEAR CARRO ${activeJob.identifier} PARA FINALIZAR`}
              onEnter={() => void finishPickingJob()}
              onValue={setPickingFinishScan}
              ref={pickingFinishRef}
              value={pickingFinishScan}
            />
          ) : null}

          {message ? <Notice tone="error">{message}</Notice> : null}

          {activeJob ? (
            <div className="grid gap-4 md:grid-cols-2">
              <button
                className="min-h-28 rounded-2xl bg-amber-500 px-6 text-2xl font-black text-slate-950"
                onClick={() => setScreen("break")}
                type="button"
              >
                PAUSA
              </button>
              <button
                className="min-h-28 rounded-2xl bg-emerald-600 px-6 text-2xl font-black text-white disabled:bg-slate-300"
                disabled={busy || (activeJob.job_type === "cart" && !scannerValue(pickingFinishScan))}
                onClick={() => void finishPickingJob()}
                type="button"
              >
                {activeJob.job_type === "cart" ? "FINALIZAR CARRO" : "FINALIZAR TRABAJO"}
              </button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <button
                className="min-h-28 rounded-2xl bg-amber-500 px-6 text-2xl font-black text-slate-950"
                onClick={() => setScreen("break")}
                type="button"
              >
                PAUSA
              </button>
              <button
                className="min-h-28 rounded-2xl bg-blue-600 px-6 text-2xl font-black text-white"
                onClick={() => setScreen("change")}
                type="button"
              >
                CAMBIAR TAREA
              </button>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <button
              className="min-h-16 rounded-xl border border-slate-300 bg-white px-5 font-bold"
              onClick={() => void logout()}
              type="button"
            >
              CAMBIAR OPERARIO
            </button>
            <button
              className="min-h-16 rounded-xl border border-red-300 bg-red-50 px-5 font-bold text-red-800 disabled:opacity-40"
              disabled={busy || Boolean(activeJob)}
              onClick={() => void finishWork()}
              type="button"
            >
              FINALIZAR JORNADA
            </button>
          </div>

          {activeJob ? (
            <p className="text-center text-sm font-bold text-slate-500">
              Finaliza el trabajo de Picking activo antes de cambiar de tarea o finalizar la jornada.
            </p>
          ) : null}
        </div>
      </TerminalFrame>
    );
  }

  if (
    state.current_period &&
    isTableArea(state.current_period.area_code) &&
    shippingSummary
  ) {
    const tableArea = state.current_period.area_code;
    const tableLabel = OPERATIONAL_AREA_LABELS[tableArea];
    const tableMode = state.current_period.mode_code;
    const activeShippingJob = shippingSummary.current_job;

    if (tableMode !== "cart") {
      return (
        <TerminalFrame title={login.employee_name} subtitle={`${terminal.name} · ${tableLabel}`}>
          <div className="mx-auto max-w-4xl space-y-5">
            {physicalMismatch ? (
              <Notice tone="info">
                Tu jornada continúa en {tableLabel}. Puedes seguirla desde este terminal.
              </Notice>
            ) : null}

            <section className="rounded-3xl bg-white p-7 text-center shadow-sm">
              <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-500">
                {tableLabel}
              </p>
              <h2 className="mt-2 text-4xl font-black text-slate-950">
                {WORK_MODE_LABELS[tableMode]}
              </h2>
              <p className="mt-3 text-xl font-black text-emerald-700">Estado: TRABAJANDO</p>
              <p className="mt-5 text-sm font-black uppercase tracking-wider text-slate-500">
                Tiempo en esta tarea
              </p>
              <p className="mt-2 font-mono text-5xl font-black text-slate-950">{taskElapsed}</p>
              <p className="mt-5 text-sm text-slate-500">
                Este modo no participa en la cola automática de carros.
              </p>
            </section>

            {message ? <Notice tone="error">{message}</Notice> : null}

            <div className="grid gap-4 md:grid-cols-2">
              <button
                className="min-h-28 rounded-2xl bg-amber-500 px-6 text-2xl font-black text-slate-950"
                onClick={() => setScreen("break")}
                type="button"
              >
                PAUSA
              </button>
              <button
                className="min-h-28 rounded-2xl bg-blue-600 px-6 text-2xl font-black text-white"
                onClick={() => setScreen("change")}
                type="button"
              >
                CAMBIAR TAREA
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <button
                className="min-h-16 rounded-xl border border-slate-300 bg-white px-5 font-bold"
                onClick={() => void logout()}
                type="button"
              >
                CAMBIAR OPERARIO
              </button>
              <button
                className="min-h-16 rounded-xl border border-red-300 bg-red-50 px-5 font-bold text-red-800"
                disabled={busy}
                onClick={() => void finishWork()}
                type="button"
              >
                FINALIZAR JORNADA
              </button>
            </div>
          </div>
        </TerminalFrame>
      );
    }

    return (
      <TerminalFrame title={login.employee_name} subtitle={`${terminal.name} · ${tableLabel}`}>
        <div className="mx-auto max-w-4xl space-y-5">
          {physicalMismatch ? (
            <Notice tone="info">
              Tu jornada continúa en {tableLabel}. Puedes seguirla desde este terminal.
            </Notice>
          ) : null}

          <ShippingSummaryPanel
            currentBreak={state.current_break}
            currentPeriod={state.current_period}
            summary={shippingSummary}
          />

          {activeShippingJob ? (
            <>
              <ActiveShippingJobPanel
                currentBreak={state.current_break}
                job={activeShippingJob}
                serverNow={shippingSummary.server_now}
              />
              <ScanField
                label={`ESCANEAR CARRO ${activeShippingJob.cart_code} PARA FINALIZAR EXPEDICIÓN`}
                onEnter={() => void finishShippingJob()}
                onValue={setShippingScan}
                ref={shippingScanRef}
                value={shippingScan}
              />
            </>
          ) : shippingSummary.next_cart ? (
            <>
              <NextShippingCartPanel summary={shippingSummary} />
              <ScanField
                label="ESCANEAR SIGUIENTE CARRO (OPCIONAL)"
                onEnter={() => void claimShippingCart()}
                onValue={setShippingScan}
                ref={shippingScanRef}
                value={shippingScan}
              />
              <button
                className="min-h-24 w-full rounded-2xl bg-emerald-600 px-6 text-3xl font-black text-white disabled:bg-slate-300"
                disabled={busy}
                onClick={() => void claimShippingCart()}
                type="button"
              >
                COGER CARRO {shippingSummary.next_cart.code}
              </button>
            </>
          ) : (
            <section className="rounded-3xl border-2 border-dashed border-slate-300 bg-white p-8 text-center">
              <p className="text-2xl font-black text-slate-800">SIN CARROS PENDIENTES</p>
              <p className="mt-2 text-slate-500">
                La mesa está disponible. Cuando Picking prepare un carro aparecerá aquí automáticamente.
              </p>
            </section>
          )}

          {message ? <Notice tone="error">{message}</Notice> : null}

          {activeShippingJob ? (
            <div className="grid gap-4 md:grid-cols-2">
              <button
                className="min-h-28 rounded-2xl bg-amber-500 px-6 text-2xl font-black text-slate-950"
                onClick={() => setScreen("break")}
                type="button"
              >
                PAUSA
              </button>
              <button
                className="min-h-28 rounded-2xl bg-emerald-600 px-6 text-2xl font-black text-white disabled:bg-slate-300"
                disabled={busy || !scannerValue(shippingScan)}
                onClick={() => void finishShippingJob()}
                type="button"
              >
                FINALIZAR EXPEDICIÓN
              </button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <button
                className="min-h-28 rounded-2xl bg-amber-500 px-6 text-2xl font-black text-slate-950"
                onClick={() => setScreen("break")}
                type="button"
              >
                PAUSA
              </button>
              <button
                className="min-h-28 rounded-2xl bg-blue-600 px-6 text-2xl font-black text-white"
                onClick={() => setScreen("change")}
                type="button"
              >
                CAMBIAR TAREA
              </button>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <button
              className="min-h-16 rounded-xl border border-slate-300 bg-white px-5 font-bold"
              onClick={() => void logout()}
              type="button"
            >
              CAMBIAR OPERARIO
            </button>
            <button
              className="min-h-16 rounded-xl border border-red-300 bg-red-50 px-5 font-bold text-red-800 disabled:opacity-40"
              disabled={busy || Boolean(activeShippingJob)}
              onClick={() => void finishWork()}
              type="button"
            >
              FINALIZAR JORNADA
            </button>
          </div>

          {activeShippingJob ? (
            <p className="text-center text-sm font-bold text-slate-500">
              Finaliza el carro de Expedición activo antes de cambiar de tarea o finalizar la jornada.
            </p>
          ) : null}
        </div>
      </TerminalFrame>
    );
  }

  return (
    <TerminalFrame title={login.employee_name} subtitle={`${terminal.name} · Jornada ${workElapsed}`}>
      <div className="mx-auto max-w-4xl space-y-5">
        {physicalMismatch ? (
          <Notice tone="info">
            Tu jornada continúa en {state.current_period ? OPERATIONAL_AREA_LABELS[state.current_period.area_code] : "otro puesto"}. Puedes cambiar la tarea desde este terminal.
          </Notice>
        ) : null}

        <div className="rounded-3xl bg-slate-900 p-7 text-center text-white shadow-sm">
          <p className="text-sm font-bold uppercase tracking-wider text-slate-300">Tarea actual</p>
          <p className="mt-2 text-4xl font-black">
            {state.current_period ? OPERATIONAL_AREA_LABELS[state.current_period.area_code] : "Sin tarea"}
          </p>
          {state.current_period ? (
            <>
              <p className="mt-2 text-xl font-semibold text-slate-200">{WORK_MODE_LABELS[state.current_period.mode_code]}</p>
              <p className="mt-4 font-mono text-4xl font-black">{taskElapsed}</p>
            </>
          ) : null}
        </div>

        {message ? <Notice tone="error">{message}</Notice> : null}

        <div className="grid gap-4 md:grid-cols-2">
          <button className="min-h-28 rounded-2xl bg-blue-600 px-6 text-2xl font-black text-white" onClick={() => setScreen("change")} type="button">
            CAMBIAR TAREA
          </button>
          <button className="min-h-28 rounded-2xl bg-amber-500 px-6 text-2xl font-black text-slate-950" onClick={() => setScreen("break")} type="button">
            PAUSA
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <button className="min-h-16 rounded-xl border border-slate-300 bg-white px-5 font-bold" onClick={() => void logout()} type="button">
            CAMBIAR OPERARIO
          </button>
          <button className="min-h-16 rounded-xl border border-red-300 bg-red-50 px-5 font-bold text-red-800" disabled={busy} onClick={() => void finishWork()} type="button">
            FINALIZAR JORNADA
          </button>
        </div>
      </div>
    </TerminalFrame>
  );
}

export default function TerminalPage() {
  return (
    <Suspense fallback={<TerminalFrame title="Terminal">Cargando...</TerminalFrame>}>
      <TerminalContent />
    </Suspense>
  );
}

function TerminalFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 rounded-3xl bg-slate-950 p-5 text-white md:p-7">
          <p className="text-sm font-bold uppercase tracking-wider text-slate-400">Puestos Almacén · Terminal</p>
          <h1 className="mt-1 text-3xl font-black md:text-4xl">{title}</h1>
          {subtitle ? <p className="mt-2 text-lg text-slate-300">{subtitle}</p> : null}
        </header>
        {children}
      </div>
    </main>
  );
}

type ScanFieldProps = {
  label: string;
  value: string;
  password?: boolean;
  onValue: (value: string) => void;
  onEnter: () => void;
};

const ScanFieldBase = function ScanFieldBase(
  { label, value, password, onValue, onEnter }: ScanFieldProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  return (
    <label className="block rounded-2xl bg-white p-5 shadow-sm">
      <span className="mb-3 block text-lg font-black text-slate-800">{label}</span>
      <input
        autoComplete="off"
        className="h-16 w-full rounded-xl border-2 border-slate-300 px-4 text-2xl font-bold outline-none focus:border-blue-600"
        onChange={(event) => onValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onEnter();
          }
        }}
        ref={ref}
        type={password ? "password" : "text"}
        value={value}
      />
    </label>
  );
};

const ScanField = forwardRef(ScanFieldBase);
ScanField.displayName = "ScanField";

function EntrySummaryPanel({
  summary,
  currentPeriod,
  currentBreak,
}: {
  summary: EntrySummary;
  currentPeriod: WorkPeriod | null;
  currentBreak: WorkBreak | null;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const deltaSeconds = Math.max(
    0,
    Math.floor((now - new Date(summary.server_now).getTime()) / 1000),
  );
  const onBreak = Boolean(currentBreak);
  const inEntries = currentPeriod?.area_code === "entradas";

  const elapsedSeconds = summary.elapsed_seconds + deltaSeconds;
  const breakSeconds = summary.break_seconds + (onBreak ? deltaSeconds : 0);
  const effectiveSeconds = summary.effective_seconds + (onBreak ? 0 : deltaSeconds);
  const entriesEffectiveSeconds =
    summary.entradas_effective_seconds + (inEntries && !onBreak ? deltaSeconds : 0);

  const cards = [
    { label: "Hora inicio", value: formatStartTime(summary.started_at) },
    { label: "Tiempo trabajando", value: formatElapsed(elapsedSeconds) },
    { label: "Tiempo pausas", value: formatElapsed(breakSeconds) },
    { label: "Pausas hoy", value: String(summary.break_count) },
    { label: "Tiempo efectivo", value: formatElapsed(effectiveSeconds) },
  ];

  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm md:p-8">
      <div className="text-center">
        <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-500">Puesto actual</p>
        <h2 className="mt-2 text-5xl font-black text-slate-950">ENTRADAS</h2>
        <p className={`mt-3 text-xl font-black ${onBreak ? "text-amber-700" : "text-emerald-700"}`}>
          Estado: {onBreak ? "EN PAUSA" : "TRABAJANDO"}
        </p>
      </div>

      <div className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-5">
        {cards.map((card) => (
          <div className="rounded-2xl bg-slate-100 p-4 text-center" key={card.label}>
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className="mt-2 font-mono text-xl font-black text-slate-950">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-2xl bg-emerald-100 p-5 text-center">
        <p className="text-sm font-black uppercase tracking-wider text-emerald-800">
          Tiempo efectivo trabajado en Entradas
        </p>
        <p className="mt-2 font-mono text-4xl font-black text-emerald-950">
          {formatElapsed(entriesEffectiveSeconds)}
        </p>
      </div>
    </section>
  );
}

function PickingSummaryPanel({
  summary,
  currentPeriod,
  currentBreak,
}: {
  summary: PickingSummary;
  currentPeriod: WorkPeriod | null;
  currentBreak: WorkBreak | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [showRecentJobs, setShowRecentJobs] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const deltaSeconds = Math.max(
    0,
    Math.floor((now - new Date(summary.server_now).getTime()) / 1000),
  );
  const onBreak = Boolean(currentBreak);
  const activeJob = Boolean(summary.active_job);
  const inPicking = currentPeriod?.area_code === "picking";

  const pickingEffectiveSeconds =
    summary.picking_effective_seconds +
    (inPicking && activeJob && !onBreak ? deltaSeconds : 0);
  const breakSeconds = summary.break_seconds + (onBreak ? deltaSeconds : 0);

  const cards = [
    { label: "Carros terminados", value: String(summary.completed_carts) },
    { label: "Preparados expedición", value: String(summary.ready_for_shipping_carts) },
    { label: "Sin carro", value: String(summary.completed_no_cart) },
    { label: "Total trabajos", value: String(summary.total_completed) },
    { label: "Pausas hoy", value: String(summary.break_count) },
    { label: "Media / carro", value: formatElapsed(summary.avg_cart_effective_seconds) },
    { label: "Tiempo efectivo Picking", value: formatElapsed(pickingEffectiveSeconds) },
    { label: "Tiempo pausas", value: formatElapsed(breakSeconds) },
  ];

  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm md:p-8">
      <div className="text-center">
        <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-500">Puesto actual</p>
        <h2 className="mt-2 text-5xl font-black text-slate-950">PICKING</h2>
        <p
          className={`mt-3 text-xl font-black ${
            onBreak
              ? "text-amber-700"
              : activeJob
                ? "text-emerald-700"
                : "text-blue-700"
          }`}
        >
          Estado: {onBreak ? "EN PAUSA" : activeJob ? "TRABAJANDO" : "DISPONIBLE"}
        </p>
      </div>

      <div className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((card) => (
          <div className="rounded-2xl bg-slate-100 p-4 text-center" key={card.label}>
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className="mt-2 font-mono text-xl font-black text-slate-950">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-5">
        <button
          className="flex min-h-14 w-full items-center justify-between rounded-2xl border-2 border-slate-200 bg-slate-50 px-5 text-left font-black text-slate-700"
          onClick={() => setShowRecentJobs((value) => !value)}
          type="button"
        >
          <span>ÚLTIMOS TRABAJOS ({summary.recent_jobs.length})</span>
          <span className="text-xl">{showRecentJobs ? "▲" : "▼"}</span>
        </button>

        {showRecentJobs ? (
          summary.recent_jobs.length ? (
            <div className="mt-2 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
              {summary.recent_jobs.map((job) => (
                <div className="flex items-center justify-between gap-4 px-4 py-3" key={job.id}>
                  <span className="font-bold text-slate-800">
                    {job.job_type === "cart" ? `Carro ${job.identifier}` : "Trabajo sin carro"}
                  </span>
                  <span className="font-mono font-black text-slate-600">
                    {formatElapsed(job.effective_seconds)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 rounded-2xl bg-slate-100 p-4 text-center font-semibold text-slate-500">
              Todavía no hay trabajos finalizados hoy.
            </p>
          )
        ) : null}
      </div>
    </section>
  );
}

function ActivePickingJobPanel({
  job,
  serverNow,
  currentBreak,
}: {
  job: PickingJobSummaryItem;
  serverNow: string;
  currentBreak: WorkBreak | null;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const deltaSeconds = Math.max(
    0,
    Math.floor((now - new Date(serverNow).getTime()) / 1000),
  );
  const effectiveSeconds = job.effective_seconds + (currentBreak ? 0 : deltaSeconds);

  return (
    <section className="rounded-3xl bg-slate-950 p-7 text-center text-white shadow-sm">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-400">
        {job.job_type === "cart" ? "CARRO ACTUAL" : "TRABAJO SIN CARRO"}
      </p>
      <p className="mt-3 text-5xl font-black">
        {job.job_type === "cart" ? job.identifier : "EN CURSO"}
      </p>
      <p className="mt-5 text-sm font-black uppercase tracking-wider text-slate-400">Tiempo efectivo actual</p>
      <p className="mt-2 font-mono text-5xl font-black">{formatElapsed(effectiveSeconds)}</p>
    </section>
  );
}


function priorityLabel(priority: ShippingCartCandidate["priority_code"]) {
  if (priority === "high") return "ALTA";
  if (priority === "low") return "BAJA";
  return "NORMAL";
}

function ShippingSummaryPanel({
  summary,
  currentPeriod,
  currentBreak,
}: {
  summary: ShippingSummary;
  currentPeriod: WorkPeriod | null;
  currentBreak: WorkBreak | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [showRecentJobs, setShowRecentJobs] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const deltaSeconds = Math.max(
    0,
    Math.floor((now - new Date(summary.server_now).getTime()) / 1000),
  );
  const onBreak = Boolean(currentBreak);
  const activeJob = Boolean(summary.current_job);
  const inCartMode =
    Boolean(currentPeriod) &&
    isTableArea(currentPeriod!.area_code) &&
    currentPeriod!.mode_code === "cart";

  const effectiveSeconds =
    summary.shipping_effective_seconds +
    (inCartMode && activeJob && !onBreak ? deltaSeconds : 0);
  const breakSeconds = summary.break_seconds + (onBreak ? deltaSeconds : 0);

  const cards = [
    { label: "Carros terminados", value: String(summary.completed_carts) },
    { label: "Pendientes", value: String(summary.waiting_total) },
    { label: "Media / carro", value: formatElapsed(summary.avg_cart_effective_seconds) },
    { label: "Tiempo efectivo", value: formatElapsed(effectiveSeconds) },
    { label: "Pausas hoy", value: String(summary.break_count) },
    { label: "Tiempo pausas", value: formatElapsed(breakSeconds) },
  ];

  const areaLabel = currentPeriod
    ? OPERATIONAL_AREA_LABELS[currentPeriod.area_code]
    : "Expedición";

  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm md:p-8">
      <div className="text-center">
        <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-500">
          Expedición
        </p>
        <h2 className="mt-2 text-5xl font-black text-slate-950">{areaLabel.toUpperCase()}</h2>
        <p
          className={`mt-3 text-xl font-black ${
            onBreak
              ? "text-amber-700"
              : activeJob
                ? "text-emerald-700"
                : "text-blue-700"
          }`}
        >
          Estado: {onBreak ? "EN PAUSA" : activeJob ? "TRABAJANDO" : "DISPONIBLE"}
        </p>
      </div>

      <div className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-3">
        {cards.map((card) => (
          <div className="rounded-2xl bg-slate-100 p-4 text-center" key={card.label}>
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className="mt-2 font-mono text-xl font-black text-slate-950">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-5">
        <button
          className="flex min-h-14 w-full items-center justify-between rounded-2xl border-2 border-slate-200 bg-slate-50 px-5 text-left font-black text-slate-700"
          onClick={() => setShowRecentJobs((value) => !value)}
          type="button"
        >
          <span>ÚLTIMOS CARROS ({summary.recent_jobs.length})</span>
          <span className="text-xl">{showRecentJobs ? "▲" : "▼"}</span>
        </button>

        {showRecentJobs ? (
          summary.recent_jobs.length ? (
            <div className="mt-2 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
              {summary.recent_jobs.map((job) => (
                <div className="flex items-center justify-between gap-4 px-4 py-3" key={job.id}>
                  <span className="font-bold text-slate-800">Carro {job.cart_code}</span>
                  <span className="font-mono font-black text-slate-600">
                    {formatElapsed(job.effective_seconds)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 rounded-2xl bg-slate-100 p-4 text-center font-semibold text-slate-500">
              Todavía no hay carros finalizados hoy por este operario.
            </p>
          )
        ) : null}
      </div>
    </section>
  );
}

function ActiveShippingJobPanel({
  job,
  serverNow,
  currentBreak,
}: {
  job: ShippingJobSummaryItem;
  serverNow: string;
  currentBreak: WorkBreak | null;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const deltaSeconds = Math.max(
    0,
    Math.floor((now - new Date(serverNow).getTime()) / 1000),
  );
  const effectiveSeconds = job.effective_seconds + (currentBreak ? 0 : deltaSeconds);

  return (
    <section className="rounded-3xl bg-slate-950 p-7 text-center text-white shadow-sm">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-400">
        CARRO ACTUAL
      </p>
      <p className="mt-3 text-6xl font-black">{job.cart_code}</p>
      <p className="mt-5 text-sm font-black uppercase tracking-wider text-slate-400">
        Tiempo efectivo actual
      </p>
      <p className="mt-2 font-mono text-5xl font-black">{formatElapsed(effectiveSeconds)}</p>
    </section>
  );
}

function NextShippingCartPanel({ summary }: { summary: ShippingSummary }) {
  const next = summary.next_cart;
  if (!next) return null;

  const waitingAfterNext = summary.waiting_carts
    .filter((cart) => cart.id !== next.id)
    .slice(0, 5);

  return (
    <section className="rounded-3xl border-2 border-emerald-300 bg-emerald-50 p-7 text-center shadow-sm">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-emerald-800">
        SIGUIENTE CARRO
      </p>
      <p className="mt-2 text-7xl font-black text-emerald-950">{next.code}</p>

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {next.is_cubetas ? (
          <span className="rounded-full bg-violet-200 px-3 py-1 text-sm font-black text-violet-900">
            CUBETAS · PRIMERO
          </span>
        ) : null}
        <span className="rounded-full bg-white px-3 py-1 text-sm font-black text-slate-700">
          PRIORIDAD {priorityLabel(next.priority_code)}
        </span>
        {next.shipment_type ? (
          <span className="rounded-full bg-white px-3 py-1 text-sm font-bold text-slate-700">
            {next.shipment_type}
          </span>
        ) : null}
      </div>

      <div className="mt-6 rounded-2xl bg-white/80 p-4">
        <p className="text-xs font-black uppercase tracking-wider text-slate-500">EN ESPERA</p>
        <p className="mt-2 text-lg font-bold text-slate-700">
          {waitingAfterNext.length
            ? waitingAfterNext.map((cart) => cart.code).join(" · ")
            : "Ningún otro carro"}
        </p>
      </div>
    </section>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "error" | "success" | "info";
  children: ReactNode;
}) {
  const classes =
    tone === "error"
      ? "border-red-300 bg-red-50 text-red-800"
      : tone === "success"
        ? "border-emerald-300 bg-emerald-50 text-emerald-800"
        : "border-blue-300 bg-blue-50 text-blue-800";

  return <div className={`rounded-2xl border-2 p-5 text-center text-lg font-black ${classes}`}>{children}</div>;
}
