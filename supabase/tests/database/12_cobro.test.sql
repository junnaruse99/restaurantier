-- Pre-cuenta, cobro con pago mixto, división y comprobantes (M12, M13, flujo D).
begin;
\ir _helpers.psql
\ir _salon.psql
select plan(46);

select pg_temp.crear_salon_prueba();
select pg_temp.guardar('local', 'e2000000-0000-4000-8000-00000000000a');
insert into public.config_local (local_id) values (pg_temp.id('local')) on conflict do nothing;
insert into public.cajas (id, local_id, nombre, impresora_id)
values ('ec000000-0000-4000-8000-000000000001', pg_temp.id('local'), 'Caja 1', pg_temp.id('imp_cocina'));
insert into public.series_cpe (local_id, tipo_cpe, serie) values
  (pg_temp.id('local'), '03', 'B001'), (pg_temp.id('local'), '01', 'F001');
-- Tasa fija para que la prueba no dependa de la fecha: régimen general (18 %) de la empresa de prueba.
insert into public.config_tributaria (empresa_id, regimen, vigencia_desde, tasa_igv, tasa_ipm, tasa_total, icbper_unitario)
select l.empresa_id, 'MYPE_RESTAURANTE', '2000-01-01', 0.16, 0.02, 0.18, 0.50
from public.locales l where l.id = pg_temp.id('local');
update public.productos set aplica_icbper = true where id = pg_temp.id('bolsa');

create function pg_temp.orden_con_items(p_mesa text, p_items jsonb)
returns uuid
language plpgsql
as $$
declare
  v_orden uuid;
begin
  perform pg_temp.como('mozo');
  v_orden := (public.abrir_orden(pg_temp.id(p_mesa), 2) ->> 'orden_id')::uuid;
  perform public.agregar_items(v_orden, p_items);
  perform public.enviar_comanda(v_orden);
  perform pg_temp.como('cajero');
  return v_orden;
end;
$$;

select pg_temp.como('cajero');
select pg_temp.guardar('sesion', (public.abrir_caja('ec000000-0000-4000-8000-000000000001', 100) ->> 'sesion_id')::uuid);

select pg_temp.guardar('o1', pg_temp.orden_con_items('A1', jsonb_build_array(
  jsonb_build_object('producto_id', pg_temp.id('lomo'), 'modificadores', '[{"grupo":"Término","nombre":"Jugoso"}]'::jsonb),
  jsonb_build_object('producto_id', pg_temp.id('chicha'), 'cantidad', 2),
  jsonb_build_object('producto_id', pg_temp.id('bolsa'))
)));

-- ---------------------------------------------------------------------------
-- Pre-cuenta (CU12.1)
-- ---------------------------------------------------------------------------
select is((public.generar_precuenta(pg_temp.id('o1'), 2::smallint) -> 'partes'), '[23.25, 23.25]'::jsonb,
  'la pre-cuenta divide el total en partes iguales');
select pg_temp.como_postgres();
select is((select estado from public.mesas where id = pg_temp.id('A1')), 'precuenta', 'la mesa pasa a pre-cuenta');
select is((select count(*) from public.print_jobs where tipo = 'precuenta'), 1::bigint, 'la pre-cuenta se imprime en la caja');
select pg_temp.como('mozo');
select lives_ok($$ select public.agregar_items(pg_temp.id('o1'), jsonb_build_array(jsonb_build_object('producto_id', pg_temp.id('chicha')))) $$,
  'se puede seguir pidiendo después de la pre-cuenta');
select pg_temp.como_postgres();
select is((select estado from public.ordenes where id = pg_temp.id('o1')), 'abierta', 'y la orden vuelve a abierta');
select pg_temp.como('cajero');
select is(pg_temp.error_de($$ select public.generar_precuenta(pg_temp.id('o1')) $$), 'PT409:items_en_borrador',
  'la pre-cuenta exige enviar o quitar lo que está en borrador');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o1'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":100}]') $$), 'PT409:items_en_borrador', 'tampoco se cobra con ítems en borrador');
