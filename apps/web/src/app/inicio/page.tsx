"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ZONA_HORARIA } from "@warike/domain";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@warike/ui";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Cargando } from "@/components/pantalla";
import { useContexto, usePermisos, useSesion } from "@/lib/contexto";
import { cerrarSesion } from "@/lib/pin-login";

const NOMBRE_ROL: Record<string, string> = {
  admin: "Administrador",
  cajero: "Cajero",
  mozo: "Mozo",
  cocina: "Cocina",
  auditor: "Auditor",
};

// Módulos que llegan en las fases siguientes (§15), visibles según los permisos del rol.
const MODULOS: Array<{ nombre: string; permisos: string[]; fase: string }> = [
  { nombre: "Salón y pedidos", permisos: ["tomar_pedido"], fase: "Fase 1" },
  { nombre: "Cocina (KDS)", permisos: ["operar_kds", "ver_listos_kds"], fase: "Fase 1" },
  { nombre: "Caja y comprobantes", permisos: ["cobrar_emitir", "operar_caja"], fase: "Fase 2" },
  { nombre: "Configuración del local", permisos: ["configurar_local"], fase: "Fase 1" },
  { nombre: "Carta y precios", permisos: ["gestionar_carta", "modificar_precios"], fase: "Fase 1" },
  { nombre: "Usuarios y planilla", permisos: ["gestionar_usuarios"], fase: "Fase 1" },
  { nombre: "Reportes", permisos: ["ver_reportes", "ver_reportes_sesion"], fase: "Fase 3" },
  { nombre: "Auditoría", permisos: ["ver_auditoria"], fase: "Fase 3" },
];

const formatoHora = new Intl.DateTimeFormat("es-PE", {
  timeZone: ZONA_HORARIA,
  hour: "2-digit",
  minute: "2-digit",
  day: "2-digit",
  month: "2-digit",
});

export default function Inicio() {
  const router = useRouter();
  const consultas = useQueryClient();
  const sesion = useSesion();
  const contexto = useContexto(sesion?.user.id);
  const permisos = usePermisos();

  useEffect(() => {
    if (sesion === null) router.replace("/ingresar");
  }, [sesion, router]);

  useEffect(() => {
    if (contexto.data?.requiere_mfa) router.replace("/admin/mfa?siguiente=/inicio");
  }, [contexto.data?.requiere_mfa, router]);

  // La sesión PIN vence a las 12 h (§4.1): se cierra sola en ese momento.
  const expiraAt = contexto.data?.sesion_pin?.expira_at;
  useEffect(() => {
    if (!expiraAt) return;
    const espera = Date.parse(expiraAt) - Date.now();
    const temporizador = setTimeout(() => void salir(), Math.max(0, Math.min(espera, 2 ** 31 - 1)));
    return () => clearTimeout(temporizador);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- salir es estable para este efecto
  }, [expiraAt]);

  async function salir() {
    await cerrarSesion();
    consultas.clear();
    router.replace("/ingresar");
  }

  if (!sesion || contexto.isLoading || contexto.data?.requiere_mfa) return <Cargando />;
  if (contexto.isError || !contexto.data) {
    return (
      <main className="mx-auto max-w-3xl p-4">
        <Alert variant="destructive">No se pudo cargar su sesión. Verifique la conexión.</Alert>
        <Button className="mt-4" variant="outline" onClick={() => void salir()}>
          Cerrar sesión
        </Button>
      </main>
    );
  }

  const ctx = contexto.data;
  const tipoSesion = ctx.sesion_pin
    ? `Ingreso con PIN · vence ${formatoHora.format(new Date(ctx.sesion_pin.expira_at))}`
    : ctx.aal === "aal2"
      ? "Ingreso con verificación en dos pasos"
      : "Sesión sin permisos";

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            Warike POS
          </p>
          <h1 className="text-2xl font-semibold" data-testid="bienvenida">
            Hola, {ctx.perfil?.nombre_visible ?? "usuario"}
          </h1>
          <p className="text-sm text-muted-foreground">{tipoSesion}</p>
        </div>
        <Button variant="outline" onClick={() => void salir()}>
          Cerrar sesión
        </Button>
      </header>

      {ctx.locales.length === 0 ? (
        <Alert>Su usuario no tiene roles activos en ningún local. Contacte al administrador.</Alert>
      ) : null}

      {ctx.locales.map((local) => (
        <Card key={local.local_id}>
          <CardHeader>
            <CardTitle>{local.nombre}</CardTitle>
            <CardDescription data-testid="roles">
              {local.roles.map((r) => NOMBRE_ROL[r] ?? r).join(", ")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2">
              {MODULOS.filter((m) => m.permisos.some((p) => local.permisos.includes(p))).map(
                (m) => (
                  <div key={m.nombre} className="rounded-md border bg-muted/40 p-4">
                    <p className="font-medium">{m.nombre}</p>
                    <p className="text-xs text-muted-foreground">
                      Disponible en la {m.fase.toLowerCase()}
                    </p>
                  </div>
                ),
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Permisos ({local.permisos.length})
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
                {local.permisos.map((p) => (
                  <li key={p}>{permisos.data?.get(p) ?? p}</li>
                ))}
              </ul>
            </details>
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
