"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  Alert,
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
import dynamic from "next/dynamic";
import { useState } from "react";
import { PaginaAdmin } from "@/components/admin/pagina-admin";
import type { CambioMesa } from "@/components/admin/editor-plano";
import { useNotificar } from "@/components/notificaciones";
import { Cargando } from "@/components/pantalla";
import { useOperador } from "@/lib/operador";
import { escribir } from "@/lib/datos";
import { aErrorRpc, mensajeDeError } from "@/lib/rpc";
import { useSalon, type Mesa } from "@/lib/salon";
import { supabase } from "@/lib/supabase";
import { useAccion } from "@/lib/use-accion";

// Konva necesita el navegador (canvas): el editor no se renderiza en el servidor.
const EditorPlano = dynamic(() => import("@/components/admin/editor-plano"), {
  ssr: false,
  loading: () => <p className="text-sm text-muted-foreground">Cargando editor…</p>,
});

export default function PaginaPlano() {
  return (
    <PaginaAdmin titulo="Plano de mesas" permisos={["configurar_local"]}>
      <Plano />
    </PaginaAdmin>
  );
}

const TIPOS: Array<{ valor: string; texto: string }> = [
  { valor: "mesa", texto: "Mesa" },
  { valor: "barra", texto: "Barra" },
  { valor: "auxiliar", texto: "Auxiliar" },
  { valor: "virtual_delivery", texto: "Virtual · Delivery" },
  { valor: "virtual_llevar", texto: "Virtual · Para llevar" },
  { valor: "virtual_personal", texto: "Virtual · Personal" },
  { valor: "virtual_auditor", texto: "Virtual · Auditor" },
];

function Plano() {
  const op = useOperador();
  const consultas = useQueryClient();
  const notificar = useNotificar();
  const { pisos, mesas } = useSalon(op.localId);
  const [pisoId, setPisoId] = useState<string | null>(null);
  const [seleccionada, setSeleccionada] = useState<string | null>(null);
  const [dialogoPiso, setDialogoPiso] = useState<"nuevo" | "editar" | null>(null);
  const accion = useAccion([
    ["mesas", op.localId],
    ["pisos", op.localId],
  ]);

  if (pisos.isLoading || mesas.isLoading) return <Cargando />;
  const piso = pisos.data?.find((p) => p.id === pisoId) ?? pisos.data?.[0];
  const mesa = mesas.data?.find((m) => m.id === seleccionada);

  async function cambiar(id: string, cambio: CambioMesa) {
    // Se refleja al instante; si falla, se vuelve a leer del servidor.
    consultas.setQueryData<Mesa[]>(["mesas", op.localId], (lista) =>
      lista?.map((m) => (m.id === id ? { ...m, ...cambio } : m)),
    );
    try {
      await escribir(supabase().from("mesas").update(cambio).eq("id", id));
    } catch (e) {
      notificar(mensajeDeError(e), "error");
      void consultas.invalidateQueries({ queryKey: ["mesas", op.localId] });
    }
  }

  async function nuevaMesa() {
    if (!piso) return;
    const numeros = (mesas.data ?? []).map((m) => Number(m.codigo)).filter(Number.isFinite);
    const codigo = String((numeros.length ? Math.max(...numeros) : 0) + 1);
    await accion.ejecutar(async () => {
      const { data, error } = await supabase()
        .from("mesas")
        .insert({
          local_id: op.localId,
          piso_id: piso.id,
          codigo,
          pos_x: 20,
          pos_y: 20,
          ancho: 80,
          alto: 80,
          capacidad: 4,
        })
        .select("id")
        .single();
      if (error) throw aErrorRpc(error);
      setSeleccionada(data.id as string);
    }, `Mesa ${codigo} creada`);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {pisos.data?.length ? (
          <Tabs
            etiqueta="Pisos"
            pestanas={pisos.data.map((p) => ({ valor: p.id, etiqueta: p.nombre }))}
            valor={piso?.id ?? ""}
            alCambiar={(id) => {
              setPisoId(id);
              setSeleccionada(null);
            }}
          />
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setDialogoPiso("nuevo")}>
          Nuevo piso
        </Button>
        {piso ? (
          <Button size="sm" variant="outline" onClick={() => setDialogoPiso("editar")}>
            Editar piso
          </Button>
        ) : null}
        <Button size="sm" disabled={!piso || accion.ocupado} onClick={() => void nuevaMesa()}>
          Nueva mesa
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Arrastre las mesas para ubicarlas. Toque una para cambiar su tamaño, rotarla o editar sus
        datos. Los cambios se guardan al soltar.
      </p>
      {piso ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <EditorPlano
            piso={piso}
            mesas={mesas.data ?? []}
            seleccionada={seleccionada}
            alSeleccionar={setSeleccionada}
            alCambiar={(id, c) => void cambiar(id, c)}
          />
          {mesa ? (
            <FormularioMesa key={mesa.id} mesa={mesa} pisos={pisos.data ?? []} />
          ) : (
            <Alert>Seleccione una mesa para editarla.</Alert>
          )}
        </div>
      ) : (
        <Alert>Cree el primer piso para empezar.</Alert>
      )}
      {dialogoPiso ? (
        <DialogoPiso
          key={dialogoPiso}
          modo={dialogoPiso}
          piso={dialogoPiso === "editar" ? piso : undefined}
          orden={(pisos.data?.length ?? 0) + 1}
          alCerrar={() => setDialogoPiso(null)}
        />
      ) : null}
    </div>
  );
}

