"use client";

import { useQuery } from "@tanstack/react-query";
import { fechaOperativa, formatearMoneda, sumarMontos } from "@warike/domain";
import { Alert, Badge, Button, Input, Label, Tabs } from "@warike/ui";
import { useState } from "react";
import { descargarCsv, PaginaAdmin, Tabla } from "@/components/admin/pagina-admin";
import { MOTIVOS_ANULACION } from "@/components/salon/dialogo-anulacion";
import { formatoCantidad, formatoFechaHora } from "@/lib/formato";
import { useOperador } from "@/lib/operador";
import { leer } from "@/lib/salon";
import { supabase } from "@/lib/supabase";

export default function PaginaReportes() {
  return (
    <PaginaAdmin titulo="Reportes" permisos={["ver_reportes", "autorizar_anulacion"]}>
      <Reportes />
    </PaginaAdmin>
  );
}

interface FilaAnulacion {
  anulacion_id: string;
  fecha_operativa: string;
  created_at: string;
  nivel: string;
  estado: string;
  orden_numero: number;
  mesa: string | null;
  producto: string | null;
  cantidad: number | null;
  monto: number;
  motivo_codigo: string;
  motivo_texto: string | null;
  merma: boolean;
  mozo: string | null;
  solicitada_por: string | null;
  autorizada_por: string | null;
}

interface FilaVentas {
  fecha_operativa: string;
  mozo_id: string | null;
  mozo: string | null;
  ordenes: number;
  ordenes_pagadas: number;
  total_pagado: number;
  total_en_curso: number;
  comensales: number;
}

const motivo = (c: string) => MOTIVOS_ANULACION.find((m) => m.valor === c)?.texto ?? c;

