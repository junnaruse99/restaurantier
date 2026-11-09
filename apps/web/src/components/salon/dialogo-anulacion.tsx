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
  Input,
  Label,
  Select,
  Textarea,
} from "@warike/ui";
import { useState } from "react";
import { useNotificar } from "@/components/notificaciones";
import { useOperador } from "@/lib/operador";
import { ErrorRpc, mensajeDeError, mutar, rpc } from "@/lib/rpc";

export const MOTIVOS_ANULACION: Array<{ valor: string; texto: string }> = [
  { valor: "error_digitacion", texto: "Error de digitación" },
  { valor: "cliente_desiste", texto: "Cliente desiste" },
  { valor: "demora", texto: "Demora" },
  { valor: "producto_agotado", texto: "Producto agotado" },
  { valor: "calidad", texto: "Calidad" },
  { valor: "otro", texto: "Otro" },
];

export interface ObjetivoAnulacion {
  tipo: "item" | "orden";
  id: string;
  descripcion: string;
}

/**
 * Se monta con `key` por objetivo para empezar siempre vacío.
 *
 * Anulación de un ítem enviado o de una orden (CU9.2, CU9.3, flujo C): motivo y merma, y la
 * autorización del supervisor con su código y PIN en este dispositivo, o la solicitud remota al admin.
 * Quien tiene autorizar_anulacion (admin con MFA) anula directamente.
 */
export function DialogoAnulacion({
  objetivo,
  alCerrar,
  alTerminar,
}: {
  objetivo: ObjetivoAnulacion | null;
  alCerrar: () => void;
  alTerminar: () => void;
}) {
  const op = useOperador();
  const notificar = useNotificar();
  const [motivo, setMotivo] = useState("");
  const [texto, setTexto] = useState("");
  const [merma, setMerma] = useState(false);
  const [codigo, setCodigo] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const autoriza = op.tiene("autorizar_anulacion");

  if (!objetivo) return null;
  const motivoValido = motivo !== "" && (motivo !== "otro" || texto.trim() !== "");

  async function anular(autorizacionId: string | null) {
    const argumentos = {
      p_motivo_codigo: motivo,
      p_motivo_texto: texto.trim() || null,
      p_merma: merma,
      p_autorizacion_id: autorizacionId,
    };
    if (objetivo!.tipo === "item")
      await mutar("anular_item", { p_item_id: objetivo!.id, ...argumentos });
    else await mutar("anular_orden", { p_orden_id: objetivo!.id, ...argumentos });
  }

  async function correr(accion: () => Promise<void>) {
    if (ocupado || !motivoValido) return;
    setOcupado(true);
    setError(null);
    try {
      await accion();
      alTerminar();
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setOcupado(false);
    }
  }

  const conPin = () =>
    correr(async () => {
      const r = await rpc<{
        ok: boolean;
        error?: string;
        autorizacion_id?: string;
        intentos_restantes?: number;
        autorizado_por?: { nombre: string };
      }>("autorizar_con_pin", {
        p_local_id: op.localId,
        p_permiso: "autorizar_anulacion",
        p_codigo: codigo.trim(),
        p_pin: pin,
      });
      if (!r.ok) {
        setPin("");
        throw new ErrorRpc(
          r.error === "bloqueado"
            ? "El PIN del supervisor está bloqueado por intentos fallidos."
            : r.error === "sin_permiso"
              ? "Ese usuario no puede autorizar anulaciones."
              : `Código o PIN incorrecto${r.intentos_restantes !== undefined ? ` (quedan ${r.intentos_restantes} intentos)` : ""}.`,
          r.error ?? "credenciales_invalidas",
        );
      }
      await anular(r.autorizacion_id!);
      notificar(`Anulado con autorización de ${r.autorizado_por?.nombre ?? "supervisor"}`, "exito");
    });

  const directo = () =>
    correr(async () => {
      await anular(null);
      notificar("Anulado", "exito");
    });

  const remoto = () =>
    correr(async () => {
      await mutar("solicitar_anulacion", {
        p_item_id: objetivo.tipo === "item" ? objetivo.id : null,
        p_orden_id: objetivo.tipo === "orden" ? objetivo.id : null,
        p_motivo_codigo: motivo,
        p_motivo_texto: texto.trim() || null,
        p_merma: merma,
      });
      notificar("Solicitud enviada al administrador", "info");
    });

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Anular {objetivo.tipo === "orden" ? "la orden" : "ítem"}</DialogTitle>
          <DialogDescription>{objetivo.descripcion}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="motivo-anulacion">Motivo</Label>
          <Select id="motivo-anulacion" value={motivo} onChange={(e) => setMotivo(e.target.value)}>
            <option value="" disabled>
              Elija el motivo…
            </option>
            {MOTIVOS_ANULACION.map((m) => (
              <option key={m.valor} value={m.valor}>
                {m.texto}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="detalle-anulacion">
            Detalle {motivo === "otro" ? "(obligatorio)" : "(opcional)"}
          </Label>
          <Textarea
            id="detalle-anulacion"
            maxLength={300}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={merma}
            onChange={(e) => setMerma(e.target.checked)}
          />
          Hubo merma (el plato ya se preparó o se desperdició)
        </label>

        {autoriza ? (
          <DialogFooter>
            <Button
              variant="destructive"
              size="lg"
              className="w-full"
              disabled={!motivoValido || ocupado}
              onClick={() => void directo()}
            >
              Anular
            </Button>
          </DialogFooter>
        ) : (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm font-medium">Autorización del supervisor</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="codigo-supervisor">Código</Label>
                <Input
                  id="codigo-supervisor"
                  autoComplete="off"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pin-supervisor">PIN</Label>
                <Input
                  id="pin-supervisor"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                className="flex-1"
                disabled={!motivoValido || ocupado || codigo.trim().length < 3 || pin.length < 4}
                onClick={() => void conPin()}
              >
                Autorizar y anular
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={!motivoValido || ocupado}
                onClick={() => void remoto()}
              >
                Pedir aprobación al admin
              </Button>
            </div>
          </div>
        )}
        {error ? <Alert variant="destructive">{error}</Alert> : null}
      </DialogContent>
    </Dialog>
  );
}
