import {
  getShiftForDate,
  type RotationGroup,
  type WorkShift,
} from "./shift-engine";

export type Manager = {
  id: string;
  name: string;
};

export type AbsencePeriod = {
  employee_id: string;
  start_date: string;
  end_date: string;
};

export type AfternoonManagerResult = {
  /*
   * Gestor que realmente
   * ocupa el puesto ese día.
   */
  manager: Manager | null;

  /*
   * Gestor al que le tocaba
   * teóricamente esa semana.
   */
  plannedManager: Manager | null;

  /*
   * true cuando otra persona
   * sustituye al Gestor previsto.
   */
  substituted: boolean;
};

type GetAfternoonManagerParams = {
  targetDate: string;

  group: RotationGroup;

  managers: Manager[];

  starterManagerId:
    | string
    | null;

  groupAJanuaryShift: WorkShift;

  holidays: string[];

  absencePeriods: AbsencePeriod[];
};

/*
 * Convierte YYYY-MM-DD
 * a fecha local al mediodía.
 *
 * El mediodía evita problemas
 * derivados de cambios horarios.
 */
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

function formatDate(
  date: Date
) {
  const year =
    date.getFullYear();

  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  const day = String(
    date.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function addDays(
  date: Date,
  days: number
) {
  const result =
    new Date(date);

  result.setDate(
    result.getDate() +
      days
  );

  return result;
}

function startOfWeekMonday(
  date: Date
) {
  const result =
    new Date(date);

  const day =
    result.getDay();

  /*
   * JS:
   * Domingo = 0
   * Lunes = 1
   */
  const difference =
    day === 0
      ? -6
      : 1 - day;

  result.setDate(
    result.getDate() +
      difference
  );

  result.setHours(
    12,
    0,
    0,
    0
  );

  return result;
}

/*
 * MES OPERATIVO
 *
 * Una semana pertenece al mes
 * que contiene al menos 3 de
 * sus días de lunes a viernes.
 *
 * Eso equivale al mes
 * del miércoles.
 */
function getOperationalMonthKey(
  date: Date
) {
  const monday =
    startOfWeekMonday(
      date
    );

  const wednesday =
    addDays(
      monday,
      2
    );

  return `${wednesday.getFullYear()}-${String(
    wednesday.getMonth() + 1
  ).padStart(
    2,
    "0"
  )}`;
}

/*
 * Primer lunes perteneciente
 * al mismo mes operativo
 * que la fecha objetivo.
 */
function getFirstOperationalWeek(
  targetDate: Date
) {
  const targetMonth =
    getOperationalMonthKey(
      targetDate
    );

  let monday =
    startOfWeekMonday(
      targetDate
    );

  while (true) {
    const previousMonday =
      addDays(
        monday,
        -7
      );

    if (
      getOperationalMonthKey(
        previousMonday
      ) !== targetMonth
    ) {
      break;
    }

    monday =
      previousMonday;
  }

  return monday;
}

function isWeekend(
  date: Date
) {
  const day =
    date.getDay();

  return (
    day === 0 ||
    day === 6
  );
}

function isAbsent(
  managerId: string,
  date: string,
  absencePeriods:
    AbsencePeriod[]
) {
  return absencePeriods.some(
    (period) =>
      period.employee_id ===
        managerId &&
      period.start_date <=
        date &&
      period.end_date >=
        date
  );
}

/*
 * Selecciona el Gestor
 * TEÓRICO de una semana.
 *
 * REGLAS:
 *
 * 1. Se intenta equilibrar
 *    el número REAL de días
 *    realizados como Gestor.
 *
 * 2. Cuando ambos están empatados
 *    al empezar el mes operativo,
 *    comienza el Gestor marcado
 *    como INICIAL.
 *
 * 3. Si posteriormente vuelven
 *    a empatar, se alterna respecto
 *    al Gestor previsto la semana
 *    anterior.
 */
function choosePlannedManager(
  managers: Manager[],
  actualDays:
    Map<string, number>,
  starterManagerId:
    | string
    | null,
  previousPlannedManagerId:
    | string
    | null,
  firstAfternoonWeek: boolean
) {
  if (
    managers.length === 0
  ) {
    return null;
  }

  if (
    managers.length === 1
  ) {
    return managers[0];
  }

  const minimumDays =
    Math.min(
      ...managers.map(
        (manager) =>
          actualDays.get(
            manager.id
          ) ?? 0
      )
    );

  const candidates =
    managers.filter(
      (manager) =>
        (
          actualDays.get(
            manager.id
          ) ?? 0
        ) === minimumDays
    );

  /*
   * Si solamente uno lleva
   * menos días reales como Gestor,
   * le corresponde a él.
   */
  if (
    candidates.length === 1
  ) {
    return candidates[0];
  }

  /*
   * PRIMERA SEMANA DE TARDE
   *
   * El Gestor marcado como
   * INICIAL tiene prioridad.
   *
   * Esto es importante:
   * "Inicial" no es solamente
   * una preferencia visual.
   */
  if (
    firstAfternoonWeek &&
    starterManagerId
  ) {
    const starter =
      candidates.find(
        (manager) =>
          manager.id ===
          starterManagerId
      );

    if (starter) {
      return starter;
    }
  }

  /*
   * Si están empatados después,
   * intentamos alternar respecto
   * a la semana anterior.
   */
  if (
    previousPlannedManagerId
  ) {
    const alternative =
      candidates.find(
        (manager) =>
          manager.id !==
          previousPlannedManagerId
      );

    if (alternative) {
      return alternative;
    }
  }

  /*
   * Si todavía no tenemos
   * referencia anterior,
   * usamos el Gestor inicial.
   */
  if (
    starterManagerId
  ) {
    const starter =
      candidates.find(
        (manager) =>
          manager.id ===
          starterManagerId
      );

    if (starter) {
      return starter;
    }
  }

  /*
   * Último fallback.
   */
  return candidates[0];
}

/*
 * Si el Gestor previsto falta,
 * buscamos otro disponible.
 *
 * El sustituto con menos días
 * reales de Gestor tiene
 * prioridad.
 */
function chooseSubstitute(
  managers: Manager[],
  plannedManagerId: string,
  date: string,
  absencePeriods:
    AbsencePeriod[],
  actualDays:
    Map<string, number>
) {
  const available =
    managers.filter(
      (manager) =>
        manager.id !==
          plannedManagerId &&
        !isAbsent(
          manager.id,
          date,
          absencePeriods
        )
    );

  if (
    available.length === 0
  ) {
    return null;
  }

  return [...available].sort(
    (a, b) => {
      const daysA =
        actualDays.get(
          a.id
        ) ?? 0;

      const daysB =
        actualDays.get(
          b.id
        ) ?? 0;

      if (
        daysA !== daysB
      ) {
        return (
          daysA -
          daysB
        );
      }

      return a.name.localeCompare(
        b.name,
        "es"
      );
    }
  )[0];
}

export function getAfternoonManagerForDate({
  targetDate,
  group,
  managers,
  starterManagerId,
  groupAJanuaryShift,
  holidays,
  absencePeriods,
}: GetAfternoonManagerParams): AfternoonManagerResult {
  /*
   * Sin gestores configurados.
   */
  if (
    managers.length === 0
  ) {
    return {
      manager: null,
      plannedManager: null,
      substituted: false,
    };
  }

  const target =
    parseDate(
      targetDate
    );

  /*
   * Sábado o domingo.
   */
  if (
    isWeekend(
      target
    )
  ) {
    return {
      manager: null,
      plannedManager: null,
      substituted: false,
    };
  }

  /*
   * Festivo general.
   */
  if (
    holidays.includes(
      targetDate
    )
  ) {
    return {
      manager: null,
      plannedManager: null,
      substituted: false,
    };
  }

  /*
   * Por seguridad comprobamos
   * que este grupo realmente
   * está de tarde ese día.
   */
  const targetGroupShift =
    getShiftForDate(
      target,
      group,
      groupAJanuaryShift
    );

  if (
    targetGroupShift !==
    "afternoon"
  ) {
    return {
      manager: null,
      plannedManager: null,
      substituted: false,
    };
  }

  /*
   * Contador REAL de días
   * realizados como Gestor.
   */
  const actualDays =
    new Map<
      string,
      number
    >();

  for (
    const manager of
    managers
  ) {
    actualDays.set(
      manager.id,
      0
    );
  }

  const targetWeek =
    startOfWeekMonday(
      target
    );

  const firstWeek =
    getFirstOperationalWeek(
      target
    );

  let currentWeek =
    firstWeek;

  let previousPlannedManagerId:
    | string
    | null = null;

  let afternoonWeekNumber =
    0;

  let targetResult:
    AfternoonManagerResult = {
      manager: null,
      plannedManager: null,
      substituted: false,
    };

  /*
   * Recorremos las semanas del
   * mes operativo hasta llegar
   * a la fecha objetivo.
   */
  while (
    currentWeek <=
    targetWeek
  ) {
    /*
     * Comprobamos si el grupo
     * está realmente de tarde
     * esta semana.
     *
     * Esto también hace funcionar
     * correctamente agosto,
     * donde el cambio es semanal.
     */
    const groupShift =
      getShiftForDate(
        currentWeek,
        group,
        groupAJanuaryShift
      );

    if (
      groupShift ===
      "afternoon"
    ) {
      const firstAfternoonWeek =
        afternoonWeekNumber ===
        0;

      /*
       * Elegimos Gestor previsto
       * PARA TODA LA SEMANA.
       */
      const plannedManager =
        choosePlannedManager(
          managers,
          actualDays,
          starterManagerId,
          previousPlannedManagerId,
          firstAfternoonWeek
        );

      if (
        plannedManager
      ) {
        /*
         * Procesamos lunes-viernes.
         */
        for (
          let dayIndex = 0;
          dayIndex < 5;
          dayIndex++
        ) {
          const day =
            addDays(
              currentWeek,
              dayIndex
            );

          /*
           * No procesamos días
           * posteriores a la fecha
           * que estamos calculando.
           */
          if (
            day > target
          ) {
            break;
          }

          const dayText =
            formatDate(
              day
            );

          /*
           * Festivos generales
           * no cuentan.
           */
          if (
            holidays.includes(
              dayText
            )
          ) {
            continue;
          }

          /*
           * Protección adicional:
           * confirmamos que el grupo
           * continúa de tarde ese día.
           */
          const dayShift =
            getShiftForDate(
              day,
              group,
              groupAJanuaryShift
            );

          if (
            dayShift !==
            "afternoon"
          ) {
            continue;
          }

          let actualManager:
            | Manager
            | null =
            plannedManager;

          let substituted =
            false;

          /*
           * Si falta el Gestor previsto,
           * otro Gestor del grupo
           * lo sustituye.
           */
          if (
            isAbsent(
              plannedManager.id,
              dayText,
              absencePeriods
            )
          ) {
            actualManager =
              chooseSubstitute(
                managers,
                plannedManager.id,
                dayText,
                absencePeriods,
                actualDays
              );

            substituted =
              actualManager !==
              null;
          }

          /*
           * Sumamos solamente
           * al Gestor que REALMENTE
           * ha trabajado como Gestor.
           */
          if (
            actualManager
          ) {
            actualDays.set(
              actualManager.id,
              (
                actualDays.get(
                  actualManager.id
                ) ?? 0
              ) + 1
            );
          }

          /*
           * Resultado del día
           * que nos han solicitado.
           */
          if (
            dayText ===
            targetDate
          ) {
            targetResult = {
              manager:
                actualManager,

              plannedManager,

              substituted,
            };
          }
        }

        /*
         * Guardamos quién tenía
         * prevista esta semana
         * para poder alternar
         * cuando haya empate.
         */
        previousPlannedManagerId =
          plannedManager.id;

        afternoonWeekNumber++;
      }
    }

    currentWeek =
      addDays(
        currentWeek,
        7
      );
  }

  return targetResult;
}