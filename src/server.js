import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL?.split(',') || '*' }));
app.use(express.json());

const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = process.env.SUPABASE_URL && SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, SUPABASE_KEY)
  : null;

const SEACE_URLS = {
  openNegocio: 'https://prod4.seace.gob.pe/openegocio/#/buscar',
  openNegocioBase: 'https://prod4.seace.gob.pe/openegocio/',
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
  return parts.map(clean).filter(Boolean).join('|').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9|.-]/g,'-').slice(0,240);
}

function moneyToNumber(value){
  if(value === null || value === undefined || value === '') return null;
  const txt = String(value).replace(/S\/?|,/gi,'').replace(/\s/g,'').replace(/[^0-9.-]/g,'');
  const n = Number(txt);
  return Number.isFinite(n) ? n : null;
}

function normalizeOpportunity(raw, keyword){
  const title = clean(raw.title || raw.descripcion || raw.descripcionObjeto || raw.descripcion_objeto || raw.objeto || raw.nombre || raw.requerimiento || raw.descripcionRequerimiento || raw.descripcion_de_requerimiento || raw.description || raw.texto || raw.text);
  const entity = clean(raw.entity || raw.entidad || raw.nombreEntidad || raw.nombre_entidad || raw.entidadContratante || raw.nombreSiglaEntidad || raw.razonSocial || raw.organo || 'Entidad no identificada');
  const region = clean(raw.region || raw.departamento || raw.ubigeo || raw.lugar || raw.regionName || raw.localidad || 'No especificada');
  const published_date = clean(raw.published_date || raw.fechaPublicacion || raw.fecha_publicacion || raw.fecha || raw.fechaInicio || raw.fechaEmision || raw.fechaConvocatoria || new Date().toISOString().slice(0,10));
  const amount = moneyToNumber(raw.amount || raw.monto || raw.valorReferencial || raw.valor_referencial || raw.montoReferencial || raw.valorEstimado || raw.total);
  const source_url = clean(raw.source_url || raw.url || raw.link || raw.enlace || SEACE_URLS.openNegocio);
  if(!title || title.length < 5) return null;
  return {
    external_id: clean(raw.external_id || raw.id || raw.codigo || raw.numero || raw.nomenclatura || makeId([entity,title,published_date,keyword])),
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

function findArrays(obj, arrays=[]){
  if(Array.isArray(obj)) {
    if(obj.length && typeof obj[0] === 'object') arrays.push(obj);
    obj.forEach(x=>findArrays(x, arrays));
  } else if(obj && typeof obj === 'object') {
    Object.values(obj).forEach(v=>findArrays(v, arrays));
  }
  return arrays;
}

function looksLikeOpportunity(o){
  const text = Object.keys(o || {}).concat(Object.values(o || {}).map(v=>String(v).slice(0,80))).join(' ').toLowerCase();
  return /(entidad|descripcion|objeto|requerimiento|monto|fecha|contratacion|contratación|nomenclatura|convocatoria|procedimiento|oportunidad)/.test(text);
}

function textToOpportunity(text, keyword, index=0, sourceUrl=SEACE_URLS.openNegocio){
  const rawText = String(text || '').replace(/\r/g,'\n');
  const lines = rawText.split(/\n|\t| {2,}| \| /).map(clean).filter(Boolean);
  const joined = clean(lines.join(' '));
  if(!joined || joined.length < 20) return null;
  const kw0 = String(keyword || '').toLowerCase().split(' ')[0];
  if(kw0 && !joined.toLowerCase().includes(kw0)) return null;
  const amountMatch = joined.match(/S\/?\s*([0-9][0-9.,]+)/i) || joined.match(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)\b/);
  const dateMatch = joined.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/) || joined.match(/\b\d{4}\-\d{2}\-\d{2}\b/);
  const title = lines.find(l=>l.length > 18 && /(mobiliario|silla|mesa|carpeta|locker|casillero|armario|hospital|melamine|estante|escritorio|bien|servicio|adquisici[oó]n|contrataci[oó]n|implementaci[oó]n)/i.test(l)) || joined.slice(0,220);
  const entity = lines.find(l=>/(municipalidad|gobierno regional|ministerio|hospital|universidad|ugel|direcci[oó]n|unidad ejecutora|proyecto especial|instituto|ej[eé]rcito|polic[ií]a)/i.test(l)) || 'Entidad no identificada';
  return normalizeOpportunity({
    external_id: makeId(['openegocio', keyword, index, entity, title, dateMatch?.[0] || new Date().toISOString().slice(0,10)]),
    title,
    entity,
    region: 'No especificada',
    amount: amountMatch?.[1] || null,
    published_date: dateMatch?.[0] || new Date().toISOString().slice(0,10),
    source_url: sourceUrl
  }, keyword);
}

