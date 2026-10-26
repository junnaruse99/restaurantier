-- Carta y precios (M3), agente de impresión (§3, §13) y alta de usuarios (M4).
begin;
\ir _helpers.psql
\ir _salon.psql
select plan(62);

select pg_temp.crear_salon_prueba();

create function pg_temp.como_servicio()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end;
$$;

create function pg_temp.como_agente(p_user uuid, p_session uuid)
returns void
language sql
as $$
  select pg_temp.fijar_claims(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1', 'session_id', p_session))
$$;

-- Usuario de Auth sin perfil (lo crea la Edge Function antes de llamar a la base).
create function pg_temp.crear_cuenta_auth(p_id uuid, p_email text)
returns uuid
language sql
as $$
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email, '', now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id;
$$;

-- Una orden abierta con lomo antes del cambio de precio.
select pg_temp.como('mozo');
select pg_temp.guardar('o1', (public.abrir_orden(pg_temp.id('A1'), 2) ->> 'orden_id')::uuid);
select pg_temp.guardar('i_lomo', (public.agregar_items(pg_temp.id('o1'), jsonb_build_array(jsonb_build_object(
  'producto_id', pg_temp.id('lomo'), 'modificadores', '[{"grupo":"Término","nombre":"Jugoso"}]'::jsonb))) -> 'item_ids' ->> 0)::uuid);

-- ---------------------------------------------------------------------------
-- Cambio de precio (CU3.2)
-- ---------------------------------------------------------------------------
select is(pg_temp.error_de($$ select public.cambiar_precio(pg_temp.id('lomo'), 34, 'Alza de insumos') $$), 'PT403:sin_permiso',
  'el mozo no cambia precios');
select pg_temp.como('admin');
select throws_ok($$ update public.productos set precio = 1 where id = pg_temp.id('lomo') $$, '42501', null,
  'el precio no se escribe directo, solo por RPC con motivo');
select is(pg_temp.error_de($$ select public.cambiar_precio(pg_temp.id('lomo'), 34, ' ') $$), 'PT400:motivo_requerido',
  'el cambio de precio exige motivo');
select is(pg_temp.error_de($$ select public.cambiar_precio(pg_temp.id('lomo'), -1, 'Error') $$), 'PT400:precio_invalido',
  'el precio no puede ser negativo');
select is(public.cambiar_precio(pg_temp.id('lomo'), 34.004, 'Alza de insumos') ->> 'precio_nuevo', '34.00',
  'el admin cambia el precio, redondeado a céntimos');
select results_eq(
  $$ select precio_anterior, precio_nuevo, motivo, cambiado_por from public.producto_precio_historial
     where producto_id = pg_temp.id('lomo') $$,
  $$ values (30.00::numeric(12, 2), 34.00::numeric(12, 2), 'Alza de insumos', pg_temp.id('admin')) $$,
  'el historial guarda precio anterior, nuevo, motivo y quién lo cambió');
select is(public.cambiar_precio(pg_temp.id('lomo'), 34, 'Sin cambio') ->> 'cambiado', 'false', 'el mismo precio no cambia nada');
select is((select count(*)::int from public.producto_precio_historial where producto_id = pg_temp.id('lomo')), 1,
  'un precio igual no deja historial');

select pg_temp.como('mozo');
select is((select precio_unitario_snapshot from public.orden_items where id = pg_temp.id('i_lomo')), 30.000000::numeric(14, 6),
  'la orden abierta conserva el precio anterior');
select pg_temp.guardar('i_lomo2', (public.agregar_items(pg_temp.id('o1'), jsonb_build_array(jsonb_build_object(
  'producto_id', pg_temp.id('lomo'), 'modificadores', '[{"grupo":"Término","nombre":"Jugoso"}]'::jsonb))) -> 'item_ids' ->> 0)::uuid);
select is((select precio_unitario_snapshot from public.orden_items where id = pg_temp.id('i_lomo2')), 34.000000::numeric(14, 6),
  'un ítem nuevo toma el precio nuevo');

select pg_temp.como('admin');
select is(pg_temp.error_de($$ select public.cambiar_precios_masivo('e2000000-0000-4000-8000-00000000000a', 0, 'Nada') $$),
  'PT400:porcentaje_invalido', 'el porcentaje masivo no puede ser cero');
select is((public.cambiar_precios_masivo('e2000000-0000-4000-8000-00000000000a', 10, 'Ajuste de bebidas',
  'e9000000-0000-4000-8000-000000000002') ->> 'productos')::int, 1, 'el cambio masivo por categoría toca solo esa categoría');
select results_eq(
  $$ select (select precio from public.productos where id = pg_temp.id('chicha')),
            (select precio from public.productos where id = pg_temp.id('lomo')),
            (select motivo from public.producto_precio_historial where producto_id = pg_temp.id('chicha')) $$,
  $$ values (8.80::numeric(12, 2), 34.00::numeric(12, 2), 'Ajuste de bebidas') $$,
  'el cambio masivo redondea, deja historial y no toca otras categorías');

-- Agotado (CU3.3)
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.marcar_disponibilidad(pg_temp.id('lomo'), false) $$), 'PT403:sin_permiso',
  'el mozo no marca agotados');
