// Envío directo a SUNAT (SEE-Del Contribuyente). **Stub sin implementar en el MVP** (§2, §10.3).
//
// Implementarlo requeriría:
// - Generar XML UBL 2.1 para facturas, boletas y notas.
// - Firmarlo con XAdES usando el Certificado Digital Tributario.
// - Enviarlo por SOAP al `billService` de SUNAT (`sendBill`, `sendSummary`, `getStatus`).
// - Guardar XML y CDR en Supabase Storage, más un backup inmutable.
// - Generar el resumen diario de boletas y la comunicación de baja.
//
// Se reevalúa si el volumen supera 500 documentos al mes de forma sostenida (docs/sunat-directo.md).
import type { ComprobanteDTO, EmisorCPE, ResultadoEmision } from "./tipos.ts";

export class NoImplementadoError extends Error {
  constructor(operacion: string) {
    super(
      `SunatDirectoEmisor.${operacion} no está implementado en el MVP. Ver docs/sunat-directo.md.`,
    );
    this.name = "NoImplementadoError";
  }
}

export class SunatDirectoEmisor implements EmisorCPE {
  emitir(_cpe: ComprobanteDTO): Promise<ResultadoEmision> {
    return Promise.reject(new NoImplementadoError("emitir"));
  }

  consultar(_tipoCpe: string, _serie: string, _numero: number): Promise<ResultadoEmision | null> {
    return Promise.reject(new NoImplementadoError("consultar"));
  }
}
