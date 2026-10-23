import "dotenv/config";
import express from "express";
import nodemailer from "nodemailer";

const PORT = Number(process.env.PORT || 10000);
const LEAD_WEBHOOK_SECRET = process.env.LEAD_WEBHOOK_SECRET || "";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_APP_PASSWORD = process.env.SMTP_APP_PASSWORD || "";
const LEAD_TO_EMAIL = process.env.LEAD_TO_EMAIL || "";
// Genio Demo (sales demo agent): destino propio, no afecta LEAD_TO_EMAIL de otros clientes
const DEMO_LEAD_TO_EMAIL = process.env.DEMO_LEAD_TO_EMAIL || "smartbrandshn@gmail.com";
const DEMO_FROM_EMAIL = "genionotificaciones@gmail.com";
const PEDIDO_TO_EMAIL = process.env.PEDIDO_TO_EMAIL || "";
// Mexcali (2do restaurante): destino propio; fallback en código para no depender de Render env
const MEXCALI_PEDIDO_TO_EMAIL = process.env.MEXCALI_PEDIDO_TO_EMAIL || "sarmientod6@gmail.com";
const MEXCALI_FROM_NAME = "Pedido Mexcali";
const LEAD_FROM_NAME = process.env.LEAD_FROM_NAME || "Genio Demo";
const CLIENT_LABEL = process.env.CLIENT_LABEL || "Genio Demo";

const CANALES = new Set(["whatsapp", "telefono", "email"]);
const PLACEHOLDER_BAD =
  /(sin\s+nombre|sin\s+especificar|n[uú]mero\s+entrante|usuario\s+sin|no\s+proporcionad|unknown|\bn\/?a\b|pendiente|placeholder|\b999999\b|\bcaller[_-]?id\b|\btelefono\b|\bwhatsapp\b|por\s+definir|sin\s+horario|a\s+definir|despu[eé]s|luego|cuando\s+sea)/i;

const app = express();
app.use((req, res, next) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    const ct = (req.headers["content-type"] || "").toLowerCase();
    const rawText = req.rawBody.toString("utf8");
    req.rawText = rawText;
    req.body = {};
    try {
      if (rawText.trim()) {
        if (ct.includes("json") || rawText.trim().startsWith("{")) {
          req.body = JSON.parse(rawText);
        } else {
          try {
            req.body = JSON.parse(rawText);
          } catch {
            req.body = Object.fromEntries(new URLSearchParams(rawText));
          }
        }
      }
    } catch {
      req.body = {};
    }
    next();
  });
});

function guatemalaTimestamp(date = new Date()) {
  const raw = new Intl.DateTimeFormat("es-GT", {
    timeZone: "America/Guatemala",
    dateStyle: "full",
    timeStyle: "medium",
  }).format(date);
  // Día y mes con mayúscula inicial (Jueves, Octubre) en correos/notificaciones
  return raw.replace(
    /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/gi,
    (w) => w.charAt(0).toUpperCase() + w.slice(1)
  );
}

function checkSecret(req) {
  if (!LEAD_WEBHOOK_SECRET) {
    return { ok: false, status: 500, error: "LEAD_WEBHOOK_SECRET no configurado" };
  }
  const header = req.get("X-Lead-Secret") || req.get("x-lead-secret") || "";
  const query = typeof req.query.secret === "string" ? req.query.secret : "";
  const provided = header || query;
  if (!provided || provided !== LEAD_WEBHOOK_SECRET) {
    return { ok: false, status: 401, error: "Secreto inválido o ausente" };
  }
  return { ok: true };
}

function looksFake(v) {
  const s = String(v || "").trim();
  if (!s) return true;
  if (PLACEHOLDER_BAD.test(s)) return true;
  return false;
}

function pick(map, names) {
  for (const n of names) {
    if (map[n] != null && String(map[n]).trim() !== "") return String(map[n]).trim();
  }
  return "";
}

function extractLead(req) {
  const merged = { ...req.query, ...(req.body && typeof req.body === "object" ? req.body : {}) };
  const nombre = pick(merged, ["nombre", "name"]);
  const telefono = pick(merged, ["telefono_whatsapp", "telefono", "whatsapp", "phone", "caller_number", "from"]);
  const interes = pick(merged, ["interes", "interest", "rubro", "producto"]).toLowerCase();
  const horario = pick(merged, ["horario_contacto", "horario"]);
  let canal = pick(merged, ["canal_preferido", "canal"]).toLowerCase();
  if (canal === "correo" || canal === "mail") canal = "email";
  if (canal === "llamada" || canal === "phone") canal = "telefono";
  if (canal === "wa") canal = "whatsapp";
  const notas = pick(merged, ["notas", "notes", "summary"]);
  const negocio = pick(merged, ["negocio", "empresa", "business"]);
  const plan_interes = pick(merged, ["plan_interes", "plan"]);
  // Same multi-source phone resolve as pedidos (body.caller_id → X-Caller-Number)
  const phone = resolveCallerPhone(req);
  return {
    nombre,
    telefono_whatsapp: telefono,
    interes,
    horario_contacto: horario,
    canal_preferido: canal,
    notas,
    negocio,
    plan_interes,
    caller_id: phone.caller_id,
    _callerIdSource: phone.source,
    _bodyKeys: bodyKeysForLog(req),
    _xCallerNumberPresent: phone.xCallerNumberPresent,
    _callerIdDestTestPresent: phone.callerIdDestTestPresent,
    _callerIdDestTestForLog: phone.callerIdDestTestForLog,
  };
}

function validateLead(lead) {
  if (!lead.nombre || looksFake(lead.nombre)) return { ok: false, error: "nombre real es requerido" };
  if (!lead.telefono_whatsapp || looksFake(lead.telefono_whatsapp) || !/\d{7,}/.test(lead.telefono_whatsapp)) {
    return { ok: false, error: "telefono real es requerido" };
  }
  if (!lead.interes || looksFake(lead.interes)) return { ok: false, error: "interes/rubro es requerido" };
  // Demo mode (Genio Demo sales agent): negocio present → horario/notas optional
  const demo = Boolean(lead.negocio);
  if (demo && looksFake(lead.negocio)) return { ok: false, error: "negocio real es requerido" };
  if (!demo && (!lead.horario_contacto || looksFake(lead.horario_contacto))) {
    return { ok: false, error: "horario_contacto real es requerido" };
  }
  if (lead.canal_preferido && !CANALES.has(lead.canal_preferido)) {
    return { ok: false, error: "canal_preferido debe ser whatsapp|telefono|email" };
  }
  if (!lead.canal_preferido) lead.canal_preferido = "telefono";
  if (!demo && (!lead.notas || looksFake(lead.notas) || /sin\s+notas/i.test(lead.notas))) {
    return { ok: false, error: "notas reales son requeridas" };
  }
  return { ok: true };
}

function buildEmail(lead) {
  const ts = guatemalaTimestamp();
  const subject = lead.negocio
    ? `[Lead Genio Demo] ${lead.negocio} (${lead.interes}) — ${lead.nombre}${lead.plan_interes ? ` — ${lead.plan_interes}` : ""}`
    : `[Lead ${CLIENT_LABEL}] ${lead.interes} — ${lead.nombre}`;
  const text = [
    `Nuevo lead — ${CLIENT_LABEL}`,
    "",
    `Fecha (America/Guatemala): ${ts}`,
    `Nombre: ${lead.nombre}`,
    ...(lead.negocio ? [`Negocio: ${lead.negocio}`] : []),
    ...(lead.plan_interes ? [`Plan de interés: ${lead.plan_interes}`] : []),
    `Teléfono / WhatsApp: ${lead.telefono_whatsapp}`,
    `Interés / rubro: ${lead.interes}`,
    `Horario: ${lead.horario_contacto || "(n/a)"}`,
    `Canal: ${lead.canal_preferido}`,
    `Notas: ${lead.notas || "(sin notas)"}`,
    `Número de cliente: ${lead.caller_id || "(n/a)"}`,
  ].join("\n");
  if (lead.negocio) {
    const { kvTable, card } = EMAIL_UI;
    const contacto = [["Nombre completo", lead.nombre], ["Teléfono", EMAIL_UI.fmtTel(lead.telefono_whatsapp)]];
    const negocio = [["Nombre del negocio", lead.negocio], ["Rubro / interés", lead.interes.charAt(0).toUpperCase() + lead.interes.slice(1)]];
    if (lead.plan_interes) negocio.push(["Plan de interés", lead.plan_interes]);
    const cards = [card("Contacto", kvTable(contacto)), card("Negocio", kvTable(negocio))];
    if (lead.horario_contacto) cards.push(card("Horario de contacto", kvTable([["Horario", lead.horario_contacto]])));
    if (lead.notas) cards.push(EMAIL_UI.notasCard(lead.notas));
    return { subject, text, html: EMAIL_UI.shell("Nuevo lead — Genio Demo", ts, cards) };
  }
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const row = (l, v) =>
    `<tr><td style="padding:6px 12px;font-weight:600">${esc(l)}</td><td style="padding:6px 12px">${esc(v)}</td></tr>`;
  const html = `<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#0f766e;color:#fff;padding:16px 20px">
      <h1 style="margin:0;font-size:18px">Lead — ${esc(CLIENT_LABEL)}</h1>
      <p style="margin:4px 0 0;opacity:.9;font-size:13px">Genio Demo</p>
    </div>
    <p style="padding:16px 20px 0;color:#64748b;font-size:13px">${esc(ts)}</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 16px">
      ${row("Nombre", lead.nombre)}
      ${lead.negocio ? row("Negocio", lead.negocio) : ""}
      ${lead.plan_interes ? row("Plan de interés", lead.plan_interes) : ""}
      ${row("Teléfono / WhatsApp", lead.telefono_whatsapp)}
      ${row("Interés / rubro", lead.interes)}
      ${row("Horario", lead.horario_contacto || "(n/a)")}
      ${row("Canal", lead.canal_preferido)}
      ${row("Notas", lead.notas || "(sin notas)")}
      ${row("Número de cliente", lead.caller_id || "(n/a)")}
    </table>
  </div></body></html>`;
  return { subject, text, html };
}

