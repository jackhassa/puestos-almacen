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

type Shift =
  | "morning"
  | "afternoon"
  | "night";

type ShiftChange = {
  id: string;
  employee_id: string;
  reinforcement_date: string;
  target_shift: Shift;
  notes: string | null;
};

type AssignmentCode =
  | "mesa1"
  | "mesa2"
  | "mesa3"
  | "mesa4"
  | "entradas"
  | "picking"
  | "reinforcement_entradas"
  | "reinforcement_picking"
  | "pending_task";

type DailyOverride = {
  id: string;
  employee_id: string;
  assignment_date: string;
  assignment_code: AssignmentCode;
  notes: string | null;
};

const shiftLabels: Record<
  Shift,
  string
> = {
  morning: "Mañana",
  afternoon: "Tarde",
  night: "Noche",
};

const assignmentLabels: Record<
  AssignmentCode,
  string
> = {
  mesa1: "Mesa 1",
  mesa2: "Mesa 2",
  mesa3: "Mesa 3",
  mesa4: "Mesa 4",
  entradas: "Entradas",
  picking: "Picking",
  reinforcement_entradas:
    "Refuerzo Entradas",
  reinforcement_picking:
    "Refuerzo Picking",
  pending_task:
    "Asignar tarea responsable",
};

function todayText() {
  const date =
    new Date();

  const year =
    date.getFullYear();

  const month =
    String(
      date.getMonth() + 1
    ).padStart(
      2,
      "0"
    );

  const day =
    String(
      date.getDate()
    ).padStart(
      2,
      "0"
    );

  return `${year}-${month}-${day}`;
}

function formatSpanishDate(
  value: string
) {
  const [
    year,
    month,
    day,
  ] = value.split("-");

  return `${day}/${month}/${year}`;
}

