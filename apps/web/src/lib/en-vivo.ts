"use client";

import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { supabase } from "./supabase";

/**
 * Mantiene al día las consultas con Realtime (M1: ≤ 2 s entre tablets). Ante cualquier cambio en
 * las tablas indicadas del local, invalida las claves dadas; los cambios seguidos se agrupan.
 */
export function useEnVivo(
  localId: string | undefined,
  tablas: readonly string[],
  claves: readonly QueryKey[],
) {
  const consultas = useQueryClient();
  const clavesRef = useRef(claves);
  useEffect(() => {
    clavesRef.current = claves;
  });
  const tablasClave = tablas.join(",");

  useEffect(() => {
    if (!localId) return;
    const cliente = supabase();
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const invalidar = () => {
      clearTimeout(temporizador);
      temporizador = setTimeout(() => {
        for (const clave of clavesRef.current)
          void consultas.invalidateQueries({ queryKey: clave });
      }, 120);
    };
    let canal = cliente.channel(
      `en-vivo:${tablasClave}:${localId}:${Math.random().toString(36).slice(2)}`,
    );
    for (const tabla of tablasClave.split(",")) {
      canal = canal.on(
        "postgres_changes",
        { event: "*", schema: "public", table: tabla, filter: `local_id=eq.${localId}` },
        invalidar,
      );
    }
    // Al reconectar se recarga todo: pudo perderse algún cambio mientras no había conexión.
    canal.subscribe((estado) => {
      if (estado === "SUBSCRIBED") invalidar();
    });
    return () => {
      clearTimeout(temporizador);
      void cliente.removeChannel(canal);
    };
  }, [localId, tablasClave, consultas]);
}
