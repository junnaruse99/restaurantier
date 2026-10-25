-- =============================================================================
-- Datos semilla del cliente: Warike Resto Grill (§6)
-- =============================================================================
-- Idempotente (on conflict do nothing): se puede aplicar a staging y producción con
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/00_warike_resto_grill.sql
-- Los valores marcados "POR CONFIRMAR" se ajustan con el cliente (ver DECISIONS.md).

begin;

-- -----------------------------------------------------------------------------
-- Empresa y local
-- -----------------------------------------------------------------------------
insert into public.empresas (id, ruc, razon_social, nombre_comercial, direccion_fiscal, regimen_igv)
values (
  'a0000000-0000-4000-8000-000000000001',
  '20000000001',                                  -- POR CONFIRMAR: RUC real
  'WARIKE RESTO GRILL (RAZÓN SOCIAL POR CONFIRMAR)',
  'Warike Resto Grill',
  'POR CONFIRMAR',
  'MYPE_RESTAURANTE'                              -- POR CONFIRMAR con el contador (P4)
)
on conflict (id) do nothing;

insert into public.locales (id, empresa_id, nombre, codigo_establecimiento_sunat, direccion, hora_corte_operativa)
values (
  'b0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'Warike Resto Grill',
  '0000',
  'POR CONFIRMAR',
  '05:00'
)
on conflict (id) do nothing;

insert into public.config_local (local_id) values ('b0000000-0000-4000-8000-000000000001')
on conflict (local_id) do nothing;

-- Series nuevas, distintas de las de SHIOL; la numeración final la valida el contador.
insert into public.series_cpe (local_id, tipo_cpe, serie) values
  ('b0000000-0000-4000-8000-000000000001', '01', 'F002'),
  ('b0000000-0000-4000-8000-000000000001', '03', 'B002'),
  ('b0000000-0000-4000-8000-000000000001', '07', 'FC02'),
  ('b0000000-0000-4000-8000-000000000001', '07', 'BC02')
on conflict (local_id, serie) do nothing;

insert into public.estaciones_produccion (local_id, nombre, muestra_kds) values
  ('b0000000-0000-4000-8000-000000000001', 'Cocina', true),
  ('b0000000-0000-4000-8000-000000000001', 'Parrilla', true),
  ('b0000000-0000-4000-8000-000000000001', 'Bar', true)
on conflict (local_id, nombre) do nothing;

insert into public.cajas (local_id, nombre) values ('b0000000-0000-4000-8000-000000000001', 'Caja 1')
on conflict (local_id, nombre) do nothing;

-- -----------------------------------------------------------------------------
-- Plano de mesas según el croquis del cliente (posiciones aproximadas en cuadrícula;
-- el admin las ajusta arrastrándolas)
-- -----------------------------------------------------------------------------
insert into public.pisos (id, local_id, nombre, orden, ancho_canvas, alto_canvas) values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Piso 1', 1, 1000, 800),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'Piso 2', 2, 1000, 900)
on conflict (id) do nothing;

-- Piso 1. Filas de arriba hacia abajo; columnas cada 100 px.
insert into public.mesas (piso_id, local_id, codigo, nombre_visible, tipo, capacidad, pos_x, pos_y, ancho, alto, activa)
select 'c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
       m.codigo, m.nombre, m.tipo, m.capacidad, m.x, m.y, m.ancho, 80, true
from (values
  -- Fila superior: auxiliares 70–75
  ('70', 'Mesa 70', 'auxiliar', 2, 40, 40, 80),
  ('71', 'Mesa 71', 'auxiliar', 2, 140, 40, 80),
  ('72', 'Mesa 72', 'auxiliar', 2, 240, 40, 80),
  ('73', 'Mesa 73', 'auxiliar', 2, 340, 40, 80),
  ('74', 'Mesa 74', 'auxiliar', 2, 440, 40, 80),
  ('75', 'Mesa 75', 'auxiliar', 2, 540, 40, 80),
  -- Fila 2
  ('8', 'Mesa 8', 'mesa', 4, 40, 180, 80),
  ('9', 'Mesa 9', 'mesa', 4, 140, 180, 80),
  ('10', 'Mesa 10', 'mesa', 4, 240, 180, 80),
  ('11', 'Mesa 11', 'mesa', 4, 340, 180, 80),
  -- Fila 3 ("08" es auxiliar, contigua a la 8)
  ('08', 'Mesa 08', 'auxiliar', 2, 40, 300, 80),
  ('7', 'Mesa 7', 'mesa', 4, 140, 300, 80),
  ('6', 'Mesa 6', 'mesa', 4, 240, 300, 80),
  ('5', 'Mesa 5', 'mesa', 4, 340, 300, 80),
  ('4', 'Mesa 4', 'mesa', 4, 440, 300, 80),
  -- Fila 4 ("01" es auxiliar, contigua a la 1)
  ('01', 'Mesa 01', 'auxiliar', 2, 40, 420, 80),
  ('1', 'Mesa 1', 'mesa', 4, 140, 420, 80),
  ('2', 'Mesa 2', 'mesa', 4, 240, 420, 80),
  ('3', 'Mesa 3', 'mesa', 4, 340, 420, 80),
  -- Mesas virtuales en la esquina inferior izquierda
  ('DELIVERY-1', 'Delivery', 'virtual_delivery', 0, 40, 640, 120),
  ('AUDITOR-1', 'Auditor', 'virtual_auditor', 0, 180, 640, 120),
  ('PERSONAL', 'Personal', 'virtual_personal', 0, 320, 640, 120),
  ('LLEVAR', 'Para llevar', 'virtual_llevar', 0, 460, 640, 120)
) as m (codigo, nombre, tipo, capacidad, x, y, ancho)
on conflict (local_id, codigo) do nothing;

