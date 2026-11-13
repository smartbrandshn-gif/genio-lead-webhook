/**
 * Power FM — hoja de oyentes (Google Sheets + Apps Script).
 * 1. Crear una Google Sheet; Extensiones → Apps Script; pegar este código.
 * 2. Cambiar TOKEN por un valor largo aleatorio.
 * 3. Implementar → Nueva implementación → Aplicación web: Ejecutar como «Yo», Acceso «Cualquier usuario».
 * 4. En Render: POWERFM_SHEET_URL = URL /exec, POWERFM_SHEET_TOKEN = el mismo TOKEN.
 */
const TOKEN = "CAMBIAR-POR-TOKEN-LARGO";
const SHEET_NAME = "Oyentes";
const COLS = ["fecha_registro", "nombre_apellido", "ciudad", "fecha_nacimiento", "sexo", "telefono", "canal", "fuente_telefono"];

function hoja_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(COLS); sh.setFrozenRows(1); }
  return sh;
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doGet(e) {
  if ((e.parameter.token || "") !== TOKEN) return json_({ ok: false, error: "token" });
  const values = hoja_().getDataRange().getDisplayValues();
  const head = values.shift() || COLS;
  const rows = values.map(function (r) { const o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
  return json_({ ok: true, rows: rows });
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents || "{}");
  if ((body.token || "") !== TOKEN) return json_({ ok: false, error: "token" });
  if (body.action !== "append" || !body.row) return json_({ ok: false, error: "accion" });
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const sh = hoja_();
    sh.appendRow(COLS.map(function (c) { return "'" + String(body.row[c] == null ? "" : body.row[c]); }));
    return json_({ ok: true });
  } finally { lock.releaseLock(); }
}
