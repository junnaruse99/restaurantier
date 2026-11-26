import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAJERO, LOCAL_GRILL, MOZO, SERVICE_ROLE_KEY } from "./entorno";
import {
  clienteCon,
  crearDispositivo,
  desactivarDispositivo,
  llamarFuncion,
  servicio,
} from "./ayudas";
import { NubefactSimulado } from "./nubefact-simulado";

// Flujo D de punta a punta: el mozo pide, la caja cobra con cobrar_y_emitir y emitir-cpe envía el
// comprobante a un Nubefact simulado. Las funciones deben tener NUBEFACT_RUTA apuntando al
// simulador (http://host.docker.internal:9300/api/v1/prueba en el CI) y NUBEFACT_TOKEN.
const PUERTO = Number(process.env.NUBEFACT_SIMULADO_PUERTO ?? 9300);
const TOKEN = process.env.NUBEFACT_SIMULADO_TOKEN ?? "token-de-prueba";
const nubefact = new NubefactSimulado(PUERTO, TOKEN);

let tablet: { id: string; token: string };
let cajaDispositivo: { id: string; token: string };
let cajaId = "";
let sesionId = "";
let mozo = "";
let cajero = "";
let papas: { id: string; precio: number };
const mesas: string[] = [];

interface Emision {
  procesados?: Array<{ id: string; serie: string; numero: number; estado: string }>;
  error?: string;
}

async function ingresar(token: string, persona: { codigo: string; pin: string }) {
  const { status, body } = await llamarFuncion<{ session: { access_token: string } }>("pin-login", {
    device_token: token,
    codigo: persona.codigo,
    pin: persona.pin,
  });
  if (status !== 200) throw new Error(`pin-login ${status}`);
  return body.session.access_token;
}

/** Abre una mesa libre, pide unas papas, las envía y cobra con boleta en efectivo. */
async function venta(): Promise<{
  comprobanteId: string;
  total: number;
  serie: string;
  numero: number;
}> {
  const { data: libre } = await servicio
    .from("mesas")
    .select("id")
    .eq("local_id", LOCAL_GRILL)
    .eq("estado", "libre")
    .eq("activa", true)
    .eq("tipo", "mesa")
    .not("id", "in", `(${mesas.length ? mesas.join(",") : randomUUID()})`)
    .limit(1)
    .single();
  mesas.push(libre!.id);
  const m = clienteCon(mozo);
  const { data: orden, error: e1 } = await m.rpc("abrir_orden", {
    p_mesa_id: libre!.id,
    p_comensales: 1,
  });
  if (e1) throw e1;
  const { error: e2 } = await m.rpc("agregar_items", {
    p_orden_id: orden.orden_id,
    p_items: [{ producto_id: papas.id }],
  });
  if (e2) throw e2;
  const { error: e3 } = await m.rpc("enviar_comanda", { p_orden_id: orden.orden_id });
  if (e3) throw e3;
  const { data: cobro, error: e4 } = await clienteCon(cajero).rpc("cobrar_y_emitir", {
    p_orden_id: orden.orden_id,
    p_sesion_id: sesionId,
    p_tipo_cpe: "03",
    p_cliente: {},
    p_pagos: [{ metodo: "efectivo", monto: papas.precio, monto_recibido: 100 }],
  });
  if (e4) throw e4;
  return {
    comprobanteId: cobro.comprobante_id,
    total: cobro.total,
    serie: cobro.serie,
    numero: cobro.numero,
  };
}

beforeAll(async () => {
  await nubefact.iniciar();
  tablet = await crearDispositivo("tablet_mozo");
  cajaDispositivo = await crearDispositivo("caja");
  const { data: caja, error } = await servicio
    .from("cajas")
    .insert({
      local_id: LOCAL_GRILL,
      nombre: `Caja integración ${randomUUID().slice(0, 8)}`,
      dispositivo_id: cajaDispositivo.id,
    })
    .select("id")
    .single();
  if (error) throw error;
  cajaId = caja.id;
  const { data: producto } = await servicio
    .from("productos")
    .select("id, precio")
    .eq("local_id", LOCAL_GRILL)
    .eq("codigo", "EJ-PAPAS")
    .single();
  papas = { id: producto!.id, precio: Number(producto!.precio) };
  await servicio.from("productos").update({ disponible: true }).eq("id", papas.id);
  mozo = await ingresar(tablet.token, MOZO);
  cajero = await ingresar(cajaDispositivo.token, CAJERO);
  const { data: sesion, error: e2 } = await clienteCon(cajero).rpc("abrir_caja", {
    p_caja_id: cajaId,
    p_monto_apertura: 100,
  });
  if (e2) throw e2;
  sesionId = sesion.sesion_id;
});

