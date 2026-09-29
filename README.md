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
- Campos: `nombre_cliente`, `pedido_completo`, `notas` (opcional), `total_pedido`, `tipo` (`recoger` | `comer en restaurante`), `metodo_pago` (`Efectivo` | `Tarjeta`)
