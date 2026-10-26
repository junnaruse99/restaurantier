"use client";

import { useQuery } from "@tanstack/react-query";
import { fechaOperativa, precioVigente, type ReglaPrecioDia } from "@warike/domain";
import { useEnVivo } from "./en-vivo";
import { aErrorRpc } from "./rpc";
import { supabase } from "./supabase";

// ---------------------------------------------------------------------------
// Tipos (filas de PostgREST)
// ---------------------------------------------------------------------------
export type EstadoMesa = "libre" | "ocupada" | "precuenta" | "por_limpiar" | "bloqueada";
export type EstadoItem =
  "borrador" | "enviado" | "en_preparacion" | "listo" | "servido" | "anulado";

export interface Piso {
  id: string;
  nombre: string;
  orden: number;
  ancho_canvas: number;
  alto_canvas: number;
}

export interface Mesa {
  id: string;
  piso_id: string;
  codigo: string;
  nombre_visible: string | null;
  tipo: string;
  capacidad: number;
  pos_x: number;
  pos_y: number;
  ancho: number;
  alto: number;
  forma: "rect" | "circle";
  rotacion: number;
  activa: boolean;
  estado: EstadoMesa;
}

export interface OrdenEnCurso {
  id: string;
  numero_dia: number;
  mesa_principal_id: string | null;
  mozo_id: string | null;
  comensales: number;
  estado: "abierta" | "precuenta";
  total: number;
  abierta_at: string;
  mozo: { nombre_visible: string } | null;
  mesa_uniones: Array<{ mesa_id: string; es_principal: boolean; liberada_at: string | null }>;
}

export interface ItemOrden {
  id: string;
  orden_id: string;
  producto_id: string;
  nombre_snapshot: string;
  cantidad: number;
  precio_unitario_snapshot: number;
  modificadores: Array<{ grupo: string; nombre: string; precio_extra: number }>;
  nota: string | null;
  total_linea: number;
  cuenta_split: number;
  estacion_produccion_id: string | null;
  comanda_id: string | null;
  estado: EstadoItem;
  enviado_at: string | null;
  anulado_at: string | null;
  created_at: string;
}

export interface Comanda {
  id: string;
  numero: number;
  estacion_produccion_id: string;
  enviada_at: string;
  reimpresiones: number;
}

export interface Orden extends Omit<OrdenEnCurso, "estado"> {
  estado: "abierta" | "precuenta" | "pagada" | "anulada";
  subtotal: number;
  local_id: string;
}

export interface Categoria {
  id: string;
  nombre: string;
  orden: number;
  estacion_produccion_id_default: string | null;
}

export interface Producto {
  id: string;
  categoria_id: string;
  codigo: string | null;
  nombre: string;
  descripcion: string | null;
  precio: number;
  disponible: boolean;
  es_menu_del_dia: boolean;
  estacion_produccion_id: string | null;
  activo: boolean;
  reglas_precio_dia: ReglaPrecioDia[];
}

export interface Modificador {
  id: string;
  grupo: string;
  nombre: string;
  precio_extra: number;
}

export interface GrupoDeProducto {
  producto_id: string;
  grupo: string;
  obligatorio: boolean;
  min: number;
  max: number;
}

export interface MenuDiario {
  producto_id: string;
  fecha: string;
  entradas: string[];
  segundos: string[];
  postre: string | null;
  bebida: string | null;
  publicado: boolean;
}

export interface Estacion {
  id: string;
  nombre: string;
  muestra_kds: boolean;
  impresora_id: string | null;
}

export function etiquetaMesa(mesa: Pick<Mesa, "codigo" | "nombre_visible"> | undefined): string {
  if (!mesa) return "Sin mesa";
  return mesa.nombre_visible ?? `Mesa ${mesa.codigo}`;
}

async function leer<T>(
  consulta: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
): Promise<T> {
  const { data, error } = await consulta;
  if (error) throw aErrorRpc(error);
  return data as T;
}

// Respaldo si Realtime se corta: las vistas operativas se refrescan solas cada 20 s.
const RESPALDO_MS = 20_000;

