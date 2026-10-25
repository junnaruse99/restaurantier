-- Toma de pedidos, comandas y KDS (M6, M7, flujo A de §8).
begin;
\ir _helpers.psql
\ir _salon.psql
select plan(56);

select pg_temp.crear_salon_prueba();

-- ---------------------------------------------------------------------------
-- Abrir mesa (CU6.1)
-- ---------------------------------------------------------------------------
select pg_temp.como('cocina');
select is(pg_temp.error_de($$ select public.abrir_orden(pg_temp.id('A1'), 2) $$), 'PT403:sin_permiso',
  'cocina no abre mesas');
select pg_temp.como('mozo_b');
select is(pg_temp.error_de($$ select public.abrir_orden(pg_temp.id('A1'), 2) $$), 'PT403:sin_permiso',
  'un mozo de otro local no abre mesas aquí');
select pg_temp.como_postgres();
select pg_temp.como_aal1(pg_temp.id('admin'));
select is(pg_temp.error_de($$ select public.abrir_orden(pg_temp.id('A1'), 2) $$), 'PT403:sin_permiso',
  'el admin sin MFA no opera');

select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.abrir_orden(pg_temp.id('DEL'), 1) $$), 'PT409:mesa_virtual_no_disponible',
  'las mesas virtuales se habilitan en fases posteriores (D-024)');
select is(pg_temp.error_de($$ select public.abrir_orden(pg_temp.id('A1'), 0) $$), 'PT400:comensales_invalidos',
  'los comensales van de 1 a 99');

select pg_temp.guardar('o1', (public.abrir_orden(pg_temp.id('A1'), 3, 'c0000000-0000-4000-8000-000000000001') ->> 'orden_id')::uuid);
select pg_temp.como_postgres();
select is((select estado from public.mesas where id = pg_temp.id('A1')), 'ocupada', 'abrir la orden ocupa la mesa');
select results_eq(
  $$ select numero_dia, tipo, mozo_id, comensales::int, fecha_operativa, estado
     from public.ordenes where id = pg_temp.id('o1') $$,
  $$ values (1, 'salon', pg_temp.id('mozo'), 3, app.fecha_operativa('e2000000-0000-4000-8000-00000000000a'), 'abierta') $$,
  'la orden nace abierta, con número del día, mozo y fecha operativa');
select is((select count(*)::int from public.mesa_uniones where orden_id = pg_temp.id('o1') and es_principal), 1,
  'la mesa queda unida como principal');
select is((select dispositivo_id from public.outbox_recibidos where client_mutation_id = 'c0000000-0000-4000-8000-000000000001'),
  pg_temp.id('tablet'), 'la mutación queda registrada con el dispositivo de la sesión');

select pg_temp.como('mozo');
select is((public.abrir_orden(pg_temp.id('A1'), 3, 'c0000000-0000-4000-8000-000000000001') ->> 'orden_id')::uuid,
  pg_temp.id('o1'), 'reenviar la misma mutación devuelve la misma orden (idempotencia)');
select is((select count(*)::int from public.ordenes where local_id = 'e2000000-0000-4000-8000-00000000000a'), 1,
  'el reenvío no crea otra orden');
select is(pg_temp.error_de($$ select public.abrir_orden(pg_temp.id('A1'), 2) $$), 'PT409:mesa_ocupada',
  'no se abre una mesa ocupada');
select pg_temp.guardar('o2', (public.abrir_orden(pg_temp.id('A2'), 2) ->> 'orden_id')::uuid);
select is((select numero_dia from public.ordenes where id = pg_temp.id('o2')), 2, 'el correlativo del día avanza');

-- ---------------------------------------------------------------------------
-- Agregar ítems (CU6.2): modificadores, precio vigente, agotados
-- ---------------------------------------------------------------------------
select is(pg_temp.error_de($$ select public.agregar_items(pg_temp.id('o1'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('lomo')))) $$), 'PT400:modificadores_incompletos',
  'el término del lomo es obligatorio');
select is(pg_temp.error_de($$ select public.agregar_items(pg_temp.id('o1'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('lomo'),
    'modificadores', '[{"grupo":"Término","nombre":"Crudo"}]'::jsonb))) $$), 'PT400:opcion_invalida',
  'solo se aceptan opciones del grupo');
select is(pg_temp.error_de($$ select public.agregar_items(pg_temp.id('o1'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha'),
    'modificadores', '[{"grupo":"Término","nombre":"Jugoso"}]'::jsonb))) $$), 'PT400:modificador_invalido',
  'un producto no admite grupos ajenos');
