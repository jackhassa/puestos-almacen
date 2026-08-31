import {
  getShiftForDate,
  type RotationGroup,
  type WorkShift,
} from "./shift-engine";

type CandidateManager = {
  id: string;
  name: string;
  rotationGroup: RotationGroup;
};

type AbsencePeriod = {
  employee_id: string;
  start_date: string;
  end_date: string;
};

type StarterSettings = {
  A?: string | null;
  B?: string | null;
};

export type MorningManagerResult = {
  required: boolean;
  manager: CandidateManager | null;
  plannedManager: CandidateManager | null;
  morningGroup: RotationGroup | null;
  substituted: boolean;
};

function parseDate(value: string) {
  const [year, month, day] = value
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

function formatDate(date: Date) {
  const year = date.getFullYear();

  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  const day = String(
    date.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getMonday(date: Date) {
  const result = new Date(date);

  const day = result.getDay();

  const difference =
    day === 0
      ? -6
      : 1 - day;

  result.setDate(
    result.getDate() + difference
  );

  return result;
}

function isWeekend(date: Date) {
  const day = date.getDay();

  return day === 0 || day === 6;
}

function isAbsent(
  employeeId: string,
  date: string,
  absencePeriods: AbsencePeriod[]
) {
  return absencePeriods.some(
    (period) =>
      period.employee_id ===
        employeeId &&
      period.start_date <= date &&
      period.end_date >= date
  );
}

function getMorningGroup(
  date: Date,
  groupAJanuaryShift: WorkShift
): RotationGroup {
  const groupAShift =
    getShiftForDate(
      date,
      "A",
      groupAJanuaryShift
    );

  return groupAShift === "morning"
    ? "A"
    : "B";
}

function chooseManager(
  candidates: CandidateManager[],
  counts: Record<string, number>,
  preferredId: string | null
) {
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort(
    (a, b) => {
      const countA =
        counts[a.id] ?? 0;

      const countB =
        counts[b.id] ?? 0;

      if (countA !== countB) {
        return countA - countB;
      }

      if (
        preferredId &&
        a.id === preferredId &&
        b.id !== preferredId
      ) {
        return -1;
      }

      if (
        preferredId &&
        b.id === preferredId &&
        a.id !== preferredId
      ) {
        return 1;
      }

      return a.name.localeCompare(
        b.name
      );
    }
  )[0];
}

export function getMorningManagerSubstitute({
  targetDate,
  fixedManagerId,
  candidates,
  groupAJanuaryShift,
  holidays,
  absencePeriods,
  starterSettings,
}: {
  targetDate: string;
  fixedManagerId: string;
  candidates: CandidateManager[];
  groupAJanuaryShift: WorkShift;
  holidays: string[];
  absencePeriods: AbsencePeriod[];
  starterSettings: StarterSettings;
}): MorningManagerResult {
  const target =
    parseDate(targetDate);

  /*
   * En fin de semana o festivo
   * no hace falta sustitución.
   */
  if (
    isWeekend(target) ||
    holidays.includes(targetDate)
  ) {
    return {
      required: false,
      manager: null,
      plannedManager: null,
      morningGroup: null,
      substituted: false,
    };
  }

  /*
   * Si el Gestor fijo está presente,
   * no buscamos sustituto.
   */
  if (
    !isAbsent(
      fixedManagerId,
      targetDate,
      absencePeriods
    )
  ) {
    return {
      required: false,
      manager: null,
      plannedManager: null,
      morningGroup:
        getMorningGroup(
          target,
          groupAJanuaryShift
        ),
      substituted: false,
    };
  }

  const targetMorningGroup =
    getMorningGroup(
      target,
      groupAJanuaryShift
    );

  /*
   * Contabilizamos las sustituciones
   * realizadas durante el mes actual.
   */
  const counts: Record<
    string,
    number
  > = {};

  candidates.forEach(
    (candidate) => {
      counts[candidate.id] = 0;
    }
  );

  const monthStart = new Date(
    target.getFullYear(),
    target.getMonth(),
    1,
    12
  );

  let week =
    getMonday(monthStart);

  const targetMonday =
    getMonday(target);

  let targetResult:
    | MorningManagerResult
    | null = null;

  while (week <= targetMonday) {
    /*
     * El turno cambia por semanas,
     * por tanto el grupo de mañana
     * será el correspondiente al lunes.
     */
    const morningGroup =
      getMorningGroup(
        week,
        groupAJanuaryShift
      );

    const groupCandidates =
      candidates.filter(
        (candidate) =>
          candidate.rotationGroup ===
          morningGroup
      );

    const preferredId =
      starterSettings[
        morningGroup
      ] ?? null;

    let weeklyPlannedManager:
      | CandidateManager
      | null = null;

    for (
      let dayIndex = 0;
      dayIndex < 5;
      dayIndex++
    ) {
      const current =
        new Date(week);

      current.setDate(
        week.getDate() +
          dayIndex
      );

      if (
        current <
        monthStart
      ) {
        continue;
      }

      if (
        current > target
      ) {
        break;
      }

      const currentText =
        formatDate(current);

      if (
        holidays.includes(
          currentText
        )
      ) {
        continue;
      }

      /*
       * Solo hay sustitución si
       * el Gestor fijo está ausente.
       */
      if (
        !isAbsent(
          fixedManagerId,
          currentText,
          absencePeriods
        )
      ) {
        continue;
      }

      /*
       * Elegimos un responsable principal
       * para esa semana.
       *
       * Se prioriza al que lleve menos
       * sustituciones acumuladas.
       */
      if (!weeklyPlannedManager) {
        weeklyPlannedManager =
          chooseManager(
            groupCandidates,
            counts,
            preferredId
          );
      }

      const plannedManager =
        weeklyPlannedManager;

      if (!plannedManager) {
        if (
          currentText ===
          targetDate
        ) {
          targetResult = {
            required: true,
            manager: null,
            plannedManager: null,
            morningGroup,
            substituted: false,
          };
        }

        continue;
      }

      let realManager =
        plannedManager;

      /*
       * Si el previsto también falta,
       * buscamos otro gestor disponible
       * de ese mismo grupo.
       */
      if (
        isAbsent(
          plannedManager.id,
          currentText,
          absencePeriods
        )
      ) {
        const availableAlternatives =
          groupCandidates.filter(
            (candidate) =>
              candidate.id !==
                plannedManager.id &&
              !isAbsent(
                candidate.id,
                currentText,
                absencePeriods
              )
          );

        const alternative =
          chooseManager(
            availableAlternatives,
            counts,
            null
          );

        if (alternative) {
          realManager =
            alternative;
        } else {
          if (
            currentText ===
            targetDate
          ) {
            targetResult = {
              required: true,
              manager: null,
              plannedManager,
              morningGroup,
              substituted: false,
            };
          }

          continue;
        }
      }

      counts[realManager.id] =
        (counts[
          realManager.id
        ] ?? 0) + 1;

      if (
        currentText ===
        targetDate
      ) {
        targetResult = {
          required: true,
          manager:
            realManager,
          plannedManager,
          morningGroup,
          substituted:
            realManager.id !==
            plannedManager.id,
        };
      }
    }

    week.setDate(
      week.getDate() + 7
    );
  }

  return (
    targetResult ?? {
      required: true,
      manager: null,
      plannedManager: null,
      morningGroup:
        targetMorningGroup,
      substituted: false,
    }
  );
}