-- Piso 2
insert into public.mesas (piso_id, local_id, codigo, nombre_visible, tipo, capacidad, pos_x, pos_y, ancho, alto, activa)
select 'c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001',
       m.codigo, m.nombre, m.tipo, m.capacidad, m.x, m.y, m.ancho, 80, m.activa
from (values
  -- Fila superior: auxiliares 60–65
  ('60', 'Mesa 60', 'auxiliar', 2, 40, 40, 80, true),
  ('61', 'Mesa 61', 'auxiliar', 2, 140, 40, 80, true),
  ('62', 'Mesa 62', 'auxiliar', 2, 240, 40, 80, true),
  ('63', 'Mesa 63', 'auxiliar', 2, 340, 40, 80, true),
  ('64', 'Mesa 64', 'auxiliar', 2, 440, 40, 80, true),
  ('65', 'Mesa 65', 'auxiliar', 2, 540, 40, 80, true),
  -- Bloque izquierdo y centro: 19 18 17 16 / 20 21 / 23 24 15 / 22 14 / 12 13
  ('19', 'Mesa 19', 'mesa', 4, 40, 170, 80, true),
  ('18', 'Mesa 18', 'mesa', 4, 140, 170, 80, true),
  ('17', 'Mesa 17', 'mesa', 4, 240, 170, 80, true),
  ('16', 'Mesa 16', 'mesa', 4, 340, 170, 80, true),
  ('20', 'Mesa 20', 'mesa', 4, 40, 280, 80, true),
  ('21', 'Mesa 21', 'mesa', 4, 140, 280, 80, true),
  ('23', 'Mesa 23', 'mesa', 4, 40, 390, 80, true),
  ('24', 'Mesa 24', 'mesa', 4, 140, 390, 80, true),
  ('15', 'Mesa 15', 'mesa', 4, 240, 390, 80, true),
  ('22', 'Mesa 22', 'mesa', 4, 40, 500, 80, true),
  ('14', 'Mesa 14', 'mesa', 4, 140, 500, 80, true),
  ('12', 'Mesa 12', 'mesa', 4, 40, 610, 80, true),
  ('13', 'Mesa 13', 'mesa', 4, 140, 610, 80, true),
  -- Bloque derecho: 34 33 32 / 25 31 / 26 30 / 27 29 / 28
  ('34', 'Mesa 34', 'mesa', 4, 600, 170, 80, true),
  ('33', 'Mesa 33', 'mesa', 4, 700, 170, 80, true),
  ('32', 'Mesa 32', 'mesa', 4, 800, 170, 80, true),
  ('25', 'Mesa 25', 'mesa', 4, 600, 280, 80, true),
  ('31', 'Mesa 31', 'mesa', 4, 700, 280, 80, true),
  ('26', 'Mesa 26', 'mesa', 4, 600, 390, 80, true),
  ('30', 'Mesa 30', 'mesa', 4, 700, 390, 80, true),
  ('27', 'Mesa 27', 'mesa', 4, 600, 500, 80, true),
  ('29', 'Mesa 29', 'mesa', 4, 700, 500, 80, true),
  ('28', 'Mesa 28', 'mesa', 4, 600, 610, 80, true),
  -- PENDIENTE CON EL CLIENTE (P1): el croquis tiene 23 mesas (12–34) y la nota dice 24.
  -- La mesa 35 queda desactivada como marcador.
  ('35', 'Mesa 35 (por confirmar)', 'mesa', 4, 700, 610, 80, false),
  -- Mesas virtuales en la esquina inferior izquierda
  ('DELIVERY-2', 'Delivery', 'virtual_delivery', 0, 40, 760, 120, true),
  ('AUDITOR-2', 'Auditor', 'virtual_auditor', 0, 180, 760, 120, true)
) as m (codigo, nombre, tipo, capacidad, x, y, ancho, activa)
on conflict (local_id, codigo) do nothing;

