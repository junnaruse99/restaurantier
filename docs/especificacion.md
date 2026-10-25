# Warike POS — Especificación técnica y de construcción

**Versión:** 1.2 (25-10-2026), que añade la integración con el POS Niubiz (§10.2)
**Cliente:** Warike Resto Grill (Perú) y, a futuro, el segundo local "Warike Urban"
**Destinatario:** LLM / agente de programación encargado de construir la solución

> **Cómo usar este documento:** es la fuente de verdad del proyecto. Síguelo en orden de fases (§15). Si encuentras una ambigüedad, elige la opción más simple que cumpla los criterios de aceptación y anótala en `DECISIONS.md` en la raíz del repositorio. No agregues funcionalidades fuera de alcance sin registrarlas primero como propuesta en `DECISIONS.md`.

---

## 1. Contexto y objetivo

Warike Resto Grill usa hoy el software SHIOL instalado en un servidor local, que sufrió ataques de ransomware. El proveedor cotizó S/ 600 al mes de mantenimiento para migrarlo a la nube. Este proyecto reemplaza SHIOL por un sistema propio en la nube, **Warike POS**.

**Requisitos no negociables:**
- Funciona en tablets de mozos, PC de caja y pantalla de cocina (PWA).
- Emite boletas, facturas y notas de crédito electrónicas válidas ante SUNAT.
- Tolera la caída de internet sin detener el servicio.
- No guarda ningún dato crítico solo en equipos locales.
- Cada acción sensible queda en una bitácora de auditoría inmutable.
- Costo de operación objetivo: **S/ 200–320 al mes**.

**Parámetros regionales:**
- Idioma de la UI: español (Perú).
- Zona horaria: `America/Lima`.
- Moneda: PEN. En la UI se muestra `S/ 1.234,50` (configurable); en la API se usa punto decimal.

**Volumen confirmado:** ~400 boletas y 50–60 facturas al mes, más las notas de crédito. En total, ≈ 460–480 comprobantes al mes.

---

## 2. Decisiones de arquitectura ya tomadas

| Tema | Decisión | Motivo |
|---|---|---|
| Hosting de datos | Supabase (PostgreSQL gestionado) en la región `sa-east-1` (São Paulo) | Elimina el servidor local, que fue el vector del ransomware; trae RLS, Realtime y backups |
| Facturación electrónica | **Nubefact (API REST JSON)**, plan de S/ 70/mes hasta 500 documentos | Con ~470 documentos al mes, el envío directo a SUNAT ahorraría ~S/ 840 al año y costaría 60–120 h de desarrollo. Se deja un adaptador intercambiable para migrar más adelante |
| Envío directo a SUNAT (SEE-Del Contribuyente) | **No se implementa en el MVP.** Se deja como stub documentado detrás de la interfaz `EmisorCPE` | Se revisará si el volumen supera 500 documentos al mes de forma sostenida |
| Consulta RUC/DNI | API comercial (dos proveedores con fallback) + caché | RENIEC no ofrece una API pública abierta; su servicio oficial exige convenio y pago por consulta |
| Yape | QR estático en caja + registro del número de operación + conciliación al cierre | Yape no tiene API pública de cobros para comercios |
| Tarjetas Visa/Mastercard y QR | **POS Niubiz integrado** (el proveedor que ya usa el cliente). La caja envía el monto al terminal y recibe la confirmación automáticamente. Si la integración no está disponible, se usa el **modo manual**: se registran la marca, los últimos 4 dígitos y el número de voucher | Evita la doble digitación y los descuadres de caja, sin cambiar de proveedor |
| Impresión | Agente local propio en Node.js, con ESC/POS por TCP 9100 o USB | Imprime sin diálogos, funciona offline en la LAN y no requiere licencias de pago |
| Offline | PWA con IndexedDB y outbox + relevo por LAN a través del agente | Permite seguir atendiendo si se cae internet |

---

## 3. Stack obligatorio

- **Frontend:** Next.js 15+ (App Router), TypeScript en modo estricto, Tailwind CSS y shadcn/ui. Es una **PWA** con Service Worker (Serwist o Workbox), instalable en Android, iPad y Windows.
- **Estado y offline:** TanStack Query, más **Dexie (IndexedDB)** como caché local y cola de salida (*outbox*).
- **Backend:** Supabase (PostgreSQL 15+, Auth, Realtime, Storage, Vault y Edge Functions en Deno).
  - La lógica crítica (totales, cobro, emisión, cierre de caja, anulaciones) va en **funciones SQL/RPC transaccionales** o en Edge Functions. **Nunca** confíes en cálculos hechos solo en el cliente.
- **Seguridad de datos:** Row Level Security (RLS) en **todas** las tablas, filtrada por `local_id` y por rol.
- **Agente de impresión** (`apps/print-agent`):
  - Node.js 20 como servicio de Windows (NSSM) o Linux (systemd).
  - Usa `node-thermal-printer` o ESC/POS propio.
  - Se suscribe a `print_jobs` por Supabase Realtime, con polling de respaldo cada 5 s.
  - Expone un endpoint LAN para el modo offline (§10).
- **Pruebas:** Vitest (unidad), pgTAP o tests SQL (RLS y funciones), Playwright (E2E) y k6 (carga de realtime).
- **CI/CD:** GitHub Actions con lint, typecheck, tests y migraciones (`supabase db push`): primero a staging y luego a producción con aprobación manual.
- **Observabilidad:** Sentry (web, Edge Functions y agente), más UptimeRobot o Better Stack para los health checks.

### 3.1 Estructura del monorepo (pnpm + Turborepo)

```
/apps
  /web            → Next.js PWA (salón, caja, KDS, admin, reportes)
  /print-agent    → servicio local de impresión y relevo LAN
/packages
  /domain         → cálculos puros: precios, IGV, redondeo, descuentos, división de cuentas, fecha operativa
  /billing-adapter→ interfaz EmisorCPE + NubefactEmisor + SunatDirectoEmisor (stub)
  /id-lookup      → interfaz ConsultaDocumento + proveedores RUC/DNI
  /payments-adapter → interfaz ProcesadorPOS + NiubizProcesador + Simulador + Manual
  /ui             → componentes compartidos
/supabase
  /migrations     → SQL versionado
  /functions      → Edge Functions
  /seed           → datos semilla (mesas, carta, tasas, roles)
/docs             → runbooks y manuales por rol
DECISIONS.md
```

---

## 4. Roles y permisos

Roles base: `admin`, `cajero`, `mozo`, `cocina` y `auditor`.
- Un usuario puede tener roles distintos en cada local (`user_local_roles`).
- Los permisos son granulares (tabla `permissions`) y se asignan por rol (`role_permissions`).
- El admin puede crear roles nuevos.

| Permiso | admin | cajero | mozo | cocina | auditor |
|---|---|---|---|---|---|
| Configurar local, pisos, mesas, impresoras y series | ✔ | ✖ | ✖ | ✖ | ✖ |
| Crear y editar usuarios y planilla | ✔ | ✖ | ✖ | ✖ | ✖ |
| Crear y editar productos y categorías | ✔ | ✖ | ✖ | ✖ | ✖ |
| Modificar precios y menú del día | ✔ | Solo publicar la composición del menú (si se habilita) | ✖ | ✖ | ✖ |
| Abrir mesa, tomar pedido y enviar a cocina | ✔ | ✔ | ✔ | ✖ | ✖ |
| Cambiar, unir o separar mesas | ✔ | ✔ | ✔ (solo sus mesas) | ✖ | ✖ |
| Anular un ítem **no enviado** | ✔ | ✔ | ✔ | ✖ | ✖ |
| Anular un ítem **enviado** o una orden | ✔ (autoriza) | Solicita + PIN de admin | Solicita | ✖ | ✖ |
| Aplicar descuento libre o cortesía | ✔ | Solicita + PIN | ✖ | ✖ | ✖ |
| Registrar consumo de personal (15%) | ✔ | ✔ | ✔ | ✖ | ✖ |
| Pre-cuenta | ✔ | ✔ | ✔ | ✖ | ✖ |
| Cobrar y emitir comprobante | ✔ | ✔ | ✖ | ✖ | ✖ |
| Emitir nota de crédito o baja | ✔ | Solicita + PIN | ✖ | ✖ | ✖ |
| Abrir caja, corte X y cierre Z | ✔ | ✔ | ✖ | ✖ | ✖ |
| Ingresos y egresos de caja | ✔ | ✔ (egreso > S/ 100 pide PIN) | ✖ | ✖ | ✖ |
| Ver el KDS y marcar preparado o listo | ✔ | ✖ | Solo ver "listo" | ✔ | ✖ |
| Reportes (paloteo, liquidación, ventas) | ✔ | Solo su sesión | ✖ | ✖ | ✔ (solo lectura, todo) |
| Ver la bitácora de auditoría | ✔ | ✖ | ✖ | ✖ | ✔ |

