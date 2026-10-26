import { ZONA_HORARIA } from "@warike/domain";

/** 2 → "2"; 1.5 → "1,5". */
export function formatoCantidad(cantidad: number): string {
  const n = Number(cantidad);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "").replace(".", ",");
}

const hora = new Intl.DateTimeFormat("es-PE", {
  timeZone: ZONA_HORARIA,
  hour: "2-digit",
  minute: "2-digit",
});
const fechaHora = new Intl.DateTimeFormat("es-PE", {
  timeZone: ZONA_HORARIA,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatoHora(instante: string | Date): string {
  return hora.format(typeof instante === "string" ? new Date(instante) : instante);
}

export function formatoFechaHora(instante: string | Date): string {
  return fechaHora.format(typeof instante === "string" ? new Date(instante) : instante);
}