-- -----------------------------------------------------------------------------
-- Carta inicial. Los productos "(EJEMPLO)" se reemplazan con la carta real del cliente.
-- -----------------------------------------------------------------------------
insert into public.categorias (local_id, nombre, orden, estacion_produccion_id_default)
select 'b0000000-0000-4000-8000-000000000001', c.nombre, c.orden, e.id
from (values
  ('Menú del día', 1, 'Cocina'),
  ('Entradas', 2, 'Cocina'),
  ('Parrillas', 3, 'Parrilla'),
  ('Bebidas', 4, 'Bar'),
  ('Otros', 9, null)
) as c (nombre, orden, estacion)
left join public.estaciones_produccion e
  on e.local_id = 'b0000000-0000-4000-8000-000000000001' and e.nombre = c.estacion
on conflict (local_id, nombre) do nothing;

insert into public.productos (local_id, categoria_id, codigo, nombre, descripcion, precio, aplica_icbper,
                              estacion_produccion_id, es_menu_del_dia)
select 'b0000000-0000-4000-8000-000000000001', cat.id, p.codigo, p.nombre, p.descripcion, p.precio, p.icbper,
       cat.estacion_produccion_id_default, p.menu
from (values
  ('MENU', 'Menú del día', 'Entrada + segundo. Lunes a sábado S/ 15, domingo y feriados S/ 18.', 15.00, false, true, 'Menú del día'),
  ('BOLSA', 'Bolsa plástica', 'Afecta al ICBPER (tributo 7152).', 0.00, true, false, 'Otros'),
  ('EJ-PAPAS', 'Papas fritas (EJEMPLO)', null, 10.00, false, false, 'Entradas'),
  ('EJ-PARRILLA', 'Parrilla de la casa (EJEMPLO)', null, 45.00, false, false, 'Parrillas'),
  ('EJ-CHICHA', 'Chicha morada 1 L (EJEMPLO)', null, 12.00, false, false, 'Bebidas')
) as p (codigo, nombre, descripcion, precio, icbper, menu, categoria)
join public.categorias cat
  on cat.local_id = 'b0000000-0000-4000-8000-000000000001' and cat.nombre = p.categoria
on conflict (local_id, codigo) do nothing;

-- Menú del día: entrada y segundo obligatorios (CU5.2). Las opciones del día vienen de menu_diario.
insert into public.producto_modificadores (local_id, producto_id, grupo, obligatorio, min, max)
select p.local_id, p.id, g.grupo, true, 1, 1
from public.productos p
cross join (values ('Entrada'), ('Segundo')) as g (grupo)
where p.local_id = 'b0000000-0000-4000-8000-000000000001' and p.codigo = 'MENU'
on conflict (producto_id, grupo) do nothing;

-- Precio del menú por día (M5): lunes a sábado S/ 15,00; domingo S/ 18,00.
insert into public.reglas_precio_dia (local_id, producto_id, dia_semana, precio, vigencia_desde)
select p.local_id, p.id, d.dia, d.precio, '2026-01-01'
from public.productos p
cross join (values (0, 18.00), (1, 15.00), (2, 15.00), (3, 15.00), (4, 15.00), (5, 15.00), (6, 15.00)) as d (dia, precio)
where p.local_id = 'b0000000-0000-4000-8000-000000000001' and p.codigo = 'MENU'
  and not exists (
    select 1 from public.reglas_precio_dia r where r.producto_id = p.id and r.dia_semana = d.dia
  );

insert into public.modificadores (local_id, grupo, nombre) values
  ('b0000000-0000-4000-8000-000000000001', 'Término', 'Jugoso'),
  ('b0000000-0000-4000-8000-000000000001', 'Término', 'Tres cuartos'),
  ('b0000000-0000-4000-8000-000000000001', 'Término', 'Bien cocido')
on conflict (local_id, grupo, nombre) do nothing;

insert into public.producto_modificadores (local_id, producto_id, grupo, obligatorio, min, max)
select p.local_id, p.id, 'Término', true, 1, 1
from public.productos p
where p.local_id = 'b0000000-0000-4000-8000-000000000001' and p.codigo = 'EJ-PARRILLA'
on conflict (producto_id, grupo) do nothing;

commit;
