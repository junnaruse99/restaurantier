-- =============================================================================
-- Warike POS — 0900 Seguridad: roles efectivos, RLS, permisos y auditoría
-- =============================================================================
-- Modelo (§4, §14.3):
--   * Un rol de user_local_roles es EFECTIVO para la sesión actual si:
--       - la sesión es aal2 (email + contraseña + TOTP), o
--       - el rol no requiere MFA y la sesión es una sesión PIN vigente (app.sesiones_dispositivo)
--         de un dispositivo activo del MISMO local.
--   * Todas las políticas filtran por local_id contra los locales donde el usuario tiene un
--     rol efectivo (o un permiso concreto).
--   * Las tablas transaccionales no tienen INSERT/UPDATE/DELETE para clientes: se escriben solo con
--     RPC SECURITY DEFINER (fases 1–2) o desde Edge Functions con service_role.

-- -----------------------------------------------------------------------------
-- Funciones auxiliares (SECURITY DEFINER: leen tablas sin depender de su RLS)
-- -----------------------------------------------------------------------------
create or replace function app.sesion_mfa()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

-- Local de la sesión PIN vigente; null si la sesión no es PIN, expiró, fue revocada o el
-- dispositivo está desactivado.
create or replace function app.local_sesion_pin()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.local_id
  from app.sesiones_dispositivo s
  join public.dispositivos d on d.id = s.dispositivo_id
  where s.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
    and s.user_id = auth.uid()
    and s.revocada_at is null
    and s.expira_at > now()
    and d.activo
$$;