### 4.1 Autenticación

- **admin y auditor:** email + contraseña + **MFA TOTP obligatorio**.
- **mozo, cajero y cocina:** inicio rápido en un **dispositivo registrado** con código de empleado + PIN de 4–6 dígitos.
  - Una Edge Function `pin-login` emite una sesión de Supabase de 12 h ligada al `device_id`.
  - El PIN se guarda con hash Argon2id o bcrypt; tras 5 intentos fallidos, se bloquea 15 min.
- **Autorización de supervisor:** las acciones sensibles piden el PIN de un admin en el mismo dispositivo, o envían una solicitud que el admin aprueba desde su celular (vía Realtime).
- **Dispositivos:** se registran con un token cuyo hash se guarda en `dispositivos.token_hash`. El admin puede revocarlos.

---

## 5. Modelo de datos (PostgreSQL)

**Convenciones:**
- PK `id uuid default gen_random_uuid()`, salvo que se indique otra cosa.
- Tablas operativas: `local_id`, `created_at timestamptz default now()`, `created_by uuid` y `updated_at`.
- Montos en `numeric(12,2)` y precios unitarios internos en `numeric(14,6)`.
- **Prohibido el borrado físico** en tablas transaccionales; usa `estado` o `anulado_at`.
- Usa enums de PostgreSQL o `check` constraints para los estados.

### 5.1 Organización y configuración
- `empresas`: ruc, razon_social, nombre_comercial, direccion_fiscal, ubigeo, regimen_igv `('MYPE_RESTAURANTE','GENERAL')`.
- `locales`: empresa_id, nombre, codigo_establecimiento_sunat (p. ej. `'0000'`), direccion, hora_corte_operativa (por defecto `05:00`), activo.
- `config_local`: local_id, descuento_personal_pct (por defecto **15**), umbral_dni_boleta (por defecto **700.00**), umbral_egreso_pin (por defecto 100.00), umbral_alerta_diferencia_caja (por defecto 20.00), propina_habilitada bool, modo_liquidacion_personal `('pago_inmediato','cuenta_empleado')`.
- `config_tributaria`: empresa_id null (null = global), regimen, vigencia_desde date, vigencia_hasta date null, tasa_igv, tasa_ipm, tasa_total, icbper_unitario. **Seeds:**
  - MYPE_RESTAURANTE 2026-01-01 → 2026-12-31: 0,08 / 0,025 / **0,105** / 0,50
  - MYPE_RESTAURANTE 2027-01-01 → null: 0,12 / 0,03 / **0,15** / 0,50
  - GENERAL: 0,16 / 0,02 / **0,18** / 0,50
- `config_plazos_cpe`: vigencia_desde, plazo_envio_factura_dias (3), plazo_envio_boleta_dias (5), plazo_resumen_dias (7), plazo_baja_dias (7), base_plazo_baja `('desde_cdr','desde_generacion')`. **Seeds:** hasta 2026-12-31 se usa `desde_cdr`; desde 2027-01-01, `desde_generacion`.
- `series_cpe`: local_id, tipo_cpe `('01','03','07','08')`, serie, ultimo_numero int, activa. **Seeds:** `F002`, `B002`, `FC02`, `BC02`.
  - Usa series distintas a las de SHIOL para no chocar correlativos; la numeración final la valida el contador.
  - La serie de contingencia queda configurable.
- `dispositivos`: local_id, nombre, tipo `('tablet_mozo','caja','kds','agente_impresion')`, token_hash, ultimo_ping, activo.
- `impresoras`: local_id, nombre, tipo_conexion `('tcp','usb')`, host, puerto, ancho_mm `(58,80)`, agente_id, estado `('ok','sin_papel','offline','error')`.
- `estaciones_produccion`: local_id, nombre (`Cocina`, `Parrilla`, `Bar`), impresora_id, muestra_kds bool.
- `feriados`: local_id null, fecha, descripcion, se_trata_como_domingo bool.

### 5.2 Plano de mesas
- `pisos`: local_id, nombre, orden, ancho_canvas, alto_canvas.
- `mesas`: piso_id, local_id, codigo text, nombre_visible, tipo `('mesa','barra','auxiliar','virtual_delivery','virtual_auditor','virtual_llevar','virtual_personal')`, capacidad, pos_x, pos_y, ancho, alto, forma `('rect','circle')`, rotacion, activa, estado `('libre','ocupada','precuenta','por_limpiar','bloqueada')`.
  - Restricción `UNIQUE(local_id, codigo)`.
  - El código es **texto libre**: `"01"` ≠ `"1"`.
- `mesa_uniones`: orden_id, mesa_id, es_principal bool. Una orden puede ocupar varias mesas.

### 5.3 Personas
- `empleados`: local_id, dni, nombres, apellidos, cargo `('mozo','cajero','cocinero','ayudante','barman','administrador','otro')`, fecha_ingreso, sueldo_base null, telefono, limite_consumo_mensual null, activo.
- `usuarios_perfil`: user_id → auth.users, empleado_id null, codigo_empleado unique, pin_hash, intentos_fallidos, bloqueado_hasta, activo.
- `roles`, `permissions`, `role_permissions`, `user_local_roles` (user_id, local_id, role_id).
- `clientes`: tipo_doc `('0','1','4','6','7')` según el catálogo 06, num_doc, nombre_razon_social, direccion, email, telefono, consentimiento_marketing bool, consentimiento_at.
- `doc_cache`: tipo_doc, num_doc, payload jsonb, proveedor, consultado_at. Restricción `UNIQUE(tipo_doc, num_doc)`.

### 5.4 Carta y precios
- `categorias`: local_id, nombre, orden, estacion_produccion_id_default.
- `productos`: local_id, categoria_id, codigo, nombre, descripcion, precio numeric(12,2) **IGV incluido**, afectacion_igv `('10','20','30')` (por defecto `'10'`), aplica_icbper bool, estacion_produccion_id, es_menu_del_dia bool, disponible bool, controla_stock bool, stock_actual null, imagen_url null.
- `producto_precio_historial`: producto_id, precio_anterior, precio_nuevo, motivo, cambiado_por, created_at. Se llena con un trigger cuando cambia `productos.precio`.
- `modificadores`: local_id, grupo (p. ej. "Término", "Entrada", "Segundo"), nombre, precio_extra ≥ 0, activo.
- `producto_modificadores`: producto_id, grupo, obligatorio bool, min, max.
- `reglas_precio_dia`: local_id, producto_id, dia_semana smallint (0 = domingo … 6 = sábado), precio, vigencia_desde, vigencia_hasta null.
- `menu_diario`: local_id, fecha, producto_id, entradas text[], segundos text[], postre, bebida, cantidad_disponible null, publicado bool.

