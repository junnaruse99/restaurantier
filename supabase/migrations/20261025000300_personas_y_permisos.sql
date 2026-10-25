-- =============================================================================
-- Warike POS — 0300 Personas, roles y permisos (§4, §5.3)
-- =============================================================================

create table public.empleados (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  -- DNI (8 dígitos) o carné de extranjería (hasta 12 caracteres).
  dni text check (dni ~ '^[0-9A-Z]{8,12}$'),
  nombres text not null,
  apellidos text not null,
  cargo text not null
    check (cargo in ('mozo', 'cajero', 'cocinero', 'ayudante', 'barman', 'administrador', 'otro')),
  fecha_ingreso date,
  sueldo_base numeric(12, 2) check (sueldo_base >= 0),
  telefono text,
  limite_consumo_mensual numeric(12, 2) check (limite_consumo_mensual >= 0),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, dni)
);

-- Perfil de aplicación de cada usuario de Supabase Auth.
-- El hash del PIN NO vive aquí: está en app.pin_credenciales, fuera de la API (ver DECISIONS.md).
create table public.usuarios_perfil (
  user_id uuid primary key references auth.users (id),
  empleado_id uuid references public.empleados (id),
  codigo_empleado text unique check (codigo_empleado ~ '^[0-9A-Za-z]{3,12}$'),
  nombre_visible text not null,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index usuarios_perfil_empleado_idx on public.usuarios_perfil (empleado_id);

-- Credenciales PIN (§4.1): hash bcrypt, intentos fallidos y bloqueo temporal.
create table app.pin_credenciales (
  user_id uuid primary key references public.usuarios_perfil (user_id),
  pin_hash text not null,
  intentos_fallidos smallint not null default 0 check (intentos_fallidos >= 0),
  bloqueado_hasta timestamptz,
  actualizado_at timestamptz not null default now(),
  actualizado_por uuid
);

-- Catálogo de permisos granulares.
create table public.permissions (
  codigo text primary key check (codigo ~ '^[a-z][a-z0-9_]+$'),
  modulo text not null,
  descripcion text not null
);

-- Roles: empresa_id null = rol base del sistema (solo se modifica por migración).
-- El admin puede crear roles propios de su empresa.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references public.empresas (id),
  codigo text not null check (codigo ~ '^[a-z][a-z0-9_]+$'),
  nombre text not null,
  -- Los roles que exigen MFA (admin, auditor) solo son efectivos en sesiones aal2,
  -- nunca en una sesión iniciada con PIN.
  requiere_mfa boolean not null default false,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (empresa_id, codigo)
);

create table public.role_permissions (
  role_id uuid not null references public.roles (id),
  permission_codigo text not null references public.permissions (codigo),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  primary key (role_id, permission_codigo)
);

-- Un usuario puede tener roles distintos en cada local.
create table public.user_local_roles (
  user_id uuid not null references public.usuarios_perfil (user_id),
  local_id uuid not null references public.locales (id),
  role_id uuid not null references public.roles (id),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  primary key (user_id, local_id, role_id)
);
create index user_local_roles_local_idx on public.user_local_roles (local_id);
create index user_local_roles_role_idx on public.user_local_roles (role_id);

-- Sesiones iniciadas con PIN en un dispositivo registrado (§4.1): 12 h, ligadas al device_id.
-- session_id es el claim `session_id` del JWT emitido por Supabase Auth.
create table app.sesiones_dispositivo (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique,
  user_id uuid not null references public.usuarios_perfil (user_id),
  dispositivo_id uuid not null,
  local_id uuid not null,
  creada_at timestamptz not null default now(),
  expira_at timestamptz not null,
  revocada_at timestamptz,
  foreign key (dispositivo_id, local_id) references public.dispositivos (id, local_id),
  check (expira_at > creada_at)
);
create index sesiones_dispositivo_dispositivo_idx on app.sesiones_dispositivo (dispositivo_id);
create index sesiones_dispositivo_user_idx on app.sesiones_dispositivo (user_id);

-- Clientes (catálogo 06 de SUNAT). Se comparten entre los locales de una misma empresa.
create table public.clientes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id),
  tipo_doc text not null check (tipo_doc in ('0', '1', '4', '6', '7')),
  num_doc text not null,
  nombre_razon_social text not null,
  direccion text,
  email text,
  telefono text,
  consentimiento_marketing boolean not null default false,
  consentimiento_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (empresa_id, tipo_doc, num_doc),
  check (tipo_doc <> '6' or num_doc ~ '^(10|15|17|20)[0-9]{9}$'),
  check (tipo_doc <> '1' or num_doc ~ '^[0-9]{8}$'),
  check (not consentimiento_marketing or consentimiento_at is not null)
);

-- Caché de consultas RUC/DNI (§11). Solo la usa la Edge Function lookup-doc.
create table public.doc_cache (
  id uuid primary key default gen_random_uuid(),
  tipo_doc text not null check (tipo_doc in ('1', '6')),
  num_doc text not null,
  payload jsonb not null,
  proveedor text not null,
  consultado_at timestamptz not null default now(),
  unique (tipo_doc, num_doc)
);

create trigger empleados_updated_at before update on public.empleados
  for each row execute function app.set_updated_at();
create trigger usuarios_perfil_updated_at before update on public.usuarios_perfil
  for each row execute function app.set_updated_at();
create trigger roles_updated_at before update on public.roles
  for each row execute function app.set_updated_at();
create trigger clientes_updated_at before update on public.clientes
  for each row execute function app.set_updated_at();

-- M2: un empleado nunca se borra, solo se desactiva. Lo mismo para los usuarios.
create trigger empleados_sin_borrado before delete on public.empleados
  for each row execute function app.prohibir_borrado();
create trigger usuarios_perfil_sin_borrado before delete on public.usuarios_perfil
  for each row execute function app.prohibir_borrado();
