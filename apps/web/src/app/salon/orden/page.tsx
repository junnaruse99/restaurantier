"use client";

import { formatearMoneda, minutosDesde } from "@warike/domain";
import {
  Alert,
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@warike/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Encabezado } from "@/components/encabezado";
import { Cargando } from "@/components/pantalla";
import { AvisosListos } from "@/components/salon/avisos-listos";
import { SelectorCarta } from "@/components/salon/carta";
import { DialogoAnulacion, type ObjetivoAnulacion } from "@/components/salon/dialogo-anulacion";
import {
  DialogoProducto,
  gruposDelProducto,
  type ItemNuevo,
} from "@/components/salon/dialogo-producto";
import { DialogoTraslado, type TipoTraslado } from "@/components/salon/dialogo-traslado";
import { formatoCantidad, formatoHora } from "@/lib/formato";
import { ConOperador, useOperador } from "@/lib/operador";
import { mutar, rpc } from "@/lib/rpc";
import {
  etiquetaMesa,
  useCarta,
  useEstaciones,
  useOrden,
  useSalon,
  type DetalleOrden,
  type EstadoItem,
  type ItemOrden,
  type Producto,
} from "@/lib/salon";
import { useAccion } from "@/lib/use-accion";
import { useAhora } from "@/lib/use-ahora";

export default function PaginaOrden() {
  return (
    <ConOperador permisos={["tomar_pedido"]}>
      <Suspense fallback={<Cargando />}>
        <PantallaOrden />
      </Suspense>
    </ConOperador>
  );
}

const ESTADO_ITEM: Record<
  EstadoItem,
  {
    texto: string;
    variante: "outline" | "secondary" | "aviso" | "exito" | "default" | "destructive";
  }
> = {
  borrador: { texto: "Por enviar", variante: "outline" },
  enviado: { texto: "Enviado", variante: "secondary" },
  en_preparacion: { texto: "Preparando", variante: "aviso" },
  listo: { texto: "Listo", variante: "exito" },
  servido: { texto: "Servido", variante: "default" },
  anulado: { texto: "Anulado", variante: "destructive" },
};