### 5.5 Operación
- `ordenes`: local_id, numero_dia int, fecha_operativa date, tipo `('salon','delivery','llevar','personal','auditor')`, mesa_principal_id, mozo_id, comensales, cliente_id null, empleado_consumo_id null, estado `('abierta','precuenta','pagada','anulada')`, subtotal, descuento_total, total, nota, datos_delivery jsonb null, estado_delivery null, abierta_at, cerrada_at.
- `orden_items`: orden_id, producto_id, nombre_snapshot, cantidad numeric(8,2), precio_unitario_snapshot, modificadores jsonb, nota, descuento_pct, descuento_monto, total_linea, cuenta_split smallint default 1, estacion_produccion_id, comanda_id null, estado `('borrador','enviado','en_preparacion','listo','servido','anulado')`, enviado_at, anulado_at, anulacion_id null.
- `comandas`: orden_id, numero, estacion_produccion_id, enviada_por, enviada_at, reimpresiones int.
- `anulaciones`: local_id, nivel `('item','orden','comprobante')`, orden_id, orden_item_id null, comprobante_id null, motivo_codigo `('error_digitacion','cliente_desiste','demora','producto_agotado','calidad','otro')`, motivo_texto, merma bool, solicitada_por, autorizada_por, estado `('pendiente','aprobada','rechazada')`.
- `traslados_mesa`: orden_id, mesa_origen_id, mesa_destino_id, tipo `('mover','unir','separar','mover_items')`, items jsonb null, realizado_por.
- `descuentos_aplicados`: orden_id, orden_item_id null, tipo `('consumo_personal','cortesia','promocion','manual')`, porcentaje, monto, motivo, autorizado_por.
- `cuentas_empleado`: empleado_id, orden_id, monto, estado `('pendiente','liquidado')`, liquidacion_id null.
- `liquidaciones_empleado`: empleado_id, periodo_desde, periodo_hasta, total, forma `('cobro_caja','descuento_planilla')`, comprobante_id null, constancia_url null.

### 5.6 Caja y pagos
- `cajas`: local_id, nombre, dispositivo_id.
- `sesiones_caja`: caja_id, cajero_id, abierta_at, monto_apertura, cerrada_at null, estado `('abierta','cerrada')`, efectivo_esperado, efectivo_contado, desglose_denominaciones jsonb, diferencia, observaciones, numero_z.
- `cortes_caja`: sesion_caja_id, tipo `('X','Z')`, numero, totales jsonb, generado_por.
- `movimientos_caja`: sesion_caja_id, tipo `('ingreso','egreso')`, concepto `('sencillo','compra_insumos','pago_proveedor','adelanto_personal','retiro_gerencia','reembolso_cliente','ajuste','otro')`, descripcion, monto, sustento_url null, autorizado_por null.
- `pagos`: orden_id, sesion_caja_id, comprobante_id null, metodo `('efectivo','visa','mastercard','otra_tarjeta','yape','plin','qr_otro','transferencia','cuenta_empleado')`, canal `('manual','niubiz_integrado')`, monto, monto_recibido null, vuelto null, referencia (**obligatoria en Yape, Plin y tarjetas**; en el canal integrado se llena sola), ultimos4 null, codigo_autorizacion null, id_transaccion_pos null, transaccion_pos_id null → `transacciones_pos`, propina default 0, estado `('registrado','anulado')`.
- `terminales_pos`: local_id, caja_id, proveedor `'niubiz'`, store_id, checkout_id, numero_serie, alias, modo `('integrado','manual')`, activo.
- `transacciones_pos`: local_id, terminal_id, orden_id, sesion_caja_id, tipo `('venta','anulacion')`, monto, moneda `'PEN'`, estado `('creada','enviada_terminal','aprobada','rechazada','cancelada','expirada','error','pendiente_conciliacion')`, id_externo, codigo_autorizacion, marca, ultimos4, request jsonb, response jsonb, transaccion_original_id null (en anulaciones), intentos, created_at, resuelta_at.

### 5.7 Facturación electrónica
- `comprobantes`: local_id, orden_id, tipo_cpe, serie, numero, fecha_emision, cliente_tipo_doc, cliente_num_doc, cliente_nombre, cliente_direccion, moneda `'PEN'`, op_gravada, op_exonerada, op_inafecta, igv, icbper, total, tasa_igv_aplicada, documento_ref_id null, motivo_nc_codigo null, motivo_nc_texto null, estado `('borrador','pendiente_envio','enviado','aceptado','observado','rechazado','anulado_baja','emision_diferida')`, sunat_codigo, sunat_descripcion, hash, enlace_pdf, enlace_xml, enlace_cdr, proveedor `('nubefact','sunat_directo')`, request jsonb, response jsonb, intentos, proximo_intento_at, entregado_cliente bool.
  - Restricción `UNIQUE(local_id, tipo_cpe, serie, numero)`.
- `comprobante_items`: comprobante_id, descripcion, cantidad, unidad (`'NIU'` para bienes, `'ZZ'` para servicios), valor_unitario (sin IGV), precio_unitario (con IGV), igv, icbper, total, afectacion_igv.
- `bajas`: comprobante_id, tipo `('comunicacion_baja','resumen_anulacion')`, motivo, estado, ticket, response jsonb.
- `uso_cpe_mensual` (vista materializada o tabla): local_id, anio_mes, cantidad_01, cantidad_03, cantidad_07, cantidad_08, total.

### 5.8 Impresión, sincronización y auditoría
- `print_jobs`: local_id, impresora_id, tipo `('comanda','precuenta','comprobante','ticket_provisional','corte_x','corte_z','anulacion','traslado','movimiento')`, payload jsonb, estado `('pendiente','tomado','impreso','error')`, intentos, agente_id, error, impreso_at.
- `outbox_recibidos`: client_mutation_id uuid UNIQUE, dispositivo_id, tipo, payload, aplicado_at, resultado jsonb.
- `audit_log`: id bigserial, local_id, user_id, dispositivo_id, accion, entidad, entidad_id, antes jsonb, despues jsonb, ip inet, created_at.
  - **Append-only:** revoca UPDATE y DELETE a todos los roles y añade un trigger que lo bloquee incluso para `service_role`.
  - Lleva triggers en ordenes, orden_items, anulaciones, descuentos_aplicados, pagos, comprobantes, movimientos_caja, sesiones_caja, productos (precio), mesas, usuarios_perfil y user_local_roles.

### 5.9 Relaciones clave
- local 1–N pisos 1–N mesas; orden N–M mesas (vía `mesa_uniones`).
- orden 1–N orden_items N–1 comandas; orden 1–N pagos; orden 1–N comprobantes (cuentas divididas).
- comprobante tipo 07 → `documento_ref_id` → comprobante original.
- sesion_caja 1–N pagos, movimientos_caja y cortes_caja.
- empleado 1–N ordenes tipo `personal`, y 1–N cuentas_empleado.

---

## 6. Datos semilla del plano (según el croquis del cliente)

Crea los pisos y mesas con posiciones aproximadas en cuadrícula. El admin las ajustará luego arrastrándolas.

**Piso 1**
- Fila superior, tipo `auxiliar`: 70, 71, 72, 73, 74 y 75.
- Fila 2: 8, 9, 10 y 11.
- Fila 3: 08, 7, 6, 5 y 4.
- Fila 4: 01, 1, 2 y 3.
- Las mesas 1 a 11 son tipo `mesa` (11 mesas, coincide con la nota del cliente). Las mesas "01" y "08" son tipo `auxiliar`, contiguas a la 1 y a la 8.
- Mesas virtuales: `DELIVERY-1` (`virtual_delivery`) y `AUDITOR-1` (`virtual_auditor`), en la esquina inferior izquierda.

**Piso 2**
- Fila superior, tipo `auxiliar`: 60, 61, 62, 63, 64 y 65.
- Bloque izquierdo y centro: 19, 18, 17, 16 / 20, 21 / 23, 24, 15 / 22, 14 / 12, 13.
- Bloque derecho: 34, 33, 32 / 25, 31 / 26, 30 / 27, 29 / 28.
- Mesas virtuales: `DELIVERY-2` y `AUDITOR-2`.
- **Pendiente con el cliente:** hay 23 mesas numeradas (12 a 34) y la nota dice 24. Crea la mesa `35` **desactivada** como marcador y registra la pregunta en `DECISIONS.md`.

