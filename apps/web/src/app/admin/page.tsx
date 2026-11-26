"use client";

import { useQuery } from "@tanstack/react-query";
import { formatearMoneda } from "@warike/domain";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@warike/ui";
import Link from "next/link";
import { PaginaAdmin } from "@/components/admin/pagina-admin";
import { useEnVivo } from "@/lib/en-vivo";
import { useOperador } from "@/lib/operador";
import { supabase } from "@/lib/supabase";
import { useAhora } from "@/lib/use-ahora";

export default function PaginaResumenAdmin() {
  return (
    <PaginaAdmin
      titulo="Administración"
      permisos={[
        "configurar_local",
        "gestionar_carta",
        "gestionar_usuarios",
        "autorizar_anulacion",
        "ver_reportes",
      ]}
    >
      <Resumen />
    </PaginaAdmin>
  );
}

function Resumen() {
  const op = useOperador();
  const clave = ["resumen_admin", op.localId];
  useEnVivo(op.localId, ["anulaciones", "ordenes", "impresoras", "print_jobs"], [clave]);
  const datos = useQuery({
    queryKey: clave,
    refetchInterval: 30_000,
    queryFn: async () => {
      const cliente = supabase();
      const contar = async (q: PromiseLike<{ count: number | null }>) => (await q).count ?? 0;
      const [aprobaciones, ordenes, impresoras, trabajosError, agentes] = await Promise.all([
        op.tiene("autorizar_anulacion")
          ? contar(
              cliente
                .from("anulaciones")
                .select("id", { count: "exact", head: true })
                .eq("local_id", op.localId)
                .eq("estado", "pendiente"),
            )
          : 0,
        cliente
          .from("ordenes")
          .select("total")
          .eq("local_id", op.localId)
          .in("estado", ["abierta", "precuenta"]),
        cliente
          .from("impresoras")
          .select("nombre, estado")
          .eq("local_id", op.localId)
          .neq("estado", "ok"),
        op.tiene("configurar_local")
          ? contar(
              cliente
                .from("print_jobs")
                .select("id", { count: "exact", head: true })
                .eq("local_id", op.localId)
                .eq("estado", "error"),
            )
          : 0,
        op.tiene("configurar_local")
          ? cliente
              .from("dispositivos")
              .select("nombre, ultimo_ping")
              .eq("local_id", op.localId)
              .eq("tipo", "agente_impresion")
              .eq("activo", true)
          : { data: [] },
      ]);
      return {
        aprobaciones,
        ordenes: ordenes.data?.length ?? 0,
        enCurso: (ordenes.data ?? []).reduce((t, o) => t + Number(o.total), 0),
        impresoras: (impresoras.data ?? []) as Array<{ nombre: string; estado: string }>,
        trabajosError,
        agentes: (agentes.data ?? []) as Array<{ nombre: string; ultimo_ping: string | null }>,
      };
    },
  });
  const d = datos.data;
  const ahora = useAhora();
  // §14.1: alerta si el agente lleva más de 2 min sin latido.
  const agentesCaidos = (d?.agentes ?? []).filter(
    (a) => !a.ultimo_ping || ahora.getTime() - Date.parse(a.ultimo_ping) > 120_000,
  );

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {op.tiene("autorizar_anulacion") ? (
        <Tarjeta
          titulo="Aprobaciones pendientes"
          href="/admin/aprobaciones"
          valor={String(d?.aprobaciones ?? "…")}
          alerta={Boolean(d?.aprobaciones)}
        />
      ) : null}
      <Tarjeta
        titulo="Mesas en curso"
        href="/salon"
        valor={String(d?.ordenes ?? "…")}
        detalle={d ? `${formatearMoneda(d.enCurso)} por cobrar` : undefined}
      />
      {op.tiene("configurar_local") ? (
        <Card>
          <CardHeader>
            <CardTitle>Impresión</CardTitle>
            <CardDescription>
              <Link href="/admin/impresoras" className="underline">
                Ver impresoras y trabajos
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {d && d.impresoras.length === 0 && agentesCaidos.length === 0 && !d.trabajosError ? (
              <Badge variant="exito">Todo en orden</Badge>
            ) : null}
            {d?.impresoras.map((i) => (
              <Badge key={i.nombre} variant="destructive">
                {i.nombre}: {i.estado.replace("_", " ")}
              </Badge>
            ))}
            {d?.trabajosError ? (
              <Badge variant="destructive">{d.trabajosError} trabajos en error</Badge>
            ) : null}
            {agentesCaidos.map((a) => (
              <Badge key={a.nombre} variant="aviso">
                {a.nombre} sin conexión
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Tarjeta({
  titulo,
  valor,
  href,
  detalle,
  alerta,
}: {
  titulo: string;
  valor: string;
  href: string;
  detalle?: string;
  alerta?: boolean;
}) {
  return (
    <Link href={href}>
      <Card className={alerta ? "border-2 border-amber-500" : undefined}>
        <CardHeader>
          <CardDescription>{titulo}</CardDescription>
          <CardTitle className="text-3xl">{valor}</CardTitle>
        </CardHeader>
        {detalle ? (
          <CardContent className="text-sm text-muted-foreground">{detalle}</CardContent>
        ) : null}
      </Card>
    </Link>
  );
}