export default function PlanificacionPage() {
  const [
    employees,
    setEmployees,
  ] =
    useState<Employee[]>([]);

  const [
    shiftChanges,
    setShiftChanges,
  ] =
    useState<
      ShiftChange[]
    >([]);

  const [
    overrides,
    setOverrides,
  ] =
    useState<
      DailyOverride[]
    >([]);

  /*
   * CAMBIO DE TURNO
   */
  const [
    employeeId,
    setEmployeeId,
  ] =
    useState("");

  const [
    date,
    setDate,
  ] =
    useState(
      todayText()
    );

  const [
    targetShift,
    setTargetShift,
  ] =
    useState<Shift>(
      "afternoon"
    );

  const [
    notes,
    setNotes,
  ] =
    useState("");

  /*
   * AJUSTE MANUAL
   */
  const [
    overrideEmployeeId,
    setOverrideEmployeeId,
  ] =
    useState("");

  const [
    overrideDate,
    setOverrideDate,
  ] =
    useState(
      todayText()
    );

  const [
    assignmentCode,
    setAssignmentCode,
  ] =
    useState<AssignmentCode>(
      "reinforcement_entradas"
    );

  /*
   * FILTROS CAMBIOS
   */
  const [
    dateFilter,
    setDateFilter,
  ] =
    useState("");

  const [
    shiftFilter,
    setShiftFilter,
  ] =
    useState<
      "all" | Shift
    >("all");

  const [
    employeeFilter,
    setEmployeeFilter,
  ] =
    useState("all");

  /*
   * FILTROS AJUSTES
   */
  const [
    overrideDateFilter,
    setOverrideDateFilter,
  ] =
    useState("");

  const [
    overrideEmployeeFilter,
    setOverrideEmployeeFilter,
  ] =
    useState("all");

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
      changesResult,
      overridesResult,
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
            "shift_reinforcements"
          )
          .select(`
            id,
            employee_id,
            reinforcement_date,
            target_shift,
            notes
          `)
          .order(
            "reinforcement_date",
            {
              ascending:
                false,
            }
          ),

        supabase
          .from(
            "daily_assignment_overrides"
          )
          .select(`
            id,
            employee_id,
            assignment_date,
            assignment_code,
            notes
          `)
          .order(
            "assignment_date",
            {
              ascending:
                false,
            }
          ),
      ]);

    if (
      employeesResult.error
    ) {
      setMessage(
        "ERROR cargando personal: " +
          employeesResult
            .error.message
      );

      return;
    }

    if (
      changesResult.error
    ) {
      setMessage(
        "ERROR cargando cambios de turno: " +
          changesResult
            .error.message
      );

      return;
    }

    if (
      overridesResult.error
    ) {
      setMessage(
        "ERROR cargando ajustes manuales: " +
          overridesResult
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
      0
    ) {
      setEmployeeId(
        (previous) =>
          previous ||
          people[0].id
      );

      setOverrideEmployeeId(
        (previous) =>
          previous ||
          people[0].id
      );
    }

    setShiftChanges(
      (
        changesResult.data ??
        []
      ) as ShiftChange[]
    );

    setOverrides(
      (
        overridesResult.data ??
        []
      ) as DailyOverride[]
    );
  }

  useEffect(() => {
    loadData();
  }, []);

  function getEmployeeName(
    id: string
  ) {
    return (
      employees.find(
        (employee) =>
          employee.id ===
          id
      )?.name ??
      "Trabajador"
    );
  }

  /*
   * GUARDAR CAMBIO DE TURNO
   *
   * Una persona solo debería
   * tener un cambio de turno
   * para una misma fecha.
   *
   * Si ya existe uno, lo
   * actualizamos.
   */
  async function addShiftChange(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setMessage("");

    if (
      !employeeId
    ) {
      setMessage(
        "Selecciona una persona."
      );

      return;
    }

    if (!date) {
      setMessage(
        "Selecciona una fecha."
      );

      return;
    }

    setSaving(true);

    const existingResult =
      await supabase
        .from(
          "shift_reinforcements"
        )
        .select(
          "id"
        )
        .eq(
          "employee_id",
          employeeId
        )
        .eq(
          "reinforcement_date",
          date
        )
        .limit(1);

    if (
      existingResult.error
    ) {
      setMessage(
        "ERROR comprobando cambio de turno: " +
          existingResult
            .error.message
      );

      setSaving(false);

      return;
    }

    const existing =
      existingResult.data?.[0];

    let error = null;

    if (existing) {
      const result =
        await supabase
          .from(
            "shift_reinforcements"
          )
          .update({
            target_shift:
              targetShift,

            notes:
              notes.trim() ||
              null,
          })
          .eq(
            "id",
            existing.id
          );

      error =
        result.error;
    } else {
      const result =
        await supabase
          .from(
            "shift_reinforcements"
          )
          .insert({
            employee_id:
              employeeId,

            reinforcement_date:
              date,

            target_shift:
              targetShift,

            notes:
              notes.trim() ||
              null,
          });

      error =
        result.error;
    }

    if (error) {
      setMessage(
        "ERROR: " +
          error.message
      );

      setSaving(false);

      return;
    }

    setMessage(
      `${getEmployeeName(
        employeeId
      )}: cambio al turno de ${
        shiftLabels[
          targetShift
        ]
      } guardado para el ${formatSpanishDate(
        date
      )}.`
    );

    setNotes("");

    setSaving(false);

    await loadData();
  }

  async function deleteShiftChange(
    change: ShiftChange
  ) {
    const confirmed =
      window.confirm(
        `¿Eliminar el cambio de turno de ${getEmployeeName(
          change.employee_id
        )} del ${formatSpanishDate(
          change.reinforcement_date
        )}?`
      );

    if (!confirmed) {
      return;
    }

    const { error } =
      await supabase
        .from(
          "shift_reinforcements"
        )
        .delete()
        .eq(
          "id",
          change.id
        );

    if (error) {
      setMessage(
        "ERROR: " +
          error.message
      );

      return;
    }

    setMessage(
      "Cambio de turno eliminado."
    );

    await loadData();
  }

  /*
   * GUARDAR AJUSTE MANUAL
   *
   * UPSERT:
   *
   * Si ya hay un ajuste para
   * esa persona y fecha,
   * lo sustituimos.
   */
  async function saveOverride(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setMessage("");

    if (
      !overrideEmployeeId
    ) {
      setMessage(
        "Selecciona una persona."
      );

      return;
    }

    if (
      !overrideDate
    ) {
      setMessage(
        "Selecciona una fecha."
      );

      return;
    }

    setSaving(true);

    const { error } =
      await supabase
        .from(
          "daily_assignment_overrides"
        )
        .upsert(
          {
            employee_id:
              overrideEmployeeId,

            assignment_date:
              overrideDate,

            assignment_code:
              assignmentCode,

            notes:
              null,
          },
          {
            onConflict:
              "employee_id,assignment_date",
          }
        );

    if (error) {
      setMessage(
        "ERROR guardando ajuste manual: " +
          error.message
      );

      setSaving(false);

      return;
    }

    setMessage(
      `${getEmployeeName(
        overrideEmployeeId
      )}: ${
        assignmentLabels[
          assignmentCode
        ]
      } para el ${formatSpanishDate(
        overrideDate
      )}.`
    );

    setSaving(false);

    await loadData();
  }

  async function removeSelectedOverride() {
    if (
      !overrideEmployeeId ||
      !overrideDate
    ) {
      return;
    }

    const existing =
      overrides.find(
        (override) =>
          override.employee_id ===
            overrideEmployeeId &&
          override.assignment_date ===
            overrideDate
      );

    if (!existing) {
      setMessage(
        "No existe ningún ajuste manual para esa persona y fecha."
      );

      return;
    }

    await deleteOverride(
      existing,
      false
    );
  }

  async function deleteOverride(
    override: DailyOverride,
    askConfirmation = true
  ) {
    if (
      askConfirmation
    ) {
      const confirmed =
        window.confirm(
          `¿Quitar el ajuste manual de ${getEmployeeName(
            override.employee_id
          )} del ${formatSpanishDate(
            override.assignment_date
          )}? Volverá a utilizarse la asignación automática.`
        );

      if (!confirmed) {
        return;
      }
    }

    const { error } =
      await supabase
        .from(
          "daily_assignment_overrides"
        )
        .delete()
        .eq(
          "id",
          override.id
        );

    if (error) {
      setMessage(
        "ERROR eliminando ajuste manual: " +
          error.message
      );

      return;
    }

    setMessage(
      `${getEmployeeName(
        override.employee_id
      )}: vuelve a la asignación automática.`
    );

    await loadData();
  }

  const filteredChanges =
    useMemo(() => {
      return shiftChanges.filter(
        (change) => {
          if (
            dateFilter &&
            change.reinforcement_date !==
              dateFilter
          ) {
            return false;
          }

          if (
            shiftFilter !==
              "all" &&
            change.target_shift !==
              shiftFilter
          ) {
            return false;
          }

          if (
            employeeFilter !==
              "all" &&
            change.employee_id !==
              employeeFilter
          ) {
            return false;
          }

          return true;
        }
      );
    }, [
      shiftChanges,
      dateFilter,
      shiftFilter,
      employeeFilter,
    ]);

  const filteredOverrides =
    useMemo(() => {
      return overrides.filter(
        (override) => {
          if (
            overrideDateFilter &&
            override.assignment_date !==
              overrideDateFilter
          ) {
            return false;
          }

          if (
            overrideEmployeeFilter !==
              "all" &&
            override.employee_id !==
              overrideEmployeeFilter
          ) {
            return false;
          }

          return true;
        }
      );
    }, [
      overrides,
      overrideDateFilter,
      overrideEmployeeFilter,
    ]);

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-7xl">

        {/* CABECERA */}

        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            Planificación
          </h1>

          <p className="mt-2 text-slate-600">
            Cambios de turno y ajustes puntuales de la asignación diaria.
          </p>
        </div>

        {message && (
          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
            {message}
          </div>
        )}

        {/* =====================================================
            CAMBIOS DE TURNO
        ===================================================== */}

        <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">

          <h2 className="text-xl font-semibold">
            Cambios de turno
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            La persona sale de su turno habitual y entra como refuerzo en el nuevo turno.
          </p>

          <form
            onSubmit={
              addShiftChange
            }
            className="mt-6"
          >

            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">

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
                  Fecha
                </label>

                <input
                  type="date"
                  value={
                    date
                  }
                  onChange={(
                    event
                  ) =>
                    setDate(
                      event.target
                        .value
                    )
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium">
                  Nuevo turno
                </label>

                <select
                  value={
                    targetShift
                  }
                  onChange={(
                    event
                  ) =>
                    setTargetShift(
                      event.target
                        .value as Shift
                    )
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="morning">
                    Mañana
                  </option>

                  <option value="afternoon">
                    Tarde
                  </option>

                  <option value="night">
                    Noche
                  </option>
                </select>
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
              className="mt-5 rounded-lg bg-slate-900 px-5 py-2 font-medium text-white disabled:opacity-50"
            >
              Guardar cambio de turno
            </button>

          </form>

        </section>

        {/* =====================================================
            AJUSTES MANUALES
        ===================================================== */}

        <section className="mt-8 rounded-xl border-2 border-blue-200 bg-white p-6 shadow-sm">

          <div className="flex flex-wrap items-start justify-between gap-4">

            <div>

              <h2 className="text-xl font-semibold text-slate-900">
                Ajuste manual de puesto
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Permite corregir la asignación automática de una persona únicamente para un día.
              </p>

            </div>

            <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-700">
              No modifica la rueda
            </span>

          </div>

          <form
            onSubmit={
              saveOverride
            }
            className="mt-6"
          >

            <div className="grid gap-5 md:grid-cols-3">

              <div>
                <label className="mb-2 block text-sm font-medium">
                  Persona
                </label>

                <select
                  value={
                    overrideEmployeeId
                  }
                  onChange={(
                    event
                  ) =>
                    setOverrideEmployeeId(
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
                  Fecha
                </label>

                <input
                  type="date"
                  value={
                    overrideDate
                  }
                  onChange={(
                    event
                  ) =>
                    setOverrideDate(
                      event.target
                        .value
                    )
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium">
                  Asignación manual
                </label>

                <select
                  value={
                    assignmentCode
                  }
                  onChange={(
                    event
                  ) =>
                    setAssignmentCode(
                      event.target
                        .value as AssignmentCode
                    )
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >

                  <optgroup label="Puestos principales">
                    <option value="entradas">
                      Entradas
                    </option>

                    <option value="picking">
                      Picking
                    </option>

                    <option value="mesa4">
                      Mesa 4
                    </option>

                    <option value="mesa3">
                      Mesa 3
                    </option>

                    <option value="mesa2">
                      Mesa 2
                    </option>

                    <option value="mesa1">
                      Mesa 1
                    </option>
                  </optgroup>

                  <optgroup label="Refuerzos">
                    <option value="reinforcement_entradas">
                      Refuerzo Entradas
                    </option>

                    <option value="reinforcement_picking">
                      Refuerzo Picking
                    </option>
                  </optgroup>

                  <optgroup label="Otros">
                    <option value="pending_task">
                      Asignar tarea responsable
                    </option>
                  </optgroup>

                </select>
              </div>

            </div>

            <div className="mt-5 flex flex-wrap gap-3">

              <button
                type="submit"
                disabled={
                  saving
                }
                className="rounded-lg bg-blue-700 px-5 py-2 font-medium text-white disabled:opacity-50"
              >
                Guardar ajuste manual
              </button>

              <button
                type="button"
                onClick={
                  removeSelectedOverride
                }
                className="rounded-lg border border-slate-300 px-5 py-2 font-medium text-slate-700"
              >
                Volver a automático
              </button>

            </div>

          </form>

        </section>

        {/* =====================================================
            AJUSTES REGISTRADOS
        ===================================================== */}

        <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">

          <div className="flex flex-wrap items-center justify-between gap-4">

            <div>
              <h2 className="text-xl font-semibold">
                Ajustes manuales registrados
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                {
                  filteredOverrides.length
                }{" "}
                ajuste
                {filteredOverrides.length ===
                1
                  ? ""
                  : "s"}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setOverrideDateFilter(
                  ""
                );

                setOverrideEmployeeFilter(
                  "all"
                );
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm"
            >
              Limpiar filtros
            </button>

          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">

            <div>
              <label className="mb-2 block text-sm font-medium">
                Fecha
              </label>

              <input
                type="date"
                value={
                  overrideDateFilter
                }
                onChange={(
                  event
                ) =>
                  setOverrideDateFilter(
                    event.target
                      .value
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
                  overrideEmployeeFilter
                }
                onChange={(
                  event
                ) =>
                  setOverrideEmployeeFilter(
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

          </div>

          <div className="mt-6 overflow-x-auto">

            <table className="w-full text-left">

              <thead className="bg-slate-50">

                <tr>
                  <th className="px-4 py-4">
                    Fecha
                  </th>

                  <th className="px-4 py-4">
                    Persona
                  </th>

                  <th className="px-4 py-4">
                    Asignación manual
                  </th>

                  <th className="px-4 py-4">
                    Acción
                  </th>
                </tr>

              </thead>

              <tbody className="divide-y divide-slate-100">

                {filteredOverrides.length ===
                0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-6 py-8 text-center text-slate-500"
                    >
                      No hay ajustes manuales registrados.
                    </td>
                  </tr>
                ) : (
                  filteredOverrides.map(
                    (
                      override
                    ) => (
                      <tr
                        key={
                          override.id
                        }
                      >

                        <td className="px-4 py-4">
                          {formatSpanishDate(
                            override.assignment_date
                          )}
                        </td>

                        <td className="px-4 py-4 font-medium">
                          {getEmployeeName(
                            override.employee_id
                          )}
                        </td>

                        <td className="px-4 py-4">
                          <span className="rounded-lg bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700">
                            {
                              assignmentLabels[
                                override.assignment_code
                              ]
                            }
                          </span>
                        </td>

                        <td className="px-4 py-4">

                          <button
                            type="button"
                            onClick={() =>
                              deleteOverride(
                                override
                              )
                            }
                            className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700"
                          >
                            Volver a automático
                          </button>

                        </td>

                      </tr>
                    )
                  )
                )}

              </tbody>

            </table>

          </div>

        </section>

        {/* =====================================================
            CAMBIOS DE TURNO REGISTRADOS
        ===================================================== */}

        <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">

          <div className="flex flex-wrap items-center justify-between gap-4">

            <div>
              <h2 className="text-xl font-semibold">
                Cambios de turno registrados
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                {
                  filteredChanges.length
                }{" "}
                registro
                {filteredChanges.length ===
                1
                  ? ""
                  : "s"}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setDateFilter(
                  ""
                );

                setShiftFilter(
                  "all"
                );

                setEmployeeFilter(
                  "all"
                );
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm"
            >
              Limpiar filtros
            </button>

          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-3">

            <div>
              <label className="mb-2 block text-sm font-medium">
                Fecha
              </label>

              <input
                type="date"
                value={
                  dateFilter
                }
                onChange={(
                  event
                ) =>
                  setDateFilter(
                    event.target
                      .value
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Nuevo turno
              </label>

              <select
                value={
                  shiftFilter
                }
                onChange={(
                  event
                ) =>
                  setShiftFilter(
                    event.target
                      .value as
                      | "all"
                      | Shift
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="all">
                  Todos
                </option>

                <option value="morning">
                  Mañana
                </option>

                <option value="afternoon">
                  Tarde
                </option>

                <option value="night">
                  Noche
                </option>
              </select>
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

          </div>

          <div className="mt-6 overflow-x-auto">

            <table className="w-full text-left">

              <thead className="bg-slate-50">

                <tr>
                  <th className="px-4 py-4">
                    Fecha
                  </th>

                  <th className="px-4 py-4">
                    Persona
                  </th>

                  <th className="px-4 py-4">
                    Nuevo turno
                  </th>

                  <th className="px-4 py-4">
                    Observación
                  </th>

                  <th className="px-4 py-4">
                    Acción
                  </th>
                </tr>

              </thead>

              <tbody className="divide-y divide-slate-100">

                {filteredChanges.length ===
                0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-6 py-8 text-center text-slate-500"
                    >
                      No hay cambios de turno registrados.
                    </td>
                  </tr>
                ) : (
                  filteredChanges.map(
                    (
                      change
                    ) => (
                      <tr
                        key={
                          change.id
                        }
                      >

                        <td className="px-4 py-4">
                          {formatSpanishDate(
                            change.reinforcement_date
                          )}
                        </td>

                        <td className="px-4 py-4 font-medium">
                          {getEmployeeName(
                            change.employee_id
                          )}
                        </td>

                        <td className="px-4 py-4">
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium">
                            {
                              shiftLabels[
                                change.target_shift
                              ]
                            }
                          </span>
                        </td>

                        <td className="px-4 py-4 text-sm text-slate-600">
                          {change.notes ??
                            "—"}
                        </td>

                        <td className="px-4 py-4">

                          <button
                            type="button"
                            onClick={() =>
                              deleteShiftChange(
                                change
                              )
                            }
                            className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700"
                          >
                            Eliminar
                          </button>

                        </td>

                      </tr>
                    )
                  )
                )}

              </tbody>

            </table>

          </div>

        </section>

      </div>
    </main>
  );
}