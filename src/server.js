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

const VERSION = '0.7.0';

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
  const source_url = clean(raw.source_url || raw.url || raw.link || raw.enlace || SEACE_URLS.buscadorPublico);
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

function textToOpportunity(text, keyword, index=0, sourceUrl=SEACE_URLS.buscadorPublico){
  const joined = clean(text);
  if(!joined || joined.length < 30) return null;
  const lower = joined.toLowerCase();
  const k0 = String(keyword || '').toLowerCase().split(' ')[0];
  if(k0 && !lower.includes(k0)) return null;

  const amountMatch = joined.match(/S\/?\s*([0-9][0-9.,]+)/i) || joined.match(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)\b/);
  const dateMatch = joined.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/) || joined.match(/\b\d{4}\-\d{2}\-\d{2}\b/);
  const parts = joined.split(/(?= Municipalidad| Gobierno Regional| Ministerio| Hospital| Universidad| UGEL| Dirección| Adquisición| Contratación)/i).map(clean).filter(Boolean);
  const title = parts.find(p=>/(mobiliario|silla|mesa|carpeta|locker|armario|hospital|melamine|estante|escritorio|adquisici[oó]n|contrataci[oó]n)/i.test(p)) || joined.slice(0,220);
  const entity = parts.find(p=>/(municipalidad|gobierno regional|ministerio|hospital|universidad|ugel|direcci[oó]n|unidad ejecutora|instituto)/i.test(p)) || 'Entidad no identificada';

  return normalizeOpportunity({
    external_id: makeId(['seace-browser', keyword, index, entity, title, dateMatch?.[0] || new Date().toISOString().slice(0,10)]),
    title,
    entity,
    region:'No especificada',
    amount: amountMatch?.[1] || null,
    published_date: dateMatch?.[0] || new Date().toISOString().slice(0,10),
    source_url: sourceUrl
  }, keyword);
}

