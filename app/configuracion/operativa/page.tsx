"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Code39Barcode } from "@/components/code39-barcode";
import {
  OPERATIONAL_AREA_LABELS,
  type OperationalAreaCode,
} from "@/lib/operational-types";
import { supabase } from "@/lib/supabase";

type EmployeeSetup = {
  id: string;
  name: string;
  active: boolean;
  has_credential: boolean;
  username_code: string | null;
  credential_active: boolean;
  locked_until: string | null;
};

type TerminalSetup = {
  id: string;
  code: string;
  name: string;
  terminal_type: "fixed_pc" | "rf";
  fixed_area_code: OperationalAreaCode | null;
  active: boolean;
};

type CartSetup = {
  id: string;
  code: string;
  state: "available" | "picking" | "ready_for_shipping" | "assigned_to_shipping" | "shipping" | "completed";
  active: boolean;
  is_cubetas: boolean;
  has_history: boolean;
};

type BreakSetup = {
  id: string;
  code: string;
  label: string;
  active: boolean;
  display_order: number;
  has_history: boolean;
};

type SetupState = {
  employees: EmployeeSetup[];
  terminals: TerminalSetup[];
  carts: CartSetup[];
  breaks: BreakSetup[];
};

type CredentialCard = {
  employeeName: string;
  usernameCode: string;
  passwordCode: string;
};

const AREAS: OperationalAreaCode[] = [
  "gestor",
  "entradas",
  "picking",
  "montajes",
  "mesa1",
  "mesa2",
  "mesa3",
  "mesa4",
];

function randomCode(prefix: string, length: number) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return `${prefix}-${Array.from(values, (value) => alphabet[value % alphabet.length]).join("")}`;
}

