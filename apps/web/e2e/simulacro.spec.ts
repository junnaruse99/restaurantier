import { expect, test, type Page } from "@playwright/test";
import {
  abrirMesa,
  abrirTablet,
  cerrarOrdenes,
  mesasLibres,
  MOZOS,
  servicio,
  sinErrores,
  textoMesa,
  tocarMesa,
  TOKEN_KDS,
  tokenTablet,
  USUARIOS,
} from "./ayudas";

// Criterio de salida de la fase 1 (§15): simulacro de servicio con 5 tablets sin errores.
// Cinco mozos trabajan a la vez en sus tablets, cocina despacha desde el KDS y el salón se
// actualiza en vivo en todas.
// eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar los fixtures
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "tablet", "simulacro en el perfil tablet");
});

const ordenes: string[] = [];
test.afterAll(async () => {
  await cerrarOrdenes(ordenes);
});

test("simulacro: 5 tablets toman pedidos a la vez, cocina despacha y nadie ve errores", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const inicio = new Date().toISOString();
  const libres = await mesasLibres(8);
  const mesas = libres.slice(0, 5);
  const [destinoMover, destinoUnir, sonda] = libres.slice(5);

  const tablets: Page[] = await Promise.all(
    MOZOS.map((m, i) => abrirTablet(browser, tokenTablet((i + 1) as 1 | 2 | 3 | 4 | 5), m)),
  );
  const kds = await abrirTablet(browser, TOKEN_KDS, USUARIOS.cocina);
  await kds.goto("/cocina");

  // 1. Los cinco abren su mesa, piden y envían a la vez.
  const ids = await Promise.all(
    tablets.map(async (page, i) => {
      const id = await abrirMesa(page, mesas[i]!, i + 1);
      ordenes.push(id);
      await page.getByTestId("producto-EJ-CHICHA").click();
      await expect(page.getByTestId("item-orden")).toHaveCount(1);
      await page.getByTestId("producto-EJ-PAPAS").click();
      await expect(page.getByTestId("item-orden")).toHaveCount(2);
      await page.getByTestId("enviar-comanda").click();
      await expect(
        page.getByTestId("item-orden").and(page.locator('[data-estado="enviado"]')),
      ).toHaveCount(2);
      return id;
    }),
  );

  // 2. Cocina ve las 10 comandas (Bar y Cocina por mesa) y las marca listas.
  for (const mesa of mesas) {
    const tickets = kds.getByTestId("ticket-kds").filter({ hasText: textoMesa(mesa.etiqueta) });
    await expect(tickets).toHaveCount(2);
    for (let restantes = 2; restantes > 0; restantes--) {
      await tickets.first().getByRole("button", { name: "Listo" }).click();
      await expect(tickets).toHaveCount(restantes - 1);
    }
  }

  // 3. Cada mozo recibe el aviso de sus platos y los marca servidos.
  await Promise.all(
    tablets.map(async (page, i) => {
      const avisos = page
        .getByTestId("avisos-listos")
        .getByRole("listitem")
        .filter({ hasText: textoMesa(mesas[i]!.etiqueta) });
      await expect(avisos).toHaveCount(2, { timeout: 10_000 });
      for (let n = 2; n > 0; n--) {
        await avisos.first().getByRole("button", { name: "Servido" }).click();
        await expect(avisos).toHaveCount(n - 1);
      }
      await expect(
        page.getByTestId("item-orden").and(page.locator('[data-estado="servido"]')),
      ).toHaveCount(2);
    }),
  );

  // 4. Cambios de mesa simultáneos: uno mueve y otro une.
  await Promise.all([
    (async () => {
      const page = tablets[0]!;
      await page.getByRole("button", { name: "Mover mesa" }).click();
      const d = page.getByRole("dialog");
      await d.getByRole("tab", { name: destinoMover!.piso, exact: true }).click();
      await d.getByTestId(`mesa-${destinoMover!.codigo}`).click();
      await d.getByRole("button", { name: "Confirmar" }).click();
      await expect(page.getByTestId("titulo-pantalla")).toContainText(
        textoMesa(destinoMover!.etiqueta),
      );
    })(),
    (async () => {
      const page = tablets[1]!;
      await page.getByRole("button", { name: "Unir mesa" }).click();
      const d = page.getByRole("dialog");
      await d.getByRole("tab", { name: destinoUnir!.piso, exact: true }).click();
      await d.getByTestId(`mesa-${destinoUnir!.codigo}`).click();
      await d.getByRole("button", { name: "Confirmar" }).click();
      await expect(page.getByText(`Unida: ${destinoUnir!.etiqueta}`)).toBeVisible();
    })(),
  ]);

  // 5. M1: un cambio en una tablet se ve en otra en ≤ 2 s.
  const observador = tablets[4]!;
  const actor = tablets[3]!;
  await observador.goto("/salon");
  await observador.getByRole("tab", { name: sonda!.piso, exact: true }).click();
  const enObservador = observador.getByTestId(`mesa-${sonda!.codigo}`);
  await expect(enObservador).toHaveAttribute("data-estado", "libre");
  await actor.goto("/salon");
  await tocarMesa(actor, sonda!);
  await actor.getByRole("button", { name: "Abrir mesa" }).click();
  const t0 = Date.now();
  await expect(actor).toHaveURL(/\/salon\/orden\?id=/);
  ordenes.push(new URL(actor.url()).searchParams.get("id")!);
  await expect(enObservador).toHaveAttribute("data-estado", "ocupada", { timeout: 2_000 });
  test.info().annotations.push({ type: "latencia_salon_ms", description: String(Date.now() - t0) });

  // 6. Ninguna pantalla mostró errores.
  for (const page of [...tablets, kds]) await sinErrores(page);

  // 7. La base quedó consistente: 2 ítems servidos y 2 comandas por orden, un trabajo de impresión
  //    por comanda (sin duplicados) y las mesas en el estado esperado.
  const { data: detalle } = await servicio()
    .from("ordenes")
    .select("id, numero_dia, mesa_principal_id, orden_items(estado), comandas(id)")
    .in("id", ids);
  expect(detalle).toHaveLength(5);
  for (const o of detalle!) {
    expect(o.orden_items.map((i) => i.estado)).toEqual(["servido", "servido"]);
    expect(o.comandas).toHaveLength(2);
  }
  const { data: trabajos } = await servicio()
    .from("print_jobs")
    .select("payload")
    .eq("tipo", "comanda")
    .gte("created_at", inicio);
  const numeros = new Set(detalle!.map((o) => o.numero_dia));
  const deEstasOrdenes = (trabajos ?? []).filter((t) =>
    numeros.has((t.payload as { orden_numero: number }).orden_numero),
  );
  expect(deEstasOrdenes).toHaveLength(10);
  const movida = detalle!.find((o) => o.id === ids[0]);
  expect(movida!.mesa_principal_id).toBe(destinoMover!.id);
  const { data: estados } = await servicio()
    .from("mesas")
    .select("id, estado")
    .in("id", [mesas[0]!.id, destinoUnir!.id]);
  expect(Object.fromEntries(estados!.map((m) => [m.id, m.estado]))).toEqual({
    [mesas[0]!.id]: "por_limpiar",
    [destinoUnir!.id]: "ocupada",
  });
});
