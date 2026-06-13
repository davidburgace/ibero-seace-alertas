// ============================================================================
// src/infra.js  —  Módulo Infra-Radar  (Fase A, v2)
// v2: el MEF está detrás de Incapsula (anti-bots) y bloquea la descarga desde
// Render. Como la base se actualiza ~mensual, el flujo robusto es subir el .xlsx
// a mano (bajado desde el navegador, que sí pasa Incapsula).
//   - POST /api/infra/ingest-upload   (multipart, campo "file")  ← USAR ESTE
//   - POST /api/infra/ingest          (intenta por URL; suele bloquearse)
// Reutiliza el stack: Supabase (service key), OpenAI gpt-4o-mini, embeddings
// text-embedding-3-small, Nodemailer, multer. No toca lo existente.
// ============================================================================

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import nodemailer from 'nodemailer';
import multer from 'multer';
import * as XLSX from 'xlsx';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

// ─── Clientes (mismos env que server.js) ────────────────────────────────────
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = process.env.SUPABASE_URL && SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, SUPABASE_KEY)
  : null;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MEF_OXI_XLSX_URL = process.env.MEF_OXI_XLSX_URL
  || 'https://www.mef.gob.pe/contenidos/inv_privada/obras_impuestos/base_adjudicaciones_OXI_31032026.xlsx';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://ibero-seace-alertas.onrender.com';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normaliza(v) {
  if (v == null) return '';
  return String(v).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

function findCol(headers, ...claves) {
  const c = claves.map(normaliza);
  return headers.find(h => { const n = normaliza(h); return c.every(k => n.includes(k)); }) || null;
}
function toISODate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function classify(text = '') {
  const t = text.toLowerCase();
  if (t.includes('hospital') || t.includes('clínic') || t.includes('clinic') || t.includes('salud') || t.includes('cama')) return 'Hospitalario';
  if (t.includes('escolar') || t.includes('carpeta') || t.includes('coleg') || t.includes('educac') || t.includes('ugel') || t.includes('institución educativa')) return 'Educación';
  if (t.includes('locker') || t.includes('casillero') || t.includes('metálic') || t.includes('metalico') || t.includes('armario')) return 'Metalmecánica';
  if (t.includes('melamine') || t.includes('oficina') || t.includes('escritorio') || t.includes('archivador')) return 'Oficina';
  return 'General';
}

// ─── Parseo del workbook (compartido por URL y por upload) ───────────────────
function rowsFromBuffer(buf) {
  // Validar que sea un .xlsx real (ZIP → empieza con "PK"). Si no, es HTML/bloqueo.
  if (!buf || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B) {
    const preview = Buffer.from(buf || []).toString('utf8', 0, 300).replace(/\s+/g, ' ');
    throw new Error(`No es un .xlsx válido (¿bloqueo Incapsula o archivo equivocado?). inicio="${preview}"`);
  }
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // La base suele tener filas de título antes del encabezado real.
  for (let hdr = 0; hdr < 6; hdr++) {
    const rows = XLSX.utils.sheet_to_json(sheet, { range: hdr, defval: null });
    if (rows.length && findCol(Object.keys(rows[0]), 'FINANCISTA')) {
      return { rows, headers: Object.keys(rows[0]) };
    }
  }
  throw new Error('No se detectó el encabezado (columna FINANCISTA) en la base del MEF.');
}

function normalizeMefRow(row, cols) {
  const cui = row[cols.cui];
  const nombre = row[cols.nombre];
  if (!cui || !nombre) return null;
  const texto = `${nombre} ${row[cols.sector] || ''}`;
  return {
    fuente: 'oxi_mef',
    external_id: String(cui).trim(),
    nombre: String(nombre).trim(),
    entidad_publica: cols.entidad ? row[cols.entidad] : null,
    financista: cols.financista && row[cols.financista] ? String(row[cols.financista]).trim() : null,
    sector: cols.sector ? row[cols.sector] : null,
    departamento: cols.depto ? row[cols.depto] : null,
    provincia: cols.prov ? row[cols.prov] : null,
    distrito: cols.dist ? row[cols.dist] : null,
    monto_inversion: cols.monto && row[cols.monto] != null ? Number(String(row[cols.monto]).replace(/[^\d.-]/g, '')) || null : null,
    estado_convenio: cols.estado ? row[cols.estado] : null,
    anio_buena_pro: cols.anio_bp && row[cols.anio_bp] != null ? (parseInt(String(row[cols.anio_bp]).replace(/[^\d]/g, '')) || null) : null,
    fecha_convenio: cols.fecha_conv ? toISODate(row[cols.fecha_conv]) : null,
    business_line: classify(texto),
    incluye_mobiliario: /MOBILIARI|EQUIPAMIENT|CARPETA/.test(normaliza(texto)),
    raw: row,
    alert_sent: false
  };
}

