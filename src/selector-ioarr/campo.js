// src/selector-ioarr/campo.js — API de Visitas de campo (/campo.html).
// Proyectos del Selector IOARR (solo lectura): limitan la búsqueda por cercanía a sus colegios.
//   GET /api/campo/proyectos      → [{ id, nombre, region, n_locales }]
//   GET /api/campo/proyectos/:id  → { id, nombre, region, locales: [códigos],
//                                     asignaciones: { códigoLocal: supervisorId } | null (sin la migración 022),
//                                     supervisores: { supervisorId: correo } (los que tienen colegios del proyecto) }
// Reparto entre supervisores (migración 022, tabla campo_asignaciones; solo el proveedor dueño del proyecto):
//   GET /api/campo/supervisores                  → [{ id, email }] los usuarios con rol supervisor
//   PUT /api/campo/proyectos/:id/asignaciones    { asignaciones: { códigoLocal: supervisorId | null }, reemplazar? }
//   GET /api/campo/proyectos/:id/fichas-zip      fichas de verificación (Excel y PDF) de los colegios del supervisor que
//       las pide; el proveedor dueño, de todos (?paquete=<supervisorId>|sin para uno). Lo arma fichasZip (router.js)
//       reemplazar = true: el reparto completo (borra el anterior); si no, cambia solo esos colegios (null = sin asignar)
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
export const AVISO_MIGRACION_ASIGNACIONES = 'Para repartir colegios entre supervisores falta ejecutar supabase/migrations/022_campo_asignaciones.sql en Supabase';
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
  const { asignaciones, supervisores } = await asignacionesProyecto(sb, p.id);
  return { id: p.id, nombre: p.nombre, region: p.region, locales, asignaciones, supervisores };
}

// ─── Reparto entre supervisores ─────────────────────────────────────────────
// { asignaciones: { cod: supervisorId }, supervisores: { id: correo } }; sin la migración 022, asignaciones = null
export async function asignacionesProyecto(sb, proyectoId) {
  const asignaciones = {};
  for (let desde = 0; ; desde += LOTE) {
    const { data, error } = await sb.from('campo_asignaciones').select('codigo_local, supervisor_id')
      .eq('proyecto_id', proyectoId).order('codigo_local').range(desde, desde + LOTE - 1);
    if (error) { if (faltaMigracion(error)) return { asignaciones: null, supervisores: {} }; throw error; }
    for (const a of data) asignaciones[a.codigo_local] = a.supervisor_id;
    if (data.length < LOTE) break;
  }
  const ids = [...new Set(Object.values(asignaciones))];
  const supervisores = {};
  if (ids.length) {
    const { data, error } = await sb.from('perfiles').select('id, email').in('id', ids);
    if (error) throw error;
    for (const u of data) supervisores[u.id] = u.email || '';
  }
  return { asignaciones, supervisores };
}

// Paquetes de fichas de verificación según el reparto: uno por supervisor (en orden de correo) y
// «Sin asignar» al final si queda alguno. Sin reparto, un solo paquete sin carpeta (clave 'todos').
// → [{ clave: supervisorId | 'sin' | 'todos', email, carpeta, codigos }]
const carpetaDe = email => 'Supervisor_' + (String(email || '').split('@')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'sin_nombre');
export function paquetesFichas(codigos, asignaciones, supervisores = {}) {
  const hay = asignaciones && codigos.some(c => asignaciones[c]);
  if (!hay) return [{ clave: 'todos', email: '', carpeta: '', codigos: [...codigos] }];
  const por = new Map(), sin = [];
  for (const c of codigos) { const id = asignaciones[c]; if (!id) sin.push(c); else { if (!por.has(id)) por.set(id, []); por.get(id).push(c); } }
  const usadas = new Set();
  const out = [...por.entries()].sort(([a], [b]) => (supervisores[a] || '').localeCompare(supervisores[b] || '') || a.localeCompare(b)).map(([id, cods]) => {
    let carpeta = carpetaDe(supervisores[id]), k = 2;
    while (usadas.has(carpeta)) carpeta = carpetaDe(supervisores[id]) + '_' + k++;
    usadas.add(carpeta);
    return { clave: id, email: supervisores[id] || '', carpeta, codigos: cods };
  });
  if (sin.length) out.push({ clave: 'sin', email: '', carpeta: 'Sin_asignar', codigos: sin });
  return out;
}

export async function listarSupervisores(sb) {
  const { data, error } = await sb.from('perfiles').select('id, email').eq('rol', 'supervisor').order('email');
  if (error) throw error;
  return data.map(u => ({ id: u.id, email: u.email || '' }));
}

