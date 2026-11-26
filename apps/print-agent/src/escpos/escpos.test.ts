import { describe, expect, it } from "vitest";
import { leerEscpos } from "../simulador";
import { partirLinea, Ticket } from "./comandos";
import { codificarCp858, decodificarCp858 } from "./cp858";
import {
  comanda,
  anulacion,
  formatoCantidad,
  PlantillaNoDisponible,
  renderizar,
  traslado,
  type PayloadComanda,
} from "./plantillas";

describe("CP858", () => {
  it("codifica ñ, tildes y signos del castellano", () => {
    expect([...codificarCp858("ñÑáéíóúÁÉÍÓÚü¿¡€°")]).toEqual([
      0xa4, 0xa5, 0xa0, 0x82, 0xa1, 0xa2, 0xa3, 0xb5, 0x90, 0xd6, 0xe0, 0xe9, 0x81, 0xa8, 0xad,
      0xd5, 0xf8,
    ]);
  });

  it("aproxima lo que no existe en la página de códigos", () => {
    expect(codificarCp858("Mesa 05 → Mesa 22").toString("latin1")).toBe("Mesa 05 -> Mesa 22");
    expect(codificarCp858("ŝ😀").toString("latin1")).toBe("s?");
  });

  it("decodifica lo que codifica", () => {
    const texto = "Ají de gallina · Señor ¿algo más? ¡Sí!";
    expect(decodificarCp858(codificarCp858(texto))).toBe(texto);
  });
});

describe("Ticket", () => {
  it("parte líneas por palabras con sangría", () => {
    expect(partirLinea("Lomo saltado con arroz y papas fritas", 16, 2)).toEqual([
      "  Lomo saltado",
      "  con arroz y",
      "  papas fritas",
    ]);
    expect(partirLinea("Supercalifragilístico", 8)).toEqual(["Supercal", "ifragilí", "stico"]);
  });

  it("inicializa, elige CP858 y corta", () => {
    const datos = new Ticket({ ancho: 80 }).linea("Hola").cortar().aBuffer();
    expect([...datos.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 19]);
    expect([...datos.subarray(-3)]).toEqual([0x1d, 0x56, 0x01]);
  });

  it("usa 48 columnas en 80 mm y 32 en 58 mm; la letra doble ocupa el doble", () => {
    expect(new Ticket({ ancho: 80 }).columnas).toBe(48);
    const t = new Ticket({ ancho: 58 });
    expect(t.columnasActuales).toBe(32);
    t.tamano(2);
    expect(t.columnasActuales).toBe(16);
    t.tamano(2, true);
    expect(t.columnasActuales).toBe(32);
  });

  it("alinea dos columnas al ancho del papel", () => {
    const [ticket] = leerEscpos(
      new Ticket({ ancho: 58 }).dosColumnas("Mozo", "Ana").cortar().aBuffer(),
    );
    expect(ticket!.texto.split("\n")[0]).toBe(`Mozo${" ".repeat(25)}Ana`);
  });

  it("emite el pulso del cajón", () => {
    const [ticket] = leerEscpos(new Ticket({ ancho: 80 }).abrirCajon().cortar().aBuffer());
    expect(ticket!.cajon).toBe(true);
  });
});

const PAYLOAD_COMANDA: PayloadComanda = {
  tipo: "comanda",
  local: "Warike Resto Grill",
  estacion: "Parrilla",
  comanda_numero: 2,
  orden_numero: 17,
  mesa: "Mesa 05",
  mesas_unidas: ["Mesa 06"],
  piso: "Piso 1",
  mozo: "Ana Pérez",
  comensales: 4,
  fecha_hora: "25/10/2026 13:45",
  reimpresion: false,
  items: [
    {
      cantidad: 2,
      nombre: "Lomo saltado",
      modificadores: ["Jugoso", "Huevo frito"],
      nota: "sin cebolla",
      cuenta: 1,
    },
    { cantidad: 1.5, nombre: "Anticucho de corazón", modificadores: [], nota: null, cuenta: 2 },
  ],
};

describe("plantillas", () => {
  it("la comanda lleva mesa, mozo, ítems con modificadores, notas y cuenta", () => {
    const [ticket] = leerEscpos(comanda(PAYLOAD_COMANDA, { ancho: 80 }));
    expect(ticket!.cortado).toBe(true);
    const lineas = ticket!.texto.split("\n").map((l) => l.trimEnd());
    expect(lineas).toEqual(
      expect.arrayContaining([
        "PARRILLA",
        "Warike Resto Grill",
        "Mesa 05",
        "+ Mesa 06",
        "2 x Lomo saltado",
        "    - Jugoso",
        "    - Huevo frito",
        "    * sin cebolla",
        "1,5 x Anticucho de corazón",
        "    (cuenta 2)",
      ]),
    );
    expect(lineas).toContain(`Comanda 2${" ".repeat(48 - 9 - 8)}Orden 17`);
    expect(ticket!.texto).not.toContain("REIMPRESIÓN");
  });

  it("marca las reimpresiones y respeta el ancho de 58 mm", () => {
    const [ticket] = leerEscpos(comanda({ ...PAYLOAD_COMANDA, reimpresion: true }, { ancho: 58 }));
    expect(ticket!.texto).toContain("*** REIMPRESIÓN ***");
    for (const linea of ticket!.texto.split("\n")) expect(linea.length).toBeLessThanOrEqual(32);
  });

  it("el aviso de anulación indica motivo y quién autorizó", () => {
    const [ticket] = leerEscpos(
      anulacion(
        {
          tipo: "anulacion",
          mesa: "Mesa 05",
          orden_numero: 17,
          mozo: "Ana Pérez",
          motivo: "cliente_desiste",
          motivo_texto: "Se retiró",
          autorizado_por: "Admin Warike",
          fecha_hora: "25/10/2026 14:02",
          items: [
            { cantidad: 1, nombre: "Lomo saltado", modificadores: ["Jugoso"], comanda_numero: 2 },
          ],
        },
        { ancho: 80 },
      ),
    );
    expect(ticket!.texto).toContain("*** ANULACIÓN ***");
    expect(ticket!.texto).toContain("Motivo: Cliente desiste - Se retiró");
    expect(ticket!.texto).toContain("Autorizó: Admin Warike");
  });

  it("el aviso de traslado dice de qué mesa a qué mesa", () => {
    const [ticket] = leerEscpos(
      traslado(
        {
          tipo: "traslado",
          mesa_origen: "Mesa 05",
          mesa_destino: "Mesa 22",
          orden_numero: 17,
          mozo: "Ana",
          fecha_hora: "25/10/2026 14:10",
          items: [{ cantidad: 2, nombre: "Chicha morada" }],
        },
        { ancho: 80 },
      ),
    );
    expect(ticket!.texto).toContain("Mesa 05 -> Mesa 22");
    expect(ticket!.texto).toContain("2 x Chicha morada");
  });

  it("rechaza tipos sin plantilla en esta fase", () => {
    expect(() => renderizar("precuenta", {}, { ancho: 80 })).toThrow(PlantillaNoDisponible);
  });

  it("formatea cantidades con coma decimal", () => {
    expect([1, 2.5, 0.25, 3.1].map(formatoCantidad)).toEqual(["1", "2,5", "0,25", "3,1"]);
  });
});
