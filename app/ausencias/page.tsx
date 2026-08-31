"use client";

import {
  FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

import { supabase } from "@/lib/supabase";

type Employee = {
  id: string;
  name: string;
};

type AbsenceType =
  | "vacation"
  | "illness"
  | "medical"
  | "permission"
  | "personal"
  | "other";

type RelatedEmployee = {
  name: string;
};

type AbsencePeriod = {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  absence_type: AbsenceType;
  notes: string | null;

  /*
   * Supabase puede devolver
   * esta relación como objeto
   * o como array.
   */
  employees:
    | RelatedEmployee
    | RelatedEmployee[]
    | null;
};

type StatusFilter =
  | "all"
  | "current"
  | "upcoming"
  | "finished";

const absenceLabels: Record<
  AbsenceType,
  string
> = {
  vacation: "Vacaciones",
  illness: "Enfermedad",
  medical: "Médico",
  permission: "Permiso",
  personal: "Asuntos propios",
  other: "Otro",
};

const monthNames = [
  "Todos los meses",
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

function todayText() {
  const date = new Date();

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
    Date.UTC(
      year,
      month - 1,
      day
    )
  );
}

function formatDate(
  value: string
) {
  const [
    year,
    month,
    day,
  ] = value.split("-");

  return `${day}/${month}/${year}`;
}

function isWeekend(
  date: Date
) {
  const day =
    date.getUTCDay();

  return (
    day === 0 ||
    day === 6
  );
}

function countWorkingDays(
  start: string,
  end: string,
  holidays: string[]
) {
  const holidaySet =
    new Set(holidays);

  const current =
    parseDate(start);

  const finish =
    parseDate(end);

  let count = 0;

  while (
    current <= finish
  ) {
    const currentText =
      current
        .toISOString()
        .slice(0, 10);

    if (
      !isWeekend(
        current
      ) &&
      !holidaySet.has(
        currentText
      )
    ) {
      count++;
    }

    current.setUTCDate(
      current.getUTCDate() +
        1
    );
  }

  return count;
}

function getStatus(
  period: AbsencePeriod
) {
  const today =
    todayText();

  if (
    period.start_date >
    today
  ) {
    return "upcoming";
  }

  if (
    period.end_date <
    today
  ) {
    return "finished";
  }

  return "current";
}

function statusLabel(
  period: AbsencePeriod
) {
  const status =
    getStatus(period);

  if (
    status === "current"
  ) {
    return "Actual";
  }

  if (
    status === "upcoming"
  ) {
    return "Próxima";
  }

  return "Finalizada";
}

/*
 * OBTENER NOMBRE
 *
 * Admite las dos formas
 * posibles que puede devolver
 * Supabase:
 *
 * employees: { name: "Juan" }
 *
 * o
 *
 * employees: [{ name: "Juan" }]
 */
function getEmployeeName(
  period: AbsencePeriod
) {
  if (
    Array.isArray(
      period.employees
    )
  ) {
    return (
      period.employees[0]
        ?.name ??
      "Trabajador"
    );
  }

  return (
    period.employees
      ?.name ??
    "Trabajador"
  );
}

export default function AusenciasPage() {
  const currentYear =
    new Date().getFullYear();

  const [
    employees,
    setEmployees,
  ] =
    useState<Employee[]>([]);

  const [
    periods,
    setPeriods,
  ] =
    useState<
      AbsencePeriod[]
    >([]);

  const [
    holidays,
    setHolidays,
  ] =
    useState<string[]>([]);

  /*
   * NUEVA AUSENCIA
   */
  const [
    employeeId,
    setEmployeeId,
  ] =
    useState("");

  const [
    absenceType,
    setAbsenceType,
  ] =
    useState<AbsenceType>(
      "vacation"
    );

  const [
    startDate,
    setStartDate,
  ] =
    useState(
      todayText()
    );

  const [
    endDate,
    setEndDate,
  ] =
    useState(
      todayText()
    );

  const [
    notes,
    setNotes,
  ] =
    useState("");

  /*
   * EDICIÓN
   */
  const [
    editing,
    setEditing,
  ] =
    useState<
      AbsencePeriod | null
    >(null);

  const [
    editType,
    setEditType,
  ] =
    useState<AbsenceType>(
      "vacation"
    );

  const [
    editStartDate,
    setEditStartDate,
  ] =
    useState("");

  const [
    editEndDate,
    setEditEndDate,
  ] =
    useState("");

  const [
    editNotes,
    setEditNotes,
  ] =
    useState("");

  /*
   * FILTROS
   */
  const [
    yearFilter,
    setYearFilter,
  ] =
    useState(
      currentYear
    );

  const [
    employeeFilter,
    setEmployeeFilter,
  ] =
    useState("all");

  const [
    typeFilter,
    setTypeFilter,
  ] =
    useState<
      "all" | AbsenceType
    >("all");

  const [
    statusFilter,
    setStatusFilter,
  ] =
    useState<StatusFilter>(
      "all"
    );

  const [
    monthFilter,
    setMonthFilter,
  ] =
    useState(0);

  const [
    message,
    setMessage,
  ] =
    useState("");

  const [
    saving,
    setSaving,
  ] =
    useState(false);

  async function loadData() {
    const [
      employeesResult,
      periodsResult,
      holidaysResult,
    ] =
      await Promise.all([
        supabase
          .from(
            "employees"
          )
          .select(
            "id, name"
          )
          .eq(
            "active",
            true
          )
          .order(
            "name"
          ),

        supabase
          .from(
            "absence_periods"
          )
          .select(`
            id,
            employee_id,
            start_date,
            end_date,
            absence_type,
            notes,
            employees (
              name
            )
          `)
          .order(
            "start_date",
            {
              ascending:
                false,
            }
          ),

        supabase
          .from(
            "non_working_days"
          )
          .select(
            "date"
          ),
      ]);

    if (
      employeesResult.error
    ) {
      setMessage(
        "ERROR personal: " +
          employeesResult
            .error.message
      );

      return;
    }

    if (
      periodsResult.error
    ) {
      setMessage(
        "ERROR ausencias: " +
          periodsResult
            .error.message
      );

      return;
    }

    if (
      holidaysResult.error
    ) {
      setMessage(
        "ERROR calendario: " +
          holidaysResult
            .error.message
      );

      return;
    }

    const people =
      employeesResult.data ??
      [];

    setEmployees(
      people
    );

    if (
      people.length >
        0 &&
      !employeeId
    ) {
      setEmployeeId(
        people[0].id
      );
    }

    setPeriods(
      (
        periodsResult.data ??
        []
      ) as AbsencePeriod[]
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
  }

  useEffect(() => {
    loadData();
  }, []);

  async function createAbsence(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setMessage("");

    if (!employeeId) {
      setMessage(
        "Selecciona una persona."
      );

      return;
    }

    if (
      parseDate(
        endDate
      ) <
      parseDate(
        startDate
      )
    ) {
      setMessage(
        "La fecha final no puede ser anterior a la inicial."
      );

      return;
    }

    setSaving(true);

    const { error } =
      await supabase
        .from(
          "absence_periods"
        )
        .insert({
          employee_id:
            employeeId,

          start_date:
            startDate,

          end_date:
            endDate,

          absence_type:
            absenceType,

          notes:
            notes.trim() ||
            null,
        });

    if (error) {
      setMessage(
        "ERROR: " +
          error.message
      );

      setSaving(false);
      return;
    }

    setNotes("");

    setMessage(
      "Ausencia registrada correctamente."
    );

    setSaving(false);

    await loadData();
  }

  function startEdit(
    period: AbsencePeriod
  ) {
    setEditing(
      period
    );

    setEditType(
      period.absence_type
    );

    setEditStartDate(
      period.start_date
    );

    setEditEndDate(
      period.end_date
    );

    setEditNotes(
      period.notes ?? ""
    );

    setMessage("");
  }

  async function saveEdit() {
    if (!editing) {
      return;
    }

    if (
      parseDate(
        editEndDate
      ) <
      parseDate(
        editStartDate
      )
    ) {
      setMessage(
        "La fecha final no puede ser anterior a la inicial."
      );

      return;
    }

    setSaving(true);

    const { error } =
      await supabase
        .from(
          "absence_periods"
        )
        .update({
          start_date:
            editStartDate,

          end_date:
            editEndDate,

          absence_type:
            editType,

          notes:
            editNotes.trim() ||
            null,
        })
        .eq(
          "id",
          editing.id
        );

    if (error) {
      setMessage(
        "ERROR: " +
          error.message
      );

      setSaving(false);
      return;
    }

    setEditing(null);

    setSaving(false);

    setMessage(
      "Ausencia actualizada correctamente."
    );

    await loadData();
  }

  async function deletePeriod(
    period: AbsencePeriod
  ) {
    const confirmed =
      window.confirm(
        `¿Eliminar la ausencia de ${getEmployeeName(
          period
        )} del ${formatDate(
          period.start_date
        )} al ${formatDate(
          period.end_date
        )}?`
      );

    if (!confirmed) {
      return;
    }

    const { error } =
      await supabase
        .from(
          "absence_periods"
        )
        .delete()
        .eq(
          "id",
          period.id
        );

    if (error) {
      setMessage(
        "ERROR: " +
          error.message
      );

      return;
    }

    setMessage(
      "Periodo eliminado."
    );

    await loadData();
  }

  const filteredPeriods =
    useMemo(() => {
      return periods.filter(
        (period) => {
          const yearStart =
            `${yearFilter}-01-01`;

          const yearEnd =
            `${yearFilter}-12-31`;

          if (
            period.end_date <
              yearStart ||
            period.start_date >
              yearEnd
          ) {
            return false;
          }

          if (
            employeeFilter !==
              "all" &&
            period.employee_id !==
              employeeFilter
          ) {
            return false;
          }

          if (
            typeFilter !==
              "all" &&
            period.absence_type !==
              typeFilter
          ) {
            return false;
          }

          if (
            statusFilter !==
              "all" &&
            getStatus(
              period
            ) !==
              statusFilter
          ) {
            return false;
          }

          if (
            monthFilter !==
            0
          ) {
            const monthStart =
              `${yearFilter}-${String(
                monthFilter
              ).padStart(
                2,
                "0"
              )}-01`;

            const monthEndDate =
              new Date(
                Date.UTC(
                  yearFilter,
                  monthFilter,
                  0
                )
              );

            const monthEnd =
              monthEndDate
                .toISOString()
                .slice(
                  0,
                  10
                );

            if (
              period.end_date <
                monthStart ||
              period.start_date >
                monthEnd
            ) {
              return false;
            }
          }

          return true;
        }
      );
    }, [
      periods,
      yearFilter,
      employeeFilter,
      typeFilter,
      statusFilter,
      monthFilter,
    ]);

  const currentCount =
    filteredPeriods.filter(
      (period) =>
        getStatus(
          period
        ) === "current"
    ).length;

  const upcomingCount =
    filteredPeriods.filter(
      (period) =>
        getStatus(
          period
        ) === "upcoming"
    ).length;

  const peopleWithAbsences =
    new Set(
      filteredPeriods.map(
        (period) =>
          period.employee_id
      )
    ).size;

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-7xl">

        {/* CABECERA */}

        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            Ausencias
          </h1>

          <p className="mt-2 text-slate-600">
            Vacaciones, permisos y otras ausencias del personal.
          </p>
        </div>

        {/* NUEVA AUSENCIA */}

        <form
          onSubmit={
            createAbsence
          }
          className="mt-8 rounded-xl bg-white p-6 shadow-sm"
        >
          <h2 className="text-xl font-semibold">
            Registrar ausencia
          </h2>

          <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-5">

            <div>
              <label className="mb-2 block text-sm font-medium">
                Persona
              </label>

              <select
                value={
                  employeeId
                }
                onChange={(
                  event
                ) =>
                  setEmployeeId(
                    event.target
                      .value
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                {employees.map(
                  (
                    employee
                  ) => (
                    <option
                      key={
                        employee.id
                      }
                      value={
                        employee.id
                      }
                    >
                      {
                        employee.name
                      }
                    </option>
                  )
                )}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Tipo
              </label>

              <select
                value={
                  absenceType
                }
                onChange={(
                  event
                ) =>
                  setAbsenceType(
                    event.target
                      .value as AbsenceType
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                {Object.entries(
                  absenceLabels
                ).map(
                  ([
                    value,
                    label,
                  ]) => (
                    <option
                      key={
                        value
                      }
                      value={
                        value
                      }
                    >
                      {
                        label
                      }
                    </option>
                  )
                )}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Desde
              </label>

              <input
                type="date"
                value={
                  startDate
                }
                onChange={(
                  event
                ) => {
                  setStartDate(
                    event.target
                      .value
                  );

                  if (
                    event.target
                      .value >
                    endDate
                  ) {
                    setEndDate(
                      event.target
                        .value
                    );
                  }
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Hasta
              </label>

              <input
                type="date"
                min={
                  startDate
                }
                value={
                  endDate
                }
                onChange={(
                  event
                ) =>
                  setEndDate(
                    event.target
                      .value
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Observación
              </label>

              <input
                value={
                  notes
                }
                onChange={(
                  event
                ) =>
                  setNotes(
                    event.target
                      .value
                  )
                }
                placeholder="Opcional"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>

          </div>

          <button
            type="submit"
            disabled={
              saving
            }
            className="mt-6 rounded-lg bg-slate-900 px-5 py-2 font-medium text-white disabled:opacity-50"
          >
            {saving
              ? "Guardando..."
              : "Registrar ausencia"}
          </button>
        </form>

        {message && (
          <div className="mt-5 rounded-lg bg-white p-4 text-sm shadow-sm">
            {message}
          </div>
        )}

        {/* EDITAR */}

        {editing && (
          <section className="mt-8 rounded-xl border-2 border-slate-900 bg-white p-6">

            <h2 className="text-xl font-semibold">
              Editar ausencia
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              {getEmployeeName(
                editing
              )}
            </p>

            <div className="mt-5 grid gap-5 md:grid-cols-4">

              <select
                value={
                  editType
                }
                onChange={(
                  event
                ) =>
                  setEditType(
                    event.target
                      .value as AbsenceType
                  )
                }
                className="rounded-lg border border-slate-300 px-3 py-2"
              >
                {Object.entries(
                  absenceLabels
                ).map(
                  ([
                    value,
                    label,
                  ]) => (
                    <option
                      key={
                        value
                      }
                      value={
                        value
                      }
                    >
                      {
                        label
                      }
                    </option>
                  )
                )}
              </select>

              <input
                type="date"
                value={
                  editStartDate
                }
                onChange={(
                  event
                ) =>
                  setEditStartDate(
                    event.target
                      .value
                  )
                }
                className="rounded-lg border border-slate-300 px-3 py-2"
              />

              <input
                type="date"
                value={
                  editEndDate
                }
                min={
                  editStartDate
                }
                onChange={(
                  event
                ) =>
                  setEditEndDate(
                    event.target
                      .value
                  )
                }
                className="rounded-lg border border-slate-300 px-3 py-2"
              />

              <input
                value={
                  editNotes
                }
                onChange={(
                  event
                ) =>
                  setEditNotes(
                    event.target
                      .value
                  )
                }
                placeholder="Observación"
                className="rounded-lg border border-slate-300 px-3 py-2"
              />

            </div>

            <div className="mt-5 flex gap-3">

              <button
                type="button"
                onClick={
                  saveEdit
                }
                disabled={
                  saving
                }
                className="rounded-lg bg-slate-900 px-5 py-2 font-medium text-white disabled:opacity-50"
              >
                {saving
                  ? "Guardando..."
                  : "Guardar cambios"}
              </button>

              <button
                type="button"
                onClick={() =>
                  setEditing(
                    null
                  )
                }
                className="rounded-lg border border-slate-300 px-5 py-2"
              >
                Cancelar
              </button>

            </div>
          </section>
        )}

        {/* FILTROS */}

        <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">

          <h2 className="text-xl font-semibold">
            Consultar ausencias
          </h2>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">

            <div>
              <label className="mb-2 block text-sm font-medium">
                Año
              </label>

              <input
                type="number"
                value={
                  yearFilter
                }
                onChange={(
                  event
                ) =>
                  setYearFilter(
                    Number(
                      event.target
                        .value
                    )
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Persona
              </label>

              <select
                value={
                  employeeFilter
                }
                onChange={(
                  event
                ) =>
                  setEmployeeFilter(
                    event.target
                      .value
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="all">
                  Todas
                </option>

                {employees.map(
                  (
                    employee
                  ) => (
                    <option
                      key={
                        employee.id
                      }
                      value={
                        employee.id
                      }
                    >
                      {
                        employee.name
                      }
                    </option>
                  )
                )}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Tipo
              </label>

              <select
                value={
                  typeFilter
                }
                onChange={(
                  event
                ) =>
                  setTypeFilter(
                    event.target
                      .value as
                      | "all"
                      | AbsenceType
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="all">
                  Todos
                </option>

                {Object.entries(
                  absenceLabels
                ).map(
                  ([
                    value,
                    label,
                  ]) => (
                    <option
                      key={
                        value
                      }
                      value={
                        value
                      }
                    >
                      {
                        label
                      }
                    </option>
                  )
                )}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Estado
              </label>

              <select
                value={
                  statusFilter
                }
                onChange={(
                  event
                ) =>
                  setStatusFilter(
                    event.target
                      .value as StatusFilter
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="all">
                  Todos
                </option>

                <option value="current">
                  Actual
                </option>

                <option value="upcoming">
                  Próxima
                </option>

                <option value="finished">
                  Finalizada
                </option>
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Mes
              </label>

              <select
                value={
                  monthFilter
                }
                onChange={(
                  event
                ) =>
                  setMonthFilter(
                    Number(
                      event.target
                        .value
                    )
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                {monthNames.map(
                  (
                    month,
                    index
                  ) => (
                    <option
                      key={
                        index
                      }
                      value={
                        index
                      }
                    >
                      {
                        month
                      }
                    </option>
                  )
                )}
              </select>
            </div>

          </div>
        </section>

        {/* RESUMEN */}

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">

          <Summary
            title="Periodos"
            value={
              filteredPeriods.length
            }
          />

          <Summary
            title="Personas"
            value={
              peopleWithAbsences
            }
          />

          <Summary
            title="Ausencias actuales"
            value={
              currentCount
            }
          />

          <Summary
            title="Próximas"
            value={
              upcomingCount
            }
          />

        </div>

        {/* TABLA */}

        <section className="mt-6 overflow-x-auto rounded-xl bg-white shadow-sm">

          <table className="w-full text-left">

            <thead className="bg-slate-50">
              <tr>

                <th className="px-4 py-4">
                  Persona
                </th>

                <th className="px-4 py-4">
                  Tipo
                </th>

                <th className="px-4 py-4">
                  Desde
                </th>

                <th className="px-4 py-4">
                  Hasta
                </th>

                <th className="px-4 py-4">
                  Días
                </th>

                <th className="px-4 py-4">
                  Estado
                </th>

                <th className="px-4 py-4">
                  Observación
                </th>

                <th className="px-4 py-4">
                  Acciones
                </th>

              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">

              {filteredPeriods.length ===
              0 ? (
                <tr>

                  <td
                    colSpan={8}
                    className="px-6 py-10 text-center text-slate-500"
                  >
                    No hay ausencias con estos filtros.
                  </td>

                </tr>
              ) : (
                filteredPeriods.map(
                  (period) => (
                    <tr
                      key={
                        period.id
                      }
                    >

                      <td className="px-4 py-4 font-medium">
                        {getEmployeeName(
                          period
                        )}
                      </td>

                      <td className="px-4 py-4">
                        {
                          absenceLabels[
                            period
                              .absence_type
                          ]
                        }
                      </td>

                      <td className="px-4 py-4">
                        {formatDate(
                          period.start_date
                        )}
                      </td>

                      <td className="px-4 py-4">
                        {formatDate(
                          period.end_date
                        )}
                      </td>

                      <td className="px-4 py-4 font-semibold">
                        {countWorkingDays(
                          period.start_date,
                          period.end_date,
                          holidays
                        )}
                      </td>

                      <td className="px-4 py-4">
                        {statusLabel(
                          period
                        )}
                      </td>

                      <td className="px-4 py-4 text-sm text-slate-600">
                        {period.notes ??
                          "—"}
                      </td>

                      <td className="px-4 py-4">

                        <div className="flex gap-2">

                          <button
                            type="button"
                            onClick={() =>
                              startEdit(
                                period
                              )
                            }
                            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white"
                          >
                            Editar
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              deletePeriod(
                                period
                              )
                            }
                            className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700"
                          >
                            Eliminar
                          </button>

                        </div>

                      </td>

                    </tr>
                  )
                )
              )}

            </tbody>
          </table>
        </section>

      </div>
    </main>
  );
}

function Summary({
  title,
  value,
}: {
  title: string;
  value: number;
}) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">

      <p className="text-sm text-slate-500">
        {title}
      </p>

      <p className="mt-2 text-3xl font-bold text-slate-900">
        {value}
      </p>

    </div>
  );
}