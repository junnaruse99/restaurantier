-- =============================================================================
-- Warike POS — Fase 2 · 0200 Pre-cuenta, cobro con pago mixto y comprobantes (M12, M13, flujo D)
-- =============================================================================

-- División en partes iguales: cada comprobante cobra una parte (DECISIONS D-044).
alter table public.comprobantes
  add column parte smallint check (parte >= 1),
  add column partes smallint check (partes >= 1),
  add constraint comprobantes_parte check ((parte is null) = (partes is null) and (parte is null or parte <= partes));

-- Modo de prueba del local (piloto): permite cerrar una mesa sin comprobante para no consumir
-- documentos del emisor. Solo se activa por SQL, nunca desde la PWA (DECISIONS D-046).
alter table public.config_local add column modo_prueba boolean not null default false;

create index comprobantes_pendientes_idx on public.comprobantes (proximo_intento_at)
  where estado in ('pendiente_envio', 'enviado');
-- Número de línea: el orden en que se envía al emisor y se imprime.
alter table public.comprobante_items add column linea smallint check (linea >= 1);

create index comprobante_items_orden_item_idx on public.comprobante_items (orden_item_id) where orden_item_id is not null;

-- -----------------------------------------------------------------------------
-- Utilidades
-- -----------------------------------------------------------------------------

-- Tasa vigente del régimen de la empresa del local en la fecha de emisión (§9).
create or replace function app.tasa_vigente(p_local_id uuid, p_fecha date)
returns public.config_tributaria
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tasa public.config_tributaria%rowtype;
begin
  select ct.* into v_tasa
  from public.locales l
  join public.empresas e on e.id = l.empresa_id
  join public.config_tributaria ct
    on ct.regimen = e.regimen_igv and (ct.empresa_id is null or ct.empresa_id = e.id)
   and ct.vigencia_desde <= p_fecha and (ct.vigencia_hasta is null or p_fecha <= ct.vigencia_hasta)
  where l.id = p_local_id
  order by ct.empresa_id nulls last
  limit 1;
  return v_tasa;
end;
$$;
revoke all on function app.tasa_vigente(uuid, date) from public;

-- RUC con dígito verificador módulo 11 (igual que packages/domain rucValido).
create or replace function app.ruc_valido(p_ruc text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_ruc ~ '^(10|15|17|20)[0-9]{9}$'
    and (11 - (
      5 * substr(p_ruc, 1, 1)::int + 4 * substr(p_ruc, 2, 1)::int + 3 * substr(p_ruc, 3, 1)::int
      + 2 * substr(p_ruc, 4, 1)::int + 7 * substr(p_ruc, 5, 1)::int + 6 * substr(p_ruc, 6, 1)::int
      + 5 * substr(p_ruc, 7, 1)::int + 4 * substr(p_ruc, 8, 1)::int + 3 * substr(p_ruc, 9, 1)::int
      + 2 * substr(p_ruc, 10, 1)::int
    ) % 11) % 10 = substr(p_ruc, 11, 1)::int
$$;
revoke all on function app.ruc_valido(text) from public;
grant execute on function app.ruc_valido(text) to authenticated, service_role;

-- Ítems de la orden que faltan cobrar: no anulados y sin comprobante vigente.
create or replace function app.items_por_cobrar(p_orden_id uuid)
returns setof public.orden_items
language sql
stable
security definer
set search_path = ''
as $$
  select i.*
  from public.orden_items i
  where i.orden_id = p_orden_id
    and i.estado <> 'anulado'
    and not exists (
      select 1 from public.comprobante_items ci
      join public.comprobantes c on c.id = ci.comprobante_id
      where ci.orden_item_id = i.id and c.tipo_cpe in ('01', '03') and c.estado <> 'anulado_baja'
    )
$$;
revoke all on function app.items_por_cobrar(uuid) from public;

-- Partes iguales cobradas de una orden (comprobantes por parte vigentes).
create or replace function app.partes_cobradas(p_orden_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.comprobantes
  where orden_id = p_orden_id and parte is not null and tipo_cpe in ('01', '03') and estado <> 'anulado_baja'
$$;
revoke all on function app.partes_cobradas(uuid) from public;

-- Detalle de pre-cuenta: líneas por cobrar con su total y, si se pide, la división en partes.
create or replace function app.detalle_cuenta(p_orden_id uuid, p_partes smallint default 1)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lineas as (
    select i.id, i.cantidad, i.total_linea, i.modificadores, i.nota, i.cuenta_split, p.nombre
    from app.items_por_cobrar(p_orden_id) i
    join public.productos p on p.id = i.producto_id
  ),
  t as (select coalesce(sum(total_linea), 0)::numeric(12, 2) as total from lineas)
  select jsonb_build_object(
    'lineas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', id, 'descripcion', nombre, 'cantidad', cantidad, 'total', total_linea,
        'modificadores', modificadores, 'cuenta', cuenta_split
      ) order by cuenta_split, nombre) from lineas
    ), '[]'::jsonb),
    'por_cuenta', coalesce((
      select jsonb_object_agg(cuenta_split, total) from (
        select cuenta_split, sum(total_linea)::numeric(12, 2) as total from lineas group by cuenta_split
      ) x
    ), '{}'::jsonb),
    'total', t.total,
    'partes', (
      select jsonb_agg(
        (floor(t.total * 100 / greatest(p_partes, 1))
         + case when n = 1 then (t.total * 100)::bigint % greatest(p_partes, 1) else 0 end) / 100.0
        order by n)
      from generate_series(1, greatest(p_partes, 1)) n
    )
  )
  from t
