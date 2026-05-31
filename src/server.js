import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import OpenAI from 'openai';

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL?.split(',') || '*' }));
app.use(express.json());
app.use(express.static('src/public'));

const VERSION = '1.0.0';
const MODE = 'seace-api-direct';

// ─── Clientes externos ────────────────────────────────────────────────────────
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = process.env.SUPABASE_URL && SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, SUPABASE_KEY)
  : null;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── SEACE API ────────────────────────────────────────────────────────────────
// API interna descubierta via DevTools en prod4.seace.gob.pe/openegocio
// Estructura: /api/oportunidades/codObjeto/codDepartamento/sintesisProceso/codTipoProceso/{page}/{size}/{keyword}/{ubigeo}
const SEACE_API = 'https://prod4.seace.gob.pe:8086/api/oportunidades/codObjeto/codDepartamento/sintesisProceso/codTipoProceso';
const SEACE_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-PE,es;q=0.9',
  'Origin': 'https://prod4.seace.gob.pe',
  'Referer': 'https://prod4.seace.gob.pe/openegocio/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

// Keywords de búsqueda para Grupo Ibero Perú
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

// Convierte fecha SEACE "DD/MM/YYYY HH:MM:SS" → "YYYY-MM-DD"
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
  // ya viene en formato ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

// Normaliza un item crudo de la API SEACE al esquema de nuestra BD
function normalizeSeaceItem(item, keyword) {
  // Campos confirmados via DevTools:
  const idProcedimiento = clean(item.idProcedimiento || '');
  const nomenclatura    = clean(item.nomenclatura || item.siglaProceso || '');
  const entidad         = clean(item.detEntidad || 'Entidad no identificada');
  const titulo          = clean(item.sintesisProceso || item.detItem || item.detCubso || '');
  const monto           = item.valorReferencial != null ? Number(item.valorReferencial) : null;
  const moneda          = clean(item.monedaProceso || 'Soles');
  const tipoProceso     = clean(item.detTipoProceso || item.detModalidadSeleccion || '');
  const objeto          = clean(item.detObjeto || '');
  const documentoBase   = clean(item.documentoBase || '');

  const fechaConvocatoria      = parseSeaceDate(item.fechaConvocatoria);
  const fechaFin               = parseSeaceDate(item.fechaFin || item.fecFinParticipantes);
  const fechaInicio            = parseSeaceDate(item.fechaInicio || item.fecInicioParticipantes);
  const fechaPresentacion      = parseSeaceDate(item.fechaPresentacionPropuestas);

  // Filtrar registros sin datos útiles
  if (!titulo || titulo.length < 10) return null;
  if (!idProcedimiento && !nomenclatura) return null;

  const external_id = idProcedimiento || nomenclatura;

  // URL de detalle en OpenNegocio
  const source_url = item.urlProceso ||
    `https://prod4.seace.gob.pe/openegocio/#/ficha-proceso/${idProcedimiento}`;

  // URL de bases integradas (si existe documentoBase UUID)
  const bases_url = documentoBase
    ? `https://prod4.seace.gob.pe:8086/api/documentos/${documentoBase}`
    : null;

  return {
    external_id,
    nomenclature: nomenclatura,
    title: titulo,
    entity: entidad,
    region: 'No especificada', // la API no devuelve departamento en este endpoint
    amount: monto,
    currency: moneda,
    process_type: tipoProceso,
    object_type: objeto,
    published_date: fechaConvocatoria || new Date().toISOString().slice(0, 10),
    start_date: fechaInicio,
    closing_date: fechaFin,
    submission_date: fechaPresentacion,
    business_line: classify(`${titulo} ${keyword}`),
    status: 'Nuevo',
    source_url,
    bases_url,
    documento_base_id: documentoBase || null,
    alert_sent: false
  };
}