function PantallaOrden() {
  const ordenId = useSearchParams().get("id");
  const op = useOperador();
  const router = useRouter();
  const ahora = useAhora();
  const detalle = useOrden(op.localId, ordenId);
  const carta = useCarta(op.localId);
  const estaciones = useEstaciones(op.localId);
  const { mesas } = useSalon(op.localId);
  const accion = useAccion([
    ["orden", ordenId],
    ["ordenes_en_curso", op.localId],
    ["mesas", op.localId],
  ]);

  const [producto, setProducto] = useState<Producto | null>(null);
  const [anular, setAnular] = useState<ObjetivoAnulacion | null>(null);
  const [traslado, setTraslado] = useState<TipoTraslado | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string> | null>(null);
  const [reimprimir, setReimprimir] = useState(false);
  const [cancelar, setCancelar] = useState(false);
  const [nota, setNota] = useState<ItemOrden | null>(null);

  const mesaPorId = useMemo(() => new Map((mesas.data ?? []).map((m) => [m.id, m])), [mesas.data]);

  if (!ordenId) return <Alert variant="destructive">Falta la orden.</Alert>;
  if (detalle.isLoading || carta.isLoading) return <Cargando />;
  if (detalle.isError || !detalle.data) {
    return (
      <main className="space-y-3 p-4">
        <Alert variant="destructive">No se encontró la orden.</Alert>
        <Button asChild variant="outline">
          <Link href="/salon">Volver al salón</Link>
        </Button>
      </main>
    );
  }

  const { orden, items, comandas, anulacionesPendientes } = detalle.data;
  const editable = orden.estado === "abierta" || orden.estado === "precuenta";
  const mesa = mesaPorId.get(orden.mesa_principal_id ?? "");
  const unidas = orden.mesa_uniones
    .filter((u) => !u.liberada_at && !u.es_principal)
    .map((u) => mesaPorId.get(u.mesa_id));
  const borradores = items.filter((i) => i.estado === "borrador");
  const enviados = items.filter((i) => i.estado !== "borrador" && i.estado !== "anulado");
  const anulados = items.filter((i) => i.estado === "anulado");
  const pendientes = new Set(anulacionesPendientes.map((a) => a.orden_item_id));
  const ordenPendiente = anulacionesPendientes.some((a) => a.nivel === "orden");
  const nuncaEnviada = items.every((i) => !i.enviado_at);

  async function agregar(item: ItemNuevo) {
    const r = await accion.ejecutar(() =>
      mutar("agregar_items", { p_orden_id: orden.id, p_items: [item] }),
    );
    if (r) setProducto(null);
  }

  function elegirProducto(p: Producto) {
    if (p.es_menu_del_dia || gruposDelProducto(p, carta.data!).length > 0) setProducto(p);
    else
      void agregar({
        producto_id: p.id,
        cantidad: 1,
        modificadores: [],
        nota: null,
        cuenta_split: 1,
      });
  }

  const alternarSeleccion = (id: string) =>
    setSeleccion((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="flex min-h-dvh flex-col">
      <Encabezado titulo={`${etiquetaMesa(mesa)} · Orden ${orden.numero_dia}`}>
        <Button asChild size="sm" variant="ghost">
          <Link href="/salon">← Salón</Link>
        </Button>
      </Encabezado>

      <div className="grid flex-1 gap-4 p-3 lg:grid-cols-[1fr_minmax(360px,440px)]">
        {editable ? (
          <SelectorCarta
            carta={carta.data!}
            alElegir={elegirProducto}
            deshabilitado={accion.ocupado}
          />
        ) : (
          <Alert>Esta orden está {orden.estado}. Ya no admite cambios.</Alert>
        )}

        <section
          className="flex min-h-0 flex-col gap-3 rounded-lg border bg-card p-3"
          aria-label="Pedido"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm text-muted-foreground">
              {orden.comensales} {orden.comensales === 1 ? "comensal" : "comensales"} ·{" "}
              {orden.mozo?.nombre_visible ?? "—"} · {minutosDesde(orden.abierta_at, ahora)} min
              {unidas.length ? (
                <> · Unida: {unidas.map((m) => etiquetaMesa(m)).join(", ")}</>
              ) : null}
            </div>
            <span className="text-2xl font-bold" data-testid="total-orden">
              {formatearMoneda(Number(orden.total))}
            </span>
          </div>
          {ordenPendiente ? (
            <Badge variant="aviso">Anulación de la orden pendiente de aprobación</Badge>
          ) : null}

          <ul className="flex-1 space-y-1 overflow-y-auto" data-testid="items-orden">
            {borradores.length ? (
              <li className="pt-1 text-xs font-semibold uppercase text-muted-foreground">
                Por enviar
              </li>
            ) : null}
            {borradores.map((i) => (
              <FilaItem key={i.id} item={i} seleccion={seleccion} alSeleccionar={alternarSeleccion}>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Menos"
                  disabled={accion.ocupado}
                  onClick={() =>
                    void accion.ejecutar(() =>
                      Number(i.cantidad) <= 1
                        ? mutar("anular_item", { p_item_id: i.id })
                        : rpc("actualizar_item", {
                            p_item_id: i.id,
                            p_cantidad: Number(i.cantidad) - 1,
                          }),
                    )
                  }
                >
                  −
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Más"
                  disabled={accion.ocupado}
                  onClick={() =>
                    void accion.ejecutar(() =>
                      rpc("actualizar_item", {
                        p_item_id: i.id,
                        p_cantidad: Number(i.cantidad) + 1,
                      }),
                    )
                  }
                >
                  +
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNota(i)}>
                  Nota
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={accion.ocupado}
                  onClick={() =>
                    void accion.ejecutar(() => mutar("anular_item", { p_item_id: i.id }))
                  }
                >
                  Quitar
                </Button>
              </FilaItem>
            ))}
            {enviados.length ? (
              <li className="pt-2 text-xs font-semibold uppercase text-muted-foreground">
                En cocina y servidos
              </li>
            ) : null}
            {enviados.map((i) => (
              <FilaItem key={i.id} item={i} seleccion={seleccion} alSeleccionar={alternarSeleccion}>
                {pendientes.has(i.id) ? <Badge variant="aviso">Anulación pendiente</Badge> : null}
                {editable && i.estado !== "servido" ? (
                  <Button
                    size="sm"
                    variant={i.estado === "listo" ? "default" : "outline"}
                    disabled={accion.ocupado}
                    onClick={() =>
                      void accion.ejecutar(() =>
                        rpc("cambiar_estado_items", { p_item_ids: [i.id], p_estado: "servido" }),
                      )
                    }
                  >
                    Servido
                  </Button>
                ) : null}
                {editable && !pendientes.has(i.id) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setAnular({
                        tipo: "item",
                        id: i.id,
                        descripcion: `${formatoCantidad(i.cantidad)} x ${i.nombre_snapshot}`,
                      })
                    }
                  >
                    Anular
                  </Button>
                ) : null}
              </FilaItem>
            ))}
            {anulados.length ? (
              <li>
                <details className="pt-2 text-sm">
                  <summary className="cursor-pointer text-xs font-semibold uppercase text-muted-foreground">
                    Anulados ({anulados.length})
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {anulados.map((i) => (
                      <FilaItem
                        key={i.id}
                        item={i}
                        seleccion={null}
                        alSeleccionar={() => undefined}
                      />
                    ))}
                  </ul>
                </details>
              </li>
            ) : null}
            {items.length === 0 ? (
              <li className="py-6 text-center text-sm text-muted-foreground">
                Agregue platos desde la carta.
              </li>
            ) : null}
          </ul>

          {editable ? (
            <div className="space-y-2 border-t pt-3">
              {seleccion ? (
                <div className="flex flex-wrap items-center gap-2" data-testid="acciones-seleccion">
                  <span className="text-sm">{seleccion.size} seleccionados</span>
                  <Button
                    size="sm"
                    disabled={!seleccion.size}
                    onClick={() => setTraslado("mover_items")}
                  >
                    Mover a otra mesa
                  </Button>
                  {unidas.length ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!seleccion.size}
                      onClick={() => setTraslado("separar")}
                    >
                      Separar con estos ítems
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => setSeleccion(null)}>
                    Cancelar
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setTraslado("mover")}>
                    Mover mesa
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setTraslado("unir")}>
                    Unir mesa
                  </Button>
                  {unidas.length ? (
                    <Button size="sm" variant="outline" onClick={() => setTraslado("separar")}>
                      Separar mesa
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!items.some((i) => i.estado !== "anulado")}
                    onClick={() => setSeleccion(new Set())}
                  >
                    Mover ítems
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!comandas.length}
                    onClick={() => setReimprimir(true)}
                  >
                    Reimprimir
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={ordenPendiente}
                    onClick={() =>
                      nuncaEnviada
                        ? setCancelar(true)
                        : setAnular({
                            tipo: "orden",
                            id: orden.id,
                            descripcion: `Orden ${orden.numero_dia}`,
                          })
                    }
                  >
                    Anular orden
                  </Button>
                </div>
              )}
              <Button
                size="lg"
                className="w-full"
                data-testid="enviar-comanda"
                disabled={!borradores.length || accion.ocupado}
                onClick={() =>
                  void accion.ejecutar(
                    () => mutar("enviar_comanda", { p_orden_id: orden.id }),
                    "Enviado a cocina",
                  )
                }
              >
                Enviar a cocina{borradores.length ? ` (${borradores.length})` : ""}
              </Button>
            </div>
          ) : (
            <Button asChild variant="outline">
              <Link href="/salon">Volver al salón</Link>
            </Button>
          )}
        </section>
      </div>

      {producto ? (
        <DialogoProducto
          key={producto.id}
          producto={producto}
          carta={carta.data!}
          cuentas={Math.min(orden.comensales, 10)}
          ocupado={accion.ocupado}
          alCerrar={() => setProducto(null)}
          alAgregar={(item) => void agregar(item)}
        />
      ) : null}
      <DialogoAnulacion
        key={anular ? `${anular.tipo}:${anular.id}` : "ninguna"}
        objetivo={anular}
        alCerrar={() => setAnular(null)}
        alTerminar={() => {
          const eraOrden = anular?.tipo === "orden";
          setAnular(null);
          void detalle.refetch();
          if (eraOrden) router.push("/salon");
        }}
      />
      {traslado ? (
        <DialogoTraslado
          tipo={traslado}
          orden={orden}
          itemIds={seleccion ? [...seleccion] : []}
          alCerrar={() => setTraslado(null)}
          alTerminar={() => {
            setTraslado(null);
            setSeleccion(null);
            void detalle.refetch();
          }}
        />
      ) : null}
      <DialogoReimprimir
        abierto={reimprimir}
        alCerrar={() => setReimprimir(false)}
        detalle={detalle.data}
        estaciones={estaciones.data ?? []}
      />
      <Dialog open={cancelar} onOpenChange={setCancelar}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar la orden {orden.numero_dia}</DialogTitle>
            <DialogDescription>Nada se envió a cocina: la mesa queda libre.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={accion.ocupado}
              onClick={async () => {
                const r = await accion.ejecutar(
                  () => mutar("anular_orden", { p_orden_id: orden.id }),
                  "Orden cancelada",
                );
                if (r) router.push("/salon");
              }}
            >
              Cancelar orden
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DialogoNota item={nota} alCerrar={() => setNota(null)} />
      <AvisosListos mesas={mesas.data ?? []} />
    </div>
  );
}