function esRelevante(item) {
  const t = normaliza(`${item.nombre} ${item.sector || ''}`);
  const educacion = t.includes('EDUCAC') || t.includes('COLEGIO') || t.includes('INSTITUCION EDUCATIVA')
      || t.includes('I.E') || item.business_line === 'Educación';
  const salud = t.includes('SALUD') || t.includes('HOSPITAL') || t.includes('CLINIC')
      || t.includes('CENTRO DE SALUD') || t.includes('ESTABLECIMIENTO DE SALUD')
      || t.includes('POSTA') || item.business_line === 'Hospitalario';
  return educacion || salud;
}

function detectCols(headers) {
  return {
    cui:        findCol(headers, 'CODIGO', 'UNICO') || findCol(headers, 'CUI') || findCol(headers, 'SNIP'),
    nombre:     findCol(headers, 'NOMBRE', 'INVERSION') || headers.find(h => normaliza(h) === 'INTERVENCION') || findCol(headers, 'NOMBRE', 'PROYECTO') || findCol(headers, 'DENOMINACION'),
    financista: findCol(headers, 'FINANCISTA'),
    sector:     findCol(headers, 'SECTOR') || findCol(headers, 'MATERIA') || findCol(headers, 'FUNCION'),
    entidad:    findCol(headers, 'ENTIDAD', 'PUBLICA') || findCol(headers, 'ENTIDAD'),
    depto:      findCol(headers, 'DEPARTAMENTO'),
    prov:       findCol(headers, 'PROVINCIA'),
    dist:       findCol(headers, 'DISTRITO'),
    monto:      findCol(headers, 'MONTO', 'INVERSION') || findCol(headers, 'MONTO', 'ADJUDICACION'),
   estado:     findCol(headers, 'ESTADO', 'CONVENIO') || findCol(headers, 'ESTADO'),
    anio_bp:    findCol(headers, 'BUENA', 'PRO'),
    fecha_conv: findCol(headers, 'FECHA', 'CONVENIO')
  };
}

// Núcleo: parsea un buffer .xlsx y hace upsert. Lo usan URL y upload.
async function ingestFromBuffer(buf) {
  if (!supabase) throw new Error('Supabase no configurado');
  const { rows, headers } = rowsFromBuffer(buf);
  const cols = detectCols(headers);
  console.log('[INFRA] Columnas detectadas:', cols);

  // Excluir estados sin opción comercial (concluido/liquidado)
  const SIN_OPCION = /CONCLUID|LIQUIDAD/;
  const items = rows.map(r => normalizeMefRow(r, cols)).filter(Boolean)
    .filter(esRelevante)
    .filter(i => !SIN_OPCION.test(normaliza(i.estado_convenio)));
  const byId = new Map();
  items.forEach(i => byId.set(i.external_id, i));
  const unique = [...byId.values()];

  if (unique.length) {
    const { error } = await supabase.from('infra_oportunidades')
      .upsert(unique, { onConflict: 'fuente,external_id', ignoreDuplicates: false });
    if (error) throw error;
  }
  return { total_filas: rows.length, relevantes: unique.length, columnas: cols, headers };
}

