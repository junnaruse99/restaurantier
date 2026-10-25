// Edge Function pin-login (§4.1)
//
// Inicio rápido de mozo, cajero y cocina en un dispositivo registrado: token del dispositivo +
// código de empleado + PIN. Emite una sesión de Supabase Auth ligada al dispositivo por 12 h.
//
// POST { device_token, codigo, pin }
//   200 { session: { access_token, refresh_token, expires_at, expires_in, token_type },
//         usuario: { id, nombre_visible }, dispositivo_id, local_id, sesion_expira_at }
//   400 solicitud_invalida · 401 dispositivo_no_autorizado | credenciales_invalidas
//   403 sin_rol_en_local · 423 bloqueado · 429 demasiadas_solicitudes · 500 error_interno
//
// La verificación del PIN, el conteo de intentos (5 → bloqueo de 15 min) y la vigencia de 12 h
// viven en la base (pin_login_verificar / pin_login_registrar_sesion), no aquí.

import { createClient } from "@supabase/supabase-js";
import {
  cabecerasCors,
  ipCliente,
  json,
  LimitadorSolicitudes,
  payloadJwt,
} from "../_shared/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const FORMATO_TOKEN = /^wkd_[0-9a-f]{64}$/;
const FORMATO_CODIGO = /^[0-9A-Za-z]{3,12}$/;
const FORMATO_PIN = /^[0-9]{4,6}$/;

const ESTADO_POR_ERROR: Record<string, number> = {
  dispositivo_no_autorizado: 401,
  credenciales_invalidas: 401,
  sin_rol_en_local: 403,
  bloqueado: 423,
};

// 20 intentos por minuto por IP y dispositivo.
const limitador = new LimitadorSolicitudes(20, 60_000);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Verificacion {
  ok: boolean;
  error?: string;
  user_id?: string;
  email?: string;
  nombre_visible?: string;
  dispositivo_id?: string;
  local_id?: string;
  bloqueado_hasta?: string;
  intentos_restantes?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cabecerasCors(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "metodo_no_permitido" });
  }

  let cuerpo: { device_token?: unknown; codigo?: unknown; pin?: unknown };
  try {
    cuerpo = await req.json();
  } catch {
    return json(req, 400, { error: "solicitud_invalida" });
  }
  const { device_token: deviceToken, codigo, pin } = cuerpo;
  if (
    typeof deviceToken !== "string" ||
    typeof codigo !== "string" ||
    typeof pin !== "string" ||
    !FORMATO_TOKEN.test(deviceToken) ||
    !FORMATO_CODIGO.test(codigo) ||
    !FORMATO_PIN.test(pin)
  ) {
    return json(req, 400, { error: "solicitud_invalida" });
  }

  const ip = ipCliente(req);
  if (!limitador.permitir(`${ip ?? "?"}|${deviceToken.slice(0, 16)}`)) {
    return json(req, 429, { error: "demasiadas_solicitudes" });
  }

  try {
    // 1. Dispositivo, PIN, bloqueo y roles del local.
    const { data, error } = await admin.rpc("pin_login_verificar", {
      p_device_token: deviceToken,
      p_codigo: codigo,
      p_pin: pin,
      p_ip: ip,
    });
    if (error) throw error;
    const verificacion = data as Verificacion;
    if (!verificacion.ok) {
      const {
        error: codigoError = "credenciales_invalidas",
        bloqueado_hasta,
        intentos_restantes,
      } = verificacion;
      return json(req, ESTADO_POR_ERROR[codigoError] ?? 401, {
        error: codigoError,
        bloqueado_hasta,
        intentos_restantes,
      });
    }

    // 2. Sesión de Supabase Auth para el usuario: enlace mágico generado por el admin y canjeado
    //    aquí mismo (nunca se envía por correo).
    const { data: enlace, error: errorEnlace } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: verificacion.email!,
    });
    if (errorEnlace) throw errorEnlace;

    const publico = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: canje, error: errorCanje } = await publico.auth.verifyOtp({
      token_hash: enlace.properties.hashed_token,
      type: "magiclink",
    });
    if (errorCanje) throw errorCanje;
    const session = canje.session;
    if (!session) throw new Error("Supabase Auth no devolvió sesión");

    // 3. Ligar la sesión al dispositivo por 12 h. Si falla, se cierra la sesión recién creada.
    const sessionId = payloadJwt(session.access_token).session_id;
    const { data: registro, error: errorRegistro } = await admin.rpc("pin_login_registrar_sesion", {
      p_user_id: verificacion.user_id,
      p_dispositivo_id: verificacion.dispositivo_id,
      p_session_id: sessionId,
      p_ip: ip,
    });
    if (errorRegistro) {
      await admin.auth.admin.signOut(session.access_token).catch(() => undefined);
      throw errorRegistro;
    }

    return json(req, 200, {
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        expires_in: session.expires_in,
        token_type: session.token_type,
      },
      usuario: { id: verificacion.user_id, nombre_visible: verificacion.nombre_visible },
      dispositivo_id: verificacion.dispositivo_id,
      local_id: verificacion.local_id,
      sesion_expira_at: (registro as { expira_at: string }).expira_at,
    });
  } catch (e) {
    console.error("[pin-login]", e instanceof Error ? e.message : e);
    return json(req, 500, { error: "error_interno" });
  }
});
