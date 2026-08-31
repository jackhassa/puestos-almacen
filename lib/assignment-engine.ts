import type { Position } from "./position-engine";

export type AssignmentType =
  | "normal"
  | "reassigned"
  | "reinforcement_entradas"
  | "reinforcement_picking"
  | "pending_task";

export type OperatorAssignment = {
  employeeId: string;
  employeeName: string;
  theoreticalPosition: Position;
  finalPosition?: Position;
  assignmentType: AssignmentType;
};

const PRIORITY: Position[] = [
  "entradas",
  "picking",
  "mesa4",
  "mesa3",
  "mesa2",
  "mesa1",
];

function priorityIndex(position: Position) {
  return PRIORITY.indexOf(position);
}

export function resolveOperatorAssignments(
  employees: {
    employeeId: string;
    employeeName: string;
    theoreticalPosition: Position;
  }[]
): OperatorAssignment[] {
  const assignments: OperatorAssignment[] =
    employees.map((employee) => ({
      ...employee,
      finalPosition: undefined,
      assignmentType: "normal",
    }));

  /*
   * PASO 1
   * Intentamos respetar el puesto teórico.
   *
   * Si dos personas tienen el mismo puesto,
   * una queda colocada y la otra queda libre
   * temporalmente.
   */
  for (const position of PRIORITY) {
    const candidates = assignments.filter(
      (assignment) =>
        assignment.theoreticalPosition === position &&
        !assignment.finalPosition
    );

    if (candidates.length > 0) {
      candidates[0].finalPosition = position;
    }
  }

  /*
   * PASO 2
   * Comprobamos los puestos que siguen vacíos.
   *
   * Primero utilizamos personas que todavía
   * no tienen puesto asignado.
   */
  for (const requiredPosition of PRIORITY) {
    const covered = assignments.some(
      (assignment) =>
        assignment.finalPosition === requiredPosition
    );

    if (covered) {
      continue;
    }

    const freePerson = assignments.find(
      (assignment) => !assignment.finalPosition
    );

    if (freePerson) {
      freePerson.finalPosition = requiredPosition;

      if (
        freePerson.theoreticalPosition !== requiredPosition
      ) {
        freePerson.assignmentType = "reassigned";
      }

      continue;
    }

    /*
     * Si no hay ninguna persona libre,
     * buscamos alguien que esté en un puesto
     * de MENOR prioridad.
     *
     * Ejemplo:
     * si falta Entradas, preferimos mover
     * Mesa 1 antes que Mesa 2, Mesa 3, etc.
     */
    const candidates = assignments
      .filter(
        (assignment) =>
          assignment.finalPosition &&
          priorityIndex(assignment.finalPosition) >
            priorityIndex(requiredPosition)
      )
      .sort(
        (a, b) =>
          priorityIndex(b.finalPosition!) -
          priorityIndex(a.finalPosition!)
      );

    const candidate = candidates[0];

    if (candidate) {
      candidate.finalPosition = requiredPosition;
      candidate.assignmentType = "reassigned";
    }
  }

  /*
   * PASO 3
   * Si todos los puestos están cubiertos y
   * todavía sobra personal:
   *
   * 1º Refuerzo Entradas
   * 2º Refuerzo Picking
   * resto → tarea del responsable.
   */
  const extras = assignments.filter(
    (assignment) => !assignment.finalPosition
  );

  extras.forEach((assignment, index) => {
    if (index === 0) {
      assignment.assignmentType =
        "reinforcement_entradas";
    } else if (index === 1) {
      assignment.assignmentType =
        "reinforcement_picking";
    } else {
      assignment.assignmentType =
        "pending_task";
    }
  });

  return assignments;
}