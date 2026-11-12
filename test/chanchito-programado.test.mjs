process.env.GENIO_NO_LISTEN = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyChanchitoPedidoFields,
  applyRossoTipoRoute,
  buildRossoEmail,
  parseChanchitoPedido,
  parseManzanoPedido,
} from "../server.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "manzano-email-baseline.json"), "utf8"));

const TS_RE =
  /\b(?:Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes|S[aá]bado|Domingo), \d{1,2} de (?:Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre) de \d{4}, \d{1,2}:\d{2}:\d{2} [ap]\. m\./gi;

const norm = (s) => String(s).replace(TS_RE, "<TS>");

const manzanoPayload = {
  tipo: "pedido",
  sucursal: "Manzano",
  nombre: "Ana Perez",
  telefono: "99887766",
  telefono_confirmado: true,
  tipo_pedido: "Para recoger",
  pedido: "Recoger:\n1 Carne 8 oz — 395 lempiras\n-Término\n•Tres cuartos\nPago: Efectivo",
  total: 395,
  comentario_cliente: "Ninguno",
  metodo_pago: "",
  notas: "",
};

const chanchitoProgramadoPayload = {
  tipo: "pedido",
  sucursal: "El Chanchito",
  nombre: "Carlos Lopez",
  telefono: "33445566",
  telefono_confirmado: true,
  tipo_pedido: "Para recoger",
  _tipoPedidoRaw: "recoger",
  pedido: "Pedido programado:\nHora: 3:30 p.m.\n1 Chanchito Personal — 250 lempiras\nPago: Efectivo",
  total: 250,
  hora_recogida: "3:30 p.m.",
  comentario_cliente: "Ninguno",
  metodo_pago: "",
  notas: "",
};

function pedidoRows(email) {
  const rows = [];
  const text = email.text || "";
  const tipo = text.match(/^Tipo de pedido:\s*(.+)$/m);
  const hora = text.match(/^Hora de recogida:\s*(.+)$/m);
  if (tipo) rows.push(["Tipo de pedido", tipo[1]]);
  if (hora) rows.push(["Hora de recogida", hora[1]]);
  const total = text.match(/^Total:\s*(.+)$/m);
  if (total) rows.push(["Total", total[1]]);
  const htmlTipo = /<td[^>]*>Tipo<\/td><td[^>]*>([^<]*)<\/td>/i.exec(email.html.replace(/\s+/g, " "));
  const htmlHora = /<td[^>]*>Hora de recogida<\/td><td[^>]*>([^<]*)<\/td>/i.exec(email.html.replace(/\s+/g, " "));
  return { textRows: rows, htmlTipo: htmlTipo ? htmlTipo[1] : null, htmlHora: htmlHora ? htmlHora[1] : null };
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(e && e.stack ? e.stack : e);
  }
}

check("Manzano parse unchanged", () => {
  const parsed = parseManzanoPedido(manzanoPayload.pedido);
  assert.deepEqual(parsed, baseline.parsed);
});

check("Manzano email is byte-identical except timestamp", () => {
  const email = buildRossoEmail(manzanoPayload);
  assert.equal(email.subject, baseline.subject);
  assert.equal(norm(email.text), baseline.text);
  assert.equal(norm(email.html), baseline.html);
  assert.equal(email.text.includes("Hora de recogida"), false);
  assert.equal(email.html.includes("Hora de recogida"), false);
  assert.equal(email.text.includes("Pedido programado"), false);
});

check("Chanchito prefix Pedido programado: + hora_recogida field", () => {
  const email = buildRossoEmail(chanchitoProgramadoPayload);
  const rows = pedidoRows(email);
  assert.equal(email.subject, "Nuevo pedido: Carlos Lopez");
  assert.deepEqual(rows.textRows, [
    ["Tipo de pedido", "Pedido programado"],
    ["Hora de recogida", "3:30 p.m."],
    ["Total", "250 lempiras"],
  ]);
  assert.equal(rows.htmlTipo, "Pedido programado");
  assert.equal(rows.htmlHora, "3:30 p.m.");
  assert.match(email.text, /1 Chanchito Personal — 250 lempiras/);
  assert.equal(/\nHora:\s*3:30 p\.m\./.test(email.text), false, "Hora: line should be lifted out of detalle");
});

