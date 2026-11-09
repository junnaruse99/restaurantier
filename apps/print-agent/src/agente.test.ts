import { describe, expect, it, vi } from "vitest";
import { Agente } from "./agente";
import { SesionVencida, type Latido, type ServidorAgente, type Trabajo } from "./conexion";
import { ErrorImpresion, type EstadoImpresora, type Impresora } from "./salida";

const cocina: Impresora = {
  id: "imp-cocina",
  nombre: "Cocina",
  tipo_conexion: "tcp",
  host: "10.0.0.5",
  puerto: 9100,
  ancho_mm: 80,
  estado: "ok",
};
const bar: Impresora = {
  id: "imp-bar",
  nombre: "Bar",
  tipo_conexion: "tcp",
  host: "10.0.0.6",
  puerto: 9100,
  ancho_mm: 58,
  estado: "ok",
};

function trabajo(id: string, impresora: Impresora, tipo = "comanda"): Trabajo {
  return {
    id,
    tipo,
    intentos: 1,
    creado_at: new Date().toISOString(),
    impresora,
    payload: {
      tipo,
      comanda_numero: 1,
      orden_numero: 1,
      mesa: "Mesa 01",
      fecha_hora: "",
      items: [{ cantidad: 1, nombre: id }],
    },
  };
}

/** Servidor falso: entrega una cola de lotes y anota lo que el agente reporta. */
class ServidorFalso implements ServidorAgente {
  lotes: Trabajo[][] = [];
  reportes: Array<{ id: string; ok: boolean; error?: string | undefined }> = [];
  estados: Array<{ id: string; estado: EstadoImpresora }> = [];
  ingresos = 0;
  porVencer = false;
  vencerEnProximaToma = false;
  alCambiar: (() => void) | undefined;

  async iniciar() {
    this.ingresos++;
  }
  async latido(): Promise<Latido> {
    return { dispositivo_id: "d", local_id: "l", impresoras: [cocina, bar] };
  }
  async tomarTrabajos(): Promise<Trabajo[]> {
    if (this.vencerEnProximaToma) {
      this.vencerEnProximaToma = false;
      throw new SesionVencida("no_es_agente");
    }
    return this.lotes.shift() ?? [];
  }
  async reportarTrabajo(id: string, ok: boolean, error?: string) {
    this.reportes.push({ id, ok, error });
  }
  async reportarImpresora(id: string, estado: EstadoImpresora) {
    this.estados.push({ id, estado });
  }
  suscribir(alCambiar: () => void) {
    this.alCambiar = alCambiar;
    return () => (this.alCambiar = undefined);
  }
  async cerrar() {}
}

function crear(servidor: ServidorFalso, imprimir: (i: Impresora, d: Buffer) => Promise<void>) {
  return new Agente(servidor, {
    pollingMs: 60_000,
    latidoMs: 60_000,
    paginaCodigos: 19,
    lote: 3,
    imprimir,
    registrar: () => undefined,
  });
}

describe("Agente", () => {
  it("imprime en orden por impresora y reporta cada trabajo", async () => {
    const servidor = new ServidorFalso();
    servidor.lotes = [
      [trabajo("c1", cocina), trabajo("b1", bar), trabajo("c2", cocina)],
      [trabajo("c3", cocina)],
    ];
    const impresos: string[] = [];
    const agente = crear(servidor, async (i, d) => {
      impresos.push(`${i.id}:${d.toString("latin1").match(/1 x (\w+)/)![1]}`);
    });
    await agente.iniciar();
    expect(impresos.filter((x) => x.startsWith("imp-cocina"))).toEqual([
      "imp-cocina:c1",
      "imp-cocina:c2",
      "imp-cocina:c3",
    ]);
    expect(impresos).toContain("imp-bar:b1");
    expect(servidor.reportes.every((r) => r.ok)).toBe(true);
    expect(servidor.reportes).toHaveLength(4);
    expect(servidor.estados).toEqual([]);
    await agente.detener();
  });

  it("si una impresora falla, su cola vuelve a esperar y se informa el estado una sola vez", async () => {
    const servidor = new ServidorFalso();
    servidor.lotes = [[trabajo("c1", cocina), trabajo("c2", cocina), trabajo("b1", bar)]];
    const imprimir = vi.fn(async (i: Impresora) => {
      if (i.id === cocina.id) throw new ErrorImpresion("La impresora no tiene papel", "sin_papel");
    });
    const agente = crear(servidor, imprimir);
    await agente.iniciar();
    expect(imprimir).toHaveBeenCalledTimes(2);
    expect(servidor.reportes).toEqual(
      expect.arrayContaining([
        { id: "c1", ok: false, error: "La impresora no tiene papel" },
        { id: "c2", ok: false, error: "La impresora no tiene papel" },
        { id: "b1", ok: true, error: undefined },
      ]),
    );
    expect(servidor.estados).toEqual([{ id: cocina.id, estado: "sin_papel" }]);

    // Cuando vuelve a imprimir, se informa "ok".
    servidor.lotes = [[trabajo("c1", cocina)]];
    imprimir.mockImplementation(async () => undefined);
    await agente.procesar();
    expect(servidor.estados).toEqual([
      { id: cocina.id, estado: "sin_papel" },
      { id: cocina.id, estado: "ok" },
    ]);
    await agente.detener();
  });

  it("un tipo sin plantilla se reporta como fallido sin cambiar el estado de la impresora", async () => {
    const servidor = new ServidorFalso();
    servidor.lotes = [[trabajo("p1", cocina, "precuenta")]];
    const agente = crear(servidor, async () => undefined);
    await agente.iniciar();
    expect(servidor.reportes[0]).toMatchObject({ id: "p1", ok: false });
    expect(servidor.reportes[0]!.error).toContain("precuenta");
    expect(servidor.estados).toEqual([]);
    await agente.detener();
  });

  it("procesa cuando Realtime avisa y agrupa avisos simultáneos", async () => {
    const servidor = new ServidorFalso();
    const agente = crear(servidor, async () => undefined);
    await agente.iniciar();
    const tomar = vi.spyOn(servidor, "tomarTrabajos");
    servidor.lotes = [[trabajo("c1", cocina)]];
    servidor.alCambiar!();
    servidor.alCambiar!();
    servidor.alCambiar!();
    await agente.procesar();
    expect(servidor.reportes.map((r) => r.id)).toEqual(["c1"]);
    expect(tomar.mock.calls.length).toBeLessThanOrEqual(3);
    await agente.detener();
  });

  it("vuelve a entrar si la sesión del dispositivo venció", async () => {
    const servidor = new ServidorFalso();
    const agente = crear(servidor, async () => undefined);
    await agente.iniciar();
    expect(servidor.ingresos).toBe(1);
    servidor.vencerEnProximaToma = true;
    await agente.procesar();
    expect(servidor.ingresos).toBe(2);

    servidor.porVencer = true;
    await agente.latido();
    expect(servidor.ingresos).toBe(3);
    await agente.detener();
  });
});
