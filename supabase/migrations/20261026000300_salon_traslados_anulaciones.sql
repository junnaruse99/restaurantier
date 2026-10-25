-- =============================================================================
-- Warike POS — Fase 1 · 0300 Cambio de mesa (M8) y anulaciones (M9) — flujos B y C de §8
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Avisos impresos para cocina, parrilla y bar
-- -----------------------------------------------------------------------------
-- Aviso de traslado ("Mesa 05 → Mesa 22") en cada estación con ítems pendientes (CA M8).
create or replace function app.avisar_traslado(p_orden_id uuid, p_item_ids uuid[], p_origen text, p_destino text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orden public.ordenes%rowtype;
  v_estacion record;
  v_avisos integer := 0;
begin
  select * into v_orden from public.ordenes where id = p_orden_id;
  for v_estacion in
    select i.estacion_produccion_id as id,
           jsonb_agg(jsonb_build_object('cantidad', i.cantidad, 'nombre', i.nombre_snapshot) order by i.created_at) as items
    from public.orden_items i
    where i.id = any (p_item_ids)
      and i.estado in ('enviado', 'en_preparacion')
      and i.estacion_produccion_id is not null
    group by i.estacion_produccion_id
  loop
    if app.encolar_impresion(v_orden.local_id, v_estacion.id, 'traslado', jsonb_build_object(
      'tipo', 'traslado',
      'mesa_origen', p_origen,
      'mesa_destino', p_destino,
      'orden_numero', v_orden.numero_dia,
      'mozo', (select nombre_visible from public.usuarios_perfil where user_id = v_orden.mozo_id),
      'fecha_hora', to_char(now() at time zone 'America/Lima', 'DD/MM/YYYY HH24:MI'),
      'items', v_estacion.items
    )) is not null then
      v_avisos := v_avisos + 1;
    end if;
  end loop;
  return v_avisos;
end;
$$;
revoke all on function app.avisar_traslado(uuid, uuid[], text, text) from public;

-- "ANULACIÓN" en la estación de cada ítem que ya estaba en cocina (CU9.2).
create or replace function app.avisar_anulacion(p_anulacion_id uuid, p_item_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_an public.anulaciones%rowtype;
  v_orden public.ordenes%rowtype;
  v_estacion record;
  v_avisos integer := 0;
begin
  select * into v_an from public.anulaciones where id = p_anulacion_id;
  select * into v_orden from public.ordenes where id = v_an.orden_id;
  for v_estacion in
    select i.estacion_produccion_id as id,
           jsonb_agg(jsonb_build_object(
             'cantidad', i.cantidad,
             'nombre', i.nombre_snapshot,
             'modificadores', (select coalesce(jsonb_agg(m ->> 'nombre'), '[]'::jsonb) from jsonb_array_elements(i.modificadores) m),
             'comanda_numero', c.numero
           ) order by i.created_at) as items
    from public.orden_items i
    left join public.comandas c on c.id = i.comanda_id
    where i.id = any (p_item_ids)
      and i.estado in ('enviado', 'en_preparacion', 'listo')
      and i.estacion_produccion_id is not null
    group by i.estacion_produccion_id
  loop
    if app.encolar_impresion(v_orden.local_id, v_estacion.id, 'anulacion', jsonb_build_object(
      'tipo', 'anulacion',
      'mesa', app.etiqueta_mesa(v_orden.mesa_principal_id),
      'orden_numero', v_orden.numero_dia,
      'mozo', (select nombre_visible from public.usuarios_perfil where user_id = v_orden.mozo_id),
      'motivo', v_an.motivo_codigo,
      'motivo_texto', v_an.motivo_texto,
      'autorizado_por', (select nombre_visible from public.usuarios_perfil where user_id = v_an.autorizada_por),
      'fecha_hora', to_char(now() at time zone 'America/Lima', 'DD/MM/YYYY HH24:MI'),
      'items', v_estacion.items
    )) is not null then
      v_avisos := v_avisos + 1;
    end if;
  end loop;
  return v_avisos;
end;
$$;
revoke all on function app.avisar_anulacion(uuid, uuid[]) from public;

-- -----------------------------------------------------------------------------
-- Cambio de mesa (CU8.1–8.3, flujo B)
-- -----------------------------------------------------------------------------
-- Abre una orden en una mesa libre como parte de un traslado (separar / mover ítems).
create or replace function app.abrir_orden_en_mesa(p_mesa public.mesas, p_mozo_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fecha date := app.fecha_operativa(p_mesa.local_id);
  v_id uuid;
begin
  insert into public.ordenes (local_id, numero_dia, fecha_operativa, tipo, mesa_principal_id, mozo_id, comensales)
  values (p_mesa.local_id, app.siguiente_numero_orden(p_mesa.local_id, v_fecha), v_fecha, 'salon', p_mesa.id, p_mozo_id, 1)
  returning id into v_id;
  insert into public.mesa_uniones (local_id, orden_id, mesa_id, es_principal)
  values (p_mesa.local_id, v_id, p_mesa.id, true);
  update public.mesas set estado = 'ocupada' where id = p_mesa.id;
  return v_id;
end;
$$;
revoke all on function app.abrir_orden_en_mesa(public.mesas, uuid) from public;

--   mover       → toda la orden a una mesa libre; las mesas que deja quedan "por limpiar".
--   unir        → suma una mesa libre a la orden; la principal conserva el número.
--   separar     → quita de la orden una mesa unida; con p_item_ids, esos ítems pasan a una
--                 orden nueva en esa mesa; sin ítems, la mesa queda "por limpiar".
--   mover_items → lleva ítems a otra mesa: a su orden en curso o, si está libre, a una orden nueva.
-- El mozo solo traslada sus propias órdenes (permiso trasladar_mesa_propia).
create or replace function public.trasladar_orden(
  p_orden_id uuid,
  p_tipo text,
  p_mesa_destino_id uuid,
  p_item_ids uuid[] default null,
  p_client_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previo jsonb := app.inicio_mutacion(p_client_mutation_id);
  v_orden public.ordenes%rowtype;
  v_destino public.mesas%rowtype;
  v_origen_id uuid;
  v_orden_destino public.ordenes%rowtype;
  v_orden_destino_id uuid;
  v_items uuid[];
  v_avisos integer := 0;
  v_resultado jsonb;
begin
  if v_previo is not null then
    return v_previo;
  end if;
  if p_tipo not in ('mover', 'unir', 'separar', 'mover_items') then
    perform app.fallar(400, 'tipo_invalido', 'Tipo de traslado inválido');
  end if;

  select * into v_orden from public.ordenes where id = p_orden_id for update;
  if not found then
    perform app.fallar(404, 'orden_no_encontrada', 'La orden no existe');
  end if;
  if not app.tiene_permiso(v_orden.local_id, 'trasladar_mesa')
     and not (app.tiene_permiso(v_orden.local_id, 'trasladar_mesa_propia') and v_orden.mozo_id = auth.uid()) then
    perform app.fallar(403, 'sin_permiso', 'Solo puede trasladar sus propias mesas');
  end if;
  if v_orden.estado not in ('abierta', 'precuenta') then
    perform app.fallar(409, 'orden_cerrada', 'La orden ya está cerrada');
  end if;

  select * into v_destino from public.mesas where id = p_mesa_destino_id and local_id = v_orden.local_id for update;
  if not found then
    perform app.fallar(404, 'mesa_no_encontrada', 'La mesa de destino no existe en este local');
  end if;
  if not v_destino.activa or v_destino.tipo like 'virtual%' then
    perform app.fallar(409, 'mesa_no_disponible', 'La mesa de destino no está disponible');
  end if;
  v_origen_id := v_orden.mesa_principal_id;

  if p_tipo = 'mover' then
    if v_destino.estado <> 'libre' then
      perform app.fallar(409, 'mesa_ocupada', 'La mesa de destino no está libre');
    end if;
    update public.mesas m set estado = 'por_limpiar'
    from public.mesa_uniones u
    where u.orden_id = v_orden.id and u.liberada_at is null and m.id = u.mesa_id;
    update public.mesa_uniones set liberada_at = now() where orden_id = v_orden.id and liberada_at is null;
    insert into public.mesa_uniones (local_id, orden_id, mesa_id, es_principal)
    values (v_orden.local_id, v_orden.id, v_destino.id, true);
    update public.mesas set estado = case when v_orden.estado = 'precuenta' then 'precuenta' else 'ocupada' end
    where id = v_destino.id;
    update public.ordenes set mesa_principal_id = v_destino.id where id = v_orden.id;

    select array_agg(id) into v_items from public.orden_items where orden_id = v_orden.id;
    v_avisos := app.avisar_traslado(v_orden.id, v_items, app.etiqueta_mesa(v_origen_id), app.etiqueta_mesa(v_destino.id));
    v_orden_destino_id := v_orden.id;

  elsif p_tipo = 'unir' then
    if v_destino.estado <> 'libre' then
      perform app.fallar(409, 'mesa_ocupada', 'La mesa a unir no está libre');
    end if;
    insert into public.mesa_uniones (local_id, orden_id, mesa_id, es_principal)
    values (v_orden.local_id, v_orden.id, v_destino.id, false);
    update public.mesas set estado = case when v_orden.estado = 'precuenta' then 'precuenta' else 'ocupada' end
    where id = v_destino.id;
    v_orden_destino_id := v_orden.id;

  elsif p_tipo = 'separar' then
    if not exists (
      select 1 from public.mesa_uniones
      where orden_id = v_orden.id and mesa_id = v_destino.id and liberada_at is null and not es_principal
    ) then
      perform app.fallar(409, 'mesa_no_unida', 'La mesa no está unida a esta orden');
    end if;
    update public.mesa_uniones set liberada_at = now()
    where orden_id = v_orden.id and mesa_id = v_destino.id and liberada_at is null;

    if p_item_ids is not null and cardinality(p_item_ids) > 0 then
      select array_agg(id) into v_items from public.orden_items
      where orden_id = v_orden.id and id = any (p_item_ids) and estado <> 'anulado';
      if v_items is null or cardinality(v_items) <> cardinality(p_item_ids) then
        perform app.fallar(400, 'items_invalidos', 'Los ítems deben ser de esta orden y no estar anulados');
      end if;
      update public.mesas set estado = 'libre' where id = v_destino.id;
      select * into v_destino from public.mesas where id = v_destino.id;
      v_orden_destino_id := app.abrir_orden_en_mesa(v_destino, v_orden.mozo_id);
      update public.orden_items set orden_id = v_orden_destino_id where id = any (v_items);
      v_avisos := app.avisar_traslado(v_orden.id, v_items, app.etiqueta_mesa(v_origen_id), app.etiqueta_mesa(v_destino.id));
    else
      update public.mesas set estado = 'por_limpiar' where id = v_destino.id;
      v_orden_destino_id := v_orden.id;
    end if;

  else -- mover_items
    if p_item_ids is null or cardinality(p_item_ids) = 0 then
      perform app.fallar(400, 'sin_items', 'Indique los ítems a mover');
    end if;
    select array_agg(id) into v_items from public.orden_items
    where orden_id = v_orden.id and id = any (p_item_ids) and estado <> 'anulado';
    if v_items is null or cardinality(v_items) <> cardinality(p_item_ids) then
      perform app.fallar(400, 'items_invalidos', 'Los ítems deben ser de esta orden y no estar anulados');
    end if;

    select o.* into v_orden_destino
    from public.mesa_uniones u
    join public.ordenes o on o.id = u.orden_id
    where u.mesa_id = v_destino.id and u.liberada_at is null and o.estado in ('abierta', 'precuenta')
    for update of o;

    if v_orden_destino.id is not null then
      if v_orden_destino.id = v_orden.id then
        perform app.fallar(409, 'misma_orden', 'Los ítems ya están en esa mesa');
      end if;
      if not app.tiene_permiso(v_orden.local_id, 'trasladar_mesa') and v_orden_destino.mozo_id is distinct from auth.uid() then
        perform app.fallar(403, 'sin_permiso', 'Solo puede mover ítems entre sus propias mesas');
      end if;
      v_orden_destino_id := v_orden_destino.id;
      perform app.reabrir_si_precuenta(v_orden_destino);
    elsif v_destino.estado = 'libre' then
      v_orden_destino_id := app.abrir_orden_en_mesa(v_destino, v_orden.mozo_id);
    else
      perform app.fallar(409, 'mesa_no_disponible', 'La mesa de destino no está libre ni tiene una orden en curso');
    end if;

    update public.orden_items set orden_id = v_orden_destino_id where id = any (v_items);
    v_avisos := app.avisar_traslado(v_orden.id, v_items, app.etiqueta_mesa(v_origen_id), app.etiqueta_mesa(v_destino.id));
  end if;

  insert into public.traslados_mesa (local_id, orden_id, mesa_origen_id, mesa_destino_id, tipo, items, realizado_por)
  values (v_orden.local_id, v_orden.id, v_origen_id, v_destino.id, p_tipo,
          case when p_tipo in ('separar', 'mover_items') then coalesce(to_jsonb(v_items), '[]'::jsonb) end,
          auth.uid());

  perform app.recalcular_orden(v_orden.id);
  if v_orden_destino_id is distinct from v_orden.id then
    perform app.recalcular_orden(v_orden_destino_id);
  end if;

  v_resultado := jsonb_build_object('orden_id', v_orden.id, 'orden_destino_id', v_orden_destino_id, 'avisos', v_avisos);
  return app.registrar_mutacion(p_client_mutation_id, v_orden.local_id, 'trasladar_orden',
    jsonb_build_object('orden_id', p_orden_id, 'tipo', p_tipo, 'mesa_destino_id', p_mesa_destino_id,
                       'item_ids', to_jsonb(p_item_ids)),
    v_resultado);
end;
$$;
revoke all on function public.trasladar_orden(uuid, text, uuid, uuid[], uuid) from public, anon;
grant execute on function public.trasladar_orden(uuid, text, uuid, uuid[], uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Anulaciones (CU9.1–9.3, flujo C)
-- -----------------------------------------------------------------------------
-- Ejecuta una anulación aprobada: marca los ítems, imprime los avisos y, si es de orden, la
-- cierra y libera sus mesas. Las solicitudes pendientes sobre lo mismo quedan resueltas.
create or replace function app.aplicar_anulacion(p_anulacion_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_an public.anulaciones%rowtype;
  v_orden public.ordenes%rowtype;
  v_items uuid[];
  v_hubo_envios boolean;
begin
  select * into v_an from public.anulaciones where id = p_anulacion_id;
  select * into v_orden from public.ordenes where id = v_an.orden_id for update;
  if v_orden.estado not in ('abierta', 'precuenta') then
    perform app.fallar(409, 'orden_cerrada', 'La orden ya está cerrada');
  end if;

  if v_an.nivel = 'item' then
    perform 1 from public.orden_items where id = v_an.orden_item_id for update;
    if exists (select 1 from public.orden_items where id = v_an.orden_item_id and (estado = 'anulado' or orden_id <> v_orden.id)) then
      perform app.fallar(409, 'item_ya_anulado', 'El ítem ya fue anulado o cambió de orden');
    end if;
    v_items := array[v_an.orden_item_id];
  else
    if exists (select 1 from public.pagos where orden_id = v_orden.id and estado = 'registrado') then
      perform app.fallar(409, 'orden_con_pagos', 'La orden tiene pagos: se anula con nota de crédito (flujo F)');
    end if;
    select array_agg(id) into v_items from public.orden_items where orden_id = v_orden.id and estado <> 'anulado';
  end if;

  perform app.avisar_anulacion(v_an.id, coalesce(v_items, '{}'));
  update public.orden_items
  set estado = 'anulado', anulado_at = now(), anulacion_id = v_an.id
  where id = any (coalesce(v_items, '{}'));

  update public.anulaciones
  set estado = 'rechazada', resuelta_at = now(), autorizada_por = v_an.autorizada_por,
      motivo_texto = coalesce(motivo_texto || ' · ', '') || 'resuelta por otra anulación'
  where estado = 'pendiente' and id <> v_an.id
    and (orden_item_id = any (coalesce(v_items, '{}')) or (v_an.nivel = 'orden' and orden_id = v_orden.id));

  if v_an.nivel = 'orden' then
    v_hubo_envios := exists (select 1 from public.orden_items where orden_id = v_orden.id and enviado_at is not null);
    update public.mesas m set estado = case when v_hubo_envios then 'por_limpiar' else 'libre' end
    from public.mesa_uniones u
    where u.orden_id = v_orden.id and u.liberada_at is null and m.id = u.mesa_id;
    update public.mesa_uniones set liberada_at = now() where orden_id = v_orden.id and liberada_at is null;
    update public.ordenes set estado = 'anulada', cerrada_at = now() where id = v_orden.id;
  end if;

  perform app.recalcular_orden(v_orden.id);
end;
$$;
revoke all on function app.aplicar_anulacion(uuid) from public;

create or replace function app.validar_motivo(p_motivo_codigo text, p_motivo_texto text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_motivo_codigo is null
     or p_motivo_codigo not in ('error_digitacion', 'cliente_desiste', 'demora', 'producto_agotado', 'calidad', 'otro') then
    perform app.fallar(400, 'motivo_requerido', 'Indique el motivo de la anulación');
  end if;
  if p_motivo_codigo = 'otro' and nullif(trim(p_motivo_texto), '') is null then
    perform app.fallar(400, 'motivo_texto_requerido', 'Describa el motivo de la anulación');
  end if;
end;
$$;
revoke all on function app.validar_motivo(text, text) from public;

-- Anular un ítem. En borrador: sin autorización (CU9.1). Enviado o posterior: motivo y
-- autorización de un supervisor, por su propia sesión o con su PIN en el dispositivo (CU9.2).
create or replace function public.anular_item(
  p_item_id uuid,
  p_motivo_codigo text default null,
  p_motivo_texto text default null,
  p_merma boolean default false,
  p_autorizacion_id uuid default null,
  p_client_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previo jsonb := app.inicio_mutacion(p_client_mutation_id);
  v_item public.orden_items%rowtype;
  v_orden public.ordenes;
  v_autorizador uuid;
  v_anulacion_id uuid;
begin
  if v_previo is not null then
    return v_previo;
  end if;

  select * into v_item from public.orden_items where id = p_item_id;
  if not found then
    perform app.fallar(404, 'item_no_encontrado', 'El ítem no existe');
  end if;

  if v_item.estado = 'borrador' then
    v_orden := app.orden_editable(v_item.orden_id, 'anular_item_borrador');
    update public.orden_items set estado = 'anulado', anulado_at = now()
    where id = p_item_id and estado = 'borrador';
    if not found then
      perform app.fallar(409, 'item_ya_enviado', 'El ítem cambió de estado; vuelva a intentarlo');
    end if;
    perform app.recalcular_orden(v_orden.id);
  else
    if v_item.estado = 'anulado' then
      perform app.fallar(409, 'item_ya_anulado', 'El ítem ya está anulado');
    end if;
    v_orden := app.orden_editable(v_item.orden_id, 'solicitar_anulacion');
    perform app.validar_motivo(p_motivo_codigo, p_motivo_texto);
    v_autorizador := app.autorizador(v_orden.local_id, 'autorizar_anulacion', p_autorizacion_id);

    insert into public.anulaciones (local_id, nivel, orden_id, orden_item_id, motivo_codigo, motivo_texto, merma,
                                    solicitada_por, autorizada_por, estado, resuelta_at)
    values (v_orden.local_id, 'item', v_orden.id, p_item_id, p_motivo_codigo, nullif(trim(p_motivo_texto), ''),
            coalesce(p_merma, false), auth.uid(), v_autorizador, 'aprobada', now())
    returning id into v_anulacion_id;
    perform app.aplicar_anulacion(v_anulacion_id);
  end if;

  return app.registrar_mutacion(p_client_mutation_id, v_orden.local_id, 'anular_item',
    jsonb_build_object('item_id', p_item_id, 'motivo', p_motivo_codigo),
    jsonb_build_object('item_id', p_item_id, 'anulacion_id', v_anulacion_id));
end;
$$;
revoke all on function public.anular_item(uuid, text, text, boolean, uuid, uuid) from public, anon;
grant execute on function public.anular_item(uuid, text, text, boolean, uuid, uuid) to authenticated;

-- Anular una orden sin pagos (CU9.3). Con ítems ya enviados exige motivo y autorización de un
-- supervisor; una orden que nunca llegó a cocina la cancela quien toma pedidos (DECISIONS D-026).
create or replace function public.anular_orden(
  p_orden_id uuid,
  p_motivo_codigo text default null,
  p_motivo_texto text default null,
  p_merma boolean default false,
  p_autorizacion_id uuid default null,
  p_client_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previo jsonb := app.inicio_mutacion(p_client_mutation_id);
  v_orden public.ordenes;
  v_hubo_envios boolean;
  v_autorizador uuid;
  v_motivo text := p_motivo_codigo;
  v_anulacion_id uuid;
begin
  if v_previo is not null then
    return v_previo;
  end if;

  v_hubo_envios := exists (select 1 from public.orden_items where orden_id = p_orden_id and enviado_at is not null);
  if v_hubo_envios then
    v_orden := app.orden_editable(p_orden_id, 'solicitar_anulacion');
    perform app.validar_motivo(p_motivo_codigo, p_motivo_texto);
    v_autorizador := app.autorizador(v_orden.local_id, 'autorizar_anulacion', p_autorizacion_id);
  else
    v_orden := app.orden_editable(p_orden_id, 'anular_item_borrador');
    -- Con la orden ya bloqueada, se confirma que nada llegó a cocina mientras tanto.
    if exists (select 1 from public.orden_items where orden_id = p_orden_id and enviado_at is not null) then
      perform app.fallar(409, 'orden_con_envios', 'La orden ya tiene ítems en cocina; vuelva a intentarlo');
    end if;
    v_motivo := coalesce(p_motivo_codigo, 'error_digitacion');
    perform app.validar_motivo(v_motivo, p_motivo_texto);
    v_autorizador := auth.uid();
  end if;

  insert into public.anulaciones (local_id, nivel, orden_id, motivo_codigo, motivo_texto, merma,
                                  solicitada_por, autorizada_por, estado, resuelta_at)
  values (v_orden.local_id, 'orden', v_orden.id, v_motivo, nullif(trim(p_motivo_texto), ''), coalesce(p_merma, false),
          auth.uid(), v_autorizador, 'aprobada', now())
  returning id into v_anulacion_id;
  perform app.aplicar_anulacion(v_anulacion_id);

  return app.registrar_mutacion(p_client_mutation_id, v_orden.local_id, 'anular_orden',
    jsonb_build_object('orden_id', p_orden_id, 'motivo', v_motivo),
    jsonb_build_object('orden_id', p_orden_id, 'anulacion_id', v_anulacion_id));
end;
$$;
revoke all on function public.anular_orden(uuid, text, text, boolean, uuid, uuid) from public, anon;
grant execute on function public.anular_orden(uuid, text, text, boolean, uuid, uuid) to authenticated;

-- Solicitud remota (§4.1): queda pendiente y el admin la aprueba desde su celular (Realtime).
create or replace function public.solicitar_anulacion(
  p_item_id uuid default null,
  p_orden_id uuid default null,
  p_motivo_codigo text default null,
  p_motivo_texto text default null,
  p_merma boolean default false,
  p_client_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previo jsonb := app.inicio_mutacion(p_client_mutation_id);
  v_item public.orden_items%rowtype;
  v_orden public.ordenes;
  v_id uuid;
begin
  if v_previo is not null then
    return v_previo;
  end if;
  if (p_item_id is null) = (p_orden_id is null) then
    perform app.fallar(400, 'objetivo_invalido', 'Indique un ítem o una orden');
  end if;
  perform app.validar_motivo(p_motivo_codigo, p_motivo_texto);

  if p_item_id is not null then
    select * into v_item from public.orden_items where id = p_item_id;
    if not found then
      perform app.fallar(404, 'item_no_encontrado', 'El ítem no existe');
    end if;
    v_orden := app.orden_editable(v_item.orden_id, 'solicitar_anulacion');
    if v_item.estado in ('borrador', 'anulado') then
      perform app.fallar(409, 'no_requiere_solicitud', 'Ese ítem no requiere autorización o ya está anulado');
    end if;
    if exists (select 1 from public.anulaciones where orden_item_id = p_item_id and estado = 'pendiente') then
      perform app.fallar(409, 'solicitud_pendiente', 'Ya hay una solicitud pendiente para este ítem');
    end if;
  else
    v_orden := app.orden_editable(p_orden_id, 'solicitar_anulacion');
    if exists (select 1 from public.pagos where orden_id = p_orden_id and estado = 'registrado') then
      perform app.fallar(409, 'orden_con_pagos', 'La orden tiene pagos: se anula con nota de crédito (flujo F)');
    end if;
    if exists (select 1 from public.anulaciones where orden_id = p_orden_id and nivel = 'orden' and estado = 'pendiente') then
      perform app.fallar(409, 'solicitud_pendiente', 'Ya hay una solicitud pendiente para esta orden');
    end if;
  end if;

  insert into public.anulaciones (local_id, nivel, orden_id, orden_item_id, motivo_codigo, motivo_texto, merma, solicitada_por)
  values (v_orden.local_id, case when p_item_id is null then 'orden' else 'item' end, v_orden.id, p_item_id,
          p_motivo_codigo, nullif(trim(p_motivo_texto), ''), coalesce(p_merma, false), auth.uid())
  returning id into v_id;

  return app.registrar_mutacion(p_client_mutation_id, v_orden.local_id, 'solicitar_anulacion',
    jsonb_build_object('item_id', p_item_id, 'orden_id', p_orden_id),
    jsonb_build_object('anulacion_id', v_id, 'estado', 'pendiente'));
end;
$$;
revoke all on function public.solicitar_anulacion(uuid, uuid, text, text, boolean, uuid) from public, anon;
grant execute on function public.solicitar_anulacion(uuid, uuid, text, text, boolean, uuid) to authenticated;

create or replace function public.resolver_anulacion(p_anulacion_id uuid, p_aprobar boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_an public.anulaciones%rowtype;
begin
  select * into v_an from public.anulaciones where id = p_anulacion_id for update;
  if not found then
    perform app.fallar(404, 'solicitud_no_encontrada', 'La solicitud no existe');
  end if;
  perform app.exigir_permiso(v_an.local_id, 'autorizar_anulacion');
  if v_an.estado <> 'pendiente' then
    perform app.fallar(409, 'solicitud_resuelta', 'La solicitud ya fue resuelta');
  end if;

  update public.anulaciones
  set estado = case when p_aprobar then 'aprobada' else 'rechazada' end,
      autorizada_por = auth.uid(),
      resuelta_at = now()
  where id = p_anulacion_id;

  if p_aprobar then
    perform app.aplicar_anulacion(p_anulacion_id);
  end if;
  return jsonb_build_object('anulacion_id', p_anulacion_id, 'estado', case when p_aprobar then 'aprobada' else 'rechazada' end);
end;
$$;
revoke all on function public.resolver_anulacion(uuid, boolean) from public, anon;
grant execute on function public.resolver_anulacion(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Reporte de anulaciones por mozo, motivo y autorizador (CA M9). Respeta la RLS de quien consulta.
-- -----------------------------------------------------------------------------
create view public.reporte_anulaciones
with (security_invoker = true)
as
select
  a.id as anulacion_id,
  a.local_id,
  o.fecha_operativa,
  a.created_at,
  a.resuelta_at,
  a.nivel,
  a.estado,
  o.numero_dia as orden_numero,
  coalesce(me.nombre_visible, 'Mesa ' || me.codigo) as mesa,
  i.nombre_snapshot as producto,
  i.cantidad,
  case when a.nivel = 'item' then i.total_linea else (
    select coalesce(sum(x.total_linea), 0) from public.orden_items x where x.anulacion_id = a.id
  ) end as monto,
  a.motivo_codigo,
  a.motivo_texto,
  a.merma,
  mozo.nombre_visible as mozo,
  sol.nombre_visible as solicitada_por,
  aut.nombre_visible as autorizada_por
from public.anulaciones a
join public.ordenes o on o.id = a.orden_id
left join public.mesas me on me.id = o.mesa_principal_id
left join public.orden_items i on i.id = a.orden_item_id
left join public.usuarios_perfil mozo on mozo.user_id = o.mozo_id
left join public.usuarios_perfil sol on sol.user_id = a.solicitada_por
left join public.usuarios_perfil aut on aut.user_id = a.autorizada_por;

grant select on public.reporte_anulaciones to authenticated;
