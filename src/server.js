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

const VERSION = '0.10.0';
const MODE = 'opennegocio-safe-v2';

const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = process.env.SUPABASE_URL && SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, SUPABASE_KEY)
  : null;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const SEACE_URLS = {
  openNegocioBase: 'https://prod4.seace.gob.pe/openegocio/',
  openNegocioBuscar: 'https://prod4.seace.gob.pe/openegocio/#/buscar',
  contratosMenores: 'https://prod6.seace.gob.pe/buscador-publico/contrataciones'
};

async function testAI() {
  const response = await openai.responses.create({
    model: "gpt-5-mini",
    input: "Resume en una frase qué es una licitación pública."
  });

  return response.output_text;
}
async function analyzeOpportunity(opportunity) {

  const prompt = `
Analiza la siguiente oportunidad de contratación pública:

Título: ${opportunity.title || ''}
Entidad: ${opportunity.entity || ''}
Descripción: ${opportunity.description || ''}
Línea: ${opportunity.business_line || ''}

Devuelve únicamente JSON con este formato:
Considera que Grupo Ibero Perú fabrica:

- mobiliario escolar
- mobiliario de oficina
- mobiliario hospitalario
- mobiliario metálico

La recomendación debe ser únicamente:

"PARTICIPAR"
"REVISAR"
"NO PARTICIPAR"

Genera 3 riesgos concretos y 3 acciones concretas.
La suma de los criterios debe ser igual al score.
decision debe ser: "PARTICIPAR", "REVISAR" o "DESCARTAR".
risks debe ser un arreglo de riesgos.
actions debe ser un arreglo de acciones recomendadas.

{
  "summary":"",
  "business_line":"",
  "fit_for_ibero":"",
  "score":0,
  "recommendation":"",
  "decision":"",
  "criteria":[
    {
      "name":"Coincidencia línea de negocio",
      "score":0,
      "max":30
    },
    {
      "name":"Experiencia sectorial",
      "score":0,
      "max":20
    },
    {
      "name":"Logística",
      "score":0,
      "max":15
    },
    {
      "name":"Información disponible",
      "score":0,
      "max":15
    },
    {
      "name":"Capacidad técnica",
      "score":0,
      "max":10
    },
    {
      "name":"Complejidad",
      "score":0,
      "max":10
    }
  ],
  "risks":[],
  "actions":[]
}
`;

  const response = await openai.responses.create({
    model: "gpt-5-mini",
    input: prompt
  });

  return JSON.parse(response.output_text);
}
const demo = {
  keywords: [
    { keyword:'mobiliario escolar', active:true, business_line:'Educación' },
    { keyword:'carpetas escolares', active:true, business_line:'Educación' },
    { keyword:'lockers', active:true, business_line:'Metalmecánica' },
    { keyword:'armarios metálicos', active:true, business_line:'Metalmecánica' },
    { keyword:'mobiliario hospitalario', active:true, business_line:'Hospitalario' },
    { keyword:'melamine', active:true, business_line:'Oficina' }
  ],
  vendors: [
    { name:'Vendedor Educación', email:'educacion@grupoibero.com', line:'Educación' },
    { name:'Vendedor Hospitalario', email:'hospitalario@grupoibero.com', line:'Hospitalario' }
  ],
  opportunities: []
};

async function table(name){
  if(!supabase) return demo[name] || [];

  const { data, error } = await supabase
    .from(name)
    .select('*');

  if(error) throw error;

  return data || [];
}
function clean(value){
  return String(value ?? '').replace(/\s+/g,' ').trim();
}

function classify(text=''){
  const t = text.toLowerCase();
  if(t.includes('hospital') || t.includes('clínic') || t.includes('clinic') || t.includes('salud') || t.includes('cama clínica')) return 'Hospitalario';
  if(t.includes('escolar') || t.includes('carpeta') || t.includes('coleg') || t.includes('institución educativa') || t.includes('educación')) return 'Educación';
  if(t.includes('locker') || t.includes('casillero') || t.includes('metálic') || t.includes('metalico') || t.includes('armario')) return 'Metalmecánica';
  if(t.includes('melamine') || t.includes('oficina') || t.includes('escritorio') || t.includes('archivador')) return 'Oficina';
  return 'General';
}

function makeId(parts){
  return parts.map(clean).filter(Boolean).join('|').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9|.-]/g,'-').slice(0,240);
}

