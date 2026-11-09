"use client";

import type * as React from "react";
import { cn } from "./cn";

export interface Pestana<T extends string> {
  valor: T;
  etiqueta: React.ReactNode;
}

/** Pestañas simples (pisos del salón, estaciones del KDS, secciones del admin). */
export function Tabs<T extends string>({
  pestanas,
  valor,
  alCambiar,
  className,
  etiqueta,
}: {
  pestanas: ReadonlyArray<Pestana<T>>;
  valor: T;
  alCambiar: (valor: T) => void;
  className?: string;
  etiqueta: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={etiqueta}
      className={cn("flex flex-wrap gap-1 rounded-lg bg-muted p-1", className)}
    >
      {pestanas.map((p) => (
        <button
          key={p.valor}
          type="button"
          role="tab"
          aria-selected={p.valor === valor}
          onClick={() => alCambiar(p.valor)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            p.valor === valor
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {p.etiqueta}
        </button>
      ))}
    </div>
  );
}