select pg_temp.como('cocina');
select lives_ok($$ select public.marcar_disponibilidad(pg_temp.id('lomo'), false) $$, 'cocina marca un plato agotado (D-027)');
select is((select disponible from public.productos where id = pg_temp.id('lomo')), false, 'el producto queda agotado');

-- ---------------------------------------------------------------------------
-- Agente de impresión: ingreso con el token de su dispositivo
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo');
select throws_ok($$ select public.agente_preparar_sesion(pg_temp.token_de(pg_temp.id('agente'))) $$, '42501', null,
  'el ingreso del agente solo lo hace la Edge Function (service_role)');

select pg_temp.como_postgres();
select pg_temp.como_servicio();
select is(public.agente_preparar_sesion('wkd_' || repeat('0', 64)) ->> 'error', 'dispositivo_no_autorizado',
  'un token desconocido no entra');
select is(public.agente_preparar_sesion(pg_temp.token_de(pg_temp.id('tablet'))) ->> 'error', 'dispositivo_no_autorizado',
  'una tablet no entra como agente');
select is(public.agente_preparar_sesion(pg_temp.token_de(pg_temp.id('agente'))) ->> 'requiere_usuario', 'true',
  'la primera vez el agente necesita su usuario técnico');

select pg_temp.como_postgres();
select pg_temp.guardar('u_agente', pg_temp.crear_cuenta_auth('f1000000-0000-4000-8000-0000000000a1', 'agente-1@agente.warike.invalid'));
select pg_temp.como_servicio();
select lives_ok($$ select public.agente_vincular_usuario(pg_temp.id('agente'), pg_temp.id('u_agente')) $$,
  'se vincula el usuario técnico al dispositivo');
select is(pg_temp.error_de($$ select public.agente_vincular_usuario(pg_temp.id('agente'), pg_temp.id('u_agente')) $$),
  'PT409:agente_ya_vinculado', 'un agente tiene un solo usuario');
select results_eq(
  $$ select r ->> 'requiere_usuario', r ->> 'email' from public.agente_preparar_sesion(pg_temp.token_de(pg_temp.id('agente'))) r $$,
  $$ values ('false', 'agente-1@agente.warike.invalid') $$,
  'después entra con su usuario técnico');
with s as materialized (
  select (public.agente_registrar_sesion(pg_temp.id('agente'), 'ab000000-0000-4000-8000-000000000001') ->> 'expira_at')::timestamptz as e
)
select is(e, now() + interval '24 hours', 'la sesión del agente dura 24 h') from s;
select pg_temp.como_postgres();
select is((select array_agg(r.codigo) from public.user_local_roles ulr join public.roles r on r.id = ulr.role_id
           where ulr.user_id = pg_temp.id('u_agente')), array['agente_impresion'], 'el usuario técnico solo tiene el rol del agente');

-- ---------------------------------------------------------------------------
-- Agente de impresión: cola de trabajos
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.agente_tomar_trabajos() $$), 'PT403:no_es_agente', 'una tablet no toma trabajos');
select is((select count(*)::int from public.print_jobs), 0, 'el mozo no lee la cola de impresión');
select public.enviar_comanda(pg_temp.id('o1'));
select pg_temp.como_postgres();
insert into public.print_jobs (local_id, impresora_id, tipo, payload)
values ('e2000000-0000-4000-8000-00000000000a', pg_temp.id('imp_bar'), 'comanda', '{"tipo":"comanda"}');

