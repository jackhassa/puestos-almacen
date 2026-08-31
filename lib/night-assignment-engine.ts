import type { Position } from "./position-engine";

export type NightAssignment = {
  employeeId: string;
  employeeName: string;
  theoreticalPosition: Position;
  finalPosition: Position;
  changed: boolean;
};

const NIGHT_PRIORITY: Position[] = [
  "picking",
  "mesa4",
  "mesa3",
];

export function resolveNightAssignments(
  employees: {
    employeeId: string;
    employeeName: string;
    theoreticalPosition: Position;
  }[]
): NightAssignment[] {
  const assignments: {
    employeeId: string;
    employeeName: string;
    theoreticalPosition: Position;
    finalPosition?: Position;
  }[] = employees.map((employee) => ({
    ...employee,
  }));

  /*
   * 1. Intentamos mantener cada puesto teórico
   * siempre que sea posible.
   */
  for (const position of NIGHT_PRIORITY) {
    const employee = assignments.find(
      (assignment) =>
        !assignment.finalPosition &&
        assignment.theoreticalPosition === position
    );

    if (employee) {
      employee.finalPosition = position;
    }
  }

  /*
   * 2. Cubrimos los puestos vacíos
   * siguiendo la prioridad nocturna:
   *
   * Picking → Mesa 4 → Mesa 3
   */
  for (const requiredPosition of NIGHT_PRIORITY) {
    const alreadyCovered = assignments.some(
      (assignment) =>
        assignment.finalPosition === requiredPosition
    );

    if (alreadyCovered) {
      continue;
    }

    /*
     * Si queda alguien todavía sin colocar,
     * lo usamos para cubrir el puesto prioritario.
     */
    const freeEmployee = assignments.find(
      (assignment) => !assignment.finalPosition
    );

    if (freeEmployee) {
      freeEmployee.finalPosition = requiredPosition;
      continue;
    }

    /*
     * Si no hay nadie libre, movemos a una persona
     * desde un puesto de menor prioridad.
     */
    const requiredPriority =
      NIGHT_PRIORITY.indexOf(requiredPosition);

    const candidate = assignments
      .filter((assignment) => {
        if (!assignment.finalPosition) {
          return false;
        }

        const currentPriority =
          NIGHT_PRIORITY.indexOf(
            assignment.finalPosition
          );

        return currentPriority > requiredPriority;
      })
      .sort((a, b) => {
        const priorityA =
          NIGHT_PRIORITY.indexOf(
            a.finalPosition!
          );

        const priorityB =
          NIGHT_PRIORITY.indexOf(
            b.finalPosition!
          );

        return priorityB - priorityA;
      })[0];

    if (candidate) {
      candidate.finalPosition = requiredPosition;
    }
  }

  return assignments
    .filter(
      (
        assignment
      ): assignment is typeof assignment & {
        finalPosition: Position;
      } => Boolean(assignment.finalPosition)
    )
    .map((assignment) => ({
      employeeId: assignment.employeeId,
      employeeName: assignment.employeeName,
      theoreticalPosition:
        assignment.theoreticalPosition,
      finalPosition: assignment.finalPosition,
      changed:
        assignment.finalPosition !==
        assignment.theoreticalPosition,
    }));
}