create or replace function app.roles_efectivos()
returns table (local_id uuid, role_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select ulr.local_id, ulr.role_id
  from public.user_local_roles ulr
  join public.roles r on r.id = ulr.role_id and r.activo
  join public.usuarios_perfil up on up.user_id = ulr.user_id and up.activo
  where ulr.user_id = auth.uid()
    and (
      app.sesion_mfa()
      or (not r.requiere_mfa and ulr.local_id = app.local_sesion_pin())
    )
$$;

create or replace function app.locales_miembro()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct re.local_id from app.roles_efectivos() re
$$;

create or replace function app.locales_con_permiso(p_permiso text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct re.local_id
  from app.roles_efectivos() re
  join public.role_permissions rp on rp.role_id = re.role_id
  where rp.permission_codigo = p_permiso
$$;

create or replace function app.tiene_permiso(p_local_id uuid, p_permiso text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.locales_con_permiso(p_permiso) l where l = p_local_id)
$$;

create or replace function app.empresas_miembro()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct l.empresa_id
  from public.locales l
  where l.id in (select app.locales_miembro())
$$;

create or replace function app.empresas_con_permiso(p_permiso text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct l.empresa_id
  from public.locales l
  where l.id in (select app.locales_con_permiso(p_permiso))
$$;

-- Usuarios que comparten al menos un local con el usuario actual (para mostrar nombres de mozos, etc.).
create or replace function app.usuarios_visibles()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct ulr.user_id
  from public.user_local_roles ulr
  where ulr.local_id in (select app.locales_miembro())
$$;

revoke all on function app.sesion_mfa() from public;
revoke all on function app.local_sesion_pin() from public;
revoke all on function app.roles_efectivos() from public;
revoke all on function app.locales_miembro() from public;
revoke all on function app.locales_con_permiso(text) from public;
revoke all on function app.tiene_permiso(uuid, text) from public;
revoke all on function app.empresas_miembro() from public;
revoke all on function app.empresas_con_permiso(text) from public;
revoke all on function app.usuarios_visibles() from public;

grant execute on function app.sesion_mfa() to authenticated, service_role;
grant execute on function app.local_sesion_pin() to authenticated, service_role;
grant execute on function app.roles_efectivos() to authenticated, service_role;
grant execute on function app.locales_miembro() to authenticated, service_role;
grant execute on function app.locales_con_permiso(text) to authenticated, service_role;
grant execute on function app.tiene_permiso(uuid, text) to authenticated, service_role;
grant execute on function app.empresas_miembro() to authenticated, service_role;
grant execute on function app.empresas_con_permiso(text) to authenticated, service_role;
grant execute on function app.usuarios_visibles() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- RLS en TODAS las tablas del esquema public y en las tablas internas de app
-- -----------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('public', 'app')
  loop
    execute format('alter table %I.%I enable row level security', t.nspname, t.relname);
  end loop;
end;
$$;

-- Punto de partida: sin privilegios para los roles de la API. Se conceden abajo uno por uno.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all tables in schema app from public, anon, authenticated;

-- service_role (solo Edge Functions) opera todas las tablas de public, salvo modificar audit_log.
-- Se concede explícitamente para no depender de los privilegios por defecto del proyecto.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
revoke update, delete, truncate on public.audit_log from service_role;

-- =============================================================================
-- 5.1 Organización y configuración
-- =============================================================================
grant select on public.empresas to authenticated;
create policy empresas_select on public.empresas for select to authenticated
  using (id in (select app.empresas_miembro()));

grant select on public.locales to authenticated;
grant update (nombre, direccion, hora_corte_operativa, proveedor_cpe, activo) on public.locales to authenticated;
create policy locales_select on public.locales for select to authenticated
  using (id in (select app.locales_miembro()));
create policy locales_update on public.locales for update to authenticated
  using (id in (select app.locales_con_permiso('configurar_local')))
  with check (id in (select app.locales_con_permiso('configurar_local')));

grant select on public.config_local to authenticated;
grant update (descuento_personal_pct, umbral_dni_boleta, umbral_egreso_pin, umbral_alerta_diferencia_caja,
              propina_habilitada, modo_liquidacion_personal)
  on public.config_local to authenticated;
create policy config_local_select on public.config_local for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy config_local_update on public.config_local for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));

-- Tasas y plazos: referencia de solo lectura; se cambian por migración.
grant select on public.config_tributaria to authenticated;
create policy config_tributaria_select on public.config_tributaria for select to authenticated
  using (empresa_id is null or empresa_id in (select app.empresas_miembro()));

grant select on public.config_plazos_cpe to authenticated;
create policy config_plazos_cpe_select on public.config_plazos_cpe for select to authenticated
  using (true);

-- ultimo_numero solo lo mueve la RPC de cobro (reserva de correlativo).
grant select on public.series_cpe to authenticated;
grant insert (local_id, tipo_cpe, serie, activa, es_contingencia) on public.series_cpe to authenticated;
grant update (activa, es_contingencia) on public.series_cpe to authenticated;
create policy series_cpe_select on public.series_cpe for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy series_cpe_insert on public.series_cpe for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('configurar_local')));
create policy series_cpe_update on public.series_cpe for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));

-- Los dispositivos se crean con la RPC registrar_dispositivo (genera el token).
-- token_hash no se concede: los clientes deben listar columnas en vez de usar select=*.
grant select (id, local_id, nombre, tipo, ultimo_ping, activo, created_at, created_by, updated_at)
  on public.dispositivos to authenticated;
grant update (nombre, activo) on public.dispositivos to authenticated;
create policy dispositivos_select on public.dispositivos for select to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')));
create policy dispositivos_update on public.dispositivos for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));

-- El estado de la impresora lo informa el agente (fase 1).
grant select on public.impresoras to authenticated;
grant insert (local_id, nombre, tipo_conexion, host, puerto, ancho_mm, agente_id) on public.impresoras to authenticated;
grant update (nombre, tipo_conexion, host, puerto, ancho_mm, agente_id) on public.impresoras to authenticated;
create policy impresoras_select on public.impresoras for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy impresoras_insert on public.impresoras for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('configurar_local')));
create policy impresoras_update on public.impresoras for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));

grant select on public.estaciones_produccion to authenticated;
grant insert (local_id, nombre, impresora_id, muestra_kds) on public.estaciones_produccion to authenticated;
grant update (nombre, impresora_id, muestra_kds) on public.estaciones_produccion to authenticated;
create policy estaciones_produccion_select on public.estaciones_produccion for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy estaciones_produccion_insert on public.estaciones_produccion for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('configurar_local')));
create policy estaciones_produccion_update on public.estaciones_produccion for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));

