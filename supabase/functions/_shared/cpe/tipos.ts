// Interfaz EmisorCPE (§10): el proveedor de facturación electrónica es intercambiable por local
// (locales.proveedor_cpe). Sin dependencias para que lo usen la Edge Function (Deno) y las pruebas
// (packages/billing-adapter, Vitest).

/** Comprobante tal como lo entrega public.cpe_tomar. */
export interface ComprobanteDTO {
  id: string;
  local_id: string;
  proveedor: "nubefact" | "sunat_directo";
  tipo_cpe: "01" | "03" | "07" | "08";
  serie: string;
  numero: number;
  fecha_emision: string; // AAAA-MM-DD
  cliente_tipo_doc: "0" | "1" | "4" | "6" | "7";
  cliente_num_doc: string | null;
  cliente_nombre: string;
  cliente_direccion: string | null;
  moneda: "PEN";
  op_gravada: number;
  op_exonerada: number;
  op_inafecta: number;
  igv: number;
  icbper: number;
  total: number;
  /** Tasa total (IGV + IPM) como fracción: 0.105, 0.15 o 0.18. */
  tasa_igv: number;
  intentos: number;
  documento_ref: { tipo_cpe: string; serie: string; numero: number } | null;
  motivo_nc_codigo: string | null;
  motivo_nc_texto: string | null;
  items: ItemDTO[];
}

export interface ItemDTO {
  descripcion: string;
  cantidad: number;
  unidad: "NIU" | "ZZ";
  valor_unitario: number;
  precio_unitario: number;
  igv: number;
  icbper: number;
  total: number;
  afectacion_igv: "10" | "20" | "30";
}

/** Lo que guarda public.cpe_registrar_resultado. */
export interface ResultadoEmision {
  estado: "aceptado" | "observado" | "rechazado" | "error_red";
  sunat_codigo?: string;
  sunat_descripcion?: string;
  hash?: string;
  qr?: string;
  enlace_pdf?: string;
  enlace_xml?: string;
  enlace_cdr?: string;
  request?: unknown;
  response?: unknown;
}

export interface EmisorCPE {
  emitir(cpe: ComprobanteDTO): Promise<ResultadoEmision>;
  consultar(tipoCpe: string, serie: string, numero: number): Promise<ResultadoEmision | null>;
}

/** Montos con punto decimal y 2 decimales para la API (§1: en la API se usa punto decimal). */
export function aDecimal(monto: number, decimales = 2): number {
  return Number(Number(monto).toFixed(decimales));
}
