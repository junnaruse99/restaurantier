-- pin-login (§4.1): dispositivo registrado + código + PIN, 5 intentos fallidos → bloqueo de 15 min.
begin;
\ir _helpers.psql
select plan(24);

select pg_temp.crear_empresa_y_locales();
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000031', 'u-7001@pin.prueba.test', 'Mozo PIN');
select pg_temp.crear_usuario('f0000000-0000-4000-8000-000000000032', 'admin.pin@prueba.test', 'Admin PIN');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000031', 'e2000000-0000-4000-8000-00000000000a', 'mozo');
select pg_temp.asignar_rol('f0000000-0000-4000-8000-000000000032', 'e2000000-0000-4000-8000-00000000000a', 'admin');
update public.usuarios_perfil set codigo_empleado = '7001' where user_id = 'f0000000-0000-4000-8000-000000000031';
update public.usuarios_perfil set codigo_empleado = '7002' where user_id = 'f0000000-0000-4000-8000-000000000032';

create temp table disp as
select pg_temp.crear_dispositivo('e2000000-0000-4000-8000-00000000000a') as tablet,
       pg_temp.crear_dispositivo('e2000000-0000-4000-8000-00000000000a', 'agente_impresion') as agente,
       pg_temp.crear_dispositivo('e2000000-0000-4000-8000-00000000000b') as tablet_urban;
grant select on disp to authenticated, service_role;

-- El admin define los PIN (con MFA).
select pg_temp.como_mfa('f0000000-0000-4000-8000-000000000032');
select throws_ok($$ select public.establecer_pin('f0000000-0000-4000-8000-000000000031', '1234') $$,
  '22023', null, 'se rechaza un PIN en secuencia');
select throws_ok($$ select public.establecer_pin('f0000000-0000-4000-8000-000000000031', '7777') $$,
  '22023', null, 'se rechaza un PIN con un solo dígito repetido');
select throws_ok($$ select public.establecer_pin('f0000000-0000-4000-8000-000000000031', '12a4') $$,
  '22023', null, 'se rechaza un PIN no numérico');
select lives_ok($$ select public.establecer_pin('f0000000-0000-4000-8000-000000000031', '2580') $$,
  'el admin define el PIN del mozo');
select lives_ok($$ select public.establecer_pin('f0000000-0000-4000-8000-000000000032', '7531') $$,
  'el admin define su propio PIN de supervisor');

-- Un mozo no puede definir PIN.
select pg_temp.como_postgres();
select pg_temp.como_pin('f0000000-0000-4000-8000-000000000031', (select tablet from disp));
select throws_ok($$ select public.establecer_pin('f0000000-0000-4000-8000-000000000031', '9512') $$,
  '42501', null, 'un mozo no puede cambiar PIN');
select throws_ok($$ select public.pin_login_verificar('x', '7001', '2580') $$,
  '42501', null, 'authenticated no puede llamar a pin_login_verificar');

select pg_temp.como_postgres();
select set_config('role', 'service_role', true);

-- Inicio correcto
select is(
  (public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7001', '2580')) ->> 'ok',
  'true', 'PIN correcto en dispositivo registrado: ok');
select is(
  (public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7001', '2580')) ->> 'local_id',
  'e2000000-0000-4000-8000-00000000000a', 'devuelve el local del dispositivo');

-- Errores de dispositivo y de rol
select is(
  (public.pin_login_verificar('wkd_' || repeat('0', 64), '7001', '2580')) ->> 'error',
  'dispositivo_no_autorizado', 'token de dispositivo desconocido');
select is(
  (public.pin_login_verificar(pg_temp.token_de((select agente from disp)), '7001', '2580')) ->> 'error',
  'dispositivo_no_autorizado', 'un agente de impresión no sirve para iniciar sesión');
select is(
  (public.pin_login_verificar(pg_temp.token_de((select tablet_urban from disp)), '7001', '2580')) ->> 'error',
  'sin_rol_en_local', 'el mozo no tiene rol en el local del dispositivo');
select is(
  (public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7002', '7531')) ->> 'error',
  'sin_rol_en_local', 'admin y auditor no inician sesión con PIN (requieren MFA)');
select is(
  (public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '9999', '2580')) ->> 'error',
  'credenciales_invalidas', 'código de empleado inexistente');

-- Fuerza bruta: 4 fallos dan intentos restantes, el 5.º bloquea 15 min.
select is(
  (public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7001', '0000')) ->> 'intentos_restantes',
  '4', 'primer fallo: quedan 4 intentos');
select public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7001', '0000');
select public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7001', '0000');
select public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7001', '0000');
select is(
  (public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7001', '0000')) ->> 'error',
  'bloqueado', 'quinto fallo: usuario bloqueado');
select is(
  (public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7001', '2580')) ->> 'error',
  'bloqueado', 'bloqueado aunque el PIN sea correcto');
select pg_temp.como_postgres();
select ok(
  (select bloqueado_hasta between now() + interval '14 minutes' and now() + interval '16 minutes'
   from app.pin_credenciales where user_id = 'f0000000-0000-4000-8000-000000000031'),
  'el bloqueo dura 15 minutos');
select is(
  (select count(*)::int from public.audit_log
   where accion in ('login_pin_fallido', 'login_pin_bloqueado') and user_id = 'f0000000-0000-4000-8000-000000000031'),
  6, 'los intentos fallidos y el bloqueo quedan en la auditoría');

-- Pasado el bloqueo vuelve a entrar.
update app.pin_credenciales set bloqueado_hasta = now() - interval '1 second'
where user_id = 'f0000000-0000-4000-8000-000000000031';
select set_config('role', 'service_role', true);
select is(
  (public.pin_login_verificar(pg_temp.token_de((select tablet from disp)), '7001', '2580')) ->> 'ok',
  'true', 'tras el bloqueo, el PIN correcto vuelve a funcionar');

-- Registro de la sesión: 12 h ligada al dispositivo.
select ok(
  (select (r ->> 'expira_at')::timestamptz between now() + interval '11 hours 59 minutes' and now() + interval '12 hours 1 minute'
   from (select public.pin_login_registrar_sesion('f0000000-0000-4000-8000-000000000031', (select tablet from disp),
                                                  'e9000000-0000-4000-8000-000000000001') as r) x),
  'la sesión PIN dura 12 horas');
select pg_temp.como_postgres();
select is(
  (select dispositivo_id from app.sesiones_dispositivo where session_id = 'e9000000-0000-4000-8000-000000000001'),
  (select tablet from disp), 'la sesión queda ligada al dispositivo');

-- Registrar dispositivos exige configurar_local.
select pg_temp.como_mfa('f0000000-0000-4000-8000-000000000032');
select ok(
  (public.registrar_dispositivo('e2000000-0000-4000-8000-00000000000a', 'Tablet nueva', 'tablet_mozo') ->> 'token')
    ~ '^wkd_[0-9a-f]{64}$',
  'el admin registra un dispositivo y recibe el token una sola vez');
select pg_temp.como_postgres();
select pg_temp.como_mfa('f0000000-0000-4000-8000-000000000031');
select throws_ok(
  $$ select public.registrar_dispositivo('e2000000-0000-4000-8000-00000000000b', 'Intruso', 'tablet_mozo') $$,
  '42501', null, 'sin configurar_local no se registran dispositivos');

select * from finish();
rollback;
