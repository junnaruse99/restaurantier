import { expect, test, type Page } from "@playwright/test";
import {
  abrirTablet,
  ingresarComoAdmin,
  LOCAL_GRILL,
  reiniciarMfa,
  servicio,
  sinErrores,
  tokenTablet,
  USUARIOS,
} from "./ayudas";

// Administración de la fase 1 (M1, M3, M4) en el perfil de escritorio.
test.describe.configure({ mode: "serial" });
// eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar los fixtures
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "administración en el perfil de escritorio");
});

async function entrarComoAdmin(page: Page, ruta: string) {
  await reiniciarMfa(USUARIOS.admin.id);
  await ingresarComoAdmin(page, USUARIOS.admin.email, USUARIOS.admin.password);
  await expect(page).toHaveURL(/\/inicio$/);
  await page.goto(ruta);
}

test("M3: cambio de precio con motivo, historial y agotado", async ({ page }) => {
  await entrarComoAdmin(page, "/admin/carta");
  const fila = page.getByTestId("fila-producto").filter({ hasText: "Papas fritas" });
  const { data: antes } = await servicio()
    .from("productos")
    .select("id, precio")
    .eq("local_id", LOCAL_GRILL)
    .eq("codigo", "EJ-PAPAS")
    .single();
  const nuevo = Number(antes!.precio) + 0.5;
  const motivo = `Prueba E2E de precios ${Date.now()}`;

  await fila.getByRole("button", { name: "Precio" }).click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByLabel("Nuevo precio con IGV (S/)").fill(String(nuevo));
  await expect(dialogo.getByRole("button", { name: "Cambiar precio" })).toBeDisabled();
  await dialogo.getByLabel("Motivo (obligatorio)").fill(motivo);
  await dialogo.getByRole("button", { name: "Cambiar precio" }).click();
  await expect(fila).toContainText(`S/ ${nuevo.toFixed(2).replace(".", ",")}`);

  await fila.getByRole("button", { name: "Historial" }).click();
  await expect(page.getByRole("dialog").getByRole("row").filter({ hasText: motivo })).toContainText(
    "Admin Warike",
  );
  await page.keyboard.press("Escape");

  await fila.getByRole("button", { name: "Agotar" }).click();
  await expect(fila).toContainText("Agotado");
  await fila.getByRole("button", { name: "Habilitar" }).click();
  await expect(fila).toContainText("Disponible");
  await sinErrores(page);
});

test("M4: el admin crea un mozo y este entra con su código y PIN", async ({ page, browser }) => {
  const codigo = `E${Date.now().toString().slice(-6)}`;
  await entrarComoAdmin(page, "/admin/usuarios");
  await page.getByRole("button", { name: "Nuevo usuario" }).click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByLabel(/^Rol en/).selectOption({ label: "Mozo" });
  await dialogo.getByLabel("Nombre para mostrar").fill(`Mozo ${codigo}`);
  await dialogo.getByLabel("Código de empleado").fill(codigo);
  await dialogo.getByLabel("PIN (4 a 6 dígitos)").fill("2468");
  await dialogo.getByRole("button", { name: "Crear usuario" }).click();
  await expect(page.getByTestId("fila-usuario").filter({ hasText: codigo })).toContainText("Mozo");

  const tablet = await abrirTablet(browser, tokenTablet(3), { codigo, pin: "2468" });
  await expect(tablet.getByTestId("bienvenida")).toHaveText(`Hola, Mozo ${codigo}`);
  await sinErrores(page);
});

test("M1: arrastrar una mesa en el editor guarda su posición", async ({ page }) => {
  const { data: mesa } = await servicio()
    .from("mesas")
    .select("id, codigo, pos_x, pos_y, ancho, alto, piso:pisos(nombre, ancho_canvas)")
    .eq("local_id", LOCAL_GRILL)
    .eq("codigo", "70")
    .single();
  const piso = mesa!.piso as unknown as { nombre: string; ancho_canvas: number };
  await entrarComoAdmin(page, "/admin/plano");
  await page.getByRole("tab", { name: piso.nombre, exact: true }).click();
  const lienzo = page.getByTestId("editor-plano");
  await expect(lienzo.locator("canvas").first()).toBeVisible();
  const caja = (await lienzo.boundingBox())!;
  const escala = caja.width / piso.ancho_canvas;
  const x = caja.x + (mesa!.pos_x + mesa!.ancho / 2) * escala;
  const y = caja.y + (mesa!.pos_y + mesa!.alto / 2) * escala;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60 * escala, y + 40 * escala, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole("form", { name: "Mesa 70" })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await servicio().from("mesas").select("pos_x, pos_y").eq("id", mesa!.id).single()).data,
    )
    .toEqual({ pos_x: mesa!.pos_x + 60, pos_y: mesa!.pos_y + 40 });

  // Se deja como estaba.
  await servicio()
    .from("mesas")
    .update({ pos_x: mesa!.pos_x, pos_y: mesa!.pos_y })
    .eq("id", mesa!.id);
  await sinErrores(page);
});