**Además:**
- Una mesa virtual `PERSONAL` (`virtual_personal`) y otra `LLEVAR` (`virtual_llevar`) por local.
- Pregunta pendiente para `DECISIONS.md`: qué son exactamente las series 60–65 y 70–75 (¿barra, terraza, otras?).

---

## 7. Módulos y casos de uso

Cada módulo debe cumplir sus criterios de aceptación (CA) antes de darse por terminado.

### M1. Configuración del local y plano de mesas (requisito "Crear mesas")
- **CU1.1:** el admin crea pisos y mesas en un editor tipo lienzo (react-konva o dnd-kit). Al arrastrar se guardan x, y, ancho, alto y rotación.
- **CU1.2:** renombrar, desactivar y crear mesas virtuales.
- **CU1.3:** vista del salón en tiempo real con un color por estado: libre (verde), ocupada (rojo), pre-cuenta (ámbar), por limpiar (gris) y bloqueada (negro). Cada mesa muestra los minutos desde su apertura, el mozo y el total acumulado. Hay pestañas por piso.
- **CA:** un cambio de estado en una tablet se ve en las demás en ≤ 2 s (p95), con 30 dispositivos conectados.

### M2. Planilla (requisito "Ingresar planilla")
- **CU2.1:** alta, baja y edición de empleados. Al ingresar el DNI se autocompletan los nombres vía `id-lookup`.
- **CU2.2:** vincular el empleado a un usuario del sistema (opcional).
- **CU2.3:** exportar el padrón a Excel.
- **Fuera de alcance:** el cálculo legal de planilla (PLAME, AFP/ONP).
- **CA:** un empleado con ventas o consumos no se puede borrar; solo se desactiva.

### M3. Carta y precios (requisitos "Ingresar platos y/o crear" y "Modificar precios")
- **CU3.1:** CRUD de categorías, productos, modificadores y estaciones de producción.
- **CU3.2:** cambio de precio individual o masivo (por porcentaje o por categoría), con motivo obligatorio. Queda en el historial y en la auditoría.
- **CU3.3:** marcar un producto como agotado; desaparece de las tablets al instante.
- **CA:** cambiar un precio no altera las órdenes abiertas, porque cada ítem guarda su `precio_unitario_snapshot`.

### M4. Usuarios y mozos (requisitos "Ingresos de mozos" y "Crear usuarios")
- **CU4.1:** el admin crea usuarios, asigna roles por local y define el PIN.
- **CU4.2:** el mozo inicia sesión con código + PIN en una tablet registrada.
- **CU4.3:** reporte de ventas por mozo y turno.
- **CA:** un mozo asignado solo a "Warike Urban" no ve las mesas ni los datos de "Warike Resto Grill" (verificado con tests de RLS).

### M5. Menú del día (requisito "Menú diario: lunes a sábado S/ 15, domingo S/ 18")
- **CU5.1:** el admin o cocina publica el menú del día, con sus entradas y segundos.
- **CU5.2:** el mozo agrega "Menú del día" y elige la entrada y el segundo como modificadores obligatorios.
- **Reglas:**
  - El precio sale de `reglas_precio_dia[dia_semana(fecha_operativa)]`; si no hay regla, se usa `productos.precio`.
  - Los feriados marcados como domingo usan el precio del domingo.
  - `fecha_operativa`: si la hora es anterior a `hora_corte_operativa`, cuenta como el día anterior.
- **Seeds:** lunes a sábado S/ 15,00; domingo S/ 18,00.
- **CA:** hay tests para los 7 días y para un feriado. El domingo a las 13:00 se cobra S/ 18,00; el lunes, S/ 15,00.

### M6. Toma de pedidos (requisito "Digitar")
- **CU6.1:** al abrir una mesa libre se indican los comensales y se crea la orden.
- **CU6.2:** agregar ítems por categoría o búsqueda, con cantidad, modificadores, nota y número de cuenta (para dividir).
- **CU6.3:** "Enviar" agrupa los ítems en `borrador` por estación. Se crea una comanda y un `print_job` por estación, los ítems pasan a `enviado` y aparecen en el KDS.
- **CU6.4:** reimprimir una comanda incrementa `reimpresiones` y queda en la auditoría.
- **CA:** la comanda sale impresa en ≤ 3 s. Muestra mesa, piso, mozo, hora y número de comanda, los ítems por estación, y los modificadores y notas en negrita.

### M7. Cocina (KDS)
- **CU7.1:** pantalla por estación con tickets ordenados por antigüedad y botones "En preparación" y "Listo". Alerta de color a los 15 y 25 min (configurable).
- **CU7.2:** el mozo recibe una notificación cuando un ítem pasa a "Listo".

### M8. Cambio de mesa (requisito "Cambiar mesas")
- **CU8.1 Mover:** pasar la orden completa de A a B (B debe estar libre). A queda "por limpiar" y B "ocupada".
- **CU8.2 Unir:** varias mesas en una orden; la mesa principal conserva el número.
- **CU8.3 Separar / mover ítems:** llevar ítems seleccionados a otra mesa u orden.
- Se permite cambiar de piso. Todo se registra en `traslados_mesa`.
- **CA:** al mover, se imprime un aviso ("Mesa 05 → Mesa 22") en las estaciones que tienen ítems pendientes de esa orden.

### M9. Anulación de pedidos
- **CU9.1:** un ítem en `borrador` se elimina sin autorización (queda en la auditoría).
- **CU9.2:** un ítem `enviado` o posterior exige motivo y autorización de admin. Se imprime "ANULACIÓN" en la estación, el KDS lo muestra tachado y el campo `merma` registra si hubo desperdicio.
- **CU9.3:** anular una orden completa sin pagos requiere admin.
- **CU9.4:** los comprobantes ya emitidos se anulan con el flujo F (§8).
- **CA:** el reporte de anulaciones por mozo, motivo y autorizador cuadra con `audit_log`.

### M10. Consumo de personal (requisito "Cargar al personal: 15% y visualizar consumos")
- **CU10.1:** orden tipo `personal` en la mesa `PERSONAL` (o en cualquier mesa), eligiendo al empleado.
- **CU10.2:** se aplica automáticamente el `descuento_personal_pct` (15%) a todos los ítems y se registra en `descuentos_aplicados`. Cambiarlo requiere admin.
- **CU10.3:** forma de liquidación según `modo_liquidacion_personal`:
  - `pago_inmediato`: cobro normal (flujo D) con boleta a nombre del empleado.
  - `cuenta_empleado`: se emite la boleta en el momento de la venta con el método de pago `cuenta_empleado` y se crea un registro en `cuentas_empleado`. Al final de la quincena o del mes, la liquidación se cobra en caja o se descuenta de la planilla con una constancia firmada.
  - **Toda venta al personal lleva comprobante.**
- **CU10.4:** reporte de consumos por empleado y rango de fechas, con alerta si se supera `limite_consumo_mensual`.
- **CA:** un consumo de S/ 40,00 queda en S/ 34,00 y aparece en el reporte del empleado y en su cuenta pendiente.

### M11. Mesa "Auditor"
- Mesa virtual para consumos de control: degustaciones, cortesías de gerencia y pruebas de calidad.
- Cada orden exige motivo y autorización de admin. Puede cerrarse como **cortesía** (100% de descuento, sin cobro y sin comprobante de venta).
- Tiene un reporte separado. Registra en `DECISIONS.md` que el tratamiento fiscal de las cortesías lo valida el contador.
- El rol `auditor` existe aparte, como usuario de solo lectura.

### M12. Pre-cuenta, cobro y pago mixto
- **CU12.1 Pre-cuenta:** se imprime el detalle con subtotales y la división por cuenta. La mesa pasa a `precuenta`; si se agregan ítems después, hay que volver a sacar la pre-cuenta.
- **CU12.2 Cobro:** admite N pagos con distintos métodos.
  - Efectivo: se ingresa el monto recibido y se calcula el vuelto.
  - **Tarjeta o QR por POS Niubiz integrado:** el cajero pulsa "Cobrar con POS" y el monto se envía al terminal de su caja (§10.2). Al aprobarse, el pago se registra solo, con marca, últimos 4 dígitos y código de autorización.
  - Tarjeta en modo manual (respaldo): voucher y últimos 4 dígitos.
  - Yape o Plin por QR fijo: número de operación.
  - **La suma de los pagos debe ser igual al total**; si no, no se puede emitir.
