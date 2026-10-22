// src/selector-ioarr/campo.js — API de Visitas de campo (/campo.html).
// Proyectos del Selector IOARR (solo lectura): limitan la búsqueda por cercanía a sus colegios.
//   GET /api/campo/proyectos      → [{ id, nombre, region, n_locales }]
//   GET /api/campo/proyectos/:id  → { id, nombre, region, locales: [códigos] }
// Colegios visitados (migración 021, tabla campo_visitas; una fila por local):
//   GET    /api/campo/visitas          → { códigoLocal: { fecha, por, mia } }
//   PUT    /api/campo/visitas/:codigo  → marca el local como visitado ({ fecha? } 'AAAA-MM-DD', por defecto hoy en Perú)
//   DELETE /api/campo/visitas/:codigo  → lo desmarca (el supervisor, solo lo que marcó él; el proveedor, cualquiera)
// Acceso (ver crearProteccionApi en src/ioarr/auth.js): proveedor y supervisor de campo.
//   proveedor  → solo sus proyectos
//   supervisor → todos los proyectos, pero solo nombre, región y códigos de local
import express from 'express';
import { supabase } from '../ioarr/db.js';

const LOTE = 1000;
const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));
const faltaMigracion = e => e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
export const AVISO_MIGRACION_CAMPO = 'Falta ejecutar supabase/migrations/011_ioarr_selector.sql en Supabase';
export const AVISO_MIGRACION_VISITAS = 'Para marcar colegios visitados falta ejecutar supabase/migrations/021_campo_visitas.sql en Supabase';

// El supervisor ve todos los proyectos; los demás, solo los suyos
const delUsuario = (q, usuario) => usuario.rol === 'supervisor' ? q : q.eq('usuario_id', usuario.id);

export async function listarProyectosCampo(sb, usuario) {
  const { data, error } = await delUsuario(sb.from('ioarr_selector_proyectos')
    .select('id, nombre, region, actualizado_en, locales:ioarr_selector_locales(count)'), usuario)
    .order('actualizado_en', { ascending: false });
  if (error) throw error;
  return data.map(p => ({ id: p.id, nombre: p.nombre, region: p.region, n_locales: p.locales?.[0]?.count ?? 0 }));
}

// null si no existe o no le corresponde al usuario
export async function proyectoCampo(sb, usuario, id) {
  if (!esUuid(id)) return null;
  const { data: p, error } = await delUsuario(sb.from('ioarr_selector_proyectos')
    .select('id, nombre, region').eq('id', id), usuario).maybeSingle();
  if (error) throw error;
  if (!p) return null;
  const locales = [];
  for (let desde = 0; ; desde += LOTE) {
    const { data, error: e } = await sb.from('ioarr_selector_locales').select('codigo_local')
      .eq('proyecto_id', p.id).order('codigo_local').range(desde, desde + LOTE - 1);
    if (e) throw e;
    locales.push(...data.map(r => r.codigo_local));
    if (data.length < LOTE) break;
  }
  return { id: p.id, nombre: p.nombre, region: p.region, locales };
}

// ─── Colegios visitados ─────────────────────────────────────────────────────
const esCodigo = c => /^\d{4,12}$/.test(String(c || ''));
// Fecha de hoy en Perú (UTC−5, sin horario de verano)
export const hoyPeru = (ahora = Date.now()) => new Date(ahora - 5 * 3600e3).toISOString().slice(0, 10);
// 'AAAA-MM-DD' válida, desde 2020 y no después de hoy; si no, null
export function fechaVisita(f, hoy = hoyPeru()) {
  if (f == null || f === '') return hoy;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  const d = new Date(f + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== f) return null;
  return f >= '2020-01-01' && f <= hoy ? f : null;
}

export async function listarVisitas(sb, usuario) {
  const mapa = {};
  for (let desde = 0; ; desde += LOTE) {
    const { data, error } = await sb.from('campo_visitas').select('codigo_local, fecha, visitado_por, visitado_por_email')
      .order('codigo_local').range(desde, desde + LOTE - 1);
    if (error) throw error;
    for (const v of data) mapa[v.codigo_local] = { fecha: v.fecha, por: v.visitado_por_email || '', mia: v.visitado_por === usuario.id };
    if (data.length < LOTE) break;
  }
  return mapa;
}

// → { status, body }
export async function marcarVisita(sb, usuario, codigo, { fecha } = {}) {
  if (!esCodigo(codigo)) return { status: 400, body: { error: 'Código de local no válido' } };
  const f = fechaVisita(fecha);
  if (!f) return { status: 400, body: { error: 'Fecha de visita no válida: usa AAAA-MM-DD, desde 2020 y no después de hoy' } };
  const fila = { codigo_local: codigo, fecha: f, visitado_por: usuario.id, visitado_por_email: usuario.email || null, actualizado_en: new Date().toISOString() };
  const { error } = await sb.from('campo_visitas').upsert(fila, { onConflict: 'codigo_local' });
  if (error) throw error;
  return { status: 200, body: { codigo, fecha: f, por: fila.visitado_por_email || '', mia: true } };
}

export async function desmarcarVisita(sb, usuario, codigo) {
  if (!esCodigo(codigo)) return { status: 400, body: { error: 'Código de local no válido' } };
  const { data: v, error } = await sb.from('campo_visitas').select('visitado_por').eq('codigo_local', codigo).maybeSingle();
  if (error) throw error;
  if (!v) return { status: 200, body: { codigo, borrado: false } };
  if (usuario.rol !== 'proveedor' && v.visitado_por !== usuario.id) return { status: 403, body: { error: 'Solo quien marcó la visita (o un proveedor) puede desmarcarla' } };
  const { error: e } = await sb.from('campo_visitas').delete().eq('codigo_local', codigo);
  if (e) throw e;
  return { status: 200, body: { codigo, borrado: true } };
}

export function crearApiCampo(sb = supabase) {
  const api = express.Router();
  const fallo = (res, next) => e => faltaMigracion(e) ? res.status(503).json({ error: AVISO_MIGRACION_CAMPO }) : next(e);
  api.use((req, res, next) => {
    if (!sb) return res.status(503).json({ error: 'Supabase no configurado' });
    if (!req.usuario?.id) return res.status(401).json({ error: 'Inicia sesión' });
    next();
  });
  api.get('/proyectos', (req, res, next) =>
    listarProyectosCampo(sb, req.usuario).then(d => res.json(d), fallo(res, next)));
  api.get('/proyectos/:id', (req, res, next) =>
    proyectoCampo(sb, req.usuario, req.params.id)
      .then(p => p ? res.json(p) : res.status(404).json({ error: 'Proyecto no encontrado' }), fallo(res, next)));

  const falloVisitas = (res, next) => e => faltaMigracion(e) ? res.status(503).json({ error: AVISO_MIGRACION_VISITAS }) : next(e);
  const enviar = res => r => res.status(r.status).json(r.body);
  api.get('/visitas', (req, res, next) =>
    listarVisitas(sb, req.usuario).then(d => res.json(d), falloVisitas(res, next)));
  api.put('/visitas/:codigo', (req, res, next) =>
    marcarVisita(sb, req.usuario, req.params.codigo, req.body || {}).then(enviar(res), falloVisitas(res, next)));
  api.delete('/visitas/:codigo', (req, res, next) =>
    desmarcarVisita(sb, req.usuario, req.params.codigo).then(enviar(res), falloVisitas(res, next)));
  return api;
}
