-- Caja (M15): apertura, ingresos y egresos, corte X y cierre Z con arqueo ciego.
begin;
\ir _helpers.psql
\ir _salon.psql
select plan(28);

select pg_temp.crear_salon_prueba();
select pg_temp.guardar('local', 'e2000000-0000-4000-8000-00000000000a');
insert into public.cajas (id, local_id, nombre, impresora_id)
values ('ec000000-0000-4000-8000-000000000001', pg_temp.id('local'), 'Caja 1', pg_temp.id('imp_cocina'));
select pg_temp.guardar('caja1', 'ec000000-0000-4000-8000-000000000001');
insert into public.config_local (local_id) values (pg_temp.id('local')) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Apertura
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.abrir_caja(pg_temp.id('caja1'), 200) $$), 'PT403:sin_permiso',
  'el mozo no abre caja');
select pg_temp.como('cajero');
select is(pg_temp.error_de($$ select public.abrir_caja(pg_temp.id('caja1'), -1) $$), 'PT400:monto_invalido',
  'el monto de apertura no puede ser negativo');
select pg_temp.guardar('sesion', (public.abrir_caja(pg_temp.id('caja1'), 200) ->> 'sesion_id')::uuid);
select isnt(pg_temp.id('sesion'), null, 'el cajero abre la caja con S/ 200');
select is(pg_temp.error_de($$ select public.abrir_caja(pg_temp.id('caja1'), 100) $$), 'PT409:caja_ya_abierta',
  'una caja tiene una sola sesión abierta');
select is(public.sesion_caja_actual(pg_temp.id('caja1')) ->> 'sesion_id', pg_temp.id('sesion')::text,
  'la PWA encuentra la sesión abierta de la caja');

-- ---------------------------------------------------------------------------
-- Ingresos y egresos
-- ---------------------------------------------------------------------------
select lives_ok($$ select public.registrar_movimiento_caja(pg_temp.id('sesion'), 'ingreso', 'sencillo', 20) $$,
  'registra un ingreso de sencillo');
select lives_ok($$ select public.registrar_movimiento_caja(pg_temp.id('sesion'), 'egreso', 'compra_insumos', 35.5, 'Limones') $$,
  'un egreso bajo el umbral no pide autorización');
select is(pg_temp.error_de($$ select public.registrar_movimiento_caja(pg_temp.id('sesion'), 'egreso', 'pago_proveedor', 150) $$),
  'PT403:requiere_autorizacion', 'un egreso sobre el umbral (S/ 100) pide autorización');
select is(pg_temp.error_de($$ select public.registrar_movimiento_caja(pg_temp.id('sesion'), 'egreso', 'otro', 10) $$),
  'PT400:descripcion_requerida', 'el concepto "otro" exige descripción');
select is(pg_temp.error_de($$ select public.registrar_movimiento_caja(pg_temp.id('sesion'), 'egreso', 'propinas', 10) $$),
  'PT400:concepto_invalido', 'el concepto debe ser del catálogo');
select pg_temp.guardar('aut_egreso', (public.autorizar_con_pin(pg_temp.id('local'), 'autorizar_egreso', 'ADM', '7531')
  ->> 'autorizacion_id')::uuid);
select is((public.registrar_movimiento_caja(pg_temp.id('sesion'), 'egreso', 'pago_proveedor', 150, 'Carnes',
    null, pg_temp.id('aut_egreso')) ->> 'autorizado_por')::uuid, pg_temp.id('admin'),
  'con el PIN del admin el egreso queda autorizado por él');
select pg_temp.como_postgres();
select is((select count(*) from public.print_jobs where tipo = 'movimiento' and local_id = pg_temp.id('local')), 3::bigint,
  'cada movimiento se imprime en la caja');

-- ---------------------------------------------------------------------------
-- Pagos del flujo D (aquí directos; cobrar_y_emitir llega con la facturación)
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo');
select pg_temp.guardar('o1', (public.abrir_orden(pg_temp.id('A1'), 2) ->> 'orden_id')::uuid);
select pg_temp.como_postgres();
insert into public.pagos (local_id, orden_id, sesion_caja_id, metodo, canal, monto, monto_recibido, vuelto, referencia) values
  (pg_temp.id('local'), pg_temp.id('o1'), pg_temp.id('sesion'), 'yape', 'manual', 50, null, null, 'OP123'),
  (pg_temp.id('local'), pg_temp.id('o1'), pg_temp.id('sesion'), 'visa', 'manual', 60, null, null, 'V-0001'),
  (pg_temp.id('local'), pg_temp.id('o1'), pg_temp.id('sesion'), 'efectivo', 'manual', 40, 50, 10, null),
  (pg_temp.id('local'), pg_temp.id('o1'), pg_temp.id('sesion'), 'efectivo', 'manual', 12.3, null, null, null);

