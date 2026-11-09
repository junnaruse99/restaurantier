import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { ConfigAgente } from "./config";
import type { EstadoImpresora, Impresora } from "./salida";

export interface Trabajo {
  id: string;
  tipo: string;
  payload: unknown;
  intentos: number;
  creado_at: string;
  impresora: Impresora;
}

export interface Latido {
  dispositivo_id: string;
  local_id: string;
  impresoras: Impresora[];
}

/** Lo que el agente necesita del servidor; en las pruebas se reemplaza por un doble. */
export interface ServidorAgente {
  iniciar(): Promise<void>;
  /** La sesión del dispositivo está por vencer y conviene volver a entrar. */
  readonly porVencer: boolean;
  latido(): Promise<Latido>;
  tomarTrabajos(limite: number): Promise<Trabajo[]>;
  reportarTrabajo(id: string, ok: boolean, error?: string): Promise<void>;
  reportarImpresora(id: string, estado: EstadoImpresora): Promise<void>;
  /** Avisa cuando cambia print_jobs del local (Realtime). Devuelve cómo cancelar. */
  suscribir(alCambiar: () => void): () => void;
  cerrar(): Promise<void>;
}

/** La sesión del agente venció o fue revocada: hay que volver a entrar. */
export class SesionVencida extends Error {}

interface RespuestaIngreso {
  error?: string;
  session?: { access_token: string; refresh_token: string };
  local_id?: string;
  sesion_expira_at?: string;
}

/** Conexión real con Supabase: ingreso por agente-login y RPC con la sesión del dispositivo. */
export class ServidorSupabase implements ServidorAgente {
  #cliente: SupabaseClient | undefined;
  #localId = "";
  #expiraAt = 0;
  #canal: RealtimeChannel | undefined;
  #alCambiar: (() => void) | undefined;

  constructor(private readonly config: ConfigAgente) {}

  async iniciar(): Promise<void> {
    const res = await fetch(`${this.config.funcionesUrl}/agente-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: this.config.supabasePublishableKey },
      body: JSON.stringify({ device_token: this.config.deviceToken }),
    });
    const cuerpo = (await res.json().catch(() => ({}))) as RespuestaIngreso;
    if (!res.ok || !cuerpo.session) {
      throw new Error(`agente-login respondió ${res.status}: ${cuerpo.error ?? "sin detalle"}`);
    }
    await this.cerrar();
    const cliente = createClient(this.config.supabaseUrl, this.config.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: true },
    });
    const { error } = await cliente.auth.setSession(cuerpo.session);
    if (error) throw error;
    await cliente.realtime.setAuth(cuerpo.session.access_token);
    this.#cliente = cliente;
    this.#localId = cuerpo.local_id!;
    this.#expiraAt = Date.parse(cuerpo.sesion_expira_at!);
    if (this.#alCambiar) this.#abrirCanal(this.#alCambiar);
  }

  /** La sesión del dispositivo dura 24 h: se renueva 30 min antes. */
  get porVencer(): boolean {
    return Date.now() > this.#expiraAt - 30 * 60_000;
  }

  async #rpc<T>(funcion: string, argumentos?: Record<string, unknown>): Promise<T> {
    if (!this.#cliente) throw new SesionVencida("sin sesión");
    const { data, error } = await this.#cliente.rpc(funcion, argumentos);
    if (error) {
      if (
        error.details === "no_es_agente" ||
        error.code === "PGRST301" ||
        error.code === "PGRST303"
      ) {
        throw new SesionVencida(error.message);
      }
      throw new Error(`${funcion}: ${error.message}`);
    }
    return data as T;
  }

  latido(): Promise<Latido> {
    return this.#rpc<Latido>("agente_latido");
  }

  tomarTrabajos(limite: number): Promise<Trabajo[]> {
    return this.#rpc<Trabajo[]>("agente_tomar_trabajos", { p_limite: limite });
  }

  async reportarTrabajo(id: string, ok: boolean, error?: string): Promise<void> {
    await this.#rpc("agente_reportar_trabajo", { p_job_id: id, p_ok: ok, p_error: error ?? null });
  }

  async reportarImpresora(id: string, estado: EstadoImpresora): Promise<void> {
    await this.#rpc("agente_reportar_impresora", { p_impresora_id: id, p_estado: estado });
  }

  suscribir(alCambiar: () => void): () => void {
    this.#alCambiar = alCambiar;
    this.#abrirCanal(alCambiar);
    return () => {
      this.#alCambiar = undefined;
      void this.#cerrarCanal();
    };
  }

  #abrirCanal(alCambiar: () => void): void {
    if (!this.#cliente) return;
    void this.#cerrarCanal();
    this.#canal = this.#cliente
      .channel(`print_jobs:${this.#localId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "print_jobs",
          filter: `local_id=eq.${this.#localId}`,
        },
        () => alCambiar(),
      )
      .subscribe();
  }

  async #cerrarCanal(): Promise<void> {
    if (this.#canal && this.#cliente) await this.#cliente.removeChannel(this.#canal);
    this.#canal = undefined;
  }

  async cerrar(): Promise<void> {
    await this.#cerrarCanal();
    if (this.#cliente) {
      this.#cliente.auth.stopAutoRefresh();
      this.#cliente.realtime.disconnect();
    }
    this.#cliente = undefined;
  }
}
