"use client";

import { Button } from "@warike/ui";

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** Teclado numérico grande para tablets (código de empleado y PIN). */
export function TecladoPin({
  onDigito,
  onBorrar,
  onConfirmar,
  deshabilitado = false,
  puedeConfirmar,
}: {
  onDigito: (digito: string) => void;
  onBorrar: () => void;
  onConfirmar: () => void;
  deshabilitado?: boolean;
  puedeConfirmar: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Teclado numérico">
      {TECLAS.map((tecla) => (
        <Button
          key={tecla}
          type="button"
          variant="outline"
          size="keypad"
          disabled={deshabilitado}
          onClick={() => onDigito(tecla)}
        >
          {tecla}
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="keypad"
        disabled={deshabilitado}
        onClick={onBorrar}
        aria-label="Borrar"
      >
        ⌫
      </Button>
      <Button
        type="button"
        variant="outline"
        size="keypad"
        disabled={deshabilitado}
        onClick={() => onDigito("0")}
      >
        0
      </Button>
      <Button
        type="button"
        size="keypad"
        disabled={deshabilitado || !puedeConfirmar}
        onClick={onConfirmar}
        aria-label="Confirmar"
      >
        OK
      </Button>
    </div>
  );
}
