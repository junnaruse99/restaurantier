-- =============================================================================
-- Warike POS — 0500 Operación: órdenes, ítems, comandas, anulaciones (§5.5)
-- =============================================================================
-- Todas las escrituras de estas tablas pasan por RPC transaccionales (fases 1–2);
-- los clientes no tienen INSERT/UPDATE directos.

create table public.ordenes (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  numero_dia integer not null check (numero_dia > 0),
  fecha_operativa date not null,
  tipo text not null default 'salon' check (tipo in ('salon', 'delivery', 'llevar', 'personal', 'auditor')),
  mesa_principal_id uuid,
  mozo_id uuid references public.usuarios_perfil (user_id),
  comensales smallint not null default 1 check (comensales > 0),
  cliente_id uuid references public.clientes (id),
  empleado_consumo_id uuid,
  estado text not null default 'abierta' check (estado in ('abierta', 'precuenta', 'pagada', 'anulada')),
  subtotal numeric(12, 2) not null default 0,
  descuento_total numeric(12, 2) not null default 0 check (descuento_total >= 0),
  total numeric(12, 2) not null default 0 check (total >= 0),
  nota text,
  datos_delivery jsonb,
  estado_delivery text check (estado_delivery in ('en_preparacion', 'en_camino', 'entregado')),
  abierta_at timestamptz not null default now(),
  cerrada_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, fecha_operativa, numero_dia),
  foreign key (mesa_principal_id, local_id) references public.mesas (id, local_id),
  foreign key (empleado_consumo_id, local_id) references public.empleados (id, local_id),
  check (tipo <> 'personal' or empleado_consumo_id is not null),
  check (estado_delivery is null or tipo in ('delivery', 'llevar'))
);
create index ordenes_local_estado_idx on public.ordenes (local_id, estado);
create index ordenes_local_fecha_idx on public.ordenes (local_id, fecha_operativa);
create index ordenes_empleado_consumo_idx on public.ordenes (empleado_consumo_id) where empleado_consumo_id is not null;

-- Una orden puede ocupar varias mesas. Al mover o separar, la unión se cierra con liberada_at
-- (no se borra) y se crea una nueva.
create table public.mesa_uniones (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  orden_id uuid not null,
  mesa_id uuid not null,
  es_principal boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  liberada_at timestamptz,
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (mesa_id, local_id) references public.mesas (id, local_id)
);
-- Una mesa solo puede estar en una orden activa, y cada orden activa tiene una sola mesa principal.
create unique index mesa_uniones_mesa_activa_uidx on public.mesa_uniones (mesa_id) where liberada_at is null;
create unique index mesa_uniones_principal_uidx on public.mesa_uniones (orden_id)
  where es_principal and liberada_at is null;

