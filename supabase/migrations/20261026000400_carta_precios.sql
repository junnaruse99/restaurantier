-- =============================================================================
-- Warike POS — Fase 1 · 0400 Carta y precios (M3)
-- =============================================================================

-- CU3.2: cambio de precio individual con motivo obligatorio. El trigger de productos guarda el
-- historial y la auditoría; las órdenes abiertas conservan su precio_unitario_snapshot (CA M3).
create or replace function public.cambiar_precio(p_producto_id uuid, p_precio numeric, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_producto public.productos%rowtype;
  v_precio numeric := round(p_precio, 2);
begin
  select * into v_producto from public.productos where id = p_producto_id for update;
  if not found then
    perform app.fallar(404, 'producto_no_encontrado', 'El producto no existe');
  end if;
  perform app.exigir_permiso(v_producto.local_id, 'modificar_precios');
  if v_precio is null or v_precio < 0 or v_precio > 99999 then
    perform app.fallar(400, 'precio_invalido', 'El precio debe estar entre 0 y 99 999');
  end if;
  if length(coalesce(trim(p_motivo), '')) < 3 then
    perform app.fallar(400, 'motivo_requerido', 'Indique el motivo del cambio de precio');
  end if;
  if v_precio = v_producto.precio then
    return jsonb_build_object('producto_id', p_producto_id, 'precio_anterior', v_producto.precio, 'precio_nuevo', v_precio,
                              'cambiado', false);
  end if;

  perform set_config('warike.motivo_cambio_precio', trim(p_motivo), true);
  update public.productos set precio = v_precio where id = p_producto_id;
  perform set_config('warike.motivo_cambio_precio', '', true);

  return jsonb_build_object('producto_id', p_producto_id, 'precio_anterior', v_producto.precio, 'precio_nuevo', v_precio,
                            'cambiado', true);
end;
$$;
revoke all on function public.cambiar_precio(uuid, numeric, text) from public, anon;
grant execute on function public.cambiar_precio(uuid, numeric, text) to authenticated;

-- CU3.2: cambio masivo por porcentaje, para todo el local o una categoría. Redondeo half-up a
-- céntimos (§9). Las reglas por día del menú del día se editan aparte.
create or replace function public.cambiar_precios_masivo(
  p_local_id uuid,
  p_porcentaje numeric,
  p_motivo text,
  p_categoria_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cambiados integer;
begin
  perform app.exigir_permiso(p_local_id, 'modificar_precios');
  if p_porcentaje is null or p_porcentaje = 0 or p_porcentaje < -90 or p_porcentaje > 500 then
    perform app.fallar(400, 'porcentaje_invalido', 'El porcentaje debe estar entre -90 y 500 y no ser cero');
  end if;
  if length(coalesce(trim(p_motivo), '')) < 3 then
    perform app.fallar(400, 'motivo_requerido', 'Indique el motivo del cambio de precios');
  end if;
  if p_categoria_id is not null
     and not exists (select 1 from public.categorias where id = p_categoria_id and local_id = p_local_id) then
    perform app.fallar(404, 'categoria_no_encontrada', 'La categoría no existe en este local');
  end if;

  perform set_config('warike.motivo_cambio_precio', trim(p_motivo), true);
  update public.productos
  set precio = round(precio * (1 + p_porcentaje / 100), 2)
  where local_id = p_local_id
    and activo
    and precio > 0
    and (p_categoria_id is null or categoria_id = p_categoria_id);
  get diagnostics v_cambiados = row_count;
  perform set_config('warike.motivo_cambio_precio', '', true);

  return jsonb_build_object('productos', v_cambiados, 'porcentaje', p_porcentaje);
end;
$$;
revoke all on function public.cambiar_precios_masivo(uuid, numeric, text, uuid) from public, anon;
grant execute on function public.cambiar_precios_masivo(uuid, numeric, text, uuid) to authenticated;

-- CU3.3: agotado / disponible. Lo marcan el admin (gestionar_carta) y cocina (operar_kds), que es
-- quien sabe cuándo se acabó un plato (DECISIONS D-027). Las tablets lo reciben por Realtime.
create or replace function public.marcar_disponibilidad(p_producto_id uuid, p_disponible boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local uuid;
begin
  select local_id into v_local from public.productos where id = p_producto_id;
  if v_local is null then
    perform app.fallar(404, 'producto_no_encontrado', 'El producto no existe');
  end if;
  if not app.tiene_permiso(v_local, 'gestionar_carta') and not app.tiene_permiso(v_local, 'operar_kds') then
    perform app.fallar(403, 'sin_permiso', 'No tiene permiso para cambiar la disponibilidad de la carta');
  end if;
  update public.productos set disponible = coalesce(p_disponible, true) where id = p_producto_id;
  return jsonb_build_object('producto_id', p_producto_id, 'disponible', coalesce(p_disponible, true));
end;
$$;
revoke all on function public.marcar_disponibilidad(uuid, boolean) from public, anon;
grant execute on function public.marcar_disponibilidad(uuid, boolean) to authenticated;
