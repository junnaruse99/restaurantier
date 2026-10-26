"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button } from "@warike/ui";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Cargando } from "@/components/pantalla";
import { useContexto, useSesion, type ContextoSesion } from "./contexto";
import { cerrarSesion } from "./pin-login";

export interface Operador {
  userId: string;
  nombre: string;
  localId: string;
  localNombre: string;
  /** Locales donde la sesión opera (el admin puede tener varios). */
  locales: ContextoSesion["locales"];
  roles: string[];
  permisos: ReadonlySet<string>;
  /** Sesión con PIN en un dispositivo (mozo, caja, cocina) o con MFA (admin, auditor). */
  dispositivoId: string | null;
  tiene: (...permisos: string[]) => boolean;
  cambiarLocal: (localId: string) => void;
  salir: () => Promise<void>;
}

const ContextoOperador = createContext<Operador | null>(null);

export function useOperador(): Operador {
  const op = useContext(ContextoOperador);
  if (!op) throw new Error("useOperador fuera de <ConOperador>");
  return op;
}

const CLAVE_LOCAL = "warike-pos-local";

function leerLocalGuardado(): string | null {
  try {
    return localStorage.getItem(CLAVE_LOCAL);
  } catch {
    return null;
  }
}

/**
 * Exige sesión y alguno de los permisos indicados; si no hay sesión, lleva al ingreso. Cierra la
 * sesión PIN al vencer (12 h, §4.1). Los hijos leen el operador con useOperador().
 */
export function ConOperador({
  permisos,
  children,
}: {
  permisos: readonly string[];
  children: ReactNode;
}) {
  const router = useRouter();
  const ruta = usePathname();
  const consultas = useQueryClient();
  const sesion = useSesion();
  const contexto = useContexto(sesion?.user.id);
  // En el servidor se muestra "Cargando…": el local guardado solo se usa en el navegador.
  const [localElegido, setLocalElegido] = useState<string | null>(() =>
    typeof window === "undefined" ? null : leerLocalGuardado(),
  );

  useEffect(() => {
    if (sesion === null) router.replace(`/ingresar?siguiente=${encodeURIComponent(ruta)}`);
  }, [sesion, router, ruta]);

  useEffect(() => {
    if (contexto.data?.requiere_mfa)
      router.replace(`/admin/mfa?siguiente=${encodeURIComponent(ruta)}`);
  }, [contexto.data?.requiere_mfa, router, ruta]);

  const expiraAt = contexto.data?.sesion_pin?.expira_at;
  const operador = useMemo<Operador | null>(() => {
    const ctx = contexto.data;
    if (!ctx || !sesion) return null;
    const candidatos = ctx.locales.filter((l) => permisos.some((p) => l.permisos.includes(p)));
    const local =
      candidatos.find((l) => l.local_id === ctx.sesion_pin?.local_id) ??
      candidatos.find((l) => l.local_id === localElegido) ??
      candidatos[0];
    if (!local) return null;
    const conjunto = new Set(local.permisos);
    return {
      userId: ctx.user_id,
      nombre: ctx.perfil?.nombre_visible ?? "Usuario",
      localId: local.local_id,
      localNombre: local.nombre,
      locales: candidatos,
      roles: local.roles,
      permisos: conjunto,
      dispositivoId: ctx.sesion_pin?.dispositivo_id ?? null,
      tiene: (...ps) => ps.some((p) => conjunto.has(p)),
      cambiarLocal: (id) => {
        try {
          localStorage.setItem(CLAVE_LOCAL, id);
        } catch {
          // Sin almacenamiento: el cambio dura hasta recargar.
        }
        setLocalElegido(id);
      },
      salir: async () => {
        await cerrarSesion();
        consultas.clear();
        router.replace(ctx.sesion_pin ? "/ingresar" : "/admin/ingresar");
      },
    };
  }, [contexto.data, sesion, permisos, localElegido, consultas, router]);

  const salir = operador?.salir;
  useEffect(() => {
    if (!expiraAt || !salir) return;
    const espera = Date.parse(expiraAt) - Date.now();
    const temporizador = setTimeout(() => void salir(), Math.max(0, Math.min(espera, 2 ** 31 - 1)));
    return () => clearTimeout(temporizador);
  }, [expiraAt, salir]);

  if (!sesion || contexto.isLoading || contexto.data?.requiere_mfa) return <Cargando />;
  if (contexto.isError) {
    return (
      <main className="mx-auto max-w-xl space-y-4 p-4">
        <Alert variant="destructive">No se pudo cargar su sesión. Verifique la conexión.</Alert>
        <Button variant="outline" onClick={() => void contexto.refetch()}>
          Reintentar
        </Button>
      </main>
    );
  }
  if (!operador) {
    return (
      <main className="mx-auto max-w-xl space-y-4 p-4">
        <Alert>Su usuario no tiene permiso para esta pantalla.</Alert>
        <Button variant="outline" onClick={() => router.replace("/inicio")}>
          Volver al inicio
        </Button>
      </main>
    );
  }
  return <ContextoOperador.Provider value={operador}>{children}</ContextoOperador.Provider>;
}