function normalizePago(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!s) return "";
  if (/\b(efectivo|cash|dinero|billete|contado)\b/.test(s) || s === "efectivo") return "Efectivo";
  if (/\b(tarjeta|card|credito|credito|debito|visa|mastercard|credit|debit)\b/.test(s) || s === "tarjeta") {
    return "Tarjeta";
  }
  return "";
}

/** Non-empty RTN; case-insensitive "no" → exact "No"; else free text (name + number). */
function normalizeRtn(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^no$/i.test(s)) return "No";
  return s;
}

/** número de cliente: digits the customer dictates. Empty/fake → "no" (pedido validation will reject "no"). */
function normalizeCallerId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "no";
  if (/^no$/i.test(s)) return "no";
  if (looksFake(s)) return "no";
  return s;
}

/**
 * Resolve número de cliente for Wangs pedidos.
 * Order: body.numero_cliente / caller_id → header X-Caller-Number (digits only).
 * Missing → "no" (validatePedido rejects). Never use destination_number as the customer phone.
 */
function resolveCallerPhone(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const bodyRaw =
    body.numero_cliente != null && String(body.numero_cliente).trim() !== ""
      ? body.numero_cliente
      : body.caller_id != null && String(body.caller_id).trim() !== ""
        ? body.caller_id
        : body.callerId != null && String(body.callerId).trim() !== ""
          ? body.callerId
          : body.telefono != null && String(body.telefono).trim() !== ""
            ? body.telefono
            : "";
  // Express req.get is case-insensitive; detect header key presence separately
  const headerHeaderPresent = Object.keys(req.headers || {}).some(
    (k) => k.toLowerCase() === "x-caller-number"
  );
  const headerRaw = req.get("X-Caller-Number") || "";
  const fromBody = bodyRaw ? normalizeCallerId(bodyRaw) : "";
  const fromHeaderRaw = headerRaw ? normalizeCallerId(headerRaw) : "";
  const fromHeader = fromHeaderRaw && fromHeaderRaw !== "no" ? fromHeaderRaw : "";
  // Prefer client-dictated body; header only if it has real digits
  const resolved = (fromBody && fromBody !== "no" ? fromBody : "") || fromHeader || fromBody || "no";
  let source = "";
  if (fromBody && fromBody !== "no") source = "body.numero_cliente";
  else if (fromHeader) source = "header.X-Caller-Number";
  else source = "default.no";
  const destTestRaw =
    body.caller_id_dest_test != null ? String(body.caller_id_dest_test).trim() : "";
  return {
    caller_id: resolved,
    source,
    bodyCallerIdPresent: Boolean(String(bodyRaw || "").trim()),
    xCallerNumberPresent: headerHeaderPresent,
    callerIdDestTestPresent: Boolean(destTestRaw),
    callerIdDestTestForLog: destTestRaw || undefined,
    _callerIdRaw: bodyRaw || headerRaw || "",
  };
}

function bodyKeysForLog(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  return Object.keys(body);
}

function extractPedido(req) {
  const merged = { ...req.query, ...(req.body && typeof req.body === "object" ? req.body : {}) };
  const nombre_cliente = pick(merged, ["nombre_cliente", "nombre", "name"]);
  const pedido_completo = pick(merged, ["pedido_completo", "pedido", "order"]);
  let notas = pick(merged, ["notas", "notes"]);
  // Optional: empty / omit / "sin notas" → treat as empty
  if (!notas || /sin\s+notas/i.test(notas) || looksFake(notas)) notas = "";
  const total_pedido = pick(merged, ["total_pedido", "total", "total_del_pedido"]);
  const pagoRaw = pick(merged, ["metodo_pago", "pago", "payment"]);
  const rtnRaw = pick(merged, ["rtn", "RTN", "factura_rtn"]);
  const motivoRaw = pick(merged, ["motivo_cancelacion", "motivo", "razon_cancelacion", "reason"]);
  const phone = resolveCallerPhone(req);
  return {
    nombre_cliente,
    pedido_completo,
    notas,
    total_pedido,
    metodo_pago: normalizePago(pagoRaw),
    rtn: normalizeRtn(rtnRaw),
    motivo_cancelacion: motivoRaw && !looksFake(motivoRaw) ? String(motivoRaw).trim() : "",
    caller_id: phone.caller_id,
    _pagoRaw: pagoRaw,
    _rtnRaw: rtnRaw,
    _callerIdRaw: phone._callerIdRaw,
    _callerIdSource: phone.source,
    _bodyKeys: bodyKeysForLog(req),
    _xCallerNumberPresent: phone.xCallerNumberPresent,
    _callerIdDestTestPresent: phone.callerIdDestTestPresent,
    _callerIdDestTestForLog: phone.callerIdDestTestForLog,
  };
}

function validatePedido(pedido) {
  if (!pedido.nombre_cliente || looksFake(pedido.nombre_cliente)) {
    return { ok: false, error: "nombre_cliente real es requerido" };
  }
  if (!pedido.pedido_completo || looksFake(pedido.pedido_completo)) {
    return { ok: false, error: "pedido_completo es requerido" };
  }
  if (!pedido.total_pedido || looksFake(pedido.total_pedido)) {
    return { ok: false, error: "total_pedido es requerido" };
  }
  if (!pedido.metodo_pago) {
    return { ok: false, error: 'metodo_pago debe ser "Efectivo" o "Tarjeta"' };
  }
  if (!pedido.rtn) {
    return { ok: false, error: "Falta el campo rtn: usa No si no quiere factura, o nombre y número de RTN si sí" };
  }
  // número de cliente: MUST be real digits the customer gave (never invent / never "no")
  const phone = String(pedido.caller_id || "").trim();
  if (
    !phone ||
    /^no$/i.test(phone) ||
    looksFake(phone) ||
    !/\d{7,}/.test(phone)
  ) {
    return {
      ok: false,
      error:
        "numero_cliente real es requerido: digitos que el cliente diga (no inventar, no omitir)",
    };
  }
  return { ok: true };
}

/** Soften literal \\n / \\r\\n from agents into real newlines; trim each line;
 *  normalize common Spanish quantity words to digits (uno→1 … cinco→5). */
function normalizePedidoQtyWords(line) {
  const map = {
    uno: "1",
    una: "1",
    dos: "2",
    tres: "3",
    cuatro: "4",
    cinco: "5",
  };
  return String(line || "").replace(
    /\b(uno|una|dos|tres|cuatro|cinco)\b/gi,
    (m) => map[m.toLowerCase()] || m
  );
}

function formatPedidoCompleto(raw) {
  return String(raw || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => normalizePedidoQtyWords(line.trim()))
    .join("\n");
}


function buildCancelPedidoEmail(pedido) {
  // esc/row no existían en este scope ("esc is not defined" → 502); usar helpers compartidos
  const esc = escHtml;
  const row = htmlRow;
  const ts = guatemalaTimestamp();
  const subject = `[CANCELADO Wangs] ${pedido.nombre_cliente} — ${pedido.total_pedido}`;
  const pedidoBody = formatPedidoCompleto(pedido.pedido_completo);
  const numeroCliente = pedido.caller_id || "no";
  const motivo = pedido.motivo_cancelacion || "El cliente canceló el pedido en la llamada";
  const text = [
    "PEDIDO CANCELADO — Wangs",
    "NO PREPARAR / NO ENTREGAR",
    `Hora: ${ts}`,
    `Motivo: ${motivo}`,
    "",
    `Cliente: ${pedido.nombre_cliente}`,
    "Pedido (cancelado):",
    pedidoBody,
    `Notas / solicitudes especiales: ${pedido.notas || "(ninguna)"}`,
    `Total: ${pedido.total_pedido}`,
    `Método de pago: ${pedido.metodo_pago}`,
    `RTN: ${pedido.rtn}`,
    `número de cliente: ${numeroCliente}`,
  ].join("\n");
  const pedidoHtml = `<div style="padding:4px 20px 12px">
      <div style="font-weight:600;margin:0 0 8px;font-size:14px">Pedido cancelado</div>
      <pre style="margin:0;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;white-space:pre-line;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace,system-ui;font-size:14px;line-height:1.45;color:#1c1917">${esc(pedidoBody)}</pre>
    </div>`;
  const html = `<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#b91c1c;color:#fff;padding:16px 20px">
      <h1 style="margin:0;font-size:18px">PEDIDO CANCELADO — Wangs</h1>
      <p style="margin:4px 0 0;opacity:.9;font-size:13px">NO PREPARAR · Genio</p>
    </div>
    <p style="padding:16px 20px 0;color:#64748b;font-size:13px">${esc(ts)}</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 0">
      ${row("Motivo", motivo)}
      ${row("Cliente", pedido.nombre_cliente)}
    </table>
    ${pedidoHtml}
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
      ${row("Notas / solicitudes", pedido.notas || "(ninguna)")}
      ${row("Total", pedido.total_pedido)}
      ${row("Método de pago", pedido.metodo_pago)}
      ${row("RTN", pedido.rtn)}
      ${row("número de cliente", numeroCliente)}
    </table>
  </div></body></html>`;
  return { subject, text, html };
}