// ---------------------------------------------------------------------------
// Salón (M1): pisos, mesas y órdenes en curso, en vivo
// ---------------------------------------------------------------------------
export function useSalon(localId: string) {
  useEnVivo(
    localId,
    ["mesas", "ordenes"],
    [
      ["mesas", localId],
      ["ordenes_en_curso", localId],
    ],
  );
  const pisos = useQuery({
    queryKey: ["pisos", localId],
    queryFn: () =>
      leer<Piso[]>(
        supabase()
          .from("pisos")
          .select("id, nombre, orden, ancho_canvas, alto_canvas")
          .eq("local_id", localId)
          .order("orden"),
      ),
    staleTime: 5 * 60_000,
  });
  const mesas = useQuery({
    queryKey: ["mesas", localId],
    refetchInterval: RESPALDO_MS,
    queryFn: () =>
      leer<Mesa[]>(
        supabase()
          .from("mesas")
          .select(
            "id, piso_id, codigo, nombre_visible, tipo, capacidad, pos_x, pos_y, ancho, alto, forma, rotacion, activa, estado",
          )
          .eq("local_id", localId)
          .order("codigo"),
      ),
  });
  const ordenes = useQuery({
    queryKey: ["ordenes_en_curso", localId],
    refetchInterval: RESPALDO_MS,
    queryFn: () =>
      leer<OrdenEnCurso[]>(
        supabase()
          .from("ordenes")
          .select(
            "id, numero_dia, mesa_principal_id, mozo_id, comensales, estado, total, abierta_at, mozo:usuarios_perfil(nombre_visible), mesa_uniones(mesa_id, es_principal, liberada_at)",
          )
          .eq("local_id", localId)
          .in("estado", ["abierta", "precuenta"]),
      ),
  });
  return { pisos, mesas, ordenes };
}

