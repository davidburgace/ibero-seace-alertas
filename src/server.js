import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import OpenAI from 'openai';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL?.split(',') || '*' }));
app.use(express.json());
app.use(express.static('src/public'));

const VERSION = '1.1.0';
const MODE = 'seace-api-direct';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

// ─── Clientes externos ────────────────────────────────────────────────────────
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = process.env.SUPABASE_URL && SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, SUPABASE_KEY)
  : null;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Generar embedding de un texto
async function getEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000)
  });
  return response.data[0].embedding;
}
// ─── SEACE API ────────────────────────────────────────────────────────────────
const SEACE_API = 'https://prod4.seace.gob.pe:8086/api/oportunidades/codObjeto/codDepartamento/sintesisProceso/codTipoProceso';
const SEACE_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-PE,es;q=0.9',
  'Origin': 'https://prod4.seace.gob.pe',
  'Referer': 'https://prod4.seace.gob.pe/openegocio/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

const IBERO_KEYWORDS = [
  { keyword: 'MOBILIARIO',              business_line: 'General' },
  { keyword: 'MOBILIARIO ESCOLAR',      business_line: 'Educación' },
  { keyword: 'CARPETAS ESCOLARES',      business_line: 'Educación' },
  { keyword: 'MOBILIARIO HOSPITALARIO', business_line: 'Hospitalario' },
  { keyword: 'CAMA CLINICA',            business_line: 'Hospitalario' },
  { keyword: 'LOCKER',                  business_line: 'Metalmecánica' },
  { keyword: 'ARMARIO METALICO',        business_line: 'Metalmecánica' },
  { keyword: 'MOBILIARIO OFICINA',      business_line: 'Oficina' },
  { keyword: 'ESCRITORIO',              business_line: 'Oficina' },
  { keyword: 'MELAMINE',                business_line: 'Oficina' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function classify(text = '') {
  const t = text.toLowerCase();
  if (t.includes('hospital') || t.includes('clínic') || t.includes('clinic') || t.includes('salud') || t.includes('cama')) return 'Hospitalario';
  if (t.includes('escolar') || t.includes('carpeta') || t.includes('coleg') || t.includes('educac') || t.includes('ugel') || t.includes('institución educativa')) return 'Educación';
  if (t.includes('locker') || t.includes('casillero') || t.includes('metálic') || t.includes('metalico') || t.includes('armario')) return 'Metalmecánica';
  if (t.includes('melamine') || t.includes('oficina') || t.includes('escritorio') || t.includes('archivador')) return 'Oficina';
  return 'General';
}

function parseSeaceDate(raw) {
  if (!raw) return null;
  const s = clean(raw);
  if (s.includes('/')) {
    const [datePart] = s.split(' ');
    const parts = datePart.split('/');
    if (parts.length === 3) {
      const [d, m, y] = parts;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function normalizeSeaceItem(item, keyword) {
  const idProcedimiento = clean(item.idProcedimiento || '');
  const nomenclatura    = clean(item.nomenclatura || item.siglaProceso || '');
  const entidad         = clean(item.detEntidad || 'Entidad no identificada');
  const titulo          = clean(item.sintesisProceso || item.detItem || item.detCubso || '');
  const monto           = item.valorReferencial != null ? Number(item.valorReferencial) : null;
  const moneda          = clean(item.monedaProceso || 'Soles');
  const tipoProceso     = clean(item.detTipoProceso || item.detModalidadSeleccion || '');
  const objeto          = clean(item.detObjeto || '');
  const documentoBase   = clean(item.documentoBase || '');

  if (!titulo || titulo.length < 10) return null;
  if (!idProcedimiento && !nomenclatura) return null;

  const external_id = idProcedimiento || nomenclatura;
  const source_url = `https://prod4.seace.gob.pe/openegocio/#/ficha/idProceso/${idProcedimiento}`;
  const bases_url = documentoBase
    ? `https://prod1.seace.gob.pe/SeaceWeb-PRO/SdescargarArchivoAlfresco?fileCode=${documentoBase}`
    : null;

  return {
    external_id,
    nomenclature: nomenclatura,
    title: titulo,
    entity: entidad,
    region: 'No especificada',
    amount: monto,
    currency: moneda,
    process_type: tipoProceso,
    published_date: parseSeaceDate(item.fechaConvocatoria) || new Date().toISOString().slice(0, 10),
    closing_date: parseSeaceDate(item.fechaFin || item.fecFinParticipantes),
    submission_date: parseSeaceDate(item.fechaPresentacionPropuestas),
    business_line: classify(`${titulo} ${keyword}`),
    source_url,
    bases_url,
    documento_base_id: documentoBase || null,
    alert_sent: false
  };
}

async function fetchSeaceKeyword(keyword, page = 0, size = 100) {
  const encoded = encodeURIComponent(keyword.toUpperCase());
  const url = `${SEACE_API}/${page}/${size}/${encoded}/0`;
  console.log(`[SEACE] Buscando: "${keyword}"`);
  const response = await fetch(url, { headers: SEACE_HEADERS, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`SEACE HTTP ${response.status} para "${keyword}"`);
  const data = await response.json();
  const items = Array.isArray(data) ? data : (data.data || data.items || data.lista || []);
  return items.map(item => normalizeSeaceItem(item, keyword)).filter(Boolean);
}

async function searchSeaceAPI(customKeywords = null) {
  const keywords = customKeywords || IBERO_KEYWORDS;
  const all = [];
  const errors = [];
  const diagnostics = [];
  for (const { keyword } of keywords) {
    try {
      const items = await fetchSeaceKeyword(keyword);
      all.push(...items);
      diagnostics.push({ keyword, found: items.length, ok: true });
    } catch (e) {
      errors.push({ keyword, error: e.message });
      diagnostics.push({ keyword, found: 0, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 600));
  }
  const byId = new Map();
  all.forEach(o => byId.set(o.external_id, o));
  return { items: [...byId.values()], errors, diagnostics };
}

// ─── Base de datos ─────────────────────────────────────────────────────────────
const demo = { keywords: [], vendors: [], opportunities: [] };

async function table(name) {
  if (!supabase) return demo[name] || [];
  const { data, error } = await supabase.from(name).select('*');
  if (error) throw error;
  return data || [];
}

async function upsertOpportunities(items) {
  if (!items?.length) return table('opportunities');
  if (!supabase) {
    const map = new Map(demo.opportunities.map(o => [o.external_id, o]));
    items.forEach(o => map.set(o.external_id, o));
    demo.opportunities = [...map.values()].slice(0, 500);
    return demo.opportunities;
  }
  const { error } = await supabase.from('opportunities').upsert(items, { onConflict: 'external_id' });
  if (error) throw error;
  return table('opportunities');
}

// ─── IA ────────────────────────────────────────────────────────────────────────
async function callAI(prompt) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3
  });
  return response.choices[0].message.content;
}

async function analyzeOpportunity(opportunity) {
  const prompt = `
Analiza esta oportunidad de contratación pública para Grupo Ibero Perú (fabricante de mobiliario escolar, hospitalario, de oficina y metálico):
Título: ${opportunity.title || ''}
Entidad: ${opportunity.entity || ''}
Tipo: ${opportunity.process_type || ''}
Monto: ${opportunity.amount ? `S/ ${Number(opportunity.amount).toLocaleString('es-PE')}` : 'No especificado'}
Línea: ${opportunity.business_line || ''}
Cierre: ${opportunity.closing_date || 'No especificado'}
Responde ÚNICAMENTE con JSON válido, sin texto adicional. Los valores numéricos son ejemplos, debes calcular los reales:
{
  "summary": "resumen ejecutivo en 2 oraciones",
  "business_line": "línea de negocio más probable",
  "fit_for_ibero": "explicación de adecuación",
  "score": 75,
  "decision": "PARTICIPAR|REVISAR|DESCARTAR",
  "recommendation": "recomendación breve",
  "criteria": [
    {"name":"Coincidencia línea de negocio","score":25,"max":30},
    {"name":"Experiencia sectorial","score":15,"max":20},
    {"name":"Logística y región","score":12,"max":15},
    {"name":"Información disponible","score":10,"max":15},
    {"name":"Capacidad técnica","score":8,"max":10},
    {"name":"Complejidad del proceso","score":5,"max":10}
  ],
  "risks": ["riesgo identificado 1","riesgo identificado 2","riesgo identificado 3"],
  "actions": ["acción recomendada 1","acción recomendada 2","acción recomendada 3"]
}
IMPORTANTE: Reemplaza todos los números con valores reales del análisis. El score total debe ser la suma de todos los criteria.score.
`;
  const raw = await callAI(prompt);
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
console.log('AI score:', parsed.score, 'criteria:', JSON.stringify(parsed.criteria));
return parsed;
}

// ─── Email ─────────────────────────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://ibero-seace-alertas.onrender.com';

function renderEmail(opportunities) {
  const rows = opportunities.slice(0, 15).map(o => {
    const link = `${FRONTEND_URL}/oportunidad.html?id=${encodeURIComponent(o.id)}`;
    const monto = o.amount ? `S/ ${Number(o.amount).toLocaleString('es-PE')}` : 'No especificado';
    const cierre = o.closing_date || o.submission_date || 'Ver detalle';
    const badge = { 'Educación': '#2563eb', 'Hospitalario': '#dc2626', 'Metalmecánica': '#7c3aed', 'Oficina': '#059669', 'General': '#d97706' }[o.business_line] || '#6b7280';
    return `
<div style="border:1px solid #e7eaf0;border-radius:12px;padding:16px;margin-bottom:12px;background:white;">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
    <span style="background:${badge};color:white;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;">${o.business_line || 'General'}</span>
    <span style="color:#6b7280;font-size:12px;">${o.nomenclature || o.external_id || ''}</span>
  </div>
  <h3 style="margin:0 0 8px;font-size:15px;color:#111827;">${o.title || 'Oportunidad SEACE'}</h3>
  <p style="margin:2px 0;color:#4b5563;font-size:13px;"><b>Entidad:</b> ${o.entity || '-'}</p>
  <p style="margin:2px 0;color:#4b5563;font-size:13px;"><b>Monto:</b> ${monto}</p>
  <p style="margin:2px 0;color:#4b5563;font-size:13px;"><b>Cierre:</b> ${cierre}</p>
  <a href="${link}" style="display:inline-block;margin-top:10px;background:#1d4ed8;color:white;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">Analizar con IA →</a>
</div>`;
  }).join('');
  return `
<div style="font-family:Arial,sans-serif;background:#f6f7fb;padding:20px;max-width:680px;margin:0 auto;">
  <div style="background:#1d4ed8;color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="margin:0;font-size:22px;">🎯 Radar SEACE — Grupo Ibero Perú</h1>
    <p style="margin:6px 0 0;opacity:0.85;">${opportunities.length} oportunidades detectadas hoy</p>
  </div>
  <div style="padding:16px 0;">${rows}</div>
  <p style="text-align:center;color:#9ca3af;font-size:12px;">Generado automáticamente · Radar SEACE v${VERSION}</p>
</div>`;
}

async function sendDigest() {
  const opportunities = await table('opportunities');
  const vendors = await table('vendors');
  if (!process.env.SMTP_HOST) return { ok: false, message: 'SMTP no configurado' };
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  const recipients = vendors.map(v => v.email).filter(Boolean).join(',');
  if (!recipients) return { ok: false, message: 'No hay vendedores configurados' };
  await transport.verify();
  const info = await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: recipients,
    subject: `🎯 ${opportunities.length} oportunidades SEACE — Radar Ibero`,
    html: renderEmail(opportunities)
  });
  const ids = opportunities.map(o => o.id).filter(Boolean);
  if (ids.length && supabase) await supabase.from('opportunities').update({ alert_sent: true }).in('id', ids);
  return { ok: true, recipients, messageId: info.messageId || null };
}

// ─── Rutas ─────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ ok: true, app: 'SEACE Radar — Grupo Ibero Perú', mode: MODE, version: VERSION }));

app.get('/api/health', (_, res) => res.json({ ok: true, supabase: !!supabase, openai: !!process.env.OPENAI_API_KEY, smtp: !!process.env.SMTP_HOST, mode: MODE, version: VERSION }));

app.get('/api/bootstrap', async (_, res, next) => {
  try { res.json({ keywords: await table('keywords'), vendors: await table('vendors'), opportunities: await table('opportunities') }); }
  catch (e) { next(e); }
});

app.get('/api/jobs/search-now', async (req, res, next) => {
  try {
    const keyword = req.query.keyword ? String(req.query.keyword) : null;
    const customKeywords = keyword ? [{ keyword: keyword.toUpperCase(), business_line: 'General' }] : null;
    const result = await searchSeaceAPI(customKeywords);
    const saved = await upsertOpportunities(result.items || []);
    res.json({ ok: true, version: VERSION, found: result.items.length, saved_total: Array.isArray(saved) ? saved.length : null, errors: result.errors || [], diagnostics: result.diagnostics || [] });
  } catch (e) { next(e); }
});

app.post('/api/jobs/search', async (_, res, next) => {
  try {
    const result = await searchSeaceAPI();
    const opportunities = await upsertOpportunities(result.items || []);
    res.json({ ok: true, found: result.items.length, errors: result.errors, diagnostics: result.diagnostics, opportunities });
  } catch (e) { next(e); }
});

app.get('/api/jobs/send-digest', async (_, res, next) => { try { res.json(await sendDigest()); } catch (e) { next(e); } });
app.post('/api/jobs/send-digest', async (_, res, next) => { try { res.json(await sendDigest()); } catch (e) { next(e); } });

app.get('/api/opportunities/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const opportunities = await table('opportunities');
    const opportunity = opportunities.find(o => String(o.id) === String(id));
    if (!opportunity) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });

    let analysis = null;
    if (!opportunity.ai_summary) {
      try {
        analysis = await analyzeOpportunity(opportunity);
        if (supabase && analysis) {
         await supabase.from('opportunities').update({
  ai_summary: analysis.summary,
  ai_score: analysis.score,
  ai_recommendation: analysis.decision,
  ai_criteria: analysis.criteria || [],
  ai_risks: analysis.risks || [],
  ai_actions: analysis.actions || []
}).eq('id', id);
        }
      } catch (e) { console.error('Error IA:', e.message); }
    } else {
  analysis = {
    summary: opportunity.ai_summary,
    score: opportunity.ai_score,
    decision: opportunity.ai_recommendation,
    criteria: opportunity.ai_criteria || [],
    risks: opportunity.ai_risks || [],
    actions: opportunity.ai_actions || []
  };
}

    res.json({
      ok: true,
      opportunity: {
        ...opportunity,
        ai_summary: analysis?.summary || null,
        ai_score: analysis?.score || null,
        ai_decision: analysis?.decision || null,
        ai_recommendation: analysis?.recommendation || analysis?.decision || null,
        ai_risks: analysis?.risks || [],
        ai_actions: analysis?.actions || [],
        ai_criteria: analysis?.criteria || []
      }
    });
  } catch (e) { next(e); }
});

