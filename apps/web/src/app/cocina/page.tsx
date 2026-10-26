"use client";

import { minutosDesde, nivelAlertaKds, type NivelAlerta } from "@warike/domain";
import {
  Alert,
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Tabs,
} from "@warike/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Encabezado } from "@/components/encabezado";
import { Cargando } from "@/components/pantalla";
import { formatoCantidad, formatoHora } from "@/lib/formato";
import { ConOperador, useOperador } from "@/lib/operador";
import { rpc } from "@/lib/rpc";
import {
  etiquetaMesa,
  useCarta,
  useConfigKds,
  useEstaciones,
  useKds,
  useSalon,
  type ItemKds,
} from "@/lib/salon";
import { pitido } from "@/lib/sonido";
import { useAccion } from "@/lib/use-accion";
import { useAhora } from "@/lib/use-ahora";

export default function PaginaCocina() {
  return (
    <ConOperador permisos={["operar_kds", "ver_listos_kds"]}>
      <Kds />
    </ConOperador>
  );
}

interface Ticket {
  comandaId: string;
  numero: number;
  enviadaAt: string;
  ordenNumero: number;
  mesaId: string | null;
  mozo: string;
  estacionId: string | null;
  items: ItemKds[];
}

const COLOR_ALERTA: Record<NivelAlerta, string> = {
  normal: "border-border",
  amarilla: "border-amber-400 bg-amber-50 dark:bg-amber-950/40",
  roja: "border-red-600 bg-red-50 dark:bg-red-950/40",
};

const SIGUIENTE: Partial<Record<ItemKds["estado"], "en_preparacion" | "listo">> = {
  enviado: "en_preparacion",
  en_preparacion: "listo",
};

function agruparTickets(items: readonly ItemKds[]): Ticket[] {
  const porComanda = new Map<string, Ticket>();
  for (const i of items) {
    if (!i.comanda_id || !i.comanda) continue;
    let t = porComanda.get(i.comanda_id);
    if (!t) {
      t = {
        comandaId: i.comanda_id,
        numero: i.comanda.numero,
        enviadaAt: i.comanda.enviada_at,
        ordenNumero: i.orden?.numero_dia ?? 0,
        mesaId: i.orden?.mesa_principal_id ?? null,
        mozo: i.orden?.mozo?.nombre_visible ?? "",
        estacionId: i.estacion_produccion_id,
        items: [],
      };
      porComanda.set(i.comanda_id, t);
    }
    t.items.push(i);
  }
  for (const t of porComanda.values())
    t.items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return [...porComanda.values()].sort((a, b) => a.enviadaAt.localeCompare(b.enviadaAt));
}

