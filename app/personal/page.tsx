"use client";

import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { supabase } from "@/lib/supabase";

type ShiftMode =
  | "rotating"
  | "morning_fixed"
  | "night_fixed";

type ManagerType =
  | "none"
  | "afternoon_pool"
  | "morning_fixed";

type Position =
  | "mesa1"
  | "mesa2"
  | "mesa3"
  | "mesa4"
  | "entradas"
  | "picking";

type Employee = {
  id: string;
  name: string;
  shift_mode: ShiftMode;
  rotation_group: "A" | "B" | null;
  manager_type: ManagerType;
  rotation_reference_date: string | null;
  rotation_reference_position: Position | null;
  photo_url: string | null;
  active: boolean;
};

type ManagerSetting = {
  rotation_group: "A" | "B";
  starter_manager_id: string | null;
};

type Filter =
  | "all"
  | "A"
  | "B"
  | "morning"
  | "night"
  | "inactive";

const normalPositions: {
  value: Position;
  label: string;
}[] = [
  { value: "mesa1", label: "Mesa 1" },
  { value: "mesa2", label: "Mesa 2" },
  { value: "mesa3", label: "Mesa 3" },
  { value: "mesa4", label: "Mesa 4" },
  { value: "entradas", label: "Entradas" },
  { value: "picking", label: "Picking" },
];

const nightPositions: {
  value: Position;
  label: string;
}[] = [
  { value: "picking", label: "Picking" },
  { value: "mesa3", label: "Mesa 3" },
  { value: "mesa4", label: "Mesa 4" },
];

function positionLabel(position: Position | null) {
  if (!position) return "—";

  return (
    normalPositions.find(
      (item) => item.value === position
    )?.label ?? position
  );
}

