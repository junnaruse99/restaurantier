-- =============================================================================
-- Warike POS — 1100 Autenticación por PIN en dispositivos registrados (§4.1)
-- =============================================================================
-- Flujo de pin-login (Edge Function):
--   1. pin_login_verificar(token_dispositivo, codigo, pin): valida el dispositivo y el PIN y lleva la
--      cuenta de intentos (5 fallidos → bloqueo de 15 min). Devuelve el usuario si todo es correcto.
--   2. La Edge Function obtiene una sesión de Supabase Auth para ese usuario.
--   3. pin_login_registrar_sesion(...): liga el session_id de esa sesión al dispositivo por 12 h.
-- Las dos funciones solo las puede ejecutar service_role.

create or replace function app.hash_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;
revoke all on function app.hash_token(text) from public;

-- PIN numérico de 4 a 6 dígitos que no sea trivial (todos iguales o secuencia).
create or replace function app.pin_es_valido(p_pin text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_pin ~ '^[0-9]{4,6}$'
    and p_pin !~ '^(.)\1+$'
    and position(p_pin in '0123456789') = 0
    and position(p_pin in '9876543210') = 0
$$;
revoke all on function app.pin_es_valido(text) from public;

-- La IP llega en cabeceras que controla el cliente: si no es una IP válida se guarda null en vez de
-- hacer fallar el inicio de sesión.
create or replace function app.a_inet(p_texto text)
returns inet
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p_texto::inet;
exception
  when others then
    return null;
end;
$$;
revoke all on function app.a_inet(text) from public;

-- Un local donde el usuario actual administra usuarios y p_user tiene algún rol; null si no hay.
create or replace function app.local_donde_administro(p_user uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ulr.local_id
  from public.user_local_roles ulr
  where ulr.user_id = p_user
    and ulr.local_id in (select app.locales_con_permiso('gestionar_usuarios'))
  order by ulr.local_id
  limit 1
$$;
revoke all on function app.local_donde_administro(uuid) from public;

-- -----------------------------------------------------------------------------
-- Cierre de sesiones de Supabase Auth ligadas a sesiones PIN expiradas o revocadas.
-- Al borrar auth.sessions, el refresh token deja de servir y el usuario debe volver a entrar.
-- -----------------------------------------------------------------------------
create or replace function app.purgar_sesiones_pin()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cantidad integer;
begin
  delete from auth.sessions s
  using app.sesiones_dispositivo sd
  where s.id = sd.session_id
    and (sd.expira_at <= now() or sd.revocada_at is not null);
  get diagnostics v_cantidad = row_count;
  return v_cantidad;
end;
$$;
revoke all on function app.purgar_sesiones_pin() from public;

-- Al desactivar un dispositivo se revocan sus sesiones al instante (§4.1: el admin puede revocarlos).
create or replace function app.revocar_sesiones_dispositivo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update app.sesiones_dispositivo
  set revocada_at = now()
  where dispositivo_id = new.id and revocada_at is null;
  perform app.purgar_sesiones_pin();
  return null;
end;
$$;
revoke all on function app.revocar_sesiones_dispositivo() from public;

create trigger dispositivos_revocar_sesiones
  after update of activo on public.dispositivos
  for each row
  when (old.activo and not new.activo)
  execute function app.revocar_sesiones_dispositivo();

-- -----------------------------------------------------------------------------
-- Registro de un dispositivo. Devuelve el token UNA sola vez; solo se guarda su hash.
-- -----------------------------------------------------------------------------
create or replace function public.registrar_dispositivo(p_local_id uuid, p_nombre text, p_tipo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_id uuid;
begin
  if not app.tiene_permiso(p_local_id, 'configurar_local') then
    raise exception 'No tiene permiso para registrar dispositivos en este local'
      using errcode = 'insufficient_privilege';
  end if;
  if nullif(trim(p_nombre), '') is null then
    raise exception 'El nombre del dispositivo es obligatorio' using errcode = 'invalid_parameter_value';
  end if;

  v_token := 'wkd_' || encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.dispositivos (local_id, nombre, tipo, token_hash)
  values (p_local_id, trim(p_nombre), p_tipo, app.hash_token(v_token))
  returning id into v_id;

  return jsonb_build_object('dispositivo_id', v_id, 'local_id', p_local_id, 'tipo', p_tipo, 'token', v_token);
end;
$$;
revoke all on function public.registrar_dispositivo(uuid, text, text) from public, anon;
grant execute on function public.registrar_dispositivo(uuid, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Definir o cambiar el PIN de un usuario (CU4.1). Solo quien administra usuarios en un local
-- donde el usuario tiene rol. Reinicia intentos y bloqueo.
-- -----------------------------------------------------------------------------
create or replace function public.establecer_pin(p_user_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local uuid := app.local_donde_administro(p_user_id);
begin
  if v_local is null then
    raise exception 'No tiene permiso para definir el PIN de este usuario'
      using errcode = 'insufficient_privilege';
  end if;
  if not app.pin_es_valido(p_pin) then
    raise exception 'El PIN debe tener de 4 a 6 dígitos y no puede ser una secuencia ni repetir un solo dígito'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into app.pin_credenciales (user_id, pin_hash, intentos_fallidos, bloqueado_hasta, actualizado_at, actualizado_por)
  values (p_user_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), 0, null, now(), auth.uid())
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash,
        intentos_fallidos = 0,
        bloqueado_hasta = null,
        actualizado_at = now(),
        actualizado_por = auth.uid();

  perform app.registrar_evento('pin_establecido', 'usuarios_perfil', p_user_id::text, v_local);
end;
$$;
revoke all on function public.establecer_pin(uuid, text) from public, anon;
grant execute on function public.establecer_pin(uuid, text) to authenticated;

create or replace function public.desbloquear_pin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local uuid := app.local_donde_administro(p_user_id);
begin
  if v_local is null then
    raise exception 'No tiene permiso para desbloquear a este usuario' using errcode = 'insufficient_privilege';
  end if;

  update app.pin_credenciales
  set intentos_fallidos = 0, bloqueado_hasta = null, actualizado_at = now(), actualizado_por = auth.uid()
  where user_id = p_user_id;

  perform app.registrar_evento('pin_desbloqueado', 'usuarios_perfil', p_user_id::text, v_local);
end;
$$;
revoke all on function public.desbloquear_pin(uuid) from public, anon;
grant execute on function public.desbloquear_pin(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Paso 1 de pin-login (solo service_role)
-- -----------------------------------------------------------------------------
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
  c_max_intentos constant smallint := 5;
  c_bloqueo constant interval := interval '15 minutes';
  v_disp public.dispositivos%rowtype;
  v_perfil public.usuarios_perfil%rowtype;
  v_cred app.pin_credenciales%rowtype;
  v_email text;
  v_intentos smallint;
  v_bloqueado_hasta timestamptz;
begin
  -- Dispositivo registrado y activo (no se aceptan agentes de impresión).
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

  -- Usuario y credencial. La fila de credencial se bloquea para contar intentos sin carreras.
  select * into v_perfil from public.usuarios_perfil where codigo_empleado = p_codigo;
  if found then
    select * into v_cred from app.pin_credenciales where user_id = v_perfil.user_id for update;
  end if;

  -- Los códigos de empleado son identificadores, no secretos (como un nombre de usuario): la respuesta
  -- a un PIN incorrecto informa los intentos restantes y el bloqueo, para que el personal sepa qué
  -- pasa. Probar códigos exige un dispositivo registrado y el bloqueo es por usuario (DECISIONS D-005).
  if v_perfil.user_id is null or not v_perfil.activo or v_cred.user_id is null then
    perform app.registrar_evento('login_pin_fallido', 'usuarios_perfil', v_perfil.user_id::text, v_disp.local_id,
      jsonb_build_object('motivo', 'usuario_desconocido_o_inactivo', 'codigo', p_codigo), v_perfil.user_id, v_disp.id, v_ip);
    return jsonb_build_object('ok', false, 'error', 'credenciales_invalidas');
  end if;

  if v_cred.bloqueado_hasta is not null and v_cred.bloqueado_hasta > now() then
    perform app.registrar_evento('login_pin_fallido', 'usuarios_perfil', v_perfil.user_id::text, v_disp.local_id,
      jsonb_build_object('motivo', 'bloqueado'), v_perfil.user_id, v_disp.id, v_ip);
    return jsonb_build_object('ok', false, 'error', 'bloqueado', 'bloqueado_hasta', v_cred.bloqueado_hasta);
  end if;

  if v_cred.pin_hash is distinct from extensions.crypt(coalesce(p_pin, ''), v_cred.pin_hash) then
    v_intentos := v_cred.intentos_fallidos + 1;
    if v_intentos >= c_max_intentos then
      v_bloqueado_hasta := now() + c_bloqueo;
      update app.pin_credenciales
      set intentos_fallidos = 0, bloqueado_hasta = v_bloqueado_hasta
      where user_id = v_perfil.user_id;
      perform app.registrar_evento('login_pin_bloqueado', 'usuarios_perfil', v_perfil.user_id::text, v_disp.local_id,
        jsonb_build_object('intentos', v_intentos, 'bloqueado_hasta', v_bloqueado_hasta), v_perfil.user_id, v_disp.id, v_ip);
      return jsonb_build_object('ok', false, 'error', 'bloqueado', 'bloqueado_hasta', v_bloqueado_hasta);
    end if;

    update app.pin_credenciales
    set intentos_fallidos = v_intentos, bloqueado_hasta = null
    where user_id = v_perfil.user_id;
    perform app.registrar_evento('login_pin_fallido', 'usuarios_perfil', v_perfil.user_id::text, v_disp.local_id,
      jsonb_build_object('motivo', 'pin_incorrecto', 'intentos', v_intentos), v_perfil.user_id, v_disp.id, v_ip);
    return jsonb_build_object('ok', false, 'error', 'credenciales_invalidas',
      'intentos_restantes', c_max_intentos - v_intentos);
  end if;

  update app.pin_credenciales
  set intentos_fallidos = 0, bloqueado_hasta = null
  where user_id = v_perfil.user_id;

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
revoke all on function public.pin_login_verificar(text, text, text, text) from public, anon, authenticated;
grant execute on function public.pin_login_verificar(text, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- Paso 3 de pin-login (solo service_role): liga la sesión de Auth al dispositivo por 12 h.
-- -----------------------------------------------------------------------------
create or replace function public.pin_login_registrar_sesion(
  p_user_id uuid,
  p_dispositivo_id uuid,
  p_session_id uuid,
  p_ip text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_duracion constant interval := interval '12 hours';
  v_local uuid;
  v_id uuid;
  v_expira timestamptz := now() + c_duracion;
begin
  select d.local_id into v_local from public.dispositivos d where d.id = p_dispositivo_id and d.activo;
  if v_local is null then
    raise exception 'Dispositivo no autorizado' using errcode = 'insufficient_privilege';
  end if;

  insert into app.sesiones_dispositivo (session_id, user_id, dispositivo_id, local_id, expira_at)
  values (p_session_id, p_user_id, p_dispositivo_id, v_local, v_expira)
  returning id into v_id;

  perform app.registrar_evento('login_pin_ok', 'sesiones_dispositivo', v_id::text, v_local,
    jsonb_build_object('session_id', p_session_id, 'expira_at', v_expira), p_user_id, p_dispositivo_id,
    app.a_inet(p_ip));

  return jsonb_build_object('sesion_dispositivo_id', v_id, 'local_id', v_local, 'expira_at', v_expira);
end;
$$;
revoke all on function public.pin_login_registrar_sesion(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.pin_login_registrar_sesion(uuid, uuid, uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- Contexto de la sesión actual para la PWA: perfil, tipo de sesión y permisos efectivos por local.
-- -----------------------------------------------------------------------------
create or replace function public.mi_contexto()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'perfil', (
      select jsonb_build_object('nombre_visible', up.nombre_visible, 'codigo_empleado', up.codigo_empleado,
                                'activo', up.activo)
      from public.usuarios_perfil up
      where up.user_id = auth.uid()
    ),
    'aal', auth.jwt() ->> 'aal',
    'sesion_pin', (
      select jsonb_build_object('dispositivo_id', s.dispositivo_id, 'local_id', s.local_id, 'expira_at', s.expira_at)
      from app.sesion_pin_vigente() s
    ),
    -- true si tiene roles que exigen MFA, la sesión no es aal2 y tampoco es una sesión PIN
    -- (con PIN solo valen los roles sin MFA): la PWA debe pedir el TOTP.
    'requiere_mfa', (
      not app.sesion_mfa()
      and app.local_sesion_pin() is null
      and exists (
        select 1
        from public.user_local_roles ulr
        join public.roles r on r.id = ulr.role_id and r.activo and r.requiere_mfa
        where ulr.user_id = auth.uid()
      )
    ),
    'locales', coalesce((
      select jsonb_agg(
        jsonb_build_object('local_id', x.local_id, 'nombre', x.nombre, 'roles', x.roles, 'permisos', x.permisos)
        order by x.nombre
      )
      from (
        select
          l.id as local_id,
          l.nombre,
          (select jsonb_agg(distinct r.codigo)
             from app.roles_efectivos() re2
             join public.roles r on r.id = re2.role_id
            where re2.local_id = l.id) as roles,
          coalesce((select jsonb_agg(distinct rp.permission_codigo)
             from app.roles_efectivos() re3
             join public.role_permissions rp on rp.role_id = re3.role_id
            where re3.local_id = l.id), '[]'::jsonb) as permisos
        from public.locales l
        where l.id in (select app.locales_miembro())
      ) x
    ), '[]'::jsonb)
  )
$$;
revoke all on function public.mi_contexto() from public, anon;
grant execute on function public.mi_contexto() to authenticated;

-- -----------------------------------------------------------------------------
-- Limpieza periódica de sesiones PIN expiradas (cada 10 min).
-- -----------------------------------------------------------------------------
create extension if not exists pg_cron;
select cron.schedule('warike-purgar-sesiones-pin', '*/10 * * * *', 'select app.purgar_sesiones_pin()');
