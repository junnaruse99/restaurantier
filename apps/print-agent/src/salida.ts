import { open } from "node:fs/promises";
import net from "node:net";

export interface Impresora {
  id: string;
  nombre: string;
  tipo_conexion: "tcp" | "usb";
  host: string | null;
  puerto: number | null;
  ancho_mm: 58 | 80;
  estado?: string;
}

export type EstadoImpresora = "ok" | "sin_papel" | "offline" | "error";

/** Error de impresión con el estado que se informa de la impresora. */
export class ErrorImpresion extends Error {
  constructor(
    message: string,
    readonly estado: EstadoImpresora,
  ) {
    super(message);
  }
}

export interface OpcionesSalida {
  timeoutMs?: number;
  /** Ruta del dispositivo para impresoras USB sin ruta propia (Linux: /dev/usb/lp0). */
  rutaUsbPorDefecto?: string;
}

// DLE EOT 4: estado del sensor de papel. Bits 5 y 6 (0x60) = papel agotado.
const CONSULTA_PAPEL = Buffer.from([0x10, 0x04, 0x04]);

/**
 * Envía un ticket a una impresora de red (RAW, puerto 9100). Antes de imprimir consulta el sensor de
 * papel; si la impresora no responde la consulta (algunas genéricas no la implementan), imprime igual.
 */
export function imprimirTcp(
  host: string,
  puerto: number,
  datos: Buffer,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: puerto });
    let fase: "conectando" | "consultando" | "imprimiendo" = "conectando";
    let terminado = false;
    const terminar = (error?: ErrorImpresion) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(espera);
      clearTimeout(esperaEstado);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    let esperaEstado: NodeJS.Timeout | undefined;
    const espera = setTimeout(
      () => terminar(new ErrorImpresion(`La impresora ${host}:${puerto} no responde`, "offline")),
      timeoutMs,
    );

    const imprimir = () => {
      if (fase === "imprimiendo") return;
      fase = "imprimiendo";
      clearTimeout(esperaEstado);
      socket.end(datos, () => terminar());
    };

    socket.once("connect", () => {
      fase = "consultando";
      socket.write(CONSULTA_PAPEL);
      esperaEstado = setTimeout(imprimir, 400);
    });
    socket.on("data", (respuesta) => {
      if (fase !== "consultando") return;
      const estado = respuesta[0]!;
      if ((estado & 0x60) === 0x60) {
        terminar(new ErrorImpresion("La impresora no tiene papel", "sin_papel"));
      } else {
        imprimir();
      }
    });
    socket.on("error", (e: NodeJS.ErrnoException) => {
      terminar(
        new ErrorImpresion(
          `No se pudo imprimir en ${host}:${puerto}: ${e.code ?? e.message}`,
          "offline",
        ),
      );
    });
  });
}

/** Impresora USB: se escribe directo al dispositivo (/dev/usb/lp0) o a la impresora compartida de Windows (\\localhost\EPSON). */
export async function imprimirUsb(ruta: string, datos: Buffer): Promise<void> {
  let archivo;
  try {
    archivo = await open(ruta, "w");
    await archivo.write(datos);
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    throw new ErrorImpresion(
      `No se pudo imprimir en ${ruta}: ${error.code ?? error.message}`,
      "offline",
    );
  } finally {
    await archivo?.close();
  }
}

export async function imprimir(
  impresora: Impresora,
  datos: Buffer,
  opciones: OpcionesSalida = {},
): Promise<void> {
  if (impresora.tipo_conexion === "tcp") {
    if (!impresora.host)
      throw new ErrorImpresion(`La impresora ${impresora.nombre} no tiene dirección`, "error");
    return imprimirTcp(impresora.host, impresora.puerto ?? 9100, datos, opciones.timeoutMs);
  }
  const ruta = impresora.host ?? opciones.rutaUsbPorDefecto;
  if (!ruta)
    throw new ErrorImpresion(`La impresora USB ${impresora.nombre} no tiene ruta`, "error");
  return imprimirUsb(ruta, datos);
}