function Kds() {
  const op = useOperador();
  const ahora = useAhora(15_000);
  const kds = useKds(op.localId);
  const estaciones = useEstaciones(op.localId);
  const config = useConfigKds(op.localId);
  const { mesas } = useSalon(op.localId);
  const [estacion, setEstacion] = useState("todas");
  const [sonido, setSonido] = useState(false);
  const [agotados, setAgotados] = useState(false);
  const opera = op.tiene("operar_kds");
  const accion = useAccion([["kds", op.localId]]);

  const mesaPorId = useMemo(() => new Map((mesas.data ?? []).map((m) => [m.id, m])), [mesas.data]);
  const tickets = useMemo(() => agruparTickets(kds.data ?? []), [kds.data]);
  const visibles = tickets.filter((t) => estacion === "todas" || t.estacionId === estacion);
  // Un ticket sigue en preparación mientras tenga algo por hacer; lo anulado no cuenta.
  const enCurso = visibles.filter((t) =>
    t.items.some((i) => i.estado === "enviado" || i.estado === "en_preparacion"),
  );
  const listos = visibles.filter(
    (t) => !enCurso.includes(t) && t.items.some((i) => i.estado === "listo"),
  );

  // Pitido cuando llega una comanda nueva.
  const vistos = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!kds.data) return;
    const ids = new Set(tickets.map((t) => t.comandaId));
    if (vistos.current && sonido && [...ids].some((id) => !vistos.current!.has(id)))
      pitido(660, 300);
    vistos.current = ids;
  }, [tickets, kds.data, sonido]);

  if (kds.isLoading || estaciones.isLoading) return <Cargando />;

  const cambiar = (ids: string[], estado: "en_preparacion" | "listo") =>
    ids.length
      ? void accion.ejecutar(() =>
          rpc("cambiar_estado_items", { p_item_ids: ids, p_estado: estado }),
        )
      : undefined;

  return (
    <div className="min-h-dvh">
      <Encabezado titulo="Cocina">
        <Button
          size="sm"
          variant={sonido ? "default" : "outline"}
          aria-pressed={sonido}
          onClick={() => {
            setSonido((s) => !s);
            pitido(660, 80);
          }}
        >
          Sonido {sonido ? "activado" : "apagado"}
        </Button>
        {opera ? (
          <Button size="sm" variant="outline" onClick={() => setAgotados(true)}>
            Agotados
          </Button>
        ) : null}
      </Encabezado>
      <main className="space-y-4 p-3">
        <Tabs
          etiqueta="Estaciones"
          pestanas={[
            { valor: "todas", etiqueta: "Todas" },
            ...(estaciones.data ?? [])
              .filter((e) => e.muestra_kds)
              .map((e) => ({ valor: e.id, etiqueta: e.nombre })),
          ]}
          valor={estacion}
          alCambiar={setEstacion}
        />
        {kds.isError ? (
          <Alert variant="destructive">Sin conexión: los tickets pueden no estar al día.</Alert>
        ) : null}

        <section aria-label="En preparación">
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            data-testid="tickets-kds"
          >
            {enCurso.map((t) => {
              const minutos = minutosDesde(t.enviadaAt, ahora);
              const nivel = nivelAlertaKds(minutos, config.data?.amarilla, config.data?.roja);
              const pendientes = t.items.filter(
                (i) => i.estado === "enviado" || i.estado === "en_preparacion",
              );
              return (
                <article
                  key={t.comandaId}
                  className={cn(
                    "flex flex-col rounded-lg border-2 bg-card p-3 shadow-sm",
                    COLOR_ALERTA[nivel],
                  )}
                  data-testid="ticket-kds"
                  data-alerta={nivel}
                >
                  <header className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-2xl font-bold">
                        {etiquetaMesa(mesaPorId.get(t.mesaId ?? ""))}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Comanda {t.numero} · Orden {t.ordenNumero} · {t.mozo}
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className={cn(
                          "text-xl font-bold tabular-nums",
                          nivel === "roja" && "text-red-700",
                          nivel === "amarilla" && "text-amber-700",
                        )}
                      >
                        {minutos} min
                      </p>
                      <p className="text-xs text-muted-foreground">{formatoHora(t.enviadaAt)}</p>
                    </div>
                  </header>
                  <ul className="my-3 flex-1 space-y-2">
                    {t.items.map((i) => (
                      <ItemTicket
                        key={i.id}
                        item={i}
                        opera={opera}
                        ocupado={accion.ocupado}
                        alAvanzar={(estado) => cambiar([i.id], estado)}
                      />
                    ))}
                  </ul>
                  {opera ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        variant="outline"
                        disabled={accion.ocupado || !pendientes.some((i) => i.estado === "enviado")}
                        onClick={() =>
                          cambiar(
                            pendientes.filter((i) => i.estado === "enviado").map((i) => i.id),
                            "en_preparacion",
                          )
                        }
                      >
                        En preparación
                      </Button>
                      <Button
                        disabled={accion.ocupado}
                        onClick={() =>
                          cambiar(
                            pendientes.map((i) => i.id),
                            "listo",
                          )
                        }
                      >
                        Listo
                      </Button>
                    </div>
                  ) : null}
                </article>
              );
            })}
            {enCurso.length === 0 ? (
              <p className="text-muted-foreground">Sin comandas pendientes.</p>
            ) : null}
          </div>
        </section>

        {listos.length ? (
          <section aria-label="Listos para servir" className="space-y-2">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">
              Listos para servir
            </h2>
            <div className="flex flex-wrap gap-2">
              {listos.map((t) => (
                <div
                  key={t.comandaId}
                  className="rounded-md border-2 border-emerald-600 bg-card px-3 py-2 text-sm"
                  data-testid="ticket-listo"
                >
                  <strong>{etiquetaMesa(mesaPorId.get(t.mesaId ?? ""))}</strong> · Comanda{" "}
                  {t.numero}:{" "}
                  {t.items
                    .filter((i) => i.estado === "listo")
                    .map((i) => `${formatoCantidad(i.cantidad)} ${i.nombre_snapshot}`)
                    .join(", ")}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </main>
      {opera ? <DialogoAgotados abierto={agotados} alCerrar={() => setAgotados(false)} /> : null}
    </div>
  );
}

function ItemTicket({
  item,
  opera,
  ocupado,
  alAvanzar,
}: {
  item: ItemKds;
  opera: boolean;
  ocupado: boolean;
  alAvanzar: (estado: "en_preparacion" | "listo") => void;
}) {
  const siguiente = SIGUIENTE[item.estado];
  const anulado = item.estado === "anulado";
  return (
    <li data-testid="item-kds" data-estado={item.estado}>
      <button
        type="button"
        disabled={!opera || !siguiente || ocupado}
        onClick={() => siguiente && alAvanzar(siguiente)}
        className={cn(
          "w-full rounded-md px-2 py-1 text-left transition-colors enabled:hover:bg-accent disabled:cursor-default",
          item.estado === "en_preparacion" && "bg-amber-100 dark:bg-amber-900/40",
          item.estado === "listo" && "bg-emerald-100 dark:bg-emerald-900/40",
        )}
      >
        <p
          className={cn("text-lg font-bold leading-tight", anulado && "text-red-700 line-through")}
        >
          {formatoCantidad(item.cantidad)} x {item.nombre_snapshot}
          {anulado ? (
            <Badge variant="destructive" className="ml-2 align-middle no-underline">
              ANULADO
            </Badge>
          ) : null}
        </p>
        {item.modificadores.length ? (
          <p className="text-sm">{item.modificadores.map((m) => m.nombre).join(" · ")}</p>
        ) : null}
        {item.nota ? <p className="text-sm font-bold">* {item.nota}</p> : null}
        {item.cuenta_split > 1 ? (
          <p className="text-xs text-muted-foreground">Cuenta {item.cuenta_split}</p>
        ) : null}
        {item.estado === "en_preparacion" ? (
          <p className="text-xs font-medium text-amber-800">En preparación</p>
        ) : null}
        {item.estado === "listo" ? (
          <p className="text-xs font-medium text-emerald-800">Listo</p>
        ) : null}
      </button>
    </li>
  );
}

/** Cocina marca platos agotados; desaparecen de las tablets al instante (CU3.3, D-027). */
function DialogoAgotados({ abierto, alCerrar }: { abierto: boolean; alCerrar: () => void }) {
  const op = useOperador();
  const carta = useCarta(op.localId);
  const accion = useAccion([["carta", op.localId]]);
  const [busqueda, setBusqueda] = useState("");
  const productos = (carta.data?.productos ?? []).filter((p) =>
    p.nombre.toLowerCase().includes(busqueda.trim().toLowerCase()),
  );
  return (
    <Dialog open={abierto} onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Platos agotados</DialogTitle>
          <DialogDescription>
            Un plato agotado no se puede pedir hasta que se vuelva a habilitar.
          </DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          placeholder="Buscar…"
          aria-label="Buscar plato"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />
        <ul className="max-h-[60dvh] divide-y overflow-y-auto">
          {productos.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-2">
              <span className={cn(!p.disponible && "text-muted-foreground line-through")}>
                {p.nombre}
              </span>
              <Button
                size="sm"
                variant={p.disponible ? "outline" : "default"}
                disabled={accion.ocupado}
                onClick={() =>
                  void accion.ejecutar(() =>
                    rpc("marcar_disponibilidad", {
                      p_producto_id: p.id,
                      p_disponible: !p.disponible,
                    }),
                  )
                }
              >
                {p.disponible ? "Marcar agotado" : "Habilitar"}
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
