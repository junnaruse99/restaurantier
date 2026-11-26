import { describe, expect, it, vi } from "vitest";
import {
  aJsonNubefact,
  interpretarRespuesta,
  NoImplementadoError,
  NubefactEmisor,
  SunatDirectoEmisor,
  type ComprobanteDTO,
} from "./index";

const boleta: ComprobanteDTO = {
  id: "c1",
  local_id: "l1",
  proveedor: "nubefact",
  tipo_cpe: "03",
  serie: "BBB1",
  numero: 7,
  fecha_emision: "2026-11-26",
  cliente_tipo_doc: "0",
  cliente_num_doc: null,
  cliente_nombre: "CLIENTES VARIOS",
  cliente_direccion: null,
  moneda: "PEN",
  op_gravada: 42.53,
  op_exonerada: 0,
  op_inafecta: 0,
  igv: 4.47,
  icbper: 0.5,
  total: 47.5,
  tasa_igv: 0.105,
  intentos: 1,
  documento_ref: null,
  motivo_nc_codigo: null,
  motivo_nc_texto: null,
  items: [
    {
      descripcion: "Lomo saltado (Jugoso)",
      cantidad: 1,
      unidad: "NIU",
      valor_unitario: 28.959276,
      precio_unitario: 32,
      igv: 3.04,
      icbper: 0,
      total: 32,
      afectacion_igv: "10",
    },
    {
      descripcion: "Bolsa plástica",
      cantidad: 1,
      unidad: "NIU",
      valor_unitario: 0,
      precio_unitario: 0,
      igv: 0,
      icbper: 0.5,
      total: 0,
      afectacion_igv: "10",
    },
  ],
};

describe("aJsonNubefact", () => {
  it("mapea una boleta a clientes varios", () => {
    const j = aJsonNubefact(boleta);
    expect(j).toMatchObject({
      operacion: "generar_comprobante",
      tipo_de_comprobante: 2,
      serie: "BBB1",
      numero: 7,
      sunat_transaction: 1,
      cliente_tipo_de_documento: "-",
      cliente_numero_de_documento: "-",
      cliente_denominacion: "CLIENTES VARIOS",
      fecha_de_emision: "26-11-2026",
      moneda: 1,
      porcentaje_de_igv: 10.5,
      total_gravada: 42.53,
      total_igv: 4.47,
      total_impuestos_bolsas: 0.5,
      total: 47.5,
      enviar_automaticamente_a_la_sunat: true,
    });
    expect((j.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      unidad_de_medida: "NIU",
      codigo: "001",
      cantidad: 1,
      valor_unitario: 28.959276,
      precio_unitario: 32,
      subtotal: 28.96,
      tipo_de_igv: 1,
      igv: 3.04,
      total: 32,
    });
    expect((j.items as Array<Record<string, unknown>>)[1]).toMatchObject({ impuesto_bolsas: 0.5 });
  });

  it("mapea una factura con RUC y una nota de crédito con su referencia", () => {
    const factura = {
      ...boleta,
      tipo_cpe: "01" as const,
      serie: "FFF1",
      cliente_tipo_doc: "6" as const,
      cliente_num_doc: "20480723563",
      cliente_nombre: "EL WARIKE",
      cliente_direccion: "Lima",
    };
    expect(aJsonNubefact(factura)).toMatchObject({
      tipo_de_comprobante: 1,
      cliente_tipo_de_documento: "6",
      cliente_numero_de_documento: "20480723563",
      cliente_direccion: "Lima",
    });
    const nota = {
      ...factura,
      tipo_cpe: "07" as const,
      motivo_nc_codigo: "01",
      documento_ref: { tipo_cpe: "01", serie: "FFF1", numero: 3 },
    };
    expect(aJsonNubefact(nota)).toMatchObject({
      tipo_de_comprobante: 3,
      documento_que_se_modifica_tipo: 1,
      documento_que_se_modifica_serie: "FFF1",
      documento_que_se_modifica_numero: 3,
      tipo_de_nota_de_credito: 1,
    });
    const debito = { ...nota, tipo_cpe: "08" as const, motivo_nc_codigo: "02" };
    expect(aJsonNubefact(debito)).toMatchObject({
      tipo_de_comprobante: 4,
      tipo_de_nota_de_debito: 2,
    });
    expect(() => aJsonNubefact({ ...nota, documento_ref: null })).toThrow(/modifica/);
  });

  it("marca exonerados e inafectos", () => {
    const j = aJsonNubefact({
      ...boleta,
      items: [
        { ...boleta.items[0]!, afectacion_igv: "20" },
        { ...boleta.items[0]!, afectacion_igv: "30" },
      ],
    });
    expect((j.items as Array<{ tipo_de_igv: number }>).map((i) => i.tipo_de_igv)).toEqual([8, 9]);
  });
});

