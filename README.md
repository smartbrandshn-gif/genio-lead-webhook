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
