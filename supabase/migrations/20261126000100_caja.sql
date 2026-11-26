-- =============================================================================
-- Warike POS — Fase 2 · 0100 Caja: apertura, corte X, cierre Z, ingresos y egresos (M15)
-- =============================================================================

-- Impresora de cada caja (pre-cuentas, comprobantes y cortes).
alter table public.cajas add column impresora_id uuid;
alter table public.cajas add foreign key (impresora_id, local_id) references public.impresoras (id, local_id);
grant insert (impresora_id) on public.cajas to authenticated;
grant update (impresora_id) on public.cajas to authenticated;

-- Una sola sesión abierta por caja.
create unique index sesiones_caja_una_abierta on public.sesiones_caja (caja_id) where estado = 'abierta';

-- Cerrar con mesas abiertas las pasa al siguiente turno y exige autorización (CU15.3).
insert into public.permissions (codigo, modulo, descripcion) values
  ('autorizar_cierre_con_mesas', 'caja', 'Autorizar el cierre Z con mesas abiertas que pasan al siguiente turno');
insert into public.role_permissions (role_id, permission_codigo)
select id, 'autorizar_cierre_con_mesas' from public.roles where empresa_id is null and codigo = 'admin';

-- -----------------------------------------------------------------------------
-- Utilidades
-- -----------------------------------------------------------------------------
create or replace function app.encolar_en_caja(p_caja_id uuid, p_tipo text, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caja public.cajas%rowtype;
  v_id uuid;
begin
  select * into v_caja from public.cajas where id = p_caja_id;
  if v_caja.impresora_id is null then
    return null;
  end if;
  insert into public.print_jobs (local_id, impresora_id, tipo, payload)
  values (v_caja.local_id, v_caja.impresora_id, p_tipo, p_payload)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function app.encolar_en_caja(uuid, text, jsonb) from public;

-- Sesión abierta, bloqueada para la transacción; falla si no existe o está cerrada.
create or replace function app.sesion_abierta(p_sesion_id uuid)
returns public.sesiones_caja
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.sesiones_caja%rowtype;
begin
  select * into v_sesion from public.sesiones_caja where id = p_sesion_id for update;
  if not found then
    perform app.fallar(404, 'sesion_no_encontrada', 'La sesión de caja no existe');
  end if;
  if v_sesion.estado <> 'abierta' then
    perform app.fallar(409, 'sesion_cerrada', 'La sesión de caja ya está cerrada');
  end if;
  return v_sesion;
end;
$$;
revoke all on function app.sesion_abierta(uuid) from public;

-- Totales de una sesión: pagos por método y canal, vueltos, comprobantes, movimientos y el
-- efectivo esperado: apertura + Σ efectivo − Σ vueltos + Σ ingresos − Σ egresos (M15).
create or replace function app.totales_sesion(p_sesion_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select * from public.sesiones_caja where id = p_sesion_id
  ),
  p as (
    select * from public.pagos where sesion_caja_id = p_sesion_id and estado = 'registrado'
  ),
  m as (
    select * from public.movimientos_caja where sesion_caja_id = p_sesion_id
  ),
  efectivo as (
    select
      coalesce((select sum(coalesce(monto_recibido, monto)) filter (where metodo = 'efectivo') from p), 0)
        - coalesce((select sum(vuelto) from p), 0) as neto,
      coalesce((select sum(vuelto) from p), 0) as vueltos
  )
  select jsonb_build_object(
    'apertura', s.monto_apertura,
    'pagos_por_metodo', coalesce((
      select jsonb_object_agg(metodo, total) from (
        select metodo, sum(monto)::numeric(12, 2) as total from p group by metodo
      ) x
    ), '{}'::jsonb),
    'pagos_por_canal', coalesce((
      select jsonb_object_agg(canal, total) from (
        select canal, sum(monto)::numeric(12, 2) as total from p group by canal
      ) x
    ), '{}'::jsonb),
    'total_cobrado', coalesce((select sum(monto) from p), 0)::numeric(12, 2),
    'propinas', coalesce((select sum(propina) from p), 0)::numeric(12, 2),
    'vueltos', e.vueltos::numeric(12, 2),
    'comprobantes_por_tipo', coalesce((
      select jsonb_object_agg(tipo_cpe, jsonb_build_object('cantidad', cantidad, 'total', total)) from (
        select c.tipo_cpe, count(*) as cantidad, sum(c.total)::numeric(12, 2) as total
        from public.comprobantes c
        where c.id in (select comprobante_id from p where comprobante_id is not null)
        group by c.tipo_cpe
      ) x
    ), '{}'::jsonb),
    'ingresos', coalesce((select sum(monto) from m where tipo = 'ingreso'), 0)::numeric(12, 2),
    'egresos', coalesce((select sum(monto) from m where tipo = 'egreso'), 0)::numeric(12, 2),
    'movimientos_por_concepto', coalesce((
      select jsonb_object_agg(tipo || ':' || concepto, total) from (
        select tipo, concepto, sum(monto)::numeric(12, 2) as total from m group by tipo, concepto
      ) x
    ), '{}'::jsonb),
    'efectivo_esperado', (
      s.monto_apertura
      + e.neto
      + coalesce((select sum(monto) from m where tipo = 'ingreso'), 0)
      - coalesce((select sum(monto) from m where tipo = 'egreso'), 0)
    )::numeric(12, 2)
  )
  from s, efectivo e
$$;
revoke all on function app.totales_sesion(uuid) from public;

-- -----------------------------------------------------------------------------
-- CU15.1 Apertura
-- -----------------------------------------------------------------------------
create or replace function public.abrir_caja(p_caja_id uuid, p_monto_apertura numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caja public.cajas%rowtype;
  v_id uuid;
begin
  select * into v_caja from public.cajas where id = p_caja_id;
  if not found or not v_caja.activa then
    perform app.fallar(404, 'caja_no_encontrada', 'La caja no existe o está inactiva');
  end if;
  perform app.exigir_permiso(v_caja.local_id, 'operar_caja');
  if p_monto_apertura is null or p_monto_apertura < 0 or p_monto_apertura > 100000 then
    perform app.fallar(400, 'monto_invalido', 'El monto de apertura debe estar entre 0 y 100 000');
  end if;
  begin
    insert into public.sesiones_caja (local_id, caja_id, cajero_id, monto_apertura)
    values (v_caja.local_id, p_caja_id, auth.uid(), round(p_monto_apertura, 2))
    returning id into v_id;
  exception when unique_violation then
    perform app.fallar(409, 'caja_ya_abierta', 'Esta caja ya tiene una sesión abierta');
  end;
  return jsonb_build_object('sesion_id', v_id, 'caja_id', p_caja_id, 'monto_apertura', round(p_monto_apertura, 2));
end;
$$;
revoke all on function public.abrir_caja(uuid, numeric) from public, anon;
grant execute on function public.abrir_caja(uuid, numeric) to authenticated;

-- -----------------------------------------------------------------------------
-- CU15.4 Ingresos y egresos. Los egresos sobre umbral_egreso_pin exigen autorización.
-- -----------------------------------------------------------------------------
create or replace function public.registrar_movimiento_caja(
  p_sesion_id uuid,
  p_tipo text,
  p_concepto text,
  p_monto numeric,
  p_descripcion text default null,
  p_sustento_url text default null,
  p_autorizacion_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.sesiones_caja%rowtype := app.sesion_abierta(p_sesion_id);
  v_umbral numeric;
  v_autorizado uuid;
  v_id uuid;
begin
  perform app.exigir_permiso(v_sesion.local_id, 'registrar_movimiento_caja');
  if p_tipo not in ('ingreso', 'egreso') then
    perform app.fallar(400, 'tipo_invalido', 'El movimiento es un ingreso o un egreso');
  end if;
  if p_concepto is null or p_concepto not in ('sencillo', 'compra_insumos', 'pago_proveedor', 'adelanto_personal',
      'retiro_gerencia', 'reembolso_cliente', 'ajuste', 'otro') then
    perform app.fallar(400, 'concepto_invalido', 'Elija un concepto válido');
  end if;
  if p_monto is null or p_monto <= 0 or p_monto > 100000 then
    perform app.fallar(400, 'monto_invalido', 'El monto debe ser mayor que cero');
  end if;
  if p_concepto in ('otro', 'ajuste') and length(coalesce(trim(p_descripcion), '')) < 3 then
    perform app.fallar(400, 'descripcion_requerida', 'Describa el movimiento');
  end if;

  if p_tipo = 'egreso' then
    select umbral_egreso_pin into v_umbral from public.config_local where local_id = v_sesion.local_id;
    if round(p_monto, 2) > coalesce(v_umbral, 0) then
      v_autorizado := app.autorizador(v_sesion.local_id, 'autorizar_egreso', p_autorizacion_id);
    end if;
  end if;

  insert into public.movimientos_caja (local_id, sesion_caja_id, tipo, concepto, descripcion, monto, sustento_url,
                                       autorizado_por)
  values (v_sesion.local_id, p_sesion_id, p_tipo, p_concepto, nullif(trim(p_descripcion), ''), round(p_monto, 2),
          nullif(trim(p_sustento_url), ''), v_autorizado)
  returning id into v_id;

  perform app.encolar_en_caja(v_sesion.caja_id, 'movimiento', jsonb_build_object(
    'tipo', 'movimiento', 'movimiento', p_tipo, 'concepto', p_concepto, 'descripcion', nullif(trim(p_descripcion), ''),
    'monto', round(p_monto, 2), 'fecha', now(),
    'cajero', (select nombre_visible from public.usuarios_perfil where user_id = auth.uid())
  ));
  return jsonb_build_object('movimiento_id', v_id, 'autorizado_por', v_autorizado);
end;
$$;
revoke all on function public.registrar_movimiento_caja(uuid, text, text, numeric, text, text, uuid) from public, anon;
grant execute on function public.registrar_movimiento_caja(uuid, text, text, numeric, text, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- CU15.2 Corte X: parcial, sin cerrar. No muestra el efectivo esperado (el arqueo del Z es ciego).
-- -----------------------------------------------------------------------------
create or replace function public.corte_x(p_sesion_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.sesiones_caja%rowtype := app.sesion_abierta(p_sesion_id);
  v_numero integer;
  v_totales jsonb;
begin
  perform app.exigir_permiso(v_sesion.local_id, 'operar_caja');
  select coalesce(max(numero), 0) + 1 into v_numero
  from public.cortes_caja where sesion_caja_id = p_sesion_id and tipo = 'X';
  v_totales := app.totales_sesion(p_sesion_id) - 'efectivo_esperado';
  insert into public.cortes_caja (local_id, sesion_caja_id, tipo, numero, totales, generado_por)
  values (v_sesion.local_id, p_sesion_id, 'X', v_numero, v_totales, auth.uid());
  perform app.encolar_en_caja(v_sesion.caja_id, 'corte_x', jsonb_build_object(
    'tipo', 'corte_x', 'numero', v_numero, 'fecha', now(), 'abierta_at', v_sesion.abierta_at,
    'caja', (select nombre from public.cajas where id = v_sesion.caja_id),
    'cajero', (select nombre_visible from public.usuarios_perfil where user_id = v_sesion.cajero_id),
    'totales', v_totales
  ));
  return jsonb_build_object('numero', v_numero, 'totales', v_totales);
end;
$$;
revoke all on function public.corte_x(uuid) from public, anon;
grant execute on function public.corte_x(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- CU15.3 Cierre Z con arqueo ciego por denominaciones. Si quedan mesas abiertas en el local, se
-- bloquea salvo que pasen al siguiente turno con autorización. La sesión cerrada es inmutable.
-- -----------------------------------------------------------------------------
create or replace function public.cerrar_caja(
  p_sesion_id uuid,
  p_desglose jsonb,
  p_observaciones text default null,
  p_transferir_mesas boolean default false,
  p_autorizacion_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.sesiones_caja%rowtype := app.sesion_abierta(p_sesion_id);
  v_contado numeric := 0;
  v_clave text;
  v_cantidad jsonb;
  v_totales jsonb;
  v_esperado numeric;
  v_numero integer;
  v_abiertas integer;
  v_autorizado uuid;
begin
  perform app.exigir_permiso(v_sesion.local_id, 'operar_caja');
  if p_desglose is null or jsonb_typeof(p_desglose) <> 'object' then
    perform app.fallar(400, 'desglose_invalido', 'Declare el efectivo por denominaciones');
  end if;
  for v_clave, v_cantidad in select key, value from jsonb_each(p_desglose) loop
    if v_clave not in ('200', '100', '50', '20', '10', '5', '2', '1', '0.5', '0.2', '0.1')
       or jsonb_typeof(v_cantidad) <> 'number'
       or (v_cantidad::text)::numeric < 0
       or (v_cantidad::text)::numeric <> trunc((v_cantidad::text)::numeric) then
      perform app.fallar(400, 'desglose_invalido', 'Denominación o cantidad inválida: ' || v_clave);
    end if;
    v_contado := v_contado + v_clave::numeric * (v_cantidad::text)::numeric;
  end loop;

  select count(*) into v_abiertas
  from public.ordenes
  where local_id = v_sesion.local_id and estado in ('abierta', 'precuenta');
  if v_abiertas > 0 then
    if not coalesce(p_transferir_mesas, false) then
      perform app.fallar(409, 'mesas_abiertas',
        'Quedan ' || v_abiertas || ' mesas abiertas: cóbrelas o páselas al siguiente turno con autorización');
    end if;
    v_autorizado := app.autorizador(v_sesion.local_id, 'autorizar_cierre_con_mesas', p_autorizacion_id);
  end if;

  v_totales := app.totales_sesion(p_sesion_id);
  v_esperado := (v_totales ->> 'efectivo_esperado')::numeric;
  select coalesce(max(numero_z), 0) + 1 into v_numero from public.sesiones_caja where caja_id = v_sesion.caja_id;
  v_totales := v_totales || jsonb_build_object(
    'efectivo_contado', round(v_contado, 2),
    'diferencia', round(v_contado - v_esperado, 2),
    'desglose', p_desglose,
    'mesas_transferidas', v_abiertas,
    'transferencia_autorizada_por', v_autorizado
  );

  update public.sesiones_caja
  set estado = 'cerrada',
      cerrada_at = now(),
      efectivo_esperado = v_esperado,
      efectivo_contado = round(v_contado, 2),
      desglose_denominaciones = p_desglose,
      diferencia = round(v_contado - v_esperado, 2),
      observaciones = nullif(trim(p_observaciones), ''),
      numero_z = v_numero
  where id = p_sesion_id;

  insert into public.cortes_caja (local_id, sesion_caja_id, tipo, numero, totales, generado_por)
  values (v_sesion.local_id, p_sesion_id, 'Z', v_numero, v_totales, auth.uid());

  perform app.encolar_en_caja(v_sesion.caja_id, 'corte_z', jsonb_build_object(
    'tipo', 'corte_z', 'numero', v_numero, 'fecha', now(), 'abierta_at', v_sesion.abierta_at,
    'caja', (select nombre from public.cajas where id = v_sesion.caja_id),
    'cajero', (select nombre_visible from public.usuarios_perfil where user_id = v_sesion.cajero_id),
    'totales', v_totales
  ));
  return jsonb_build_object(
    'numero_z', v_numero,
    'efectivo_esperado', v_esperado,
    'efectivo_contado', round(v_contado, 2),
    'diferencia', round(v_contado - v_esperado, 2),
    'totales', v_totales
  );
end;
$$;
revoke all on function public.cerrar_caja(uuid, jsonb, text, boolean, uuid) from public, anon;
grant execute on function public.cerrar_caja(uuid, jsonb, text, boolean, uuid) to authenticated;

-- Sesión abierta de una caja (la PWA la consulta al entrar a caja).
create or replace function public.sesion_caja_actual(p_caja_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caja public.cajas%rowtype;
begin
  select * into v_caja from public.cajas where id = p_caja_id;
  if not found then
    perform app.fallar(404, 'caja_no_encontrada', 'La caja no existe');
  end if;
  if not (app.tiene_permiso(v_caja.local_id, 'operar_caja') or app.tiene_permiso(v_caja.local_id, 'cobrar_emitir')) then
    perform app.fallar(403, 'sin_permiso', 'No tiene permiso para operar la caja');
  end if;
  return (
    select jsonb_build_object('sesion_id', s.id, 'abierta_at', s.abierta_at, 'monto_apertura', s.monto_apertura,
                              'cajero_id', s.cajero_id,
                              'cajero', (select nombre_visible from public.usuarios_perfil where user_id = s.cajero_id))
    from public.sesiones_caja s
    where s.caja_id = p_caja_id and s.estado = 'abierta'
  );
end;
$$;
revoke all on function public.sesion_caja_actual(uuid) from public, anon;
grant execute on function public.sesion_caja_actual(uuid) to authenticated;
