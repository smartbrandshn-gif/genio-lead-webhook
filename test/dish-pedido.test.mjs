process.env.GENIO_NO_LISTEN = "1";
import assert from "node:assert/strict";
import { buildRossoEmail, extractRosso, validateRosso, applyDishPedidoFields } from "../server.js";

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}`); console.error(e?.stack || e); } };

const req = (body) => ({ body, query: {}, get: () => "", params: {} });

check("extractRosso mapea sucursal Dish", () => {
  const p = extractRosso(req({ sucursal: "Dish", tipo: "pedido", nombre: "Ana López", telefono: "9999-8888", tipo_servicio: "para recoger", forma_pago: "efectivo", hora_estimada: "1:30 P.M.", pedido: "1 Build Your Verdi — 320 lempiras", total: 320, telefono_confirmado: true }));
  assert.equal(p.sucursal, "Dish");
  assert.equal(p.hora_estimada, "1:30 P.M.");
  assert.equal(p.tipo_servicio, "para recoger");
});

check("applyDishPedidoFields llena tipo_pedido desde tipo_servicio", () => {
  const p = applyDishPedidoFields({ tipo_servicio: "para llevar", tipo_pedido: "" });
  assert.equal(p.tipo_pedido, "Para recoger");
  const q = applyDishPedidoFields({ tipo_servicio: "comer en el restaurante", tipo_pedido: "" });
  assert.equal(q.tipo_pedido, "Comer en el restaurante");
});

check("validateRosso acepta pedido Dish con tipo_servicio y sin tipo_pedido", () => {
  const err = validateRosso({
    tipo: "pedido",
    sucursal: "Dish",
    nombre: "Ana López",
    telefono: "99998888",
    telefono_confirmado: true,
    tipo_servicio: "recoger",
    pedido: "1 Build Your Verdi — 320 lempiras",
    total: 320,
  });
  assert.equal(err, "");
});

check("correo de pedido Dish: asunto, hora del pedido y sin fila de restaurante", () => {
  const email = buildRossoEmail({
    tipo: "pedido",
    sucursal: "Dish",
    nombre: "Ana López",
    telefono: "99998888",
    telefono_confirmado: true,
    tipo_servicio: "recoger",
    forma_pago: "efectivo",
    hora_estimada: "1:30 P.M.",
    pedido: "1 Build Your Verdi — 320 lempiras\n- Comentario de cocina: sin cebolla",
    total: 320,
  });
  assert.equal(email.subject, "Nuevo pedido - Ana López");
  assert.match(email.text, /^Nuevo pedido\n/);
  assert.match(email.text, /Hora del pedido: 1:30 P\.M\./);
  assert.match(email.text, /Forma de pago: Efectivo/);
  assert.match(email.text, /Tipo: Para llevar/);
  assert.doesNotMatch(email.text, /Restaurante:/);
  assert.match(email.text, /Comentario de cocina: sin cebolla/);
  assert.match(email.html, /Hora del pedido/);
  assert.match(email.html, /1:30 P\.M\./);
});

check("correo de reserva Dish: asunto y tipo_evento", () => {
  const email = buildRossoEmail({
    tipo: "reserva",
    sucursal: "Dish",
    nombre: "Ana López",
    telefono: "99998888",
    telefono_confirmado: true,
    reserva_personas: 4,
    reserva_fecha: "28 de noviembre",
    reserva_hora: "7:00 P.M.",
    tipo_evento: "cena familiar",
  });
  assert.equal(email.subject, "Nueva reserva - Ana López");
  assert.match(email.text, /Nueva reserva — Dish/);
  assert.match(email.text, /Tipo de evento: cena familiar/);
  assert.match(email.text, /Cantidad de personas: 4/);
});

check("correo de Arnie's no gana la fila Hora del pedido", () => {
  const email = buildRossoEmail({
    tipo: "pedido",
    sucursal: "Arnies",
    nombre: "Ana López",
    telefono: "99998888",
    telefono_confirmado: true,
    tipo_pedido: "recoger",
    tipo_servicio: "recoger",
    forma_pago: "efectivo",
    hora_estimada: "1:30 P.M.",
    pedido: "1 Brownie — 190 lempiras",
    total: 190,
  });
  assert.equal(email.subject, "Nuevo pedido - Ana López");
  assert.doesNotMatch(email.text, /Hora del pedido/);
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
