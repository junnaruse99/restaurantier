import { codificarCp858 } from "./cp858";

/** Columnas de la fuente A según el ancho del papel. */
export const COLUMNAS: Record<58 | 80, number> = { 58: 32, 80: 48 };

const ESC = 0x1b;
const GS = 0x1d;

export type Alineacion = "izquierda" | "centro" | "derecha";

export interface OpcionesTicket {
  ancho: 58 | 80;
  /** Valor de ESC t para CP858: 19 en Epson y la mayoría de genéricas (Xprinter). */
  paginaCodigos?: number;
}

/**
 * Constructor de tickets ESC/POS. Solo usa comandos del juego básico de Epson (ESC @, ESC t,
 * ESC a, ESC E, GS !, ESC d, GS V, ESC p), que también entienden las impresoras genéricas.
 */
export class Ticket {
  readonly columnas: number;
  readonly #partes: Buffer[] = [];
  #multiplicador = 1;

  constructor(opciones: OpcionesTicket) {
    this.columnas = COLUMNAS[opciones.ancho];
    this.#bytes(ESC, 0x40, ESC, 0x74, opciones.paginaCodigos ?? 19);
  }

  #bytes(...valores: number[]): this {
    this.#partes.push(Buffer.from(valores));
    return this;
  }

  /** Columnas disponibles con el tamaño de letra actual. */
  get columnasActuales(): number {
    return Math.floor(this.columnas / this.#multiplicador);
  }

  alinear(alineacion: Alineacion): this {
    return this.#bytes(ESC, 0x61, { izquierda: 0, centro: 1, derecha: 2 }[alineacion]);
  }

  negrita(activa: boolean): this {
    return this.#bytes(ESC, 0x45, activa ? 1 : 0);
  }

  /** Tamaño de letra: 1 normal, 2 doble alto y ancho, 3 triple. */
  tamano(multiplicador: 1 | 2 | 3, soloAlto = false): this {
    this.#multiplicador = soloAlto ? 1 : multiplicador;
    const n = multiplicador - 1;
    return this.#bytes(GS, 0x21, (soloAlto ? 0 : n << 4) | n);
  }

  /** Escribe texto partiendo las líneas largas por palabras. */
  linea(texto = "", sangria = 0): this {
    for (const parte of partirLinea(texto, this.columnasActuales, sangria)) {
      this.#partes.push(codificarCp858(`${parte}\n`));
    }
    return this;
  }

  /** Una línea tal cual, sin partir ni compactar espacios. */
  #literal(texto: string): this {
    this.#partes.push(codificarCp858(`${texto}\n`));
    return this;
  }

  /** Texto a la izquierda y a la derecha en la misma línea (p. ej. "Mozo" … "Juan"). */
  dosColumnas(izquierda: string, derecha: string): this {
    const ancho = this.columnasActuales;
    const espacio = ancho - izquierda.length - derecha.length;
    if (espacio < 1)
      return this.linea(izquierda).alinear("derecha").linea(derecha).alinear("izquierda");
    return this.#literal(`${izquierda}${" ".repeat(espacio)}${derecha}`);
  }

  separador(caracter = "-"): this {
    return this.#literal(caracter.repeat(this.columnasActuales));
  }

  avanzar(lineas = 1): this {
    return this.#bytes(ESC, 0x64, lineas);
  }

  /** Avanza el papel y hace un corte parcial (§13). */
  cortar(): this {
    return this.avanzar(4).#bytes(GS, 0x56, 0x01);
  }

  /** Pulso al cajón de dinero (ESC p, pin 2). */
  abrirCajon(): this {
    return this.#bytes(ESC, 0x70, 0x00, 0x19, 0xfa);
  }

  aBuffer(): Buffer {
    return Buffer.concat(this.#partes);
  }
}

/** Parte un texto en líneas de `ancho` columnas, cortando por palabras y con sangría opcional. */
export function partirLinea(texto: string, ancho: number, sangria = 0): string[] {
  const prefijo = " ".repeat(sangria);
  const util = Math.max(ancho - sangria, 1);
  const lineas: string[] = [];
  for (const parrafo of texto.split("\n")) {
    let actual = "";
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      if (!actual) {
        actual = palabra;
      } else if (actual.length + 1 + palabra.length <= util) {
        actual += ` ${palabra}`;
      } else {
        lineas.push(actual);
        actual = palabra;
      }
      while (actual.length > util) {
        lineas.push(actual.slice(0, util));
        actual = actual.slice(util);
      }
    }
    lineas.push(actual);
  }
  return lineas.map((l) => (l ? prefijo + l : l));
}
