import path from "node:path";
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import {
  abrirMesa,
  cerrarOrdenes,
  ingresarComoAdmin,
  ingresarConPin,
  mesasLibres,
  MOZOS,
  reiniciarMfa,
  TOKEN_KDS,
  tokenTablet,
  USUARIOS,
} from "../e2e/ayudas";

// Capturas del manual de usuario por rol (docs/manual). Cada paso del manual tiene su imagen.
const DESTINO = path.resolve(import.meta.dirname, "../../../docs/manual/img");
const TABLET = devices["Galaxy Tab S4 landscape"];
const CELULAR = devices["Pixel 7"];

const ordenes: string[] = [];
test.afterAll(async () => {
  await cerrarOrdenes(ordenes);
});

async function foto(page: Page, rol: string, nombre: string, completa = false) {
  await page.waitForLoadState("networkidle");
  // Las notificaciones flotantes se van solas; no deben tapar la captura.
  await page
    .getByTestId("notificacion")
    .first()
    .waitFor({ state: "detached", timeout: 6_000 })
    .catch(() => undefined);
  // Los diálogos entran con una animación corta.
  if (await page.getByRole("dialog").count()) await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(DESTINO, rol, `${nombre}.png`), fullPage: completa });
}

async function contexto(browser: Browser, dispositivo = TABLET) {
  const c = await browser.newContext({
    ...dispositivo,
    locale: "es-PE",
    timezoneId: "America/Lima",
  });
  return c.newPage();
}

async function registrar(page: Page, token: string, nombre: string, rol?: string) {
  await page.goto("/dispositivo");
  if (rol) await foto(page, rol, "01-registrar-dispositivo");
  await page.getByText("Tengo un token de dispositivo").click();
  await page.getByLabel("Token").fill(token);
  await page.getByLabel("Nombre para mostrar").fill(nombre);
  await page.getByRole("button", { name: "Guardar token" }).click();
  await expect(page).toHaveURL(/\/ingresar$/);
}

function item(page: Page, texto: string) {
  return page.getByTestId("item-orden").filter({ hasText: texto });
}

