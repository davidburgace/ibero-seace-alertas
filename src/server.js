import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL?.split(',') || '*' }));
app.use(express.json());

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const demo = {
  keywords: ['mobiliario escolar','carpetas escolares','lockers','armarios metálicos','mobiliario hospitalario','melamine'],
  vendors: [
    { name:'Vendedor Educación', email:'educacion@grupoibero.com', line:'Educación' },
    { name:'Vendedor Hospitalario', email:'hospitalario@grupoibero.com', line:'Hospitalario' }
  ],
  opportunities: [
    { title:'Adquisición de mobiliario escolar para institución educativa', entity:'Gobierno Regional', region:'Lima', amount:120000, published_date:'2026-05-25', business_line:'Educación', status:'Nuevo', source_url:'#', alert_sent:false },
    { title:'Adquisición de lockers metálicos', entity:'Municipalidad Distrital', region:'Arequipa', amount:48000, published_date:'2026-05-25', business_line:'Metalmecánica', status:'Nuevo', source_url:'#', alert_sent:false }
  ]
};

async function table(name){
  if(!supabase) return demo[name] || [];
  const { data, error } = await supabase.from(name).select('*').order('created_at', { ascending:false });
  if(error) throw error;
  return data;
}

function classify(text=''){
  const t = text.toLowerCase();
  if(t.includes('hospital') || t.includes('clínic') || t.includes('cama')) return 'Hospitalario';
  if(t.includes('escolar') || t.includes('carpeta') || t.includes('coleg')) return 'Educación';
  if(t.includes('locker') || t.includes('metálic') || t.includes('armario')) return 'Metalmecánica';
  if(t.includes('melamine') || t.includes('oficina') || t.includes('escritorio')) return 'Oficina';
  return 'General';
}

async function searchSeaceMock(){
  // Conector temporal: mantiene la app funcionando mientras se implementa extracción real de SEACE/OECE.
  const today = new Date().toISOString().slice(0,10);
  return [
    { external_id:`mock-${today}-1`, title:'Adquisición de mobiliario escolar', entity:'Unidad Ejecutora Educación', region:'Lima', amount:150000, published_date:today, source_url:'https://prodapp2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml' },
    { external_id:`mock-${today}-2`, title:'Adquisición de armarios y lockers metálicos', entity:'Municipalidad Provincial', region:'Junín', amount:70000, published_date:today, source_url:'https://prodapp2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml' },
    { external_id:`mock-${today}-3`, title:'Mobiliario hospitalario para establecimiento de salud', entity:'Dirección Regional de Salud', region:'Arequipa', amount:210000, published_date:today, source_url:'https://prodapp2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml' }
  ].map(o=>({...o,business_line:classify(o.title),status:'Nuevo',alert_sent:false}));
}

async function upsertOpportunities(items){
  if(!supabase){ demo.opportunities = items.concat(demo.opportunities).slice(0,20); return demo.opportunities; }
  const { error } = await supabase.from('opportunities').upsert(items, { onConflict:'external_id' });
  if(error) throw error;
  return table('opportunities');
}

function renderEmail(opportunities){
  const cards = opportunities.slice(0,10).map(o=>`<div style="border:1px solid #e7eaf0;border-radius:14px;padding:14px;margin:0 0 12px;background:#fff"><h3 style="margin:0 0 8px;font-size:16px">${o.title}</h3><p style="margin:0 0 10px;color:#475467;line-height:1.45"><b>Entidad:</b> ${o.entity}<br><b>Región:</b> ${o.region}<br><b>Monto:</b> ${o.amount ? 'S/ '+Number(o.amount).toLocaleString('es-PE') : 'Sin monto'}<br><b>Línea:</b> ${o.business_line}</p><a href="${o.source_url}" style="display:block;background:#0f766e;color:#fff;text-align:center;text-decoration:none;border-radius:12px;padding:12px;font-weight:700">Ver oportunidad</a></div>`).join('');
  return `<div style="font-family:Arial,sans-serif;background:#f6f7fb;padding:16px"><div style="max-width:480px;margin:auto"><div style="background:#174e8f;color:#fff;border-radius:16px 16px 0 0;padding:18px"><h2 style="margin:0">Alertas SEACE</h2><p style="margin:6px 0 0">${opportunities.length} oportunidades detectadas</p></div><div style="background:#fff;padding:14px;border:1px solid #e7eaf0;border-top:0;border-radius:0 0 16px 16px">${cards}<p style="font-size:12px;color:#667085">Sistema de Alertas Comerciales - Grupo Ibero</p></div></div></div>`;
}

async function sendDigest(){
  const opportunities = await table('opportunities');
  const vendors = await table('vendors');
  if(!process.env.SMTP_HOST) return { ok:false, message:'SMTP no configurado' };
  const transport = nodemailer.createTransport({ host:process.env.SMTP_HOST, port:Number(process.env.SMTP_PORT||587), secure:false, auth:{ user:process.env.SMTP_USER, pass:process.env.SMTP_PASS } });
  const recipients = vendors.map(v=>v.email).filter(Boolean).join(',');
  if(!recipients) return { ok:false, message:'No hay vendedores configurados' };
  await transport.sendMail({ from:process.env.MAIL_FROM, to:recipients, subject:`${opportunities.length} oportunidades SEACE detectadas`, html:renderEmail(opportunities) });
  return { ok:true, recipients };
}

app.get('/api/health', (_,res)=>res.json({ok:true, supabase:!!supabase}));
app.get('/api/bootstrap', async (_,res,next)=>{try{res.json({keywords:await table('keywords'),vendors:await table('vendors'),opportunities:await table('opportunities')});}catch(e){next(e)}});
app.post('/api/jobs/search', async (_,res,next)=>{try{const found=await searchSeaceMock(); const opportunities=await upsertOpportunities(found); res.json({ok:true,opportunities});}catch(e){next(e)}});
app.post('/api/jobs/send-digest', async (_,res,next)=>{try{res.json(await sendDigest());}catch(e){next(e)}});
app.use((err,_,res,__)=>res.status(500).json({error:err.message}));

const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
cron.schedule(schedule, async()=>{ try{ await upsertOpportunities(await searchSeaceMock()); await sendDigest(); console.log('cron ok'); } catch(e){ console.error('cron error',e); } });

app.listen(process.env.PORT || 3000, ()=>console.log(`SEACE backend on ${process.env.PORT || 3000}`));
