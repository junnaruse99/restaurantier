"use client";

import {
  formatearMoneda,
  totalLinea,
  validarModificadores,
  type GrupoModificador,
  type ModificadorElegido,
} from "@warike/domain";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@warike/ui";
import { useMemo, useState } from "react";
import { precioDeHoy, type Carta, type Producto } from "@/lib/salon";

export interface ItemNuevo {
  producto_id: string;
  cantidad: number;
  modificadores: ModificadorElegido[];
  nota: string | null;
  cuenta_split: number;
}

/** Grupos de modificadores del producto; en el menú del día, entrada y segundo salen del menú publicado. */
export function gruposDelProducto(producto: Producto, carta: Carta): GrupoModificador[] {
  const menu = carta.menus.find((m) => m.producto_id === producto.id && m.publicado);
  return carta.grupos
    .filter((g) => g.producto_id === producto.id)
    .sort((a, b) => a.grupo.localeCompare(b.grupo))
    .map((g) => {
      const delMenu = producto.es_menu_del_dia && (g.grupo === "Entrada" || g.grupo === "Segundo");
      const opciones = delMenu
        ? ((g.grupo === "Entrada" ? menu?.entradas : menu?.segundos) ?? []).map((nombre) => ({
            nombre,
            precioExtra: 0,
          }))
        : carta.modificadores
            .filter((m) => m.grupo === g.grupo)
            .map((m) => ({ nombre: m.nombre, precioExtra: Number(m.precio_extra) }));
      return { grupo: g.grupo, min: g.min, max: g.max, opciones };
    });
}

export function DialogoProducto({
  producto,
  carta,
  cuentas,
  alCerrar,
  alAgregar,
  ocupado,
}: {
  producto: Producto | null;
  carta: Carta;
  cuentas: number;
  alCerrar: () => void;
  alAgregar: (item: ItemNuevo) => void;
  ocupado: boolean;
}) {
  const [elegidos, setElegidos] = useState<ModificadorElegido[]>([]);
  const [cantidad, setCantidad] = useState(1);
  const [nota, setNota] = useState("");
  const [cuenta, setCuenta] = useState(1);
  const [intento, setIntento] = useState(false);

  const grupos = useMemo(
    () => (producto ? gruposDelProducto(producto, carta) : []),
    [producto, carta],
  );
  if (!producto) return null;
  const sinMenu =
    producto.es_menu_del_dia &&
    !carta.menus.some((m) => m.producto_id === producto.id && m.publicado);
  const validacion = validarModificadores(producto.nombre, grupos, elegidos);
  const precio = precioDeHoy(producto, carta) + validacion.recargo;

  function alternar(grupo: GrupoModificador, nombre: string) {
    setElegidos((actual) => {
      const ya = actual.some((e) => e.grupo === grupo.grupo && e.nombre === nombre);
      if (ya) return actual.filter((e) => !(e.grupo === grupo.grupo && e.nombre === nombre));
      const delGrupo = actual.filter((e) => e.grupo === grupo.grupo);
      // Con una sola opción permitida, elegir otra la reemplaza.
      const base = grupo.max === 1 ? actual.filter((e) => e.grupo !== grupo.grupo) : actual;
      if (grupo.max > 1 && delGrupo.length >= grupo.max) return actual;
      return [...base, { grupo: grupo.grupo, nombre }];
    });
  }

  function agregar() {
    setIntento(true);
    if (validacion.errores.length || sinMenu) return;
    alAgregar({
      producto_id: producto!.id,
      cantidad,
      modificadores: elegidos,
      nota: nota.trim() || null,
      cuenta_split: cuenta,
    });
  }

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && alCerrar()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{producto.nombre}</DialogTitle>
          <DialogDescription>{formatearMoneda(precio)} c/u</DialogDescription>
        </DialogHeader>
        {sinMenu ? (
          <Alert variant="destructive">El menú de hoy aún no está publicado.</Alert>
        ) : null}
        {grupos.map((g) => (
          <fieldset key={g.grupo} className="space-y-2">
            <legend className="text-sm font-medium">
              {g.grupo}{" "}
              <span className="font-normal text-muted-foreground">
                {g.min === g.max
                  ? `(elija ${g.min})`
                  : g.min > 0
                    ? `(${g.min} a ${g.max})`
                    : `(opcional, hasta ${g.max})`}
              </span>
            </legend>
            <div className="flex flex-wrap gap-2">
              {g.opciones.map((o) => {
                const activo = elegidos.some((e) => e.grupo === g.grupo && e.nombre === o.nombre);
                return (
                  <Button
                    key={o.nombre}
                    type="button"
                    variant={activo ? "default" : "outline"}
                    aria-pressed={activo}
                    onClick={() => alternar(g, o.nombre)}
                  >
                    {o.nombre}
                    {o.precioExtra ? ` +${formatearMoneda(o.precioExtra)}` : ""}
                  </Button>
                );
              })}
              {g.opciones.length === 0 ? (
                <span className="text-sm text-muted-foreground">Sin opciones</span>
              ) : null}
            </div>
          </fieldset>
        ))}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Cantidad</Label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                aria-label="Menos"
                onClick={() => setCantidad((c) => Math.max(1, c - 1))}
              >
                −
              </Button>
              <span className="w-10 text-center text-xl font-semibold" data-testid="cantidad">
                {cantidad}
              </span>
              <Button
                variant="outline"
                aria-label="Más"
                onClick={() => setCantidad((c) => Math.min(99, c + 1))}
              >
                +
              </Button>
            </div>
          </div>
          {cuentas > 1 ? (
            <div className="space-y-2">
              <Label>Cuenta</Label>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: cuentas }, (_, i) => i + 1).map((n) => (
                  <Button
                    key={n}
                    size="sm"
                    variant={n === cuenta ? "default" : "outline"}
                    onClick={() => setCuenta(n)}
                  >
                    {n}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="nota-item">Nota para cocina</Label>
          <Input
            id="nota-item"
            maxLength={200}
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Sin cebolla, bien cocido…"
          />
        </div>
        {intento && validacion.errores.length ? (
          <Alert variant="destructive">
            <ul className="list-disc pl-4">
              {validacion.errores.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button size="lg" className="w-full" disabled={ocupado || sinMenu} onClick={agregar}>
            Agregar · {formatearMoneda(totalLinea(precio, cantidad))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
