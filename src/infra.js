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
  const wb = XLSX.read(buf, { type: 'buffer' });
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
    business_line: classify(texto),
    incluye_mobiliario: /MOBILIARI|EQUIPAMIENT|CARPETA/.test(normaliza(texto)),
    raw: row,
    alert_sent: false
  };
}

function esRelevante(item) {
  const t = normaliza(`${item.nombre} ${item.sector || ''}`);
  return t.includes('EDUCAC') || t.includes('COLEGIO') || t.includes('INSTITUCION EDUCATIVA')
      || t.includes('I.E') || item.business_line === 'Educación';
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
    estado:     findCol(headers, 'ESTADO', 'CONVENIO') || findCol(headers, 'ESTADO')
  };
}

// Núcleo: parsea un buffer .xlsx y hace upsert. Lo usan URL y upload.
async function ingestFromBuffer(buf) {
  if (!supabase) throw new Error('Supabase no configurado');
  const { rows, headers } = rowsFromBuffer(buf);
  const cols = detectCols(headers);
  console.log('[INFRA] Columnas detectadas:', cols);

  const items = rows.map(r => normalizeMefRow(r, cols)).filter(Boolean).filter(esRelevante);
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
router.post('/api/infra/ingest', async (_, res, next) => {
  try { res.json({ ok: true, ...(await ingestOxiMefURL()) }); } catch (e) { next(e); }
});

router.get('/api/infra/opportunities', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    let q = supabase.from('infra_oportunidades').select('*')
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