select pg_temp.como_agente(pg_temp.id('u_agente'), 'ab000000-0000-4000-8000-000000000001');
select is(jsonb_array_length(public.agente_latido() -> 'impresoras'), 1, 'el latido devuelve las impresoras del agente');
select is((select count(*)::int from public.print_jobs), 2, 'el agente lee la cola de su local');
create temp table tomados as select public.agente_tomar_trabajos() as j;
grant select on tomados to authenticated;
select results_eq(
  $$ select jsonb_array_length(j), j -> 0 -> 'impresora' ->> 'host', (j -> 0 ->> 'intentos')::int, j -> 0 -> 'payload' ->> 'mesa'
     from tomados $$,
  $$ values (1, '10.0.0.5', 1, 'Mesa A1') $$,
  'el agente toma solo los trabajos de sus impresoras, con la foto y los datos de conexión');
select pg_temp.guardar('job1', (select (j -> 0 ->> 'id')::uuid from tomados));
select is(jsonb_array_length(public.agente_tomar_trabajos()), 0, 'un trabajo tomado no se entrega dos veces');

select is(public.agente_reportar_trabajo(pg_temp.id('job1'), false, 'Conexión rechazada') ->> 'estado', 'pendiente',
  'si falla, el trabajo vuelve a la cola');
select pg_temp.como_postgres();
select results_eq(
  $$ select estado, error, reintentar_desde = now() + interval '5 seconds' from public.print_jobs where id = pg_temp.id('job1') $$,
  $$ values ('pendiente', 'Conexión rechazada', true) $$,
  'el reintento espera 5 s la primera vez');
select pg_temp.como_agente(pg_temp.id('u_agente'), 'ab000000-0000-4000-8000-000000000001');
select is(jsonb_array_length(public.agente_tomar_trabajos()), 0, 'no se reintenta antes de tiempo');
select pg_temp.como_postgres();
update public.print_jobs set reintentar_desde = now() - interval '1 second' where id = pg_temp.id('job1');
select pg_temp.como_agente(pg_temp.id('u_agente'), 'ab000000-0000-4000-8000-000000000001');
select is((public.agente_tomar_trabajos() -> 0 ->> 'intentos')::int, 2, 'vencida la espera, se vuelve a tomar');
select is(public.agente_reportar_trabajo(pg_temp.id('job1'), true) ->> 'estado', 'impreso', 'el agente reporta la impresión');
select pg_temp.como_postgres();
select ok((select impreso_at is not null and error is null from public.print_jobs where id = pg_temp.id('job1')),
  'el trabajo impreso guarda la hora y limpia el error');
select pg_temp.como_agente(pg_temp.id('u_agente'), 'ab000000-0000-4000-8000-000000000001');
select is(pg_temp.error_de($$ select public.agente_reportar_trabajo(pg_temp.id('job1'), true) $$), 'PT409:trabajo_no_tomado',
  'no se reporta un trabajo que no está tomado');

-- Tras 20 intentos queda en error para que el admin lo redirija; un tomado abandonado se recupera.
select pg_temp.como_postgres();
insert into public.print_jobs (id, local_id, impresora_id, tipo, payload, estado, intentos, agente_id) values
  ('eb000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a', pg_temp.id('imp_cocina'), 'comanda', '{}',
   'tomado', 20, pg_temp.id('agente')),
  ('eb000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', pg_temp.id('imp_cocina'), 'comanda', '{}',
   'tomado', 1, pg_temp.id('agente'));
set local session_replication_role = replica;
update public.print_jobs set updated_at = now() - interval '5 minutes' where id = 'eb000000-0000-4000-8000-000000000002';
set local session_replication_role = origin;
select pg_temp.como_agente(pg_temp.id('u_agente'), 'ab000000-0000-4000-8000-000000000001');
select is(public.agente_reportar_trabajo('eb000000-0000-4000-8000-000000000001', false, 'Sin papel') ->> 'estado', 'error',
  'tras 20 intentos el trabajo queda en error');
