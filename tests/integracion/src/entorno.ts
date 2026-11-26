// Valores del stack local de `supabase start` (demo, públicos). Se pueden sobrescribir por entorno.
export const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
export const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
export const FUNCTIONS_URL = process.env.FUNCTIONS_URL ?? `${SUPABASE_URL}/functions/v1`;
export const PIN_LOGIN_URL = process.env.PIN_LOGIN_URL ?? `${FUNCTIONS_URL}/pin-login`;

/** Local y usuarios de supabase/seed (semilla del cliente + usuarios de desarrollo). */
export const LOCAL_GRILL = "b0000000-0000-4000-8000-000000000001";
export const MOZO = { codigo: "1001", pin: "2580", id: "d0000000-0000-4000-8000-000000000003" };
export const CAJERO = { codigo: "2001", pin: "1470" };
export const ADMIN = { codigo: "9001", pin: "7531" };
