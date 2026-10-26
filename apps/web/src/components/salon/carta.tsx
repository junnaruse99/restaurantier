"use client";

import { formatearMoneda } from "@warike/domain";
import { cn, Input, Tabs } from "@warike/ui";
import { useMemo, useState } from "react";
import { precioDeHoy, type Carta, type Producto } from "@/lib/salon";

/** Selector de productos por categoría o búsqueda (CU6.2). Los agotados aparecen deshabilitados. */
export function SelectorCarta({
  carta,
  alElegir,
  deshabilitado,
}: {
  carta: Carta;
  alElegir: (p: Producto) => void;
  deshabilitado?: boolean;
}) {
  const [categoria, setCategoria] = useState<string>("todas");
  const [busqueda, setBusqueda] = useState("");
  const conProductos = useMemo(
    () => carta.categorias.filter((c) => carta.productos.some((p) => p.categoria_id === c.id)),
    [carta],
  );
  const texto = normalizar(busqueda.trim());
  const visibles = carta.productos.filter((p) =>
    texto
      ? normalizar(p.nombre).includes(texto) || normalizar(p.codigo ?? "") === texto
      : categoria === "todas" || p.categoria_id === categoria,
  );

  return (
    <section className="flex min-h-0 flex-col gap-3" aria-label="Carta">
      <Input
        type="search"
        placeholder="Buscar plato o código…"
        aria-label="Buscar en la carta"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
      />
      {texto ? null : (
        <Tabs
          etiqueta="Categorías"
          pestanas={[
            { valor: "todas", etiqueta: "Todas" },
            ...conProductos.map((c) => ({ valor: c.id, etiqueta: c.nombre })),
          ]}
          valor={categoria}
          alCambiar={setCategoria}
        />
      )}
      <div className="grid grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
        {visibles.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={deshabilitado || !p.disponible}
            onClick={() => alElegir(p)}
            data-testid={`producto-${p.codigo ?? p.id}`}
            className={cn(
              "flex min-h-20 flex-col justify-between rounded-md border bg-card p-2 text-left shadow-sm transition-colors hover:bg-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <span className="text-sm font-medium leading-tight">{p.nombre}</span>
            <span className="flex items-end justify-between gap-1 text-xs text-muted-foreground">
              <span>{p.disponible ? formatearMoneda(precioDeHoy(p, carta)) : "Agotado"}</span>
              {p.codigo ? <span>{p.codigo}</span> : null}
            </span>
          </button>
        ))}
        {visibles.length === 0 ? (
          <p className="col-span-full text-sm text-muted-foreground">Sin resultados.</p>
        ) : null}
      </div>
    </section>
  );
}

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