$$;
revoke all on function app.detalle_cuenta(uuid, smallint) from public;

-- -----------------------------------------------------------------------------
-- CU12.1 Pre-cuenta: imprime el detalle y pasa la orden y sus mesas a "precuenta". Si después
-- se agregan ítems, la orden vuelve a "abierta" (app.reabrir_si_precuenta) y hay que sacarla otra vez.
-- -----------------------------------------------------------------------------
create or replace function public.generar_precuenta(
  p_orden_id uuid,
  p_partes smallint default 1,
  p_client_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previo jsonb := app.inicio_mutacion(p_client_mutation_id);
  v_orden public.ordenes%rowtype;
  v_detalle jsonb;
  v_caja uuid;
  v_resultado jsonb;
begin
  if v_previo is not null then
    return v_previo;
  end if;
  v_orden := app.orden_editable(p_orden_id, 'generar_precuenta');
  if p_partes is null or p_partes < 1 or p_partes > 20 then
    perform app.fallar(400, 'partes_invalidas', 'Divida la cuenta entre 1 y 20 partes');
  end if;
  if exists (select 1 from public.orden_items where orden_id = p_orden_id and estado = 'borrador') then
    perform app.fallar(409, 'items_en_borrador', 'Envíe o quite los ítems en borrador antes de la pre-cuenta');
  end if;
  v_detalle := app.detalle_cuenta(p_orden_id, p_partes);
  if (v_detalle ->> 'total')::numeric <= 0 and jsonb_array_length(v_detalle -> 'lineas') = 0 then
    perform app.fallar(409, 'orden_vacia', 'La orden no tiene ítems por cobrar');
  end if;

  update public.ordenes set estado = 'precuenta' where id = p_orden_id;
  update public.mesas m set estado = 'precuenta'
  from public.mesa_uniones u
  where u.orden_id = p_orden_id and u.liberada_at is null and m.id = u.mesa_id;

  select id into v_caja from public.cajas
  where local_id = v_orden.local_id and activa and impresora_id is not null
  order by nombre limit 1;
  if v_caja is not null then
    perform app.encolar_en_caja(v_caja, 'precuenta', v_detalle || jsonb_build_object(
      'tipo', 'precuenta', 'fecha', now(), 'mesa', app.etiqueta_mesa(v_orden.mesa_principal_id),
      'orden', v_orden.numero_dia, 'comensales', v_orden.comensales,
      'mozo', (select nombre_visible from public.usuarios_perfil where user_id = v_orden.mozo_id)
    ));
  end if;

  v_resultado := v_detalle || jsonb_build_object('orden_id', p_orden_id, 'estado', 'precuenta');
  return app.registrar_mutacion(p_client_mutation_id, v_orden.local_id, 'generar_precuenta',
    jsonb_build_object('orden_id', p_orden_id, 'partes', p_partes), v_resultado);
end;
$$;
revoke all on function public.generar_precuenta(uuid, smallint, uuid) from public, anon;
grant execute on function public.generar_precuenta(uuid, smallint, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Flujo D.3 cobrar_y_emitir: en una sola transacción valida la sesión y los pagos, reserva el
-- correlativo, crea el comprobante (pendiente_envio) con sus ítems y pagos, y cierra la orden cuando
-- no queda nada por cobrar. La Edge Function emitir-cpe lo envía después al emisor.
--
--   p_cliente: { tipo_doc: '0'|'1'|'4'|'6'|'7', num_doc, nombre, direccion }
--   p_pagos:   [{ metodo, monto, monto_recibido?, referencia?, propina? }]
--   p_item_ids: cobra solo esos ítems (división por ítems); p_partes: cobra la siguiente de N partes
--   iguales. Sin ambos, cobra todo lo pendiente.
-- -----------------------------------------------------------------------------
create or replace function public.cobrar_y_emitir(
  p_orden_id uuid,
  p_sesion_id uuid,
  p_tipo_cpe text,
  p_cliente jsonb,
  p_pagos jsonb,
  p_item_ids uuid[] default null,
  p_partes smallint default null,
  p_client_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previo jsonb := app.inicio_mutacion(p_client_mutation_id);
  v_orden public.ordenes%rowtype;
  v_sesion public.sesiones_caja%rowtype;
  v_config public.config_local%rowtype;
  v_tasa public.config_tributaria%rowtype;
  v_fecha date := (now() at time zone 'America/Lima')::date;
  v_tipo_doc text := coalesce(nullif(p_cliente ->> 'tipo_doc', ''), '0');
  v_num_doc text := nullif(trim(p_cliente ->> 'num_doc'), '');
  v_nombre text := nullif(trim(p_cliente ->> 'nombre'), '');
  v_direccion text := nullif(trim(p_cliente ->> 'direccion'), '');
  v_serie text;
  v_numero integer;
  v_comprobante uuid;
  v_parte smallint;
  v_total numeric := 0;
  v_op_gravada numeric := 0;
  v_igv numeric := 0;
  v_icbper numeric := 0;
  v_pago jsonb;
  v_suma_pagos numeric := 0;
  v_monto numeric;
  v_recibido numeric;
  v_metodo text;
  v_quedan integer;
  v_resultado jsonb;
  -- Líneas a cobrar: [{orden_item_id, descripcion, cantidad, total, icbper}] en el orden de la orden.
  v_lineas jsonb;
  r record;
begin
  if v_previo is not null then
    return v_previo;
  end if;
  select * into v_orden from public.ordenes where id = p_orden_id for update;
  if not found then
    perform app.fallar(404, 'orden_no_encontrada', 'La orden no existe');
  end if;
  perform app.exigir_permiso(v_orden.local_id, 'cobrar_emitir');
  if v_orden.estado not in ('abierta', 'precuenta') then
    perform app.fallar(409, 'orden_cerrada', 'La orden ya está cerrada');
  end if;
  v_sesion := app.sesion_abierta(p_sesion_id);
  if v_sesion.local_id <> v_orden.local_id then
    perform app.fallar(409, 'sesion_de_otro_local', 'La sesión de caja es de otro local');
  end if;
  -- '00' = cerrar sin comprobante, solo en modo de prueba.
  if p_tipo_cpe not in ('01', '03', '00') then
    perform app.fallar(400, 'tipo_cpe_invalido', 'Emita una boleta (03) o una factura (01)');
  end if;
  if p_item_ids is not null and p_partes is not null then
    perform app.fallar(400, 'division_invalida', 'Divida por ítems o en partes iguales, no ambas');
  end if;
  if exists (select 1 from public.orden_items where orden_id = p_orden_id and estado = 'borrador') then
    perform app.fallar(409, 'items_en_borrador', 'Envíe o quite los ítems en borrador antes de cobrar');
  end if;
  if exists (select 1 from public.transacciones_pos where orden_id = p_orden_id and estado = 'enviada_terminal') then
    perform app.fallar(409, 'pago_pos_en_curso', 'Espere a que el POS apruebe, rechace o cancele el cobro');
  end if;
  select * into v_config from public.config_local where local_id = v_orden.local_id;
  if p_tipo_cpe = '00' then
    if not coalesce(v_config.modo_prueba, false) then
      perform app.fallar(403, 'modo_prueba_inactivo', 'Cerrar sin comprobante solo está permitido en modo de prueba');
    end if;
    if p_item_ids is not null or p_partes is not null then
      perform app.fallar(400, 'division_invalida', 'Sin comprobante se cierra la cuenta completa');
    end if;
  end if;
  v_tasa := app.tasa_vigente(v_orden.local_id, v_fecha);
  if v_tasa.id is null then
    perform app.fallar(500, 'sin_tasa_vigente', 'No hay una tasa de IGV vigente configurada');
  end if;


  if p_partes is not null then
    if p_partes < 2 or p_partes > 20 then
      perform app.fallar(400, 'partes_invalidas', 'Divida la cuenta entre 2 y 20 partes');
    end if;
    v_parte := app.partes_cobradas(p_orden_id) + 1;
    if v_parte > p_partes then
      perform app.fallar(409, 'partes_completas', 'Ya se cobraron todas las partes');
    end if;
    if exists (
      select 1 from public.comprobantes
      where orden_id = p_orden_id and tipo_cpe in ('01', '03') and estado <> 'anulado_baja'
        and (partes is distinct from p_partes)
    ) then
      perform app.fallar(409, 'division_cambiada', 'La orden ya se empezó a cobrar de otra forma');
    end if;
    -- Partes iguales del total de la orden; el residuo de céntimos va a la primera parte (§9).
    select coalesce(sum(total_linea), 0) into v_monto
    from public.orden_items where orden_id = p_orden_id and estado <> 'anulado';
    v_monto := (floor(v_monto * 100 / p_partes)
                + case when v_parte = 1 then (v_monto * 100)::bigint % p_partes else 0 end) / 100;
    v_lineas := jsonb_build_array(jsonb_build_object(
      'orden_item_id', null, 'cantidad', 1, 'total', v_monto, 'icbper', false,
      'descripcion', 'CONSUMO DE ALIMENTOS Y BEBIDAS (PARTE ' || v_parte || ' DE ' || p_partes || ')'
    ));
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'orden_item_id', i.id, 'cantidad', i.cantidad, 'total', i.total_linea, 'icbper', p.aplica_icbper,
             'descripcion', p.nombre || coalesce(' (' || (
               select string_agg(m ->> 'nombre', ', ') from jsonb_array_elements(i.modificadores) m
             ) || ')', '')
           ) order by i.created_at, i.id), '[]'::jsonb)
    into v_lineas
    from app.items_por_cobrar(p_orden_id) i
    join public.productos p on p.id = i.producto_id
    where p_item_ids is null or i.id = any (p_item_ids);
    if p_item_ids is not null and jsonb_array_length(v_lineas) <> cardinality(p_item_ids) then
      perform app.fallar(409, 'items_no_cobrables', 'Algún ítem ya fue cobrado, anulado o no es de esta orden');
    end if;
    if exists (select 1 from public.comprobantes
               where orden_id = p_orden_id and parte is not null and estado <> 'anulado_baja') then
      perform app.fallar(409, 'division_cambiada', 'La orden ya se empezó a cobrar en partes iguales');
    end if;
  end if;
  if jsonb_array_length(v_lineas) = 0 then
    perform app.fallar(409, 'orden_vacia', 'No hay ítems por cobrar');
  end if;

  -- Totales (§9): valor = round2(precio / (1 + tasa) × cantidad); IGV = total − valor; ICBPER aparte.
  select coalesce(sum(round(round((total / cantidad) / (1 + v_tasa.tasa_total), 10) * cantidad, 2)), 0),
         coalesce(sum(total), 0),
         coalesce(sum(cantidad * v_tasa.icbper_unitario) filter (where icbper), 0)
  into v_op_gravada, v_total, v_icbper
  from jsonb_to_recordset(v_lineas) as l(cantidad numeric, total numeric, icbper boolean);
  v_igv := v_total - v_op_gravada;
  v_total := v_total + v_icbper;

  -- Cliente (M13).
  if p_tipo_cpe = '01' then
    if v_tipo_doc <> '6' or v_num_doc is null or not app.ruc_valido(v_num_doc) then
      perform app.fallar(400, 'ruc_invalido', 'La factura exige un RUC válido');
    end if;
    if v_nombre is null then
      perform app.fallar(400, 'razon_social_requerida', 'Indique la razón social');
    end if;
  elsif p_tipo_cpe = '03' then
    if v_tipo_doc = '6' then
      perform app.fallar(400, 'boleta_con_ruc', 'Para un RUC emita una factura');
    end if;
    if v_tipo_doc = '1' and (v_num_doc is null or v_num_doc !~ '^[0-9]{8}$') then
      perform app.fallar(400, 'dni_invalido', 'El DNI tiene 8 dígitos');
    end if;
    if v_tipo_doc in ('4', '7') and v_num_doc is null then
      perform app.fallar(400, 'documento_requerido', 'Indique el número de documento');
    end if;
    if v_tipo_doc = '0' and v_total > coalesce(v_config.umbral_dni_boleta, 700) then
      perform app.fallar(400, 'dni_requerido',
        'Las boletas de más de S/ ' || coalesce(v_config.umbral_dni_boleta, 700) || ' exigen el documento del cliente');
    end if;
    if v_tipo_doc = '0' then
      v_num_doc := null;
      v_nombre := coalesce(v_nombre, 'CLIENTES VARIOS');
    end if;
    if v_nombre is null then
      perform app.fallar(400, 'nombre_requerido', 'Indique el nombre del cliente');
    end if;
  end if;

  -- Pagos (CU12.2): la suma debe ser igual al total.
  if p_pagos is null or jsonb_typeof(p_pagos) <> 'array' or jsonb_array_length(p_pagos) = 0 then
    perform app.fallar(400, 'sin_pagos', 'Registre al menos un pago');
  end if;
  for v_pago in select value from jsonb_array_elements(p_pagos) loop
    v_metodo := v_pago ->> 'metodo';
    v_monto := round((v_pago ->> 'monto')::numeric, 2);
    if v_metodo is null or v_metodo not in ('efectivo', 'visa', 'mastercard', 'otra_tarjeta', 'yape', 'plin', 'qr_otro',
        'transferencia', 'cuenta_empleado') then
      perform app.fallar(400, 'metodo_invalido', 'Método de pago inválido');
    end if;
    if v_metodo = 'cuenta_empleado' then
      perform app.fallar(400, 'metodo_invalido', 'El cargo a la cuenta del empleado se registra desde consumo de personal');
    end if;
    if v_monto is null or v_monto <= 0 then
      perform app.fallar(400, 'monto_invalido', 'Cada pago debe ser mayor que cero');
    end if;
    if v_metodo in ('yape', 'plin', 'visa', 'mastercard', 'otra_tarjeta') and nullif(trim(v_pago ->> 'referencia'), '') is null then
      perform app.fallar(400, 'referencia_requerida', 'Indique el número de operación o de voucher');
    end if;
    if v_metodo = 'efectivo' and v_pago ? 'monto_recibido' and (v_pago ->> 'monto_recibido')::numeric < v_monto then
      perform app.fallar(400, 'recibido_insuficiente', 'El monto recibido no alcanza');
    end if;
    v_suma_pagos := v_suma_pagos + v_monto;
  end loop;
  if v_suma_pagos <> v_total then
    perform app.fallar(400, 'pagos_no_cuadran',
      'Los pagos suman S/ ' || v_suma_pagos || ' y el total es S/ ' || v_total);
  end if;

  -- Correlativo sin saltos: se reserva dentro de esta transacción (CA de M13).
  if p_tipo_cpe <> '00' then
    update public.series_cpe
    set ultimo_numero = ultimo_numero + 1
    where id = (
      select id from public.series_cpe
      where local_id = v_orden.local_id and tipo_cpe = p_tipo_cpe and activa and not es_contingencia
      order by serie limit 1
    )
    returning serie, ultimo_numero into v_serie, v_numero;
    if v_serie is null then
      perform app.fallar(500, 'sin_serie', 'No hay una serie activa para este tipo de comprobante');
    end if;

    insert into public.comprobantes (
      local_id, orden_id, tipo_cpe, serie, numero, fecha_emision, cliente_tipo_doc, cliente_num_doc, cliente_nombre,
      cliente_direccion, op_gravada, igv, icbper, total, tasa_igv_aplicada, estado, proveedor, proximo_intento_at,
      parte, partes
    )
    values (
      v_orden.local_id, p_orden_id, p_tipo_cpe, v_serie, v_numero, v_fecha, v_tipo_doc, v_num_doc, upper(v_nombre),
      v_direccion, v_op_gravada, v_igv, v_icbper, v_total, v_tasa.tasa_total, 'pendiente_envio',
      (select proveedor_cpe from public.locales where id = v_orden.local_id), now(), v_parte, p_partes
    )
    returning id into v_comprobante;

    for r in
      select l.*, n::smallint as linea
      from jsonb_array_elements(v_lineas) with ordinality as e(v, n),
           jsonb_to_record(e.v) as l(orden_item_id uuid, descripcion text, cantidad numeric, total numeric, icbper boolean)
    loop
      insert into public.comprobante_items (local_id, comprobante_id, linea, orden_item_id, descripcion, cantidad,
                                            valor_unitario, precio_unitario, igv, icbper, total)
      values (
        v_orden.local_id, v_comprobante, r.linea, r.orden_item_id, r.descripcion, r.cantidad,
        round((r.total / r.cantidad) / (1 + v_tasa.tasa_total), 6),
        round(r.total / r.cantidad, 6),
        r.total - round(round((r.total / r.cantidad) / (1 + v_tasa.tasa_total), 10) * r.cantidad, 2),
        case when r.icbper then r.cantidad * v_tasa.icbper_unitario else 0 end,
        r.total
      );
    end loop;
  end if;

  for v_pago in select value from jsonb_array_elements(p_pagos) loop
    v_metodo := v_pago ->> 'metodo';
    v_monto := round((v_pago ->> 'monto')::numeric, 2);
    v_recibido := case when v_metodo = 'efectivo' and v_pago ? 'monto_recibido'
                       then round((v_pago ->> 'monto_recibido')::numeric, 2) end;
    insert into public.pagos (local_id, orden_id, sesion_caja_id, comprobante_id, metodo, canal, monto, monto_recibido,
                              vuelto, referencia, propina)
    values (
      v_orden.local_id, p_orden_id, p_sesion_id, v_comprobante, v_metodo, 'manual', v_monto, v_recibido,
      case when v_recibido is not null then v_recibido - v_monto end,
      nullif(trim(v_pago ->> 'referencia'), ''),
      case when coalesce(v_config.propina_habilitada, false) then coalesce(round((v_pago ->> 'propina')::numeric, 2), 0) else 0 end
    );
  end loop;

  -- ¿Queda algo por cobrar?
  if p_tipo_cpe = '00' then
    v_quedan := 0;
  elsif p_partes is not null then
    v_quedan := p_partes - v_parte;
  else
    select count(*) into v_quedan from app.items_por_cobrar(p_orden_id);
  end if;
  if v_quedan = 0 then
    update public.mesas m set estado = 'por_limpiar'
    from public.mesa_uniones u
    where u.orden_id = p_orden_id and u.liberada_at is null and m.id = u.mesa_id;
    update public.mesa_uniones set liberada_at = now() where orden_id = p_orden_id and liberada_at is null;
    update public.ordenes set estado = 'pagada', cerrada_at = now() where id = p_orden_id;
  end if;

  v_resultado := jsonb_build_object(
    'comprobante_id', v_comprobante, 'tipo_cpe', p_tipo_cpe, 'serie', v_serie, 'numero', v_numero,
    'total', v_total, 'op_gravada', v_op_gravada, 'igv', v_igv, 'icbper', v_icbper,
    'vuelto', coalesce((select sum(vuelto) from public.pagos where comprobante_id = v_comprobante), 0),
    'orden_pagada', v_quedan = 0, 'parte', v_parte, 'partes', p_partes
  );
  return app.registrar_mutacion(p_client_mutation_id, v_orden.local_id, 'cobrar_y_emitir',
    jsonb_build_object('orden_id', p_orden_id, 'tipo_cpe', p_tipo_cpe, 'pagos', p_pagos), v_resultado);
