"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { supabase } from "@/lib/supabase";

type WorkShift =
  | "morning"
  | "afternoon";

type Employee = {
  id: string;
  name: string;

  shift_mode:
    | "rotating"
    | "morning_fixed"
    | "night_fixed";

  rotation_group:
    | "A"
    | "B"
    | null;

  manager_type:
    | "none"
    | "afternoon_pool"
    | "morning_fixed";

  active: boolean;
};

type ManagerSetting = {
  rotation_group:
    | "A"
    | "B";

  starter_manager_id:
    | string
    | null;
};

function shiftLabel(
  shift: WorkShift | null
) {
  if (shift === "morning") {
    return "Mañana";
  }

  if (shift === "afternoon") {
    return "Tarde";
  }

  return "Sin configurar";
}

function oppositeShift(
  shift: WorkShift | null
) {
  if (shift === "morning") {
    return "Tarde";
  }

  if (shift === "afternoon") {
    return "Mañana";
  }

  return "Sin configurar";
}

export default function ConfiguracionPage() {
  const currentYear =
    new Date().getFullYear();

  const [
    employees,
    setEmployees,
  ] =
    useState<Employee[]>([]);

  const [
    managerSettings,
    setManagerSettings,
  ] =
    useState<
      ManagerSetting[]
    >([]);

  const [
    januaryShift,
    setJanuaryShift,
  ] =
    useState<
      WorkShift | null
    >(null);

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

  async function loadData() {
    setLoading(true);
    setMessage("");

    const [
      employeesResult,
      yearResult,
      managersResult,
    ] =
      await Promise.all([
        supabase
          .from(
            "employees"
          )
          .select(`
            id,
            name,
            shift_mode,
            rotation_group,
            manager_type,
            active
          `)
          .eq(
            "active",
            true
          )
          .order(
            "name"
          ),

        supabase
          .from(
            "year_shift_settings"
          )
          .select(
            "group_a_january_shift"
          )
          .eq(
            "year",
            currentYear
          )
          .maybeSingle(),

        supabase
          .from(
            "afternoon_manager_settings"
          )
          .select(`
            rotation_group,
            starter_manager_id
          `),
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
      yearResult.error
    ) {
      setMessage(
        "ERROR cargando configuración anual: " +
          yearResult
            .error.message
      );

      setLoading(false);
      return;
    }

    if (
      managersResult.error
    ) {
      setMessage(
        "ERROR cargando gestores: " +
          managersResult
            .error.message
      );

      setLoading(false);
      return;
    }

    setEmployees(
      (
        employeesResult.data ??
        []
      ) as Employee[]
    );

    setManagerSettings(
      (
        managersResult.data ??
        []
      ) as ManagerSetting[]
    );

    setJanuaryShift(
      yearResult.data
        ?.group_a_january_shift
        ? (
            yearResult.data
              .group_a_january_shift as WorkShift
          )
        : null
    );

    setLoading(false);
  }

  useEffect(() => {
    loadData();
  }, []);

  const groupA =
    employees.filter(
      (employee) =>
        employee.shift_mode ===
          "rotating" &&
        employee.rotation_group ===
          "A"
    );

  const groupB =
    employees.filter(
      (employee) =>
        employee.shift_mode ===
          "rotating" &&
        employee.rotation_group ===
          "B"
    );

  const nightEmployees =
    employees.filter(
      (employee) =>
        employee.shift_mode ===
        "night_fixed"
    );

  const fixedMorningManagers =
    employees.filter(
      (employee) =>
        employee.manager_type ===
        "morning_fixed"
    );

  const afternoonManagers =
    employees.filter(
      (employee) =>
        employee.manager_type ===
        "afternoon_pool"
    );

  function getStarterName(
    group: "A" | "B"
  ) {
    const setting =
      managerSettings.find(
        (item) =>
          item.rotation_group ===
          group
      );

    if (
      !setting
        ?.starter_manager_id
    ) {
      return "Sin configurar";
    }

    return (
      employees.find(
        (employee) =>
          employee.id ===
          setting
            .starter_manager_id
      )?.name ??
      "Sin configurar"
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-7xl">

        {/* CABECERA */}

        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            Configuración
          </h1>

          <p className="mt-2 text-slate-600">
            Resumen de las reglas y configuración de la planificación del almacén.
          </p>
        </div>

        {message && (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
            {message}
          </div>
        )}

        {loading ? (
          <p className="mt-8">
            Cargando configuración...
          </p>
        ) : (
          <>

            {/* RESUMEN GENERAL */}

            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">

              <SummaryCard
                title="Personal activo"
                value={
                  employees.length
                }
              />

              <SummaryCard
                title="Grupo A"
                value={
                  groupA.length
                }
              />

              <SummaryCard
                title="Grupo B"
                value={
                  groupB.length
                }
              />

              <SummaryCard
                title="Turno noche"
                value={
                  nightEmployees.length
                }
              />

            </div>

            {/* CONFIGURACIÓN ANUAL */}

            <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">

              <div className="flex flex-wrap items-center justify-between gap-4">

                <div>
                  <h2 className="text-xl font-semibold">
                    Rotación anual {currentYear}
                  </h2>

                  <p className="mt-1 text-sm text-slate-500">
                    Configuración utilizada para calcular los turnos de los Grupos A y B.
                  </p>
                </div>

                <Link
                  href="/calendario"
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
                >
                  Abrir calendario
                </Link>

              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">

                <InfoBox
                  title="Grupo A en enero"
                  value={
                    shiftLabel(
                      januaryShift
                    )
                  }
                />

                <InfoBox
                  title="Grupo B en enero"
                  value={
                    oppositeShift(
                      januaryShift
                    )
                  }
                />

              </div>

              <div className="mt-5 rounded-lg bg-slate-50 p-4">

                <p className="font-medium text-slate-800">
                  Cambio de mes
                </p>

                <p className="mt-1 text-sm text-slate-600">
                  La semana pertenece al mes que tenga 3 o más días entre lunes y viernes.
                </p>

              </div>

              <div className="mt-3 rounded-lg bg-slate-50 p-4">

                <p className="font-medium text-slate-800">
                  Regla especial de agosto
                </p>

                <p className="mt-1 text-sm text-slate-600">
                  Durante agosto los Grupos A y B intercambian mañana y tarde semanalmente.
                </p>

              </div>

            </section>

            {/* PERSONAL Y GESTORES */}

            <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">

              <div className="flex flex-wrap items-center justify-between gap-4">

                <div>
                  <h2 className="text-xl font-semibold">
                    Personal y gestores
                  </h2>

                  <p className="mt-1 text-sm text-slate-500">
                    Distribución actual del personal activo.
                  </p>
                </div>

                <Link
                  href="/personal"
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
                >
                  Gestionar personal
                </Link>

              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">

                <InfoBox
                  title="Grupo A"
                  value={`${groupA.length} personas`}
                />

                <InfoBox
                  title="Grupo B"
                  value={`${groupB.length} personas`}
                />

                <InfoBox
                  title="Noche fija"
                  value={`${nightEmployees.length} personas`}
                />

                <InfoBox
                  title="Gestor fijo mañana"
                  value={
                    fixedMorningManagers[0]
                      ?.name ??
                    "Sin configurar"
                  }
                />

              </div>

              <div className="mt-6 border-t border-slate-100 pt-6">

                <h3 className="font-semibold">
                  Gestores de tarde
                </h3>

                <p className="mt-1 text-sm text-slate-500">
                  Personal habilitado para cubrir el puesto de Gestor cuando su grupo está de tarde.
                </p>

                <div className="mt-4 grid gap-4 md:grid-cols-2">

                  <div className="rounded-lg border border-slate-200 p-4">

                    <p className="font-semibold">
                      Grupo A
                    </p>

                    <div className="mt-3 space-y-2">

                      {afternoonManagers
                        .filter(
                          (employee) =>
                            employee.rotation_group ===
                            "A"
                        )
                        .map(
                          (employee) => (
                            <p
                              key={
                                employee.id
                              }
                              className="text-sm"
                            >
                              {employee.name}
                            </p>
                          )
                        )}

                      {afternoonManagers.filter(
                        (employee) =>
                          employee.rotation_group ===
                          "A"
                      ).length ===
                        0 && (
                        <p className="text-sm text-red-600">
                          Sin gestores configurados
                        </p>
                      )}

                    </div>

                    <p className="mt-4 text-xs text-slate-500">
                      Gestor inicial:{" "}
                      <strong>
                        {getStarterName(
                          "A"
                        )}
                      </strong>
                    </p>

                  </div>

                  <div className="rounded-lg border border-slate-200 p-4">

                    <p className="font-semibold">
                      Grupo B
                    </p>

                    <div className="mt-3 space-y-2">

                      {afternoonManagers
                        .filter(
                          (employee) =>
                            employee.rotation_group ===
                            "B"
                        )
                        .map(
                          (employee) => (
                            <p
                              key={
                                employee.id
                              }
                              className="text-sm"
                            >
                              {employee.name}
                            </p>
                          )
                        )}

                      {afternoonManagers.filter(
                        (employee) =>
                          employee.rotation_group ===
                          "B"
                      ).length ===
                        0 && (
                        <p className="text-sm text-red-600">
                          Sin gestores configurados
                        </p>
                      )}

                    </div>

                    <p className="mt-4 text-xs text-slate-500">
                      Gestor inicial:{" "}
                      <strong>
                        {getStarterName(
                          "B"
                        )}
                      </strong>
                    </p>

                  </div>

                </div>

              </div>

            </section>

            {/* REGLAS DE PUESTOS */}

            <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">

              <h2 className="text-xl font-semibold">
                Rueda de puestos
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Reglas utilizadas automáticamente por la planificación diaria.
              </p>

              <div className="mt-6">

                <h3 className="font-semibold">
                  Mañana y tarde
                </h3>

                <div className="mt-3 flex flex-wrap items-center gap-2">

                  {[
                    "Mesa 1",
                    "Mesa 2",
                    "Mesa 3",
                    "Mesa 4",
                    "Entradas",
                    "Picking",
                  ].map(
                    (
                      position,
                      index,
                      array
                    ) => (
                      <div
                        key={
                          position
                        }
                        className="flex items-center gap-2"
                      >
                        <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium">
                          {position}
                        </span>

                        {index <
                          array.length -
                            1 && (
                          <span className="text-slate-400">
                            →
                          </span>
                        )}
                      </div>
                    )
                  )}

                  <span className="text-slate-400">
                    →
                  </span>

                  <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium">
                    Mesa 1
                  </span>

                </div>

              </div>

              <div className="mt-8">

                <h3 className="font-semibold">
                  Prioridad cuando falta personal
                </h3>

                <div className="mt-3 flex flex-wrap items-center gap-2">

                  {[
                    "Gestor",
                    "Entradas",
                    "Picking",
                    "Mesa 4",
                    "Mesa 3",
                    "Mesa 2",
                    "Mesa 1",
                  ].map(
                    (
                      position,
                      index,
                      array
                    ) => (
                      <div
                        key={
                          position
                        }
                        className="flex items-center gap-2"
                      >
                        <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium">
                          {position}
                        </span>

                        {index <
                          array.length -
                            1 && (
                          <span className="text-slate-400">
                            →
                          </span>
                        )}
                      </div>
                    )
                  )}

                </div>

                <p className="mt-3 text-sm text-slate-500">
                  Los puestos de menor prioridad quedan sin cubrir antes que los prioritarios.
                </p>

              </div>

              <div className="mt-8">

                <h3 className="font-semibold">
                  Turno de noche
                </h3>

                <p className="mt-2 text-sm text-slate-500">
                  Rueda teórica:
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2">

                  <RuleItem text="Picking" />
                  <Arrow />
                  <RuleItem text="Mesa 3" />
                  <Arrow />
                  <RuleItem text="Mesa 4" />
                  <Arrow />
                  <RuleItem text="Picking" />

                </div>

                <p className="mt-5 text-sm text-slate-500">
                  Prioridad real cuando falta personal:
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2">

                  <RuleItem text="Picking" />
                  <Arrow />
                  <RuleItem text="Mesa 4" />
                  <Arrow />
                  <RuleItem text="Mesa 3" />

                </div>

              </div>

            </section>

            {/* REGLAS ESPECIALES */}

            <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">

              <h2 className="text-xl font-semibold">
                Reglas especiales
              </h2>

              <div className="mt-5 grid gap-4 md:grid-cols-2">

                <RuleCard
                  title="Ausencias"
                  text="Las vacaciones, permisos y otras ausencias no detienen la rueda teórica del trabajador."
                />

                <RuleCard
                  title="Festivos"
                  text="Los sábados, domingos y días no laborables generales no hacen avanzar la rueda de puestos."
                />

                <RuleCard
                  title="Cambio de turno"
                  text="La persona sale de su turno habitual, entra en el nuevo turno y se considera siempre personal de refuerzo. La rueda teórica no cambia."
                />

                <RuleCard
                  title="Personal adicional"
                  text="Primer extra: Refuerzo Entradas. Segundo extra: Refuerzo Picking. Resto: Asignar tarea responsable."
                />

                <RuleCard
                  title="Gestor de mañana"
                  text="Si falta el Gestor fijo, lo sustituye un Gestor de tarde que esté trabajando de mañana, intentando equilibrar las sustituciones."
                />

                <RuleCard
                  title="Gestor de tarde"
                  text="Los dos gestores del grupo se reparten el puesto intentando equilibrar los días reales trabajados como Gestor durante el mes."
                />

              </div>

            </section>

            {/* ACCESOS */}

            <section className="mt-8">

              <h2 className="text-xl font-semibold">
                Gestión
              </h2>

              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">

                <NavigationCard
                  href="/personal"
                  title="Personal"
                  text="Trabajadores, grupos, gestores y referencias de rueda."
                />

                <NavigationCard
                  href="/calendario"
                  title="Calendario"
                  text="Turnos anuales, festivos y días no laborables."
                />

                <NavigationCard
                  href="/ausencias"
                  title="Ausencias"
                  text="Vacaciones, permisos y periodos de ausencia."
                />

                <NavigationCard
                  href="/planificacion"
                  title="Cambios de turno"
                  text="Cambios puntuales entre mañana, tarde y noche."
                />

                <NavigationCard
                  href="/configuracion/operativa"
                  title="Operativa"
                  text="Credenciales por código de barras y configuración de terminales."
                />

              </div>

            </section>

          </>
        )}

      </div>
    </main>
  );
}

function SummaryCard({
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

function InfoBox({
  title,
  value,
}: {
  title: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">

      <p className="text-sm text-slate-500">
        {title}
      </p>

      <p className="mt-1 font-semibold text-slate-900">
        {value}
      </p>

    </div>
  );
}

function RuleItem({
  text,
}: {
  text: string;
}) {
  return (
    <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium">
      {text}
    </span>
  );
}

function Arrow() {
  return (
    <span className="text-slate-400">
      →
    </span>
  );
}

function RuleCard({
  title,
  text,
}: {
  title: string;
  text: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-5">

      <p className="font-semibold text-slate-900">
        {title}
      </p>

      <p className="mt-2 text-sm leading-6 text-slate-600">
        {text}
      </p>

    </div>
  );
}

function NavigationCard({
  href,
  title,
  text,
}: {
  href: string;
  title: string;
  text: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >

      <p className="font-semibold text-slate-900">
        {title}
      </p>

      <p className="mt-2 text-sm leading-6 text-slate-500">
        {text}
      </p>

      <p className="mt-4 text-sm font-medium text-slate-900">
        Abrir →
      </p>

    </Link>
  );
}