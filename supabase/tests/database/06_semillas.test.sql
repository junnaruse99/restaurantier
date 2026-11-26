-- Datos de referencia (migraciones) y semilla del cliente (§6, §5.1, M5).
begin;
select plan(16);

-- Roles y permisos (§4)
select results_eq(
  $$ select codigo, requiere_mfa from public.roles where empresa_id is null order by codigo $$,
  $$ values ('admin', true), ('agente_impresion', false), ('auditor', true), ('cajero', false), ('cocina', false),
            ('mozo', false) $$,
  'roles base; admin y auditor exigen MFA');
select is(
  (select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.codigo = 'admin'),
  (select count(*)::int from public.permissions),
  'admin tiene todos los permisos');
select is(
  (select array_agg(rp.permission_codigo order by rp.permission_codigo) from public.role_permissions rp
   join public.roles r on r.id = rp.role_id where r.codigo = 'auditor'),
  array['ver_auditoria', 'ver_reportes'],
  'auditor: solo lectura de reportes y bitácora');
select ok(
  not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id
              where r.codigo = 'mozo' and rp.permission_codigo in ('cobrar_emitir', 'ver_reportes', 'operar_caja')),
  'mozo no cobra, no abre caja ni ve reportes');

-- Tasas (§5.1)
select results_eq(
  $$ select regimen, vigencia_desde, vigencia_hasta, tasa_total, icbper_unitario from public.config_tributaria
     where empresa_id is null order by regimen, vigencia_desde $$,
  $$ values ('GENERAL', '2000-01-01'::date, null::date, 0.1800::numeric(6,4), 0.50::numeric(12,2)),
            ('MYPE_RESTAURANTE', '2026-01-01'::date, '2026-12-31'::date, 0.1050::numeric(6,4), 0.50::numeric(12,2)),
            ('MYPE_RESTAURANTE', '2027-01-01'::date, null::date, 0.1500::numeric(6,4), 0.50::numeric(12,2)) $$,
  'tasas 10,5 % (2026), 15 % (2027+) y 18 % (general)');
select throws_ok(
  $$ insert into public.config_tributaria (regimen, vigencia_desde, tasa_igv, tasa_ipm, tasa_total, icbper_unitario)
     values ('MYPE_RESTAURANTE', '2026-06-01', 0.10, 0.02, 0.12, 0.50) $$,
  '23P01', null, 'no se permiten vigencias de tasa solapadas');
select results_eq(
  $$ select vigencia_desde, base_plazo_baja from public.config_plazos_cpe order by vigencia_desde $$,
  $$ values ('2000-01-01'::date, 'desde_cdr'::text), ('2027-01-01'::date, 'desde_generacion'::text) $$,
  'plazo de baja: desde CDR hasta 2026, desde generación desde 2027');

-- Local y series
select results_eq(
  $$ select tipo_cpe, serie from public.series_cpe where local_id = 'b0000000-0000-4000-8000-000000000001' order by serie collate "C" $$,
  $$ values ('03', 'B002'), ('07', 'BC02'), ('01', 'F002'), ('07', 'FC02') $$,
  'series F002, B002, FC02 y BC02');
select results_eq(
  $$ select descuento_personal_pct, umbral_dni_boleta, umbral_egreso_pin from public.config_local
     where local_id = 'b0000000-0000-4000-8000-000000000001' $$,
  $$ values (15.00::numeric(5,2), 700.00::numeric(12,2), 100.00::numeric(12,2)) $$,
  'configuración del local por defecto (15 %, S/ 700, S/ 100)');

-- Plano (§6)
select is(
  (select count(*)::int from public.mesas m join public.pisos p on p.id = m.piso_id
   where p.nombre = 'Piso 1' and m.tipo = 'mesa' and m.local_id = 'b0000000-0000-4000-8000-000000000001'),
  11, 'piso 1: 11 mesas tipo mesa (1 a 11)');
select results_eq(
  $$ select m.codigo from public.mesas m join public.pisos p on p.id = m.piso_id
     where p.nombre = 'Piso 1' and m.tipo = 'auxiliar' order by m.codigo $$,
  $$ values ('01'), ('08'), ('70'), ('71'), ('72'), ('73'), ('74'), ('75') $$,
  'piso 1: auxiliares 01, 08 y 70–75');
select ok(
  exists (select 1 from public.mesas where codigo = '01' and local_id = 'b0000000-0000-4000-8000-000000000001')
  and exists (select 1 from public.mesas where codigo = '1' and local_id = 'b0000000-0000-4000-8000-000000000001'),
  'el código es texto libre: "01" y "1" son mesas distintas');
select results_eq(
  $$ select count(*) filter (where m.activa)::int, count(*) filter (where not m.activa)::int
     from public.mesas m join public.pisos p on p.id = m.piso_id
     where p.nombre = 'Piso 2' and m.tipo = 'mesa' $$,
  $$ values (23, 1) $$,
  'piso 2: 23 mesas activas (12–34) y la 35 desactivada como marcador');
select results_eq(
  $$ select codigo, tipo from public.mesas where tipo like 'virtual%' and local_id = 'b0000000-0000-4000-8000-000000000001'
     order by codigo $$,
  $$ values ('AUDITOR-1', 'virtual_auditor'), ('AUDITOR-2', 'virtual_auditor'), ('DELIVERY-1', 'virtual_delivery'),
            ('DELIVERY-2', 'virtual_delivery'), ('LLEVAR', 'virtual_llevar'), ('PERSONAL', 'virtual_personal') $$,
  'mesas virtuales de delivery, auditor, personal y para llevar');

-- Menú del día (M5): lunes a sábado S/ 15, domingo S/ 18.
select results_eq(
  $$ select r.dia_semana::int, r.precio from public.reglas_precio_dia r
     join public.productos p on p.id = r.producto_id where p.codigo = 'MENU' order by r.dia_semana $$,
  $$ values (0, 18.00::numeric(12,2)), (1, 15.00), (2, 15.00), (3, 15.00), (4, 15.00), (5, 15.00), (6, 15.00) $$,
  'precio del menú por día de la semana');
select ok(
  exists (select 1 from public.productos where codigo = 'BOLSA' and aplica_icbper),
  'existe el producto Bolsa plástica con ICBPER');

select * from finish();
rollback;
