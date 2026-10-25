import { describe, expect, it } from "vitest";
import { formatearMoneda } from "./regional";

describe("formatearMoneda", () => {
  it("usa el formato peruano por defecto S/ 1.234,50", () => {
    expect(formatearMoneda(1234.5)).toBe("S/ 1.234,50");
  });

  it("formatea montos pequeños y cero", () => {
    expect(formatearMoneda(0)).toBe("S/ 0,00");
    expect(formatearMoneda(15)).toBe("S/ 15,00");
    expect(formatearMoneda(0.1)).toBe("S/ 0,10");
  });

  it("agrupa millones", () => {
    expect(formatearMoneda(1234567.891)).toBe("S/ 1.234.567,89");
  });

  it("redondea half-up a 2 decimales", () => {
    expect(formatearMoneda(1.005)).toBe("S/ 1,01");
    expect(formatearMoneda(2.675)).toBe("S/ 2,68");
  });

  it("muestra el signo en montos negativos (notas de crédito)", () => {
    expect(formatearMoneda(-40)).toBe("-S/ 40,00");
    expect(formatearMoneda(-0.001)).toBe("S/ 0,00");
  });

  it("no pierde precisión con montos muy pequeños", () => {
    expect(formatearMoneda(1e-7)).toBe("S/ 0,00");
  });

  it("acepta un formato configurable", () => {
    expect(
      formatearMoneda(1234.5, { simbolo: "S/", separadorMiles: ",", separadorDecimal: "." }),
    ).toBe("S/ 1,234.50");
  });

  it("rechaza valores no finitos", () => {
    expect(() => formatearMoneda(Number.NaN)).toThrow(RangeError);
    expect(() => formatearMoneda(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