- **CU12.3 Dividir la cuenta:** por ítems o en partes iguales, con un comprobante por parte.
- **CU12.4 Propina:** opcional y configurable. Se registra aparte y no forma parte del comprobante.
- **CA:**
  - Un total de S/ 150 pagado con S/ 50 en Yape, S/ 60 con Visa por el POS integrado y S/ 40 en efectivo (recibido S/ 50, vuelto S/ 10) aparece correctamente por método y por canal en el corte X.
  - **No se puede emitir el comprobante mientras un pago integrado esté en estado `enviada_terminal`**: hay que esperar a que se apruebe, se rechace o se cancele.

### M13. Emisión de comprobantes (boletas y facturas)
- **CU13.1 Tipo de comprobante:**
  - **Boleta:** el DNI es opcional, pero obligatorio si el total supera `umbral_dni_boleta`.
  - **Factura:** RUC obligatorio, con validación del dígito verificador (módulo 11). Si el contribuyente no está "ACTIVO" y "HABIDO", se muestra una advertencia.
  - El RUC o el DNI se autocompletan vía `id-lookup`.
- **CU13.2 Cálculo:** se hace en `packages/domain` (ver §9).
- **CU13.3 Emisión:** se llama a `EmisorCPE.emitir()`.
  - Si se acepta: se guardan los enlaces PDF, XML y CDR, y se imprime el ticket con QR y hash.
  - Si hay error de red: el estado queda `pendiente_envio` y se reintenta (§7.1).
- **CU13.4:** enviar el comprobante por enlace de WhatsApp o por email.
- **CA:**
  - Sin saltos de correlativo: el número se reserva con `UPDATE series_cpe SET ultimo_numero = ultimo_numero + 1 … RETURNING` dentro de la misma transacción del cobro.
  - Con 50 emisiones concurrentes no hay duplicados ni huecos.

### M14. Nota de crédito y baja
- Sigue el flujo F (§8).
- **CA:** una NC por anulación total (motivo `01`) deja la orden `anulada`, revierte el paloteo y aparece con signo negativo en el corte.

### M15. Caja: apertura, corte parcial y cierre total (requisitos "Cierre e inicio de caja (parcial y total)" y "Retiros: ingresos y egresos")
- **CU15.1 Apertura:** se registra el monto inicial. No se puede cobrar sin una sesión abierta.
- **CU15.2 Corte X (parcial):** se puede sacar las veces que se quiera sin cerrar la sesión.
- **CU15.3 Cierre Z (total):**
  - Arqueo **ciego**: el cajero declara el efectivo por denominaciones sin ver el monto esperado. Billetes de S/ 200, 100, 50, 20 y 10; monedas de S/ 5, 2, 1, 0,50, 0,20 y 0,10.
  - El sistema calcula la diferencia.
  - Si quedan mesas abiertas, se bloquea el cierre, salvo que se transfieran al siguiente turno con autorización.
  - Se imprime el Z con número correlativo.
- **CU15.4 Ingresos y egresos:** con concepto, monto y foto opcional del sustento. Los egresos por encima de `umbral_egreso_pin` requieren PIN.
- **Fórmula:** `efectivo_esperado = monto_apertura + Σ pagos efectivo − Σ vueltos + Σ ingresos − Σ egresos`.
- **CA:**
  - El Z cuadra al céntimo con los pagos y movimientos de la sesión y se puede reproducir después.
  - Una sesión cerrada es inmutable; las correcciones se hacen con un movimiento `ajuste` en la sesión siguiente.

### M16. Reportes (requisitos "Paloteo" y "Liquidación para reportes de caja")
- **R1 Paloteo:** unidades vendidas por plato, categoría, fecha y turno (los menús se desglosan por segundo). Las anulaciones se muestran aparte.
- **R2 Liquidación de caja:** por sesión o por día. Totales por método de pago y por tipo de comprobante, notas de crédito, descuentos, consumo de personal, cortesías Auditor, ingresos, egresos y diferencia de arqueo.
- **R3:** ventas por mozo, por mesa o piso, y por hora.
- **R4 Estado SUNAT:** comprobantes pendientes, observados o rechazados, más el **uso mensual de documentos frente al plan contratado**.
- **R5:** historial de cambios de precio y de anulaciones.
- Todos se exportan a Excel/CSV y PDF.

### M17. Delivery y para llevar
- La orden va en una mesa virtual, con contacto y dirección (se informa la finalidad del uso de datos).
- Estados: en preparación, en camino y entregado.
- Producto "Bolsa plástica" con ICBPER cuando corresponda.

### M18. Multi-local (Warike Urban) — post-MVP, pero el modelo lo soporta desde el inicio
- Todo se filtra por `local_id`. El admin puede cambiar de local y ver reportes consolidados.
- Cada local tiene sus propias series y su código de establecimiento SUNAT.

### 7.1 Reintentos de emisión
- **Backoff:** 1, 2, 5, 10 y 30 min; luego cada 60 min.
- **Alertas al admin:**
  - una factura `pendiente_envio` por más de 24 h (el plazo SUNAT es de 3 días);
  - una boleta pendiente por más de 72 h;
  - cualquier comprobante `rechazado`.

---

## 8. Flujos detallados

**A. Apertura de mesa → pedido → cocina**
1. El mozo toca una mesa libre e indica los comensales. La RPC `abrir_orden(mesa_id, comensales, client_mutation_id)` crea la orden y marca la mesa `ocupada` en una sola transacción; si la mesa ya está ocupada, responde 409.
2. Los ítems agregados quedan en `borrador`, tanto en el cliente (Dexie) como en el servidor.
3. Al pulsar "Enviar", la RPC `enviar_comanda(orden_id, item_ids[])` agrupa por estación, crea las comandas y los `print_jobs`, y marca los ítems `enviado`.
4. El agente imprime y el KDS muestra la comanda. Cuando cocina marca "Listo", el mozo recibe la notificación.

**B. Cambio de mesa**
1. El mozo elige Mover, Unir o Separar y luego la mesa destino en el plano.
2. La RPC `trasladar_orden(orden_id, tipo, mesa_destino_id, item_ids?)` valida la operación, actualiza `mesa_uniones`, los estados de las mesas y `traslados_mesa`, e imprime el aviso.

**C. Anulación con motivo y autorización**
1. El usuario elige "Anular" e indica el motivo. Si el ítem ya fue `enviado`, se pide el PIN del supervisor o la aprobación remota.
2. La RPC `anular_item(item_id, motivo, autorizacion)` marca el ítem `anulado`, crea el registro en `anulaciones`, recalcula los totales, imprime "ANULACIÓN" y deja la auditoría.

**D. Pre-cuenta → cobro con pago mixto → comprobante**
1. `generar_precuenta(orden_id, modo_division)` imprime la pre-cuenta y pasa la mesa a `precuenta`.
2. En caja se elige el tipo de comprobante y el cliente (con lookup), y se agregan pagos hasta que el saldo sea 0.
3. La RPC `cobrar_y_emitir(orden_id, cliente, pagos[], items_split?)` hace todo en **una transacción**:
   - valida que la sesión de caja esté abierta y que la suma de pagos sea igual al total;
   - reserva el correlativo;
   - crea el comprobante con estado `pendiente_envio`, sus ítems y los pagos;
   - marca la orden como `pagada` (o parcialmente pagada si hay cuentas divididas pendientes).
4. Un `pg_net`, un webhook o una cola invocan la Edge Function `emitir_cpe(comprobante_id)`, que llama a `EmisorCPE`, actualiza el estado y crea el `print_job` del comprobante.
5. La mesa pasa a `por_limpiar` y el mozo la libera.

**E. Consumo de personal**
- Igual que el flujo D, pero con una orden tipo `personal`, el descuento automático y el método de pago `cuenta_empleado` cuando corresponde (ver M10).

