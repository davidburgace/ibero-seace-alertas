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
  buscadorPublico: 'https://prodapp2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml',
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
  const title = clean(raw.title || raw.descripcion || raw.descripcionObjeto || raw.descripcion_objeto || raw.objeto || raw.nombre || raw.requerimiento || raw.descripcionRequerimiento || raw.descripcion_de_requerimiento || raw.description);
  const entity = clean(raw.entity || raw.entidad || raw.nombreEntidad || raw.nombre_entidad || raw.entidadContratante || raw.nombreSiglaEntidad || raw.razonSocial || 'Entidad no identificada');
  const region = clean(raw.region || raw.departamento || raw.ubigeo || raw.lugar || raw.regionName || 'No especificada');
  const published_date = clean(raw.published_date || raw.fechaPublicacion || raw.fecha_publicacion || raw.fecha || raw.fechaInicio || raw.fechaEmision || new Date().toISOString().slice(0,10));
  const amount = moneyToNumber(raw.amount || raw.monto || raw.valorReferencial || raw.valor_referencial || raw.montoReferencial || raw.total);
  const source_url = clean(raw.source_url || raw.url || raw.link || raw.enlace || SEACE_URLS.contratosMenores);
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
  const text = Object.keys(o || {}).concat(Object.values(o || {}).map(v=>String(v).slice(0,40))).join(' ').toLowerCase();
  return /(entidad|descripcion|objeto|requerimiento|monto|fecha|contratacion|contratación|nomenclatura)/.test(text);
}

async function fetchJson(url, options={}, timeoutMs=20000){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    const res = await fetch(url, { ...options, signal:controller.signal, headers:{ 'accept':'application/json,text/plain,*/*', 'content-type':'application/json', 'user-agent':'Mozilla/5.0 SEACE Alertas Grupo Ibero', ...(options.headers || {}) } });
    const text = await res.text();
    if(!res.ok) throw new Error(`${res.status} ${text.slice(0,120)}`);
    try { return JSON.parse(text); } catch { return { html:text }; }
  } finally { clearTimeout(timer); }
}


async function discoverApiEndpoints(){
  // Mantiene el descubrimiento JSON como primer intento, pero ya no depende de que SEACE exponga una ruta fija.
  const htmlRes = await fetchJson(SEACE_URLS.contratosMenores, { headers:{ accept:'text/html,*/*' } }, 20000);
  const html = htmlRes.html || '';
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)].map(m=>new URL(m[1], SEACE_URLS.contratosMenores).href);
  const endpoints = new Set();
  for(const script of scripts.slice(-12)){
    try{
      const jsRes = await fetchJson(script, { headers:{ accept:'application/javascript,text/plain,*/*' } }, 20000);
      const js = jsRes.html || '';
      const matches = [...js.matchAll(/["'`]([^"'`]{0,160}(?:api|contrat|requerim|busc|convoc)[^"'`]{0,220})["'`]/gi)].map(m=>m[1]);
      for(const raw of matches){
        if(raw.includes('http') || raw.startsWith('/')) {
          try { endpoints.add(new URL(raw, SEACE_URLS.contratosMenores).href); } catch {}
        }
      }
    } catch(e){ console.warn('No se pudo leer asset SEACE', script, e.message); }
  }
  return [...endpoints].filter(u=>/api|contrat|requerim|busc|convoc/i.test(u)).slice(0,40);
}

async function tryEndpoint(endpoint, keyword){
  const candidates = [];
  const u = new URL(endpoint);
  for(const qName of ['q','query','search','texto','descripcion','palabraClave','keyword','term','filter']){
    const x = new URL(u.href); x.searchParams.set(qName, keyword); x.searchParams.set('page','0'); x.searchParams.set('size','20');
    candidates.push({ url:x.href, options:{ method:'GET' }});
  }
  const payloads = [
    { texto:keyword, page:0, size:20 },
    { descripcion:keyword, page:0, size:20 },
    { palabraClave:keyword, pagina:0, tamanio:20 },
    { search:keyword, page:0, size:20 },
    { filtro:keyword, page:0, size:20 },
    { term:keyword, offset:0, limit:20 }
  ];
  for(const body of payloads) candidates.push({ url:u.href, options:{ method:'POST', body:JSON.stringify(body) }});

  for(const c of candidates){
    try{
      const json = await fetchJson(c.url, c.options, 15000);
      if(json?.error || json?.mensaje?.toLowerCase?.().includes('ruta no')) continue;
      if(json.html) continue;
      const arrays = findArrays(json).sort((a,b)=>b.length-a.length);
      for(const arr of arrays){
        const rows = arr.filter(looksLikeOpportunity).map(r=>normalizeOpportunity(r, keyword)).filter(Boolean);
        if(rows.length) return rows;
      }
    } catch {}
  }
  return [];
}