select pg_temp.como('mozo');
select public.anular_item(i.id, 'error_digitacion', null, false, null, null) from public.orden_items i
where i.orden_id = pg_temp.id('o1') and i.estado = 'borrador';
select pg_temp.como('cajero');

-- ---------------------------------------------------------------------------
-- Validaciones del cobro
-- ---------------------------------------------------------------------------
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o1'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":40}]') $$), 'PT400:pagos_no_cuadran', 'los pagos deben sumar el total');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o1'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"yape","monto":47}]') $$), 'PT400:referencia_requerida', 'Yape exige el número de operación');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o1'), pg_temp.id('sesion'), '01',
    '{"tipo_doc":"6","num_doc":"20480723562","nombre":"X"}', '[{"metodo":"efectivo","monto":47}]') $$),
  'PT400:ruc_invalido', 'la factura valida el dígito verificador del RUC');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o1'), pg_temp.id('sesion'), '03',
    '{"tipo_doc":"1","num_doc":"123"}', '[{"metodo":"efectivo","monto":47}]') $$),
  'PT400:dni_invalido', 'el DNI tiene 8 dígitos');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o1'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":47,"monto_recibido":40}]') $$),
  'PT400:recibido_insuficiente', 'el efectivo recibido debe alcanzar');
select pg_temp.como('mozo');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o1'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":47}]') $$), 'PT403:sin_permiso', 'el mozo no cobra');
select pg_temp.como('cajero');

-- ---------------------------------------------------------------------------
-- Boleta con pago mixto (CA de M12): 30 + 2 × 8 + 0,50 de bolsa + 0,50 de ICBPER = 47,00
-- ---------------------------------------------------------------------------
create temp table b1 as select public.cobrar_y_emitir(pg_temp.id('o1'), pg_temp.id('sesion'), '03',
  '{"tipo_doc":"1","num_doc":"45678912","nombre":"Ana Pérez"}',
  '[{"metodo":"yape","monto":17,"referencia":"OP-981"},{"metodo":"efectivo","monto":30,"monto_recibido":50}]') as r;
grant select on b1 to authenticated, service_role;
select is((select r ->> 'serie' || '-' || (r ->> 'numero') from b1), 'B001-1', 'emite la boleta B001-1');
select is((select (r ->> 'vuelto')::numeric from b1), 20.00, 'calcula el vuelto del efectivo');
select pg_temp.como_postgres();
select results_eq(
  $$ select op_gravada, igv, icbper, total, tasa_igv_aplicada, estado, cliente_nombre
     from public.comprobantes where id = (select (r ->> 'comprobante_id')::uuid from b1) $$,
  $$ values (39.40::numeric(12, 2), 7.10::numeric(12, 2), 0.50::numeric(12, 2), 47.00::numeric(12, 2),
            0.1800::numeric(6, 4), 'pendiente_envio', 'ANA PÉREZ') $$,
  'valor, IGV (18 %), ICBPER y total según §9; queda pendiente de envío');
select results_eq(
  $$ select descripcion, cantidad, valor_unitario, precio_unitario, igv, icbper, total from public.comprobante_items
     where comprobante_id = (select (r ->> 'comprobante_id')::uuid from b1) order by total desc $$,
  $$ values ('Lomo saltado (Jugoso)', 1.00::numeric(8, 2), 25.423729::numeric(14, 6), 30::numeric(14, 6), 4.58::numeric(12, 2), 0::numeric(12, 2), 30.00::numeric(12, 2)),
            ('Chicha morada', 2.00, 6.779661, 8, 2.44, 0, 16.00),
            ('Bolsa', 1.00, 0.423729, 0.5, 0.08, 0.50, 0.50) $$,
  'cada línea lleva su valor unitario, IGV e ICBPER');
