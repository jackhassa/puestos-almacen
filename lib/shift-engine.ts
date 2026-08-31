export type WorkShift = "morning" | "afternoon";
export type RotationGroup = "A" | "B";

const oppositeShift = (shift: WorkShift): WorkShift =>
  shift === "morning" ? "afternoon" : "morning";

function startOfWeekMonday(date: Date) {
  const result = new Date(date);
  const day = result.getDay();

  const difference = day === 0 ? -6 : 1 - day;

  result.setDate(result.getDate() + difference);
  result.setHours(0, 0, 0, 0);

  return result;
}

/**
 * Determina a qué mes pertenece laboralmente una semana.
 *
 * Solo cuenta lunes-viernes.
 * El mes que tenga 3 o más de los 5 días gana.
 */
export function getOperationalMonth(date: Date) {
  const monday = startOfWeekMonday(date);

  const monthCount = new Map<number, number>();

  for (let i = 0; i < 5; i++) {
    const current = new Date(monday);
    current.setDate(monday.getDate() + i);

    const month = current.getMonth();

    monthCount.set(month, (monthCount.get(month) ?? 0) + 1);
  }

  let selectedMonth = monday.getMonth();
  let highestCount = 0;

  for (const [month, count] of monthCount.entries()) {
    if (count > highestCount) {
      selectedMonth = month;
      highestCount = count;
    }
  }

  return selectedMonth;
}

/**
 * Calcula el turno mensual normal del Grupo A.
 *
 * Enero toma el valor configurado.
 * Después alterna:
 *
 * Enero   M
 * Febrero T
 * Marzo   M
 * ...
 */
function getNormalGroupAShift(
  operationalMonth: number,
  januaryShift: WorkShift
): WorkShift {
  if (operationalMonth % 2 === 0) {
    return januaryShift;
  }

  return oppositeShift(januaryShift);
}

/**
 * Obtiene el número de semana OPERATIVA de agosto.
 *
 * La primera semana considerada agosto = 0.
 * La segunda = 1.
 * etc.
 */
function getAugustOperationalWeekIndex(date: Date) {
  const year = date.getFullYear();

  const searchStart = new Date(year, 6, 20);

  let monday = startOfWeekMonday(searchStart);

  let augustWeekIndex = 0;

  for (let i = 0; i < 10; i++) {
    const operationalMonth = getOperationalMonth(monday);

    if (operationalMonth === 7) {
      const currentMonday = startOfWeekMonday(date);

      if (monday.getTime() === currentMonday.getTime()) {
        return augustWeekIndex;
      }

      augustWeekIndex++;
    }

    monday.setDate(monday.getDate() + 7);
  }

  return 0;
}

/**
 * Calcula el turno de un grupo A/B para una fecha.
 *
 * REGLAS:
 *
 * - Grupo A y Grupo B siempre son opuestos.
 * - Enero parte de la configuración anual.
 * - Los meses normales alternan mañana/tarde.
 * - Una semana pertenece al mes que tenga mayoría
 *   de días entre lunes y viernes.
 * - Agosto cambia cada semana.
 * - La primera semana de agosto cambia respecto
 *   al turno de julio.
 */
export function getShiftForDate(
  date: Date,
  group: RotationGroup,
  groupAJanuaryShift: WorkShift
): WorkShift {
  const operationalMonth = getOperationalMonth(date);

  let groupAShift: WorkShift;

  // AGOSTO
  if (operationalMonth === 7) {
    const julyShift = getNormalGroupAShift(
      6,
      groupAJanuaryShift
    );

    const firstAugustShift = oppositeShift(julyShift);

    const weekIndex = getAugustOperationalWeekIndex(date);

    groupAShift =
      weekIndex % 2 === 0
        ? firstAugustShift
        : oppositeShift(firstAugustShift);
  }

  // RESTO DEL AÑO
  else {
    groupAShift = getNormalGroupAShift(
      operationalMonth,
      groupAJanuaryShift
    );
  }

  if (group === "A") {
    return groupAShift;
  }

  return oppositeShift(groupAShift);
}