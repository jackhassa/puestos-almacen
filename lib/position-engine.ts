export type Position =
  | "mesa1"
  | "mesa2"
  | "mesa3"
  | "mesa4"
  | "entradas"
  | "picking";

export const POSITION_ROTATION: Position[] = [
  "mesa1",
  "mesa2",
  "mesa3",
  "mesa4",
  "entradas",
  "picking",
];

export const NIGHT_POSITION_ROTATION: Position[] = [
  "picking",
  "mesa3",
  "mesa4",
];

export const POSITION_LABELS: Record<Position, string> = {
  mesa1: "Mesa 1",
  mesa2: "Mesa 2",
  mesa3: "Mesa 3",
  mesa4: "Mesa 4",
  entradas: "Entradas",
  picking: "Picking",
};

function calculatePosition(
  rotation: Position[],
  startPosition: Position,
  workdaysPassed: number
): Position {
  const startIndex = rotation.indexOf(startPosition);

  if (startIndex === -1) {
    return rotation[0];
  }

  const offset =
    ((workdaysPassed % rotation.length) + rotation.length) %
    rotation.length;

  const newIndex =
    (startIndex + offset) % rotation.length;

  return rotation[newIndex];
}

/**
 * Rueda normal:
 * Mesa 1 → Mesa 2 → Mesa 3 → Mesa 4 → Entradas → Picking
 */
export function getPositionForWorkday(
  startPosition: Position,
  workdaysPassed: number
): Position {
  return calculatePosition(
    POSITION_ROTATION,
    startPosition,
    workdaysPassed
  );
}

/**
 * Rueda turno noche:
 * Picking → Mesa 3 → Mesa 4 → Picking
 */
export function getNightPositionForWorkday(
  startPosition: Position,
  workdaysPassed: number
): Position {
  return calculatePosition(
    NIGHT_POSITION_ROTATION,
    startPosition,
    workdaysPassed
  );
}