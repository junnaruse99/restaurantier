"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Notificaciones } from "@/components/notificaciones";
import { supabase } from "@/lib/supabase";

export function Providers({ children }: { children: ReactNode }) {
  const [clienteConsultas] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  // Tablets compartidas: al cerrar sesión no debe quedar en caché nada del usuario anterior.
  useEffect(() => {
    const { data } = supabase().auth.onAuthStateChange((evento) => {
      if (evento === "SIGNED_OUT") clienteConsultas.clear();
    });
    return () => data.subscription.unsubscribe();
  }, [clienteConsultas]);

  return (
    <QueryClientProvider client={clienteConsultas}>
      <Notificaciones>{children}</Notificaciones>
    </QueryClientProvider>
  );
}