/* ---------- Diseño de email compartido (cards, verde #166534) ---------- */
const EMAIL_UI = (() => {
  const F = "font-family:Arial,Helvetica,sans-serif;";
  const ACCENT = "#166534", ACCENT_BG = "#f0fdf4", ACCENT_SUB = "#bbf7d0";
  const kv = (l, v, last) => `<tr><td style="${F}padding:8px 0;font-size:13px;color:#6b7280;width:38%;vertical-align:top;${last ? "" : "border-bottom:1px solid #f1f1f1;"}">${escHtml(l)}</td><td style="${F}padding:8px 0;font-size:14px;color:#111827;font-weight:bold;vertical-align:top;${last ? "" : "border-bottom:1px solid #f1f1f1;"}">${escHtml(v)}</td></tr>`;
  const kvTable = (r) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${r.map(([a, b], i) => kv(a, b, i === r.length - 1)).join("")}</table>`;
  const card = (t, inner) => `<tr><td style="padding:0 24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff">
    <tr><td style="${F}padding:12px 16px 4px;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${ACCENT}">${escHtml(t)}</td></tr>
    <tr><td style="padding:0 16px 12px">${inner}</td></tr></table></td></tr>`;
  const itemsTable = (items, total, extra = []) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:8px">
    <tr><td style="${F}padding:6px 10px;font-size:11px;font-weight:bold;text-transform:uppercase;color:#6b7280;background:#f9fafb;border-bottom:1px solid #e5e7eb">Detalle del pedido</td></tr>
    ${items.map((it) => {
      const t = String(it).trim();
      const bullet = /^[·•]/.test(t);
      const sub = /^[-–—]/.test(t);
      const pad = bullet
        ? "padding:3px 10px 3px 36px;font-size:13px;color:#374151;"
        : sub
          ? "padding:6px 10px 4px 18px;font-size:13px;color:#6b7280;font-weight:600;"
          : "padding:9px 10px;font-size:14px;color:#111827;font-weight:bold;";
      return `<tr><td style="${F}${pad}border-bottom:1px solid #f1f1f1">${escHtml(it)}</td></tr>`;
    }).join("")}${extra.length ? `<tr><td style="padding:4px 0 8px">${kvTable(extra)}</td></tr>` : ""}
    <tr><td style="padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>
      <td style="${F}padding:12px 10px;font-size:15px;font-weight:bold;color:${ACCENT};background:${ACCENT_BG}">Total</td>
      <td align="right" style="${F}padding:12px 10px;font-size:16px;font-weight:bold;color:${ACCENT};background:${ACCENT_BG};text-align:right">${escHtml(total)}</td></tr></table></td></tr></table>`;
  const notasCard = (notas) => card("Notas", `<div style="${F}font-size:14px;color:#111827;line-height:1.5;padding-top:6px">${escHtml(notas)}</div>`);
  const shell = (title, subtitle, cards) => `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-collapse:separate;border:1px solid #e5e7eb;border-radius:10px">
  <tr><td style="background:${ACCENT};padding:22px 24px;border-radius:10px 10px 0 0">
    <div style="${F}font-size:20px;font-weight:bold;color:#ffffff">${escHtml(title)}</div>
    ${subtitle ? `<div style="${F}font-size:13px;color:${ACCENT_SUB};padding-top:6px">${escHtml(subtitle)}</div>` : ""}
  </td></tr>
  <tr><td style="height:20px;line-height:20px;font-size:0">&nbsp;</td></tr>
  ${cards.join("\n  ")}
  <tr><td style="${F}padding:4px 24px 20px;font-size:11px;color:#9ca3af;text-align:center">Notificación automática · Genio</td></tr>
</table></td></tr></table></body></html>`;
  const fmtTel = (t) => { const d = String(t || "").replace(/\D/g, "").replace(/^504(?=\d{8}$)/, ""); return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4)}` : String(t || ""); };
  return { kv, kvTable, card, itemsTable, notasCard, shell, fmtTel };
})();

function buildPedidoEmail(pedido) {
  const ts = guatemalaTimestamp();
  const subject = `[Pedido Wangs] ${pedido.nombre_cliente} — ${pedido.total_pedido}`;
  const pedidoBody = formatPedidoCompleto(pedido.pedido_completo);
  const numeroCliente = pedido.caller_id || "no";
  const text = [
    "Nuevo pedido — Wangs",
    "",
    `Fecha (America/Guatemala): ${ts}`,
    `Cliente: ${pedido.nombre_cliente}`,
    "Pedido:",
    pedidoBody,
    `Notas / solicitudes especiales: ${pedido.notas || "(ninguna)"}`,
    `Total: ${pedido.total_pedido}`,
    `Método de pago: ${pedido.metodo_pago}`,
    `RTN: ${pedido.rtn}`,
    `número de cliente: ${numeroCliente}`,
  ].join("\n");
  const { kvTable, card } = EMAIL_UI;
  const cards = [
    card("Cliente", kvTable([["Nombre", pedido.nombre_cliente], ["Teléfono", EMAIL_UI.fmtTel(numeroCliente)]])),
    card("Pedido", kvTable([["Método de pago", pedido.metodo_pago]]) + EMAIL_UI.itemsTable(rossoSplitItems(pedidoBody), String(pedido.total_pedido))),
    card("Factura", kvTable([["RTN", pedido.rtn]])),
  ];
  if (pedido.notas) cards.push(EMAIL_UI.notasCard(pedido.notas));
  const html = EMAIL_UI.shell("Nuevo pedido — Wangs", ts, cards);
  return { subject, text, html };
}

/* ---------- Restaurantes adicionales (Mexcali, …) ----------
 * Builders parametrizados por nombre de negocio. Mismo formato que Wangs
 * (los builders/rutas de Wangs arriba y abajo NO se tocan).
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlRow(l, v) {
  return `<tr><td style="padding:6px 12px;font-weight:600;vertical-align:top">${escHtml(l)}</td><td style="padding:6px 12px">${escHtml(v)}</td></tr>`;
}

function buildPedidoEmailFor(business, pedido) {
  const ts = guatemalaTimestamp();
  const subject = `[Pedido ${business}] ${pedido.nombre_cliente} — ${pedido.total_pedido}`;
  const pedidoBody = formatPedidoCompleto(pedido.pedido_completo);
  const numeroCliente = pedido.caller_id || "no";
  const text = [
    `Nuevo pedido — ${business}`,
    "",
    `Fecha (America/Guatemala): ${ts}`,
    `Cliente: ${pedido.nombre_cliente}`,
    "Pedido:",
    pedidoBody,
    `Notas / solicitudes especiales: ${pedido.notas || "(ninguna)"}`,
    `Total: ${pedido.total_pedido}`,
    `Método de pago: ${pedido.metodo_pago}`,
    `RTN: ${pedido.rtn}`,
    `número de cliente: ${numeroCliente}`,
  ].join("\n");
  const pedidoHtml = `<div style="padding:4px 20px 12px">
      <div style="font-weight:600;margin:0 0 8px;font-size:14px">Pedido</div>
      <pre style="margin:0;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;white-space:pre-line;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace,system-ui;font-size:14px;line-height:1.45;color:#1c1917">${escHtml(pedidoBody)}</pre>
    </div>`;
  const html = `<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#b45309;color:#fff;padding:16px 20px">
      <h1 style="margin:0;font-size:18px">Pedido — ${escHtml(business)}</h1>
      <p style="margin:4px 0 0;opacity:.9;font-size:13px">Genio · notificaciones</p>
    </div>
    <p style="padding:16px 20px 0;color:#64748b;font-size:13px">${escHtml(ts)}</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 0">
      ${htmlRow("Cliente", pedido.nombre_cliente)}
    </table>
    ${pedidoHtml}
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
      ${htmlRow("Notas / solicitudes", pedido.notas || "(ninguna)")}
      ${htmlRow("Total", pedido.total_pedido)}
      ${htmlRow("Método de pago", pedido.metodo_pago)}
      ${htmlRow("RTN", pedido.rtn)}
      ${htmlRow("número de cliente", numeroCliente)}
    </table>
  </div></body></html>`;
  return { subject, text, html };
}

function buildCancelPedidoEmailFor(business, pedido) {
  const ts = guatemalaTimestamp();
  const subject = `[CANCELADO ${business}] ${pedido.nombre_cliente} — ${pedido.total_pedido}`;
  const pedidoBody = formatPedidoCompleto(pedido.pedido_completo);
  const numeroCliente = pedido.caller_id || "no";
  const motivo = pedido.motivo_cancelacion || "El cliente canceló el pedido en la llamada";
  const text = [
    `PEDIDO CANCELADO — ${business}`,
    "NO PREPARAR / NO ENTREGAR",
    `Hora: ${ts}`,
    `Motivo: ${motivo}`,
    "",
    `Cliente: ${pedido.nombre_cliente}`,
    "Pedido (cancelado):",
    pedidoBody,
    `Notas / solicitudes especiales: ${pedido.notas || "(ninguna)"}`,
    `Total: ${pedido.total_pedido}`,
    `Método de pago: ${pedido.metodo_pago}`,
    `RTN: ${pedido.rtn}`,
    `número de cliente: ${numeroCliente}`,
  ].join("\n");
  const pedidoHtml = `<div style="padding:4px 20px 12px">
      <div style="font-weight:600;margin:0 0 8px;font-size:14px">Pedido cancelado</div>
      <pre style="margin:0;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;white-space:pre-line;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace,system-ui;font-size:14px;line-height:1.45;color:#1c1917">${escHtml(pedidoBody)}</pre>
    </div>`;
  const html = `<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#b91c1c;color:#fff;padding:16px 20px">
      <h1 style="margin:0;font-size:18px">PEDIDO CANCELADO — ${escHtml(business)}</h1>
      <p style="margin:4px 0 0;opacity:.9;font-size:13px">NO PREPARAR · Genio</p>
    </div>
    <p style="padding:16px 20px 0;color:#64748b;font-size:13px">${escHtml(ts)}</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 0">
      ${htmlRow("Motivo", motivo)}
      ${htmlRow("Cliente", pedido.nombre_cliente)}
    </table>
    ${pedidoHtml}
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
      ${htmlRow("Notas / solicitudes", pedido.notas || "(ninguna)")}
      ${htmlRow("Total", pedido.total_pedido)}
      ${htmlRow("Método de pago", pedido.metodo_pago)}
      ${htmlRow("RTN", pedido.rtn)}
      ${htmlRow("número de cliente", numeroCliente)}
    </table>
  </div></body></html>`;
  return { subject, text, html };
}

function createTransport() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_APP_PASSWORD },
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "genio-lead-webhook",
    client: CLIENT_LABEL,
    time: guatemalaTimestamp(),
    smtpConfigured: Boolean(SMTP_USER && SMTP_APP_PASSWORD && LEAD_TO_EMAIL),
    pedidoToConfigured: Boolean(PEDIDO_TO_EMAIL || LEAD_TO_EMAIL),
    mexcaliPedidoToConfigured: Boolean(MEXCALI_PEDIDO_TO_EMAIL),
    secretConfigured: Boolean(LEAD_WEBHOOK_SECRET),
  });
});

async function handleLead(req, res) {
  const auth = checkSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const lead = extractLead(req);
  console.log("[lead] inbound meta", {
    bodyKeys: lead._bodyKeys,
    xCallerNumberPresent: lead._xCallerNumberPresent,
    callerIdSource: lead._callerIdSource || "(none)",
    callerIdDestTestPresent: lead._callerIdDestTestPresent,
    // caller_id_dest_test logged for diagnostics only — never used as customer phone
    callerIdDestTest: lead._callerIdDestTestForLog,
  });
  console.log("[lead] inbound", {
    nombre: lead.nombre,
    telefono_whatsapp: lead.telefono_whatsapp,
    interes: lead.interes,
    horario_contacto: lead.horario_contacto,
    canal_preferido: lead.canal_preferido,
    notas: lead.notas,
    caller_id: lead.caller_id,
  });

  const validated = validateLead(lead);
  if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

  if (!lead.caller_id && lead.telefono_whatsapp) lead.caller_id = lead.telefono_whatsapp;

  try {
    const transport = createTransport();
    const { subject, text, html } = buildEmail(lead);
    const leadTo = lead.negocio ? DEMO_LEAD_TO_EMAIL : LEAD_TO_EMAIL;
    const info = await transport.sendMail({
      from: lead.negocio ? `"Genio Demo" <${DEMO_FROM_EMAIL}>` : `"${LEAD_FROM_NAME}" <${SMTP_USER}>`,
      to: leadTo,
      subject,
      text,
      html,
    });
    console.log(`[lead] enviado a ${leadTo} id=${info.messageId}`);
    return res.json({ ok: true, message: "Lead enviado", messageId: info.messageId });
  } catch (err) {
    console.error("[lead] SMTP", err?.message || err);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: err?.message || String(err) });
  }
}
app.post("/webhooks/enviar-lead", handleLead);
app.post("/webhooks/lead", handleLead);

app.post("/webhooks/enviar-pedido", async (req, res) => {
  const auth = checkSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const pedido = extractPedido(req);
  console.log("[pedido] inbound meta", {
    bodyKeys: pedido._bodyKeys,
    xCallerNumberPresent: pedido._xCallerNumberPresent,
    callerIdSource: pedido._callerIdSource || "(none)",
    callerIdDestTestPresent: pedido._callerIdDestTestPresent,
    // caller_id_dest_test logged for diagnostics only — never used as customer phone
    callerIdDestTest: pedido._callerIdDestTestForLog,
  });
  console.log("[pedido] inbound", {
    nombre_cliente: pedido.nombre_cliente,
    pedido_completo: pedido.pedido_completo,
    notas: pedido.notas,
    total_pedido: pedido.total_pedido,
    metodo_pago: pedido.metodo_pago,
    rtn: pedido.rtn,
    caller_id: pedido.caller_id,
    _pagoRaw: pedido._pagoRaw,
    _rtnRaw: pedido._rtnRaw,
    _callerIdRaw: pedido._callerIdRaw,
    _callerIdSource: pedido._callerIdSource,
  });

  const validated = validatePedido(pedido);
  if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

  const toEmail = PEDIDO_TO_EMAIL || LEAD_TO_EMAIL;
  if (!toEmail) {
    return res.status(500).json({ ok: false, error: "PEDIDO_TO_EMAIL / LEAD_TO_EMAIL no configurado" });
  }
  if (!SMTP_USER || !SMTP_APP_PASSWORD) {
    return res.status(500).json({ ok: false, error: "SMTP no configurado" });
  }

  try {
    const transport = createTransport();
    const { subject, text, html } = buildPedidoEmail(pedido);
    const fromName = LEAD_FROM_NAME || "Pedido Wangs";
    const info = await transport.sendMail({
      from: `"${fromName}" <${SMTP_USER}>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    console.log(`[pedido] enviado a ${toEmail} id=${info.messageId}`);
    return res.json({
      ok: true,
      message: "Pedido enviado",
      messageId: info.messageId,
      to: toEmail,
      metodo_pago: pedido.metodo_pago,
      rtn: pedido.rtn,
      caller_id: pedido.caller_id || "No disponible",
    });
  } catch (err) {
    console.error("[pedido] SMTP", err?.message || err);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: err?.message || String(err) });
  }
});

