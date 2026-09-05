import { supabase } from "@/lib/supabase";
import {
  buildDailyPlanning,
  type EmployeeDailyAssignment,
  type PlanningAbsence,
  type PlanningDailyOverride,
  type PlanningEmployee,
  type PlanningManagerSetting,
  type PlanningShiftChange,
} from "@/lib/daily-plan-engine";
import type { WorkShift } from "@/lib/shift-engine";

export async function loadEmployeeDailyAssignment(
  employeeId: string,
  targetDate: string,
): Promise<EmployeeDailyAssignment> {
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
    supabase
      .from("absence_periods")
      .select("employee_id,start_date,end_date"),
    supabase
      .from("afternoon_manager_settings")
      .select("rotation_group,starter_manager_id"),
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

  if (firstError) {
    throw new Error(firstError.message);
  }

  if (!yearResult.data) {
    throw new Error(`No existe configuración de turnos para ${year}.`);
  }

  const planning = buildDailyPlanning({
    targetDate,
    employees: (employeesResult.data ?? []) as PlanningEmployee[],
    groupAJanuaryShift: yearResult.data.group_a_january_shift as WorkShift,
    holidays: (holidaysResult.data ?? []).map((item) => item.date),
    absencePeriods: (absencesResult.data ?? []) as PlanningAbsence[],
    managerSettings: (managersResult.data ?? []) as PlanningManagerSetting[],
    shiftChanges: (changesResult.data ?? []) as PlanningShiftChange[],
    dailyOverrides: (overridesResult.data ?? []) as PlanningDailyOverride[],
  });

  const result = planning.find((item) => item.employeeId === employeeId);
  if (!result) {
    throw new Error("El trabajador no aparece en la planificación activa.");
  }

  return result;
}
