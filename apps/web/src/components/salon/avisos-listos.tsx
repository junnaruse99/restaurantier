"use client";

import { Button } from "@warike/ui";
import { useEffect, useRef } from "react";
import { useOperador } from "@/lib/operador";
import { rpc } from "@/lib/rpc";
import { etiquetaMesa, useListosDelMozo, type Mesa } from "@/lib/salon";
import { useAccion } from "@/lib/use-accion";
import { formatoCantidad } from "@/lib/formato";
import { pitido } from "@/lib/sonido";

/** Aviso al mozo cuando cocina marca "Listo" (CU7.2), con el botón para marcar servido. */
export function AvisosListos({ mesas }: { mesas: readonly Mesa[] }) {
  const op = useOperador();
  const listos = useListosDelMozo(op.localId, op.userId);
  const accion = useAccion([["listos", op.userId], ["orden"]]);
  const cantidad = listos.data?.length ?? 0;
  const anterior = useRef(cantidad);

  useEffect(() => {
    if (cantidad > anterior.current) {
      pitido();
      navigator.vibrate?.(200);
    }
    anterior.current = cantidad;
  }, [cantidad]);

  if (!cantidad) return null;
  const porMesa = new Map(mesas.map((m) => [m.id, m]));
  return (
    <aside
      className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] space-y-2 rounded-lg border-2 border-emerald-600 bg-card p-3 shadow-xl"
      aria-label="Platos listos"
      data-testid="avisos-listos"
    >
      <p className="font-semibold text-emerald-700">Listos para servir ({cantidad})</p>
      <ul className="max-h-72 space-y-2 overflow-y-auto">
        {listos.data!.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
            <span>
              <strong>{etiquetaMesa(porMesa.get(i.orden.mesa_principal_id ?? ""))}</strong> ·{" "}
              {formatoCantidad(i.cantidad)} x {i.nombre_snapshot}
            </span>
            <Button
              size="sm"
              disabled={accion.ocupado}
              onClick={() =>
                void accion.ejecutar(() =>
                  rpc("cambiar_estado_items", { p_item_ids: [i.id], p_estado: "servido" }),
                )
              }
            >
              Servido
            </Button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
