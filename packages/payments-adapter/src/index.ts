/**
 * Contrato del procesador de cobros con tarjeta y QR por terminal POS (§10.2).
 *
 * Implementaciones previstas (fase 2 y 2b):
 * - `SimuladorProcesador`: aprueba, rechaza o expira según el monto (p. ej. un monto que termina en ,13 se rechaza).
 * - `ManualProcesador`: respaldo; el cajero registra voucher y últimos 4 dígitos.
 * - `NiubizProcesador`: se construye solo con la documentación oficial de Niubiz. No se inventan endpoints.
 *
 * Las llamadas reales a Niubiz ocurren únicamente en Edge Functions (`pos-iniciar`, `pos-estado`, `pos-anular`).
 * El sistema nunca recibe ni guarda el número completo de la tarjeta.
 */

/** Mismo dominio que `transacciones_pos.estado`. */
export type EstadoPOS =
  | "creada"
  | "enviada_terminal"
  | "aprobada"
  | "rechazada"
  | "cancelada"
  | "expirada"
  | "error"
  | "pendiente_conciliacion";

export type MarcaTarjeta = "visa" | "mastercard" | "amex" | "diners" | "qr" | "otra";

export interface SolicitudCobro {
  terminalId: string;
  monto: number;
  moneda: "PEN";
  referenciaInterna: string;
}

export interface ResultadoPOS {
  estado: EstadoPOS;
  codigoAutorizacion?: string;
  marca?: MarcaTarjeta;
  ultimos4?: string;
  mensaje?: string;
  respuesta?: unknown;
}

export interface ProcesadorPOS {
  iniciarCobro(req: SolicitudCobro): Promise<{ idExterno: string; estado: EstadoPOS }>;
  consultarEstado(idExterno: string): Promise<ResultadoPOS>;
  /** Antes de que el cliente pague. */
  cancelarCobro(idExterno: string): Promise<ResultadoPOS>;
  /** Reverso posterior. */
  anularTransaccion(idExterno: string, monto: number): Promise<ResultadoPOS>;
}
