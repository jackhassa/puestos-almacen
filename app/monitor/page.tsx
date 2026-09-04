"use client";

import {
  useEffect,
  useState,
} from "react";

import { supabase } from "@/lib/supabase";
import {
  ASSIGNMENT_LABELS,
  type AssignmentCode,
} from "@/lib/operational-types";

import {
  getShiftForDate,
  type RotationGroup,
  type WorkShift,
} from "@/lib/shift-engine";

import {
  getPositionForWorkday,
  getNightPositionForWorkday,
  POSITION_LABELS,
  type Position,
} from "@/lib/position-engine";

import {
  countWorkingDays,
} from "@/lib/workday-engine";

import {
  resolveOperatorAssignments,
} from "@/lib/assignment-engine";

import {
  resolveNightAssignments,
} from "@/lib/night-assignment-engine";

import {
  getAfternoonManagerForDate,
} from "@/lib/manager-engine";

import {
  getMorningManagerSubstitute,
} from "@/lib/morning-manager-engine";

type Shift =
  | "morning"
  | "afternoon"
  | "night";

type Employee = {
  id: string;
  name: string;

  shift_mode:
    | "rotating"
    | "morning_fixed"
    | "night_fixed";

  rotation_group:
    | "A"
    | "B"
    | null;

  manager_type:
    | "none"
    | "afternoon_pool"
    | "morning_fixed";

  rotation_reference_date:
    | string
    | null;

  rotation_reference_position:
    | Position
    | null;

  photo_url:
    | string
    | null;

  active: boolean;
};

type AbsencePeriod = {
  employee_id: string;
  start_date: string;
  end_date: string;
};

type ManagerSetting = {
  rotation_group:
    | "A"
    | "B";

  starter_manager_id:
    | string
    | null;
};

type ShiftChange = {
  employee_id: string;
  reinforcement_date: string;
  target_shift: Shift;
};

type DailyOverride = {
  employee_id: string;
  assignment_date: string;
  assignment_code: AssignmentCode;
};

type PlannedEmployee =
  Employee & {
    theoreticalPosition:
      | Position
      | null;

    finalText: string;

    changed: boolean;

    isShiftChange: boolean;

    isManualOverride: boolean;

    scheduledShift:
      | Shift
      | null;
  };

type ManagerView = {
  name: string;

  photo:
    | string
    | null;

  absent?: boolean;

  substituted?: boolean;

  plannedName?:
    | string
    | null;

  replacementReason?:
    | string
    | null;
};

type ShiftPlan = {
  employees:
    PlannedEmployee[];

  uncoveredPositions:
    Position[];
};

const DAY_REQUIRED_POSITIONS:
  Position[] = [
    "entradas",
    "picking",
    "mesa4",
    "mesa3",
    "mesa2",
    "mesa1",
  ];

const NIGHT_REQUIRED_POSITIONS:
  Position[] = [
    "picking",
    "mesa4",
    "mesa3",
  ];

const DISPLAY_ORDER:
  Record<string, number> = {
    Entradas: 10,
    Picking: 20,
    Montajes: 25,
    "Mesa 4": 30,
    "Mesa 3": 40,
    "Mesa 2": 50,
    "Mesa 1": 60,

    "Refuerzo Entradas": 70,
    "Refuerzo Picking": 80,
    "Refuerzo noche": 90,

    "Asignar tarea responsable": 100,
    "Sin asignar": 110,
  };

function formatDateForInput(
  date: Date
) {
  const year =
    date.getFullYear();

  const month =
    String(
      date.getMonth() + 1
    ).padStart(
      2,
      "0"
    );

  const day =
    String(
      date.getDate()
    ).padStart(
      2,
      "0"
    );

  return `${year}-${month}-${day}`;
}

function parseDate(
  value: string
) {
  const [
    year,
    month,
    day,
  ] = value
    .split("-")
    .map(Number);

  return new Date(
    year,
    month - 1,
    day,
    12,
    0,
    0
  );
}

function formatLongDate(
  date: Date
) {
  return new Intl.DateTimeFormat(
    "es-ES",
    {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }
  ).format(date);
}

function formatClock(
  date: Date
) {
  return new Intl.DateTimeFormat(
    "es-ES",
    {
      hour: "2-digit",
      minute: "2-digit",
    }
  ).format(date);
}

function shiftLabel(
  shift:
    | Shift
    | null
) {
  if (
    shift === "morning"
  ) {
    return "Mañana";
  }

  if (
    shift === "afternoon"
  ) {
    return "Tarde";
  }

  if (
    shift === "night"
  ) {
    return "Noche";
  }

  return "—";
}

function sortEmployees(
  people:
    PlannedEmployee[]
) {
  return [...people].sort(
    (a, b) => {
      const orderA =
        DISPLAY_ORDER[
          a.finalText
        ] ?? 999;

      const orderB =
        DISPLAY_ORDER[
          b.finalText
        ] ?? 999;

      if (
        orderA !==
        orderB
      ) {
        return (
          orderA -
          orderB
        );
      }

      return a.name.localeCompare(
        b.name,
        "es"
      );
    }
  );
}

