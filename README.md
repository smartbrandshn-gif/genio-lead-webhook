# Genio Lead Webhook

Webhook limpio para demos Genio: Voice Agent → email.

## Render

1. New **Web Service**, Node, root = this folder
2. Build: `npm install`
3. Start: `npm start`
4. Plan: Starter (~$7)
5. Environment variables (ver `.env.example` + `RENDER_SECRET.txt` local)

Health: `GET /health`  
Lead: `POST /webhooks/enviar-lead` con header `X-Lead-Secret`  
Pedido Wangs: `POST /webhooks/enviar-pedido` con header `X-Lead-Secret`  
Cancelar Wangs: `POST /webhooks/cancelar-pedido` con header `X-Lead-Secret`  
Pedido Mexcali: `POST /webhooks/mexcali/enviar-pedido` con header `X-Lead-Secret`  
Cancelar Mexcali: `POST /webhooks/mexcali/cancelar-pedido` con header `X-Lead-Secret`

### Pedido env

- `PEDIDO_TO_EMAIL` — destino de pedidos Wangs (si falta, usa `LEAD_TO_EMAIL`)
- Campos: `nombre_cliente`, `pedido_completo`, `notas` (opcional), `total_pedido`, `metodo_pago` (`Efectivo` | `Tarjeta`), `rtn` (requerido; `No` si no factura), `numero_cliente` / `caller_id` (número dictado, o `no` si no lo da). El email muestra **número de cliente**.

### Mexcali env

- `MEXCALI_PEDIDO_TO_EMAIL` — destino de pedidos/cancelaciones Mexcali (si falta, usa `sarmientod6@gmail.com` hardcodeado en `server.js`)
- Remitente: mismo SMTP (`SMTP_USER`), nombre `Pedido Mexcali`. Asuntos: `[Pedido Mexcali] <nombre> — <total>` y `[CANCELADO Mexcali] <nombre> — <total>`.
- Mismos campos y validación que Wangs (ver arriba); cancelación acepta además `motivo_cancelacion` (opcional).
- Las rutas Mexcali se registran con `registerRestaurantPedidoRoutes(...)` **antes** del handler 404.

### Rosso Napoletano
`POST /webhooks/pedido-rosso` (header `X-Lead-Secret`). `tipo`: `pedido` (default) | `reserva` | `ambos`. Siempre: `sucursal` (Foresta/Proceres), `nombre`, `telefono` (8 dígitos). Pedido: `tipo_pedido`, `pedido`, `total`, `necesita_rtn` (+ `rtn_numero`, `rtn_nombre` si true). Reserva: `reserva_nombre`, `reserva_personas`, `reserva_fecha`, `reserva_hora`. `notas` opcional.
Env: `ROSSO_FORESTA_TO_EMAIL`, `ROSSO_PROCERES_TO_EMAIL` (default `sarmientod6@gmail.com`). From: `"Rosso Napoletano Pedidos" <genionotificaciones@gmail.com>`.

### Prosperity Partners — hoja de reclamos (demo Marcela Morales / Regina)
`POST /webhooks/prosperity/hoja-reclamos` (header `X-Lead-Secret`). Body JSON: `nombre` (string, requerido), `correo` (string, requerido; acepta forma hablada «juan arroba gmail punto com»), `telefono` (opcional).
Envía `assets/prosperity/hoja-reclamos-gastos.pdf` adjunto a `correo` (asunto «Hoja de reclamos de gastos – Prosperity Partners», From `"Prosperity Partners" <genionotificaciones@gmail.com>`) y un aviso de copia a `PROSPERITY_COPY_EMAIL` (default `sarmientod6@gmail.com`).
Respuestas: `{ok:true, mensaje:"Hoja enviada a <correo>"}` · 400 `{ok:false, error:"correo_invalido"|"nombre_requerido"}` · 401 secreto inválido.
Pruebas locales sin enviar: `MAIL_DRY_RUN=1 MAIL_DRY_RUN_DIR=./.mail-dry-run node server.js` (guarda cada mensaje como JSON).

### Wangs — enviar menú por correo
`POST /webhooks/wangs/enviar-menu` (header `X-Lead-Secret`). Body JSON: `correo` (requerido; acepta forma hablada), `nombre` (opcional). Adjunta `assets/wangs/menu-wangs.pdf` como `Menu-Wangs.pdf` (From `"Wangs" <genionotificaciones@gmail.com>`, asunto «Menú de Wangs») y manda aviso de copia a `WANGS_MENU_COPY_EMAIL` (default `sarmientod6@gmail.com`, se omite si es el mismo destinatario). Respuestas: `{ok:true, mensaje:"Menú enviado a <correo>"}` · 400 `correo_invalido` · 401 secreto inválido.

