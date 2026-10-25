-- =============================================================================
-- Warike POS — 0400 Plano de mesas (§5.2) y carta (§5.4)
-- =============================================================================

create table public.pisos (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  nombre text not null,
  orden smallint not null default 0,
  ancho_canvas integer not null default 1200 check (ancho_canvas > 0),
  alto_canvas integer not null default 800 check (alto_canvas > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, nombre)
);

create table public.mesas (
  id uuid primary key default gen_random_uuid(),
  piso_id uuid not null,
  local_id uuid not null references public.locales (id),
  -- Texto libre: "01" y "1" son mesas distintas.
  codigo text not null check (length(codigo) between 1 and 20),
  nombre_visible text,
  tipo text not null default 'mesa' check (
    tipo in ('mesa', 'barra', 'auxiliar', 'virtual_delivery', 'virtual_auditor', 'virtual_llevar', 'virtual_personal')
  ),
  capacidad smallint not null default 4 check (capacidad >= 0),
  pos_x integer not null default 0,
  pos_y integer not null default 0,
  ancho integer not null default 80 check (ancho > 0),
  alto integer not null default 80 check (alto > 0),
  forma text not null default 'rect' check (forma in ('rect', 'circle')),
  rotacion numeric(6, 2) not null default 0,
  activa boolean not null default true,
  estado text not null default 'libre'
    check (estado in ('libre', 'ocupada', 'precuenta', 'por_limpiar', 'bloqueada')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, codigo),
  foreign key (piso_id, local_id) references public.pisos (id, local_id)
);
create index mesas_piso_idx on public.mesas (piso_id);

create table public.categorias (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  nombre text not null,
  orden smallint not null default 0,
  estacion_produccion_id_default uuid,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, nombre),
  foreign key (estacion_produccion_id_default, local_id)
    references public.estaciones_produccion (id, local_id)
);

create table public.productos (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  categoria_id uuid not null,
  codigo text,
  nombre text not null,
  descripcion text,
  -- Precio de carta con IGV incluido (§9).
  precio numeric(12, 2) not null check (precio >= 0),
  afectacion_igv text not null default '10' check (afectacion_igv in ('10', '20', '30')),
  aplica_icbper boolean not null default false,
  estacion_produccion_id uuid,
  es_menu_del_dia boolean not null default false,
  disponible boolean not null default true,
  controla_stock boolean not null default false,
  stock_actual numeric(12, 2),
  imagen_url text,
  -- Retiro definitivo de la carta (distinto de "agotado", que es disponible = false).
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, codigo),
  foreign key (categoria_id, local_id) references public.categorias (id, local_id),
  foreign key (estacion_produccion_id, local_id) references public.estaciones_produccion (id, local_id),
  check (not controla_stock or stock_actual is not null)
);
create index productos_categoria_idx on public.productos (categoria_id);

create table public.producto_precio_historial (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  producto_id uuid not null,
  precio_anterior numeric(12, 2) not null,
  precio_nuevo numeric(12, 2) not null,
  motivo text not null,
  cambiado_por uuid,
  created_at timestamptz not null default now(),
  foreign key (producto_id, local_id) references public.productos (id, local_id)
);
create index producto_precio_historial_producto_idx on public.producto_precio_historial (producto_id, created_at);

create table public.modificadores (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  grupo text not null,
  nombre text not null,
  precio_extra numeric(12, 2) not null default 0 check (precio_extra >= 0),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (local_id, grupo, nombre)
);

create table public.producto_modificadores (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  producto_id uuid not null,
  grupo text not null,
  obligatorio boolean not null default false,
  min smallint not null default 0,
  max smallint not null default 1,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (producto_id, grupo),
  foreign key (producto_id, local_id) references public.productos (id, local_id),
  check (min >= 0 and max >= min and max > 0),
  check (not obligatorio or min >= 1)
);

-- Precio por día de la semana (0 = domingo … 6 = sábado), con vigencia (M5).
create table public.reglas_precio_dia (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  producto_id uuid not null,
  dia_semana smallint not null check (dia_semana between 0 and 6),
  precio numeric(12, 2) not null check (precio >= 0),
  vigencia_desde date not null,
  vigencia_hasta date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  foreign key (producto_id, local_id) references public.productos (id, local_id),
  check (vigencia_hasta is null or vigencia_hasta >= vigencia_desde),
  constraint reglas_precio_dia_sin_solape exclude using gist (
    producto_id with =,
    dia_semana with =,
    daterange(vigencia_desde, vigencia_hasta, '[]') with &&
  )
);

create table public.menu_diario (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  fecha date not null,
  producto_id uuid not null,
  entradas text[] not null default '{}',
  segundos text[] not null default '{}',
  postre text,
  bebida text,
  cantidad_disponible integer check (cantidad_disponible >= 0),
  publicado boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (local_id, fecha, producto_id),
  foreign key (producto_id, local_id) references public.productos (id, local_id)
);

create trigger pisos_updated_at before update on public.pisos
  for each row execute function app.set_updated_at();
create trigger mesas_updated_at before update on public.mesas
  for each row execute function app.set_updated_at();
create trigger categorias_updated_at before update on public.categorias
  for each row execute function app.set_updated_at();
create trigger productos_updated_at before update on public.productos
  for each row execute function app.set_updated_at();
create trigger modificadores_updated_at before update on public.modificadores
  for each row execute function app.set_updated_at();
create trigger producto_modificadores_updated_at before update on public.producto_modificadores
  for each row execute function app.set_updated_at();
create trigger reglas_precio_dia_updated_at before update on public.reglas_precio_dia
  for each row execute function app.set_updated_at();
create trigger menu_diario_updated_at before update on public.menu_diario
  for each row execute function app.set_updated_at();

-- -----------------------------------------------------------------------------
-- Historial de precios (CU3.2): todo cambio de productos.precio exige motivo.
-- La RPC de cambio de precio (fase 1) fija el motivo con
--   set_config('warike.motivo_cambio_precio', <motivo>, true)
-- antes del UPDATE; sin motivo el cambio se rechaza.
-- -----------------------------------------------------------------------------
create or replace function app.registrar_cambio_precio()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_motivo text := nullif(trim(current_setting('warike.motivo_cambio_precio', true)), '');
begin
  if v_motivo is null then
    raise exception 'El cambio de precio de "%" requiere un motivo', new.nombre
      using errcode = 'check_violation';
  end if;
  insert into public.producto_precio_historial (local_id, producto_id, precio_anterior, precio_nuevo, motivo, cambiado_por)
  values (new.local_id, new.id, old.precio, new.precio, v_motivo, auth.uid());
  return new;
end;
$$;

create trigger productos_historial_precio
  after update of precio on public.productos
  for each row
  when (old.precio is distinct from new.precio)
  execute function app.registrar_cambio_precio();

create trigger producto_precio_historial_sin_borrado before delete on public.producto_precio_historial
  for each row execute function app.prohibir_borrado();
