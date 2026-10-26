"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  Tabs,
} from "@warike/ui";
import { useState } from "react";
import { PaginaAdmin, Tabla } from "@/components/admin/pagina-admin";
import { Cargando } from "@/components/pantalla";
import { escribir } from "@/lib/datos";
import { useEnVivo } from "@/lib/en-vivo";
import { formatoFechaHora } from "@/lib/formato";
import { useOperador } from "@/lib/operador";
import { rpc } from "@/lib/rpc";
import { leer } from "@/lib/salon";
import { supabase } from "@/lib/supabase";
import { useAccion } from "@/lib/use-accion";

export default function PaginaImpresoras() {
  return (
    <PaginaAdmin titulo="Impresoras" permisos={["configurar_local"]}>
      <Impresoras />
    </PaginaAdmin>
  );
}

interface Impresora {
  id: string;
  nombre: string;
  tipo_conexion: "tcp" | "usb";
  host: string | null;
  puerto: number | null;
  ancho_mm: 58 | 80;
  agente_id: string | null;
  estado: string;
}
interface Trabajo {
  id: string;
  tipo: string;
  estado: string;
  intentos: number;
  error: string | null;
  created_at: string;
  impreso_at: string | null;
  impresora_id: string | null;
}

const ESTADO_IMPRESORA: Record<
  string,
  { texto: string; variante: "exito" | "destructive" | "aviso" }
> = {
  ok: { texto: "OK", variante: "exito" },
  sin_papel: { texto: "Sin papel", variante: "aviso" },
  offline: { texto: "Apagada / sin red", variante: "destructive" },
  error: { texto: "Error", variante: "destructive" },
};

