import { describe, expect, it } from "vitest";
import { destinoSeguro } from "./navegacion";

describe("destinoSeguro", () => {
  it("acepta rutas internas", () => {
    expect(destinoSeguro("/dispositivo")).toBe("/dispositivo");
    expect(destinoSeguro("/inicio?x=1")).toBe("/inicio?x=1");
  });

  it("rechaza destinos externos o ambiguos", () => {
    expect(destinoSeguro("https://malicioso.example")).toBe("/inicio");
    expect(destinoSeguro("//malicioso.example")).toBe("/inicio");
    expect(destinoSeguro("/\\malicioso.example")).toBe("/inicio");
    expect(destinoSeguro(null)).toBe("/inicio");
    expect(destinoSeguro("", "/ingresar")).toBe("/ingresar");
  });

  it("rechaza tabuladores y saltos de línea que el parser de URL elimina", () => {
    expect(destinoSeguro("/\t/malicioso.example")).toBe("/inicio");
    expect(destinoSeguro("/\n/malicioso.example")).toBe("/inicio");
    expect(destinoSeguro("/\r\n\\malicioso.example")).toBe("/inicio");
  });

  it("normaliza la ruta interna", () => {
    expect(destinoSeguro("/admin/../dispositivo#x")).toBe("/dispositivo#x");
  });
});
