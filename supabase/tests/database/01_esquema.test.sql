-- Estructura y permisos base: tablas del modelo, RLS en todas las tablas y nada expuesto de más.
begin;
select plan(14);

select is(
  (select array_agg(t order by t) from unnest(array[
    'empresas', 'locales', 'config_local', 'config_tributaria', 'config_plazos_cpe', 'series_cpe', 'dispositivos',
    'impresoras', 'estaciones_produccion', 'feriados', 'pisos', 'mesas', 'mesa_uniones', 'empleados',
    'usuarios_perfil', 'roles', 'permissions', 'role_permissions', 'user_local_roles', 'clientes', 'doc_cache',
    'categorias', 'productos', 'producto_precio_historial', 'modificadores', 'producto_modificadores',
    'reglas_precio_dia', 'menu_diario', 'ordenes', 'orden_items', 'comandas', 'anulaciones', 'traslados_mesa',
    'descuentos_aplicados', 'cuentas_empleado', 'liquidaciones_empleado', 'cajas', 'sesiones_caja', 'cortes_caja',
    'movimientos_caja', 'pagos', 'terminales_pos', 'transacciones_pos', 'comprobantes', 'comprobante_items', 'bajas',
    'print_jobs', 'outbox_recibidos', 'audit_log'
  ]) as t where to_regclass('public.' || t) is null),
  null,
  'existen todas las tablas del modelo de datos (§5)'
);

select has_view('public', 'uso_cpe_mensual', 'existe la vista uso_cpe_mensual');

select is(
  (select array_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname in ('public', 'app') and not c.relrowsecurity),
  null,
  'todas las tablas de public y app tienen RLS habilitado'
);

select is(
  (select array_agg(distinct table_name::text)
   from information_schema.role_table_grants
   where grantee = 'anon' and table_schema in ('public', 'app')),
  null,
  'anon no tiene privilegios sobre ninguna tabla'
);

select is(
  (select array_agg(distinct table_name::text)
   from information_schema.column_privileges
   where grantee = 'anon' and table_schema in ('public', 'app')),
  null,
  'anon no tiene privilegios de columna'
);

select is(
  (select array_agg(t order by t)
   from unnest(array[
     'ordenes', 'orden_items', 'comandas', 'anulaciones', 'traslados_mesa', 'descuentos_aplicados',
     'cuentas_empleado', 'liquidaciones_empleado', 'mesa_uniones', 'sesiones_caja', 'cortes_caja',
     'movimientos_caja', 'pagos', 'transacciones_pos', 'comprobantes', 'comprobante_items', 'bajas', 'print_jobs',
     'outbox_recibidos', 'audit_log', 'producto_precio_historial', 'doc_cache'
   ]) as t
   where has_table_privilege('authenticated', 'public.' || t, 'INSERT')
      or has_any_column_privilege('authenticated', 'public.' || t, 'INSERT')
      or has_any_column_privilege('authenticated', 'public.' || t, 'UPDATE')
      or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
      or has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE')),
  null,
  'authenticated no escribe directamente en tablas transaccionales (solo RPC)'
);

select ok(
  has_table_privilege('service_role', 'public.comprobantes', 'INSERT')
  and has_table_privilege('service_role', 'public.doc_cache', 'UPDATE')
  and has_table_privilege('service_role', 'public.audit_log', 'INSERT')
  and not has_table_privilege('service_role', 'public.audit_log', 'UPDATE')
  and not has_table_privilege('service_role', 'public.audit_log', 'DELETE'),
  'service_role escribe en todas las tablas salvo modificar audit_log'
);

select ok(
  not has_any_column_privilege('authenticated', 'public.doc_cache', 'SELECT')
  and not has_any_column_privilege('authenticated', 'public.outbox_recibidos', 'SELECT'),
  'doc_cache y outbox_recibidos no son legibles por la API'
);

select ok(
  not has_column_privilege('authenticated', 'public.dispositivos', 'token_hash', 'SELECT')
  and not has_column_privilege('authenticated', 'public.mesas', 'estado', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.productos', 'precio', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.series_cpe', 'ultimo_numero', 'UPDATE'),
  'columnas sensibles protegidas: token_hash, mesas.estado, productos.precio, series_cpe.ultimo_numero'
);

select is(
  (select array_agg(p.proname::text order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')),
  null,
  'anon no puede ejecutar ninguna función de public'
);

select ok(
  not has_function_privilege('authenticated', 'public.pin_login_verificar(text, text, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.pin_login_registrar_sesion(uuid, uuid, uuid, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.pin_login_verificar(text, text, text, text)', 'EXECUTE'),
  'las funciones de pin-login son exclusivas de service_role'
);

select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app') and p.prosecdef
     and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')),
  null,
  'toda función SECURITY DEFINER fija su search_path'
);

select is(
  (select array_agg(t order by t)
   from unnest(array[
     'ordenes', 'orden_items', 'anulaciones', 'descuentos_aplicados', 'pagos', 'comprobantes', 'movimientos_caja',
     'sesiones_caja', 'productos', 'mesas', 'usuarios_perfil', 'user_local_roles', 'comandas', 'mesa_uniones',
     'traslados_mesa', 'comprobante_items'
   ]) as t
   where not exists (
     select 1 from pg_trigger tg
     where tg.tgrelid = ('public.' || t)::regclass and tg.tgname = 'auditoria' and not tg.tgisinternal
   )),
  null,
  'las tablas exigidas por §5.8 (y las demás transaccionales) tienen trigger de auditoría'
);

select is(
  (select array_agg(t order by t)
   from unnest(array[
     'ordenes', 'orden_items', 'comandas', 'anulaciones', 'traslados_mesa', 'descuentos_aplicados', 'mesa_uniones',
     'cuentas_empleado', 'liquidaciones_empleado', 'sesiones_caja', 'cortes_caja', 'movimientos_caja', 'pagos',
     'transacciones_pos', 'comprobantes', 'comprobante_items', 'bajas', 'empleados', 'series_cpe', 'print_jobs',
     'outbox_recibidos'
   ]) as t
   where not exists (
     select 1 from pg_trigger tg
     where tg.tgrelid = ('public.' || t)::regclass and tg.tgname = t || '_sin_borrado'
   )),
  null,
  'las tablas transaccionales prohíben el borrado físico'
);

select * from finish();
rollback;