// Intento por URL (suele bloquearse por Incapsula desde Render)
async function ingestOxiMefURL() {
  const res = await fetch(MEF_OXI_XLSX_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*',
      'Accept-Language': 'es-PE,es;q=0.9',
      'Referer': 'https://www.mef.gob.pe/'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`MEF HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return ingestFromBuffer(buf);
}

// ─── IA: scoring ─────────────────────────────────────────────────────────────
async function callAI(prompt) {
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3
  });
  return r.choices[0].message.content;
}
async function getEmbedding(text) {
  const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: String(text).slice(0, 8000) });
  return r.data[0].embedding;
}

async function analyzeInfra(op) {
  const prompt = `
Analiza esta oportunidad de infraestructura pública/privada para Grupo Ibero Perú
(fabricante de mobiliario escolar, hospitalario, de oficina y metálico). A diferencia
de una licitación SEACE, aquí el comprador del mobiliario suele ser el EJECUTOR de la
obra (constructora/consorcio), no la entidad pública ni la financista.

Fuente: ${op.fuente}
Nombre: ${op.nombre || ''}
Entidad pública: ${op.entidad_publica || ''}
Financista: ${op.financista || ''}
Sector: ${op.sector || ''}
Ubicación: ${[op.distrito, op.provincia, op.departamento].filter(Boolean).join(', ') || ''}
Monto inversión: ${op.monto_inversion ? `S/ ${Number(op.monto_inversion).toLocaleString('es-PE')}` : 'No especificado'}
Etapa: ${op.etapa || op.estado_convenio || 'No especificada'}
¿Incluye mobiliario/equipamiento?: ${op.incluye_mobiliario === true ? 'Sí (heurística)' : 'Por confirmar'}

Responde ÚNICAMENTE con JSON válido, sin texto adicional. El score total debe ser la
suma de los criteria.score (máx 100):
{
  "summary": "resumen ejecutivo en 2 oraciones",
  "business_line": "Educación|Hospitalario|Oficina|Metalmecánica|General",
  "incluye_mobiliario": true,
  "score": 0,
  "decision": "PERSEGUIR|REVISAR|DESCARTAR",
  "recommendation": "recomendación breve y accionable",
  "criteria": [
    {"name":"Mobiliario/línea de negocio","score":0,"max":30},
    {"name":"Monto de inversión","score":0,"max":15},
    {"name":"Etapa y timing","score":0,"max":20},
    {"name":"Logística y región (plantas Puente Piedra/Lurín)","score":0,"max":15},
    {"name":"Canal de acceso al comprador (¿ejecutor identificable?)","score":0,"max":10},
    {"name":"Probabilidad de cierre","score":0,"max":10}
  ],
  "risks": ["riesgo 1","riesgo 2","riesgo 3"],
  "actions": ["acción 1","acción 2","acción 3"]
}`;
  const raw = await callAI(prompt);
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

async function scoreOpportunity(id) {
  const { data: op, error } = await supabase.from('infra_oportunidades').select('*').eq('id', id).single();
  if (error) throw error;
  const a = await analyzeInfra(op);
  let embedding = null;
  try { embedding = await getEmbedding(`${op.nombre} ${op.financista || ''} ${op.sector || ''} ${a.summary || ''}`); }
  catch (e) { console.error('[INFRA] embedding:', e.message); }
  const update = {
    ai_summary: a.summary, ai_score: a.score, ai_recommendation: a.decision,
    ai_criteria: a.criteria || [], ai_risks: a.risks || [], ai_actions: a.actions || [],
    incluye_mobiliario: a.incluye_mobiliario ?? op.incluye_mobiliario,
    business_line: a.business_line || op.business_line,
    updated_at: new Date().toISOString()
  };
  if (embedding) update.embedding = embedding;
  await supabase.from('infra_oportunidades').update(update).eq('id', id);
  return { ...op, ...update };
}

// ─── Digest ──────────────────────────────────────────────────────────────────
function renderInfraEmail(ops) {
  const rows = ops.slice(0, 15).map(o => {
    const link = `${FRONTEND_URL}/infra.html?id=${encodeURIComponent(o.id)}`;
    const monto = o.monto_inversion ? `S/ ${Number(o.monto_inversion).toLocaleString('es-PE')}` : 'No especificado';
    return `
<div style="border:1px solid #e7eaf0;border-radius:12px;padding:16px;margin-bottom:12px;background:white;">
  <div style="margin-bottom:8px;">
    <span style="background:#0f766e;color:white;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;">${o.fuente}</span>
    <span style="color:#6b7280;font-size:12px;margin-left:6px;">${o.external_id || ''} · score ${o.ai_score ?? '—'}</span>
  </div>
  <h3 style="margin:0 0 8px;font-size:15px;color:#111827;">${o.nombre || 'Oportunidad'}</h3>
  <p style="margin:2px 0;color:#4b5563;font-size:13px;"><b>Financista:</b> ${o.financista || '-'}</p>
  <p style="margin:2px 0;color:#4b5563;font-size:13px;"><b>Monto:</b> ${monto}</p>
  <p style="margin:2px 0;color:#4b5563;font-size:13px;"><b>Etapa:</b> ${o.etapa || o.estado_convenio || '-'}</p>
  <a href="${link}" style="display:inline-block;margin-top:10px;background:#0f766e;color:white;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">Ver oportunidad →</a>
</div>`;
  }).join('');
  return `
<div style="font-family:Arial,sans-serif;background:#f6f7fb;padding:20px;max-width:680px;margin:0 auto;">
  <div style="background:#0f766e;color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="margin:0;font-size:22px;">🏗️ Radar Infra (OxI/APP) — Grupo Ibero</h1>
    <p style="margin:6px 0 0;opacity:0.85;">${ops.length} oportunidades de infraestructura</p>
  </div>
  <div style="padding:16px 0;">${rows}</div>
</div>`;
}

async function sendInfraDigest() {
  if (!supabase) return { ok: false, message: 'Supabase no configurado' };
  if (!process.env.SMTP_HOST) return { ok: false, message: 'SMTP no configurado' };
  const { data: ops } = await supabase.from('infra_oportunidades').select('*')
    .order('ai_score', { ascending: false, nullsFirst: false }).limit(30);
  const { data: vendors } = await supabase.from('vendors').select('*');
  const recipients = (vendors || []).map(v => v.email).filter(Boolean).join(',');
  if (!recipients) return { ok: false, message: 'No hay vendedores configurados' };
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  await transport.verify();
  const info = await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER, to: recipients,
    subject: `🏗️ ${(ops || []).length} oportunidades Infra (OxI/APP) — Radar Ibero`,
    html: renderInfraEmail(ops || [])
  });
  return { ok: true, recipients, messageId: info.messageId || null };
}

// ─── Rutas (/api/infra/*) ────────────────────────────────────────────────────
router.get('/api/infra/health', (_, res) =>
  res.json({ ok: true, supabase: !!supabase, mef_url: MEF_OXI_XLSX_URL }));

// PRINCIPAL: subir el .xlsx bajado desde el navegador (pasa Incapsula)
router.post('/api/infra/ingest-upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo (campo "file")' });
    res.json({ ok: true, archivo: req.file.originalname, ...(await ingestFromBuffer(req.file.buffer)) });
  } catch (e) { next(e); }
});

// Intento por URL (probablemente bloqueado por Incapsula desde Render)
// Consulta INFOBRAS por CUI (param "valor"). Devuelve estado, código interno y, si están, contratista/avance.
async function consultarInfobras(cui) {
  const base = 'https://infobras.contraloria.gob.pe/InfobrasWeb/Mapa/MapaEstadistico/BusquedaAvanzada';
  const qs = new URLSearchParams({
    nombre:'', codigo:'', valor:String(cui||''), desde:'', hasta:'', minimo:'', maximo:'',
    nivel1:'', nivel2:'', nivel3:'', controlSocial:'', controlGubernamental:'', tipoControl:'',
    marca:'', departamento:'', provincia:'', distrito:'', estado:'', modalidadEjecucion:'',
    orderBy:'en_ejecucion', pageNumber:'1', pageSize:'20'
  });
  const res = await fetch(`${base}?${qs.toString()}`, {
    headers: {
      'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':'application/json, text/plain, */*',
      'X-Requested-With':'XMLHttpRequest',
      'Referer':'https://infobras.contraloria.gob.pe/InfobrasWeb/Mapa/Index'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`INFOBRAS HTTP ${res.status}`);
  const data = await res.json();
  const r = (data.Result || [])[0];
  if (!r) return { registrada: false };
  return {
    registrada: true,
    estado: r.Estado || null,
    codigoInfobras: r.Codigo || null,
    nombre: r.NombreObra || null,
    ubicacion: r.Ubicacion || null,
    contratista: r.Contratista || null,
    avanceFisico: r.AvanceFisico ?? null
  };
}

router.get('/api/infra/opportunities/:id/infobras', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { data: op } = await supabase.from('infra_oportunidades').select('external_id').eq('id', req.params.id).single();
    if (!op) return res.status(404).json({ ok: false, error: 'No encontrada' });
    const info = await consultarInfobras(op.external_id);
    res.json({ ok: true, infobras: info });
  } catch (e) { next(e); }
});
router.post('/api/infra/ingest', async (_, res, next) => {
  try { res.json({ ok: true, ...(await ingestOxiMefURL()) }); } catch (e) { next(e); }
});
// Diagnóstico ProInversión: trae el detalle desde el servidor y reporta si la ejecutora viene en el HTML
router.get('/api/infra/proinversion-test', async (req, res) => {
  try {
    const url = req.query.url || 'https://www.investinperu.pe/procesos-de-seleccion/procesos-de-seleccion-detalle/?1056/1653';
    const r = await fetch(url, {
      headers: {
        'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(20000)
    });
    const html = await r.text();
    const up = html.toUpperCase();
    const idx = up.indexOf('EJECUTORA');
    const rucs = (html.match(/\b\d{11}\b/g) || []).slice(0, 12);
    res.json({
      ok: true, status: r.status, length: html.length,
      tieneEjecutora: idx >= 0,
      tieneAdjudicataria: up.includes('ADJUDICATARIA'),
      rucsEncontrados: rucs,
      snippet: idx >= 0 ? html.slice(idx, idx + 700).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ') : html.slice(0, 500)
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});router.get('/api/infra/opportunities', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    let q = supabase.from('infra_oportunidades').select('id,fuente,external_id,nombre,entidad_publica,financista,sector,departamento,provincia,distrito,monto_inversion,etapa,estado_convenio,estado_ejecucion,incluye_mobiliario,business_line,ai_summary,ai_score,ai_recommendation,ai_criteria,ai_risks,ai_actions,fecha_deteccion,anio_buena_pro,fecha_convenio,infra_ejecutores(consorcio_nombre,estado_verificacion),proinversion_url,proinversion_estado')
      .order('ai_score', { ascending: false, nullsFirst: false }).limit(500);
    if (req.query.sector)       q = q.ilike('sector', `%${req.query.sector}%`);
    if (req.query.financista)   q = q.ilike('financista', `%${req.query.financista}%`);
    if (req.query.departamento) q = q.ilike('departamento', `%${req.query.departamento}%`);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, count: data.length, opportunities: data });
  } catch (e) { next(e); }
});

router.get('/api/infra/opportunities/:id', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { data: op } = await supabase.from('infra_oportunidades').select('*').eq('id', req.params.id).single();
    if (!op) return res.status(404).json({ ok: false, error: 'No encontrada' });
    const analyzed = op.ai_summary ? op : await scoreOpportunity(req.params.id);
    const { data: senales } = await supabase.from('infra_senales').select('*').eq('oportunidad_id', req.params.id);
    const { data: ejecutores } = await supabase.from('infra_ejecutores').select('*').eq('oportunidad_id', req.params.id);
    res.json({ ok: true, opportunity: analyzed, senales: senales || [], ejecutores: ejecutores || [] });
  } catch (e) { next(e); }
});
// Chat sobre una oportunidad (grounded en sus datos + análisis IA; sin RAG porque OxI no trae documentos)
// Guardar/actualizar el ejecutor de una oportunidad (cola de enriquecimiento)
// Búsqueda web del ejecutor (Responses API + web_search), con fallback de variante
// Búsqueda web del ejecutor (Responses API + web_search), con fallback de variante
async function buscarEjecutorWeb(input) {
  const model = process.env.INFRA_SEARCH_MODEL || 'gpt-4o';
  try {
    return await openai.responses.create({ model, tools: [{ type: 'web_search' }], input });
  } catch (e) {
    return await openai.responses.create({ model, tools: [{ type: 'web_search_preview' }], input });
  }
}

function normNombre(s){ return String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }

// Sugerir ejecutor: la IA busca en la web y PROPONE; el humano confirma y guarda
router.post('/api/infra/opportunities/:id/sugerir-ejecutor', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { data: op } = await supabase.from('infra_oportunidades').select('*').eq('id', req.params.id).single();
    if (!op) return res.status(404).json({ ok: false, error: 'No encontrada' });

    const loc = [op.distrito, op.provincia, op.departamento].filter(Boolean).join(', ');
    const fin = op.financista || 'desconocido';
    const input = `Eres un investigador de obras públicas peruanas. Tu única tarea es identificar la EMPRESA EJECUTORA (la constructora o consorcio de construcción que FÍSICAMENTE construye la obra) de este proyecto, ejecutado bajo Obras por Impuestos (OxI).

REGLA CRÍTICA: en OxI hay DOS empresas distintas. La FINANCISTA aporta el dinero (suele ser un banco o una minera: BCP, Antamina, Southern, Interbank, etc.). La EJECUTORA construye (constructora o consorcio de obra civil). NUNCA las confundas.
- La financista de ESTA obra es: "${fin}". Ese nombre está PROHIBIDO como respuesta. Si lo único que encuentras es la financista, responde ejecutor=null.
- Tampoco aceptes a la entidad pública (PRONIED, municipalidad, gobierno regional, Minedu) como ejecutor.
- Un ejecutor válido se ve así: "Consorcio ...", "Constructora ...", "... Contratistas Generales", "... Ingeniería y Construcción".

Proyecto: ${op.nombre}
CUI: ${op.external_id}
Entidad pública: ${op.entidad_publica || ''}
Ubicación: ${loc}

Busca frases explícitas: "ejecución a cargo de", "ejecutada por el consorcio", "contratista", "construye la obra". Prioriza INFOBRAS (campo Ejecutor/Contratista), notas de colocación de primera piedra y convenios. Si no hallas una constructora claramente distinta de la financista, responde ejecutor=null con confianza "baja".

Responde ÚNICAMENTE con JSON válido, sin texto adicional:
{"ejecutor":"constructora/consorcio o null","ruc":"RUC o null","confianza":"alta|media|baja","fuente":"URL principal","nota":"1 oración explicando el hallazgo o por qué no se encontró"}`;

    const r = await buscarEjecutorWeb(input);
    const text = (r.output_text || '').replace(/```json|```/g, '').trim();
    let sug;
    try { sug = JSON.parse(text); } catch { sug = { ejecutor: null, confianza: 'baja', nota: (text || '').slice(0, 300) }; }

    // Candado determinista: si la "sugerencia" es la financista (o la contiene), se descarta
    if (sug && sug.ejecutor && op.financista) {
      const e = normNombre(sug.ejecutor), f = normNombre(op.financista);
      if (e && f && (e.includes(f) || f.includes(e))) {
        sug = { ejecutor: null, confianza: 'baja', fuente: sug.fuente || null,
                nota: 'Solo se halló la empresa financista, no el ejecutor. Verifícalo manualmente en INFOBRAS.' };
      }
    }
    res.json({ ok: true, sugerencia: sug });
  } catch (e) { next(e); }
});

// Sugerir ejecutor: la IA busca en la web y PROPONE; el humano confirma y guarda
router.post('/api/infra/opportunities/:id/sugerir-ejecutor', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { data: op } = await supabase.from('infra_oportunidades').select('*').eq('id', req.params.id).single();
    if (!op) return res.status(404).json({ ok: false, error: 'No encontrada' });

    const loc = [op.distrito, op.provincia, op.departamento].filter(Boolean).join(', ');
    const input = `Investiga en la web quién es la EMPRESA EJECUTORA (constructora o consorcio) de esta obra pública peruana, ejecutada bajo Obras por Impuestos (OxI). En OxI el ejecutor NO es la financista ni la entidad pública: es la constructora que construye la obra.

Proyecto: ${op.nombre}
CUI: ${op.external_id}
Financista (NO es el ejecutor): ${op.financista || 'desconocido'}
Entidad: ${op.entidad_publica || ''}
Ubicación: ${loc}

Busca en INFOBRAS, PRONIED, notas de prensa de colocación de primera piedra, convenios de inversión e informes de Contraloría. Responde ÚNICAMENTE con JSON válido, sin texto adicional:
{"ejecutor":"nombre del consorcio/constructora o null","ruc":"RUC si aparece o null","confianza":"alta|media|baja","fuente":"URL de la fuente principal","nota":"1 oración explicando el hallazgo"}`;

    const r = await buscarEjecutorWeb(input);
    const text = (r.output_text || '').replace(/```json|```/g, '').trim();
    let sug;
    try { sug = JSON.parse(text); }
    catch { sug = { ejecutor: null, confianza: 'baja', nota: (text || '').slice(0, 300) }; }
    res.json({ ok: true, sugerencia: sug });
  } catch (e) { next(e); }
});
router.put('/api/infra/opportunities/:id/ejecutor', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { consorcio_nombre, ruc, contacto, estado_verificacion, fuente } = req.body;
    const payload = {
      oportunidad_id: req.params.id,
      consorcio_nombre: consorcio_nombre || null,
      ruc: ruc || null,
      contacto: contacto || null,
      estado_verificacion: estado_verificacion || 'en_revision',
      fuente: fuente || 'infobras',
      updated_at: new Date().toISOString()
    };
    const { data: existing } = await supabase.from('infra_ejecutores').select('id').eq('oportunidad_id', req.params.id).limit(1);
    let result;
    if (existing && existing.length) {
      result = await supabase.from('infra_ejecutores').update(payload).eq('id', existing[0].id).select().single();
    } else {
      result = await supabase.from('infra_ejecutores').insert(payload).select().single();
    }
    if (result.error) throw result.error;
    res.json({ ok: true, ejecutor: result.data });
  } catch (e) { next(e); }
});
router.post('/api/infra/opportunities/:id/ask', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { question } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ ok: false, error: 'La pregunta es requerida' });
    const { data: op } = await supabase.from('infra_oportunidades').select('*').eq('id', req.params.id).single();
    if (!op) return res.status(404).json({ ok: false, error: 'No encontrada' });
    const { data: senales } = await supabase.from('infra_senales').select('*').eq('oportunidad_id', req.params.id);
    const { data: ejecutores } = await supabase.from('infra_ejecutores').select('*').eq('oportunidad_id', req.params.id);

    const ctx = `OPORTUNIDAD (canal: ${op.fuente})
Nombre: ${op.nombre || ''}
Entidad pública: ${op.entidad_publica || ''}
Financista: ${op.financista || ''}
Sector: ${op.sector || ''}
Ubicación: ${[op.distrito, op.provincia, op.departamento].filter(Boolean).join(', ')}
Monto inversión: ${op.monto_inversion ? 'S/ ' + Number(op.monto_inversion).toLocaleString('es-PE') : 'No especificado'}
Estado: ${op.estado_convenio || op.etapa || 'No especificado'}
CUI: ${op.external_id || ''}
¿Incluye mobiliario?: ${op.incluye_mobiliario ? 'Sí' : 'Por confirmar'}

ANÁLISIS IA:
Resumen: ${op.ai_summary || 'No analizado aún'}
Score: ${op.ai_score ?? '—'} · Decisión: ${op.ai_recommendation || '—'}
Riesgos: ${(op.ai_risks || []).join('; ') || '—'}
Acciones: ${(op.ai_actions || []).join('; ') || '—'}

SEÑALES: ${(senales || []).map(s => `${s.tipo}: ${s.descripcion || ''}`).join(' | ') || 'ninguna'}
EJECUTOR: ${(ejecutores || []).map(e => `${e.consorcio_nombre || 'por confirmar'} (${e.estado_verificacion})`).join(', ') || 'no identificado'}`;

    const prompt = `Eres un asistente comercial experto en infraestructura pública/privada (OxI, APP, PRONIED) para Grupo Ibero Perú (fabrica mobiliario escolar, hospitalario, de oficina y metálico). En estos canales el comprador del mobiliario suele ser el EJECUTOR de la obra, no la entidad ni la financista.

${ctx}

PREGUNTA: ${question}

Responde claro, práctico y orientado a decisión comercial. Si la respuesta exige un dato que no está arriba (p.ej. quién es el ejecutor), dilo y sugiere dónde buscarlo (convenio, informe de Contraloría).`;

    const r = await openai.chat.completions.create({
      model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1500
    });
    res.json({ ok: true, answer: r.choices[0].message.content });
  } catch (e) { next(e); }
});
// Ingesta del Excel de ProInversión (Procesos de selección OxI): mapea CUI -> enlace al detalle (donde está la ejecutora)
async function ingestProinversion(buf) {
  if (!supabase) throw new Error('Supabase no configurado');
  if (!buf || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B) throw new Error('No es un .xlsx válido');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);

  let headerRow = -1; const cols = {};
  for (let r = range.s.r; r <= Math.min(range.s.r + 15, range.e.r); r++) {
    let found = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      const v = cell ? normaliza(cell.v) : '';
      if (v.includes('CODIGO UNICO') || v === 'CUI') found = true;
    }
    if (found) {
      headerRow = r;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        const v = cell ? normaliza(cell.v) : '';
        if (v.includes('CODIGO UNICO') || v === 'CUI') cols.cui = c;
        else if (v.includes('ENLACE PORTAL') || (v.includes('PORTAL') && v.includes('PROINVERSION'))) cols.link = c;
        else if (v.includes('TIPO') && v.includes('CONVOCATORIA')) cols.tipo = c;
        else if (v === 'ESTADO') cols.estado = c;
      }
      break;
    }
  }
  if (headerRow < 0 || cols.cui == null || cols.link == null) throw new Error('No se detectó encabezado (CUI/Enlace) en el Excel de ProInversión');

  const byCui = new Map();
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const cuiCell = ws[XLSX.utils.encode_cell({ r, c: cols.cui })];
    if (!cuiCell || cuiCell.v == null) continue;
    const cui = String(cuiCell.v).trim();
    const tipo = cols.tipo != null ? normaliza((ws[XLSX.utils.encode_cell({ r, c: cols.tipo })] || {}).v) : '';
    const estado = cols.estado != null ? (ws[XLSX.utils.encode_cell({ r, c: cols.estado })] || {}).v : null;
    const linkCell = ws[XLSX.utils.encode_cell({ r, c: cols.link })];
    const url = linkCell && linkCell.l ? linkCell.l.Target : null;
    if (!url) continue;
    const isEmpresa = tipo.includes('EMPRESA PRIVADA');
    const prev = byCui.get(cui);
    if (!prev || (isEmpresa && !prev.isEmpresa)) byCui.set(cui, { url, estado, isEmpresa });
  }

  let matched = 0;
  for (const [cui, info] of byCui) {
    const { data, error } = await supabase.from('infra_oportunidades')
      .update({ proinversion_url: info.url, proinversion_estado: info.estado, updated_at: new Date().toISOString() })
      .eq('external_id', cui).select('id');
    if (!error && data && data.length) matched += data.length;
  }
  return { procesos: byCui.size, oportunidades_actualizadas: matched };
}

router.post('/api/infra/ingest-proinversion', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo (campo "file")' });
    res.json({ ok: true, archivo: req.file.originalname, ...(await ingestProinversion(req.file.buffer)) });
  } catch (e) { next(e); }
});

// --- ProInversión: extraer ejecutoras/adjudicatarias del HTML del detalle ---
function piParseDescripcion(s) {
  if (!s) return [];
  return s.split(';').map(p => {
    const f = p.split('|');
    const nombre = (f[0] || '').trim().replace(/&amp;/g, '&');
    const ruc = (f[1] || '').trim();
    return nombre ? { nombre, ruc: /^\d{11}$/.test(ruc) ? ruc : null } : null;
  }).filter(Boolean);
}
function piExtractField(html, field) {
  const m = html.match(new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
  return m ? m[1] : null;
}
async function fetchProinversionEmpresas(url) {
  let lastErr;
  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept':'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(45000)
      });
      if (!r.ok) throw new Error(`ProInversión HTTP ${r.status}`);
      const html = await r.text();
      return {
        ejecutoras: piParseDescripcion(piExtractField(html, 'EjecutoraDescripcion')),
        adjudicatarias: piParseDescripcion(piExtractField(html, 'AdjudicatariaDescripcion'))
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

router.post('/api/infra/opportunities/:id/cargar-proinversion', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok:false, error:'Supabase no configurado' });
    const { data: op } = await supabase.from('infra_oportunidades').select('proinversion_url').eq('id', req.params.id).single();
    if (!op) return res.status(404).json({ ok:false, error:'No encontrada' });
    if (!op.proinversion_url) return res.json({ ok:false, error:'Esta oportunidad no tiene proceso en ProInversión' });
    const emp = await fetchProinversionEmpresas(op.proinversion_url);
    res.json({ ok:true, ...emp });
  } catch (e) { next(e); }
});
router.post('/api/infra/score-pending', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const limit = Math.min(Number(req.query.limit || 10), 50);
    const { data } = await supabase.from('infra_oportunidades').select('id').is('ai_score', null).limit(limit);
    let done = 0;
    for (const row of data || []) { try { await scoreOpportunity(row.id); done++; } catch (e) { console.error(e.message); } }
    res.json({ ok: true, scored: done });
  } catch (e) { next(e); }
});

router.post('/api/infra/senales', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { oportunidad_id, tipo, descripcion, severidad, fecha, fuente_url } = req.body;
    const { data, error } = await supabase.from('infra_senales')
      .insert({ oportunidad_id, tipo, descripcion, severidad, fecha, fuente_url }).select().single();
    if (error) throw error;
    res.json({ ok: true, senal: data });
  } catch (e) { next(e); }
});

router.get('/api/infra/send-digest', async (_, res, next) => { try { res.json(await sendInfraDigest()); } catch (e) { next(e); } });
router.post('/api/infra/send-digest', async (_, res, next) => { try { res.json(await sendInfraDigest()); } catch (e) { next(e); } });

// Para el cron de server.js (intenta por URL; si Incapsula bloquea, solo registra el error)
export async function runInfraIngest() {
  const r = await ingestOxiMefURL();
  console.log(`[INFRA][CRON] OxI MEF: ${r.relevantes} relevantes de ${r.total_filas} filas`);
  return r;
}

export default router;

// ============================================================================
// INTEGRACIÓN EN server.js (sin cambios respecto a v1):
//   1) import infraRouter, { runInfraIngest } from './infra.js';
//   2) app.use(infraRouter);   (antes del middleware de error)
//   3) (opcional) cron — ojo: por Incapsula probablemente falle; el flujo real
//      es subir el archivo a mano con /api/infra/ingest-upload una vez al mes.
//
// package.json: "xlsx" (nuevo) y "multer" (YA lo tienes) deben estar presentes.
// ============================================================================
