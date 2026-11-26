// Edge Function emitir-cpe (flujo D.4, §7.1, §10)
//
// Envía al emisor (Nubefact) los comprobantes que cobrar_y_emitir dejó pendientes y registra el
// resultado. La llaman:
//   - la caja, justo después de cobrar, con su sesión: POST { comprobante_id };
//   - pg_cron cada minuto con la service_role, para los reintentos vencidos: POST {}.
// Las credenciales del emisor (NUBEFACT_RUTA y NUBEFACT_TOKEN) son secretos de la función.
//
//   200 { procesados: [{ id, serie, numero, estado }] } · 400 solicitud_invalida · 401 no_autenticado
//   403 sin_permiso · 500 emisor_sin_configurar | error_interno

import { createClient } from "@supabase/supabase-js";
import { NubefactEmisor } from "../_shared/cpe/nubefact.ts";
import { SunatDirectoEmisor } from "../_shared/cpe/sunat-directo.ts";
import type { ComprobanteDTO, EmisorCPE, ResultadoEmision } from "../_shared/cpe/tipos.ts";
import { cabecerasCors, json } from "../_shared/http.ts";
import { ANON_KEY, clienteAdmin, SERVICE_ROLE_KEY, SUPABASE_URL } from "../_shared/sesion.ts";

const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const admin = clienteAdmin();

function emisorPara(proveedor: ComprobanteDTO["proveedor"]): EmisorCPE | null {
  if (proveedor === "sunat_directo") return new SunatDirectoEmisor();
  const ruta = Deno.env.get("NUBEFACT_RUTA");
  const token = Deno.env.get("NUBEFACT_TOKEN");
  return ruta && token ? new NubefactEmisor(ruta, token) : null;
}

async function procesar(cpe: ComprobanteDTO) {
  const emisor = emisorPara(cpe.proveedor);
  let resultado: ResultadoEmision;
  if (!emisor) {
    resultado = {
      estado: "error_red",
      sunat_descripcion: "Emisor sin configurar (NUBEFACT_RUTA/TOKEN)",
    };
  } else {
    try {
      resultado = await emisor.emitir(cpe);
    } catch (e) {
      resultado = {
        estado: "error_red",
        sunat_descripcion: e instanceof Error ? e.message : String(e),
      };
    }
  }
  const { error } = await admin.rpc("cpe_registrar_resultado", {
    p_comprobante_id: cpe.id,
    p_resultado: resultado,
  });
  if (error) throw error;
  return { id: cpe.id, serie: cpe.serie, numero: cpe.numero, estado: resultado.estado };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cabecerasCors(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "metodo_no_permitido" });
  }
  const autorizacion = req.headers.get("authorization");
  if (!autorizacion?.startsWith("Bearer ")) {
    return json(req, 401, { error: "no_autenticado" });
  }

  let comprobanteId: string | null = null;
  try {
    const cuerpo = (await req.json().catch(() => ({}))) as { comprobante_id?: unknown };
    if (cuerpo.comprobante_id !== undefined) {
      if (typeof cuerpo.comprobante_id !== "string" || !FORMATO_UUID.test(cuerpo.comprobante_id)) {
        return json(req, 400, { error: "solicitud_invalida" });
      }
      comprobanteId = cuerpo.comprobante_id;
    }
  } catch {
    return json(req, 400, { error: "solicitud_invalida" });
  }

  try {
    const esServicio = autorizacion.slice(7) === SERVICE_ROLE_KEY;
    if (!esServicio) {
      // La caja solo envía un comprobante suyo, y lo comprueba la base con su sesión.
      if (!comprobanteId) return json(req, 400, { error: "solicitud_invalida" });
      const caja = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: autorizacion } },
      });
      const { error } = await caja.rpc("cpe_puede_emitir", { p_comprobante_id: comprobanteId });
      if (error) {
        if (error.code === "PGRST301" || error.code === "PGRST302") {
          return json(req, 401, { error: "no_autenticado" });
        }
        const estado = /^PT\d{3}$/.test(error.code) ? Number(error.code.slice(2)) : 500;
        return json(req, estado, { error: error.details || "error_interno" });
      }
    }

    const { data, error } = await admin.rpc("cpe_tomar", {
      p_comprobante_id: comprobanteId,
      p_limite: 10,
    });
    if (error) throw error;
    const procesados = [];
    for (const cpe of (data ?? []) as ComprobanteDTO[]) procesados.push(await procesar(cpe));
    return json(req, 200, { procesados });
  } catch (e) {
    console.error("[emitir-cpe]", e instanceof Error ? e.message : e);
    return json(req, 500, { error: "error_interno" });
  }
});
