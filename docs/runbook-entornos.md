# Runbook: entornos staging y producción

Cómo crear y configurar los entornos de Supabase, GitHub y el hosting del frontend (§3, §15 fase 0, §17).
**Nunca** se edita la base de producción a mano: todo cambio de esquema va por migraciones.

## 1. Proyectos de Supabase

Se crean con la cuenta de la organización del cliente, con MFA y al menos dos administradores (§14.2).

1. Cree dos proyectos en la región **South America (São Paulo) `sa-east-1`**: `warike-pos-staging` y `warike-pos-production`. Producción va en plan **Pro** (backups diarios, §14.4).
2. Guarde la contraseña de la base de cada proyecto en el gestor de secretos del equipo.
3. En **Authentication → Sign In / Providers**:
   - Desactive "Allow new users to sign up". Los usuarios los crea el admin.
   - Mantenga habilitado el proveedor **Email**, porque admin y auditor entran con email y contraseña.
4. En **Authentication → Multi-Factor**: habilite **TOTP** (enroll y verify).
5. En **Authentication → Rate Limits**: suba **Token verifications** a 300 cada 5 min. `pin-login` canjea un enlace mágico por cada ingreso con PIN y todas las verificaciones salen desde la IP de la Edge Function (DECISIONS D-002).
6. En **Authentication → URL Configuration**: ponga como Site URL la URL del frontend del entorno.
7. Confirme que el plan incluye **pg_cron**. La migración `1100` agenda la purga de sesiones PIN vencidas.

## 2. GitHub

1. **Settings → Environments**: cree `staging` y `production`. En `production` active **Required reviewers**; esa es la aprobación manual de §3.
2. En cada environment defina:
   - Secret `SUPABASE_ACCESS_TOKEN`: token personal de Supabase de una cuenta de servicio.
   - Secret `SUPABASE_DB_PASSWORD`: contraseña de la base de ese proyecto.
   - Variable `SUPABASE_PROJECT_REF`: el `ref` del proyecto (aparece en la URL del panel).
3. Proteja la rama `main`: PR obligatorio con el CI en verde.
4. Con esto, cada merge a `main` corre `deploy.yml`: migraciones y Edge Functions en staging, y luego en producción tras la aprobación. Hasta que existan los secretos, el workflow se omite sin fallar.

## 3. Datos iniciales

1. Complete los valores "POR CONFIRMAR" de `supabase/seed/00_warike_resto_grill.sql` (RUC, razón social y direcciones; DECISIONS P9).
2. Aplique la semilla. Es idempotente:

   ```bash
   psql "postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" \
     -v ON_ERROR_STOP=1 -f supabase/seed/00_warike_resto_grill.sql
   ```

3. **No** aplique `supabase/seed/dev/`: contiene usuarios y tokens de prueba.

## 4. Primer administrador

Mientras la pantalla de usuarios (M4, fase 1) no existe, el primer admin se crea así:

1. En **Authentication → Users → Add user**, cree el usuario con su email real y una contraseña robusta (mínimo 12 caracteres, con mayúsculas, minúsculas y dígitos).
2. En el SQL Editor, cree su perfil y asígnele el rol `admin` en el local:

   ```sql
   insert into public.usuarios_perfil (user_id, nombre_visible, codigo_empleado)
   values ('<uuid del usuario>', '<Nombre Apellido>', '<código opcional para autorizar con PIN>');

   insert into public.user_local_roles (user_id, local_id, role_id)
   select '<uuid del usuario>', 'b0000000-0000-4000-8000-000000000001', id
   from public.roles where empresa_id is null and codigo = 'admin';
   ```

3. La primera vez que entre a `/admin/ingresar`, la PWA le pedirá enrolar el TOTP. Sin ese paso no ve datos.
4. Repita el procedimiento con un segundo administrador (§14.2).

## 5. Dispositivos

1. Con la cuenta de admin, abra la PWA en cada tablet, PC de caja o pantalla de cocina.
2. Vaya a **Registrar dispositivo**. El token queda solo en ese equipo y el admin sale de su sesión.
3. Si un equipo se pierde o se reinstala, desactívelo en `dispositivos` (`activo = false`). Sus sesiones se cortan al instante; registre el equipo nuevo.

## 6. Frontend

1. Despliegue `apps/web` en Vercel o Cloudflare Pages, con estas variables de entorno:
   - `NEXT_PUBLIC_SUPABASE_URL`: `https://<ref>.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: la clave publicable o anon. **Nunca** la `service_role`.
2. En las Edge Functions, defina el secreto `WARIKE_ALLOWED_ORIGINS` con el dominio del frontend:

   ```bash
   supabase secrets set --project-ref <ref> WARIKE_ALLOWED_ORIGINS=https://<dominio-del-frontend>
   ```
