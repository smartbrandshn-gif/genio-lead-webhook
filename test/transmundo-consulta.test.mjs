import assert from "node:assert/strict";
process.env.LEAD_WEBHOOK_SECRET = "test-secret";
process.env.SMTP_USER = "";
delete process.env.TRANSMUNDO_ROUTE_TO_AGENTS;
delete process.env.TRANSMUNDO_DRY_RUN;
const { app, resolveTransmundoAgente, transmundoRouting, buildTransmundoEmail } = await import("../server.js");
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
  assert.equal(j.subject, "Consulta – Ana López");
  assert.match(j.text, /SOLICITUD DEL CLIENTE/);
  assert.match(j.text, /Quiere cotizar un viaje familiar/);
  assert.doesNotMatch(j.text, /Detalle:/);
  assert.doesNotMatch(j.text, /Agente:|Tipo de cliente:/);
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
  assert.equal(n.subject, "Compra de boleto aéreo – Carlos Pérez");
  assert.equal(n.destinatario_real, "sin asignar (aún no hay correo de clientes nuevos)");
  assert.match(n.text, /Número de personas: 3/);
  assert.match(n.text, /Vacuna de la fiebre amarilla: Sí/);
  assert.doesNotMatch(n.text, /OTRA CONSULTA|SOLICITUD DEL CLIENTE/);
  assert.match(n.text, /Buenos Aires/);

  // Campos desglosados nuevos
  r = await post({
    nombre: "Daniel Sarmiento", telefono: "95660886", telefono_confirmado: true,
    agente: "María José Baltodano", tipo_cliente: "frecuente", tipo_consulta: "boleto",
    tipo_boleto: "ida y vuelta", fecha_ida: "24 de diciembre", fecha_regreso: "7 de enero",
    origen: "San Pedro Sula, Honduras", destino: "San Diego, Estados Unidos",
    personas: 3, infantes: "no", tipo_vuelo: "directo", horario: "mañana",
    maleta_documentada: true, personas_maleta: 2, asiento: "pasillo", visa: "sí", dry_run: true,
  }, "test-secret");
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.subject, "Compra de boleto aéreo – Daniel Sarmiento");
  assert.equal(d.destinatario_real, "mariajose.baltodano@transmundohn.com");
  for (const re of [/Tipo de boleto: Ida y vuelta/, /Fecha de regreso: 7 de enero/, /Infantes menores de 2 años: No/,
    /Tipo de vuelo: Directo/, /Horario preferido: Mañana/, /Maleta documentada: Sí/,
    /Personas con maleta documentada: 2 de 3/, /Asiento: Pasillo/, /Visa vigente de EE\. UU\.: Sí/]) assert.match(d.text, re);
  assert.doesNotMatch(d.text, /Vacuna|OTRA CONSULTA|SOLICITUD DEL CLIENTE|Consulta:/);

  // Solo ida oculta la fecha de regreso
  const e = buildTransmundoEmail({ nombre: "X", telefono: "99999999", tipo_consulta: "boleto", tipo_boleto: "solo ida",
    fecha_ida: "1 de marzo", fecha_regreso: "9 de marzo", destino: "Lima" },
    { routeOn: false, toEmail: "sarmientod6@gmail.com", intendedEmail: "", intendedLabel: "x" }, null);
  assert.doesNotMatch(e.text, /Fecha de regreso/);
  assert.match(e.html, /Modo prueba/);

  // Parada intermedia: varias paradas, "no", vacío y respaldo `paradas`
  r = await post({
    nombre: "Daniel Sarmiento", telefono: "95660886", telefono_confirmado: true,
    agente: "María José Baltodano", tipo_cliente: "frecuente", tipo_consulta: "boleto",
    tipo_boleto: "ida y vuelta", fecha_ida: "28 de diciembre", fecha_regreso: "5 de enero",
    origen: "San Pedro Sula, Honduras", destino: "París, Francia",
    parada_intermedia: "Miami, 3 días; Madrid, 2 días",
    personas: 2, infantes: "no", tipo_vuelo: "con escala", horario: "mañana",
    maleta_documentada: "sí", personas_maleta: 2, asiento: "ventana", dry_run: true,
  }, "test-secret");
  const par = await r.json();
  assert.equal(par.ok, true);
  assert.match(par.text, /Paradas intermedias: Miami, 3 días; Madrid, 2 días/);
  assert.doesNotMatch(par.text, /Visa|Vacuna/);

  const noParada = buildTransmundoEmail({ nombre: "X", telefono: "99999999", tipo_consulta: "boleto",
    tipo_boleto: "ida y vuelta", fecha_ida: "1 de marzo", fecha_regreso: "9 de marzo",
    origen: "Tegucigalpa", destino: "París", parada_intermedia: "no" },
    { routeOn: false, toEmail: "sarmientod6@gmail.com", intendedEmail: "", intendedLabel: "x" }, null);
  assert.match(noParada.text, /Parada intermedia: No/);
  assert.doesNotMatch(noParada.text, /Paradas intermedias/);

  const sinParada = buildTransmundoEmail({ nombre: "X", telefono: "99999999", tipo_consulta: "boleto",
    destino: "París" },
    { routeOn: false, toEmail: "sarmientod6@gmail.com", intendedEmail: "", intendedLabel: "x" }, null);
  assert.doesNotMatch(sinParada.text, /Parada intermedia|Paradas intermedias/);

  r = await post({
    nombre: "Ana López", telefono: "99881234", telefono_confirmado: true,
    agente: "Kelly Gudiel", tipo_cliente: "frecuente", tipo_consulta: "boleto",
    tipo_boleto: "solo ida", fecha_ida: "10 de abril",
    origen: "Tegucigalpa, Honduras", destino: "Miami, Estados Unidos",
    paradas: "Ciudad de México, 1 día",
    personas: 1, dry_run: true,
  }, "test-secret");
  const fallback = await r.json();
  assert.equal(fallback.ok, true);
  assert.match(fallback.text, /Parada intermedia: Ciudad de México, 1 día/);

  // Solicitud del cliente (no boleto): párrafo a ancho completo, otra_consulta con fallback
  const solicitud = "Quiere cambiar la fecha de regreso de su boleto San Pedro Sula–Madrid del 10 al 17 de enero para 2 personas; pregunta si hay penalidad.";
  const o = buildTransmundoEmail({
    nombre: "Carlos Pérez", telefono: "31905551", tipo_cliente: "nuevo", agente: "Nuevo cliente",
    tipo_consulta: "otra", otra_consulta: solicitud, consulta: "resumen breve",
  }, { routeOn: false, toEmail: "sarmientod6@gmail.com", intendedEmail: "", intendedLabel: "sin asignar (aún no hay correo de clientes nuevos)" }, null);
  assert.equal(o.subject, "Consulta – Carlos Pérez");
  assert.match(o.text, /SOLICITUD DEL CLIENTE/);
  assert.match(o.text, /Quiere cambiar la fecha de regreso/);
  assert.doesNotMatch(o.text, /Detalle:|Compra de boleto|Tipo de boleto:|VIAJE/);
  assert.match(o.html, /SOLICITUD DEL CLIENTE/);
  assert.doesNotMatch(o.html, />Detalle</);
  assert.doesNotMatch(o.html, /colspan="2"[^>]*>resumen breve/);
  const escaped = buildTransmundoEmail({
    nombre: "Ana", telefono: "99881234", tipo_consulta: "otra",
    otra_consulta: 'Cambio <urgente> & "penalidad"\nsegunda línea',
  }, { routeOn: false, toEmail: "sarmientod6@gmail.com", intendedEmail: "", intendedLabel: "x" }, null);
  assert.match(escaped.html, /Cambio &lt;urgente&gt; &amp; &quot;penalidad&quot;<br>segunda línea/);
  assert.doesNotMatch(escaped.html, /<urgente>/);

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
