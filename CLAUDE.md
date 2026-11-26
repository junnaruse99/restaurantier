# Guía para agentes

- **Especificación:** `docs/especificacion.md` es la fuente de verdad. Se sigue en orden de fases (§15).
- **Ambigüedades:** se elige la opción más simple que cumpla los criterios de aceptación y se registra en `DECISIONS.md`. Nada fuera de alcance sin proponerlo primero ahí.
- **Idioma:** todo en español (código de dominio, UI, comentarios y mensajes de commit). Zona horaria `America/Lima`; moneda PEN.

## Comandos

```bash
pnpm install
pnpm db:start / pnpm db:reset      # Supabase local con migraciones y semillas
pnpm lint && pnpm typecheck && pnpm test
pnpm db:test                       # pgTAP (supabase/tests/database)
pnpm db:lint
pnpm test:integracion              # requiere el stack local
pnpm --filter @warike/web e2e      # requiere el stack local y el build de la web
pnpm --filter @warike/print-agent simulador   # impresoras simuladas en 127.0.0.1:9101-9103
```

## Reglas de la base de datos

- Cada cambio de esquema es una **migración nueva** en `supabase/migrations`. No se editan migraciones ya desplegadas.
- **RLS en toda tabla nueva**, con privilegios explícitos para `authenticated` y `service_role`. `01_esquema.test.sql` falla si falta alguno.
- Las políticas filtran por `local_id in (select app.locales_con_permiso('<permiso>'))`.
- Lo transaccional se escribe con RPC `SECURITY DEFINER` con `set search_path = ''`, que validan permisos con `app.tiene_permiso` y hacen `revoke ... from public, anon`.
- Las RPC fallan con `app.fallar(estado_http, 'codigo_estable', 'mensaje')`; las mutaciones de salón aceptan `p_client_mutation_id` (`app.inicio_mutacion` / `app.registrar_mutacion`).
- **Sin borrado físico** en tablas transaccionales: se agrega el trigger `app.prohibir_borrado` y la auditoría con `app.auditar_cambio`.
- Los cálculos de dinero van en `packages/domain` (cobertura ≥ 90 %), nunca solo en el cliente. Las tasas se leen de `config_tributaria`.