app.post("/webhooks/cancelar-pedido", async (req, res) => {
  const auth = checkSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const pedido = extractPedido(req);
  console.log("[cancel-pedido] inbound meta", {
    bodyKeys: pedido._bodyKeys,
    xCallerNumberPresent: pedido._xCallerNumberPresent,
    callerIdSource: pedido._callerIdSource || "(none)",
  });
  console.log("[cancel-pedido] inbound", {
    nombre_cliente: pedido.nombre_cliente,
    pedido_completo: pedido.pedido_completo,
    total_pedido: pedido.total_pedido,
    metodo_pago: pedido.metodo_pago,
    rtn: pedido.rtn,
    caller_id: pedido.caller_id,
    motivo_cancelacion: pedido.motivo_cancelacion,
  });

  const validated = validatePedido(pedido);
  if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

  const toEmail = PEDIDO_TO_EMAIL || LEAD_TO_EMAIL;
  if (!toEmail) {
    return res.status(500).json({ ok: false, error: "PEDIDO_TO_EMAIL / LEAD_TO_EMAIL no configurado" });
  }
  if (!SMTP_USER || !SMTP_APP_PASSWORD) {
    return res.status(500).json({ ok: false, error: "SMTP no configurado" });
  }

  try {
    const transport = createTransport();
    const { subject, text, html } = buildCancelPedidoEmail(pedido);
    const fromName = LEAD_FROM_NAME || "Pedido Wangs";
    const info = await transport.sendMail({
      from: `"${fromName}" <${SMTP_USER}>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    console.log(`[cancel-pedido] enviado a ${toEmail} id=${info.messageId}`);
    return res.json({
      ok: true,
      message: "Cancelación enviada",
      messageId: info.messageId,
      to: toEmail,
      caller_id: pedido.caller_id || "No disponible",
    });
  } catch (err) {
    console.error("[cancel-pedido] SMTP", err?.message || err);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: err?.message || String(err) });
  }
});

/* ---------- Wangs: reservas (ruta nueva; no toca rutas existentes) ---------- */
function extractReservaWangs(req) {
  const merged = { ...req.query, ...(req.body && typeof req.body === "object" ? req.body : {}) };
  const nombre_cliente = pick(merged, ["nombre_cliente", "nombre", "name"]);
  const personasRaw = merged.reserva_personas != null ? String(merged.reserva_personas).trim() : "";
  const reserva_fecha = pick(merged, ["reserva_fecha", "fecha", "dia"]);
  const reserva_hora = pick(merged, ["reserva_hora", "hora"]);
  let notas = pick(merged, ["notas", "notes"]);
  if (!notas || /sin\s+notas/i.test(notas) || looksFake(notas)) notas = "";
  const phone = resolveCallerPhone(req);
  return { nombre_cliente, reserva_personas: personasRaw, reserva_fecha, reserva_hora, notas, caller_id: phone.caller_id, _callerIdSource: phone.source };
}

function validateReservaWangs(r) {
  if (!r.nombre_cliente || looksFake(r.nombre_cliente)) return "nombre_cliente real es requerido";
  const phone = String(r.caller_id || "").trim();
  if (!phone || /^no$/i.test(phone) || looksFake(phone) || phone.replace(/\D/g, "").length < 7) {
    return "numero_cliente real es requerido: digitos que el cliente diga (no inventar, no omitir)";
  }
  if (!r.reserva_personas || looksFake(r.reserva_personas)) return "reserva_personas es requerido (número de personas)";
  if (!r.reserva_fecha || looksFake(r.reserva_fecha)) return "reserva_fecha es requerida (día)";
  if (!r.reserva_hora || looksFake(r.reserva_hora)) return "reserva_hora es requerida";
  return "";
}

function buildReservaWangsEmail(r) {
  const ts = guatemalaTimestamp();
  const subject = `Nueva reserva Wangs - ${r.nombre_cliente}`;
  const tel = EMAIL_UI.fmtTel(r.caller_id);
  const lines = [
    "Nueva reserva — Wangs",
    "",
    `Fecha (America/Guatemala): ${ts}`,
    `Nombre: ${r.nombre_cliente}`,
    `Teléfono: ${tel}`,
    `Personas: ${r.reserva_personas}`,
    `Día: ${r.reserva_fecha}`,
    `Hora: ${r.reserva_hora}`,
  ];
  if (r.notas) lines.push(`Notas: ${r.notas}`);
  const cards = [
    EMAIL_UI.card("Reserva", EMAIL_UI.kvTable([
      ["Nombre", r.nombre_cliente],
      ["Teléfono", tel],
      ["Personas", String(r.reserva_personas)],
      ["Día", r.reserva_fecha],
      ["Hora", r.reserva_hora],
    ])),
  ];
  if (r.notas) cards.push(EMAIL_UI.notasCard(r.notas));
  const html = EMAIL_UI.shell("Nueva reserva — Wangs", ts, cards);
  return { subject, text: lines.join("\n"), html };
}

app.post("/webhooks/enviar-reserva", async (req, res) => {
  const auth = checkSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const r = extractReservaWangs(req);
  console.log("[reserva-wangs] inbound", r);
  const err = validateReservaWangs(r);
  if (err) return res.status(400).json({ ok: false, error: err });

  const toEmail = PEDIDO_TO_EMAIL || LEAD_TO_EMAIL;
  if (!toEmail) {
    return res.status(500).json({ ok: false, error: "PEDIDO_TO_EMAIL / LEAD_TO_EMAIL no configurado" });
  }
  if (!SMTP_USER || !SMTP_APP_PASSWORD) {
    return res.status(500).json({ ok: false, error: "SMTP no configurado" });
  }

  try {
    const transport = createTransport();
    const { subject, text, html } = buildReservaWangsEmail(r);
    const fromName = LEAD_FROM_NAME || "Pedido Wangs";
    const info = await transport.sendMail({
      from: `"${fromName}" <${SMTP_USER}>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    console.log(`[reserva-wangs] enviado a ${toEmail} id=${info.messageId}`);
    return res.json({ ok: true, message: "Reserva enviada", messageId: info.messageId, to: toEmail });
  } catch (e) {
    console.error("[reserva-wangs] SMTP", e?.message || e);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: e?.message || String(e) });
  }
});

