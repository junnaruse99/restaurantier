-- =============================================================================
-- Warike POS — Fase 1 · 0100 Base de la operación de salón
-- =============================================================================
-- Utilidades que comparten las RPC de la fase 1:
--   * errores con código HTTP para PostgREST (SQLSTATE PTxxx) y código de máquina en `details`;
--   * fecha operativa y precio vigente (M5, §9);
--   * correlativo de órdenes por día;
--   * idempotencia por client_mutation_id (§12.2);
--   * autorizaciones de supervisor con PIN, de un solo uso (§4.1).

-- -----------------------------------------------------------------------------
-- Errores
-- -----------------------------------------------------------------------------
-- PostgREST responde con el estado HTTP de un SQLSTATE 'PTxxx'. El mensaje es para la persona; el
-- código estable va en `details` para que la PWA decida qué hacer.
create or replace function app.fallar(p_estado integer, p_codigo text, p_mensaje text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'PT' || p_estado::text, message = p_mensaje, detail = p_codigo;
end;
$$;
revoke all on function app.fallar(integer, text, text) from public;
grant execute on function app.fallar(integer, text, text) to authenticated, service_role;

create or replace function app.exigir_permiso(p_local_id uuid, p_permiso text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_local_id is null or not app.tiene_permiso(p_local_id, p_permiso) then
    perform app.fallar(403, 'sin_permiso',
      'No tiene permiso para: ' || coalesce((select descripcion from public.permissions where codigo = p_permiso), p_permiso));
  end if;
end;
$$;
revoke all on function app.exigir_permiso(uuid, text) from public;
grant execute on function app.exigir_permiso(uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Configuración del KDS (M7: alertas a los 15 y 25 min, configurables)
-- -----------------------------------------------------------------------------
alter table public.config_local
  add column kds_alerta_amarilla_min smallint not null default 15,
  add column kds_alerta_roja_min smallint not null default 25,
  add constraint config_local_kds_alertas check (kds_alerta_amarilla_min > 0 and kds_alerta_roja_min > kds_alerta_amarilla_min);
grant update (kds_alerta_amarilla_min, kds_alerta_roja_min) on public.config_local to authenticated;

-- -----------------------------------------------------------------------------
-- Fecha operativa (M5): antes de la hora de corte del local cuenta como el día anterior.
-- La misma regla vive en packages/domain para la UI; la autoritativa es esta.
-- -----------------------------------------------------------------------------
create or replace function app.fecha_operativa(p_local_id uuid, p_momento timestamptz default now())
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select ((p_momento at time zone 'America/Lima') - l.hora_corte_operativa)::date
  from public.locales l
  where l.id = p_local_id
$$;
revoke all on function app.fecha_operativa(uuid, timestamptz) from public;
grant execute on function app.fecha_operativa(uuid, timestamptz) to authenticated, service_role;

-- Precio con IGV vigente de un producto en una fecha operativa: regla por día de la semana
-- (los feriados marcados se cobran como domingo) o, si no hay regla, el precio de carta.
create or replace function app.precio_vigente(p_producto_id uuid, p_fecha date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select r.precio
      from public.reglas_precio_dia r
      where r.producto_id = p.id
        and r.dia_semana = case
          when exists (
            select 1 from public.feriados f
            where f.fecha = p_fecha and f.se_trata_como_domingo and (f.local_id is null or f.local_id = p.local_id)
          ) then 0
          else extract(dow from p_fecha)::smallint
        end
        and p_fecha >= r.vigencia_desde
        and (r.vigencia_hasta is null or p_fecha <= r.vigencia_hasta)
      limit 1
    ),
    p.precio
  )
  from public.productos p
  where p.id = p_producto_id
$$;
revoke all on function app.precio_vigente(uuid, date) from public;
grant execute on function app.precio_vigente(uuid, date) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Correlativo de órdenes por local y fecha operativa
-- -----------------------------------------------------------------------------
create table app.contadores_orden (
  local_id uuid not null references public.locales (id),
  fecha_operativa date not null,
  ultimo integer not null,
  primary key (local_id, fecha_operativa)
);
alter table app.contadores_orden enable row level security;

create or replace function app.siguiente_numero_orden(p_local_id uuid, p_fecha date)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into app.contadores_orden as c (local_id, fecha_operativa, ultimo)
  values (p_local_id, p_fecha, 1)
  on conflict (local_id, fecha_operativa) do update set ultimo = c.ultimo + 1
  returning c.ultimo
$$;
revoke all on function app.siguiente_numero_orden(uuid, date) from public;

-- -----------------------------------------------------------------------------
-- Idempotencia (§12.2): una mutación con el mismo client_mutation_id se aplica una sola vez y,
-- si se reenvía, devuelve el mismo resultado.
-- -----------------------------------------------------------------------------
create or replace function app.inicio_mutacion(p_client_mutation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_client_mutation_id is null then
    return null;
  end if;
  -- Serializa reenvíos simultáneos de la misma mutación.
  perform pg_advisory_xact_lock(hashtextextended(p_client_mutation_id::text, 0));
  return (select o.resultado from public.outbox_recibidos o where o.client_mutation_id = p_client_mutation_id);
end;
$$;
revoke all on function app.inicio_mutacion(uuid) from public;

create or replace function app.registrar_mutacion(
  p_client_mutation_id uuid,
  p_local_id uuid,
  p_tipo text,
  p_payload jsonb,
  p_resultado jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_client_mutation_id is not null then
    insert into public.outbox_recibidos (client_mutation_id, local_id, dispositivo_id, tipo, payload, resultado)
    values (p_client_mutation_id, p_local_id, app.dispositivo_sesion(), p_tipo, coalesce(p_payload, '{}'::jsonb), p_resultado);
  end if;
  return p_resultado;
end;
$$;
revoke all on function app.registrar_mutacion(uuid, uuid, text, jsonb, jsonb) from public;

-- -----------------------------------------------------------------------------
-- Comprobación de PIN con conteo de intentos (§4.1: 5 fallidos → bloqueo de 15 min).
-- La usan el ingreso con PIN y la autorización de supervisor, para que la política sea una sola.
-- -----------------------------------------------------------------------------
create or replace function app.comprobar_pin(p_user_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_intentos constant smallint := 5;
  c_bloqueo constant interval := interval '15 minutes';
  v_cred app.pin_credenciales%rowtype;
  v_intentos smallint;
  v_bloqueado_hasta timestamptz;
begin
  select * into v_cred from app.pin_credenciales where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'credenciales_invalidas', 'motivo', 'sin_pin');
  end if;

  if v_cred.bloqueado_hasta is not null and v_cred.bloqueado_hasta > now() then
    return jsonb_build_object('ok', false, 'error', 'bloqueado', 'motivo', 'bloqueado',
                              'bloqueado_hasta', v_cred.bloqueado_hasta);
  end if;

  if v_cred.pin_hash is distinct from extensions.crypt(coalesce(p_pin, ''), v_cred.pin_hash) then
    v_intentos := v_cred.intentos_fallidos + 1;
    if v_intentos >= c_max_intentos then
      v_bloqueado_hasta := now() + c_bloqueo;
      update app.pin_credenciales set intentos_fallidos = 0, bloqueado_hasta = v_bloqueado_hasta
      where user_id = p_user_id;
      return jsonb_build_object('ok', false, 'error', 'bloqueado', 'motivo', 'bloqueo_por_intentos',
                                'intentos', v_intentos, 'bloqueado_hasta', v_bloqueado_hasta);
    end if;
    update app.pin_credenciales set intentos_fallidos = v_intentos, bloqueado_hasta = null
    where user_id = p_user_id;
    return jsonb_build_object('ok', false, 'error', 'credenciales_invalidas', 'motivo', 'pin_incorrecto',
                              'intentos', v_intentos, 'intentos_restantes', c_max_intentos - v_intentos);
  end if;

  update app.pin_credenciales set intentos_fallidos = 0, bloqueado_hasta = null where user_id = p_user_id;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function app.comprobar_pin(uuid, text) from public;

-- pin_login_verificar pasa a usar app.comprobar_pin (misma firma y permisos que en la fase 0).
create or replace function public.pin_login_verificar(
  p_device_token text,
  p_codigo text,
  p_pin text,
  p_ip text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ip constant inet := app.a_inet(p_ip);
  v_disp public.dispositivos%rowtype;
  v_perfil public.usuarios_perfil%rowtype;
  v_pin jsonb;
  v_email text;
begin
  select * into v_disp from public.dispositivos where token_hash = app.hash_token(coalesce(p_device_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', 'dispositivo_no_autorizado');
  end if;
  if not v_disp.activo or v_disp.tipo = 'agente_impresion' then
    perform app.registrar_evento('login_pin_rechazado', 'dispositivos', v_disp.id::text, v_disp.local_id,
      jsonb_build_object('motivo', 'dispositivo_no_autorizado', 'codigo', p_codigo), null, v_disp.id, v_ip);
    return jsonb_build_object('ok', false, 'error', 'dispositivo_no_autorizado');
  end if;

  update public.dispositivos set ultimo_ping = now() where id = v_disp.id;

  -- Los códigos de empleado son identificadores, no secretos (DECISIONS D-005).
  select * into v_perfil from public.usuarios_perfil where codigo_empleado = p_codigo;
  if v_perfil.user_id is null or not v_perfil.activo then
    perform app.registrar_evento('login_pin_fallido', 'usuarios_perfil', v_perfil.user_id::text, v_disp.local_id,
      jsonb_build_object('motivo', 'usuario_desconocido_o_inactivo', 'codigo', p_codigo), v_perfil.user_id, v_disp.id, v_ip);
    return jsonb_build_object('ok', false, 'error', 'credenciales_invalidas');
  end if;

  v_pin := app.comprobar_pin(v_perfil.user_id, p_pin);
  if not (v_pin ->> 'ok')::boolean then
    perform app.registrar_evento(
      case when v_pin ->> 'motivo' = 'bloqueo_por_intentos' then 'login_pin_bloqueado' else 'login_pin_fallido' end,
      'usuarios_perfil', v_perfil.user_id::text, v_disp.local_id,
      v_pin - 'ok' - 'error', v_perfil.user_id, v_disp.id, v_ip);
    return jsonb_build_object('ok', false, 'error', v_pin ->> 'error',
      'bloqueado_hasta', v_pin -> 'bloqueado_hasta', 'intentos_restantes', v_pin -> 'intentos_restantes');
  end if;

  -- Con PIN solo cuentan los roles sin MFA (mozo, cajero, cocina…) del local del dispositivo.
  if not exists (
    select 1
    from public.user_local_roles ulr
    join public.roles r on r.id = ulr.role_id and r.activo
    where ulr.user_id = v_perfil.user_id
      and ulr.local_id = v_disp.local_id
      and not r.requiere_mfa
  ) then
    perform app.registrar_evento('login_pin_rechazado', 'usuarios_perfil', v_perfil.user_id::text, v_disp.local_id,
      jsonb_build_object('motivo', 'sin_rol_en_local'), v_perfil.user_id, v_disp.id, v_ip);
    return jsonb_build_object('ok', false, 'error', 'sin_rol_en_local');
  end if;

  select u.email into v_email
  from auth.users u
  where u.id = v_perfil.user_id
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until < now());
  if v_email is null then
    perform app.registrar_evento('login_pin_rechazado', 'usuarios_perfil', v_perfil.user_id::text, v_disp.local_id,
      jsonb_build_object('motivo', 'usuario_auth_no_disponible'), v_perfil.user_id, v_disp.id, v_ip);
    return jsonb_build_object('ok', false, 'error', 'credenciales_invalidas');
  end if;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_perfil.user_id,
    'email', v_email,
    'nombre_visible', v_perfil.nombre_visible,
    'dispositivo_id', v_disp.id,
    'local_id', v_disp.local_id
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Autorizaciones de supervisor (§4.1): el supervisor digita su código y PIN en el mismo
-- dispositivo; se emite una autorización de un solo uso, válida 2 minutos, para un permiso, un
-- local y quien la pidió. La RPC sensible la consume.
-- -----------------------------------------------------------------------------
create table app.autorizaciones (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  permiso text not null references public.permissions (codigo),
  autorizado_por uuid not null references public.usuarios_perfil (user_id),
  solicitante uuid not null,
  creada_at timestamptz not null default now(),
  expira_at timestamptz not null,
  usada_at timestamptz,
  check (expira_at > creada_at)
);
alter table app.autorizaciones enable row level security;

create or replace function public.autorizar_con_pin(p_local_id uuid, p_permiso text, p_codigo text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_vigencia constant interval := interval '2 minutes';
  v_perfil public.usuarios_perfil%rowtype;
  v_pin jsonb;
  v_id uuid;
  v_expira timestamptz := now() + c_vigencia;
begin
  -- Quien pide la autorización debe operar en el local.
  if p_local_id is null or not exists (select 1 from app.locales_miembro() l where l = p_local_id) then
    perform app.fallar(403, 'sin_permiso', 'No opera en este local');
  end if;
  if not exists (select 1 from public.permissions where codigo = p_permiso and codigo like 'autorizar_%') then
    perform app.fallar(400, 'permiso_invalido', 'Permiso de autorización inválido');
  end if;

  select * into v_perfil from public.usuarios_perfil where codigo_empleado = p_codigo and activo;
  if not found then
    perform app.registrar_evento('autorizacion_pin_fallida', 'usuarios_perfil', null, p_local_id,
      jsonb_build_object('motivo', 'usuario_desconocido_o_inactivo', 'codigo', p_codigo, 'permiso', p_permiso));
    return jsonb_build_object('ok', false, 'error', 'credenciales_invalidas');
  end if;

  v_pin := app.comprobar_pin(v_perfil.user_id, p_pin);
  if not (v_pin ->> 'ok')::boolean then
    perform app.registrar_evento('autorizacion_pin_fallida', 'usuarios_perfil', v_perfil.user_id::text, p_local_id,
      (v_pin - 'ok' - 'error') || jsonb_build_object('permiso', p_permiso));
    return jsonb_build_object('ok', false, 'error', v_pin ->> 'error',
      'bloqueado_hasta', v_pin -> 'bloqueado_hasta', 'intentos_restantes', v_pin -> 'intentos_restantes');
  end if;

  -- El supervisor debe tener el permiso en el local (su presencia física reemplaza a su sesión MFA).
  if not exists (
    select 1
    from public.user_local_roles ulr
    join public.roles r on r.id = ulr.role_id and r.activo
    join public.role_permissions rp on rp.role_id = r.id
    where ulr.user_id = v_perfil.user_id and ulr.local_id = p_local_id and rp.permission_codigo = p_permiso
  ) then
    perform app.registrar_evento('autorizacion_pin_fallida', 'usuarios_perfil', v_perfil.user_id::text, p_local_id,
      jsonb_build_object('motivo', 'sin_permiso', 'permiso', p_permiso));
    return jsonb_build_object('ok', false, 'error', 'sin_permiso');
  end if;

  insert into app.autorizaciones (local_id, permiso, autorizado_por, solicitante, expira_at)
  values (p_local_id, p_permiso, v_perfil.user_id, auth.uid(), v_expira)
  returning id into v_id;

  perform app.registrar_evento('autorizacion_pin', 'usuarios_perfil', v_perfil.user_id::text, p_local_id,
    jsonb_build_object('permiso', p_permiso, 'autorizacion_id', v_id, 'solicitante', auth.uid()));

  return jsonb_build_object('ok', true, 'autorizacion_id', v_id, 'expira_at', v_expira,
    'autorizado_por', jsonb_build_object('id', v_perfil.user_id, 'nombre', v_perfil.nombre_visible));
end;
$$;
revoke all on function public.autorizar_con_pin(uuid, text, text, text) from public, anon;
grant execute on function public.autorizar_con_pin(uuid, text, text, text) to authenticated;

-- Devuelve quién autoriza una acción: el propio usuario si tiene el permiso, o el supervisor de
-- una autorización con PIN vigente (que queda consumida). Falla si no hay ninguna de las dos.
create or replace function app.autorizador(p_local_id uuid, p_permiso text, p_autorizacion_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_aut app.autorizaciones%rowtype;
begin
  if app.tiene_permiso(p_local_id, p_permiso) then
    return auth.uid();
  end if;
  if p_autorizacion_id is null then
    perform app.fallar(403, 'requiere_autorizacion', 'Esta acción requiere la autorización de un supervisor');
  end if;

  select * into v_aut from app.autorizaciones where id = p_autorizacion_id for update;
  if not found
     or v_aut.local_id <> p_local_id
     or v_aut.permiso <> p_permiso
     or v_aut.solicitante is distinct from auth.uid()
     or v_aut.usada_at is not null
     or v_aut.expira_at <= now() then
    perform app.fallar(403, 'autorizacion_invalida', 'La autorización del supervisor no es válida o venció');
  end if;

  update app.autorizaciones set usada_at = now() where id = p_autorizacion_id;
  return v_aut.autorizado_por;
end;
$$;
revoke all on function app.autorizador(uuid, text, uuid) from public;

-- -----------------------------------------------------------------------------
-- Totales de la orden: suma de los ítems no anulados (descuentos en la fase 2).
-- -----------------------------------------------------------------------------
create or replace function app.recalcular_orden(p_orden_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ordenes o
  set subtotal = t.subtotal,
      total = greatest(t.subtotal - o.descuento_total, 0)
  from (
    select coalesce(sum(i.total_linea), 0)::numeric(12, 2) as subtotal
    from public.orden_items i
    where i.orden_id = p_orden_id and i.estado <> 'anulado'
  ) t
  where o.id = p_orden_id
$$;
revoke all on function app.recalcular_orden(uuid) from public;

-- Nombre legible de una mesa para comandas y avisos ("Mesa 05").
create or replace function app.etiqueta_mesa(p_mesa_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(m.nombre_visible, 'Mesa ' || m.codigo) from public.mesas m where m.id = p_mesa_id
$$;
revoke all on function app.etiqueta_mesa(uuid) from public;

-- -----------------------------------------------------------------------------
-- Realtime (M1, M7): cambios de mesas, órdenes, ítems, comandas, anulaciones, carta e impresoras.
-- La RLS de cada tabla decide qué recibe cada suscriptor.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.mesas, public.ordenes, public.orden_items, public.comandas, public.anulaciones,
      public.productos, public.impresoras, public.print_jobs;
  end if;
end;
$$;