function Reportes() {
  const op = useOperador();
  const hoy = fechaOperativa(new Date());
  const [desde, setDesde] = useState(hoy);
  const [hasta, setHasta] = useState(hoy);
  const [vista, setVista] = useState<"anulaciones" | "mozos">("anulaciones");

  const anulaciones = useQuery({
    queryKey: ["reporte_anulaciones", op.localId, desde, hasta],
    enabled: vista === "anulaciones",
    queryFn: () =>
      leer<FilaAnulacion[]>(
        supabase()
          .from("reporte_anulaciones")
          .select("*")
          .eq("local_id", op.localId)
          .gte("fecha_operativa", desde)
          .lte("fecha_operativa", hasta)
          .order("created_at", { ascending: false }),
      ),
  });
  const ventas = useQuery({
    queryKey: ["ventas_por_mozo", op.localId, desde, hasta],
    enabled: vista === "mozos",
    queryFn: () =>
      leer<FilaVentas[]>(
        supabase()
          .from("ventas_por_mozo")
          .select("*")
          .eq("local_id", op.localId)
          .gte("fecha_operativa", desde)
          .lte("fecha_operativa", hasta),
      ),
  });

  // Ventas por mozo en el rango ("turno" = fecha operativa hasta definir turnos, DECISIONS P11).
  const porMozo = new Map<string, FilaVentas>();
  for (const v of ventas.data ?? []) {
    const k = v.mozo_id ?? "sin";
    const a = porMozo.get(k);
    porMozo.set(
      k,
      a
        ? {
            ...a,
            ordenes: a.ordenes + v.ordenes,
            ordenes_pagadas: a.ordenes_pagadas + v.ordenes_pagadas,
            total_pagado: sumarMontos([a.total_pagado, Number(v.total_pagado)]),
            total_en_curso: sumarMontos([a.total_en_curso, Number(v.total_en_curso)]),
            comensales: a.comensales + v.comensales,
          }
        : { ...v, total_pagado: Number(v.total_pagado), total_en_curso: Number(v.total_en_curso) },
    );
  }
  const mozos = [...porMozo.values()].sort(
    (a, b) => b.total_pagado + b.total_en_curso - (a.total_pagado + a.total_en_curso),
  );
  const filas = anulaciones.data ?? [];
  const aprobadas = filas.filter((f) => f.estado === "aprobada");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Tabs
          etiqueta="Reporte"
          pestanas={[
            { valor: "anulaciones", etiqueta: "Anulaciones" },
            { valor: "mozos", etiqueta: "Ventas por mozo" },
          ]}
          valor={vista}
          alCambiar={setVista}
        />
        <div className="space-y-1">
          <Label htmlFor="r-desde">Desde</Label>
          <Input
            id="r-desde"
            type="date"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="r-hasta">Hasta</Label>
          <Input
            id="r-hasta"
            type="date"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
          />
        </div>
      </div>

      {vista === "anulaciones" ? (
        <>
          {anulaciones.isError ? (
            <Alert variant="destructive">No se pudo cargar el reporte.</Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              {aprobadas.length} anulaciones aprobadas ·{" "}
              {formatearMoneda(sumarMontos(aprobadas.map((f) => Number(f.monto))))} ·{" "}
              {aprobadas.filter((f) => f.merma).length} con merma
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!filas.length}
              onClick={() =>
                descargarCsv(`anulaciones-${desde}-${hasta}.csv`, [
                  [
                    "Fecha",
                    "Hora",
                    "Orden",
                    "Mesa",
                    "Nivel",
                    "Producto",
                    "Cantidad",
                    "Monto",
                    "Motivo",
                    "Detalle",
                    "Merma",
                    "Mozo",
                    "Pidió",
                    "Autorizó",
                    "Estado",
                  ],
                  ...filas.map((f) => [
                    f.fecha_operativa,
                    formatoFechaHora(f.created_at),
                    f.orden_numero,
                    f.mesa,
                    f.nivel,
                    f.producto,
                    f.cantidad,
                    Number(f.monto).toFixed(2),
                    motivo(f.motivo_codigo),
                    f.motivo_texto,
                    f.merma ? "Sí" : "No",
                    f.mozo,
                    f.solicitada_por,
                    f.autorizada_por,
                    f.estado,
                  ]),
                ])
              }
            >
              Exportar CSV
            </Button>
          </div>
          <Tabla
            columnas={[
              "Hora",
              "Mesa / orden",
              "Qué",
              "Monto",
              "Motivo",
              "Mozo",
              "Autorizó",
              "Estado",
            ]}
            vacio={filas.length === 0}
          >
            {filas.map((f) => (
              <tr key={f.anulacion_id} data-testid="fila-anulacion">
                <td className="whitespace-nowrap px-3 py-2">{formatoFechaHora(f.created_at)}</td>
                <td className="px-3 py-2">
                  {f.mesa} · #{f.orden_numero}
                </td>
                <td className="px-3 py-2">
                  {f.nivel === "orden"
                    ? "Orden completa"
                    : `${formatoCantidad(f.cantidad ?? 0)} x ${f.producto}`}
                </td>
                <td className="px-3 py-2 tabular-nums">{formatearMoneda(Number(f.monto))}</td>
                <td className="px-3 py-2">
                  {motivo(f.motivo_codigo)}
                  {f.motivo_texto ? (
                    <span className="block text-xs text-muted-foreground">{f.motivo_texto}</span>
                  ) : null}
                  {f.merma ? <Badge variant="aviso">merma</Badge> : null}
                </td>
                <td className="px-3 py-2">{f.mozo ?? "—"}</td>
                <td className="px-3 py-2">
                  {f.estado === "pendiente" ? "—" : (f.autorizada_por ?? "—")}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant={
                      f.estado === "aprobada"
                        ? "destructive"
                        : f.estado === "pendiente"
                          ? "aviso"
                          : "secondary"
                    }
                  >
                    {f.estado}
                  </Badge>
                </td>
              </tr>
            ))}
          </Tabla>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Lo pagado se llena con caja (fase 2). "En curso" son las órdenes abiertas o en
            pre-cuenta del rango.
          </p>
          <Tabla
            columnas={["Mozo", "Órdenes", "Comensales", "Pagado", "En curso"]}
            vacio={mozos.length === 0}
          >
            {mozos.map((m) => (
              <tr key={m.mozo_id ?? "sin"}>
                <td className="px-3 py-2 font-medium">{m.mozo ?? "Sin mozo"}</td>
                <td className="px-3 py-2">{m.ordenes}</td>
                <td className="px-3 py-2">{m.comensales}</td>
                <td className="px-3 py-2 tabular-nums">{formatearMoneda(m.total_pagado)}</td>
                <td className="px-3 py-2 tabular-nums">{formatearMoneda(m.total_en_curso)}</td>
              </tr>
            ))}
          </Tabla>
        </>
      )}
    </div>
  );
}
