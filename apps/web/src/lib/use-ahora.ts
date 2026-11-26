"use client";

import { useEffect, useState } from "react";

/** Hora actual que se actualiza cada `cadaMs` (minutos en mesas y tickets del KDS). */
export function useAhora(cadaMs = 30_000): Date {
  const [ahora, setAhora] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAhora(new Date()), cadaMs);
    return () => clearInterval(t);
  }, [cadaMs]);
  return ahora;
}
