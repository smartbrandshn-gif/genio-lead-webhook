/**
 * Power FM — registro de oyentes (agente Regina).
 *
 *   POST /webhooks/powerfm/buscar-oyente     (header X-Lead-Secret)
 *   POST /webhooks/powerfm/registrar-oyente  (header X-Lead-Secret)
 *   GET  /webhooks/powerfm/oyentes.csv       (header X-Lead-Secret) — exportación
 *
 * Almacenamiento (en orden de preferencia):
 *   1. Google Sheet vía Apps Script web app: POWERFM_SHEET_URL (+ POWERFM_SHEET_TOKEN).
 *   2. Archivo JSON local: POWERFM_DATA_FILE (default ./data/powerfm-oyentes.json).
 *      En Render sin disco persistente este archivo SE PIERDE en cada deploy/reinicio.
 *      Para hacerlo durable, montar un Render Disk y apuntar POWERFM_DATA_FILE a él.
 * Cada registro también se escribe en el log como `[powerfm] registro {...}` (respaldo).
 */
import fs from "node:fs";
import path from "node:path";

const SHEET_URL = (process.env.POWERFM_SHEET_URL || "").trim();
const SHEET_TOKEN = (process.env.POWERFM_SHEET_TOKEN || "").trim();
const DATA_FILE = process.env.POWERFM_DATA_FILE || "./data/powerfm-oyentes.json";
const CACHE_MS = Number(process.env.POWERFM_SHEET_CACHE_MS || 60000);

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12,
};
const NUM_PALABRAS = {
  uno: 1, primero: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30,
  treintaiuno: 31, "treinta y uno": 31,
};

export function sinTildes(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Normaliza teléfono hondureño: solo dígitos, quita 504 inicial si son 11, compara últimos 8. */
export function normalizarTelefono(raw) {
  const s = String(raw ?? "").trim();
  if (!s || /\{\{|\}\}|\$\{/.test(s)) return ""; // plantilla sin resolver
  if (/^(no|null|undefined|unknown|anonymous|anonimo|an[oó]nimo|private|privado|desconocido)$/i.test(s)) return "";
  let d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("504")) d = d.slice(3);
  if (d.length < 8) return "";
  return d.slice(-8);
}

/** Fecha → YYYY-MM-DD. Acepta DD/MM/AAAA, DD-MM-AAAA, AAAA-MM-DD, «15 de marzo de 1990». */
export function normalizarFecha(raw) {
  let s = sinTildes(String(raw || "")).toLowerCase().trim();
  if (!s) return "";
  let d, m, y;
  let mm = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  if (!y) {
    mm = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/);
    if (mm) { d = +mm[1]; m = +mm[2]; y = +mm[3]; }
  }
  if (!y) {
    s = s.replace(/\bdel?\b/g, " ").replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
    for (const [w, n] of Object.entries(NUM_PALABRAS).sort((a, b) => b[0].length - a[0].length)) {
      s = s.replace(new RegExp(`^${w}\\b`), String(n));
    }
    mm = s.match(/^(\d{1,2}) ([a-z]+) (\d{2,4})$/);
    if (mm && MESES[mm[2]]) { d = +mm[1]; m = MESES[mm[2]]; y = +mm[3]; }
  }
  if (!y) return "";
  if (y < 100) y += y > (new Date().getFullYear() % 100) ? 1900 : 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return "";
  if (y < 1900 || dt > new Date()) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function fechaLegible(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y) return "";
  const nombres = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  return `${d} de ${nombres[m - 1]} de ${y}`;
}

export function normalizarSexo(raw) {
  const s = sinTildes(String(raw || "")).toLowerCase().trim();
  if (/^(m|masculino|hombre|varon|male)$/.test(s)) return "Masculino";
  if (/^(f|femenino|mujer|female)$/.test(s)) return "Femenino";
  if (/^(otro|otra|prefiero no decir|no binario)$/.test(s)) return "Otro";
  return "";
}