function moneyToNumber(value){
  if(value === null || value === undefined || value === '') return null;
  const txt = String(value).replace(/S\/?|,/gi,'').replace(/\s/g,'').replace(/[^0-9.-]/g,'');
  const n = Number(txt);
  return Number.isFinite(n) ? n : null;
}

function normalizeOpportunity(raw, keyword){
  const title = clean(raw.title || raw.descripcion || raw.objeto || raw.nombre || raw.requerimiento || raw.description);
  const entity = clean(raw.entity || raw.entidad || raw.nombreEntidad || raw.entidadContratante || 'Entidad no identificada');
  const region = clean(raw.region || raw.departamento || raw.lugar || 'No especificada');
 let published_date = clean(raw.published_date || raw.fecha || raw.fechaPublicacion || '');

if (published_date && published_date.includes('/')) {
  const [d, m, y] = published_date.split(' ')[0].split('/');
  published_date = `${y}-${m}-${d}`;
}

if (!published_date) {
  published_date = new Date().toISOString().slice(0,10);
}
  const amount = moneyToNumber(raw.amount || raw.monto || raw.valorReferencial || raw.montoReferencial || raw.total);
  const source_url = clean(raw.source_url || raw.url || raw.link || SEACE_URLS.openNegocioBuscar);
  if(!title || title.length < 5) return null;
  const titleUpper = title.toUpperCase();
  const titleNorm = titleUpper.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const isGarbage =
  titleUpper.includes('BUSCADOR') ||
  titleUpper.includes('CONTRATOS MENORES') ||
  titleUpper.includes('SEARCH') ||
  titleUpper.includes('BUSCAR POR DESCRIPCION') ||
  titleUpper.includes('CONTRATOS MENORES 8 A UIT') ||
  titleUpper.includes('NO SE ENCONTRARON DATOS') ||
  titleUpper.includes('REGISTROS POR PAGINA') ||
  titleUpper.includes('FILTROS DE BUSQUEDA') ||
  titleUpper.includes('SELECCIONAR');

const looksLikeOpportunity =
  /LP-|AS-|CP-|SIE-|DIRECTA|ADJUDICACION|ADQUISICION|CONTRATACION|SERVICIO|SUMINISTRO|SILLA|SILLAS|MOBILIARIO|CARPETA|CARPETAS|MUEBLE|MUEBLES/.test(titleNorm);

if (isGarbage || !looksLikeOpportunity) return null;
  return {
    external_id: clean(raw.external_id || raw.id || raw.codigo || makeId([entity,title,published_date,keyword])),
    title,
    entity,
    region,
    amount,
    published_date,
    business_line: classify(`${title} ${keyword}`),
    status: 'Nuevo',
    source_url,
    alert_sent: false
  };
}

function textToOpportunity(text, keyword, index=0){
  const joined = clean(text);
  if(!joined || joined.length < 20) return null;

  // Acepta filas de tabla aunque el texto esté truncado o el primer término no aparezca completo.
  const opportunityWords = /(adquisici[oó]n|contrataci[oó]n|mobiliario|silla|mesa|carpeta|locker|armario|estante|escritorio|bien|servicio|procedimiento|nomenclatura|gobierno|municipalidad|hospital|ministerio|ugel|regional|entidad)/i;
  if(!opportunityWords.test(joined)) return null;

  const amountMatch = joined.match(/S\/?\s*([0-9][0-9.,]+)/i) || joined.match(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)\b/);
  const dateMatch = joined.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/) || joined.match(/\b\d{4}\-\d{2}\-\d{2}\b/);
  const closingMatch = joined.match(/(\d{2}\/\d{2}\/\d{4})\s+\d{2}:\d{2}:\d{2}\s+Fecha de cierre/i);

  const bienMatch = joined.match(/Bien:\s*(.*?)(?:Cotizaciones:|Fecha de publicación|open_in_new|Descargar|$)/i);
const tituloMatch = joined.match(/Título:\s*(.*?)(?:Entidad|Región|Fecha|$)/i);
const entidadMatch = joined.match(/Entidad\s+(.+?)(?:Cotizaciones:|Bien:|Fecha|$)/i);

const titleLine = clean(
  (bienMatch && bienMatch[1]) ||
  (tituloMatch && tituloMatch[1]) ||
  joined.slice(0, 180)
);

