import { SesionVencida, type ServidorAgente, type Trabajo } from "./conexion";
import { renderizar } from "./escpos/plantillas";
import {
  ErrorImpresion,
  imprimir as imprimirEnImpresora,
  type EstadoImpresora,
  type Impresora,
} from "./salida";

export interface OpcionesAgente {
  pollingMs: number;
  latidoMs: number;
  paginaCodigos: number;
  rutaUsb?: string | undefined;
  /** Trabajos por toma (la RPC acepta hasta 50). */
  lote?: number;
  /** Salida a la impresora; en las pruebas se reemplaza. */
  imprimir?: (impresora: Impresora, datos: Buffer) => Promise<void>;
  registrar?: (nivel: "info" | "error", mensaje: string) => void;
}

function registroPorDefecto(nivel: "info" | "error", mensaje: string): void {
  const linea = `${new Date().toISOString()} [print-agent] ${mensaje}`;
  if (nivel === "error") console.error(linea);
  else console.log(linea);
}

/**
 * Ciclo del agente (§3, §13): se entera de los trabajos por Realtime, con polling de respaldo,
 * los imprime en orden por impresora, reporta el resultado (la base reintenta con espera creciente)
 * e informa el estado de cada impresora cuando cambia.
 */
export class Agente {
  readonly #estados = new Map<string, EstadoImpresora>();
  readonly #temporizadores: NodeJS.Timeout[] = [];
  #cancelarSuscripcion: (() => void) | undefined;
  #procesando: Promise<void> | undefined;
  #pendiente = false;
  #detenido = false;

  constructor(
    private readonly servidor: ServidorAgente,
    private readonly opciones: OpcionesAgente,
  ) {}

  get #registrar() {
    return this.opciones.registrar ?? registroPorDefecto;
  }

  async iniciar(): Promise<void> {
    await this.servidor.iniciar();
    await this.latido();
    this.#cancelarSuscripcion = this.servidor.suscribir(() => void this.procesar());
    this.#temporizadores.push(
      setInterval(() => void this.procesar(), this.opciones.pollingMs),
      setInterval(() => void this.latido(), this.opciones.latidoMs),
    );
    this.#registrar("info", "agente en línea");
    await this.procesar();
  }

  async detener(): Promise<void> {
    this.#detenido = true;
    this.#temporizadores.forEach(clearInterval);
    this.#cancelarSuscripcion?.();
    await this.#procesando;
    await this.servidor.cerrar();
  }

  /** Latido: mantiene el último ping y la lista de impresoras con su estado. */
  async latido(): Promise<void> {
    try {
      if (this.servidor.porVencer) await this.servidor.iniciar();
      const { impresoras } = await this.servidor.latido();
      for (const i of impresoras)
        if (i.estado) this.#estados.set(i.id, i.estado as EstadoImpresora);
    } catch (e) {
      await this.#manejarError(e, "latido");
    }
  }

  /** Toma y procesa trabajos hasta vaciar la cola. Llamadas simultáneas se agrupan en una sola vuelta extra. */
  procesar(): Promise<void> {
    if (this.#procesando) {
      this.#pendiente = true;
      return this.#procesando;
    }
    this.#procesando = (async () => {
      try {
        do {
          this.#pendiente = false;
          await this.#vaciarCola();
        } while (this.#pendiente && !this.#detenido);
      } finally {
        this.#procesando = undefined;
      }
    })();
    return this.#procesando;
  }

  async #vaciarCola(): Promise<void> {
    const lote = this.opciones.lote ?? 10;
    try {
      for (let vuelta = 0; vuelta < 20 && !this.#detenido; vuelta++) {
        const trabajos = await this.servidor.tomarTrabajos(lote);
        if (trabajos.length === 0) return;
        // En orden dentro de cada impresora; en paralelo entre impresoras.
        const porImpresora = new Map<string, Trabajo[]>();
        for (const t of trabajos)
          porImpresora.set(t.impresora.id, [...(porImpresora.get(t.impresora.id) ?? []), t]);
        await Promise.all([...porImpresora.values()].map((cola) => this.#imprimirCola(cola)));
        if (trabajos.length < lote) return;
      }
    } catch (e) {
      await this.#manejarError(e, "cola");
    }
  }

  async #imprimirCola(cola: Trabajo[]): Promise<void> {
    let fallo: ErrorImpresion | undefined;
    for (const trabajo of cola) {
      // Si la impresora falló, el resto de su cola vuelve a esperar sin intentar imprimir.
      if (fallo) {
        await this.servidor.reportarTrabajo(trabajo.id, false, fallo.message);
        continue;
      }
      try {
        const datos = renderizar(trabajo.tipo, trabajo.payload, {
          ancho: trabajo.impresora.ancho_mm,
          paginaCodigos: this.opciones.paginaCodigos,
        });
        await (this.opciones.imprimir ?? this.#imprimirReal)(trabajo.impresora, datos);
        await this.servidor.reportarTrabajo(trabajo.id, true);
        await this.#informarEstado(trabajo.impresora, "ok");
        this.#registrar(
          "info",
          `${trabajo.tipo} impresa en ${trabajo.impresora.nombre} (${trabajo.id})`,
        );
      } catch (e) {
        const mensaje = e instanceof Error ? e.message : String(e);
        await this.servidor.reportarTrabajo(trabajo.id, false, mensaje);
        this.#registrar(
          "error",
          `${trabajo.tipo} en ${trabajo.impresora.nombre}: ${mensaje} (intento ${trabajo.intentos})`,
        );
        if (e instanceof ErrorImpresion) {
          fallo = e;
          await this.#informarEstado(trabajo.impresora, e.estado);
        }
      }
    }
  }

  #imprimirReal = (impresora: Impresora, datos: Buffer) =>
    imprimirEnImpresora(impresora, datos, { rutaUsbPorDefecto: this.opciones.rutaUsb });

  async #informarEstado(impresora: Impresora, estado: EstadoImpresora): Promise<void> {
    if (this.#estados.get(impresora.id) === estado) return;
    this.#estados.set(impresora.id, estado);
    try {
      await this.servidor.reportarImpresora(impresora.id, estado);
    } catch (e) {
      this.#estados.delete(impresora.id);
      await this.#manejarError(e, "estado de impresora");
    }
  }

  async #manejarError(e: unknown, contexto: string): Promise<void> {
    if (e instanceof SesionVencida && !this.#detenido) {
      this.#registrar("info", "sesión vencida; volviendo a entrar");
      try {
        await this.servidor.iniciar();
        return;
      } catch (reingreso) {
        e = reingreso;
      }
    }
    this.#registrar("error", `${contexto}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
