import { leerConfig } from "./config";

// Fase 0: solo el punto de entrada. La suscripción a print_jobs, las plantillas ESC/POS
// y el relevo LAN se construyen en la fase 1 (§13 y §12.3).
const config = leerConfig();
console.log(
  `[print-agent] configurado para ${config.supabaseUrl}; polling cada ${config.pollingMs} ms; LAN en :${config.puertoLan}`,
);
