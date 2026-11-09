"use client";

import { useQuery } from "@tanstack/react-query";
import { formatearMoneda } from "@warike/domain";
import { Alert, Button, Card, CardContent } from "@warike/ui";
import { PaginaAdmin } from "@/components/admin/pagina-admin";
import { MOTIVOS_ANULACION } from "@/components/salon/dialogo-anulacion";
import { useEnVivo } from "@/lib/en-vivo";
import { formatoCantidad, formatoHora } from "@/lib/formato";
import { useOperador } from "@/lib/operador";
import { rpc } from "@/lib/rpc";
import { etiquetaMesa, leer } from "@/lib/salon";
import { supabase } from "@/lib/supabase";
import { useAccion } from "@/lib/use-accion";

export default function PaginaAprobaciones() {
  return (
    <PaginaAdmin titulo="Aprobaciones" permisos={["autorizar_anulacion"]}>
      <Aprobaciones />
    </PaginaAdmin>
  );
}

interface Pendiente {
  id: string;
  nivel: "item" | "orden";
  motivo_codigo: string;
  motivo_texto: string | null;
  merma: boolean;
  created_at: string;
  solicitante: { nombre_visible: string } | null;
  item: { nombre_snapshot: string; cantidad: number; total_linea: number; estado: string } | null;
  orden: {
    numero_dia: number;
    total: number;
    mesa: { codigo: string; nombre_visible: string | null } | null;
  } | null;
}

/** Solicitudes de anulación remota (§4.1): el admin las aprueba desde su celular, en vivo. */
function Aprobaciones() {
  const op = useOperador();
  const clave = ["aprobaciones", op.localId];
  useEnVivo(op.localId, ["anulaciones"], [clave]);
  const pendientes = useQuery({
    queryKey: clave,
    refetchInterval: 20_000,
    queryFn: () =>
      leer<Pendiente[]>(
        supabase()
          .from("anulaciones")
          .select(
            "id, nivel, motivo_codigo, motivo_texto, merma, created_at, solicitante:usuarios_perfil!anulaciones_solicitada_por_fkey(nombre_visible), item:orden_items!anulaciones_orden_item_id_local_id_fkey(nombre_snapshot, cantidad, total_linea, estado), orden:ordenes(numero_dia, total, mesa:mesas(codigo, nombre_visible))",
          )
          .eq("local_id", op.localId)
          .eq("estado", "pendiente")
          .order("created_at"),
      ),
  });
  const accion = useAccion([clave]);
  const motivo = (c: string) => MOTIVOS_ANULACION.find((m) => m.valor === c)?.texto ?? c;

  if (pendientes.isError)
    return <Alert variant="destructive">No se pudieron cargar las solicitudes.</Alert>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Las solicitudes llegan en vivo desde las tablets. Aprobar anula el ítem (o la orden) e
        imprime el aviso en cocina.
      </p>
      {(pendientes.data ?? []).map((p) => (
        <Card key={p.id} data-testid="solicitud-anulacion">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <div className="space-y-1">
              <p className="font-semibold">
                {etiquetaMesa(p.orden?.mesa ?? undefined)} · Orden {p.orden?.numero_dia} ·{" "}
                {p.nivel === "orden"
                  ? `Orden completa (${formatearMoneda(Number(p.orden?.total ?? 0))})`
                  : `${formatoCantidad(p.item?.cantidad ?? 0)} x ${p.item?.nombre_snapshot} (${formatearMoneda(Number(p.item?.total_linea ?? 0))})`}
              </p>
              <p className="text-sm">
                Motivo: {motivo(p.motivo_codigo)}
                {p.motivo_texto ? ` — ${p.motivo_texto}` : ""}
                {p.merma ? " · con merma" : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Pide {p.solicitante?.nombre_visible ?? "—"} a las {formatoHora(p.created_at)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={accion.ocupado}
                onClick={() =>
                  void accion.ejecutar(
                    () => rpc("resolver_anulacion", { p_anulacion_id: p.id, p_aprobar: false }),
                    "Solicitud rechazada",
                  )
                }
              >
                Rechazar
              </Button>
              <Button
                variant="destructive"
                disabled={accion.ocupado}
                onClick={() =>
                  void accion.ejecutar(
                    () => rpc("resolver_anulacion", { p_anulacion_id: p.id, p_aprobar: true }),
                    "Anulación aprobada",
                  )
                }
              >
                Aprobar
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      {pendientes.data?.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">No hay solicitudes pendientes.</p>
      ) : null}
    </div>
  );
}
