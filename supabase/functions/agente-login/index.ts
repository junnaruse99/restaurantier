// Edge Function agente-login (§3, §14.3)
//
// El agente de impresión entra con el token de su dispositivo (tipo agente_impresion). La primera vez
// se le crea un usuario técnico, cuyo único permiso es imprimir; nunca recibe la service_role.
// La sesión de Supabase Auth queda ligada al dispositivo por 24 h y el agente la renueva con su
// refresh_token o volviendo a entrar.
//
// POST { device_token }
//   200 { session, dispositivo_id, local_id, nombre, sesion_expira_at }
//   400 solicitud_invalida · 401 dispositivo_no_autorizado · 429 demasiadas_solicitudes
//   500 error_interno

import {
  cabecerasCors,
  ipCliente,
  json,
  LimitadorSolicitudes,
  payloadJwt,
} from "../_shared/http.ts";
import {
  clienteAdmin,
  contrasenaAleatoria,
  crearSesion,
  sesionPublica,
} from "../_shared/sesion.ts";

const FORMATO_TOKEN = /^wkd_[0-9a-f]{64}$/;

// 10 ingresos por minuto por IP y dispositivo.
const limitador = new LimitadorSolicitudes(10, 60_000);

const admin = clienteAdmin();

interface Preparacion {
  ok: boolean;
  error?: string;
  requiere_usuario?: boolean;
  dispositivo_id?: string;
  local_id?: string;
  nombre?: string;
  user_id?: string;
  email?: string;
}

/** Crea (o recupera, si un intento anterior quedó a medias) el usuario técnico del agente. */
async function crearUsuarioAgente(dispositivoId: string): Promise<{ id: string; email: string }> {
  const email = `agente-${dispositivoId}@agente.warike.invalid`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: contrasenaAleatoria(),
    email_confirm: true,
    app_metadata: { tipo: "agente_impresion", dispositivo_id: dispositivoId },
  });
  if (!error) return { id: data.user.id, email };
  // Ya existe: lo creó un intento anterior o un ingreso simultáneo (Auth responde email_exists o,
  // si choca en la misma transacción, un error de base de datos). generateLink lo devuelve.
  const { data: enlace, error: errorEnlace } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (errorEnlace) throw error;
  return { id: enlace.user.id, email };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cabecerasCors(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "metodo_no_permitido" });
  }

  let cuerpo: { device_token?: unknown };
  try {
    cuerpo = await req.json();
  } catch {
    return json(req, 400, { error: "solicitud_invalida" });
  }
  const deviceToken = cuerpo.device_token;
  if (typeof deviceToken !== "string" || !FORMATO_TOKEN.test(deviceToken)) {
    return json(req, 400, { error: "solicitud_invalida" });
  }

  const ip = ipCliente(req);
  if (!limitador.permitir(`${ip ?? "?"}|${deviceToken.slice(0, 16)}`)) {
    return json(req, 429, { error: "demasiadas_solicitudes" });
  }

  try {
    // 1. Dispositivo de tipo agente, activo.
    const { data, error } = await admin.rpc("agente_preparar_sesion", {
      p_device_token: deviceToken,
      p_ip: ip,
    });
    if (error) throw error;
    const preparacion = data as Preparacion;
    if (!preparacion.ok) {
      return json(req, 401, { error: preparacion.error ?? "dispositivo_no_autorizado" });
    }

    // 2. Usuario técnico (solo la primera vez).
    let email = preparacion.email;
    if (preparacion.requiere_usuario) {
      const usuario = await crearUsuarioAgente(preparacion.dispositivo_id!);
      const { error: errorVinculo } = await admin.rpc("agente_vincular_usuario", {
        p_dispositivo_id: preparacion.dispositivo_id,
        p_user_id: usuario.id,
      });
      // Otro ingreso simultáneo pudo vincularlo primero: se usa el mismo usuario.
      if (errorVinculo && errorVinculo.details !== "agente_ya_vinculado") throw errorVinculo;
      email = usuario.email;
    }

    // 3. Sesión ligada al dispositivo. Si no se puede registrar, se cierra.
    const session = await crearSesion(admin, email!);
    const sessionId = payloadJwt(session.access_token).session_id;
    const { data: registro, error: errorRegistro } = await admin.rpc("agente_registrar_sesion", {
      p_dispositivo_id: preparacion.dispositivo_id,
      p_session_id: sessionId,
      p_ip: ip,
    });
    if (errorRegistro) {
      await admin.auth.admin.signOut(session.access_token, "local").catch(() => undefined);
      throw errorRegistro;
    }

    return json(req, 200, {
      session: sesionPublica(session),
      dispositivo_id: preparacion.dispositivo_id,
      local_id: preparacion.local_id,
      nombre: preparacion.nombre,
      sesion_expira_at: (registro as { expira_at: string }).expira_at,
    });
  } catch (e) {
    console.error("[agente-login]", e instanceof Error ? e.message : e);
    return json(req, 500, { error: "error_interno" });
  }
});