export default function MonitorPage() {
  const [
    now,
    setNow,
  ] =
    useState(
      new Date()
    );

  const [
    selectedDate,
    setSelectedDate,
  ] =
    useState(
      formatDateForInput(
        new Date()
      )
    );

  const [
    employees,
    setEmployees,
  ] =
    useState<Employee[]>([]);

  const [
    absencePeriods,
    setAbsencePeriods,
  ] =
    useState<
      AbsencePeriod[]
    >([]);

  const [
    holidays,
    setHolidays,
  ] =
    useState<string[]>([]);

  const [
    managerSettings,
    setManagerSettings,
  ] =
    useState<
      ManagerSetting[]
    >([]);

  const [
    shiftChanges,
    setShiftChanges,
  ] =
    useState<
      ShiftChange[]
    >([]);

  const [
    dailyOverrides,
    setDailyOverrides,
  ] =
    useState<
      DailyOverride[]
    >([]);

  const [
    groupAJanuaryShift,
    setGroupAJanuaryShift,
  ] =
    useState<
      WorkShift | null
    >(null);

  const [
    loading,
    setLoading,
  ] =
    useState(true);

  const [
    message,
    setMessage,
  ] =
    useState("");

  const [
    lastUpdate,
    setLastUpdate,
  ] =
    useState<Date | null>(
      null
    );

  /*
   * RELOJ
   *
   * También cambia automáticamente
   * de fecha al llegar medianoche.
   */
  useEffect(() => {
    const timer =
      window.setInterval(
        () => {
          const current =
            new Date();

          setNow(
            current
          );

          const today =
            formatDateForInput(
              current
            );

          setSelectedDate(
            (
              previous
            ) =>
              previous ===
              today
                ? previous
                : today
          );
        },
        1000
      );

    return () =>
      window.clearInterval(
        timer
      );
  }, []);

  /*
   * CARGA DE DATOS
   */
  async function loadData() {
    const year =
      parseDate(
        selectedDate
      ).getFullYear();

    const [
      employeesResult,
      yearResult,
      holidaysResult,
      absencesResult,
      managersResult,
      changesResult,
      overridesResult,
    ] =
      await Promise.all([
        supabase
          .from(
            "employees"
          )
          .select("*")
          .eq(
            "active",
            true
          )
          .order(
            "name"
          ),

        supabase
          .from(
            "year_shift_settings"
          )
          .select(
            "group_a_january_shift"
          )
          .eq(
            "year",
            year
          )
          .maybeSingle(),

        supabase
          .from(
            "non_working_days"
          )
          .select(
            "date"
          ),

        supabase
          .from(
            "absence_periods"
          )
          .select(
            "employee_id, start_date, end_date"
          ),

        supabase
          .from(
            "afternoon_manager_settings"
          )
          .select(
            "rotation_group, starter_manager_id"
          ),

        supabase
          .from(
            "shift_reinforcements"
          )
          .select(
            "employee_id, reinforcement_date, target_shift"
          )
          .eq(
            "reinforcement_date",
            selectedDate
          ),

        supabase
          .from(
            "daily_assignment_overrides"
          )
          .select(
            "employee_id, assignment_date, assignment_code"
          )
          .eq(
            "assignment_date",
            selectedDate
          ),
      ]);

    if (
      employeesResult.error
    ) {
      setMessage(
        "No se ha podido cargar el personal."
      );

      setLoading(false);
      return;
    }

    if (
      yearResult.error ||
      !yearResult.data
    ) {
      setMessage(
        `No existe configuración de turnos para ${year}.`
      );

      setLoading(false);
      return;
    }

    if (
      holidaysResult.error ||
      absencesResult.error ||
      managersResult.error ||
      changesResult.error ||
      overridesResult.error
    ) {
      setMessage(
        "No se ha podido actualizar la planificación."
      );

      setLoading(false);
      return;
    }

    setEmployees(
      (
        employeesResult.data ??
        []
      ) as Employee[]
    );

    setGroupAJanuaryShift(
      yearResult.data
        .group_a_january_shift as WorkShift
    );

    setHolidays(
      (
        holidaysResult.data ??
        []
      ).map(
        (item) =>
          item.date
      )
    );

    setAbsencePeriods(
      (
        absencesResult.data ??
        []
      ) as AbsencePeriod[]
    );

    setManagerSettings(
      (
        managersResult.data ??
        []
      ) as ManagerSetting[]
    );

    setShiftChanges(
      (
        changesResult.data ??
        []
      ) as ShiftChange[]
    );

    setDailyOverrides(
      (
        overridesResult.data ??
        []
      ) as DailyOverride[]
    );

    setMessage("");

    setLastUpdate(
      new Date()
    );

    setLoading(false);
  }

  /*
   * ACTUALIZACIÓN AUTOMÁTICA
   * CADA 60 SEGUNDOS
   */
  useEffect(() => {
    setLoading(true);

    loadData();

    const timer =
      window.setInterval(
        () => {
          loadData();
        },
        60000
      );

    return () =>
      window.clearInterval(
        timer
      );
  }, [selectedDate]);

  /*
   * AUSENCIAS
   */
  const absentIdsToday =
    Array.from(
      new Set(
        absencePeriods
          .filter(
            (period) =>
              period.start_date <=
                selectedDate &&
              period.end_date >=
                selectedDate
          )
          .map(
            (period) =>
              period.employee_id
          )
      )
    );

  /*
   * TURNO HABITUAL
   */
  function getScheduledShift(
    employee: Employee
  ): Shift | null {
    if (
      employee.shift_mode ===
      "morning_fixed"
    ) {
      return "morning";
    }

    if (
      employee.shift_mode ===
      "night_fixed"
    ) {
      return "night";
    }

    if (
      employee.shift_mode ===
        "rotating" &&
      employee.rotation_group &&
      groupAJanuaryShift
    ) {
      return getShiftForDate(
        parseDate(
          selectedDate
        ),
        employee.rotation_group,
        groupAJanuaryShift
      );
    }

    return null;
  }

  /*
   * CAMBIO DE TURNO
   */
  function getShiftChange(
    employeeId: string
  ) {
    return shiftChanges.find(
      (change) =>
        change.employee_id ===
        employeeId
    );
  }

  /*
   * AJUSTE MANUAL
   */
  function getDailyOverride(
    employeeId: string
  ) {
    return dailyOverrides.find(
      (override) =>
        override.employee_id ===
        employeeId
    );
  }

  /*
   * TURNO REAL
   */
  function getActualShift(
    employee: Employee
  ): Shift | null {
    const change =
      getShiftChange(
        employee.id
      );

    if (
      change &&
      change.target_shift !==
        getScheduledShift(
          employee
        )
    ) {
      return change.target_shift;
    }

    return getScheduledShift(
      employee
    );
  }

  function hasRealShiftChange(
    employee: Employee
  ) {
    const change =
      getShiftChange(
        employee.id
      );

    if (!change) {
      return false;
    }

    return (
      change.target_shift !==
      getScheduledShift(
        employee
      )
    );
  }

  /*
   * PUESTO TEÓRICO
   *
   * Ausencias, cambios de turno
   * y ajustes manuales NO
   * modifican la rueda.
   */
  function getTheoreticalPosition(
    employee: Employee
  ): Position | null {
    if (
      employee.shift_mode ===
      "morning_fixed"
    ) {
      return null;
    }

    if (
      !employee
        .rotation_reference_date ||
      !employee
        .rotation_reference_position
    ) {
      return null;
    }

    const workdays =
      countWorkingDays(
        employee
          .rotation_reference_date,
        selectedDate,
        holidays
      );

    if (
      employee.shift_mode ===
      "night_fixed"
    ) {
      return getNightPositionForWorkday(
        employee
          .rotation_reference_position,
        workdays
      );
    }

    return getPositionForWorkday(
      employee
        .rotation_reference_position,
      workdays
    );
  }

  /*
   * AJUSTE MANUAL
   *
   * Tiene la última palabra.
   */
  function applyManualOverride(
    employee:
      PlannedEmployee
  ): PlannedEmployee {
    const override =
      getDailyOverride(
        employee.id
      );

    if (!override) {
      return employee;
    }

    return {
      ...employee,

      finalText:
        ASSIGNMENT_LABELS[
          override.assignment_code
        ],

      changed:
        true,

      isManualOverride:
        true,
    };
  }

  /*
   * GRUPO DE TARDE
   */
  function getAfternoonGroup():
    | RotationGroup
    | null {
    if (
      !groupAJanuaryShift
    ) {
      return null;
    }

    const groupAShift =
      getShiftForDate(
        parseDate(
          selectedDate
        ),
        "A",
        groupAJanuaryShift
      );

    return groupAShift ===
      "afternoon"
      ? "A"
      : "B";
  }

  const afternoonGroup =
    getAfternoonGroup();

  /*
   * GESTOR TARDE
   */
  function calculateAfternoonManager() {
    if (
      !afternoonGroup ||
      !groupAJanuaryShift
    ) {
      return null;
    }

    const managers =
      employees.filter(
        (employee) =>
          employee.manager_type ===
            "afternoon_pool" &&
          employee.rotation_group ===
            afternoonGroup
      );

    const setting =
      managerSettings.find(
        (item) =>
          item.rotation_group ===
          afternoonGroup
      );

    const effectiveAbsences:
      AbsencePeriod[] = [
        ...absencePeriods,
      ];

    for (
      const manager of
      managers
    ) {
      if (
        getActualShift(
          manager
        ) !== "afternoon"
      ) {
        effectiveAbsences.push({
          employee_id:
            manager.id,

          start_date:
            selectedDate,

          end_date:
            selectedDate,
        });
      }
    }

    const result =
      getAfternoonManagerForDate({
        targetDate:
          selectedDate,

        group:
          afternoonGroup,

        managers:
          managers.map(
            (manager) => ({
              id:
                manager.id,

              name:
                manager.name,
            })
          ),

        starterManagerId:
          setting
            ?.starter_manager_id ??
          null,

        groupAJanuaryShift,

        holidays,

        absencePeriods:
          effectiveAbsences,
      });

    if (
      !result.manager
    ) {
      return {
        employeeId:
          null,

        view:
          result.plannedManager
            ? ({
                name:
                  result
                    .plannedManager
                    .name,

                photo:
                  null,

                absent:
                  true,

                plannedName:
                  result
                    .plannedManager
                    .name,

                replacementReason:
                  "Sin cubrir",
              } satisfies ManagerView)
            : null,
      };
    }

    const employee =
      employees.find(
        (item) =>
          item.id ===
          result.manager?.id
      );

    return {
      employeeId:
        result.manager.id,

      view: {
        name:
          result.manager.name,

        photo:
          employee
            ?.photo_url ??
          null,

        substituted:
          result.substituted,

        plannedName:
          result
            .plannedManager
            ?.name ??
          null,

        replacementReason:
          result.substituted
            ? "Suplencia"
            : null,
      } satisfies ManagerView,
    };
  }

  const afternoonManager =
    calculateAfternoonManager();

  /*
   * GESTOR FIJO MAÑANA
   */
  const fixedMorningManager =
    employees.find(
      (employee) =>
        employee.manager_type ===
        "morning_fixed"
    );

  /*
   * GESTOR REAL MAÑANA
   */
  function calculateMorningManager() {
    if (
      !fixedMorningManager
    ) {
      return {
        employeeId:
          null,

        view:
          null,
      };
    }

    const fixedUnavailable =
      absentIdsToday.includes(
        fixedMorningManager.id
      ) ||
      getActualShift(
        fixedMorningManager
      ) !== "morning";

    if (
      !fixedUnavailable
    ) {
      return {
        employeeId:
          fixedMorningManager.id,

        view: {
          name:
            fixedMorningManager.name,

          photo:
            fixedMorningManager
              .photo_url,

          absent:
            false,
        } satisfies ManagerView,
      };
    }

    if (
      !groupAJanuaryShift
    ) {
      return {
        employeeId:
          null,

        view: {
          name:
            fixedMorningManager.name,

          photo:
            null,

          absent:
            true,

          replacementReason:
            "Sin cubrir",
        } satisfies ManagerView,
      };
    }

    const candidates =
      employees
        .filter(
          (employee) =>
            employee.manager_type ===
              "afternoon_pool" &&
            employee.rotation_group !==
              null &&
            getActualShift(
              employee
            ) === "morning"
        )
        .map(
          (employee) => ({
            id:
              employee.id,

            name:
              employee.name,

            rotationGroup:
              employee
                .rotation_group as RotationGroup,
          })
        );

    const starterSettings: {
      A?: string | null;
      B?: string | null;
    } = {};

    for (
      const setting of
      managerSettings
    ) {
      starterSettings[
        setting.rotation_group
      ] =
        setting
          .starter_manager_id;
    }

    const effectiveAbsences:
      AbsencePeriod[] = [
        ...absencePeriods,
      ];

    if (
      !absentIdsToday.includes(
        fixedMorningManager.id
      )
    ) {
      effectiveAbsences.push({
        employee_id:
          fixedMorningManager.id,

        start_date:
          selectedDate,

        end_date:
          selectedDate,
      });
    }

    const result =
      getMorningManagerSubstitute({
        targetDate:
          selectedDate,

        fixedManagerId:
          fixedMorningManager.id,

        candidates,

        groupAJanuaryShift,

        holidays,

        absencePeriods:
          effectiveAbsences,

        starterSettings,
      });

    if (
      !result.manager
    ) {
      return {
        employeeId:
          null,

        view: {
          name:
            fixedMorningManager.name,

          photo:
            null,

          absent:
            true,

          replacementReason:
            "Sin cubrir",
        } satisfies ManagerView,
      };
    }

    const substitute =
      employees.find(
        (employee) =>
          employee.id ===
          result.manager?.id
      );

    return {
      employeeId:
        result.manager.id,

      view: {
        name:
          result.manager.name,

        photo:
          substitute
            ?.photo_url ??
          null,

        substituted:
          true,

        plannedName:
          fixedMorningManager.name,

        replacementReason:
          "Suplencia",
      } satisfies ManagerView,
    };
  }

  const morningManager =
    calculateMorningManager();

  /*
   * MAÑANA / TARDE
   */
  function buildNormalShift(
    shift:
      | "morning"
      | "afternoon"
  ): ShiftPlan {
    const people =
      employees.filter(
        (employee) =>
          getActualShift(
            employee
          ) === shift
      );

    let operators =
      people.filter(
        (employee) =>
          employee.manager_type !==
          "morning_fixed"
      );

    /*
     * Sustituto Gestor mañana
     */
    if (
      shift === "morning" &&
      morningManager.employeeId &&
      morningManager.employeeId !==
        fixedMorningManager?.id
    ) {
      operators =
        operators.filter(
          (employee) =>
            employee.id !==
            morningManager
              .employeeId
        );
    }

    /*
     * Gestor tarde
     */
    if (
      shift === "afternoon" &&
      afternoonManager
        ?.employeeId
    ) {
      operators =
        operators.filter(
          (employee) =>
            employee.id !==
            afternoonManager
              .employeeId
        );
    }

    /*
     * Quitamos ausencias
     */
    const availableOperators =
      operators.filter(
        (employee) =>
          !absentIdsToday.includes(
            employee.id
          )
      );

    /*
     * Personal normal
     */
    const regularOperators =
      availableOperators.filter(
        (employee) =>
          !hasRealShiftChange(
            employee
          )
      );

    /*
     * Cambios de turno
     */
    const shiftChangeOperators =
      availableOperators.filter(
        (employee) =>
          hasRealShiftChange(
            employee
          )
      );

    /*
     * Motor automático únicamente
     * con personal habitual.
     */
    const regularSource =
      regularOperators
        .map(
          (employee) => {
            const position =
              getTheoreticalPosition(
                employee
              );

            if (
              !position
            ) {
              return null;
            }

            return {
              employeeId:
                employee.id,

              employeeName:
                employee.name,

              theoreticalPosition:
                position,
            };
          }
        )
        .filter(
          (
            item
          ): item is {
            employeeId:
              string;

            employeeName:
              string;

            theoreticalPosition:
              Position;
          } =>
            item !== null
        );

    const regularAssignments =
      resolveOperatorAssignments(
        regularSource
      );

    const existingExtras =
      regularAssignments.filter(
        (assignment) =>
          assignment.assignmentType ===
            "reinforcement_entradas" ||
          assignment.assignmentType ===
            "reinforcement_picking" ||
          assignment.assignmentType ===
            "pending_task"
      ).length;

    /*
     * Personal habitual
     */
    const regularResults:
      PlannedEmployee[] =
      regularOperators.map(
        (employee) => {
          const theoreticalPosition =
            getTheoreticalPosition(
              employee
            );

          const assignment =
            regularAssignments.find(
              (item) =>
                item.employeeId ===
                employee.id
            );

          let finalText =
            "Sin asignar";

          let changed =
            false;

          if (
            assignment
          ) {
            if (
              assignment
                .assignmentType ===
              "reinforcement_entradas"
            ) {
              finalText =
                "Refuerzo Entradas";

              changed =
                true;
            } else if (
              assignment
                .assignmentType ===
              "reinforcement_picking"
            ) {
              finalText =
                "Refuerzo Picking";

              changed =
                true;
            } else if (
              assignment
                .assignmentType ===
              "pending_task"
            ) {
              finalText =
                "Asignar tarea responsable";

              changed =
                true;
            } else if (
              assignment
                .finalPosition
            ) {
              finalText =
                POSITION_LABELS[
                  assignment
                    .finalPosition
                ];

              changed =
                assignment
                  .finalPosition !==
                assignment
                  .theoreticalPosition;
            }
          }

          const result:
            PlannedEmployee = {
            ...employee,

            theoreticalPosition,

            finalText,

            changed,

            isShiftChange:
              false,

            isManualOverride:
              false,

            scheduledShift:
              getScheduledShift(
                employee
              ),
          };

          return applyManualOverride(
            result
          );
        }
      );

    /*
     * Cambios de turno
     *
     * Siempre entran como extra,
     * salvo que el responsable
     * defina una asignación manual.
     */
    const shiftChangeResults:
      PlannedEmployee[] =
      shiftChangeOperators.map(
        (
          employee,
          index
        ) => {
          const extraIndex =
            existingExtras +
            index;

          let finalText:
            string;

          if (
            extraIndex === 0
          ) {
            finalText =
              "Refuerzo Entradas";
          } else if (
            extraIndex === 1
          ) {
            finalText =
              "Refuerzo Picking";
          } else {
            finalText =
              "Asignar tarea responsable";
          }

          const result:
            PlannedEmployee = {
            ...employee,

            theoreticalPosition:
              getTheoreticalPosition(
                employee
              ),

            finalText,

            changed:
              true,

            isShiftChange:
              true,

            isManualOverride:
              false,

            scheduledShift:
              getScheduledShift(
                employee
              ),
          };

          return applyManualOverride(
            result
          );
        }
      );

    const finalEmployees =
      sortEmployees([
        ...regularResults,
        ...shiftChangeResults,
      ]);

    /*
     * Recalculamos puestos sin cubrir
     * después de los ajustes manuales.
     */
    const uncoveredPositions =
      DAY_REQUIRED_POSITIONS.filter(
        (position) =>
          !finalEmployees.some(
            (employee) =>
              employee.finalText ===
              POSITION_LABELS[
                position
              ]
          )
      );

    return {
      employees:
        finalEmployees,

      uncoveredPositions,
    };
  }

  /*
   * NOCHE
   */
  function buildNightShift():
    ShiftPlan {
    const people =
      employees
        .filter(
          (employee) =>
            getActualShift(
              employee
            ) === "night"
        )
        .filter(
          (employee) =>
            !absentIdsToday.includes(
              employee.id
            )
        );

    const regularNight =
      people.filter(
        (employee) =>
          !hasRealShiftChange(
            employee
          )
      );

    const changedToNight =
      people.filter(
        (employee) =>
          hasRealShiftChange(
            employee
          )
      );

    const source =
      regularNight
        .map(
          (employee) => {
            const position =
              getTheoreticalPosition(
                employee
              );

            if (
              !position
            ) {
              return null;
            }

            return {
              employeeId:
                employee.id,

              employeeName:
                employee.name,

              theoreticalPosition:
                position,
            };
          }
        )
        .filter(
          (
            item
          ): item is {
            employeeId:
              string;

            employeeName:
              string;

            theoreticalPosition:
              Position;
          } =>
            item !== null
        );

    const resolved =
      resolveNightAssignments(
        source
      );

    /*
     * Personal habitual noche
     */
    const regularResults:
      PlannedEmployee[] =
      regularNight.map(
        (employee) => {
          const theoreticalPosition =
            getTheoreticalPosition(
              employee
            );

          const assignment =
            resolved.find(
              (item) =>
                item.employeeId ===
                employee.id
            );

          let result:
            PlannedEmployee;

          if (
            !assignment
          ) {
            result = {
              ...employee,

              theoreticalPosition,

              finalText:
                "Asignar tarea responsable",

              changed:
                true,

              isShiftChange:
                false,

              isManualOverride:
                false,

              scheduledShift:
                getScheduledShift(
                  employee
                ),
            };
          } else {
            result = {
              ...employee,

              theoreticalPosition,

              finalText:
                POSITION_LABELS[
                  assignment
                    .finalPosition
                ],

              changed:
                assignment.changed,

              isShiftChange:
                false,

              isManualOverride:
                false,

              scheduledShift:
                getScheduledShift(
                  employee
                ),
            };
          }

          return applyManualOverride(
            result
          );
        }
      );

    /*
     * Cambios hacia noche
     */
    const changedResults:
      PlannedEmployee[] =
      changedToNight.map(
        (employee) => {
          const result:
            PlannedEmployee = {
            ...employee,

            theoreticalPosition:
              getTheoreticalPosition(
                employee
              ),

            finalText:
              "Refuerzo noche",

            changed:
              true,

            isShiftChange:
              true,

            isManualOverride:
              false,

            scheduledShift:
              getScheduledShift(
                employee
              ),
          };

          return applyManualOverride(
            result
          );
        }
      );

    const finalEmployees =
      sortEmployees([
        ...regularResults,
        ...changedResults,
      ]);

    /*
     * Puestos nocturnos
     * después de ajustes.
     */
    const uncoveredPositions =
      NIGHT_REQUIRED_POSITIONS.filter(
        (position) =>
          !finalEmployees.some(
            (employee) =>
              employee.finalText ===
              POSITION_LABELS[
                position
              ]
          )
      );

    return {
      employees:
        finalEmployees,

      uncoveredPositions,
    };
  }

  const morningPlan =
    buildNormalShift(
      "morning"
    );

  const afternoonPlan =
    buildNormalShift(
      "afternoon"
    );

  const nightPlan =
    buildNightShift();

  /*
   * PUESTOS SIN CUBRIR
   */
  const morningMissing =
    morningManager.employeeId
      ? morningPlan
          .uncoveredPositions
          .map(
            (position) =>
              POSITION_LABELS[
                position
              ]
          )
      : [
          "Gestor",

          ...morningPlan
            .uncoveredPositions
            .map(
              (position) =>
                POSITION_LABELS[
                  position
                ]
            ),
        ];

  const afternoonMissing =
    afternoonManager
      ?.employeeId
      ? afternoonPlan
          .uncoveredPositions
          .map(
            (position) =>
              POSITION_LABELS[
                position
              ]
          )
      : [
          "Gestor",

          ...afternoonPlan
            .uncoveredPositions
            .map(
              (position) =>
                POSITION_LABELS[
                  position
                ]
            ),
        ];

  const nightMissing =
    nightPlan
      .uncoveredPositions
      .map(
        (position) =>
          POSITION_LABELS[
            position
          ]
      );

  /*
   * CONTADORES
   */
  const shiftChangeCount =
    employees.filter(
      (employee) =>
        hasRealShiftChange(
          employee
        ) &&
        !absentIdsToday.includes(
          employee.id
        )
    ).length;

  const manualOverrideCount =
    dailyOverrides.filter(
      (override) =>
        !absentIdsToday.includes(
          override.employee_id
        )
    ).length;

  /*
   * LABORABLE / NO LABORABLE
   */
  const selectedDateObject =
    parseDate(
      selectedDate
    );

  const dayOfWeek =
    selectedDateObject
      .getDay();

  const weekend =
    dayOfWeek === 0 ||
    dayOfWeek === 6;

  const holiday =
    holidays.includes(
      selectedDate
    );

  const nonWorkingDay =
    weekend ||
    holiday;

  return (
    <main className="min-h-screen bg-slate-950 text-white">

      {/* CABECERA */}

      <header className="border-b border-slate-700 bg-slate-900 px-6 py-4">

        <div className="mx-auto flex max-w-[1900px] items-center justify-between gap-6">

          <div>

            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
              Puestos Almacén
            </p>

            <h1 className="mt-1 text-2xl font-bold capitalize xl:text-3xl">
              {formatLongDate(
                now
              )}
            </h1>

          </div>

          <div className="flex items-center gap-4">

            {shiftChangeCount >
              0 && (
              <div className="rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-center">

                <p className="text-xs font-semibold uppercase tracking-wide text-blue-300">
                  Cambios turno
                </p>

                <p className="text-2xl font-bold text-blue-100">
                  {
                    shiftChangeCount
                  }
                </p>

              </div>
            )}

            {manualOverrideCount >
              0 && (
              <div className="rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-center">

                <p className="text-xs font-semibold uppercase tracking-wide text-violet-300">
                  Ajustes
                </p>

                <p className="text-2xl font-bold text-violet-100">
                  {
                    manualOverrideCount
                  }
                </p>

              </div>
            )}

            <div className="ml-3 text-right">

              <p className="text-4xl font-bold tabular-nums xl:text-5xl">
                {formatClock(
                  now
                )}
              </p>

              {lastUpdate && (
                <p className="mt-1 text-xs text-slate-500">
                  Actualizado{" "}
                  {formatClock(
                    lastUpdate
                  )}
                </p>
              )}

            </div>

          </div>

        </div>

      </header>

      {/* ERROR */}

      {message ? (
        <div className="flex min-h-[70vh] items-center justify-center p-8">

          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-10 py-8 text-center">

            <p className="text-2xl font-bold text-red-300">
              No se puede mostrar la planificación
            </p>

            <p className="mt-3 text-lg text-red-200">
              {message}
            </p>

          </div>

        </div>
      ) : loading ? (
        <div className="flex min-h-[70vh] items-center justify-center">

          <p className="text-xl text-slate-400">
            Cargando planificación...
          </p>

        </div>
      ) : (
        <>

          {/* DÍA NO LABORABLE */}

          {nonWorkingDay && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-3 text-center">

              <p className="text-lg font-bold text-amber-300">
                DÍA NO LABORABLE
              </p>

            </div>
          )}

          {/* TURNOS */}

          <div className="mx-auto grid max-w-[1900px] gap-4 p-4 lg:grid-cols-3">

            <MonitorShift
              title="MAÑANA"
              manager={
                morningManager
                  .view
              }
              employees={
                morningPlan
                  .employees
              }
              missingPosts={
                morningMissing
              }
            />

            <MonitorShift
              title="TARDE"
              manager={
                afternoonManager
                  ?.view ??
                null
              }
              employees={
                afternoonPlan
                  .employees
              }
              missingPosts={
                afternoonMissing
              }
            />

            <MonitorShift
              title="NOCHE"
              manager={
                null
              }
              employees={
                nightPlan
                  .employees
              }
              missingPosts={
                nightMissing
              }
            />

          </div>

          {/* LEYENDA */}

          <footer className="mx-auto flex max-w-[1900px] flex-wrap items-center justify-between gap-3 px-6 pb-4 pt-1 text-xs text-slate-500">

            <div className="flex flex-wrap gap-5">

              <span>
                <strong className="text-slate-300">
                  Normal
                </strong>
                {" "}
                puesto previsto
              </span>

              <span>
                <strong className="text-amber-300">
                  Reasignado
                </strong>
                {" "}
                cambio por cobertura
              </span>

              <span>
                <strong className="text-blue-300">
                  Cambio de turno
                </strong>
                {" "}
                personal de refuerzo
              </span>

              <span>
                <strong className="text-violet-300">
                  Ajuste manual
                </strong>
                {" "}
                decisión del responsable
              </span>

            </div>

            <p>
              Actualización automática cada 60 s
            </p>

          </footer>

        </>
      )}

    </main>
  );
}

