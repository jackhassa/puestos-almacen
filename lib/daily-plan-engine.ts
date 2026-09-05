import { resolveOperatorAssignments } from "./assignment-engine";
import { getAfternoonManagerForDate } from "./manager-engine";
import { getMorningManagerSubstitute } from "./morning-manager-engine";
import { resolveNightAssignments } from "./night-assignment-engine";
import {
  assignmentCodeToOperationalArea,
  ASSIGNMENT_LABELS,
  OPERATIONAL_AREA_LABELS,
  type AssignmentCode,
  type OperationalAreaCode,
  type PlannedAssignmentCode,
} from "./operational-types";
import {
  getNightPositionForWorkday,
  getPositionForWorkday,
  type Position,
} from "./position-engine";
import {
  getShiftForDate,
  type RotationGroup,
  type WorkShift,
} from "./shift-engine";
import { countWorkingDays } from "./workday-engine";

export type OperationalShift = "morning" | "afternoon" | "night";

export type PlanningEmployee = {
  id: string;
  name: string;
  shift_mode: "rotating" | "morning_fixed" | "night_fixed";
  rotation_group: "A" | "B" | null;
  manager_type: "none" | "afternoon_pool" | "morning_fixed";
  rotation_reference_date: string | null;
  rotation_reference_position: Position | null;
  active: boolean;
};

export type PlanningAbsence = {
  employee_id: string;
  start_date: string;
  end_date: string;
};

export type PlanningManagerSetting = {
  rotation_group: "A" | "B";
  starter_manager_id: string | null;
};

export type PlanningShiftChange = {
  employee_id: string;
  reinforcement_date: string;
  target_shift: OperationalShift;
};

export type PlanningDailyOverride = {
  employee_id: string;
  assignment_date: string;
  assignment_code: AssignmentCode;
};

export type DailyPlanningInput = {
  targetDate: string;
  employees: PlanningEmployee[];
  groupAJanuaryShift: WorkShift;
  holidays: string[];
  absencePeriods: PlanningAbsence[];
  managerSettings: PlanningManagerSetting[];
  shiftChanges: PlanningShiftChange[];
  dailyOverrides: PlanningDailyOverride[];
};

export type EmployeeDailyAssignment = {
  employeeId: string;
  employeeName: string;
  operationalDate: string;
  scheduledShift: OperationalShift | null;
  actualShift: OperationalShift | null;
  absent: boolean;
  assignmentCode: PlannedAssignmentCode | null;
  assignmentLabel: string;
  areaCode: OperationalAreaCode | null;
  canStart: boolean;
  reason: string | null;
};

function parseLocalDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function isWeekend(value: string) {
  const day = parseLocalDate(value).getDay();
  return day === 0 || day === 6;
}

function assignmentLabel(code: PlannedAssignmentCode | null) {
  if (code === "gestor") return OPERATIONAL_AREA_LABELS.gestor;
  if (!code) return "Sin asignar";
  return ASSIGNMENT_LABELS[code];
}