-- Feriados globales (local_id null) se cargan por migración; los del local, el admin.
grant select on public.feriados to authenticated;
grant insert (local_id, fecha, descripcion, se_trata_como_domingo) on public.feriados to authenticated;
grant update (fecha, descripcion, se_trata_como_domingo) on public.feriados to authenticated;
grant delete on public.feriados to authenticated;
create policy feriados_select on public.feriados for select to authenticated
  using (local_id is null or local_id in (select app.locales_miembro()));
create policy feriados_insert on public.feriados for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('configurar_local')));
create policy feriados_update on public.feriados for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));
create policy feriados_delete on public.feriados for delete to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')));

-- =============================================================================
-- 5.2 Plano de mesas
-- =============================================================================
grant select on public.pisos to authenticated;
grant insert (local_id, nombre, orden, ancho_canvas, alto_canvas) on public.pisos to authenticated;
grant update (nombre, orden, ancho_canvas, alto_canvas) on public.pisos to authenticated;
create policy pisos_select on public.pisos for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy pisos_insert on public.pisos for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('configurar_local')));
create policy pisos_update on public.pisos for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));

-- El estado de la mesa solo cambia con las RPC de operación (abrir_orden, trasladar_orden, …).
grant select on public.mesas to authenticated;
grant insert (piso_id, local_id, codigo, nombre_visible, tipo, capacidad, pos_x, pos_y, ancho, alto, forma, rotacion, activa)
  on public.mesas to authenticated;
grant update (piso_id, codigo, nombre_visible, tipo, capacidad, pos_x, pos_y, ancho, alto, forma, rotacion, activa)
  on public.mesas to authenticated;
create policy mesas_select on public.mesas for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy mesas_insert on public.mesas for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('configurar_local')));
create policy mesas_update on public.mesas for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));

grant select on public.mesa_uniones to authenticated;
create policy mesa_uniones_select on public.mesa_uniones for select to authenticated
  using (local_id in (select app.locales_miembro()));

-- =============================================================================
-- 5.3 Personas, roles y permisos
-- =============================================================================
-- Datos de planilla (incluye sueldo): solo admin (gestionar_usuarios) y lectura de reportes.
grant select on public.empleados to authenticated;
grant insert (local_id, dni, nombres, apellidos, cargo, fecha_ingreso, sueldo_base, telefono, limite_consumo_mensual, activo)
  on public.empleados to authenticated;
grant update (dni, nombres, apellidos, cargo, fecha_ingreso, sueldo_base, telefono, limite_consumo_mensual, activo)
  on public.empleados to authenticated;
create policy empleados_select on public.empleados for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('gestionar_usuarios'))
    or local_id in (select app.locales_con_permiso('ver_reportes'))
  );
create policy empleados_insert on public.empleados for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('gestionar_usuarios')));
create policy empleados_update on public.empleados for update to authenticated
  using (local_id in (select app.locales_con_permiso('gestionar_usuarios')))
  with check (local_id in (select app.locales_con_permiso('gestionar_usuarios')));

-- Los perfiles se crean desde la Edge Function de alta de usuarios (crea también el usuario de Auth).
grant select on public.usuarios_perfil to authenticated;
grant update (empleado_id, codigo_empleado, nombre_visible, activo) on public.usuarios_perfil to authenticated;
create policy usuarios_perfil_select on public.usuarios_perfil for select to authenticated
  using (user_id = auth.uid() or user_id in (select app.usuarios_visibles()));
create policy usuarios_perfil_update on public.usuarios_perfil for update to authenticated
  using (
    user_id <> auth.uid()
    and exists (
      select 1 from public.user_local_roles ulr
      where ulr.user_id = usuarios_perfil.user_id
        and ulr.local_id in (select app.locales_con_permiso('gestionar_usuarios'))
    )
  )
  with check (
    exists (
      select 1 from public.user_local_roles ulr
      where ulr.user_id = usuarios_perfil.user_id
        and ulr.local_id in (select app.locales_con_permiso('gestionar_usuarios'))
    )
  );

