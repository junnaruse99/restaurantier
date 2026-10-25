// Edge Function admin-usuarios (CU4.1)
//
// Alta de usuarios desde el panel de admin. Crear la cuenta de Supabase Auth necesita la service_role,
// así que no puede hacerse desde el navegador; los permisos se comprueban con la sesión de quien da
// el alta (validar_alta_usuario: gestionar_usuarios en el local, sesión con MFA).
//
// POST (Authorization: Bearer <JWT del admin>)
//   { local_id, role_id, nombre_visible, codigo_empleado?, pin?, empleado_id?, email?, password? }
//   - Roles con MFA (admin, auditor): email y contraseña inicial; el TOTP se enrola al primer ingreso.
//   - Resto (mozo, cajero, cocina): código de empleado y PIN; el email es sintético.
//   201 { user_id, rol }
//   400 solicitud_invalida | <validación> · 401 no_autenticado · 403 sin_permiso
//   409 codigo_duplicado | email_duplicado · 500 error_interno
//
// Si el perfil no se puede crear, se borra la cuenta de Auth recién creada.

import { createClient, type PostgrestError } from "@supabase/supabase-js";
import { cabecerasCors, json } from "../_shared/http.ts";
import { ANON_KEY, clienteAdmin, contrasenaAleatoria, SUPABASE_URL } from "../_shared/sesion.ts";

const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATO_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const admin = clienteAdmin();

interface Solicitud {
  local_id: string;
  role_id: string;
  nombre_visible: string;
  codigo_empleado?: string;
  pin?: string;
  empleado_id?: string;
  email?: string;
  password?: string;
}

function esTextoOpcional(v: unknown): v is string | undefined {
  return v === undefined || v === null || typeof v === "string";
}

function leerSolicitud(cuerpo: Record<string, unknown>): Solicitud | null {
  const { local_id, role_id, nombre_visible, codigo_empleado, pin, empleado_id, email, password } =
    cuerpo;
  if (
    typeof local_id !== "string" ||
    typeof role_id !== "string" ||
    typeof nombre_visible !== "string" ||
    !FORMATO_UUID.test(local_id) ||
    !FORMATO_UUID.test(role_id) ||
    ![codigo_empleado, pin, empleado_id, email, password].every(esTextoOpcional) ||
    (empleado_id && !FORMATO_UUID.test(empleado_id as string))
  ) {
    return null;
  }
  return {
    local_id,
    role_id,
    nombre_visible,
    codigo_empleado: (codigo_empleado as string) || undefined,
    pin: (pin as string) || undefined,
    empleado_id: (empleado_id as string) || undefined,
    email: (email as string)?.trim().toLowerCase() || undefined,
    password: (password as string) || undefined,
  };
}

/** Respuesta para un error de una RPC: las de Warike usan SQLSTATE PTxxx con el código en details. */
function respuestaError(req: Request, error: PostgrestError): Response {
  const estado = /^PT\d{3}$/.test(error.code) ? Number(error.code.slice(2)) : 500;
  if (estado === 500) throw error;
  return json(req, estado, { error: error.details || "error", mensaje: error.message });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cabecerasCors(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "metodo_no_permitido" });
  }
  const autorizacion = req.headers.get("authorization");
  if (!autorizacion?.startsWith("Bearer ")) {
    return json(req, 401, { error: "no_autenticado" });
  }

  let solicitud: Solicitud | null;
  try {
    const cuerpo = await req.json();
    solicitud = cuerpo && typeof cuerpo === "object" ? leerSolicitud(cuerpo) : null;
  } catch {
    solicitud = null;
  }
  if (!solicitud) {
    return json(req, 400, { error: "solicitud_invalida" });
  }

  try {
    // 1. Permisos de quien da el alta, con su propia sesión.
    const solicitante = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: autorizacion } },
    });
    const { data: validacion, error: errorValidacion } = await solicitante.rpc(
      "validar_alta_usuario",
      { p_local_id: solicitud.local_id, p_role_id: solicitud.role_id },
    );
    if (errorValidacion) {
      if (errorValidacion.code === "PGRST301" || errorValidacion.code === "PGRST302") {
        return json(req, 401, { error: "no_autenticado" });
      }
      return respuestaError(req, errorValidacion);
    }
    const { solicitante: creadoPor, requiere_mfa: requiereMfa } = validacion as {
      solicitante: string;
      requiere_mfa: boolean;
    };

    // 2. Cuenta de Auth.
    let email: string;
    let password: string;
    if (requiereMfa) {
      if (!solicitud.email || !FORMATO_EMAIL.test(solicitud.email)) {
        return json(req, 400, { error: "email_invalido", mensaje: "Indique un email válido" });
      }
      if (!solicitud.password || solicitud.password.length < 12) {
        return json(req, 400, {
          error: "contrasena_invalida",
          mensaje: "La contraseña inicial debe tener al menos 12 caracteres",
        });
      }
      email = solicitud.email;
      password = solicitud.password;
    } else {
      if (!solicitud.codigo_empleado || !solicitud.pin) {
        return json(req, 400, {
          error: "codigo_y_pin_requeridos",
          mensaje: "El personal de salón y cocina entra con código y PIN",
        });
      }
      email = `u-${solicitud.codigo_empleado.toLowerCase()}@pin.warike.invalid`;
      password = contrasenaAleatoria();
    }
    const { data: creado, error: errorCreacion } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (errorCreacion) {
      if (errorCreacion.code === "email_exists") {
        return requiereMfa
          ? json(req, 409, { error: "email_duplicado", mensaje: "Ya existe un usuario con ese email" })
          : json(req, 409, {
              error: "codigo_duplicado",
              mensaje: "Ya existe un usuario con ese código de empleado",
            });
      }
      if (errorCreacion.code === "weak_password") {
        return json(req, 400, { error: "contrasena_invalida", mensaje: errorCreacion.message });
      }
      throw errorCreacion;
    }
    const userId = creado.user.id;

    // 3. Perfil, rol y PIN en una transacción; si falla, se deshace la cuenta de Auth.
    const { data: perfil, error: errorPerfil } = await admin.rpc("crear_perfil_usuario", {
      p_user_id: userId,
      p_local_id: solicitud.local_id,
      p_role_id: solicitud.role_id,
      p_nombre_visible: solicitud.nombre_visible,
      p_codigo_empleado: requiereMfa ? solicitud.codigo_empleado ?? null : solicitud.codigo_empleado,
      p_pin: requiereMfa ? null : solicitud.pin,
      p_empleado_id: solicitud.empleado_id ?? null,
      p_creado_por: creadoPor,
    });
    if (errorPerfil) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
      return respuestaError(req, errorPerfil);
    }
    return json(req, 201, perfil);
  } catch (e) {
    console.error("[admin-usuarios]", e instanceof Error ? e.message : e);
    return json(req, 500, { error: "error_interno" });
  }
});
