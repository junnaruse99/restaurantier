"use client";

import { Button, cn, Select } from "@warike/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useOperador } from "@/lib/operador";

interface Enlace {
  href: string;
  texto: string;
  permisos: string[];
}

const ENLACES: Enlace[] = [
  { href: "/salon", texto: "Salón", permisos: ["tomar_pedido"] },
  { href: "/cocina", texto: "Cocina", permisos: ["operar_kds", "ver_listos_kds"] },
  {
    href: "/admin",
    texto: "Administración",
    permisos: [
      "configurar_local",
      "gestionar_carta",
      "gestionar_usuarios",
      "autorizar_anulacion",
      "ver_reportes",
    ],
  },
];

/** Barra superior de las pantallas operativas: local, persona, navegación y salida. */
export function Encabezado({ titulo, children }: { titulo: string; children?: ReactNode }) {
  const op = useOperador();
  const ruta = usePathname();
  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Warike POS</p>
        <h1 className="truncate text-lg font-semibold" data-testid="titulo-pantalla">
          {titulo}
        </h1>
      </div>
      <nav className="flex flex-wrap gap-1" aria-label="Secciones">
        {ENLACES.filter((e) => op.tiene(...e.permisos)).map((e) => (
          <Link
            key={e.href}
            href={e.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent",
              ruta === e.href || ruta.startsWith(`${e.href}/`)
                ? "bg-accent"
                : "text-muted-foreground",
            )}
          >
            {e.texto}
          </Link>
        ))}
      </nav>
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        {children}
        {op.locales.length > 1 ? (
          <Select
            aria-label="Local"
            className="h-9 w-auto"
            value={op.localId}
            onChange={(e) => op.cambiarLocal(e.target.value)}
          >
            {op.locales.map((l) => (
              <option key={l.local_id} value={l.local_id}>
                {l.nombre}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-sm text-muted-foreground">{op.localNombre}</span>
        )}
        <span className="text-sm font-medium" data-testid="operador">
          {op.nombre}
        </span>
        <Button size="sm" variant="outline" onClick={() => void op.salir()}>
          Salir
        </Button>
      </div>
    </header>
  );
}
