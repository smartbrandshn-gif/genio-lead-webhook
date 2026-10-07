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
