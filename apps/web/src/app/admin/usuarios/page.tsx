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
} from "@warike/ui";
import { useState } from "react";
import { descargarCsv, PaginaAdmin, Tabla } from "@/components/admin/pagina-admin";
import { Cargando } from "@/components/pantalla";
import { escribir } from "@/lib/datos";
import { useOperador } from "@/lib/operador";
import { ErrorRpc, rpc } from "@/lib/rpc";
import { leer } from "@/lib/salon";
import { supabase } from "@/lib/supabase";
import { useAccion } from "@/lib/use-accion";

export default function PaginaUsuarios() {
  return (
    <PaginaAdmin titulo="Usuarios y planilla" permisos={["gestionar_usuarios"]}>
      <Usuarios />
    </PaginaAdmin>
  );
}

interface Rol {
  id: string;
  codigo: string;
  nombre: string;
  requiere_mfa: boolean;
}
interface Empleado {
  id: string;
  dni: string | null;
  nombres: string;
  apellidos: string;
  cargo: string;
  fecha_ingreso: string | null;
  sueldo_base: number | null;
  telefono: string | null;
  limite_consumo_mensual: number | null;
  activo: boolean;
}
interface Usuario {
  user_id: string;
  nombre_visible: string;
  codigo_empleado: string | null;
  activo: boolean;
  empleado_id: string | null;
  roles: Array<{ role_id: string; codigo: string; nombre: string; requiere_mfa: boolean }>;
}

const CARGOS = ["mozo", "cajero", "cocinero", "ayudante", "barman", "administrador", "otro"];

function useUsuarios(localId: string) {
  return useQuery({
    queryKey: ["usuarios", localId],
    queryFn: async () => {
      const c = supabase();
      const [asignaciones, roles, empleados] = await Promise.all([
        leer<Array<{ user_id: string; role_id: string; rol: Rol; perfil: Omit<Usuario, "roles"> }>>(
          c
            .from("user_local_roles")
            .select(
              "user_id, role_id, rol:roles(id, codigo, nombre, requiere_mfa), perfil:usuarios_perfil(user_id, nombre_visible, codigo_empleado, activo, empleado_id)",
            )
            .eq("local_id", localId),
        ),
        leer<Rol[]>(
          c
            .from("roles")
            .select("id, codigo, nombre, requiere_mfa")
            .eq("activo", true)
            .neq("codigo", "agente_impresion")
            .order("nombre"),
        ),
        leer<Empleado[]>(
          c.from("empleados").select("*").eq("local_id", localId).order("apellidos"),
        ),
      ]);
      const porUsuario = new Map<string, Usuario>();
      for (const a of asignaciones) {
        // El usuario técnico del agente de impresión no es una persona.
        if (a.rol.codigo === "agente_impresion") continue;
        const u = porUsuario.get(a.user_id) ?? { ...a.perfil, roles: [] };
        u.roles.push({
          role_id: a.role_id,
          codigo: a.rol.codigo,
          nombre: a.rol.nombre,
          requiere_mfa: a.rol.requiere_mfa,
        });
        porUsuario.set(a.user_id, u);
      }
      return {
        usuarios: [...porUsuario.values()].sort((x, y) =>
          x.nombre_visible.localeCompare(y.nombre_visible),
        ),
        roles,
        empleados,
      };
    },
  });
}

type Datos = NonNullable<ReturnType<typeof useUsuarios>["data"]>;

function Usuarios() {
  const op = useOperador();
  const datos = useUsuarios(op.localId);
  const [seccion, setSeccion] = useState<"usuarios" | "planilla">("usuarios");
  if (datos.isLoading) return <Cargando />;
  if (datos.isError || !datos.data)
    return <Alert variant="destructive">No se pudieron cargar los usuarios.</Alert>;
  return (
    <div className="space-y-4">
      <Tabs
        etiqueta="Secciones"
        pestanas={[
          { valor: "usuarios", etiqueta: "Usuarios" },
          { valor: "planilla", etiqueta: "Planilla" },
        ]}
        valor={seccion}
        alCambiar={setSeccion}
      />
      {seccion === "usuarios" ? <ListaUsuarios d={datos.data} /> : <Planilla d={datos.data} />}
    </div>
  );
}

