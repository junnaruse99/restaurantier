"use client";

import { useQuery } from "@tanstack/react-query";
import { minutosDesde } from "@warike/domain";
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
} from "@warike/ui";
import { useState } from "react";
import { PaginaAdmin, Tabla } from "@/components/admin/pagina-admin";
import { Cargando } from "@/components/pantalla";
import { escribir } from "@/lib/datos";
import { formatoFechaHora } from "@/lib/formato";
import { useOperador } from "@/lib/operador";
import { rpc } from "@/lib/rpc";
import { leer } from "@/lib/salon";
import { supabase } from "@/lib/supabase";
import { useAccion } from "@/lib/use-accion";
import { useAhora } from "@/lib/use-ahora";

export default function PaginaDispositivos() {
  return (
    <PaginaAdmin titulo="Dispositivos" permisos={["configurar_local"]}>
      <Dispositivos />
    </PaginaAdmin>
  );
}

const TIPOS: Record<string, string> = {
  tablet_mozo: "Tablet de mozo",
  caja: "Caja",
  kds: "KDS de cocina",
  agente_impresion: "Agente de impresión",
};

interface Dispositivo {
  id: string;
  nombre: string;
  tipo: string;
  ultimo_ping: string | null;
  activo: boolean;
  created_at: string;
}

/** Registro y revocación de dispositivos (§4.1). El token se muestra una sola vez. */
function Dispositivos() {
  const op = useOperador();
  const ahora = useAhora();
  const accion = useAccion([["dispositivos", op.localId]]);
  const [registrar, setRegistrar] = useState(false);
  const lista = useQuery({
    queryKey: ["dispositivos", op.localId],
    refetchInterval: 30_000,
    queryFn: () =>
      leer<Dispositivo[]>(
        supabase()
          .from("dispositivos")
          .select("id, nombre, tipo, ultimo_ping, activo, created_at")
          .eq("local_id", op.localId)
          .order("activo", { ascending: false })
          .order("nombre"),
      ),
  });
  if (lista.isLoading) return <Cargando />;
  return (
    <div className="space-y-3">
      <Button onClick={() => setRegistrar(true)}>Registrar dispositivo</Button>
      <Tabla
        columnas={["Dispositivo", "Tipo", "Última conexión", "Estado", ""]}
        vacio={lista.data?.length === 0}
      >
        {(lista.data ?? []).map((d) => (
          <tr key={d.id} className={d.activo ? undefined : "opacity-50"}>
            <td className="px-3 py-2 font-medium">{d.nombre}</td>
            <td className="px-3 py-2">{TIPOS[d.tipo] ?? d.tipo}</td>
            <td className="px-3 py-2">
              {d.ultimo_ping ? (
                <>
                  {formatoFechaHora(d.ultimo_ping)}
                  {d.tipo === "agente_impresion" &&
                  d.activo &&
                  minutosDesde(d.ultimo_ping, ahora) >= 2 ? (
                    <Badge variant="aviso" className="ml-2">
                      sin latido
                    </Badge>
                  ) : null}
                </>
              ) : (
                "Nunca"
              )}
            </td>
            <td className="px-3 py-2">
              {d.activo ? (
                <Badge variant="exito">Activo</Badge>
              ) : (
                <Badge variant="secondary">Revocado</Badge>
              )}
            </td>
            <td className="px-3 py-2 text-right">
              {d.activo ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={accion.ocupado}
                  onClick={() =>
                    void accion.ejecutar(
                      () =>
                        escribir(
                          supabase().from("dispositivos").update({ activo: false }).eq("id", d.id),
                        ),
                      "Dispositivo revocado: sus sesiones se cerraron",
                    )
                  }
                >
                  Revocar
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </Tabla>
      <p className="text-xs text-muted-foreground">
        Revocar un dispositivo cierra al instante las sesiones abiertas en él. Para volver a usarlo,
        regístrelo de nuevo.
      </p>
      {registrar ? <DialogoRegistrar alCerrar={() => setRegistrar(false)} /> : null}
    </div>
  );
}

function DialogoRegistrar({ alCerrar }: { alCerrar: () => void }) {
  const op = useOperador();
  const accion = useAccion([["dispositivos", op.localId]]);
  const [nombre, setNombre] = useState("");
  const [tipo, setTipo] = useState("tablet_mozo");
  const [token, setToken] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  return (
    <Dialog open onOpenChange={(a) => !a && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar dispositivo</DialogTitle>
          <DialogDescription>
            {token
              ? "Copie el token ahora: no se vuelve a mostrar."
              : "Se genera un token que se pega una sola vez en el dispositivo."}
          </DialogDescription>
        </DialogHeader>
        {token ? (
          <div className="space-y-3">
            <Alert>
              <p className="mb-2 text-sm">
                {tipo === "agente_impresion"
                  ? "Póngalo en WARIKE_DEVICE_TOKEN del agente (ver docs/runbook-agente.md)."
                  : "En el dispositivo, abra /dispositivo → Tengo un token de dispositivo, y péguelo."}
              </p>
              <code
                className="block break-all rounded bg-muted p-2 text-xs"
                data-testid="token-dispositivo"
              >
                {token}
              </code>
            </Alert>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(token).then(() => setCopiado(true));
                }}
              >
                {copiado ? "Copiado" : "Copiar"}
              </Button>
              <Button onClick={alCerrar}>Listo</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="d-nombre">Nombre</Label>
              <Input
                id="d-nombre"
                maxLength={60}
                placeholder="Tablet Salón 6"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-tipo">Tipo</Label>
              <Select id="d-tipo" value={tipo} onChange={(e) => setTipo(e.target.value)}>
                {Object.entries(TIPOS).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
            <DialogFooter>
              <Button
                disabled={!nombre.trim() || accion.ocupado}
                onClick={async () => {
                  const r = await accion.ejecutar(() =>
                    rpc<{ token: string }>("registrar_dispositivo", {
                      p_local_id: op.localId,
                      p_nombre: nombre,
                      p_tipo: tipo,
                    }),
                  );
                  if (r) setToken(r.token);
                }}
              >
                Registrar
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