function Impresoras() {
  const op = useOperador();
  const clave = ["impresoras_admin", op.localId];
  useEnVivo(op.localId, ["impresoras", "print_jobs"], [clave]);
  const [vista, setVista] = useState<"impresoras" | "trabajos">("impresoras");
  const [filtro, setFiltro] = useState<"problemas" | "todos">("problemas");
  const datos = useQuery({
    queryKey: [...clave, filtro],
    refetchInterval: 20_000,
    queryFn: async () => {
      const c = supabase();
      let trabajos = c
        .from("print_jobs")
        .select("id, tipo, estado, intentos, error, created_at, impreso_at, impresora_id")
        .eq("local_id", op.localId);
      trabajos =
        filtro === "problemas" ? trabajos.in("estado", ["pendiente", "tomado", "error"]) : trabajos;
      const [impresoras, agentes, lista] = await Promise.all([
        leer<Impresora[]>(
          c
            .from("impresoras")
            .select("id, nombre, tipo_conexion, host, puerto, ancho_mm, agente_id, estado")
            .eq("local_id", op.localId)
            .order("nombre"),
        ),
        leer<Array<{ id: string; nombre: string }>>(
          c
            .from("dispositivos")
            .select("id, nombre")
            .eq("local_id", op.localId)
            .eq("tipo", "agente_impresion")
            .eq("activo", true),
        ),
        leer<Trabajo[]>(trabajos.order("created_at", { ascending: false }).limit(100)),
      ]);
      return { impresoras, agentes, trabajos: lista };
    },
  });
  const accion = useAccion([clave]);
  const [editar, setEditar] = useState<Impresora | "nueva" | null>(null);
  const [redirigir, setRedirigir] = useState<Trabajo | null>(null);

  if (datos.isLoading) return <Cargando />;
  if (!datos.data)
    return <Alert variant="destructive">No se pudieron cargar las impresoras.</Alert>;
  const d = datos.data;
  const nombreImpresora = new Map(d.impresoras.map((i) => [i.id, i.nombre]));
  const nombreAgente = new Map(d.agentes.map((a) => [a.id, a.nombre]));

  return (
    <div className="space-y-4">
      <Tabs
        etiqueta="Vista"
        pestanas={[
          { valor: "impresoras", etiqueta: "Impresoras" },
          { valor: "trabajos", etiqueta: "Trabajos de impresión" },
        ]}
        valor={vista}
        alCambiar={setVista}
      />
      {vista === "impresoras" ? (
        <>
          <Button onClick={() => setEditar("nueva")}>Nueva impresora</Button>
          <Tabla
            columnas={["Impresora", "Conexión", "Papel", "Agente", "Estado", ""]}
            vacio={d.impresoras.length === 0}
          >
            {d.impresoras.map((i) => {
              const estado = ESTADO_IMPRESORA[i.estado] ?? ESTADO_IMPRESORA.error!;
              return (
                <tr key={i.id}>
                  <td className="px-3 py-2 font-medium">{i.nombre}</td>
                  <td className="px-3 py-2">
                    {i.tipo_conexion === "tcp"
                      ? `${i.host}:${i.puerto ?? 9100}`
                      : `USB ${i.host ?? "(ruta por defecto)"}`}
                  </td>
                  <td className="px-3 py-2">{i.ancho_mm} mm</td>
                  <td className="px-3 py-2">
                    {i.agente_id
                      ? (nombreAgente.get(i.agente_id) ?? "Agente revocado")
                      : "Sin agente"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={estado.variante}>{estado.texto}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => setEditar(i)}>
                      Editar
                    </Button>
                  </td>
                </tr>
              );
            })}
          </Tabla>
          <p className="text-xs text-muted-foreground">
            Cada estación de producción se asigna a una impresora en Carta y precios → Estaciones.
          </p>
        </>
      ) : (
        <>
          <Select
            className="max-w-xs"
            aria-label="Filtro de trabajos"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value as typeof filtro)}
          >
            <option value="problemas">Pendientes y con error</option>
            <option value="todos">Últimos 100</option>
          </Select>
          <Tabla
            columnas={["Creado", "Tipo", "Impresora", "Estado", "Intentos", "Error", ""]}
            vacio={d.trabajos.length === 0}
          >
            {d.trabajos.map((t) => (
              <tr key={t.id} data-testid="fila-trabajo">
                <td className="px-3 py-2">{formatoFechaHora(t.created_at)}</td>
                <td className="px-3 py-2 capitalize">{t.tipo}</td>
                <td className="px-3 py-2">
                  {t.impresora_id ? nombreImpresora.get(t.impresora_id) : "—"}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant={
                      t.estado === "impreso"
                        ? "exito"
                        : t.estado === "error"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {t.estado}
                  </Badge>
                </td>
                <td className="px-3 py-2">{t.intentos}</td>
                <td className="max-w-xs truncate px-3 py-2 text-xs" title={t.error ?? undefined}>
                  {t.error ?? ""}
                </td>
                <td className="space-x-1 whitespace-nowrap px-3 py-2 text-right">
                  {t.estado !== "impreso" ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={accion.ocupado}
                        onClick={() =>
                          void accion.ejecutar(
                            () => rpc("redirigir_trabajo", { p_job_id: t.id }),
                            "Trabajo reintentado",
                          )
                        }
                      >
                        Reintentar
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setRedirigir(t)}>
                        Redirigir
                      </Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </Tabla>
        </>
      )}
      {editar ? (
        <DialogoImpresora
          key={editar === "nueva" ? "n" : editar.id}
          impresora={editar === "nueva" ? null : editar}
          agentes={d.agentes}
          alCerrar={() => setEditar(null)}
        />
      ) : null}
      {redirigir ? (
        <Dialog open onOpenChange={(a) => !a && setRedirigir(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Redirigir trabajo</DialogTitle>
            </DialogHeader>
            <ul className="space-y-2">
              {d.impresoras
                .filter((i) => i.id !== redirigir.impresora_id)
                .map((i) => (
                  <li key={i.id} className="flex items-center justify-between">
                    <span>
                      {i.nombre}{" "}
                      <Badge
                        variant={(ESTADO_IMPRESORA[i.estado] ?? ESTADO_IMPRESORA.error!).variante}
                      >
                        {(ESTADO_IMPRESORA[i.estado] ?? ESTADO_IMPRESORA.error!).texto}
                      </Badge>
                    </span>
                    <Button
                      size="sm"
                      disabled={accion.ocupado}
                      onClick={async () => {
                        const r = await accion.ejecutar(
                          () =>
                            rpc("redirigir_trabajo", {
                              p_job_id: redirigir.id,
                              p_impresora_id: i.id,
                            }),
                          `Enviado a ${i.nombre}`,
                        );
                        if (r) setRedirigir(null);
                      }}
                    >
                      Enviar aquí
                    </Button>
                  </li>
                ))}
            </ul>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function DialogoImpresora({
  impresora,
  agentes,
  alCerrar,
}: {
  impresora: Impresora | null;
  agentes: Array<{ id: string; nombre: string }>;
  alCerrar: () => void;
}) {
  const op = useOperador();
  const accion = useAccion([
    ["impresoras_admin", op.localId],
    ["carta_admin", op.localId],
  ]);
  const [f, setF] = useState({
    nombre: impresora?.nombre ?? "",
    tipo_conexion: impresora?.tipo_conexion ?? "tcp",
    host: impresora?.host ?? "",
    puerto: impresora?.puerto ?? 9100,
    ancho_mm: impresora?.ancho_mm ?? 80,
    agente_id: impresora?.agente_id ?? agentes[0]?.id ?? "",
  });
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{impresora ? `Editar ${impresora.nombre}` : "Nueva impresora"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const fila = {
              nombre: f.nombre.trim(),
              tipo_conexion: f.tipo_conexion,
              host: f.host.trim() || null,
              puerto: f.tipo_conexion === "tcp" ? f.puerto : null,
              ancho_mm: f.ancho_mm,
              agente_id: f.agente_id || null,
            };
            const ok = await accion.ejecutar(async () => {
              if (impresora)
                await escribir(supabase().from("impresoras").update(fila).eq("id", impresora.id));
              else
                await escribir(
                  supabase()
                    .from("impresoras")
                    .insert({ ...fila, local_id: op.localId }),
                );
              return true;
            }, "Impresora guardada");
            if (ok) alCerrar();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="i-nombre">Nombre</Label>
            <Input
              id="i-nombre"
              required
              maxLength={60}
              value={f.nombre}
              onChange={(e) => setF({ ...f, nombre: e.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="i-conexion">Conexión</Label>
              <Select
                id="i-conexion"
                value={f.tipo_conexion}
                onChange={(e) => setF({ ...f, tipo_conexion: e.target.value as "tcp" | "usb" })}
              >
                <option value="tcp">Red (TCP 9100)</option>
                <option value="usb">USB</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="i-ancho">Papel</Label>
              <Select
                id="i-ancho"
                value={f.ancho_mm}
                onChange={(e) => setF({ ...f, ancho_mm: Number(e.target.value) as 58 | 80 })}
              >
                <option value={80}>80 mm</option>
                <option value={58}>58 mm</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="i-host">
                {f.tipo_conexion === "tcp" ? "Dirección IP" : "Ruta del dispositivo"}
              </Label>
              <Input
                id="i-host"
                required={f.tipo_conexion === "tcp"}
                placeholder={
                  f.tipo_conexion === "tcp"
                    ? "192.168.1.50"
                    : "/dev/usb/lp0 o \\\\localhost\\COCINA"
                }
                value={f.host}
                onChange={(e) => setF({ ...f, host: e.target.value })}
              />
            </div>
            {f.tipo_conexion === "tcp" ? (
              <div className="space-y-1">
                <Label htmlFor="i-puerto">Puerto</Label>
                <Input
                  id="i-puerto"
                  type="number"
                  min={1}
                  max={65535}
                  value={f.puerto}
                  onChange={(e) => setF({ ...f, puerto: Number(e.target.value) })}
                />
              </div>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="i-agente">Agente que la atiende</Label>
            <Select
              id="i-agente"
              value={f.agente_id}
              onChange={(e) => setF({ ...f, agente_id: e.target.value })}
            >
              <option value="">Sin agente</option>
              {agentes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nombre}
                </option>
              ))}
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={accion.ocupado}>
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