end;
$$;
revoke all on function public.cobrar_y_emitir(uuid, uuid, text, jsonb, jsonb, uuid[], smallint, uuid) from public, anon;
grant execute on function public.cobrar_y_emitir(uuid, uuid, text, jsonb, jsonb, uuid[], smallint, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Emisión (Edge Function emitir-cpe, con service_role). §7.1: reintentos a 1, 2, 5, 10 y 30 min;
-- luego cada 60 min.
-- -----------------------------------------------------------------------------

-- Toma comprobantes listos para enviar (uno o los vencidos) y los marca "enviado" para que dos
-- invocaciones no envíen el mismo.
create or replace function public.cpe_tomar(p_comprobante_id uuid default null, p_limite integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select array_agg(id) into v_ids from (
    select c.id from public.comprobantes c
    where (p_comprobante_id is null or c.id = p_comprobante_id)
      and (
        (c.estado = 'pendiente_envio' and (p_comprobante_id is not null or c.proximo_intento_at <= now()))
        -- Un envío que quedó colgado más de 2 min se retoma.
        or (c.estado = 'enviado' and c.updated_at < now() - interval '2 minutes')
      )
    order by c.proximo_intento_at nulls first
    limit greatest(p_limite, 1)
    for update skip locked
  ) x;
  if v_ids is null then
    return '[]'::jsonb;
  end if;
  update public.comprobantes set estado = 'enviado', intentos = intentos + 1 where id = any (v_ids);
  return (
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'local_id', c.local_id, 'proveedor', c.proveedor, 'tipo_cpe', c.tipo_cpe, 'serie', c.serie,
      'numero', c.numero, 'fecha_emision', c.fecha_emision, 'cliente_tipo_doc', c.cliente_tipo_doc,
      'cliente_num_doc', c.cliente_num_doc, 'cliente_nombre', c.cliente_nombre, 'cliente_direccion', c.cliente_direccion,
      'moneda', c.moneda, 'op_gravada', c.op_gravada, 'op_exonerada', c.op_exonerada, 'op_inafecta', c.op_inafecta,
      'igv', c.igv, 'icbper', c.icbper, 'total', c.total, 'tasa_igv', c.tasa_igv_aplicada, 'intentos', c.intentos,
      'documento_ref', (select jsonb_build_object('tipo_cpe', r.tipo_cpe, 'serie', r.serie, 'numero', r.numero)
                        from public.comprobantes r where r.id = c.documento_ref_id),
      'motivo_nc_codigo', c.motivo_nc_codigo, 'motivo_nc_texto', c.motivo_nc_texto,
      'items', (select jsonb_agg(jsonb_build_object(
                  'descripcion', i.descripcion, 'cantidad', i.cantidad, 'unidad', i.unidad,
                  'valor_unitario', i.valor_unitario, 'precio_unitario', i.precio_unitario,
                  'igv', i.igv, 'icbper', i.icbper, 'total', i.total, 'afectacion_igv', i.afectacion_igv
                ) order by i.linea, i.created_at, i.id)
                from public.comprobante_items i where i.comprobante_id = c.id),
      'pagos', (select jsonb_agg(jsonb_build_object('metodo', p.metodo, 'monto', p.monto))
                from public.pagos p where p.comprobante_id = c.id)
    ))
    from public.comprobantes c where c.id = any (v_ids)
  );
