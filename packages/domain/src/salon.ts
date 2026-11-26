/**
 * Cálculos de salón y cocina (M5, M6, M7). La base de datos es la autoridad (agregar_items,
 * app.fecha_operativa); estas funciones dan la misma respuesta en la UI antes de que llegue la del
 * servidor y validan lo que el mozo elige.
 */
import { ZONA_HORARIA } from "./regional";

/** Redondeo half-up a céntimos sin errores de coma flotante (1.005 → 1.01). */
export function redondearMonto(monto: number): number {
  if (!Number.isFinite(monto)) throw new RangeError(`Monto inválido: ${monto}`);
  const signo = monto < 0 ? -1 : 1;
  const [mantisa, exponente = "0"] = Math.abs(monto).toPrecision(15).split("e");
  const centimos = Math.round(Number(`${mantisa}e${Number(exponente) + 2}`));
  return (signo * centimos) / 100;
}

/** Total de una línea: precio unitario (con recargos de modificadores) × cantidad, a céntimos. */
export function totalLinea(precioUnitario: number, cantidad: number): number {
  if (cantidad <= 0) throw new RangeError("La cantidad debe ser positiva");
  return redondearMonto(precioUnitario * cantidad);
}

/** Suma montos en céntimos enteros. */
export function sumarMontos(montos: readonly number[]): number {
  return montos.reduce((total, m) => total + Math.round(redondearMonto(m) * 100), 0) / 100;
}

const partesLima = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA_HORARIA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Fecha operativa (M5): antes de la hora de corte del local (por defecto 05:00) cuenta como el día
 * anterior. Devuelve `YYYY-MM-DD` en hora de Lima.
 */
export function fechaOperativa(momento: Date, horaCorte = "05:00"): string {
  const p = Object.fromEntries(partesLima.formatToParts(momento).map((x) => [x.type, x.value]));
  const [hc = 0, mc = 0, sc = 0] = horaCorte.split(":").map(Number);
  const segundos = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  const dia = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  if (segundos < hc * 3600 + mc * 60 + sc) dia.setUTCDate(dia.getUTCDate() - 1);
  return dia.toISOString().slice(0, 10);
}

/** Minutos enteros transcurridos desde un instante (nunca negativos). */
export function minutosDesde(desde: Date | string, ahora: Date = new Date()): number {
  const inicio = typeof desde === "string" ? Date.parse(desde) : desde.getTime();
  return Math.max(0, Math.floor((ahora.getTime() - inicio) / 60_000));
}

export type NivelAlerta = "normal" | "amarilla" | "roja";

/** Color del ticket del KDS según su antigüedad (M7: 15 y 25 min por defecto, configurables). */
export function nivelAlertaKds(minutos: number, amarilla = 15, roja = 25): NivelAlerta {
  if (minutos >= roja) return "roja";
  if (minutos >= amarilla) return "amarilla";
  return "normal";
}

export interface GrupoModificador {
  grupo: string;
  min: number;
  max: number;
  /** Opciones válidas con su recargo. */
  opciones: ReadonlyArray<{ nombre: string; precioExtra: number }>;
}

export interface ModificadorElegido {
  grupo: string;
  nombre: string;
}

export interface ResultadoModificadores {
  errores: string[];
  recargo: number;
}

/** Valida lo elegido contra los grupos del producto (misma regla que app.validar_modificadores). */
export function validarModificadores(
  producto: string,
  grupos: readonly GrupoModificador[],
  elegidos: readonly ModificadorElegido[],
): ResultadoModificadores {
  const errores: string[] = [];
  let recargo = 0;
  for (const e of elegidos) {
    if (!grupos.some((g) => g.grupo === e.grupo)) {
      errores.push(`"${producto}" no admite el grupo "${e.grupo}"`);
    }
  }
  for (const g of grupos) {
    const delGrupo = elegidos.filter((e) => e.grupo === g.grupo);
    if (delGrupo.length < g.min || delGrupo.length > g.max) {
      errores.push(
        g.min === g.max
          ? `Elija ${g.min} de "${g.grupo}"`
          : `Elija entre ${g.min} y ${g.max} de "${g.grupo}"`,
      );
    }
    for (const e of delGrupo) {
      const opcion = g.opciones.find((o) => o.nombre === e.nombre);
      if (!opcion) errores.push(`"${e.nombre}" no es una opción de "${g.grupo}"`);
      else recargo = sumarMontos([recargo, opcion.precioExtra]);
    }
  }
  return { errores, recargo };
}

export interface ReglaPrecioDia {
  dia_semana: number;
  precio: number;
  vigencia_desde: string;
  vigencia_hasta: string | null;
}

/**
 * Precio vigente en una fecha operativa (M5): la regla del día de la semana (los feriados marcados
 * se cobran como domingo) o, si no hay regla, el precio de carta. Igual que app.precio_vigente.
 */
export function precioVigente(
  precioCarta: number,
  reglas: readonly ReglaPrecioDia[],
  fecha: string,
  feriadoComoDomingo = false,
): number {
  const dia = feriadoComoDomingo ? 0 : new Date(`${fecha}T12:00:00Z`).getUTCDay();
  const regla = reglas.find(
    (r) =>
      r.dia_semana === dia &&
      fecha >= r.vigencia_desde &&
      (r.vigencia_hasta === null || fecha <= r.vigencia_hasta),
  );
  return regla ? Number(regla.precio) : precioCarta;
}
