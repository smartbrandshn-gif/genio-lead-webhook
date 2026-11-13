process.env.GENIO_NO_LISTEN = "1";
import fs from "node:fs";
import { buildRossoEmail } from "../server.js";
import { GOLDEN_CASES } from "./golden-cases.mjs";
const TS_RE = /\b(?:Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes|S[aá]bado|Domingo), \d{1,2} de (?:Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre) de \d{4}, \d{1,2}:\d{2}:\d{2} [ap]\. m\./gi;
const norm = (s) => String(s).replace(TS_RE, "<TS>");
const out = {};
for (const [k, p] of Object.entries(GOLDEN_CASES)) { const e = buildRossoEmail(structuredClone(p)); out[k] = { subject: e.subject, text: norm(e.text), html: norm(e.html) }; }
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
