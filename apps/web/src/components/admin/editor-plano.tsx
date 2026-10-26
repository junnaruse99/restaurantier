"use client";

import type Konva from "konva";
import { useEffect, useRef, useState } from "react";
import { Ellipse, Group, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import type { Mesa, Piso } from "@/lib/salon";

const RETICULA = 10;
const ajustar = (v: number) => Math.round(v / RETICULA) * RETICULA;

const RELLENO: Record<string, string> = {
  mesa: "#d1fae5",
  barra: "#fde68a",
  auxiliar: "#bae6fd",
};

export interface CambioMesa {
  pos_x: number;
  pos_y: number;
  ancho?: number;
  alto?: number;
  rotacion?: number;
}

/**
 * Lienzo del plano (CU1.1): se arrastran las mesas y, con la seleccionada, se cambia tamaño y
 * rotación. Al soltar se guardan x, y, ancho, alto y rotación (ajustados a una retícula de 10 px).
 */
export default function EditorPlano({
  piso,
  mesas,
  seleccionada,
  alSeleccionar,
  alCambiar,
}: {
  piso: Piso;
  mesas: readonly Mesa[];
  seleccionada: string | null;
  alSeleccionar: (id: string | null) => void;
  alCambiar: (id: string, cambio: CambioMesa) => void;
}) {
  const contenedor = useRef<HTMLDivElement>(null);
  const transformador = useRef<Konva.Transformer>(null);
  const nodos = useRef(new Map<string, Konva.Group>());
  const [ancho, setAncho] = useState(800);

  useEffect(() => {
    const el = contenedor.current;
    if (!el) return;
    const observador = new ResizeObserver(([e]) =>
      setAncho(Math.max(320, Math.floor(e!.contentRect.width))),
    );
    observador.observe(el);
    return () => observador.disconnect();
  }, []);

  useEffect(() => {
    const nodo = seleccionada ? nodos.current.get(seleccionada) : undefined;
    transformador.current?.nodes(nodo ? [nodo] : []);
    transformador.current?.getLayer()?.batchDraw();
  }, [seleccionada, mesas]);

  const escala = ancho / piso.ancho_canvas;
  const lineas: number[][] = [];
  for (let x = 0; x <= piso.ancho_canvas; x += 50) lineas.push([x, 0, x, piso.alto_canvas]);
  for (let y = 0; y <= piso.alto_canvas; y += 50) lineas.push([0, y, piso.ancho_canvas, y]);

  return (
    <div
      ref={contenedor}
      className="w-full overflow-hidden rounded-lg border bg-white"
      data-testid="editor-plano"
    >
      <Stage
        width={ancho}
        height={piso.alto_canvas * escala}
        scaleX={escala}
        scaleY={escala}
        onMouseDown={(e) => e.target === e.target.getStage() && alSeleccionar(null)}
        onTouchStart={(e) => e.target === e.target.getStage() && alSeleccionar(null)}
      >
        <Layer listening={false}>
          {lineas.map((p, i) => (
            <Line key={i} points={p} stroke="#f1f5f9" strokeWidth={1} />
          ))}
        </Layer>
        <Layer>
          {mesas
            .filter((m) => m.piso_id === piso.id)
            .map((m) => {
              const virtual = m.tipo.startsWith("virtual");
              const relleno = virtual ? "#ede9fe" : (RELLENO[m.tipo] ?? "#e5e7eb");
              const borde = m.id === seleccionada ? "#0284c7" : "#334155";
              return (
                <Group
                  key={m.id}
                  ref={(n) => {
                    if (n) nodos.current.set(m.id, n);
                    else nodos.current.delete(m.id);
                  }}
                  x={m.pos_x + m.ancho / 2}
                  y={m.pos_y + m.alto / 2}
                  offsetX={m.ancho / 2}
                  offsetY={m.alto / 2}
                  rotation={Number(m.rotacion)}
                  opacity={m.activa ? 1 : 0.35}
                  draggable
                  onMouseDown={() => alSeleccionar(m.id)}
                  onTap={() => alSeleccionar(m.id)}
                  dragBoundFunc={(p) => ({
                    x: Math.min(Math.max(p.x, 0), piso.ancho_canvas * escala),
                    y: Math.min(Math.max(p.y, 0), piso.alto_canvas * escala),
                  })}
                  onDragEnd={(e) => {
                    const n = e.target;
                    const x = ajustar(n.x() - m.ancho / 2);
                    const y = ajustar(n.y() - m.alto / 2);
                    n.position({ x: x + m.ancho / 2, y: y + m.alto / 2 });
                    alCambiar(m.id, { pos_x: x, pos_y: y });
                  }}
                  onTransformEnd={(e) => {
                    const n = e.target;
                    const nuevoAncho = Math.max(40, ajustar(m.ancho * n.scaleX()));
                    const nuevoAlto = Math.max(40, ajustar(m.alto * n.scaleY()));
                    n.scale({ x: 1, y: 1 });
                    alCambiar(m.id, {
                      pos_x: ajustar(n.x() - nuevoAncho / 2),
                      pos_y: ajustar(n.y() - nuevoAlto / 2),
                      ancho: nuevoAncho,
                      alto: nuevoAlto,
                      rotacion: Math.round(n.rotation()),
                    });
                  }}
                >
                  {m.forma === "circle" ? (
                    <Ellipse
                      x={m.ancho / 2}
                      y={m.alto / 2}
                      radiusX={m.ancho / 2}
                      radiusY={m.alto / 2}
                      fill={relleno}
                      stroke={borde}
                      strokeWidth={2}
                      dash={virtual ? [6, 4] : undefined}
                    />
                  ) : (
                    <Rect
                      width={m.ancho}
                      height={m.alto}
                      cornerRadius={8}
                      fill={relleno}
                      stroke={borde}
                      strokeWidth={2}
                      dash={virtual ? [6, 4] : undefined}
                    />
                  )}
                  <Text
                    text={m.codigo}
                    width={m.ancho}
                    height={m.alto}
                    align="center"
                    verticalAlign="middle"
                    fontSize={Math.min(22, m.alto / 2.5)}
                    fontStyle="bold"
                    fill="#0f172a"
                    listening={false}
                  />
                </Group>
              );
            })}
          <Transformer
            ref={transformador}
            rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
            boundBoxFunc={(viejo, nuevo) => (nuevo.width < 30 || nuevo.height < 30 ? viejo : nuevo)}
          />
        </Layer>
      </Stage>
    </div>
  );
}