**F. Nota de crédito o baja**
1. El admin elige un comprobante aceptado y pulsa "Anular/Corregir".
2. El sistema decide según `config_plazos_cpe`, vigente a la fecha:
   - Si `entregado_cliente = false` y está dentro del plazo de baja: ofrece la **baja**. En facturas es una comunicación de baja; en boletas va como anulada en el resumen diario.
   - En otro caso, emite una **NC tipo 07** con su motivo del catálogo 09 (`01` anulación de la operación, `07` devolución por ítem, `04` descuento global, `06` devolución total, etc.). La serie es FC02 o BC02 y referencia al comprobante original.
3. Revierte el paloteo. El reembolso en efectivo se registra como egreso `reembolso_cliente` en la sesión actual. Si el pago fue con el POS Niubiz integrado, se ofrece hacer el reverso en el terminal (§10.2). Las devoluciones por Yape o en modo manual se registran a mano con su referencia.
4. Requiere el permiso `emitir_nc` y queda en la auditoría.

**G. Caja:** apertura → cortes X → movimientos → cierre Z (ver M15).

---

## 9. Reglas de cálculo (`packages/domain`, cobertura de tests ≥ 90%)

- **Precio de carta:** incluye IGV.
- **Tasa:** la `tasa_total` vigente se toma de `config_tributaria` según el régimen de la empresa y la `fecha_emision`. **Nunca escribas la tasa directamente en el código.**
- **Por línea gravada:**
  - `valor_unitario = precio_unitario / (1 + tasa_total)`, calculado internamente con 10 decimales.
  - `valor_venta_linea = round2(valor_unitario × cantidad)`
  - `igv_linea = round2(total_linea − valor_venta_linea)`
- **Totales:**
  - `op_gravada = Σ valor_venta_linea`
  - `igv = Σ igv_linea`
  - `total = op_gravada + igv + icbper`
  - Si queda una diferencia de redondeo, se ajusta en la última línea.
- **Redondeo:** *half-up* a 2 decimales.
- **Descuentos por línea:** se aplican sobre el precio con IGV; la línea se envía con el valor unitario neto.
- **ICBPER:** cantidad de bolsas × `icbper_unitario`, fuera de la base del IGV (tributo 7152).
- **División en partes iguales:** el residuo de céntimos va a la primera parte.
- **Fecha operativa:** según `hora_corte_operativa` (ver M5).
- **Casos de prueba obligatorios:**
  - Tasas de 10,5%, 15% y 18% según la fecha y el régimen.
  - Descuento de personal del 15%.
  - Menú del día para los 7 días y un feriado.
  - División de cuentas.
  - Fórmula del arqueo.
  - ICBPER.

---

## 10. Facturación electrónica: adaptador

**Volumen esperado:** ~400 boletas + 50–60 facturas + notas de crédito ≈ **460–480 documentos al mes**.

1. **Interfaz `EmisorCPE`** (en `packages/billing-adapter`):
   ```ts
   interface EmisorCPE {
     emitir(cpe: ComprobanteDTO): Promise<ResultadoEmision>;      // estado, codigo, descripcion, enlaces, hash, qr
     consultar(tipo: string, serie: string, numero: number): Promise<ResultadoEmision>;
     anular(cpe: ComprobanteDTO, motivo: string): Promise<ResultadoBaja>; // baja o resumen
     emitirNota(nota: NotaDTO): Promise<ResultadoEmision>;
   }
   ```
2. **Implementación en producción: `NubefactEmisor`.**
   - Usa la API REST JSON de Nubefact; el plan es de hasta 500 documentos al mes.
   - Las credenciales (ruta y token por local) se guardan en **Supabase Vault** y solo se usan dentro de Edge Functions.
   - Ambientes: demo en staging, producción en prod.
3. **`SunatDirectoEmisor`:** stub documentado, **sin implementar en el MVP**.
   - Documenta en el código y en `docs/sunat-directo.md` lo que requeriría: SEE-Del Contribuyente; XML UBL 2.1; firma XAdES con Certificado Digital Tributario; SOAP `billService` (`sendBill`, `sendSummary`, `getStatus`); almacenamiento propio de XML y CDR en Storage, más un backup inmutable; resumen diario de boletas y comunicación de baja.
   - Cambiar de proveedor debe ser **solo configuración por local** (`locales.proveedor_cpe`).
4. **Control de uso del plan:**
   - Contador de documentos del mes en el panel de admin (`uso_cpe_mensual`).
   - Alerta al llegar a **400** documentos en el mes (80%) y a **475** (95%).
   - Reporte mensual por tipo (01, 03, 07, 08) para evaluar si conviene migrar al envío directo.
5. **Idempotencia:** antes de reenviar, consulta si la serie-número ya existe en el proveedor.
6. **Catálogos SUNAT:** mapea el 01 (tipo de documento), el 06 (documento de identidad), el 07 (afectación IGV), el 09 (motivos de NC) y el 05 (tributos, incluido el 7152 ICBPER).

### 10.2 Integración con el POS Niubiz (cobro con tarjeta y QR)

**Contexto:** el cliente ya opera con Niubiz. Niubiz ofrece un modo **"POS integrado"**: el software de caja envía la solicitud de cobro al terminal, el cliente paga ahí y el resultado vuelve al sistema. Sistemas comerciales peruanos (p. ej. Bsale) ya lo usan.

**Prerrequisitos (los gestiona el cliente con su ejecutivo de cuentas Niubiz):**
1. Activar el **modo POS integrado** en cada terminal.
2. Recibir el correo "Credenciales Integración Niubiz", que trae:
   - `client_id` y `client_secret`
   - código de comercio
   - usuario y clave
   - `storeId` (sucursal) y `checkoutId` (caja)
3. Recibir la **documentación técnica oficial de la API de POS integrado** y acceso a un ambiente de pruebas (QA).
   - **Esta documentación no es pública.** Mientras no llegue, implementa solo la interfaz y un simulador, y construye el adaptador real contra la documentación oficial. **No inventes endpoints.**
4. Confirmar con Niubiz la tarifa negociada y si los pagos QR por el terminal tienen otra comisión.

**Diseño:**
1. **Interfaz `ProcesadorPOS`** en `packages/payments-adapter`:
   ```ts
   interface ProcesadorPOS {
     iniciarCobro(req: { terminalId: string; monto: number; moneda: 'PEN'; referenciaInterna: string }): Promise<{ idExterno: string; estado: EstadoPOS }>;
     consultarEstado(idExterno: string): Promise<ResultadoPOS>;   // estado, codigoAutorizacion, marca, ultimos4
     cancelarCobro(idExterno: string): Promise<ResultadoPOS>;     // antes de que el cliente pague
     anularTransaccion(idExterno: string, monto: number): Promise<ResultadoPOS>; // reverso posterior
   }
   ```
   Implementaciones:
   - `NiubizProcesador`: la real, construida con la documentación oficial.
   - `SimuladorProcesador`: para desarrollo, pruebas E2E y demos. Aprueba, rechaza o expira según el monto (p. ej. un monto que termine en ,13 se rechaza).
   - `ManualProcesador`: modo de respaldo; el cajero digita el monto en el terminal y registra voucher y últimos 4 dígitos.
2. **Seguridad:** las credenciales van en **Supabase Vault**, por local y por terminal. Las llamadas a Niubiz se hacen **solo desde Edge Functions** (`pos-iniciar`, `pos-estado`, `pos-anular`), nunca desde el navegador.
3. **Datos de tarjeta:** el sistema **nunca recibe ni guarda el número completo de la tarjeta**; solo la marca, los últimos 4 dígitos y el código de autorización. La tarjeta se lee únicamente en el terminal. Por eso no es necesario certificar el sistema en PCI-DSS; documéntalo en `DECISIONS.md`.
4. **Asignación terminal–caja:** `terminales_pos.caja_id` define qué terminal usa cada caja. El `checkoutId` de Niubiz corresponde a esa caja.

