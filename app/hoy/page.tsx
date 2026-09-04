"use client";

import { useEffect, useState } from "react";
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

import { countWorkingDays } from "@/lib/workday-engine";

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

function formatDateForInput(
  date: Date
) {
  const year =
    date.getFullYear();

  const month = String(
    date.getMonth() + 1
  ).padStart(
    2,
    "0"
  );

  const day = String(
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

export default function HoyPage() {
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
    message,
    setMessage,
  ] =
    useState("");

  const [
    loading,
    setLoading,
  ] =
    useState(true);

  async function loadData() {
    setLoading(true);
    setMessage("");

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
        "ERROR cargando personal: " +
          employeesResult
            .error.message
      );

      setLoading(false);
      return;
    }

    if (
      yearResult.error
    ) {
      setMessage(
        "ERROR cargando configuración anual: " +
          yearResult
            .error.message
      );

      setLoading(false);
      return;
    }

    if (
      !yearResult.data
    ) {
      setMessage(
        `No existe configuración de turnos para ${year}.`
      );

      setLoading(false);
      return;
    }

    if (
      holidaysResult.error
    ) {
      setMessage(
        "ERROR cargando calendario: " +
          holidaysResult
            .error.message
      );

      setLoading(false);
      return;
    }

    if (
      absencesResult.error
    ) {
      setMessage(
        "ERROR cargando ausencias: " +
          absencesResult
            .error.message
      );

      setLoading(false);
      return;
    }

    if (
      managersResult.error
    ) {
      setMessage(
        "ERROR cargando gestores: " +
          managersResult
            .error.message
      );

      setLoading(false);
      return;
    }

    if (
      changesResult.error
    ) {
      setMessage(
        "ERROR cargando cambios de turno: " +
          changesResult
            .error.message
      );

      setLoading(false);
      return;
    }

    if (
      overridesResult.error
    ) {
      setMessage(
        "ERROR cargando ajustes manuales: " +
          overridesResult
            .error.message
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

    setLoading(false);
  }

  useEffect(() => {
    loadData();
  }, [selectedDate]);

  /*
   * AUSENCIAS DEL DÍA
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
   * TURNO REAL DEL DÍA
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
   * Ni las ausencias,
   * ni los cambios de turno,
   * ni los ajustes manuales
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
   * APLICA EL AJUSTE MANUAL
   * COMO ÚLTIMA DECISIÓN.
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
   * GESTOR DE TARDE
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
                  employees.find(
                    (employee) =>
                      employee.id ===
                      result
                        .plannedManager
                        ?.id
                  )?.photo_url ??
                  null,

                absent:
                  true,

                plannedName:
                  result
                    .plannedManager
                    .name,

                replacementReason:
                  "Sin Gestor de tarde disponible",
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
            ? "Gestor · Suplencia"
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
            fixedMorningManager
              .photo_url,

          absent:
            true,

          replacementReason:
            "Sin sustituto disponible",
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
            fixedMorningManager
              .photo_url,

          absent:
            true,

          replacementReason:
            "Sin sustituto disponible",
        } satisfies ManagerView,
      };
    }

    const substituteEmployee =
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
          substituteEmployee
            ?.photo_url ??
          null,

        substituted:
          true,

        plannedName:
          fixedMorningManager.name,

        replacementReason:
          "Sustitución del Gestor fijo",
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
     * Sacamos al sustituto
     * del Gestor de mañana.
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
     * Sacamos al Gestor
     * de tarde.
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

    const availableOperators =
      operators.filter(
        (employee) =>
          !absentIdsToday.includes(
            employee.id
          )
      );

    /*
     * PERSONAL HABITUAL
     */
    const regularOperators =
      availableOperators.filter(
        (employee) =>
          !hasRealShiftChange(
            employee
          )
      );

    /*
     * CAMBIOS DE TURNO
     */
    const shiftChangeOperators =
      availableOperators.filter(
        (employee) =>
          hasRealShiftChange(
            employee
          )
      );

    const regularSource =
      regularOperators
        .map(
          (employee) => {
            const position =
              getTheoreticalPosition(
                employee
              );

            if (!position) {
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
            employeeId: string;
            employeeName: string;
            theoreticalPosition: Position;
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
     * PERSONAL HABITUAL
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
     * CAMBIOS DE TURNO
     *
     * Automáticamente son refuerzo,
     * salvo que exista un ajuste
     * manual para ese día.
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

    const finalEmployees = [
      ...regularResults,
      ...shiftChangeResults,
    ];

    /*
     * Recalculamos puestos sin cubrir
     * DESPUÉS de aplicar los ajustes
     * manuales.
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

            if (!position) {
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
            employeeId: string;
            employeeName: string;
            theoreticalPosition: Position;
          } =>
            item !== null
        );

    const resolved =
      resolveNightAssignments(
        source
      );

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

          if (!assignment) {
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
     * CAMBIOS HACIA NOCHE
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

    const finalEmployees = [
      ...regularResults,
      ...changedResults,
    ];

    /*
     * Recalculamos también
     * después del ajuste manual.
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
   * INCORPORAMOS GESTOR
   * A LOS PUESTOS SIN CUBRIR.
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

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-7xl">

        {/* CABECERA */}

        <div className="flex flex-wrap items-end justify-between gap-4">

          <div>

            <h1 className="text-3xl font-bold text-slate-900">
              Planificación diaria
            </h1>

            <p className="mt-2 text-slate-600">
              Asignación automática del almacén
            </p>

          </div>

          <div>

            <label className="mb-2 block text-sm font-medium">
              Fecha
            </label>

            <input
              type="date"
              value={
                selectedDate
              }
              onChange={(
                event
              ) =>
                setSelectedDate(
                  event.target
                    .value
                )
              }
              className="rounded-lg border border-slate-300 bg-white px-4 py-2"
            />

          </div>

        </div>

        {/* ERRORES */}

        {message && (
          <div className="mt-6 rounded-lg bg-white p-4 text-red-600 shadow-sm">
            {message}
          </div>
        )}

        {loading ? (
          <p className="mt-8">
            Calculando planificación...
          </p>
        ) : (
          <>

            {/* AVISOS */}

            {(shiftChangeCount >
              0 ||
              manualOverrideCount >
                0) && (
              <div className="mt-6 grid gap-4 md:grid-cols-2">

                {shiftChangeCount >
                  0 && (
                  <div className="rounded-xl border border-blue-200 bg-blue-50 px-5 py-4">

                    <p className="font-semibold text-blue-900">
                      Cambios de turno
                    </p>

                    <p className="mt-1 text-sm text-blue-700">
                      Hay{" "}
                      {
                        shiftChangeCount
                      }{" "}
                      cambio
                      {shiftChangeCount ===
                      1
                        ? ""
                        : "s"}{" "}
                      de turno para esta fecha.
                    </p>

                  </div>
                )}

                {manualOverrideCount >
                  0 && (
                  <div className="rounded-xl border border-violet-200 bg-violet-50 px-5 py-4">

                    <p className="font-semibold text-violet-900">
                      Ajustes manuales
                    </p>

                    <p className="mt-1 text-sm text-violet-700">
                      Hay{" "}
                      {
                        manualOverrideCount
                      }{" "}
                      ajuste
                      {manualOverrideCount ===
                      1
                        ? ""
                        : "s"}{" "}
                      manual
                      {manualOverrideCount ===
                      1
                        ? ""
                        : "es"}{" "}
                      para esta fecha.
                    </p>

                  </div>
                )}

              </div>
            )}

            {/* TURNOS */}

            <div className="mt-8 grid gap-6 lg:grid-cols-3">

              <ShiftCard
                title="Mañana"
                employees={
                  morningPlan
                    .employees
                }
                manager={
                  morningManager
                    .view
                }
                missingPosts={
                  morningMissing
                }
              />

              <ShiftCard
                title="Tarde"
                employees={
                  afternoonPlan
                    .employees
                }
                manager={
                  afternoonManager
                    ?.view ??
                  null
                }
                missingPosts={
                  afternoonMissing
                }
              />

              <ShiftCard
                title="Noche"
                employees={
                  nightPlan
                    .employees
                }
                manager={
                  null
                }
                missingPosts={
                  nightMissing
                }
              />

            </div>

            {/* AUSENCIAS */}

            {absentIdsToday.length >
              0 && (
              <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">

                <h2 className="text-lg font-semibold">
                  Ausencias del día
                </h2>

                <p className="mt-1 text-sm text-slate-500">
                  El motivo de la ausencia no se muestra en esta pantalla.
                </p>

                <div className="mt-4 flex flex-wrap gap-2">

                  {employees
                    .filter(
                      (employee) =>
                        absentIdsToday.includes(
                          employee.id
                        )
                    )
                    .map(
                      (employee) => (
                        <span
                          key={
                            employee.id
                          }
                          className="rounded-full bg-slate-100 px-3 py-2 text-sm"
                        >
                          {
                            employee.name
                          }
                        </span>
                      )
                    )}

                </div>

              </section>
            )}

          </>
        )}

      </div>
    </main>
  );
}

function ShiftCard({
  title,
  employees,
  manager,
  missingPosts,
}: {
  title: string;

  employees:
    PlannedEmployee[];

  manager:
    ManagerView | null;

  missingPosts:
    string[];
}) {
  return (
    <section className="overflow-hidden rounded-xl bg-white shadow-sm">

      {/* CABECERA */}

      <div className="border-b border-slate-100 px-6 py-5">

        <div className="flex items-center justify-between">

          <h2 className="text-xl font-semibold">
            {title}
          </h2>

          <span className="rounded-full bg-slate-100 px-3 py-1 text-sm">
            {employees.length +
              (manager &&
              !manager.absent
                ? 1
                : 0)}{" "}
            personas
          </span>

        </div>

      </div>

      {/* PUESTOS SIN CUBRIR */}

      {missingPosts.length >
        0 && (
        <div className="border-b border-red-100 bg-red-50 px-6 py-4">

          <p className="text-sm font-semibold text-red-700">
            ⚠ Puestos sin cubrir
          </p>

          <p className="mt-1 text-sm text-red-600">
            {missingPosts.join(
              ", "
            )}
          </p>

        </div>
      )}

      {/* GESTOR */}

      {manager && (
        <div
          className={
            manager.absent
              ? "border-b border-red-100 bg-red-50 px-6 py-4"
              : manager.substituted
              ? "border-b border-amber-100 bg-amber-50 px-6 py-4"
              : "border-b border-slate-100 bg-slate-50 px-6 py-4"
          }
        >

          <div className="flex items-center gap-3">

            {manager.photo ? (
              <img
                src={
                  manager.photo
                }
                alt={
                  manager.name
                }
                className="h-12 w-12 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 font-semibold">
                {manager.name
                  .charAt(0)
                  .toUpperCase()}
              </div>
            )}

            <div>

              <p className="font-semibold">
                {
                  manager.name
                }
              </p>

              {manager.absent ? (
                <>
                  <p className="text-sm font-semibold text-red-600">
                    Gestor ausente
                  </p>

                  {manager.replacementReason && (
                    <p className="text-xs text-red-500">
                      {
                        manager.replacementReason
                      }
                    </p>
                  )}
                </>
              ) : manager.substituted ? (
                <>
                  <p className="text-sm font-semibold text-amber-700">
                    {manager.replacementReason ??
                      "Gestor · Suplencia"}
                  </p>

                  {manager.plannedName && (
                    <p className="text-xs text-slate-500">
                      Sustituye a:{" "}
                      {
                        manager.plannedName
                      }
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-500">
                  Gestor
                </p>
              )}

            </div>

          </div>

        </div>
      )}

      {/* PERSONAL */}

      <div className="divide-y divide-slate-100">

        {employees.length ===
        0 ? (
          <p className="p-6 text-sm text-slate-500">
            No hay operarios disponibles.
          </p>
        ) : (
          employees.map(
            (employee) => (
              <div
                key={
                  employee.id
                }
                className="flex items-center justify-between gap-4 px-6 py-4"
              >

                <div className="flex min-w-0 items-center gap-3">

                  {employee.photo_url ? (
                    <img
                      src={
                        employee.photo_url
                      }
                      alt={
                        employee.name
                      }
                      className="h-11 w-11 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold">
                      {employee.name
                        .charAt(0)
                        .toUpperCase()}
                    </div>
                  )}

                  <div className="min-w-0">

                    <div className="flex flex-wrap items-center gap-2">

                      <p className="font-medium">
                        {
                          employee.name
                        }
                      </p>

                      {employee.isShiftChange && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                          Cambio de turno
                        </span>
                      )}

                      {employee.isManualOverride && (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                          Ajuste manual
                        </span>
                      )}

                    </div>

                    {employee.isShiftChange && (
                      <p className="mt-1 text-xs text-blue-700">
                        Habitual:{" "}
                        {shiftLabel(
                          employee
                            .scheduledShift
                        )}
                      </p>
                    )}

                    {employee.changed &&
                      employee.theoreticalPosition && (
                        <p className="mt-1 text-xs text-slate-500">
                          Teórico:{" "}
                          {
                            POSITION_LABELS[
                              employee
                                .theoreticalPosition
                            ]
                          }
                        </p>
                      )}

                  </div>

                </div>

                <div
                  className={
                    employee.isManualOverride
                      ? "rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-right"
                      : employee.isShiftChange
                      ? "rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-right"
                      : employee.changed
                      ? "rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-right"
                      : "rounded-lg bg-slate-100 px-3 py-2 text-right"
                  }
                >

                  <p className="text-sm font-semibold">
                    {
                      employee.finalText
                    }
                  </p>

                </div>

              </div>
            )
          )
        )}

      </div>

    </section>
  );
}