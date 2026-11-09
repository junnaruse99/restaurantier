/**
 * Configuración del agente de impresión, leída de variables de entorno.
 * El agente nunca usa la service_role: se autentica como dispositivo `agente_impresion` (§14.3).
 */
export interface ConfigAgente {
  supabaseUrl: string;
  supabasePublishableKey: string;
  /** Base de las Edge Functions (por defecto `${supabaseUrl}/functions/v1`). */
  funcionesUrl: string;
  /** Token del dispositivo, entregado una sola vez al registrarlo. */
  deviceToken: string;
  /** Respaldo por polling de `print_jobs` (§3). */
  pollingMs: number;
  /** Latido al servidor y relectura de la configuración de impresoras. */
  latidoMs: number;
  /** Valor de ESC t para CP858 (19 en Epson TM-T20 y Xprinter). */
  paginaCodigos: number;
  /** Ruta para impresoras USB sin ruta configurada (Linux: /dev/usb/lp0). */
  rutaUsb: string | undefined;
  /** Puerto del endpoint LAN para el modo offline (§12.3, fase 3). */
  puertoLan: number;
}

function requerida(env: NodeJS.ProcessEnv, nombre: string): string {
  const valor = env[nombre];
  if (!valor) {
    throw new Error(`Falta la variable de entorno ${nombre}`);
  }
  return valor;
}

function entero(
  env: NodeJS.ProcessEnv,
  nombre: string,
  porDefecto: number,
  minimo: number,
): number {
  const valor = Number(env[nombre] ?? porDefecto);
  if (!Number.isInteger(valor) || valor < minimo) {
    throw new Error(`${nombre} debe ser un entero mayor o igual que ${minimo}`);
  }
  return valor;
}

export function leerConfig(env: NodeJS.ProcessEnv = process.env): ConfigAgente {
  const supabaseUrl = requerida(env, "SUPABASE_URL").replace(/\/+$/, "");
  const deviceToken = requerida(env, "WARIKE_DEVICE_TOKEN");
  if (!/^wkd_[0-9a-f]{64}$/.test(deviceToken)) {
    throw new Error("WARIKE_DEVICE_TOKEN no tiene el formato de un token de dispositivo");
  }
  return {
    supabaseUrl,
    supabasePublishableKey: requerida(env, "SUPABASE_PUBLISHABLE_KEY"),
    funcionesUrl: (env.WARIKE_FUNCIONES_URL ?? `${supabaseUrl}/functions/v1`).replace(/\/+$/, ""),
    deviceToken,
    pollingMs: entero(env, "WARIKE_POLLING_MS", 5_000, 500),
    latidoMs: entero(env, "WARIKE_LATIDO_MS", 30_000, 1_000),
    paginaCodigos: entero(env, "WARIKE_PAGINA_CODIGOS", 19, 0),
    rutaUsb: env.WARIKE_USB_RUTA || undefined,
    puertoLan: entero(env, "WARIKE_PUERTO_LAN", 8443, 1),
  };
}
