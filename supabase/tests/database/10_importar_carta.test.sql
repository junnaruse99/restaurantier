-- Carga masiva de la carta desde la plantilla (M3, DECISIONS D-042).
begin;
\ir _helpers.psql
\ir _salon.psql
select plan(18);

select pg_temp.crear_salon_prueba();
select pg_temp.guardar('local', 'e2000000-0000-4000-8000-00000000000a');

create function pg_temp.importar(p_filas jsonb, p_motivo text default null, p_simular boolean default false)
returns jsonb
language sql
as $$ select public.importar_carta(pg_temp.id('local'), p_filas, p_motivo, p_simular) $$;

-- ---------------------------------------------------------------------------
-- Permisos y validación
-- ---------------------------------------------------------------------------
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select pg_temp.importar('[{"fila":2,"nombre":"X","categoria":"Platos","precio":1}]') $$),
  'PT403:sin_permiso', 'el mozo no carga la carta');

select pg_temp.como('admin');
select is(pg_temp.error_de($$ select pg_temp.importar('[]') $$), 'PT400:sin_filas', 'un archivo vacío se rechaza');

select is(
  pg_temp.importar('[
    {"fila":2,"nombre":"","categoria":"Platos","precio":10},
    {"fila":3,"nombre":"Ceviche","categoria":"","precio":"abc"},
    {"fila":4,"codigo":"C1","nombre":"Causa","categoria":"Entradas","precio":12,"estacion":"Horno"},
    {"fila":5,"codigo":"C1","nombre":"Causa 2","categoria":"Entradas","precio":12}
  ]') -> 'errores',
  '[
    {"fila":2,"error":"Falta el nombre o pasa de 120 caracteres"},
    {"fila":3,"error":"Falta la categoría"},
    {"fila":3,"error":"El precio debe ser un número entre 0 y 99 999"},
    {"fila":4,"error":"La estación Horno no existe"},
    {"fila":5,"error":"El código C1 se repite en el archivo"}
  ]'::jsonb,
  'devuelve todos los errores con su fila');
select is((select count(*) from public.productos where local_id = pg_temp.id('local')), 4::bigint,
  'con errores no se guarda nada');

-- ---------------------------------------------------------------------------
-- Vista previa
-- ---------------------------------------------------------------------------
select is(
  pg_temp.importar('[
    {"fila":2,"codigo":"E01","nombre":"Tequeños","categoria":"Entradas","precio":15.5,"estacion":"cocina"},
    {"fila":3,"codigo":"P01","nombre":"Lomo saltado","categoria":"Platos","precio":30}
  ]', null, true),
  '{"ok":true,"simulado":true,"nuevos":1,"actualizados":1,"precios_cambiados":0,"categorias_nuevas":["Entradas"]}'::jsonb,
  'la simulación resume los cambios');
select is((select count(*) from public.categorias where local_id = pg_temp.id('local') and nombre = 'Entradas'), 0::bigint,
  'la simulación no crea categorías');
select is((select count(*) from public.productos where codigo = 'E01'), 0::bigint, 'la simulación no crea productos');

-- ---------------------------------------------------------------------------
-- Aplicación
-- ---------------------------------------------------------------------------
select is(pg_temp.error_de($$ select pg_temp.importar(
    '[{"fila":2,"codigo":"P01","nombre":"Lomo saltado","categoria":"Platos","precio":33}]') $$),
  'PT400:motivo_requerido', 'cambiar precios exige motivo');

select is(
  pg_temp.importar('[
    {"fila":2,"codigo":"E01","nombre":"Tequeños","categoria":"Entradas","precio":15.5,"estacion":"cocina"},
    {"fila":3,"codigo":"P01","nombre":"Lomo saltado","categoria":"platos","precio":33,"descripcion":"Con papas"},
    {"fila":4,"nombre":"chicha morada","categoria":"Bebidas","precio":8,"disponible":false}
  ]', 'Carta de noviembre') - 'simulado',
  '{"ok":true,"nuevos":1,"actualizados":2,"precios_cambiados":1,"categorias_nuevas":["Entradas"]}'::jsonb,
  'aplica nuevos y actualizaciones');
select results_eq(
  $$ select p.nombre, c.nombre, p.precio, e.nombre, p.disponible
     from public.productos p
     join public.categorias c on c.id = p.categoria_id
     left join public.estaciones_produccion e on e.id = p.estacion_produccion_id
     where p.codigo = 'E01' $$,
  $$ values ('Tequeños', 'Entradas', 15.50::numeric(12, 2), 'Cocina', true) $$,
  'crea el producto con su categoría nueva y la estación indicada');
select results_eq(
  $$ select precio, descripcion from public.productos where id = pg_temp.id('lomo') $$,
  $$ values (33.00::numeric(12, 2), 'Con papas') $$,
  'actualiza el producto reconocido por código, sin crear otra categoría por mayúsculas');
select results_eq(
  $$ select precio_anterior, precio_nuevo, motivo from public.producto_precio_historial where producto_id = pg_temp.id('lomo') $$,
  $$ values (30.00::numeric(12, 2), 33.00::numeric(12, 2), 'Carga masiva: Carta de noviembre') $$,
  'el cambio de precio queda en el historial con el motivo');
select is((select disponible from public.productos where id = pg_temp.id('chicha')), false,
  'sin código reconoce el producto por su nombre');
select is((select count(*) from public.producto_precio_historial where producto_id = pg_temp.id('chicha')), 0::bigint,
  'sin cambio de precio no hay historial');

select is(
  pg_temp.importar('[{"fila":2,"codigo":"P01","nombre":"Lomo saltado","categoria":"Platos","precio":33}]') ->> 'actualizados',
  '1', 'volver a subir el mismo archivo no exige motivo');
select is((select descripcion from public.productos where id = pg_temp.id('lomo')), 'Con papas',
  'una celda vacía no borra la descripción');
select is(pg_temp.error_de($$ select public.importar_carta('e2000000-0000-4000-8000-00000000000b',
    '[{"fila":2,"codigo":"P01","nombre":"Lomo","categoria":"Platos","precio":1}]', 'Prueba') $$),
  'PT403:sin_permiso', 'no carga la carta de un local donde no es admin');
select pg_temp.como_postgres();
select results_eq($$ select nombre, precio from public.productos where id = pg_temp.id('lomo_b') $$,
  $$ values ('Lomo Urban', 32.00::numeric(12, 2)) $$,
  'el producto con el mismo código en otro local sigue igual');

select * from finish();
rollback;
