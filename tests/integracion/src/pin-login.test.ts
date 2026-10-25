import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  ANON_KEY,
  CAJERO,
  LOCAL_GRILL,
  MOZO,
  PIN_LOGIN_URL,
  SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "./entorno";

const servicio = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface RespuestaPinLogin {
  error?: string;
  intentos_restantes?: number;
  session?: { access_token: string; refresh_token: string };
  usuario?: { id: string; nombre_visible: string };
  dispositivo_id?: string;
  local_id?: string;
  sesion_expira_at?: string;
}

async function pinLogin(cuerpo: Record<string, unknown>) {
  const res = await fetch(PIN_LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  return { status: res.status, body: (await res.json()) as RespuestaPinLogin };
}

function clienteCon(accessToken: string) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// Dispositivo propio de la prueba, para no alterar los dispositivos de desarrollo.
const token = `wkd_${randomBytes(32).toString("hex")}`;
let dispositivoId = "";

beforeAll(async () => {
  const { data, error } = await servicio
    .from("dispositivos")
    .insert({
      local_id: LOCAL_GRILL,
      nombre: `Tablet integración ${Date.now()}`,
      tipo: "tablet_mozo",
      token_hash: createHash("sha256").update(token).digest("hex"),
    })
    .select("id")
    .single();
  if (error) throw error;
  dispositivoId = data.id;
});

afterAll(async () => {
  if (dispositivoId) {
    await servicio.from("dispositivos").update({ activo: false }).eq("id", dispositivoId);
  }
});

describe("pin-login", () => {
  it("emite una sesión de Supabase ligada al dispositivo por 12 h", async () => {
    const { status, body } = await pinLogin({
      device_token: token,
      codigo: MOZO.codigo,
      pin: MOZO.pin,
    });
    expect(status).toBe(200);
    expect(body.usuario?.id).toBe(MOZO.id);
    expect(body.local_id).toBe(LOCAL_GRILL);
    expect(body.dispositivo_id).toBe(dispositivoId);
    const horas = (Date.parse(body.sesion_expira_at!) - Date.now()) / 3_600_000;
    expect(horas).toBeGreaterThan(11.9);
    expect(horas).toBeLessThanOrEqual(12);

    const cliente = clienteCon(body.session!.access_token);
    const { data: contexto, error } = await cliente.rpc("mi_contexto");
    expect(error).toBeNull();
    expect(contexto.sesion_pin.dispositivo_id).toBe(dispositivoId);
    expect(contexto.locales).toHaveLength(1);
    expect(contexto.locales[0].roles).toEqual(["mozo"]);

    const { count } = await cliente.from("mesas").select("id", { count: "exact", head: true });
    expect(count).toBeGreaterThan(50);
    const { data: pagos } = await cliente.from("pagos").select("id");
    expect(pagos).toEqual([]);
  });

  it("rechaza un PIN incorrecto e informa los intentos restantes", async () => {
    const { status, body } = await pinLogin({
      device_token: token,
      codigo: CAJERO.codigo,
      pin: "9512",
    });
    expect(status).toBe(401);
    expect(body.error).toBe("credenciales_invalidas");
    expect(body.intentos_restantes).toBe(4);
    // Un inicio correcto reinicia el contador.
    const ok = await pinLogin({ device_token: token, codigo: CAJERO.codigo, pin: CAJERO.pin });
    expect(ok.status).toBe(200);
  });

  it("no permite que un admin entre con PIN (requiere MFA)", async () => {
    const { status, body } = await pinLogin({
      device_token: token,
      codigo: ADMIN.codigo,
      pin: ADMIN.pin,
    });
    expect(status).toBe(403);
    expect(body.error).toBe("sin_rol_en_local");
  });

  it("rechaza dispositivos no registrados y solicitudes mal formadas", async () => {
    const desconocido = await pinLogin({
      device_token: `wkd_${"0".repeat(64)}`,
      codigo: MOZO.codigo,
      pin: MOZO.pin,
    });
    expect(desconocido.status).toBe(401);
    expect(desconocido.body.error).toBe("dispositivo_no_autorizado");

    const malFormada = await pinLogin({ codigo: MOZO.codigo });
    expect(malFormada.status).toBe(400);
  });

  it("al revocar el dispositivo la sesión deja de servir y no se puede renovar", async () => {
    const { body } = await pinLogin({ device_token: token, codigo: MOZO.codigo, pin: MOZO.pin });
    const cliente = clienteCon(body.session!.access_token);

    const { error } = await servicio
      .from("dispositivos")
      .update({ activo: false })
      .eq("id", dispositivoId);
    expect(error).toBeNull();

    const { count } = await cliente.from("mesas").select("id", { count: "exact", head: true });
    expect(count).toBe(0);

    const renovacion = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: errorRenovacion } = await renovacion.auth.refreshSession({
      refresh_token: body.session!.refresh_token,
    });
    expect(errorRenovacion).not.toBeNull();

    const despues = await pinLogin({ device_token: token, codigo: MOZO.codigo, pin: MOZO.pin });
    expect(despues.status).toBe(401);
    expect(despues.body.error).toBe("dispositivo_no_autorizado");
  });
});