function MonitorShift({
  title,
  manager,
  employees,
  missingPosts,
}: {
  title: string;

  manager:
    ManagerView | null;

  employees:
    PlannedEmployee[];

  missingPosts:
    string[];
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-xl">

      {/* TURNO */}

      <div className="flex items-center justify-between border-b border-slate-700 bg-slate-800 px-5 py-3">

        <h2 className="text-2xl font-black tracking-wide xl:text-3xl">
          {title}
        </h2>

        <span className="rounded-full bg-slate-700 px-3 py-1 text-sm font-bold text-slate-200">
          {employees.length +
            (manager &&
            !manager.absent
              ? 1
              : 0)}
        </span>

      </div>

      {/* GESTOR */}

      {title !== "NOCHE" && (
        <ManagerRow
          manager={
            manager
          }
        />
      )}

      {/* OPERARIOS */}

      <div className="divide-y divide-slate-800">

        {employees.length ===
        0 ? (
          <div className="px-5 py-10 text-center text-slate-500">
            Sin personal disponible
          </div>
        ) : (
          employees.map(
            (employee) => (
              <EmployeeRow
                key={
                  employee.id
                }
                employee={
                  employee
                }
              />
            )
          )
        )}

      </div>

      {/* SIN CUBRIR */}

      {missingPosts.length >
        0 && (
        <div className="border-t border-red-500/30 bg-red-500/10 px-5 py-3">

          <p className="text-xs font-bold uppercase tracking-wider text-red-300">
            Puestos sin cubrir
          </p>

          <p className="mt-1 text-lg font-bold text-red-100">
            {missingPosts.join(
              " · "
            )}
          </p>

        </div>
      )}

    </section>
  );
}

