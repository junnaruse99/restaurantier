import { Ticket, type OpcionesTicket } from "./comandos";

// Fotos que arma la base al encolar (app.payload_comanda, app.avisar_anulacion, app.avisar_traslado).
export interface ItemComanda {
  cantidad: number;
  nombre: string;
  modificadores?: string[];
  nota?: string | null;
  cuenta?: number | null;
}

export interface PayloadComanda {
  tipo: "comanda";
  local?: string;
  estacion?: string;
  comanda_numero: number;
  orden_numero: number;
  mesa?: string | null;
  mesas_unidas?: string[];
  piso?: string | null;
  mozo?: string | null;
  comensales?: number | null;
  fecha_hora: string;
  reimpresion?: boolean;
  items: ItemComanda[];
}

export interface PayloadAnulacion {
  tipo: "anulacion";
  mesa?: string | null;
  orden_numero: number;
  mozo?: string | null;
  motivo: string;
  motivo_texto?: string | null;
  autorizado_por?: string | null;
  fecha_hora: string;
  items: (ItemComanda & { comanda_numero?: number | null })[];
}

export interface PayloadTraslado {
  tipo: "traslado";
  mesa_origen: string;
  mesa_destino: string;
  orden_numero: number;
  mozo?: string | null;
  fecha_hora: string;
  items: ItemComanda[];
}

export type Payload = PayloadComanda | PayloadAnulacion | PayloadTraslado;

export class PlantillaNoDisponible extends Error {
  constructor(tipo: string) {
    super(`No hay plantilla para trabajos de tipo "${tipo}" en esta versión del agente`);
  }
}

const MOTIVOS: Record<string, string> = {
  error_digitacion: "Error de digitación",
  cliente_desiste: "Cliente desiste",
  demora: "Demora",
  producto_agotado: "Producto agotado",
  calidad: "Calidad",
  otro: "Otro",
};

/** 2 → "2"; 1.5 → "1,5"; 0.25 → "0,25". */
export function formatoCantidad(cantidad: number): string {
  if (Number.isInteger(cantidad)) return String(cantidad);
  return cantidad.toFixed(2).replace(/0$/, "").replace(".", ",");
}

function encabezado(t: Ticket, titulo: string, subtitulo?: string): void {
  t.alinear("centro").negrita(true).tamano(2).linea(titulo).tamano(1);
  if (subtitulo) t.linea(subtitulo);
  t.negrita(false).alinear("izquierda");
}

function items(t: Ticket, lista: ItemComanda[] | undefined, detalle: boolean): void {
  for (const item of lista ?? []) {
    t.negrita(true)
      .tamano(2, true)
      .linea(`${formatoCantidad(item.cantidad)} x ${item.nombre}`)
      .tamano(1)
      .negrita(false);
    if (!detalle) continue;
    for (const m of item.modificadores ?? []) t.linea(`- ${m}`, 4);
    if (item.nota) t.negrita(true).linea(`* ${item.nota}`, 4).negrita(false);
    if (item.cuenta && item.cuenta > 1) t.linea(`(cuenta ${item.cuenta})`, 4);
  }
}

/** Comanda (§13): la mesa en letra grande y corte parcial. */
export function comanda(p: PayloadComanda, opciones: OpcionesTicket): Buffer {
  const t = new Ticket(opciones);
  if (p.reimpresion) {
    t.alinear("centro").negrita(true).linea("*** REIMPRESIÓN ***").negrita(false);
  }
  encabezado(t, (p.estacion ?? "Comanda").toUpperCase(), p.local);
  t.alinear("centro")
    .negrita(true)
    .tamano(3)
    .linea(p.mesa ?? "Sin mesa")
    .tamano(1);
  if (p.mesas_unidas?.length) t.linea(`+ ${p.mesas_unidas.join(", ")}`);
  t.negrita(false).alinear("izquierda").separador();
  t.dosColumnas(`Comanda ${p.comanda_numero}`, `Orden ${p.orden_numero}`);
  if (p.mozo) t.dosColumnas("Mozo", p.mozo);
  if (p.piso || p.comensales)
    t.dosColumnas(p.piso ?? "", p.comensales ? `${p.comensales} pax` : "");
  t.dosColumnas("Hora", p.fecha_hora).separador();
  items(t, p.items, true);
  return t.separador().cortar().aBuffer();
}

/** Aviso de anulación para la estación que ya tenía el ítem (CU9.2). */
export function anulacion(p: PayloadAnulacion, opciones: OpcionesTicket): Buffer {
  const t = new Ticket(opciones);
  encabezado(t, "*** ANULACIÓN ***");
  t.alinear("centro")
    .negrita(true)
    .tamano(2)
    .linea(p.mesa ?? "Sin mesa")
    .tamano(1)
    .negrita(false);
  t.alinear("izquierda").separador();
  t.dosColumnas(`Orden ${p.orden_numero}`, p.fecha_hora);
  if (p.mozo) t.dosColumnas("Mozo", p.mozo);
  t.separador();
  items(t, p.items, true);
  t.separador();
  t.linea(
    `Motivo: ${MOTIVOS[p.motivo] ?? p.motivo}${p.motivo_texto ? ` - ${p.motivo_texto}` : ""}`,
  );
  if (p.autorizado_por) t.linea(`Autorizó: ${p.autorizado_por}`);
  return t.cortar().aBuffer();
}

/** Aviso de cambio de mesa ("Mesa 05 -> Mesa 22") para las estaciones con ítems pendientes (CA M8). */
export function traslado(p: PayloadTraslado, opciones: OpcionesTicket): Buffer {
  const t = new Ticket(opciones);
  encabezado(t, "TRASLADO");
  t.alinear("centro")
    .negrita(true)
    .tamano(2)
    .linea(`${p.mesa_origen} → ${p.mesa_destino}`)
    .tamano(1)
    .negrita(false);
  t.alinear("izquierda").separador();
  t.dosColumnas(`Orden ${p.orden_numero}`, p.fecha_hora);
  if (p.mozo) t.dosColumnas("Mozo", p.mozo);
  t.separador();
  items(t, p.items, false);
  return t.cortar().aBuffer();
}

/** Arma el ticket de un trabajo. Pre-cuenta, comprobantes y cortes llegan en la fase 2. */
export function renderizar(tipo: string, payload: unknown, opciones: OpcionesTicket): Buffer {
  switch (tipo) {
    case "comanda":
      return comanda(payload as PayloadComanda, opciones);
    case "anulacion":
      return anulacion(payload as PayloadAnulacion, opciones);
    case "traslado":
      return traslado(payload as PayloadTraslado, opciones);
    default:
      throw new PlantillaNoDisponible(tipo);
  }
}