### Power FM — registro de oyentes (agente Regina)
Código en `powerfm.js`. Todas con header `X-Lead-Secret`.
- `POST /webhooks/powerfm/buscar-oyente` — body: `caller_number` (System param de xAI, opcional), `nombre` y `fecha_nacimiento` (plan B, opcionales). Teléfono: solo dígitos, quita `504` si son 11, compara últimos 8 (también lee `X-Caller-Number`). Plan B: fecha exacta + nombre tolerante (sin tildes/mayúsculas, puede faltar un apellido, errores leves de voz). Responde `{ok, encontrado, metodo, nombre, primer_nombre, ciudad, telefono_detectado, mensaje}`. Loguea `caller_number` crudo y headers (sin secretos) como `[powerfm] buscar-oyente inbound`.
- `POST /webhooks/powerfm/registrar-oyente` — body: `nombre_apellido`, `ciudad`, `fecha_nacimiento`, `sexo`, `telefono` (o `caller_number`). Deduplica por teléfono (`ya_registrado:true`). `dry_run:true` valida sin guardar. 400 `datos_incompletos` con `faltan`.
- `GET /webhooks/powerfm/oyentes.csv` — exportación CSV. `GET /webhooks/powerfm/estado` — tipo de almacenamiento.

Almacenamiento: si existe `POWERFM_SHEET_URL` (+ `POWERFM_SHEET_TOKEN`) usa una Google Sheet vía Apps Script (`docs/powerfm-apps-script.gs`). Si no, archivo `POWERFM_DATA_FILE` (default `./data/powerfm-oyentes.json`), **que se borra en cada deploy/reinicio de Render** si no hay disco persistente. Cada registro queda además en el log `[powerfm] registro {...}`.

### Transmundo — consulta de Carlota
`POST /webhooks/pedido/Transmundo/consulta` (también `/webhooks/pedido-rosso/Transmundo/consulta`; header `X-Lead-Secret`). Body JSON: `nombre`, `telefono`, `telefono_confirmado` (boolean, debe ser true), `agente` (nombre del agente o `"Nuevo cliente"`), `tipo_cliente` (`frecuente` | `nuevo`), `consulta` (opcional en boletos si vienen `origen`/`destino`). Opcionales: `origen`, `destino`, `parada_intermedia` (ciudades y días, o `no`; también acepta `paradas` como respaldo; se parte por `;` o salto de línea; en el correo, una fila «Parada intermedia» por cada parada después de Destino (el mismo rótulo si hay varias); se muestra «No» si el valor es no y se oculta si viene vacío), `fecha_ida`, `fecha_regreso`, `adultos`, `ninos`, `visa`, `vacuna_fiebre_amarilla`, y los campos desglosados `tipo_consulta` (`boleto` | `otra`; si falta: boleto cuando hay origen/destino), `tipo_boleto` (`ida y vuelta` | `solo ida`), `personas`, `infantes` (`no` o cantidad), `tipo_vuelo` (`directo` | `con escala`), `horario` (`mañana` | `tarde` | `noche`…), `maleta_documentada` (sí/no), `personas_maleta` (número → «2 de 3»), `asiento` (`pasillo` | `ventana`…), `otra_consulta` (solicitud del cliente cuando no es boleto; se muestra como párrafo a ancho completo en la sección Solicitud del cliente, con `consulta` como respaldo).
Por defecto (`TRANSMUNDO_ROUTE_TO_AGENTS` apagado) **todos** los correos van solo a `TRANSMUNDO_TO_EMAIL` (default `sarmientod6@gmail.com`), con From `"Genio Notificaciones" <genionotificaciones@gmail.com>` y asunto `Compra de boleto aéreo – [nombre]` (o `Consulta – [nombre]` si no es boleto). Cuerpo por secciones (franja verde solo con fecha y hora; Cliente, Viaje, Pasajeros, Preferencias de vuelo, Requisitos / Solicitud del cliente); filas vacías se ocultan; sin filas de agente ni tipo de cliente. En modo prueba, una línea discreta al pie indica a qué correo real del agente iría. El mapa de agentes (`@transmundohn.com`) solo se usa como destino cuando `TRANSMUNDO_ROUTE_TO_AGENTS=1`. Clientes nuevos sin `TRANSMUNDO_NEW_CLIENT_EMAIL` siguen yendo a la bandeja de pruebas. `dry_run=true` valida y arma el correo sin enviarlo.
