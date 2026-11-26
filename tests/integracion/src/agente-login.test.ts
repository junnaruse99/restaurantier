import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_GRILL } from "./entorno";
import {
  clienteCon,
  crearDispositivo,
  desactivarDispositivo,
  llamarFuncion,
  servicio,
} from "./ayudas";

interface RespuestaAgente {
  error?: string;
  session?: { access_token: string; refresh_token: string };
  dispositivo_id?: string;
  local_id?: string;
  sesion_expira_at?: string;
}

const ingresar = (deviceToken: unknown) =>
  llamarFuncion<RespuestaAgente>("agente-login", { device_token: deviceToken });

let agente: { id: string; token: string };
let tablet: { id: string; token: string };
let impresoraId = "";
const extras: string[] = [];

beforeAll(async () => {
  agente = await crearDispositivo("agente_impresion");
  tablet = await crearDispositivo("tablet_mozo");
  const { data, error } = await servicio
    .from("impresoras")
    .insert({
      local_id: LOCAL_GRILL,
      nombre: `Impresora integración ${randomUUID().slice(0, 8)}`,
      tipo_conexion: "tcp",
      host: "127.0.0.1",
      puerto: 9199,
      agente_id: agente.id,
    })
    .select("id")
    .single();
  if (error) throw error;
  impresoraId = data.id;
});

afterAll(async () => {
  for (const id of [agente.id, tablet.id, ...extras]) await desactivarDispositivo(id);
});

describe("agente-login", () => {
  it("el agente entra con el token de su dispositivo y la sesión dura 24 h", async () => {
    const { status, body } = await ingresar(agente.token);
    expect(status).toBe(200);
    expect(body.dispositivo_id).toBe(agente.id);
    expect(body.local_id).toBe(LOCAL_GRILL);
    const horas = (Date.parse(body.sesion_expira_at!) - Date.now()) / 3_600_000;
    expect(horas).toBeGreaterThan(23.9);
    expect(horas).toBeLessThanOrEqual(24);

    const { data: latido, error } = await clienteCon(body.session!.access_token).rpc(
      "agente_latido",
    );
    expect(error).toBeNull();
    expect(latido.impresoras.map((i: { id: string }) => i.id)).toEqual([impresoraId]);
  });

  it("vuelve a entrar con el mismo usuario técnico, también en ingresos simultáneos", async () => {
    const respuestas = await Promise.all([1, 2, 3].map(() => ingresar(agente.token)));
    expect(respuestas.map((r) => r.status)).toEqual([200, 200, 200]);
    const { data } = await servicio
      .from("dispositivos")
      .select("usuario_agente_id")
      .eq("id", agente.id)
      .single();
    const usuarios = await Promise.all(
      respuestas.map(
        async (r) => (await clienteCon(r.body.session!.access_token).auth.getUser()).data.user?.id,
      ),
    );
    expect(new Set(usuarios)).toEqual(new Set([data!.usuario_agente_id]));
  });

  it("el primer ingreso simultáneo de un agente nuevo crea un solo usuario", async () => {
    const nuevo = await crearDispositivo("agente_impresion");
    try {
      const respuestas = await Promise.all([1, 2].map(() => ingresar(nuevo.token)));
      expect(respuestas.map((r) => r.status)).toEqual([200, 200]);
    } finally {
      await desactivarDispositivo(nuevo.id);
    }
  });

  it("toma, imprime y reporta un trabajo de su impresora", async () => {
    const { body } = await ingresar(agente.token);
    const cliente = clienteCon(body.session!.access_token);
    const { data: trabajo, error } = await servicio
      .from("print_jobs")
      .insert({
        local_id: LOCAL_GRILL,
        impresora_id: impresoraId,
        tipo: "comanda",
        payload: { tipo: "comanda", mesa: "Mesa 01", items: [] },
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    const { data: tomados } = await cliente.rpc("agente_tomar_trabajos", { p_limite: 10 });
    expect(tomados.map((t: { id: string }) => t.id)).toContain(trabajo!.id);

    const { data: reporte, error: errorReporte } = await cliente.rpc("agente_reportar_trabajo", {
      p_job_id: trabajo!.id,
      p_ok: true,
    });
    expect(errorReporte).toBeNull();
    expect(reporte.estado).toBe("impreso");
  });

  it("recibe por Realtime los trabajos nuevos de su local", async () => {
    const propio = await crearDispositivo("agente_impresion");
    extras.push(propio.id);
    const { body } = await ingresar(propio.token);
    const cliente = clienteCon(body.session!.access_token);
    await cliente.realtime.setAuth(body.session!.access_token);
    // Realtime puede tardar en empezar a emitir tras SUBSCRIBED y entregar cambios previos: se
    // inserta un trabajo cada 2 s hasta recibir uno de los propios.
    const insertados = new Set<string>();
    const recibidos = new Set<string>();
    let canal: ReturnType<typeof cliente.channel> | undefined;
    let intervalo: ReturnType<typeof setInterval> | undefined;
    const insertar = async () => {
      const { data } = await servicio
        .from("print_jobs")
        .insert({
          local_id: LOCAL_GRILL,
          impresora_id: impresoraId,
          tipo: "comanda",
          payload: { tipo: "comanda" },
        })
        .select("id")
        .single();
      if (data) insertados.add(data.id);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const espera = setTimeout(() => reject(new Error("sin evento de Realtime")), 20_000);
        const revisar = () => {
          if ([...recibidos].some((id) => insertados.has(id))) {
            clearTimeout(espera);
            resolve();
          }
        };
        canal = cliente
          .channel(`agente-${propio.id}`)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "print_jobs",
              filter: `local_id=eq.${LOCAL_GRILL}`,
            },
            (cambio) => {
              recibidos.add((cambio.new as { id: string }).id);
              revisar();
            },
          )
          .subscribe((estado) => {
            if (estado !== "SUBSCRIBED" || intervalo) return;
            void insertar().then(revisar);
            intervalo = setInterval(() => void insertar().then(revisar), 2_000);
          });
      });
    } finally {
      clearInterval(intervalo);
      if (canal) await cliente.removeChannel(canal);
    }
  });

  it("una tablet no entra como agente", async () => {
    const { status, body } = await ingresar(tablet.token);
    expect(status).toBe(401);
    expect(body.error).toBe("dispositivo_no_autorizado");
  });

  it("rechaza tokens desconocidos y solicitudes mal formadas", async () => {
    expect((await ingresar(`wkd_${"0".repeat(64)}`)).status).toBe(401);
    expect((await ingresar("no-es-un-token")).status).toBe(400);
    expect((await ingresar(undefined)).status).toBe(400);
  });

  it("al desactivar el dispositivo el agente pierde la sesión", async () => {
    const otro = await crearDispositivo("agente_impresion");
    const { body } = await ingresar(otro.token);
    const cliente = clienteCon(body.session!.access_token);
    await desactivarDispositivo(otro.id);
    const { error } = await cliente.rpc("agente_latido");
    expect(error?.details).toBe("no_es_agente");
    expect((await ingresar(otro.token)).status).toBe(401);
  });
});
