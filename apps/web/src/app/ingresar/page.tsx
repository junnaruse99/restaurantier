"use client";

import { Alert, Button, Input, Label } from "@warike/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Cargando, Pantalla } from "@/components/pantalla";
import { TecladoPin } from "@/components/teclado-pin";
import type { DispositivoLocal } from "@/lib/db-local";
import { obtenerDispositivo, olvidarDispositivo } from "@/lib/dispositivo";
import { iniciarSesionConPin, mensajeErrorPin } from "@/lib/pin-login";

type Campo = "codigo" | "pin";

export default function IngresarConPin() {
  const router = useRouter();
  const [dispositivo, setDispositivo] = useState<DispositivoLocal | null | undefined>(undefined);
  const [codigo, setCodigo] = useState("");
  const [pin, setPin] = useState("");
  const [campo, setCampo] = useState<Campo>("codigo");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispositivoRevocado, setDispositivoRevocado] = useState(false);
  // El estado `enviando` llega tarde a los cierres: Enter y el botón OK casi a la vez enviarían dos veces.
  const enviandoRef = useRef(false);

  useEffect(() => {
    void obtenerDispositivo().then((d) => setDispositivo(d ?? null));
  }, []);

  if (dispositivo === undefined) return <Cargando />;

  if (dispositivo === null) {
    return (
      <Pantalla
        titulo="Dispositivo no registrado"
        descripcion="Para ingresar con código y PIN, un administrador debe registrar primero este dispositivo."
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/dispositivo">Registrar este dispositivo</Link>
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link href="/admin/ingresar">Acceso de administrador</Link>
        </Button>
      </Pantalla>
    );
  }

  const puedeEnviar = /^[0-9A-Za-z]{3,12}$/.test(codigo) && /^[0-9]{4,6}$/.test(pin);

  async function enviar() {
    if (!dispositivo || !puedeEnviar || enviandoRef.current) return;
    enviandoRef.current = true;
    setEnviando(true);
    setError(null);
    try {
      const resultado = await iniciarSesionConPin({ deviceToken: dispositivo.token, codigo, pin });
      if (resultado.ok) {
        router.replace("/inicio");
        return;
      }
      setPin("");
      setCampo("pin");
      setError(mensajeErrorPin(resultado));
      setDispositivoRevocado(resultado.error === "dispositivo_no_autorizado");
    } catch {
      setError(mensajeErrorPin({ ok: false, error: "error_interno" }));
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
  }

  function escribir(digito: string) {
    if (campo === "codigo") setCodigo((v) => (v.length < 12 ? v + digito : v));
    else setPin((v) => (v.length < 6 ? v + digito : v));
  }

  function borrar() {
    if (campo === "codigo") setCodigo((v) => v.slice(0, -1));
    else setPin((v) => v.slice(0, -1));
  }

  return (
    <Pantalla titulo="Ingresar" descripcion={`Dispositivo: ${dispositivo.nombre}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void enviar();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="codigo">Código de empleado</Label>
          <Input
            id="codigo"
            name="codigo"
            inputMode="numeric"
            autoComplete="username"
            autoFocus
            value={codigo}
            onFocus={() => setCampo("codigo")}
            onChange={(e) => setCodigo(e.target.value.replace(/[^0-9A-Za-z]/g, "").slice(0, 12))}
            className={campo === "codigo" ? "ring-2 ring-ring" : undefined}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pin">PIN</Label>
          <Input
            id="pin"
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={pin}
            onFocus={() => setCampo("pin")}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className={campo === "pin" ? "ring-2 ring-ring" : undefined}
          />
        </div>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <TecladoPin
          onDigito={escribir}
          onBorrar={borrar}
          onConfirmar={() => void enviar()}
          deshabilitado={enviando}
          puedeConfirmar={puedeEnviar}
        />
        <Button type="submit" size="lg" className="w-full" disabled={!puedeEnviar || enviando}>
          {enviando ? "Ingresando…" : "Ingresar"}
        </Button>
      </form>

      <div className="flex flex-col gap-2 pt-2 text-center text-sm">
        <Link href="/admin/ingresar" className="text-primary underline-offset-4 hover:underline">
          Acceso de administrador
        </Link>
        {dispositivoRevocado ? (
          <button
            type="button"
            className="text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => void olvidarDispositivo().then(() => setDispositivo(null))}
          >
            Olvidar este dispositivo
          </button>
        ) : null}
      </div>
    </Pantalla>
  );
}