**Flujo de cobro integrado:**
1. El cajero agrega un pago "Tarjeta/QR – POS" por un monto (puede ser parcial dentro de un pago mixto).
2. La RPC `crear_transaccion_pos(orden_id, terminal_id, monto, client_mutation_id)` crea un registro en `transacciones_pos` (estado `creada`) y llama a la Edge Function `pos-iniciar`, que pasa el estado a `enviada_terminal`.
3. La UI muestra "Esperando pago en el terminal…" con un botón **Cancelar** y consulta el estado cada 2 s, o recibe el webhook si Niubiz lo ofrece. El tiempo límite es de 120 s (configurable).
4. Resultado:
   - **Aprobada:** se crea el `pago` con canal `niubiz_integrado`, autorización, marca y últimos 4 dígitos. El saldo de la orden se actualiza.
   - **Rechazada, cancelada o expirada:** no se crea pago. Se muestra el motivo y se ofrece reintentar o cambiar de método.
   - **Error o sin respuesta:** el estado pasa a `pendiente_conciliacion`. **No se reintenta automáticamente** porque podría cobrarse dos veces. El cajero ve el monto en el terminal y elige "Sí se cobró" (pide código de autorización + PIN de supervisor) o "No se cobró".
5. Con todos los pagos completos, se sigue con la emisión del comprobante (flujo D).

**Anulaciones y devoluciones:**
- **Antes de emitir el comprobante:** si se anula una venta pagada por POS integrado, el reverso se hace con `anularTransaccion` y requiere PIN de supervisor.
- **Después de emitir:** el reverso en Niubiz **no reemplaza la nota de crédito ante SUNAT**. Son dos pasos independientes, ambos obligatorios:
  1. La NC o baja (flujo F).
  2. El reverso de la transacción en el POS, si aún procede según las reglas de Niubiz. Si no procede, se registra como devolución manual con su sustento.
- Las anulaciones en el POS se registran en `transacciones_pos` con tipo `anulacion` y quedan en `audit_log`.

**Conciliación y cierre de caja:**
- Los cortes X y Z muestran los cobros con tarjeta **por canal** (integrado o manual) y **por marca**.
- El Z se bloquea si hay transacciones en `enviada_terminal` o `pendiente_conciliacion`, salvo que un supervisor las resuelva.
- Reporte diario de conciliación: total de tarjetas en el sistema frente al cierre del terminal o la liquidación de Niubiz. Si Niubiz ofrece un reporte o API de liquidaciones, impórtalo; si no, permite cargar su archivo (CSV o Excel) y cruzarlo por código de autorización y monto.

**Modo offline:** sin internet, el terminal puede seguir funcionando con su propia conexión (SIM o red), pero el sistema no puede comunicarse con Niubiz. El cobro con tarjeta pasa automáticamente a **modo manual** y los pagos quedan marcados para conciliar.

**CA:**
- Con el simulador, un cobro aprobado se registra solo, en ≤ 3 s desde la aprobación.
- Un timeout nunca genera un pago duplicado.
- El Z cuadra con el total de transacciones aprobadas menos las anuladas.
- Con la integración desactivada, el modo manual funciona sin cambios en el resto del flujo.

---

## 11. Consulta de RUC y DNI

- **Interfaz `ConsultaDocumento`:** `ruc(numero)` y `dni(numero)`.
- **Orden de búsqueda:**
  1. `doc_cache`, con TTL de 30 días para RUC y 180 días para DNI.
  2. El proveedor primario.
  3. El proveedor secundario.
  4. Si ambos fallan, ingreso manual.
- **Ejecución:** solo desde la Edge Function `lookup-doc`, para no exponer los tokens, con un límite de 30 consultas por minuto por dispositivo.
- **Datos que se guardan:** solo los mínimos. Para RUC: razón social, dirección fiscal, estado y condición. Para DNI: solo el nombre.

---

## 12. Modo offline y resiliencia

1. **Red** (infraestructura, fuera del software): router con conmutación automática a un módem 4G.
2. **Cliente PWA:**
   - Guarda en caché la carta, las mesas, el menú del día, los usuarios del local y las reglas de precio.
   - Cada mutación lleva un `client_mutation_id` (UUID v7), se guarda en el outbox de Dexie y se aplica de forma optimista en la UI.
   - Al reconectar, el outbox se envía en orden y el servidor deduplica con `outbox_recibidos`.
3. **Relevo LAN** (agente de impresión):
   - El agente expone `https://agente.local:8443` con certificado propio instalado en los dispositivos, y los endpoints `/print`, `/relay` y un WebSocket de estado de mesas.
   - Sin internet, las tablets envían las comandas directo al agente, que imprime, guarda una cola en SQLite y, al volver internet, sube los eventos a Supabase.
4. **Cobro sin internet:**
   - Se registra el pago y se imprime un **ticket provisional "Pendiente de emisión electrónica"** con número interno. **No se imprime una boleta con correlativo.**
   - Al reconectar se emite el comprobante y se ofrece reimprimirlo o enviarlo por enlace.
   - Una factura offline solo se permite si el cliente acepta recibirla después.
   - La contingencia por caídas de más de 24 h se documenta en el runbook y la valida el contador.
- **CA:**
  - Con internet cortado 30 min se pueden abrir 10 mesas, enviar 30 comandas (impresas) y cobrar 10 cuentas.
  - Al reconectar no hay duplicados ni pérdidas, y los comprobantes pendientes se emiten en ≤ 5 min.

---

## 13. Impresión térmica

- **Plantillas ESC/POS de 80 mm y 58 mm:**
  - comanda: mesa en texto grande y corte parcial;
  - pre-cuenta;
  - comprobante: logo, RUC, dirección, serie-número, cliente, ítems, op. gravada, IGV con su tasa, ICBPER, total, importe en letras, métodos de pago, hash, QR y enlace de consulta;
  - ticket provisional;
  - cortes X y Z;
  - anulación, traslado y movimiento de caja.
- **Codificación:** página de códigos CP858 o PC850 para ñ y tildes. Prueba con Epson TM-T20 y modelos genéricos tipo Xprinter.
- **Cajón de dinero:** se abre con un pulso ESC p al cobrar en efectivo.
- **Estado:** el agente informa el estado de cada impresora (`sin_papel`, `offline`) y la caja muestra una alerta.
- **CA:** si una impresora está apagada, el trabajo queda `pendiente`, se reintenta y el admin puede redirigirlo a otra impresora.

---

## 14. Seguridad, anti-ransomware y protección de datos

1. **Ningún dato crítico vive en equipos locales.** El mini-PC del agente solo guarda una cola temporal cifrada y se puede reinstalar en 30 min con un script (`docs/runbook-agente.md`).
2. **MFA** en las cuentas de admin, auditor, Supabase, GitHub, Nubefact, el dominio y el correo. Mínimo dos administradores de la organización en la nube y códigos de recuperación guardados offline.
3. **RLS** en todas las tablas, con tests automatizados por rol. La `service_role` solo se usa dentro de Edge Functions.
4. **Backups 3-2-1:**
   - (a) backups diarios de Supabase;
   - (b) una GitHub Action nocturna con `pg_dump`, cifrado con age o GPG, subido a un bucket S3, B2 o R2 **de otra cuenta** con **Object Lock (modo compliance) de 35 días**;
   - (c) export semanal de comprobantes (PDF, XML y CDR) al mismo bucket.
5. **Restauración:** simulacro mensual en staging, con objetivos RTO de 2 h y RPO de 24 h.
6. **Dispositivos:**
   - Tablets en modo kiosco.
   - En la PC de caja: usuario sin privilegios de administrador, antivirus o EDR, y **ningún escritorio remoto (RDP/3389) expuesto a internet**.
