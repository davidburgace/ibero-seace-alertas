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
    tipo_intervencion: cols.tipo && row[cols.tipo] ? String(row[cols.tipo]).trim() : null,
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
    // "INTERVENCIÓN" es el nombre real del proyecto; "TIPO DE INTERVENCIÓN" es solo una categoría (siempre dice "Proyecto")
    // y contiene la misma palabra, así que hay que evitarla explícitamente.
    nombre:     headers.find(h => normaliza(h) === 'INTERVENCION')
             || headers.find(h => normaliza(h).includes('INTERVENCION') && !normaliza(h).startsWith('TIPO'))
             || findCol(headers, 'NOMBRE', 'PROYECTO') || findCol(headers, 'NOMBRE'),
    // Esta sí es la columna "TIPO DE INTERVENCIÓN": Proyecto | IOARR | Mantenimiento | Operación y Mantenimiento
    tipo:       headers.find(h => normaliza(h).startsWith('TIPO') && normaliza(h).includes('INTERVENCION')),
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
  return { total_filas: rows.length, relevantes: unique.length, columnas: cols };
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

    // Adjuntar los ejecutores ya encontrados (tabla separada), para que se vean en la tarjeta sin abrir el detalle.
    const ids = (data || []).map(o => o.id);
    if (ids.length) {
      const { data: ejecutores, error: errEj } = await supabase.from('infra_ejecutores')
        .select('*').in('oportunidad_id', ids);
      if (errEj) console.error('[INFRA] Error cargando ejecutores para el listado:', errEj.message);
      else {
        const porOportunidad = {};
        (ejecutores || []).forEach(e => {
          if (!porOportunidad[e.oportunidad_id]) porOportunidad[e.oportunidad_id] = [];
          porOportunidad[e.oportunidad_id].push(e);
        });
        (data || []).forEach(o => { o.infra_ejecutores = porOportunidad[o.id] || []; });
      }
    }

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

// Guardar/actualizar el ejecutor (constructora/consorcio) de una oportunidad, a mano.
router.put('/api/infra/opportunities/:id/ejecutor', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { id } = req.params;
    const { consorcio_nombre, ruc, contacto, estado_verificacion, fuente } = req.body;
    if (!consorcio_nombre) return res.status(400).json({ ok: false, error: 'consorcio_nombre es requerido' });

    const { data: existente } = await supabase.from('infra_ejecutores')
      .select('id').eq('oportunidad_id', id).limit(1).maybeSingle();

    const payload = {
      oportunidad_id: id,
      consorcio_nombre,
      ruc: ruc || null,
      contacto: contacto || null,
      estado_verificacion: estado_verificacion || null,
      fuente: fuente || 'manual',
      updated_at: new Date().toISOString()
    };

    let error;
    if (existente) {
      ({ error } = await supabase.from('infra_ejecutores').update(payload).eq('id', existente.id));
    } else {
      ({ error } = await supabase.from('infra_ejecutores').insert(payload));
    }
    if (error) throw error;
    res.json({ ok: true });
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

// Chat de preguntas sobre una oportunidad puntual
router.post('/api/infra/opportunities/:id/ask', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { id } = req.params;
    const { question } = req.body;
    if (!question?.trim()) return res.status(400).json({ ok: false, error: 'La pregunta es requerida' });

    const { data: op } = await supabase.from('infra_oportunidades').select('*').eq('id', id).single();
    if (!op) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });
    const { data: ejecutores } = await supabase.from('infra_ejecutores').select('*').eq('oportunidad_id', id);
    const ej = (ejecutores || [])[0];

    const prompt = `Eres un asistente comercial experto en obras por impuestos (OxI) y APP para Grupo Ibero Perú
(fabrica mobiliario escolar, hospitalario, de oficina y metálico). A diferencia de una licitación SEACE,
aquí el comprador del mobiliario suele ser el EJECUTOR de la obra (constructora/consorcio), no la entidad
pública ni la financista.

OPORTUNIDAD:
Nombre: ${op.nombre || ''}
Financista: ${op.financista || ''}
Entidad pública: ${op.entidad_publica || ''}
Sector: ${op.sector || ''}
Ubicación: ${[op.distrito, op.provincia, op.departamento].filter(Boolean).join(', ') || ''}
Monto de inversión: ${op.monto_inversion ? `S/ ${Number(op.monto_inversion).toLocaleString('es-PE')}` : 'No especificado'}
Estado del convenio: ${op.estado_convenio || 'No especificado'}
Año de buena pro: ${op.anio_buena_pro || 'No especificado'}
Ejecutor asignado: ${ej ? `${ej.consorcio_nombre}${ej.ruc ? ' (RUC ' + ej.ruc + ')' : ''}` : 'Aún no identificado'}
${op.ai_summary ? `Resumen IA: ${op.ai_summary}` : ''}

PREGUNTA: ${question}

Responde de forma clara, práctica y orientada a decisión comercial.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1500
    });
    const answer = response.choices[0].message.content;
    try { await supabase.from('infra_ai_chats').insert({ oportunidad_id: id, question, answer }); } catch (e) {}
    res.json({ ok: true, answer });
  } catch (e) { next(e); }
});

// Sugerir ejecutor con IA + búsqueda web (herramienta nativa de OpenAI, sin API key adicional)
router.post('/api/infra/opportunities/:id/sugerir-ejecutor', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { id } = req.params;
    const { data: op } = await supabase.from('infra_oportunidades').select('*').eq('id', id).single();
    if (!op) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });

    const prompt = `Busca en la web quién es el EJECUTOR (constructora o consorcio a cargo de la obra) del
