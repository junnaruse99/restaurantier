import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ANON_KEY, FUNCTIONS_URL, LOCAL_GRILL, SERVICE_ROLE_KEY, SUPABASE_URL } from "./entorno";

export const servicio = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function clienteCon(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** POST a una Edge Function; devuelve estado y cuerpo JSON. */
export async function llamarFuncion<T = Record<string, unknown>>(
  nombre: string,
  cuerpo: unknown,
  cabeceras: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${FUNCTIONS_URL}/${nombre}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** Registra un dispositivo propio de la prueba (no toca los de desarrollo). */
export async function crearDispositivo(
  tipo: "tablet_mozo" | "caja" | "kds" | "agente_impresion",
): Promise<{ id: string; token: string }> {
  const token = `wkd_${randomBytes(32).toString("hex")}`;
  const { data, error } = await servicio
    .from("dispositivos")
    .insert({
      local_id: LOCAL_GRILL,
      nombre: `${tipo} integración ${randomUUID().slice(0, 8)}`,
      tipo,
      token_hash: createHash("sha256").update(token).digest("hex"),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id, token };
}

/** Sin borrado físico: los dispositivos de prueba se desactivan al terminar. */
export async function desactivarDispositivo(id: string): Promise<void> {
  await servicio.from("dispositivos").update({ activo: false }).eq("id", id);
}

/** Código TOTP (RFC 6238, SHA-1, 30 s, 6 dígitos) a partir de la clave base32. */
export function codigoTotp(secretoBase32: string, ahora = Date.now()): string {
  const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretoBase32.replace(/=+$/, "").toUpperCase()) {
    bits += alfabeto.indexOf(c).toString(2).padStart(5, "0");
  }
  const clave = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(ahora / 30_000)));
  const hmac = createHmac("sha1", clave).update(contador).digest();
  const desplazamiento = hmac[hmac.length - 1]! & 0xf;
  const numero = (hmac.readUInt32BE(desplazamiento) & 0x7fffffff) % 1_000_000;
  return numero.toString().padStart(6, "0");
}

/**
 * Crea un admin propio de la prueba en el local Grill y devuelve sus sesiones aal1 (solo contraseña)
 * y aal2 (con TOTP enrolado y verificado).
 */
export async function crearAdminConMfa(): Promise<{ id: string; aal1: string; aal2: string }> {
  const email = `admin-${randomUUID().slice(0, 8)}@integracion.test`;
  const password = `Integracion-${randomBytes(6).toString("hex")}A1`;
  const { data: creado, error } = await servicio.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  const id = creado.user.id;
  const { error: errorPerfil } = await servicio
    .from("usuarios_perfil")
    .insert({ user_id: id, nombre_visible: "Admin integración" });
  if (errorPerfil) throw errorPerfil;
  const { data: rol } = await servicio
    .from("roles")
    .select("id")
    .is("empresa_id", null)
    .eq("codigo", "admin")
    .single();
  const { error: errorRol } = await servicio
    .from("user_local_roles")
    .insert({ user_id: id, local_id: LOCAL_GRILL, role_id: rol!.id });
  if (errorRol) throw errorRol;

  const auth = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: ingreso, error: errorIngreso } = await auth.auth.signInWithPassword({
    email,
    password,
  });
  if (errorIngreso) throw errorIngreso;
  const aal1 = ingreso.session!.access_token;

  const { data: factor, error: errorFactor } = await auth.auth.mfa.enroll({ factorType: "totp" });
  if (errorFactor) throw errorFactor;
  const { data: verificado, error: errorVerificacion } = await auth.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: codigoTotp(factor.totp.secret),
  });
  if (errorVerificacion) throw errorVerificacion;
  return { id, aal1, aal2: verificado.access_token };
}
