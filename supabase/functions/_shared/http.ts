// Utilidades HTTP comunes de las Edge Functions de Warike POS.

const ORIGENES_PERMITIDOS = (Deno.env.get("WARIKE_ALLOWED_ORIGINS") ?? "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function cabecerasCors(req: Request): HeadersInit {
  const origen = req.headers.get("origin") ?? "";
  const permitido = ORIGENES_PERMITIDOS.includes("*")
    ? "*"
    : ORIGENES_PERMITIDOS.includes(origen)
      ? origen
      : "";
  return {
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function json(req: Request, status: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...cabecerasCors(req), "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * IP del cliente según X-Forwarded-For; null si no tiene forma de IP. El primer salto lo puede alterar
 * el cliente, así que solo sirve para el límite de mejor esfuerzo y como dato de auditoría; la base
 * descarta lo que no sea un inet válido (app.a_inet).
 */
export function ipCliente(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  const ip = xff?.split(",")[0]?.trim();
  if (!ip) return null;
  return /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null;
}

/**
 * Límite de solicitudes por clave en ventana deslizante, en memoria del isolate (§14.10).
 * Es una protección de mejor esfuerzo: el bloqueo por intentos fallidos lo garantiza la base de datos.
 */
export class LimitadorSolicitudes {
  readonly #marcas = new Map<string, number[]>();

  constructor(
    private readonly maximo: number,
    private readonly ventanaMs: number,
  ) {}

  permitir(clave: string, ahora = Date.now()): boolean {
    const desde = ahora - this.ventanaMs;
    const marcas = (this.#marcas.get(clave) ?? []).filter((t) => t > desde);
    if (marcas.length >= this.maximo) {
      this.#marcas.set(clave, marcas);
      return false;
    }
    marcas.push(ahora);
    this.#marcas.set(clave, marcas);
    if (this.#marcas.size > 10_000) {
      for (const [k, v] of this.#marcas) {
        if (v.every((t) => t <= desde)) this.#marcas.delete(k);
      }
    }
    return true;
  }
}

/** Decodifica el payload de un JWT sin verificar la firma (solo para leer claims de un token recién emitido). */
export function payloadJwt(token: string): Record<string, unknown> {
  const parte = token.split(".")[1];
  if (!parte) throw new Error("JWT inválido");
  const base64 = parte
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(parte.length / 4) * 4, "=");
  return JSON.parse(atob(base64));
}