// ─── Búsqueda en SEACE API ────────────────────────────────────────────────────
async function fetchSeaceKeyword(keyword, page = 0, size = 100) {
  const encoded = encodeURIComponent(keyword.toUpperCase());
  const url = `${SEACE_API}/${page}/${size}/${encoded}/0`;

  console.log(`[SEACE] Buscando: "${keyword}" → ${url}`);

  const response = await fetch(url, {
    headers: SEACE_HEADERS,
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok) {
    throw new Error(`SEACE respondió HTTP ${response.status} para "${keyword}"`);
  }

  const data = await response.json();
  const items = Array.isArray(data) ? data : (data.data || data.items || data.lista || []);

  console.log(`[SEACE] "${keyword}": ${items.length} registros crudos`);

  const normalized = items.map(item => normalizeSeaceItem(item, keyword)).filter(Boolean);
  console.log(`[SEACE] "${keyword}": ${normalized.length} oportunidades normalizadas`);

  return normalized;
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
      console.error(`[SEACE] Error en "${keyword}":`, e.message);
    }
    // Pausa entre requests para no saturar el servidor
    await new Promise(r => setTimeout(r, 600));
  }

  // Deduplicar por external_id
  const byId = new Map();
  all.forEach(o => byId.set(o.external_id, o));

  const unique = [...byId.values()];
  console.log(`[SEACE] Total único: ${unique.length} oportunidades`);

  return { items: unique, errors, diagnostics };
}

// ─── Base de datos ─────────────────────────────────────────────────────────────
const demo = {
  keywords: IBERO_KEYWORDS.map(k => ({ keyword: k.keyword, active: true, business_line: k.business_line })),
  vendors: [
    { name: 'Vendedor Educación',    email: 'educacion@grupoibero.com',    line: 'Educación' },
    { name: 'Vendedor Hospitalario', email: 'hospitalario@grupoibero.com', line: 'Hospitalario' }
  ],
  opportunities: []
};

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
  const { error } = await supabase
    .from('opportunities')
    .upsert(items, { onConflict: 'external_id' });
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
Objeto: ${opportunity.object_type || ''}
Monto: ${opportunity.amount ? `S/ ${Number(opportunity.amount).toLocaleString('es-PE')}` : 'No especificado'}
Línea: ${opportunity.business_line || ''}
Cierre: ${opportunity.closing_date || 'No especificado'}

Responde ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "summary": "resumen ejecutivo en 2 oraciones",
  "business_line": "línea de negocio más probable",
  "fit_for_ibero": "explicación de adecuación",
  "score": 0,
  "decision": "PARTICIPAR|REVISAR|DESCARTAR",
  "recommendation": "recomendación breve",
  "criteria": [
    {"name":"Coincidencia línea de negocio","score":0,"max":30},
    {"name":"Experiencia sectorial","score":0,"max":20},
    {"name":"Logística y región","score":0,"max":15},
    {"name":"Información disponible","score":0,"max":15},
    {"name":"Capacidad técnica","score":0,"max":10},
    {"name":"Complejidad del proceso","score":0,"max":10}
  ],
  "risks": ["riesgo 1","riesgo 2","riesgo 3"],
  "actions": ["acción 1","acción 2","acción 3"]
}
La suma de criteria.score debe ser igual a score.`;

  const raw = await callAI(prompt);
  const clean_json = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean_json);
}

// ─── Email ─────────────────────────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://ibero-seace-alertas.onrender.com';

function renderEmail(opportunities) {
  const rows = opportunities.slice(0, 15).map(o => {
    const link = `${FRONTEND_URL}/oportunidad.html?id=${encodeURIComponent(o.id)}`;
    const monto = o.amount ? `S/ ${Number(o.amount).toLocaleString('es-PE')}` : 'No especificado';
    const cierre = o.closing_date || o.submission_date || 'Ver detalle';
    const badge = {
      'Educación':     '#2563eb',
      'Hospitalario':  '#dc2626',
      'Metalmecánica': '#7c3aed',
      'Oficina':       '#059669',
      'General':       '#d97706'
    }[o.business_line] || '#6b7280';

    return `