function ManagerRow({
  manager,
}: {
  manager:
    ManagerView | null;
}) {
  if (
    !manager ||
    manager.absent
  ) {
    return (
      <div className="border-b border-red-500/30 bg-red-500/10 px-5 py-3">

        <div className="flex items-center gap-4">

          <Avatar
            name="G"
            photo={
              null
            }
          />

          <div>

            <p className="text-sm font-black uppercase tracking-wider text-red-300">
              Gestor
            </p>

            <p className="text-xl font-bold text-red-100">
              SIN CUBRIR
            </p>

          </div>

        </div>

      </div>
    );
  }

  return (
    <div
      className={
        manager.substituted
          ? "border-b border-amber-500/30 bg-amber-500/10 px-5 py-3"
          : "border-b border-slate-700 bg-slate-800/40 px-5 py-3"
      }
    >

      <div className="flex items-center gap-4">

        <Avatar
          name={
            manager.name
          }
          photo={
            manager.photo
          }
        />

        <div className="min-w-0">

          <div className="flex flex-wrap items-center gap-2">

            <p
              className={
                manager.substituted
                  ? "text-sm font-black uppercase tracking-wider text-amber-300"
                  : "text-sm font-black uppercase tracking-wider text-slate-400"
              }
            >
              Gestor
            </p>

            {manager.substituted && (
              <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-xs font-bold text-amber-300">
                SUPLENCIA
              </span>
            )}

          </div>

          <p className="truncate text-xl font-bold text-white xl:text-2xl">
            {manager.name}
          </p>

        </div>

      </div>

    </div>
  );
}

