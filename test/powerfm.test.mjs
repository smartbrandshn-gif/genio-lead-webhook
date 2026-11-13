import assert from "node:assert/strict";
import express from "express";
import {
  normalizarTelefono, normalizarFecha, normalizarSexo, coincidenciaNombre, buscarEnFilas, registerPowerFmRoutes,
} from "../powerfm.js";

const t = (name, fn) => Promise.resolve().then(fn).then(() => console.log("ok ", name));

await t("normalizarTelefono", () => {
  assert.equal(normalizarTelefono("98501161"), "98501161");
  assert.equal(normalizarTelefono("+504 9850-1161"), "98501161");
  assert.equal(normalizarTelefono("50498501161"), "98501161");
  assert.equal(normalizarTelefono("sip:+50498501161@telesys"), "98501161");
  assert.equal(normalizarTelefono("{{caller_number}}"), "");
  assert.equal(normalizarTelefono(""), "");
  assert.equal(normalizarTelefono("anonymous"), "");
  assert.equal(normalizarTelefono("1234"), "");
});
await t("normalizarFecha", () => {
  assert.equal(normalizarFecha("15/03/1990"), "1990-03-15");
  assert.equal(normalizarFecha("1990-03-15"), "1990-03-15");
  assert.equal(normalizarFecha("15 de marzo de 1990"), "1990-03-15");
  assert.equal(normalizarFecha("quince de marzo de 1990"), "1990-03-15");
  assert.equal(normalizarFecha("1 de Septiembre del 2001"), "2001-09-01");
  assert.equal(normalizarFecha("31/02/1990"), "");
  assert.equal(normalizarFecha("mañana"), "");
});
await t("normalizarSexo", () => {
  assert.equal(normalizarSexo("mujer"), "Femenino");
  assert.equal(normalizarSexo("Masculino"), "Masculino");
  assert.equal(normalizarSexo("x"), "");
});
await t("coincidenciaNombre", () => {
  assert.ok(coincidenciaNombre("jose perez", "José Pérez López") > 0);
  assert.ok(coincidenciaNombre("Daniel Sarmiento", "daniel sarmiento") === 1);
  assert.ok(coincidenciaNombre("Maria Velasquez", "María Belásquez") > 0);
  assert.equal(coincidenciaNombre("Jose", "José Pérez"), 0); // un solo token no basta
  assert.equal(coincidenciaNombre("Carlos Perez", "José Pérez"), 0);
});
await t("buscarEnFilas", () => {
  const rows = [
    { nombre_apellido: "José Pérez López", fecha_nacimiento: "1990-03-15", telefono: "98501161", ciudad: "Tegucigalpa" },
    { nombre_apellido: "Ana Gómez", fecha_nacimiento: "1985-01-02", telefono: "33334444", ciudad: "SPS" },
  ];
  assert.equal(buscarEnFilas(rows, { telefono: "98501161" }).metodo, "telefono");
  assert.equal(buscarEnFilas(rows, { telefono: "", nombre: "jose perez", fecha: "1990-03-15" }).encontrado, true);
  assert.equal(buscarEnFilas(rows, { telefono: "", nombre: "jose perez", fecha: "1990-03-16" }).encontrado, false);
  assert.equal(buscarEnFilas(rows, { telefono: "11112222" }).encontrado, false);
});

// HTTP end-to-end con store en memoria
const mem = []; 
const store = { tipo: "memoria", async list() { return mem; }, async append(r) { mem.push(r); } };
const app = express();
app.use(express.json());
registerPowerFmRoutes(app, { checkSecret: (req) => req.get("X-Lead-Secret") === "s" ? { ok: true } : { ok: false, status: 401, error: "no" }, store });
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}/webhooks/powerfm`;
const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Lead-Secret": "s", ...h }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json() }));
const orig = console.log; console.log = () => {};
try {
  let r = await post("/buscar-oyente", { caller_number: "+50498501161" }, { "X-Lead-Secret": "bad" });
  assert.equal(r.status, 401);
  r = await post("/buscar-oyente", { caller_number: "+50498501161" });
  assert.equal(r.j.encontrado, false); assert.equal(r.j.telefono_detectado, "98501161");
  r = await post("/registrar-oyente", { nombre_apellido: "jose perez", ciudad: "tegucigalpa", fecha_nacimiento: "15/03/1990", sexo: "hombre" });
  assert.equal(r.status, 400); assert.deepEqual(r.j.faltan, ["telefono"]);
  r = await post("/registrar-oyente", { nombre_apellido: "jose perez", ciudad: "tegucigalpa", fecha_nacimiento: "15/03/1990", sexo: "hombre", caller_number: "98501161", dry_run: true });
  assert.equal(r.j.dry_run, true); assert.equal(mem.length, 0);
  r = await post("/registrar-oyente", { nombre_apellido: "jose perez", ciudad: "tegucigalpa", fecha_nacimiento: "15/03/1990", sexo: "hombre", caller_number: "98501161" });
  assert.equal(r.j.registrado, true); assert.equal(mem.length, 1); assert.equal(mem[0].nombre_apellido, "Jose Perez"); assert.equal(mem[0].fuente_telefono, "caller_id");
  r = await post("/registrar-oyente", { nombre_apellido: "Otro Nombre", ciudad: "x", fecha_nacimiento: "1/1/2000", sexo: "f", telefono: "+504 9850 1161" });
  assert.equal(r.j.ya_registrado, true); assert.equal(mem.length, 1);
  r = await post("/buscar-oyente", { caller_number: "98501161" });
  assert.equal(r.j.encontrado, true); assert.equal(r.j.primer_nombre, "Jose");
  r = await post("/buscar-oyente", { caller_number: "", nombre: "José Pérez", fecha_nacimiento: "15 de marzo de 1990" });
  assert.equal(r.j.encontrado, true); assert.equal(r.j.metodo, "nombre_fecha");
  r = await post("/buscar-oyente", {}, { "X-Caller-Number": "50498501161" });
  assert.equal(r.j.encontrado, true);
} finally { console.log = orig; srv.close(); }
console.log("ok  http e2e\n\npowerfm tests passed");
