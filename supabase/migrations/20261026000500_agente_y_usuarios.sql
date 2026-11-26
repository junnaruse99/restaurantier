-- =============================================================================
-- Warike POS — Fase 1 · 0500 Agente de impresión (§3, §13) y alta de usuarios (M4)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Rol técnico del agente de impresión
-- -----------------------------------------------------------------------------
-- El agente nunca usa la service_role (§14.3): se autentica como su dispositivo con un usuario
-- técnico propio, cuyo único permiso es imprimir, y con una sesión ligada al dispositivo.
insert into public.permissions (codigo, modulo, descripcion)
values ('imprimir', 'impresion', 'Tomar y reportar trabajos de impresión (agente local)');

insert into public.roles (codigo, nombre, requiere_mfa) values ('agente_impresion', 'Agente de impresión', false);

-- El admin conserva todos los permisos; agente_actual() exige además la sesión del dispositivo agente.
insert into public.role_permissions (role_id, permission_codigo)
select r.id, 'imprimir' from public.roles r
where r.empresa_id is null and r.codigo in ('agente_impresion', 'admin');

alter table public.dispositivos
  add column usuario_agente_id uuid unique references public.usuarios_perfil (user_id);

-- El rol técnico solo lo asigna agente_vincular_usuario: nadie se lo da a una persona.
drop policy user_local_roles_insert on public.user_local_roles;
create policy user_local_roles_insert on public.user_local_roles for insert to authenticated
  with check (
    local_id in (select app.locales_con_permiso('gestionar_usuarios'))
    and app.usuario_de_la_empresa_del_local(user_id, local_id)
    and exists (
      select 1
      from public.roles r
      join public.locales l on l.id = user_local_roles.local_id
      where r.id = user_local_roles.role_id
        and r.codigo <> 'agente_impresion'
        and (r.empresa_id is null or r.empresa_id = l.empresa_id)
    )
  );

-- Reintentos con espera creciente cuando la impresora no responde.
alter table public.print_jobs add column reintentar_desde timestamptz;

drop policy print_jobs_select on public.print_jobs;
create policy print_jobs_select on public.print_jobs for select to authenticated
  using (
    local_id in (select app.locales_con_permiso('configurar_local'))
    or local_id in (select app.locales_con_permiso('imprimir'))
  );

