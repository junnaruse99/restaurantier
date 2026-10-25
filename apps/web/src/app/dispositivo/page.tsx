"use client";

import { Alert, Button, Input, Label } from "@warike/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Cargando, Pantalla } from "@/components/pantalla";
import { useContexto, useSesion } from "@/lib/contexto";
import type { DispositivoLocal, TipoDispositivo } from "@/lib/db-local";
import {
  esTokenValido,
  guardarDispositivo,
  obtenerDispositivo,
  olvidarDispositivo,
} from "@/lib/dispositivo";
import { cerrarSesion } from "@/lib/pin-login";
import { supabase } from "@/lib/supabase";

const TIPOS: Array<{ valor: TipoDispositivo; etiqueta: string }> = [
  { valor: "tablet_mozo", etiqueta: "Tablet de mozo" },
  { valor: "caja", etiqueta: "PC de caja" },
  { valor: "kds", etiqueta: "Pantalla de cocina (KDS)" },
];

const SELECT =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm";

export default function RegistrarDispositivo() {
  const router = useRouter();
  const sesion = useSesion();
  const contexto = useContexto(Boolean(sesion));
  const [actual, setActual] = useState<DispositivoLocal | null | undefined>(undefined);
  const [localId, setLocalId] = useState("");
  const [nombre, setNombre] = useState("");
  const [tipo, setTipo] = useState<TipoDispositivo>("tablet_mozo");
  const [token, setToken] = useState("");
  const [nombreManual, setNombreManual] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void obtenerDispositivo().then((d) => setActual(d ?? null));
  }, []);

  const localesAdmin = (contexto.data?.locales ?? []).filter((l) =>
    l.permisos.includes("configurar_local"),
  );
  const localElegido = localId || localesAdmin[0]?.local_id || "";

  if (actual === undefined || sesion === undefined || (sesion && contexto.isLoading))
    return <Cargando />;

  async function registrar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    const { data, error: errorRpc } = await supabase().rpc("registrar_dispositivo", {
      p_local_id: localElegido,
      p_nombre: nombre,
      p_tipo: tipo,
    });
    if (errorRpc) {
      setEnviando(false);
      setError(errorRpc.message);
      return;
    }
    const registro = data as { dispositivo_id: string; local_id: string; token: string };
    await guardarDispositivo({
      token: registro.token,
      nombre,
      dispositivoId: registro.dispositivo_id,
      localId: registro.local_id,
      tipo,
    });
    // El dispositivo queda listo para el ingreso con PIN: se cierra la sesión del administrador.
    await cerrarSesion();
    router.replace("/ingresar");
  }

  async function guardarManual(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await guardarDispositivo({ token, nombre: nombreManual });
      router.replace("/ingresar");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Token inválido");
    }
  }

  return (
    <Pantalla
      titulo="Registrar dispositivo"
      descripcion="Solo los dispositivos registrados permiten el ingreso rápido con código y PIN (§4.1)."
      ancho="max-w-lg"
    >
      {actual ? (
        <Alert>
          Este dispositivo ya está registrado como <strong>{actual.nombre}</strong>.{" "}
          <button
            type="button"
            className="text-primary underline-offset-4 hover:underline"
            onClick={() => void olvidarDispositivo().then(() => setActual(null))}
          >
            Olvidar registro
          </button>
        </Alert>
      ) : null}

      {localesAdmin.length > 0 ? (
        <form className="space-y-4" onSubmit={(e) => void registrar(e)}>
          {localesAdmin.length > 1 ? (
            <div className="space-y-2">
              <Label htmlFor="local">Local</Label>
              <select
                id="local"
                className={SELECT}
                value={localElegido}
                onChange={(e) => setLocalId(e.target.value)}
              >
                {localesAdmin.map((l) => (
                  <option key={l.local_id} value={l.local_id}>
                    {l.nombre}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Local: {localesAdmin[0]?.nombre}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="nombre">Nombre del dispositivo</Label>
            <Input
              id="nombre"
              required
              placeholder="Tablet Salón 2"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tipo">Tipo</Label>
            <select
              id="tipo"
              className={SELECT}
              value={tipo}
              onChange={(e) => setTipo(e.target.value as TipoDispositivo)}
            >
              {TIPOS.map((t) => (
                <option key={t.valor} value={t.valor}>
                  {t.etiqueta}
                </option>
              ))}
            </select>
          </div>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <Button type="submit" size="lg" className="w-full" disabled={enviando || !nombre.trim()}>
            {enviando ? "Registrando…" : "Registrar este dispositivo"}
          </Button>
        </form>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {sesion
              ? "Su sesión no tiene permiso para configurar el local (requiere administrador con MFA)."
              : "Inicie sesión como administrador para registrar este dispositivo."}
          </p>
          <Button asChild size="lg" className="w-full">
            <Link href="/admin/ingresar?siguiente=/dispositivo">Ingresar como administrador</Link>
          </Button>
        </div>
      )}

      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer font-medium">Tengo un token de dispositivo</summary>
        <form className="mt-3 space-y-3" onSubmit={(e) => void guardarManual(e)}>
          <div className="space-y-2">
            <Label htmlFor="token">Token</Label>
            <Input
              id="token"
              autoComplete="off"
              spellCheck={false}
              placeholder="wkd_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nombre-manual">Nombre para mostrar</Label>
            <Input
              id="nombre-manual"
              value={nombreManual}
              onChange={(e) => setNombreManual(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            className="w-full"
            disabled={!esTokenValido(token)}
          >
            Guardar token
          </Button>
        </form>
      </details>

      <p className="text-center text-sm">
        <Link href="/ingresar" className="text-primary underline-offset-4 hover:underline">
          Volver
        </Link>
      </p>
    </Pantalla>
  );
}
