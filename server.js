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
const LEAD_FROM_NAME = process.env.LEAD_FROM_NAME || "Genio Demo";
const CLIENT_LABEL = process.env.CLIENT_LABEL || "Genio Demo";

const CANALES = new Set(["whatsapp", "telefono", "email"]);
const PLACEHOLDER_BAD =
  /(sin\s+nombre|sin\s+especificar|n[uú]mero\s+entrante|usuario\s+sin|no\s+proporcionad|unknown|\bn\/?a\b|pendiente|placeholder|\b999999\b)/i;

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
  const telefono = pick(merged, ["telefono_whatsapp", "telefono", "whatsapp", "phone"]);
  const interes = pick(merged, ["interes", "interest", "rubro", "producto"]).toLowerCase();
  const horario = pick(merged, ["horario_contacto", "horario"]);
  let canal = pick(merged, ["canal_preferido", "canal"]).toLowerCase();
  if (canal === "correo" || canal === "mail") canal = "email";
  if (canal === "llamada" || canal === "phone") canal = "telefono";
  if (canal === "wa") canal = "whatsapp";
  const notas = pick(merged, ["notas", "notes", "summary"]);
  let caller_id = pick(merged, ["caller_id", "callerId"]);
  if (looksFake(caller_id)) caller_id = "";
  return {
    nombre,
    telefono_whatsapp: telefono,
    interes,
    horario_contacto: horario,
    canal_preferido: canal,
    notas,
    caller_id,
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
  if (!CANALES.has(lead.canal_preferido)) {
    return { ok: false, error: "canal_preferido debe ser whatsapp|telefono|email" };
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
    `Caller ID: ${lead.caller_id || "(n/a)"}`,
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
      ${row("Caller ID", lead.caller_id || "(n/a)")}
    </table>
  </div></body></html>`;
  return { subject, text, html };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "genio-lead-webhook",
    client: CLIENT_LABEL,
    time: guatemalaTimestamp(),
    smtpConfigured: Boolean(SMTP_USER && SMTP_APP_PASSWORD && LEAD_TO_EMAIL),
    secretConfigured: Boolean(LEAD_WEBHOOK_SECRET),
  });
});

app.post("/webhooks/enviar-lead", async (req, res) => {
  const auth = checkSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const lead = extractLead(req);
  console.log("[lead] inbound", lead);

  const validated = validateLead(lead);
  if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

  if (!lead.caller_id && lead.telefono_whatsapp) lead.caller_id = lead.telefono_whatsapp;

  try {
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_APP_PASSWORD },
    });
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

app.use((_req, res) => res.status(404).json({ ok: false, error: "No encontrado" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`genio-lead-webhook on :${PORT}`);
});
