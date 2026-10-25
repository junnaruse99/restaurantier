-- =============================================================================
-- Warike POS — 0200 Organización y configuración (§5.1)
-- =============================================================================

create table public.empresas (
  id uuid primary key default gen_random_uuid(),
  ruc text not null unique check (ruc ~ '^(10|15|17|20)[0-9]{9}$'),
  razon_social text not null,
  nombre_comercial text,
  direccion_fiscal text,
  ubigeo text check (ubigeo ~ '^[0-9]{6}$'),
  regimen_igv text not null default 'MYPE_RESTAURANTE'
    check (regimen_igv in ('MYPE_RESTAURANTE', 'GENERAL')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.locales (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id),
  nombre text not null,
  codigo_establecimiento_sunat text not null default '0000'
    check (codigo_establecimiento_sunat ~ '^[0-9]{4}$'),
  direccion text,
  hora_corte_operativa time not null default '05:00',
  -- §10.3: cambiar de emisor es solo configuración por local.
  proveedor_cpe text not null default 'nubefact' check (proveedor_cpe in ('nubefact', 'sunat_directo')),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (empresa_id, codigo_establecimiento_sunat),
  unique (empresa_id, nombre)
);
create index locales_empresa_idx on public.locales (empresa_id);

create table public.config_local (
  local_id uuid primary key references public.locales (id),
  descuento_personal_pct numeric(5, 2) not null default 15
    check (descuento_personal_pct between 0 and 100),
  umbral_dni_boleta numeric(12, 2) not null default 700.00 check (umbral_dni_boleta >= 0),
  umbral_egreso_pin numeric(12, 2) not null default 100.00 check (umbral_egreso_pin >= 0),
  umbral_alerta_diferencia_caja numeric(12, 2) not null default 20.00
    check (umbral_alerta_diferencia_caja >= 0),
  propina_habilitada boolean not null default false,
  modo_liquidacion_personal text not null default 'pago_inmediato'
    check (modo_liquidacion_personal in ('pago_inmediato', 'cuenta_empleado')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

-- Tasas tributarias por régimen y vigencia. empresa_id null = tasa global.
-- Nunca se escriben tasas en el código (§9): se consultan aquí según régimen y fecha de emisión.
create table public.config_tributaria (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references public.empresas (id),
  regimen text not null check (regimen in ('MYPE_RESTAURANTE', 'GENERAL')),
  vigencia_desde date not null,
  vigencia_hasta date,
  tasa_igv numeric(6, 4) not null check (tasa_igv >= 0),
  tasa_ipm numeric(6, 4) not null check (tasa_ipm >= 0),
  tasa_total numeric(6, 4) not null,
  icbper_unitario numeric(12, 2) not null check (icbper_unitario >= 0),
  created_at timestamptz not null default now(),
  check (tasa_total = tasa_igv + tasa_ipm),
  check (vigencia_hasta is null or vigencia_hasta >= vigencia_desde),
  -- Sin solapamiento de vigencias para el mismo ámbito y régimen.
  constraint config_tributaria_sin_solape exclude using gist (
    (coalesce(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    regimen with =,
    daterange(vigencia_desde, vigencia_hasta, '[]') with &&
  )
);

-- Plazos SUNAT vigentes desde una fecha (el registro vigente es el de mayor vigencia_desde <= fecha).
create table public.config_plazos_cpe (
  id uuid primary key default gen_random_uuid(),
  vigencia_desde date not null unique,
  plazo_envio_factura_dias smallint not null default 3 check (plazo_envio_factura_dias > 0),
  plazo_envio_boleta_dias smallint not null default 5 check (plazo_envio_boleta_dias > 0),
  plazo_resumen_dias smallint not null default 7 check (plazo_resumen_dias > 0),
  plazo_baja_dias smallint not null default 7 check (plazo_baja_dias > 0),
  base_plazo_baja text not null check (base_plazo_baja in ('desde_cdr', 'desde_generacion')),
  created_at timestamptz not null default now()
);

create table public.series_cpe (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  tipo_cpe text not null check (tipo_cpe in ('01', '03', '07', '08')),
  serie text not null,
  ultimo_numero integer not null default 0 check (ultimo_numero between 0 and 99999999),
  activa boolean not null default true,
  -- Serie de contingencia configurable (§5.1).
  es_contingencia boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (local_id, serie),
  check (
    (es_contingencia and serie ~ '^[0-9]{4}$')
    or (
      not es_contingencia
      and serie ~ '^[FB][A-Z0-9]{3}$'
      and (tipo_cpe <> '01' or serie like 'F%')
      and (tipo_cpe <> '03' or serie like 'B%')
    )
  )
);

create table public.dispositivos (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  nombre text not null,
  tipo text not null check (tipo in ('tablet_mozo', 'caja', 'kds', 'agente_impresion')),
  -- SHA-256 (hex) del token entregado al registrar el dispositivo. El token nunca se guarda.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  ultimo_ping timestamptz,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id)
);
create index dispositivos_local_idx on public.dispositivos (local_id);

create table public.impresoras (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  nombre text not null,
  tipo_conexion text not null check (tipo_conexion in ('tcp', 'usb')),
  host text,
  puerto integer default 9100 check (puerto between 1 and 65535),
  ancho_mm smallint not null default 80 check (ancho_mm in (58, 80)),
  agente_id uuid,
  estado text not null default 'ok' check (estado in ('ok', 'sin_papel', 'offline', 'error')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, nombre),
  check (tipo_conexion <> 'tcp' or host is not null),
  foreign key (agente_id, local_id) references public.dispositivos (id, local_id)
);

create table public.estaciones_produccion (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  nombre text not null,
  impresora_id uuid,
  muestra_kds boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, nombre),
  foreign key (impresora_id, local_id) references public.impresoras (id, local_id)
);

-- local_id null = feriado nacional, válido para todos los locales.
create table public.feriados (
  id uuid primary key default gen_random_uuid(),
  local_id uuid references public.locales (id),
  fecha date not null,
  descripcion text not null,
  se_trata_como_domingo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (local_id, fecha)
);

create trigger empresas_updated_at before update on public.empresas
  for each row execute function app.set_updated_at();
create trigger locales_updated_at before update on public.locales
  for each row execute function app.set_updated_at();
create trigger config_local_updated_at before update on public.config_local
  for each row execute function app.set_updated_at();
create trigger series_cpe_updated_at before update on public.series_cpe
  for each row execute function app.set_updated_at();
create trigger dispositivos_updated_at before update on public.dispositivos
  for each row execute function app.set_updated_at();
create trigger impresoras_updated_at before update on public.impresoras
  for each row execute function app.set_updated_at();
create trigger estaciones_produccion_updated_at before update on public.estaciones_produccion
  for each row execute function app.set_updated_at();
create trigger feriados_updated_at before update on public.feriados
  for each row execute function app.set_updated_at();

-- Los correlativos nunca se pierden.
create trigger series_cpe_sin_borrado before delete on public.series_cpe
  for each row execute function app.prohibir_borrado();
