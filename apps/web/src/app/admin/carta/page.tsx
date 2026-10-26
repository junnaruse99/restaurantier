"use client";

import { useQuery } from "@tanstack/react-query";
import { formatearMoneda } from "@warike/domain";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  Tabs,
  Textarea,
} from "@warike/ui";
import { useState, type FormEvent } from "react";
import { PaginaAdmin, Tabla } from "@/components/admin/pagina-admin";
import { Cargando } from "@/components/pantalla";
import { escribir } from "@/lib/datos";
import { useEnVivo } from "@/lib/en-vivo";
import { formatoFechaHora } from "@/lib/formato";
import { useOperador } from "@/lib/operador";
import { rpc } from "@/lib/rpc";
import { leer, type GrupoDeProducto, type Producto } from "@/lib/salon";
import { supabase } from "@/lib/supabase";
import { useAccion } from "@/lib/use-accion";

export default function PaginaCarta() {
  return (
    <PaginaAdmin titulo="Carta y precios" permisos={["gestionar_carta", "modificar_precios"]}>
      <Carta />
    </PaginaAdmin>
  );
}

interface CategoriaAdmin {
  id: string;
  nombre: string;
  orden: number;
  estacion_produccion_id_default: string | null;
  activa: boolean;
}
interface ModificadorAdmin {
  id: string;
  grupo: string;
  nombre: string;
  precio_extra: number;
  activo: boolean;
}
interface EstacionAdmin {
  id: string;
  nombre: string;
  impresora_id: string | null;
  muestra_kds: boolean;
}
interface ProductoAdmin extends Producto {
  aplica_icbper: boolean;
}

function useCartaAdmin(localId: string) {
  const clave = ["carta_admin", localId];
  useEnVivo(localId, ["productos"], [clave]);
  return useQuery({
    queryKey: clave,
    queryFn: async () => {
      const c = supabase();
      const [categorias, productos, modificadores, grupos, estaciones, impresoras] =
        await Promise.all([
          leer<CategoriaAdmin[]>(
            c
              .from("categorias")
              .select("id, nombre, orden, estacion_produccion_id_default, activa")
              .eq("local_id", localId)
              .order("orden")
              .order("nombre"),
          ),
          leer<ProductoAdmin[]>(
            c
              .from("productos")
              .select(
                "id, categoria_id, codigo, nombre, descripcion, precio, disponible, es_menu_del_dia, estacion_produccion_id, activo, aplica_icbper, reglas_precio_dia(dia_semana, precio, vigencia_desde, vigencia_hasta)",
              )
              .eq("local_id", localId)
              .order("nombre"),
          ),
          leer<ModificadorAdmin[]>(
            c
              .from("modificadores")
              .select("id, grupo, nombre, precio_extra, activo")
              .eq("local_id", localId)
              .order("grupo")
              .order("nombre"),
          ),
          leer<Array<GrupoDeProducto & { id: string }>>(
            c
              .from("producto_modificadores")
              .select("id, producto_id, grupo, obligatorio, min, max")
              .eq("local_id", localId),
          ),
          leer<EstacionAdmin[]>(
            c
              .from("estaciones_produccion")
              .select("id, nombre, impresora_id, muestra_kds")
              .eq("local_id", localId)
              .order("nombre"),
          ),
          leer<Array<{ id: string; nombre: string }>>(
            c.from("impresoras").select("id, nombre").eq("local_id", localId).order("nombre"),
          ),
        ]);
      return { categorias, productos, modificadores, grupos, estaciones, impresoras };
    },
  });
}

type Seccion = "productos" | "categorias" | "modificadores" | "estaciones";