const entityLine = clean(
  (entidadMatch && entidadMatch[1]) ||
  'Entidad no identificada'
);
 

const entidadRealMatch = joined.match(
  /(MUNICIPALIDAD.?|GOBIERNO REGIONAL.?|UGEL.?|HOSPITAL.?|ESSALUD.?|MINISTERIO.?)(?:\s{2,}|Bien:|Fecha|Cotizaciones:|$)/i
);

const entidadReal =
  entidadRealMatch?.[1]?.trim() ||
  entityLine ||
  'Entidad no identificada';
  return normalizeOpportunity({
    external_id: makeId(['openegocio', keyword, index, entityLine || '', titleLine || joined.slice(0,120), dateMatch?.[0] || new Date().toISOString().slice(0,10)]),
    title: titleLine || joined.slice(0,260),
    entity: entidadReal,
    region: 'No especificada',
    amount: amountMatch
      ? Number(amountMatch[1].replace(/\./g,'').replace(',','.'))
      : null,
    published_date: dateMatch?.[0] || new Date().toISOString().slice(0,10),
    closing_date: closingMatch?.[1]
  ? (() => {
      const [d,m,y] = closingMatch[1].split('/');
      return ${y}-${m}-${d};
    })()
  : null,
    
    source_url: SEACE_URLS.openNegocio
  }, keyword);
}

async function launchBrowser(){
  let chromium;
  try{
    ({ chromium } = await import('playwright'));
  }catch(e){
    throw new Error('Playwright no está instalado. Revisa package.json y Render.');
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 }
  });

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return { browser, page };
}

async function fillBestInput(page, keyword, diagnostics){
  // OpenNegocio tiene varios campos. Llenamos los campos de texto visibles para reproducir la búsqueda manual.
  try{
    const advanced = page.getByText(/Búsqueda avanzada|Busqueda avanzada/i).first();
    if(await advanced.isVisible({ timeout:1500 })){
      await advanced.click({ timeout:2000 }).catch(()=>{});
      diagnostics.push('Se intentó abrir Búsqueda avanzada.');
      await page.waitForTimeout(800);
    }
  }catch{}

  const inputs = await page.locator('input:not([type=hidden]), textarea').all();
  diagnostics.push(`Inputs detectados: ${inputs.length}`);
  let filled = 0;

  for(const input of inputs){
    try{
      if(await input.isVisible({ timeout:800 })){
        const box = await input.boundingBox();
        const placeholder = await input.getAttribute('placeholder').catch(()=>null);
        const aria = await input.getAttribute('aria-label').catch(()=>null);
        const type = await input.getAttribute('type').catch(()=>null);
        const value = await input.inputValue().catch(()=>null);
        diagnostics.push(`Input visible: ${JSON.stringify({placeholder, aria, type, value, box})}`);
        if(box && box.width > 40 && box.height > 10 && (!type || ['text','search',''].includes(String(type).toLowerCase()))){
          await input.click({ timeout:1500 });
          await input.fill(keyword, { timeout:2500 });
          filled++;
          await page.waitForTimeout(250);
        }
      }
    }catch(e){
      diagnostics.push(`No se pudo llenar input: ${e.message}`);
    }
  }

  // También intenta insertar en campos con label Descripción si el framework no reaccionó al fill normal.
  try{
    await page.evaluate((kw)=>{
      const els = Array.from(document.querySelectorAll('input:not([type=hidden]), textarea'));
      for(const el of els){
        const rect = el.getBoundingClientRect();
        if(rect.width > 40 && rect.height > 10){
          el.value = kw;
          el.dispatchEvent(new Event('input', { bubbles:true }));
          el.dispatchEvent(new Event('change', { bubbles:true }));
        }
      }
    }, keyword);
    diagnostics.push('Se dispararon eventos input/change manuales.');
  }catch(e){ diagnostics.push(`No se pudieron disparar eventos manuales: ${e.message}`); }

  diagnostics.push(`Campos llenados: ${filled}`);
  return filled > 0;
}