async function searchOpenNegocioWithBrowser(keyword){
  let chromium;
  try{
    ({ chromium } = await import('playwright'));
  } catch(e){
    throw new Error('Playwright no está instalado en Render. Revisa package.json y PLAYWRIGHT_BROWSERS_PATH=0.');
  }

  console.log('[OPENNEGOCIO] iniciando búsqueda:', keyword);
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
    viewport: { width: 1366, height: 768 },
    locale: 'es-PE'
  });

  const apiItems = [];
  const apiDebug = [];

  page.on('response', async (response)=>{
    try{
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      const status = response.status();
      if(/openegocio|seace|prod4/i.test(url) && /json|text|javascript/i.test(ct)){
        apiDebug.push({ status, url:url.slice(0,250), contentType:ct });
      }
      if(status >= 200 && status < 300 && /json/i.test(ct)){
        const json = await response.json().catch(()=>null);
        if(json){
          const arrays = findArrays(json).sort((a,b)=>b.length-a.length);
          for(const arr of arrays){
            const rows = arr.filter(looksLikeOpportunity).map(r=>normalizeOpportunity(r, keyword)).filter(Boolean);
            if(rows.length) apiItems.push(...rows);
          }
        }
      }
    }catch(e){}
  });

  try{
    await page.goto(SEACE_URLS.openNegocio, { waitUntil:'domcontentloaded', timeout:60000 });
    console.log('[OPENNEGOCIO] URL cargada:', page.url());
    await page.waitForTimeout(8000);

    // Llenar el campo más probable de búsqueda. Open Negocio es SPA, por eso intentamos varios selectores.
    const selectorCandidates = [
      'input[placeholder*="Buscar" i]',
      'input[placeholder*="descrip" i]',
      'input[placeholder*="palabra" i]',
      'input[placeholder*="objeto" i]',
      'input[type="text"]',
      'textarea'
    ];

    let filled = false;
    for(const sel of selectorCandidates){
      try{
        const loc = page.locator(sel).first();
        if(await loc.isVisible({ timeout:2500 })){
          await loc.fill(keyword, { timeout:5000 });
          filled = true;
          console.log('[OPENNEGOCIO] campo llenado con selector:', sel);
          break;
        }
      }catch(e){}
    }

    if(!filled){
      const inputs = await page.locator('input:not([type=hidden]), textarea').all();
      for(const input of inputs){
        try{
          if(await input.isVisible({ timeout:1000 })){
            const box = await input.boundingBox();
            if(box && box.width > 60 && box.height > 12){
              await input.fill(keyword, { timeout:3000 });
              filled = true;
              console.log('[OPENNEGOCIO] campo llenado por fallback');
              break;
            }
          }
        }catch(e){}
      }
    }

    // Ejecutar búsqueda.
    try { await page.keyboard.press('Enter'); } catch {}
    await page.waitForTimeout(1500);
    const buttonLabels = ['Buscar','Consultar','Filtrar','Ver oportunidades','Aplicar'];
    for(const label of buttonLabels){
      try{
        const btn = page.getByText(label, { exact:false }).first();
        if(await btn.isVisible({ timeout:1500 })){
          await btn.click({ timeout:5000 });
          console.log('[OPENNEGOCIO] click botón:', label);
          break;
        }
      }catch(e){}
    }

    await page.waitForTimeout(10000);
    console.log('[OPENNEGOCIO] respuestas capturadas:', apiDebug.length);

    if(apiItems.length){
      console.log('[OPENNEGOCIO] resultados por API:', apiItems.length);
      const byId = new Map();
      apiItems.forEach(o=>byId.set(o.external_id, o));
      return [...byId.values()].slice(0,25);
    }

    const extracted = await page.evaluate((kw)=>{
      const clean = s => String(s||'').replace(/\s+/g,' ').trim();
      const kw0 = String(kw||'').toLowerCase().split(' ')[0];
      const selectors = [
        'tr', '[role=row]', '.card', '.mat-row', '.MuiTableRow-root', '.ant-table-row',
        'li', 'article', '.resultado', '.result', '.item', '.panel', '.table tbody tr',
        'app-card', 'app-procedimiento', 'app-oportunidad'
      ];
      const out=[];
      for(const sel of selectors){
        document.querySelectorAll(sel).forEach((el)=>{
          const text = clean(el.innerText || el.textContent || '');
          if(text.length > 30 && (!kw0 || text.toLowerCase().includes(kw0))) out.push(text);
        });
      }
      if(!out.length){
        const body = clean(document.body.innerText || '');
        const chunks = body.split(/(?=\b(?:MUNICIPALIDAD|GOBIERNO|HOSPITAL|MINISTERIO|UNIVERSIDAD|UGEL|DIRECCI[ÓO]N|ADQUISICI[ÓO]N|CONTRATACI[ÓO]N|BIENES|SERVICIOS)\b)/i);
        chunks.forEach(c=>{ if(c.length>50 && (!kw0 || c.toLowerCase().includes(kw0))) out.push(c.slice(0,1000)); });
      }
      return [...new Set(out)].slice(0,40);
    }, keyword);

    console.log('[OPENNEGOCIO] textos extraídos:', extracted.length);
    const rows = extracted.map((txt,i)=>textToOpportunity(txt, keyword, i, SEACE_URLS.openNegocio)).filter(Boolean);
    return rows.slice(0,25);
  } finally {
    await browser.close();
  }
}

