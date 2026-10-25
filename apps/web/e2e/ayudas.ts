import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:54321";
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
