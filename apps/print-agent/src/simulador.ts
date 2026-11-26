import net from "node:net";
import { decodificarCp858 } from "./escpos/cp858";

/** Longitud de cada comando ESC/POS que emite el agente (sin contar el texto). */
const LONGITUD: Record<string, number> = {
  "1b40": 2, // ESC @
  "1b74": 3, // ESC t n
  "1b61": 3, // ESC a n
  "1b45": 3, // ESC E n
  "1d21": 3, // GS ! n
  "1b64": 3, // ESC d n
  "1d56": 3, // GS V m
  "1b70": 5, // ESC p m t1 t2
  "1004": 3, // DLE EOT n
};

export interface TicketSimulado {
  texto: string;
  cortado: boolean;
  cajon: boolean;
}

/** Separa un flujo ESC/POS en tickets de texto (un ticket por corte). */
export function leerEscpos(datos: Buffer): TicketSimulado[] {
  const tickets: TicketSimulado[] = [];
  let texto: number[] = [];
  let cajon = false;
  let i = 0;
  while (i < datos.length) {
    const b = datos[i]!;
    if (b === 0x1b || b === 0x1d || b === 0x10) {
      const clave = datos.subarray(i, i + 2).toString("hex");
      const largo = LONGITUD[clave] ?? 2;
      if (clave === "1d56") {
        tickets.push({ texto: decodificarCp858(Uint8Array.from(texto)), cortado: true, cajon });
        texto = [];
        cajon = false;
      }
      if (clave === "1b70") cajon = true;
      i += largo;
      continue;
    }
    texto.push(b);
    i++;
  }
  if (texto.some((c) => c !== 0x0a))
    tickets.push({ texto: decodificarCp858(Uint8Array.from(texto)), cortado: false, cajon });
  return tickets;
}

/**
 * Impresora de red simulada (RAW 9100) para desarrollo y pruebas: responde la consulta de papel
 * (DLE EOT 4) y guarda lo impreso como texto.
 */
export class ImpresoraSimulada {
  readonly tickets: TicketSimulado[] = [];
  /** Con false, responde "sin papel" a la consulta de estado. */
  conPapel = true;
  readonly #servidor: net.Server;
  readonly #esperas: Array<{ cantidad: number; resolver: () => void }> = [];

  constructor(private readonly alImprimir?: (ticket: TicketSimulado) => void) {
    this.#servidor = net.createServer((socket) => {
      const partes: Buffer[] = [];
      socket.on("data", (d) => {
        if (d[0] === 0x10 && d[1] === 0x04) {
          socket.write(Buffer.from([this.conPapel ? 0x12 : 0x72]));
          d = d.subarray(3);
        }
        if (d.length) partes.push(d);
      });
      socket.on("end", () => {
        for (const t of leerEscpos(Buffer.concat(partes))) {
          this.tickets.push(t);
          this.alImprimir?.(t);
        }
        for (const e of this.#esperas.filter((x) => this.tickets.length >= x.cantidad)) {
          e.resolver();
          this.#esperas.splice(this.#esperas.indexOf(e), 1);
        }
        socket.end();
      });
      socket.on("error", () => undefined);
    });
  }

  escuchar(puerto = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#servidor.once("error", reject);
      this.#servidor.listen(puerto, host, () =>
        resolve((this.#servidor.address() as net.AddressInfo).port),
      );
    });
  }

  /** Espera a que haya al menos `cantidad` tickets impresos. */
  esperarTickets(cantidad: number, timeoutMs = 10_000): Promise<void> {
    if (this.tickets.length >= cantidad) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const espera = setTimeout(
        () =>
          reject(new Error(`se esperaban ${cantidad} tickets; llegaron ${this.tickets.length}`)),
        timeoutMs,
      );
      this.#esperas.push({
        cantidad,
        resolver: () => {
          clearTimeout(espera);
          resolve();
        },
      });
    });
  }

  cerrar(): Promise<void> {
    return new Promise((resolve) => this.#servidor.close(() => resolve()));
  }
}
