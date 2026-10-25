import { Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from "@warike/ui";
import type { ReactNode } from "react";

/** Contenedor centrado de las pantallas de acceso. */
export function Pantalla({
  titulo,
  descripcion,
  children,
  ancho = "max-w-md",
}: {
  titulo: string;
  descripcion?: ReactNode;
  children: ReactNode;
  ancho?: string;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className={cn("w-full", ancho)}>
        <p className="mb-4 text-center text-sm font-semibold uppercase tracking-[0.2em] text-primary">
          Warike POS
        </p>
        <Card>
          <CardHeader>
            <CardTitle>{titulo}</CardTitle>
            {descripcion ? <CardDescription>{descripcion}</CardDescription> : null}
          </CardHeader>
          <CardContent className="space-y-4">{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}

export function Cargando({ texto = "Cargando…" }: { texto?: string }) {
  return (
    <main
      className="flex min-h-dvh items-center justify-center p-4 text-muted-foreground"
      aria-busy="true"
    >
      {texto}
    </main>
  );
}