select is(pg_temp.error_de($$ select public.agregar_items(pg_temp.id('o1'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('lomo_b'),
    'modificadores', '[{"grupo":"Término","nombre":"Jugoso"}]'::jsonb))) $$), 'PT404:producto_no_encontrado',
  'no se piden productos de otro local');
select is(pg_temp.error_de($$ select public.agregar_items(pg_temp.id('o1'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha'), 'cantidad', 0))) $$), 'PT400:cantidad_invalida',
  'la cantidad debe ser positiva');

with r as (
  select public.agregar_items(pg_temp.id('o1'), jsonb_build_array(
    jsonb_build_object('producto_id', pg_temp.id('lomo'), 'cantidad', 2, 'nota', ' sin cebolla ',
      'modificadores', '[{"grupo":"Término","nombre":"Jugoso"},{"grupo":"Extras","nombre":"Huevo frito"}]'::jsonb),
    jsonb_build_object('producto_id', pg_temp.id('chicha')),
    jsonb_build_object('producto_id', pg_temp.id('bolsa'))
  ), 'c0000000-0000-4000-8000-000000000002') as j
)
select pg_temp.guardar('i_lomo', (j -> 'item_ids' ->> 0)::uuid), pg_temp.guardar('i_chicha', (j -> 'item_ids' ->> 1)::uuid),
       pg_temp.guardar('i_bolsa', (j -> 'item_ids' ->> 2)::uuid)
from r;

select results_eq(
  $$ select estado, precio_unitario_snapshot, total_linea, nota, estacion_produccion_id, jsonb_array_length(modificadores)
     from public.orden_items where id = pg_temp.id('i_lomo') $$,
  $$ values ('borrador', 32.000000::numeric(14, 6), 64.00::numeric(12, 2), 'sin cebolla', pg_temp.id('cocina_est'), 2) $$,
  'el ítem guarda precio con recargo, total de línea, nota, estación y modificadores');
select is((select estacion_produccion_id from public.orden_items where id = pg_temp.id('i_chicha')), pg_temp.id('bar_est'),
  'la estación sale de la categoría');
select is((select estacion_produccion_id from public.orden_items where id = pg_temp.id('i_bolsa')), null::uuid,
  'un producto sin estación no va a ninguna');
select is((select total from public.ordenes where id = pg_temp.id('o1')), 72.50::numeric(12, 2), 'el total de la orden se recalcula');
select is(
  (public.agregar_items(pg_temp.id('o1'), '[]'::jsonb, 'c0000000-0000-4000-8000-000000000002') -> 'item_ids' ->> 0)::uuid,
  pg_temp.id('i_lomo'), 'reenviar agregar_items no duplica los ítems');

-- Precio por día (M5) y feriado tratado como domingo.
select pg_temp.como_postgres();
insert into public.reglas_precio_dia (local_id, producto_id, dia_semana, precio, vigencia_desde)
select 'e2000000-0000-4000-8000-00000000000a', pg_temp.id('chicha'), extract(dow from o.fecha_operativa)::smallint, 6.00,
       o.fecha_operativa - 7
from public.ordenes o where o.id = pg_temp.id('o1');
insert into public.reglas_precio_dia (local_id, producto_id, dia_semana, precio, vigencia_desde)
values ('e2000000-0000-4000-8000-00000000000a', pg_temp.id('lomo'), 0, 27.00, '2026-01-01');
insert into public.feriados (local_id, fecha, descripcion) values (null, '2026-12-08', 'Inmaculada Concepción');
select is(app.precio_vigente(pg_temp.id('lomo'), '2026-12-08'), 27.00::numeric, 'un feriado se cobra con el precio del domingo');
select is(app.precio_vigente(pg_temp.id('lomo'), '2026-12-09'), 30.00::numeric, 'sin regla del día rige el precio de carta');

select pg_temp.como('mozo');
select pg_temp.guardar('i_chicha2', (public.agregar_items(pg_temp.id('o1'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha')))) -> 'item_ids' ->> 0)::uuid);
select is((select precio_unitario_snapshot from public.orden_items where id = pg_temp.id('i_chicha2')), 6.000000::numeric(14, 6),
  'el ítem nuevo toma la regla de precio del día');

select pg_temp.como_postgres();
update public.productos set disponible = false where id = pg_temp.id('chicha');
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.agregar_items(pg_temp.id('o1'),
  jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha')))) $$), 'PT409:producto_agotado',
  'no se pide un producto agotado');
select pg_temp.como_postgres();
update public.productos set disponible = true where id = pg_temp.id('chicha');

-- Menú del día: entrada y segundo del menú publicado para la fecha operativa (CU5.2).
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.agregar_items(pg_temp.id('o2'), jsonb_build_array(jsonb_build_object(
  'producto_id', pg_temp.id('menu'),
  'modificadores', '[{"grupo":"Entrada","nombre":"Papa a la huancaína"},{"grupo":"Segundo","nombre":"Ají de gallina"}]'::jsonb))) $$),
  'PT409:menu_no_publicado', 'sin menú publicado no se vende el menú del día');
select pg_temp.como_postgres();
insert into public.menu_diario (local_id, fecha, producto_id, entradas, segundos, publicado)
select local_id, fecha_operativa, pg_temp.id('menu'), '{"Papa a la huancaína","Sopa criolla"}', '{"Ají de gallina"}', true
from public.ordenes where id = pg_temp.id('o2');
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.agregar_items(pg_temp.id('o2'), jsonb_build_array(jsonb_build_object(
  'producto_id', pg_temp.id('menu'),
  'modificadores', '[{"grupo":"Entrada","nombre":"Ceviche"},{"grupo":"Segundo","nombre":"Ají de gallina"}]'::jsonb))) $$),
  'PT400:opcion_de_menu_invalida', 'la entrada debe estar en el menú de hoy');
select pg_temp.guardar('i_menu', (public.agregar_items(pg_temp.id('o2'), jsonb_build_array(jsonb_build_object(
  'producto_id', pg_temp.id('menu'),
  'modificadores', '[{"grupo":"Entrada","nombre":"Sopa criolla"},{"grupo":"Segundo","nombre":"Ají de gallina"}]'::jsonb)))
  -> 'item_ids' ->> 0)::uuid);
select is((select precio_unitario_snapshot from public.orden_items where id = pg_temp.id('i_menu')), 15.000000::numeric(14, 6),
  'el menú del día se vende con su precio');

-- Editar un ítem en borrador.
select lives_ok($$ select public.actualizar_item(pg_temp.id('i_lomo'), 3, 'bien jugoso') $$, 'se edita un ítem en borrador');
select results_eq($$ select total_linea, nota from public.orden_items where id = pg_temp.id('i_lomo') $$,
  $$ values (96.00::numeric(12, 2), 'bien jugoso') $$, 'la edición recalcula la línea');

-- ---------------------------------------------------------------------------
-- Enviar a cocina (CU6.3)
-- ---------------------------------------------------------------------------
select pg_temp.guardar('envio1', ((public.enviar_comanda(pg_temp.id('o1'), null, 'c0000000-0000-4000-8000-000000000003')
  -> 'comandas' -> 0 ->> 'comanda_id'))::uuid);
select pg_temp.como_postgres();
select results_eq(
  $$ select e.nombre, c.numero from public.comandas c join public.estaciones_produccion e on e.id = c.estacion_produccion_id
     where c.orden_id = pg_temp.id('o1') order by e.nombre $$,
  $$ values ('Bar', 1), ('Cocina', 1) $$,
  'una comanda por estación, con el mismo número');
select is((select count(*)::int from public.orden_items where orden_id = pg_temp.id('o1') and estado = 'enviado'), 4,
  'todos los ítems quedan enviados');
select ok((select comanda_id is null and enviado_at is not null from public.orden_items where id = pg_temp.id('i_bolsa')),
  'un ítem sin estación se envía sin comanda (D-025)');
select results_eq(
  $$ select tipo, impresora_id, estado, payload ->> 'mesa', payload ->> 'mozo', payload ->> 'estacion',
            jsonb_array_length(payload -> 'items'), payload -> 'items' -> 0 -> 'modificadores'
     from public.print_jobs where local_id = 'e2000000-0000-4000-8000-00000000000a' $$,
  $$ values ('comanda', pg_temp.id('imp_cocina'), 'pendiente', 'Mesa A1', 'Mozo Uno', 'Cocina', 1,
             '["Huevo frito", "Jugoso"]'::jsonb) $$,
  'solo la estación con impresora recibe trabajo, con la foto de la comanda');

select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.enviar_comanda(pg_temp.id('o1')) $$), 'PT409:sin_items_por_enviar',
  'no se envía una comanda vacía');
select is(pg_temp.error_de($$ select public.actualizar_item(pg_temp.id('i_lomo'), 1) $$), 'PT409:item_ya_enviado',
  'un ítem enviado ya no se edita');
select public.agregar_items(pg_temp.id('o1'), jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha'))));
select is((public.enviar_comanda(pg_temp.id('o1')) ->> 'numero')::int, 2, 'la segunda comanda lleva el número 2');

-- ---------------------------------------------------------------------------
-- KDS (CU7.1) y entrega
-- ---------------------------------------------------------------------------
select is(pg_temp.error_de($$ select public.cambiar_estado_items(array[pg_temp.id('i_lomo')], 'en_preparacion') $$),
  'PT403:sin_permiso', 'el mozo no opera el KDS');
select pg_temp.como('cocina');
select ok((select count(*) > 0 from public.orden_items where orden_id = pg_temp.id('o1')), 'cocina ve los ítems de su local');
select lives_ok($$ select public.cambiar_estado_items(array[pg_temp.id('i_lomo')], 'en_preparacion') $$,
  'cocina marca en preparación');
select lives_ok($$ select public.cambiar_estado_items(array[pg_temp.id('i_lomo')], 'listo') $$, 'cocina marca listo');
select is(pg_temp.error_de($$ select public.cambiar_estado_items(array[pg_temp.id('i_lomo')], 'servido') $$),
  'PT403:sin_permiso', 'cocina no marca servido');
select pg_temp.como('mozo');
select lives_ok($$ select public.cambiar_estado_items(array[pg_temp.id('i_lomo')], 'servido') $$, 'el mozo marca servido');
select pg_temp.como('cocina');
select is(pg_temp.error_de($$ select public.cambiar_estado_items(array[pg_temp.id('i_lomo')], 'en_preparacion') $$),
  'PT409:transicion_invalida', 'un ítem servido no vuelve a preparación');

-- Reimpresión (CU6.4)
select pg_temp.como('mozo');
select lives_ok($$ select public.reimprimir_comanda(
  (select id from public.comandas where orden_id = pg_temp.id('o1') and estacion_produccion_id = pg_temp.id('cocina_est') and numero = 1)) $$,
  'se reimprime la comanda de cocina');
select pg_temp.como_postgres();
select results_eq(
  $$ select c.reimpresiones, (select count(*)::int from public.print_jobs j where (j.payload ->> 'reimpresion')::boolean)
     from public.comandas c where c.orden_id = pg_temp.id('o1') and c.estacion_produccion_id = pg_temp.id('cocina_est') and c.numero = 1 $$,
  $$ values (1, 1) $$, 'la reimpresión suma al contador y encola un trabajo marcado');
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.reimprimir_comanda(
  (select id from public.comandas where orden_id = pg_temp.id('o1') and estacion_produccion_id = pg_temp.id('bar_est') limit 1)) $$),
  'PT409:estacion_sin_impresora', 'una estación solo con KDS no reimprime');