function textToOpportunity(text, keyword, index=0){
  const lines = clean(text).split(/(?:\n|\r|\t|  +| \| )/).map(clean).filter(Boolean);
  const joined = clean(lines.join(' '));
  if(!joined || joined.length < 20) return null;
  const lower = joined.toLowerCase();
  if(keyword && !lower.includes(keyword.toLowerCase().split(' ')[0])) return null;
  const amountMatch = joined.match(/S\/?\s*([0-9][0-9.,]+)/i) || joined.match(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)\b/);
  const dateMatch = joined.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/) || joined.match(/\b\d{4}\-\d{2}\-\d{2}\b/);
  let title = lines.find(l=>l.length > 18 && /(mobiliario|silla|mesa|carpeta|locker|armario|hospital|melamine|estante|escritorio|bien|servicio|adquisici[oó]n|contrataci[oó]n)/i.test(l)) || joined.slice(0,220);
  let entity = lines.find(l=>/(municipalidad|gobierno regional|ministerio|hospital|universidad|ugel|direcci[oó]n|unidad ejecutora|proyecto especial|instituto)/i.test(l)) || 'Entidad no identificada';
  return normalizeOpportunity({
    external_id: makeId(['pw', keyword, index, entity, title, dateMatch?.[0] || new Date().toISOString().slice(0,10)]),
    title,
    entity,
    region: 'No especificada',
    amount: amountMatch?.[1] || null,
    published_date: dateMatch?.[0] || new Date().toISOString().slice(0,10),
    source_url: SEACE_URLS.contratosMenores
  }, keyword);
}

