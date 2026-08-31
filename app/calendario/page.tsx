"use client";

import { FormEvent, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Shift = "morning" | "afternoon";

type NonWorkingDay = {
  id: string;
  date: string;
  description: string | null;
};

const monthNames = [
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

function oppositeShift(shift: Shift): Shift {
  return shift === "morning"
    ? "afternoon"
    : "morning";
}

function shiftLabel(shift: Shift) {
  return shift === "morning"
    ? "Mañana"
    : "Tarde";
}

function formatSpanishDate(value: string) {
  const [year, month, day] = value.split("-");

  return `${day}/${month}/${year}`;
}

export default function CalendarioPage() {
  const currentYear = new Date().getFullYear();

  const [year, setYear] =
    useState(currentYear);

  const [januaryShift, setJanuaryShift] =
    useState<Shift>("morning");

  const [yearConfigured, setYearConfigured] =
    useState(false);

  const [nonWorkingDays, setNonWorkingDays] =
    useState<NonWorkingDay[]>([]);

  const [newDate, setNewDate] =
    useState("");

  const [description, setDescription] =
    useState("");

  const [message, setMessage] =
    useState("");

  const [loading, setLoading] =
    useState(true);

  async function loadCalendar() {
    setLoading(true);
    setMessage("");

    const yearResult = await supabase
      .from("year_shift_settings")
      .select("group_a_january_shift")
      .eq("year", year)
      .maybeSingle();

    if (yearResult.error) {
      setMessage(
        "ERROR cargando configuración: " +
          yearResult.error.message
      );

      setLoading(false);
      return;
    }

    if (yearResult.data) {
      setJanuaryShift(
        yearResult.data
          .group_a_january_shift as Shift
      );

      setYearConfigured(true);
    } else {
      setJanuaryShift("morning");
      setYearConfigured(false);
    }

    const daysResult = await supabase
      .from("non_working_days")
      .select("*")
      .gte("date", `${year}-01-01`)
      .lte("date", `${year}-12-31`)
      .order("date");

    if (daysResult.error) {
      setMessage(
        "ERROR cargando días no laborables: " +
          daysResult.error.message
      );

      setLoading(false);
      return;
    }

    setNonWorkingDays(
      (daysResult.data ?? []) as NonWorkingDay[]
    );

    setLoading(false);
  }

  useEffect(() => {
    loadCalendar();
  }, [year]);

  async function saveYearSettings() {
    setMessage("");

    const { error } = await supabase
      .from("year_shift_settings")
      .upsert(
        {
          year,
          group_a_january_shift:
            januaryShift,
        },
        {
          onConflict: "year",
        }
      );

    if (error) {
      setMessage(
        "ERROR: " + error.message
      );

      return;
    }

    setYearConfigured(true);

    setMessage(
      `Calendario ${year} guardado correctamente.`
    );
  }

  async function addNonWorkingDay(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setMessage("");

    if (!newDate) {
      setMessage(
        "Debes indicar una fecha."
      );

      return;
    }

    const { error } = await supabase
      .from("non_working_days")
      .insert({
        date: newDate,
        description:
          description.trim() || null,
      });

    if (error) {
      if (error.code === "23505") {
        setMessage(
          "Esa fecha ya está registrada."
        );
      } else {
        setMessage(
          "ERROR: " + error.message
        );
      }

      return;
    }

    setNewDate("");
    setDescription("");

    setMessage(
      "Día no laborable añadido."
    );

    await loadCalendar();
  }

  async function deleteNonWorkingDay(
    id: string
  ) {
    const confirmed = window.confirm(
      "¿Eliminar este día no laborable?"
    );

    if (!confirmed) return;

    const { error } = await supabase
      .from("non_working_days")
      .delete()
      .eq("id", id);

    if (error) {
      setMessage(
        "ERROR: " + error.message
      );

      return;
    }

    setMessage(
      "Día eliminado."
    );

    await loadCalendar();
  }

  function getMonthShift(
    monthIndex: number
  ): Shift {
    if (monthIndex % 2 === 0) {
      return januaryShift;
    }

    return oppositeShift(
      januaryShift
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-7xl">

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">
              Calendario laboral
            </h1>

            <p className="mt-2 text-slate-600">
              Turnos anuales, festivos y días no laborables.
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium">
              Año
            </label>

            <input
              type="number"
              min="2020"
              max="2100"
              value={year}
              onChange={(event) =>
                setYear(
                  Number(
                    event.target.value
                  )
                )
              }
              className="w-32 rounded-lg border border-slate-300 bg-white px-4 py-2"
            />
          </div>
        </div>

        {message && (
          <div className="mt-6 rounded-lg bg-white p-4 text-sm shadow-sm">
            {message}
          </div>
        )}

        {loading ? (
          <p className="mt-8">
            Cargando calendario...
          </p>
        ) : (
          <>
            {/* CONFIGURACIÓN ANUAL */}

            <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold">
                    Rotación {year}
                  </h2>

                  <p className="mt-1 text-sm text-slate-500">
                    Define únicamente cómo empieza enero.
                  </p>
                </div>

                <span
                  className={
                    yearConfigured
                      ? "rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-700"
                      : "rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-700"
                  }
                >
                  {yearConfigured
                    ? "Configurado"
                    : "Pendiente"}
                </span>
              </div>

              <div className="mt-6 grid gap-5 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Grupo A empieza enero de
                  </label>

                  <select
                    value={januaryShift}
                    onChange={(event) =>
                      setJanuaryShift(
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
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Grupo B empieza enero de
                  </label>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    {shiftLabel(
                      oppositeShift(
                        januaryShift
                      )
                    )}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={saveYearSettings}
                className="mt-6 rounded-lg bg-slate-900 px-5 py-2 font-medium text-white"
              >
                Guardar configuración anual
              </button>
            </section>

            {/* RESUMEN DE TURNOS */}

            <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold">
                Resumen de turnos
              </h2>

              <div className="mt-5 overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3">
                        Mes
                      </th>

                      <th className="px-4 py-3">
                        Grupo A
                      </th>

                      <th className="px-4 py-3">
                        Grupo B
                      </th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-100">
                    {monthNames.map(
                      (month, index) => {
                        const groupA =
                          getMonthShift(
                            index
                          );

                        const groupB =
                          oppositeShift(
                            groupA
                          );

                        return (
                          <tr key={month}>
                            <td className="px-4 py-3 font-medium">
                              {month}
                            </td>

                            {index === 7 ? (
                              <>
                                <td className="px-4 py-3 font-semibold">
                                  Rotación semanal
                                </td>

                                <td className="px-4 py-3 font-semibold">
                                  Rotación semanal
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="px-4 py-3">
                                  {shiftLabel(
                                    groupA
                                  )}
                                </td>

                                <td className="px-4 py-3">
                                  {shiftLabel(
                                    groupB
                                  )}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      }
                    )}
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-sm text-slate-500">
                Los cambios de mes se calculan por semanas
                de lunes a viernes. La semana pertenece al
                mes que tenga al menos 3 de los 5 días.
              </p>

              <p className="mt-1 text-sm text-slate-500">
                En agosto el cambio de mañana/tarde se realiza
                semanalmente.
              </p>
            </section>

            {/* DÍAS NO LABORABLES */}

            <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold">
                Festivos y días no laborables
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Estos días no hacen avanzar la rueda de puestos.
              </p>

              <form
                onSubmit={addNonWorkingDay}
                className="mt-6 grid gap-4 md:grid-cols-[200px_1fr_auto]"
              >
                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Fecha
                  </label>

                  <input
                    type="date"
                    value={newDate}
                    onChange={(event) =>
                      setNewDate(
                        event.target.value
                      )
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Descripción
                  </label>

                  <input
                    value={description}
                    onChange={(event) =>
                      setDescription(
                        event.target.value
                      )
                    }
                    placeholder="Ej. Festivo local"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>

                <div className="flex items-end">
                  <button
                    type="submit"
                    className="rounded-lg bg-slate-900 px-5 py-2 font-medium text-white"
                  >
                    Añadir
                  </button>
                </div>
              </form>

              <div className="mt-6 overflow-hidden rounded-lg border border-slate-200">
                {nonWorkingDays.length ===
                0 ? (
                  <p className="p-6 text-slate-500">
                    No hay días no laborables registrados para {year}.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {nonWorkingDays.map(
                      (day) => (
                        <div
                          key={day.id}
                          className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
                        >
                          <div>
                            <p className="font-medium">
                              {formatSpanishDate(
                                day.date
                              )}
                            </p>

                            <p className="mt-1 text-sm text-slate-500">
                              {day.description ??
                                "Día no laborable"}
                            </p>
                          </div>

                          <button
                            type="button"
                            onClick={() =>
                              deleteNonWorkingDay(
                                day.id
                              )
                            }
                            className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700"
                          >
                            Eliminar
                          </button>
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}