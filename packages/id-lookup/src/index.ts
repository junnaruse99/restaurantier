/**
 * Consulta de RUC y DNI (§11).
 *
 * Orden: `doc_cache` (TTL 30 días RUC / 180 días DNI) → proveedor primario → secundario → ingreso manual.
 * Solo se ejecuta desde la Edge Function `lookup-doc`, con un límite de 30 consultas por minuto por dispositivo.
 * Los proveedores se implementan en la fase 2.
 */

/** Datos mínimos que se guardan de un RUC. */
export interface DatosRUC {
  ruc: string;
  razonSocial: string;
  direccionFiscal: string | null;
  estado: string;
  condicion: string;
}

/** De un DNI solo se guarda el nombre. */
export interface DatosDNI {
  dni: string;
  nombre: string;
}

export interface ConsultaDocumento {
  ruc(numero: string): Promise<DatosRUC | null>;
  dni(numero: string): Promise<DatosDNI | null>;
}
