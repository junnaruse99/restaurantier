import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { devices, expect, type Browser, type Page } from "@playwright/test";

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** Token del dispositivo "Tablet Salón 1" de supabase/seed/dev. */
export const TOKEN_TABLET = `wkd_${"a1".repeat(32)}`;

export const USUARIOS = {
  admin: {
    id: "d0000000-0000-4000-8000-000000000001",
    email: "admin@warike.test",
    password: "Warike-Admin-2026",
  },
  auditor: {
    id: "d0000000-0000-4000-8000-000000000002",
    email: "auditor@warike.test",
    password: "Warike-Auditor-2026",
  },
  mozo: { codigo: "1001", pin: "2580", nombre: "Mozo Demo" },
  cajero: { codigo: "2001", pin: "1470", nombre: "Cajera Demo" },
  cocina: { codigo: "3001", pin: "3690", nombre: "Cocina Demo" },
  adminPin: { codigo: "9001", pin: "7531" },
} as const;

/** Código TOTP (RFC 6238, SHA-1, 30 s, 6 dígitos) a partir de la clave base32. */
export function codigoTotp(secretoBase32: string, ahora = Date.now()): string {
  const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretoBase32.replace(/=+$/, "").toUpperCase()) {
    bits += alfabeto.indexOf(c).toString(2).padStart(5, "0");
  }
  const clave = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(ahora / 30_000)));
  const hmac = createHmac("sha1", clave).update(contador).digest();
  const desplazamiento = hmac[hmac.length - 1]! & 0xf;
  const numero = (hmac.readUInt32BE(desplazamiento) & 0x7fffffff) % 1_000_000;
  return numero.toString().padStart(6, "0");
}

/** Borra los factores MFA del usuario para que la prueba recorra el enrolamiento desde cero. */
export async function reiniciarMfa(userId: string): Promise<void> {
  const servicio = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await servicio.auth.admin.mfa.listFactors({ userId });
  if (error) throw error;
  for (const factor of data.factors) {
    await servicio.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
  }
}

export async function registrarTablet(page: Page): Promise<void> {
  await page.goto("/dispositivo");
  await page.getByText("Tengo un token de dispositivo").click();
  await page.getByLabel("Token").fill(TOKEN_TABLET);
  await page.getByLabel("Nombre para mostrar").fill("Tablet Salón 1");
  await page.getByRole("button", { name: "Guardar token" }).click();
  await expect(page).toHaveURL(/\/ingresar$/);
}