-- ---------------------------------------------------------------------------
-- Aislamiento y escritura directa
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo_b');
select is((select count(*)::int from public.ordenes), 0, 'un mozo de otro local no ve estas órdenes');
select pg_temp.como('mozo');
select throws_ok($$ update public.mesas set estado = 'libre' where id = pg_temp.id('A1') $$, '42501', null,
  'el estado de la mesa solo cambia por RPC');
select throws_ok($$ insert into public.orden_items (local_id, orden_id, producto_id, nombre_snapshot, cantidad, precio_unitario_snapshot)
  values ('e2000000-0000-4000-8000-00000000000a', pg_temp.id('o1'), pg_temp.id('lomo'), 'x', 1, 0) $$, '42501', null,
  'los ítems solo se crean por RPC');

-- Mesas: liberar y bloquear
select is(pg_temp.error_de($$ select public.liberar_mesa(pg_temp.id('A1')) $$), 'PT409:mesa_no_por_limpiar',
  'solo se libera una mesa por limpiar');
select is(pg_temp.error_de($$ select public.bloquear_mesa(pg_temp.id('A4'), true) $$), 'PT403:sin_permiso',
  'el mozo no bloquea mesas');
select pg_temp.como('admin');
select lives_ok($$ select public.bloquear_mesa(pg_temp.id('A4'), true) $$, 'el admin bloquea una mesa libre');
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.abrir_orden(pg_temp.id('A4'), 2) $$), 'PT409:mesa_ocupada',
  'una mesa bloqueada no se abre');

select * from finish();
rollback;
