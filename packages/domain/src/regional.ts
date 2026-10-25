/**
 * Parámetros regionales (§1 de la especificación).
 *
 * La UI muestra los montos como `S/ 1.234,50` por defecto; el formato es configurable.
 * La API y la base de datos usan siempre punto decimal.
 */

export const ZONA_HORARIA = "America/Lima";
export const MONEDA = "PEN";
export const IDIOMA_UI = "es-PE";

export interface FormatoMoneda {
  simbolo: string;
  separadorMiles: string;
  separadorDecimal: string;
}

export const FORMATO_MONEDA_POR_DEFECTO: FormatoMoneda = {
  simbolo: "S/",
  separadorMiles: ".",
  separadorDecimal: ",",
};

/**
 * Convierte un monto no negativo a céntimos enteros con redondeo half-up.
 * Desplaza la coma en la representación decimal (no multiplica en coma flotante),
 * así 1.005 → 101 y 2.675 → 268.
 */
function aCentimos(montoAbsoluto: number): number {
  const [mantisa, exponente = "0"] = montoAbsoluto.toPrecision(15).split("e");
  return Math.round(Number(`${mantisa}e${Number(exponente) + 2}`));
}

/**
 * Formatea un monto en soles para mostrarlo en la UI.
 * Redondea half-up a 2 decimales trabajando en céntimos enteros.
 */
export function formatearMoneda(
  monto: number,
  formato: FormatoMoneda = FORMATO_MONEDA_POR_DEFECTO,
): string {
  if (!Number.isFinite(monto)) {
    throw new RangeError(`Monto inválido: ${monto}`);
  }
  const centimos = aCentimos(Math.abs(monto));
  const negativo = monto < 0 && centimos > 0;
  const enteros = Math.floor(centimos / 100).toString();
  const decimales = (centimos % 100).toString().padStart(2, "0");
  const conMiles = enteros.replace(/\B(?=(\d{3})+(?!\d))/g, formato.separadorMiles);
  return `${negativo ? "-" : ""}${formato.simbolo} ${conMiles}${formato.separadorDecimal}${decimales}`;
}