function Carta() {
  const op = useOperador();
  const datos = useCartaAdmin(op.localId);
  const [seccion, setSeccion] = useState<Seccion>("productos");
  if (datos.isLoading) return <Cargando />;
  if (datos.isError || !datos.data)
    return <Alert variant="destructive">No se pudo cargar la carta.</Alert>;
  const pestanas: Array<{ valor: Seccion; etiqueta: string }> = [
    { valor: "productos", etiqueta: "Productos" },
    { valor: "categorias", etiqueta: "Categorías" },
    { valor: "modificadores", etiqueta: "Modificadores" },
  ];
  if (op.tiene("configurar_local")) pestanas.push({ valor: "estaciones", etiqueta: "Estaciones" });
  return (
    <div className="space-y-4">
      <Tabs
        etiqueta="Secciones de la carta"
        pestanas={pestanas}
        valor={seccion}
        alCambiar={setSeccion}
      />
      {seccion === "productos" ? <Productos d={datos.data} /> : null}
      {seccion === "categorias" ? <Categorias d={datos.data} /> : null}
      {seccion === "modificadores" ? <Modificadores d={datos.data} /> : null}
      {seccion === "estaciones" ? <Estaciones d={datos.data} /> : null}
    </div>
  );
}

type Datos = NonNullable<ReturnType<typeof useCartaAdmin>["data"]>;
const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------
function Productos({ d }: { d: Datos }) {
  const op = useOperador();
  const accion = useAccion([
    ["carta_admin", op.localId],
    ["carta", op.localId],
  ]);
  const [busqueda, setBusqueda] = useState("");
  const [categoria, setCategoria] = useState("");
  const [editar, setEditar] = useState<ProductoAdmin | "nuevo" | null>(null);
  const [precio, setPrecio] = useState<ProductoAdmin | null>(null);
  const [historial, setHistorial] = useState<ProductoAdmin | null>(null);
  const [masivo, setMasivo] = useState(false);
  const nombreCategoria = new Map(d.categorias.map((c) => [c.id, c.nombre]));
  const texto = busqueda.trim().toLowerCase();
  const visibles = d.productos.filter(
    (p) =>
      (!categoria || p.categoria_id === categoria) &&
      (!texto ||
        p.nombre.toLowerCase().includes(texto) ||
        (p.codigo ?? "").toLowerCase() === texto),
  );
  const gestiona = op.tiene("gestionar_carta");
  const precios = op.tiene("modificar_precios");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          type="search"
          placeholder="Buscar…"
          aria-label="Buscar producto"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />
        <Select
          className="max-w-xs"
          aria-label="Categoría"
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
        >
          <option value="">Todas las categorías</option>
          {d.categorias.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {precios ? (
          <Button variant="outline" onClick={() => setMasivo(true)}>
            Cambio masivo de precios
          </Button>
        ) : null}
        {gestiona ? <Button onClick={() => setEditar("nuevo")}>Nuevo producto</Button> : null}
      </div>
      <Tabla
        columnas={["Producto", "Categoría", "Precio", "Estado", ""]}
        vacio={visibles.length === 0}
      >
        {visibles.map((p) => {
          const reglas = (p.reglas_precio_dia ?? []).filter((r) => !r.vigencia_hasta);
          return (
            <tr
              key={p.id}
              className={p.activo ? undefined : "opacity-50"}
              data-testid="fila-producto"
            >
              <td className="px-3 py-2">
                <p className="font-medium">{p.nombre}</p>
                <p className="text-xs text-muted-foreground">
                  {p.codigo ?? "sin código"}
                  {p.es_menu_del_dia ? " · menú del día" : ""}
                </p>
              </td>
              <td className="px-3 py-2">{nombreCategoria.get(p.categoria_id)}</td>
              <td className="px-3 py-2 tabular-nums">
                {formatearMoneda(Number(p.precio))}
                {reglas.length ? (
                  <p className="text-xs text-muted-foreground">
                    Por día:{" "}
                    {reglas
                      .sort((a, b) => a.dia_semana - b.dia_semana)
                      .map((r) => `${DIAS[r.dia_semana]} ${Number(r.precio)}`)
                      .join(" · ")}
                  </p>
                ) : null}
              </td>
              <td className="space-x-1 px-3 py-2">
                {!p.activo ? (
                  <Badge variant="secondary">Inactivo</Badge>
                ) : p.disponible ? (
                  <Badge variant="exito">Disponible</Badge>
                ) : (
                  <Badge variant="destructive">Agotado</Badge>
                )}
              </td>
              <td className="space-x-1 whitespace-nowrap px-3 py-2 text-right">
                {gestiona && p.activo ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={accion.ocupado}
                    onClick={() =>
                      void accion.ejecutar(() =>
                        rpc("marcar_disponibilidad", {
                          p_producto_id: p.id,
                          p_disponible: !p.disponible,
                        }),
                      )
                    }
                  >
                    {p.disponible ? "Agotar" : "Habilitar"}
                  </Button>
                ) : null}
                {precios ? (
                  <Button size="sm" variant="ghost" onClick={() => setPrecio(p)}>
                    Precio
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setHistorial(p)}>
                  Historial
                </Button>
                {gestiona ? (
                  <Button size="sm" variant="outline" onClick={() => setEditar(p)}>
                    Editar
                  </Button>
                ) : null}
              </td>
            </tr>
          );
        })}
      </Tabla>
      {editar ? (
        <DialogoProducto
          key={editar === "nuevo" ? "nuevo" : editar.id}
          d={d}
          producto={editar === "nuevo" ? null : editar}
          alCerrar={() => setEditar(null)}
        />
      ) : null}
      {precio ? (
        <DialogoPrecio key={precio.id} producto={precio} alCerrar={() => setPrecio(null)} />
      ) : null}
      {historial ? (
        <DialogoHistorial producto={historial} alCerrar={() => setHistorial(null)} />
      ) : null}
      {masivo ? <DialogoMasivo d={d} alCerrar={() => setMasivo(false)} /> : null}
    </div>
  );
}