test("mozo y cocina", async ({ browser }) => {
  const [mesa, destino] = await mesasLibres(2);
  const mozo = await contexto(browser);
  const cocina = await contexto(browser);

  // Mozo: registro de la tablet (lo hace el admin una vez) e ingreso con código y PIN.
  await registrar(mozo, tokenTablet(1), "Tablet Salón 1", "mozo");
  await mozo.getByLabel("Código de empleado").fill(MOZOS[0]!.codigo);
  await mozo.getByLabel("PIN", { exact: true }).click();
  for (const d of MOZOS[0]!.pin.slice(0, 2)) {
    await mozo
      .getByRole("group", { name: "Teclado numérico" })
      .getByRole("button", { name: d, exact: true })
      .click();
  }
  await foto(mozo, "mozo", "02-ingresar-pin");
  await mozo.goto("/ingresar");
  await ingresarConPin(mozo, MOZOS[0]!.codigo, MOZOS[0]!.pin);
  await expect(mozo).toHaveURL(/\/inicio$/);
  await foto(mozo, "mozo", "03-inicio");

  await mozo.goto("/salon");
  await mozo.getByRole("tab", { name: mesa!.piso, exact: true }).first().click();
  await foto(mozo, "mozo", "04-salon");
  await mozo.getByTestId(`mesa-${mesa!.codigo}`).first().click();
  await foto(mozo, "mozo", "05-abrir-mesa");

  ordenes.push(await abrirMesa(mozo, mesa!, 3));
  await foto(mozo, "mozo", "06-orden-vacia");
  await mozo.getByTestId("producto-EJ-PARRILLA").click();
  const dialogo = mozo.getByRole("dialog");
  await dialogo.getByRole("button", { name: "Tres cuartos" }).click();
  await dialogo.getByLabel("Nota para cocina").fill("sin sal");
  await foto(mozo, "mozo", "07-modificadores");
  await dialogo.getByRole("button", { name: /^Agregar/ }).click();
  await mozo.getByTestId("producto-EJ-CHICHA").click();
  await mozo.getByTestId("producto-EJ-PAPAS").click();
  await expect(item(mozo, "Papas")).toHaveAttribute("data-estado", "borrador");
  await foto(mozo, "mozo", "08-orden-borrador");
  await mozo.getByTestId("enviar-comanda").click();
  await expect(item(mozo, "Parrilla")).toHaveAttribute("data-estado", "enviado");
  await foto(mozo, "mozo", "09-orden-enviada");

  // Cocina: ingreso en el KDS y despacho.
  await registrar(cocina, TOKEN_KDS, "KDS Cocina", "cocina");
  await ingresarConPin(cocina, USUARIOS.cocina.codigo, USUARIOS.cocina.pin);
  await expect(cocina).toHaveURL(/\/inicio$/);
  await foto(cocina, "cocina", "02-inicio");
  await cocina.goto("/cocina");
  const ticket = cocina.getByTestId("ticket-kds").filter({ hasText: "Parrilla" }).first();
  await expect(ticket).toContainText("sin sal");
  await foto(cocina, "cocina", "03-kds");
  await ticket.getByRole("button", { name: "Listo" }).click();

  // Mozo: aviso de "listo" y servido.
  const aviso = mozo.getByTestId("avisos-listos").getByRole("listitem").first();
  await expect(aviso).toContainText("Parrilla", { timeout: 10_000 });
  await foto(mozo, "mozo", "10-aviso-listo");
  await aviso.getByRole("button", { name: "Servido" }).click();
  await expect(item(mozo, "Parrilla")).toHaveAttribute("data-estado", "servido");

  // Mozo: anulación con el PIN de un supervisor.
  await item(mozo, "Chicha").getByRole("button", { name: "Anular" }).click();
  const anulacion = mozo.getByRole("dialog");
  await anulacion.getByLabel("Motivo").selectOption("cliente_desiste");
  await anulacion.getByLabel("Código").fill(USUARIOS.adminPin.codigo);
  await anulacion.getByLabel("PIN").fill(USUARIOS.adminPin.pin);
  await foto(mozo, "mozo", "11-anular");
  await anulacion.getByRole("button", { name: "Autorizar y anular" }).click();
  await expect(item(mozo, "Chicha")).toHaveAttribute("data-estado", "anulado");
  await foto(mozo, "mozo", "12-anulado");

  // Cocina: el anulado aparece tachado; agotar un plato.
  await expect(cocina.getByTestId("anulado-kds").first()).toContainText("Chicha");
  await foto(cocina, "cocina", "04-kds-anulado");
  await cocina
    .getByRole("button", { name: /agotados/i })
    .first()
    .click();
  await foto(cocina, "cocina", "05-agotados");
  await cocina.keyboard.press("Escape");

  // Mozo: anulación remota (pedir aprobación) y cambio de mesa.
  await item(mozo, "Papas").getByRole("button", { name: "Anular" }).click();
  await mozo.getByRole("dialog").getByLabel("Motivo").selectOption("demora");
  await mozo.getByRole("dialog").getByRole("button", { name: "Pedir aprobación al admin" }).click();
  await expect(item(mozo, "Papas")).toContainText("Anulación pendiente");
  await foto(mozo, "mozo", "13-anulacion-pendiente");

  await mozo.getByRole("button", { name: "Mover mesa" }).click();
  const traslado = mozo.getByRole("dialog");
  await traslado.getByRole("tab", { name: destino!.piso, exact: true }).click();
  await traslado.getByTestId(`mesa-${destino!.codigo}`).click();
  await foto(mozo, "mozo", "14-mover-mesa");
  await traslado.getByRole("button", { name: "Confirmar" }).click();
  await expect(mozo.getByTestId("titulo-pantalla")).toContainText(destino!.etiqueta);

  // Admin desde su celular: aprueba la anulación pendiente.
  const admin = await contexto(browser, CELULAR);
  await reiniciarMfa(USUARIOS.admin.id);
  await ingresarComoAdmin(admin, USUARIOS.admin.email, USUARIOS.admin.password);
  await expect(admin).toHaveURL(/\/inicio$/);
  await admin.goto("/admin/aprobaciones");
  await expect(admin.getByTestId("solicitud-anulacion").first()).toBeVisible();
  await foto(admin, "admin", "10-aprobaciones-celular");
  await admin
    .getByTestId("solicitud-anulacion")
    .first()
    .getByRole("button", { name: "Aprobar" })
    .click();
  await expect(item(mozo, "Papas")).toHaveAttribute("data-estado", "anulado", { timeout: 10_000 });
});