/** Orden en curso de cada mesa (incluye las mesas unidas). */
export function ordenPorMesa(ordenes: readonly OrdenEnCurso[]): Map<string, OrdenEnCurso> {
  const mapa = new Map<string, OrdenEnCurso>();
  for (const o of ordenes) {
    for (const u of o.mesa_uniones) if (!u.liberada_at) mapa.set(u.mesa_id, o);
    if (o.mesa_principal_id && !mapa.has(o.mesa_principal_id)) mapa.set(o.mesa_principal_id, o);
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// Carta (M3, M5)
// ---------------------------------------------------------------------------
export interface Carta {
  categorias: Categoria[];
  productos: Producto[];
  modificadores: Modificador[];
  grupos: GrupoDeProducto[];
  menus: MenuDiario[];
  fecha: string;
  feriadoComoDomingo: boolean;
}

export function useCarta(localId: string) {
  useEnVivo(localId, ["productos"], [["carta", localId]]);
  return useQuery({
    queryKey: ["carta", localId],
    staleTime: 60_000,
    queryFn: async (): Promise<Carta> => {
      const cliente = supabase();
      const { data: local } = await cliente
        .from("locales")
        .select("hora_corte_operativa")
        .eq("id", localId)
        .single();
      const fecha = fechaOperativa(
        new Date(),
        (local?.hora_corte_operativa as string | undefined) ?? "05:00",
      );
      const [categorias, productos, modificadores, grupos, menus, feriados] = await Promise.all([
        leer<Categoria[]>(
          cliente
            .from("categorias")
            .select("id, nombre, orden, estacion_produccion_id_default")
            .eq("local_id", localId)
            .eq("activa", true)
            .order("orden")
            .order("nombre"),
        ),
        leer<Producto[]>(
          cliente
            .from("productos")
            .select(
              "id, categoria_id, codigo, nombre, descripcion, precio, disponible, es_menu_del_dia, estacion_produccion_id, activo, reglas_precio_dia(dia_semana, precio, vigencia_desde, vigencia_hasta)",
            )
            .eq("local_id", localId)
            .eq("activo", true)
            .order("nombre"),
        ),
        leer<Modificador[]>(
          cliente
            .from("modificadores")
            .select("id, grupo, nombre, precio_extra")
            .eq("local_id", localId)
            .eq("activo", true)
            .order("nombre"),
        ),
        leer<GrupoDeProducto[]>(
          cliente
            .from("producto_modificadores")
            .select("producto_id, grupo, obligatorio, min, max")
            .eq("local_id", localId),
        ),
        leer<MenuDiario[]>(
          cliente
            .from("menu_diario")
            .select("producto_id, fecha, entradas, segundos, postre, bebida, publicado")
            .eq("local_id", localId)
            .eq("fecha", fecha),
        ),
        leer<Array<{ se_trata_como_domingo: boolean }>>(
          cliente.from("feriados").select("se_trata_como_domingo").eq("fecha", fecha),
        ),
      ]);
      return {
        categorias,
        productos,
        modificadores,
        grupos,
        menus,
        fecha,
        feriadoComoDomingo: feriados.some((f) => f.se_trata_como_domingo),
      };
    },
  });
}

/** Precio que verá el mozo (el que cobrará el servidor al agregar el ítem). */
export function precioDeHoy(
  producto: Producto,
  carta: Pick<Carta, "fecha" | "feriadoComoDomingo">,
): number {
  return precioVigente(
    Number(producto.precio),
    producto.reglas_precio_dia ?? [],
    carta.fecha,
    carta.feriadoComoDomingo,
  );
}

// ---------------------------------------------------------------------------
// Una orden (M6, M8, M9)
// ---------------------------------------------------------------------------
export interface DetalleOrden {
  orden: Orden;
  items: ItemOrden[];
  comandas: Comanda[];
  anulacionesPendientes: Array<{ id: string; orden_item_id: string | null; nivel: string }>;
}

export function useOrden(localId: string, ordenId: string | null) {
  useEnVivo(localId, ["orden_items", "ordenes", "comandas", "anulaciones"], [["orden", ordenId]]);
  return useQuery({
    queryKey: ["orden", ordenId],
    enabled: Boolean(ordenId),
    refetchInterval: RESPALDO_MS,
    queryFn: async (): Promise<DetalleOrden> => {
      const cliente = supabase();
      const [orden, items, comandas, anulacionesPendientes] = await Promise.all([
        leer<Orden>(
          cliente
            .from("ordenes")
            .select(
              "id, local_id, numero_dia, mesa_principal_id, mozo_id, comensales, estado, subtotal, total, abierta_at, mozo:usuarios_perfil(nombre_visible), mesa_uniones(mesa_id, es_principal, liberada_at)",
            )
            .eq("id", ordenId!)
            .single(),
        ),
        leer<ItemOrden[]>(
          cliente.from("orden_items").select("*").eq("orden_id", ordenId!).order("created_at"),
        ),
        leer<Comanda[]>(
          cliente
            .from("comandas")
            .select("id, numero, estacion_produccion_id, enviada_at, reimpresiones")
            .eq("orden_id", ordenId!)
            .order("numero"),
        ),
        leer<DetalleOrden["anulacionesPendientes"]>(
          cliente
            .from("anulaciones")
            .select("id, orden_item_id, nivel")
            .eq("orden_id", ordenId!)
            .eq("estado", "pendiente"),
        ),
      ]);
      return { orden, items, comandas, anulacionesPendientes };
    },
  });
}

export function useEstaciones(localId: string) {
  return useQuery({
    queryKey: ["estaciones", localId],
    staleTime: 5 * 60_000,
    queryFn: () =>
      leer<Estacion[]>(
        supabase()
          .from("estaciones_produccion")
          .select("id, nombre, muestra_kds, impresora_id")
          .eq("local_id", localId)
          .order("nombre"),
      ),
  });
}

// ---------------------------------------------------------------------------
// KDS (M7)
// ---------------------------------------------------------------------------
export interface ItemKds extends ItemOrden {
  comanda: { numero: number; enviada_at: string } | null;
  orden: {
    numero_dia: number;
    mesa_principal_id: string | null;
    mozo: { nombre_visible: string } | null;
  } | null;
}

export function useKds(localId: string) {
  useEnVivo(localId, ["orden_items", "comandas", "productos"], [["kds", localId]]);
  return useQuery({
    queryKey: ["kds", localId],
    refetchInterval: RESPALDO_MS,
    queryFn: async () => {
      const desde = new Date(Date.now() - 30 * 60_000).toISOString();
      const campos =
        "*, comanda:comandas(numero, enviada_at), orden:ordenes(numero_dia, mesa_principal_id, mozo:usuarios_perfil(nombre_visible))";
      const cliente = supabase();
      const [activos, anulados] = await Promise.all([
        leer<ItemKds[]>(
          cliente
            .from("orden_items")
            .select(campos)
            .eq("local_id", localId)
            .in("estado", ["enviado", "en_preparacion", "listo"])
            .not("comanda_id", "is", null),
        ),
        // Lo anulado en los últimos 30 min se muestra tachado (CU9.2).
        leer<ItemKds[]>(
          cliente
            .from("orden_items")
            .select(campos)
            .eq("local_id", localId)
            .eq("estado", "anulado")
            .not("comanda_id", "is", null)
            .gte("anulado_at", desde),
        ),
      ]);
      return [...activos, ...anulados];
    },
  });
}

export function useConfigKds(localId: string) {
  return useQuery({
    queryKey: ["config_kds", localId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase()
        .from("config_local")
        .select("kds_alerta_amarilla_min, kds_alerta_roja_min")
        .eq("local_id", localId)
        .maybeSingle();
      return {
        amarilla: data?.kds_alerta_amarilla_min ?? 15,
        roja: data?.kds_alerta_roja_min ?? 25,
      };
    },
  });
}

/** Ítems listos de las órdenes del mozo (CU7.2: aviso cuando cocina marca "Listo"). */
export function useListosDelMozo(localId: string, mozoId: string) {
  useEnVivo(localId, ["orden_items"], [["listos", mozoId]]);
  return useQuery({
    queryKey: ["listos", mozoId],
    refetchInterval: RESPALDO_MS,
    queryFn: () =>
      leer<
        Array<
          ItemOrden & {
            orden: {
              id: string;
              numero_dia: number;
              mesa_principal_id: string | null;
              mozo_id: string;
            };
          }
        >
      >(
        supabase()
          .from("orden_items")
          .select("*, orden:ordenes!inner(id, numero_dia, mesa_principal_id, mozo_id)")
          .eq("local_id", localId)
          .eq("estado", "listo")
          .eq("orden.mozo_id", mozoId),
      ),
  });
}
