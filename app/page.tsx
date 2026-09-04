"use client";

import Link from "next/link";
import {
  useEffect,
  useState,
} from "react";

import { supabase } from "@/lib/supabase";

type DashboardData = {
  activeEmployees: number;
  absencesToday: number;
  shiftChangesToday: number;
  nonWorkingDay:
    | string
    | null;
};

function getTodayText() {
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

function formatToday() {
  const date =
    new Date();

  return new Intl.DateTimeFormat(
    "es-ES",
    {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }
  ).format(date);
}

export default function HomePage() {
  const today =
    getTodayText();

  const [
    data,
    setData,
  ] =
    useState<DashboardData>({
      activeEmployees: 0,
      absencesToday: 0,
      shiftChangesToday: 0,
      nonWorkingDay: null,
    });

  const [
    loading,
    setLoading,
  ] =
    useState(true);

  const [
    message,
    setMessage,
  ] =
    useState("");

  async function loadDashboard() {
    setLoading(true);
    setMessage("");

    const [
      employeesResult,
      absencesResult,
      changesResult,
      nonWorkingResult,
    ] =
      await Promise.all([
        /*
         * Personal activo.
         */
        supabase
          .from(
            "employees"
          )
          .select(
            "id"
          )
          .eq(
            "active",
            true
          ),

        /*
         * Ausencias que afectan
         * al día actual.
         */
        supabase
          .from(
            "absence_periods"
          )
          .select(
            "employee_id"
          )
          .lte(
            "start_date",
            today
          )
          .gte(
            "end_date",
            today
          ),

        /*
         * Cambios de turno
         * programados para hoy.
         */
        supabase
          .from(
            "shift_reinforcements"
          )
          .select(
            "id"
          )
          .eq(
            "reinforcement_date",
            today
          ),

        /*
         * Comprobamos si hoy
         * está marcado como
         * día no laborable.
         */
        supabase
          .from(
            "non_working_days"
          )
          .select(
            "description"
          )
          .eq(
            "date",
            today
          )
          .maybeSingle(),
      ]);

    if (
      employeesResult.error
    ) {
      setMessage(
        "ERROR cargando personal: " +
          employeesResult
            .error.message
      );

      setLoading(false);
      return;
    }

    if (
      absencesResult.error
    ) {
      setMessage(
        "ERROR cargando ausencias: " +
          absencesResult
            .error.message
      );

      setLoading(false);
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

      setLoading(false);
      return;
    }

    if (
      nonWorkingResult.error
    ) {
      setMessage(
        "ERROR cargando calendario: " +
          nonWorkingResult
            .error.message
      );

      setLoading(false);
      return;
    }

    /*
     * Evitamos contar dos veces
     * una persona si por error
     * tuviera dos periodos de
     * ausencia coincidentes.
     */
    const absentPeople =
      new Set(
        (
          absencesResult.data ??
          []
        ).map(
          (item) =>
            item.employee_id
        )
      );

    setData({
      activeEmployees:
        employeesResult.data
          ?.length ??
        0,

      absencesToday:
        absentPeople.size,

      shiftChangesToday:
        changesResult.data
          ?.length ??
        0,

      nonWorkingDay:
        nonWorkingResult.data
          ?.description ??
        null,
    });

    setLoading(false);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDashboard();
    }, 0);

    return () => window.clearTimeout(timer);
    // loadDashboard usa únicamente setters de React y el cliente Supabase estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-7xl p-6 md:p-8">

        {/* CABECERA */}

        <header className="overflow-hidden rounded-2xl bg-slate-900 p-6 text-white shadow-sm md:p-8">

          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">

            <div>

              <p className="text-sm font-medium uppercase tracking-wider text-slate-300">
                Planificación de almacén
              </p>

              <h1 className="mt-2 text-3xl font-bold md:text-4xl">
                Puestos Almacén
              </h1>

              <p className="mt-3 capitalize text-slate-300">
                {formatToday()}
              </p>

            </div>

            <Link
              href="/hoy"
              className="inline-flex items-center justify-center rounded-xl bg-white px-6 py-4 font-semibold text-slate-900 transition hover:bg-slate-100"
            >
              Ver planificación de hoy →
            </Link>

          </div>

        </header>

        {/* MENSAJE */}

        {message && (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
            {message}
          </div>
        )}

        {/* ESTADO DEL DÍA */}

        <section className="mt-8">

          <div className="flex flex-wrap items-end justify-between gap-3">

            <div>
              <h2 className="text-xl font-semibold text-slate-900">
                Estado de hoy
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Resumen rápido antes de abrir la planificación.
              </p>
            </div>

            <Link
              href="/hoy"
              className="text-sm font-semibold text-slate-700 hover:text-slate-900"
            >
              Abrir detalle →
            </Link>

          </div>

          {loading ? (
            <div className="mt-5 rounded-xl bg-white p-6 shadow-sm">
              Cargando resumen...
            </div>
          ) : (
            <>

              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">

                <StatusCard
                  title="Personal activo"
                  value={
                    data.activeEmployees
                  }
                  text="Personas disponibles en plantilla"
                />

                <StatusCard
                  title="Ausencias hoy"
                  value={
                    data.absencesToday
                  }
                  text={
                    data.absencesToday ===
                    0
                      ? "Sin ausencias registradas"
                      : "Revisar cobertura de puestos"
                  }
                  alert={
                    data.absencesToday >
                    0
                  }
                />

                <StatusCard
                  title="Cambios de turno"
                  value={
                    data.shiftChangesToday
                  }
                  text={
                    data.shiftChangesToday ===
                    0
                      ? "Sin cambios programados"
                      : "Cambios previstos para hoy"
                  }
                  info={
                    data.shiftChangesToday >
                    0
                  }
                />

                <StatusCard
                  title="Calendario"
                  value={
                    data.nonWorkingDay
                      ? "No laborable"
                      : "Laborable"
                  }
                  text={
                    data.nonWorkingDay ??
                    "Jornada ordinaria"
                  }
                  alert={
                    Boolean(
                      data.nonWorkingDay
                    )
                  }
                />

              </div>

              {data.nonWorkingDay && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">

                  <p className="font-semibold text-amber-800">
                    Día no laborable
                  </p>

                  <p className="mt-1 text-sm text-amber-700">
                    {
                      data.nonWorkingDay
                    }
                  </p>

                </div>
              )}

            </>
          )}

        </section>

        {/* ACCESOS PRINCIPALES */}

        <section className="mt-10">

          <h2 className="text-xl font-semibold text-slate-900">
            Gestión
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            Acceso directo a las áreas de trabajo.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">

            <ModuleCard
              href="/hoy"
              number="01"
              title="Planificación diaria"
              text="Consulta quién trabaja hoy, el puesto asignado, cambios de turno y puestos sin cubrir."
              primary
            />

            <ModuleCard
              href="/personal"
              number="02"
              title="Personal"
              text="Alta y gestión de trabajadores, grupos, gestores y referencias de la rueda."
            />

            <ModuleCard
              href="/ausencias"
              number="03"
              title="Ausencias"
              text="Registra vacaciones, permisos, bajas y otros periodos de ausencia."
            />

            <ModuleCard
              href="/planificacion"
              number="04"
              title="Cambios de turno"
              text="Gestiona cambios puntuales entre los turnos de mañana, tarde y noche."
            />

            <ModuleCard
              href="/calendario"
              number="05"
              title="Calendario"
              text="Configura la rotación anual y los días no laborables."
            />

            <ModuleCard
              href="/configuracion"
              number="06"
              title="Configuración"
              text="Consulta las reglas utilizadas por el motor de planificación."
            />

            <ModuleCard
              href="/terminal"
              number="07"
              title="Terminal operario"
              text="Acceso de operarios mediante códigos de barras para iniciar jornada, cambiar tarea y pausas."
            />

            <ModuleCard
              href="/configuracion/operativa"
              number="08"
              title="Configuración operativa"
              text="Configura credenciales, carros, PCs fijos, terminales RF y códigos de ubicación."
            />

            <ModuleCard
              href="/gestor"
              number="09"
              title="Panel del gestor"
              text="Monitoriza en tiempo real Entradas, Picking y las mesas operativas."
            />

            <ModuleCard
              href="/estadisticas"
              number="10"
              title="Estadísticas"
              text="Analiza horas, pausas, productividad, Picking y Expedición por trabajador, puesto y periodo."
            />

          </div>

        </section>

        {/* REGLAS RÁPIDAS */}

        <section className="mt-10 rounded-2xl bg-white p-6 shadow-sm">

          <div className="flex flex-wrap items-center justify-between gap-4">

            <div>

              <h2 className="text-xl font-semibold text-slate-900">
                Reglas rápidas
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Principios principales de la planificación automática.
              </p>

            </div>

            <Link
              href="/configuracion"
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Ver todas las reglas
            </Link>

          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-3">

            <QuickRule
              number="1"
              title="La rueda continúa"
              text="Las ausencias y los cambios de turno no modifican la posición teórica futura."
            />

            <QuickRule
              number="2"
              title="Prioridad de cobertura"
              text="Gestor, Entradas y Picking tienen prioridad cuando falta personal."
            />

            <QuickRule
              number="3"
              title="Cambio de turno"
              text="La persona sale de su turno habitual y entra como refuerzo en el nuevo turno."
            />

          </div>

        </section>

        {/* PIE */}

        <footer className="mt-10 border-t border-slate-200 py-6 text-center text-sm text-slate-400">
          Puestos Almacén
        </footer>

      </div>
    </main>
  );
}