function ListaUsuarios({ d }: { d: Datos }) {
  const op = useOperador();
  const accion = useAccion([["usuarios", op.localId]]);
  const [nuevo, setNuevo] = useState(false);
  const [pin, setPin] = useState<Usuario | null>(null);
  const [roles, setRoles] = useState<Usuario | null>(null);
  return (
    <div className="space-y-3">
      <Button onClick={() => setNuevo(true)}>Nuevo usuario</Button>
      <Tabla columnas={["Nombre", "Código", "Roles", "Estado", ""]} vacio={d.usuarios.length === 0}>
        {d.usuarios.map((u) => {
          const conPin = u.roles.some((r) => !r.requiere_mfa) || Boolean(u.codigo_empleado);
          return (
            <tr
              key={u.user_id}
              className={u.activo ? undefined : "opacity-50"}
              data-testid="fila-usuario"
            >
              <td className="px-3 py-2 font-medium">{u.nombre_visible}</td>
              <td className="px-3 py-2">{u.codigo_empleado ?? "—"}</td>
              <td className="space-x-1 px-3 py-2">
                {u.roles.map((r) => (
                  <Badge key={r.role_id} variant={r.requiere_mfa ? "default" : "secondary"}>
                    {r.nombre}
                  </Badge>
                ))}
              </td>
              <td className="px-3 py-2">
                {u.activo ? (
                  <Badge variant="exito">Activo</Badge>
                ) : (
                  <Badge variant="secondary">Inactivo</Badge>
                )}
              </td>
              <td className="space-x-1 whitespace-nowrap px-3 py-2 text-right">
                {conPin ? (
                  <Button size="sm" variant="ghost" onClick={() => setPin(u)}>
                    PIN
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setRoles(u)}>
                  Roles
                </Button>
                {u.user_id !== op.userId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={accion.ocupado}
                    onClick={() =>
                      void accion.ejecutar(
                        () =>
                          escribir(
                            supabase()
                              .from("usuarios_perfil")
                              .update({ activo: !u.activo })
                              .eq("user_id", u.user_id),
                          ),
                        u.activo
                          ? "Usuario desactivado: sus sesiones dejan de valer"
                          : "Usuario activado",
                      )
                    }
                  >
                    {u.activo ? "Desactivar" : "Activar"}
                  </Button>
                ) : null}
              </td>
            </tr>
          );
        })}
      </Tabla>
      {nuevo ? <DialogoNuevoUsuario d={d} alCerrar={() => setNuevo(false)} /> : null}
      {pin ? <DialogoPin key={pin.user_id} usuario={pin} alCerrar={() => setPin(null)} /> : null}
      {roles ? (
        <DialogoRoles
          key={roles.user_id}
          d={d}
          usuario={d.usuarios.find((u) => u.user_id === roles.user_id) ?? roles}
          alCerrar={() => setRoles(null)}
        />
      ) : null}
    </div>
  );
}

/** Errores de la Edge Function admin-usuarios: el cuerpo trae { error, mensaje }. */
async function altaUsuario(cuerpo: Record<string, unknown>) {
  const { data, error } = await supabase().functions.invoke("admin-usuarios", { body: cuerpo });
  if (error) {
    const respuesta = (error as { context?: Response }).context;
    const detalle = respuesta
      ? ((await respuesta.json().catch(() => ({}))) as { error?: string; mensaje?: string })
      : {};
    throw new ErrorRpc(
      detalle.mensaje ??
        (detalle.error === "codigo_duplicado"
          ? "El código ya existe"
          : "No se pudo crear el usuario"),
      detalle.error ?? "error",
    );
  }
  return data as { user_id: string };
}