select results_eq(
  $$ select metodo, monto, monto_recibido, vuelto, referencia from public.pagos
     where comprobante_id = (select (r ->> 'comprobante_id')::uuid from b1) order by metodo $$,
  $$ values ('efectivo', 30.00::numeric(12, 2), 50.00::numeric(12, 2), 20.00::numeric(12, 2), null::text),
            ('yape', 17.00, null, null, 'OP-981') $$,
  'registra los pagos con su vuelto y referencia');
select is((select estado from public.ordenes where id = pg_temp.id('o1')), 'pagada', 'la orden queda pagada');
select is((select estado from public.mesas where id = pg_temp.id('A1')), 'por_limpiar', 'la mesa queda por limpiar');
select is((select ultimo_numero from public.series_cpe where serie = 'B001'), 1, 'el correlativo avanza');
select pg_temp.como('cajero');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o1'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":1}]') $$), 'PT409:orden_cerrada', 'una orden pagada no se vuelve a cobrar');

-- ---------------------------------------------------------------------------
-- División por ítems: factura por la chicha y boleta por el resto
-- ---------------------------------------------------------------------------
select pg_temp.guardar('o2', pg_temp.orden_con_items('A2', jsonb_build_array(
  jsonb_build_object('producto_id', pg_temp.id('lomo'), 'modificadores', '[{"grupo":"Término","nombre":"Jugoso"}]'::jsonb),
  jsonb_build_object('producto_id', pg_temp.id('chicha'))
)));
select pg_temp.guardar('i_chicha', (select id from public.orden_items where orden_id = pg_temp.id('o2') and producto_id = pg_temp.id('chicha')));
select is((public.cobrar_y_emitir(pg_temp.id('o2'), pg_temp.id('sesion'), '01',
    '{"tipo_doc":"6","num_doc":"20480723563","nombre":"El Warike Resto Grill S.C.R.L.","direccion":"Lima"}',
    '[{"metodo":"visa","monto":8,"referencia":"V-1234"}]', array[pg_temp.id('i_chicha')]) ->> 'serie'), 'F001',
  'emite una factura solo por la chicha');
select pg_temp.como_postgres();
select is((select estado from public.ordenes where id = pg_temp.id('o2')), 'abierta', 'queda el lomo por cobrar');
select pg_temp.como('cajero');
select is(pg_temp.error_de(format($$ select public.cobrar_y_emitir(%L, %L, '03', '{}', '[{"metodo":"efectivo","monto":8}]', array[%L]::uuid[]) $$,
    pg_temp.id('o2'), pg_temp.id('sesion'), pg_temp.id('i_chicha'))), 'PT409:items_no_cobrables',
  'un ítem ya cobrado no se vuelve a cobrar');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o2'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":15}]', null, 2::smallint) $$), 'PT409:division_cambiada',
  'no se mezcla la división por ítems con las partes iguales');
