"use client";

import { useQuery } from "@tanstack/react-query";
import { fechaOperativa, formatearMoneda } from "@warike/domain";
import { Alert, Badge, Button, Input, Label, Select, Textarea } from "@warike/ui";
import { useState } from "react";
import { PaginaAdmin } from "@/components/admin/pagina-admin";
import { Cargando } from "@/components/pantalla";
import { escribir } from "@/lib/datos";
import { useOperador } from "@/lib/operador";
import { leer, precioDeHoy, useCarta, type MenuDiario } from "@/lib/salon";
import { supabase } from "@/lib/supabase";
import { useAccion } from "@/lib/use-accion";

export default function PaginaMenu() {
  return (
    <PaginaAdmin titulo="Menú del día" permisos={["publicar_menu"]}>
      <Menu />
    </PaginaAdmin>
  );
}

const lineas = (texto: string) =>
  texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Publicar el menú del día (CU5.1): entradas y segundos que el mozo elige al pedirlo. */
function Menu() {
  const op = useOperador();
  const carta = useCarta(op.localId);
  const [fecha, setFecha] = useState(() => fechaOperativa(new Date()));
  const menus = carta.data?.productos.filter((p) => p.es_menu_del_dia) ?? [];
  const [productoId, setProductoId] = useState<string>("");
  const producto = menus.find((p) => p.id === productoId) ?? menus[0];
  const clave = ["menu_diario", op.localId, fecha, producto?.id];
  const actual = useQuery({
    queryKey: clave,
    enabled: Boolean(producto),
    queryFn: async () =>
      (
        await leer<MenuDiario[]>(
          supabase()
            .from("menu_diario")
            .select("producto_id, fecha, entradas, segundos, postre, bebida, publicado")
            .eq("local_id", op.localId)
            .eq("fecha", fecha)
            .eq("producto_id", producto!.id),
        )
      )[0] ?? null,
  });

  if (carta.isLoading) return <Cargando />;
  if (!producto)
    return (
      <Alert>
        No hay productos marcados como "menú del día". Márquelo en Carta y precios → Editar.
      </Alert>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="menu-fecha">Fecha operativa</Label>
          <Input
            id="menu-fecha"
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
          />
        </div>
        {menus.length > 1 ? (
          <div className="space-y-1">
            <Label htmlFor="menu-producto">Producto</Label>
            <Select
              id="menu-producto"
              value={producto.id}
              onChange={(e) => setProductoId(e.target.value)}
            >
              {menus.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nombre}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <p className="pb-2 text-sm text-muted-foreground">
          Precio de {producto.nombre} ese día:{" "}
          <strong>
            {formatearMoneda(precioDeHoy(producto, { fecha, feriadoComoDomingo: false }))}
          </strong>
        </p>
      </div>
      {actual.isLoading ? (
        <Cargando texto="Cargando menú…" />
      ) : (
        <FormularioMenu
          key={`${fecha}:${producto.id}:${actual.data ? "1" : "0"}`}
          fecha={fecha}
          productoId={producto.id}
          menu={actual.data ?? null}
          clave={clave}
        />
      )}
    </div>
  );
}

function FormularioMenu({
  fecha,
  productoId,
  menu,
  clave,
}: {
  fecha: string;
  productoId: string;
  menu: MenuDiario | null;
  clave: unknown[];
}) {
  const op = useOperador();
  const accion = useAccion([clave, ["carta", op.localId]]);
  const [entradas, setEntradas] = useState(menu?.entradas.join("\n") ?? "");
  const [segundos, setSegundos] = useState(menu?.segundos.join("\n") ?? "");
  const [postre, setPostre] = useState(menu?.postre ?? "");
  const [bebida, setBebida] = useState(menu?.bebida ?? "");

  async function guardar(publicado: boolean) {
    const fila = {
      entradas: lineas(entradas),
      segundos: lineas(segundos),
      postre: postre.trim() || null,
      bebida: bebida.trim() || null,
      publicado,
    };
    await accion.ejecutar(
      () =>
        menu
          ? escribir(
              supabase()
                .from("menu_diario")
                .update(fila)
                .eq("local_id", op.localId)
                .eq("fecha", fecha)
                .eq("producto_id", productoId),
            )
          : escribir(
              supabase()
                .from("menu_diario")
                .insert({ ...fila, local_id: op.localId, fecha, producto_id: productoId }),
            ),
      publicado ? "Menú publicado: ya se puede pedir" : "Menú guardado sin publicar",
    );
  }

  const valido = lineas(entradas).length > 0 && lineas(segundos).length > 0;
  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">Menú del {fecha}</h2>
        {menu?.publicado ? (
          <Badge variant="exito">Publicado</Badge>
        ) : (
          <Badge variant="secondary">Sin publicar</Badge>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="menu-entradas">Entradas (una por línea)</Label>
          <Textarea
            id="menu-entradas"
            rows={5}
            value={entradas}
            onChange={(e) => setEntradas(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="menu-segundos">Segundos (uno por línea)</Label>
          <Textarea
            id="menu-segundos"
            rows={5}
            value={segundos}
            onChange={(e) => setSegundos(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="menu-postre">Postre</Label>
          <Input id="menu-postre" value={postre} onChange={(e) => setPostre(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="menu-bebida">Bebida</Label>
          <Input id="menu-bebida" value={bebida} onChange={(e) => setBebida(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!valido || accion.ocupado} onClick={() => void guardar(true)}>
          {menu?.publicado ? "Guardar cambios" : "Publicar"}
        </Button>
        <Button variant="outline" disabled={accion.ocupado} onClick={() => void guardar(false)}>
          {menu?.publicado ? "Despublicar" : "Guardar borrador"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Cambiar las opciones no afecta los menús ya pedidos: cada ítem guarda la entrada y el
        segundo elegidos.
      </p>
    </div>
  );
}