async function searchContratosMenoresFallback(keyword){
  // Fallback simple: abre contratos menores y extrae texto si el portal responde.
  let chromium;
  ({ chromium } = await import('playwright'));
  const browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage({ userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36' });
  try{
    await page.goto(SEACE_URLS.contratosMenores, { waitUntil:'domcontentloaded', timeout:45000 });
    await page.waitForTimeout(6000);
    const inputs = await page.locator('input:not([type=hidden]), textarea').all();
    for(const input of inputs){
      try{
        if(await input.isVisible({ timeout:1000 })){
          const box = await input.boundingBox();
          if(box && box.width > 40 && box.height > 12){ await input.fill(keyword); break; }
        }
      }catch(e){}
    }
    try { await page.keyboard.press('Enter'); } catch {}
    await page.waitForTimeout(6000);
    const texts = await page.evaluate((kw)=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const kw0=String(kw||'').toLowerCase().split(' ')[0];
      return [...document.querySelectorAll('tr,[role=row],.card,li,article')]
        .map(el=>clean(el.innerText||el.textContent||''))
        .filter(t=>t.length>30 && (!kw0 || t.toLowerCase().includes(kw0)))
        .slice(0,30);
    }, keyword);
    return texts.map((txt,i)=>textToOpportunity(txt, keyword, i, SEACE_URLS.contratosMenores)).filter(Boolean);
  }finally{ await browser.close(); }
}

async function searchSeaceRealForKeyword(keyword){
  const all = [];
  try{
    const rows = await searchOpenNegocioWithBrowser(keyword);
    all.push(...rows);
  }catch(e){
    console.error('[OPENNEGOCIO] error:', e.message);
  }

  if(!all.length){
    try{
      console.log('[FALLBACK] intentando contratos menores:', keyword);
      const rows = await searchContratosMenoresFallback(keyword);
      all.push(...rows);
    }catch(e){
      console.error('[FALLBACK] error:', e.message);
    }
  }

  if(!all.length && (!process.env.SEACE_STRICT || process.env.SEACE_STRICT !== 'true')){
    all.push(normalizeOpportunity({
      external_id: `opennegocio-pending-${keyword}-${new Date().toISOString().slice(0,10)}`,
      title: `Pendiente validar en Open Negocio: ${keyword}`,
      entity: 'Open Negocio SEACE/OECE',
      region: 'Nacional',
      published_date: new Date().toISOString().slice(0,10),
      source_url: SEACE_URLS.openNegocio
    }, keyword));
  }

  const byId = new Map();
  all.filter(Boolean).forEach(o=>byId.set(o.external_id, o));
  return [...byId.values()].slice(0,25);
}

async function getActiveKeywords(){
  const rows = await table('keywords');
  const words = rows.map(r=>r.keyword || r.name || r.text || r.palabra).filter(Boolean);
  return [...new Set(words.length ? words : demo.keywords.map(k=>k.keyword))].slice(0,30);
}

async function searchSeace(keywordOverride=null){
  const keywords = keywordOverride ? [keywordOverride] : await getActiveKeywords();
  const found = [];
  const errors = [];
  for(const keyword of keywords){
    try{
      const rows = await searchSeaceRealForKeyword(keyword);
      found.push(...rows);
    } catch(e){
      errors.push({ keyword, error:e.message });
      console.error('SEACE keyword error', keyword, e.message);
    }
  }
  const byId = new Map();
  found.forEach(o=>{ if(o?.external_id) byId.set(o.external_id, o); });
  return { items:[...byId.values()], errors };
}

async function upsertOpportunities(items){
  if(!items.length) return table('opportunities');
  if(!supabase){ demo.opportunities = items.concat(demo.opportunities).slice(0,100); return demo.opportunities; }
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
  const transport = nodemailer.createTransport({ host:process.env.SMTP_HOST, port:Number(process.env.SMTP_PORT||587), secure:String(process.env.SMTP_SECURE||'false') === 'true', auth:{ user:process.env.SMTP_USER, pass:process.env.SMTP_PASS } });
  const recipients = vendors.map(v=>v.email).filter(Boolean).join(',');
  if(!recipients) return { ok:false, message:'No hay vendedores configurados' };
  await transport.sendMail({ from:process.env.MAIL_FROM || process.env.SMTP_USER, to:recipients, subject:`${opportunities.length} oportunidades SEACE detectadas`, html:renderEmail(opportunities) });
  return { ok:true, recipients };
}

app.get('/', (_,res)=>res.json({ ok:true, app:'SEACE Alertas Grupo Ibero', endpoints:['/api/health','/api/bootstrap','/api/jobs/search-now'], source:'Open Negocio' }));
app.get('/api/health', (_,res)=>res.json({ ok:true, supabase:!!supabase, mode:'opennegocio-browser-v1', version:'0.8.0' }));
app.get('/api/bootstrap', async (_,res,next)=>{ try{ res.json({ keywords:await table('keywords'), vendors:await table('vendors'), opportunities:await table('opportunities') }); } catch(e){ next(e); } });
app.post('/api/jobs/search', async (_,res,next)=>{ try{ const result = await searchSeace(); const opportunities = await upsertOpportunities(result.items || []); res.json({ ok:true, found:result.items.length, errors:result.errors, opportunities }); } catch(e){ next(e); } });
app.get('/api/jobs/search-now', async (req,res,next)=>{
  console.log('ENTRO A SEARCH NOW', req.query);
  try{
    const keyword = req.query.keyword ? String(req.query.keyword) : 'mobiliario escolar';
    const result = await searchSeace(keyword);
    await upsertOpportunities(result.items || []);
    res.json({ ok:true, source:'Open Negocio', keyword, found:result.items ? result.items.length : 0, errors:result.errors || [], items:result.items || [] });
  }catch(err){ next(err); }
});
app.post('/api/jobs/send-digest', async (_,res,next)=>{ try{ res.json(await sendDigest()); } catch(e){ next(e); } });
app.use((err,_,res,__)=>res.status(500).json({ error:err.message, stack:process.env.NODE_ENV === 'production' ? undefined : err.stack }));

const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
cron.schedule(schedule, async()=>{ try{ const result = await searchSeace(); await upsertOpportunities(result.items || []); await sendDigest(); console.log('cron ok', result.items.length); } catch(e){ console.error('cron error', e); } });

app.listen(process.env.PORT || 3000, ()=>console.log(`SEACE backend Open Negocio v0.8.0 on ${process.env.PORT || 3000}`));