<div style="border:1px solid #e7eaf0;border-radius:12px;padding:16px;margin-bottom:12px;background:white;">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
    <span style="background:${badge};color:white;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;">${o.business_line || 'General'}</span>
    <span style="color:#6b7280;font-size:12px;">${o.nomenclature || o.external_id || ''}</span>
  </div>
  <h3 style="margin:0 0 8px;font-size:15px;color:#111827;">${o.title || 'Oportunidad SEACE'}</h3>
  <p style="margin:2px 0;color:#4b5563;font-size:13px;"><b>Entidad:</b> ${o.entity || '-'}</p>
  <p style="margin:2px 0;color:#4b5563;font-size:13px;"><b>Monto:</b> ${monto}</p>
  <p style="margin:2px 0;color:#4b5563;font-size:13px;"><b>Cierre participantes:</b> ${cierre}</p>
  <a href="${link}" style="display:inline-block;margin-top:10px;background:#1d4ed8;color:white;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">
    Analizar con IA →
  </a>
</div>`;
  }).join('');

  return `
<div style="font-family:Arial,sans-serif;background:#f6f7fb;padding:20px;max-width:680px;margin:0 auto;">
  <div style="background:#1d4ed8;color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="margin:0;font-size:22px;">🎯 Radar SEACE — Grupo Ibero Perú</h1>
    <p style="margin:6px 0 0;opacity:0.85;">${opportunities.length} oportunidades detectadas hoy</p>
  </div>
  <div style="padding:16px 0;">
    ${rows}
  </div>
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
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
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

  console.log('Digest enviado:', info.messageId || info.response);

  // Marcar como enviadas
  const ids = opportunities.map(o => o.id).filter(Boolean);
  if (ids.length && supabase) {
    await supabase.from('opportunities').update({ alert_sent: true }).in('id', ids);
  }

  return { ok: true, recipients, messageId: info.messageId || null };
}

// ─── Rutas ─────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({
  ok: true,
  app: 'SEACE Radar — Grupo Ibero Perú',
  mode: MODE,
  version: VERSION,
  endpoints: ['/api/health', '/api/bootstrap', '/api/jobs/search-now', '/api/jobs/send-digest']
}));

app.get('/api/health', (_, res) => res.json({
  ok: true,
  supabase: !!supabase,
  openai: !!process.env.OPENAI_API_KEY,
  smtp: !!process.env.SMTP_HOST,
  mode: MODE,
  version: VERSION
}));

app.get('/api/bootstrap', async (_, res, next) => {
  try {
    res.json({
      keywords: await table('keywords'),
      vendors: await table('vendors'),
      opportunities: await table('opportunities')
    });
  } catch (e) { next(e); }
});

// Búsqueda manual (trigger inmediato)
app.get('/api/jobs/search-now', async (req, res, next) => {
  try {
    const keyword = req.query.keyword ? String(req.query.keyword) : null;
    const customKeywords = keyword
      ? [{ keyword: keyword.toUpperCase(), business_line: 'General' }]
      : null;

    const result = await searchSeaceAPI(customKeywords);
    const saved = await upsertOpportunities(result.items || []);

    res.json({
      ok: true,
      version: VERSION,
      found: result.items.length,
      saved_total: Array.isArray(saved) ? saved.length : null,
      errors: result.errors || [],
      diagnostics: result.diagnostics || [],
      items: result.items || []
    });
  } catch (e) { next(e); }
});

app.post('/api/jobs/search', async (_, res, next) => {
  try {
    const result = await searchSeaceAPI();
    const opportunities = await upsertOpportunities(result.items || []);
    res.json({ ok: true, found: result.items.length, errors: result.errors, diagnostics: result.diagnostics, opportunities });
  } catch (e) { next(e); }
});

app.get('/api/jobs/send-digest', async (_, res, next) => {
  try { res.json(await sendDigest()); } catch (e) { next(e); }
});

app.post('/api/jobs/send-digest', async (_, res, next) => {
  try { res.json(await sendDigest()); } catch (e) { next(e); }
});

