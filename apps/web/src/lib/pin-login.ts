import { actualizarDispositivo } from "./dispositivo";
import { supabase, SUPABASE_KEY, SUPABASE_URL } from "./supabase";

export type ErrorPinLogin =
  | "solicitud_invalida"
  | "dispositivo_no_autorizado"
  | "credenciales_invalidas"
  | "sin_rol_en_local"
  | "bloqueado"
  | "demasiadas_solicitudes"
  | "error_interno"
  | "sin_conexion";

export type ResultadoPinLogin =
  | { ok: true; nombreVisible: string; localId: string; sesionExpiraAt: string }
  | { ok: false; error: ErrorPinLogin; intentosRestantes?: number; bloqueadoHasta?: string };

interface RespuestaPinLogin {
  error?: ErrorPinLogin;
  intentos_restantes?: number;
  bloqueado_hasta?: string;
  session?: { access_token: string; refresh_token: string };
  usuario?: { id: string; nombre_visible: string };
  dispositivo_id?: string;
  local_id?: string;
  sesion_expira_at?: string;
}

const CLAVE_EXPIRACION = "warike-pos-sesion-pin-expira";

/** Inicio rápido con código de empleado + PIN en un dispositivo registrado (§4.1). */
export async function iniciarSesionConPin(datos: {
  deviceToken: string;
  codigo: string;
  pin: string;
}): Promise<ResultadoPinLogin> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/pin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
      body: JSON.stringify({
        device_token: datos.deviceToken,
        codigo: datos.codigo,
        pin: datos.pin,
      }),
    });
  } catch {
    return { ok: false, error: "sin_conexion" };
  }

  const cuerpo = (await res.json().catch(() => ({}))) as RespuestaPinLogin;
  if (!res.ok || !cuerpo.session) {
    return {
      ok: false,
      error: cuerpo.error ?? "error_interno",
      intentosRestantes: cuerpo.intentos_restantes,
      bloqueadoHasta: cuerpo.bloqueado_hasta,
    };
  }

  const { error } = await supabase().auth.setSession(cuerpo.session);
  if (error) return { ok: false, error: "error_interno" };

  localStorage.setItem(CLAVE_EXPIRACION, cuerpo.sesion_expira_at!);
  await actualizarDispositivo({ dispositivoId: cuerpo.dispositivo_id!, localId: cuerpo.local_id! });

  return {
    ok: true,
    nombreVisible: cuerpo.usuario!.nombre_visible,
    localId: cuerpo.local_id!,
    sesionExpiraAt: cuerpo.sesion_expira_at!,
  };
}

/** Mensaje en español para cada resultado fallido de pin-login. */
export function mensajeErrorPin(
  resultado: Extract<ResultadoPinLogin, { ok: false }>,
  ahora = new Date(),
): string {
  switch (resultado.error) {
    case "credenciales_invalidas":
      return resultado.intentosRestantes !== undefined
        ? `Código o PIN incorrecto. Le quedan ${resultado.intentosRestantes} ${
            resultado.intentosRestantes === 1 ? "intento" : "intentos"
          }.`
        : "Código o PIN incorrecto.";
    case "bloqueado": {
      if (!resultado.bloqueadoHasta) return "Usuario bloqueado temporalmente. Intente más tarde.";
      const minutos = Math.max(
        1,
        Math.ceil((Date.parse(resultado.bloqueadoHasta) - ahora.getTime()) / 60_000),
      );
      return `Demasiados intentos fallidos. Usuario bloqueado por ${minutos} ${minutos === 1 ? "minuto" : "minutos"}.`;
    }
    case "dispositivo_no_autorizado":
      return "Este dispositivo no está autorizado o fue revocado. Pida al administrador que lo registre.";
    case "sin_rol_en_local":
      return "Su usuario no tiene un rol habilitado para ingresar con PIN en este local.";
    case "demasiadas_solicitudes":
      return "Demasiados intentos seguidos. Espere un minuto.";
    case "solicitud_invalida":
      return "El código debe tener de 3 a 12 caracteres y el PIN de 4 a 6 dígitos.";
    case "sin_conexion":
      return "Sin conexión con el servidor. Verifique internet e intente de nuevo.";
    case "error_interno":
      return "Ocurrió un error al iniciar sesión. Intente de nuevo.";
  }
}

/** Hora en que vence la sesión PIN (12 h), si hay una. */
export function expiracionSesionPin(): Date | null {
  const valor = typeof localStorage === "undefined" ? null : localStorage.getItem(CLAVE_EXPIRACION);
  return valor ? new Date(valor) : null;
}

export async function cerrarSesion(): Promise<void> {
  localStorage.removeItem(CLAVE_EXPIRACION);
  await supabase().auth.signOut();
}
