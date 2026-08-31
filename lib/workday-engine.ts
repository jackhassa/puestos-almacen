function parseDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);

  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isWeekend(date: Date) {
  const day = date.getUTCDay();

  return day === 0 || day === 6;
}

/**
 * Cuenta los días laborables transcurridos entre dos fechas.
 *
 * REGLAS:
 * - Sábado y domingo NO cuentan.
 * - Festivos generales NO cuentan.
 * - Ausencias personales SÍ cuentan.
 * - Vacaciones personales SÍ cuentan.
 *
 * La fecha de referencia es el puesto conocido.
 * Por tanto:
 *
 * Lunes referencia = Mesa 1
 * Martes = 1 día transcurrido = Mesa 2
 */
export function countWorkingDays(
  referenceDate: string,
  targetDate: string,
  nonWorkingDates: string[]
) {
  if (referenceDate === targetDate) {
    return 0;
  }

  const holidays = new Set(nonWorkingDates);

  const reference = parseDate(referenceDate);
  const target = parseDate(targetDate);

  const forward = target > reference;

  let current = new Date(reference);
  let count = 0;

  while (
    forward
      ? current < target
      : current > target
  ) {
    current.setUTCDate(
      current.getUTCDate() + (forward ? 1 : -1)
    );

    const currentDate = formatDate(current);

    if (
      !isWeekend(current) &&
      !holidays.has(currentDate)
    ) {
      count += forward ? 1 : -1;
    }
  }

  return count;
}