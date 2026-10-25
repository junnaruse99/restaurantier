"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Label } from "@warike/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Cargando, Pantalla } from "@/components/pantalla";
import { cerrarSesion } from "@/lib/pin-login";
import { destinoSeguro } from "@/lib/navegacion";
import { supabase } from "@/lib/supabase";

type Estado =
  | { modo: "cargando" }
  | { modo: "verificar"; factorId: string }
  | { modo: "enrolar"; factorId: string; qr: string; secreto: string }
  | { modo: "error"; mensaje: string };

function SegundoFactor() {
  const router = useRouter();
  const consultas = useQueryClient();
  const siguiente = destinoSeguro(useSearchParams().get("siguiente"));
  const [estado, setEstado] = useState<Estado>({ modo: "cargando" });
  const [codigo, setCodigo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iniciado = useRef(false);

  useEffect(() => {
    if (iniciado.current) return;
    iniciado.current = true;

    void (async () => {
      const cliente = supabase();
      const { data: sesion } = await cliente.auth.getSession();
      if (!sesion.session) {
        router.replace(`/admin/ingresar?siguiente=${encodeURIComponent(siguiente)}`);
        return;
      }
      const { data: factores, error: errorFactores } = await cliente.auth.mfa.listFactors();
      if (errorFactores) {
        setEstado({ modo: "error", mensaje: "No se pudieron leer los factores de verificación." });
        return;
      }
      const verificado = factores.totp.find((f) => f.status === "verified");
      if (verificado) {
        setEstado({ modo: "verificar", factorId: verificado.id });
        return;
      }
      // Primer ingreso: se descartan enrolamientos a medias y se crea uno nuevo.
      for (const f of factores.all.filter((x) => x.status === "unverified")) {
        await cliente.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data: alta, error: errorAlta } = await cliente.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Warike POS ${new Date().toISOString()}`,
        issuer: "Warike POS",
      });
      if (errorAlta) {
        setEstado({ modo: "error", mensaje: "No se pudo iniciar el registro del autenticador." });
        return;
      }
      setEstado({
        modo: "enrolar",
        factorId: alta.id,
        qr: alta.totp.qr_code,
        secreto: alta.totp.secret,
      });
    })();
  }, [router, siguiente]);

  async function verificar(e: React.FormEvent) {
    e.preventDefault();
    if (estado.modo !== "verificar" && estado.modo !== "enrolar") return;
    setEnviando(true);
    setError(null);
    const { error: errorVerificacion } = await supabase().auth.mfa.challengeAndVerify({
      factorId: estado.factorId,
      code: codigo,
    });
    setEnviando(false);
    if (errorVerificacion) {
      setCodigo("");
      setError("Código incorrecto o vencido. Revise la hora del teléfono e intente de nuevo.");
      return;
    }
    await consultas.invalidateQueries();
    router.replace(siguiente);
  }

  if (estado.modo === "cargando") return <Cargando />;
  if (estado.modo === "error") {
    return (
      <Pantalla titulo="Verificación en dos pasos">
        <Alert variant="destructive">{estado.mensaje}</Alert>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => void cerrarSesion().then(() => router.replace("/admin/ingresar"))}
        >
          Volver
        </Button>
      </Pantalla>
    );
  }

  return (
    <Pantalla
      titulo="Verificación en dos pasos"
      descripcion={
        estado.modo === "enrolar"
          ? "Es obligatoria para administradores y auditores. Escanee el código con una app autenticadora (Google Authenticator, Microsoft Authenticator, 1Password…) e ingrese el código de 6 dígitos."
          : "Ingrese el código de 6 dígitos de su app autenticadora."
      }
    >
      {estado.modo === "enrolar" ? (
        <div className="flex flex-col items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- QR en data URI entregado por Supabase Auth */}
          <img
            src={estado.qr}
            alt="Código QR para la app autenticadora"
            className="h-48 w-48 rounded bg-white p-2"
          />
          <p className="text-xs text-muted-foreground">
            ¿No puede escanear? Clave:{" "}
            <code data-testid="secreto-totp" className="break-all font-mono">
              {estado.secreto}
            </code>
          </p>
        </div>
      ) : null}
      <form className="space-y-4" onSubmit={(e) => void verificar(e)}>
        <div className="space-y-2">
          <Label htmlFor="codigo-totp">Código de verificación</Label>
          <Input
            id="codigo-totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={codigo}
            onChange={(e) => setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
        </div>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={codigo.length !== 6 || enviando}
        >
          {enviando ? "Verificando…" : "Verificar"}
        </Button>
      </form>
      <Button
        variant="ghost"
        className="w-full"
        onClick={() => void cerrarSesion().then(() => router.replace("/admin/ingresar"))}
      >
        Cancelar
      </Button>
    </Pantalla>
  );
}

export default function PaginaMfa() {
  return (
    <Suspense fallback={<Cargando />}>
      <SegundoFactor />
    </Suspense>
  );
}