function DialogoNuevoUsuario({ d, alCerrar }: { d: Datos; alCerrar: () => void }) {
  const op = useOperador();
  const accion = useAccion([["usuarios", op.localId]]);
  const [f, setF] = useState({
    role_id: d.roles.find((r) => r.codigo === "mozo")?.id ?? d.roles[0]?.id ?? "",
    nombre: "",
    codigo: "",
    pin: "",
    email: "",
    password: "",
    empleado_id: "",
  });
  const rol = d.roles.find((r) => r.id === f.role_id);
  const valido =
    f.nombre.trim() &&
    (rol?.requiere_mfa
      ? f.email.includes("@") && f.password.length >= 12
      : /^[0-9A-Za-z]{3,12}$/.test(f.codigo) && /^[0-9]{4,6}$/.test(f.pin));
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo usuario</DialogTitle>
          <DialogDescription>
            {rol?.requiere_mfa
              ? "Entra con email y contraseña, y enrola la verificación en dos pasos en su primer ingreso."
              : "Entra en las tablets registradas con su código de empleado y PIN."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="u-rol">Rol en {op.localNombre}</Label>
          <Select
            id="u-rol"
            value={f.role_id}
            onChange={(e) => setF({ ...f, role_id: e.target.value })}
          >
            {d.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nombre}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-nombre">Nombre para mostrar</Label>
          <Input
            id="u-nombre"
            maxLength={80}
            value={f.nombre}
            onChange={(e) => setF({ ...f, nombre: e.target.value })}
          />
        </div>
        {rol?.requiere_mfa ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="u-email">Email</Label>
              <Input
                id="u-email"
                type="email"
                value={f.email}
                onChange={(e) => setF({ ...f, email: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="u-password">Contraseña inicial (12+)</Label>
              <Input
                id="u-password"
                type="password"
                autoComplete="new-password"
                value={f.password}
                onChange={(e) => setF({ ...f, password: e.target.value })}
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="u-codigo">Código de empleado</Label>
              <Input
                id="u-codigo"
                maxLength={12}
                value={f.codigo}
                onChange={(e) => setF({ ...f, codigo: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="u-pin">PIN (4 a 6 dígitos)</Label>
              <Input
                id="u-pin"
                inputMode="numeric"
                maxLength={6}
                value={f.pin}
                onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "") })}
              />
            </div>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="u-empleado">Empleado de la planilla (opcional)</Label>
          <Select
            id="u-empleado"
            value={f.empleado_id}
            onChange={(e) => setF({ ...f, empleado_id: e.target.value })}
          >
            <option value="">Sin vincular</option>
            {d.empleados
              .filter((e) => e.activo)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.apellidos}, {e.nombres}
                </option>
              ))}
          </Select>
        </div>
        <DialogFooter>
          <Button
            disabled={!valido || accion.ocupado}
            onClick={async () => {
              const r = await accion.ejecutar(
                () =>
                  altaUsuario({
                    local_id: op.localId,
                    role_id: f.role_id,
                    nombre_visible: f.nombre.trim(),
                    empleado_id: f.empleado_id || null,
                    ...(rol?.requiere_mfa
                      ? { email: f.email.trim(), password: f.password }
                      : { codigo_empleado: f.codigo, pin: f.pin }),
                  }),
                "Usuario creado",
              );
              if (r) alCerrar();
            }}
          >
            Crear usuario
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DialogoPin({ usuario, alCerrar }: { usuario: Usuario; alCerrar: () => void }) {
  const accion = useAccion();
  const [pin, setPin] = useState("");
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>PIN de {usuario.nombre_visible}</DialogTitle>
          <DialogDescription>
            De 4 a 6 dígitos, sin secuencias (1234) ni un solo dígito repetido. También desbloquea
            el PIN.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="nuevo-pin">Nuevo PIN</Label>
          <Input
            id="nuevo-pin"
            inputMode="numeric"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={pin.length < 4 || accion.ocupado}
            onClick={async () => {
              const r = await accion.ejecutar(
                () =>
                  rpc("establecer_pin", { p_user_id: usuario.user_id, p_pin: pin }).then(
                    () => true,
                  ),
                "PIN actualizado",
              );
              if (r) alCerrar();
            }}
          >
            Guardar PIN
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DialogoRoles({
  d,
  usuario,
  alCerrar,
}: {
  d: Datos;
  usuario: Usuario;
  alCerrar: () => void;
}) {
  const op = useOperador();
  const accion = useAccion([["usuarios", op.localId]]);
  const [nuevo, setNuevo] = useState("");
  const disponibles = d.roles.filter((r) => !usuario.roles.some((x) => x.role_id === r.id));
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roles de {usuario.nombre_visible}</DialogTitle>
          <DialogDescription>
            Los roles de admin y auditor solo valen con verificación en dos pasos; los demás, con
            PIN en un dispositivo.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {usuario.roles.map((r) => (
            <li key={r.role_id} className="flex items-center justify-between">
              <span>{r.nombre}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={accion.ocupado || (usuario.user_id === op.userId && r.codigo === "admin")}
                onClick={() =>
                  void accion.ejecutar(() =>
                    escribir(
                      supabase()
                        .from("user_local_roles")
                        .delete()
                        .eq("user_id", usuario.user_id)
                        .eq("local_id", op.localId)
                        .eq("role_id", r.role_id),
                    ),
                  )
                }
              >
                Quitar
              </Button>
            </li>
          ))}
        </ul>
        {disponibles.length ? (
          <div className="flex gap-2">
            <Select
              aria-label="Rol a agregar"
              value={nuevo}
              onChange={(e) => setNuevo(e.target.value)}
            >
              <option value="">Agregar rol…</option>
              {disponibles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nombre}
                </option>
              ))}
            </Select>
            <Button
              disabled={!nuevo || accion.ocupado}
              onClick={() =>
                void accion.ejecutar(async () => {
                  await escribir(
                    supabase()
                      .from("user_local_roles")
                      .insert({ user_id: usuario.user_id, local_id: op.localId, role_id: nuevo }),
                  );
                  setNuevo("");
                })
              }
            >
              Agregar
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Planilla (M2): alta, edición, baja lógica y exportación
// ---------------------------------------------------------------------------
function Planilla({ d }: { d: Datos }) {
  const [editar, setEditar] = useState<Empleado | "nuevo" | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setEditar("nuevo")}>Nuevo empleado</Button>
        <Button
          variant="outline"
          onClick={() =>
            descargarCsv("planilla.csv", [
              [
                "DNI",
                "Apellidos",
                "Nombres",
                "Cargo",
                "Fecha de ingreso",
                "Sueldo base",
                "Teléfono",
                "Límite de consumo",
                "Activo",
              ],
              ...d.empleados.map((e) => [
                e.dni,
                e.apellidos,
                e.nombres,
                e.cargo,
                e.fecha_ingreso,
                e.sueldo_base,
                e.telefono,
                e.limite_consumo_mensual,
                e.activo ? "Sí" : "No",
              ]),
            ])
          }
        >
          Exportar a Excel (CSV)
        </Button>
      </div>
      <Tabla
        columnas={["Empleado", "DNI", "Cargo", "Ingreso", "Sueldo", "Estado", ""]}
        vacio={d.empleados.length === 0}
      >
        {d.empleados.map((e) => (
          <tr key={e.id} className={e.activo ? undefined : "opacity-50"}>
            <td className="px-3 py-2 font-medium">
              {e.apellidos}, {e.nombres}
            </td>
            <td className="px-3 py-2">{e.dni ?? "—"}</td>
            <td className="px-3 py-2 capitalize">{e.cargo}</td>
            <td className="px-3 py-2">{e.fecha_ingreso ?? "—"}</td>
            <td className="px-3 py-2 tabular-nums">
              {e.sueldo_base !== null ? formatearMoneda(Number(e.sueldo_base)) : "—"}
            </td>
            <td className="px-3 py-2">
              {e.activo ? (
                <Badge variant="exito">Activo</Badge>
              ) : (
                <Badge variant="secondary">De baja</Badge>
              )}
            </td>
            <td className="px-3 py-2 text-right">
              <Button size="sm" variant="outline" onClick={() => setEditar(e)}>
                Editar
              </Button>
            </td>
          </tr>
        ))}
      </Tabla>
      <p className="text-xs text-muted-foreground">
        Un empleado no se borra: se da de baja y conserva su historial de ventas y consumos.
      </p>
      {editar ? (
        <DialogoEmpleado
          key={editar === "nuevo" ? "n" : editar.id}
          empleado={editar === "nuevo" ? null : editar}
          alCerrar={() => setEditar(null)}
        />
      ) : null}
    </div>
  );
}

function DialogoEmpleado({
  empleado,
  alCerrar,
}: {
  empleado: Empleado | null;
  alCerrar: () => void;
}) {
  const op = useOperador();
  const accion = useAccion([["usuarios", op.localId]]);
  const [f, setF] = useState({
    dni: empleado?.dni ?? "",
    nombres: empleado?.nombres ?? "",
    apellidos: empleado?.apellidos ?? "",
    cargo: empleado?.cargo ?? "mozo",
    fecha_ingreso: empleado?.fecha_ingreso ?? "",
    sueldo_base:
      empleado?.sueldo_base !== null && empleado?.sueldo_base !== undefined
        ? String(empleado.sueldo_base)
        : "",
    telefono: empleado?.telefono ?? "",
    activo: empleado?.activo ?? true,
  });
  const campo = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) =>
    setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{empleado ? "Editar empleado" : "Nuevo empleado"}</DialogTitle>
          <DialogDescription>
            La consulta automática del DNI llega con id-lookup en la fase 2; por ahora los nombres
            se escriben a mano.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const fila = {
              dni: f.dni.trim().toUpperCase() || null,
              nombres: f.nombres.trim(),
              apellidos: f.apellidos.trim(),
              cargo: f.cargo,
              fecha_ingreso: f.fecha_ingreso || null,
              sueldo_base: f.sueldo_base ? Number(f.sueldo_base.replace(",", ".")) : null,
              telefono: f.telefono.trim() || null,
              activo: f.activo,
            };
            const ok = await accion.ejecutar(async () => {
              if (empleado)
                await escribir(supabase().from("empleados").update(fila).eq("id", empleado.id));
              else
                await escribir(
                  supabase()
                    .from("empleados")
                    .insert({ ...fila, local_id: op.localId }),
                );
              return true;
            }, "Empleado guardado");
            if (ok) alCerrar();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="e-dni">DNI / CE</Label>
              <Input
                id="e-dni"
                pattern="[0-9A-Za-z]{8,12}"
                maxLength={12}
                value={f.dni}
                onChange={(e) => campo("dni", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="e-cargo">Cargo</Label>
              <Select id="e-cargo" value={f.cargo} onChange={(e) => campo("cargo", e.target.value)}>
                {CARGOS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="e-nombres">Nombres</Label>
              <Input
                id="e-nombres"
                required
                value={f.nombres}
                onChange={(e) => campo("nombres", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="e-apellidos">Apellidos</Label>
              <Input
                id="e-apellidos"
                required
                value={f.apellidos}
                onChange={(e) => campo("apellidos", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="e-ingreso">Fecha de ingreso</Label>
              <Input
                id="e-ingreso"
                type="date"
                value={f.fecha_ingreso}
                onChange={(e) => campo("fecha_ingreso", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="e-sueldo">Sueldo base (S/)</Label>
              <Input
                id="e-sueldo"
                inputMode="decimal"
                value={f.sueldo_base}
                onChange={(e) => campo("sueldo_base", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="e-telefono">Teléfono</Label>
              <Input
                id="e-telefono"
                value={f.telefono}
                onChange={(e) => campo("telefono", e.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={f.activo}
              onChange={(e) => campo("activo", e.target.checked)}
            />
            Activo (desmarque para dar de baja)
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
