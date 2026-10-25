import { dbLocal, type DispositivoLocal, type TipoDispositivo } from "./db-local";

export const FORMATO_TOKEN_DISPOSITIVO = /^wkd_[0-9a-f]{64}$/;

export function esTokenValido(token: string): boolean {
  return FORMATO_TOKEN_DISPOSITIVO.test(token.trim());
}

export async function obtenerDispositivo(): Promise<DispositivoLocal | undefined> {
  return dbLocal.dispositivo.get("actual");
}

export async function guardarDispositivo(datos: {
  token: string;
  nombre: string;
  dispositivoId?: string | null;
  localId?: string | null;
  tipo?: TipoDispositivo | null;
}): Promise<DispositivoLocal> {
  const token = datos.token.trim();
  if (!esTokenValido(token)) {
    throw new Error(
      "El token del dispositivo no tiene el formato esperado (wkd_ + 64 caracteres hexadecimales)",
    );
  }
  const registro: DispositivoLocal = {
    clave: "actual",
    token,
    nombre: datos.nombre.trim() || "Dispositivo",
    dispositivoId: datos.dispositivoId ?? null,
    localId: datos.localId ?? null,
    tipo: datos.tipo ?? null,
    registradoAt: new Date().toISOString(),
  };
  await dbLocal.dispositivo.put(registro);
  return registro;
}

/** Completa los datos del dispositivo con lo que devuelve pin-login (id y local). */
export async function actualizarDispositivo(cambios: {
  dispositivoId: string;
  localId: string;
}): Promise<void> {
  await dbLocal.dispositivo.update("actual", cambios);
}

export async function olvidarDispositivo(): Promise<void> {
  await dbLocal.dispositivo.delete("actual");
}
