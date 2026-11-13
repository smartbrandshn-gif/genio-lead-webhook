// Casos para snapshot de correos (todas las sucursales del flujo rosso). Solo local, sin SMTP.
const base = { tipo: "pedido", nombre: "Ana Perez", telefono: "99887766", telefono_confirmado: true, comentario_cliente: "Ninguno", metodo_pago: "", notas: "" };
export const GOLDEN_CASES = {
  manzano_recoger: { ...base, sucursal: "Manzano", tipo_pedido: "Para recoger", pedido: "Recoger:\n1 Carne 8 oz — 395 lempiras\n-Término\n•Tres cuartos\nPago: Efectivo", total: 395 },
  manzano_parrilla_inline: { ...base, sucursal: "Manzano", tipo_pedido: "Delivery", pedido: "Delivery: 1 Tradicional Parrilla Duo con Papas y Yuca | 2 Limonada — 120 lempiras. Pago: Tarjeta. RTN: 08011999123456, a nombre de Ana Perez", total: 900 },
  manzano_comer_temporada: { ...base, sucursal: "Manzano", tipo_pedido: "comer en el restaurante", pedido: "Comer en el restaurante: 1 Langosta — precio de temporada; 1 Proteína: Camarón", total: 0 },
  manzano_evento: { ...base, tipo: "reserva", sucursal: "Manzano", tipo_evento: "Cumpleaños", reserva_nombre: "Ana", reserva_personas: 20, reserva_fecha: "20 de noviembre", reserva_hora: "7 pm" },
  rosso_foresta_pedido: { ...base, sucursal: "Foresta", tipo_pedido: "recoger", pedido: "1 Pizza Margarita, 2 Coca Cola y una Lasaña", total: 500 },
  rosso_proceres_reserva: { ...base, tipo: "reserva", sucursal: "Proceres", reserva_nombre: "Ana", reserva_personas: 4, reserva_fecha: "viernes", reserva_hora: "8 pm" },
  rosso_ambos: { ...base, tipo: "ambos", sucursal: "Foresta", tipo_pedido: "comer en el restaurante", pedido: "1 Pizza Pepperoni; 1 Tiramisú", total: 400, reserva_nombre: "Ana", reserva_personas: 2, reserva_fecha: "sábado", reserva_hora: "7 pm", notas: "ventana" },
  tuchi_pedido: { ...base, sucursal: "Tuchi", tipo_pedido: "recoger", pedido: "2 Tacos al pastor\n1 Horchata", total: 210 },
  izakaya: { ...base, sucursal: "Izakaya", tipo_pedido: "recoger", pedido: "Recoger:\n2 Ramen Tonkotsu — 640 lempiras\n1 Gyoza — 180 lempiras\nRTN: 08011999123456, a nombre de Ana Perez", total: 820 },
  arnies: { ...base, sucursal: "Arnies", tipo_pedido: "comer en el restaurante", pedido: "Comer en el restaurante:\n1 Desayuno Típico — 220 lempiras\n•Huevos revueltos", total: 220 },
  pulhapanzac_reserva: { ...base, tipo: "reserva", sucursal: "Pulhapanzac", reserva_nombre: "Ana", cantidad_personas: 3, fecha_entrada: "1 dic", fecha_salida: "3 dic", correo_electronico: "ana@example.com", cantidad_dias: 2, menor_de_5_anos: "no", cabana_elegida: "Cabaña 1", total: 3000 },
  chanchito_delivery_old: { ...base, sucursal: "El Chanchito", tipo_pedido: "delivery", _tipoPedidoRaw: "delivery", pedido: "Delivery:\n1 Chanchito Personal — 250 lempiras\n•Proteína: Panceta", total: 250 },
  chanchito_comer_old: { ...base, sucursal: "El Chanchito", tipo_pedido: "comer en el restaurante", _tipoPedidoRaw: "comer en el restaurante", pedido: "Comer en el restaurante:\n2 Pastelitos de Panceta — 370 lempiras", total: 370 },
  chanchito_programado_v11_ml: { ...base, sucursal: "El Chanchito", tipo_pedido: "Pedido programado", _tipoPedidoRaw: "recoger", hora_recogida: "3 P.M.", pedido: "Pedido programado:\nHora: 3 P.M.\nGourmet Sandwich con Papas — 295 lempiras\n• Proteína: Pulled Pork\nYuca con Chicharrón — 270 lempiras\n• Proteína: Costilla Frita\n• Yuca: Al mojo", total: 565 },
};