async function clickSearch(page, diagnostics){
  const labels = ['Buscar','Consultar','Filtrar','Aplicar','Search'];
  for(const label of labels){
    try{
      const btns = await page.getByText(label, { exact:false }).all();
      for(const btn of btns){
        if(await btn.isVisible({ timeout:800 })){
          await btn.click({ timeout:2500 });
          diagnostics.push(`Click en botón: ${label}`);
          await page.waitForTimeout(2500);
          return true;
        }
      }
    }catch{}
  }
  try{
    await page.keyboard.press('Enter');
    diagnostics.push('Se presionó Enter.');
    await page.waitForTimeout(2500);
    return true;
  }catch(e){
    diagnostics.push(`No se pudo presionar Enter: ${e.message}`);
  }
  return false;
}

async function extractRows(page, keyword, diagnostics){
  // Espera explícitamente texto típico de resultado en OpenNegocio.
  await page.waitForTimeout(12000);

  const result = await page.evaluate((kw) => {
    const clean = s => String(s||'').replace(/\s+/g,' ').trim();
    const body = clean(document.body.innerText || '');
    const out = [];

    // 1) Extrae filas de tabla reales.
    document.querySelectorAll('table tbody tr, table tr, [role=row]').forEach((tr)=>{
      const cells = Array.from(tr.querySelectorAll('td, th, [role=cell], [role=gridcell]')).map(td=>clean(td.innerText || td.textContent || '')).filter(Boolean);
      const text = cells.length ? cells.join(' | ') : clean(tr.innerText || tr.textContent || '');
      if(text.length > 35) out.push({ selector:'row', cells, text:text.slice(0,1500) });
    });

    // 2) Extrae bloques visuales si no hay tabla estándar.
    ['.ng-star-inserted','.mat-row','.p-datatable-tbody tr','.ui-table-tbody tr','.card','.item','li'].forEach(sel=>{
      document.querySelectorAll(sel).forEach((el)=>{
        const text = clean(el.innerText || el.textContent || '');
        if(text.length > 45) out.push({ selector:sel, cells:[], text:text.slice(0,1500) });
      });
    });

    // 3) Si todo falla, corta el cuerpo por entidades/procedimientos.
    if(!out.length){
      body.split(/(?=GOBIERNO|MUNICIPALIDAD|MINISTERIO|HOSPITAL|UNIVERSIDAD|UGEL|DIRECCI[ÓO]N|ADQUISICI[ÓO]N|CONTRATACI[ÓO]N|LP-|AS-|SIE-|CP-)/i)
        .map(clean)
        .filter(x=>x.length>50)
        .forEach(x=>out.push({selector:'body-chunk', cells:[], text:x.slice(0,1500)}));
    }

    return {
      url: location.href,
      title: document.title,
      bodyStart: body.slice(0,1200),
      matches: [...new Map(
  out
    .filter(x => {
      const t = String(x.text || '').toUpperCase();

      const hasProcessCode =
        /LP-|AS-|CP-|SIE-|DIRECTA|CONCURSO|ADJUDICACION|ADQUISICION|CONTRATACION/.test(t);

      const isGarbage =
        t.includes('BUSCADOR') ||
        t.includes('CONTRATOS MENORES 8 A UIT') ||
        t.includes('NO SE ENCONTRARON DATOS') ||
        t.includes('REGISTROS POR PAGINA') ||
        t.includes('FILTROS DE BUSQUEDA') ||
        t.includes('SELECCIONAR');

      return hasProcessCode && !isGarbage;
    })
    .map(x => [x.text, x])
).values()].slice(0,50)
    };
  }, keyword);

  diagnostics.push(`URL final: ${result.url}`);
  diagnostics.push(`Título: ${result.title}`);
  diagnostics.push(`Texto inicial: ${result.bodyStart}`);
  diagnostics.push(`Bloques extraídos: ${result.matches.length}`);

  const rows = result.matches
    .map((m,i)=>textToOpportunity(m.text, keyword, i))
    .filter(Boolean);

  diagnostics.push(`Oportunidades normalizadas: ${rows.length}`);
  return rows;
}

