import { Agente } from "./agente";
import { leerConfig } from "./config";
import { ServidorSupabase } from "./conexion";

// El relevo LAN para el modo offline (§12.3) llega en la fase 3.
const config = leerConfig();
const agente = new Agente(new ServidorSupabase(config), config);

async function arrancar(): Promise<void> {
  // Sin red al encender el equipo: se reintenta cada 10 s hasta poder entrar.
  for (;;) {
    try {
      await agente.iniciar();
      return;
    } catch (e) {
      console.error(
        `${new Date().toISOString()} [print-agent] no se pudo iniciar: ${e instanceof Error ? e.message : e}`,
      );
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    void agente.detener().finally(() => process.exit(0));
  });
}

void arrancar();
