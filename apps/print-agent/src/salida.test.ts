import { mkdtemp, readFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ticket } from "./escpos/comandos";
import { ErrorImpresion, imprimir, imprimirTcp, type Impresora } from "./salida";
import { ImpresoraSimulada } from "./simulador";

const ticket = () => new Ticket({ ancho: 80 }).linea("Mesa 05").cortar().aBuffer();
let simuladas: ImpresoraSimulada[] = [];

afterEach(async () => {
  await Promise.all(simuladas.map((s) => s.cerrar()));
  simuladas = [];
});

async function simulada(): Promise<{ impresora: ImpresoraSimulada; puerto: number }> {
  const impresora = new ImpresoraSimulada();
  simuladas.push(impresora);
  return { impresora, puerto: await impresora.escuchar() };
}

describe("salida TCP (RAW 9100)", () => {
  it("imprime en una impresora de red", async () => {
    const { impresora, puerto } = await simulada();
    await imprimirTcp("127.0.0.1", puerto, ticket());
    await impresora.esperarTickets(1);
    expect(impresora.tickets[0]!.texto).toContain("Mesa 05");
    expect(impresora.tickets[0]!.cortado).toBe(true);
  });

  it("no imprime si el sensor indica que no hay papel", async () => {
    const { impresora, puerto } = await simulada();
    impresora.conPapel = false;
    await expect(imprimirTcp("127.0.0.1", puerto, ticket())).rejects.toMatchObject({
      estado: "sin_papel",
    });
    expect(impresora.tickets).toHaveLength(0);
  });

  it("imprime aunque la impresora no responda la consulta de estado", async () => {
    const recibido: Buffer[] = [];
    let terminar: () => void;
    const fin = new Promise<void>((r) => (terminar = r));
    const servidor = net.createServer((s) => {
      s.on("data", (d) => recibido.push(d));
      s.on("end", () => {
        s.end();
        terminar();
      });
    });
    await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
    const { port } = servidor.address() as net.AddressInfo;
    await imprimirTcp("127.0.0.1", port, ticket());
    await fin;
    servidor.close();
    expect(Buffer.concat(recibido).toString("latin1")).toContain("Mesa 05");
  });

  it("informa offline si la impresora está apagada", async () => {
    const libre = net.createServer();
    await new Promise<void>((r) => libre.listen(0, "127.0.0.1", r));
    const { port } = libre.address() as net.AddressInfo;
    await new Promise((r) => libre.close(r));
    const error = await imprimirTcp("127.0.0.1", port, ticket()).catch((e) => e);
    expect(error).toBeInstanceOf(ErrorImpresion);
    expect(error.estado).toBe("offline");
  });

  it("informa offline si la impresora no responde a tiempo", async () => {
    // Acepta la conexión pero nunca termina de recibir.
    const servidor = net.createServer((s) => s.pause());
    await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
    const { port } = servidor.address() as net.AddressInfo;
    const grande = Buffer.alloc(64 * 1024 * 1024, 0x41);
    const error = await imprimirTcp("127.0.0.1", port, grande, 800).catch((e) => e);
    servidor.close();
    expect(error).toBeInstanceOf(ErrorImpresion);
    expect(error.estado).toBe("offline");
  });
});

describe("salida USB", () => {
  const usb = (host: string | null): Impresora => ({
    id: "i1",
    nombre: "USB",
    tipo_conexion: "usb",
    host,
    puerto: null,
    ancho_mm: 58,
  });

  it("escribe al dispositivo configurado", async () => {
    const ruta = join(await mkdtemp(join(tmpdir(), "warike-")), "lp0");
    await imprimir(usb(ruta), ticket());
    expect((await readFile(ruta)).toString("latin1")).toContain("Mesa 05");
  });

  it("usa la ruta por defecto y falla como offline si no existe", async () => {
    await expect(
      imprimir(usb(null), ticket(), { rutaUsbPorDefecto: "/no/existe/lp0" }),
    ).rejects.toMatchObject({
      estado: "offline",
    });
    await expect(imprimir(usb(null), ticket())).rejects.toMatchObject({ estado: "error" });
  });
});
