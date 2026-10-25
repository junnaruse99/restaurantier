import type { Metadata } from "next";
import { Pantalla } from "@/components/pantalla";

export const metadata: Metadata = { title: "Sin conexión" };

export default function SinConexion() {
  return (
    <Pantalla
      titulo="Sin conexión"
      descripcion="No hay conexión a internet. Cuando vuelva, la aplicación se recargará sola."
    >
      <p className="text-sm text-muted-foreground">
        El trabajo sin internet (pedidos, comandas y cobros con ticket provisional) llega en la fase
        3.
      </p>
    </Pantalla>
  );
}