select is((public.cobrar_y_emitir(pg_temp.id('o2'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":30}]') ->> 'orden_pagada')::boolean, true, 'la boleta por el resto cierra la orden');
select pg_temp.como_postgres();
select is((select cliente_nombre from public.comprobantes where serie = 'B001' and numero = 2), 'CLIENTES VARIOS',
  'una boleta sin documento va a "clientes varios"');

-- ---------------------------------------------------------------------------
-- Partes iguales: 30 + 8 = 38 entre 3 → 12,68 + 12,66 + 12,66
-- ---------------------------------------------------------------------------
select pg_temp.guardar('o3', pg_temp.orden_con_items('A3', jsonb_build_array(
  jsonb_build_object('producto_id', pg_temp.id('lomo'), 'modificadores', '[{"grupo":"Término","nombre":"Jugoso"}]'::jsonb),
  jsonb_build_object('producto_id', pg_temp.id('chicha'))
)));
select is((public.cobrar_y_emitir(pg_temp.id('o3'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":12.68}]', null, 3::smallint) ->> 'parte')::int, 1, 'cobra la primera parte con el residuo');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o3'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":12.68}]', null, 3::smallint) $$), 'PT400:pagos_no_cuadran', 'las demás partes son de 12,66');
select is(pg_temp.error_de($$ select public.cobrar_y_emitir(pg_temp.id('o3'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":19}]', null, 2::smallint) $$), 'PT409:division_cambiada', 'no se cambia el número de partes');
select is((public.cobrar_y_emitir(pg_temp.id('o3'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"plin","monto":12.66,"referencia":"P-1"}]', null, 3::smallint) ->> 'orden_pagada')::boolean, false,
  'la segunda parte no cierra la orden');
select is((public.cobrar_y_emitir(pg_temp.id('o3'), pg_temp.id('sesion'), '03', '{}',
    '[{"metodo":"efectivo","monto":12.66}]', null, 3::smallint) ->> 'orden_pagada')::boolean, true,
  'la tercera parte la cierra');
select pg_temp.como_postgres();
select is((select sum(total) from public.comprobantes where orden_id = pg_temp.id('o3')), 38.00::numeric,
  'las partes suman el total de la orden');
select is((select descripcion from public.comprobante_items ci join public.comprobantes c on c.id = ci.comprobante_id
           where c.orden_id = pg_temp.id('o3') and c.parte = 2),
  'CONSUMO DE ALIMENTOS Y BEBIDAS (PARTE 2 DE 3)', 'cada parte lleva una línea de consumo');

-- ---------------------------------------------------------------------------
-- Cola de emisión (Edge Function emitir-cpe con service_role)
-- ---------------------------------------------------------------------------
select pg_temp.como('cajero');
select throws_ok($$ select public.cpe_tomar() $$, '42501', null, 'la caja no toma comprobantes de la cola');
select is(public.cpe_puede_emitir((select (r ->> 'comprobante_id')::uuid from b1)), true,
  'la caja puede pedir el envío de sus comprobantes');
select pg_temp.como_postgres();
set local role service_role;
create temp table t1 as select public.cpe_tomar((select (r ->> 'comprobante_id')::uuid from b1)) as r;
select is((select jsonb_array_length(r) from t1), 1, 'toma el comprobante pedido');
select is((select array_agg(i ->> 'descripcion' order by i ->> 'descripcion') from t1, jsonb_array_elements(r -> 0 -> 'items') i),
  array['Bolsa', 'Chicha morada', 'Lomo saltado (Jugoso)'], 'con sus ítems');
select is((select estado from public.comprobantes where id = (select (r ->> 'comprobante_id')::uuid from b1)), 'enviado',
  'y lo marca enviado para que nadie más lo envíe');
select is(public.cpe_tomar((select (r ->> 'comprobante_id')::uuid from b1)), '[]'::jsonb, 'un enviado no se toma dos veces');
select is(public.cpe_registrar_resultado((select (r ->> 'comprobante_id')::uuid from b1), '{"estado":"error_red"}') ->> 'estado',
  'pendiente_envio', 'un error de red lo deja pendiente');
select ok((select proximo_intento_at > now() from public.comprobantes where id = (select (r ->> 'comprobante_id')::uuid from b1)),
  'con el siguiente intento según el backoff');
select is(public.cpe_registrar_resultado((select (r ->> 'comprobante_id')::uuid from b1),
    '{"estado":"aceptado","sunat_codigo":"0","hash":"abc=","enlace_pdf":"https://x/pdf","qr":"20480723563|03|B001|1"}') ->> 'estado',
  'aceptado', 'registra la aceptación');
reset role;
select results_eq(
  $$ select estado, hash, enlace_pdf from public.comprobantes where id = (select (r ->> 'comprobante_id')::uuid from b1) $$,
  $$ values ('aceptado', 'abc=', 'https://x/pdf') $$, 'guarda el hash y los enlaces');
select is((select payload ->> 'qr' from public.print_jobs where tipo = 'comprobante'), '20480723563|03|B001|1',
  'e imprime el ticket con el QR');

select * from finish();
rollback;
