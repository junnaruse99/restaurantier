// NubefactEmisor (§10.2): API REST JSON de Nubefact. Cada cuenta tiene su RUTA (URL) y su TOKEN;
// viven en los secretos de la Edge Function, nunca en el navegador (DECISIONS D-045).
//
// Formato según el manual de integración JSON de Nubefact; los campos se validan contra el
// ambiente demo antes de producción (DECISIONS P13).
import { aDecimal, type ComprobanteDTO, type EmisorCPE, type ResultadoEmision } from "./tipos.ts";

/** Catálogo 01 → tipo_de_comprobante de Nubefact. */
const TIPO_COMPROBANTE: Record<ComprobanteDTO["tipo_cpe"], number> = {
  "01": 1, // factura
  "03": 2, // boleta
  "07": 3, // nota de crédito
  "08": 4, // nota de débito
};

/** Catálogo 06 → cliente_tipo_de_documento ("-" = varios, sin documento). */
const TIPO_DOCUMENTO: Record<ComprobanteDTO["cliente_tipo_doc"], string> = {
  "0": "-",
  "1": "1",
  "4": "4",
  "6": "6",
  "7": "7",
};

/** Catálogo 07 → tipo_de_igv: 1 gravado (operación onerosa), 8 exonerado, 9 inafecto. */
const TIPO_IGV = { "10": 1, "20": 8, "30": 9 } as const;

/** AAAA-MM-DD → DD-MM-AAAA. */
function fechaNubefact(fecha: string): string {
  const [a, m, d] = fecha.split("-");
  return `${d}-${m}-${a}`;
}

/** Cuerpo de "generar_comprobante". */
export function aJsonNubefact(cpe: ComprobanteDTO): Record<string, unknown> {
  const cuerpo: Record<string, unknown> = {
    operacion: "generar_comprobante",
    tipo_de_comprobante: TIPO_COMPROBANTE[cpe.tipo_cpe],
    serie: cpe.serie,
    numero: cpe.numero,
    sunat_transaction: 1,
    cliente_tipo_de_documento: TIPO_DOCUMENTO[cpe.cliente_tipo_doc],
    cliente_numero_de_documento: cpe.cliente_num_doc ?? "-",
    cliente_denominacion: cpe.cliente_nombre,
    cliente_direccion: cpe.cliente_direccion ?? "",
    fecha_de_emision: fechaNubefact(cpe.fecha_emision),
    moneda: 1,
    porcentaje_de_igv: aDecimal(cpe.tasa_igv * 100),
    total_gravada: aDecimal(cpe.op_gravada),
    total_exonerada: aDecimal(cpe.op_exonerada),
    total_inafecta: aDecimal(cpe.op_inafecta),
    total_igv: aDecimal(cpe.igv),
    total_impuestos_bolsas: aDecimal(cpe.icbper),
    total: aDecimal(cpe.total),
    enviar_automaticamente_a_la_sunat: true,
    enviar_automaticamente_al_cliente: false,
    items: cpe.items.map((i, n) => ({
      unidad_de_medida: i.unidad,
      codigo: String(n + 1).padStart(3, "0"),
      descripcion: i.descripcion,
      cantidad: aDecimal(i.cantidad),
      valor_unitario: aDecimal(i.valor_unitario, 6),
      precio_unitario: aDecimal(i.precio_unitario, 6),
      subtotal: aDecimal(i.total - i.igv),
      tipo_de_igv: TIPO_IGV[i.afectacion_igv],
      igv: aDecimal(i.igv),
      impuesto_bolsas: aDecimal(i.icbper),
      total: aDecimal(i.total),
      anticipo_regularizacion: false,
    })),
  };
  if (cpe.tipo_cpe === "07" || cpe.tipo_cpe === "08") {
    if (!cpe.documento_ref) throw new Error("La nota necesita el comprobante que modifica");
    cuerpo.documento_que_se_modifica_tipo =
      TIPO_COMPROBANTE[cpe.documento_ref.tipo_cpe as "01" | "03"];
    cuerpo.documento_que_se_modifica_serie = cpe.documento_ref.serie;
    cuerpo.documento_que_se_modifica_numero = cpe.documento_ref.numero;
    if (cpe.tipo_cpe === "07") cuerpo.tipo_de_nota_de_credito = Number(cpe.motivo_nc_codigo);
    else cuerpo.tipo_de_nota_de_debito = Number(cpe.motivo_nc_codigo);
  }
  return cuerpo;
}