grant select on public.permissions to authenticated;
create policy permissions_select on public.permissions for select to authenticated using (true);

-- Roles base (empresa_id null) solo por migración; el admin crea roles de su empresa.
grant select on public.roles to authenticated;
grant insert (empresa_id, codigo, nombre, requiere_mfa, activo) on public.roles to authenticated;
grant update (nombre, requiere_mfa, activo) on public.roles to authenticated;
create policy roles_select on public.roles for select to authenticated
  using (empresa_id is null or empresa_id in (select app.empresas_miembro()));
create policy roles_insert on public.roles for insert to authenticated
  with check (empresa_id in (select app.empresas_con_permiso('gestionar_usuarios')));
create policy roles_update on public.roles for update to authenticated
  using (empresa_id in (select app.empresas_con_permiso('gestionar_usuarios')))
  with check (empresa_id in (select app.empresas_con_permiso('gestionar_usuarios')));

grant select on public.role_permissions to authenticated;
grant insert (role_id, permission_codigo) on public.role_permissions to authenticated;
grant delete on public.role_permissions to authenticated;
create policy role_permissions_select on public.role_permissions for select to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id));
create policy role_permissions_insert on public.role_permissions for insert to authenticated
  with check (
    exists (
      select 1 from public.roles r
      where r.id = role_id and r.empresa_id in (select app.empresas_con_permiso('gestionar_usuarios'))
    )
  );
create policy role_permissions_delete on public.role_permissions for delete to authenticated
  using (
    exists (
      select 1 from public.roles r
      where r.id = role_id and r.empresa_id in (select app.empresas_con_permiso('gestionar_usuarios'))
    )
  );

-- Un admin asigna roles en los locales donde administra usuarios, y solo roles base o de la misma empresa.
grant select on public.user_local_roles to authenticated;
grant insert (user_id, local_id, role_id) on public.user_local_roles to authenticated;
grant delete on public.user_local_roles to authenticated;
create policy user_local_roles_select on public.user_local_roles for select to authenticated
  using (
    user_id = auth.uid()
    or local_id in (select app.locales_con_permiso('gestionar_usuarios'))
    or local_id in (select app.locales_con_permiso('ver_auditoria'))
  );
create policy user_local_roles_insert on public.user_local_roles for insert to authenticated
  with check (
    local_id in (select app.locales_con_permiso('gestionar_usuarios'))
    and exists (
      select 1
      from public.roles r
      join public.locales l on l.id = user_local_roles.local_id
      where r.id = user_local_roles.role_id
        and (r.empresa_id is null or r.empresa_id = l.empresa_id)
    )
  );
create policy user_local_roles_delete on public.user_local_roles for delete to authenticated
  using (local_id in (select app.locales_con_permiso('gestionar_usuarios')));

-- Clientes: compartidos por empresa; los crea caja al emitir.
grant select on public.clientes to authenticated;
grant insert (empresa_id, tipo_doc, num_doc, nombre_razon_social, direccion, email, telefono,
              consentimiento_marketing, consentimiento_at)
  on public.clientes to authenticated;
grant update (nombre_razon_social, direccion, email, telefono, consentimiento_marketing, consentimiento_at)
  on public.clientes to authenticated;
create policy clientes_select on public.clientes for select to authenticated
  using (
    empresa_id in (select app.empresas_con_permiso('cobrar_emitir'))
    or empresa_id in (select app.empresas_con_permiso('ver_reportes'))
  );
create policy clientes_insert on public.clientes for insert to authenticated
  with check (empresa_id in (select app.empresas_con_permiso('cobrar_emitir')));
create policy clientes_update on public.clientes for update to authenticated
  using (empresa_id in (select app.empresas_con_permiso('cobrar_emitir')))
  with check (empresa_id in (select app.empresas_con_permiso('cobrar_emitir')));

-- doc_cache: sin políticas → solo Edge Functions (service_role).

