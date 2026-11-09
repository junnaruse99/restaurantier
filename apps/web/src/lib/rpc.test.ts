import { describe, expect, it } from "vitest";
import { aErrorRpc, mensajeDeError } from "./rpc";

describe("aErrorRpc", () => {
  it("lee el estado HTTP y el código de las RPC de Warike", () => {
    const e = aErrorRpc({
      message: "La mesa no está libre",
      code: "PT409",
      details: "mesa_ocupada",
    });
    expect(e).toMatchObject({
      estado: 409,
      codigo: "mesa_ocupada",
      message: "La mesa no está libre",
    });
  });

  it("reconoce la falta de conexión y la falta de privilegios", () => {
    expect(aErrorRpc({ message: "TypeError: Failed to fetch" }).codigo).toBe("sin_conexion");
    expect(aErrorRpc({ message: "permission denied", code: "42501" })).toMatchObject({
      codigo: "sin_permiso",
      estado: 403,
    });
    expect(aErrorRpc({ message: "otro", code: "PGRST116" }).codigo).toBe("PGRST116");
  });

  it("da un mensaje legible para cualquier error", () => {
    expect(mensajeDeError(new Error("x"))).toBe("x");
    expect(mensajeDeError("raro")).toBe("Ocurrió un error inesperado.");
  });
});
