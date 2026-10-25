/**
 * Contrato del emisor de comprobantes de pago electrónicos (§10).
 *
 * Cambiar de proveedor debe ser solo configuración por local (`locales.proveedor_cpe`).
 * Los DTO se completan en la fase 2 (M13), cuando se construye NubefactEmisor.
 */

/** Catálogo 01 de SUNAT: tipo de comprobante. */
export type TipoCPE = "01" | "03" | "07" | "08";

/** Catálogo 06 de SUNAT: tipo de documento de identidad. */
export type TipoDocumentoIdentidad = "0" | "1" | "4" | "6" | "7";

/** Catálogo 07 de SUNAT (subconjunto usado): afectación del IGV. */
export type AfectacionIGV = "10" | "20" | "30";

export type ProveedorCPE = "nubefact" | "sunat_directo";

export type EstadoEmision = "aceptado" | "observado" | "rechazado" | "pendiente_envio" | "error";

export interface ComprobanteItemDTO {
  descripcion: string;
  cantidad: number;
  unidad: "NIU" | "ZZ";
  /** Sin IGV. */
  valorUnitario: number;
  /** Con IGV. */
  precioUnitario: number;
  igv: number;
  icbper: number;
  total: number;
  afectacionIgv: AfectacionIGV;
}

export interface ComprobanteDTO {
  id: string;
  tipo: TipoCPE;
  serie: string;
  numero: number;
  /** Fecha de emisión en `YYYY-MM-DD` (zona America/Lima). */
  fechaEmision: string;
  cliente: {
    tipoDoc: TipoDocumentoIdentidad;
    numDoc: string;
    nombre: string;
    direccion?: string;
    email?: string;
  };
  moneda: "PEN";
  opGravada: number;
  opExonerada: number;
  opInafecta: number;
  igv: number;
  icbper: number;
  total: number;
  tasaIgvAplicada: number;
  items: ComprobanteItemDTO[];
}

/** Catálogo 09 de SUNAT: motivo de la nota de crédito. */
export type MotivoNotaCredito =
  "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12" | "13";

export interface NotaDTO extends ComprobanteDTO {
  tipo: "07" | "08";
  documentoReferencia: { tipo: "01" | "03"; serie: string; numero: number };
  motivoCodigo: MotivoNotaCredito;
  motivoTexto: string;
}

export interface ResultadoEmision {
  estado: EstadoEmision;
  codigo?: string;
  descripcion?: string;
  enlaces?: { pdf?: string; xml?: string; cdr?: string };
  hash?: string;
  qr?: string;
  /** Respuesta cruda del proveedor, para `comprobantes.response`. */
  respuesta?: unknown;
}

export interface ResultadoBaja {
  tipo: "comunicacion_baja" | "resumen_anulacion";
  estado: "aceptado" | "pendiente" | "rechazado" | "error";
  ticket?: string;
  descripcion?: string;
  respuesta?: unknown;
}

export interface EmisorCPE {
  emitir(cpe: ComprobanteDTO): Promise<ResultadoEmision>;
  consultar(tipo: TipoCPE, serie: string, numero: number): Promise<ResultadoEmision>;
  /** Baja (factura) o anulación en el resumen diario (boleta). */
  anular(cpe: ComprobanteDTO, motivo: string): Promise<ResultadoBaja>;
  emitirNota(nota: NotaDTO): Promise<ResultadoEmision>;
}
