// El Chanchito: POST /webhooks/chanchito/enviar-menu (nunca envía correo real: MAIL_DRY_RUN=1 + dry_run)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.GENIO_NO_LISTEN = "1";
process.env.LEAD_WEBHOOK_SECRET = "test-secret";
process.env.MAIL_DRY_RUN = "1";
const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), "chanchito-menu-"));
process.env.MAIL_DRY_RUN_DIR = mailDir;
delete process.env.CHANCHITO_MENU_COPY_EMAIL;

const assert = (await import("node:assert/strict")).default;
const { app, buildChanchitoMenuEmail } = await import("../server.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (body, headers = { "X-Lead-Secret": "test-secret" }) => {
  const r = await fetch(`${base}/webhooks/chanchito/enviar-menu`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const sent = () => fs.readdirSync(mailDir);
const t = (name, fn) => Promise.resolve().then(fn).then(() => console.log("ok ", name));

try {
  await t("sin secreto → 401", async () => {
    const r = await post({ correo: "a@b.com" }, {});
    assert.equal(r.status, 401);
    assert.equal(r.json.ok, false);
  });
  await t("correo inválido → 400 correo_invalido", async () => {
    for (const correo of ["", "juan", "a@b", "a@b.com, c@d.com", "x@y.com\nBcc: z@w.com"]) {
      const r = await post({ correo });
      assert.equal(r.status, 400, correo);
      assert.equal(r.json.error, "correo_invalido");
    }
    assert.equal(sent().length, 0);
  });
  await t("dry_run valida sin enviar (forma hablada)", async () => {
    const r = await post({ correo: "Juan Perez arroba Gmail punto com", nombre: "Juan", dry_run: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.enviado, false);
    assert.equal(r.json.correo, "juanperez@gmail.com");
    assert.ok(r.json.pdf_bytes > 10000);
    const r2 = await post({ correo: "juan@gmail.com", dry_run: "true" });
    assert.equal(r2.json.dry_run, true);
    assert.equal(sent().length, 0);
  });
  await t("envío normal adjunta el PDF del menú", async () => {
    const r = await post({ correo: "juan.perez@gmail.com", nombre: "Juan" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, mensaje: "Menú enviado a juan.perez@gmail.com" });
    const files = sent();
    assert.equal(files.length, 1);
    const msg = JSON.parse(fs.readFileSync(path.join(mailDir, files[0]), "utf8"));
    assert.equal(msg.subject, "Menú El Chanchito");
    assert.equal(msg.to[0].address, "juan.perez@gmail.com");
    assert.match(msg.from.name, /El Chanchito/);
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0].filename, "Menu-El-Chanchito.pdf");
    assert.equal(msg.attachments[0].contentType, "application/pdf");
    const pdf = Buffer.from(msg.attachments[0].content, "base64");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  });
  await t("texto del correo", () => {
    const e = buildChanchitoMenuEmail("");
    assert.match(e.text, /^Hola,/);
    assert.match(e.text, /El Chanchito/);
    assert.match(buildChanchitoMenuEmail("<b>Ana</b>").html, /Hola &lt;b&gt;Ana/);
  });
  await t("rutas existentes siguen respondiendo", async () => {
    const r = await fetch(`${base}/webhooks/manzano/enviar-menu`, { method: "POST", headers: { "Content-Type": "application/json", "X-Lead-Secret": "test-secret" }, body: JSON.stringify({ correo: "no-valido" }) });
    assert.equal(r.status, 400);
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
  });
} finally {
  server.close();
  fs.rmSync(mailDir, { recursive: true, force: true });
}
