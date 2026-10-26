# DECISIONS.md — Warike POS

Registro de decisiones, ambigüedades resueltas y preguntas abiertas (ver `docs/especificacion.md`, "Cómo usar este documento").
Cada decisión indica la sección de la especificación que la origina.

Estado: **Fase 0 (Fundaciones)** y **Fase 1 (Salón y cocina)** implementadas.

---

## Decisiones

### D-001 · Next.js 15.5 en lugar de 16 (§3)

La especificación pide Next.js 15+. Se usa la rama 15.5 porque `@serwist/next` se integra con el build de webpack, que es el predeterminado en 15.5 (Next 16 compila con Turbopack por defecto). Migrar a 16 queda para cuando Serwist lo soporte sin configuración extra.

### D-002 · Sesión PIN = sesión real de Supabase Auth, ligada al dispositivo en la base (§4.1)

`pin-login` (Edge Function) valida el dispositivo y el PIN con `pin_login_verificar` (SQL) y luego obtiene una sesión de Supabase Auth para el usuario: genera un enlace mágico con la API de admin y lo canjea en el acto (`verifyOtp`). Nunca se envía correo. El `session_id` del JWT se registra en `app.sesiones_dispositivo` con vencimiento a 12 h.

- La vigencia de 12 h y la revocación se aplican **en la RLS**: un rol sin MFA solo es efectivo si la sesión tiene una fila vigente en `app.sesiones_dispositivo`, de un dispositivo activo y del mismo local.
- Al desactivar un dispositivo, y cada 10 min (`pg_cron`), se borran las filas de `auth.sessions` vencidas o revocadas: el refresh token deja de servir.
- **Descartado:** firmar un JWT propio con el secreto del proyecto. Los proyectos nuevos de Supabase usan claves asimétricas y ese token no se podría revocar.
- **Implicación operativa:** el límite de Auth "token verifications" (30 cada 5 min por IP) se cuenta sobre la IP de la Edge Function. Hay que subirlo en el panel (p. ej. a 300) antes de operar; ver `docs/runbook-entornos.md`.
- Los usuarios que solo entran con PIN tienen un email sintético en un dominio reservado (`u-<código>@pin.warike.invalid`). Auth lo acepta en local; hay que confirmarlo en staging (P8).
- Cada enlace mágico nuevo invalida el anterior del mismo usuario. Si dos ingresos simultáneos se pisan (dos equipos o un doble toque), `pin-login` reintenta hasta 3 veces.
- Los cierres de sesión son de alcance `local`: cerrar en una tablet no cierra las sesiones del mismo usuario en otros equipos.

### D-003 · Cada tipo de rol exige su tipo de sesión, aplicado por la base (§4.1)

- `roles.requiere_mfa` (admin y auditor): solo son efectivos en sesiones `aal2`. Un admin que entra con contraseña sin TOTP, o con PIN, no ve ningún dato.
- Roles sin MFA (mozo, cajero, cocina): solo son efectivos en una sesión PIN vigente de un dispositivo registrado del mismo local. Un aal2 **no** los activa. Así, un mozo que enrole un TOTP o cambie su contraseña por su cuenta no obtiene acceso fuera de un dispositivo registrado, ni sesiones que escapen a la vigencia de 12 h y a la revocación.
- `mi_contexto()` devuelve `requiere_mfa` para que la PWA lleve al usuario al enrolamiento o a la verificación del TOTP.

### D-004 · El hash del PIN vive fuera de la API (§5.3)

`pin_hash`, `intentos_fallidos` y `bloqueado_hasta` se guardan en `app.pin_credenciales` (esquema privado, sin acceso para `anon` ni `authenticated`) y no en `usuarios_perfil`. Un PIN de 4–6 dígitos se rompe por fuerza bruta offline si su hash se filtra. El hash es bcrypt (`pgcrypto`, costo 10). Además se rechazan los PIN triviales (todos los dígitos iguales o en secuencia).

