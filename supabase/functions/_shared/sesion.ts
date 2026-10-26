// Sesiones de Supabase Auth emitidas desde una Edge Function (pin-login, agente-login).

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export function clienteAdmin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Obtiene una sesión de Supabase Auth con un enlace mágico generado por el admin y canjeado aquí
 * mismo (nunca se envía por correo). Cada enlace nuevo invalida el anterior del mismo usuario, así
 * que dos ingresos simultáneos (dos equipos o un doble toque) pueden pisarse: se reintenta.
 */
export async function crearSesion(admin: SupabaseClient, email: string): Promise<Session> {
  const publico = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let ultimoError: unknown;
  for (let intento = 0; intento < 3; intento++) {
    const { data: enlace, error: errorEnlace } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (errorEnlace) throw errorEnlace;
    const { data: canje, error: errorCanje } = await publico.auth.verifyOtp({
      token_hash: enlace.properties.hashed_token,
      type: "magiclink",
    });
    if (!errorCanje && canje.session) return canje.session;
    ultimoError = errorCanje ?? new Error("Supabase Auth no devolvió sesión");
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
  }
  throw ultimoError;
}

/** Solo los campos de la sesión que necesita el cliente. */
export function sesionPublica(session: Session) {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type,
  };
}

/**
 * Contraseña aleatoria para usuarios que nunca la usan (entran con PIN o como agente). El sufijo fijo
 * cumple la política de Auth (minúsculas, mayúsculas y dígitos); la entropía la dan los 32 bytes.
 */
export function contrasenaAleatoria(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") + "Wk7";
}
