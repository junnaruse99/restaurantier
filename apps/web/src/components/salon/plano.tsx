"use client";

import { formatearMoneda, minutosDesde } from "@warike/domain";
import { cn } from "@warike/ui";
import {
  etiquetaMesa,
  type EstadoMesa,
  type Mesa,
  type OrdenEnCurso,
  type Piso,
} from "@/lib/salon";

/** Colores por estado (CU1.3). */
export const COLOR_ESTADO: Record<EstadoMesa, string> = {
  libre: "bg-emerald-500 text-white border-emerald-700",
  ocupada: "bg-red-600 text-white border-red-800",
  precuenta: "bg-amber-400 text-black border-amber-600",
  por_limpiar: "bg-zinc-400 text-black border-zinc-500",
  bloqueada: "bg-zinc-900 text-white border-black",
};

export const NOMBRE_ESTADO: Record<EstadoMesa, string> = {
  libre: "Libre",
  ocupada: "Ocupada",
  precuenta: "Pre-cuenta",
  por_limpiar: "Por limpiar",
  bloqueada: "Bloqueada",
};

export function Leyenda() {
  return (
    <ul className="flex flex-wrap gap-3 text-xs" aria-label="Estados de mesa">
      {(Object.keys(NOMBRE_ESTADO) as EstadoMesa[]).map((e) => (
        <li key={e} className="flex items-center gap-1.5">
          <span className={cn("inline-block size-3 rounded-sm border", COLOR_ESTADO[e])} />
          {NOMBRE_ESTADO[e]}
        </li>
      ))}
    </ul>
  );
}

/**
 * Plano de un piso: cada mesa en su posición del lienzo, escalada al ancho disponible. Muestra el
 * estado por color y, si tiene orden, los minutos desde la apertura, el mozo y el total.
 */
export function Plano({
  piso,
  mesas,
  ordenes,
  ahora,
  alElegir,
  habilitada = () => true,
  resaltadas,
  altoMaximo,
}: {
  piso: Piso;
  mesas: readonly Mesa[];
  ordenes: ReadonlyMap<string, OrdenEnCurso>;
  ahora: Date;
  alElegir: (mesa: Mesa) => void;
  habilitada?: (mesa: Mesa) => boolean;
  resaltadas?: ReadonlySet<string>;
  /** Alto máximo (CSS) dentro de un diálogo: el ancho se ajusta para conservar la proporción. */
  altoMaximo?: string;
}) {
  const visibles = mesas.filter(
    (m) => m.piso_id === piso.id && m.activa && !m.tipo.startsWith("virtual"),
  );
  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-lg border bg-muted/40"
      style={{
        aspectRatio: `${piso.ancho_canvas} / ${piso.alto_canvas}`,
        maxWidth: altoMaximo
          ? `calc(${altoMaximo} * ${piso.ancho_canvas / piso.alto_canvas})`
          : undefined,
      }}
      data-testid={`plano-${piso.nombre}`}
    >
      {visibles.map((m) => {
        const orden = ordenes.get(m.id);
        const esPrincipal = orden ? orden.mesa_principal_id === m.id : false;
        const activa = habilitada(m);
        return (
          <button
            key={m.id}
            type="button"
            disabled={!activa}
            onClick={() => alElegir(m)}
            data-testid={`mesa-${m.codigo}`}
            data-estado={m.estado}
            aria-label={`${etiquetaMesa(m)}, ${NOMBRE_ESTADO[m.estado]}`}
            className={cn(
              "absolute flex flex-col items-center justify-center overflow-hidden border-2 p-0.5 text-center leading-tight shadow-sm transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-35",
              m.forma === "circle" ? "rounded-full" : "rounded-md",
              COLOR_ESTADO[m.estado],
              resaltadas?.has(m.id) && "ring-4 ring-sky-500 ring-offset-1",
            )}
            style={{
              left: `${(m.pos_x / piso.ancho_canvas) * 100}%`,
              top: `${(m.pos_y / piso.alto_canvas) * 100}%`,
              width: `${(m.ancho / piso.ancho_canvas) * 100}%`,
              height: `${(m.alto / piso.alto_canvas) * 100}%`,
              transform: m.rotacion ? `rotate(${m.rotacion}deg)` : undefined,
              containerType: "size",
            }}
          >
            <span className="text-[clamp(0.8rem,32cqmin,1.6rem)] font-bold">
              {m.codigo}
            </span>
            {orden ? (
              <span className="text-[clamp(0.5rem,13cqmin,0.8rem)]">
                {esPrincipal ? (
                  <>
                    {minutosDesde(orden.abierta_at, ahora)} min
                    <br />
                    {orden.mozo?.nombre_visible.split(" ")[0] ?? ""}
                    <br />
                    {formatearMoneda(Number(orden.total))}
                  </>
                ) : (
                  <>Unida · #{orden.numero_dia}</>
                )}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