test("administrador", async ({ browser }) => {
  const page = await contexto(browser, {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
  });
  await reiniciarMfa(USUARIOS.admin.id);
  await page.goto("/admin/ingresar");
  await page.getByLabel("Email").fill(USUARIOS.admin.email);
  await foto(page, "admin", "01-ingresar");
  await page.getByLabel("Contraseña").fill(USUARIOS.admin.password);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/admin\/mfa/);
  await expect(page.getByTestId("secreto-totp")).toBeVisible();
  await foto(page, "admin", "02-mfa");
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await reiniciarMfa(USUARIOS.admin.id);
  await ingresarComoAdmin(page, USUARIOS.admin.email, USUARIOS.admin.password);
  await expect(page).toHaveURL(/\/inicio$/);
  await foto(page, "admin", "03-inicio");

  await page.goto("/admin");
  await foto(page, "admin", "04-resumen");

  await page.goto("/admin/carta");
  await expect(page.getByTestId("fila-producto").first()).toBeVisible();
  await foto(page, "admin", "05-carta");
  await page.getByRole("button", { name: "Cargar desde Excel o CSV" }).click();
  const csv = [
    "codigo;nombre;categoria;precio;descripcion;estacion;disponible",
    "MAN-01;Anticuchos;Entradas;18,50;De corazón con papas;Parrilla;si",
    "MAN-02;Limonada frozen;Bebidas;9;;Bar;si",
  ].join("\r\n");
  await page
    .getByRole("dialog")
    .getByLabel("Archivo (.xlsx o .csv)")
    .setInputFiles({
      name: "carta.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await expect(page.getByTestId("vista-importacion")).toBeVisible();
  await foto(page, "admin", "06-carga-masiva");
  await page.keyboard.press("Escape");
  const fila = page.getByTestId("fila-producto").filter({ hasText: "Papas fritas" });
  await fila.getByRole("button", { name: "Precio" }).click();
  await page.getByRole("dialog").getByLabel("Nuevo precio con IGV (S/)").fill("11");
  await page.getByRole("dialog").getByLabel("Motivo (obligatorio)").fill("Alza de insumos");
  await foto(page, "admin", "07-cambio-precio");
  await page.keyboard.press("Escape");

  await page.goto("/admin/menu");
  await foto(page, "admin", "08-menu-del-dia");

  await page.goto("/admin/usuarios");
  await foto(page, "admin", "09-usuarios");
  await page
    .getByRole("button", { name: /Nuevo usuario|Agregar usuario|Dar de alta/ })
    .first()
    .click();
  await foto(page, "admin", "09b-nuevo-usuario");
  await page.keyboard.press("Escape");

  await page.goto("/admin/plano");
  await page.waitForTimeout(1_000);
  await foto(page, "admin", "11-plano");
  await page.goto("/admin/dispositivos");
  await foto(page, "admin", "12-dispositivos");
  await page.goto("/admin/impresoras");
  await foto(page, "admin", "13-impresoras");
  await page.goto("/admin/reportes");
  await foto(page, "admin", "14-reportes");
});