/**
 * Rutas de pedido/cancelación para un restaurante adicional.
 * Mismo payload, validación, secreto y manejo de número que Wangs.
 * IMPORTANTE: registrar ANTES del handler 404.
 */
function registerRestaurantPedidoRoutes({ slug, business, toEmail, fromName }) {
  const tag = `[${slug}-pedido]`;
  const cancelTag = `[${slug}-cancel-pedido]`;

  app.post(`/webhooks/${slug}/enviar-pedido`, async (req, res) => {
    const auth = checkSecret(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

    const pedido = extractPedido(req);
    console.log(`${tag} inbound meta`, {
      bodyKeys: pedido._bodyKeys,
      xCallerNumberPresent: pedido._xCallerNumberPresent,
      callerIdSource: pedido._callerIdSource || "(none)",
      callerIdDestTestPresent: pedido._callerIdDestTestPresent,
      callerIdDestTest: pedido._callerIdDestTestForLog,
    });
    console.log(`${tag} inbound`, {
      nombre_cliente: pedido.nombre_cliente,
      pedido_completo: pedido.pedido_completo,
      notas: pedido.notas,
      total_pedido: pedido.total_pedido,
      metodo_pago: pedido.metodo_pago,
      rtn: pedido.rtn,
      caller_id: pedido.caller_id,
      _pagoRaw: pedido._pagoRaw,
      _rtnRaw: pedido._rtnRaw,
      _callerIdRaw: pedido._callerIdRaw,
      _callerIdSource: pedido._callerIdSource,
    });

    const validated = validatePedido(pedido);
    if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

    if (!toEmail) {
      return res.status(500).json({ ok: false, error: `Destino de pedidos ${business} no configurado` });
    }
    if (!SMTP_USER || !SMTP_APP_PASSWORD) {
      return res.status(500).json({ ok: false, error: "SMTP no configurado" });
    }

    try {
      const transport = createTransport();
      const { subject, text, html } = buildPedidoEmailFor(business, pedido);
      const info = await transport.sendMail({
        from: `"${fromName}" <${SMTP_USER}>`,
        to: toEmail,
        subject,
        text,
        html,
      });
      console.log(`${tag} enviado a ${toEmail} id=${info.messageId}`);
      return res.json({
        ok: true,
        message: "Pedido enviado",
        messageId: info.messageId,
        to: toEmail,
        metodo_pago: pedido.metodo_pago,
        rtn: pedido.rtn,
        caller_id: pedido.caller_id || "No disponible",
      });
    } catch (err) {
      console.error(`${tag} SMTP`, err?.message || err);
      return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: err?.message || String(err) });
    }
  });

  app.post(`/webhooks/${slug}/cancelar-pedido`, async (req, res) => {
    const auth = checkSecret(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

    const pedido = extractPedido(req);
    console.log(`${cancelTag} inbound meta`, {
      bodyKeys: pedido._bodyKeys,
      xCallerNumberPresent: pedido._xCallerNumberPresent,
      callerIdSource: pedido._callerIdSource || "(none)",
    });
    console.log(`${cancelTag} inbound`, {
      nombre_cliente: pedido.nombre_cliente,
      pedido_completo: pedido.pedido_completo,
      total_pedido: pedido.total_pedido,
      metodo_pago: pedido.metodo_pago,
      rtn: pedido.rtn,
      caller_id: pedido.caller_id,
      motivo_cancelacion: pedido.motivo_cancelacion,
    });

    const validated = validatePedido(pedido);
    if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

    if (!toEmail) {
      return res.status(500).json({ ok: false, error: `Destino de pedidos ${business} no configurado` });
    }
    if (!SMTP_USER || !SMTP_APP_PASSWORD) {
      return res.status(500).json({ ok: false, error: "SMTP no configurado" });
    }

    try {
      const transport = createTransport();
      const { subject, text, html } = buildCancelPedidoEmailFor(business, pedido);
      const info = await transport.sendMail({
        from: `"${fromName}" <${SMTP_USER}>`,
        to: toEmail,
        subject,
        text,
        html,
      });
      console.log(`${cancelTag} enviado a ${toEmail} id=${info.messageId}`);
      return res.json({
        ok: true,
        message: "Cancelación enviada",
        messageId: info.messageId,
        to: toEmail,
        caller_id: pedido.caller_id || "No disponible",
      });
    } catch (err) {
      console.error(`${cancelTag} SMTP`, err?.message || err);
      return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: err?.message || String(err) });
    }
  });
}

registerRestaurantPedidoRoutes({
  slug: "mexcali",
  business: "Mexcali",
  toEmail: MEXCALI_PEDIDO_TO_EMAIL,
  fromName: MEXCALI_FROM_NAME,
});

/* ---------- Rosso Napoletano (2 sucursales: Foresta / Proceres) ----------
 * Ruta independiente: pedidos y/o reservas. No modifica rutas existentes.
 */
const ROSSO_FORESTA_TO_EMAIL = process.env.ROSSO_FORESTA_TO_EMAIL || "sarmientod6@gmail.com";
const ROSSO_PROCERES_TO_EMAIL = process.env.ROSSO_PROCERES_TO_EMAIL || "sarmientod6@gmail.com";
const ROSSO_FROM = `"Rosso Napoletano Pedidos" <genionotificaciones@gmail.com>`;
const TUCHI_TO_EMAIL = process.env.TUCHI_TO_EMAIL || "sarmientod6@gmail.com";
const TUCHI_FROM = `"Tuchi Pedidos" <genionotificaciones@gmail.com>`;
const MANZANO_TO_EMAIL = process.env.MANZANO_TO_EMAIL || "sarmientod6@gmail.com";
const MANZANO_FROM = `"Genio Notificaciones" <genionotificaciones@gmail.com>`;
const MEXCALI_ROSSO_FROM = `"Mexcali Pedidos" <genionotificaciones@gmail.com>`;
const PULHAPANZAC_TO_EMAIL = process.env.PULHAPANZAC_TO_EMAIL || "sarmientod6@gmail.com";
const PULHAPANZAC_RESERVA_TO_EMAIL = "sarmientod6@gmail.com, pulhahn@gmail.com, catarataspulhapanzak@gmail.com";
const PULHAPANZAC_FROM = `"PULHAPANZAK Pedidos" <genionotificaciones@gmail.com>`;
const PULHAPANZAC_NOTA_FROM = `"PULHAPANZAK Notas" <genionotificaciones@gmail.com>`;
const rossoBrand = (p) => (p.sucursal === "Manzano" ? "El Manzano" : p.sucursal === "Pulhapanzac" ? "PULHAPANZAK" : ["Tuchi", "Mexcali"].includes(p.sucursal) ? p.sucursal : "Rosso Napoletano");

