import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Next.js reemplaza estas variables en el build; deben leerse con su nombre literal.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

let cliente: SupabaseClient | null = null;

/** Cliente de Supabase del navegador (sesión persistente y renovación automática). */
export function supabase(): SupabaseClient {
  if (!cliente) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error(
        "Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (ver apps/web/.env.example)",
      );
    }
    cliente = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "warike-pos-auth" },
    });
  }
  return cliente;
}
