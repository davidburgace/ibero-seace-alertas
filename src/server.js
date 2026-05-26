import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL?.split(',') || '*' }));
app.use(express.json());

const VERSION = '0.9.0';
const MODE = 'opennegocio-safe-v2';

const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = process.env.SUPABASE_URL && SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, SUPABASE_KEY)
  : null;

const SEACE_URLS = {
  openNegocioBase: 'https://prod4.seace.gob.pe/openegocio/',
  openNegocioBuscar: 'https://prod4.seace.gob.pe/openegocio/#/buscar',
  contratosMenores: 'https://prod6.seace.gob.pe/buscador-publico/contrataciones'
};

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
  const { data, error } = await supabase.from(name).select('*').order('created_at', { ascending:false });
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
  const published_date = clean(raw.published_date || raw.fecha || raw.fechaPublicacion || new Date().toISOString().slice(0,10));
  const amount = moneyToNumber(raw.amount || raw.monto || raw.valorReferencial || raw.montoReferencial || raw.total);
  const source_url = clean(raw.source_url || raw.url || raw.link || SEACE_URLS.openNegocioBuscar);
  if(!title || title.length < 5) return null;
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
  if(!joined || joined.length < 35) return null;
  const lower = joined.toLowerCase();
  const kw0 = String(keyword || '').toLowerCase().split(' ')[0];
  if(kw0 && !lower.includes(kw0)) return null;

  const parts = joined.split(/(?=Entidad|Objeto|Descripción|Monto|Fecha|Región|Departamento|Nomenclatura|Código)/i)
    .map(clean).filter(Boolean);
  const amountMatch = joined.match(/S\/?\s*([0-9][0-9.,]+)/i) || joined.match(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)\b/);
  const dateMatch = joined.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/) || joined.match(/\b\d{4}\-\d{2}\-\d{2}\b/);

  const entityLine = parts.find(p=>/(municipalidad|gobierno regional|ministerio|hospital|universidad|ugel|direcci[oó]n|unidad ejecutora|instituto|entidad)/i.test(p));
  const titleLine = parts.find(p=>/(mobiliario|silla|mesa|carpeta|locker|armario|hospital|melamine|estante|escritorio|adquisici[oó]n|contrataci[oó]n|bien)/i.test(p));

  return normalizeOpportunity({
    external_id: makeId(['openegocio', keyword, index, entityLine || '', titleLine || joined.slice(0,120), dateMatch?.[0] || new Date().toISOString().slice(0,10)]),
    title: titleLine || joined.slice(0,220),
    entity: entityLine || 'Entidad no identificada',
    region: 'No especificada',
    amount: amountMatch?.[1] || null,
    published_date: dateMatch?.[0] || new Date().toISOString().slice(0,10),
    source_url: SEACE_URLS.openNegocioBuscar
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
  const inputs = await page.locator('input:not([type=hidden]), textarea').all();
  diagnostics.push(`Inputs detectados: ${inputs.length}`);

  for(const input of inputs){
    try{
      if(await input.isVisible({ timeout:800 })){
        const box = await input.boundingBox();
        const placeholder = await input.getAttribute('placeholder').catch(()=>null);
        const aria = await input.getAttribute('aria-label').catch(()=>null);
        const type = await input.getAttribute('type').catch(()=>null);
        diagnostics.push(`Input visible: ${JSON.stringify({placeholder, aria, type, box})}`);
        if(box && box.width > 40 && box.height > 10){
          await input.click({ timeout:1500 });
          await input.fill(keyword, { timeout:2500 });
          await page.waitForTimeout(800);
          diagnostics.push('Se llenó campo de búsqueda.');
          return true;
        }
      }
    }catch(e){
      diagnostics.push(`No se pudo llenar input: ${e.message}`);
    }
  }
  diagnostics.push('No se encontró campo de búsqueda visible.');
  return false;
}

async function clickSearch(page, diagnostics){
  const labels = ['Buscar','Consultar','Filtrar','Aplicar','Search'];
  for(const label of labels){
    try{
      const btn = page.getByText(label, { exact:false }).first();
      if(await btn.isVisible({ timeout:1000 })){
        await btn.click({ timeout:2500 });
        diagnostics.push(`Click en botón: ${label}`);
        return true;
      }
    }catch{}
  }
  try{
    await page.keyboard.press('Enter');
    diagnostics.push('Se presionó Enter.');
    return true;
  }catch(e){
    diagnostics.push(`No se pudo presionar Enter: ${e.message}`);
  }
  return false;
}

async function extractRows(page, keyword, diagnostics){
  await page.waitForTimeout(8000);

  const result = await page.evaluate((kw) => {
    const clean = s => String(s||'').replace(/\s+/g,' ').trim();
    const kw0 = String(kw||'').toLowerCase().split(' ')[0];
    const selectors = [
      'tr','[role=row]','.card','.mat-row','.MuiTableRow-root',
      '.ant-table-row','li','article','.resultado','.result','.item',
      '.p-card','.ui-card','.ng-star-inserted'
    ];

    const out = [];
    for(const sel of selectors){
      document.querySelectorAll(sel).forEach((el)=>{
        const text = clean(el.innerText || el.textContent || '');
        if(text.length > 35 && (!kw0 || text.toLowerCase().includes(kw0))) {
          out.push({ selector: sel, text: text.slice(0,1200) });
        }
      });
    }

    const body = clean(document.body.innerText || '');
    return {
      url: location.href,
      title: document.title,
      bodyStart: body.slice(0,900),
      matches: [...new Map(out.map(x=>[x.text,x])).values()].slice(0,30)
    };
  }, keyword);

  diagnostics.push(`URL final: ${result.url}`);
  diagnostics.push(`Título: ${result.title}`);
  diagnostics.push(`Texto inicial: ${result.bodyStart}`);
  diagnostics.push(`Bloques extraídos: ${result.matches.length}`);

  return result.matches.map((m,i)=>textToOpportunity(m.text, keyword, i)).filter(Boolean);
}

async function searchOpenNegocioWithBrowser(keyword){
  const diagnostics = [];
  const rows = [];
  const { browser, page } = await launchBrowser();

  try{
    // En algunas SPA, navegar directamente al hash puede devolver error desde servidor.
    // Por eso se abre la base y luego se cambia el hash dentro del navegador.
    diagnostics.push(`Abriendo base: ${SEACE_URLS.openNegocioBase}`);
    await page.goto(SEACE_URLS.openNegocioBase, { waitUntil:'domcontentloaded', timeout:45000 });
    await page.waitForTimeout(3000);

    let bodyText = await page.locator('body').innerText({ timeout:5000 }).catch(()=>'');
    diagnostics.push(`Base texto inicial: ${clean(bodyText).slice(0,500)}`);

    if(/ruta no v[aá]lida|invalid path/i.test(bodyText)){
      diagnostics.push('La base devolvió ruta no válida. Intentando contratos menores como respaldo.');
    }else{
      await page.evaluate(() => { window.location.hash = '#/buscar'; });
      await page.waitForTimeout(4000);
      diagnostics.push(`Hash aplicado: ${await page.url()}`);

      await fillBestInput(page, keyword, diagnostics);
      await clickSearch(page, diagnostics);
      rows.push(...await extractRows(page, keyword, diagnostics));
    }
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

async function searchSeace(keyword=null){
  if(keyword){
    return await searchKeyword(keyword);
  }

  const keywords = await getActiveKeywords();
  const found = [];
  const errors = [];
  const diagnostics = [];

  for(const kw of keywords){
    try{
      const result = await searchKeyword(kw);
      found.push(...result.items);
      diagnostics.push({ keyword:kw, diagnostics:result.diagnostics });
      if(found.length >= 50) break;
    }catch(e){
      errors.push({ keyword:kw, error:e.message });
    }
  }

  const byId = new Map();
  found.forEach(o=>{ if(o?.external_id) byId.set(o.external_id, o); });
  return { items:[...byId.values()], errors, diagnostics };
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

function renderEmail(opportunities){
  const cards = opportunities.slice(0,10).map(o=>`<div style="border:1px solid #e7eaf0;border-radius:14px;padding:14px;margin:0 0 12px;background:#fff"><h3 style="margin:0 0 8px;font-size:16px">${o.title}</h3><p style="margin:0 0 10px;color:#475467;line-height:1.45"><b>Entidad:</b> ${o.entity}<br><b>Región:</b> ${o.region}<br><b>Monto:</b> ${o.amount ? 'S/ '+Number(o.amount).toLocaleString('es-PE') : 'Sin monto'}<br><b>Línea:</b> ${o.business_line}</p><a href="${o.source_url}" style="display:block;background:#0f766e;color:#fff;text-align:center;text-decoration:none;border-radius:12px;padding:12px;font-weight:700">Ver oportunidad</a></div>`).join('');
  return `<div style="font-family:Arial,sans-serif;background:#f6f7fb;padding:16px"><div style="max-width:480px;margin:auto"><div style="background:#174e8f;color:#fff;border-radius:16px 16px 0 0;padding:18px"><h2 style="margin:0">Alertas SEACE</h2><p style="margin:6px 0 0">${opportunities.length} oportunidades detectadas</p></div><div style="background:#fff;padding:14px;border:1px solid #e7eaf0;border-top:0;border-radius:0 0 16px 16px">${cards || '<p>No hay oportunidades nuevas para enviar.</p>'}<p style="font-size:12px;color:#667085">Sistema de Alertas Comerciales - Grupo Ibero</p></div></div></div>`;
}

async function sendDigest(){
  const opportunities = await table('opportunities');
  const vendors = await table('vendors');
  if(!process.env.SMTP_HOST) return { ok:false, message:'SMTP no configurado' };

  const transport = nodemailer.createTransport({
    host:process.env.SMTP_HOST,
    port:Number(process.env.SMTP_PORT || 587),
    secure:String(process.env.SMTP_SECURE || 'false') === 'true',
    auth:{ user:process.env.SMTP_USER, pass:process.env.SMTP_PASS }
  });

  const recipients = vendors.map(v=>v.email).filter(Boolean).join(',');
  if(!recipients) return { ok:false, message:'No hay vendedores configurados' };

  await transport.sendMail({
    from:process.env.MAIL_FROM || process.env.SMTP_USER,
    to:recipients,
    subject:`${opportunities.length} oportunidades SEACE detectadas`,
    html:renderEmail(opportunities)
  });

  return { ok:true, recipients };
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
    const result = await searchSeace();
    const opportunities = await upsertOpportunities(result.items || []);
    res.json({ ok:true, found:result.items.length, errors:result.errors, diagnostics:result.diagnostics, opportunities });
  }catch(e){ next(e); }
});

app.get('/api/jobs/search-now', async (req,res,next)=>{
  console.log('ENTRO A SEARCH NOW', req.query);
  try{
    const keyword = req.query.keyword ? String(req.query.keyword) : 'mobiliario escolar';
    const result = await searchSeace(keyword);
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

app.post('/api/jobs/send-digest', async (_,res,next)=>{
  try{ res.json(await sendDigest()); }
  catch(e){ next(e); }
});

app.use((err,_,res,__)=>{
  console.error('API error:', err);
  res.status(500).json({ error:err.message, version:VERSION });
});

const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
cron.schedule(schedule, async()=>{
  try{
    const result = await searchSeace();
    await upsertOpportunities(result.items || []);
    await sendDigest();
    console.log('cron ok', result.items.length);
  }catch(e){
    console.error('cron error', e);
  }
});

app.listen(process.env.PORT || 3000, ()=>console.log(`SEACE backend ${VERSION} on ${process.env.PORT || 3000}`));