### D-005 · Bloqueo de PIN y conteo de intentos en SQL (§4.1)

`pin_login_verificar` bloquea la fila de credenciales (`for update`) para contar los intentos sin carreras: 5 fallos seguidos bloquean 15 min, y un ingreso correcto reinicia el contador. Todo intento fallido, bloqueo e ingreso queda en `audit_log` (§14.7, "inicios de sesión fallidos").

- **Los códigos de empleado son identificadores, no secretos** (como un nombre de usuario). Ante un PIN incorrecto se informan los intentos restantes y el bloqueo, para que el personal sepa qué pasa. Eso permite distinguir qué códigos existen, pero probar códigos exige un dispositivo registrado y el bloqueo es por usuario. Ocultarlo empeoraría la operación en caja sin una ganancia real.
- La Edge Function limita en memoria a 20 intentos por minuto por IP y dispositivo (§14.10). Es de mejor esfuerzo: la IP sale de `X-Forwarded-For`, que el cliente puede alterar. La protección real es el bloqueo por usuario en la base. Una IP mal formada se guarda como null y no hace fallar el ingreso.

### D-006 · Escrituras: RPC para lo transaccional, RLS por columna para la configuración (§3, §5)

- Las tablas transaccionales (órdenes, ítems, pagos, comprobantes, caja, POS, impresión, outbox, auditoría) no tienen INSERT/UPDATE/DELETE para clientes: se escriben con RPC `SECURITY DEFINER` (fases 1–2) o desde Edge Functions.
- Las tablas de catálogo y configuración se editan directo con RLS por permiso, y con privilegios por columna: `mesas.estado`, `productos.precio` y `series_cpe.ultimo_numero` no son editables desde la API.
- Cambiar `productos.precio` exige motivo (`warike.motivo_cambio_precio`) y llena `producto_precio_historial` con un trigger.
- `dispositivos.token_hash` no se puede leer desde la API.

### D-007 · Aislamiento por local con FK compuestas (§5, M18)

Las tablas hijas repiten `local_id` y referencian al padre con `(id, local_id)`, así que es imposible mezclar datos de dos locales aunque una RPC tenga un error. Las políticas filtran con `local_id in (select app.locales_con_permiso('…'))`; el `select` se evalúa una sola vez por consulta.

### D-008 · Tablas sin `local_id` (§5.3)

- `clientes` lleva `empresa_id`: se comparte entre los locales de una empresa.
- `doc_cache` y `outbox_recibidos` no son accesibles para clientes; solo las usan las Edge Functions y las RPC.
- `outbox_recibidos` lleva `local_id` para cumplir la regla general.

### D-009 · Columnas agregadas al modelo (§5)

| Columna                                                              | Motivo                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `locales.proveedor_cpe`                                              | §10.3: cambiar de emisor es configuración por local              |
| `series_cpe.es_contingencia`                                         | §5.1: serie de contingencia configurable                         |
| `usuarios_perfil.nombre_visible`                                     | Mostrar el mozo en mesas y comandas sin exponer la planilla      |
| `productos.activo`, `categorias.activa`, `cajas.activa`              | Retirar sin borrado físico ("agotado" sigue siendo `disponible`) |
| `mesa_uniones.liberada_at`, `created_by`                             | Historial de uniones y traslados sin borrar filas                |
| `comprobante_items.orden_item_id`                                    | Revertir el paloteo y emitir NC por ítem (M14)                   |
| `anulaciones.resuelta_at`                                            | Saber cuándo se aprobó o rechazó                                 |
| `local_id`, `created_at`, `created_by`, `updated_at` en tablas hijas | Convención de §5 y D-007                                         |

### D-010 · Borrar un ítem en borrador = marcarlo anulado (CU9.1)

Por la prohibición de borrado físico, "eliminar" un ítem en `borrador` lo deja en estado `anulado` con `anulado_at`, sin fila en `anulaciones` y sin autorización. Queda en la auditoría.

