import { describe, expect, it } from "vitest";
import { mensajeErrorPin } from "./pin-login";

describe("mensajeErrorPin", () => {
  it("informa los intentos restantes en singular y plural", () => {
    expect(
      mensajeErrorPin({ ok: false, error: "credenciales_invalidas", intentosRestantes: 3 }),
    ).toBe("Código o PIN incorrecto. Le quedan 3 intentos.");
    expect(
      mensajeErrorPin({ ok: false, error: "credenciales_invalidas", intentosRestantes: 1 }),
    ).toBe("Código o PIN incorrecto. Le quedan 1 intento.");
    expect(mensajeErrorPin({ ok: false, error: "credenciales_invalidas" })).toBe(
      "Código o PIN incorrecto.",
    );
  });

  it("calcula los minutos de bloqueo restantes", () => {
    const ahora = new Date("2026-10-25T12:00:00Z");
    expect(
      mensajeErrorPin(
        { ok: false, error: "bloqueado", bloqueadoHasta: "2026-10-25T12:15:00Z" },
        ahora,
      ),
    ).toBe("Demasiados intentos fallidos. Usuario bloqueado por 15 minutos.");
    expect(
      mensajeErrorPin(
        { ok: false, error: "bloqueado", bloqueadoHasta: "2026-10-25T12:00:20Z" },
        ahora,
      ),
    ).toBe("Demasiados intentos fallidos. Usuario bloqueado por 1 minuto.");
    expect(mensajeErrorPin({ ok: false, error: "bloqueado" })).toMatch(/bloqueado temporalmente/);
  });

  it("tiene un mensaje para cada error", () => {
    const errores = [
      "dispositivo_no_autorizado",
      "sin_rol_en_local",
      "demasiadas_solicitudes",
      "solicitud_invalida",
      "sin_conexion",
      "error_interno",
    ] as const;
    for (const error of errores) {
      expect(mensajeErrorPin({ ok: false, error })).not.toBe("");
    }
  });
});
