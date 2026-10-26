"use client";

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tabs,
} from "@warike/ui";
import { useMemo, useState } from "react";
import { useNotificar } from "@/components/notificaciones";
import { useOperador } from "@/lib/operador";
import { mensajeDeError, mutar } from "@/lib/rpc";
import { etiquetaMesa, ordenPorMesa, useSalon, type Mesa, type Orden } from "@/lib/salon";
import { useAhora } from "@/lib/use-ahora";
import { Plano } from "./plano";

export type TipoTraslado = "mover" | "unir" | "separar" | "mover_items";

const TEXTOS: Record<TipoTraslado, { titulo: string; ayuda: string }> = {
  mover: { titulo: "Mover la mesa", ayuda: "Elija una mesa libre. La actual quedará por limpiar." },
  unir: { titulo: "Unir una mesa", ayuda: "Elija una mesa libre para sumarla a esta orden." },
  separar: { titulo: "Separar una mesa", ayuda: "Elija la mesa unida que se separa." },
  mover_items: {
    titulo: "Mover ítems",
    ayuda: "Elija la mesa destino: libre (abre una orden) o con una orden en curso.",
  },
};

/** Cambio de mesa (flujo B): el mozo elige la mesa destino en el plano, de cualquier piso. */
export function DialogoTraslado({
  tipo,
  orden,
  itemIds,
  alCerrar,
  alTerminar,
}: {
  tipo: TipoTraslado | null;
  orden: Orden;
  itemIds: string[];
  alCerrar: () => void;
  alTerminar: () => void;
}) {
  const op = useOperador();
  const notificar = useNotificar();
  const ahora = useAhora();
  const { pisos, mesas, ordenes } = useSalon(op.localId);
  const porMesa = useMemo(() => ordenPorMesa(ordenes.data ?? []), [ordenes.data]);
  const [pisoId, setPisoId] = useState<string | null>(
    () => mesas.data?.find((m) => m.id === orden.mesa_principal_id)?.piso_id ?? null,
  );
  const [destino, setDestino] = useState<Mesa | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const unidas = useMemo(
    () =>
      new Set(
        orden.mesa_uniones.filter((u) => !u.liberada_at && !u.es_principal).map((u) => u.mesa_id),
      ),
    [orden],
  );

  if (!tipo) return null;
  const piso = pisos.data?.find((p) => p.id === pisoId) ?? pisos.data?.[0];

  function habilitada(m: Mesa): boolean {
    switch (tipo) {
      case "mover":
      case "unir":
        return m.estado === "libre";
      case "separar":
        return unidas.has(m.id);
      default: {
        const otra = porMesa.get(m.id);
        return m.estado === "libre" || (otra !== undefined && otra.id !== orden.id);
      }
    }
  }

  async function confirmar() {
    if (!destino || ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      await mutar("trasladar_orden", {
        p_orden_id: orden.id,
        p_tipo: tipo,
        p_mesa_destino_id: destino.id,
        p_item_ids: itemIds.length ? itemIds : null,
      });
      notificar(`${TEXTOS[tipo!].titulo}: ${etiquetaMesa(destino)}`, "exito");
      alTerminar();
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && alCerrar()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{TEXTOS[tipo].titulo}</DialogTitle>
          <DialogDescription>
            {TEXTOS[tipo].ayuda}
            {itemIds.length
              ? ` (${itemIds.length} ${itemIds.length === 1 ? "ítem" : "ítems"})`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {pisos.data && pisos.data.length > 1 ? (
          <Tabs
            etiqueta="Pisos"
            pestanas={pisos.data.map((p) => ({ valor: p.id, etiqueta: p.nombre }))}
            valor={piso?.id ?? ""}
            alCambiar={setPisoId}
          />
        ) : null}
        {piso && mesas.data ? (
          <Plano
            piso={piso}
            mesas={mesas.data}
            ordenes={porMesa}
            ahora={ahora}
            habilitada={habilitada}
            alElegir={setDestino}
            resaltadas={destino ? new Set([destino.id]) : undefined}
          />
        ) : null}
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <DialogFooter>
          <span className="mr-auto self-center text-sm">
            {destino ? (
              <>
                Destino: <strong data-testid="destino-traslado">{etiquetaMesa(destino)}</strong>
              </>
            ) : (
              "Toque la mesa destino"
            )}
          </span>
          <Button variant="outline" onClick={alCerrar}>
            Cancelar
          </Button>
          <Button disabled={!destino || ocupado} onClick={() => void confirmar()}>
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