-- =============================================================================
-- 5.4 Carta y precios
-- =============================================================================
grant select on public.categorias to authenticated;
grant insert (local_id, nombre, orden, estacion_produccion_id_default, activa) on public.categorias to authenticated;
grant update (nombre, orden, estacion_produccion_id_default, activa) on public.categorias to authenticated;
create policy categorias_select on public.categorias for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy categorias_insert on public.categorias for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('gestionar_carta')));
create policy categorias_update on public.categorias for update to authenticated
  using (local_id in (select app.locales_con_permiso('gestionar_carta')))
  with check (local_id in (select app.locales_con_permiso('gestionar_carta')));

-- El precio se cambia solo con la RPC de cambio de precio (exige motivo, CU3.2).
grant select on public.productos to authenticated;
grant insert (local_id, categoria_id, codigo, nombre, descripcion, precio, afectacion_igv, aplica_icbper,
              estacion_produccion_id, es_menu_del_dia, disponible, controla_stock, stock_actual, imagen_url, activo)
  on public.productos to authenticated;
grant update (categoria_id, codigo, nombre, descripcion, afectacion_igv, aplica_icbper, estacion_produccion_id,
              es_menu_del_dia, disponible, controla_stock, imagen_url, activo)
  on public.productos to authenticated;
create policy productos_select on public.productos for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy productos_insert on public.productos for insert to authenticated
  with check (
    local_id in (select app.locales_con_permiso('gestionar_carta'))
    and local_id in (select app.locales_con_permiso('modificar_precios'))
  );
create policy productos_update on public.productos for update to authenticated
  using (local_id in (select app.locales_con_permiso('gestionar_carta')))
  with check (local_id in (select app.locales_con_permiso('gestionar_carta')));

grant select on public.producto_precio_historial to authenticated;
create policy producto_precio_historial_select on public.producto_precio_historial for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('gestionar_carta'))
    or local_id in (select app.locales_con_permiso('ver_reportes'))
  );

grant select on public.modificadores to authenticated;
grant insert (local_id, grupo, nombre, precio_extra, activo) on public.modificadores to authenticated;
grant update (grupo, nombre, precio_extra, activo) on public.modificadores to authenticated;
create policy modificadores_select on public.modificadores for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy modificadores_insert on public.modificadores for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('gestionar_carta')));
create policy modificadores_update on public.modificadores for update to authenticated
  using (local_id in (select app.locales_con_permiso('gestionar_carta')))
  with check (local_id in (select app.locales_con_permiso('gestionar_carta')));

grant select on public.producto_modificadores to authenticated;
grant insert (local_id, producto_id, grupo, obligatorio, min, max) on public.producto_modificadores to authenticated;
grant update (obligatorio, min, max) on public.producto_modificadores to authenticated;
grant delete on public.producto_modificadores to authenticated;
create policy producto_modificadores_select on public.producto_modificadores for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy producto_modificadores_insert on public.producto_modificadores for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('gestionar_carta')));
create policy producto_modificadores_update on public.producto_modificadores for update to authenticated
  using (local_id in (select app.locales_con_permiso('gestionar_carta')))
  with check (local_id in (select app.locales_con_permiso('gestionar_carta')));
create policy producto_modificadores_delete on public.producto_modificadores for delete to authenticated
  using (local_id in (select app.locales_con_permiso('gestionar_carta')));

grant select on public.reglas_precio_dia to authenticated;
grant insert (local_id, producto_id, dia_semana, precio, vigencia_desde, vigencia_hasta)
  on public.reglas_precio_dia to authenticated;
grant update (vigencia_hasta) on public.reglas_precio_dia to authenticated;
create policy reglas_precio_dia_select on public.reglas_precio_dia for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy reglas_precio_dia_insert on public.reglas_precio_dia for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('modificar_precios')));
create policy reglas_precio_dia_update on public.reglas_precio_dia for update to authenticated
  using (local_id in (select app.locales_con_permiso('modificar_precios')))
  with check (local_id in (select app.locales_con_permiso('modificar_precios')));

grant select on public.menu_diario to authenticated;
grant insert (local_id, fecha, producto_id, entradas, segundos, postre, bebida, cantidad_disponible, publicado)
  on public.menu_diario to authenticated;
