"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { supabase } from "@/lib/supabase";

const STORAGE_KEY = "warehouse-management-session-token";
const PUBLIC_PREFIXES = ["/terminal", "/monitor"];

function isPublicPath(pathname: string) {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function ManagerAccessGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const publicPath = isPublicPath(pathname);

  const [checking, setChecking] = useState(!publicPath);
  const [authorized, setAuthorized] = useState(publicPath);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("Gestor");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (publicPath) {
      setChecking(false);
      setAuthorized(true);
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        const token = window.localStorage.getItem(STORAGE_KEY);

        if (!token) {
          setAuthorized(false);
          setChecking(false);
          return;
        }

        const { data, error } = await supabase.rpc(
          "warehouse_management_validate",
          { target_session_token: token },
        );

        if (error || !data?.valid) {
          window.localStorage.removeItem(STORAGE_KEY);
          setAuthorized(false);
          setChecking(false);
          return;
        }

        setDisplayName(data.display_name ?? "Gestor");
        setAuthorized(true);
        setChecking(false);
      })();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [publicPath, pathname]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!username.trim() || !password) {
      setMessage("Indica usuario y contraseña.");
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const { data, error } = await supabase.rpc(
        "warehouse_management_login",
        {
          target_username: username.trim(),
          target_password: password,
        },
      );

      if (error) throw new Error(error.message);

      const row = Array.isArray(data) ? data[0] : data;

      if (!row?.management_session_token) {
        throw new Error("No se ha podido iniciar la sesión de gestión.");
      }

      window.localStorage.setItem(STORAGE_KEY, row.management_session_token);
      setDisplayName(row.display_name ?? "Gestor");
      setPassword("");
      setAuthorized(true);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Usuario o contraseña incorrectos.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    const token = window.localStorage.getItem(STORAGE_KEY);
    window.localStorage.removeItem(STORAGE_KEY);
    setAuthorized(false);
    setPassword("");

    if (token) {
      try {
        await supabase.rpc("warehouse_management_logout", {
          target_session_token: token,
        });
      } catch {
        // La sesión local ya está cerrada aunque falle la llamada remota.
      }
    }
  }

  if (publicPath) return <>{children}</>;

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white">
        <div className="rounded-2xl border border-slate-800 bg-slate-900 px-8 py-7 text-center shadow-xl">
          <p className="text-sm uppercase tracking-[0.2em] text-slate-400">
            Puestos Almacén
          </p>
          <p className="mt-3 text-lg font-semibold">
            Comprobando acceso de gestión...
          </p>
        </div>
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10">
        <form onSubmit={login} className="w-full max-w-md rounded-2xl bg-white p-7 shadow-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            Puestos Almacén
          </p>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">
            Acceso Gestor
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Identifícate para acceder a la planificación y a las pantallas de gestión.
          </p>

          <label className="mt-6 block text-sm font-medium text-slate-700">
            Usuario
          </label>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-slate-900"
          />

          <label className="mt-4 block text-sm font-medium text-slate-700">
            Contraseña
          </label>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-slate-900"
          />

          {message && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-6 w-full rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Validando..." : "Entrar"}
          </button>

          <p className="mt-5 text-center text-xs text-slate-400">
            Terminal de operarios y monitor continúan disponibles sin este acceso.
          </p>
        </form>
      </main>
    );
  }

  return (
    <>
      <div className="fixed right-3 top-3 z-[100] flex items-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-md backdrop-blur">
        <span className="max-w-40 truncate font-semibold text-slate-700">
          {displayName}
        </span>
        <button
          type="button"
          onClick={() => void logout()}
          className="rounded-lg bg-slate-900 px-3 py-1.5 font-semibold text-white"
        >
          Cerrar sesión
        </button>
      </div>
      {children}
    </>
  );
}
