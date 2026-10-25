-- Permisos por rol (§4) y reglas de sesión (§4.1): MFA para admin/auditor, PIN ligado al dispositivo.
begin;
\ir _helpers.psql
select plan(29);

select pg_temp.crear_empresa_y_locales();
-- Local A = Grill Prueba
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000021', 'admin@prueba.test', 'Admin');
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000022', 'auditor@prueba.test', 'Auditor');
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000023', 'mozo@prueba.test', 'Mozo');
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000024', 'cajero@prueba.test', 'Cajero');
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000025', 'cocina@prueba.test', 'Cocina');
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000026', 'cajero2@prueba.test', 'Cajero 2');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000021', 'e2000000-0000-4000-8000-00000000000a', 'admin');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000022', 'e2000000-0000-4000-8000-00000000000a', 'auditor');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000023', 'e2000000-0000-4000-8000-00000000000a', 'mozo');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000024', 'e2000000-0000-4000-8000-00000000000a', 'cajero');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000025', 'e2000000-0000-4000-8000-00000000000a', 'cocina');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000026', 'e2000000-0000-4000-8000-00000000000a', 'cajero');
-- Usuario con dos roles: admin (MFA) y cajero (PIN).
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000027', 'admin.cajero@prueba.test', 'Admin y cajero');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000027', 'e2000000-0000-4000-8000-00000000000a', 'admin');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000027', 'e2000000-0000-4000-8000-00000000000a', 'cajero');
-- Cambio de perfil (evento de auditoría sin local).
update public.usuarios_perfil set nombre_visible = 'Mozo renombrado'
where user_id = 'f0000000-0000-4000-8000-000000000023';

create temp table disp as select pg_temp.crear_dispositivo('e2000000-0000-4000-8000-00000000000a') as id;
grant select on disp to authenticated, service_role;

-- Datos de caja y pagos para probar la visibilidad.
insert into public.cajas (id, local_id, nombre)
values ('e7000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', 'Caja R');
insert into public.sesiones_caja (id, local_id, caja_id, cajero_id, monto_apertura) values
  ('e8000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a',
   'e7000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000024', 100);
insert into public.ordenes (id, local_id, numero_dia, fecha_operativa)
values ('e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', 1, current_date);
insert into public.pagos (local_id, orden_id, sesion_caja_id, metodo, monto, monto_recibido, vuelto)
values ('e2000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-000000000002',
        'e8000000-0000-4000-8000-000000000002', 'efectivo', 40, 50, 10);
insert into public.empleados (local_id, nombres, apellidos, cargo, sueldo_base)
values ('e2000000-0000-4000-8000-00000000000a', 'Ana', 'Pérez', 'mozo', 1200);

-- ---------------------------------------------------------------------------
-- Admin: sin MFA no tiene nada; con MFA, todo en su local.
-- ---------------------------------------------------------------------------
select pg_temp.como_aal1('f0000000-0000-4000-8000-000000000021');
select is((select count(*)::int from public.mesas), 0, 'admin sin MFA (aal1) no ve datos');
select is((select count(*)::int from public.audit_log), 0, 'admin sin MFA no ve la auditoría');
select is((public.mi_contexto() ->> 'requiere_mfa')::boolean, true, 'mi_contexto pide MFA al admin aal1');

select pg_temp.como_postgres();
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000021', (select id from disp));
select is((select count(*)::int from public.mesas), 0, 'un admin con sesión PIN no obtiene su rol de admin');

select pg_temp.como_postgres();
select pg_temp.como_mfa('f0000000-0000-4000-8000-000000000021');
select is((select count(*)::int from public.mesas where local_id = 'e2000000-0000-4000-8000-00000000000a'), 2,
  'admin con MFA ve las mesas');
select is((select count(*)::int from public.pagos), 1, 'admin con MFA ve los pagos');
select is((select count(*)::int from public.empleados), 1, 'admin ve la planilla');
select lives_ok(
  $$ update public.mesas set pos_x = 300 where codigo = 'A1' and local_id = 'e2000000-0000-4000-8000-00000000000a' $$,
  'admin mueve una mesa en el plano');
select throws_ok(
  $$ update public.mesas set estado = 'ocupada' where codigo = 'A1' $$,
  '42501', null, 'ni el admin cambia mesas.estado directamente (solo por RPC)');