siguiente proyecto de infraestructura pública en Perú (Obras por Impuestos / APP). Suele aparecer en
INFOBRAS (infobras.contraloria.gob.pe), ProInversión, OSCE o noticias de adjudicación.

Proyecto: ${op.nombre || ''}
Financista: ${op.financista || ''}
Entidad pública: ${op.entidad_publica || ''}
Ubicación: ${[op.distrito, op.provincia, op.departamento].filter(Boolean).join(', ') || ''}
Año de buena pro: ${op.anio_buena_pro || ''}

Responde ÚNICAMENTE con JSON válido, sin texto adicional:
{"ejecutor": "nombre de la constructora/consorcio, o null si no lo encuentras", "ruc": "RUC si lo encuentras, o null", "confianza": "alta|media|baja", "fuente": "URL de la fuente más confiable, o null", "nota": "breve explicación de 1 línea"}`;

    let raw;
    try {
      const resp = await openai.responses.create({
        model: 'gpt-4o',
        tools: [{ type: 'web_search_preview' }],
        input: prompt
      });
      raw = resp.output_text;
    } catch (webErr) {
      console.error('[INFRA] web_search no disponible, uso fallback sin navegar:', webErr.message);
      const fallback = await openai.chat.completions.create({
        model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.2
      });
      raw = fallback.choices[0].message.content;
    }
    const sugerencia = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
    res.json({ ok: true, sugerencia });
  } catch (e) { next(e); }
});

// Extrae una tabla RUC/Razón Social de una sección del HTML de la ficha ProInversión,
// buscando el <h2> que la titula y tomando el primer <tbody> que aparezca después.
function extraerTablaProinversion(html, tituloSeccion) {
  const idx = html.indexOf(tituloSeccion);
  if (idx === -1) return [];
  const resto = html.slice(idx);
  const tbodyMatch = resto.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return [];
  const filas = [...tbodyMatch[1].matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>(?:\s*<td[^>]*>([^<]*)<\/td>)?\s*<\/tr>/g)];
  return filas.map(f => ({
    ruc: (f[1] || '').trim(),
    nombre: (f[2] || '').trim(),
    ...(f[3] !== undefined ? { participacion: f[3].trim() } : {})
  })).filter(e => e.nombre);
}

// Cargar ejecutor(as) directo desde la ficha oficial de ProInversión ya vinculada a esta oportunidad.
// La ficha es HTML servido por WordPress (no una SPA), así que se descarga y se parsean sus tablas
// "Empresa(s) Ejecutora(s)" y "Empresa(s) Adjudicataria(s)" directamente — sin IA, sin adivinar.
router.post('/api/infra/opportunities/:id/cargar-proinversion', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { id } = req.params;
    const { data: op } = await supabase.from('infra_oportunidades').select('*').eq('id', id).single();
    if (!op) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });
    if (!op.proinversion_url) return res.json({ ok: true, ejecutoras: [], adjudicatarias: [], nota: 'Esta oportunidad no tiene ficha de ProInversión vinculada.' });

    const resp = await fetch(op.proinversion_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!resp.ok) return res.json({ ok: true, ejecutoras: [], adjudicatarias: [], nota: `No se pudo abrir la ficha (HTTP ${resp.status}).` });
    const html = await resp.text();

    const ejecutoras = extraerTablaProinversion(html, 'Empresa(s) Ejecutora(s)');
    const adjudicatarias = extraerTablaProinversion(html, 'Empresa(s) Adjudicataria(s)');

    if (!ejecutoras.length && !adjudicatarias.length) {
      return res.json({ ok: true, ejecutoras: [], adjudicatarias: [], nota: 'ProInversión aún no muestra ejecutora (proceso sin adjudicar todavía).' });
    }
    res.json({ ok: true, ejecutoras, adjudicatarias });
  } catch (e) { next(e); }
});

// TODO: reconstruir el parser real cuando tengamos una muestra del Excel de ProInversión.
// Por ahora responde JSON claro en vez de un 404 en HTML, para no romper el fetch del frontend.
router.post('/api/infra/ingest-proinversion', upload.single('file'), async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo (campo "file")' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const range = XLSX.utils.decode_range(sheet['!ref']);

    // Ubicar la fila de encabezado y las columnas relevantes (el archivo trae varias filas de título antes)
    let headerRow = -1, colCUI = -1, colLink = -1, colTipo = -1;
    for (let r = range.s.r; r <= Math.min(range.e.r, 20); r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell && typeof cell.v === 'string') {
          if (cell.v.includes('Código Único de Inversiones')) { headerRow = r; colCUI = c; }
          if (cell.v.includes('Enlace Portal web ProInversión')) colLink = c;
          if (cell.v.trim() === 'Tipo de Convocatoria') colTipo = c;
        }
      }
      if (headerRow >= 0 && colLink >= 0) break;
    }
    if (headerRow === -1 || colCUI === -1 || colLink === -1) {
      return res.status(400).json({ ok: false, error: 'No se detectaron las columnas esperadas (CUI / Enlace Portal web ProInversión) en el Excel.' });
    }

    // Leer cada fila: uno o varios CUI (separados por ";") con su URL de la ficha (el hipervínculo real, no el texto de la celda).
    // Un mismo CUI puede tener 2 convocatorias (p.ej. "Empresa Privada" y "Entidad Privada Supervisora");
    // nos quedamos con la de "Empresa Privada" porque es la que identifica al ejecutor/constructora.
    const porCui = {};
    let totalFilas = 0;
    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const cuiCell = sheet[XLSX.utils.encode_cell({ r, c: colCUI })];
      const linkCell = sheet[XLSX.utils.encode_cell({ r, c: colLink })];
      if (!cuiCell || !cuiCell.v) continue;
      const url = linkCell && linkCell.l ? linkCell.l.Target : null;
      if (!url) continue;
      totalFilas++;
      const tipo = colTipo >= 0 ? (sheet[XLSX.utils.encode_cell({ r, c: colTipo })]?.v || '') : '';
      String(cuiCell.v).split(';').map(s => s.trim()).filter(Boolean).forEach(cui => {
        const actual = porCui[cui];
        if (!actual || (tipo === 'Empresa Privada' && actual.tipo !== 'Empresa Privada')) {
          porCui[cui] = { url, tipo };
        }
      });
    }
    const registros = Object.entries(porCui).map(([cui, v]) => ({ cui, url: v.url }));

    // Enlazar por lotes: buscar el id interno de infra_oportunidades para cada CUI, y actualizar solo proinversion_url
    let actualizadas = 0;
    const CHUNK = 200;
    for (let i = 0; i < registros.length; i += CHUNK) {
      const lote = registros.slice(i, i + CHUNK);
      const cuis = [...new Set(lote.map(x => x.cui))];
      const { data: encontrados, error: errBusca } = await supabase.from('infra_oportunidades')
        .select('id, external_id').in('external_id', cuis);
      if (errBusca) { console.error('[INFRA] Error buscando CUIs:', errBusca.message); continue; }
      const idPorCui = {};
      (encontrados || []).forEach(o => { idPorCui[o.external_id] = o.id; });

      const payload = lote
        .filter(x => idPorCui[x.cui])
        .map(x => ({ id: idPorCui[x.cui], proinversion_url: x.url }));
      if (!payload.length) continue;

      const { error: errUpsert } = await supabase.from('infra_oportunidades')
        .upsert(payload, { onConflict: 'id' });
      if (errUpsert) console.error('[INFRA] Error actualizando proinversion_url:', errUpsert.message);
      else actualizadas += payload.length;
    }

    res.json({ ok: true, procesos: registros.length, oportunidades_actualizadas: actualizadas });
  } catch (e) { next(e); }
});

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
