import { describe, expect, it } from "vitest";
import {
  aplicarDescuento,
  calcularComprobante,
  calcularVuelto,
  diferenciaArqueo,
  dividirEnPartes,
  dniValido,
  efectivoEsperado,
  rucValido,
  saldoPendiente,
  tasaVigente,
  totalDenominaciones,
  type ConfigTributaria,
} from "./caja";

// Igual que supabase/migrations/…_datos_referencia.sql.
const CONFIG: ConfigTributaria[] = [
  {
    regimen: "MYPE_RESTAURANTE",
    vigencia_desde: "2026-01-01",
    vigencia_hasta: "2026-12-31",
    tasa_total: 0.105,
    icbper_unitario: 0.5,
  },
  {
    regimen: "MYPE_RESTAURANTE",
    vigencia_desde: "2027-01-01",
    vigencia_hasta: null,
    tasa_total: 0.15,
    icbper_unitario: 0.5,
  },
  {
    regimen: "GENERAL",
    vigencia_desde: "2000-01-01",
    vigencia_hasta: null,
    tasa_total: 0.18,
    icbper_unitario: 0.5,
  },
];

describe("tasaVigente", () => {
  it("elige la tasa por régimen y fecha de emisión", () => {
    expect(tasaVigente(CONFIG, "MYPE_RESTAURANTE", "2026-11-26").tasa_total).toBe(0.105);
    expect(tasaVigente(CONFIG, "MYPE_RESTAURANTE", "2026-12-31").tasa_total).toBe(0.105);
    expect(tasaVigente(CONFIG, "MYPE_RESTAURANTE", "2027-01-01").tasa_total).toBe(0.15);
    expect(tasaVigente(CONFIG, "GENERAL", "2026-11-26").tasa_total).toBe(0.18);
  });

  it("falla si no hay tasa vigente", () => {
    expect(() => tasaVigente(CONFIG, "MYPE_RESTAURANTE", "2025-12-31")).toThrow(RangeError);
  });
});

describe("calcularComprobante", () => {
  it.each([
    // tasa, precio, valor de venta, IGV
    [0.105, 45, 40.72, 4.28],
    [0.15, 45, 39.13, 5.87],
    [0.18, 45, 38.14, 6.86],
  ])("con tasa %s una parrilla de S/ %s tiene valor %s e IGV %s", (tasa, precio, valor, igv) => {
    const r = calcularComprobante(
      [{ descripcion: "Parrilla", cantidad: 1, precioUnitario: precio }],
      tasa,
    );
    expect(r.opGravada).toBe(valor);
    expect(r.igv).toBe(igv);
    expect(r.total).toBe(precio);
    expect(r.lineas[0]!.valorUnitario).toBe(Number((precio / (1 + tasa)).toFixed(10)));
  });

  it("suma varias líneas y la suma de valor e IGV cuadra con el total", () => {
    const r = calcularComprobante(
      [
        { descripcion: "Chicha", cantidad: 3, precioUnitario: 12 },
        { descripcion: "Papas", cantidad: 2, precioUnitario: 10.5 },
        { descripcion: "Menú", cantidad: 1, precioUnitario: 15 },
      ],
      0.105,
    );
    expect(r.total).toBe(72);
    expect(r.opGravada + r.igv).toBeCloseTo(72, 10);
    expect(r.lineas.map((l) => l.valorVenta)).toEqual([32.58, 19.0, 13.57]);
    expect(r.lineas.map((l) => l.igv)).toEqual([3.42, 2.0, 1.43]);
    expect(r.opGravada).toBe(65.15);
    expect(r.igv).toBe(6.85);
  });

  it("aplica el descuento del personal (15 %) sobre el precio con IGV: S/ 40 → S/ 34", () => {
    const r = calcularComprobante(
      [{ descripcion: "Lomo", cantidad: 1, precioUnitario: 40, descuentoPct: 15 }],
      0.105,
    );
    expect(r.total).toBe(34);
    expect(r.descuentos).toBe(6);
    expect(r.lineas[0]!.precioUnitario).toBe(34);
    expect(r.opGravada).toBe(30.77);
    expect(r.igv).toBe(3.23);
  });

  it("suma el ICBPER fuera de la base del IGV", () => {
    const r = calcularComprobante(
      [
        { descripcion: "Lomo", cantidad: 1, precioUnitario: 32 },
        { descripcion: "Bolsa", cantidad: 2, precioUnitario: 0, icbper: true },
      ],
      0.105,
      0.5,
    );
    expect(r.icbper).toBe(1);
    expect(r.lineas[1]!.icbper).toBe(1);
    expect(r.lineas[1]!.igv).toBe(0);
    expect(r.total).toBe(33);
  });

  it("separa operaciones exoneradas e inafectas", () => {
    const r = calcularComprobante(
      [
        { descripcion: "Gravado", cantidad: 1, precioUnitario: 11.05 },
        { descripcion: "Exonerado", cantidad: 2, precioUnitario: 5, afectacion: "20" },
        { descripcion: "Inafecto", cantidad: 1, precioUnitario: 3, afectacion: "30" },
      ],
      0.105,
    );
    expect(r.opGravada).toBe(10);
    expect(r.igv).toBe(1.05);
    expect(r.opExonerada).toBe(10);
    expect(r.opInafecta).toBe(3);
    expect(r.total).toBe(24.05);
  });

  it("acepta cantidades fraccionarias y redondea half-up", () => {
    const r = calcularComprobante(
      [{ descripcion: "Pollo", cantidad: 0.5, precioUnitario: 24.99 }],
      0.18,
    );
    expect(r.total).toBe(12.5);
    expect(r.opGravada).toBe(10.59);
    expect(r.igv).toBe(1.91);
  });

  it("rechaza entradas inválidas", () => {
    expect(() => calcularComprobante([], 0.18)).toThrow(RangeError);
    expect(() =>
      calcularComprobante([{ descripcion: "X", cantidad: 1, precioUnitario: 1 }], 1),
    ).toThrow(RangeError);
    expect(() =>
      calcularComprobante([{ descripcion: "X", cantidad: 0, precioUnitario: 1 }], 0.18),
    ).toThrow(RangeError);
    expect(() =>
      calcularComprobante([{ descripcion: "X", cantidad: 1, precioUnitario: -1 }], 0.18),
    ).toThrow(RangeError);
  });
});