app.post('/api/opportunities/:id/ask', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { question } = req.body;
    if (!question?.trim()) return res.status(400).json({ ok: false, error: 'La pregunta es requerida' });

    const opportunities = await table('opportunities');
    const opportunity = opportunities.find(o => String(o.id) === String(id));
    if (!opportunity) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });

    // RAG: buscar chunks relevantes según la pregunta
let docsText = 'No hay documentos del expediente cargados.';
if (supabase) {
  const questionEmbedding = await getEmbedding(question);
  const { data: chunks } = await supabase.rpc('match_chunks', {
    query_embedding: questionEmbedding,
    match_opportunity_id: id,
    match_count: 6
  });
  if (chunks && chunks.length > 0) {
    docsText = 'FRAGMENTOS RELEVANTES DEL EXPEDIENTE:\n\n' +
      chunks.map((c, i) => `[Fragmento ${i+1}]\n${c.content}`).join('\n\n---\n\n');
  }
}
    const prompt = `Eres un asistente comercial experto en licitaciones públicas para Grupo Ibero Perú (fabrica mobiliario escolar, hospitalario, de oficina y metálico).

OPORTUNIDAD:
Título: ${opportunity.title || ''}
Entidad: ${opportunity.entity || ''}
Nomenclatura: ${opportunity.nomenclature || opportunity.external_id || ''}
Monto: ${opportunity.amount ? `S/ ${Number(opportunity.amount).toLocaleString('es-PE')}` : 'No especificado'}
Tipo: ${opportunity.process_type || ''}
Cierre: ${opportunity.closing_date || 'No especificado'}
Línea: ${opportunity.business_line || ''}

DOCUMENTOS DEL EXPEDIENTE:
${docsText}

PREGUNTA: ${question}

Responde de forma clara, práctica y orientada a decisión comercial. Si hay documentos cargados, úsalos para responder con precisión.`;

    const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: prompt }],
  temperature: 0.3,
  max_tokens: 2000
});
const answer = response.choices[0].message.content;
    if (supabase) { try { await supabase.from('ai_chats').insert({ opportunity_id: id, question, answer }); } catch(e) {} }
    res.json({ ok: true, answer });
  } catch (e) { next(e); }
});