check("Chanchito fallback: Hora: line when hora_recogida is absent", () => {
  const { hora_recogida, ...rest } = chanchitoProgramadoPayload;
  const email = buildRossoEmail({ ...rest, hora_recogida: "" });
  const rows = pedidoRows(email);
  assert.deepEqual(rows.textRows[0], ["Tipo de pedido", "Pedido programado"]);
  assert.deepEqual(rows.textRows[1], ["Hora de recogida", "3:30 p.m."]);
  assert.equal(rows.htmlHora, "3:30 p.m.");
});

check("Chanchito hora_recogida field wins over Hora: line", () => {
  const email = buildRossoEmail({
    ...chanchitoProgramadoPayload,
    hora_recogida: "7:00 p.m.",
    pedido: "Pedido programado:\nHora: 3:30 p.m.\n1 Chanchito Personal — 250 lempiras",
  });
  assert.deepEqual(pedidoRows(email).textRows[1], ["Hora de recogida", "7:00 p.m."]);
});

check("Chanchito programado without any hour shows (no indicada)", () => {
  const email = buildRossoEmail({
    ...chanchitoProgramadoPayload,
    hora_recogida: "",
    tipo_pedido: "pedido programado",
    _tipoPedidoRaw: "pedido programado",
    pedido: "Pedido programado:\n1 Chanchito Personal — 250 lempiras",
  });
  const rows = pedidoRows(email);
  assert.deepEqual(rows.textRows[0], ["Tipo de pedido", "Pedido programado"]);
  assert.deepEqual(rows.textRows[1], ["Hora de recogida", "(no indicada)"]);
  assert.equal(rows.htmlHora, "(no indicada)");
});

check("Chanchito tipo_pedido=programado without prefix", () => {
  const email = buildRossoEmail({
    ...chanchitoProgramadoPayload,
    tipo_pedido: "",
    _tipoPedidoRaw: "programado",
    pedido: "1 Chanchito Personal — 250 lempiras\nHora: 4:00 p.m.",
    hora_recogida: "",
  });
  const rows = pedidoRows(email);
  assert.deepEqual(rows.textRows[0], ["Tipo de pedido", "Pedido programado"]);
  assert.deepEqual(rows.textRows[1], ["Hora de recogida", "4:00 p.m."]);
});

check("Chanchito recoger does not add Hora de recogida", () => {
  const email = buildRossoEmail({
    ...chanchitoProgramadoPayload,
    tipo_pedido: "Para recoger",
    _tipoPedidoRaw: "recoger",
    hora_recogida: "",
    pedido: "Recoger:\n1 Chanchito Personal — 250 lempiras\nPago: Efectivo",
  });
  const rows = pedidoRows(email);
  assert.deepEqual(rows.textRows[0], ["Tipo de pedido", "Para recoger"]);
  assert.equal(rows.textRows.some((r) => r[0] === "Hora de recogida"), false);
  assert.equal(rows.htmlHora, null);
});

check("applyChanchitoPedidoFields is a no-op for Manzano", () => {
  const out = applyChanchitoPedidoFields(manzanoPayload);
  assert.equal(out, manzanoPayload);
});

check("parseChanchitoPedido recognizes prefix and Hora line", () => {
  const parsed = parseChanchitoPedido(chanchitoProgramadoPayload.pedido);
  assert.equal(parsed.tipo, "Pedido programado");
  assert.equal(parsed.horaRecogida, "3:30 p.m.");
  assert.deepEqual(parsed.items, ["1 Chanchito Personal — 250 lempiras"]);
  assert.equal(parsed.pago, "Efectivo");
});

check("applyRossoTipoRoute keeps Chanchito programado and still defaults others to recoger", () => {
  const chReq = { params: { sucursal: "El Chanchito", tipo: "pedido" }, body: { tipo_pedido: "programado", nombre: "Carlos" } };
  assert.equal(applyRossoTipoRoute(chReq, { status() { return this; }, json() {} }), true);
  assert.equal(chReq.body.tipo, "pedido");
  assert.equal(chReq.body.tipo_pedido, "pedido programado");
  assert.equal(chReq.body.sucursal, "El Chanchito");

  const mzReq = { params: { sucursal: "Manzano", tipo: "pedido" }, body: { tipo_pedido: "programado", nombre: "Ana" } };
  assert.equal(applyRossoTipoRoute(mzReq, { status() { return this; }, json() {} }), true);
  assert.equal(mzReq.body.tipo_pedido, "recoger");
  assert.equal(mzReq.body.sucursal, "Manzano");
});

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
