import { supabase } from "./supabase";
import { uuidv7 } from "./uuid";

/**
 * Error de una RPC de Warike. Las RPC fallan con SQLSTATE PTxxx: el estado HTTP va en `estado`, el
 * código estable para decidir qué hacer en `codigo` (p. ej. "mesa_ocupada") y el texto para la
 * persona en `message`.
 */
export class ErrorRpc extends Error {
  constructor(
    message: string,
    readonly codigo: string,
    readonly estado?: number,
  ) {
    super(message);
  }
}

interface ErrorPostgrest {
  message: string;
  code?: string;
  details?: string | null;
}

export function aErrorRpc(error: ErrorPostgrest): ErrorRpc {
  const estado = /^PT\d{3}$/.test(error.code ?? "") ? Number(error.code!.slice(2)) : undefined;
  if (estado) return new ErrorRpc(error.message, error.details || "error", estado);
  if (/fetch|network|load failed/i.test(error.message)) {
    return new ErrorRpc(
      "Sin conexión con el servidor. Reintente en unos segundos.",
      "sin_conexion",
    );
  }
  if (error.code === "42501")
    return new ErrorRpc("No tiene permiso para esta acción.", "sin_permiso", 403);
  return new ErrorRpc(error.message, error.code || "error");
}

export async function rpc<T>(nombre: string, argumentos?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().rpc(nombre, argumentos);
  if (error) throw aErrorRpc(error);
  return data as T;
}

/**
 * Mutación idempotente: lleva un client_mutation_id y, si se corta la conexión, se reintenta con el
 * mismo id (el servidor la aplica una sola vez y devuelve el mismo resultado, §12.2).
 */
export async function mutar<T>(
  nombre: string,
  argumentos: Record<string, unknown>,
  intentos = 3,
): Promise<T> {
  const argumentosConId = { ...argumentos, p_client_mutation_id: uuidv7() };
  for (let intento = 1; ; intento++) {
    try {
      return await rpc<T>(nombre, argumentosConId);
    } catch (e) {
      if (!(e instanceof ErrorRpc) || e.codigo !== "sin_conexion" || intento >= intentos) throw e;
      await new Promise((r) => setTimeout(r, 400 * intento));
    }
  }
}

export function mensajeDeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Ocurrió un error inesperado.";
}
