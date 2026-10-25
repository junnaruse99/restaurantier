-- =============================================================================
-- Warike POS — Fase 1 · 0200 Toma de pedidos, comandas y KDS (M6, M7, flujo A de §8)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Abrir mesa (CU6.1, flujo A.1): crea la orden y ocupa la mesa en una sola transacción.
-- -----------------------------------------------------------------------------
create or replace function public.abrir_orden(
  p_mesa_id uuid,
  p_comensales integer default 1,
  p_client_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previo jsonb := app.inicio_mutacion(p_client_mutation_id);
  v_mesa public.mesas%rowtype;
  v_fecha date;
  v_numero integer;
  v_orden_id uuid;
begin
  if v_previo is not null then
    return v_previo;
  end if;

  select * into v_mesa from public.mesas where id = p_mesa_id for update;
  if not found then
    perform app.fallar(404, 'mesa_no_encontrada', 'La mesa no existe');
  end if;
  perform app.exigir_permiso(v_mesa.local_id, 'tomar_pedido');

  if not v_mesa.activa then
    perform app.fallar(409, 'mesa_inactiva', 'La mesa está desactivada');
  end if;
  -- Delivery, para llevar, personal y auditor llegan con M10, M11 y M17 (DECISIONS D-024).
  if v_mesa.tipo like 'virtual%' then
    perform app.fallar(409, 'mesa_virtual_no_disponible', 'Las mesas virtuales se habilitan en una fase posterior');
  end if;
  if v_mesa.estado <> 'libre' then
    perform app.fallar(409, 'mesa_ocupada', 'La mesa no está libre');
  end if;
  if p_comensales is null or p_comensales < 1 or p_comensales > 99 then
    perform app.fallar(400, 'comensales_invalidos', 'Indique entre 1 y 99 comensales');
  end if;

  v_fecha := app.fecha_operativa(v_mesa.local_id);
  v_numero := app.siguiente_numero_orden(v_mesa.local_id, v_fecha);

  insert into public.ordenes (local_id, numero_dia, fecha_operativa, tipo, mesa_principal_id, mozo_id, comensales)
  values (v_mesa.local_id, v_numero, v_fecha, 'salon', v_mesa.id, auth.uid(), p_comensales)
  returning id into v_orden_id;

  insert into public.mesa_uniones (local_id, orden_id, mesa_id, es_principal)
  values (v_mesa.local_id, v_orden_id, v_mesa.id, true);

  update public.mesas set estado = 'ocupada' where id = v_mesa.id;

  return app.registrar_mutacion(p_client_mutation_id, v_mesa.local_id, 'abrir_orden',
    jsonb_build_object('mesa_id', p_mesa_id, 'comensales', p_comensales),
    jsonb_build_object('orden_id', v_orden_id, 'numero_dia', v_numero, 'fecha_operativa', v_fecha));
end;
$$;
revoke all on function public.abrir_orden(uuid, integer, uuid) from public, anon;
grant execute on function public.abrir_orden(uuid, integer, uuid) to authenticated;

-- Bloquea la orden y verifica que admite cambios de ítems. Si estaba en pre-cuenta, vuelve a
-- "abierta" (CU12.1: si se agregan ítems hay que volver a sacar la pre-cuenta).
create or replace function app.orden_editable(p_orden_id uuid, p_permiso text)
returns public.ordenes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orden public.ordenes%rowtype;
begin
  select * into v_orden from public.ordenes where id = p_orden_id for update;
  if not found then
    perform app.fallar(404, 'orden_no_encontrada', 'La orden no existe');
  end if;
  perform app.exigir_permiso(v_orden.local_id, p_permiso);
  if v_orden.estado not in ('abierta', 'precuenta') then
    perform app.fallar(409, 'orden_cerrada', 'La orden ya está cerrada');
  end if;
  return v_orden;
end;
$$;
revoke all on function app.orden_editable(uuid, text) from public;

create or replace function app.reabrir_si_precuenta(p_orden public.ordenes)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_orden.estado = 'precuenta' then
    update public.ordenes set estado = 'abierta' where id = p_orden.id;
    update public.mesas m set estado = 'ocupada'
    from public.mesa_uniones u
    where u.orden_id = p_orden.id and u.liberada_at is null and m.id = u.mesa_id and m.estado = 'precuenta';
  end if;
end;
$$;
revoke all on function app.reabrir_si_precuenta(public.ordenes) from public;

-- -----------------------------------------------------------------------------
-- Valida los modificadores elegidos para un producto y devuelve su snapshot y el recargo.
--   Entrada: [{"grupo": "Término", "nombre": "Jugoso"}, …]
--   - Los grupos del producto (producto_modificadores) fijan mínimos, máximos y obligatoriedad.
--   - Las opciones salen de `modificadores` del local; en el menú del día, "Entrada" y "Segundo"
--     salen del menú publicado para la fecha operativa (CU5.2).
-- -----------------------------------------------------------------------------
create or replace function app.validar_modificadores(p_producto public.productos, p_elegidos jsonb, p_fecha date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_elegidos jsonb := coalesce(p_elegidos, '[]'::jsonb);
  v_grupo record;
  v_mod record;
  v_snapshot jsonb := '[]'::jsonb;
  v_recargo numeric := 0;
  v_cantidad integer;
  v_menu public.menu_diario%rowtype;
  v_extra numeric;
begin
  if jsonb_typeof(v_elegidos) <> 'array' then
    perform app.fallar(400, 'modificadores_invalidos', 'Los modificadores deben ser una lista');
  end if;

  -- Cada elegido pertenece a un grupo del producto.
  for v_mod in
    select e ->> 'grupo' as grupo, e ->> 'nombre' as nombre from jsonb_array_elements(v_elegidos) e
  loop
    if not exists (select 1 from public.producto_modificadores pm where pm.producto_id = p_producto.id and pm.grupo = v_mod.grupo) then
      perform app.fallar(400, 'modificador_invalido',
        format('"%s" no admite el grupo "%s"', p_producto.nombre, v_mod.grupo));
    end if;
  end loop;

  if p_producto.es_menu_del_dia then
    select * into v_menu from public.menu_diario
    where local_id = p_producto.local_id and producto_id = p_producto.id and fecha = p_fecha and publicado;
  end if;

  for v_grupo in
    select pm.grupo, pm.obligatorio, pm.min, pm.max
    from public.producto_modificadores pm
    where pm.producto_id = p_producto.id
    order by pm.grupo
  loop
    select count(*) into v_cantidad from jsonb_array_elements(v_elegidos) e where e ->> 'grupo' = v_grupo.grupo;
    if v_cantidad < v_grupo.min or v_cantidad > v_grupo.max then
      perform app.fallar(400, 'modificadores_incompletos',
        format('"%s": elija entre %s y %s opciones de "%s"', p_producto.nombre, v_grupo.min, v_grupo.max, v_grupo.grupo));
    end if;

    for v_mod in
      select e ->> 'nombre' as nombre from jsonb_array_elements(v_elegidos) e where e ->> 'grupo' = v_grupo.grupo
    loop
      if p_producto.es_menu_del_dia and v_grupo.grupo in ('Entrada', 'Segundo') then
        if v_menu.id is null then
          perform app.fallar(409, 'menu_no_publicado', 'El menú del día aún no está publicado');
        end if;
        if not (v_mod.nombre = any (case when v_grupo.grupo = 'Entrada' then v_menu.entradas else v_menu.segundos end)) then
          perform app.fallar(400, 'opcion_de_menu_invalida',
            format('"%s" no está en el menú de hoy (%s)', v_mod.nombre, lower(v_grupo.grupo)));
        end if;
        v_extra := 0;
      else
        select m.precio_extra into v_extra
        from public.modificadores m
        where m.local_id = p_producto.local_id and m.grupo = v_grupo.grupo and m.nombre = v_mod.nombre and m.activo;
        if not found then
          perform app.fallar(400, 'opcion_invalida', format('"%s" no es una opción de "%s"', v_mod.nombre, v_grupo.grupo));
        end if;
      end if;
      v_recargo := v_recargo + v_extra;
      v_snapshot := v_snapshot || jsonb_build_array(
        jsonb_build_object('grupo', v_grupo.grupo, 'nombre', v_mod.nombre, 'precio_extra', v_extra));
    end loop;
  end loop;

  return jsonb_build_object('snapshot', v_snapshot, 'recargo', v_recargo);
end;
$$;
revoke all on function app.validar_modificadores(public.productos, jsonb, date) from public;

-- -----------------------------------------------------------------------------
-- Agregar ítems (CU6.2): quedan en "borrador" con el precio vigente congelado (CA M3).
--   p_items: [{"producto_id", "cantidad", "modificadores": [...], "nota", "cuenta_split"}]
-- -----------------------------------------------------------------------------
create or replace function public.agregar_items(
  p_orden_id uuid,
  p_items jsonb,
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
  v_item jsonb;
  v_producto public.productos%rowtype;
  v_cantidad numeric;
  v_cuenta integer;
  v_nota text;
  v_mods jsonb;
  v_precio numeric;
  v_estacion uuid;
  v_ids jsonb := '[]'::jsonb;
  v_id uuid;
begin
  if v_previo is not null then
    return v_previo;
  end if;

  v_orden := app.orden_editable(p_orden_id, 'tomar_pedido');

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    perform app.fallar(400, 'sin_items', 'Agregue al menos un ítem');
  end if;
  if jsonb_array_length(p_items) > 100 then
    perform app.fallar(400, 'demasiados_items', 'Máximo 100 ítems por envío');
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_producto from public.productos
    where id = (v_item ->> 'producto_id')::uuid and local_id = v_orden.local_id;
    if not found or not v_producto.activo then
      perform app.fallar(404, 'producto_no_encontrado', 'El producto no existe en este local');
    end if;
    if not v_producto.disponible then
      perform app.fallar(409, 'producto_agotado', format('"%s" está agotado', v_producto.nombre));
    end if;

    v_cantidad := coalesce((v_item ->> 'cantidad')::numeric, 1);
    if v_cantidad <= 0 or v_cantidad > 999 or v_cantidad <> round(v_cantidad, 2) then
      perform app.fallar(400, 'cantidad_invalida', 'La cantidad debe estar entre 0,01 y 999');
    end if;
    v_cuenta := coalesce((v_item ->> 'cuenta_split')::integer, 1);
    if v_cuenta < 1 or v_cuenta > 50 then
      perform app.fallar(400, 'cuenta_invalida', 'El número de cuenta debe estar entre 1 y 50');
    end if;
    v_nota := nullif(trim(v_item ->> 'nota'), '');
    if length(v_nota) > 200 then
      perform app.fallar(400, 'nota_muy_larga', 'La nota admite hasta 200 caracteres');
    end if;

    v_mods := app.validar_modificadores(v_producto, v_item -> 'modificadores', v_orden.fecha_operativa);
    v_precio := app.precio_vigente(v_producto.id, v_orden.fecha_operativa) + (v_mods ->> 'recargo')::numeric;
    v_estacion := coalesce(
      v_producto.estacion_produccion_id,
      (select c.estacion_produccion_id_default from public.categorias c where c.id = v_producto.categoria_id)
    );

    insert into public.orden_items (
      local_id, orden_id, producto_id, nombre_snapshot, cantidad, precio_unitario_snapshot, modificadores,
      nota, total_linea, cuenta_split, estacion_produccion_id
    ) values (
      v_orden.local_id, v_orden.id, v_producto.id, v_producto.nombre, v_cantidad, v_precio, v_mods -> 'snapshot',
      v_nota, round(v_precio * v_cantidad, 2), v_cuenta, v_estacion
    ) returning id into v_id;
    v_ids := v_ids || to_jsonb(v_id);
  end loop;

  perform app.reabrir_si_precuenta(v_orden);
  perform app.recalcular_orden(v_orden.id);

  return app.registrar_mutacion(p_client_mutation_id, v_orden.local_id, 'agregar_items',
    jsonb_build_object('orden_id', p_orden_id, 'items', p_items),
    jsonb_build_object('orden_id', v_orden.id, 'item_ids', v_ids));
end;
$$;
revoke all on function public.agregar_items(uuid, jsonb, uuid) from public, anon;
grant execute on function public.agregar_items(uuid, jsonb, uuid) to authenticated;

-- Cambiar cantidad, nota o cuenta de un ítem que aún no se envió.
create or replace function public.actualizar_item(
  p_item_id uuid,
  p_cantidad numeric default null,
  p_nota text default null,
  p_cuenta_split integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.orden_items%rowtype;
  v_orden public.ordenes;
  v_cantidad numeric;
begin
  select * into v_item from public.orden_items where id = p_item_id;
  if not found then
    perform app.fallar(404, 'item_no_encontrado', 'El ítem no existe');
  end if;
  v_orden := app.orden_editable(v_item.orden_id, 'tomar_pedido');
  select * into v_item from public.orden_items where id = p_item_id for update;
  if v_item.estado <> 'borrador' then
    perform app.fallar(409, 'item_ya_enviado', 'Solo se editan ítems que aún no se enviaron');
  end if;

  v_cantidad := coalesce(p_cantidad, v_item.cantidad);
  if v_cantidad <= 0 or v_cantidad > 999 or v_cantidad <> round(v_cantidad, 2) then
    perform app.fallar(400, 'cantidad_invalida', 'La cantidad debe estar entre 0,01 y 999');
  end if;
  if p_cuenta_split is not null and (p_cuenta_split < 1 or p_cuenta_split > 50) then
    perform app.fallar(400, 'cuenta_invalida', 'El número de cuenta debe estar entre 1 y 50');
  end if;
  if length(trim(p_nota)) > 200 then
    perform app.fallar(400, 'nota_muy_larga', 'La nota admite hasta 200 caracteres');
  end if;

  update public.orden_items
  set cantidad = v_cantidad,
      total_linea = round(precio_unitario_snapshot * v_cantidad, 2),
      nota = case when p_nota is null then nota else nullif(trim(p_nota), '') end,
      cuenta_split = coalesce(p_cuenta_split, cuenta_split)
  where id = p_item_id;

  perform app.recalcular_orden(v_orden.id);
  return jsonb_build_object('item_id', p_item_id);
end;
$$;
revoke all on function public.actualizar_item(uuid, numeric, text, integer) from public, anon;
grant execute on function public.actualizar_item(uuid, numeric, text, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- Contenido de una comanda para la impresora (§13). Es una foto: el agente no consulta tablas.
-- -----------------------------------------------------------------------------
create or replace function app.payload_comanda(p_comanda_id uuid, p_reimpresion boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tipo', 'comanda',
    'local', l.nombre,
    'estacion', e.nombre,
    'comanda_numero', c.numero,
    'orden_numero', o.numero_dia,
    'mesa', app.etiqueta_mesa(o.mesa_principal_id),
    'mesas_unidas', coalesce((
      select jsonb_agg(app.etiqueta_mesa(u.mesa_id) order by u.created_at)
      from public.mesa_uniones u
      where u.orden_id = o.id and u.liberada_at is null and not u.es_principal
    ), '[]'::jsonb),
    'piso', p.nombre,
    'mozo', up.nombre_visible,
    'comensales', o.comensales,
    'fecha_hora', to_char(now() at time zone 'America/Lima', 'DD/MM/YYYY HH24:MI'),
    'reimpresion', p_reimpresion,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'cantidad', i.cantidad,
        'nombre', i.nombre_snapshot,
        'modificadores', (select coalesce(jsonb_agg(m ->> 'nombre'), '[]'::jsonb) from jsonb_array_elements(i.modificadores) m),
        'nota', i.nota,
        'cuenta', i.cuenta_split
      ) order by i.created_at)
      from public.orden_items i
      where i.comanda_id = c.id and i.estado <> 'anulado'
    ), '[]'::jsonb)
  )
  from public.comandas c
  join public.ordenes o on o.id = c.orden_id
  join public.locales l on l.id = c.local_id
  join public.estaciones_produccion e on e.id = c.estacion_produccion_id
  left join public.mesas me on me.id = o.mesa_principal_id
  left join public.pisos p on p.id = me.piso_id
  left join public.usuarios_perfil up on up.user_id = o.mozo_id
  where c.id = p_comanda_id
$$;
revoke all on function app.payload_comanda(uuid, boolean) from public;

-- Encola un trabajo para la impresora de una estación; si la estación no tiene impresora, el
-- trabajo no se crea (la estación trabaja solo con el KDS).
create or replace function app.encolar_impresion(p_local_id uuid, p_estacion_id uuid, p_tipo text, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_impresora uuid;
  v_id uuid;
begin
  select e.impresora_id into v_impresora from public.estaciones_produccion e where e.id = p_estacion_id;
  if v_impresora is null then
    return null;
  end if;
  insert into public.print_jobs (local_id, impresora_id, tipo, payload)
  values (p_local_id, v_impresora, p_tipo, p_payload)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function app.encolar_impresion(uuid, uuid, text, jsonb) from public;

-- -----------------------------------------------------------------------------
-- Enviar (CU6.3, flujo A.3): agrupa los ítems en borrador por estación, crea una comanda y un
-- trabajo de impresión por estación y marca los ítems "enviado". Los ítems sin estación (p. ej.
-- la bolsa) se marcan enviados sin comanda (DECISIONS D-025).
-- -----------------------------------------------------------------------------
create or replace function public.enviar_comanda(
  p_orden_id uuid,
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
  v_orden public.ordenes;
  v_numero integer;
  v_estacion record;
  v_comanda_id uuid;
  v_comandas jsonb := '[]'::jsonb;
  v_enviados integer;
begin
  if v_previo is not null then
    return v_previo;
  end if;

  v_orden := app.orden_editable(p_orden_id, 'tomar_pedido');

  perform 1 from public.orden_items i
  where i.orden_id = v_orden.id and i.estado = 'borrador' and (p_item_ids is null or i.id = any (p_item_ids))
  for update;
  if not found then
    perform app.fallar(409, 'sin_items_por_enviar', 'No hay ítems pendientes de enviar');
  end if;

  select coalesce(max(c.numero), 0) + 1 into v_numero from public.comandas c where c.orden_id = v_orden.id;

  for v_estacion in
    select distinct i.estacion_produccion_id as id
    from public.orden_items i
    where i.orden_id = v_orden.id and i.estado = 'borrador' and i.estacion_produccion_id is not null
      and (p_item_ids is null or i.id = any (p_item_ids))
  loop
    insert into public.comandas (local_id, orden_id, numero, estacion_produccion_id, enviada_por)
    values (v_orden.local_id, v_orden.id, v_numero, v_estacion.id, auth.uid())
    returning id into v_comanda_id;

    update public.orden_items
    set estado = 'enviado', enviado_at = now(), comanda_id = v_comanda_id
    where orden_id = v_orden.id and estado = 'borrador' and estacion_produccion_id = v_estacion.id
      and (p_item_ids is null or id = any (p_item_ids));

    perform app.encolar_impresion(v_orden.local_id, v_estacion.id, 'comanda', app.payload_comanda(v_comanda_id, false));
    v_comandas := v_comandas || jsonb_build_array(jsonb_build_object(
      'comanda_id', v_comanda_id, 'estacion_produccion_id', v_estacion.id, 'numero', v_numero));
  end loop;

  update public.orden_items
  set estado = 'enviado', enviado_at = now()
  where orden_id = v_orden.id and estado = 'borrador' and estacion_produccion_id is null
    and (p_item_ids is null or id = any (p_item_ids));

  select count(*) into v_enviados from public.orden_items
  where orden_id = v_orden.id and enviado_at >= now() and estado = 'enviado';

  return app.registrar_mutacion(p_client_mutation_id, v_orden.local_id, 'enviar_comanda',
    jsonb_build_object('orden_id', p_orden_id, 'item_ids', to_jsonb(p_item_ids)),
    jsonb_build_object('orden_id', v_orden.id, 'numero', v_numero, 'comandas', v_comandas, 'items_enviados', v_enviados));
end;
$$;
revoke all on function public.enviar_comanda(uuid, uuid[], uuid) from public, anon;
grant execute on function public.enviar_comanda(uuid, uuid[], uuid) to authenticated;

-- CU6.4: reimprimir incrementa el contador; el cambio queda en la auditoría (trigger de comandas).
create or replace function public.reimprimir_comanda(p_comanda_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_comanda public.comandas%rowtype;
  v_job uuid;
begin
  select * into v_comanda from public.comandas where id = p_comanda_id for update;
  if not found then
    perform app.fallar(404, 'comanda_no_encontrada', 'La comanda no existe');
  end if;
  perform app.exigir_permiso(v_comanda.local_id, 'tomar_pedido');

  v_job := app.encolar_impresion(v_comanda.local_id, v_comanda.estacion_produccion_id, 'comanda',
    app.payload_comanda(v_comanda.id, true));
  if v_job is null then
    perform app.fallar(409, 'estacion_sin_impresora', 'La estación no tiene impresora asignada');
  end if;
  update public.comandas set reimpresiones = reimpresiones + 1 where id = p_comanda_id;
  return jsonb_build_object('comanda_id', p_comanda_id, 'print_job_id', v_job);
end;
$$;
revoke all on function public.reimprimir_comanda(uuid) from public, anon;
grant execute on function public.reimprimir_comanda(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Estados de preparación (CU7.1) y entrega:
--   en_preparacion / listo → cocina (operar_kds); servido → salón (tomar_pedido).
-- -----------------------------------------------------------------------------
create or replace function public.cambiar_estado_items(p_item_ids uuid[], p_estado text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locales uuid[];
  v_permiso text;
  v_desde text[];
  v_cambiados integer;
begin
  if p_item_ids is null or cardinality(p_item_ids) = 0 then
    perform app.fallar(400, 'sin_items', 'Indique los ítems');
  end if;
  case p_estado
    when 'en_preparacion' then v_permiso := 'operar_kds'; v_desde := array['enviado', 'listo'];
    when 'listo' then v_permiso := 'operar_kds'; v_desde := array['enviado', 'en_preparacion'];
    when 'servido' then v_permiso := 'tomar_pedido'; v_desde := array['enviado', 'en_preparacion', 'listo'];
    else perform app.fallar(400, 'estado_invalido', 'Estado no permitido');
  end case;

  select array_agg(distinct i.local_id) into v_locales from public.orden_items i where i.id = any (p_item_ids);
  if v_locales is null or cardinality(v_locales) <> 1 then
    perform app.fallar(400, 'items_invalidos', 'Los ítems deben existir y ser de un mismo local');
  end if;
  perform app.exigir_permiso(v_locales[1], v_permiso);

  perform 1 from public.orden_items i where i.id = any (p_item_ids) for update;
  if exists (select 1 from public.orden_items i where i.id = any (p_item_ids) and not (i.estado = any (v_desde))) then
    perform app.fallar(409, 'transicion_invalida', 'Algún ítem no puede pasar a ese estado');
  end if;

  update public.orden_items set estado = p_estado where id = any (p_item_ids);
  get diagnostics v_cambiados = row_count;
  return jsonb_build_object('items', v_cambiados, 'estado', p_estado);
end;
$$;
revoke all on function public.cambiar_estado_items(uuid[], text) from public, anon;
grant execute on function public.cambiar_estado_items(uuid[], text) to authenticated;

-- -----------------------------------------------------------------------------
-- Estado de la mesa fuera de una orden: liberar tras la limpieza y bloquear/desbloquear.
-- -----------------------------------------------------------------------------
create or replace function public.liberar_mesa(p_mesa_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mesa public.mesas%rowtype;
begin
  select * into v_mesa from public.mesas where id = p_mesa_id for update;
  if not found then
    perform app.fallar(404, 'mesa_no_encontrada', 'La mesa no existe');
  end if;
  perform app.exigir_permiso(v_mesa.local_id, 'tomar_pedido');
  if v_mesa.estado <> 'por_limpiar' then
    perform app.fallar(409, 'mesa_no_por_limpiar', 'Solo se libera una mesa que está por limpiar');
  end if;
  update public.mesas set estado = 'libre' where id = p_mesa_id;
  return jsonb_build_object('mesa_id', p_mesa_id, 'estado', 'libre');
end;
$$;
revoke all on function public.liberar_mesa(uuid) from public, anon;
grant execute on function public.liberar_mesa(uuid) to authenticated;

create or replace function public.bloquear_mesa(p_mesa_id uuid, p_bloquear boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mesa public.mesas%rowtype;
begin
  select * into v_mesa from public.mesas where id = p_mesa_id for update;
  if not found then
    perform app.fallar(404, 'mesa_no_encontrada', 'La mesa no existe');
  end if;
  perform app.exigir_permiso(v_mesa.local_id, 'configurar_local');
  if p_bloquear and v_mesa.estado not in ('libre', 'por_limpiar') then
    perform app.fallar(409, 'mesa_ocupada', 'No se bloquea una mesa con una orden en curso');
  end if;
  if not p_bloquear and v_mesa.estado <> 'bloqueada' then
    perform app.fallar(409, 'mesa_no_bloqueada', 'La mesa no está bloqueada');
  end if;
  update public.mesas set estado = case when p_bloquear then 'bloqueada' else 'libre' end where id = p_mesa_id;
  return jsonb_build_object('mesa_id', p_mesa_id, 'estado', case when p_bloquear then 'bloqueada' else 'libre' end);
end;
$$;
revoke all on function public.bloquear_mesa(uuid, boolean) from public, anon;
grant execute on function public.bloquear_mesa(uuid, boolean) to authenticated;