async function searchOpenNegocioWithBrowser(keyword){
  const diagnostics = [];
  const rows = [];
  const { browser, page } = await launchBrowser();

  try{
    diagnostics.push(`Abriendo OpenNegocio directo: ${SEACE_URLS.openNegocio}`);
    await page.goto(SEACE_URLS.openNegocio, { waitUntil:'domcontentloaded', timeout:60000 });
    await page.waitForTimeout(8000);

    let bodyText = await page.locator('body').innerText({ timeout:8000 }).catch(()=>'');
    diagnostics.push(`Texto inicial directo: ${clean(bodyText).slice(0,800)}`);

    // Si el servidor responde ruta no válida antes de cargar la SPA, reintenta cargando base sin depender del hash.
    if(/ruta no v[aá]lida|invalid path/i.test(bodyText)){
      diagnostics.push('Directo devolvió ruta no válida. Reintentando base y luego hash.');
      await page.goto('https://prod4.seace.gob.pe/openegocio/', { waitUntil:'domcontentloaded', timeout:60000 });
      await page.waitForTimeout(4000);
      await page.evaluate(() => { window.location.hash = '#/buscar'; });
      await page.waitForTimeout(8000);
      bodyText = await page.locator('body').innerText({ timeout:8000 }).catch(()=>'');
      diagnostics.push(`Texto luego de base/hash: ${clean(bodyText).slice(0,800)}`);
    }

    await fillBestInput(page, keyword, diagnostics);
    await clickSearch(page, diagnostics);
    rows.push(...await extractRows(page, keyword, diagnostics));
  }catch(e){
    diagnostics.push(`OpenNegocio error: ${e.message}`);
  }finally{
    await browser.close();
  }

  return { rows, diagnostics };
}

async function searchContratosMenoresWithBrowser(keyword){
  const diagnostics = [];
  const rows = [];
  const { browser, page } = await launchBrowser();

  try{
    diagnostics.push(`Abriendo contratos menores: ${SEACE_URLS.contratosMenores}`);
    await page.goto(SEACE_URLS.contratosMenores, { waitUntil:'domcontentloaded', timeout:45000 });
    await page.waitForTimeout(5000);

    await fillBestInput(page, keyword, diagnostics);
    await clickSearch(page, diagnostics);
    rows.push(...await extractRows(page, keyword, diagnostics));
  }catch(e){
    diagnostics.push(`Contratos menores error: ${e.message}`);
  }finally{
    await browser.close();
  }

  return { rows, diagnostics };
}

async function searchKeyword(keyword){
  const diagnostics = [];
  const errors = [];
  const all = [];

  const open = await searchOpenNegocioWithBrowser(keyword);
  diagnostics.push({ fuente:'opennegocio', pasos:open.diagnostics });
  all.push(...open.rows);

  if(!all.length){
    const menores = await searchContratosMenoresWithBrowser(keyword);
    diagnostics.push({ fuente:'contratos-menores', pasos:menores.diagnostics });
    all.push(...menores.rows);
  }

  const byId = new Map();
  all.filter(Boolean).forEach(o=>byId.set(o.external_id, o));
  return { items:[...byId.values()].slice(0,25), errors, diagnostics };
}

async function getActiveKeywords(){
  const rows = await table('keywords');
  const words = rows.map(r=>r.keyword || r.name || r.text || r.palabra).filter(Boolean);
  return [...new Set(words.length ? words : demo.keywords.map(k=>k.keyword))].slice(0,30);
}

  
async function searchSeaceLite(keyword=null){
  const errors = [];
  const diagnostics = [];
  const all = [];

  const keywords = keyword
    ? [keyword]
    : await getActiveKeywords();

  for (const k of keywords.slice(0,5)) {
    try {
      const result = await searchKeyword(k);

      all.push(...(result.items || []));

      diagnostics.push({
        keyword: k,
        found: result.items?.length || 0,
        diagnostics: result.diagnostics || []
      });

    } catch (e) {
      errors.push({
        keyword: k,
        error: e.message
      });
    }
  }

  const byId = new Map();

  all.filter(Boolean).forEach(o => {
    byId.set(o.external_id, o);
  });

  return {
    items: [...byId.values()].slice(0,25),
    errors,
    diagnostics
  };
}
async function upsertOpportunities(items){
  if(!items?.length) return table('opportunities');
  if(!supabase){
    demo.opportunities = items.concat(demo.opportunities).slice(0,100);
    return demo.opportunities;
  }
  const { error } = await supabase.from('opportunities').upsert(items, { onConflict:'external_id' });
  if(error) throw error;
  return table('opportunities');
}

