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
  return new Intl.DateTimeFormat("es-GT", {
    timeZone: "America/Guatemala",
    dateStyle: "full",
    timeStyle: "medium",
  }).format(date);
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
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const row = (l, v) =>
    `<tr><td style="padding:6px 12px;font-weight:600;vertical-align:top">${esc(l)}</td><td style="padding:6px 12px">${esc(v)}</td></tr>`;
  const pedidoHtml = `<div style="padding:4px 20px 12px">
      <div style="font-weight:600;margin:0 0 8px;font-size:14px">Pedido</div>
      <pre style="margin:0;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;white-space:pre-line;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace,system-ui;font-size:14px;line-height:1.45;color:#1c1917">${esc(pedidoBody)}</pre>
    </div>`;
  const html = `<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#b45309;color:#fff;padding:16px 20px">
      <h1 style="margin:0;font-size:18px">Pedido — Wangs</h1>
      <p style="margin:4px 0 0;opacity:.9;font-size:13px">Genio · notificaciones</p>
    </div>
    <p style="padding:16px 20px 0;color:#64748b;font-size:13px">${esc(ts)}</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 0">
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

function rossoNorm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function rossoSucursal(raw) {
  const s = rossoNorm(raw);
  if (s.includes("foresta")) return "Foresta";
  if (s.includes("procer")) return "Proceres";
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
    rtn_numero: String(raw("rtn_numero")),
    rtn_nombre: String(raw("rtn_nombre")),
    notas: String(raw("notas")),
    reserva_nombre: String(raw("reserva_nombre")),
    reserva_personas: (() => { const n = parseInt(String(raw("reserva_personas")).replace(/\D/g, ""), 10); return n > 0 ? n : null; })(),
    reserva_fecha: String(raw("reserva_fecha")),
    reserva_hora: String(raw("reserva_hora")),
  };
}

function validateRosso(p) {
  if (!p.tipo) return "tipo inválido: usa 'pedido', 'reserva' o 'ambos'";
  if (!p.sucursal) return "sucursal es requerida: 'Foresta' o 'Proceres'";
  if (!p.nombre || looksFake(p.nombre)) return "nombre es requerido";
  if (!p.telefono) return "telefono es requerido: 8 dígitos sin 504";
  if (p.tipo !== "reserva") {
    if (!p.tipo_pedido) return "tipo_pedido es requerido: 'recoger' o 'comer en el restaurante'";
    if (!p.pedido || looksFake(p.pedido)) return "pedido es requerido";
    if (p.total == null) return "total es requerido (número en lempiras)";
    if (p.necesita_rtn == null) return "necesita_rtn es requerido (true/false)";
    if (p.necesita_rtn && (!p.rtn_numero || !p.rtn_nombre)) return "rtn_numero y rtn_nombre son requeridos cuando necesita_rtn es true";
  }
  if (p.tipo !== "pedido") {
    if (!p.reserva_nombre || looksFake(p.reserva_nombre)) return "reserva_nombre es requerido";
    if (!p.reserva_personas) return "reserva_personas es requerido (número)";
    if (!p.reserva_fecha) return "reserva_fecha es requerida";
    if (!p.reserva_hora) return "reserva_hora es requerida";
  }
  return "";
}

function buildRossoEmail(p) {
  const ts = guatemalaTimestamp();
  const hasPedido = p.tipo !== "reserva";
  const hasReserva = p.tipo !== "pedido";
  const subject = hasPedido
    ? `[Pedido Rosso ${p.sucursal}] ${p.nombre} - ${rossoMoney(p.total)}`
    : `[Reserva Rosso ${p.sucursal}] ${p.reserva_nombre} - ${p.reserva_personas} personas - ${p.reserva_fecha} ${p.reserva_hora}`;
  const title = hasPedido && hasReserva ? "Nuevo pedido y reserva" : hasPedido ? "Nuevo pedido" : "Nueva reserva";
  const pedidoBody = hasPedido ? formatPedidoCompleto(p.pedido) : "";
  const lines = [
    `${title} — Rosso Napoletano (${p.sucursal})`,
    "",
    `Fecha (America/Guatemala): ${ts}`,
    `Sucursal: ${p.sucursal}`,
    `Cliente: ${p.nombre}`,
    `Teléfono: ${p.telefono}`,
  ];
  const rows = [["Sucursal", p.sucursal], ["Cliente", p.nombre], ["Teléfono", p.telefono]];
  const pedRows = [];
  if (hasPedido) {
    lines.push("", "PEDIDO", `Tipo de pedido: ${p.tipo_pedido}`, "Detalle:", pedidoBody, `Total: ${rossoMoney(p.total)}`);
    pedRows.push(["Tipo de pedido", p.tipo_pedido], ["Total", rossoMoney(p.total)]);
    if (p.necesita_rtn) {
      lines.push(`Factura con RTN: Sí`, `RTN número: ${p.rtn_numero}`, `RTN a nombre de: ${p.rtn_nombre}`);
      pedRows.push(["Factura con RTN", "Sí"], ["RTN número", p.rtn_numero], ["RTN a nombre de", p.rtn_nombre]);
    } else {
      lines.push("Factura con RTN: No");
      pedRows.push(["Factura con RTN", "No"]);
    }
  }
  const resRows = [];
  if (hasReserva) {
    lines.push("", "RESERVA DE MESA", `A nombre de: ${p.reserva_nombre}`, `Personas: ${p.reserva_personas}`, `Fecha: ${p.reserva_fecha}`, `Hora: ${p.reserva_hora}`);
    resRows.push(["A nombre de", p.reserva_nombre], ["Personas", String(p.reserva_personas)], ["Fecha", p.reserva_fecha], ["Hora", p.reserva_hora]);
  }
  lines.push("", `Notas: ${p.notas || "(ninguna)"}`);
  const items = rossoSplitItems(p.pedido);
  const telFmt = p.telefono.length === 8 ? `${p.telefono.slice(0, 4)}-${p.telefono.slice(4)}` : p.telefono;
  const F = "font-family:Arial,Helvetica,sans-serif;";
  const kv = (l, v, last) => `<tr><td style="${F}padding:8px 0;font-size:13px;color:#6b7280;width:38%;vertical-align:top;${last ? "" : "border-bottom:1px solid #f1f1f1;"}">${escHtml(l)}</td><td style="${F}padding:8px 0;font-size:14px;color:#111827;font-weight:bold;vertical-align:top;${last ? "" : "border-bottom:1px solid #f1f1f1;"}">${escHtml(v)}</td></tr>`;
  const kvTable = (r) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${r.map(([a, b], i) => kv(a, b, i === r.length - 1)).join("")}</table>`;
  const card = (t, inner) => `<tr><td style="padding:0 24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff">
    <tr><td style="${F}padding:12px 16px 4px;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#7f1d1d">${escHtml(t)}</td></tr>
    <tr><td style="padding:0 16px 12px">${inner}</td></tr></table></td></tr>`;
  const itemsTable = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:8px">
    <tr><td style="${F}padding:6px 10px;font-size:11px;font-weight:bold;text-transform:uppercase;color:#6b7280;background:#f9fafb;border-bottom:1px solid #e5e7eb">Detalle del pedido</td></tr>
    ${items.map((it) => `<tr><td style="${F}padding:9px 10px;font-size:14px;color:#111827;border-bottom:1px solid #f1f1f1">${escHtml(it)}</td></tr>`).join("")}
    <tr><td style="padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>
      <td style="${F}padding:12px 10px;font-size:15px;font-weight:bold;color:#7f1d1d;background:#fef2f2">Total</td>
      <td align="right" style="${F}padding:12px 10px;font-size:16px;font-weight:bold;color:#7f1d1d;background:#fef2f2;text-align:right">${escHtml(hasPedido ? rossoMoney(p.total) : "")}</td></tr></table></td></tr></table>`;
  const cards = [card("Cliente", kvTable([["Nombre", p.nombre], ["Teléfono", telFmt]]))];
  if (hasPedido) {
    cards.push(card("Pedido", kvTable([["Tipo", p.tipo_pedido]]) + itemsTable));
    const fr = [["RTN", p.necesita_rtn ? "Sí" : "No"]];
    if (p.necesita_rtn) fr.push(["Número RTN", p.rtn_numero], ["A nombre de", p.rtn_nombre]);
    cards.push(card("Factura", kvTable(fr)));
  }
  if (hasReserva) cards.push(card("Reserva", kvTable([["A nombre de", p.reserva_nombre], ["Personas", String(p.reserva_personas)], ["Día", p.reserva_fecha], ["Hora", p.reserva_hora]])));
  if (p.notas) cards.push(card("Notas", `<div style="${F}font-size:14px;color:#111827;line-height:1.5;padding-top:6px">${escHtml(p.notas)}</div>`));
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-collapse:separate;border:1px solid #e5e7eb;border-radius:10px">
  <tr><td style="background:#7f1d1d;padding:22px 24px;border-radius:10px 10px 0 0">
    <div style="${F}font-size:20px;font-weight:bold;color:#ffffff">${escHtml(title)} — Rosso Napoletano</div>
    <div style="${F}font-size:13px;color:#fecaca;padding-top:6px">Sucursal ${escHtml(p.sucursal)} · ${escHtml(ts)}</div>
  </td></tr>
  <tr><td style="height:20px;line-height:20px;font-size:0">&nbsp;</td></tr>
  ${cards.join("\n  ")}
  <tr><td style="${F}padding:4px 24px 20px;font-size:11px;color:#9ca3af;text-align:center">Notificación automática · Genio</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text: lines.join("\n"), html };
}

