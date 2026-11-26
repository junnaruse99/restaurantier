import { describe, expect, it } from "vitest";
import {
  fechaOperativa,
  minutosDesde,
  nivelAlertaKds,
  redondearMonto,
  sumarMontos,
  totalLinea,
  precioVigente,
  validarModificadores,
  type GrupoModificador,
} from "./salon";

describe("montos", () => {
  it("redondea half-up a céntimos sin errores de coma flotante", () => {
    expect(redondearMonto(1.005)).toBe(1.01);
    expect(redondearMonto(2.675)).toBe(2.68);
    expect(redondearMonto(-1.005)).toBe(-1.01);
    expect(redondearMonto(0.1 + 0.2)).toBe(0.3);
    expect(() => redondearMonto(Number.NaN)).toThrow(RangeError);
  });

  it("calcula el total de línea como la base (round(precio × cantidad, 2))", () => {
    expect(totalLinea(32, 2)).toBe(64);
    expect(totalLinea(8.8, 3)).toBe(26.4);
    expect(totalLinea(15.5, 1.5)).toBe(23.25);
    expect(totalLinea(0.333333, 3)).toBe(1);
    expect(() => totalLinea(10, 0)).toThrow(RangeError);
  });

  it("suma en céntimos", () => {
    expect(sumarMontos([0.1, 0.2, 0.3])).toBe(0.6);
    expect(sumarMontos([64, 8, 0.5])).toBe(72.5);
    expect(sumarMontos([])).toBe(0);
  });
});

describe("fecha operativa (M5)", () => {
  it("antes de la hora de corte cuenta como el día anterior", () => {
    // 2026-10-26 03:30 en Lima (UTC-5) = 08:30 UTC
    expect(fechaOperativa(new Date("2026-10-26T08:30:00Z"))).toBe("2026-10-25");
    // 2026-10-26 05:00 en Lima
    expect(fechaOperativa(new Date("2026-10-26T10:00:00Z"))).toBe("2026-10-26");
    // 23:59 en Lima del 31 de diciembre
    expect(fechaOperativa(new Date("2027-01-01T04:59:00Z"))).toBe("2026-12-31");
  });

  it("respeta una hora de corte propia, con segundos", () => {
    // 02:00:00 en Lima
    expect(fechaOperativa(new Date("2026-10-26T07:00:00Z"), "02:00:00")).toBe("2026-10-26");
    expect(fechaOperativa(new Date("2026-10-26T07:00:00Z"), "02:00:01")).toBe("2026-10-25");
    expect(fechaOperativa(new Date("2026-03-01T06:59:59Z"), "02:00")).toBe("2026-02-28");
  });
});

describe("KDS (M7)", () => {
  it("cuenta minutos enteros y nunca negativos", () => {
    const ahora = new Date("2026-10-26T18:30:00Z");
    expect(minutosDesde("2026-10-26T18:14:30Z", ahora)).toBe(15);
    expect(minutosDesde(new Date("2026-10-26T18:31:00Z"), ahora)).toBe(0);
  });

  it("alerta en amarillo a los 15 min y en rojo a los 25, o con umbrales propios", () => {
    expect([0, 14, 15, 24, 25, 90].map((m) => nivelAlertaKds(m))).toEqual([
      "normal",
      "normal",
      "amarilla",
      "amarilla",
      "roja",
      "roja",
    ]);
    expect(nivelAlertaKds(10, 8, 12)).toBe("amarilla");
  });
});

describe("modificadores", () => {
  const grupos: GrupoModificador[] = [
    {
      grupo: "Término",
      min: 1,
      max: 1,
      opciones: [
        { nombre: "Jugoso", precioExtra: 0 },
        { nombre: "A punto", precioExtra: 0 },
      ],
    },
    {
      grupo: "Extras",
      min: 0,
      max: 2,
      opciones: [
        { nombre: "Huevo frito", precioExtra: 2 },
        { nombre: "Queso", precioExtra: 1.5 },
      ],
    },
  ];

  it("acepta lo válido y suma los recargos", () => {
    expect(
      validarModificadores("Lomo", grupos, [
        { grupo: "Término", nombre: "Jugoso" },
        { grupo: "Extras", nombre: "Huevo frito" },
        { grupo: "Extras", nombre: "Queso" },
      ]),
    ).toEqual({ errores: [], recargo: 3.5 });
  });

  it("informa grupos faltantes, excedidos, ajenos y opciones inválidas", () => {
    const r = validarModificadores("Lomo", grupos, [
      { grupo: "Extras", nombre: "Huevo frito" },
      { grupo: "Extras", nombre: "Queso" },
      { grupo: "Extras", nombre: "Tocino" },
      { grupo: "Salsa", nombre: "Criolla" },
    ]);
    expect(r.errores).toEqual([
      '"Lomo" no admite el grupo "Salsa"',
      'Elija 1 de "Término"',
      'Elija entre 0 y 2 de "Extras"',
      '"Tocino" no es una opción de "Extras"',
    ]);
  });
});

describe("precio vigente del menú del día (M5)", () => {
  const reglas = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    dia_semana: d,
    precio: d === 0 ? 18 : 15,
    vigencia_desde: "2026-01-01",
    vigencia_hasta: null,
  }));

  it("lunes a sábado S/ 15 y domingo S/ 18", () => {
    // 2026-10-25 es domingo
    const semana = [
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
    ];
    expect(semana.map((f) => precioVigente(15, reglas, f))).toEqual([18, 15, 15, 15, 15, 15, 15]);
  });

  it("un feriado marcado como domingo se cobra a S/ 18", () => {
    expect(precioVigente(15, reglas, "2026-12-08", true)).toBe(18);
  });

  it("sin regla vigente rige el precio de carta", () => {
    expect(precioVigente(15, [], "2026-10-26")).toBe(15);
    expect(precioVigente(15, reglas, "2025-12-31")).toBe(15);
    const vencida = [
      { dia_semana: 1, precio: 12, vigencia_desde: "2026-01-01", vigencia_hasta: "2026-06-30" },
    ];
    expect(precioVigente(15, vencida, "2026-10-26")).toBe(15);
    expect(precioVigente(15, vencida, "2026-06-29")).toBe(12);
  });
});
