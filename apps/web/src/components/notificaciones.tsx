"use client";

import { cn } from "@warike/ui";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Tipo = "exito" | "error" | "info";

interface Notificacion {
  id: number;
  texto: string;
  tipo: Tipo;
}

interface Api {
  notificar: (texto: string, tipo?: Tipo) => void;
}

const Contexto = createContext<Api>({ notificar: () => undefined });

export function useNotificar() {
  return useContext(Contexto).notificar;
}

/** Mensajes breves de resultado (se cierran solos a los 4 s; los errores a los 7 s). */
export function Notificaciones({ children }: { children: ReactNode }) {
  const [lista, setLista] = useState<Notificacion[]>([]);
  const siguiente = useRef(1);
  const notificar = useCallback((texto: string, tipo: Tipo = "info") => {
    const id = siguiente.current++;
    setLista((l) => [...l.slice(-3), { id, texto, tipo }]);
    setTimeout(
      () => setLista((l) => l.filter((n) => n.id !== id)),
      tipo === "error" ? 7_000 : 4_000,
    );
  }, []);
  const api = useMemo(() => ({ notificar }), [notificar]);
  return (
    <Contexto.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 left-4 z-[60] flex max-w-sm flex-col gap-2"
        aria-live="polite"
      >
        {lista.map((n) => (
          <div
            key={n.id}
            role={n.tipo === "error" ? "alert" : "status"}
            data-testid="notificacion"
            className={cn(
              "pointer-events-auto rounded-md px-4 py-3 text-sm shadow-lg",
              n.tipo === "error" && "bg-destructive text-destructive-foreground",
              n.tipo === "exito" && "bg-emerald-600 text-white",
              n.tipo === "info" && "bg-foreground text-background",
            )}
          >
            {n.texto}
          </div>
        ))}
      </div>
    </Contexto.Provider>
  );
}
