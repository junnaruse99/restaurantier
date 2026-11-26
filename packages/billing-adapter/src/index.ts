// La implementación vive junto a la Edge Function emitir-cpe (Deno) para que se despliegue con ella;
// este paquete la expone a Node para las pruebas y los tipos (DECISIONS D-045).
export * from "../../../supabase/functions/_shared/cpe/tipos.ts";
export * from "../../../supabase/functions/_shared/cpe/nubefact.ts";
export * from "../../../supabase/functions/_shared/cpe/sunat-directo.ts";
