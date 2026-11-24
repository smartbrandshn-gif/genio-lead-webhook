process.env.GENIO_NO_LISTEN = "1";
import assert from "node:assert/strict";
import { buildRossoEmail, extractRosso, parseArniesPedido, arniesNormTipoServicio, arniesNormFormaPago } from "../server.js";

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}`); console.error(e?.stack || e); } };

const base = {
  tipo: "pedido",
  sucursal: "Arnies",
  nombre: "Cliente Ejemplo",
  telefono: "99999999",
  telefono_confirmado: true,
  pedido: "Para llevar:\n1 Brownie — 190 lempiras",
  total: 190,
};

const req = (body) => ({ body, query: {}, get: () => "", params: {} });

check("extractRosso lee tipo_servicio, forma_pago, hora_estimada, rtn y campos existentes", () => {
  const p = extractRosso(req({
    sucursal: "Arnies",
    tipo: "pedido",
    nombre: "Cliente Ejemplo",
    telefono: "9999-9999",
    pedido: "1 Brownie — 190 lempiras",
    total: 190,
    telefono_confirmado: true,
    comentario_cliente: "Sin nueces",
    tipo_servicio: "Para llevar",
    forma_pago: "Link de pago",
    hora_estimada: "20-25 minutos",
    rtn_numero: "0000-0000-000000",
    rtn_nombre: "Cliente Ejemplo",
  }));
  assert.equal(p.nombre, "Cliente Ejemplo");
  assert.equal(p.telefono, "99999999");
  assert.equal(p.pedido, "1 Brownie — 190 lempiras");
  assert.equal(p.total, 190);
  assert.equal(p.telefono_confirmado, true);
  assert.equal(p.comentario_cliente, "Sin nueces");
  assert.equal(p.tipo_servicio, "Para llevar");
  assert.equal(p.forma_pago, "Link de pago");
  assert.equal(p.hora_estimada, "20-25 minutos");
  assert.equal(p.rtn_numero, "0000-0000-000000");
  assert.equal(p.rtn_nombre, "Cliente Ejemplo");
});

check("normaliza tipo_servicio y forma_pago (incl. recoger → Para llevar y Link de pago)", () => {
  assert.equal(arniesNormTipoServicio("para llevar"), "Para llevar");
  assert.equal(arniesNormTipoServicio("Recoger"), "Para llevar");
  assert.equal(arniesNormTipoServicio("comer en el restaurante"), "Comer en el restaurante");
  assert.equal(arniesNormFormaPago("tarjeta"), "Tarjeta");
  assert.equal(arniesNormFormaPago("Efectivo"), "Efectivo");
  assert.equal(arniesNormFormaPago("link de pago"), "Link de pago");
});

check("parseArniesPedido conserva viñetas y acepta Para llevar", () => {
  const r = parseArniesPedido("Para llevar:\n1 Mar y Tierra — 1050 lempiras\n- Proteína: filete 9 oz\n• Término: roja\nRTN: 0000-0000-000000, a nombre de Cliente Ejemplo");
  assert.equal(r.tipo, "Para llevar");
  assert.equal(r.rtn, "00000000000000");
  assert.equal(r.rtnNombre, "Cliente Ejemplo");
  assert.deepEqual(r.items, [
    "1 Mar y Tierra — 1050 lempiras",
    "• Proteína: filete 9 oz",
    "• Término: roja",
  ]);
});

check("correo: campos etiquetados, RTN vacío → No solicitó RTN, hora omitida si falta, forma No", () => {
  const e = buildRossoEmail({ ...base, comentario_cliente: "Ninguno" });
  assert.equal(e.subject, "Nuevo pedido: Cliente Ejemplo");
  assert.match(e.text, /Restaurante: Arnie's/);
  assert.match(e.text, /Tipo: Para llevar/);
  assert.match(e.text, /Forma de pago: No/);
  assert.doesNotMatch(e.text, /Hora estimada:/);
  assert.match(e.text, /RTN: No solicitó RTN/);
  assert.match(e.html, />Tipo</);
  assert.match(e.html, />Para llevar</);
  assert.match(e.html, />Forma de pago</);
  assert.match(e.html, /No solicitó RTN/);
  assert.doesNotMatch(e.html, /Hora estimada/);
  assert.doesNotMatch(e.subject, /MODIFICACIÓN/);
});

check("correo: tipo_servicio, forma_pago, hora_estimada y RTN en campos propios", () => {
  const e = buildRossoEmail({
    ...base,
    tipo_servicio: "Para llevar",
    forma_pago: "Tarjeta",
    hora_estimada: "20-25 minutos",
    rtn_numero: "0000-0000-000000",
    rtn_nombre: "Cliente Ejemplo",
    comentario_cliente: "Papas fritas y ensalada de la casa en vez de las guarniciones fijas",
    pedido: "Para llevar:\n1 Mar y Tierra — 1050 lempiras\n• Proteína: filete 9 oz, 10 camarones al ajillo\n• Término: roja\n• Guarnición: Papas Fritas Estilo Arnie's\n• Guarnición: Ensalada de la Casa\n1 Media orden de lechón 4 oz — 200 lempiras\n• Extra\n1 Sopa de Tortilla Grande — 290 lempiras\n2 Tacos de Lechón — 520 lempiras\n• Cantidad: 2\n• Precio unitario: 260 lempiras\n• Subtotal: 520 lempiras\n1 Brownie — 190 lempiras",
    total: 2250,
  });
  assert.equal(e.subject, "Nuevo pedido: Cliente Ejemplo");
  assert.match(e.text, /Tipo: Para llevar/);
  assert.match(e.text, /Forma de pago: Tarjeta/);
  assert.match(e.text, /Hora estimada: 20-25 minutos/);
  assert.match(e.text, /RTN: Sí/);
  assert.match(e.text, /Número de RTN: 0000-0000-000000/);
  assert.match(e.text, /Nombre del RTN: Cliente Ejemplo/);
  assert.match(e.text, /• Proteína: filete 9 oz, 10 camarones al ajillo/);
  assert.match(e.text, /• Término: roja/);
  assert.match(e.text, /Total: 2250 lempiras/);
  assert.match(e.html, /Link de pago|Tarjeta/);
  assert.match(e.html, /20-25 minutos/);
  assert.match(e.html, /Número de RTN/);
  assert.match(e.html, /• Proteína: filete 9 oz, 10 camarones al ajillo/);
  assert.doesNotMatch(e.html, /ISV/);
});

check("MODIFICACIÓN DE PEDIDO aparece en asunto, texto y encabezado HTML", () => {
  const e = buildRossoEmail({
    ...base,
    forma_pago: "Efectivo",
    comentario_cliente: "MODIFICACIÓN DE PEDIDO: quitar el brownie y agregar otra sopa",
  });
  assert.equal(e.subject, "MODIFICACIÓN DE PEDIDO: Cliente Ejemplo");
  assert.match(e.text, /MODIFICACIÓN DE PEDIDO — Arnie's/);
  assert.match(e.text, /MODIFICACIÓN DE PEDIDO\nTipo:/);
  assert.match(e.html, /MODIFICACIÓN DE PEDIDO/);
  assert.match(e.text, /Comentario de cocina: MODIFICACIÓN DE PEDIDO: quitar el brownie y agregar otra sopa/);
});

check("no altera el correo de Izakaya ni Manzano (sin campos nuevos de Arnie's)", () => {
  const iz = buildRossoEmail({
    tipo: "pedido",
    sucursal: "Izakaya",
    nombre: "Ana Perez",
    telefono: "99887766",
    telefono_confirmado: true,
    tipo_pedido: "recoger",
    pedido: "Recoger:\n2 Ramen Tonkotsu — 640 lempiras",
    total: 640,
    tipo_servicio: "Para llevar",
    forma_pago: "Link de pago",
    hora_estimada: "20-25 minutos",
  });
  assert.equal(iz.subject, "Nuevo pedido: Ana Perez");
  assert.doesNotMatch(iz.text, /Forma de pago/);
  assert.doesNotMatch(iz.text, /Hora estimada/);
  assert.doesNotMatch(iz.text, /Restaurante: Arnie's/);
  assert.doesNotMatch(iz.html, /Link de pago/);
  assert.doesNotMatch(iz.html, /Hora estimada/);
  assert.match(iz.text, /Tipo de pedido: Para recoger|Tipo de pedido: recoger|Tipo: Para recoger/);

  const mz = buildRossoEmail({
    tipo: "pedido",
    sucursal: "Manzano",
    nombre: "Ana Perez",
    telefono: "99887766",
    telefono_confirmado: true,
    tipo_pedido: "Para recoger",
    pedido: "Recoger:\n1 Carne 8 oz — 395 lempiras",
    total: 395,
    tipo_servicio: "Para llevar",
    forma_pago: "Link de pago",
    hora_estimada: "20-25 minutos",
  });
  assert.doesNotMatch(mz.text, /Forma de pago/);
  assert.doesNotMatch(mz.text, /Hora estimada/);
  assert.doesNotMatch(mz.html, /Link de pago/);
  assert.doesNotMatch(mz.subject, /MODIFICACIÓN/);
});

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall arnies tests passed");
