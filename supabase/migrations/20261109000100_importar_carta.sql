-- =============================================================================
-- Warike POS — Carga masiva de la carta (M3, DECISIONS D-042)
-- =============================================================================
-- La PWA lee la plantilla (CSV o Excel) y envía las filas ya separadas; aquí se valida todo y se
-- aplica en una sola transacción: o entran todas las filas o ninguna.
--
-- p_filas: [{ fila, codigo?, nombre, categoria, precio, descripcion?, estacion?, disponible? }]
--   - Un producto existente se reconoce por su código o, sin código, por su nombre exacto.
--   - Las categorías que no existen se crean; las estaciones deben existir.
--   - Una celda vacía de descripción, estación o disponible no cambia lo que ya tenía el producto.
--   - Un cambio de precio queda en el historial con el motivo indicado (exige modificar_precios).
-- p_simular: valida y devuelve el resumen sin guardar nada (vista previa).

create or replace function public.importar_carta(
  p_local_id uuid,
  p_filas jsonb,
  p_motivo text,
  p_simular boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fila jsonb;
  v_num integer;
  v_codigo text;
  v_nombre text;
  v_categoria text;
  v_estacion text;
  v_descripcion text;
  v_precio numeric;
  v_disponible boolean;
  v_estacion_id uuid;
  v_categoria_id uuid;
  v_producto public.productos%rowtype;
  v_coincidencias integer;
  v_errores jsonb := '[]'::jsonb;
  v_codigos text[] := array[]::text[];
  v_nombres text[] := array[]::text[];
  v_nuevos integer := 0;
  v_actualizados integer := 0;
  v_precios integer := 0;
  v_categorias_nuevas text[] := array[]::text[];
  v_motivo text := nullif(trim(p_motivo), '');
  v_resumen jsonb;
begin
  perform app.exigir_permiso(p_local_id, 'gestionar_carta');
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) = 0 then
    perform app.fallar(400, 'sin_filas', 'El archivo no tiene productos');
  end if;
  if jsonb_array_length(p_filas) > 1000 then
    perform app.fallar(400, 'demasiadas_filas', 'Cargue como máximo 1000 productos por archivo');
  end if;

  -- 1. Validación de todas las filas, sin escribir nada.
  for v_fila in select value from jsonb_array_elements(p_filas) loop
    v_num := coalesce((v_fila ->> 'fila')::integer, 0);
    v_codigo := nullif(trim(v_fila ->> 'codigo'), '');
    v_nombre := nullif(trim(v_fila ->> 'nombre'), '');
    v_categoria := nullif(trim(v_fila ->> 'categoria'), '');
    v_estacion := nullif(trim(v_fila ->> 'estacion'), '');
    begin
      v_precio := round((v_fila ->> 'precio')::numeric, 2);
    exception when others then
      v_precio := null;
    end;

    if v_nombre is null or length(v_nombre) > 120 then
      v_errores := v_errores || jsonb_build_object('fila', v_num, 'error', 'Falta el nombre o pasa de 120 caracteres');
    end if;
    if v_categoria is null then
      v_errores := v_errores || jsonb_build_object('fila', v_num, 'error', 'Falta la categoría');
    end if;
    if v_precio is null or v_precio < 0 or v_precio > 99999 then
      v_errores := v_errores || jsonb_build_object('fila', v_num, 'error', 'El precio debe ser un número entre 0 y 99 999');
    end if;
    if v_codigo is not null then
      if v_codigo = any (v_codigos) then
        v_errores := v_errores || jsonb_build_object('fila', v_num, 'error', 'El código ' || v_codigo || ' se repite en el archivo');
      end if;
      v_codigos := v_codigos || v_codigo;
    elsif v_nombre is not null then
      if lower(v_nombre) = any (v_nombres) then
        v_errores := v_errores || jsonb_build_object('fila', v_num, 'error', 'El producto ' || v_nombre || ' se repite en el archivo');
      end if;
      v_nombres := v_nombres || lower(v_nombre);
      select count(*) into v_coincidencias
      from public.productos
      where local_id = p_local_id and lower(nombre) = lower(v_nombre);
      if v_coincidencias > 1 then
        v_errores := v_errores || jsonb_build_object('fila', v_num, 'error',
          'Hay varios productos llamados ' || v_nombre || ': indique el código');
      end if;
    end if;
    if v_estacion is not null and not exists (
      select 1 from public.estaciones_produccion
      where local_id = p_local_id and lower(nombre) = lower(v_estacion)
    ) then
      v_errores := v_errores || jsonb_build_object('fila', v_num, 'error', 'La estación ' || v_estacion || ' no existe');
    end if;
  end loop;

  if jsonb_array_length(v_errores) > 0 then
    return jsonb_build_object('ok', false, 'errores', v_errores);
  end if;

  -- 2. Escritura. En simulación se deshace al final con una excepción capturada.
  begin
    perform set_config('warike.motivo_cambio_precio', 'Carga masiva: ' || coalesce(v_motivo, 'sin motivo'), true);

    for v_fila in select value from jsonb_array_elements(p_filas) loop
      v_num := (v_fila ->> 'fila')::integer;
      v_codigo := nullif(trim(v_fila ->> 'codigo'), '');
      v_nombre := trim(v_fila ->> 'nombre');
      v_categoria := trim(v_fila ->> 'categoria');
      v_estacion := nullif(trim(v_fila ->> 'estacion'), '');
      v_descripcion := nullif(trim(v_fila ->> 'descripcion'), '');
      v_precio := round((v_fila ->> 'precio')::numeric, 2);
      v_disponible := (v_fila ->> 'disponible')::boolean;

      select id into v_categoria_id
      from public.categorias
      where local_id = p_local_id and lower(nombre) = lower(v_categoria);
      if v_categoria_id is null then
        insert into public.categorias (local_id, nombre, orden)
        values (
          p_local_id,
          v_categoria,
          coalesce((select max(orden) from public.categorias where local_id = p_local_id), 0) + 1
        )
        returning id into v_categoria_id;
        v_categorias_nuevas := v_categorias_nuevas || v_categoria;
      end if;

      v_estacion_id := null;
      if v_estacion is not null then
        select id into v_estacion_id
        from public.estaciones_produccion
        where local_id = p_local_id and lower(nombre) = lower(v_estacion);
      end if;

      if v_codigo is not null then
        select * into v_producto from public.productos
        where local_id = p_local_id and codigo = v_codigo
        for update;
      else
        select * into v_producto from public.productos
        where local_id = p_local_id and lower(nombre) = lower(v_nombre)
        for update;
      end if;

      if v_producto.id is null then
        insert into public.productos (local_id, categoria_id, codigo, nombre, descripcion, precio,
                                      estacion_produccion_id, disponible)
        values (
          p_local_id, v_categoria_id, v_codigo, v_nombre, v_descripcion, v_precio,
          coalesce(v_estacion_id,
                   (select estacion_produccion_id_default from public.categorias where id = v_categoria_id)),
          coalesce(v_disponible, true)
        );
        v_nuevos := v_nuevos + 1;
      else
        if v_producto.precio <> v_precio then
          if not app.tiene_permiso(p_local_id, 'modificar_precios') then
            perform app.fallar(403, 'sin_permiso', 'No tiene permiso para cambiar precios (fila ' || v_num || ')');
          end if;
          if v_motivo is null or length(v_motivo) < 3 then
            perform app.fallar(400, 'motivo_requerido', 'Indique el motivo: el archivo cambia precios');
          end if;
          v_precios := v_precios + 1;
        end if;
        update public.productos
        set nombre = v_nombre,
            categoria_id = v_categoria_id,
            descripcion = coalesce(v_descripcion, descripcion),
            precio = v_precio,
            estacion_produccion_id = coalesce(v_estacion_id, estacion_produccion_id),
            disponible = coalesce(v_disponible, disponible),
            activo = true
        where id = v_producto.id;
        v_actualizados := v_actualizados + 1;
      end if;
      v_producto := null;
    end loop;

    perform set_config('warike.motivo_cambio_precio', '', true);
    v_resumen := jsonb_build_object(
      'ok', true,
      'simulado', p_simular,
      'nuevos', v_nuevos,
      'actualizados', v_actualizados,
      'precios_cambiados', v_precios,
      'categorias_nuevas', to_jsonb(v_categorias_nuevas)
    );
    if p_simular then
      raise exception using errcode = 'PT299', message = 'simulacion';
    end if;
  exception
    when sqlstate 'PT299' then
      perform set_config('warike.motivo_cambio_precio', '', true);
      return v_resumen;
  end;

  return v_resumen;
end;
$$;
revoke all on function public.importar_carta(uuid, jsonb, text, boolean) from public, anon;
grant execute on function public.importar_carta(uuid, jsonb, text, boolean) to authenticated;