select is((public.agente_tomar_trabajos() -> 0 ->> 'id')::uuid, 'eb000000-0000-4000-8000-000000000002'::uuid,
  'un trabajo tomado hace más de 2 minutos sin reporte se vuelve a entregar');

select is(public.agente_reportar_impresora(pg_temp.id('imp_cocina'), 'sin_papel') ->> 'estado', 'sin_papel',
  'el agente informa que la impresora no tiene papel');
select is((select estado from public.impresoras where id = pg_temp.id('imp_cocina')), 'sin_papel',
  'el estado de la impresora queda visible para la caja');
select is(pg_temp.error_de($$ select public.agente_reportar_impresora(pg_temp.id('imp_bar'), 'ok') $$),
  'PT404:impresora_no_encontrada', 'el agente solo informa de sus impresoras');
select is(pg_temp.error_de($$ select public.agente_reportar_impresora(pg_temp.id('imp_cocina'), 'rota') $$),
  'PT400:estado_invalido', 'el estado de la impresora se valida');

-- Redirigir un trabajo en error (CA §13)
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.redirigir_trabajo('eb000000-0000-4000-8000-000000000001', pg_temp.id('imp_bar')) $$),
  'PT403:sin_permiso', 'el mozo no redirige trabajos');
select pg_temp.como('admin');
select lives_ok($$ select public.redirigir_trabajo('eb000000-0000-4000-8000-000000000001', pg_temp.id('imp_bar')) $$,
  'el admin manda el trabajo a otra impresora');
select results_eq(
  $$ select estado, impresora_id, intentos, agente_id from public.print_jobs where id = 'eb000000-0000-4000-8000-000000000001' $$,
  $$ values ('pendiente', pg_temp.id('imp_bar'), 0, null::uuid) $$,
  'el trabajo redirigido vuelve a la cola desde cero');

-- Un agente desactivado pierde la sesión.
select pg_temp.como_postgres();
update public.dispositivos set activo = false where id = pg_temp.id('agente');
select pg_temp.como_agente(pg_temp.id('u_agente'), 'ab000000-0000-4000-8000-000000000001');
select is(pg_temp.error_de($$ select public.agente_latido() $$), 'PT403:no_es_agente', 'desactivar el dispositivo corta al agente');

-- ---------------------------------------------------------------------------
-- Alta de usuarios (CU4.1)
-- ---------------------------------------------------------------------------
select pg_temp.como_postgres();
insert into public.empresas (id, ruc, razon_social) values ('e1000000-0000-4000-8000-000000000002', '20999999992', 'OTRA SAC');
insert into public.roles (id, empresa_id, codigo, nombre)
values ('ec000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'mozo_otra', 'Mozo de otra empresa');
select pg_temp.guardar('rol_mozo', (select id from public.roles where empresa_id is null and codigo = 'mozo'));
select pg_temp.guardar('rol_admin', (select id from public.roles where empresa_id is null and codigo = 'admin'));
select pg_temp.guardar('rol_agente', (select id from public.roles where empresa_id is null and codigo = 'agente_impresion'));

select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.validar_alta_usuario('e2000000-0000-4000-8000-00000000000a', pg_temp.id('rol_mozo')) $$),
  'PT403:sin_permiso', 'el mozo no da de alta usuarios');
select pg_temp.como('admin');
select results_eq(
  $$ select r ->> 'rol', (r ->> 'requiere_mfa')::boolean, (r ->> 'solicitante')::uuid
     from public.validar_alta_usuario('e2000000-0000-4000-8000-00000000000a', pg_temp.id('rol_mozo')) r $$,
  $$ values ('mozo', false, pg_temp.id('admin')) $$,
  'el admin con MFA puede dar de alta un mozo');
select is(pg_temp.error_de($$ select public.validar_alta_usuario('e2000000-0000-4000-8000-00000000000a', pg_temp.id('rol_agente')) $$),
  'PT400:rol_invalido', 'el rol técnico del agente no se asigna a personas');
select is(pg_temp.error_de($$ select public.validar_alta_usuario('e2000000-0000-4000-8000-00000000000a',
  'ec000000-0000-4000-8000-000000000001') $$), 'PT400:rol_invalido', 'no se asignan roles de otra empresa');