-- -----------------------------------------------------------------------------
-- Inicio de sesión del agente (Edge Function agente-login, solo service_role)
-- -----------------------------------------------------------------------------
create or replace function public.agente_preparar_sesion(p_device_token text, p_ip text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_disp public.dispositivos%rowtype;
  v_email text;
begin
  select * into v_disp from public.dispositivos where token_hash = app.hash_token(coalesce(p_device_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', 'dispositivo_no_autorizado');
  end if;
  if not v_disp.activo or v_disp.tipo <> 'agente_impresion' then
    perform app.registrar_evento('agente_login_rechazado', 'dispositivos', v_disp.id::text, v_disp.local_id,
      jsonb_build_object('motivo', 'dispositivo_no_autorizado'), null, v_disp.id, app.a_inet(p_ip));
    return jsonb_build_object('ok', false, 'error', 'dispositivo_no_autorizado');
  end if;

  update public.dispositivos set ultimo_ping = now() where id = v_disp.id;

  if v_disp.usuario_agente_id is null then
    return jsonb_build_object('ok', true, 'requiere_usuario', true, 'dispositivo_id', v_disp.id,
                              'local_id', v_disp.local_id, 'nombre', v_disp.nombre);
  end if;

  select u.email into v_email from auth.users u where u.id = v_disp.usuario_agente_id and u.deleted_at is null;
  if v_email is null then
    perform app.fallar(500, 'agente_sin_usuario', 'El usuario técnico del agente no existe');
  end if;
  return jsonb_build_object('ok', true, 'requiere_usuario', false, 'dispositivo_id', v_disp.id,
                            'local_id', v_disp.local_id, 'nombre', v_disp.nombre,
                            'user_id', v_disp.usuario_agente_id, 'email', v_email);
end;
$$;
revoke all on function public.agente_preparar_sesion(text, text) from public, anon, authenticated;
grant execute on function public.agente_preparar_sesion(text, text) to service_role;

create or replace function public.agente_vincular_usuario(p_dispositivo_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_disp public.dispositivos%rowtype;
begin
  select * into v_disp from public.dispositivos where id = p_dispositivo_id for update;
  if not found or not v_disp.activo or v_disp.tipo <> 'agente_impresion' then
    perform app.fallar(403, 'dispositivo_no_autorizado', 'Dispositivo no autorizado');
  end if;
  if v_disp.usuario_agente_id is not null then
    perform app.fallar(409, 'agente_ya_vinculado', 'El agente ya tiene usuario');
  end if;

  insert into public.usuarios_perfil (user_id, nombre_visible)
  values (p_user_id, left('Agente · ' || v_disp.nombre, 80));
  insert into public.user_local_roles (user_id, local_id, role_id)
  select p_user_id, v_disp.local_id, r.id from public.roles r where r.empresa_id is null and r.codigo = 'agente_impresion';
  update public.dispositivos set usuario_agente_id = p_user_id where id = p_dispositivo_id;

  perform app.registrar_evento('agente_vinculado', 'dispositivos', p_dispositivo_id::text, v_disp.local_id,
    jsonb_build_object('user_id', p_user_id), null, p_dispositivo_id);
  return jsonb_build_object('dispositivo_id', p_dispositivo_id, 'user_id', p_user_id);
end;
$$;
revoke all on function public.agente_vincular_usuario(uuid, uuid) from public, anon, authenticated;
grant execute on function public.agente_vincular_usuario(uuid, uuid) to service_role;

-- La sesión del agente dura 24 h; el agente vuelve a entrar antes de que venza.
create or replace function public.agente_registrar_sesion(p_dispositivo_id uuid, p_session_id uuid, p_ip text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_duracion constant interval := interval '24 hours';
  v_disp public.dispositivos%rowtype;
  v_expira timestamptz := now() + c_duracion;
begin
  select * into v_disp from public.dispositivos where id = p_dispositivo_id;
  if not found or not v_disp.activo or v_disp.tipo <> 'agente_impresion' or v_disp.usuario_agente_id is null then
    perform app.fallar(403, 'dispositivo_no_autorizado', 'Dispositivo no autorizado');
  end if;
  insert into app.sesiones_dispositivo (session_id, user_id, dispositivo_id, local_id, expira_at)
  values (p_session_id, v_disp.usuario_agente_id, v_disp.id, v_disp.local_id, v_expira);
  perform app.registrar_evento('agente_login_ok', 'dispositivos', v_disp.id::text, v_disp.local_id,
    jsonb_build_object('session_id', p_session_id, 'expira_at', v_expira), v_disp.usuario_agente_id, v_disp.id,
    app.a_inet(p_ip));
  return jsonb_build_object('dispositivo_id', v_disp.id, 'local_id', v_disp.local_id, 'expira_at', v_expira);
end;
$$;
revoke all on function public.agente_registrar_sesion(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.agente_registrar_sesion(uuid, uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- Operación del agente (sesión del agente)
-- -----------------------------------------------------------------------------
create or replace function app.agente_actual()
returns public.dispositivos
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_disp public.dispositivos%rowtype;
begin
  select d.* into v_disp
  from app.sesion_pin_vigente() s
  join public.dispositivos d on d.id = s.dispositivo_id
  where d.tipo = 'agente_impresion' and d.usuario_agente_id = auth.uid();
  if not found then
    perform app.fallar(403, 'no_es_agente', 'La sesión no es de un agente de impresión');
  end if;
  perform app.exigir_permiso(v_disp.local_id, 'imprimir');
  return v_disp;
end;
$$;
revoke all on function app.agente_actual() from public;

-- Latido (§14.1: el health check revisa el último ping del agente) y configuración de sus impresoras.
create or replace function public.agente_latido()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_disp public.dispositivos := app.agente_actual();
begin
  update public.dispositivos set ultimo_ping = now() where id = v_disp.id;
  return jsonb_build_object(
    'dispositivo_id', v_disp.id,
    'local_id', v_disp.local_id,
    'impresoras', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'nombre', i.nombre, 'tipo_conexion', i.tipo_conexion,
                                          'host', i.host, 'puerto', i.puerto, 'ancho_mm', i.ancho_mm, 'estado', i.estado)
                       order by i.nombre)
      from public.impresoras i
      where i.agente_id = v_disp.id
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.agente_latido() from public, anon;
grant execute on function public.agente_latido() to authenticated;

-- Toma trabajos pendientes de las impresoras de este agente. Un trabajo "tomado" que no se
-- reportó en 2 minutos (agente caído) vuelve a estar disponible.
create or replace function public.agente_tomar_trabajos(p_limite integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_disp public.dispositivos := app.agente_actual();
  v_trabajos jsonb;
begin
  with candidatos as (
    select j.id
    from public.print_jobs j
    join public.impresoras i on i.id = j.impresora_id
    where j.local_id = v_disp.local_id
      and i.agente_id = v_disp.id
      and (
        (j.estado = 'pendiente' and (j.reintentar_desde is null or j.reintentar_desde <= now()))
        or (j.estado = 'tomado' and j.updated_at < now() - interval '2 minutes')
      )
    order by j.created_at
    limit least(greatest(coalesce(p_limite, 10), 1), 50)
    for update of j skip locked
  ),
  tomados as (
    update public.print_jobs j
    set estado = 'tomado', agente_id = v_disp.id, intentos = j.intentos + 1
    from candidatos c
    where j.id = c.id
    returning j.id, j.tipo, j.payload, j.intentos, j.created_at, j.impresora_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'tipo', t.tipo, 'payload', t.payload, 'intentos', t.intentos, 'creado_at', t.created_at,
           'impresora', jsonb_build_object('id', i.id, 'nombre', i.nombre, 'tipo_conexion', i.tipo_conexion,
                                           'host', i.host, 'puerto', i.puerto, 'ancho_mm', i.ancho_mm)
         ) order by t.created_at), '[]'::jsonb)
  into v_trabajos
  from tomados t
  join public.impresoras i on i.id = t.impresora_id;

  update public.dispositivos set ultimo_ping = now() where id = v_disp.id;
  return v_trabajos;
end;
$$;
revoke all on function public.agente_tomar_trabajos(integer) from public, anon;
grant execute on function public.agente_tomar_trabajos(integer) to authenticated;

-- Resultado de un trabajo. Si falló, vuelve a la cola con espera creciente (5 s, 10 s, 20 s… hasta
-- 60 s); tras 20 intentos queda en "error" para que el admin lo redirija (CA §13).
create or replace function public.agente_reportar_trabajo(p_job_id uuid, p_ok boolean, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_intentos constant integer := 20;
  v_disp public.dispositivos := app.agente_actual();
  v_job public.print_jobs%rowtype;
  v_estado text;
begin
  select * into v_job from public.print_jobs where id = p_job_id for update;
  if not found or v_job.agente_id is distinct from v_disp.id or v_job.estado <> 'tomado' then
    perform app.fallar(409, 'trabajo_no_tomado', 'El trabajo no está tomado por este agente');
  end if;

  if p_ok then
    v_estado := 'impreso';
    update public.print_jobs
    set estado = 'impreso', impreso_at = now(), error = null, reintentar_desde = null
    where id = p_job_id;
  else
    v_estado := case when v_job.intentos >= c_max_intentos then 'error' else 'pendiente' end;
    update public.print_jobs
    set estado = v_estado,
        error = left(coalesce(p_error, 'Error de impresión'), 500),
        reintentar_desde = case when v_estado = 'pendiente'
          then now() + make_interval(secs => least(5 * power(2, greatest(v_job.intentos - 1, 0)), 60))
        end
    where id = p_job_id;
  end if;
  return jsonb_build_object('job_id', p_job_id, 'estado', v_estado);
end;
$$;
revoke all on function public.agente_reportar_trabajo(uuid, boolean, text) from public, anon;
grant execute on function public.agente_reportar_trabajo(uuid, boolean, text) to authenticated;

-- Estado de una impresora (§13: sin papel, apagada…); la caja muestra la alerta por Realtime.
create or replace function public.agente_reportar_impresora(p_impresora_id uuid, p_estado text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_disp public.dispositivos := app.agente_actual();
begin
  if p_estado not in ('ok', 'sin_papel', 'offline', 'error') then
    perform app.fallar(400, 'estado_invalido', 'Estado de impresora inválido');
  end if;
  update public.impresoras set estado = p_estado
  where id = p_impresora_id and agente_id = v_disp.id and estado <> p_estado;
  if not found and not exists (select 1 from public.impresoras where id = p_impresora_id and agente_id = v_disp.id) then
    perform app.fallar(404, 'impresora_no_encontrada', 'La impresora no pertenece a este agente');
  end if;
  return jsonb_build_object('impresora_id', p_impresora_id, 'estado', p_estado);
end;
$$;
revoke all on function public.agente_reportar_impresora(uuid, text) from public, anon;
grant execute on function public.agente_reportar_impresora(uuid, text) to authenticated;

-- El admin reintenta un trabajo o lo manda a otra impresora (CA §13).
create or replace function public.redirigir_trabajo(p_job_id uuid, p_impresora_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.print_jobs%rowtype;
  v_impresora uuid;
begin
  select * into v_job from public.print_jobs where id = p_job_id for update;
  if not found then
    perform app.fallar(404, 'trabajo_no_encontrado', 'El trabajo no existe');
  end if;
  perform app.exigir_permiso(v_job.local_id, 'configurar_local');
  v_impresora := coalesce(p_impresora_id, v_job.impresora_id);
  if v_impresora is null or not exists (select 1 from public.impresoras where id = v_impresora and local_id = v_job.local_id) then
    perform app.fallar(404, 'impresora_no_encontrada', 'La impresora no existe en este local');
  end if;

  update public.print_jobs
  set impresora_id = v_impresora, estado = 'pendiente', intentos = 0, error = null, reintentar_desde = null,
      agente_id = null, impreso_at = null
  where id = p_job_id;
  return jsonb_build_object('job_id', p_job_id, 'impresora_id', v_impresora, 'estado', 'pendiente');
end;
$$;
revoke all on function public.redirigir_trabajo(uuid, uuid) from public, anon;
grant execute on function public.redirigir_trabajo(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Alta de usuarios (CU4.1, Edge Function admin-usuarios)
-- -----------------------------------------------------------------------------
-- Paso 1, con la sesión de quien da el alta: tiene que administrar usuarios en el local y el rol
-- tiene que poder asignarse allí.
create or replace function public.validar_alta_usuario(p_local_id uuid, p_role_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol public.roles%rowtype;
begin
  perform app.exigir_permiso(p_local_id, 'gestionar_usuarios');
  select r.* into v_rol
  from public.roles r
  join public.locales l on l.id = p_local_id
  where r.id = p_role_id and r.activo and r.codigo <> 'agente_impresion'
    and (r.empresa_id is null or r.empresa_id = l.empresa_id);
  if not found then
    perform app.fallar(400, 'rol_invalido', 'El rol no existe o no se puede asignar en este local');
  end if;
  return jsonb_build_object('ok', true, 'solicitante', auth.uid(), 'rol', v_rol.codigo, 'requiere_mfa', v_rol.requiere_mfa);
end;
$$;
revoke all on function public.validar_alta_usuario(uuid, uuid) from public, anon;
grant execute on function public.validar_alta_usuario(uuid, uuid) to authenticated;

-- Paso 2, con service_role tras crear el usuario de Auth: perfil, rol y PIN en una transacción.
create or replace function public.crear_perfil_usuario(
  p_user_id uuid,
  p_local_id uuid,
  p_role_id uuid,
  p_nombre_visible text,
  p_codigo_empleado text default null,
  p_pin text default null,
  p_empleado_id uuid default null,
  p_creado_por uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol public.roles%rowtype;
  v_nombre text := nullif(trim(p_nombre_visible), '');
begin
  select r.* into v_rol
  from public.roles r
  join public.locales l on l.id = p_local_id
  where r.id = p_role_id and r.activo and r.codigo <> 'agente_impresion'
    and (r.empresa_id is null or r.empresa_id = l.empresa_id);
  if not found then
    perform app.fallar(400, 'rol_invalido', 'El rol no existe');
  end if;
  if v_nombre is null or length(v_nombre) > 80 then
    perform app.fallar(400, 'nombre_invalido', 'El nombre debe tener entre 1 y 80 caracteres');
  end if;
  if not v_rol.requiere_mfa and (p_codigo_empleado is null or p_pin is null) then
    perform app.fallar(400, 'codigo_y_pin_requeridos', 'El personal de salón y cocina entra con código y PIN');
  end if;
  if p_codigo_empleado is not null and p_codigo_empleado !~ '^[0-9A-Za-z]{3,12}$' then
    perform app.fallar(400, 'codigo_invalido', 'El código debe tener de 3 a 12 letras o números');
  end if;
  if p_pin is not null and not app.pin_es_valido(p_pin) then
    perform app.fallar(400, 'pin_invalido',
      'El PIN debe tener de 4 a 6 dígitos y no puede ser una secuencia ni repetir un solo dígito');
  end if;
  if p_empleado_id is not null
     and not exists (select 1 from public.empleados where id = p_empleado_id and local_id = p_local_id) then
    perform app.fallar(400, 'empleado_invalido', 'El empleado no pertenece a este local');
  end if;
  if exists (select 1 from public.usuarios_perfil where codigo_empleado = p_codigo_empleado) then
    perform app.fallar(409, 'codigo_duplicado', 'Ya existe un usuario con ese código de empleado');
  end if;

  insert into public.usuarios_perfil (user_id, empleado_id, codigo_empleado, nombre_visible, created_by)
  values (p_user_id, p_empleado_id, p_codigo_empleado, v_nombre, p_creado_por);
  insert into public.user_local_roles (user_id, local_id, role_id, created_by)
  values (p_user_id, p_local_id, p_role_id, p_creado_por);
  if p_pin is not null then
    insert into app.pin_credenciales (user_id, pin_hash, actualizado_por)
    values (p_user_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), p_creado_por);
  end if;

  perform app.registrar_evento('usuario_creado', 'usuarios_perfil', p_user_id::text, p_local_id,
    jsonb_build_object('rol', v_rol.codigo, 'codigo_empleado', p_codigo_empleado, 'con_pin', p_pin is not null),
    p_creado_por);
  return jsonb_build_object('user_id', p_user_id, 'rol', v_rol.codigo);
end;
$$;
revoke all on function public.crear_perfil_usuario(uuid, uuid, uuid, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.crear_perfil_usuario(uuid, uuid, uuid, text, text, text, uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Ventas por mozo (CU4.3). Hasta la fase 2 no hay órdenes pagadas; se muestra lo que está en curso.
-- "Turno" = fecha operativa hasta que el cliente defina sus turnos (DECISIONS P11).
-- -----------------------------------------------------------------------------
create view public.ventas_por_mozo
with (security_invoker = true)
as
select
  o.local_id,
  o.fecha_operativa,
  o.mozo_id,
  up.nombre_visible as mozo,
  count(*) filter (where o.estado <> 'anulada') as ordenes,
  count(*) filter (where o.estado = 'pagada') as ordenes_pagadas,
  coalesce(sum(o.total) filter (where o.estado = 'pagada'), 0)::numeric(12, 2) as total_pagado,
  coalesce(sum(o.total) filter (where o.estado in ('abierta', 'precuenta')), 0)::numeric(12, 2) as total_en_curso,
  coalesce(sum(o.comensales) filter (where o.estado <> 'anulada'), 0) as comensales
from public.ordenes o
left join public.usuarios_perfil up on up.user_id = o.mozo_id
group by o.local_id, o.fecha_operativa, o.mozo_id, up.nombre_visible;

grant select on public.ventas_por_mozo to authenticated;