export default function PersonalPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [managerSettings, setManagerSettings] =
    useState<ManagerSetting[]>([]);

  const [filter, setFilter] = useState<Filter>("all");

  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const editRef = useRef<HTMLDivElement | null>(null);

  // NUEVO TRABAJADOR
  const [name, setName] = useState("");
  const [shiftMode, setShiftMode] =
    useState<ShiftMode>("rotating");
  const [rotationGroup, setRotationGroup] =
    useState<"A" | "B">("A");
  const [afternoonManager, setAfternoonManager] =
    useState(false);
  const [referenceDate, setReferenceDate] = useState("");
  const [referencePosition, setReferencePosition] =
    useState<Position>("mesa1");
  const [photo, setPhoto] = useState<File | null>(null);

  // EDICIÓN
  const [editing, setEditing] =
    useState<Employee | null>(null);

  const [editName, setEditName] = useState("");
  const [editShiftMode, setEditShiftMode] =
    useState<ShiftMode>("rotating");
  const [editRotationGroup, setEditRotationGroup] =
    useState<"A" | "B">("A");
  const [editAfternoonManager, setEditAfternoonManager] =
    useState(false);
  const [editReferenceDate, setEditReferenceDate] =
    useState("");
  const [editReferencePosition, setEditReferencePosition] =
    useState<Position>("mesa1");
  const [editPhoto, setEditPhoto] =
    useState<File | null>(null);

  async function loadEmployees() {
    const { data, error } = await supabase
      .from("employees")
      .select("*")
      .order("active", { ascending: false })
      .order("name");

    if (error) {
      setMessage("ERROR: " + error.message);
      return;
    }

    setEmployees((data ?? []) as Employee[]);
  }

  async function loadManagerSettings() {
    const { data, error } = await supabase
      .from("afternoon_manager_settings")
      .select(
        "rotation_group, starter_manager_id"
      );

    if (error) {
      setMessage("ERROR: " + error.message);
      return;
    }

    setManagerSettings(
      (data ?? []) as ManagerSetting[]
    );
  }

  useEffect(() => {
    loadEmployees();
    loadManagerSettings();
  }, []);

  const filteredEmployees = useMemo(() => {
    if (filter === "all") {
      return employees.filter(
        (employee) => employee.active
      );
    }

    if (filter === "A") {
      return employees.filter(
        (employee) =>
          employee.active &&
          employee.rotation_group === "A"
      );
    }

    if (filter === "B") {
      return employees.filter(
        (employee) =>
          employee.active &&
          employee.rotation_group === "B"
      );
    }

    if (filter === "morning") {
      return employees.filter(
        (employee) =>
          employee.active &&
          employee.shift_mode === "morning_fixed"
      );
    }

    if (filter === "night") {
      return employees.filter(
        (employee) =>
          employee.active &&
          employee.shift_mode === "night_fixed"
      );
    }

    return employees.filter(
      (employee) => !employee.active
    );
  }, [employees, filter]);

  function validatePhoto(file: File) {
    if (!file.type.startsWith("image/")) {
      setMessage("La foto debe ser una imagen.");
      return false;
    }

    if (file.size > 5 * 1024 * 1024) {
      setMessage(
        "La fotografía no puede superar los 5 MB."
      );
      return false;
    }

    return true;
  }

  function handlePhoto(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];

    if (!file) return;

    if (!validatePhoto(file)) {
      event.target.value = "";
      return;
    }

    setPhoto(file);
  }

  function handleEditPhoto(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];

    if (!file) return;

    if (!validatePhoto(file)) {
      event.target.value = "";
      return;
    }

    setEditPhoto(file);
  }

  async function uploadPhoto(
    employeeId: string,
    file: File
  ) {
    const path = `${employeeId}/profile`;

    const { error } = await supabase.storage
      .from("employee-photos")
      .upload(path, file, {
        upsert: true,
        contentType: file.type,
        cacheControl: "60",
      });

    if (error) {
      throw error;
    }

    const { data } = supabase.storage
      .from("employee-photos")
      .getPublicUrl(path);

    return `${data.publicUrl}?v=${Date.now()}`;
  }

  function changeShiftMode(value: ShiftMode) {
    setShiftMode(value);

    if (value === "night_fixed") {
      setReferencePosition("picking");
      setAfternoonManager(false);
    }

    if (value === "morning_fixed") {
      setReferenceDate("");
      setAfternoonManager(false);
    }

    if (value === "rotating") {
      setReferencePosition("mesa1");
    }
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    setMessage("");

    if (!name.trim()) {
      setMessage("Debes indicar el nombre.");
      return;
    }

    if (
      shiftMode !== "morning_fixed" &&
      !referenceDate
    ) {
      setMessage(
        "Debes indicar la fecha de referencia."
      );
      return;
    }

    setSaving(true);

    let managerType: ManagerType = "none";

    if (shiftMode === "morning_fixed") {
      managerType = "morning_fixed";
    }

    if (
      shiftMode === "rotating" &&
      afternoonManager
    ) {
      managerType = "afternoon_pool";
    }

    const { data, error } = await supabase
      .from("employees")
      .insert({
        name: name.trim(),
        shift_mode: shiftMode,
        rotation_group:
          shiftMode === "rotating"
            ? rotationGroup
            : null,
        manager_type: managerType,
        rotation_reference_date:
          shiftMode === "morning_fixed"
            ? null
            : referenceDate,
        rotation_reference_position:
          shiftMode === "morning_fixed"
            ? null
            : referencePosition,
        active: true,
      })
      .select("id")
      .single();

    if (error || !data) {
      setMessage(
        "ERROR: " +
          (error?.message ??
            "No se pudo crear el trabajador.")
      );

      setSaving(false);
      return;
    }

    if (photo) {
      try {
        const photoUrl = await uploadPhoto(
          data.id,
          photo
        );

        await supabase
          .from("employees")
          .update({
            photo_url: photoUrl,
          })
          .eq("id", data.id);
      } catch (error) {
        setMessage(
          "Trabajador creado, pero hubo un problema con la foto."
        );
      }
    }

    setName("");
    setShiftMode("rotating");
    setRotationGroup("A");
    setAfternoonManager(false);
    setReferenceDate("");
    setReferencePosition("mesa1");
    setPhoto(null);

    setMessage(
      "Trabajador guardado correctamente."
    );

    setSaving(false);

    await loadEmployees();
  }

  function startEdit(employee: Employee) {
    setEditing(employee);

    setEditName(employee.name);
    setEditShiftMode(employee.shift_mode);

    setEditRotationGroup(
      employee.rotation_group ?? "A"
    );

    setEditAfternoonManager(
      employee.manager_type ===
        "afternoon_pool"
    );

    setEditReferenceDate(
      employee.rotation_reference_date ?? ""
    );

    setEditReferencePosition(
      employee.rotation_reference_position ??
        (employee.shift_mode === "night_fixed"
          ? "picking"
          : "mesa1")
    );

    setEditPhoto(null);
    setMessage("");

    setTimeout(() => {
      editRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 50);
  }

  function cancelEdit() {
    setEditing(null);
    setEditPhoto(null);
  }

  function changeEditShiftMode(
    value: ShiftMode
  ) {
    setEditShiftMode(value);

    if (value === "night_fixed") {
      setEditReferencePosition("picking");
      setEditAfternoonManager(false);
    }

    if (value === "morning_fixed") {
      setEditReferenceDate("");
      setEditAfternoonManager(false);
    }

    if (value === "rotating") {
      if (!editReferenceDate) {
        setEditReferencePosition("mesa1");
      }
    }
  }

  async function saveEdit() {
    if (!editing) return;

    if (!editName.trim()) {
      setMessage("Debes indicar el nombre.");
      return;
    }

    if (
      editShiftMode !== "morning_fixed" &&
      !editReferenceDate
    ) {
      setMessage(
        "Debes indicar la fecha de referencia."
      );
      return;
    }

    setSaving(true);
    setMessage("");

    let managerType: ManagerType = "none";

    if (editShiftMode === "morning_fixed") {
      managerType = "morning_fixed";
    }

    if (
      editShiftMode === "rotating" &&
      editAfternoonManager
    ) {
      managerType = "afternoon_pool";
    }

    let photoUrl = editing.photo_url;

    if (editPhoto) {
      try {
        photoUrl = await uploadPhoto(
          editing.id,
          editPhoto
        );
      } catch (error) {
        setMessage(
          "ERROR subiendo la fotografía."
        );
        setSaving(false);
        return;
      }
    }

    const { error } = await supabase
      .from("employees")
      .update({
        name: editName.trim(),

        shift_mode: editShiftMode,

        rotation_group:
          editShiftMode === "rotating"
            ? editRotationGroup
            : null,

        manager_type: managerType,

        rotation_reference_date:
          editShiftMode === "morning_fixed"
            ? null
            : editReferenceDate,

        rotation_reference_position:
          editShiftMode === "morning_fixed"
            ? null
            : editReferencePosition,

        photo_url: photoUrl,
      })
      .eq("id", editing.id);

    if (error) {
      setMessage(
        "ERROR guardando cambios: " +
          error.message
      );

      setSaving(false);
      return;
    }

    /*
     * Si deja de ser Gestor de tarde,
     * comprobamos que no siga figurando
     * como gestor inicial del grupo.
     */
    if (
      managerType !== "afternoon_pool"
    ) {
      await supabase
        .from("afternoon_manager_settings")
        .update({
          starter_manager_id: null,
        })
        .eq(
          "starter_manager_id",
          editing.id
        );
    }

    /*
     * Si cambia de grupo siendo gestor inicial,
     * también eliminamos la referencia antigua.
     */
    if (
      editing.rotation_group &&
      editing.rotation_group !==
        (editShiftMode === "rotating"
          ? editRotationGroup
          : null)
    ) {
      await supabase
        .from("afternoon_manager_settings")
        .update({
          starter_manager_id: null,
        })
        .eq(
          "starter_manager_id",
          editing.id
        );
    }

    setEditing(null);
    setEditPhoto(null);
    setSaving(false);

    setMessage(
      "Trabajador actualizado correctamente."
    );

    await loadEmployees();
    await loadManagerSettings();
  }

  async function deactivateEmployee(
    employee: Employee
  ) {
    const confirmed = window.confirm(
      `¿Eliminar a ${employee.name} de la planificación?\n\nNo se borrará su histórico.`
    );

    if (!confirmed) return;

    const { error } = await supabase
      .from("employees")
      .update({
        active: false,
      })
      .eq("id", employee.id);

    if (error) {
      setMessage(
        "ERROR: " + error.message
      );
      return;
    }

    await supabase
      .from("afternoon_manager_settings")
      .update({
        starter_manager_id: null,
      })
      .eq(
        "starter_manager_id",
        employee.id
      );

    setMessage(
      `${employee.name} ha sido eliminado de la planificación.`
    );

    await loadEmployees();
    await loadManagerSettings();
  }

  async function reactivateEmployee(
    employee: Employee
  ) {
    const { error } = await supabase
      .from("employees")
      .update({
        active: true,
      })
      .eq("id", employee.id);

    if (error) {
      setMessage(
        "ERROR: " + error.message
      );
      return;
    }

    setMessage(
      `${employee.name} vuelve a estar activo.`
    );

    await loadEmployees();
  }

  async function makeStarter(
    employee: Employee
  ) {
    if (
      employee.manager_type !==
        "afternoon_pool" ||
      !employee.rotation_group
    ) {
      return;
    }

    const { error } = await supabase
      .from("afternoon_manager_settings")
      .upsert(
        {
          rotation_group:
            employee.rotation_group,

          starter_manager_id:
            employee.id,
        },
        {
          onConflict: "rotation_group",
        }
      );

    if (error) {
      setMessage(
        "ERROR: " + error.message
      );
      return;
    }

    setMessage(
      `${employee.name} es el gestor inicial del Grupo ${employee.rotation_group}.`
    );

    await loadManagerSettings();
  }

  function isStarter(employee: Employee) {
    if (!employee.rotation_group) {
      return false;
    }

    return managerSettings.some(
      (setting) =>
        setting.rotation_group ===
          employee.rotation_group &&
        setting.starter_manager_id ===
          employee.id
    );
  }

  const availablePositions =
    shiftMode === "night_fixed"
      ? nightPositions
      : normalPositions;

  const editAvailablePositions =
    editShiftMode === "night_fixed"
      ? nightPositions
      : normalPositions;

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-7xl">

        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            Personal
          </h1>

          <p className="mt-2 text-slate-600">
            Gestión de trabajadores, grupos,
            gestores y rueda de puestos.
          </p>
        </div>

        {/* NUEVO TRABAJADOR */}

        <form
          onSubmit={handleSubmit}
          className="mt-8 rounded-xl bg-white p-6 shadow-sm"
        >
          <h2 className="text-xl font-semibold">
            Nuevo trabajador
          </h2>

          <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">

            <div>
              <label className="mb-2 block text-sm font-medium">
                Nombre
              </label>

              <input
                value={name}
                onChange={(e) =>
                  setName(e.target.value)
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                placeholder="Nombre y apellidos"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Tipo de turno
              </label>

              <select
                value={shiftMode}
                onChange={(e) =>
                  changeShiftMode(
                    e.target.value as ShiftMode
                  )
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="rotating">
                  Rotativo mañana / tarde
                </option>

                <option value="morning_fixed">
                  Mañana fija - Gestor
                </option>

                <option value="night_fixed">
                  Noche fija
                </option>
              </select>
            </div>

            {shiftMode === "rotating" && (
              <div>
                <label className="mb-2 block text-sm font-medium">
                  Grupo
                </label>

                <select
                  value={rotationGroup}
                  onChange={(e) =>
                    setRotationGroup(
                      e.target.value as "A" | "B"
                    )
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="A">
                    Grupo A
                  </option>

                  <option value="B">
                    Grupo B
                  </option>
                </select>
              </div>
            )}

            {shiftMode === "rotating" && (
              <div className="flex items-end">
                <label className="flex items-center gap-3 rounded-lg border border-slate-300 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={afternoonManager}
                    onChange={(e) =>
                      setAfternoonManager(
                        e.target.checked
                      )
                    }
                  />

                  Gestor de tarde
                </label>
              </div>
            )}

            {shiftMode !== "morning_fixed" && (
              <>
                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Fecha referencia rueda
                  </label>

                  <input
                    type="date"
                    value={referenceDate}
                    onChange={(e) =>
                      setReferenceDate(
                        e.target.value
                      )
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Puesto ese día
                  </label>

                  <select
                    value={referencePosition}
                    onChange={(e) =>
                      setReferencePosition(
                        e.target.value as Position
                      )
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    {availablePositions.map(
                      (position) => (
                        <option
                          key={position.value}
                          value={position.value}
                        >
                          {position.label}
                        </option>
                      )
                    )}
                  </select>
                </div>
              </>
            )}

            <div>
              <label className="mb-2 block text-sm font-medium">
                Foto
              </label>

              <input
                type="file"
                accept="image/*"
                onChange={handlePhoto}
                className="w-full text-sm"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="mt-6 rounded-lg bg-slate-900 px-5 py-2 font-medium text-white disabled:opacity-50"
          >
            {saving
              ? "Guardando..."
              : "Guardar trabajador"}
          </button>
        </form>

        {message && (
          <div className="mt-5 rounded-lg bg-white p-4 text-sm shadow-sm">
            {message}
          </div>
        )}

        {/* EDITAR */}

        {editing && (
          <div
            ref={editRef}
            className="mt-8 rounded-xl border-2 border-slate-900 bg-white p-6 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">
                  Editar trabajador
                </h2>

                <p className="mt-1 text-sm text-slate-500">
                  Editando a{" "}
                  <strong>{editing.name}</strong>
                </p>
              </div>

              <button
                type="button"
                onClick={cancelEdit}
                className="rounded-lg border border-slate-300 px-4 py-2"
              >
                Cerrar
              </button>
            </div>

            <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">

              <div>
                <label className="mb-2 block text-sm font-medium">
                  Nombre
                </label>

                <input
                  value={editName}
                  onChange={(e) =>
                    setEditName(e.target.value)
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium">
                  Tipo de turno
                </label>

                <select
                  value={editShiftMode}
                  onChange={(e) =>
                    changeEditShiftMode(
                      e.target.value as ShiftMode
                    )
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="rotating">
                    Rotativo mañana / tarde
                  </option>

                  <option value="morning_fixed">
                    Mañana fija - Gestor
                  </option>

                  <option value="night_fixed">
                    Noche fija
                  </option>
                </select>
              </div>

              {editShiftMode === "rotating" && (
                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Grupo
                  </label>

                  <select
                    value={editRotationGroup}
                    onChange={(e) =>
                      setEditRotationGroup(
                        e.target.value as "A" | "B"
                      )
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    <option value="A">
                      Grupo A
                    </option>

                    <option value="B">
                      Grupo B
                    </option>
                  </select>
                </div>
              )}

              {editShiftMode === "rotating" && (
                <div className="flex items-end">
                  <label className="flex items-center gap-3 rounded-lg border border-slate-300 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={
                        editAfternoonManager
                      }
                      onChange={(e) =>
                        setEditAfternoonManager(
                          e.target.checked
                        )
                      }
                    />

                    Gestor de tarde
                  </label>
                </div>
              )}

              {editShiftMode !== "morning_fixed" && (
                <>
                  <div>
                    <label className="mb-2 block text-sm font-medium">
                      Fecha referencia rueda
                    </label>

                    <input
                      type="date"
                      value={editReferenceDate}
                      onChange={(e) =>
                        setEditReferenceDate(
                          e.target.value
                        )
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium">
                      Puesto ese día
                    </label>

                    <select
                      value={
                        editReferencePosition
                      }
                      onChange={(e) =>
                        setEditReferencePosition(
                          e.target
                            .value as Position
                        )
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2"
                    >
                      {editAvailablePositions.map(
                        (position) => (
                          <option
                            key={
                              position.value
                            }
                            value={
                              position.value
                            }
                          >
                            {position.label}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                </>
              )}

              <div>
                <label className="mb-2 block text-sm font-medium">
                  Cambiar fotografía
                </label>

                <input
                  type="file"
                  accept="image/*"
                  onChange={handleEditPhoto}
                  className="w-full text-sm"
                />
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={saveEdit}
                disabled={saving}
                className="rounded-lg bg-slate-900 px-5 py-2 font-medium text-white disabled:opacity-50"
              >
                {saving
                  ? "Guardando..."
                  : "Guardar cambios"}
              </button>

              <button
                type="button"
                onClick={cancelEdit}
                className="rounded-lg border border-slate-300 px-5 py-2"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* FILTROS */}

        <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">
              Personal
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              {filteredEmployees.length} trabajadores
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium">
              Filtrar personal
            </label>

            <select
              value={filter}
              onChange={(e) =>
                setFilter(
                  e.target.value as Filter
                )
              }
              className="min-w-52 rounded-lg border border-slate-300 bg-white px-4 py-2"
            >
              <option value="all">
                Todos los activos
              </option>

              <option value="A">
                Grupo A
              </option>

              <option value="B">
                Grupo B
              </option>

              <option value="morning">
                Mañana fija
              </option>

              <option value="night">
                Noche fija
              </option>

              <option value="inactive">
                Eliminados
              </option>
            </select>
          </div>
        </div>

        {/* TABLA */}

        <div className="mt-4 overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full text-left">
            <thead className="bg-slate-50 text-sm">
              <tr>
                <th className="px-4 py-4">
                  Foto
                </th>

                <th className="px-4 py-4">
                  Nombre
                </th>

                <th className="px-4 py-4">
                  Turno
                </th>

                <th className="px-4 py-4">
                  Grupo
                </th>

                <th className="px-4 py-4">
                  Gestor
                </th>

                <th className="px-4 py-4">
                  Inicial
                </th>

                <th className="px-4 py-4">
                  Referencia
                </th>

                <th className="px-4 py-4">
                  Acciones
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {filteredEmployees.length ===
              0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-6 py-10 text-center text-slate-500"
                  >
                    No hay trabajadores en este
                    filtro.
                  </td>
                </tr>
              ) : (
                filteredEmployees.map(
                  (employee) => (
                    <tr key={employee.id}>
                      <td className="px-4 py-4">
                        {employee.photo_url ? (
                          <img
                            src={
                              employee.photo_url
                            }
                            alt={employee.name}
                            className="h-12 w-12 rounded-full object-cover"
                          />
                        ) : (
                          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 font-semibold">
                            {employee.name
                              .charAt(0)
                              .toUpperCase()}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-4 font-medium">
                        {employee.name}
                      </td>

                      <td className="px-4 py-4">
                        {employee.shift_mode ===
                        "rotating"
                          ? "Rotativo"
                          : employee.shift_mode ===
                            "morning_fixed"
                          ? "Mañana fija"
                          : "Noche fija"}
                      </td>

                      <td className="px-4 py-4">
                        {employee.rotation_group
                          ? `Grupo ${employee.rotation_group}`
                          : "—"}
                      </td>

                      <td className="px-4 py-4">
                        {employee.manager_type ===
                        "morning_fixed"
                          ? "Gestor fijo"
                          : employee.manager_type ===
                            "afternoon_pool"
                          ? "Gestor tarde"
                          : "No"}
                      </td>

                      <td className="px-4 py-4">
                        {employee.manager_type ===
                          "afternoon_pool" &&
                        employee.active ? (
                          isStarter(employee) ? (
                            <span className="font-semibold">
                              ⭐ Inicial
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                makeStarter(
                                  employee
                                )
                              }
                              className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
                            >
                              Hacer inicial
                            </button>
                          )
                        ) : (
                          "—"
                        )}
                      </td>

                      <td className="px-4 py-4 text-sm">
                        {employee
                          .rotation_reference_date
                          ? `${employee.rotation_reference_date} · ${positionLabel(
                              employee.rotation_reference_position
                            )}`
                          : "—"}
                      </td>

                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              startEdit(
                                employee
                              )
                            }
                            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white"
                          >
                            Editar
                          </button>

                          {employee.active ? (
                            <button
                              type="button"
                              onClick={() =>
                                deactivateEmployee(
                                  employee
                                )
                              }
                              className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700"
                            >
                              Eliminar
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                reactivateEmployee(
                                  employee
                                )
                              }
                              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                            >
                              Reactivar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}