export type AssignmentCode =
  | "mesa1"
  | "mesa2"
  | "mesa3"
  | "mesa4"
  | "entradas"
  | "picking"
  | "montajes"
  | "reinforcement_entradas"
  | "reinforcement_picking"
  | "pending_task";

export type PlannedAssignmentCode = AssignmentCode | "gestor";

export type OperationalAreaCode =
  | "gestor"
  | "mesa1"
  | "mesa2"
  | "mesa3"
  | "mesa4"
  | "entradas"
  | "picking"
  | "montajes";

export type WorkModeCode =
  | "standard"
  | "cart"
  | "export"
  | "support";

export const ASSIGNMENT_LABELS: Record<AssignmentCode, string> = {
  mesa1: "Mesa 1",
  mesa2: "Mesa 2",
  mesa3: "Mesa 3",
  mesa4: "Mesa 4",
  entradas: "Entradas",
  picking: "Picking",
  montajes: "Montajes",
  reinforcement_entradas: "Refuerzo Entradas",
  reinforcement_picking: "Refuerzo Picking",
  pending_task: "Asignar tarea responsable",
};

export const OPERATIONAL_AREA_LABELS: Record<OperationalAreaCode, string> = {
  gestor: "Gestor",
  mesa1: "Mesa 1",
  mesa2: "Mesa 2",
  mesa3: "Mesa 3",
  mesa4: "Mesa 4",
  entradas: "Entradas",
  picking: "Picking",
  montajes: "Montajes",
};

export const WORK_MODE_LABELS: Record<WorkModeCode, string> = {
  standard: "Trabajo habitual",
  cart: "Modo Carro",
  export: "Modo Exportación",
  support: "Modo Apoyo",
};

export function assignmentCodeToOperationalArea(
  assignment: AssignmentCode | "gestor",
): OperationalAreaCode | null {
  if (assignment === "reinforcement_entradas") return "entradas";
  if (assignment === "reinforcement_picking") return "picking";
  if (assignment === "pending_task") return null;
  return assignment;
}

export function defaultModeForArea(area: OperationalAreaCode): WorkModeCode {
  if (area === "mesa1" || area === "mesa2" || area === "mesa3" || area === "mesa4") {
    return "cart";
  }

  return "standard";
}