function DialogoProducto({
  d,
  producto,
  alCerrar,
}: {
  d: Datos;
  producto: ProductoAdmin | null;
  alCerrar: () => void;
}) {
  const op = useOperador();
  const accion = useAccion([
    ["carta_admin", op.localId],
    ["carta", op.localId],
  ]);
  const [f, setF] = useState({
    nombre: producto?.nombre ?? "",
    codigo: producto?.codigo ?? "",
    descripcion: producto?.descripcion ?? "",
    categoria_id: producto?.categoria_id ?? d.categorias.find((c) => c.activa)?.id ?? "",
    estacion_produccion_id: producto?.estacion_produccion_id ?? "",
    es_menu_del_dia: producto?.es_menu_del_dia ?? false,
    aplica_icbper: producto?.aplica_icbper ?? false,
    activo: producto?.activo ?? true,
    precio: "",
  });
  const campo = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) =>
    setF((x) => ({ ...x, [k]: v }));
  const grupos = producto ? d.grupos.filter((g) => g.producto_id === producto.id) : [];
  const gruposDisponibles = [
    ...new Set([
      ...d.modificadores.map((m) => m.grupo),
      ...(f.es_menu_del_dia ? ["Entrada", "Segundo"] : []),
    ]),
  ].filter((g) => !grupos.some((x) => x.grupo === g));
  const [nuevoGrupo, setNuevoGrupo] = useState({ grupo: "", min: 0, max: 1 });

  async function guardar(e: FormEvent) {
    e.preventDefault();
    const fila = {
      nombre: f.nombre.trim(),
      codigo: f.codigo.trim() || null,
      descripcion: f.descripcion.trim() || null,
      categoria_id: f.categoria_id,
      estacion_produccion_id: f.estacion_produccion_id || null,
      es_menu_del_dia: f.es_menu_del_dia,
      aplica_icbper: f.aplica_icbper,
      activo: f.activo,
    };
    const ok = await accion.ejecutar(
      async () => {
        if (producto)
          await escribir(supabase().from("productos").update(fila).eq("id", producto.id));
        else
          await escribir(
            supabase()
              .from("productos")
              .insert({
                ...fila,
                local_id: op.localId,
                precio: Number(f.precio.replace(",", ".")),
              }),
          );
        return true;
      },
      producto ? "Producto guardado" : "Producto creado",
    );
    if (ok) alCerrar();
  }

  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{producto ? `Editar ${producto.nombre}` : "Nuevo producto"}</DialogTitle>
          {producto ? (
            <DialogDescription>
              El precio se cambia con "Precio", que pide el motivo y deja historial.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => void guardar(e)}>
          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <div className="space-y-1">
              <Label htmlFor="p-nombre">Nombre</Label>
              <Input
                id="p-nombre"
                required
                maxLength={120}
                value={f.nombre}
                onChange={(e) => campo("nombre", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-codigo">Código</Label>
              <Input
                id="p-codigo"
                maxLength={20}
                value={f.codigo}
                onChange={(e) => campo("codigo", e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="p-descripcion">Descripción</Label>
            <Textarea
              id="p-descripcion"
              maxLength={300}
              value={f.descripcion}
              onChange={(e) => campo("descripcion", e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="p-categoria">Categoría</Label>
              <Select
                id="p-categoria"
                required
                value={f.categoria_id}
                onChange={(e) => campo("categoria_id", e.target.value)}
              >
                {d.categorias.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-estacion">Estación de producción</Label>
              <Select
                id="p-estacion"
                value={f.estacion_produccion_id}
                onChange={(e) => campo("estacion_produccion_id", e.target.value)}
              >
                <option value="">Según la categoría</option>
                {d.estaciones.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nombre}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {!producto ? (
            <div className="space-y-1">
              <Label htmlFor="p-precio">Precio con IGV (S/)</Label>
              <Input
                id="p-precio"
                required
                inputMode="decimal"
                pattern="[0-9]+([.,][0-9]{1,2})?"
                value={f.precio}
                onChange={(e) => campo("precio", e.target.value)}
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={f.es_menu_del_dia}
                onChange={(e) => campo("es_menu_del_dia", e.target.checked)}
              />
              Es el menú del día
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={f.aplica_icbper}
                onChange={(e) => campo("aplica_icbper", e.target.checked)}
              />
              Bolsa plástica (ICBPER)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={f.activo}
                onChange={(e) => campo("activo", e.target.checked)}
              />
              Activo en la carta
            </label>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={accion.ocupado}>
              Guardar
            </Button>
          </DialogFooter>
        </form>

        {producto ? (
          <section className="space-y-2 border-t pt-3" aria-label="Grupos de modificadores">
            <h3 className="font-medium">Modificadores del producto</h3>
            <ul className="space-y-1 text-sm">
              {grupos.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-2">
                  <span>
                    {g.grupo} · {g.min === g.max ? `elegir ${g.min}` : `${g.min} a ${g.max}`}
                    {g.obligatorio ? " · obligatorio" : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={accion.ocupado}
                    onClick={() =>
                      void accion.ejecutar(() =>
                        escribir(supabase().from("producto_modificadores").delete().eq("id", g.id)),
                      )
                    }
                  >
                    Quitar
                  </Button>
                </li>
              ))}
              {grupos.length === 0 ? (
                <li className="text-muted-foreground">Sin modificadores.</li>
              ) : null}
            </ul>
            {gruposDisponibles.length ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="g-grupo">Grupo</Label>
                  <Select
                    id="g-grupo"
                    value={nuevoGrupo.grupo}
                    onChange={(e) => setNuevoGrupo((x) => ({ ...x, grupo: e.target.value }))}
                  >
                    <option value="">Elegir…</option>
                    {gruposDisponibles.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="w-20 space-y-1">
                  <Label htmlFor="g-min">Mín.</Label>
                  <Input
                    id="g-min"
                    type="number"
                    min={0}
                    max={10}
                    value={nuevoGrupo.min}
                    onChange={(e) => setNuevoGrupo((x) => ({ ...x, min: Number(e.target.value) }))}
                  />
                </div>
                <div className="w-20 space-y-1">
                  <Label htmlFor="g-max">Máx.</Label>
                  <Input
                    id="g-max"
                    type="number"
                    min={1}
                    max={10}
                    value={nuevoGrupo.max}
                    onChange={(e) => setNuevoGrupo((x) => ({ ...x, max: Number(e.target.value) }))}
                  />
                </div>
                <Button
                  variant="outline"
                  disabled={
                    !nuevoGrupo.grupo ||
                    nuevoGrupo.max < Math.max(1, nuevoGrupo.min) ||
                    accion.ocupado
                  }
                  onClick={() =>
                    void accion.ejecutar(async () => {
                      await escribir(
                        supabase()
                          .from("producto_modificadores")
                          .insert({
                            local_id: op.localId,
                            producto_id: producto.id,
                            grupo: nuevoGrupo.grupo,
                            min: nuevoGrupo.min,
                            max: nuevoGrupo.max,
                            obligatorio: nuevoGrupo.min > 0,
                          }),
                      );
                      setNuevoGrupo({ grupo: "", min: 0, max: 1 });
                    })
                  }
                >
                  Agregar grupo
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DialogoPrecio({ producto, alCerrar }: { producto: ProductoAdmin; alCerrar: () => void }) {
  const op = useOperador();
  const accion = useAccion([
    ["carta_admin", op.localId],
    ["carta", op.localId],
  ]);
  const [precio, setPrecio] = useState(String(Number(producto.precio)));
  const [motivo, setMotivo] = useState("");
  const valor = Number(precio.replace(",", "."));
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Precio de {producto.nombre}</DialogTitle>
          <DialogDescription>
            Actual: {formatearMoneda(Number(producto.precio))}. Las órdenes abiertas conservan el
            precio con el que se pidió cada ítem.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="precio-nuevo">Nuevo precio con IGV (S/)</Label>
          <Input
            id="precio-nuevo"
            inputMode="decimal"
            value={precio}
            onChange={(e) => setPrecio(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="precio-motivo">Motivo (obligatorio)</Label>
          <Input
            id="precio-motivo"
            maxLength={200}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={
              accion.ocupado || !Number.isFinite(valor) || valor < 0 || motivo.trim().length < 3
            }
            onClick={async () => {
              const r = await accion.ejecutar(
                () =>
                  rpc("cambiar_precio", {
                    p_producto_id: producto.id,
                    p_precio: valor,
                    p_motivo: motivo,
                  }),
                "Precio actualizado",
              );
              if (r) alCerrar();
            }}
          >
            Cambiar precio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DialogoMasivo({ d, alCerrar }: { d: Datos; alCerrar: () => void }) {
  const op = useOperador();
  const accion = useAccion([
    ["carta_admin", op.localId],
    ["carta", op.localId],
  ]);
  const [porcentaje, setPorcentaje] = useState("");
  const [categoria, setCategoria] = useState("");
  const [motivo, setMotivo] = useState("");
  const valor = Number(porcentaje.replace(",", "."));
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cambio masivo de precios</DialogTitle>
          <DialogDescription>
            Sube o baja un porcentaje los precios de carta, redondeados a céntimos. Cada cambio
            queda en el historial.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="masivo-porcentaje">Porcentaje (ej. 5 o -10)</Label>
            <Input
              id="masivo-porcentaje"
              inputMode="decimal"
              value={porcentaje}
              onChange={(e) => setPorcentaje(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="masivo-categoria">Categoría</Label>
            <Select
              id="masivo-categoria"
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
            >
              <option value="">Toda la carta</option>
              {d.categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="masivo-motivo">Motivo (obligatorio)</Label>
          <Input
            id="masivo-motivo"
            maxLength={200}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={
              accion.ocupado || !Number.isFinite(valor) || valor === 0 || motivo.trim().length < 3
            }
            onClick={async () => {
              const r = await accion.ejecutar(() =>
                rpc<{ productos: number }>("cambiar_precios_masivo", {
                  p_local_id: op.localId,
                  p_porcentaje: valor,
                  p_motivo: motivo,
                  p_categoria_id: categoria || null,
                }),
              );
              if (r) alCerrar();
            }}
          >
            Aplicar {Number.isFinite(valor) && valor ? `${valor > 0 ? "+" : ""}${valor} %` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DialogoHistorial({
  producto,
  alCerrar,
}: {
  producto: ProductoAdmin;
  alCerrar: () => void;
}) {
  const historial = useQuery({
    queryKey: ["historial_precio", producto.id],
    queryFn: async () => {
      const filas = await leer<
        Array<{
          id: string;
          precio_anterior: number;
          precio_nuevo: number;
          motivo: string | null;
          created_at: string;
          cambiado_por: string | null;
        }>
      >(
        supabase()
          .from("producto_precio_historial")
          .select("id, precio_anterior, precio_nuevo, motivo, created_at, cambiado_por")
          .eq("producto_id", producto.id)
          .order("created_at", { ascending: false }),
      );
      // cambiado_por no tiene FK (puede ser un proceso del sistema): los nombres se leen aparte.
      const ids = [
        ...new Set(filas.map((f) => f.cambiado_por).filter((x): x is string => Boolean(x))),
      ];
      const personas = ids.length
        ? await leer<Array<{ user_id: string; nombre_visible: string }>>(
            supabase().from("usuarios_perfil").select("user_id, nombre_visible").in("user_id", ids),
          )
        : [];
      const nombre = new Map(personas.map((p) => [p.user_id, p.nombre_visible]));
      return filas.map((f) => ({
        ...f,
        quien: f.cambiado_por ? (nombre.get(f.cambiado_por) ?? "—") : "Sistema",
      }));
    },
  });
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Historial de precios · {producto.nombre}</DialogTitle>
        </DialogHeader>
        <Tabla
          columnas={["Fecha", "Antes", "Después", "Motivo", "Quién"]}
          vacio={historial.data?.length === 0}
        >
          {(historial.data ?? []).map((h) => (
            <tr key={h.id}>
              <td className="px-3 py-2">{formatoFechaHora(h.created_at)}</td>
              <td className="px-3 py-2 tabular-nums">
                {formatearMoneda(Number(h.precio_anterior))}
              </td>
              <td className="px-3 py-2 tabular-nums">{formatearMoneda(Number(h.precio_nuevo))}</td>
              <td className="px-3 py-2">{h.motivo}</td>
              <td className="px-3 py-2">{h.quien}</td>
            </tr>
          ))}
        </Tabla>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Categorías, modificadores y estaciones
// ---------------------------------------------------------------------------
function Categorias({ d }: { d: Datos }) {
  const op = useOperador();
  const [editar, setEditar] = useState<CategoriaAdmin | "nueva" | null>(null);
  const estacion = new Map(d.estaciones.map((s) => [s.id, s.nombre]));
  return (
    <div className="space-y-3">
      {op.tiene("gestionar_carta") ? (
        <Button onClick={() => setEditar("nueva")}>Nueva categoría</Button>
      ) : null}
      <Tabla
        columnas={["Categoría", "Orden", "Estación por defecto", "Estado", ""]}
        vacio={d.categorias.length === 0}
      >
        {d.categorias.map((c) => (
          <tr key={c.id} className={c.activa ? undefined : "opacity-50"}>
            <td className="px-3 py-2 font-medium">{c.nombre}</td>
            <td className="px-3 py-2">{c.orden}</td>
            <td className="px-3 py-2">
              {c.estacion_produccion_id_default
                ? estacion.get(c.estacion_produccion_id_default)
                : "—"}
            </td>
            <td className="px-3 py-2">
              {c.activa ? (
                <Badge variant="exito">Activa</Badge>
              ) : (
                <Badge variant="secondary">Inactiva</Badge>
              )}
            </td>
            <td className="px-3 py-2 text-right">
              {op.tiene("gestionar_carta") ? (
                <Button size="sm" variant="outline" onClick={() => setEditar(c)}>
                  Editar
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </Tabla>
      {editar ? (
        <DialogoCategoria
          key={editar === "nueva" ? "n" : editar.id}
          d={d}
          categoria={editar === "nueva" ? null : editar}
          alCerrar={() => setEditar(null)}
        />
      ) : null}
    </div>
  );
}

function DialogoCategoria({
  d,
  categoria,
  alCerrar,
}: {
  d: Datos;
  categoria: CategoriaAdmin | null;
  alCerrar: () => void;
}) {
  const op = useOperador();
  const accion = useAccion([
    ["carta_admin", op.localId],
    ["carta", op.localId],
  ]);
  const [f, setF] = useState({
    nombre: categoria?.nombre ?? "",
    orden: categoria?.orden ?? d.categorias.length + 1,
    estacion_produccion_id_default: categoria?.estacion_produccion_id_default ?? "",
    activa: categoria?.activa ?? true,
  });
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{categoria ? `Editar ${categoria.nombre}` : "Nueva categoría"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const fila = {
              ...f,
              nombre: f.nombre.trim(),
              estacion_produccion_id_default: f.estacion_produccion_id_default || null,
            };
            const ok = await accion.ejecutar(async () => {
              if (categoria)
                await escribir(supabase().from("categorias").update(fila).eq("id", categoria.id));
              else
                await escribir(
                  supabase()
                    .from("categorias")
                    .insert({ ...fila, local_id: op.localId }),
                );
              return true;
            }, "Categoría guardada");
            if (ok) alCerrar();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="c-nombre">Nombre</Label>
            <Input
              id="c-nombre"
              required
              maxLength={60}
              value={f.nombre}
              onChange={(e) => setF({ ...f, nombre: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="c-orden">Orden</Label>
              <Input
                id="c-orden"
                type="number"
                min={0}
                max={999}
                value={f.orden}
                onChange={(e) => setF({ ...f, orden: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-estacion">Estación por defecto</Label>
              <Select
                id="c-estacion"
                value={f.estacion_produccion_id_default}
                onChange={(e) => setF({ ...f, estacion_produccion_id_default: e.target.value })}
              >
                <option value="">Ninguna (no va a cocina)</option>
                {d.estaciones.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nombre}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={f.activa}
              onChange={(e) => setF({ ...f, activa: e.target.checked })}
            />
            Activa
          </label>
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

function Modificadores({ d }: { d: Datos }) {
  const op = useOperador();
  const [editar, setEditar] = useState<ModificadorAdmin | "nuevo" | null>(null);
  return (
    <div className="space-y-3">
      {op.tiene("gestionar_carta") ? (
        <Button onClick={() => setEditar("nuevo")}>Nuevo modificador</Button>
      ) : null}
      <Tabla
        columnas={["Grupo", "Opción", "Recargo", "Estado", ""]}
        vacio={d.modificadores.length === 0}
      >
        {d.modificadores.map((m) => (
          <tr key={m.id} className={m.activo ? undefined : "opacity-50"}>
            <td className="px-3 py-2">{m.grupo}</td>
            <td className="px-3 py-2 font-medium">{m.nombre}</td>
            <td className="px-3 py-2 tabular-nums">
              {Number(m.precio_extra) ? `+${formatearMoneda(Number(m.precio_extra))}` : "—"}
            </td>
            <td className="px-3 py-2">
              {m.activo ? (
                <Badge variant="exito">Activo</Badge>
              ) : (
                <Badge variant="secondary">Inactivo</Badge>
              )}
            </td>
            <td className="px-3 py-2 text-right">
              {op.tiene("gestionar_carta") ? (
                <Button size="sm" variant="outline" onClick={() => setEditar(m)}>
                  Editar
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </Tabla>
      {editar ? (
        <DialogoModificador
          key={editar === "nuevo" ? "n" : editar.id}
          d={d}
          modificador={editar === "nuevo" ? null : editar}
          alCerrar={() => setEditar(null)}
        />
      ) : null}
    </div>
  );
}

function DialogoModificador({
  d,
  modificador,
  alCerrar,
}: {
  d: Datos;
  modificador: ModificadorAdmin | null;
  alCerrar: () => void;
}) {
  const op = useOperador();
  const accion = useAccion([
    ["carta_admin", op.localId],
    ["carta", op.localId],
  ]);
  const [f, setF] = useState({
    grupo: modificador?.grupo ?? "",
    nombre: modificador?.nombre ?? "",
    precio_extra: String(Number(modificador?.precio_extra ?? 0)),
    activo: modificador?.activo ?? true,
  });
  const grupos = [...new Set(d.modificadores.map((m) => m.grupo))];
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{modificador ? "Editar modificador" : "Nuevo modificador"}</DialogTitle>
          <DialogDescription>
            Los grupos ("Término", "Extras") se asignan a cada producto desde Productos → Editar.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const fila = {
              grupo: f.grupo.trim(),
              nombre: f.nombre.trim(),
              precio_extra: Number(f.precio_extra.replace(",", ".")) || 0,
              activo: f.activo,
            };
            const ok = await accion.ejecutar(async () => {
              if (modificador)
                await escribir(
                  supabase().from("modificadores").update(fila).eq("id", modificador.id),
                );
              else
                await escribir(
                  supabase()
                    .from("modificadores")
                    .insert({ ...fila, local_id: op.localId }),
                );
              return true;
            }, "Modificador guardado");
            if (ok) alCerrar();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="m-grupo">Grupo</Label>
              <Input
                id="m-grupo"
                required
                list="grupos-existentes"
                maxLength={40}
                value={f.grupo}
                onChange={(e) => setF({ ...f, grupo: e.target.value })}
              />
              <datalist id="grupos-existentes">
                {grupos.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-nombre">Opción</Label>
              <Input
                id="m-nombre"
                required
                maxLength={60}
                value={f.nombre}
                onChange={(e) => setF({ ...f, nombre: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="m-precio">Recargo (S/)</Label>
            <Input
              id="m-precio"
              inputMode="decimal"
              value={f.precio_extra}
              onChange={(e) => setF({ ...f, precio_extra: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={f.activo}
              onChange={(e) => setF({ ...f, activo: e.target.checked })}
            />
            Activo
          </label>
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

function Estaciones({ d }: { d: Datos }) {
  const op = useOperador();
  const accion = useAccion([
    ["carta_admin", op.localId],
    ["estaciones", op.localId],
  ]);
  const [nueva, setNueva] = useState("");
  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await accion.ejecutar(async () => {
            await escribir(
              supabase()
                .from("estaciones_produccion")
                .insert({ local_id: op.localId, nombre: nueva.trim() }),
            );
            return true;
          }, "Estación creada");
          if (ok) setNueva("");
        }}
      >
        <Input
          className="max-w-xs"
          required
          placeholder="Nueva estación (p. ej. Postres)"
          aria-label="Nombre de la estación"
          value={nueva}
          onChange={(e) => setNueva(e.target.value)}
        />
        <Button type="submit" disabled={accion.ocupado}>
          Agregar
        </Button>
      </form>
      <Tabla columnas={["Estación", "Impresora", "KDS"]} vacio={d.estaciones.length === 0}>
        {d.estaciones.map((s) => (
          <tr key={s.id}>
            <td className="px-3 py-2 font-medium">{s.nombre}</td>
            <td className="px-3 py-2">
              <Select
                aria-label={`Impresora de ${s.nombre}`}
                value={s.impresora_id ?? ""}
                disabled={accion.ocupado}
                onChange={(e) =>
                  void accion.ejecutar(() =>
                    escribir(
                      supabase()
                        .from("estaciones_produccion")
                        .update({ impresora_id: e.target.value || null })
                        .eq("id", s.id),
                    ),
                  )
                }
              >
                <option value="">Sin impresora (solo KDS)</option>
                {d.impresoras.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.nombre}
                  </option>
                ))}
              </Select>
            </td>
            <td className="px-3 py-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={s.muestra_kds}
                  disabled={accion.ocupado}
                  onChange={(e) =>
                    void accion.ejecutar(() =>
                      escribir(
                        supabase()
                          .from("estaciones_produccion")
                          .update({ muestra_kds: e.target.checked })
                          .eq("id", s.id),
                      ),
                    )
                  }
                />
                Mostrar en el KDS
              </label>
            </td>
          </tr>
        ))}
      </Tabla>
    </div>
  );
}
