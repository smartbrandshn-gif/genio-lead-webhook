process.env.GENIO_NO_LISTEN = "1";
import assert from "node:assert/strict";
import { buildRossoEmail, extractRosso, parseArniesPedido, arniesNormTipoServicio, arniesNormFormaPago, validateRosso } from "../server.js";

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

check("comentario de cocina queda bajo el plato; el que no tiene no muestra línea", () => {
  const r = parseArniesPedido("Para llevar:\n1 Mar y Tierra — 1050 lempiras\n- Comentario de cocina: cambio de guarniciones: papas fritas y ensalada de la casa\n1 Media orden de lechón 4 oz — 200 lempiras\n1 Sopa de Tortilla Grande — 290 lempiras\n2 Tacos de Lechón — 520 lempiras\n- Comentario de cocina: sin cebolla\n1 Brownie — 190 lempiras");
  assert.deepEqual(r.items, [
    "1 Mar y Tierra — 1050 lempiras",
    "• Comentario de cocina: cambio de guarniciones: papas fritas y ensalada de la casa",
    "1 Media orden de lechón 4 oz — 200 lempiras",
    "1 Sopa de Tortilla Grande — 290 lempiras",
    "2 Tacos de Lechón — 520 lempiras",
    "• Comentario de cocina: sin cebolla",
    "1 Brownie — 190 lempiras",
  ]);
  const empty = parseArniesPedido("1 Brownie — 190 lempiras\n- Comentario de cocina:");
  assert.deepEqual(empty.items, ["1 Brownie — 190 lempiras"]);
});

