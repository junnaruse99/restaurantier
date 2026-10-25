-- =============================================================================
-- Warike POS — 0600 Caja, pagos y POS (§5.6, §10.2)
-- =============================================================================

create table public.cajas (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  nombre text not null,
  dispositivo_id uuid,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (local_id, nombre),
  foreign key (dispositivo_id, local_id) references public.dispositivos (id, local_id)
);

create table public.sesiones_caja (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  caja_id uuid not null,
  cajero_id uuid not null references public.usuarios_perfil (user_id),
  abierta_at timestamptz not null default now(),
  monto_apertura numeric(12, 2) not null check (monto_apertura >= 0),
  cerrada_at timestamptz,
  estado text not null default 'abierta' check (estado in ('abierta', 'cerrada')),
  efectivo_esperado numeric(12, 2),
  efectivo_contado numeric(12, 2) check (efectivo_contado >= 0),
  desglose_denominaciones jsonb,
  diferencia numeric(12, 2),
  observaciones text,
  numero_z integer check (numero_z > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  unique (caja_id, numero_z),
  foreign key (caja_id, local_id) references public.cajas (id, local_id),
  check (
    (estado = 'abierta' and cerrada_at is null)
    or (estado = 'cerrada' and cerrada_at is not null and numero_z is not null
        and efectivo_esperado is not null and efectivo_contado is not null and diferencia is not null)
  )
);
-- Una sola sesión abierta por caja.
create unique index sesiones_caja_abierta_uidx on public.sesiones_caja (caja_id) where estado = 'abierta';

create table public.cortes_caja (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  sesion_caja_id uuid not null,
  tipo text not null check (tipo in ('X', 'Z')),
  numero integer not null check (numero > 0),
  totales jsonb not null,
  generado_por uuid not null references public.usuarios_perfil (user_id),
  created_at timestamptz not null default now(),
  unique (sesion_caja_id, tipo, numero),
  foreign key (sesion_caja_id, local_id) references public.sesiones_caja (id, local_id)
);

create table public.movimientos_caja (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  sesion_caja_id uuid not null,
  tipo text not null check (tipo in ('ingreso', 'egreso')),
  concepto text not null check (
    concepto in ('sencillo', 'compra_insumos', 'pago_proveedor', 'adelanto_personal', 'retiro_gerencia',
                 'reembolso_cliente', 'ajuste', 'otro')
  ),
  descripcion text,
  monto numeric(12, 2) not null check (monto > 0),
  sustento_url text,
  autorizado_por uuid references public.usuarios_perfil (user_id),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  foreign key (sesion_caja_id, local_id) references public.sesiones_caja (id, local_id)
);
create index movimientos_caja_sesion_idx on public.movimientos_caja (sesion_caja_id);

create table public.terminales_pos (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  caja_id uuid not null,
  proveedor text not null default 'niubiz' check (proveedor = 'niubiz'),
  -- storeId (sucursal) y checkoutId (caja) de Niubiz. Las credenciales van en Vault, nunca aquí.
  store_id text,
  checkout_id text,
  numero_serie text,
  alias text not null,
  modo text not null default 'manual' check (modo in ('integrado', 'manual')),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (id, local_id),
  foreign key (caja_id, local_id) references public.cajas (id, local_id),
  check (modo <> 'integrado' or (store_id is not null and checkout_id is not null))
);
create index terminales_pos_caja_idx on public.terminales_pos (caja_id);

create table public.transacciones_pos (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  terminal_id uuid not null,
  orden_id uuid not null,
  sesion_caja_id uuid not null,
  tipo text not null default 'venta' check (tipo in ('venta', 'anulacion')),
  monto numeric(12, 2) not null check (monto > 0),
  moneda text not null default 'PEN' check (moneda = 'PEN'),
  estado text not null default 'creada' check (
    estado in ('creada', 'enviada_terminal', 'aprobada', 'rechazada', 'cancelada', 'expirada', 'error',
               'pendiente_conciliacion')
  ),
  id_externo text unique,
  codigo_autorizacion text,
  marca text,
  -- Nunca se guarda el número completo de la tarjeta (§10.2).
  ultimos4 text check (ultimos4 ~ '^[0-9]{4}$'),
  request jsonb,
  response jsonb,
  transaccion_original_id uuid,
  intentos integer not null default 0 check (intentos >= 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  resuelta_at timestamptz,
  unique (id, local_id),
  foreign key (terminal_id, local_id) references public.terminales_pos (id, local_id),
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (sesion_caja_id, local_id) references public.sesiones_caja (id, local_id),
  foreign key (transaccion_original_id, local_id) references public.transacciones_pos (id, local_id),
  check (tipo <> 'anulacion' or transaccion_original_id is not null)
);
create index transacciones_pos_sesion_estado_idx on public.transacciones_pos (sesion_caja_id, estado);
create index transacciones_pos_orden_idx on public.transacciones_pos (orden_id);

create table public.pagos (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  orden_id uuid not null,
  sesion_caja_id uuid not null,
  comprobante_id uuid,
  metodo text not null check (
    metodo in ('efectivo', 'visa', 'mastercard', 'otra_tarjeta', 'yape', 'plin', 'qr_otro', 'transferencia',
               'cuenta_empleado')
  ),
  canal text not null default 'manual' check (canal in ('manual', 'niubiz_integrado')),
  monto numeric(12, 2) not null check (monto > 0),
  monto_recibido numeric(12, 2) check (monto_recibido >= 0),
  vuelto numeric(12, 2) check (vuelto >= 0),
  referencia text,
  ultimos4 text check (ultimos4 ~ '^[0-9]{4}$'),
  codigo_autorizacion text,
  id_transaccion_pos text,
  transaccion_pos_id uuid,
  propina numeric(12, 2) not null default 0 check (propina >= 0),
  estado text not null default 'registrado' check (estado in ('registrado', 'anulado')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  foreign key (orden_id, local_id) references public.ordenes (id, local_id),
  foreign key (sesion_caja_id, local_id) references public.sesiones_caja (id, local_id),
  foreign key (transaccion_pos_id, local_id) references public.transacciones_pos (id, local_id),
  -- Referencia obligatoria en Yape, Plin y tarjetas (en el canal integrado se llena sola).
  check (
    metodo not in ('yape', 'plin', 'visa', 'mastercard', 'otra_tarjeta')
    or nullif(trim(referencia), '') is not null
  ),
  check (canal <> 'niubiz_integrado' or transaccion_pos_id is not null),
  check (metodo = 'efectivo' or (monto_recibido is null and vuelto is null)),
  check (vuelto is null or (monto_recibido is not null and vuelto = monto_recibido - monto))
);
create index pagos_orden_idx on public.pagos (orden_id);
create index pagos_sesion_idx on public.pagos (sesion_caja_id);

create trigger cajas_updated_at before update on public.cajas
  for each row execute function app.set_updated_at();
create trigger sesiones_caja_updated_at before update on public.sesiones_caja
  for each row execute function app.set_updated_at();
create trigger terminales_pos_updated_at before update on public.terminales_pos
  for each row execute function app.set_updated_at();
create trigger transacciones_pos_updated_at before update on public.transacciones_pos
  for each row execute function app.set_updated_at();
create trigger pagos_updated_at before update on public.pagos
  for each row execute function app.set_updated_at();

-- -----------------------------------------------------------------------------
-- CA M15: una sesión cerrada es inmutable. Las correcciones se hacen con un
-- movimiento `ajuste` en la sesión siguiente.
-- -----------------------------------------------------------------------------
create or replace function app.sesion_caja_cerrada_inmutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.estado = 'cerrada' then
    raise exception 'La sesión de caja % está cerrada y no se puede modificar', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger sesiones_caja_inmutable before update on public.sesiones_caja
  for each row execute function app.sesion_caja_cerrada_inmutable();

create trigger sesiones_caja_sin_borrado before delete on public.sesiones_caja
  for each row execute function app.prohibir_borrado();
create trigger cortes_caja_sin_borrado before delete on public.cortes_caja
  for each row execute function app.prohibir_borrado();
create trigger movimientos_caja_sin_borrado before delete on public.movimientos_caja
  for each row execute function app.prohibir_borrado();
create trigger transacciones_pos_sin_borrado before delete on public.transacciones_pos
  for each row execute function app.prohibir_borrado();
create trigger pagos_sin_borrado before delete on public.pagos
  for each row execute function app.prohibir_borrado();