function sanitizeUsername(name: string, id: string) {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);

  return `U-${base || "OP"}-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

export default function OperationalConfigurationPage() {
  const [data, setData] = useState<SetupState>({
    employees: [],
    terminals: [],
    carts: [],
    breaks: [],
  });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [cartCode, setCartCode] = useState("");
  const [breakLabel, setBreakLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [credentialCard, setCredentialCard] = useState<CredentialCard | null>(null);

  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [terminalCode, setTerminalCode] = useState("");
  const [terminalName, setTerminalName] = useState("");
  const [terminalType, setTerminalType] = useState<"fixed_pc" | "rf">("fixed_pc");
  const [fixedArea, setFixedArea] = useState<OperationalAreaCode>("mesa1");
  const [terminalActive, setTerminalActive] = useState(true);

  async function loadSetup() {
    const { data: result, error } = await supabase.rpc("warehouse_admin_get_setup_state_open");

    if (error) throw new Error(error.message);
    setData(
      (result ?? { employees: [], terminals: [], carts: [], breaks: [] }) as SetupState,
    );
  }

  useEffect(() => {
    void (async () => {
      try {
        await loadSetup();
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "No se ha podido cargar la configuración operativa.",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function generateCredential(employee: EmployeeSetup) {
    const usernameCode = employee.username_code ?? sanitizeUsername(employee.name, employee.id);
    const passwordCode = randomCode("P", 8);

    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("warehouse_admin_set_employee_credential_open", {
        target_employee_id: employee.id,
        target_username_code: usernameCode,
        target_password_code: passwordCode,
      });
      if (error) throw new Error(error.message);

      setCredentialCard({
        employeeName: employee.name,
        usernameCode,
        passwordCode,
      });
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido generar la credencial.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleCredential(employee: EmployeeSetup) {
    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("warehouse_admin_set_credential_active_open", {
        target_employee_id: employee.id,
        target_active: !employee.credential_active,
      });
      if (error) throw new Error(error.message);
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido cambiar la credencial.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTerminal() {
    if (!terminalCode.trim() || !terminalName.trim()) {
      setMessage("Indica código y nombre del terminal.");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("warehouse_admin_upsert_terminal_open", {
        target_terminal_id: terminalId,
        target_code: terminalCode,
        target_name: terminalName,
        target_terminal_type: terminalType,
        target_fixed_area_code: terminalType === "fixed_pc" ? fixedArea : null,
        target_active: terminalActive,
      });
      if (error) throw new Error(error.message);
      clearTerminalForm();
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido guardar el terminal.");
    } finally {
      setBusy(false);
    }
  }

  function editTerminal(terminal: TerminalSetup) {
    setTerminalId(terminal.id);
    setTerminalCode(terminal.code);
    setTerminalName(terminal.name);
    setTerminalType(terminal.terminal_type);
    setFixedArea(terminal.fixed_area_code ?? "mesa1");
    setTerminalActive(terminal.active);
    setMessage("");

    window.setTimeout(() => {
      document
        .getElementById("terminal-editor")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }

  function clearTerminalForm() {
    setTerminalId(null);
    setTerminalCode("");
    setTerminalName("");
    setTerminalType("fixed_pc");
    setFixedArea("mesa1");
    setTerminalActive(true);
  }

  async function createTypicalTerminals() {
    const presets: Array<{
      code: string;
      name: string;
      type: "fixed_pc" | "rf";
      area: OperationalAreaCode | null;
    }> = [
      { code: "PC-MESA1", name: "PC Mesa 1", type: "fixed_pc", area: "mesa1" },
      { code: "PC-MESA2", name: "PC Mesa 2", type: "fixed_pc", area: "mesa2" },
      { code: "PC-MESA3", name: "PC Mesa 3", type: "fixed_pc", area: "mesa3" },
      { code: "PC-MESA4", name: "PC Mesa 4", type: "fixed_pc", area: "mesa4" },
      { code: "PC-ENTRADAS", name: "PC Entradas", type: "fixed_pc", area: "entradas" },
      { code: "PC-PICKING", name: "PC Picking", type: "fixed_pc", area: "picking" },
      { code: "PC-MONTAJES", name: "PC Montajes", type: "fixed_pc", area: "montajes" },
      { code: "RF-01", name: "Terminal RF 01", type: "rf", area: null },
    ];

    setBusy(true);
    setMessage("");
    try {
      const existingCodes = new Set(data.terminals.map((terminal) => terminal.code));
      for (const preset of presets) {
        if (existingCodes.has(preset.code)) continue;
        const { error } = await supabase.rpc("warehouse_admin_upsert_terminal_open", {
            target_terminal_id: null,
          target_code: preset.code,
          target_name: preset.name,
          target_terminal_type: preset.type,
          target_fixed_area_code: preset.area,
          target_active: true,
        });
        if (error) throw new Error(`${preset.code}: ${error.message}`);
      }
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se han podido crear los terminales.");
    } finally {
      setBusy(false);
    }
  }

  async function createCart() {
    const code = cartCode.trim().toUpperCase();
    if (!code) {
      setMessage("Indica el código del carro.");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("warehouse_admin_create_cart_open", {
        target_code: code,
      });
      if (error) throw new Error(error.message);
      setCartCode("");
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido crear el carro.");
    } finally {
      setBusy(false);
    }
  }

  async function removeCart(cart: CartSetup) {
    if (!window.confirm(`¿Eliminar el carro ${cart.code}?`)) return;

    setBusy(true);
    setMessage("");
    try {
      const { data: result, error } = await supabase.rpc("warehouse_admin_remove_cart_open", {
        target_cart_id: cart.id,
      });
      if (error) throw new Error(error.message);
      setMessage(
        result === "disabled"
          ? `El carro ${cart.code} tiene historial y se ha desactivado para conservar la trazabilidad.`
          : `Carro ${cart.code} eliminado.`,
      );
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido eliminar el carro.");
    } finally {
      setBusy(false);
    }
  }

  async function activateCart(cart: CartSetup) {
    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("warehouse_admin_set_cart_active_open", {
        target_cart_id: cart.id,
        target_active: true,
      });
      if (error) throw new Error(error.message);
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido activar el carro.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleCubetasCart(cart: CartSetup) {
    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("warehouse_admin_set_cart_cubetas_open", {
        target_cart_id: cart.id,
        target_cubetas: !cart.is_cubetas,
      });
      if (error) throw new Error(error.message);
      await loadSetup();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se ha podido cambiar el carro de cubetas.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createBreakType() {
    const label = breakLabel.trim();
    if (!label) {
      setMessage("Indica el nombre de la pausa.");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("warehouse_admin_create_break_type_open", {
        target_label: label,
      });
      if (error) throw new Error(error.message);
      setBreakLabel("");
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido crear la pausa.");
    } finally {
      setBusy(false);
    }
  }

  async function removeBreakType(breakType: BreakSetup) {
    if (!window.confirm(`¿Eliminar la pausa "${breakType.label}"?`)) return;

    setBusy(true);
    setMessage("");
    try {
      const { data: result, error } = await supabase.rpc("warehouse_admin_remove_break_type_open", {
        target_break_type_id: breakType.id,
      });
      if (error) throw new Error(error.message);
      setMessage(
        result === "disabled"
          ? `La pausa "${breakType.label}" tiene historial y se ha desactivado para conservarlo.`
          : `Pausa "${breakType.label}" eliminada.`,
      );
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido eliminar la pausa.");
    } finally {
      setBusy(false);
    }
  }

  async function activateBreakType(breakType: BreakSetup) {
    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("warehouse_admin_set_break_type_active_open", {
        target_break_type_id: breakType.id,
        target_active: true,
      });
      if (error) throw new Error(error.message);
      await loadSetup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se ha podido activar la pausa.");
    } finally {
      setBusy(false);
    }
  }

  const activeEmployees = useMemo(
    () => data.employees.filter((employee) => employee.active),
    [data.employees],
  );

  const activeCarts = useMemo(
    () => data.carts.filter((cart) => cart.active),
    [data.carts],
  );

  if (loading) {
    return <PageFrame>Cargando configuración operativa...</PageFrame>;
  }

  return (
    <PageFrame>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-900">Configuración operativa</h1>
          <p className="mt-1 text-slate-600">Credenciales, pausas, carros, terminales y accesos operativos del almacén.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="rounded-xl bg-slate-900 px-5 py-3 font-bold text-white" href="/gestor">PANEL DEL GESTOR</Link>
          <Link className="rounded-xl border border-slate-300 bg-white px-5 py-3 font-bold" href="/configuracion">Volver a configuración</Link>
        </div>
      </div>

      {message ? <Message>{message}</Message> : null}

      {credentialCard ? (
        <section className="mt-6 rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-6 print:border-0 print:bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
            <div>
              <h2 className="text-xl font-black">Credencial creada · {credentialCard.employeeName}</h2>
              <p className="text-sm text-emerald-800">Imprime ahora el password: por seguridad no se puede recuperar después.</p>
            </div>
            <button className="rounded-xl bg-slate-900 px-5 py-3 font-bold text-white" onClick={() => window.print()} type="button">IMPRIMIR</button>
          </div>
          <div className="mt-5 grid gap-6 md:grid-cols-2">
            <CredentialBlock label="USUARIO" value={credentialCard.usernameCode} />
            <CredentialBlock label="PASSWORD" value={credentialCard.passwordCode} />
          </div>
        </section>
      ) : null}

      <section className="mt-8 rounded-2xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Credenciales de operarios</h2>
            <p className="mt-1 text-sm text-slate-500">El operario escaneará primero USUARIO y después PASSWORD.</p>
          </div>
          <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-bold">{activeEmployees.length} activos</span>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead className="border-b text-sm text-slate-500">
              <tr><th className="py-3">Trabajador</th><th>Usuario</th><th>Estado</th><th className="text-right">Acciones</th></tr>
            </thead>
            <tbody>
              {activeEmployees.map((employee) => (
                <tr className="border-b last:border-0" key={employee.id}>
                  <td className="py-4 font-bold">{employee.name}</td>
                  <td className="font-mono text-sm">{employee.username_code ?? "—"}</td>
                  <td>{employee.has_credential ? (employee.credential_active ? "Activa" : "Desactivada") : "Sin crear"}</td>
                  <td className="py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-bold text-white" disabled={busy} onClick={() => void generateCredential(employee)} type="button">
                        {employee.has_credential ? "REGENERAR" : "GENERAR"}
                      </button>
                      {employee.has_credential ? (
                        <button className="rounded-lg border px-3 py-2 text-sm font-bold" disabled={busy} onClick={() => void toggleCredential(employee)} type="button">
                          {employee.credential_active ? "DESACTIVAR" : "ACTIVAR"}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 rounded-2xl bg-white p-6 shadow-sm" id="pausas">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Pausas</h2>
            <p className="mt-1 text-sm text-slate-500">
              Configura las pausas que aparecerán al operario. Si una pausa ya tiene historial,
              se desactiva en lugar de borrarse.
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-bold">
            {data.breaks.filter((breakType) => breakType.active).length} activas
          </span>
        </div>

        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <input
            className="min-w-0 flex-1 rounded-xl border p-3"
            onChange={(event) => setBreakLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createBreakType();
            }}
            placeholder="Nombre de la pausa"
            value={breakLabel}
          />
          <button
            className="rounded-xl bg-blue-600 px-6 py-3 font-black text-white"
            disabled={busy || !breakLabel.trim()}
            onClick={() => void createBreakType()}
            type="button"
          >
            AÑADIR PAUSA
          </button>
        </div>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[650px] text-left">
            <thead className="border-b text-sm text-slate-500">
              <tr>
                <th className="py-3">Pausa</th>
                <th>Estado</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {data.breaks.length ? (
                data.breaks.map((breakType) => (
                  <tr className="border-b last:border-0" key={breakType.id}>
                    <td className="py-4 font-black">{breakType.label}</td>
                    <td>{breakType.active ? "Activa" : "Desactivada"}</td>
                    <td className="py-3 text-right">
                      {breakType.active ? (
                        <button
                          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-800"
                          disabled={busy}
                          onClick={() => void removeBreakType(breakType)}
                          type="button"
                        >
                          {breakType.has_history ? "DESACTIVAR" : "ELIMINAR"}
                        </button>
                      ) : (
                        <button
                          className="rounded-lg border px-3 py-2 text-sm font-bold"
                          disabled={busy}
                          onClick={() => void activateBreakType(breakType)}
                          type="button"
                        >
                          ACTIVAR
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="py-5 text-center text-slate-500" colSpan={3}>
                    No hay pausas configuradas.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 rounded-2xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Carros</h2>
            <p className="mt-1 text-sm text-slate-500">
              Solo los carros activos de este listado pueden iniciarse desde Picking.
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-bold">
            {activeCarts.length} activos
          </span>
        </div>

        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <input
            className="min-w-0 flex-1 rounded-xl border p-3 font-mono uppercase"
            onChange={(event) => setCartCode(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createCart();
            }}
            placeholder="Código del carro"
            value={cartCode}
          />
          <button
            className="rounded-xl bg-blue-600 px-6 py-3 font-black text-white"
            disabled={busy || !cartCode.trim()}
            onClick={() => void createCart()}
            type="button"
          >
            AÑADIR CARRO
          </button>
        </div>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[850px] text-left">
            <thead className="border-b text-sm text-slate-500">
              <tr>
                <th className="py-3">Código</th>
                <th>Estado</th>
                <th>Activo</th>
                <th>Cubetas</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {activeCarts.length ? (
                activeCarts.map((cart) => (
                  <tr className="border-b last:border-0" key={cart.id}>
                    <td className="py-4 font-mono font-black">{cart.code}</td>
                    <td>{cartStateLabel(cart.state)}</td>
                    <td>{cart.active ? "Sí" : "No"}</td>
                    <td>{cart.is_cubetas ? "Sí" : "—"}</td>
                    <td className="py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          className={`rounded-lg border px-3 py-2 text-sm font-bold ${
                            cart.is_cubetas
                              ? "border-violet-300 bg-violet-50 text-violet-800"
                              : ""
                          }`}
                          disabled={busy || !cart.active || cart.state !== "available"}
                          onClick={() => void toggleCubetasCart(cart)}
                          type="button"
                        >
                          {cart.is_cubetas ? "QUITAR CUBETAS" : "MARCAR CUBETAS"}
                        </button>
                        {cart.active ? (
                          <button
                            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-800"
                            disabled={busy}
                            onClick={() => void removeCart(cart)}
                            type="button"
                          >
                            {cart.has_history ? "DESACTIVAR" : "ELIMINAR"}
                          </button>
                        ) : (
                          <button
                            className="rounded-lg border px-3 py-2 text-sm font-bold"
                            disabled={busy}
                            onClick={() => void activateCart(cart)}
                            type="button"
                          >
                            ACTIVAR
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="py-5 text-center text-slate-500" colSpan={5}>
                    No hay carros configurados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 rounded-2xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Terminales</h2>
            <p className="mt-1 text-sm text-slate-500">PC fijo = puesto conocido. RF = el operario escanea la ubicación.</p>
          </div>
          <button className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-bold" disabled={busy} onClick={() => void createTypicalTerminals()} type="button">CREAR TERMINALES HABITUALES</button>
        </div>

        {terminalId ? (
          <div className="mt-6 rounded-2xl border-2 border-blue-300 bg-blue-50 px-5 py-4">
            <p className="text-sm font-black uppercase tracking-wider text-blue-700">
              Editando terminal
            </p>
            <p className="mt-1 text-xl font-black text-slate-950">
              {terminalName || terminalCode}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Modifica código, nombre, tipo, puesto o estado y pulsa GUARDAR.
            </p>
          </div>
        ) : null}

        <div
          className={`mt-4 grid gap-3 rounded-2xl md:grid-cols-2 lg:grid-cols-6 ${
            terminalId
              ? "border-2 border-blue-300 bg-blue-50 p-4"
              : "mt-6"
          }`}
          id="terminal-editor"
        >
          <input className="rounded-xl border p-3 lg:col-span-1" onChange={(event) => setTerminalCode(event.target.value.toUpperCase())} placeholder="Código" value={terminalCode} />
          <input className="rounded-xl border p-3 lg:col-span-2" onChange={(event) => setTerminalName(event.target.value)} placeholder="Nombre" value={terminalName} />
          <select className="rounded-xl border p-3" onChange={(event) => setTerminalType(event.target.value as "fixed_pc" | "rf")} value={terminalType}>
            <option value="fixed_pc">PC fijo</option>
            <option value="rf">RF</option>
          </select>
          <select className="rounded-xl border p-3" disabled={terminalType === "rf"} onChange={(event) => setFixedArea(event.target.value as OperationalAreaCode)} value={fixedArea}>
            {AREAS.map((area) => <option key={area} value={area}>{OPERATIONAL_AREA_LABELS[area]}</option>)}
          </select>
          <button className="rounded-xl bg-blue-600 px-4 py-3 font-black text-white" disabled={busy} onClick={() => void saveTerminal()} type="button">{terminalId ? "GUARDAR" : "AÑADIR"}</button>
        </div>
        {terminalId ? (
          <div className="mt-3 flex items-center gap-4">
            <label className="flex items-center gap-2"><input checked={terminalActive} onChange={(event) => setTerminalActive(event.target.checked)} type="checkbox" /> Terminal activo</label>
            <button className="text-sm font-bold text-slate-600" onClick={clearTerminalForm} type="button">Cancelar edición</button>
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.terminals.map((terminal) => (
            <article className="rounded-xl border border-slate-200 p-4" key={terminal.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-black">{terminal.name}</p>
                  <p className="mt-1 font-mono text-sm text-slate-500">{terminal.code}</p>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs font-bold ${terminal.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}>{terminal.active ? "Activo" : "Inactivo"}</span>
              </div>
              <p className="mt-3 text-sm text-slate-600">
                {terminal.terminal_type === "fixed_pc" ? `PC fijo · ${terminal.fixed_area_code ? OPERATIONAL_AREA_LABELS[terminal.fixed_area_code] : "—"}` : "Terminal RF"}
              </p>
              <div className="mt-4 flex gap-2">
                <Link className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-bold text-white" href={`/terminal?terminal=${encodeURIComponent(terminal.code)}`} target="_blank">ABRIR</Link>
                <button
                  className={`rounded-lg border px-3 py-2 text-sm font-bold ${
                    terminalId === terminal.id
                      ? "border-blue-500 bg-blue-600 text-white"
                      : "border-slate-300 bg-white text-slate-800"
                  }`}
                  onClick={() => editTerminal(terminal)}
                  type="button"
                >
                  {terminalId === terminal.id ? "EDITANDO" : "EDITAR"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-8 rounded-2xl bg-white p-6 shadow-sm print:break-before-page">
        <h2 className="text-xl font-black">Códigos de ubicación para RF</h2>
        <p className="mt-1 text-sm text-slate-500">Imprime y coloca cada código en su puesto físico.</p>
        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {AREAS.map((area) => (
            <div className="rounded-xl border p-4 text-center" key={area}>
              <p className="mb-3 text-lg font-black">{OPERATIONAL_AREA_LABELS[area]}</p>
              <Code39Barcode value={`AREA-${area.toUpperCase()}`} />
            </div>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}

function cartStateLabel(state: CartSetup["state"]) {
  const labels: Record<CartSetup["state"], string> = {
    available: "Disponible",
    picking: "En Picking",
    ready_for_shipping: "Preparado para Expedición",
    assigned_to_shipping: "Asignado a Expedición",
    shipping: "En Expedición",
    completed: "Completado",
  };

  return labels[state];
}

function CredentialBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white p-5 text-center shadow-sm">
      <p className="mb-3 text-sm font-black tracking-widest text-slate-500">{label}</p>
      <Code39Barcode height={70} value={value} />
    </div>
  );
}

function PageFrame({ children }: { children: ReactNode }) {
  return <main className="min-h-screen bg-slate-100 p-6 md:p-8"><div className="mx-auto max-w-7xl">{children}</div></main>;
}

function Message({ children }: { children: ReactNode }) {
  return <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 font-semibold text-red-800">{children}</div>;
}