### D-011 · Roles base inmutables desde la API; roles propios por empresa (§4)

Los roles base (`empresa_id` null) solo cambian por migración. El admin crea roles de su empresa con los permisos que necesite. Por ejemplo, "cajero que publica el menú" se crea como un rol propio que suma `publicar_menu`, tal como prevé §4 ("si se habilita").

### D-012 · Permiso `publicar_menu` para cocina (M5 frente a §4)

La tabla de §4 marca ✖ para cocina en "Modificar precios y menú del día", pero CU5.1 dice "el admin o cocina publica el menú del día". Se separaron dos permisos:

- `modificar_precios`: solo admin.
- `publicar_menu`: admin y cocina.

### D-013 · Datos de referencia en migraciones; datos del cliente en `supabase/seed` (§3.1)

- Permisos, roles, tasas y plazos van en migraciones porque producción los necesita.
- El local, el plano, la carta y las series están en `supabase/seed/00_warike_resto_grill.sql`. Es idempotente y se aplica a mano en staging y producción.
- Los usuarios y dispositivos de prueba están en `supabase/seed/dev/` y **solo** se cargan en local.

### D-014 · Valores provisionales en la semilla

- RUC `20000000001`, razón social y dirección quedan marcados "POR CONFIRMAR".
- No se siembran feriados: cambian el precio del menú (domingo) y los define el admin.
- La "Bolsa plástica" se siembra a S/ 0,00 más ICBPER; el precio y la afectación los valida el contador.
- La carta real reemplaza a los productos "(EJEMPLO)".

### D-015 · Planilla visible solo para admin y auditor (§4, Ley 29733)

`empleados` (incluye `sueldo_base`) solo es legible con `gestionar_usuarios` o `ver_reportes`. Para elegir al empleado en el consumo de personal (M10, fase 2) se usará una RPC que devuelva solo id y nombre.

### D-016 · El cajero solo ve sus propias sesiones de caja (§4: "Reportes: solo su sesión")

Lo aplica la RLS de `sesiones_caja`, `cortes_caja` y `movimientos_caja`. Quien tiene `ver_reportes` ve todas.

### D-017 · El service worker no cachea respuestas de Supabase (§12, §14)

Las respuestas de la API llevan datos del usuario y las tablets son compartidas. El modo offline (fase 3) usará Dexie de forma explícita.

### D-018 · No se requiere certificación PCI-DSS (§10.2)

La tarjeta se lee únicamente en el terminal Niubiz. El sistema nunca recibe ni guarda el número completo: solo la marca, los últimos 4 dígitos (CHECK `^[0-9]{4}$`) y el código de autorización. Con esto el sistema queda fuera del alcance de PCI-DSS; conviene confirmarlo con Niubiz al recibir la documentación.

### D-019 · Cortesías de la mesa Auditor (M11)

El tratamiento fiscal de las cortesías (100 % de descuento, sin comprobante de venta) **lo valida el contador** antes de habilitarlas en producción (P4).

### D-020 · Inmutabilidad de `audit_log` y sus límites (§5.8, §14.7)

- Triggers `BEFORE UPDATE/DELETE/TRUNCATE` bloquean cualquier cambio, incluso de `postgres` y `service_role`, y además se revocan esos privilegios.
- El dueño de la tabla podría desactivar los triggers con una migración. El control es la revisión obligatoria de migraciones en CI, más la exportación mensual al bucket inmutable (fase 4).
- La bitácora excluye los datos sensibles o voluminosos: `token_hash`, `ultimo_ping`, y el `request`/`response` de Nubefact y Niubiz.
- `print_jobs` y `outbox_recibidos` no permiten borrado físico (borrar el outbox permitiría reaplicar mutaciones offline), pero no llevan trigger de auditoría: ya son un registro, y `print_jobs` cambia de estado en cada impresión. Una futura purga por antigüedad se hará con una migración explícita.
- Los eventos sin local (perfiles, roles) solo los ve quien audita un local donde el autor o el usuario afectado tiene un rol.