function rossoSplitItems(raw) {
  const out = String(raw || "")
    .split(/\r?\n|;|,(?![^()]*\))|\s+y\s+(?=(?:\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b)/i)
    .map((s) => normalizePedidoQtyWords(s.trim().replace(/^[-•*]\s*/, "")))
    .filter(Boolean);
  return out.length ? out : [String(raw || "")];
}

app.post("/webhooks/pedido-rosso", async (req, res) => {
  const auth = checkSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const p = extractRosso(req);
  console.log("[rosso] inbound", p);
  const err = validateRosso(p);
  if (err) return res.status(400).json({ ok: false, error: err });
  const toEmail = p.sucursal === "Foresta" ? ROSSO_FORESTA_TO_EMAIL : ROSSO_PROCERES_TO_EMAIL;
  if (!SMTP_USER || !SMTP_APP_PASSWORD) return res.status(500).json({ ok: false, error: "SMTP no configurado" });
  const email = buildRossoEmail(p);
  if (process.env.ROSSO_DRY_RUN === "1") return res.json({ ok: true, dryRun: true, to: toEmail, ...email });
  try {
    const info = await createTransport().sendMail({ from: ROSSO_FROM, to: toEmail, subject: email.subject, text: email.text, html: email.html });
    console.log(`[rosso] enviado a ${toEmail} id=${info.messageId}`);
    return res.json({ ok: true, message: p.tipo === "reserva" ? "Reserva enviada" : "Pedido enviado", tipo: p.tipo, sucursal: p.sucursal, messageId: info.messageId, to: toEmail });
  } catch (e) {
    console.error("[rosso] SMTP", e?.message || e);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: e?.message || String(e) });
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: "No encontrado" }));


app.listen(PORT, "0.0.0.0", () => {
  console.log(`genio-lead-webhook on :${PORT}`);
});
