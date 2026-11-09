import { randomInt, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANON_KEY, LOCAL_GRILL, MOZO, SUPABASE_URL } from "./entorno";
import {
  crearAdminConMfa,
  crearDispositivo,
  desactivarDispositivo,
  llamarFuncion,
  servicio,
} from "./ayudas";

interface RespuestaAlta {
  error?: string;
  mensaje?: string;
  user_id?: string;
  rol?: string;
}

let admin: { id: string; aal1: string; aal2: string };
let tablet: { id: string; token: string };
const roles: Record<string, string> = {};

const alta = (cuerpo: Record<string, unknown>, token?: string) =>
  llamarFuncion<RespuestaAlta>(
    "admin-usuarios",
    cuerpo,
    token ? { Authorization: `Bearer ${token}` } : {},
  );

/** Código de empleado que no choca con ejecuciones anteriores contra el mismo stack. */
const codigoNuevo = () => `I${randomInt(10_000_000, 99_999_999)}`;

beforeAll(async () => {
  admin = await crearAdminConMfa();
  tablet = await crearDispositivo("tablet_mozo");
  const { data } = await servicio.from("roles").select("id, codigo").is("empresa_id", null);
  for (const r of data ?? []) roles[r.codigo] = r.id;
});

afterAll(async () => {
  await desactivarDispositivo(tablet.id);
});

describe("admin-usuarios", () => {
  it("el admin con MFA da de alta un mozo que luego entra con su PIN", async () => {
    const codigo = codigoNuevo();
    const { status, body } = await alta(
      {
        local_id: LOCAL_GRILL,
        role_id: roles.mozo,
        nombre_visible: "Mozo de integración",
        codigo_empleado: codigo,
        pin: "2468",
      },
      admin.aal2,
    );
    expect(status).toBe(201);
    expect(body.rol).toBe("mozo");

    const ingreso = await llamarFuncion<{ usuario?: { id: string } }>("pin-login", {
      device_token: tablet.token,
      codigo,
      pin: "2468",
    });
    expect(ingreso.status).toBe(200);
    expect(ingreso.body.usuario?.id).toBe(body.user_id);
  });

  it("da de alta un auditor con email y contraseña inicial", async () => {
    const email = `auditor-${randomUUID().slice(0, 8)}@integracion.test`;
    const password = "Auditor-Integracion-2026";
    const { status } = await alta(
      {
        local_id: LOCAL_GRILL,
        role_id: roles.auditor,
        nombre_visible: "Auditora",
        email,
        password,
      },
      admin.aal2,
    );
    expect(status).toBe(201);
    const auth = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await auth.auth.signInWithPassword({ email, password });
    expect(error).toBeNull();
  });

  it("rechaza códigos repetidos y PIN inválidos sin dejar cuentas sueltas", async () => {
    const duplicado = await alta(
      {
        local_id: LOCAL_GRILL,
        role_id: roles.mozo,
        nombre_visible: "Otro",
        codigo_empleado: MOZO.codigo,
        pin: "2468",
      },
      admin.aal2,
    );
    expect(duplicado.status).toBe(409);
    expect(duplicado.body.error).toBe("codigo_duplicado");

    const codigo = codigoNuevo();
    const pinInvalido = await alta(
      {
        local_id: LOCAL_GRILL,
        role_id: roles.mozo,
        nombre_visible: "Otro",
        codigo_empleado: codigo,
        pin: "1234",
      },
      admin.aal2,
    );
    expect(pinInvalido.status).toBe(400);
    expect(pinInvalido.body.error).toBe("pin_invalido");
    const { data: perfiles } = await servicio
      .from("usuarios_perfil")
      .select("user_id")
      .eq("codigo_empleado", codigo);
    expect(perfiles).toEqual([]);

    // La cuenta de Auth se deshizo: el mismo código se puede usar después.
    const reintento = await alta(
      {
        local_id: LOCAL_GRILL,
        role_id: roles.mozo,
        nombre_visible: "Otro",
        codigo_empleado: codigo,
        pin: "2468",
      },
      admin.aal2,
    );
    expect(reintento.status).toBe(201);
  });

  it("valida los datos según el rol", async () => {
    const sinPin = await alta(
      {
        local_id: LOCAL_GRILL,
        role_id: roles.mozo,
        nombre_visible: "Sin PIN",
        codigo_empleado: codigoNuevo(),
      },
      admin.aal2,
    );
    expect(sinPin.status).toBe(400);
    expect(sinPin.body.error).toBe("codigo_y_pin_requeridos");

    const sinEmail = await alta(
      { local_id: LOCAL_GRILL, role_id: roles.auditor, nombre_visible: "Sin email" },
      admin.aal2,
    );
    expect(sinEmail.status).toBe(400);
    expect(sinEmail.body.error).toBe("email_invalido");

    const agente = await alta(
      {
        local_id: LOCAL_GRILL,
        role_id: roles.agente_impresion,
        nombre_visible: "Agente",
        codigo_empleado: codigoNuevo(),
        pin: "2468",
      },
      admin.aal2,
    );
    expect(agente.status).toBe(400);
    expect(agente.body.error).toBe("rol_invalido");

    const malFormada = await alta(
      { local_id: "no-es-uuid", role_id: roles.mozo, nombre_visible: "X" },
      admin.aal2,
    );
    expect(malFormada.status).toBe(400);
    expect(malFormada.body.error).toBe("solicitud_invalida");
  });

  it("exige sesión de admin con MFA", async () => {
    const cuerpo = {
      local_id: LOCAL_GRILL,
      role_id: roles.mozo,
      nombre_visible: "No",
      codigo_empleado: codigoNuevo(),
      pin: "2468",
    };
    expect((await alta(cuerpo)).status).toBe(401);
    expect((await alta(cuerpo, "token-invalido")).status).toBe(401);

    const sinMfa = await alta(cuerpo, admin.aal1);
    expect(sinMfa.status).toBe(403);
    expect(sinMfa.body.error).toBe("sin_permiso");

    const mozo = await llamarFuncion<{ session?: { access_token: string } }>("pin-login", {
      device_token: tablet.token,
      codigo: MOZO.codigo,
      pin: MOZO.pin,
    });
    const comoMozo = await alta(cuerpo, mozo.body.session!.access_token);
    expect(comoMozo.status).toBe(403);
  });
});