function rossoNorm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function rossoSucursal(raw) {
  const s = rossoNorm(raw);
  if (s.includes("foresta")) return "Foresta";
  if (s.includes("procer")) return "Proceres";
  if (s.includes("tuchi")) return "Tuchi";
  if (s.includes("manzano")) return "Manzano";
  if (s.includes("mexcali") || s.includes("mexcalí")) return "Mexcali";
  if (s.includes("pulhapanz") || s.includes("pulapanz")) return "Pulhapanzac";
  return "";
}
function rossoBool(raw) {
  if (typeof raw === "boolean") return raw;
  const s = rossoNorm(raw);
  if (["true", "si", "s", "yes", "1", "sí"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return null;
}
function rossoTipo(raw) {
  const s = rossoNorm(raw);
  if (!s) return "pedido";
  if (s.includes("ambos") || (s.includes("pedido") && s.includes("reserva"))) return "ambos";
  if (s.includes("reserva")) return "reserva";
  if (s.includes("pedido")) return "pedido";
  return "";
}
function rossoTipoPedido(raw) {
  const s = rossoNorm(raw);
  if (s.includes("recog") || s.includes("llevar")) return "Para recoger";
  if (s.includes("comer") || s.includes("restaurante") || s.includes("mesa") || s.includes("aqui")) return "Comer en el restaurante";
  return "";
}
function rossoTelefono(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("504")) d = d.slice(3);
  return /^\d{8}$/.test(d) ? d : "";
}
function rossoTotal(raw) {
  const s = String(raw ?? "").replace(/lempiras?|lps?\.?|\bL\b|,/gi, "").trim();
  const n = Number(s);
  return s && Number.isFinite(n) && n >= 0 ? n : null;
}
function rossoMoney(n) {
  return `${Number.isInteger(n) ? n : n.toFixed(2)} lempiras`;
}

function extractRosso(req) {
  const m = { ...req.query, ...(req.body && typeof req.body === "object" ? req.body : {}) };
  const raw = (k) => (m[k] == null ? "" : typeof m[k] === "boolean" ? m[k] : String(m[k]).trim());
  return {
    tipo: rossoTipo(raw("tipo")),
    _tipoRaw: raw("tipo"),
    sucursal: rossoSucursal(raw("sucursal")),
    nombre: String(raw("nombre")),
    telefono: rossoTelefono(raw("telefono")),
    tipo_pedido: rossoTipoPedido(raw("tipo_pedido")),
    pedido: String(raw("pedido")),
    total: rossoTotal(raw("total")),
    necesita_rtn: rossoBool(raw("necesita_rtn")),
    telefono_confirmado: rossoBool(raw("telefono_confirmado")),
    rtn_numero: String(raw("rtn_numero")),
    rtn_nombre: String(raw("rtn_nombre")),
    ...(() => {
      let notas = String(raw("notas_cliente") || raw("notas"));
      let pago = String(raw("metodo_pago"));
      const re = /(m[eé]todo de )?pago\s*:\s*(efectivo|tarjeta)\s*[.;,]?/i;
      const mm = notas.match(re);
      if (mm) { if (!pago) pago = mm[2]; notas = notas.replace(re, "").replace(/^[\s.;,|-]+|[\s.;,|-]+$/g, "").trim(); }
      if (/^\s*no\s*aplica\s*$/i.test(pago)) pago = "";
      pago = pago ? pago.charAt(0).toUpperCase() + pago.slice(1).toLowerCase() : "";
      return { notas, metodo_pago: pago };
    })(),
    reserva_nombre: String(raw("reserva_nombre")) || String(raw("nombre")),
    reserva_personas: (() => {
      const n = parseInt(String(raw("reserva_personas") || raw("cantidad_personas")).replace(/\D/g, ""), 10);
      return n > 0 ? n : null;
    })(),
    reserva_fecha: String(raw("reserva_fecha")),
    reserva_hora: String(raw("reserva_hora")),
    // Pulapanzác cabaña / visita: campos de Daniel (+ aliases)
    tipo_reserva: String(raw("tipo_reserva")),
    dias_reserva: String(raw("dias_reserva") || raw("dias_estadia")),
    dias_estadia: String(raw("dias_estadia") || raw("dias_reserva")),
    cantidad_personas: (() => {
      const n = parseInt(String(raw("cantidad_personas") || raw("reserva_personas")).replace(/\D/g, ""), 10);
      return n > 0 ? n : null;
    })(),
    cabana_elegida: String(raw("cabana_elegida")),
    // Pulhapanzac reserva: notas verbatim (alias pedido_especial)
    notas_reserva: (() => {
      const v = m.notas != null && String(m.notas).trim() !== "" ? m.notas : m.pedido_especial;
      return v == null ? "" : String(v);
    })(),
    // Pulhapanzac reserva: total verbatim (opcional)
    total_reserva: m.total == null ? "" : String(m.total),
    notas_cliente: String(raw("notas_cliente") || raw("notas")),
    fecha_llegada: String(raw("fecha_llegada") || raw("fecha_entrada")),
    fecha_entrada: String(raw("fecha_entrada") || raw("fecha_llegada")),
    fecha_salida: String(raw("fecha_salida")),
    correo_electronico: String(raw("correo_electronico") || raw("correo") || raw("email")),
    cantidad_dias: (() => {
      const n = parseInt(String(raw("cantidad_dias") || raw("dias_estadia") || raw("dias_reserva")).replace(/\D/g, ""), 10);
      return n > 0 ? n : null;
    })(),
    menor_de_5_anos: (() => {
      const rawV = raw("menor_de_5_anos") || raw("menores_de_5") || raw("menor_de_5") || raw("ninos_menores_de_5");
      if (rawV === undefined || rawV === null || String(rawV).trim() === "") return null;
      const s = String(rawV).trim().toLowerCase();
      if (["si", "sí", "yes", "true", "1", "s"].includes(s)) return "sí";
      if (["no", "false", "0", "n"].includes(s)) return "no";
      if (rawV === true) return "sí";
      if (rawV === false) return "no";
      // legacy numeric count: any positive → Sí
      const n = parseInt(String(rawV).replace(/\D/g, ""), 10);
      if (n > 0) return "sí";
      if (n === 0) return "no";
      return null;
    })(),
  };
}

function validateRosso(p) {
  if (!p.tipo) return "tipo inválido: usa 'pedido', 'reserva' o 'ambos'";
  if (!p.sucursal) return "sucursal es requerida: 'Foresta' o 'Proceres'";
  if (!p.nombre || looksFake(p.nombre)) return "nombre es requerido";
  if (!p.telefono) return "telefono es requerido: 8 dígitos sin 504";
  if (p.telefono_confirmado !== true) return "BLOQUEADO: telefono_confirmado debe ser true. Repita el teléfono al cliente en pares, espere que diga sí y vuelva a enviar con telefono_confirmado=true";
  if (p.tipo !== "reserva") {
    if (!p.tipo_pedido) return "tipo_pedido es requerido: 'recoger' o 'comer en el restaurante'";
    if (!p.pedido || looksFake(p.pedido)) return "pedido es requerido";
    if (p.total == null) return "total es requerido (número en lempiras)";
  }
  if (p.tipo !== "pedido") {
    if (!p.reserva_nombre || looksFake(p.reserva_nombre)) return "reserva_nombre es requerido";
    // cantidad_personas / reserva_personas
    if (!p.reserva_personas && p.cantidad_personas) p.reserva_personas = p.cantidad_personas;
    if (!p.reserva_personas) return "reserva_personas / cantidad_personas es requerido (número)";
    if (p.sucursal === "Pulhapanzac") {
      // Reserva de cabaña: nombre, teléfono, correo, fecha entrada, fecha salida, personas
      if (!(p.fecha_entrada || p.fecha_llegada)) return "fecha_entrada es requerida";
      if (!p.fecha_salida) return "fecha_salida es requerida";
      if (!p.correo_electronico || !String(p.correo_electronico).includes("@")) {
        return "correo_electronico es requerido";
      }
      if (!p.cantidad_dias) return "cantidad_dias es requerida";
      if (p.menor_de_5_anos !== "sí" && p.menor_de_5_anos !== "no") {
        return "niños menores es requerido: sí o no";
      }
      p.reserva_fecha = `${p.fecha_entrada || p.fecha_llegada} → ${p.fecha_salida}`;
      if (!p.tipo_reserva) p.tipo_reserva = "cabaña";
      if (!p.reserva_nombre) p.reserva_nombre = p.nombre;
      if (!p.notas && p.notas_cliente) p.notas = p.notas_cliente;
    } else {
      if (!p.reserva_fecha) return "reserva_fecha es requerida";
      if (!p.reserva_hora) return "reserva_hora es requerida";
    }
  }
  return "";
}

function buildRossoEmail(p) {
  p = { ...p };
  const ts = guatemalaTimestamp();
  const hasPedido = p.tipo !== "reserva";
  const hasReserva = p.tipo !== "pedido";
  const mz = p.sucursal === "Manzano" && hasPedido ? parseManzanoPedido(p.pedido) : null;
  if (mz) {
    p = { ...p, tipo_pedido: mz.tipo || p.tipo_pedido };
    if (!p.metodo_pago && mz.pago) p.metodo_pago = mz.pago;
    if (!p.rtn_numero && mz.rtn) p.rtn_numero = mz.rtn;
    if (!p.rtn_nombre && mz.rtnNombre) p.rtn_nombre = mz.rtnNombre;
  }
  let subject;
  if (p.sucursal === "Manzano") {
    // Subject: pedido/delivery/recoger → Nuevo pedido; reserva → Nueva reserva
    const who = String((!hasPedido ? (p.reserva_nombre || p.nombre) : p.nombre) || "").trim() || "cliente";
    subject = hasPedido ? `Nuevo pedido: ${who}` : `Nueva reserva: ${who}`;
  } else {
    subject = hasPedido
      ? `[Pedido ${["Tuchi", "Mexcali", "Pulhapanzac"].includes(p.sucursal) ? (p.sucursal === "Pulhapanzac" ? "PULHAPANZAK" : p.sucursal) : "Rosso " + p.sucursal}] ${p.nombre} - ${rossoMoney(p.total)}`
      : (p.sucursal === "Pulhapanzac"
        ? `[Reserva PULHAPANZAK] ${p.nombre} - ${p.cantidad_personas || p.reserva_personas} personas - ${p.fecha_entrada || p.fecha_llegada} → ${p.fecha_salida}`
        : `[Reserva ${["Tuchi", "Mexcali"].includes(p.sucursal) ? p.sucursal : "Rosso " + p.sucursal}] ${p.reserva_nombre} - ${p.reserva_personas} personas - ${p.reserva_fecha} ${p.reserva_hora}`);
  }
  const title = hasPedido && hasReserva ? "Nuevo pedido y reserva" : hasPedido ? "Nuevo pedido" : "Nueva reserva";
  const mzExtra = mz ? [["Método de pago", p.metodo_pago], ["RTN", p.rtn_numero], ["Factura a nombre de", p.rtn_nombre]].filter(([, v]) => v) : [];
  const pedidoBody = hasPedido ? (mz ? mz.items.join("\n") : formatPedidoCompleto(p.pedido)) : "";
  const lines = [
    `${title} — ${rossoBrand(p)} (${p.sucursal})`,
    "",
    `Fecha (America/Guatemala): ${ts}`,
    `Sucursal: ${p.sucursal}`,
    `Cliente: ${p.nombre}`,
    `Teléfono: ${p.telefono}`,
  ];
  const rows = [["Sucursal", p.sucursal], ["Cliente", p.nombre], ["Teléfono", p.telefono]];
  const pedRows = [];
  if (hasPedido) {
    lines.push("", "PEDIDO", `Tipo de pedido: ${p.tipo_pedido}`, "Detalle:", pedidoBody, ...mzExtra.map(([k, v]) => `${k}: ${v}`), `Total: ${rossoMoney(p.total)}`);
    pedRows.push(["Tipo de pedido", p.tipo_pedido], ["Total", rossoMoney(p.total)]);
  }
  const resRows = [];
  const isPulhaReserva = hasReserva && p.sucursal === "Pulhapanzac";
  if (hasReserva && isPulhaReserva) {
    const personas = p.cantidad_personas || p.reserva_personas;
    const entrada = p.fecha_entrada || p.fecha_llegada || "";
    const salida = p.fecha_salida || "";
    const nombreCli = p.nombre;
    const correo = p.correo_electronico || "";
    // Reserva cabaña: nombre, tel, correo, fechas, noches+días, personas, menores sí/no
    const noches = p.cantidad_dias;
    const diasCal = noches != null ? noches + 1 : null;
    lines.length = 0;
    lines.push(
      `Nueva reserva — PULHAPANZAK`,
      "",
      `Fecha (America/Guatemala): ${ts}`,
      "",
      "RESERVA DE CABAÑA — PULHAPANZAK",
      `Nombre: ${nombreCli}`,
      `Teléfono: ${p.telefono}`,
      `Correo electrónico: ${correo}`,
      `Fecha de entrada: ${entrada}`,
      `Fecha de salida: ${salida}`,
      `Cantidad de noches: ${noches}`,
      `Cantidad de días: ${diasCal}`,
      `Cantidad de personas: ${personas}`,
      `niños menores: ${p.menor_de_5_anos}`,
      `Solicitud especial del cliente: ${String(p.notas_reserva || "").trim() ? p.notas_reserva : "Ninguno"}`,
      `total: ${String(p.total_reserva || "").trim() ? p.total_reserva : "Por confirmar"}`,
    );
    resRows.push(
      ["Nombre", nombreCli],
      ["Teléfono", p.telefono],
      ["Correo electrónico", correo],
      ["Fecha de entrada", entrada],
      ["Fecha de salida", salida],
      ["Cantidad de noches", String(noches)],
      ["Cantidad de días", String(diasCal)],
      ["Cantidad de personas", String(personas)],
      ["niños menores", String(p.menor_de_5_anos)],
      ["Solicitud especial del cliente", String(p.notas_reserva || "").trim() ? p.notas_reserva : "Ninguno"],
      ["total", String(p.total_reserva || "").trim() ? p.total_reserva : "Por confirmar"],
    );
  } else if (hasReserva) {
    lines.push("", "RESERVA DE MESA", `A nombre de: ${p.reserva_nombre}`, `Personas: ${p.reserva_personas}`, `Fecha: ${p.reserva_fecha}`, `Hora: ${p.reserva_hora}`);
    resRows.push(["A nombre de", p.reserva_nombre], ["Personas", String(p.reserva_personas)], ["Fecha", p.reserva_fecha], ["Hora", p.reserva_hora]);
  }
  if (!isPulhaReserva) lines.push("", `Notas: ${p.notas || "(ninguna)"}`);
  const items = mz ? mz.items : rossoSplitItems(p.pedido);
  const telFmt = p.telefono.length === 8 ? `${p.telefono.slice(0, 4)}-${p.telefono.slice(4)}` : p.telefono;
  const { kvTable, card } = EMAIL_UI;
  const itemsTable = EMAIL_UI.itemsTable(items, hasPedido ? rossoMoney(p.total) : "", mzExtra);
  const cards = [];
  if (!(hasReserva && isPulhaReserva && !hasPedido)) {
    cards.push(card("Cliente", kvTable([["Nombre", p.nombre], ["Teléfono", telFmt]])));
  }
  if (hasPedido) {
    cards.push(card("Pedido", kvTable([["Tipo", p.tipo_pedido]]) + itemsTable));
  }
  if (hasReserva && isPulhaReserva) {
    const personas = p.cantidad_personas || p.reserva_personas;
    const entrada = p.fecha_entrada || p.fecha_llegada || "";
    const salida = p.fecha_salida || "";
    const nombreCli = p.nombre;
    const correo = p.correo_electronico || "";
    const nochesKv = p.cantidad_dias;
    const diasKv = nochesKv != null ? nochesKv + 1 : null;
    const kv = [
      ["Nombre", nombreCli],
      ["Teléfono", telFmt],
      ["Correo electrónico", correo],
      ["Fecha de entrada", entrada],
      ["Fecha de salida", salida],
      ["Cantidad de noches", String(nochesKv)],
      ["Cantidad de días", String(diasKv)],
      ["Cantidad de personas", String(personas)],
      ["niños menores", String(p.menor_de_5_anos)],
      ["Solicitud especial del cliente", String(p.notas_reserva || "").trim() ? p.notas_reserva : "Ninguno"],
      ["total", String(p.total_reserva || "").trim() ? p.total_reserva : "Por confirmar"],
    ];
    cards.push(card("Reserva de cabaña — PULHAPANZAK", kvTable(kv)));
  } else if (hasReserva) {
    cards.push(card("Reserva", kvTable([["A nombre de", p.reserva_nombre], ["Personas", String(p.reserva_personas)], ["Día", p.reserva_fecha], ["Hora", p.reserva_hora]])));
  }
  if (!isPulhaReserva && p.notas) cards.push(EMAIL_UI.notasCard(p.notas));
  const html = p.sucursal === "Manzano"
    ? EMAIL_UI.shell(ts, "", cards) // franja verde: solo fecha/hora
    : EMAIL_UI.shell(`${title} — ${rossoBrand(p)}`, `Sucursal ${p.sucursal} · ${ts}`, cards);
  return { subject, text: lines.join("\n"), html };
}

// Solo El Manzano: "Delivery:/Recoger: <items>. Pago: X. RTN: …"
// Parrillas en el email: qty+plato, -Parrilla Personal|Duo|Cuarteto, -Acompañantes, •opts (una línea c/u)
function parseManzanoPedido(raw) {
  let s = String(raw || "").trim();
  let tipo = "";
  const pm = s.match(/^\s*(delivery|domicilio|recoger)\s*:\s*/i);
  if (pm) { tipo = /recoger/i.test(pm[1]) ? "Para recoger" : "Delivery"; s = s.slice(pm[0].length); }
  let rtn = "", rtnNombre = "", pago = "";
  const rm = s.match(/[.;,|]?\s*RTN\s*:?\s*([\d\s-]{6,})(?:\s*,?\s*a\s+nombre\s+de\s+([^.;|]+?))?\s*(?=$|[.;|]\s|\.$)/i);
  if (rm) { rtn = rm[1].replace(/\D/g, ""); rtnNombre = (rm[2] || "").trim(); s = s.replace(rm[0], "\n"); }
  const pg = s.match(/[.;,|]?\s*(?:m[eé]todo de )?pago\s*:\s*([^.;|,]+)/i);
  if (pg) { pago = pg[1].trim(); s = s.replace(pg[0], "\n"); }
  if (/^no\s*aplica$/i.test(pago)) pago = "";
  if (pago) pago = pago.charAt(0).toUpperCase() + pago.slice(1).toLowerCase();
  let chunks = s.split(/\s*\|\s*|\s*;\s*|\r?\n/).map((x) => x.trim()).filter(Boolean);
  // Si el modelo pegó " / " en vez de Enter, partir cada chunk
  chunks = chunks.flatMap((c) =>
    /\s\/\s/.test(c) && /(-Parrilla|•|-Acompa)/i.test(c)
      ? c.split(/\s\/\s/).map((x) => x.trim()).filter(Boolean)
      : [c]
  );
  const items = expandManzanoDetalleItems(chunks.length ? chunks : [s.trim()].filter(Boolean));
  return { tipo, pago, rtn, rtnNombre, items: items.length ? items : [String(raw || "").trim()] };
}

/** Solo Parrillas (Tradicional, Mar y Tierra, Tierra y Mar). */
function expandManzanoDetalleItems(chunks) {
  const out = [];
  const sizeRe = /\bParrilla\s+(Personal|Duo|Cuarteto)\b/i;
  const parrillaDishRe = /\b(Tradicional|Mar y Tierra|Tierra y Mar)\b/i;
  const pushUnique = (line) => {
    if (!line) return;
    if (/^-Parrilla\s+/i.test(line) && out.some((x) => x.toLowerCase() === line.toLowerCase())) return;
    if (out.length && out[out.length - 1] === line) return;
    out.push(line);
  };
  for (const raw of chunks) {
    const line = String(raw || "").trim();
    if (!line) continue;
    if (/^[-–—•·*]/.test(line)) {
      let cleaned = line.replace(/^[-–—]\s*/, "-").replace(/^[•·*]\s*/, "•");
      if (/^-Acompa[nñ]antes$/i.test(cleaned)) cleaned = "-Acompañantes";
      else if (/^-Salsa$/i.test(cleaned)) cleaned = "-Salsa";
      else if (/^-Parrilla\s+(Personal|Duo|Cuarteto)$/i.test(cleaned)) {
        const g = cleaned.match(/Parrilla\s+(Personal|Duo|Cuarteto)/i);
        cleaned = `-Parrilla ${g[1].charAt(0).toUpperCase()}${g[1].slice(1).toLowerCase()}`;
      }
      pushUnique(cleaned);
      continue;
    }
    const m = line.match(/^(\d+)\s+(.+?)(?:\s+con\s+(.+))?$/i);
    if (!m) { pushUnique(line); continue; }
    const qty = m[1];
    let rest = m[2].trim();
    const optsRaw = (m[3] || "").trim();
    const isParrilla = sizeRe.test(rest) || sizeRe.test(line) || parrillaDishRe.test(rest);
    if (!isParrilla) { pushUnique(line); continue; }
    let size = "";
    const sm = rest.match(sizeRe);
    if (sm) {
      size = `Parrilla ${sm[1].charAt(0).toUpperCase()}${sm[1].slice(1).toLowerCase()}`;
      rest = rest.replace(sizeRe, " ").replace(/\s+/g, " ").trim();
    }
    if (rest) rest = rest.charAt(0).toUpperCase() + rest.slice(1);
    pushUnique(`${qty} ${rest || line}`);
    if (size) pushUnique(`-${size}`);
    if (optsRaw) {
      pushUnique("-Acompañantes");
      for (const o of optsRaw.split(/\s+y\s+/i).map((x) => x.trim()).filter(Boolean)) {
        pushUnique(`•${o}`);
      }
    }
  }
  return out.length ? out : chunks;
}

function rossoSplitItems(raw) {
  const out = String(raw || "")
    .split(/\r?\n|;|,(?![^()]*\))|\s+y\s+(?=(?:\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b)/i)
    .map((s) => normalizePedidoQtyWords(s.trim().replace(/^[-•*]\s*/, "")))
    .filter(Boolean);
  return out.length ? out : [String(raw || "")];
}

/* ---------- Pulapanzác: nota interna de escalamiento ----------
 * POST /webhooks/pedido-rosso/Pulhapanzac/nota
 * Body: nombre, telefono, motivo, notas; telefono_confirmado optional.
 * Debe registrarse ANTES de la ruta :sucursal/:tipo (pedido|reserva|ambos).
 */
app.post("/webhooks/pedido-rosso/:sucursal/nota", async (req, res) => {
  const auth = checkSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const sucursal = rossoSucursal(req.params.sucursal);
  if (sucursal !== "Pulhapanzac") {
    return res.status(404).json({ ok: false, error: "nota interna solo disponible para Pulhapanzac" });
  }

  const m = { ...req.query, ...(req.body && typeof req.body === "object" ? req.body : {}) };
  const raw = (k) => (m[k] == null ? "" : typeof m[k] === "boolean" ? m[k] : String(m[k]).trim());
  const nombre = String(raw("nombre"));
  const telefono = String(raw("telefono"));
  const motivo = String(raw("motivo"));
  const notas = String(raw("notas"));
  const telefono_confirmado = rossoBool(raw("telefono_confirmado"));

  console.log("[pulhapanzac-nota] inbound", { nombre, telefono, motivo, notas, telefono_confirmado });

  if (!nombre || looksFake(nombre)) return res.status(400).json({ ok: false, error: "nombre es requerido" });
  if (!telefono || looksFake(telefono) || !/\d{7,}/.test(telefono)) {
    return res.status(400).json({ ok: false, error: "telefono es requerido" });
  }
  if (!motivo || looksFake(motivo)) return res.status(400).json({ ok: false, error: "motivo es requerido" });
  if (!notas || looksFake(notas)) return res.status(400).json({ ok: false, error: "notas son requeridas" });

  if (!SMTP_USER || !SMTP_APP_PASSWORD) {
    return res.status(500).json({ ok: false, error: "SMTP no configurado" });
  }

  const ts = guatemalaTimestamp();
  const shortMotivo = motivo.length > 80 ? motivo.slice(0, 77) + "…" : motivo;
  const subject = `[PULHAPANZAK] Nota interna: ${shortMotivo}`;
  const spirit = `No pude resolver esto: ${motivo}. Por favor contactar al cliente y darle la información correcta.`;
  const text = [
    "NOTA INTERNA — Cataratas PULHAPANZAK",
    "",
    spirit,
    "",
    `Fecha (America/Guatemala): ${ts}`,
    `Nombre: ${nombre}`,
    `Teléfono: ${telefono}`,
    `Motivo: ${motivo}`,
    `Notas: ${notas}`,
  ].join("\n");
  const { kvTable, card } = EMAIL_UI;
  const cards = [
    card("Escalamiento", `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;line-height:1.5;padding-top:6px">${escHtml(spirit)}</div>`),
    card("Cliente", kvTable([["Nombre", nombre], ["Teléfono", EMAIL_UI.fmtTel(telefono)]])),
    card("Detalle", kvTable([["Motivo", motivo]])),
    EMAIL_UI.notasCard(notas),
  ];
  const html = EMAIL_UI.shell("Nota interna — PULHAPANZAK", ts, cards);

  try {
    const info = await createTransport().sendMail({
      from: PULHAPANZAC_NOTA_FROM,
      to: PULHAPANZAC_TO_EMAIL,
      subject,
      text,
      html,
    });
    console.log(`[pulhapanzac-nota] enviado a ${PULHAPANZAC_TO_EMAIL} id=${info.messageId}`);
    return res.json({ ok: true, messageId: info.messageId, to: PULHAPANZAC_TO_EMAIL });
  } catch (e) {
    console.error("[pulhapanzac-nota] SMTP", e?.message || e);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: e?.message || String(e) });
  }
});

