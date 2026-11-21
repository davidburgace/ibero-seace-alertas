// ============================================================================
// src/ioarr/alertas.js — Correo diario de Radar IOARR
// Se envía por src/correo.js (Resend por su API web o, sin RESEND_API_KEY, SMTP).
// Por cada configuración activa (ioarr_alertas_config) envía los proyectos
// NUEVOS y los CAMBIOS DE ESTADO desde el último envío, en sus regiones.
// ============================================================================

import { enviarCorreo, correoConfigurado, AVISO_CORREO } from '../correo.js';
import { supabase } from './db.js';

const FRONTEND_URL = process.env.FRONTEND_URL?.split(',')[0] || 'https://ibero-seace-alertas.onrender.com';
const UN_DIA = 24 * 60 * 60 * 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const soles = (n) => n == null ? '—' : 'S/ ' + Number(n).toLocaleString('es-PE', { maximumFractionDigits: 0 });

function filaHtml(p, extra = '') {
  return `<tr>
    <td style="padding:6px;border-bottom:1px solid #eee;font-family:monospace">${esc(p.cui)}</td>
    <td style="padding:6px;border-bottom:1px solid #eee">${esc(p.nombre)}${p.es_mobiliario ? ' 🪑' : ''}<br>
      <small style="color:#666">${esc(p.entidad || '')} · ${esc(p.region || '')}${p.provincia ? ' / ' + esc(p.provincia) : ''}</small></td>
    <td style="padding:6px;border-bottom:1px solid #eee;white-space:nowrap">${soles(p.monto_inversion)}</td>
    <td style="padding:6px;border-bottom:1px solid #eee">${esc(extra || p.estado)}</td>
  </tr>`;
}

function armarHtml(nuevos, cambios) {
  const tabla = (titulo, filas) => filas.length ? `
    <h3 style="font-family:sans-serif;margin:18px 0 6px">${titulo} (${filas.length})</h3>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px">${filas.join('')}</table>` : '';
  return `<div style="font-family:sans-serif;max-width:760px">
    <h2 style="margin:0 0 4px">Radar IOARR — resumen diario</h2>
    ${tabla('Proyectos nuevos', nuevos.map(p => filaHtml(p)))}
    ${tabla('Cambios de estado', cambios.map(c => filaHtml(c.proyecto, c.detalle)))}
    <p style="margin-top:18px"><a href="${FRONTEND_URL}/ioarr.html">Abrir Radar IOARR →</a></p>
    <p style="color:#888;font-size:11px;margin-top:18px">Información referencial obtenida de fuentes públicas; debe verificarse
    con la DGPPIP del MEF o un abogado antes de tomar decisiones.</p></div>`;
}

// Envía el resumen. Con { userId } solo procesa la configuración de ese usuario (botón "probar").
export async function sendIoarrDigest({ userId } = {}) {
  if (!supabase) return { ok: false, message: 'Supabase no configurado' };
  if (!correoConfigurado()) return { ok: false, message: AVISO_CORREO };

  let q = supabase.from('ioarr_alertas_config').select('*').eq('activo', true);
  if (userId) q = q.eq('user_id', userId);
  const { data: configs, error } = await q;
  if (error) throw error;

  const resultado = { ok: true, configuraciones: configs.length, enviados: 0, sin_novedades: 0 };
  for (const cfg of configs) {
    const desde = cfg.ultimo_envio || new Date(Date.now() - UN_DIA).toISOString();
    const ahora = new Date().toISOString();
    const regiones = cfg.regiones?.length ? cfg.regiones : ['LAMBAYEQUE'];

    let qn = supabase.from('ioarr_proyectos').select('*').gte('creado_en', desde).in('region', regiones);
    if (cfg.solo_mobiliario) qn = qn.eq('es_mobiliario', true);
    const { data: nuevos, error: e1 } = await qn.order('creado_en', { ascending: false }).limit(300);
    if (e1) throw e1;

    let qc = supabase.from('ioarr_eventos')
      .select('detalle, fecha, proyecto:ioarr_proyectos!inner(id, cui, nombre, entidad, region, provincia, monto_inversion, estado, es_mobiliario)')
      .eq('tipo', 'cambio_estado').gte('fecha', desde).in('proyecto.region', regiones);
    if (cfg.solo_mobiliario) qc = qc.eq('proyecto.es_mobiliario', true);
    const { data: eventos, error: e2 } = await qc.order('fecha', { ascending: false }).limit(300);
    if (e2) throw e2;

    const idsNuevos = new Set(nuevos.map(p => p.id));
    const cambios = eventos.filter(ev => !idsNuevos.has(ev.proyecto.id));

    if (nuevos.length || cambios.length) {
      await enviarCorreo({
        to: cfg.email,
        subject: `Radar IOARR: ${nuevos.length} nuevos, ${cambios.length} cambios de estado (${regiones.join(', ')})`,
        html: armarHtml(nuevos, cambios)
      });
      resultado.enviados++;
    } else {
      resultado.sin_novedades++;
    }
    await supabase.from('ioarr_alertas_config').update({ ultimo_envio: ahora }).eq('id', cfg.id);
  }
  return resultado;
}
