"use client";

import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNotificar } from "@/components/notificaciones";
import { mensajeDeError } from "./rpc";

/**
 * Ejecuta una acción contra el servidor una sola vez a la vez (sin dobles toques), muestra el error
 * si falla y refresca las consultas indicadas al terminar.
 */
export function useAccion(invalidar: readonly QueryKey[] = []) {
  const consultas = useQueryClient();
  const notificar = useNotificar();
  const [ocupado, setOcupado] = useState(false);
  const enCurso = useRef(false);
  const invalidarRef = useRef(invalidar);
  useEffect(() => {
    invalidarRef.current = invalidar;
  });

  const ejecutar = useCallback(
    async <T>(accion: () => Promise<T>, exito?: string): Promise<T | undefined> => {
      if (enCurso.current) return undefined;
      enCurso.current = true;
      setOcupado(true);
      try {
        const resultado = await accion();
        if (exito) notificar(exito, "exito");
        return resultado;
      } catch (e) {
        notificar(mensajeDeError(e), "error");
        return undefined;
      } finally {
        enCurso.current = false;
        setOcupado(false);
        for (const clave of invalidarRef.current)
          void consultas.invalidateQueries({ queryKey: clave });
      }
    },
    [consultas, notificar],
  );
  return { ejecutar, ocupado };
}