### D-021 · Pruebas de base de datos con pgTAP (§3, §16)

- En CI se ejecutan con `supabase test db`.
- `scripts/pgtap-psql.sh` ejecuta los mismos archivos con `psql`, para cuando no se puede descargar la imagen de `pg_prove`.
- Las pruebas crean sus propios datos dentro de una transacción con rollback.

### D-022 · Supabase staging y producción se crean con la cuenta del cliente (§2, §15)

Crear los proyectos de Supabase (plan Pro, `sa-east-1`) genera costos y debe hacerse con la cuenta y el MFA del cliente. Los pasos están en `docs/runbook-entornos.md`; el workflow de despliegue se omite solo hasta que existan los secretos.

### D-023 · Node.js 24 LTS en lugar de Node.js 20 (§3)

La especificación pide Node.js 20 para el agente de impresión, pero:

- Node 20 terminó su soporte en abril de 2026 y GitHub Actions ya lo marca como obsoleto.
- `@supabase/supabase-js` 2.118 exige Node 22 o superior para Realtime (WebSocket nativo), y el agente se suscribe a `print_jobs` por Realtime.

Se usa Node 24 LTS en CI y en `.nvmrc`; `engines` exige `>=22.12`.

### D-024 · Las mesas virtuales esperan a sus módulos (M10, M11, M17)

Las mesas `virtual_*` (delivery, para llevar, personal, auditor) ya existen en el modelo y el editor del plano las crea (CU1.2), pero su operación pertenece a los módulos de las fases 2 y 3. En la fase 1, `abrir_orden` las rechaza (`mesa_virtual_no_disponible`) y el salón no las muestra.

### D-025 · Los ítems sin estación no van a cocina

Un producto cuya categoría no tiene estación (p. ej. la bolsa plástica) no genera comanda: al enviar pasa directo a `servido`. Así no queda "enviado" para siempre esperando a una cocina que no lo prepara.

### D-026 · Una orden que nunca llegó a cocina la cancela el mozo (CU9.3)

CU9.3 exige admin para anular una orden "sin pagos". Si ningún ítem se envió, no hay nada que cocina deba dejar de preparar ni riesgo de fraude: el mozo la cancela con `anular_item_borrador` (motivo por defecto `error_digitacion`) y la mesa queda libre. Con ítems enviados se exige el motivo y la autorización de admin (con su sesión, su PIN en la tablet o la aprobación remota).

### D-027 · Cocina también marca agotados (CU3.3)

CU3.3 no dice quién marca un producto agotado. Quien sabe que algo se acabó es cocina, así que `marcar_disponibilidad` acepta `gestionar_carta` (admin) u `operar_kds` (cocina). El KDS tiene el botón "Agotados".

### D-028 · Autorización de supervisor con PIN: token de un solo uso (§4.1, flujo C)

El supervisor digita su código y PIN en la tablet del mozo (`autorizar_con_pin`). Se emite una autorización de un solo uso, válida 2 minutos, atada al permiso (`autorizar_*`), al local y a quien la pidió; la RPC sensible la consume (`app.autorizador`). El PIN usa el mismo conteo de intentos y bloqueo que el ingreso (`app.comprobar_pin`) y queda en la auditoría. La alternativa remota es una solicitud `pendiente` que el admin aprueba en `/admin/aprobaciones`; las tablets la ven por Realtime.

### D-029 · Errores de las RPC con estado HTTP y código estable

Las RPC fallan con SQLSTATE `PTxxx` (PostgREST responde con ese estado HTTP), el mensaje para la persona en `message` y un código estable en `details` (`mesa_ocupada`, `requiere_autorizacion`…). La PWA decide por el código; las pruebas pgTAP comparan `SQLSTATE:código`.