// Detalle de oportunidad + análisis IA
app.get('/api/opportunities/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const opportunities = await table('opportunities');
    const opportunity = opportunities.find(o => String(o.id) === String(id));

    if (!opportunity) {
      return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });
    }

    let analysis = null;
    if (!opportunity.ai_summary) {
      try {
        analysis = await analyzeOpportunity(opportunity);
        // Guardar análisis en Supabase para no regenerar
        if (supabase && analysis) {
          await supabase.from('opportunities').update({
            ai_summary: analysis.summary,
            ai_score: analysis.score,
            ai_recommendation: analysis.decision
          }).eq('id', id);
        }
      } catch (e) {
        console.error('Error analizando con IA:', e.message);
      }
    } else {
      analysis = {
        summary: opportunity.ai_summary,
        score: opportunity.ai_score,
        decision: opportunity.ai_recommendation
      };
    }

    res.json({
      ok: true,
      opportunity: {
        ...opportunity,
        ai_summary:        analysis?.summary || null,
        ai_score:          analysis?.score || null,
        ai_decision:       analysis?.decision || null,
        ai_recommendation: analysis?.recommendation || analysis?.decision || null,
        ai_risks:          analysis?.risks || [],
        ai_actions:        analysis?.actions || [],
        ai_criteria:       analysis?.criteria || []
      }
    });
  } catch (e) { next(e); }
});

// Chat IA por oportunidad
app.post('/api/opportunities/:id/ask', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { question } = req.body;

    if (!question?.trim()) {
      return res.status(400).json({ ok: false, error: 'La pregunta es requerida' });
    }

    const opportunities = await table('opportunities');
    const opportunity = opportunities.find(o => String(o.id) === String(id));
    if (!opportunity) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });

    const documents = supabase
      ? (await supabase.from('opportunity_documents').select('*').eq('opportunity_id', id)).data || []
      : [];

    const docsText = documents.length
      ? documents.map(d => `DOCUMENTO: ${d.title || 'Sin título'}\n${d.content || ''}`).join('\n\n---\n\n')
      : 'No hay documentos del expediente cargados.';

    const prompt = `
Eres un asistente comercial experto en licitaciones públicas para Grupo Ibero Perú (fabrica mobiliario escolar, hospitalario, de oficina y metálico).

OPORTUNIDAD:
Título: ${opportunity.title || ''}
Entidad: ${opportunity.entity || ''}
Nomenclatura: ${opportunity.nomenclature || opportunity.external_id || ''}
Monto: ${opportunity.amount ? `S/ ${Number(opportunity.amount).toLocaleString('es-PE')}` : 'No especificado'}
Tipo: ${opportunity.process_type || ''}
Cierre: ${opportunity.closing_date || opportunity.submission_date || 'No especificado'}
Línea: ${opportunity.business_line || ''}

DOCUMENTOS:
${docsText}

PREGUNTA: ${question}

Responde de forma clara, práctica y orientada a decisión comercial.`;

    const answer = await callAI(prompt);

    if (supabase) {
      await supabase.from('ai_chats').insert({ opportunity_id: id, question, answer });
    }

    res.json({ ok: true, answer });
  } catch (e) { next(e); }
});

// Documentos de oportunidad
app.get('/api/opportunities/:id/documents', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!supabase) return res.json({ ok: true, documents: [] });
    const { data, error } = await supabase.from('opportunity_documents').select('*').eq('opportunity_id', id);
    if (error) throw error;
    res.json({ ok: true, documents: data || [] });
  } catch (e) { next(e); }
});

// Subida de documentos (pendiente implementar storage)
app.post('/api/opportunities/:id/documents', async (req, res) => {
  res.status(501).json({ ok: false, error: 'Subida de documentos pendiente — próxima versión' });
});

// Test de IA
app.get('/api/ai-test', async (_, res, next) => {
  try {
    const result = await callAI('Resume en una frase qué es una licitación pública en Perú.');
    res.json({ ok: true, result });
  } catch (e) { next(e); }
});

// Error handler
app.use((err, _, res, __) => {
  console.error('API error:', err);
  res.status(500).json({ error: err.message, version: VERSION });
});

// ─── Cron ──────────────────────────────────────────────────────────────────────
// Por defecto: 8am y 5pm cada día
const schedule = process.env.CRON_SCHEDULE || '0 8,17 * * *';
cron.schedule(schedule, async () => {
  try {
    console.log('[CRON] Iniciando búsqueda SEACE...');
    const result = await searchSeaceAPI();
    await upsertOpportunities(result.items || []);
    await sendDigest();
    console.log(`[CRON] Completado: ${result.items.length} oportunidades`);
  } catch (e) {
    console.error('[CRON] Error:', e.message);
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log(`SEACE Radar v${VERSION} corriendo en puerto ${process.env.PORT || 3000}`)
);