function StatusCard({
  title,
  value,
  text,
  alert = false,
  info = false,
}: {
  title: string;
  value:
    | number
    | string;
  text: string;
  alert?: boolean;
  info?: boolean;
}) {
  const cardClass =
    "rounded-xl border bg-white p-5 shadow-sm";

  let borderClass =
    "border-slate-200";

  let valueClass =
    "text-slate-900";

  if (alert) {
    borderClass =
      "border-amber-200";

    valueClass =
      "text-amber-700";
  }

  if (info) {
    borderClass =
      "border-blue-200";

    valueClass =
      "text-blue-700";
  }

  return (
    <div
      className={`${cardClass} ${borderClass}`}
    >

      <p className="text-sm font-medium text-slate-500">
        {title}
      </p>

      <p
        className={`mt-2 text-3xl font-bold ${valueClass}`}
      >
        {value}
      </p>

      <p className="mt-2 text-sm text-slate-500">
        {text}
      </p>

    </div>
  );
}

function ModuleCard({
  href,
  number,
  title,
  text,
  primary = false,
}: {
  href: string;
  number: string;
  title: string;
  text: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        primary
          ? "group rounded-2xl bg-slate-900 p-6 text-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          : "group rounded-2xl bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
      }
    >

      <div className="flex items-start justify-between gap-4">

        <span
          className={
            primary
              ? "text-sm font-semibold text-slate-400"
              : "text-sm font-semibold text-slate-400"
          }
        >
          {number}
        </span>

        <span
          className={
            primary
              ? "text-white"
              : "text-slate-400 group-hover:text-slate-900"
          }
        >
          →
        </span>

      </div>

      <h3
        className={
          primary
            ? "mt-8 text-xl font-semibold text-white"
            : "mt-8 text-xl font-semibold text-slate-900"
        }
      >
        {title}
      </h3>

      <p
        className={
          primary
            ? "mt-3 text-sm leading-6 text-slate-300"
            : "mt-3 text-sm leading-6 text-slate-500"
        }
      >
        {text}
      </p>

    </Link>
  );
}

function QuickRule({
  number,
  title,
  text,
}: {
  number: string;
  title: string;
  text: string;
}) {
  return (
    <div className="rounded-xl bg-slate-50 p-5">

      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-sm font-bold text-white">
        {number}
      </div>

      <h3 className="mt-4 font-semibold text-slate-900">
        {title}
      </h3>

      <p className="mt-2 text-sm leading-6 text-slate-600">
        {text}
      </p>

    </div>
  );
}