### D-030 · Idempotencia de las mutaciones de salón desde la fase 1 (§12.2)

`abrir_orden`, `agregar_items`, `enviar_comanda`, `trasladar_orden`, `anular_item`, `anular_orden` y `solicitar_anulacion` aceptan `client_mutation_id` (UUID v7) y lo registran en `outbox_recibidos` con un bloqueo consultivo: un reenvío devuelve el mismo resultado sin repetir el efecto. La PWA reintenta con el mismo id si se corta la conexión. El outbox en Dexie y el trabajo sin internet llegan con la fase 3.

### D-031 · Agente de impresión con usuario técnico por dispositivo (§3, §13, §14.3)

- El agente nunca recibe la `service_role`. Entra con el token de su dispositivo (tipo `agente_impresion`) por la Edge Function `agente-login`, que la primera vez crea un usuario técnico con el rol `agente_impresion` (único permiso: `imprimir`). La sesión queda ligada al dispositivo por 24 h y se renueva sola; revocar el dispositivo la corta.
- Toma trabajos con `FOR UPDATE SKIP LOCKED` (solo de sus impresoras). Un fallo vuelve el trabajo a la cola con espera creciente (5 s a 60 s); tras 20 intentos queda en `error` para que el admin lo redirija (CA §13). Un trabajo tomado y no reportado en 2 minutos se vuelve a entregar.
- Antes de imprimir consulta el sensor de papel (`DLE EOT 4`); si la impresora no lo implementa, imprime igual.
- El relevo LAN con cola en SQLite (§12.3) es parte del modo offline de la fase 3; la autoactualización desde GitHub Releases (§17), de la fase 4.

### D-032 · El menú del día se puede publicar desde la fase 1 (M5)

M5 está en la fase 2, pero el menú del día es el plato más vendido: sin él, el simulacro de servicio no representa un día real. Se adelantó lo mínimo: la validación de entrada y segundo contra el menú publicado al pedir (`agregar_items`), el precio por día que ya traía la semilla y la pantalla de publicación (`/admin/menu`, admin o cocina por D-012). Las reglas de precio por día se editan en la fase 2.

### D-033 · Planilla mínima junto con usuarios (M2)

§15 no asigna M2 a ninguna fase, y M4 vincula usuarios con empleados. Se incluyó lo mínimo de M2: alta, edición, baja lógica (no hay borrado, CA M2) y exportación a Excel (CSV con BOM y `;`). El autocompletado por DNI usa `id-lookup`, que llega en la fase 2.

### D-034 · Sin descuento de stock

`productos.controla_stock` existe en el modelo, pero el inventario es post-MVP (§15, fase 5). Agotado es una marca manual (CU3.3).

### D-035 · Separar una mesa unida sin ítems la deja por limpiar

CU8.3 habla de llevar ítems a otra mesa. Separar una mesa unida sin elegir ítems la desocupa y la marca `por_limpiar` (los clientes estuvieron ahí); con ítems, esos ítems pasan a una orden nueva en esa mesa.

### D-036 · Alta de usuarios en dos pasos (CU4.1)

Crear la cuenta de Auth necesita la `service_role`, que solo vive en Edge Functions (§14.3). `admin-usuarios` valida primero con la sesión del admin (`validar_alta_usuario`: `gestionar_usuarios`, MFA, rol asignable en ese local), crea la cuenta y luego el perfil, el rol y el PIN en una transacción (`crear_perfil_usuario`); si el perfil falla, borra la cuenta recién creada. El rol técnico del agente no se asigna a personas, ni por la función ni por la API (política de `user_local_roles`).

### D-037 · El KDS agrupa por comanda y muestra lo anulado

Cada ticket es una comanda de una estación, ordenada por antigüedad, con alerta amarilla y roja configurable (`config_local.kds_alerta_amarilla_min` y `kds_alerta_roja_min`, 15 y 25 min por defecto). Lo anulado en los últimos 30 minutos se ve tachado (CU9.2): dentro del ticket si este sigue en preparación, o en una franja aparte si no.

