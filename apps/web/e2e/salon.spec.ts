import { devices, expect, test, type Page } from "@playwright/test";
import {
  abrirMesa as abrirMesaEnSalon,
  abrirTablet,
  cerrarOrdenes,
  ingresarComoAdmin,
  mesasLibres,
  MOZOS,
  reiniciarMfa,
  sinErrores,
  textoMesa,
  TOKEN_KDS,
  tokenTablet,
  USUARIOS,
  type MesaLibre,
} from "./ayudas";

// Flujos A, B y C de §8 con tablets reales: mozo, cocina (KDS) y admin. Se corren en el perfil
// tablet; el de escritorio ya cubre el admin en admin.spec.ts.
test.describe.configure({ mode: "serial" });
// eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar los fixtures
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "tablet", "flujos de salón en el perfil tablet");
});

const ordenes: string[] = [];
test.afterAll(async () => {
  await cerrarOrdenes(ordenes);
});

async function abrirMesa(page: Page, mesa: MesaLibre, comensales = 2): Promise<string> {
  const id = await abrirMesaEnSalon(page, mesa, comensales);
  ordenes.push(id);
  return id;
}

function item(page: Page, texto: string) {
  return page.getByTestId("item-orden").filter({ hasText: texto });
}

test("flujo A, C y B: pedido a cocina, aviso de listo, anulación con PIN y cambio de mesa", async ({
  browser,
}) => {
  const [mesa, destino] = await mesasLibres(2);
  const mozo = await abrirTablet(browser, tokenTablet(1), MOZOS[0]);
  const cocina = await abrirTablet(browser, TOKEN_KDS, USUARIOS.cocina);

  // A.1–A.3: abrir mesa, agregar ítems (con modificador y nota) y enviar.
  await abrirMesa(mozo, mesa!, 3);
  await mozo.getByTestId("producto-EJ-CHICHA").click();
  await expect(item(mozo, "Chicha")).toHaveAttribute("data-estado", "borrador");
  await mozo.getByTestId("producto-EJ-PARRILLA").click();
  const dialogo = mozo.getByRole("dialog");
  await dialogo.getByRole("button", { name: /^Agregar/ }).click();
  await expect(dialogo.getByRole("alert")).toContainText('Elija 1 de "Término"');
  await dialogo.getByRole("button", { name: "Tres cuartos" }).click();
  await dialogo.getByLabel("Nota para cocina").fill("sin sal");
  await dialogo.getByRole("button", { name: /^Agregar/ }).click();
  await expect(item(mozo, "Parrilla")).toContainText("Tres cuartos");
  await expect(mozo.getByTestId("total-orden")).toHaveText("S/ 57,00");
  await mozo.getByTestId("enviar-comanda").click();
  await expect(item(mozo, "Parrilla")).toHaveAttribute("data-estado", "enviado");
  await expect(item(mozo, "Chicha")).toHaveAttribute("data-estado", "enviado");

  // A.4: el KDS muestra la comanda; cocina marca "Listo" y el mozo recibe el aviso (CU7.2).
  await cocina.goto("/cocina");
  const ticketParrilla = cocina
    .getByTestId("ticket-kds")
    .filter({ hasText: textoMesa(mesa!.etiqueta) })
    .filter({ hasText: "Parrilla" });
  await expect(ticketParrilla).toContainText("* sin sal");
  await ticketParrilla.getByRole("button", { name: "Listo" }).click();
  const aviso = mozo
    .getByTestId("avisos-listos")
    .getByRole("listitem")
    .filter({ hasText: textoMesa(mesa!.etiqueta) });
  await expect(aviso).toContainText("Parrilla", { timeout: 5_000 });
  await aviso.getByRole("button", { name: "Servido" }).click();
  await expect(item(mozo, "Parrilla")).toHaveAttribute("data-estado", "servido");

  // C: anular la chicha ya enviada con el PIN del admin en la tablet; cocina la ve tachada.
  await item(mozo, "Chicha").getByRole("button", { name: "Anular" }).click();
  const anulacion = mozo.getByRole("dialog");
  await anulacion.getByLabel("Motivo").selectOption("cliente_desiste");
  await anulacion.getByLabel("Código").fill(USUARIOS.adminPin.codigo);
  await anulacion.getByLabel("PIN").fill("1111");
  await anulacion.getByRole("button", { name: "Autorizar y anular" }).click();
  await expect(anulacion.getByRole("alert")).toContainText("Código o PIN incorrecto");
  await anulacion.getByLabel("PIN").fill(USUARIOS.adminPin.pin);
  await anulacion.getByRole("button", { name: "Autorizar y anular" }).click();
  await expect(item(mozo, "Chicha")).toHaveAttribute("data-estado", "anulado");
  await expect(mozo.getByTestId("total-orden")).toHaveText("S/ 45,00");
  await expect(
    cocina.getByTestId("anulado-kds").filter({ hasText: textoMesa(mesa!.etiqueta) }),
  ).toContainText("Chicha");

  // B: mover la orden a otra mesa (de cualquier piso); la anterior queda por limpiar.
  await mozo.getByRole("button", { name: "Mover mesa" }).click();
  const traslado = mozo.getByRole("dialog");
  await traslado.getByRole("tab", { name: destino!.piso, exact: true }).click();
  await traslado.getByTestId(`mesa-${destino!.codigo}`).click();
  await expect(traslado.getByTestId("destino-traslado")).toHaveText(destino!.etiqueta);
  await traslado.getByRole("button", { name: "Confirmar" }).click();
  await expect(mozo.getByTestId("titulo-pantalla")).toContainText(textoMesa(destino!.etiqueta));
  await mozo.goto("/salon");
  await mozo.getByRole("tab", { name: mesa!.piso, exact: true }).click();
  await expect(mozo.getByTestId(`mesa-${mesa!.codigo}`)).toHaveAttribute(
    "data-estado",
    "por_limpiar",
  );

  await sinErrores(mozo);
  await sinErrores(cocina);
});