select throws_ok(
  $$ insert into public.role_permissions (role_id, permission_codigo)
     select id, 'ver_auditoria' from public.roles where codigo = 'mozo' and empresa_id is null $$,
  '42501', null, 'los roles base no se modifican desde la API');

-- ---------------------------------------------------------------------------
-- Auditor: lectura de reportes y bitácora, sin escritura.
-- ---------------------------------------------------------------------------
select pg_temp.como_postgres();
select pg_temp.como_mfa('f0000000-0000-4000-8000-000000000022');
select ok((select count(*) from public.audit_log) > 0, 'auditor ve la bitácora');
select is(
  (select count(*)::int from public.audit_log
   where entidad = 'usuarios_perfil' and accion = 'update' and entidad_id = 'f0000000-0000-4000-8000-000000000023'),
  1, 'auditor ve los cambios de perfil de usuarios de su local (eventos sin local)');
select is((select count(*)::int from public.pagos), 1, 'auditor ve los pagos');
select is(
  pg_temp.filas_afectadas($$ update public.mesas set pos_x = 1 where local_id = 'e2000000-0000-4000-8000-00000000000a' $$),
  0, 'auditor no puede modificar mesas (RLS filtra la actualización)');

-- ---------------------------------------------------------------------------
-- Mozo (PIN): opera el salón, no ve caja, planilla ni auditoría.
-- ---------------------------------------------------------------------------
select pg_temp.como_postgres();
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000023', (select id from disp));
select is((select count(*)::int from public.mesas where local_id = 'e2000000-0000-4000-8000-00000000000a'), 2,
  'mozo con PIN ve las mesas de su local');
select is((select count(*)::int from public.pagos), 0, 'mozo no ve pagos');
select is((select count(*)::int from public.audit_log), 0, 'mozo no ve la auditoría');
select is((select count(*)::int from public.empleados), 0, 'mozo no ve la planilla (sueldos)');
select is((select count(*)::int from public.sesiones_caja), 0, 'mozo no ve sesiones de caja');
select is(
  pg_temp.filas_afectadas($$ update public.mesas set pos_x = 1 where local_id = 'e2000000-0000-4000-8000-00000000000a' $$),
  0, 'mozo no puede editar el plano');

-- Sesión PIN expirada o dispositivo revocado: sin acceso.
select pg_temp.como_postgres();
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000023', (select id from disp), interval '-1 minute');
select is((select count(*)::int from public.mesas), 0, 'una sesión PIN de más de 12 h ya no da acceso');

select pg_temp.como_postgres();
select pg_temp.como_aal1('f0000000-0000-4000-8000-000000000023');
select is((select count(*)::int from public.mesas), 0, 'un mozo sin sesión de dispositivo no ve nada');

-- ---------------------------------------------------------------------------
-- Cajero: ve pagos y solo sus sesiones de caja.
-- ---------------------------------------------------------------------------
select pg_temp.como_postgres();
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000024', (select id from disp));
select is((select count(*)::int from public.pagos), 1, 'cajero ve los pagos');
select is((select count(*)::int from public.sesiones_caja), 1, 'cajero ve su sesión de caja');

select pg_temp.como_postgres();
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000026', (select id from disp));
select is((select count(*)::int from public.sesiones_caja), 0, 'cajero no ve la sesión de otro cajero');

-- ---------------------------------------------------------------------------
-- Cocina: KDS, sin pagos.
-- ---------------------------------------------------------------------------
select pg_temp.como_postgres();
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000025', (select id from disp));
select is((select count(*)::int from public.pagos), 0, 'cocina no ve pagos');

-- Admin que además es cajero, con PIN: solo vale el rol de cajero y no se le pide MFA.
select pg_temp.como_postgres();
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000027', (select id from disp));
select is((public.mi_contexto() ->> 'requiere_mfa')::boolean, false,
  'con sesión PIN no se pide MFA aunque el usuario también sea admin');
select is(public.mi_contexto() -> 'locales' -> 0 -> 'roles', '["cajero"]'::jsonb,
  'con sesión PIN solo cuenta el rol sin MFA');

-- Revocar el dispositivo corta el acceso al instante.
select pg_temp.como_postgres();
update public.dispositivos set activo = false where id = (select id from disp);
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000025', (select id from disp));
select is((select count(*)::int from public.mesas), 0, 'un dispositivo desactivado no da acceso');

select * from finish();
rollback;
