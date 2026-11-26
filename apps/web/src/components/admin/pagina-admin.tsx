"use client";

import { cn } from "@warike/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Encabezado } from "@/components/encabezado";
import { ConOperador, useOperador } from "@/lib/operador";

const SECCIONES: Array<{ href: string; texto: string; permisos: string[] }> = [
  {
    href: "/admin",
    texto: "Resumen",
    permisos: [
      "configurar_local",
      "gestionar_carta",
      "gestionar_usuarios",
      "autorizar_anulacion",
      "ver_reportes",
    ],
  },
  { href: "/admin/aprobaciones", texto: "Aprobaciones", permisos: ["autorizar_anulacion"] },
  { href: "/admin/plano", texto: "Plano", permisos: ["configurar_local"] },
  {
    href: "/admin/carta",
    texto: "Carta y precios",
    permisos: ["gestionar_carta", "modificar_precios"],
  },
  { href: "/admin/menu", texto: "Menú del día", permisos: ["publicar_menu"] },
  { href: "/admin/usuarios", texto: "Usuarios y planilla", permisos: ["gestionar_usuarios"] },
  { href: "/admin/dispositivos", texto: "Dispositivos", permisos: ["configurar_local"] },
  { href: "/admin/impresoras", texto: "Impresoras", permisos: ["configurar_local"] },
  { href: "/admin/reportes", texto: "Reportes", permisos: ["ver_reportes", "autorizar_anulacion"] },
];

/** Marco de las pantallas de administración: exige alguno de los permisos y muestra las secciones. */
export function PaginaAdmin({
  titulo,
  permisos,
  children,
}: {
  titulo: string;
  permisos: string[];
  children: ReactNode;
}) {
  return (
    <ConOperador permisos={permisos}>
      <Marco titulo={titulo}>{children}</Marco>
    </ConOperador>
  );
}

function Marco({ titulo, children }: { titulo: string; children: ReactNode }) {
  const op = useOperador();
  const ruta = usePathname();
  return (
    <div className="min-h-dvh">
      <Encabezado titulo={titulo} />
      <nav className="flex gap-1 overflow-x-auto border-b px-4 py-2" aria-label="Administración">
        {SECCIONES.filter((s) => op.tiene(...s.permisos)).map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className={cn(
              "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent",
              ruta === s.href ? "bg-accent" : "text-muted-foreground",
            )}
          >
            {s.texto}
          </Link>
        ))}
      </nav>
      <main className="mx-auto max-w-7xl space-y-4 p-4">{children}</main>
    </div>
  );
}

/** Tabla simple con el estilo del sistema. */
export function Tabla({
  columnas,
  children,
  vacio,
}: {
  columnas: string[];
  children: ReactNode;
  vacio?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-left">
          <tr>
            {columnas.map((c) => (
              <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
      {vacio ? (
        <p className="p-4 text-center text-sm text-muted-foreground">Sin registros.</p>
      ) : null}
    </div>
  );
}

/** Descarga un CSV que Excel abre con tildes (BOM UTF-8 y punto y coma). */
export function descargarCsv(
  nombre: string,
  filas: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
) {
  const celda = (v: string | number | null | undefined) => {
    const t = v === null || v === undefined ? "" : String(v);
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const texto = "﻿" + filas.map((f) => f.map(celda).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}