export function buildDailyPlanning(
  input: DailyPlanningInput,
): EmployeeDailyAssignment[] {
  const {
    targetDate,
    employees,
    groupAJanuaryShift,
    holidays,
    absencePeriods,
    managerSettings,
    shiftChanges,
    dailyOverrides,
  } = input;

  const absentIds = new Set(
    absencePeriods
      .filter(
        (period) =>
          period.start_date <= targetDate && period.end_date >= targetDate,
      )
      .map((period) => period.employee_id),
  );

  const getScheduledShift = (
    employee: PlanningEmployee,
  ): OperationalShift | null => {
    if (employee.shift_mode === "morning_fixed") return "morning";
    if (employee.shift_mode === "night_fixed") return "night";

    if (employee.shift_mode === "rotating" && employee.rotation_group) {
      return getShiftForDate(
        parseLocalDate(targetDate),
        employee.rotation_group,
        groupAJanuaryShift,
      );
    }

    return null;
  };

  const getShiftChange = (employeeId: string) =>
    shiftChanges.find((change) => change.employee_id === employeeId);

  const getDailyOverride = (employeeId: string) =>
    dailyOverrides.find((override) => override.employee_id === employeeId);

  const getActualShift = (
    employee: PlanningEmployee,
  ): OperationalShift | null => {
    const scheduled = getScheduledShift(employee);
    const change = getShiftChange(employee.id);

    if (change && change.target_shift !== scheduled) {
      return change.target_shift;
    }

    return scheduled;
  };

  const hasRealShiftChange = (employee: PlanningEmployee) => {
    const change = getShiftChange(employee.id);
    return Boolean(change && change.target_shift !== getScheduledShift(employee));
  };

  const getTheoreticalPosition = (
    employee: PlanningEmployee,
  ): Position | null => {
    if (employee.shift_mode === "morning_fixed") return null;
    if (!employee.rotation_reference_date || !employee.rotation_reference_position) {
      return null;
    }

    const workdays = countWorkingDays(
      employee.rotation_reference_date,
      targetDate,
      holidays,
    );

    if (employee.shift_mode === "night_fixed") {
      return getNightPositionForWorkday(
        employee.rotation_reference_position,
        workdays,
      );
    }

    return getPositionForWorkday(employee.rotation_reference_position, workdays);
  };

  const afternoonGroup = (() => {
    const groupAShift = getShiftForDate(
      parseLocalDate(targetDate),
      "A",
      groupAJanuaryShift,
    );

    return (groupAShift === "afternoon" ? "A" : "B") as RotationGroup;
  })();

  const afternoonManagerId = (() => {
    const managers = employees.filter(
      (employee) =>
        employee.manager_type === "afternoon_pool" &&
        employee.rotation_group === afternoonGroup,
    );

    const setting = managerSettings.find(
      (item) => item.rotation_group === afternoonGroup,
    );

    const effectiveAbsences: PlanningAbsence[] = [...absencePeriods];

    for (const manager of managers) {
      if (getActualShift(manager) !== "afternoon") {
        effectiveAbsences.push({
          employee_id: manager.id,
          start_date: targetDate,
          end_date: targetDate,
        });
      }
    }

    const result = getAfternoonManagerForDate({
      targetDate,
      group: afternoonGroup,
      managers: managers.map((manager) => ({ id: manager.id, name: manager.name })),
      starterManagerId: setting?.starter_manager_id ?? null,
      groupAJanuaryShift,
      holidays,
      absencePeriods: effectiveAbsences,
    });

    return result.manager?.id ?? null;
  })();

  const fixedMorningManager = employees.find(
    (employee) => employee.manager_type === "morning_fixed",
  );

  const morningManagerId = (() => {
    if (!fixedMorningManager) return null;

    const fixedUnavailable =
      absentIds.has(fixedMorningManager.id) ||
      getActualShift(fixedMorningManager) !== "morning";

    if (!fixedUnavailable) return fixedMorningManager.id;

    const candidates = employees
      .filter(
        (employee) =>
          employee.manager_type === "afternoon_pool" &&
          employee.rotation_group !== null &&
          getActualShift(employee) === "morning",
      )
      .map((employee) => ({
        id: employee.id,
        name: employee.name,
        rotationGroup: employee.rotation_group as RotationGroup,
      }));

    const starterSettings: { A?: string | null; B?: string | null } = {};
    for (const setting of managerSettings) {
      starterSettings[setting.rotation_group] = setting.starter_manager_id;
    }

    const effectiveAbsences: PlanningAbsence[] = [...absencePeriods];
    if (!absentIds.has(fixedMorningManager.id)) {
      effectiveAbsences.push({
        employee_id: fixedMorningManager.id,
        start_date: targetDate,
        end_date: targetDate,
      });
    }

    const result = getMorningManagerSubstitute({
      targetDate,
      fixedManagerId: fixedMorningManager.id,
      candidates,
      groupAJanuaryShift,
      holidays,
      absencePeriods: effectiveAbsences,
      starterSettings,
    });

    return result.manager?.id ?? null;
  })();

  const assigned = new Map<string, PlannedAssignmentCode>();

  const buildNormalShift = (shift: "morning" | "afternoon") => {
    const people = employees.filter((employee) => getActualShift(employee) === shift);

    let operators = people.filter(
      (employee) => employee.manager_type !== "morning_fixed",
    );

    if (
      shift === "morning" &&
      morningManagerId &&
      morningManagerId !== fixedMorningManager?.id
    ) {
      operators = operators.filter((employee) => employee.id !== morningManagerId);
    }

    if (shift === "afternoon" && afternoonManagerId) {
      operators = operators.filter((employee) => employee.id !== afternoonManagerId);
    }

    const available = operators.filter((employee) => !absentIds.has(employee.id));
    const regular = available.filter((employee) => !hasRealShiftChange(employee));
    const changed = available.filter((employee) => hasRealShiftChange(employee));

    const regularSource = regular
      .map((employee) => {
        const theoreticalPosition = getTheoreticalPosition(employee);
        if (!theoreticalPosition) return null;
        return {
          employeeId: employee.id,
          employeeName: employee.name,
          theoreticalPosition,
        };
      })
      .filter(
        (
          item,
        ): item is {
          employeeId: string;
          employeeName: string;
          theoreticalPosition: Position;
        } => item !== null,
      );

    const resolved = resolveOperatorAssignments(regularSource);
    const existingExtras = resolved.filter(
      (assignment) =>
        assignment.assignmentType === "reinforcement_entradas" ||
        assignment.assignmentType === "reinforcement_picking" ||
        assignment.assignmentType === "pending_task",
    ).length;

    for (const employee of regular) {
      const override = getDailyOverride(employee.id);
      if (override) {
        assigned.set(employee.id, override.assignment_code);
        continue;
      }

      const item = resolved.find((entry) => entry.employeeId === employee.id);
      if (!item) {
        assigned.set(employee.id, "pending_task");
      } else if (item.assignmentType === "reinforcement_entradas") {
        assigned.set(employee.id, "reinforcement_entradas");
      } else if (item.assignmentType === "reinforcement_picking") {
        assigned.set(employee.id, "reinforcement_picking");
      } else if (item.assignmentType === "pending_task") {
        assigned.set(employee.id, "pending_task");
      } else if (item.finalPosition) {
        assigned.set(employee.id, item.finalPosition);
      } else {
        assigned.set(employee.id, "pending_task");
      }
    }

    changed.forEach((employee, index) => {
      const override = getDailyOverride(employee.id);
      if (override) {
        assigned.set(employee.id, override.assignment_code);
        return;
      }

      const extraIndex = existingExtras + index;
      if (extraIndex === 0) assigned.set(employee.id, "reinforcement_entradas");
      else if (extraIndex === 1) assigned.set(employee.id, "reinforcement_picking");
      else assigned.set(employee.id, "pending_task");
    });
  };

  const buildNightShift = () => {
    const people = employees
      .filter((employee) => getActualShift(employee) === "night")
      .filter((employee) => !absentIds.has(employee.id));

    const regular = people.filter((employee) => !hasRealShiftChange(employee));
    const changed = people.filter((employee) => hasRealShiftChange(employee));

    const source = regular
      .map((employee) => {
        const theoreticalPosition = getTheoreticalPosition(employee);
        if (!theoreticalPosition) return null;
        return {
          employeeId: employee.id,
          employeeName: employee.name,
          theoreticalPosition,
        };
      })
      .filter(
        (
          item,
        ): item is {
          employeeId: string;
          employeeName: string;
          theoreticalPosition: Position;
        } => item !== null,
      );

    const resolved = resolveNightAssignments(source);

    for (const employee of regular) {
      const override = getDailyOverride(employee.id);
      if (override) {
        assigned.set(employee.id, override.assignment_code);
        continue;
      }

      const item = resolved.find((entry) => entry.employeeId === employee.id);
      assigned.set(employee.id, item?.finalPosition ?? "pending_task");
    }

    for (const employee of changed) {
      const override = getDailyOverride(employee.id);
      assigned.set(employee.id, override?.assignment_code ?? "pending_task");
    }
  };

  buildNormalShift("morning");
  buildNormalShift("afternoon");
  buildNightShift();

  if (morningManagerId) assigned.set(morningManagerId, "gestor");
  if (afternoonManagerId) assigned.set(afternoonManagerId, "gestor");

  const nonWorking = isWeekend(targetDate) || holidays.includes(targetDate);

  return employees.map((employee) => {
    const scheduledShift = getScheduledShift(employee);
    const actualShift = getActualShift(employee);
    const absent = absentIds.has(employee.id);
    const code = assigned.get(employee.id) ?? null;
    const areaCode =
      code === "gestor"
        ? "gestor"
        : code
          ? assignmentCodeToOperationalArea(code)
          : null;

    let reason: string | null = null;
    if (nonWorking) reason = "Hoy está configurado como día no laborable.";
    else if (absent) reason = "Constas como ausente en la planificación de hoy.";
    else if (!actualShift) reason = "No tienes un turno operativo asignado para hoy.";
    else if (!code || code === "pending_task") {
      reason = "El responsable debe asignarte un puesto concreto antes de iniciar.";
    } else if (!areaCode) {
      reason = "La asignación actual no corresponde a un puesto operativo concreto.";
    }

    return {
      employeeId: employee.id,
      employeeName: employee.name,
      operationalDate: targetDate,
      scheduledShift,
      actualShift,
      absent,
      assignmentCode: code,
      assignmentLabel: assignmentLabel(code),
      areaCode,
      canStart: reason === null,
      reason,
    };
  });
}