grant update (entradas, segundos, postre, bebida, cantidad_disponible, publicado) on public.menu_diario to authenticated;
create policy menu_diario_select on public.menu_diario for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy menu_diario_insert on public.menu_diario for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('publicar_menu')));
create policy menu_diario_update on public.menu_diario for update to authenticated
  using (local_id in (select app.locales_con_permiso('publicar_menu')))
  with check (local_id in (select app.locales_con_permiso('publicar_menu')));

-- =============================================================================
-- 5.5 Operación (solo lectura para clientes; se escribe con RPC)
-- =============================================================================
grant select on public.ordenes to authenticated;
create policy ordenes_select on public.ordenes for select to authenticated
  using (local_id in (select app.locales_miembro()));

grant select on public.orden_items to authenticated;
create policy orden_items_select on public.orden_items for select to authenticated
  using (local_id in (select app.locales_miembro()));

grant select on public.comandas to authenticated;
create policy comandas_select on public.comandas for select to authenticated
  using (local_id in (select app.locales_miembro()));

grant select on public.anulaciones to authenticated;
create policy anulaciones_select on public.anulaciones for select to authenticated
  using (local_id in (select app.locales_miembro()));

grant select on public.traslados_mesa to authenticated;
create policy traslados_mesa_select on public.traslados_mesa for select to authenticated
  using (local_id in (select app.locales_miembro()));

grant select on public.descuentos_aplicados to authenticated;
create policy descuentos_aplicados_select on public.descuentos_aplicados for select to authenticated
  using (local_id in (select app.locales_miembro()));

grant select on public.cuentas_empleado to authenticated;
create policy cuentas_empleado_select on public.cuentas_empleado for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('cobrar_emitir'))
    or local_id in (select app.locales_con_permiso('gestionar_usuarios'))
    or local_id in (select app.locales_con_permiso('ver_reportes'))
  );

grant select on public.liquidaciones_empleado to authenticated;
create policy liquidaciones_empleado_select on public.liquidaciones_empleado for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('cobrar_emitir'))
    or local_id in (select app.locales_con_permiso('gestionar_usuarios'))
    or local_id in (select app.locales_con_permiso('ver_reportes'))
  );

-- =============================================================================
-- 5.6 Caja y pagos
-- =============================================================================
grant select on public.cajas to authenticated;
grant insert (local_id, nombre, dispositivo_id, activa) on public.cajas to authenticated;
grant update (nombre, dispositivo_id, activa) on public.cajas to authenticated;
create policy cajas_select on public.cajas for select to authenticated
  using (local_id in (select app.locales_miembro()));
create policy cajas_insert on public.cajas for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('configurar_local')));
create policy cajas_update on public.cajas for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));

-- El cajero solo ve sus propias sesiones (reportes "solo su sesión"); reportes completos con ver_reportes.
grant select on public.sesiones_caja to authenticated;
create policy sesiones_caja_select on public.sesiones_caja for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('ver_reportes'))
    or (cajero_id = auth.uid() and local_id in (select app.locales_con_permiso('operar_caja')))
  );

grant select on public.cortes_caja to authenticated;
create policy cortes_caja_select on public.cortes_caja for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('ver_reportes'))
    or exists (
      select 1 from public.sesiones_caja s
      where s.id = cortes_caja.sesion_caja_id and s.cajero_id = auth.uid()
        and s.local_id in (select app.locales_con_permiso('operar_caja'))
    )
  );

grant select on public.movimientos_caja to authenticated;
create policy movimientos_caja_select on public.movimientos_caja for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('ver_reportes'))
    or exists (
      select 1 from public.sesiones_caja s
      where s.id = movimientos_caja.sesion_caja_id and s.cajero_id = auth.uid()
        and s.local_id in (select app.locales_con_permiso('operar_caja'))
    )
  );

grant select on public.terminales_pos to authenticated;
grant insert (local_id, caja_id, proveedor, store_id, checkout_id, numero_serie, alias, modo, activo)
  on public.terminales_pos to authenticated;