create table public.comandas (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  orden_id uuid not null,
  numero integer not null check (numero > 0),
  estacion_produccion_id uuid not null,
  enviada_por uuid references public.usuarios_perfil (user_id),
  enviada_at timestamptz not null default now(),
  reimpresiones integer not null default 0 check (reimpresiones >= 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (orden_id, estacion_produccion_id, numero),
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (estacion_produccion_id, local_id) references public.estaciones_produccion (id, local_id)
);

create table public.orden_items (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  orden_id uuid not null,
  producto_id uuid not null,
  nombre_snapshot text not null,
  cantidad numeric(8, 2) not null check (cantidad > 0),
  -- Precio con IGV vigente al agregar el ítem: los cambios de carta no alteran órdenes abiertas (CA M3).
  precio_unitario_snapshot numeric(14, 6) not null check (precio_unitario_snapshot >= 0),
  modificadores jsonb not null default '[]'::jsonb check (jsonb_typeof(modificadores) = 'array'),
  nota text,
  descuento_pct numeric(5, 2) not null default 0 check (descuento_pct between 0 and 100),
  descuento_monto numeric(12, 2) not null default 0 check (descuento_monto >= 0),
  total_linea numeric(12, 2) not null default 0 check (total_linea >= 0),
  cuenta_split smallint not null default 1 check (cuenta_split >= 1),
  estacion_produccion_id uuid,
  comanda_id uuid,
  estado text not null default 'borrador'
    check (estado in ('borrador', 'enviado', 'en_preparacion', 'listo', 'servido', 'anulado')),
  enviado_at timestamptz,
  anulado_at timestamptz,
  anulacion_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (producto_id, local_id) references public.productos (id, local_id),
  foreign key (estacion_produccion_id, local_id) references public.estaciones_produccion (id, local_id),
  foreign key (comanda_id, local_id) references public.comandas (id, local_id),
  check ((estado = 'anulado') = (anulado_at is not null)),
  check (estado = 'borrador' or estado = 'anulado' or enviado_at is not null)
);
create index orden_items_orden_idx on public.orden_items (orden_id);
create index orden_items_comanda_idx on public.orden_items (comanda_id) where comanda_id is not null;
create index orden_items_estacion_estado_idx on public.orden_items (estacion_produccion_id, estado);

create table public.anulaciones (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  nivel text not null check (nivel in ('item', 'orden', 'comprobante')),
  orden_id uuid not null,
  orden_item_id uuid,
  comprobante_id uuid,
  motivo_codigo text not null check (
    motivo_codigo in ('error_digitacion', 'cliente_desiste', 'demora', 'producto_agotado', 'calidad', 'otro')
  ),
  motivo_texto text,
  merma boolean not null default false,
  solicitada_por uuid not null references public.usuarios_perfil (user_id),
  autorizada_por uuid references public.usuarios_perfil (user_id),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  resuelta_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (orden_item_id, local_id) references public.orden_items (id, local_id),
  check (nivel <> 'item' or orden_item_id is not null),
  check (nivel <> 'comprobante' or comprobante_id is not null),
  check (motivo_codigo <> 'otro' or nullif(trim(motivo_texto), '') is not null),
  check (estado = 'pendiente' or resuelta_at is not null)
);
create index anulaciones_orden_idx on public.anulaciones (orden_id);

alter table public.orden_items
  add foreign key (anulacion_id, local_id) references public.anulaciones (id, local_id);

create table public.traslados_mesa (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  orden_id uuid not null,
  mesa_origen_id uuid not null,
  mesa_destino_id uuid not null,
  tipo text not null check (tipo in ('mover', 'unir', 'separar', 'mover_items')),
  items jsonb,
  realizado_por uuid not null references public.usuarios_perfil (user_id),
  created_at timestamptz not null default now(),
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (mesa_origen_id, local_id) references public.mesas (id, local_id),
  foreign key (mesa_destino_id, local_id) references public.mesas (id, local_id),
  check (tipo not in ('separar', 'mover_items') or items is not null)
);
create index traslados_mesa_orden_idx on public.traslados_mesa (orden_id);

create table public.descuentos_aplicados (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  orden_id uuid not null,
  orden_item_id uuid,
  tipo text not null check (tipo in ('consumo_personal', 'cortesia', 'promocion', 'manual')),
  porcentaje numeric(5, 2) check (porcentaje between 0 and 100),
  monto numeric(12, 2) not null check (monto >= 0),
  motivo text,
  autorizado_por uuid references public.usuarios_perfil (user_id),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (orden_item_id, local_id) references public.orden_items (id, local_id)
);
create index descuentos_aplicados_orden_idx on public.descuentos_aplicados (orden_id);

create table public.liquidaciones_empleado (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  empleado_id uuid not null,
  periodo_desde date not null,
  periodo_hasta date not null,
  total numeric(12, 2) not null check (total >= 0),
  forma text not null check (forma in ('cobro_caja', 'descuento_planilla')),
  comprobante_id uuid,
  constancia_url text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (id, local_id),
  foreign key (empleado_id, local_id) references public.empleados (id, local_id),
  check (periodo_hasta >= periodo_desde)
);

create table public.cuentas_empleado (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  empleado_id uuid not null,
  orden_id uuid not null,
  monto numeric(12, 2) not null check (monto >= 0),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'liquidado')),
  liquidacion_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  foreign key (empleado_id, local_id) references public.empleados (id, local_id),
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (liquidacion_id, local_id) references public.liquidaciones_empleado (id, local_id),
  check ((estado = 'liquidado') = (liquidacion_id is not null))
);
create index cuentas_empleado_empleado_idx on public.cuentas_empleado (empleado_id, estado);

create trigger ordenes_updated_at before update on public.ordenes
  for each row execute function app.set_updated_at();
create trigger comandas_updated_at before update on public.comandas
  for each row execute function app.set_updated_at();
create trigger orden_items_updated_at before update on public.orden_items
  for each row execute function app.set_updated_at();
create trigger anulaciones_updated_at before update on public.anulaciones
  for each row execute function app.set_updated_at();
create trigger cuentas_empleado_updated_at before update on public.cuentas_empleado
  for each row execute function app.set_updated_at();

create trigger ordenes_sin_borrado before delete on public.ordenes
  for each row execute function app.prohibir_borrado();
create trigger mesa_uniones_sin_borrado before delete on public.mesa_uniones
  for each row execute function app.prohibir_borrado();
create trigger comandas_sin_borrado before delete on public.comandas
  for each row execute function app.prohibir_borrado();
create trigger orden_items_sin_borrado before delete on public.orden_items
  for each row execute function app.prohibir_borrado();
create trigger anulaciones_sin_borrado before delete on public.anulaciones
  for each row execute function app.prohibir_borrado();
create trigger traslados_mesa_sin_borrado before delete on public.traslados_mesa
  for each row execute function app.prohibir_borrado();
create trigger descuentos_aplicados_sin_borrado before delete on public.descuentos_aplicados
  for each row execute function app.prohibir_borrado();
create trigger liquidaciones_empleado_sin_borrado before delete on public.liquidaciones_empleado
  for each row execute function app.prohibir_borrado();
create trigger cuentas_empleado_sin_borrado before delete on public.cuentas_empleado
  for each row execute function app.prohibir_borrado();