function renderEmail(opportunities) {
  return '<div style="font-family:Arial,sans-serif;background:#f6f7fb;padding:16px;">' +
    '<h2>Radar SEACE - Nuevas oportunidades</h2>' +
    opportunities.slice(0, 10).map(o => {
      const q = encodeURIComponent(o.external_id || o.nomenclatura || o.title || '');
      const link = 'https://prod4.seace.gob.pe/openegocio/#/buscar?search=' + q;

      return '<div style="border:1px solid #e7eaf0;border-radius:12px;padding:16px;margin-bottom:12px;background:white;">' +
        '<h3>' + (o.title || 'Oportunidad SEACE') + '</h3>' +
        '<p><b>Nomenclatura:</b> ' + (o.nomenclature || o.external_id || '-') + '</p>' +
        '<p><b>Entidad:</b> ' + (o.entity || '-') + '</p>' +
        '<p><b>Línea:</b> ' + (o.business_line || '-') + '</p>' +
        '<p><a href="' + link + '" target="_blank">Ver oportunidad en Radar Ibero</a></p>' +
      '</div>';
    }).join('') +
  '</div>';
}
async function sendDigest(){
  const opportunities = await table('opportunities');
  const vendors = await table('vendors');
  if(!process.env.SMTP_HOST) return { ok:false, message:'SMTP no configurado' };

  const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000
});

  const recipients = vendors.map(v=>v.email).filter(Boolean).join(',');
  if(!recipients) return { ok:false, message:'No hay vendedores configurados' };

  console.log('VERIFICANDO SMTP...');
await transport.verify();
console.log('SMTP OK');

console.log('ENVIANDO DIGEST A:', recipients);

const info = await transport.sendMail({
  from: process.env.MAIL_FROM || process.env.SMTP_USER,
  to: recipients,
  subject: `${opportunities.length} oportunidades SEACE detectadas`,
  html: renderEmail(opportunities)
});

console.log('DIGEST ENVIADO:', info.messageId || info.response);

return { ok:true, recipients, messageId: info.messageId || null, response: info.response || null };
}

app.get('/', (_,res)=>res.json({
  ok:true,
  app:'SEACE Alertas Grupo Ibero',
  mode:MODE,
  version:VERSION,
  endpoints:['/api/health','/api/bootstrap','/api/jobs/search-now']
}));

app.get('/api/health', (_,res)=>res.json({
  ok:true,
  supabase:!!supabase,
  mode:MODE,
  version:VERSION
}));

app.get('/api/bootstrap', async (_,res,next)=>{
  try{
    res.json({
      keywords: await table('keywords'),
      vendors: await table('vendors'),
      opportunities: await table('opportunities')
    });
  }catch(e){ next(e); }
});

app.post('/api/jobs/search', async (_,res,next)=>{
  try{
    const result = await searchSeaceLite();
    const opportunities = await upsertOpportunities(result.items || []);
    res.json({ ok:true, found:result.items.length, errors:result.errors, diagnostics:result.diagnostics, opportunities });
  }catch(e){ next(e); }
});

app.get('/api/jobs/search-now', async (req,res,next)=>{
  console.log('ENTRO A SEARCH NOW', req.query);
  try{
    const keyword = req.query.keyword ? String(req.query.keyword) : 'mobiliario escolar';
    const result = await searchSeaceLite(keyword);
    const saved = await upsertOpportunities(result.items || []);
    res.json({
      ok:true,
      version:VERSION,
      keyword,
      found: result.items ? result.items.length : 0,
      saved_total: Array.isArray(saved) ? saved.length : null,
      errors: result.errors || [],
      diagnostics: result.diagnostics || [],
      items: result.items || []
    });
  }catch(err){ next(err); }
});

app.post('/api/jobs/send-digest', async (_req,res,next)=>{
  try { res.json(await sendDigest()); }
  catch(e){ next(e); }
});