export async function ingresarConPin(page: Page, codigo: string, pin: string): Promise<void> {
  await page.getByLabel("Código de empleado").fill(codigo);
  await page.getByLabel("PIN", { exact: true }).click();
  for (const digito of pin) {
    await page
      .getByRole("group", { name: "Teclado numérico" })
      .getByRole("button", { name: digito, exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

export async function ingresarComoAdmin(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/admin/ingresar");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/admin\/mfa/);
  const secreto = (await page.getByTestId("secreto-totp").textContent())!.trim();
  await page.getByLabel("Código de verificación").fill(codigoTotp(secreto));
  await page.getByRole("button", { name: "Verificar" }).click();
}

// ---------------------------------------------------------------------------
// Fase 1: varias tablets, mesas libres y limpieza de órdenes de prueba
// ---------------------------------------------------------------------------
const FUNCTIONS_URL = process.env.E2E_FUNCTIONS_URL ?? `${SUPABASE_URL}/functions/v1`;
export const LOCAL_GRILL = "b0000000-0000-4000-8000-000000000001";

/** Tokens de supabase/seed/dev: tablets "a1"…"a5" y el KDS "d3". */
export const tokenTablet = (n: 1 | 2 | 3 | 4 | 5) => `wkd_${`a${n}`.repeat(32)}`;
export const TOKEN_KDS = `wkd_${"d3".repeat(32)}`;

/** Mozos 1001–1005 de la semilla de desarrollo (simulacro de 5 tablets). */
export const MOZOS = [
  { codigo: "1001", pin: "2580", nombre: "Mozo Demo" },
  { codigo: "1002", pin: "3581", nombre: "Mozo Dos" },
  { codigo: "1003", pin: "4682", nombre: "Mozo Tres" },
  { codigo: "1004", pin: "5793", nombre: "Mozo Cuatro" },
  { codigo: "1005", pin: "6824", nombre: "Mozo Cinco" },
] as const;

export function servicio() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface MesaLibre {
  id: string;
  codigo: string;
  piso: string;
  etiqueta: string;
}

/** Mesas libres del local (las pruebas no dependen de mesas fijas: el stack local se reutiliza). */
export async function mesasLibres(cantidad: number): Promise<MesaLibre[]> {
  const { data, error } = await servicio()
    .from("mesas")
    .select("id, codigo, nombre_visible, piso:pisos(nombre)")
    .eq("local_id", LOCAL_GRILL)
    .eq("estado", "libre")
    .eq("tipo", "mesa")
    .eq("activa", true)
    .order("codigo");
  if (error) throw error;
  if ((data ?? []).length < cantidad) throw new Error(`Se necesitan ${cantidad} mesas libres`);
  // Al azar, para que dos corridas seguidas no peleen por la misma mesa.
  return [...data!]
    .sort(() => Math.random() - 0.5)
    .slice(0, cantidad)
    .map((m) => ({
      id: m.id as string,
      codigo: m.codigo as string,
      piso: (m.piso as unknown as { nombre: string }).nombre,
      etiqueta: (m.nombre_visible as string | null) ?? `Mesa ${m.codigo}`,
    }));
}

/** Abre un contexto de tablet registrada y entra con código y PIN. */
export async function abrirTablet(
  browser: Browser,
  token: string,
  persona: { codigo: string; pin: string },
  dispositivo = devices["Galaxy Tab S4 landscape"],
): Promise<Page> {
  const contexto = await browser.newContext({
    ...dispositivo,
    locale: "es-PE",
    timezoneId: "America/Lima",
  });
  const page = await contexto.newPage();
  await page.goto("/dispositivo");
  await page.getByText("Tengo un token de dispositivo").click();
  await page.getByLabel("Token").fill(token);
  await page.getByLabel("Nombre para mostrar").fill("Tablet de prueba");
  await page.getByRole("button", { name: "Guardar token" }).click();
  await expect(page).toHaveURL(/\/ingresar$/);
  await ingresarConPin(page, persona.codigo, persona.pin);
  await expect(page).toHaveURL(/\/inicio$/);
  return page;
}

/** En el salón, cambia al piso de la mesa y la toca. */
export async function tocarMesa(page: Page, mesa: MesaLibre): Promise<void> {
  await page.getByRole("tab", { name: mesa.piso, exact: true }).first().click();
  await page.getByTestId(`mesa-${mesa.codigo}`).first().click();
}

/** Sin errores de la aplicación: ninguna notificación de error a la vista. */
export async function sinErrores(page: Page): Promise<void> {
  await expect(page.getByTestId("notificacion").and(page.getByRole("alert"))).toHaveCount(0);
}

/**
 * Cierra las órdenes que dejó una prueba: un mozo pide la autorización con el PIN del admin, anula
 * cada orden y libera sus mesas. Así el stack local queda listo para la siguiente corrida.
 */
export async function cerrarOrdenes(ordenIds: string[]): Promise<void> {
  if (!ordenIds.length) return;
  const res = await fetch(`${FUNCTIONS_URL}/pin-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_token: tokenTablet(5),
      codigo: MOZOS[4].codigo,
      pin: MOZOS[4].pin,
    }),
  });
  const { session } = (await res.json()) as { session: { access_token: string } };
  const mozo = createClient(SUPABASE_URL, process.env.E2E_SUPABASE_ANON_KEY ?? ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
  for (const id of ordenIds) {
    const { data: orden } = await servicio()
      .from("ordenes")
      .select("estado, mesa_uniones(mesa_id, liberada_at)")
      .eq("id", id)
      .single();
    if (orden && (orden.estado === "abierta" || orden.estado === "precuenta")) {
      const { data: aut } = await mozo.rpc("autorizar_con_pin", {
        p_local_id: LOCAL_GRILL,
        p_permiso: "autorizar_anulacion",
        p_codigo: USUARIOS.adminPin.codigo,
        p_pin: USUARIOS.adminPin.pin,
      });
      await mozo.rpc("anular_orden", {
        p_orden_id: id,
        p_motivo_codigo: "otro",
        p_motivo_texto: "Limpieza de prueba E2E",
        p_autorizacion_id: aut?.autorizacion_id,
      });
    }
    const { data: uniones } = await servicio()
      .from("mesa_uniones")
      .select("mesa_id")
      .eq("orden_id", id);
    for (const u of uniones ?? []) await mozo.rpc("liberar_mesa", { p_mesa_id: u.mesa_id });
  }
}

/** Texto de una mesa sin confundir "Mesa 1" con "Mesa 10". */
export function textoMesa(etiqueta: string): RegExp {
  return new RegExp(`${etiqueta.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`);
}

/** Abre la mesa desde el salón y devuelve el id de la orden. */
export async function abrirMesa(page: Page, mesa: MesaLibre, comensales = 2): Promise<string> {
  await page.goto("/salon");
  await tocarMesa(page, mesa);
  await page
    .getByRole("group", { name: "Comensales" })
    .getByRole("button", { name: String(comensales), exact: true })
    .click();
  await page.getByRole("button", { name: "Abrir mesa" }).click();
  await expect(page).toHaveURL(/\/salon\/orden\?id=/);
  await expect(page.getByTestId("titulo-pantalla")).toContainText(textoMesa(mesa.etiqueta));
  return new URL(page.url()).searchParams.get("id")!;
}
