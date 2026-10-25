# Warike POS

Punto de venta en la nube para **Warike Resto Grill** (Perú). Reemplaza al sistema SHIOL instalado en un servidor local.

- La fuente de verdad del proyecto es [`docs/especificacion.md`](docs/especificacion.md) (v1.2).
- Las decisiones tomadas y las preguntas abiertas están en [`DECISIONS.md`](DECISIONS.md).

## Estado

| Fase              | Contenido                                                                                  | Estado                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 0. Fundaciones    | Monorepo, CI/CD, esquema completo con RLS, auditoría, `pin-login`, MFA, semillas, PWA base | ✅ Hecha (staging y producción pendientes de crear con la cuenta del cliente) |
| 1. Salón y cocina | Plano de mesas, carta, usuarios, pedidos, KDS, traslados, anulaciones, agente de impresión | Siguiente                                                                     |
| 2–5               | Caja y facturación, POS Niubiz, offline, NC, reportes, endurecimiento, multi-local         | Pendiente                                                                     |

## Estructura

```
apps/web            PWA Next.js 15 (salón, caja, KDS, admin, reportes)
apps/print-agent    Agente local de impresión ESC/POS y relevo LAN (fase 1)
packages/domain     Cálculos puros (precios, IGV, redondeo, fecha operativa…)
packages/billing-adapter   EmisorCPE: Nubefact (fase 2) y SUNAT directo (stub)
packages/id-lookup  Consulta de RUC/DNI (fase 2)
packages/payments-adapter  ProcesadorPOS: Niubiz, simulador y modo manual (fase 2)
packages/ui         Componentes compartidos (estilo shadcn/ui)
supabase/migrations SQL versionado (esquema, RLS, auditoría, autenticación PIN)
supabase/functions  Edge Functions (pin-login)
supabase/seed       Datos del cliente (plano, carta, series) y, en dev/, usuarios de prueba
supabase/tests      Pruebas pgTAP
tests/integracion   Pruebas de integración contra el stack local
docs/               Especificación, runbooks y manuales
```

## Desarrollo local

Requisitos: Node 20+, pnpm 10 (`corepack enable`) y Docker.

```bash
pnpm install
pnpm db:start                          # Supabase local: aplica migraciones y semillas
cp apps/web/.env.example apps/web/.env.local
pnpm dev                               # http://localhost:3000
```

- `pnpm db:reset` vuelve a aplicar las migraciones y las semillas desde cero.
- Studio queda en http://127.0.0.1:54323.

### Usuarios de desarrollo

Solo existen en local; los carga `supabase/seed/dev/`.

| Rol     | Acceso                                        | Credenciales                                  |
| ------- | --------------------------------------------- | --------------------------------------------- |
| Admin   | `/admin/ingresar`, enrola TOTP la primera vez | `admin@warike.test` / `Warike-Admin-2026`     |
| Auditor | `/admin/ingresar` + TOTP                      | `auditor@warike.test` / `Warike-Auditor-2026` |
| Mozo    | PIN en dispositivo                            | código `1001`, PIN `2580`                     |
| Cajero  | PIN en dispositivo                            | código `2001`, PIN `1470`                     |
| Cocina  | PIN en dispositivo                            | código `3001`, PIN `3690`                     |

Para probar el ingreso con PIN, primero registre el navegador como dispositivo de una de dos formas:

- En `/dispositivo`, con la cuenta de admin.
- Pegando en "Tengo un token" el token de la tablet de desarrollo: `wkd_` seguido de `a1` repetido 32 veces.

## Pruebas

```bash
pnpm lint && pnpm typecheck && pnpm test     # unitarias (Vitest)
pnpm db:test                                 # pgTAP: RLS, auditoría, pin-login, semillas
pnpm db:test:psql                            # las mismas pruebas, con psql (sin la imagen de pg_prove)
pnpm db:lint                                 # plpgsql_check sobre public y app
pnpm test:integracion                        # pin-login contra el stack local
pnpm --filter @warike/web build && pnpm --filter @warike/web e2e   # Playwright (tablet y desktop)
```

CI (`.github/workflows/ci.yml`) ejecuta todo lo anterior en cada PR.

## Modelo de acceso (§4)

- **Admin y auditor:** email, contraseña y TOTP obligatorio. Sus roles solo son efectivos en sesiones `aal2`; sin el segundo factor no ven datos.
- **Mozo, cajero y cocina:** código y PIN en un **dispositivo registrado**. La Edge Function `pin-login` emite una sesión de Supabase ligada al dispositivo por 12 h.
  - 5 PIN fallidos bloquean al usuario 15 min.
  - Desactivar el dispositivo corta sus sesiones al instante.
- **RLS en todas las tablas**, filtrada por local y por permiso.
  - Lo transaccional solo se escribe por RPC o Edge Functions.
  - `audit_log` es append-only, incluso para `service_role`.

Más detalle en [`DECISIONS.md`](DECISIONS.md), decisiones D-002 a D-007.

## Despliegue

- **Migraciones y Edge Functions:** `.github/workflows/deploy.yml` despliega tras un CI verde en `main`, primero a staging y luego a producción con aprobación manual.
- **Frontend:** Vercel o Cloudflare Pages.
- **Puesta en marcha:** [`docs/runbook-entornos.md`](docs/runbook-entornos.md).