// → { status, body }. Solo el proveedor, y solo en sus proyectos (proyectoCampo lo filtra por dueño)
export async function guardarAsignaciones(sb, usuario, proyectoId, { asignaciones, reemplazar = false } = {}) {
  if (usuario.rol !== 'proveedor') return { status: 403, body: { error: 'Solo el proveedor reparte los colegios entre supervisores' } };
  if (!asignaciones || typeof asignaciones !== 'object' || Array.isArray(asignaciones)) return { status: 400, body: { error: 'Faltan las asignaciones' } };
  const p = await proyectoCampo(sb, usuario, proyectoId);
  if (!p) return { status: 404, body: { error: 'Proyecto no encontrado' } };
  if (p.asignaciones == null) return { status: 503, body: { error: AVISO_MIGRACION_ASIGNACIONES } };
  const delProyecto = new Set(p.locales);
  const fuera = Object.keys(asignaciones).filter(c => !delProyecto.has(c));
  if (fuera.length) return { status: 400, body: { error: `${fuera.length === 1 ? 'El local' : 'Los locales'} ${fuera.slice(0, 5).join(', ')} no ${fuera.length === 1 ? 'es' : 'son'} del proyecto` } };
  const sups = new Map((await listarSupervisores(sb)).map(u => [u.id, u.email]));
  const malos = [...new Set(Object.values(asignaciones).filter(id => id != null && !sups.has(id)))];
  if (malos.length) return { status: 400, body: { error: 'Solo se puede asignar a usuarios con rol de supervisor de campo' } };

  const ahora = new Date().toISOString();
  const filas = Object.entries(asignaciones).filter(([, id]) => id != null)
    .map(([cod, id]) => ({ proyecto_id: p.id, codigo_local: cod, supervisor_id: id, asignado_por: usuario.id, actualizado_en: ahora }));
  const quitar = Object.entries(asignaciones).filter(([, id]) => id == null).map(([cod]) => cod);
  if (reemplazar) {
    const { error } = await sb.from('campo_asignaciones').delete().eq('proyecto_id', p.id);
    if (error) throw error;
  } else {
    for (let i = 0; i < quitar.length; i += LOTE) {
      const { error } = await sb.from('campo_asignaciones').delete().eq('proyecto_id', p.id).in('codigo_local', quitar.slice(i, i + LOTE));
      if (error) throw error;
    }
  }
  for (let i = 0; i < filas.length; i += LOTE) {
    const { error } = await sb.from('campo_asignaciones').upsert(filas.slice(i, i + LOTE), { onConflict: 'proyecto_id,codigo_local' });
    if (error) throw error;
  }
  const r = await asignacionesProyecto(sb, p.id);
  return { status: 200, body: r };
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

// ¿Qué paquete de fichas puede bajar este usuario? → { paquete } o { status, error }
export async function paqueteFichasCampo(sb, usuario, proyectoId, pedido) {
  const p = await proyectoCampo(sb, usuario, proyectoId);
  if (!p) return { status: 404, error: 'Proyecto no encontrado' };
  if (usuario.rol === 'supervisor') {
    if (!p.asignaciones || !Object.values(p.asignaciones).includes(usuario.id)) return { status: 404, error: 'No tienes colegios asignados en este proyecto' };
    return { paquete: usuario.id };
  }
  return { paquete: pedido ? String(pedido) : null };
}

// deps.fichasZip(res, proyectoId, paquete): arma el ZIP (src/selector-ioarr/router.js → fichasZipProyecto)
export function crearApiCampo(sb = supabase, deps = {}) {
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

  const falloAsig = (res, next) => e => faltaMigracion(e) ? res.status(503).json({ error: AVISO_MIGRACION_ASIGNACIONES }) : next(e);
  api.get('/supervisores', (req, res, next) => req.usuario.rol !== 'proveedor'
    ? res.status(403).json({ error: 'Solo el proveedor ve la lista de supervisores' })
    : listarSupervisores(sb).then(d => res.json(d), next));
  api.put('/proyectos/:id/asignaciones', (req, res, next) =>
    guardarAsignaciones(sb, req.usuario, req.params.id, req.body || {}).then(r => res.status(r.status).json(r.body), falloAsig(res, next)));

  api.get('/proyectos/:id/fichas-zip', async (req, res, next) => {
    try {
      if (!deps.fichasZip) return res.status(503).json({ error: 'Las fichas no están disponibles' });
      const r = await paqueteFichasCampo(sb, req.usuario, req.params.id, req.query.paquete);
      if (r.error) return res.status(r.status).json({ error: r.error });
      await deps.fichasZip(res, req.params.id, r.paquete);
    } catch (e) { next(e); }
  });

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
