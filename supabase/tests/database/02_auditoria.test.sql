-- Bitácora append-only (§5.8), prohibición de borrado físico, historial de precios e inmutabilidad del Z.
begin;
\ir _helpers.psql
select plan(14);

select pg_temp.crear_empresa_y_locales();
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000011', 'admin.audit@prueba.test', 'Admin');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000011', 'e2000000-0000-4000-8000-00000000000a', 'admin');

-- Una orden creada "por" el admin (como lo haría una RPC) queda auditada con su usuario.
select set_config('request.jwt.claims',
  '{"sub":"f0000000-0000-4000-8000-000000000011","role":"authenticated","aal":"aal2"}', true);
insert into public.ordenes (id, local_id, numero_dia, fecha_operativa, mozo_id)
values ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a', 1, current_date,
        'f0000000-0000-4000-8000-000000000011');

select is(
  (select user_id from public.audit_log where entidad = 'ordenes' and entidad_id = 'e4000000-0000-4000-8000-000000000001'
     and accion = 'insert'),
  'f0000000-0000-4000-8000-000000000011'::uuid,
  'insertar una orden deja una entrada de auditoría con el usuario');

update public.ordenes set nota = 'sin cebolla' where id = 'e4000000-0000-4000-8000-000000000001';
select is(
  (select despues ->> 'nota' from public.audit_log where entidad = 'ordenes' and accion = 'update'
     and entidad_id = 'e4000000-0000-4000-8000-000000000001'),
  'sin cebolla',
  'la actualización guarda el estado anterior y el nuevo');

select throws_ok(
  $$ delete from public.ordenes where id = 'e4000000-0000-4000-8000-000000000001' $$,
  '23001', null, 'no se puede borrar físicamente una orden');

-- audit_log: append-only incluso para postgres y service_role.
select throws_ok($$ update public.audit_log set accion = 'x' $$, '42501', null,
  'postgres no puede modificar audit_log');
select throws_ok($$ delete from public.audit_log $$, '42501', null,
  'postgres no puede borrar de audit_log');
select throws_ok($$ truncate public.audit_log $$, '42501', null,
  'postgres no puede vaciar audit_log');

select set_config('role', 'service_role', true);
select throws_ok($$ update public.audit_log set accion = 'x' $$, '42501', null,
  'service_role no puede modificar audit_log');
select throws_ok($$ delete from public.audit_log $$, '42501', null,
  'service_role no puede borrar de audit_log');
select pg_temp.como_postgres();

-- La bitácora no copia el hash del token de los dispositivos.
select pg_temp.crear_dispositivo('e2000000-0000-4000-8000-00000000000a');
select ok(
  not exists (select 1 from public.audit_log where entidad = 'dispositivos' and despues ? 'token_hash')
  and exists (select 1 from public.audit_log where entidad = 'dispositivos'),
  'la auditoría de dispositivos excluye token_hash');

-- Historial de precios: el cambio exige motivo y queda registrado.
insert into public.categorias (id, local_id, nombre)
values ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a', 'Cat');
insert into public.productos (id, local_id, categoria_id, nombre, precio)
values ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a',
        'e5000000-0000-4000-8000-000000000001', 'Lomo', 30.00);

select throws_ok(
  $$ update public.productos set precio = 32.00 where id = 'e6000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'cambiar el precio sin motivo se rechaza');

select set_config('warike.motivo_cambio_precio', 'Alza de insumos', true);
update public.productos set precio = 32.00 where id = 'e6000000-0000-4000-8000-000000000001';
select results_eq(
  $$ select precio_anterior, precio_nuevo, motivo from public.producto_precio_historial
     where producto_id = 'e6000000-0000-4000-8000-000000000001' $$,
  $$ values (30.00::numeric(12,2), 32.00::numeric(12,2), 'Alza de insumos'::text) $$,
  'el cambio de precio queda en el historial con su motivo');

-- Sesión de caja cerrada: inmutable.
insert into public.cajas (id, local_id, nombre)
values ('e7000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a', 'Caja T');
insert into public.sesiones_caja (id, local_id, caja_id, cajero_id, monto_apertura, estado, cerrada_at,
                                  efectivo_esperado, efectivo_contado, diferencia, numero_z)
values ('e8000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a',
        'e7000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000011',
        100, 'cerrada', now(), 250, 245, -5, 1);

select throws_ok(
  $$ update public.sesiones_caja set efectivo_contado = 250 where id = 'e8000000-0000-4000-8000-000000000001' $$,
  '23001', null, 'una sesión de caja cerrada no se puede modificar');
select throws_ok(
  $$ delete from public.sesiones_caja where id = 'e8000000-0000-4000-8000-000000000001' $$,
  '23001', null, 'una sesión de caja no se puede borrar');

select is(
  (select count(*)::int from public.audit_log where entidad = 'sesiones_caja'
     and entidad_id = 'e8000000-0000-4000-8000-000000000001'),
  1, 'la apertura/cierre de caja queda auditada');

select * from finish();
rollback;
