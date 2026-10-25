"use client";

import type { Session } from "@supabase/supabase-js";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

/** Respuesta de la RPC public.mi_contexto(). */
export interface ContextoSesion {
  user_id: string;
  perfil: { nombre_visible: string; codigo_empleado: string | null; activo: boolean } | null;
  aal: "aal1" | "aal2" | null;
  sesion_pin: { dispositivo_id: string; local_id: string; expira_at: string } | null;
  requiere_mfa: boolean;
  locales: Array<{ local_id: string; nombre: string; roles: string[]; permisos: string[] }>;
}

/** Sesión actual de Supabase Auth; `undefined` mientras carga. */
export function useSesion(): Session | null | undefined {
  const [sesion, setSesion] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    const cliente = supabase();
    void cliente.auth.getSession().then(({ data }) => setSesion(data.session));
    const { data } = cliente.auth.onAuthStateChange((_evento, nueva) => setSesion(nueva));
    return () => data.subscription.unsubscribe();
  }, []);
  return sesion;
}

/** Contexto de la sesión; la clave incluye el usuario para no mostrar el de quien usó antes la tablet. */
export function useContexto(userId: string | undefined) {
  return useQuery({
    queryKey: ["mi_contexto", userId],
    enabled: Boolean(userId),
    queryFn: async (): Promise<ContextoSesion> => {
      const { data, error } = await supabase().rpc("mi_contexto");
      if (error) throw error;
      return data as ContextoSesion;
    },
  });
}

export function usePermisos() {
  return useQuery({
    queryKey: ["permissions"],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("permissions")
        .select("codigo, descripcion, modulo");
      if (error) throw error;
      return new Map(data.map((p) => [p.codigo as string, p.descripcion as string]));
    },
  });
}