async function searchWithBrowser(keyword){
  let chromium;
  try{
    ({ chromium } = await import('playwright'));
  } catch(e){
    throw new Error('Playwright no está instalado en Render. Revisa package.json.');
  }

  const browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage({ userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' });

  const diagnostics = [];
  const rows = [];

  try{
    const urlsToTry = [SEACE_URLS.buscadorPublico, SEACE_URLS.contratosMenores];

    for(const url of urlsToTry){
      try{
        diagnostics.push(`Abriendo: ${url}`);
        await page.goto(url, { waitUntil:'domcontentloaded', timeout:45000 });
        await page.waitForTimeout(4000);

        const bodyText = await page.locator('body').innerText({ timeout:5000 }).catch(()=>'');

        if(/ruta no v[aá]lida|invalid path/i.test(bodyText)){
          diagnostics.push(`SEACE devolvió ruta inválida en: ${url}`);
          continue;
        }

        diagnostics.push(`Página cargada. Texto inicial: ${clean(bodyText).slice(0,160)}`);

        // Intenta llenar cualquier campo visible.
        const inputs = await page.locator('input:not([type=hidden]), textarea').all();
        let filled = false;
        for(const input of inputs){
          try{
            if(await input.isVisible({ timeout:1000 })){
              const box = await input.boundingBox();
              if(box && box.width > 40 && box.height > 12){
                await input.fill(keyword, { timeout:3000 });
                filled = true;
                break;
              }
            }
          }catch{}
        }
        diagnostics.push(filled ? 'Se llenó campo de búsqueda.' : 'No se encontró campo de búsqueda visible.');

        try { await page.keyboard.press('Enter'); } catch {}
        await page.waitForTimeout(1500);

        for(const label of ['Buscar','Consultar','Filtrar','Search']){
          try{
            const btn = page.getByText(label, { exact:false }).first();
            if(await btn.isVisible({ timeout:1200 })){
              await btn.click({ timeout:3000 });
              diagnostics.push(`Click en botón: ${label}`);
              break;
            }
          }catch{}
        }

        await page.waitForTimeout(7000);

        const extracted = await page.evaluate((kw)=>{
          const clean = s => String(s||'').replace(/\s+/g,' ').trim();
          const kw0 = String(kw||'').toLowerCase().split(' ')[0];
          const selectors = ['tr','[role=row]','.card','.mat-row','.MuiTableRow-root','.ant-table-row','li','article','div'];
          const out=[];
          for(const sel of selectors){
            document.querySelectorAll(sel).forEach((el)=>{
              const text = clean(el.innerText || el.textContent || '');
              if(text.length > 45 && text.length < 1200 && (!kw0 || text.toLowerCase().includes(kw0))) out.push(text);
            });
          }
          return [...new Set(out)].slice(0,40);
        }, keyword);

        diagnostics.push(`Bloques extraídos: ${extracted.length}`);

        extracted.forEach((txt,i)=>{
          const opp = textToOpportunity(txt, keyword, i, url);
          if(opp) rows.push(opp);
        });

        if(rows.length) break;
      } catch(e){
        diagnostics.push(`Error en ${url}: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  return { rows, diagnostics };
}

async function searchSeaceRealForKeyword(keyword){
  const { rows, diagnostics } = await searchWithBrowser(keyword);
  const byId = new Map();
  rows.filter(Boolean).forEach(o=>byId.set(o.external_id, o));
  return { items:[...byId.values()].slice(0,25), diagnostics };
}

async function getActiveKeywords(){
  const rows = await table('keywords');
  const words = rows.map(r=>r.keyword || r.name || r.text || r.palabra).filter(Boolean);
  return [...new Set(words.length ? words : demo.keywords.map(k=>k.keyword))].slice(0,30);
}

async function searchSeace(singleKeyword=null){
  const keywords = singleKeyword ? [singleKeyword] : await getActiveKeywords();
  const found = [];
  const errors = [];
  const diagnostics = [];
  for(const keyword of keywords){
    try{
      const result = await searchSeaceRealForKeyword(keyword);
      found.push(...(result.items || []));
      diagnostics.push({ keyword, steps: result.diagnostics || [] });
    } catch(e){
      errors.push({ keyword, error:e.message });
      console.error('SEACE keyword error', keyword, e.message);
    }
  }
  const byId = new Map();
  found.forEach(o=>{ if(o?.external_id) byId.set(o.external_id, o); });
  return { items:[...byId.values()], errors, diagnostics };
}

async function upsertOpportunities(items){
  if(!items?.length) return [];
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

app.get('/', (_,res)=>res.json({ ok:true, app:'SEACE Alertas Grupo Ibero', version:VERSION, endpoints:['/api/health','/api/bootstrap','/api/jobs/search-now'] }));

app.get('/api/health', (_,res)=>res.json({ ok:true, supabase:!!supabase, mode:'seace-browser-diagnostics-v1', version:VERSION }));

app.get('/api/bootstrap', async (_,res,next)=>{
  try{
    res.json({
      keywords: await table('keywords'),
      vendors: await table('vendors'),
      opportunities: await table('opportunities')
    });
  } catch(e){ next(e); }
});

app.post('/api/jobs/search', async (_,res,next)=>{
  try{
    const result = await searchSeace();
    const opportunities = await upsertOpportunities(result.items || []);
    res.json({ ok:true, found:result.items.length, errors:result.errors, diagnostics:result.diagnostics, opportunities });
  } catch(e){ next(e); }
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
      found: result.items.length,
      saved_total: Array.isArray(saved) ? saved.length : null,
      errors: result.errors,
      diagnostics: result.diagnostics,
      items: result.items || []
    });
  }catch(err){ next(err); }
});

app.post('/api/jobs/send-digest', async (_,res,next)=>{
  try{ res.json(await sendDigest()); } catch(e){ next(e); }
});

app.use((err,_,res,__)=>res.status(500).json({ ok:false, error:err.message, version:VERSION }));

const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
cron.schedule(schedule, async()=>{
  try{
    const result = await searchSeace();
    await upsertOpportunities(result.items || []);
    await sendDigest();
    console.log('cron ok', result.items.length);
  } catch(e){ console.error('cron error', e); }
});

app.listen(process.env.PORT || 3000, ()=>console.log(`SEACE backend v${VERSION} on ${process.env.PORT || 3000}`));