### D-038 · react-konva de la rama 19.2

El editor del plano usa react-konva (CU1.1). Next 15.5 trae su propio React 19.2 para el App Router, y react-konva 19.3 exige React 19.3 en tiempo de ejecución; se fija la rama 19.2. El editor se carga solo en el navegador y el paquete opcional `canvas` de Konva se excluye del build del servidor.

### D-039 · Latencia del salón medida en el simulacro; la carga con 30 equipos va con k6

La CA de M1 pide ≤ 2 s (p95) con 30 dispositivos. El simulacro E2E de 5 tablets (criterio de salida de la fase 1) mide la propagación entre tablets y falla si supera 2 s (en local, alrededor de 0,6 s). La prueba de carga de Realtime con 30 conexiones usa k6 (§3) y se ejecuta en la fase 4 (endurecimiento) contra staging, donde la red y la infraestructura son las reales.

### D-040 · Cálculos de salón en `packages/domain` y en SQL

El total de línea, la fecha operativa, el precio vigente (con feriados como domingo) y la validación de modificadores están en `packages/domain` (cobertura del 100 %) para que la PWA muestre lo mismo que cobrará el servidor, y en SQL (`agregar_items`, `app.precio_vigente`, `app.fecha_operativa`), que es la autoridad. El total de la orden en la fase 1 es la suma de líneas; descuentos e IGV llegan con la caja.

---

## Preguntas abiertas

| #   | Pregunta                                                                                                                                                                                        | Para             | Estado  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------- |
| P1  | Piso 2: ¿hay 23 o 24 mesas? ¿Existe la mesa 35 o falta otra? (sembrada la 35 desactivada)                                                                                                       | Cliente          | Abierta |
| P2  | ¿Qué son las series 60–65 (piso 2) y 70–75 (piso 1): barra, terraza u otra zona? (sembradas como `auxiliar`)                                                                                    | Cliente          | Abierta |
| P3  | ¿Las mesas "01" y "08" son extensiones de la 1 y la 8?                                                                                                                                          | Cliente          | Abierta |
| P4  | ¿Warike califica para el IGV de 10,5 % en 2026? ¿Tratamiento fiscal de cortesías y del consumo de personal descontado por planilla? ¿Series definitivas? ¿Fue designado PRICO u obligado a OSE? | Contador         | Abierta |
| P5  | Propinas: ¿se registran en el sistema? ¿Se cobran por el POS?                                                                                                                                   | Cliente          | Abierta |
| P6  | Niubiz: modo POS integrado, credenciales y documentación con ambiente QA, tarifa, comisión de QR, cantidad de terminales y en qué cajas                                                         | Cliente / Niubiz | Abierta |
| P7  | "Warike Urban": ¿segundo local o solo un usuario? (no sembrado; el modelo ya es multi-local)                                                                                                    | Cliente          | Abierta |
| P8  | Confirmar en staging que Auth acepta el dominio reservado `pin.warike.invalid` para los usuarios de PIN, o definir uno propio                                                                   | Equipo           | Abierta |
| P9  | RUC, razón social, dirección fiscal, ubigeo y dirección del local para reemplazar los valores provisionales                                                                                     | Cliente          | Abierta |
| P10 | Feriados que se cobran como domingo (menú a S/ 18)                                                                                                                                              | Cliente          | Abierta |
| P11 | Turnos para el reporte de ventas por mozo (CU4.3): ¿mañana/tarde/noche con qué horas? Mientras tanto, el turno es la fecha operativa                                                            | Cliente          | Abierta |
| P12 | Modelos de las impresoras de cocina, parrilla y bar: confirmar que aceptan `ESC t 19` (CP858) y la consulta de papel `DLE EOT`                                                                  | Equipo           | Abierta |

---

## Propuestas fuera de alcance

_Ninguna por ahora._