describe("interpretarRespuesta", () => {
  it("aceptado, observado y rechazado", () => {
    const aceptada = {
      aceptada_por_sunat: true,
      sunat_responsecode: "0",
      codigo_hash: "h=",
      cadena_para_codigo_qr: "qr",
      enlace_del_pdf: "https://pdf",
      sunat_description: "La Boleta ha sido aceptada",
    };
    expect(interpretarRespuesta(200, aceptada)).toMatchObject({
      estado: "aceptado",
      hash: "h=",
      qr: "qr",
      enlace_pdf: "https://pdf",
      sunat_codigo: "0",
    });
    expect(interpretarRespuesta(200, { ...aceptada, sunat_responsecode: "4252" }).estado).toBe(
      "observado",
    );
    expect(
      interpretarRespuesta(200, { aceptada_por_sunat: false, enlace_del_pdf: "https://pdf" })
        .estado,
    ).toBe("observado");
    expect(interpretarRespuesta(400, { errors: "El número ya existe", codigo: 23 })).toMatchObject({
      estado: "rechazado",
      sunat_descripcion: "El número ya existe",
    });
    expect(interpretarRespuesta(502, {}).estado).toBe("error_red");
    expect(interpretarRespuesta(200, {}).estado).toBe("error_red");
  });
});

describe("NubefactEmisor", () => {
  const respuesta = (cuerpo: unknown, estado = 200) =>
    Promise.resolve(new Response(JSON.stringify(cuerpo), { status: estado }));

  it("envía a la RUTA con el token y devuelve el resultado con la solicitud", async () => {
    const hacerFetch = vi.fn(() =>
      respuesta({ aceptada_por_sunat: true, sunat_responsecode: "0" }),
    );
    const emisor = new NubefactEmisor(
      "https://api.nubefact.test/api/v1/x",
      "secreto",
      hacerFetch as typeof fetch,
    );
    const r = await emisor.emitir(boleta);
    expect(r.estado).toBe("aceptado");
    expect(r.request).toMatchObject({ serie: "BBB1", numero: 7 });
    const [url, init] = hacerFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.nubefact.test/api/v1/x");
    expect((init.headers as Record<string, string>).Authorization).toBe('Token token="secreto"');
  });

  it("en un reintento consulta primero y no duplica un comprobante ya generado", async () => {
    const hacerFetch = vi.fn(() =>
      respuesta({ aceptada_por_sunat: true, sunat_responsecode: "0", codigo_hash: "h" }),
    );
    const emisor = new NubefactEmisor("https://n", "t", hacerFetch as typeof fetch);
    const r = await emisor.emitir({ ...boleta, intentos: 2 });
    expect(r.hash).toBe("h");
    expect(hacerFetch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((hacerFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
        .operacion,
    ).toBe("consultar_comprobante");
  });

  it("si la consulta no lo encuentra, lo genera", async () => {
    const hacerFetch = vi
      .fn()
      .mockImplementationOnce(() => respuesta({ errors: "No existe", codigo: 24 }, 400))
      .mockImplementationOnce(() =>
        respuesta({ aceptada_por_sunat: true, sunat_responsecode: "0" }),
      );
    const emisor = new NubefactEmisor("https://n", "t", hacerFetch as typeof fetch);
    expect((await emisor.emitir({ ...boleta, intentos: 3 })).estado).toBe("aceptado");
    expect(hacerFetch).toHaveBeenCalledTimes(2);
  });

  it("un fallo de red o una respuesta que no es JSON se reintenta", async () => {
    const caido = new NubefactEmisor("https://n", "t", (() =>
      Promise.reject(new Error("ECONNRESET"))) as typeof fetch);
    expect(await caido.emitir(boleta)).toMatchObject({
      estado: "error_red",
      sunat_descripcion: "ECONNRESET",
    });
    const html = new NubefactEmisor("https://n", "t", (() =>
      Promise.resolve(new Response("<html>", { status: 503 }))) as typeof fetch);
    expect((await html.emitir(boleta)).estado).toBe("error_red");
  });
});

describe("SunatDirectoEmisor (stub del MVP)", () => {
  it("rechaza todas las operaciones con NoImplementadoError", async () => {
    const emisor = new SunatDirectoEmisor();
    await expect(emisor.emitir(boleta)).rejects.toBeInstanceOf(NoImplementadoError);
    await expect(emisor.consultar("03", "B002", 1)).rejects.toThrow(/docs\/sunat-directo\.md/);
  });
});
