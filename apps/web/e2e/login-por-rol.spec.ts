import { expect, test } from "@playwright/test";
import {
  ingresarComoAdmin,
  ingresarConPin,
  registrarTablet,
  reiniciarMfa,
  USUARIOS,
} from "./ayudas";

// Criterio de salida de la fase 0 (§15): el login por rol funciona.

test.describe("ingreso con PIN en dispositivo registrado", () => {
  test.beforeEach(async ({ page }) => {
    await registrarTablet(page);
  });

  test("mozo: ve salón y cocina, no caja", async ({ page }) => {
    await ingresarConPin(page, USUARIOS.mozo.codigo, USUARIOS.mozo.pin);
    await expect(page.getByTestId("bienvenida")).toHaveText(`Hola, ${USUARIOS.mozo.nombre}`);
    await expect(page.getByTestId("roles")).toHaveText("Mozo");
    await expect(page.getByText(/^Ingreso con PIN · vence/)).toBeVisible();
    await expect(page.getByText("Salón y pedidos", { exact: true })).toBeVisible();
    await expect(page.getByText("Caja y comprobantes", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Auditoría", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Cerrar sesión" }).click();
    await expect(page).toHaveURL(/\/ingresar$/);
  });

  test("cajero: ve caja; un PIN incorrecto informa los intentos restantes", async ({ page }) => {
    await ingresarConPin(page, USUARIOS.cajero.codigo, "9512");
    await expect(page.locator("main").getByRole("alert")).toContainText(
      /Código o PIN incorrecto\. Le quedan \d intentos?\./,
    );

    await ingresarConPin(page, USUARIOS.cajero.codigo, USUARIOS.cajero.pin);
    await expect(page.getByTestId("roles")).toHaveText("Cajero");
    await expect(page.getByText("Caja y comprobantes", { exact: true })).toBeVisible();
    await expect(page.getByText("Configuración del local", { exact: true })).toHaveCount(0);
  });

  test("cocina: ve el KDS", async ({ page }) => {
    await ingresarConPin(page, USUARIOS.cocina.codigo, USUARIOS.cocina.pin);
    await expect(page.getByTestId("roles")).toHaveText("Cocina");
    await expect(page.getByText("Cocina (KDS)", { exact: true })).toBeVisible();
    await expect(page.getByText("Salón y pedidos", { exact: true })).toHaveCount(0);
  });

  test("un administrador no puede entrar con PIN", async ({ page }) => {
    await ingresarConPin(page, USUARIOS.adminPin.codigo, USUARIOS.adminPin.pin);
    await expect(page.locator("main").getByRole("alert")).toContainText(
      "no tiene un rol habilitado",
    );
    await expect(page).toHaveURL(/\/ingresar$/);
  });
});

test.describe("ingreso con email, contraseña y MFA TOTP", () => {
  test("admin: enrola el autenticador y accede a todo", async ({ page }) => {
    await reiniciarMfa(USUARIOS.admin.id);
    await ingresarComoAdmin(page, USUARIOS.admin.email, USUARIOS.admin.password);
    await expect(page).toHaveURL(/\/inicio$/);
    await expect(page.getByTestId("roles")).toHaveText("Administrador");
    await expect(
      page.getByText("Ingreso con verificación en dos pasos", { exact: true }),
    ).toBeVisible();
    for (const modulo of [
      "Salón y pedidos",
      "Caja y comprobantes",
      "Configuración del local",
      "Auditoría",
    ]) {
      await expect(page.getByText(modulo, { exact: true })).toBeVisible();
    }
  });

  test("auditor: solo reportes y auditoría", async ({ page }) => {
    await reiniciarMfa(USUARIOS.auditor.id);
    await ingresarComoAdmin(page, USUARIOS.auditor.email, USUARIOS.auditor.password);
    await expect(page).toHaveURL(/\/inicio$/);
    await expect(page.getByTestId("roles")).toHaveText("Auditor");
    await expect(page.getByText("Reportes", { exact: true })).toBeVisible();
    await expect(page.getByText("Auditoría", { exact: true })).toBeVisible();
    await expect(page.getByText("Salón y pedidos", { exact: true })).toHaveCount(0);
  });
});
