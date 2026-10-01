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
const PEDIDO_TO_EMAIL = process.env.PEDIDO_TO_EMAIL || "";
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
  // Same multi-source phone resolve as pedidos (body.caller_id → X-Caller-Number)
  const phone = resolveCallerPhone(req);
  return {
    nombre,
    telefono_whatsapp: telefono,
    interes,
    horario_contacto: horario,
    canal_preferido: canal,
    notas,
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
  if (!lead.horario_contacto || looksFake(lead.horario_contacto)) {
    return { ok: false, error: "horario_contacto real es requerido" };
  }
  if (lead.canal_preferido && !CANALES.has(lead.canal_preferido)) {
    return { ok: false, error: "canal_preferido debe ser whatsapp|telefono|email" };
  }
  if (!lead.canal_preferido) lead.canal_preferido = "telefono";
  if (!lead.notas || looksFake(lead.notas) || /sin\s+notas/i.test(lead.notas)) {
    return { ok: false, error: "notas reales son requeridas" };
  }
  return { ok: true };
}

function buildEmail(lead) {
  const ts = guatemalaTimestamp();
  const subject = `[Lead ${CLIENT_LABEL}] ${lead.interes} — ${lead.nombre}`;
  const text = [
    `Nuevo lead — ${CLIENT_LABEL}`,
    "",
    `Fecha (America/Guatemala): ${ts}`,
    `Nombre: ${lead.nombre}`,
    `Teléfono / WhatsApp: ${lead.telefono_whatsapp}`,
    `Interés / rubro: ${lead.interes}`,
    `Horario: ${lead.horario_contacto}`,
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
      ${row("Teléfono / WhatsApp", lead.telefono_whatsapp)}
      ${row("Interés / rubro", lead.interes)}
      ${row("Horario", lead.horario_contacto)}
      ${row("Canal", lead.canal_preferido)}
      ${row("Notas", lead.notas || "(sin notas)")}
      ${row("Número de cliente", lead.caller_id || "(n/a)")}
    </table>
  </div></body></html>`;
  return { subject, text, html };
}

function normalizeTipo(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!s) return "";
  if (
    /\b(recoger|llevar|pickup|para\s+llevar|take\s*away|takeaway|to\s*go)\b/.test(s) ||
    s === "recoger" ||
    s === "para llevar"
  ) {
    return "recoger";
  }
  if (
    /\b(comer|restaurante|local|dine\s*in|dine-in|aqui|aquí|mesa|en\s+el\s+local|comer\s+en)\b/.test(s) ||
    /comer\s+en\s+(el\s+)?restaurante/.test(s) ||
    s === "dine in" ||
    s === "en el local"
  ) {
    return "comer en el restaurante";
  }
  return "";
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

/** Cliente phone from the call (Caller ID); empty/placeholders → ""; pedidos treat missing as optional. */
function normalizeCallerId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (looksFake(s)) return "";
  return s;
}

/**
 * Resolve customer phone for Wangs pedidos / lead Número de cliente.
 * Order (first non-empty after normalize):
 *   1) body.caller_id (or body.callerId)
 *   2) header X-Caller-Number (case-insensitive; system vars)
 * Never use destination_number or caller_id_dest_test as the customer phone
 * (caller_id_dest_test is logged only for diagnostics).
 */
function resolveCallerPhone(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const bodyRaw =
    body.caller_id != null && String(body.caller_id).trim() !== ""
      ? body.caller_id
      : body.callerId != null && String(body.callerId).trim() !== ""
        ? body.callerId
        : "";
  // Express req.get is case-insensitive; detect header key presence separately
  const headerHeaderPresent = Object.keys(req.headers || {}).some(
    (k) => k.toLowerCase() === "x-caller-number"
  );
  const headerRaw = req.get("X-Caller-Number") || "";
  const fromBody = normalizeCallerId(bodyRaw);
  const fromHeader = normalizeCallerId(headerRaw);
  const resolved = fromBody || fromHeader || "";
  let source = "";
  if (fromBody) source = "body.caller_id";
  else if (fromHeader) source = "header.X-Caller-Number";
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
  const tipoRaw = pick(merged, ["tipo", "modalidad", "tipo_pedido", "para"]);
  const pagoRaw = pick(merged, ["metodo_pago", "pago", "payment"]);
  const rtnRaw = pick(merged, ["rtn", "RTN", "factura_rtn"]);
  const phone = resolveCallerPhone(req);
  return {
    nombre_cliente,
    pedido_completo,
    notas,
    total_pedido,
    tipo: normalizeTipo(tipoRaw),
    metodo_pago: normalizePago(pagoRaw),
    rtn: normalizeRtn(rtnRaw),
    caller_id: phone.caller_id,
    _tipoRaw: tipoRaw,
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
  if (!pedido.tipo) {
    return {
      ok: false,
      error: 'tipo debe ser "recoger" o "comer en restaurante" (se aceptan variantes como para llevar, pickup, dine in)',
    };
  }
  if (!pedido.metodo_pago) {
    return { ok: false, error: 'metodo_pago debe ser "Efectivo" o "Tarjeta"' };
  }
  if (!pedido.rtn) {
    return { ok: false, error: "Falta el campo rtn: usa No si no quiere factura, o nombre y número de RTN si sí" };
  }
  // caller_id / phone is optional for pedidos: missing → email uses "No disponible"
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

function buildPedidoEmail(pedido) {
  const ts = guatemalaTimestamp();
  const subject = `[Pedido Wangs] ${pedido.nombre_cliente} — ${pedido.tipo} — ${pedido.total_pedido}`;
  const pedidoBody = formatPedidoCompleto(pedido.pedido_completo);
  const numeroCliente = pedido.caller_id || "No disponible";
  const text = [
    "Nuevo pedido — Wangs",
    "",
    `Fecha (America/Guatemala): ${ts}`,
    `Cliente: ${pedido.nombre_cliente}`,
    "Pedido:",
    pedidoBody,
    `Notas / solicitudes especiales: ${pedido.notas || "(ninguna)"}`,
    `Total: ${pedido.total_pedido}`,
    `Tipo: ${pedido.tipo}`,
    `Método de pago: ${pedido.metodo_pago}`,
    `RTN: ${pedido.rtn}`,
    `caller id: ${numeroCliente}`,
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
      ${row("Tipo", pedido.tipo)}
      ${row("Método de pago", pedido.metodo_pago)}
      ${row("RTN", pedido.rtn)}
      ${row("caller id", numeroCliente)}
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
    secretConfigured: Boolean(LEAD_WEBHOOK_SECRET),
  });
});

app.post("/webhooks/enviar-lead", async (req, res) => {
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
    const info = await transport.sendMail({
      from: `"${LEAD_FROM_NAME}" <${SMTP_USER}>`,
      to: LEAD_TO_EMAIL,
      subject,
      text,
      html,
    });
    console.log(`[lead] enviado a ${LEAD_TO_EMAIL} id=${info.messageId}`);
    return res.json({ ok: true, message: "Lead enviado", messageId: info.messageId });
  } catch (err) {
    console.error("[lead] SMTP", err?.message || err);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: err?.message || String(err) });
  }
});

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
    tipo: pedido.tipo,
    metodo_pago: pedido.metodo_pago,
    rtn: pedido.rtn,
    caller_id: pedido.caller_id,
    _tipoRaw: pedido._tipoRaw,
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
      tipo: pedido.tipo,
      metodo_pago: pedido.metodo_pago,
      rtn: pedido.rtn,
      caller_id: pedido.caller_id || "No disponible",
    });
  } catch (err) {
    console.error("[pedido] SMTP", err?.message || err);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el email", detail: err?.message || String(err) });
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: "No encontrado" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`genio-lead-webhook on :${PORT}`);
});