function EmployeeRow({
  employee,
}: {
  employee:
    PlannedEmployee;
}) {
  const reassigned =
    employee.changed &&
    !employee.isShiftChange &&
    !employee.isManualOverride;

  /*
   * Prioridad visual:
   *
   * 1. Ajuste manual
   * 2. Cambio de turno
   * 3. Reasignación automática
   */
  const rowClass =
    employee.isManualOverride
      ? "bg-violet-500/10"
      : employee.isShiftChange
      ? "bg-blue-500/10"
      : reassigned
      ? "bg-amber-500/10"
      : "";

  const positionClass =
    employee.isManualOverride
      ? "text-violet-300"
      : employee.isShiftChange
      ? "text-blue-300"
      : reassigned
      ? "text-amber-300"
      : "text-slate-300";

  return (
    <div
      className={`px-5 py-2.5 ${rowClass}`}
    >

      <div className="flex items-center gap-4">

        <Avatar
          name={
            employee.name
          }
          photo={
            employee.photo_url
          }
        />

        <div className="min-w-0 flex-1">

          {/* PUESTO */}

          <div className="flex flex-wrap items-center gap-2">

            <p
              className={`text-sm font-black uppercase tracking-wide xl:text-base ${positionClass}`}
            >
              {
                employee.finalText
              }
            </p>

            {employee.isManualOverride && (
              <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-[11px] font-bold text-violet-300">
                AJUSTE MANUAL
              </span>
            )}

            {employee.isShiftChange && (
              <span className="rounded-full border border-blue-400/30 bg-blue-400/10 px-2 py-0.5 text-[11px] font-bold text-blue-300">
                CAMBIO DE TURNO
              </span>
            )}

            {reassigned && (
              <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] font-bold text-amber-300">
                REASIGNADO
              </span>
            )}

          </div>

          {/* PERSONA */}

          <p className="truncate text-xl font-bold text-white xl:text-2xl">
            {
              employee.name
            }
          </p>

          {employee.isShiftChange && (
            <p className="text-xs text-blue-300/80">
              Turno habitual:{" "}
              {shiftLabel(
                employee
                  .scheduledShift
              )}
            </p>
          )}

        </div>

      </div>

    </div>
  );
}

function Avatar({
  name,
  photo,
}: {
  name: string;

  photo:
    | string
    | null;
}) {
  if (photo) {
    return (
      <img
        src={
          photo
        }
        alt={
          name
        }
        className="h-11 w-11 shrink-0 rounded-full border border-slate-600 object-cover xl:h-12 xl:w-12"
      />
    );
  }

  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-600 bg-slate-700 text-lg font-black text-white xl:h-12 xl:w-12">

      {name
        .charAt(0)
        .toUpperCase()}

    </div>
  );
}