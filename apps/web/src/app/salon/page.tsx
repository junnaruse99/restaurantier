"use client";

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tabs,
} from "@warike/ui";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Encabezado } from "@/components/encabezado";
import { Cargando } from "@/components/pantalla";
import { AvisosListos } from "@/components/salon/avisos-listos";
import { Leyenda, Plano } from "@/components/salon/plano";
import { ConOperador, useOperador } from "@/lib/operador";
import { mutar, rpc } from "@/lib/rpc";
import { etiquetaMesa, ordenPorMesa, useSalon, type Mesa } from "@/lib/salon";
import { useAccion } from "@/lib/use-accion";
import { useAhora } from "@/lib/use-ahora";

export default function PaginaSalon() {
  return (
    <ConOperador permisos={["tomar_pedido"]}>
      <Salon />
    </ConOperador>
  );
}

const CLAVE_PISO = "warike-pos-piso";

function Salon() {
  const op = useOperador();
  const router = useRouter();
  const ahora = useAhora();
  const { pisos, mesas, ordenes } = useSalon(op.localId);
  const [pisoId, setPisoId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(CLAVE_PISO);
    } catch {
      return null;
    }
  });
  const [abrir, setAbrir] = useState<Mesa | null>(null);
  const [liberar, setLiberar] = useState<Mesa | null>(null);
  const porMesa = useMemo(() => ordenPorMesa(ordenes.data ?? []), [ordenes.data]);

  if (pisos.isLoading || mesas.isLoading) return <Cargando />;
  if (pisos.isError || mesas.isError) {
    return <Alert variant="destructive">No se pudo cargar el salón. Verifique la conexión.</Alert>;
  }
  const piso = pisos.data!.find((p) => p.id === pisoId) ?? pisos.data![0];

  function elegir(mesa: Mesa) {
    const orden = porMesa.get(mesa.id);
    if (orden) {
      router.push(`/salon/orden?id=${orden.id}`);
    } else if (mesa.estado === "libre") {
      setAbrir(mesa);
    } else if (mesa.estado === "por_limpiar") {
      setLiberar(mesa);
    }
  }

  return (
    <div className="min-h-dvh">
      <Encabezado titulo="Salón" />
      <main className="space-y-3 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs
            etiqueta="Pisos"
            pestanas={pisos.data!.map((p) => ({ valor: p.id, etiqueta: p.nombre }))}
            valor={piso?.id ?? ""}
            alCambiar={(id) => {
              setPisoId(id);
              try {
                sessionStorage.setItem(CLAVE_PISO, id);
              } catch {
                // sin almacenamiento
              }
            }}
          />
          <Leyenda />
        </div>
        {piso ? (
          <Plano
            piso={piso}
            mesas={mesas.data!}
            ordenes={porMesa}
            ahora={ahora}
            alElegir={elegir}
            habilitada={(m) => m.estado !== "bloqueada"}
          />
        ) : (
          <Alert>
            El local aún no tiene pisos. El administrador los crea en Administración → Plano.
          </Alert>
        )}
      </main>
      {abrir ? (
        <DialogoAbrir
          key={abrir.id}
          mesa={abrir}
          alCerrar={() => setAbrir(null)}
          alAbrir={(id) => router.push(`/salon/orden?id=${id}`)}
        />
      ) : null}
      <DialogoLiberar mesa={liberar} alCerrar={() => setLiberar(null)} />
      <AvisosListos mesas={mesas.data!} />
    </div>
  );
}

function DialogoAbrir({
  mesa,
  alCerrar,
  alAbrir,
}: {
  mesa: Mesa;
  alCerrar: () => void;
  alAbrir: (ordenId: string) => void;
}) {
  const op = useOperador();
  const [comensales, setComensales] = useState(() => Math.min(Math.max(mesa.capacidad, 1), 8));
  const accion = useAccion([
    ["mesas", op.localId],
    ["ordenes_en_curso", op.localId],
  ]);

  async function confirmar() {
    const r = await accion.ejecutar(() =>
      mutar<{ orden_id: string }>("abrir_orden", { p_mesa_id: mesa.id, p_comensales: comensales }),
    );
    if (r) {
      alCerrar();
      alAbrir(r.orden_id);
    }
  }

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Abrir {etiquetaMesa(mesa)}</DialogTitle>
          <DialogDescription>¿Cuántos comensales?</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-5 gap-2" role="group" aria-label="Comensales">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <Button
              key={n}
              size="lg"
              variant={n === comensales ? "default" : "outline"}
              aria-pressed={n === comensales}
              onClick={() => setComensales(n)}
            >
              {n}
            </Button>
          ))}
        </div>
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            aria-label="Menos comensales"
            onClick={() => setComensales((c) => Math.max(1, c - 1))}
          >
            −
          </Button>
          <span className="w-12 text-center text-2xl font-semibold" data-testid="comensales">
            {comensales}
          </span>
          <Button
            variant="outline"
            aria-label="Más comensales"
            onClick={() => setComensales((c) => Math.min(99, c + 1))}
          >
            +
          </Button>
        </div>
        <DialogFooter>
          <Button
            size="lg"
            className="w-full"
            disabled={accion.ocupado}
            onClick={() => void confirmar()}
          >
            Abrir mesa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DialogoLiberar({ mesa, alCerrar }: { mesa: Mesa | null; alCerrar: () => void }) {
  const op = useOperador();
  const accion = useAccion([["mesas", op.localId]]);
  return (
    <Dialog open={Boolean(mesa)} onOpenChange={(abierto) => !abierto && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{etiquetaMesa(mesa ?? undefined)} por limpiar</DialogTitle>
          <DialogDescription>
            Cuando la mesa esté lista para nuevos clientes, márquela como libre.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            size="lg"
            className="w-full"
            disabled={accion.ocupado}
            onClick={async () => {
              const r = await accion.ejecutar(
                () => rpc("liberar_mesa", { p_mesa_id: mesa!.id }),
                "Mesa libre",
              );
              if (r) alCerrar();
            }}
          >
            Mesa limpia: liberar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
