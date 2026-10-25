"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Cargando } from "@/components/pantalla";
import { useSesion } from "@/lib/contexto";

export default function Raiz() {
  const router = useRouter();
  const sesion = useSesion();

  useEffect(() => {
    if (sesion === undefined) return;
    router.replace(sesion ? "/inicio" : "/ingresar");
  }, [sesion, router]);

  return <Cargando />;
}
