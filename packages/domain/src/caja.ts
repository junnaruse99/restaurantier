/**
 * Cálculos de caja y comprobantes (fase 2, §9): IGV por línea, descuentos, ICBPER, división de la
 * cuenta, pagos, arqueo y validación de RUC/DNI. La base de datos repite lo que hace falta para
 * cobrar (cobrar_y_emitir) y es la autoridad; aquí está la referencia con cobertura de pruebas.
 */
import { redondearMonto } from "./salon";

const aCentimos = (monto: number) => Math.round(redondearMonto(monto) * 100);
const deCentimos = (centimos: number) => centimos / 100;

// ---------------------------------------------------------------------------
// Tasas (config_tributaria): nunca se escribe la tasa en el código.
// ---------------------------------------------------------------------------
export interface ConfigTributaria {
  regimen: string;
  vigencia_desde: string;
  vigencia_hasta: string | null;
  tasa_total: number;
  icbper_unitario: number;
}

/** Fila de config_tributaria vigente para el régimen en la fecha (AAAA-MM-DD) de emisión. */
export function tasaVigente(
  config: readonly ConfigTributaria[],
  regimen: string,
  fecha: string,
): ConfigTributaria {
  const vigente = config.find(
    (c) =>
      c.regimen === regimen &&
      c.vigencia_desde <= fecha &&
      (c.vigencia_hasta === null || fecha <= c.vigencia_hasta),
  );
  if (!vigente) throw new RangeError(`Sin tasa vigente para ${regimen} el ${fecha}`);
  return vigente;
}

// ---------------------------------------------------------------------------
// Comprobante (§9)
// ---------------------------------------------------------------------------
export type AfectacionIgv = "10" | "20" | "30"; // gravado, exonerado, inafecto (catálogo 07)

export interface LineaVenta {
  descripcion: string;
  cantidad: number;
  /** Precio de carta con IGV, por unidad, antes de descuentos. */
  precioUnitario: number;
  /** Descuento sobre el precio con IGV, en porcentaje (p. ej. 15 para el personal). */
  descuentoPct?: number;
  afectacion?: AfectacionIgv;
  /** Bolsa plástica: lleva ICBPER por unidad, fuera de la base del IGV. */
  icbper?: boolean;
}

export interface LineaCalculada {
  descripcion: string;
  cantidad: number;
  afectacion: AfectacionIgv;
  /** Precio unitario con IGV ya descontado. */
  precioUnitario: number;
  /** Valor unitario sin IGV, con 10 decimales. */
  valorUnitario: number;
  valorVenta: number;
  igv: number;
  icbper: number;
  /** Total con IGV, sin ICBPER. */
  total: number;
  descuento: number;
}

export interface TotalesComprobante {
  lineas: LineaCalculada[];
  opGravada: number;
  opExonerada: number;
  opInafecta: number;
  igv: number;
  icbper: number;
  descuentos: number;
  total: number;
}

/** Precio con IGV tras un descuento porcentual, a céntimos (half-up). */
export function aplicarDescuento(precio: number, porcentaje: number): number {
  if (porcentaje < 0 || porcentaje > 100) throw new RangeError("Descuento fuera de 0–100 %");
  return redondearMonto(precio * (1 - porcentaje / 100));
}

/**
 * Totales del comprobante según §9: valor unitario = precio / (1 + tasa) con 10 decimales; valor de
 * venta = round2(valor unitario × cantidad); IGV = total de línea − valor de venta. Así la suma de
 * líneas cuadra siempre con el total; los descuentos se aplican al precio con IGV.
 */
export function calcularComprobante(
  lineas: readonly LineaVenta[],
  tasaTotal: number,
  icbperUnitario = 0,
): TotalesComprobante {
  if (!lineas.length) throw new RangeError("El comprobante no tiene líneas");
  if (tasaTotal < 0 || tasaTotal >= 1) throw new RangeError(`Tasa inválida: ${tasaTotal}`);
  const calculadas = lineas.map((l): LineaCalculada => {
    if (l.cantidad <= 0) throw new RangeError(`Cantidad inválida en ${l.descripcion}`);
    if (l.precioUnitario < 0) throw new RangeError(`Precio inválido en ${l.descripcion}`);
    const afectacion = l.afectacion ?? "10";
    const precioUnitario = aplicarDescuento(l.precioUnitario, l.descuentoPct ?? 0);
    const total = deCentimos(Math.round(precioUnitario * 100 * l.cantidad));
    const bruto = deCentimos(Math.round(redondearMonto(l.precioUnitario) * 100 * l.cantidad));
    const gravada = afectacion === "10";
    const valorUnitario = gravada
      ? Number((precioUnitario / (1 + tasaTotal)).toFixed(10))
      : precioUnitario;
    const valorVenta = gravada ? redondearMonto(valorUnitario * l.cantidad) : total;
    return {
      descripcion: l.descripcion,
      cantidad: l.cantidad,
      afectacion,
      precioUnitario,
      valorUnitario,
      valorVenta,
      igv: deCentimos(aCentimos(total) - aCentimos(valorVenta)),
      icbper: l.icbper ? redondearMonto(icbperUnitario * l.cantidad) : 0,
      total,
      descuento: deCentimos(aCentimos(bruto) - aCentimos(total)),
    };
  });
  const suma = (f: (l: LineaCalculada) => number, filtro?: (l: LineaCalculada) => boolean) =>
    deCentimos(calculadas.filter(filtro ?? (() => true)).reduce((s, l) => s + aCentimos(f(l)), 0));
  const opGravada = suma(
    (l) => l.valorVenta,
    (l) => l.afectacion === "10",
  );
  const opExonerada = suma(
    (l) => l.valorVenta,
    (l) => l.afectacion === "20",
  );
  const opInafecta = suma(
    (l) => l.valorVenta,
    (l) => l.afectacion === "30",
  );
  const igv = suma((l) => l.igv);
  const icbper = suma((l) => l.icbper);
  return {
    lineas: calculadas,
    opGravada,
    opExonerada,
    opInafecta,
    igv,
    icbper,
    descuentos: suma((l) => l.descuento),
    total: deCentimos(
      aCentimos(opGravada) +
        aCentimos(opExonerada) +
        aCentimos(opInafecta) +
        aCentimos(igv) +
        aCentimos(icbper),
    ),
  };
}

