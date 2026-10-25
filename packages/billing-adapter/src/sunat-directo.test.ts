import { describe, expect, it } from "vitest";
import type { ComprobanteDTO } from "./emisor";
import { NoImplementadoError, SunatDirectoEmisor } from "./sunat-directo";

const cpe = { id: "x", tipo: "03", serie: "B002", numero: 1 } as ComprobanteDTO;

describe("SunatDirectoEmisor (stub del MVP)", () => {
  it("rechaza todas las operaciones con NoImplementadoError", async () => {
    const emisor = new SunatDirectoEmisor();
    await expect(emisor.emitir(cpe)).rejects.toBeInstanceOf(NoImplementadoError);
    await expect(emisor.consultar("03", "B002", 1)).rejects.toBeInstanceOf(NoImplementadoError);
    await expect(emisor.anular(cpe, "error")).rejects.toThrow(/docs\/sunat-directo\.md/);
  });
});
