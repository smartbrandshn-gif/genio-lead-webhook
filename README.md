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

### Pedido env

- `PEDIDO_TO_EMAIL` — destino de pedidos Wangs (si falta, usa `LEAD_TO_EMAIL`)
- Campos: `nombre_cliente`, `pedido_completo`, `notas` (opcional), `total_pedido`, `tipo` (`recoger` | `comer en restaurante`), `metodo_pago` (`Efectivo` | `Tarjeta`), `rtn` (requerido; `No` si no factura), teléfono del cliente (**opcional**) resuelto en orden: `body.caller_id` → header `X-Caller-Number` (system vars). Si falta, el email usa `Número de cliente: No disponible` y responde 200. `caller_id_dest_test` se loguea solo; nunca se usa `destination_number` como teléfono del cliente.