// ---------------------------------------------------------------------------
// División de la cuenta y pagos (M12)
// ---------------------------------------------------------------------------

/** Partes iguales; el residuo de céntimos va a la primera parte (§9). */
export function dividirEnPartes(total: number, partes: number): number[] {
  if (!Number.isInteger(partes) || partes < 1) throw new RangeError("Partes inválidas");
  const centimos = aCentimos(total);
  const base = Math.floor(centimos / partes);
  const residuo = centimos - base * partes;
  return Array.from({ length: partes }, (_, i) => deCentimos(base + (i === 0 ? residuo : 0)));
}

/** Vuelto de un pago en efectivo. */
export function calcularVuelto(monto: number, recibido: number): number {
  const vuelto = aCentimos(recibido) - aCentimos(monto);
  if (vuelto < 0) throw new RangeError("El monto recibido no alcanza");
  return deCentimos(vuelto);
}

/** Saldo por cobrar: total − Σ pagos (negativo si se pagó de más). */
export function saldoPendiente(total: number, pagos: readonly number[]): number {
  return deCentimos(aCentimos(total) - pagos.reduce((s, p) => s + aCentimos(p), 0));
}

// ---------------------------------------------------------------------------
// Arqueo (M15)
// ---------------------------------------------------------------------------
export const DENOMINACIONES = [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1] as const;
export type Denominacion = (typeof DENOMINACIONES)[number];

/** Efectivo declarado por denominaciones (cantidad de billetes y monedas de cada valor). */
export function totalDenominaciones(desglose: Partial<Record<string, number>>): number {
  let centimos = 0;
  for (const [valor, cantidad] of Object.entries(desglose)) {
    const denominacion = Number(valor);
    if (!DENOMINACIONES.includes(denominacion as Denominacion))
      throw new RangeError(`Denominación inválida: ${valor}`);
    if (cantidad === undefined) continue;
    if (!Number.isInteger(cantidad) || cantidad < 0)
      throw new RangeError(`Cantidad inválida de S/ ${valor}`);
    centimos += aCentimos(denominacion) * cantidad;
  }
  return deCentimos(centimos);
}

export interface MovimientosEfectivo {
  apertura: number;
  pagosEfectivo: readonly number[];
  vueltos: readonly number[];
  ingresos: readonly number[];
  egresos: readonly number[];
}

/** efectivo_esperado = apertura + Σ pagos en efectivo − Σ vueltos + Σ ingresos − Σ egresos. */
export function efectivoEsperado(m: MovimientosEfectivo): number {
  const sumar = (montos: readonly number[]) => montos.reduce((s, x) => s + aCentimos(x), 0);
  return deCentimos(
    aCentimos(m.apertura) +
      sumar(m.pagosEfectivo) -
      sumar(m.vueltos) +
      sumar(m.ingresos) -
      sumar(m.egresos),
  );
}

/** Diferencia del arqueo: contado − esperado (negativa si falta dinero). */
export function diferenciaArqueo(contado: number, esperado: number): number {
  return deCentimos(aCentimos(contado) - aCentimos(esperado));
}

// ---------------------------------------------------------------------------
// Documentos de identidad (M13)
// ---------------------------------------------------------------------------

/** RUC: 11 dígitos, prefijo 10, 15, 17 o 20 y dígito verificador módulo 11. */
export function rucValido(ruc: string): boolean {
  if (!/^(10|15|17|20)\d{9}$/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((s, p, i) => s + p * Number(ruc[i]), 0);
  const verificador = (11 - (suma % 11)) % 10;
  return verificador === Number(ruc[10]);
}

/** DNI: 8 dígitos. */
export function dniValido(dni: string): boolean {
  return /^\d{8}$/.test(dni);
}