interface RespuestaNubefact {
  aceptada_por_sunat?: boolean;
  sunat_description?: string | null;
  sunat_responsecode?: string | null;
  sunat_soap_error?: string | null;
  enlace_del_pdf?: string;
  enlace_del_xml?: string;
  enlace_del_cdr?: string;
  cadena_para_codigo_qr?: string;
  codigo_hash?: string;
  errors?: string;
  codigo?: number;
}

/**
 * Respuesta de Nubefact → resultado. Con aceptada_por_sunat el comprobante quedó aceptado (con
 * observaciones si el código SUNAT es 4000 o más). Sin aceptación pero con documento generado, Nubefact
 * lo seguirá enviando: queda "observado" hasta la consulta. Un error de validación es "rechazado".
 */
export function interpretarRespuesta(
  estadoHttp: number,
  json: RespuestaNubefact,
): ResultadoEmision {
  const comun = {
    sunat_codigo: json.sunat_responsecode ?? undefined,
    sunat_descripcion: json.sunat_description ?? json.sunat_soap_error ?? json.errors ?? undefined,
    hash: json.codigo_hash,
    qr: json.cadena_para_codigo_qr,
    enlace_pdf: json.enlace_del_pdf,
    enlace_xml: json.enlace_del_xml,
    enlace_cdr: json.enlace_del_cdr,
    response: json,
  };
  if (estadoHttp >= 500) return { estado: "error_red", ...comun };
  if (json.errors) return { estado: "rechazado", ...comun };
  if (json.aceptada_por_sunat) {
    const codigo = Number(json.sunat_responsecode ?? 0);
    return { estado: codigo >= 4000 ? "observado" : "aceptado", ...comun };
  }
  if (json.enlace_del_pdf || json.codigo_hash) return { estado: "observado", ...comun };
  return { estado: "error_red", ...comun };
}

export class NubefactEmisor implements EmisorCPE {
  constructor(
    private readonly ruta: string,
    private readonly token: string,
    private readonly hacerFetch: typeof fetch = fetch,
  ) {}

  private async llamar(cuerpo: Record<string, unknown>): Promise<ResultadoEmision> {
    let res: Response;
    try {
      res = await this.hacerFetch(this.ruta, {
        method: "POST",
        headers: {
          Authorization: `Token token="${this.token}"`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      return {
        estado: "error_red",
        sunat_descripcion: e instanceof Error ? e.message : String(e),
        request: cuerpo,
      };
    }
    let json: RespuestaNubefact;
    try {
      json = (await res.json()) as RespuestaNubefact;
    } catch {
      return {
        estado: "error_red",
        sunat_descripcion: `Respuesta inválida (${res.status})`,
        request: cuerpo,
      };
    }
    return { ...interpretarRespuesta(res.status, json), request: cuerpo };
  }

  async consultar(
    tipoCpe: string,
    serie: string,
    numero: number,
  ): Promise<ResultadoEmision | null> {
    const r = await this.llamar({
      operacion: "consultar_comprobante",
      tipo_de_comprobante: TIPO_COMPROBANTE[tipoCpe as ComprobanteDTO["tipo_cpe"]],
      serie,
      numero,
    });
    // "No existe" llega como error: no es un rechazo del comprobante.
    return r.estado === "rechazado" || r.estado === "error_red" ? null : r;
  }

  /** §10.5 Idempotencia: en un reintento se consulta primero si el número ya existe en Nubefact. */
  async emitir(cpe: ComprobanteDTO): Promise<ResultadoEmision> {
    if (cpe.intentos > 1) {
      const previo = await this.consultar(cpe.tipo_cpe, cpe.serie, cpe.numero);
      if (previo) return previo;
    }
    return this.llamar(aJsonNubefact(cpe));
  }
}
