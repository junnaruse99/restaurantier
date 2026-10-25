-- CA M4 / M18: los datos se aíslan por local. Un mozo asignado solo a "Urban" no ve nada de "Grill".
begin;
\ir _helpers.psql
select plan(13);

select pg_temp.crear_empresa_y_locales();
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000001', 'mozo.urban@prueba.test', 'Mozo Urban');
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000002', 'admin.grill@prueba.test', 'Admin Grill');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000b', 'mozo');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', 'admin');
-- Otra empresa con su propio cajero.
insert into public.empresas (id, ruc, razon_social)
values ('e1000000-0000-4000-8000-000000000002', '20999999992', 'OTRA EMPRESA SAC');
insert into public.locales (id, empresa_id, nombre)
values ('e2000000-0000-4000-8000-00000000000c', 'e1000000-0000-4000-8000-000000000002', 'Local ajeno');
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000003', 'cajero.ajeno@prueba.test', 'Cajero ajeno');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-00000000000c', 'cajero');

create temp table disp as
select pg_temp.crear_dispositivo('e2000000-0000-4000-8000-00000000000b') as urban,
       pg_temp.crear_dispositivo('e2000000-0000-4000-8000-00000000000a') as grill;
grant select on disp to authenticated, service_role;

-- Mozo de Urban con sesión PIN en una tablet de Urban
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000001', (select urban from disp));

select is(
  (select count(*)::int from public.mesas where local_id = 'e2000000-0000-4000-8000-00000000000a'),
  0, 'el mozo de Urban no ve las mesas de Grill');
select is(
  (select count(*)::int from public.mesas where local_id = 'e2000000-0000-4000-8000-00000000000b'),
  1, 'el mozo de Urban ve las mesas de Urban');
select is(
  (select count(*)::int from public.mesas where local_id = 'b0000000-0000-4000-8000-000000000001'),
  0, 'el mozo de Urban no ve las mesas de Warike Resto Grill (semilla)');
select is(
  (select array_agg(nombre) from public.locales),
  array['Urban Prueba'], 'solo ve su local');
select is(
  (select count(*)::int from public.pisos where local_id <> 'e2000000-0000-4000-8000-00000000000b'),
  0, 'no ve pisos de otros locales');
select is(
  (select count(*)::int from public.productos where local_id = 'b0000000-0000-4000-8000-000000000001'),
  0, 'no ve la carta de otro local');

-- El mismo mozo con una sesión PIN en una tablet de Grill (donde no tiene rol) no ve nada.
select pg_temp.como_postgres();
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000001', (select grill from disp));
select is((select count(*)::int from public.mesas), 0,
  'una sesión PIN en un dispositivo de otro local no da acceso a ningún local');

-- El admin de Grill (MFA) no ve Urban.
select pg_temp.como_postgres();
select pg_temp.como_mfa('f0000000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from public.mesas where local_id = 'e2000000-0000-4000-8000-00000000000b'),
  0, 'el admin de Grill no ve las mesas de Urban');
select is(
  (select count(*)::int from public.mesas where local_id = 'e2000000-0000-4000-8000-00000000000a'),
  2, 'el admin de Grill ve las mesas de Grill');

-- Y no puede asignarse roles en Urban.
select throws_ok(
  $$ insert into public.user_local_roles (user_id, local_id, role_id)
     select 'f0000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000b', id
     from public.roles where codigo = 'admin' and empresa_id is null $$,
  '42501', null, 'el admin de Grill no puede darse roles en Urban');

-- Solo asigna roles a usuarios de su empresa: no puede "adoptar" a un usuario de otra empresa
-- para luego cambiarle el PIN o desactivarlo.
select throws_ok(
  $$ insert into public.user_local_roles (user_id, local_id, role_id)
     select 'f0000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-00000000000a', id
     from public.roles where codigo = 'mozo' and empresa_id is null $$,
  '42501', null, 'el admin no puede asignar roles a un usuario de otra empresa');
select throws_ok(
  $$ select public.establecer_pin('f0000000-0000-4000-8000-000000000003', '2580') $$,
  '42501', null, 'el admin no puede cambiar el PIN de un usuario de otra empresa');
select lives_ok(
  $$ insert into public.user_local_roles (user_id, local_id, role_id)
     select 'f0000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a', id
     from public.roles where codigo = 'cajero' and empresa_id is null $$,
  'el admin sí asigna roles en su local a un usuario de su misma empresa');

select * from finish();
rollback;
