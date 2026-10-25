-- =============================================================================
-- Warike POS — 1000 Datos de referencia (van en migraciones porque producción los necesita)
-- =============================================================================
-- Permisos y roles base (§4), tasas tributarias (§5.1) y plazos SUNAT (§5.1).
-- Los datos propios del cliente (local, mesas, carta, series) están en supabase/seed.

insert into public.permissions (codigo, modulo, descripcion) values
  ('configurar_local',           'configuracion', 'Configurar local, pisos, mesas, impresoras y series'),
  ('gestionar_usuarios',         'personas',      'Crear y editar usuarios y planilla'),
  ('gestionar_carta',            'carta',         'Crear y editar productos y categorías'),
  ('modificar_precios',          'carta',         'Modificar precios y reglas de precio del menú del día'),
  ('publicar_menu',              'carta',         'Publicar la composición del menú del día'),
  ('tomar_pedido',               'salon',         'Abrir mesa, tomar pedido y enviar a cocina'),
  ('trasladar_mesa',             'salon',         'Cambiar, unir o separar cualquier mesa'),
  ('trasladar_mesa_propia',      'salon',         'Cambiar, unir o separar solo sus mesas'),
  ('anular_item_borrador',       'salon',         'Anular un ítem no enviado'),
  ('solicitar_anulacion',        'salon',         'Solicitar la anulación de un ítem enviado o de una orden'),
  ('autorizar_anulacion',        'salon',         'Autorizar la anulación de un ítem enviado o de una orden'),
  ('solicitar_descuento',        'caja',          'Solicitar un descuento libre o una cortesía'),
  ('autorizar_descuento',        'caja',          'Aplicar o autorizar un descuento libre o una cortesía'),
  ('registrar_consumo_personal', 'salon',         'Registrar consumo de personal (descuento del 15 %)'),
  ('generar_precuenta',          'salon',         'Generar la pre-cuenta'),
  ('cobrar_emitir',              'caja',          'Cobrar y emitir comprobante'),
  ('solicitar_nc',               'caja',          'Solicitar una nota de crédito o baja'),
  ('emitir_nc',                  'caja',          'Emitir una nota de crédito o baja'),
  ('operar_caja',                'caja',          'Abrir caja, corte X y cierre Z'),
  ('registrar_movimiento_caja',  'caja',          'Registrar ingresos y egresos de caja'),
  ('autorizar_egreso',           'caja',          'Autorizar egresos por encima del umbral'),
  ('operar_kds',                 'cocina',        'Ver el KDS y marcar preparado o listo'),
  ('ver_listos_kds',             'cocina',        'Ver los ítems listos en el KDS'),
  ('ver_reportes',               'reportes',      'Ver todos los reportes (paloteo, liquidación, ventas)'),
  ('ver_reportes_sesion',        'reportes',      'Ver los reportes de su propia sesión de caja'),
  ('ver_auditoria',              'auditoria',     'Ver la bitácora de auditoría');

insert into public.roles (codigo, nombre, requiere_mfa) values
  ('admin',   'Administrador', true),
  ('cajero',  'Cajero',        false),
  ('mozo',    'Mozo',          false),
  ('cocina',  'Cocina',        false),
  ('auditor', 'Auditor',       true);

-- Matriz de §4. "Solicita + PIN de admin" se modela como permiso de solicitud; la autorización
-- la da quien tenga el permiso autorizar_* (admin).
insert into public.role_permissions (role_id, permission_codigo)
select r.id, p.codigo
from public.roles r
cross join public.permissions p
where r.empresa_id is null and r.codigo = 'admin';

insert into public.role_permissions (role_id, permission_codigo)
select r.id, x.permiso
from public.roles r
join (values
  ('cajero', 'tomar_pedido'),
  ('cajero', 'trasladar_mesa'),
  ('cajero', 'anular_item_borrador'),
  ('cajero', 'solicitar_anulacion'),
  ('cajero', 'solicitar_descuento'),
  ('cajero', 'registrar_consumo_personal'),
  ('cajero', 'generar_precuenta'),
  ('cajero', 'cobrar_emitir'),
  ('cajero', 'solicitar_nc'),
  ('cajero', 'operar_caja'),
  ('cajero', 'registrar_movimiento_caja'),
  ('cajero', 'ver_reportes_sesion'),
  ('mozo', 'tomar_pedido'),
  ('mozo', 'trasladar_mesa_propia'),
  ('mozo', 'anular_item_borrador'),
  ('mozo', 'solicitar_anulacion'),
  ('mozo', 'registrar_consumo_personal'),
  ('mozo', 'generar_precuenta'),
  ('mozo', 'ver_listos_kds'),
  ('cocina', 'operar_kds'),
  ('cocina', 'publicar_menu'),
  ('auditor', 'ver_reportes'),
  ('auditor', 'ver_auditoria')
) as x (rol, permiso) on x.rol = r.codigo
where r.empresa_id is null;

-- Tasas (§5.1). Régimen especial MYPE de restaurantes: 10,5 % en 2026 y 15 % desde 2027; régimen general: 18 %.
-- Si Warike califica para el régimen especial lo confirma el contador (DECISIONS.md, P4).
insert into public.config_tributaria (empresa_id, regimen, vigencia_desde, vigencia_hasta, tasa_igv, tasa_ipm, tasa_total, icbper_unitario) values
  (null, 'MYPE_RESTAURANTE', '2026-01-01', '2026-12-31', 0.08, 0.025, 0.105, 0.50),
  (null, 'MYPE_RESTAURANTE', '2027-01-01', null,         0.12, 0.03,  0.15,  0.50),
  (null, 'GENERAL',          '2000-01-01', null,         0.16, 0.02,  0.18,  0.50);

-- Plazos SUNAT (§5.1): hasta 2026-12-31 la baja se cuenta desde el CDR; desde 2027, desde la generación.
insert into public.config_plazos_cpe (vigencia_desde, plazo_envio_factura_dias, plazo_envio_boleta_dias, plazo_resumen_dias, plazo_baja_dias, base_plazo_baja) values
  ('2000-01-01', 3, 5, 7, 7, 'desde_cdr'),
  ('2027-01-01', 3, 5, 7, 7, 'desde_generacion');
