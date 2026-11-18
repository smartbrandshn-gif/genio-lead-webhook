import assert from "node:assert/strict";
process.env.LEAD_WEBHOOK_SECRET = "test-secret";
process.env.SMTP_USER = "";
delete process.env.TRANSMUNDO_ROUTE_TO_AGENTS;
delete process.env.TRANSMUNDO_DRY_RUN;
const { app, resolveTransmundoAgente, transmundoRouting } = await import("../server.js");
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}/webhooks/pedido/Transmundo/consulta`;
const post = (body, secret) => fetch(base, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { "X-Lead-Secret": secret } : {}) },
  body: JSON.stringify(body),
});
const valid = {
  nombre: "Ana López",
  telefono: "99881234",
  telefono_confirmado: true,
  agente: "Kelly Gudiel",
  tipo_cliente: "frecuente",
  consulta: "Quiere cotizar un viaje familiar",
  dry_run: true,
};
try {
  assert.equal((await post({})).status, 401);
  let r = await post({}, "test-secret");
  assert.equal(r.status, 400);

  r = await post(valid, "test-secret");
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.dry_run, true);
  assert.equal(j.to, "sarmientod6@gmail.com");
  assert.equal(j.destinatario_real, "kelly.gudiel@transmundohn.com");
  assert.equal(j.route_to_agents, false);
  assert.equal(j.subject, "Transmundo – Consulta para Kelly Gudiel – Ana López");
  assert.match(j.text, /MODO PRUEBA/);
  assert.match(j.text, /kelly\.gudiel@transmundohn\.com/);

  const kelly = resolveTransmundoAgente("kelly");
  assert.equal(kelly.email, "kelly.gudiel@transmundohn.com");
  process.env.TRANSMUNDO_ROUTE_TO_AGENTS = "1";
  const routed = transmundoRouting({ tipo_cliente: "frecuente", agente: "Kelly Gudiel" }, kelly);
  assert.equal(routed.routeOn, true);
  assert.equal(routed.toEmail, "kelly.gudiel@transmundohn.com");
  delete process.env.TRANSMUNDO_ROUTE_TO_AGENTS;

  const nuevo = {
    nombre: "Carlos Pérez",
    telefono: "31905551",
    telefono_confirmado: true,
    agente: "Nuevo cliente",
    tipo_cliente: "nuevo",
    consulta: "Viaje de Tegucigalpa a Buenos Aires",
    origen: "Tegucigalpa",
    destino: "Buenos Aires",
    fecha_ida: "10 de diciembre",
    fecha_regreso: "20 de diciembre",
    adultos: 2,
    ninos: 1,
    vacuna_fiebre_amarilla: "sí",
    dry_run: true,
  };
  r = await post(nuevo, "test-secret");
  const n = await r.json();
  assert.equal(n.ok, true);
  assert.equal(n.to, "sarmientod6@gmail.com");
  assert.match(n.subject, /Nuevo cliente/);
  assert.match(n.text, /Buenos Aires/);

  const other = await fetch(`http://127.0.0.1:${srv.address().port}/webhooks/pedido/Manzano/consulta`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Lead-Secret": "test-secret" },
    body: JSON.stringify(valid),
  });
  assert.equal(other.status, 404);

  console.log("transmundo-consulta OK");
} finally {
  srv.close();
}