app.get('/api/opportunities/:id/documents', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!supabase) return res.json({ ok: true, documents: [] });
    const { data, error } = await supabase.from('opportunity_documents').select('*').eq('opportunity_id', id);
    if (error) throw error;
    res.json({ ok: true, documents: data || [] });
  } catch (e) { next(e); }
});

// ─── Subida de documentos PDF con extracción de texto ────────────────────────
app.post('/api/opportunities/:id/documents', upload.single('file'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { document_type } = req.body;

    if (!req.file) return res.status(400).json({ ok: false, error: 'No se recibió ningún archivo' });
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });

    // Extraer texto del PDF
    let content = '';
    if (req.file.mimetype === 'application/pdf') {
      try {
        const parsed = await pdfParse(req.file.buffer);
        content = parsed.text;
        console.log(`PDF extraído: ${content.length} caracteres`);
      } catch (e) {
        console.error('Error extrayendo PDF:', e.message);
        content = 'No se pudo extraer el texto del PDF.';
      }
    }

    // Subir archivo a Supabase Storage
    const fileName = `${id}/${Date.now()}_${req.file.originalname}`;
    const { error: uploadError } = await supabase.storage
      .from('opportunity-documents')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) console.error('Error Storage:', uploadError.message);

    // Obtener URL pública
    const { data: urlData } = supabase.storage.from('opportunity-documents').getPublicUrl(fileName);

    // Guardar en tabla opportunity_documents
    const { data, error } = await supabase.from('opportunity_documents').insert({
      opportunity_id: id,
      document_type: document_type || 'otro',
      file_name: req.file.originalname,
      file_url: urlData?.publicUrl || null,
      content,
      file_size: req.file.size
    }).select().single();

    if (error) throw error;