async function searchWithBrowser(keyword){
  let chromium;
  try{
    ({ chromium } = await import('playwright'));
  } catch(e){
    throw new Error('Playwright no está instalado en Render. Revisa que package.json versión 0.5.0 se haya desplegado.');
  }

  const browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage({ userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' });
  const rows = [];
  try{
    await page.goto(SEACE_URLS.contratosMenores, { waitUntil:'domcontentloaded', timeout:45000 });
    await page.waitForTimeout(5000);

    // Intenta escribir la palabra clave en el primer campo útil.
    const inputs = await page.locator('input:not([type=hidden]), textarea').all();
    for(const input of inputs){
      try{
        if(await input.isVisible({ timeout:1000 })){
          const box = await input.boundingBox();
          if(box && box.width > 40 && box.height > 12){
            await input.fill(keyword, { timeout:2000 });
            break;
          }
        }
      } catch {}
    }

    // Intenta activar búsqueda con Enter y/o botones Buscar/Consultar.
    try { await page.keyboard.press('Enter'); } catch {}
    await page.waitForTimeout(1500);
    for(const label of ['Buscar','Consultar','Filtrar','Search']){
      try{
        const btn = page.getByText(label, { exact:false }).first();
        if(await btn.isVisible({ timeout:1000 })) { await btn.click({ timeout:2000 }); break; }
      } catch {}
    }
    await page.waitForTimeout(7000);

    const extracted = await page.evaluate((kw)=>{
      const clean = s => String(s||'').replace(/\s+/g,' ').trim();
      const kw0 = String(kw||'').toLowerCase().split(' ')[0];
      const selectors = ['tr','[role=row]','.card','.mat-row','.MuiTableRow-root','.ant-table-row','li','article'];
      const out=[];
      for(const sel of selectors){
        document.querySelectorAll(sel).forEach((el)=>{
          const text = clean(el.innerText || el.textContent || '');
          if(text.length > 25 && (!kw0 || text.toLowerCase().includes(kw0))) out.push(text);
        });
      }
      if(!out.length){
        const body = clean(document.body.innerText || '');
        const chunks = body.split(/(?=\b(?:MUNICIPALIDAD|GOBIERNO|HOSPITAL|MINISTERIO|UNIVERSIDAD|UGEL|DIRECCI[ÓO]N|ADQUISICI[ÓO]N|CONTRATACI[ÓO]N)\b)/i);
        chunks.forEach(c=>{ if(c.length>40 && (!kw0 || c.toLowerCase().includes(kw0))) out.push(c.slice(0,800)); });
      }
      return [...new Set(out)].slice(0,30);
    }, keyword);

    extracted.forEach((txt,i)=>{
      const opp = textToOpportunity(txt, keyword, i);
      if(opp) rows.push(opp);
    });
  } finally {
    await browser.close();
  }
  return rows;
}

async function searchSeaceRealForKeyword(keyword){
  // 1) Intenta APIs internas JSON descubiertas dinámicamente.
  const all = [];
  try{
    const endpoints = await discoverApiEndpoints();
    for(const endpoint of endpoints){
      const rows = await tryEndpoint(endpoint, keyword);
      if(rows.length) all.push(...rows);
      if(all.length >= 20) break;
    }
  } catch(e){
    console.warn('Descubrimiento JSON no disponible:', e.message);
  }

  // 2) Si el JSON no funcionó, usa navegador automatizado para la SPA de SEACE.
  if(!all.length){
    try{
      const browserRows = await searchWithBrowser(keyword);
      all.push(...browserRows);
    } catch(e){
      console.error('Browser scraping error:', e.message);
      if(!process.env.SEACE_STRICT || process.env.SEACE_STRICT !== 'true'){
        all.push(normalizeOpportunity({
          external_id: `seace-pending-${keyword}-${new Date().toISOString().slice(0,10)}`,
          title: `Pendiente validar en SEACE: ${keyword}`,
          entity: 'Buscador Público SEACE/OECE',
          region: 'Nacional',
          published_date: new Date().toISOString().slice(0,10),
          source_url: SEACE_URLS.contratosMenores
        }, keyword));
      }
    }
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

app.get('/', (_,res)=>res.json({ ok:true, app:'SEACE Alertas Grupo Ibero', endpoints:['/api/health','/api/bootstrap','/api/jobs/search-now'] }));
app.get('/api/health', (_,res)=>res.json({ ok:true, supabase:!!supabase, mode:'seace-browser-v1', version:'0.5.0' }));
app.get('/api/bootstrap', async (_,res,next)=>{ try{ res.json({ keywords:await table('keywords'), vendors:await table('vendors'), opportunities:await table('opportunities') }); } catch(e){ next(e); } });
app.post('/api/jobs/search', async (_,res,next)=>{ try{ const result = await searchSeace(); const opportunities = await upsertOpportunities(result.items); res.json({ ok:true, found:result.items.length, errors:result.errors, opportunities }); } catch(e){ next(e); } });
// Ruta GET para probar desde navegador sin Postman ni terminal.
app.get('/api/jobs/search-now', async (req,res,next)=>{
  console.log("ENTRO A SEARCH NOW");
  console.log(req.query);

  try{
    const keyword = req.query.keyword ? String(req.query.keyword) : null;
    const result = await searchSeace(keyword);
    await upsertOpportunities(result.items || []);
    res.json({
      ok:true,
      test:true,
      keyword,
      found: result.items ? result.items.length : 0,
      items: result.items || [],
      errors: result.errors || []
    });
  }catch(err){
    next(err);
  }
});
app.post('/api/jobs/send-digest', async (_,res,next)=>{ try{ res.json(await sendDigest()); } catch(e){ next(e); } });
app.use((err,_,res,__)=>{ console.error('API ERROR:', err); res.status(500).json({ error:err.message }); });

const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
cron.schedule(schedule, async()=>{ try{ const result = await searchSeace(); await upsertOpportunities(result.items); await sendDigest(); console.log('cron ok', result.items.length); } catch(e){ console.error('cron error', e); } });

app.listen(process.env.PORT || 3000, ()=>console.log(`SEACE backend on ${process.env.PORT || 3000}`));
