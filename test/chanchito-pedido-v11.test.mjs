process.env.GENIO_NO_LISTEN = "1";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRossoEmail, parseChanchitoPedido, looksFake, looksFakePedido, validateRosso, extractRosso } from "../server.js";
import { GOLDEN_CASES } from "./golden-cases.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "rosso-email-golden.json"), "utf8"));
const TS_RE = /\b(?:Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes|S[aá]bado|Domingo), \d{1,2} de (?:Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre) de \d{4}, \d{1,2}:\d{2}:\d{2} [ap]\. m\./gi;
const norm = (s) => String(s).replace(TS_RE, "<TS>");

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}`); console.error(e?.stack || e); } };
const detalle = (email) => { const m = email.text.match(/\nDetalle:\n([\s\S]*?)\n(?:Comentario del cliente|Método de pago|RTN|Factura|Total):/); return m ? m[1].split("\n") : null; };

// Pedido real del 13 nov 2026 15:22 UTC (logs de Render)
const daniel = { tipo: "pedido", sucursal: "El Chanchito", nombre: "Daniel", telefono: "95660886", telefono_confirmado: true, tipo_pedido: "Pedido programado", _tipoPedidoRaw: "recoger", hora_recogida: "3 P.M.", total: 565, comentario_cliente: "Ninguno", metodo_pago: "", notas: "" };
const ML = "Pedido programado:\nHora: 3 P.M.\nGourmet Sandwich con Papas — 295 lempiras\n• Proteína: Pulled Pork\nYuca con Chicharrón — 270 lempiras\n• Proteína: Costilla Frita\n• Yuca: Al mojo";
const SL = "Pedido programado: Hora: 3 P.M. Gourmet Sandwich con Papas - 295 lempiras, Proteina: Pulled Pork. Yuca con Chicharron - 270 lempiras, Proteina: Costilla Frita, Yuca: Al mojo.";

for (const [k, p] of Object.entries(GOLDEN_CASES)) {
  check(`golden sin cambios: ${k}`, () => {
    const e = buildRossoEmail(structuredClone(p));
    assert.equal(e.subject, golden[k].subject);
    assert.equal(norm(e.text), golden[k].text);
    assert.equal(norm(e.html), golden[k].html);
  });
}

check("bug 1: pedido multilínea con «Proteína» ya no es «pedido es requerido»", () => {
  assert.equal(looksFakePedido(ML), false);
  assert.equal(validateRosso({ ...daniel, pedido: ML }), "");
  assert.equal(looksFake("Proteína"), false);
  assert.equal(looksFake("Medina"), false);
  assert.equal(looksFake("N/A"), true);
  assert.equal(looksFake("na"), true);
  assert.equal(looksFake("caller_id"), true);
  assert.equal(looksFakePedido(""), true);
  assert.equal(looksFakePedido("N/A"), true);
  assert.equal(validateRosso({ ...daniel, pedido: "" }), "pedido es requerido");
});

check("extractRosso acepta pedido_completo / detalle_pedido como alias", () => {
  const req = (body) => ({ body, query: {}, get: () => "", params: {} });
  assert.equal(extractRosso(req({ sucursal: "El Chanchito", tipo: "pedido", pedido_completo: ML })).pedido, ML);
  assert.equal(extractRosso(req({ sucursal: "El Chanchito", tipo: "pedido", detalle_pedido: ML })).pedido, ML);
});

check("multilínea v11: plato + opciones elegidas", () => {
  const e = buildRossoEmail({ ...daniel, pedido: ML });
  assert.deepEqual(detalle(e), ["Gourmet Sandwich con Papas — 295 lempiras", "•Proteína: Pulled Pork", "Yuca con Chicharrón — 270 lempiras", "•Proteína: Costilla Frita", "•Yuca: Al mojo"]);
  assert.match(e.text, /Hora de recogida: 3 P\.M\./);
});

check("bug 2: una sola línea se parte en platos y opciones (antes salía vacío)", () => {
  const e = buildRossoEmail({ ...daniel, pedido: SL });
  assert.deepEqual(detalle(e), ["Gourmet Sandwich con Papas - 295 lempiras", "•Proteina: Pulled Pork", "Yuca con Chicharron - 270 lempiras", "•Proteina: Costilla Frita", "•Yuca: Al mojo"]);
  assert.match(e.html, /Gourmet Sandwich con Papas - 295 lempiras/);
  assert.match(e.text, /Hora de recogida: 3 P\.M\./);
});

check("plato sin opciones: solo el nombre (ambos formatos)", () => {
  const a = parseChanchitoPedido("Pedido programado:\nHora: 3 P.M.\nPastelitos de Panceta — 185 lempiras\nYuca con Chicharrón — 270 lempiras\n• Proteína: Costilla Frita\n• Yuca: Al mojo");
  assert.deepEqual(a.items, ["Pastelitos de Panceta — 185 lempiras", "Yuca con Chicharrón — 270 lempiras", "•Proteína: Costilla Frita", "•Yuca: Al mojo"]);
  const b = parseChanchitoPedido("Pedido programado: Hora: 3 P.M. Pastelitos de Panceta - 185 lempiras. Yuca con Chicharron - 270 lempiras, Proteina: Costilla Frita, Yuca: Al mojo.");
  assert.deepEqual(b.items, ["Pastelitos de Panceta - 185 lempiras", "Yuca con Chicharron - 270 lempiras", "•Proteina: Costilla Frita", "•Yuca: Al mojo"]);
});

check("saltos escapados (\\n literal) se tratan como Enter", () => {
  const r = parseChanchitoPedido(ML.replace(/\n/g, "\\n"));
  assert.equal(r.horaRecogida, "3 P.M.");
  assert.equal(r.items[0], "Gourmet Sandwich con Papas — 295 lempiras");
});

check("nunca detalle vacío: sin platos → aviso visible", () => {
  const r = parseChanchitoPedido("Pedido programado: Hora: 3 P.M.");
  assert.deepEqual(r.items, ["(pedido sin detalle: revisar la llamada)"]);
});

check("Hora con texto no es partida («3 de la tarde»)", () => {
  const r = parseChanchitoPedido("Pedido programado:\nHora: 3 de la tarde\n1 Chanchito — 250 lempiras");
  assert.equal(r.horaRecogida, "3 de la tarde");
  assert.deepEqual(r.items, ["1 Chanchito — 250 lempiras"]);
});

if (failed) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
console.log("\nall tests passed");
