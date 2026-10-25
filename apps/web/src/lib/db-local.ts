import Dexie, { type EntityTable } from "dexie";

export type TipoDispositivo = "tablet_mozo" | "caja" | "kds";

/** Credencial del dispositivo registrado. Es revocable desde el admin; no es un dato crítico (§1). */
export interface DispositivoLocal {
  clave: "actual";
  token: string;
  dispositivoId: string | null;
  localId: string | null;
  nombre: string;
  tipo: TipoDispositivo | null;
  registradoAt: string;
}

/**
 * Cola de salida para el modo offline (§12.2). Cada mutación lleva un client_mutation_id (UUID v7)
 * y el servidor deduplica con outbox_recibidos. Se usa a partir de la fase 3.
 */
export interface MutacionPendiente {
  clientMutationId: string;
  tipo: string;
  payload: unknown;
  creadaAt: string;
  intentos: number;
}

export const dbLocal = new Dexie("warike-pos") as Dexie & {
  dispositivo: EntityTable<DispositivoLocal, "clave">;
  outbox: EntityTable<MutacionPendiente, "clientMutationId">;
};

dbLocal.version(1).stores({
  dispositivo: "clave",
  outbox: "clientMutationId, creadaAt",
});
