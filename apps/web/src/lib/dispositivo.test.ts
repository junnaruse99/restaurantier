import { beforeEach, describe, expect, it } from "vitest";
import { dbLocal } from "./db-local";
import {
  actualizarDispositivo,
  esTokenValido,
  guardarDispositivo,
  obtenerDispositivo,
  olvidarDispositivo,
} from "./dispositivo";

const TOKEN = `wkd_${"a1".repeat(32)}`;

beforeEach(async () => {
  await dbLocal.dispositivo.clear();
});

describe("registro local del dispositivo", () => {
  it("valida el formato del token", () => {
    expect(esTokenValido(TOKEN)).toBe(true);
    expect(esTokenValido(` ${TOKEN} `)).toBe(true);
    expect(esTokenValido("wkd_123")).toBe(false);
    expect(esTokenValido(TOKEN.toUpperCase())).toBe(false);
  });

  it("guarda, completa y olvida el dispositivo", async () => {
    expect(await obtenerDispositivo()).toBeUndefined();

    await guardarDispositivo({ token: `  ${TOKEN}`, nombre: " Tablet Salón 1 " });
    const guardado = await obtenerDispositivo();
    expect(guardado?.token).toBe(TOKEN);
    expect(guardado?.nombre).toBe("Tablet Salón 1");
    expect(guardado?.dispositivoId).toBeNull();

    await actualizarDispositivo({ dispositivoId: "d-1", localId: "l-1" });
    expect((await obtenerDispositivo())?.localId).toBe("l-1");

    await olvidarDispositivo();
    expect(await obtenerDispositivo()).toBeUndefined();
  });

  it("rechaza tokens mal formados", async () => {
    await expect(guardarDispositivo({ token: "abc", nombre: "X" })).rejects.toThrow(/formato/);
  });
});
