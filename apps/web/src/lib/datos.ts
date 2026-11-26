import { aErrorRpc } from "./rpc";

/** Ejecuta una escritura directa (insert/update permitidos por RLS y privilegios de columna). */
export async function escribir<T = unknown>(
  consulta: PromiseLike<{
    data?: T | null;
    error: { message: string; code?: string; details?: string | null } | null;
  }>,
): Promise<T> {
  const { data, error } = await consulta;
  if (error) throw aErrorRpc(error);
  return data as T;
}