select throws_ok($$ insert into public.user_local_roles (user_id, local_id, role_id)
  values (pg_temp.id('mozo2'), 'e2000000-0000-4000-8000-00000000000a', pg_temp.id('rol_agente')) $$, '42501', null,
  'el admin tampoco asigna el rol del agente directamente');
select throws_ok($$ select public.crear_perfil_usuario(gen_random_uuid(), 'e2000000-0000-4000-8000-00000000000a',
  pg_temp.id('rol_mozo'), 'X', 'X01', '2468') $$, '42501', null, 'el perfil solo lo crea la Edge Function');

select pg_temp.como_postgres();
select pg_temp.guardar('u_nuevo', pg_temp.crear_cuenta_auth('f1000000-0000-4000-8000-0000000000b1', 'u-n01@pin.warike.invalid'));
select pg_temp.guardar('u_nuevo2', pg_temp.crear_cuenta_auth('f1000000-0000-4000-8000-0000000000b2', 'u-n02@pin.warike.invalid'));
select pg_temp.guardar('u_admin2', pg_temp.crear_cuenta_auth('f1000000-0000-4000-8000-0000000000b3', 'admin2@salon.test'));
select pg_temp.como_servicio();
select is(pg_temp.error_de($$ select public.crear_perfil_usuario(pg_temp.id('u_nuevo'), 'e2000000-0000-4000-8000-00000000000a',
  pg_temp.id('rol_mozo'), 'Nuevo', null, null) $$), 'PT400:codigo_y_pin_requeridos', 'un mozo necesita código y PIN');
select is(pg_temp.error_de($$ select public.crear_perfil_usuario(pg_temp.id('u_nuevo'), 'e2000000-0000-4000-8000-00000000000a',
  pg_temp.id('rol_mozo'), 'Nuevo', 'N01', '1234') $$), 'PT400:pin_invalido', 'el PIN del alta se valida');
select lives_ok($$ select public.crear_perfil_usuario(pg_temp.id('u_nuevo'), 'e2000000-0000-4000-8000-00000000000a',
  pg_temp.id('rol_mozo'), ' Mozo Nuevo ', 'N01', '2468', null, pg_temp.id('admin')) $$, 'se crea el perfil del mozo');
select is(pg_temp.error_de($$ select public.crear_perfil_usuario(pg_temp.id('u_nuevo2'), 'e2000000-0000-4000-8000-00000000000a',
  pg_temp.id('rol_mozo'), 'Otro', 'N01', '2468') $$), 'PT409:codigo_duplicado', 'el código de empleado es único');
select lives_ok($$ select public.crear_perfil_usuario(pg_temp.id('u_admin2'), 'e2000000-0000-4000-8000-00000000000a',
  pg_temp.id('rol_admin'), 'Admin Dos') $$, 'un admin se crea sin código ni PIN (entra con email y MFA)');
select pg_temp.como_postgres();
select results_eq(
  $$ select up.nombre_visible, up.codigo_empleado, up.created_by, r.codigo,
            extensions.crypt('2468', pc.pin_hash) = pc.pin_hash
     from public.usuarios_perfil up
     join public.user_local_roles ulr on ulr.user_id = up.user_id
     join public.roles r on r.id = ulr.role_id
     join app.pin_credenciales pc on pc.user_id = up.user_id
     where up.user_id = pg_temp.id('u_nuevo') $$,
  $$ values ('Mozo Nuevo', 'N01', pg_temp.id('admin'), 'mozo', true) $$,
  'el alta deja perfil, rol en el local y PIN cifrado');
select ok(exists (select 1 from public.audit_log where accion = 'usuario_creado' and entidad_id = pg_temp.id('u_nuevo')::text
                  and user_id = pg_temp.id('admin')), 'el alta queda en la auditoría con quién la hizo');

-- Ventas por mozo (CU4.3)
select pg_temp.como('admin');
select results_eq(
  $$ select mozo, ordenes::int, total_en_curso, total_pagado from public.ventas_por_mozo $$,
  $$ values ('Mozo Uno', 1, 64.00::numeric(12, 2), 0.00::numeric(12, 2)) $$,
  'ventas por mozo muestra lo que tiene en curso');

select * from finish();
rollback;
