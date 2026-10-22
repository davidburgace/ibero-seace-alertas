// src/selector-ioarr/campo.js — Proyectos del Selector IOARR en Visitas de campo (solo lectura).
// La página /campo.html limita la búsqueda por cercanía a los colegios de un proyecto.
//   GET /api/campo/proyectos      → [{ id, nombre, region, n_locales }]
//   GET /api/campo/proyectos/:id  → { id, nombre, region, locales: [códigos] }
// Acceso (ver crearProteccionApi en src/ioarr/auth.js): proveedor y supervisor de campo.
//   proveedor  → solo sus proyectos
//   supervisor → todos los proyectos, pero solo nombre, región y códigos de local
import express from 'express';
import { supabase } from '../ioarr/db.js';

const LOTE = 1000;
const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));
const faltaMigracion = e => e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
export const AVISO_MIGRACION_CAMPO = 'Falta ejecutar supabase/migrations/011_ioarr_selector.sql en Supabase';

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
  return api;
}
