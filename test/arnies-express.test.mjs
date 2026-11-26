process.env.GENIO_NO_LISTEN = "1";
import assert from "node:assert/strict";
import { buildRossoEmail, extractRosso, validateRosso, rossoSucursal } from "../server.js";

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}`); console.error(e?.stack || e); } };
const req = (body) => ({ body, query: {}, get: () => "", params: {} });

check("rossoSucursal: Express va antes que Arnie's y Arnie's sigue igual", () => {
  for (const v of ["ArniesExpress", "Arnies Express", "arnies-express", "Arnie's Express", "arnies_express"]) assert.equal(rossoSucursal(v), "ArniesExpress", v);
  for (const v of ["Arnies", "Arnie's", "arnies", "ARNIES"]) assert.equal(rossoSucursal(v), "Arnies", v);
  assert.equal(rossoSucursal("Dish"), "Dish");
});

const base = { sucursal: "ArniesExpress", tipo: "pedido", nombre: "Ana López", telefono: "99998888", telefono_confirmado: true, tipo_servicio: "Recoger", forma_pago: "efectivo", hora_estimada: "1:30 P.M.", pedido: "Recoger: 1 Plato de prueba — 100 lempiras\n- Comentario de cocina: sin cebolla", total: 100 };

check("pedido Express valido sin tipo_pedido", () => {
  const p = extractRosso(req(base));
  assert.equal(validateRosso(p), "");
  assert.equal(p.tipo_pedido, "Para recoger");
});

check("reserva Express se rechaza", () => {
  const p = extractRosso(req({ ...base, tipo: "reserva", reserva_personas: 4, reserva_fecha: "x", reserva_hora: "y", tipo_evento: "z" }));
  assert.match(validateRosso(p), /solo toma pedidos para recoger/);
  const q = extractRosso(req({ ...base, tipo: "ambos" }));
  assert.match(validateRosso(q), /solo toma pedidos/);
});

check("correo Express: asunto, RTN, total; sin Tipo, Forma de pago ni Hora del pedido", () => {
  const p = extractRosso(req({ ...base, tipo_servicio: "comer en el restaurante", rtn_numero: "08011999123456", rtn_nombre: "Empresa X" }));
  validateRosso(p);
  const email = buildRossoEmail(p);
  assert.equal(email.subject, "Arnie's Express - Nuevo pedido - Ana López");
  assert.doesNotMatch(email.text, /Comer en el restaurante/);
  assert.doesNotMatch(email.text, /^Tipo:/m);
  assert.doesNotMatch(email.text, /Forma de pago/);
  assert.doesNotMatch(email.text, /Hora del pedido/);
  assert.doesNotMatch(email.html, /Forma de pago/);
  assert.doesNotMatch(email.html, /Hora del pedido/);
  assert.doesNotMatch(email.html, />Tipo</);
  assert.match(email.text, /Total: 100 lempiras/);
  assert.match(email.text, /Teléfono: 9999-8888/);
  assert.match(email.text, /Nombre del RTN: Empresa X/);
  assert.match(email.text, /Número de RTN: 08011999123456/);
  assert.match(email.text, /Comentario de cocina: sin cebolla/);
  assert.match(email.text, /Fecha \(America\/Guatemala\)/);
});

check("correo Express: sin RTN y modificacion (sin hora en el correo)", () => {
  const e1 = buildRossoEmail(extractRosso(req({ ...base, hora_estimada: "" })));
  assert.match(e1.text, /RTN: No solicitó RTN/);
  assert.doesNotMatch(e1.text, /Hora del pedido/);
  assert.doesNotMatch(e1.html, /Hora del pedido/);
  const e2 = buildRossoEmail(extractRosso(req({ ...base, comentario_cliente: "MODIFICACIÓN DE PEDIDO: quitar la bebida", pedido: "MODIFICACIÓN", total: 0 })));
  assert.equal(e2.subject, "Arnie's Express - MODIFICACIÓN DE PEDIDO: Ana López");
});

check("Arnie's sigue con su propio correo (sin Express, sin Hora del pedido)", () => {
  const p = extractRosso(req({ ...base, sucursal: "Arnies" }));
  assert.equal(p.sucursal, "Arnies");
  const email = buildRossoEmail(p);
  assert.equal(email.subject, "Nuevo pedido - Ana López");
  assert.doesNotMatch(email.text, /Express/);
  assert.doesNotMatch(email.text, /Hora del pedido/);
});

if (failed) { console.error(`${failed} test(s) fallaron`); process.exit(1); }
console.log("arnies-express: todo ok");
