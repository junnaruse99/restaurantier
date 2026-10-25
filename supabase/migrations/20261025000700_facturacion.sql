-- =============================================================================
-- Warike POS — 0700 Facturación electrónica (§5.7)
-- =============================================================================

create table public.comprobantes (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  orden_id uuid,
  tipo_cpe text not null check (tipo_cpe in ('01', '03', '07', '08')),
  serie text not null,
  numero integer not null check (numero > 0),
  fecha_emision date not null,
  cliente_tipo_doc text not null check (cliente_tipo_doc in ('0', '1', '4', '6', '7')),
  cliente_num_doc text,
  cliente_nombre text not null,
  cliente_direccion text,
  moneda text not null default 'PEN' check (moneda = 'PEN'),
  op_gravada numeric(12, 2) not null default 0,
  op_exonerada numeric(12, 2) not null default 0,
  op_inafecta numeric(12, 2) not null default 0,
  igv numeric(12, 2) not null default 0,
  icbper numeric(12, 2) not null default 0,
  total numeric(12, 2) not null,
  tasa_igv_aplicada numeric(6, 4) not null,
  documento_ref_id uuid,
  motivo_nc_codigo text check (motivo_nc_codigo ~ '^[0-9]{2}$'),
  motivo_nc_texto text,
  estado text not null default 'borrador' check (
    estado in ('borrador', 'pendiente_envio', 'enviado', 'aceptado', 'observado', 'rechazado', 'anulado_baja',
               'emision_diferida')
  ),
  sunat_codigo text,
  sunat_descripcion text,
  hash text,
  enlace_pdf text,
  enlace_xml text,
  enlace_cdr text,
  proveedor text not null default 'nubefact' check (proveedor in ('nubefact', 'sunat_directo')),
  request jsonb,
  response jsonb,
  intentos integer not null default 0 check (intentos >= 0),
  proximo_intento_at timestamptz,
  entregado_cliente boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, tipo_cpe, serie, numero),
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (documento_ref_id, local_id) references public.comprobantes (id, local_id),
  -- Factura: RUC obligatorio.
  check (tipo_cpe <> '01' or (cliente_tipo_doc = '6' and cliente_num_doc ~ '^(10|15|17|20)[0-9]{9}$')),
  -- Notas: referencia al comprobante original y motivo del catálogo 09/10.
  check (tipo_cpe not in ('07', '08') or (documento_ref_id is not null and motivo_nc_codigo is not null)),
  check (total = op_gravada + op_exonerada + op_inafecta + igv + icbper)
);
create index comprobantes_orden_idx on public.comprobantes (orden_id);
create index comprobantes_estado_idx on public.comprobantes (local_id, estado);
create index comprobantes_fecha_idx on public.comprobantes (local_id, fecha_emision);

create table public.comprobante_items (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  comprobante_id uuid not null,
  -- Trazabilidad con el ítem de la orden (paloteo y NC por ítem).
  orden_item_id uuid,
  descripcion text not null,
  cantidad numeric(8, 2) not null check (cantidad > 0),
  unidad text not null default 'NIU' check (unidad in ('NIU', 'ZZ')),
  valor_unitario numeric(14, 6) not null,
  precio_unitario numeric(14, 6) not null,
  igv numeric(12, 2) not null default 0,
  icbper numeric(12, 2) not null default 0,
  total numeric(12, 2) not null,
  afectacion_igv text not null default '10' check (afectacion_igv in ('10', '20', '30')),
  created_at timestamptz not null default now(),
  foreign key (comprobante_id, local_id) references public.comprobantes (id, local_id),
  foreign key (orden_item_id, local_id) references public.orden_items (id, local_id)
);
create index comprobante_items_comprobante_idx on public.comprobante_items (comprobante_id);

create table public.bajas (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  comprobante_id uuid not null,
  tipo text not null check (tipo in ('comunicacion_baja', 'resumen_anulacion')),
  motivo text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'enviado', 'aceptado', 'rechazado')),
  ticket text,
  response jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  foreign key (comprobante_id, local_id) references public.comprobantes (id, local_id)
);
create index bajas_comprobante_idx on public.bajas (comprobante_id);

-- Referencias circulares hacia comprobantes, compuestas con local_id como el resto (D-007).
alter table public.pagos
  add foreign key (comprobante_id, local_id) references public.comprobantes (id, local_id);
alter table public.anulaciones
  add foreign key (comprobante_id, local_id) references public.comprobantes (id, local_id);
alter table public.liquidaciones_empleado
  add foreign key (comprobante_id, local_id) references public.comprobantes (id, local_id);

-- Uso mensual de documentos frente al plan contratado (§10.4, R4).
-- security_invoker: respeta la RLS de comprobantes de quien consulta.
create view public.uso_cpe_mensual
with (security_invoker = true)
as
select
  c.local_id,
  to_char(c.fecha_emision, 'YYYY-MM') as anio_mes,
  count(*) filter (where c.tipo_cpe = '01') as cantidad_01,
  count(*) filter (where c.tipo_cpe = '03') as cantidad_03,
  count(*) filter (where c.tipo_cpe = '07') as cantidad_07,
  count(*) filter (where c.tipo_cpe = '08') as cantidad_08,
  count(*) as total
from public.comprobantes c
where c.estado not in ('borrador', 'emision_diferida')
group by c.local_id, to_char(c.fecha_emision, 'YYYY-MM');

create trigger comprobantes_updated_at before update on public.comprobantes
  for each row execute function app.set_updated_at();
create trigger bajas_updated_at before update on public.bajas
  for each row execute function app.set_updated_at();

create trigger comprobantes_sin_borrado before delete on public.comprobantes
  for each row execute function app.prohibir_borrado();
create trigger comprobante_items_sin_borrado before delete on public.comprobante_items
  for each row execute function app.prohibir_borrado();
create trigger bajas_sin_borrado before delete on public.bajas
  for each row execute function app.prohibir_borrado();
