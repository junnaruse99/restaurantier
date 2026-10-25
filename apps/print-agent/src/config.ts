/**
 * Configuración del agente de impresión, leída de variables de entorno.
 * El agente nunca usa la service_role: se autentica como dispositivo `agente_impresion` (§14.3).
 */
export interface ConfigAgente {
  supabaseUrl: string;
  supabasePublishableKey: string;
  /** Token del dispositivo, entregado una sola vez al registrarlo. */
  deviceToken: string;
  /** Respaldo por polling de `print_jobs` (§3). */
  pollingMs: number;
  /** Puerto del endpoint LAN para el modo offline (§12.3). */
  puertoLan: number;
}

function requerida(env: NodeJS.ProcessEnv, nombre: string): string {
  const valor = env[nombre];
  if (!valor) {
    throw new Error(`Falta la variable de entorno ${nombre}`);
  }
  return valor;
}

export function leerConfig(env: NodeJS.ProcessEnv = process.env): ConfigAgente {
  return {
    supabaseUrl: requerida(env, "SUPABASE_URL"),
    supabasePublishableKey: requerida(env, "SUPABASE_PUBLISHABLE_KEY"),
    deviceToken: requerida(env, "WARIKE_DEVICE_TOKEN"),
    pollingMs: Number(env.WARIKE_POLLING_MS ?? 5000),
    puertoLan: Number(env.WARIKE_PUERTO_LAN ?? 8443),
  };
}