const PARTICULAS = new Set(["de", "del", "la", "las", "los", "y", "da", "van", "von"]);
export function tokensNombre(s) {
  return sinTildes(s).toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t && !PARTICULAS.has(t));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function tokenIgual(a, b) {
  if (a === b) return true;
  const tol = Math.min(a.length, b.length) >= 7 ? 2 : Math.min(a.length, b.length) >= 4 ? 1 : 0;
  if (tol && levenshtein(a, b) <= tol) return true;
  // fonética simple voz→texto: b/v, s/z/c, y/ll, h muda
  const f = (t) => t.replace(/h/g, "").replace(/v/g, "b").replace(/[zc](?=[ei])/g, "s").replace(/z/g, "s").replace(/ll/g, "y");
  return f(a) === f(b);
}

/**
 * Puntaje de coincidencia de nombre (0..1). Coincide si el primer nombre coincide
 * y al menos 2 tokens coinciden (permite que falte un apellido o un segundo nombre).
 */
export function coincidenciaNombre(consulta, registrado) {
  const q = tokensNombre(consulta);
  const r = tokensNombre(registrado);
  if (!q.length || !r.length) return 0;
  const usados = new Set();
  let hits = 0;
  for (const t of q) {
    const idx = r.findIndex((x, i) => !usados.has(i) && tokenIgual(t, x));
    if (idx >= 0) { usados.add(idx); hits++; }
  }
  const primerNombreOk = tokenIgual(q[0], r[0]) || (q.length > 1 && tokenIgual(q[1], r[0]));
  const minimo = Math.min(2, r.length);
  if (!primerNombreOk || hits < minimo) return 0;
  return hits / Math.max(q.length, r.length);
}

function primerNombre(nombre) {
  const t = String(nombre || "").trim().split(/\s+/)[0] || "";
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : "";
}

function limpiarTexto(s, max = 80) {
  return String(s || "").replace(/[<>\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function tituloNombre(s) {
  return limpiarTexto(s).toLowerCase().replace(/(^|\s)(\S)/g, (_m, sp, c) => sp + c.toUpperCase())
    .replace(/(\s)(De|Del|La|Las|Los|Y)(?=\s)/g, (_m, sp, w) => sp + w.toLowerCase());
}

/* ---------------- Almacenamiento ---------------- */

function createFileStore(file) {
  let rows = null;
  const load = () => {
    if (rows) return rows;
    try { rows = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(rows)) rows = []; }
    catch { rows = []; }
    return rows;
  };
  return {
    tipo: "archivo",
    detalle: path.resolve(file),
    async list() { return load(); },
    async append(row) {
      load().push(row);
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 1));
      fs.renameSync(tmp, file);
    },
  };
}