test("anulación remota: el mozo la pide y el admin la aprueba desde su celular", async ({
  browser,
}) => {
  const [mesa] = await mesasLibres(1);
  const mozo = await abrirTablet(browser, tokenTablet(2), MOZOS[1]);
  await abrirMesa(mozo, mesa!);
  await mozo.getByTestId("producto-EJ-PAPAS").click();
  await mozo.getByTestId("enviar-comanda").click();
  await expect(item(mozo, "Papas")).toHaveAttribute("data-estado", "enviado");

  await item(mozo, "Papas").getByRole("button", { name: "Anular" }).click();
  await mozo.getByRole("dialog").getByLabel("Motivo").selectOption("demora");
  await mozo.getByRole("dialog").getByRole("button", { name: "Pedir aprobación al admin" }).click();
  await expect(item(mozo, "Papas")).toContainText("Anulación pendiente");

  const contexto = await browser.newContext({
    ...devices["Pixel 7"],
    locale: "es-PE",
    timezoneId: "America/Lima",
  });
  const admin = await contexto.newPage();
  await reiniciarMfa(USUARIOS.admin.id);
  await ingresarComoAdmin(admin, USUARIOS.admin.email, USUARIOS.admin.password);
  await expect(admin).toHaveURL(/\/inicio$/);
  await admin.goto("/admin/aprobaciones");
  const solicitud = admin
    .getByTestId("solicitud-anulacion")
    .filter({ hasText: textoMesa(mesa!.etiqueta) });
  await expect(solicitud).toContainText("Demora");
  await solicitud.getByRole("button", { name: "Aprobar" }).click();
  await expect(solicitud).toHaveCount(0);

  // La tablet del mozo lo ve en vivo.
  await expect(item(mozo, "Papas")).toHaveAttribute("data-estado", "anulado", { timeout: 5_000 });
  await sinErrores(mozo);
  await sinErrores(admin);
});