function FormularioMesa({
  mesa,
  pisos,
}: {
  mesa: Mesa;
  pisos: Array<{ id: string; nombre: string }>;
}) {
  const op = useOperador();
  const accion = useAccion([["mesas", op.localId]]);
  const [datos, setDatos] = useState({
    codigo: mesa.codigo,
    nombre_visible: mesa.nombre_visible ?? "",
    tipo: mesa.tipo,
    capacidad: mesa.capacidad,
    forma: mesa.forma,
    ancho: mesa.ancho,
    alto: mesa.alto,
    rotacion: Number(mesa.rotacion),
    piso_id: mesa.piso_id,
  });
  const campo = <K extends keyof typeof datos>(k: K, v: (typeof datos)[K]) =>
    setDatos((d) => ({ ...d, [k]: v }));
  const ocupada = mesa.estado !== "libre" && mesa.estado !== "bloqueada";

  return (
    <form
      className="space-y-3 rounded-lg border bg-card p-4"
      aria-label={`Mesa ${mesa.codigo}`}
      onSubmit={(e) => {
        e.preventDefault();
        void accion.ejecutar(
          () =>
            escribir(
              supabase()
                .from("mesas")
                .update({ ...datos, nombre_visible: datos.nombre_visible.trim() || null })
                .eq("id", mesa.id),
            ),
          "Mesa guardada",
        );
      }}
    >
      <h2 className="font-semibold">Mesa {mesa.codigo}</h2>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="mesa-codigo">Código</Label>
          <Input
            id="mesa-codigo"
            required
            maxLength={20}
            value={datos.codigo}
            onChange={(e) => campo("codigo", e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="mesa-capacidad">Capacidad</Label>
          <Input
            id="mesa-capacidad"
            type="number"
            min={0}
            max={99}
            value={datos.capacidad}
            onChange={(e) => campo("capacidad", Number(e.target.value))}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="mesa-nombre">Nombre visible (opcional)</Label>
        <Input
          id="mesa-nombre"
          maxLength={40}
          placeholder={`Mesa ${datos.codigo}`}
          value={datos.nombre_visible}
          onChange={(e) => campo("nombre_visible", e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="mesa-tipo">Tipo</Label>
          <Select id="mesa-tipo" value={datos.tipo} onChange={(e) => campo("tipo", e.target.value)}>
            {TIPOS.map((t) => (
              <option key={t.valor} value={t.valor}>
                {t.texto}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="mesa-forma">Forma</Label>
          <Select
            id="mesa-forma"
            value={datos.forma}
            onChange={(e) => campo("forma", e.target.value as Mesa["forma"])}
          >
            <option value="rect">Rectangular</option>
            <option value="circle">Redonda</option>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label htmlFor="mesa-ancho">Ancho</Label>
          <Input
            id="mesa-ancho"
            type="number"
            min={30}
            max={600}
            value={datos.ancho}
            onChange={(e) => campo("ancho", Number(e.target.value))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="mesa-alto">Alto</Label>
          <Input
            id="mesa-alto"
            type="number"
            min={30}
            max={600}
            value={datos.alto}
            onChange={(e) => campo("alto", Number(e.target.value))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="mesa-rotacion">Rotación</Label>
          <Input
            id="mesa-rotacion"
            type="number"
            min={-360}
            max={360}
            value={datos.rotacion}
            onChange={(e) => campo("rotacion", Number(e.target.value))}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="mesa-piso">Piso</Label>
        <Select
          id="mesa-piso"
          value={datos.piso_id}
          onChange={(e) => campo("piso_id", e.target.value)}
        >
          {pisos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nombre}
            </option>
          ))}
        </Select>
      </div>
      {datos.tipo.startsWith("virtual") ? (
        <p className="text-xs text-muted-foreground">
          Las mesas virtuales se usan con delivery, para llevar, personal y auditor (fases
          siguientes).
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={accion.ocupado}>
          Guardar
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={accion.ocupado || (mesa.activa && ocupada)}
          title={
            mesa.activa && ocupada ? "No se desactiva una mesa con una orden en curso" : undefined
          }
          onClick={() =>
            void accion.ejecutar(
              () =>
                escribir(
                  supabase().from("mesas").update({ activa: !mesa.activa }).eq("id", mesa.id),
                ),
              mesa.activa ? "Mesa desactivada" : "Mesa activada",
            )
          }
        >
          {mesa.activa ? "Desactivar" : "Activar"}
        </Button>
      </div>
    </form>
  );
}

function DialogoPiso({
  modo,
  piso,
  orden,
  alCerrar,
}: {
  modo: "nuevo" | "editar";
  piso?: { id: string; nombre: string; ancho_canvas: number; alto_canvas: number };
  orden: number;
  alCerrar: () => void;
}) {
  const op = useOperador();
  const accion = useAccion([["pisos", op.localId]]);
  const [nombre, setNombre] = useState(piso?.nombre ?? `Piso ${orden}`);
  const [ancho, setAncho] = useState(piso?.ancho_canvas ?? 1000);
  const [alto, setAlto] = useState(piso?.alto_canvas ?? 800);
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{modo === "nuevo" ? "Nuevo piso" : `Editar ${piso?.nombre}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="piso-nombre">Nombre</Label>
          <Input id="piso-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="piso-ancho">Ancho del lienzo</Label>
            <Input
              id="piso-ancho"
              type="number"
              min={400}
              max={4000}
              value={ancho}
              onChange={(e) => setAncho(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="piso-alto">Alto del lienzo</Label>
            <Input
              id="piso-alto"
              type="number"
              min={300}
              max={4000}
              value={alto}
              onChange={(e) => setAlto(Number(e.target.value))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={accion.ocupado || !nombre.trim()}
            onClick={async () => {
              const r = await accion.ejecutar(async () => {
                await (modo === "nuevo"
                  ? escribir(
                      supabase().from("pisos").insert({
                        local_id: op.localId,
                        nombre: nombre.trim(),
                        orden,
                        ancho_canvas: ancho,
                        alto_canvas: alto,
                      }),
                    )
                  : escribir(
                      supabase()
                        .from("pisos")
                        .update({ nombre: nombre.trim(), ancho_canvas: ancho, alto_canvas: alto })
                        .eq("id", piso!.id),
                    ));
                return true;
              }, "Piso guardado");
              if (r) alCerrar();
            }}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