function createSheetStore(url, token) {
  let cache = null;
  let cacheAt = 0;
  return {
    tipo: "google_sheet",
    detalle: "Apps Script web app",
    async list() {
      if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
      const u = new URL(url);
      u.searchParams.set("action", "list");
      if (token) u.searchParams.set("token", token);
      const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (!j.ok || !Array.isArray(j.rows)) throw new Error(`sheet list: ${j.error || r.status}`);
      cache = j.rows;
      cacheAt = Date.now();
      return cache;
    },
    async append(row) {
      const r = await fetch(url, {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "append", token, row }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(`sheet append: ${j.error || r.status}`);
      if (cache) cache.push(row);
    },
  };
}

export function createStore() {
  return SHEET_URL ? createSheetStore(SHEET_URL, SHEET_TOKEN) : createFileStore(DATA_FILE);
}

/* ---------------- Búsqueda ---------------- */

export function buscarEnFilas(rows, { telefono, nombre, fecha }) {
  if (telefono) {
    const hit = rows.find((r) => normalizarTelefono(r.telefono) === telefono);
    if (hit) return { encontrado: true, metodo: "telefono", oyente: hit };
  }
  if (nombre && fecha) {
    const cands = rows
      .filter((r) => normalizarFecha(r.fecha_nacimiento) === fecha)
      .map((r) => ({ r, score: coincidenciaNombre(nombre, r.nombre_apellido) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (cands.length === 1 || (cands.length > 1 && cands[0].score > cands[1].score)) {
      return { encontrado: true, metodo: "nombre_fecha", oyente: cands[0].r, score: cands[0].score };
    }
    if (cands.length > 1) return { encontrado: false, metodo: "nombre_fecha", ambiguo: true };
  }
  return { encontrado: false, metodo: telefono ? "telefono" : nombre && fecha ? "nombre_fecha" : "ninguno" };
}

function headersParaLog(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const lk = k.toLowerCase();
    if (lk === "x-lead-secret" || lk === "authorization" || lk === "cookie") continue;
    if (/caller|from|phone|number|sip|call|x-|user-agent|forwarded/.test(lk)) out[lk] = v;
  }
  return out;
}

function telefonoDeRequest(req, body) {
  const candidatos = [
    ["body.caller_number", body.caller_number],
    ["body.caller_id", body.caller_id],
    ["body.numero_cliente", body.numero_cliente],
    ["body.telefono", body.telefono],
    ["header.x-caller-number", req.get("X-Caller-Number")],
  ];
  for (const [src, v] of candidatos) {
    const t = normalizarTelefono(v);
    if (t) return { telefono: t, fuente: src };
  }
  return { telefono: "", fuente: "ninguna" };
}

/* ---------------- Rutas ---------------- */

export function registerPowerFmRoutes(app, { checkSecret, store = createStore(), now = () => new Date() } = {}) {
  app.post("/webhooks/powerfm/buscar-oyente", async (req, res) => {
    const auth = checkSecret(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { telefono, fuente } = telefonoDeRequest(req, body);
    const nombre = limpiarTexto(body.nombre || body.nombre_apellido || body.nombre_completo);
    const fechaRaw = body.fecha_nacimiento || body.fecha || "";
    const fecha = normalizarFecha(fechaRaw);
    // Log de diagnóstico: qué manda xAI/Telesys exactamente
    console.log("[powerfm] buscar-oyente inbound", JSON.stringify({
      caller_number_raw: body.caller_number ?? null,
      caller_id_raw: body.caller_id ?? null,
      telefono_raw: body.telefono ?? null,
      telefono_normalizado: telefono || null,
      fuente,
      nombre_len: nombre.length,
      fecha_raw: fechaRaw || null,
      fecha_normalizada: fecha || null,
      bodyKeys: Object.keys(body),
      headers: headersParaLog(req),
    }));
    if (fechaRaw && !fecha) {
      return res.json({ ok: true, encontrado: false, telefono_detectado: telefono, error: "fecha_invalida",
        mensaje: "No entendí la fecha de nacimiento. Pídela otra vez con día, mes y año." });
    }
    let rows;
    try { rows = await store.list(); }
    catch (err) {
      console.error("[powerfm] store.list", err?.message || err);
      return res.status(502).json({ ok: false, encontrado: false, telefono_detectado: telefono, error: "almacenamiento_no_disponible",
        mensaje: "No se pudo consultar la base. Continúa como oyente nuevo." });
    }
    const r = buscarEnFilas(rows, { telefono, nombre, fecha });
    console.log("[powerfm] buscar-oyente result", JSON.stringify({ encontrado: r.encontrado, metodo: r.metodo, ambiguo: Boolean(r.ambiguo), total: rows.length }));
    if (r.encontrado) {
      const o = r.oyente;
      return res.json({
        ok: true, encontrado: true, metodo: r.metodo,
        nombre: o.nombre_apellido, primer_nombre: primerNombre(o.nombre_apellido),
        ciudad: o.ciudad || "", telefono_detectado: telefono, telefono_registrado: normalizarTelefono(o.telefono),
        mensaje: `Oyente registrado. Salúdalo por su nombre: ${primerNombre(o.nombre_apellido)}. No le pidas sus datos otra vez.`,
      });
    }
    let mensaje;
    if (r.ambiguo) mensaje = "Hay más de un oyente con datos parecidos. Pídele su número de teléfono y vuelve a consultar.";
    else if (telefono) mensaje = "Número no registrado. Si aún no lo hiciste, pide nombre completo y fecha de nacimiento y vuelve a consultar; si sigue sin aparecer, regístralo.";
    else if (nombre && fecha) mensaje = "No hay un oyente con ese nombre y fecha. Es oyente nuevo: pide ciudad, sexo y teléfono, confirma y registra.";
    else mensaje = "No llegó el número de quien llama. Pide nombre completo y fecha de nacimiento y vuelve a consultar.";
    return res.json({ ok: true, encontrado: false, metodo: r.metodo, ambiguo: Boolean(r.ambiguo), telefono_detectado: telefono, mensaje });
  });

  app.post("/webhooks/powerfm/registrar-oyente", async (req, res) => {
    const auth = checkSecret(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const nombre_apellido = tituloNombre(body.nombre_apellido || body.nombre || body.nombre_completo);
    const ciudad = tituloNombre(body.ciudad);
    const fecha = normalizarFecha(body.fecha_nacimiento || body.fecha);
    const sexo = normalizarSexo(body.sexo);
    const telefono = normalizarTelefono(body.telefono) || normalizarTelefono(body.caller_number) || normalizarTelefono(req.get("X-Caller-Number"));
    const dryRun = body.dry_run === true || body.dry_run === "true" || req.query.dry_run === "1";
    console.log("[powerfm] registrar-oyente inbound", JSON.stringify({
      bodyKeys: Object.keys(body), caller_number_raw: body.caller_number ?? null, telefono_raw: body.telefono ?? null,
      telefono_normalizado: telefono || null, dryRun, headers: headersParaLog(req),
    }));
    const faltan = [];
    if (tokensNombre(nombre_apellido).length < 2) faltan.push("nombre_apellido");
    if (!ciudad) faltan.push("ciudad");
    if (!fecha) faltan.push("fecha_nacimiento");
    if (!sexo) faltan.push("sexo");
    if (!telefono) faltan.push("telefono");
    if (faltan.length) {
      return res.status(400).json({ ok: false, error: "datos_incompletos", faltan,
        mensaje: `Faltan o no son válidos: ${faltan.join(", ")}. Pídeselos al oyente (nombre y apellido; fecha con día, mes y año; sexo masculino o femenino; teléfono de 8 dígitos) y vuelve a registrar.` });
    }
    const row = {
      fecha_registro: now().toISOString(),
      nombre_apellido, ciudad, fecha_nacimiento: fecha, sexo, telefono,
      canal: "llamada", fuente_telefono: normalizarTelefono(body.caller_number) === telefono ? "caller_id" : "dictado",
    };
    if (dryRun) return res.json({ ok: true, dry_run: true, registro: row });
    let rows;
    try { rows = await store.list(); }
    catch (err) {
      console.error("[powerfm] store.list", err?.message || err);
      console.log("[powerfm] registro-no-guardado", JSON.stringify(row));
      return res.status(502).json({ ok: false, error: "almacenamiento_no_disponible", mensaje: "No se pudo guardar el registro ahora. Dile al oyente que quedó anotado y continúa." });
    }
    const existente = rows.find((r) => normalizarTelefono(r.telefono) === telefono);
    if (existente) {
      console.log("[powerfm] registrar-oyente duplicado", JSON.stringify({ telefono }));
      return res.json({ ok: true, ya_registrado: true, primer_nombre: primerNombre(existente.nombre_apellido),
        mensaje: `Ese teléfono ya estaba registrado a nombre de ${existente.nombre_apellido}. No se duplicó.` });
    }
    try { await store.append(row); }
    catch (err) {
      console.error("[powerfm] store.append", err?.message || err);
      console.log("[powerfm] registro-no-guardado", JSON.stringify(row));
      return res.status(502).json({ ok: false, error: "almacenamiento_no_disponible", mensaje: "No se pudo guardar el registro ahora. Dile al oyente que quedó anotado y continúa." });
    }
    console.log("[powerfm] registro", JSON.stringify(row));
    return res.json({ ok: true, registrado: true, primer_nombre: primerNombre(nombre_apellido),
      mensaje: `Registro guardado. Dile: «¡Listo ${primerNombre(nombre_apellido)}! Ya quedaste registrado con POWER».` });
  });

  app.get("/webhooks/powerfm/oyentes.csv", async (req, res) => {
    const auth = checkSecret(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    let rows;
    try { rows = await store.list(); }
    catch (err) { return res.status(502).json({ ok: false, error: "almacenamiento_no_disponible" }); }
    const cols = ["fecha_registro", "nombre_apellido", "ciudad", "fecha_nacimiento", "sexo", "telefono", "canal", "fuente_telefono"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="powerfm-oyentes.csv"');
    return res.send("\ufeff" + csv);
  });

  app.get("/webhooks/powerfm/estado", (req, res) => {
    const auth = checkSecret(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    return res.json({ ok: true, almacenamiento: store.tipo, persistente: store.tipo === "google_sheet" });
  });
}