grant update (caja_id, store_id, checkout_id, numero_serie, alias, modo, activo) on public.terminales_pos to authenticated;
create policy terminales_pos_select on public.terminales_pos for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('cobrar_emitir'))
    or local_id in (select app.locales_con_permiso('configurar_local'))
  );
create policy terminales_pos_insert on public.terminales_pos for insert to authenticated
  with check (local_id in (select app.locales_con_permiso('configurar_local')));
create policy terminales_pos_update on public.terminales_pos for update to authenticated
  using (local_id in (select app.locales_con_permiso('configurar_local')))
  with check (local_id in (select app.locales_con_permiso('configurar_local')));

grant select on public.transacciones_pos to authenticated;
create policy transacciones_pos_select on public.transacciones_pos for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('cobrar_emitir'))
    or local_id in (select app.locales_con_permiso('ver_reportes'))
  );

grant select on public.pagos to authenticated;
create policy pagos_select on public.pagos for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('cobrar_emitir'))
    or local_id in (select app.locales_con_permiso('ver_reportes'))
  );

-- =============================================================================
-- 5.7 Facturación
-- =============================================================================
grant select on public.comprobantes to authenticated;
create policy comprobantes_select on public.comprobantes for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('cobrar_emitir'))
    or local_id in (select app.locales_con_permiso('ver_reportes'))
  );

grant select on public.comprobante_items to authenticated;
create policy comprobante_items_select on public.comprobante_items for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('cobrar_emitir'))
    or local_id in (select app.locales_con_permiso('ver_reportes'))
  );

grant select on public.bajas to authenticated;
create policy bajas_select on public.bajas for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('cobrar_emitir'))
    or local_id in (select app.locales_con_permiso('ver_reportes'))
  );

grant select on public.uso_cpe_mensual to authenticated;

-- =============================================================================
-- 5.8 Impresión, sincronización y auditoría
-- =============================================================================
grant select on public.print_jobs to authenticated;
create policy print_jobs_select on public.print_jobs for select to authenticated
  using (local_id in (select app.locales_miembro()));

-- outbox_recibidos: sin políticas → lo usan las RPC SECURITY DEFINER.

-- Los eventos sin local (perfiles de usuario, roles) se muestran si el autor o el usuario afectado
-- comparte un local con quien audita.
grant select on public.audit_log to authenticated;
create policy audit_log_select on public.audit_log for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('ver_auditoria'))
    or (
      local_id is null
      and exists (select 1 from app.locales_con_permiso('ver_auditoria'))
      and (
        user_id in (select app.usuarios_visibles())
        or entidad_id in (select u::text from app.usuarios_visibles() u)
      )
    )
  );

-- =============================================================================
-- Auditoría automática (§5.8)
-- =============================================================================
create trigger auditoria after insert or update or delete on public.ordenes
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.orden_items
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.anulaciones
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.descuentos_aplicados
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.pagos
  for each row execute function app.auditar_cambio();
-- request/response de Nubefact pueden ser grandes; se quedan en la tabla y no se duplican.
create trigger auditoria after insert or update or delete on public.comprobantes
  for each row execute function app.auditar_cambio('request', 'response');
create trigger auditoria after insert or update or delete on public.movimientos_caja
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.sesiones_caja
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.cortes_caja
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.productos
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.mesas
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.usuarios_perfil
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.user_local_roles
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.roles
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.role_permissions
  for each row execute function app.auditar_cambio();
-- ultimo_ping cambia en cada uso del dispositivo: no se audita por sí solo.
create trigger auditoria after insert or update or delete on public.dispositivos
  for each row execute function app.auditar_cambio('token_hash', 'ultimo_ping');
create trigger auditoria after insert or update or delete on public.config_local
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.series_cpe
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.empleados
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.terminales_pos
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.transacciones_pos
  for each row execute function app.auditar_cambio('request', 'response');
create trigger auditoria after insert or update or delete on public.cuentas_empleado
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.liquidaciones_empleado
  for each row execute function app.auditar_cambio();
create trigger auditoria after insert or update or delete on public.bajas
  for each row execute function app.auditar_cambio('response');