// Dividir en chunks para RAG
if (content.length > 3000) {
  const chunkSize = 4000;
const chunks = [];
const seen = new Set();
for (let i = 0; i < content.length; i += chunkSize) {
  const text = content.slice(i, i + chunkSize).trim();
  const key = text.slice(0, 100);
  if (text.length > 100 && !seen.has(key)) {
    seen.add(key);
    chunks.push({
      document_id: data.id,
      opportunity_id: id,
      chunk_index: chunks.length,
      content: text
    });
  }
}
 try {
  for (const chunk of chunks) {
    chunk.embedding = await getEmbedding(chunk.content);
  }
  await supabase.from('document_chunks').insert(chunks);
  console.log('Chunks con embeddings creados: ' + chunks.length);
} catch(e) { console.error('Chunks error:', e.message); }
  console.log('Chunks creados: ' + chunks.length);
}
    res.json({ ok: true, document: data, content_length: content.length });
  } catch (e) { next(e); }
});
// ─── Descarga automática de documentos desde SEACE ───────────────────────────
app.post('/api/opportunities/:id/fetch-document', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { document_url, document_type } = req.body;

    if (!document_url) return res.status(400).json({ ok: false, error: 'URL requerida' });
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });

    // Descargar PDF desde SEACE
    console.log(`Descargando: ${document_url}`);
    const response = await fetch(document_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://prod4.seace.gob.pe/'
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) throw new Error(`SEACE respondió ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'application/pdf';
    const fileName = `${id}/${document_type || 'documento'}_${Date.now()}.pdf`;

    // Extraer texto del PDF
    let content = '';
    try {
      const parsed = await pdfParse(buffer);
      content = parsed;
      console.log(`Texto extraído: ${content.length} caracteres`);
    } catch(e) {
      console.error('Error PDF:', e.message);
      content = 'No se pudo extraer el texto.';
    }

    // Subir a Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('opportunity-documents')
      .upload(fileName, buffer, { contentType });

    if (uploadError) console.error('Storage error:', uploadError.message);

    const { data: urlData } = supabase.storage
      .from('opportunity-documents')
      .getPublicUrl(fileName);

    // Guardar en tabla
    const { data, error } = await supabase.from('opportunity_documents').insert({
      opportunity_id: id,
      document_type: document_type || 'bases',
      file_name: fileName.split('/').pop(),
      file_url: urlData?.publicUrl || null,
      content,
      file_size: buffer.length
    }).select().single();

    if (error) throw error;
// Dividir en chunks para RAG
if (content.length > 3000) {
  const chunkSize = 4000;
const chunks = [];
const seen = new Set();
for (let i = 0; i < content.length; i += chunkSize) {
  const text = content.slice(i, i + chunkSize).trim();
  const key = text.slice(0, 100);
  if (text.length > 100 && !seen.has(key)) {
    seen.add(key);
    chunks.push({
      document_id: data.id,
      opportunity_id: id,
      chunk_index: chunks.length,
      content: text
    });
  }
}
 try {
  for (const chunk of chunks) {
    chunk.embedding = await getEmbedding(chunk.content);
  }
  await supabase.from('document_chunks').insert(chunks);
  console.log('Chunks con embeddings creados: ' + chunks.length);
} catch(e) { console.error('Chunks error:', e.message); }
  console.log('Chunks creados: ' + chunks.length);
}
    res.json({ ok: true, document: data, content_length: content.length });
  } catch (e) { next(e); }
});
app.get('/api/ai-test', async (_, res, next) => {
  try { res.json({ ok: true, result: await callAI('Resume en una frase qué es una licitación pública en Perú.') }); }
  catch (e) { next(e); }
});
// ─── Admin endpoints ──────────────────────────────────────────────────────────
app.post('/api/admin/vendors', async (req, res, next) => {
  try {
    const { name, email, line } = req.body;
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { data, error } = await supabase.from('vendors').insert({ name, email, line }).select().single();
    if (error) throw error;
    res.json({ ok: true, vendor: data });
  } catch(e) { next(e); }
});

app.delete('/api/admin/vendors/:id', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { error } = await supabase.from('vendors').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { next(e); }
});

app.post('/api/admin/keywords', async (req, res, next) => {
  try {
    const { keyword, business_line, active } = req.body;
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { data, error } = await supabase.from('keywords').insert({ keyword, business_line, active }).select().single();
    if (error) throw error;
    res.json({ ok: true, keyword: data });
  } catch(e) { next(e); }
});
app.patch('/api/admin/keywords/:id', async (req, res, next) => {
  try {
    const { active } = req.body;
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { error } = await supabase.from('keywords').update({ active }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { next(e); }
});
app.delete('/api/admin/keywords/:id', async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase no configurado' });
    const { error } = await supabase.from('keywords').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { next(e); }
});
app.use((err, _, res, __) => {
  console.error('API error:', err);
  res.status(500).json({ error: err.message, version: VERSION });
});

// ─── Cron ──────────────────────────────────────────────────────────────────────
const schedule = process.env.CRON_SCHEDULE || '0 8,17 * * *';
cron.schedule(schedule, async () => {
  try {
    console.log('[CRON] Iniciando búsqueda SEACE...');
    const result = await searchSeaceAPI();
    await upsertOpportunities(result.items || []);
    await sendDigest();
    console.log(`[CRON] Completado: ${result.items.length} oportunidades`);
  } catch (e) { console.error('[CRON] Error:', e.message); }
});

app.listen(process.env.PORT || 3000, () =>
  console.log(`SEACE Radar v${VERSION} corriendo en puerto ${process.env.PORT || 3000}`)
);