const ROSSO_FIXED = {
  "ambos": { tipo: "ambos", tipo_pedido: "comer en el restaurante" },
  "pedido": { tipo: "pedido", tipo_pedido: "recoger" },
  "reserva": { tipo: "reserva" },
};
function applyRossoTipoRoute(req, res) {
  const fx = ROSSO_FIXED[String(req.params.tipo).toLowerCase()];
  if (!fx) {
    res.status(404).json({ ok: false, error: "ruta inválida" });
    return false;
  }
  req.body = { ...(req.body && typeof req.body === "object" ? req.body : {}), sucursal: req.params.sucursal, ...fx };
  return true;
}
const ROSSO_RECENT = new Map();
async function handleRossoPedido(req, res) {
  const auth = checkSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const p = extractRosso(req);
  console.log("[rosso] inbound", p);
  const err = validateRosso(p);
  if (err) return res.status(400).json({ ok: false, error: err });
  const dupKey = [p.sucursal, p.tipo, String(p.telefono).replace(/\D/g, ""), p.pedido || "", p.total ?? "", p.reserva_personas ?? "", p.reserva_fecha || "", p.reserva_hora || ""].join("|").toLowerCase();
  const now = Date.now();
  for (const [k, t] of ROSSO_RECENT) if (now - t > 10 * 60 * 1000) ROSSO_RECENT.delete(k);
  if (ROSSO_RECENT.has(dupKey)) return res.json({ ok: true, duplicado: true, message: "Ya estaba enviado. No volver a enviar; despedirse." });
  const toEmail = p.sucursal === "Pulhapanzac" ? (p.tipo === "reserva" ? PULHAPANZAC_RESERVA_TO_EMAIL : PULHAPANZAC_TO_EMAIL) : p.sucursal === "Mexcali" ? MEXCALI_PEDIDO_TO_EMAIL : p.sucursal === "Manzano" ? MANZANO_TO_EMAIL : p.sucursal === "Tuchi" ? TUCHI_TO_EMAIL : p.sucursal === "Foresta" ? ROSSO_FORESTA_TO_EMAIL : ROSSO_PROCERES_TO_EMAIL;
  if (!SMTP_USER || !SMTP_APP_PASSWORD) return res.status(500).json({ ok: false, error: "SMTP no configurado" });
  const email = buildRossoEmail(p);
  if (process.env.ROSSO_DRY_RUN === "1") return res.json({ ok: true, dryRun: true, to: toEmail, ...email });
  try {
    const info = await createTransport().sendMail({ from: p.sucursal === "Pulhapanzac" ? PULHAPANZAC_FROM : p.sucursal === "Mexcali" ? MEXCALI_ROSSO_FROM : p.sucursal === "Manzano" ? MANZANO_FROM : p.sucursal === "Tuchi" ? TUCHI_FROM : ROSSO_FROM, to: toEmail, subject: email.subject, text: email.text, html: email.html });
    ROSSO_RECENT.set(dupKey, Date.now());
    console.log(`[rosso] enviado a ${toEmail} id=${info.messageId}`);
    return res.json({ ok: true, message: p.tipo === "reserva" ? "Reserva enviada" : "Pedido enviado", tipo: p.tipo, sucursal: p.sucursal, messageId: info.messageId, to: toEmail });
  } catch (e) {
    console.error("[rosso] SMTP", e?.message || e);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: e?.message || String(e) });
  }
}

// Ruta neutra (sin "rosso") — Manzano y futuros
app.post("/webhooks/pedido/:sucursal/:tipo", (req, res) => {
  if (!applyRossoTipoRoute(req, res)) return;
  return handleRossoPedido(req, res);
});
// Legacy pedido-rosso
app.post("/webhooks/pedido-rosso/:sucursal/:tipo", (req, res) => {
  if (!applyRossoTipoRoute(req, res)) return;
  return handleRossoPedido(req, res);
});
app.post("/webhooks/pedido-rosso", handleRossoPedido);
app.post("/webhooks/pedido", handleRossoPedido);

app.use((_req, res) => res.status(404).json({ ok: false, error: "No encontrado" }));


app.listen(PORT, "0.0.0.0", () => {
  console.log(`genio-lead-webhook on :${PORT}`);
});
