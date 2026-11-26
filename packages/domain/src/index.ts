/**
 * @warike/domain — cálculos puros del negocio (§9).
 *
 * Fase 1: parámetros regionales y cálculos de salón (montos, fecha operativa, alertas del KDS y
 * modificadores). Fase 2: IGV por línea, descuentos, división de cuentas, pagos, arqueo y RUC/DNI (caja.ts).
 */
export * from "./regional";
export * from "./salon";
export * from "./caja";
