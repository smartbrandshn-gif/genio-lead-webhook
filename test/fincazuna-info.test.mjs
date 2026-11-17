import assert from "node:assert/strict";
process.env.LEAD_WEBHOOK_SECRET = "test-secret";
process.env.SMTP_USER = "";
const { app, buildFincaZunaInfoEmail } = await import("../server.js");
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}/webhooks/pedido/FincaZuna/info`;
const post = (body, secret) => fetch(base, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "X-Lead-Secret": secret } : {}) }, body: JSON.stringify(body) });
try {
  assert.equal((await post({})).status, 401);
  let r = await post({}, "test-secret"); assert.equal(r.status, 400); console.log((await r.json()).error);
  r = await post({ correo_electronico: "a@b.com", tipo: "otro" }, "test-secret"); assert.equal(r.status, 400);
  r = await post({ correo_electronico: "Juan@Gmail.com", tipo: "ambos", dry_run: true }, "test-secret");
  const j = await r.json(); assert.equal(j.ok, true); assert.equal(j.to, "juan@gmail.com"); assert.equal(j.subject, "Finca Zuna – Ubicación y cuentas");
  for (const t of ["ubicacion", "cuentas", "ambos"]) {
    const e = buildFincaZunaInfoEmail("Ana", t);
    assert.equal(e.text.includes("14.291059,-88.092522"), t !== "cuentas");
    assert.equal(e.text.includes("212470081500"), t !== "ubicacion");
    assert.ok(e.text.includes("no confirma ninguna reserva"));
  }
  console.log("fincazuna-info OK");
} finally { srv.close(); }
