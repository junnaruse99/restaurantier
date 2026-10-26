-- Cambio de mesa (M8), anulaciones (M9) y autorización de supervisor con PIN — flujos B y C de §8.
begin;
\ir _helpers.psql
\ir _salon.psql
select plan(56);

select pg_temp.crear_salon_prueba();

-- Orden 1 (mozo, A1): lomo a Cocina y chicha a Bar enviados; otra chicha en borrador.
select pg_temp.como('mozo');
select pg_temp.guardar('o1', (public.abrir_orden(pg_temp.id('A1'), 2) ->> 'orden_id')::uuid);
with r as (
  select public.agregar_items(pg_temp.id('o1'), jsonb_build_array(
    jsonb_build_object('producto_id', pg_temp.id('lomo'), 'modificadores', '[{"grupo":"Término","nombre":"A punto"}]'::jsonb),
    jsonb_build_object('producto_id', pg_temp.id('chicha')))) as j
)
select pg_temp.guardar('i_lomo', (j -> 'item_ids' ->> 0)::uuid), pg_temp.guardar('i_chicha', (j -> 'item_ids' ->> 1)::uuid) from r;
select public.enviar_comanda(pg_temp.id('o1'));
select pg_temp.guardar('i_chicha_b', (public.agregar_items(pg_temp.id('o1'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha')))) -> 'item_ids' ->> 0)::uuid);

-- Orden 2 (mozo2, A2): chicha enviada.
select pg_temp.como('mozo2');
select pg_temp.guardar('o2', (public.abrir_orden(pg_temp.id('A2'), 4) ->> 'orden_id')::uuid);
select pg_temp.guardar('i_chicha_o2', (public.agregar_items(pg_temp.id('o2'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha')))) -> 'item_ids' ->> 0)::uuid);
select public.enviar_comanda(pg_temp.id('o2'));

-- ---------------------------------------------------------------------------
-- Cambio de mesa (CU8.1–8.3)
-- ---------------------------------------------------------------------------
select is(pg_temp.error_de($$ select public.trasladar_orden(pg_temp.id('o1'), 'mover', pg_temp.id('A3')) $$),
  'PT403:sin_permiso', 'un mozo no mueve la orden de otro mozo');

select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.trasladar_orden(pg_temp.id('o1'), 'mover', pg_temp.id('A2')) $$),
  'PT409:mesa_ocupada', 'no se mueve a una mesa ocupada');
select is(pg_temp.error_de($$ select public.trasladar_orden(pg_temp.id('o1'), 'mover', pg_temp.id('B1')) $$),
  'PT404:mesa_no_encontrada', 'no se mueve a una mesa de otro local');
select is(pg_temp.error_de($$ select public.trasladar_orden(pg_temp.id('o1'), 'girar', pg_temp.id('A3')) $$),
  'PT400:tipo_invalido', 'el tipo de traslado se valida');
select is((public.trasladar_orden(pg_temp.id('o1'), 'mover', pg_temp.id('A3')) ->> 'avisos')::int, 1,
  'mover avisa a la estación con impresora que tiene ítems pendientes');
select pg_temp.como_postgres();
select results_eq(
  $$ select (select estado from public.mesas where id = pg_temp.id('A1')),
            (select estado from public.mesas where id = pg_temp.id('A3')),
            (select mesa_principal_id from public.ordenes where id = pg_temp.id('o1')) $$,
  $$ values ('por_limpiar', 'ocupada', pg_temp.id('A3')) $$,
  'la mesa anterior queda por limpiar y la orden pasa a la nueva');
select results_eq(
  $$ select impresora_id, payload ->> 'mesa_origen', payload ->> 'mesa_destino', jsonb_array_length(payload -> 'items')
     from public.print_jobs where tipo = 'traslado' $$,
  $$ values (pg_temp.id('imp_cocina'), 'Mesa A1', 'Mesa A3', 1) $$,
  'el aviso de traslado dice de qué mesa a qué mesa');

select pg_temp.como('mozo');
select lives_ok($$ select public.trasladar_orden(pg_temp.id('o1'), 'unir', pg_temp.id('A4')) $$, 'se une una mesa libre');
select pg_temp.como_postgres();
select results_eq(
  $$ select (select estado from public.mesas where id = pg_temp.id('A4')),
            (select count(*)::int from public.mesa_uniones where orden_id = pg_temp.id('o1') and liberada_at is null),
            (select mesa_principal_id from public.ordenes where id = pg_temp.id('o1')) $$,
  $$ values ('ocupada', 2, pg_temp.id('A3')) $$,
  'la mesa unida se ocupa y la principal conserva la orden');

select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.trasladar_orden(pg_temp.id('o1'), 'separar', pg_temp.id('A1')) $$),
  'PT409:mesa_no_unida', 'solo se separa una mesa unida');
select pg_temp.guardar('o3', (public.trasladar_orden(pg_temp.id('o1'), 'separar', pg_temp.id('A4'),
  array[pg_temp.id('i_chicha_b')]) ->> 'orden_destino_id')::uuid);
select pg_temp.como_postgres();
select results_eq(
  $$ select o.mesa_principal_id, o.mozo_id, o.total, (select orden_id from public.orden_items where id = pg_temp.id('i_chicha_b'))
     from public.ordenes o where o.id = pg_temp.id('o3') $$,
  $$ values (pg_temp.id('A4'), pg_temp.id('mozo'), 8.00::numeric(12, 2), pg_temp.id('o3')) $$,
  'separar con ítems crea una orden en esa mesa con esos ítems');
select is((select total from public.ordenes where id = pg_temp.id('o1')), 38.00::numeric(12, 2),
  'la orden original pierde los ítems separados');

select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.trasladar_orden(pg_temp.id('o1'), 'mover_items', pg_temp.id('A2'),
  array[pg_temp.id('i_lomo')]) $$), 'PT403:sin_permiso', 'el mozo no pasa ítems a la mesa de otro mozo');
select is(pg_temp.error_de($$ select public.trasladar_orden(pg_temp.id('o1'), 'mover_items', pg_temp.id('A2'),
  array[pg_temp.id('i_chicha_o2')]) $$), 'PT400:items_invalidos', 'solo se mueven ítems de la propia orden');
select pg_temp.como('cajero');
select is((public.trasladar_orden(pg_temp.id('o1'), 'mover_items', pg_temp.id('A2'), array[pg_temp.id('i_lomo')]) ->> 'orden_destino_id')::uuid,
  pg_temp.id('o2'), 'caja (trasladar_mesa) pasa un ítem a la orden en curso de otra mesa');
select pg_temp.como_postgres();
select results_eq(
  $$ select (select total from public.ordenes where id = pg_temp.id('o1')), (select total from public.ordenes where id = pg_temp.id('o2')),
            (select count(*)::int from public.print_jobs where tipo = 'traslado') $$,
  $$ values (8.00::numeric(12, 2), 38.00::numeric(12, 2), 2) $$,
  'los totales de ambas órdenes se recalculan y cocina recibe el aviso');
select results_eq(
  $$ select tipo, realizado_por from public.traslados_mesa where orden_id = pg_temp.id('o1') order by tipo $$,
  $$ values ('mover', pg_temp.id('mozo')), ('mover_items', pg_temp.id('cajero')), ('separar', pg_temp.id('mozo')),
            ('unir', pg_temp.id('mozo')) $$,
  'cada traslado queda registrado con quién lo hizo');

select pg_temp.como('mozo');
select lives_ok($$ select public.liberar_mesa(pg_temp.id('A1')) $$, 'el mozo libera la mesa limpia');

-- ---------------------------------------------------------------------------
-- Anular en borrador (CU9.1): sin autorización ni registro de anulación
-- ---------------------------------------------------------------------------
select pg_temp.guardar('i_bolsa', (public.agregar_items(pg_temp.id('o1'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('bolsa')))) -> 'item_ids' ->> 0)::uuid);
select lives_ok($$ select public.anular_item(pg_temp.id('i_bolsa')) $$, 'el mozo anula un ítem no enviado');
select pg_temp.como_postgres();
select results_eq(
  $$ select i.estado, i.anulacion_id, o.total from public.orden_items i join public.ordenes o on o.id = i.orden_id
     where i.id = pg_temp.id('i_bolsa') $$,
  $$ values ('anulado', null::uuid, 8.00::numeric(12, 2)) $$,
  'el ítem en borrador se anula sin registro de anulación y sale del total');

-- ---------------------------------------------------------------------------
-- Anular un ítem enviado (CU9.2): motivo y autorización
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo2');
select is(pg_temp.error_de($$ select public.anular_item(pg_temp.id('i_lomo')) $$), 'PT400:motivo_requerido',
  'anular algo enviado exige motivo');
select is(pg_temp.error_de($$ select public.anular_item(pg_temp.id('i_lomo'), 'otro', '  ') $$), 'PT400:motivo_texto_requerido',
  'el motivo "otro" exige descripción');
select is(pg_temp.error_de($$ select public.anular_item(pg_temp.id('i_lomo'), 'cliente_desiste') $$), 'PT403:requiere_autorizacion',
  'el mozo necesita la autorización de un supervisor');

select is(pg_temp.error_de($$ select public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000a', 'tomar_pedido', 'ADM', '7531') $$),
  'PT400:permiso_invalido', 'solo se autorizan permisos autorizar_*');
select is(pg_temp.error_de($$ select public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000b', 'autorizar_anulacion', 'ADM', '7531') $$),
  'PT403:sin_permiso', 'quien pide la autorización debe operar en ese local');
select is(public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000a', 'autorizar_anulacion', 'M01', '2580') ->> 'error',
  'sin_permiso', 'el PIN de un mozo no autoriza anulaciones');
select results_eq(
  $$ select r ->> 'ok', r ->> 'error', (r ->> 'intentos_restantes')::int
     from public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000a', 'autorizar_anulacion', 'ADM', '0000') r $$,
  $$ values ('false', 'credenciales_invalidas', 4) $$,
  'un PIN incorrecto cuenta como intento fallido');

select pg_temp.guardar('aut1', (public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000a', 'autorizar_anulacion', 'ADM', '7531')
  ->> 'autorizacion_id')::uuid);
select lives_ok($$ select public.anular_item(pg_temp.id('i_lomo'), 'demora', 'Cliente se fue', true, pg_temp.id('aut1')) $$,
  'con el PIN del admin el mozo anula el ítem enviado');
select pg_temp.como_postgres();
select results_eq(
  $$ select a.nivel, a.estado, a.solicitada_por, a.autorizada_por, a.merma, i.estado, i.anulacion_id = a.id
     from public.anulaciones a join public.orden_items i on i.id = a.orden_item_id where a.orden_item_id = pg_temp.id('i_lomo') $$,
  $$ values ('item', 'aprobada', pg_temp.id('mozo2'), pg_temp.id('admin'), true, 'anulado', true) $$,
  'la anulación queda aprobada con quién la pidió y quién la autorizó');
select results_eq(
  $$ select impresora_id, payload ->> 'motivo', payload ->> 'autorizado_por', payload -> 'items' -> 0 ->> 'nombre'
     from public.print_jobs where tipo = 'anulacion' $$,
  $$ values (pg_temp.id('imp_cocina'), 'demora', 'Admin', 'Lomo saltado') $$,
  'cocina recibe el aviso de anulación');
select is((select total from public.ordenes where id = pg_temp.id('o2')), 8.00::numeric(12, 2), 'el ítem anulado sale del total');
select ok(exists (select 1 from public.audit_log where accion = 'autorizacion_pin' and entidad_id = pg_temp.id('admin')::text),
  'la autorización con PIN queda en la auditoría');

select pg_temp.como('mozo2');
select is(pg_temp.error_de($$ select public.anular_item(pg_temp.id('i_chicha_o2'), 'demora', null, false, pg_temp.id('aut1')) $$),
  'PT403:autorizacion_invalida', 'una autorización se usa una sola vez');
select pg_temp.como('mozo');
select pg_temp.guardar('aut2', (public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000a', 'autorizar_anulacion', 'ADM', '7531')
  ->> 'autorizacion_id')::uuid);
select pg_temp.como('mozo2');
select is(pg_temp.error_de($$ select public.anular_item(pg_temp.id('i_chicha_o2'), 'demora', null, false, pg_temp.id('aut2')) $$),
  'PT403:autorizacion_invalida', 'la autorización es de quien la pidió');
select pg_temp.guardar('aut3', (public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000a', 'autorizar_anulacion', 'ADM', '7531')
  ->> 'autorizacion_id')::uuid);
select pg_temp.como_postgres();
update app.autorizaciones set creada_at = now() - interval '5 minutes', expira_at = now() - interval '3 minutes'
where id = pg_temp.id('aut3');
select pg_temp.como('mozo2');
select is(pg_temp.error_de($$ select public.anular_item(pg_temp.id('i_chicha_o2'), 'demora', null, false, pg_temp.id('aut3')) $$),
  'PT403:autorizacion_invalida', 'una autorización vencida no sirve');

-- ---------------------------------------------------------------------------
-- Solicitud remota (§4.1)
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo');
select pg_temp.guardar('sol1', (public.solicitar_anulacion(pg_temp.id('i_chicha'), null, 'calidad') ->> 'anulacion_id')::uuid);
select is(pg_temp.error_de($$ select public.solicitar_anulacion(pg_temp.id('i_chicha'), null, 'calidad') $$),
  'PT409:solicitud_pendiente', 'no se duplica una solicitud pendiente');
select is(pg_temp.error_de($$ select public.resolver_anulacion(pg_temp.id('sol1'), true) $$), 'PT403:sin_permiso',
  'el mozo no aprueba su propia solicitud');
select pg_temp.como('admin');
select is(public.resolver_anulacion(pg_temp.id('sol1'), true) ->> 'estado', 'aprobada', 'el admin aprueba desde su sesión');
select pg_temp.como_postgres();
select results_eq(
  $$ select a.estado, a.autorizada_por, i.estado from public.anulaciones a join public.orden_items i on i.id = a.orden_item_id
     where a.id = pg_temp.id('sol1') $$,
  $$ values ('aprobada', pg_temp.id('admin'), 'anulado') $$,
  'aprobar la solicitud anula el ítem');
select pg_temp.como('admin');
select is(pg_temp.error_de($$ select public.resolver_anulacion(pg_temp.id('sol1'), false) $$), 'PT409:solicitud_resuelta',
  'una solicitud resuelta no se vuelve a resolver');

select pg_temp.como('mozo2');
select pg_temp.guardar('sol2', (public.solicitar_anulacion(pg_temp.id('i_chicha_o2'), null, 'error_digitacion') ->> 'anulacion_id')::uuid);
select pg_temp.como('admin');
select lives_ok($$ select public.resolver_anulacion(pg_temp.id('sol2'), false) $$, 'el admin rechaza una solicitud');
select pg_temp.como_postgres();
select results_eq(
  $$ select a.estado, i.estado from public.anulaciones a join public.orden_items i on i.id = a.orden_item_id
     where a.id = pg_temp.id('sol2') $$,
  $$ values ('rechazada', 'enviado') $$, 'rechazar deja el ítem como estaba');

select pg_temp.como('mozo2');
select pg_temp.guardar('i_borrador_o2', (public.agregar_items(pg_temp.id('o2'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha')))) -> 'item_ids' ->> 0)::uuid);
select is(pg_temp.error_de($$ select public.solicitar_anulacion(pg_temp.id('i_borrador_o2'), null, 'calidad') $$),
  'PT409:no_requiere_solicitud', 'un ítem en borrador no necesita solicitud');
select is(pg_temp.error_de($$ select public.solicitar_anulacion(pg_temp.id('i_borrador_o2'), pg_temp.id('o2'), 'calidad') $$),
  'PT400:objetivo_invalido', 'se pide la anulación de un ítem o de una orden, no de ambos');

-- ---------------------------------------------------------------------------
-- Anular la orden completa (CU9.3)
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo');
select lives_ok($$ select public.anular_orden(pg_temp.id('o3')) $$, 'una orden que nunca fue a cocina se cancela sin autorización (D-026)');
select pg_temp.como_postgres();
select results_eq(
  $$ select o.estado, (select estado from public.mesas where id = pg_temp.id('A4')),
            (select motivo_codigo from public.anulaciones where orden_id = o.id and nivel = 'orden')
     from public.ordenes o where o.id = pg_temp.id('o3') $$,
  $$ values ('anulada', 'libre', 'error_digitacion') $$,
  'la orden queda anulada y su mesa libre');

select pg_temp.como('mozo2');
select is(pg_temp.error_de($$ select public.anular_orden(pg_temp.id('o2'), 'cliente_desiste') $$), 'PT403:requiere_autorizacion',
  'una orden con ítems en cocina requiere autorización');
select pg_temp.guardar('sol3', (public.solicitar_anulacion(null, pg_temp.id('o2'), 'cliente_desiste') ->> 'anulacion_id')::uuid);
select pg_temp.como('admin');
select lives_ok($$ select public.anular_orden(pg_temp.id('o2'), 'cliente_desiste') $$, 'el admin anula la orden');
select pg_temp.como_postgres();
select results_eq(
  $$ select o.estado, o.total, (select estado from public.mesas where id = pg_temp.id('A2')),
            (select estado from public.anulaciones where id = pg_temp.id('sol3')),
            (select count(*)::int from public.orden_items where orden_id = o.id and estado <> 'anulado')
     from public.ordenes o where o.id = pg_temp.id('o2') $$,
  $$ values ('anulada', 0.00::numeric(12, 2), 'por_limpiar', 'rechazada', 0) $$,
  'la orden anulada cierra sus ítems, deja la mesa por limpiar y resuelve la solicitud pendiente');
select pg_temp.como('mozo2');
select is(pg_temp.error_de($$ select public.agregar_items(pg_temp.id('o2'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha')))) $$), 'PT409:orden_cerrada',
  'una orden anulada no admite ítems');

-- Con pagos se anula por nota de crédito (flujo F), no aquí.
select pg_temp.como('mozo');
select pg_temp.guardar('o4', (public.abrir_orden(pg_temp.id('A1'), 1) ->> 'orden_id')::uuid);
select pg_temp.como_postgres();
insert into public.cajas (id, local_id, nombre) values ('e7000000-0000-4000-8000-000000000008', 'e2000000-0000-4000-8000-00000000000a', 'Caja T');
insert into public.sesiones_caja (id, local_id, caja_id, cajero_id, monto_apertura) values
  ('e8000000-0000-4000-8000-000000000008', 'e2000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000008',
   pg_temp.id('cajero'), 100);
insert into public.pagos (local_id, orden_id, sesion_caja_id, metodo, monto, monto_recibido, vuelto)
values ('e2000000-0000-4000-8000-00000000000a', pg_temp.id('o4'), 'e8000000-0000-4000-8000-000000000008', 'efectivo', 10, 10, 0);
select pg_temp.como('admin');
select is(pg_temp.error_de($$ select public.anular_orden(pg_temp.id('o4'), 'otro', 'prueba') $$), 'PT409:orden_con_pagos',
  'una orden con pagos no se anula por esta vía');

-- ---------------------------------------------------------------------------
-- Reporte (CA M9)
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select nivel, estado, motivo_codigo, mozo, solicitada_por, autorizada_por from public.reporte_anulaciones
     order by nivel, estado, motivo_codigo $$,
  $$ values ('item', 'aprobada', 'calidad', 'Mozo Uno', 'Mozo Uno', 'Admin'),
            ('item', 'aprobada', 'demora', 'Mozo Dos', 'Mozo Dos', 'Admin'),
            ('item', 'rechazada', 'error_digitacion', 'Mozo Dos', 'Mozo Dos', 'Admin'),
            ('orden', 'aprobada', 'cliente_desiste', 'Mozo Dos', 'Admin', 'Admin'),
            ('orden', 'aprobada', 'error_digitacion', 'Mozo Uno', 'Mozo Uno', 'Mozo Uno'),
            ('orden', 'rechazada', 'cliente_desiste', 'Mozo Dos', 'Mozo Dos', 'Admin') $$,
  'el reporte muestra mozo, motivo, quién pidió y quién autorizó');
select is((select monto from public.reporte_anulaciones where nivel = 'item' and motivo_codigo = 'demora'), 30.00::numeric(12, 2),
  'el reporte incluye el monto anulado');
select pg_temp.como('mozo_b');
select is((select count(*)::int from public.reporte_anulaciones), 0, 'el reporte respeta la RLS del local');

-- ---------------------------------------------------------------------------
-- Bloqueo del PIN del supervisor por intentos (§4.1)
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo');
select public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000a', 'autorizar_anulacion', 'ADM', '1111')
from generate_series(1, 4);
select is(public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000a', 'autorizar_anulacion', 'ADM', '1111') ->> 'error',
  'bloqueado', 'el quinto intento fallido bloquea el PIN');
select is(public.autorizar_con_pin('e2000000-0000-4000-8000-00000000000a', 'autorizar_anulacion', 'ADM', '7531') ->> 'error',
  'bloqueado', 'bloqueado, ni el PIN correcto autoriza');

select * from finish();
rollback;