-- ---------------------------------------------------------------------------
-- Corte X
-- ---------------------------------------------------------------------------
select pg_temp.como('cajero');
select is((public.corte_x(pg_temp.id('sesion')) -> 'totales' -> 'pagos_por_metodo'),
  '{"efectivo": 52.30, "visa": 60.00, "yape": 50.00}'::jsonb, 'el X suma los pagos por método (CA de M12)');
select is((public.corte_x(pg_temp.id('sesion')) ->> 'numero')::integer, 2, 'los X se numeran dentro de la sesión');
select ok(not ((select totales from public.cortes_caja where sesion_caja_id = pg_temp.id('sesion') and numero = 1) ? 'efectivo_esperado'),
  'el X no muestra el efectivo esperado: el arqueo es ciego');

-- ---------------------------------------------------------------------------
-- Cierre Z
-- ---------------------------------------------------------------------------
select is(pg_temp.error_de($$ select public.cerrar_caja(pg_temp.id('sesion'), '{"100": 1}') $$),
  'PT409:mesas_abiertas', 'con mesas abiertas no se cierra');
select is(pg_temp.error_de($$ select public.cerrar_caja(pg_temp.id('sesion'), '{"100": 1}', null, true) $$),
  'PT403:requiere_autorizacion', 'pasar las mesas al siguiente turno exige autorización');
select is(pg_temp.error_de($$ select public.cerrar_caja(pg_temp.id('sesion'), '{"3": 1}', null, true) $$),
  'PT400:desglose_invalido', 'solo denominaciones válidas');
select is(pg_temp.error_de($$ select public.cerrar_caja(pg_temp.id('sesion'), '{"10": 1.5}', null, true) $$),
  'PT400:desglose_invalido', 'las cantidades son enteras');

-- Esperado: 200 + (12,30 + 50 recibidos − 10 vuelto) + 20 − 35,50 − 150 = 86,80. Se declaran 86,30.
select pg_temp.guardar('aut_cierre', (public.autorizar_con_pin(pg_temp.id('local'), 'autorizar_cierre_con_mesas', 'ADM', '7531')
  ->> 'autorizacion_id')::uuid);
create temp table z as
select public.cerrar_caja(pg_temp.id('sesion'), '{"50": 1, "20": 1, "10": 1, "5": 1, "1": 1, "0.2": 1, "0.1": 1}',
  'Falta medio sol', true, pg_temp.id('aut_cierre')) as r;
grant select on z to authenticated;
select is((select (r ->> 'efectivo_esperado')::numeric from z), 86.80, 'efectivo esperado según la fórmula de M15');
select is((select (r ->> 'efectivo_contado')::numeric from z), 86.30, 'efectivo contado por denominaciones');
select is((select (r ->> 'diferencia')::numeric from z), -0.50, 'la diferencia es contado − esperado');
select is((select (r ->> 'numero_z')::integer from z), 1, 'el Z se numera por caja');

select pg_temp.como_postgres();
select results_eq(
  $$ select estado, efectivo_esperado, efectivo_contado, diferencia, numero_z from public.sesiones_caja where id = pg_temp.id('sesion') $$,
  $$ values ('cerrada', 86.80::numeric(12, 2), 86.30::numeric(12, 2), -0.50::numeric(12, 2), 1) $$,
  'la sesión queda cerrada con su arqueo');
select is((select (totales ->> 'mesas_transferidas')::integer from public.cortes_caja where sesion_caja_id = pg_temp.id('sesion') and tipo = 'Z'),
  1, 'el Z registra las mesas que pasan al siguiente turno');
select throws_ok($$ update public.sesiones_caja set observaciones = 'cambio' where id = pg_temp.id('sesion') $$,
  '23001', null, 'una sesión cerrada es inmutable');
select pg_temp.como('cajero');
select is(pg_temp.error_de($$ select public.registrar_movimiento_caja(pg_temp.id('sesion'), 'ingreso', 'sencillo', 5) $$),
  'PT409:sesion_cerrada', 'no se registran movimientos en una sesión cerrada');
select pg_temp.como_postgres();
select is((select count(*) from public.print_jobs where tipo in ('corte_x', 'corte_z') and local_id = pg_temp.id('local')), 3::bigint,
  'los dos X y el Z se imprimen en la caja');

select * from finish();
rollback;
