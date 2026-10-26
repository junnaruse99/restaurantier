import { ImpresoraSimulada } from "./simulador";

// Impresoras simuladas de la semilla de desarrollo (Cocina, Parrilla y Bar en 127.0.0.1:9101-9103).
// Uso: pnpm --filter @warike/print-agent simulador [puerto...]
const puertos = process.argv.slice(2).map(Number);
for (const puerto of puertos.length ? puertos : [9101, 9102, 9103]) {
  const impresora = new ImpresoraSimulada((ticket) => {
    console.log(
      `\n===== :${puerto} ${new Date().toLocaleTimeString("es-PE")} =====\n${ticket.texto}`,
    );
  });
  await impresora.escuchar(puerto);
  console.log(`impresora simulada en 127.0.0.1:${puerto}`);
}