7. **Auditoría:** `audit_log` append-only, retención de 5 años y exportación mensual al bucket inmutable. Hay un reporte de eventos sensibles: anulaciones, descuentos, cambios de precio, notas de crédito, diferencias de caja e inicios de sesión fallidos.
8. **Ley 29733 y su reglamento (D.S. 016-2024-JUS):**
   - política de privacidad (aviso en el ticket y en la web);
   - consentimiento separado para marketing;
   - minimización de datos (la dirección de delivery se borra o anonimiza a los 90 días);
   - procedimiento de incidentes con notificación a la ANPD dentro de 48 h;
   - registro de la transferencia internacional (Supabase en São Paulo);
   - un canal para los derechos ARCO.
9. **Secretos y dependencias:** secretos en Vault o en variables cifradas, rotados cada seis meses. Dependabot activo.
10. **Endurecimiento web:** cabeceras CSP y HSTS, y rate limiting en las Edge Functions.

### 14.1 Monitoreo y alertas
- `/api/health` revisa la base de datos, Nubefact y el último ping del agente; se consulta cada 1 min.
- Alertas al admin por WhatsApp, Telegram o email cuando:
  - el agente lleva más de 2 min offline;
  - hay comprobantes pendientes según §7.1, o alguno `rechazado`;
  - el uso de comprobantes llega a 400 o a 475 en el mes;
  - una diferencia de caja supera el umbral;
  - falla el backup nocturno;
  - el disco de la base de datos pasa del 80%.

---

## 15. Plan por fases (sprints de 1 semana)

| Fase | Semanas | Entregables | Criterio de salida |
|---|---|---|---|
| **0. Fundaciones** | 1 | Monorepo, CI, Supabase (staging y prod), esquema base, RLS, `pin-login`, seeds (mesas, carta, tasas, roles) | El login por rol funciona y los tests de RLS pasan |
| **1. Salón y cocina** | 2–3 | M1, M3, M4, M6, M7, M8, M9 y el agente de impresión | Simulacro de servicio con 5 tablets sin errores |
| **2. Caja y facturación** | 4–6 | M5, M10, M11, M12, M13 (Nubefact demo), M15, `id-lookup`, `ProcesadorPOS` con simulador y modo manual | 100 comprobantes de prueba aceptados en demo y el Z cuadra |
| **2b. POS Niubiz integrado** | En paralelo a las fases 3–4, cuando lleguen las credenciales y la documentación | `NiubizProcesador` contra el ambiente QA, conciliación de tarjetas y pruebas en el terminal real | 20 cobros y 3 anulaciones reales en QA sin descuadres |
| **3. Offline, NC y reportes** | 7–8 | §12, M14, M16, M17 | La prueba de corte de internet se aprueba |
| **4. Endurecimiento y paralelo** | 9–10 | Backups inmutables, monitoreo, manuales por rol, Nubefact en producción, **2 semanas operando en paralelo con el sistema vigente** | El cuadre diario coincide con el del sistema vigente y el simulacro de restauración sale bien |
| **5. Post-MVP** | 11+ | M18 (Warike Urban), inventario y recetas, conciliación asistida de Yape, dashboards, y evaluación de `SunatDirectoEmisor` si el volumen supera 500 documentos al mes | Según prioridad |

---

## 16. Estrategia de pruebas

- **Unitarias** (`domain`): todos los casos de §9.
- **Base de datos:**
  - RLS por rol y por local.
  - Concurrencia: si dos cajas cobran la misma orden, solo una debe poder hacerlo.
  - 50 emisiones concurrentes sin saltos ni duplicados de correlativo.
- **Integración:**
  - Nubefact en demo: boleta, factura, NC `01`, baja y un rechazo simulado.
  - `id-lookup` con mocks y su fallback.
  - POS: con el simulador, casos de aprobación, rechazo, cancelación, timeout y respuesta tardía (aprobación que llega después del timeout); después, pruebas en el ambiente QA de Niubiz.
- **E2E (Playwright)** con perfiles tablet y desktop: los flujos A a G completos.
- **Offline:** cortar la red en Playwright y en dispositivos reales, reconectar y verificar la idempotencia.
- **Carga (k6):** 40 clientes realtime y 200 ítems por minuto, con propagación p95 < 2 s.
- **Seguridad:**
  - un mozo intenta abrir reportes (debe fallar);
  - fuerza bruta del PIN (debe bloquearse);
  - restauración de un backup.
- **Aceptación con el cliente**, ejecutada por el admin y un cajero reales:
  1. Abrir la mesa 5 del piso 1 y pedir 2 menús un domingo; deben cobrarse a S/ 18.
  2. Enviar a cocina y a bar.
  3. Mover la cuenta a la mesa 22 del piso 2.
  4. Anular un ítem ya enviado con PIN de admin.
  5. Cobrar con pago mixto: Yape S/ 20 + Visa S/ 30 + el resto en efectivo.
  6. Emitir una factura con el RUC autocompletado.
  7. Emitir una NC.
  8. Registrar el consumo de un mozo con 15% de descuento y ver su reporte.
  9. Sacar un corte X y luego el Z.
  10. Desconectar internet y seguir tomando pedidos.

---

## 17. Despliegue y puesta en marcha

- **Entornos:** `staging` (con Nubefact demo) y `production`. Las migraciones van versionadas; **nunca edites la base de producción a mano**.
- **Frontend:** hosting con CDN (Vercel o Cloudflare Pages). Supabase en `sa-east-1`.
- **Agente:** instalador para Windows (servicio con NSSM) o systemd en Linux, con autoactualización desde GitHub Releases firmados.
- **Corte de sistema:**
  1. Cargar la carta, el personal y las mesas.
  2. Configurar las series nuevas (B002, F002, BC02, FC02), validadas por el contador.
  3. Operar en paralelo 2 semanas.
  4. Fijar la fecha de corte.
  5. Dejar de usar las series de SHIOL.
- **Runbooks** en `/docs`: caída de internet, impresora caída, Nubefact caído, restauración de backup, alta de dispositivo, cierre de mes y migración a `SunatDirectoEmisor`.

---

## 18. Costo de operación objetivo

| Concepto | Costo mensual aprox. |
|---|---|
| Supabase Pro | ≈ S/ 94 |
| Hosting del frontend | S/ 0–75 |
| Nubefact (hasta 500 documentos; volumen esperado de ~470) | S/ 70 |
| API de RUC/DNI | S/ 18–30 |
| Bucket de backups inmutables | S/ 5–20 |
| Dominio y monitoreo | S/ 5–10 |
| **Total** | **≈ S/ 200–300** (frente a los S/ 600 cotizados) |

Revisar el plan de Nubefact si el volumen supera 500 documentos al mes de forma sostenida.

---

## 19. Definición de terminado (global)

- Cada requisito del cliente tiene un caso de uso, tests y criterios de aceptación que pasan.
- Cero comprobantes rechazados en la última semana de operación en paralelo.
- El Z cuadra al céntimo con los pagos registrados.
- El simulacro de restauración y la prueba offline están documentados.
- Hay un manual de una página por rol, en español.
- `DECISIONS.md` está actualizado y las preguntas abiertas están resueltas con el cliente.

---

## 20. Preguntas abiertas (registrar en `DECISIONS.md`)

1. Piso 2: ¿hay 23 o 24 mesas? ¿Existe la mesa 35 o falta otra?
2. ¿Qué son las series 60–65 (piso 2) y 70–75 (piso 1): barra, terraza u otra zona?
3. ¿Las mesas "01" y "08" son extensiones de la 1 y la 8?
4. **Contador:**
   - ¿Warike califica para el IGV de 10,5% en 2026?
   - ¿Cómo se tratan fiscalmente las cortesías (Auditor) y el consumo de personal descontado por planilla?
   - ¿Qué series se usarán?
   - ¿Warike fue designado PRICO u obligado a usar OSE?
5. Política de propinas: ¿se registran en el sistema? ¿Se cobran por el POS?
6. **Niubiz** (lo gestiona el cliente con su ejecutivo):
   - activar el modo POS integrado en los terminales;
   - credenciales de integración y documentación técnica con ambiente QA;
   - tarifa negociada;
   - comisión de los pagos QR por el terminal;
   - cuántos terminales hay y en qué cajas.
7. "Warike Urban": ¿segundo local o solo un usuario? Confirmar.