describe("aplicarDescuento", () => {
  it("redondea a céntimos y valida el porcentaje", () => {
    expect(aplicarDescuento(12.9, 15)).toBe(10.97);
    expect(aplicarDescuento(10, 100)).toBe(0);
    expect(() => aplicarDescuento(10, 101)).toThrow(RangeError);
    expect(() => aplicarDescuento(10, -1)).toThrow(RangeError);
  });
});

describe("división y pagos", () => {
  it("divide en partes iguales y el residuo va a la primera parte", () => {
    expect(dividirEnPartes(100, 3)).toEqual([33.34, 33.33, 33.33]);
    expect(dividirEnPartes(150, 2)).toEqual([75, 75]);
    expect(dividirEnPartes(0.05, 2)).toEqual([0.03, 0.02]);
    expect(() => dividirEnPartes(10, 0)).toThrow(RangeError);
    expect(() => dividirEnPartes(10, 1.5)).toThrow(RangeError);
  });

  it("calcula el vuelto y el saldo de un pago mixto (CA de M12)", () => {
    expect(calcularVuelto(40, 50)).toBe(10);
    expect(() => calcularVuelto(40, 39.99)).toThrow(RangeError);
    expect(saldoPendiente(150, [50, 60])).toBe(40);
    expect(saldoPendiente(150, [50, 60, 40])).toBe(0);
    expect(saldoPendiente(0.3, [0.1, 0.2])).toBe(0);
  });
});

describe("arqueo", () => {
  it("suma el efectivo por denominaciones", () => {
    expect(totalDenominaciones({ "200": 1, "50": 2, "10": 3, "0.5": 3, "0.1": 7 })).toBe(332.2);
    expect(totalDenominaciones({ "20": undefined })).toBe(0);
    expect(() => totalDenominaciones({ "3": 1 })).toThrow(RangeError);
    expect(() => totalDenominaciones({ "10": -1 })).toThrow(RangeError);
    expect(() => totalDenominaciones({ "10": 1.5 })).toThrow(RangeError);
  });

  it("aplica la fórmula del efectivo esperado y la diferencia", () => {
    const esperado = efectivoEsperado({
      apertura: 200,
      pagosEfectivo: [50, 35.5],
      vueltos: [10, 4.5],
      ingresos: [20],
      egresos: [15.3],
    });
    expect(esperado).toBe(275.7);
    expect(diferenciaArqueo(270, esperado)).toBe(-5.7);
    expect(diferenciaArqueo(275.7, esperado)).toBe(0);
  });
});

describe("documentos de identidad", () => {
  it("valida el RUC con el dígito verificador", () => {
    expect(rucValido("20480723563")).toBe(true); // Warike Resto Grill
    expect(rucValido("20100070970")).toBe(true);
    expect(rucValido("20480723562")).toBe(false);
    expect(rucValido("30480723563")).toBe(false);
    expect(rucValido("2048072356")).toBe(false);
  });

  it("valida el DNI", () => {
    expect(dniValido("45678912")).toBe(true);
    expect(dniValido("4567891")).toBe(false);
    expect(dniValido("4567891a")).toBe(false);
  });
});