end;
$$;
revoke all on function public.cpe_tomar(uuid, integer) from public, anon, authenticated;
grant execute on function public.cpe_tomar(uuid, integer) to service_role;

-- Resultado del emisor:
--   { estado: 'aceptado'|'observado'|'rechazado'|'error_red', sunat_codigo?, sunat_descripcion?, hash?,
--     qr?, enlace_pdf?, enlace_xml?, enlace_cdr?, request?, response? }
-- error_red deja el comprobante pendiente con backoff; aceptado/observado encola la impresión.
create or replace function public.cpe_registrar_resultado(p_comprobante_id uuid, p_resultado jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.comprobantes%rowtype;
  v_estado text := p_resultado ->> 'estado';
  v_espera interval;
  v_caja uuid;
begin
  select * into v_c from public.comprobantes where id = p_comprobante_id for update;
  if not found then
    perform app.fallar(404, 'comprobante_no_encontrado', 'El comprobante no existe');
  end if;
  if v_estado not in ('aceptado', 'observado', 'rechazado', 'error_red') then
    perform app.fallar(400, 'estado_invalido', 'Estado de emisión inválido');
  end if;

  if v_estado = 'error_red' then
    v_espera := case least(v_c.intentos, 6)
      when 0 then interval '1 minute' when 1 then interval '1 minute' when 2 then interval '2 minutes'
      when 3 then interval '5 minutes' when 4 then interval '10 minutes' when 5 then interval '30 minutes'
      else interval '60 minutes' end;
    update public.comprobantes
    set estado = 'pendiente_envio', proximo_intento_at = now() + v_espera,
        request = coalesce(p_resultado -> 'request', request), response = p_resultado -> 'response',
        sunat_descripcion = p_resultado ->> 'sunat_descripcion'
    where id = p_comprobante_id;
    return jsonb_build_object('estado', 'pendiente_envio', 'proximo_intento_at', now() + v_espera);
  end if;

  update public.comprobantes
  set estado = v_estado, proximo_intento_at = null,
      sunat_codigo = p_resultado ->> 'sunat_codigo', sunat_descripcion = p_resultado ->> 'sunat_descripcion',
      hash = p_resultado ->> 'hash', enlace_pdf = p_resultado ->> 'enlace_pdf',
      enlace_xml = p_resultado ->> 'enlace_xml', enlace_cdr = p_resultado ->> 'enlace_cdr',
      request = coalesce(p_resultado -> 'request', request), response = p_resultado -> 'response'
  where id = p_comprobante_id;

  if v_estado in ('aceptado', 'observado') then
    select s.caja_id into v_caja
    from public.pagos p join public.sesiones_caja s on s.id = p.sesion_caja_id
    where p.comprobante_id = p_comprobante_id limit 1;
    if v_caja is not null then
      perform app.encolar_en_caja(v_caja, 'comprobante', app.payload_comprobante(p_comprobante_id)
        || jsonb_build_object('hash', p_resultado ->> 'hash', 'qr', p_resultado ->> 'qr'));
    end if;
  end if;
  return jsonb_build_object('estado', v_estado);
end;
$$;
revoke all on function public.cpe_registrar_resultado(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cpe_registrar_resultado(uuid, jsonb) to service_role;

-- Ticket impreso del comprobante.
create or replace function app.payload_comprobante(p_comprobante_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tipo', 'comprobante',
    'tipo_cpe', c.tipo_cpe, 'serie', c.serie, 'numero', c.numero, 'fecha', c.created_at,
    'emisor', jsonb_build_object('ruc', e.ruc, 'razon_social', e.razon_social, 'nombre_comercial', e.nombre_comercial,
                                 'direccion', coalesce(l.direccion, e.direccion_fiscal)),
    'cliente', jsonb_build_object('tipo_doc', c.cliente_tipo_doc, 'num_doc', c.cliente_num_doc,
                                  'nombre', c.cliente_nombre, 'direccion', c.cliente_direccion),
    'items', (select jsonb_agg(jsonb_build_object('descripcion', i.descripcion, 'cantidad', i.cantidad,
                                                   'precio_unitario', i.precio_unitario, 'total', i.total)
                               order by i.linea, i.created_at, i.id)
              from public.comprobante_items i where i.comprobante_id = c.id),
    'op_gravada', c.op_gravada, 'igv', c.igv, 'icbper', c.icbper, 'total', c.total,
    'tasa_igv', c.tasa_igv_aplicada,
    'pagos', (select jsonb_agg(jsonb_build_object('metodo', p.metodo, 'monto', p.monto, 'vuelto', p.vuelto))
              from public.pagos p where p.comprobante_id = c.id),
    'enlace_pdf', c.enlace_pdf
  )
  from public.comprobantes c
  join public.locales l on l.id = c.local_id
  join public.empresas e on e.id = l.empresa_id
  where c.id = p_comprobante_id
$$;
revoke all on function app.payload_comprobante(uuid) from public;

-- La caja puede pedir el envío de un comprobante suyo (la Edge Function lo valida con esta RPC).
create or replace function public.cpe_puede_emitir(p_comprobante_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local uuid;
begin
  select local_id into v_local from public.comprobantes where id = p_comprobante_id;
  if v_local is null then
    perform app.fallar(404, 'comprobante_no_encontrado', 'El comprobante no existe');
  end if;
  perform app.exigir_permiso(v_local, 'cobrar_emitir');
  return true;
end;
$$;
revoke all on function public.cpe_puede_emitir(uuid) from public, anon;
grant execute on function public.cpe_puede_emitir(uuid) to authenticated;