function FilaItem({
  item,
  seleccion,
  alSeleccionar,
  children,
}: {
  item: ItemOrden;
  seleccion: Set<string> | null;
  alSeleccionar: (id: string) => void;
  children?: React.ReactNode;
}) {
  const estado = ESTADO_ITEM[item.estado];
  return (
    <li
      className={cn("rounded-md border p-2", item.estado === "anulado" && "opacity-60")}
      data-testid="item-orden"
      data-estado={item.estado}
    >
      <div className="flex items-start gap-2">
        {seleccion && item.estado !== "anulado" ? (
          <input
            type="checkbox"
            className="mt-1 size-5"
            aria-label={`Seleccionar ${item.nombre_snapshot}`}
            checked={seleccion.has(item.id)}
            onChange={() => alSeleccionar(item.id)}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className={cn("font-medium", item.estado === "anulado" && "line-through")}>
            {formatoCantidad(item.cantidad)} x {item.nombre_snapshot}
          </p>
          {item.modificadores.length ? (
            <p className="text-xs text-muted-foreground">
              {item.modificadores.map((m) => m.nombre).join(" · ")}
            </p>
          ) : null}
          {item.nota ? <p className="text-xs font-semibold">* {item.nota}</p> : null}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge variant={estado.variante}>{estado.texto}</Badge>
            {item.cuenta_split > 1 ? (
              <Badge variant="outline">Cuenta {item.cuenta_split}</Badge>
            ) : null}
            {item.enviado_at ? (
              <span className="text-xs text-muted-foreground">{formatoHora(item.enviado_at)}</span>
            ) : null}
          </div>
        </div>
        <span className="text-sm font-medium tabular-nums">
          {formatearMoneda(Number(item.total_linea))}
        </span>
      </div>
      {children ? <div className="mt-2 flex flex-wrap justify-end gap-1">{children}</div> : null}
    </li>
  );
}

function DialogoReimprimir({
  abierto,
  alCerrar,
  detalle,
  estaciones,
}: {
  abierto: boolean;
  alCerrar: () => void;
  detalle: DetalleOrden;
  estaciones: Array<{ id: string; nombre: string; impresora_id: string | null }>;
}) {
  const accion = useAccion([["orden", detalle.orden.id]]);
  const porId = new Map(estaciones.map((e) => [e.id, e]));
  return (
    <Dialog open={abierto} onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reimprimir comanda</DialogTitle>
          <DialogDescription>La reimpresión queda registrada en la auditoría.</DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {detalle.comandas.map((c) => {
            const estacion = porId.get(c.estacion_produccion_id);
            return (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <span>
                  Comanda {c.numero} · {estacion?.nombre ?? "Estación"} ·{" "}
                  {formatoHora(c.enviada_at)}
                  {c.reimpresiones ? ` · ${c.reimpresiones} reimpr.` : ""}
                </span>
                <Button
                  size="sm"
                  disabled={accion.ocupado || !estacion?.impresora_id}
                  onClick={() =>
                    void accion.ejecutar(
                      () => rpc("reimprimir_comanda", { p_comanda_id: c.id }),
                      "Comanda enviada a la impresora",
                    )
                  }
                >
                  {estacion?.impresora_id ? "Reimprimir" : "Solo KDS"}
                </Button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function DialogoNota({ item, alCerrar }: { item: ItemOrden | null; alCerrar: () => void }) {
  const accion = useAccion([["orden", item?.orden_id]]);
  const [texto, setTexto] = useState("");
  const [deItem, setDeItem] = useState<string | null>(null);
  if (item && deItem !== item.id) {
    setDeItem(item.id);
    setTexto(item.nota ?? "");
  }
  return (
    <Dialog open={Boolean(item)} onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nota para cocina</DialogTitle>
          <DialogDescription>{item?.nombre_snapshot}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="nota-editar">Nota</Label>
          <Input
            id="nota-editar"
            maxLength={200}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={accion.ocupado}
            onClick={async () => {
              const r = await accion.ejecutar(() =>
                rpc("actualizar_item", { p_item_id: item!.id, p_nota: texto }),
              );
              if (r) alCerrar();
            }}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