check("correo: campos etiquetados, RTN vacío → No solicitó RTN, hora omitida si falta, forma No", () => {
  const e = buildRossoEmail({ ...base, comentario_cliente: "Ninguno" });
  assert.equal(e.subject, "Nuevo pedido - Cliente Ejemplo");
  assert.match(e.text, /^Nuevo pedido\n/);
  assert.doesNotMatch(e.text, /^Arnie/);
  assert.doesNotMatch(e.text, /Nuevo pedido — Arnie/);
  assert.doesNotMatch(e.text, /Restaurante:/);
  assert.doesNotMatch(e.html, />Restaurante</);
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

check("correo: tipo_servicio, forma_pago y RTN en campos propios; sin hora estimada, Sí de RTN, cantidad, precio unitario ni subtotal", () => {
  const e = buildRossoEmail({
    ...base,
    tipo_servicio: "Para llevar",
    forma_pago: "Tarjeta",
    hora_estimada: "20-25 minutos",
    rtn_numero: "0000-0000-000000",
    rtn_nombre: "Cliente Ejemplo",
    comentario_cliente: "Ninguno",
    pedido: "Para llevar:\n1 Mar y Tierra — 1050 lempiras\n• Proteína: filete 9 oz, 10 camarones al ajillo\n• Término: roja\n• Guarnición: Papas Fritas Estilo Arnie's\n• Guarnición: Ensalada de la Casa\n- Comentario de cocina: cambio de guarniciones: papas fritas y ensalada de la casa\n1 Media orden de lechón 4 oz — 200 lempiras\n• Extra\n1 Sopa de Tortilla Grande — 290 lempiras\n2 Tacos de Lechón — 520 lempiras\n• Cantidad: 2\n• Precio unitario: 260 lempiras\n• Subtotal: 520 lempiras\n- Comentario de cocina: sin cebolla\n1 Brownie — 190 lempiras",
    total: 2250,
  });
  assert.equal(e.subject, "Nuevo pedido - Cliente Ejemplo");
  assert.match(e.text, /Tipo: Para llevar/);
  assert.match(e.text, /Forma de pago: Tarjeta/);
  assert.doesNotMatch(e.text, /Hora estimada/);
  assert.doesNotMatch(e.text, /RTN: Sí/);
  assert.doesNotMatch(e.html, /Hora estimada|20-25 minutos/);
  assert.doesNotMatch(e.html, />Sí</);
  assert.match(e.text, /Número de RTN: 0000-0000-000000/);
  assert.match(e.text, /Nombre del RTN: Cliente Ejemplo/);
  assert.doesNotMatch(e.text, /Cantidad:/);
  assert.doesNotMatch(e.text, /Precio unitario:/);
  assert.doesNotMatch(e.text, /Subtotal:/);
  assert.doesNotMatch(e.html, /Cantidad:/);
  assert.doesNotMatch(e.html, /Precio unitario:/);
  assert.doesNotMatch(e.html, /Subtotal:/);
  assert.match(e.text, /2 Tacos de Lechón — 520 lempiras/);
  assert.match(e.text, /• Proteína: filete 9 oz, 10 camarones al ajillo/);
  assert.match(e.text, /• Término: roja/);
  assert.match(e.text, /1 Mar y Tierra — 1050 lempiras[\s\S]*• Comentario de cocina: cambio de guarniciones: papas fritas y ensalada de la casa[\s\S]*1 Media orden de lechón 4 oz/);
  assert.match(e.text, /2 Tacos de Lechón — 520 lempiras[\s\S]*• Comentario de cocina: sin cebolla[\s\S]*1 Brownie/);
  assert.doesNotMatch(e.text, /1 Media orden de lechón 4 oz — 200 lempiras\n• Extra\n• Comentario de cocina/);
  assert.doesNotMatch(e.text, /1 Sopa de Tortilla Grande — 290 lempiras\n• Comentario de cocina/);
  assert.doesNotMatch(e.text, /1 Brownie — 190 lempiras\n• Comentario de cocina/);
  assert.doesNotMatch(e.text, /^Comentario de cocina:/m);
  assert.doesNotMatch(e.text, /Nota general/);
  assert.match(e.text, /Total: 2250 lempiras/);
  assert.match(e.html, /Link de pago|Tarjeta/);
  assert.match(e.html, /Número de RTN/);
  assert.match(e.html, /Nombre del RTN/);
  assert.match(e.html, /• Proteína: filete 9 oz, 10 camarones al ajillo/);
  assert.match(e.html, /• Comentario de cocina: cambio de guarniciones: papas fritas y ensalada de la casa/);
  assert.match(e.html, /• Comentario de cocina: sin cebolla/);
  assert.doesNotMatch(e.html, /ISV/);
});

check("correo: el extra no se repite como viñeta y se conserva el comentario de cocina", () => {
  const e = buildRossoEmail({
    ...base,
    tipo_servicio: "Comer en el restaurante",
    forma_pago: "Tarjeta",
    pedido: "Comer en el restaurante:\n1 Media orden de lechón 4 oz (extra) — 200 lempiras\n• Extra\n• Extra: media orden de lechón cuatro onzas extra\n- Comentario de cocina: bien dorada\n1 Brownie — 190 lempiras",
    total: 390,
  });
  assert.match(e.text, /1 Media orden de lechón 4 oz \(extra\) — 200 lempiras\n• Comentario de cocina: bien dorada\n1 Brownie/);
  assert.match(e.html, /• Comentario de cocina: bien dorada/);
  assert.doesNotMatch(e.text, /• Extra/);
  assert.doesNotMatch(e.html, /• Extra/);
  assert.doesNotMatch(e.text, /Restaurante:/);
  assert.doesNotMatch(e.html, />Restaurante</);
});

check("comentario_cliente que no es modificación se muestra una vez como Nota general, no como comentario de cocina agrupado", () => {
  const e = buildRossoEmail({ ...base, comentario_cliente: "Llamar al llegar" });
  assert.match(e.text, /Nota general: Llamar al llegar/);
  assert.match(e.html, /Nota general/);
  assert.match(e.html, /Llamar al llegar/);
  assert.doesNotMatch(e.text, /^Comentario de cocina:/m);
  assert.doesNotMatch(e.html, />Comentario de cocina</);
});

check("MODIFICACIÓN DE PEDIDO aparece en asunto, texto y encabezado HTML", () => {
  const e = buildRossoEmail({
    ...base,
    forma_pago: "Efectivo",
    comentario_cliente: "MODIFICACIÓN DE PEDIDO: quitar el brownie y agregar otra sopa",
  });
  assert.equal(e.subject, "MODIFICACIÓN DE PEDIDO: Cliente Ejemplo");
  assert.match(e.text, /^MODIFICACIÓN DE PEDIDO\n/);
  assert.doesNotMatch(e.text, /MODIFICACIÓN DE PEDIDO — Arnie/);
  assert.match(e.text, /MODIFICACIÓN DE PEDIDO\nTipo:/);
  assert.match(e.html, /MODIFICACIÓN DE PEDIDO/);
  assert.match(e.text, /MODIFICACIÓN DE PEDIDO: quitar el brownie y agregar otra sopa/);
  assert.doesNotMatch(e.text, /Comentario de cocina: MODIFICACIÓN/);
  assert.doesNotMatch(e.text, /Nota general/);
  assert.doesNotMatch(e.html, />Comentario de cocina</);
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


const reservaBase = {
  tipo: "reserva",
  sucursal: "Arnies",
  nombre: "Ana López",
  telefono: "98765432",
  telefono_confirmado: true,
  reserva_fecha: "28/11/2026",
  reserva_hora: "7:00 p. m.",
  reserva_personas: 6,
  tipo_evento: "Cumpleaños",
};

check("extractRosso lee tipo_evento y aliases; reserva_nombre y cantidad_personas siguen compatibles", () => {
  const a = extractRosso(req({
    sucursal: "Arnies",
    tipo: "reserva",
    nombre: "Ana López",
    telefono: "9876-5432",
    telefono_confirmado: true,
    reserva_fecha: "28/11/2026",
    reserva_hora: "7:00 p. m.",
    reserva_personas: "6",
    tipo_evento: "Cumpleaños",
  }));
  assert.equal(a.sucursal, "Arnies");
  assert.equal(a.tipo, "reserva");
  assert.equal(a.nombre, "Ana López");
  assert.equal(a.reserva_nombre, "Ana López");
  assert.equal(a.telefono, "98765432");
  assert.equal(a.telefono_confirmado, true);
  assert.equal(a.reserva_fecha, "28/11/2026");
  assert.equal(a.reserva_hora, "7:00 p. m.");
  assert.equal(a.reserva_personas, 6);
  assert.equal(a.tipo_evento, "Cumpleaños");

  const alias = extractRosso(req({
    sucursal: "Arnies",
    tipo: "reserva",
    reserva_nombre: "Ana López",
    telefono: "98765432",
    cantidad_personas: "6",
    reserva_fecha: "28/11/2026",
    reserva_hora: "7:00 p. m.",
    tipo_de_evento: "Aniversario",
  }));
  assert.equal(alias.nombre, "");
  assert.equal(alias.reserva_nombre, "Ana López");
  assert.equal(alias.reserva_personas, 6);
  assert.equal(alias.cantidad_personas, 6);
  assert.equal(alias.tipo_evento, "Aniversario");

  const ev = extractRosso(req({
    sucursal: "Arnies",
    tipo: "reserva",
    nombre: "Ana López",
    evento: "Reunión",
  }));
  assert.equal(ev.tipo_evento, "Reunión");
});

check("validateRosso Arnie's reserva exige los 6 campos y telefono_confirmado; fallback Tipo de evento en notas", () => {
  assert.equal(validateRosso({ ...reservaBase }), "");

  const sinNombre = validateRosso({ ...reservaBase, nombre: "", reserva_nombre: "" });
  assert.match(sinNombre, /nombre/);

  const sinTel = validateRosso({ ...reservaBase, telefono: "" });
  assert.match(sinTel, /telefono/);

  const sinConf = validateRosso({ ...reservaBase, telefono_confirmado: false });
  assert.match(sinConf, /telefono_confirmado/);

  const sinFecha = validateRosso({ ...reservaBase, reserva_fecha: "" });
  assert.match(sinFecha, /reserva_fecha/);

  const sinHora = validateRosso({ ...reservaBase, reserva_hora: "" });
  assert.match(sinHora, /reserva_hora/);

  const sinPersonas = validateRosso({ ...reservaBase, reserva_personas: null, cantidad_personas: null });
  assert.match(sinPersonas, /reserva_personas|cantidad_personas/);

  const sinEvento = validateRosso({ ...reservaBase, tipo_evento: "" });
  assert.match(sinEvento, /tipo_evento/);

  const desdeNotas = { ...reservaBase, tipo_evento: "", notas: "Tipo de evento: Cumpleaños" };
  assert.equal(validateRosso(desdeNotas), "");
  assert.equal(desdeNotas.tipo_evento, "Cumpleaños");

  const aliasNombre = { ...reservaBase, nombre: "", reserva_nombre: "Ana López" };
  assert.equal(validateRosso(aliasNombre), "");
  assert.equal(aliasNombre.nombre, "Ana López");

  const aliasPers = { ...reservaBase, reserva_personas: null, cantidad_personas: 6 };
  assert.equal(validateRosso(aliasPers), "");
  assert.equal(aliasPers.reserva_personas, 6);
});

check("asuntos Arnie's: guion y sin nombre, no dos puntos; reserva conserva el cuerpo", () => {
  assert.equal(buildRossoEmail({ ...reservaBase, nombre: "", reserva_nombre: "" }).subject, "Nueva reserva");
  assert.equal(buildRossoEmail({ ...reservaBase }).subject, "Nueva reserva - Ana López");
  const pedidoVacio = buildRossoEmail({ tipo: "pedido", sucursal: "Arnies", nombre: "  ", telefono: "99991234", telefono_confirmado: true, tipo_pedido: "recoger", pedido: "1 Brownie — 190 lempiras", total: 190 });
  assert.equal(pedidoVacio.subject, "Nuevo pedido");
  assert.match(pedidoVacio.text, /^Nuevo pedido\n/);
});

check("correo de reserva Arnie's: 6 campos propios, no plantilla de evento Manzano", () => {
  const e = buildRossoEmail({ ...reservaBase });
  assert.equal(e.subject, "Nueva reserva - Ana López");
  assert.match(e.text, /Nueva reserva — Arnie's/);
  assert.match(e.text, /Nombre completo: Ana López/);
  assert.match(e.text, /Fecha: 28\/11\/2026/);
  assert.match(e.text, /Hora: 7:00 p\. m\./);
  assert.match(e.text, /Cantidad de personas: 6/);
  assert.match(e.text, /Teléfono: 9876-5432/);
  assert.match(e.text, /Tipo de evento: Cumpleaños/);
  assert.doesNotMatch(e.text, /Nueva reserva de evento/);
  assert.doesNotMatch(e.text, /A nombre de:/);
  assert.doesNotMatch(e.text, /Notas:/);
  assert.match(e.html, />Nombre completo</);
  assert.match(e.html, />Ana López</);
  assert.match(e.html, />Fecha</);
  assert.match(e.html, />28\/11\/2026</);
  assert.match(e.html, />Hora</);
  assert.match(e.html, />7:00 p\. m\.</);
  assert.match(e.html, />Cantidad de personas</);
  assert.match(e.html, />Teléfono</);
  assert.match(e.html, />9876-5432</);
  assert.match(e.html, />Tipo de evento</);
  assert.match(e.html, />Cumpleaños</);

  const fallback = buildRossoEmail({ ...reservaBase, tipo_evento: "", notas: "Tipo de evento: Cumpleaños\nMesa junto a la ventana" });
  assert.match(fallback.text, /Tipo de evento: Cumpleaños/);
  assert.match(fallback.text, /Notas: Mesa junto a la ventana/);
  assert.doesNotMatch(fallback.text, /Notas: Tipo de evento:/);
});

check("reserva de Manzano/Izakaya no cambia: evento Manzano sigue aparte; Izakaya no exige tipo_evento", () => {
  const mzEvento = {
    tipo: "reserva",
    sucursal: "Manzano",
    nombre: "Ana López",
    telefono: "98765432",
    telefono_confirmado: true,
    reserva_fecha: "28/11/2026",
    reserva_hora: "7:00 p. m.",
    reserva_personas: 6,
    tipo_evento: "Cumpleaños",
  };
  assert.equal(validateRosso(mzEvento), "");
  const mzMail = buildRossoEmail(mzEvento);
  assert.equal(mzMail.subject, "Nuevo evento: Ana López");
  assert.match(mzMail.text, /Nueva reserva de evento — El Manzano/);
  assert.match(mzMail.text, /Tipo de evento: Cumpleaños/);
  assert.doesNotMatch(mzMail.text, /Nombre completo:/);
  assert.doesNotMatch(mzMail.text, /Nueva reserva — Arnie's/);

  const mzMesa = {
    tipo: "reserva",
    sucursal: "Manzano",
    nombre: "Ana López",
    reserva_nombre: "Ana López",
    telefono: "98765432",
    telefono_confirmado: true,
    reserva_fecha: "28/11/2026",
    reserva_hora: "7:00 p. m.",
    reserva_personas: 6,
  };
  assert.equal(validateRosso(mzMesa), "");
  const mzMesaMail = buildRossoEmail(mzMesa);
  assert.equal(mzMesaMail.subject, "Nueva reserva: Ana López");
  assert.match(mzMesaMail.text, /RESERVA DE MESA/);
  assert.match(mzMesaMail.text, /A nombre de: Ana López/);
  assert.doesNotMatch(mzMesaMail.text, /Tipo de evento:/);
  assert.doesNotMatch(mzMesaMail.text, /Nombre completo:/);

  const iz = {
    tipo: "reserva",
    sucursal: "Izakaya",
    nombre: "Ana López",
    reserva_nombre: "Ana López",
    telefono: "98765432",
    telefono_confirmado: true,
    reserva_fecha: "28/11/2026",
    reserva_hora: "7:00 p. m.",
    reserva_personas: 6,
  };
  assert.equal(validateRosso(iz), "");
  const izMail = buildRossoEmail(iz);
  assert.equal(izMail.subject, "Nueva reserva: Ana López");
  assert.match(izMail.text, /RESERVA DE MESA/);
  assert.doesNotMatch(izMail.text, /Tipo de evento:/);
  assert.doesNotMatch(izMail.text, /Nueva reserva — Arnie's/);
});

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall arnies tests passed");