afterAll(async () => {
  const m = clienteCon(mozo);
  for (const id of mesas) await m.rpc("liberar_mesa", { p_mesa_id: id });
  await clienteCon(cajero)
    .rpc("cerrar_caja", { p_sesion_id: sesionId, p_desglose: {}, p_transferir_mesas: false })
    .then(
      () => undefined,
      () => undefined,
    );
  await desactivarDispositivo(tablet.id);
  await desactivarDispositivo(cajaDispositivo.id);
  await nubefact.detener();
});

describe("emitir-cpe", () => {
  it("la caja cobra y el comprobante sale aceptado con su PDF, hash y ticket", async () => {
    const v = await venta();
    const { status, body } = await llamarFuncion<Emision>(
      "emitir-cpe",
      { comprobante_id: v.comprobanteId },
      { Authorization: `Bearer ${cajero}` },
    );
    expect(status).toBe(200);
    expect(body.procesados).toEqual([
      { id: v.comprobanteId, serie: v.serie, numero: v.numero, estado: "aceptado" },
    ]);

    const enviado = nubefact.documentos.get(`2-${v.serie}-${v.numero}`)!.cuerpo;
    expect(enviado).toMatchObject({
      serie: v.serie,
      numero: v.numero,
      total: v.total,
      cliente_tipo_de_documento: "-",
    });
    const { data: c } = await servicio
      .from("comprobantes")
      .select("estado, enlace_pdf, hash, sunat_codigo")
      .eq("id", v.comprobanteId)
      .single();
    expect(c).toMatchObject({ estado: "aceptado", sunat_codigo: "0" });
    expect(c!.enlace_pdf).toMatch(/\.pdf$/);
    expect(c!.hash).toBeTruthy();
  });

  it("si Nubefact está caído queda pendiente y el reintento no duplica el comprobante", async () => {
    const v = await venta();
    nubefact.fallarProximas = 1;
    const primero = await llamarFuncion<Emision>(
      "emitir-cpe",
      { comprobante_id: v.comprobanteId },
      { Authorization: `Bearer ${cajero}` },
    );
    expect(primero.body.procesados?.[0]?.estado).toBe("error_red");
    const { data: pendiente } = await servicio
      .from("comprobantes")
      .select("estado, proximo_intento_at")
      .eq("id", v.comprobanteId)
      .single();
    expect(pendiente!.estado).toBe("pendiente_envio");
    expect(Date.parse(pendiente!.proximo_intento_at)).toBeGreaterThan(Date.now());

    // Vence el reintento y lo procesa la cola (pg_cron llama con la service_role).
    await servicio
      .from("comprobantes")
      .update({ proximo_intento_at: new Date().toISOString() })
      .eq("id", v.comprobanteId);
    const antes = nubefact.solicitudes.length;
    const cola = await llamarFuncion<Emision>(
      "emitir-cpe",
      {},
      { Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    );
    expect(cola.status).toBe(200);
    expect(cola.body.procesados?.find((p) => p.id === v.comprobanteId)?.estado).toBe("aceptado");
    const nuevas = nubefact.solicitudes.slice(antes).map((s) => s.operacion);
    expect(nuevas.slice(0, 2)).toEqual(["consultar_comprobante", "generar_comprobante"]);
  });

  it("exige una sesión con permiso de cobro y un comprobante válido", async () => {
    expect((await llamarFuncion("emitir-cpe", { comprobante_id: randomUUID() })).status).toBe(401);
    const v = await venta();
    const comoMozo = await llamarFuncion<Emision>(
      "emitir-cpe",
      { comprobante_id: v.comprobanteId },
      { Authorization: `Bearer ${mozo}` },
    );
    expect(comoMozo.status).toBe(403);
    expect(comoMozo.body.error).toBe("sin_permiso");
    const malFormada = await llamarFuncion<Emision>(
      "emitir-cpe",
      { comprobante_id: "no-es-uuid" },
      { Authorization: `Bearer ${cajero}` },
    );
    expect(malFormada.status).toBe(400);
    const desconocido = await llamarFuncion<Emision>(
      "emitir-cpe",
      { comprobante_id: randomUUID() },
      { Authorization: `Bearer ${cajero}` },
    );
    expect(desconocido.status).toBe(404);
    // Lo deja emitido para la siguiente corrida.
    await llamarFuncion(
      "emitir-cpe",
      { comprobante_id: v.comprobanteId },
      { Authorization: `Bearer ${cajero}` },
    );
  });
});
