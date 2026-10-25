"use client";

import { Alert, Button, Input, Label } from "@warike/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Cargando, Pantalla } from "@/components/pantalla";
import { destinoSeguro } from "@/lib/navegacion";
import { supabase } from "@/lib/supabase";

function FormularioAdmin() {
  const router = useRouter();
  const siguiente = destinoSeguro(useSearchParams().get("siguiente"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    const { error: errorLogin } = await supabase().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (errorLogin) {
      setEnviando(false);
      setError(
        errorLogin.message === "Invalid login credentials"
          ? "Email o contraseña incorrectos."
          : "No se pudo iniciar sesión. Intente de nuevo.",
      );
      return;
    }
    // Admin y auditor siempre completan el segundo factor (TOTP) antes de ver datos (§4.1).
    const { data: nivel } = await supabase().auth.mfa.getAuthenticatorAssuranceLevel();
    router.replace(
      nivel?.currentLevel === "aal2"
        ? siguiente
        : `/admin/mfa?siguiente=${encodeURIComponent(siguiente)}`,
    );
  }

  return (
    <Pantalla
      titulo="Acceso de administrador"
      descripcion="Administradores y auditores: email, contraseña y código de verificación (MFA)."
    >
      <form className="space-y-4" onSubmit={(e) => void enviar(e)}>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Contraseña</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Button type="submit" size="lg" className="w-full" disabled={enviando}>
          {enviando ? "Verificando…" : "Continuar"}
        </Button>
      </form>
      <p className="text-center text-sm">
        <Link href="/ingresar" className="text-primary underline-offset-4 hover:underline">
          Ingresar con código y PIN
        </Link>
      </p>
    </Pantalla>
  );
}

export default function IngresarAdmin() {
  return (
    <Suspense fallback={<Cargando />}>
      <FormularioAdmin />
    </Suspense>
  );
}
