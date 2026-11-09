import { randomUUID } from "node:crypto";
import { Agente } from "@warike/print-agent/agente";
import { ServidorSupabase } from "@warike/print-agent/conexion";
import { ImpresoraSimulada } from "@warike/print-agent/simulador";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, ANON_KEY, FUNCTIONS_URL, LOCAL_GRILL, SUPABASE_URL } from "./entorno";
import {
  clienteCon,
  crearDispositivo,
  desactivarDispositivo,
  llamarFuncion,
  servicio,
} from "./ayudas";

// Flujo A y C de punta a punta con el agente real y una impresora simulada: el mozo envía una
// comanda, el agente la imprime; luego la orden se anula con el PIN del admin y sale el aviso.
const sufijo = randomUUID().slice(0, 8);
const impresora = new ImpresoraSimulada();
let agenteDispositivo: { id: string; token: string };
let tablet: { id: string; token: string };
let agente: Agente;
let productoId = "";

beforeAll(async () => {
  const puerto = await impresora.escuchar();
  agenteDispositivo = await crearDispositivo("agente_impresion");
  tablet = await crearDispositivo("tablet_mozo");

  const { data: imp, error: e1 } = await servicio
    .from("impresoras")
    .insert({
      local_id: LOCAL_GRILL,
      nombre: `Simulada ${sufijo}`,
      tipo_conexion: "tcp",
      host: "127.0.0.1",
      puerto,
      ancho_mm: 80,
      agente_id: agenteDispositivo.id,
    })
    .select("id")
    .single();
  if (e1) throw e1;
  const { data: estacion, error: e2 } = await servicio
    .from("estaciones_produccion")
    .insert({ local_id: LOCAL_GRILL, nombre: `Integración ${sufijo}`, impresora_id: imp.id })
    .select("id")
    .single();
  if (e2) throw e2;
  const { data: categoria, error: e3 } = await servicio
    .from("categorias")
    .insert({
      local_id: LOCAL_GRILL,
      nombre: `Integración ${sufijo}`,
      estacion_produccion_id_default: estacion.id,
    })
    .select("id")
    .single();
  if (e3) throw e3;
  const { data: producto, error: e4 } = await servicio
    .from("productos")
    .insert({
      local_id: LOCAL_GRILL,
      categoria_id: categoria.id,
      nombre: "Plato de integración",
      precio: 10,
    })
    .select("id")
    .single();
  if (e4) throw e4;
  productoId = producto.id;

  agente = new Agente(
    new ServidorSupabase({
      supabaseUrl: SUPABASE_URL,
      supabasePublishableKey: ANON_KEY,
      funcionesUrl: FUNCTIONS_URL,
      deviceToken: agenteDispositivo.token,
      pollingMs: 1_000,
      latidoMs: 30_000,
      paginaCodigos: 19,
      rutaUsb: undefined,
      puertoLan: 8443,
    }),
    { pollingMs: 1_000, latidoMs: 30_000, paginaCodigos: 19, registrar: () => undefined },
  );
  await agente.iniciar();
});

afterAll(async () => {
  await agente?.detener();
  await impresora.cerrar();
  await desactivarDispositivo(agenteDispositivo.id);
  await desactivarDispositivo(tablet.id);
  await servicio.from("productos").update({ activo: false }).eq("id", productoId);
});

describe("agente de impresión con el stack real", () => {
  it("imprime la comanda que envía el mozo y el aviso de anulación autorizado con PIN", async () => {
    const ingreso = await llamarFuncion<{ session: { access_token: string } }>("pin-login", {
      device_token: tablet.token,
      codigo: "1002",
      pin: "3581",
    });
    expect(ingreso.status).toBe(200);
    const mozo = clienteCon(ingreso.body.session.access_token);

    const { data: mesas } = await mozo
      .from("mesas")
      .select("id, codigo, nombre_visible")
      .eq("local_id", LOCAL_GRILL)
      .eq("estado", "libre")
      .eq("tipo", "mesa")
      .eq("activa", true)
      .order("codigo", { ascending: false })
      .limit(1);
    const mesa = mesas![0]!;
    const etiqueta = mesa.nombre_visible ?? `Mesa ${mesa.codigo}`;

    const { data: abierta, error: e1 } = await mozo.rpc("abrir_orden", {
      p_mesa_id: mesa.id,
      p_comensales: 2,
    });
    expect(e1).toBeNull();
    const ordenId = abierta.orden_id as string;
    const { error: e2 } = await mozo.rpc("agregar_items", {
      p_orden_id: ordenId,
      p_items: [{ producto_id: productoId, cantidad: 2, nota: "bien caliente" }],
    });
    expect(e2).toBeNull();
    const { error: e3 } = await mozo.rpc("enviar_comanda", { p_orden_id: ordenId });
    expect(e3).toBeNull();

    await impresora.esperarTickets(1, 15_000);
    const comanda = impresora.tickets[0]!.texto;
    expect(comanda).toContain(`INTEGRACIÓN ${sufijo.toUpperCase()}`);
    expect(comanda).toContain(etiqueta);
    expect(comanda).toContain("2 x Plato de integración");
    expect(comanda).toContain("* bien caliente");
    expect(comanda).toContain("Mozo Dos");

    const { data: autorizacion } = await mozo.rpc("autorizar_con_pin", {
      p_local_id: LOCAL_GRILL,
      p_permiso: "autorizar_anulacion",
      p_codigo: ADMIN.codigo,
      p_pin: ADMIN.pin,
    });
    expect(autorizacion.ok).toBe(true);
    const { error: e4 } = await mozo.rpc("anular_orden", {
      p_orden_id: ordenId,
      p_motivo_codigo: "cliente_desiste",
      p_autorizacion_id: autorizacion.autorizacion_id,
    });
    expect(e4).toBeNull();

    await impresora.esperarTickets(2, 15_000);
    const aviso = impresora.tickets[1]!.texto;
    expect(aviso).toContain("*** ANULACIÓN ***");
    expect(aviso).toContain("2 x Plato de integración");
    expect(aviso).toContain("Motivo: Cliente desiste");
    expect(aviso).toContain("Autorizó: Admin Warike");

    const { error: e5 } = await mozo.rpc("liberar_mesa", { p_mesa_id: mesa.id });
    expect(e5).toBeNull();

    // Ambos trabajos quedan impresos.
    await expect
      .poll(
        async () => {
          const { data } = await servicio
            .from("print_jobs")
            .select("estado")
            .eq("agente_id", agenteDispositivo.id);
          return (data ?? []).map((j) => j.estado);
        },
        { timeout: 5_000 },
      )
      .toEqual(["impreso", "impreso"]);
  });
});