app.get('/api/jobs/send-digest', async (_req,res,next)=>{
  try { res.json(await sendDigest()); }
  catch(e){ next(e); }
});
app.get('/api/ai-test', async (req, res) => {
  try {
    const result = await testAI();

    res.json({
      ok: true,
      result
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});
app.get('/api/ai-demo', async (req,res) => {

  try {

    const opportunities = await table('opportunities');

    if(!opportunities.length){
      return res.json({
        ok:false,
        message:'No hay oportunidades'
      });
    }

    const analysis =
      await analyzeOpportunity(opportunities[0]);

    res.json({
      ok:true,
      opportunity: opportunities[0],
      analysis
    });

  } catch(e){

    res.status(500).json({
      ok:false,
      error:e.message
    });

  }

});

app.get('/api/ask-test', async (req,res) => {

  try {

    const opportunities = await table('opportunities');

    const opportunity = opportunities[0];

    const analysis = await analyzeOpportunity(opportunity);

    res.json({
      ok:true,
      opportunity: opportunity.title,
      analysis
    });

  } catch(e){

    res.status(500).json({
      ok:false,
      error:e.message
    });

  }

});
app.post('/api/opportunities/:id/ask', async (req, res) => {
  try {
    const { id } = req.params;
    const { question } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'La pregunta es requerida'
      });
    }

    const opportunities = await table('opportunities');
    const opportunity = opportunities.find(o => String(o.id) === String(id));
    const allDocuments = await table('opportunity_documents');

const documents = allDocuments.filter(
  d => String(d.opportunity_id) === String(id)
);

const documentsText = documents.length
  ? documents.map(d => `
DOCUMENTO: ${d.title || 'Sin título'}
TIPO: ${d.document_type || '-'}
URL: ${d.url || '-'}
CONTENIDO:
${d.content || ''}
`).join('\n\n---\n\n')
  : 'No hay documentos del expediente cargados para esta oportunidad.';

    if (!opportunity) {
      return res.status(404).json({
        ok: false,
        error: 'Oportunidad no encontrada'
      });
    }

    const prompt = `
Eres un asistente comercial experto en licitaciones públicas para Grupo Ibero Perú.

Analiza esta oportunidad:

Título: ${opportunity.title || ''}
Entidad: ${opportunity.entity || ''}
Proceso: ${opportunity.external_id || opportunity.nomenclature || ''}
Región: ${opportunity.region || ''}
Línea: ${opportunity.business_line || ''}
Descripción: ${opportunity.description || opportunity.title || ''}

DOCUMENTOS DEL EXPEDIENTE:
${documentsText}

Pregunta del usuario:
${question}

Responde de forma clara, práctica y orientada a decisión comercial.
`;

    const response = await openai.responses.create({
      model: "gpt-5-mini",
      input: prompt
    });

    const answer = response.output_text;

    await supabase
      .from('ai_chats')
      .insert({
        opportunity_id: id,
        question,
        answer
      });

    res.json({
      ok: true,
      answer
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});
app.get('/api/opportunities/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const opportunities = await table('opportunities');
    const opportunity = opportunities.find(
      o => String(o.id) === String(id)
    );

    if (!opportunity) {
      return res.status(404).json({
        ok: false,
        error: 'Oportunidad no encontrada'
      });
    }

    let analysis = null;

if (!opportunity.ai_summary && !opportunity.resumen_ai) {
  analysis = await analyzeOpportunity(opportunity);
} else {
  analysis = {
    summary: opportunity.ai_summary || opportunity.resumen_ai,
    score: opportunity.ai_score || opportunity.puntuacion_ai,
    recommendation: opportunity.ai_recommendation || opportunity.recomendacion_ai
  };
}

res.json({
  ok: true,
  opportunity: {
    ...opportunity,
    ai_summary: analysis?.summary || null,
    ai_score: analysis?.score || null,
    ai_recommendation: analysis?.recommendation || analysis?.decision || null,
    ai_decision: analysis?.decision || analysis?.recommendation || null,
    ai_risks: analysis?.risks || [],
    ai_actions: analysis?.actions || [],
    ai_criteria: analysis?.criteria || []
  }
});

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});
app.get('/api/opportunities/:id/documents', async (req, res) => {
  try {
    const { id } = req.params;

    const documents = await table('opportunity_documents');
    const items = documents.filter(
      d => String(d.opportunity_id) === String(id)
    );

    res.json({
      ok: true,
      documents: items
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});
app.use((err,_,res,__)=>{
  console.error('API error:', err);
  res.status(500).json({ error:err.message, version:VERSION });
});

const schedule = process.env.CRON_SCHEDULE || '0 8,17 * * *';
cron.schedule(schedule, async()=>{
  try{
    const result = await searchSeaceLite();
    await upsertOpportunities(result.items || []);
    await sendDigest();
    console.log('cron ok', result.items.length);
  }catch(e){
    console.error('cron error', e);
  }
});

app.listen(process.env.PORT || 3000, ()=>console.log(`SEACE backend ${VERSION} on ${process.env.PORT || 3000}`));
