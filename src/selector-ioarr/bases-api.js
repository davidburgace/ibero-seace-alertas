// ============================================================================
// src/selector-ioarr/bases-api.js — API del generador de bases OxI
//
// Se monta dentro de /api/selector-ioarr (router.js): sesión y rol proveedor.
// Solo el dueño del proyecto. Tablas: supabase/migrations/028_ioarr_bases_oxi.sql
//
//   GET    /proyectos/:id/bases            fichas del proyecto, IOARR (niveles) y definición de campos
//   POST   /proyectos/:id/bases            { nivel, nombre? } ficha nueva, precargada con lo que sabe la app
//   GET    /bases/:fid                     ficha + montos calculados + validación + cuadro de cantidades
//   PATCH  /bases/:fid                     { datos?, nombre? } (se fusiona con lo guardado)
//   POST   /bases/:fid/precargar           vuelve a tomar de la app lo que está vacío
//   POST   /bases/:fid/duplicar            { nombre?, nivel?, proyecto_id? }
//   DELETE /bases/:fid
//   GET    /bases/:fid/vista-previa        .docx con los marcadores pendientes (sin versión, no válido para publicar)
//   POST   /bases/:fid/exportar            valida (422 con los errores) → .docx y guarda la versión
//   GET    /bases/:fid/versiones           versiones exportadas (número, fecha, usuario)
//   GET    /bases/:fid/versiones/:v/docx   el .docx de esa versión, regenerado desde lo guardado
//   GET    /bases/:fid/comparar?a=1&b=2    diferencias entre dos versiones (b=actual: la ficha de ahora)
// ============================================================================

import express from 'express';
import { randomUUID } from 'node:crypto';
import { supabase } from '../ioarr/db.js';
import {
  limpiarFicha, validarFicha, calcularMontos, montoEnLetras, cuadroCantidades, precargar, contextoApp, compararFichas,
  SECCIONES, HASH_PLANTILLAS, DECLARACION, REGLAMENTO_PLANTILLAS, PROPUESTA_MIN, PROPUESTA_MAX, OBLIGATORIOS_DE
} from './bases.js';
import { ESPECIFICACIONES, NORMAS_SUGERIDAS } from './bases-especificaciones.js';
import { generarBasesDocx } from './word-bases.js';

export const AVISO_BASES = 'Falta ejecutar supabase/migrations/028_ioarr_bases_oxi.sql en Supabase para guardar las fichas de bases';
const faltaMigracion = e => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));
const NIVELES = ['I', 'P', 'S', 'E'];
const hoyLima = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(d);
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'bases';
const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const error = (status, msg) => Object.assign(new Error(msg), { status });
// Campos que dependen del nivel (al duplicar a otro nivel o proyecto se vuelven a tomar de la app)
const PROPIOS_NIVEL = ['NOMBRE_IOARR', 'CUI', 'MONTO_DOC_EQUIVALENTE', 'MONTO_EJECUCION', 'MONTO_SUP_EJECUCION', 'MONTO_SUP_DOC_EQUIVALENTE', 'PLAZO_EJECUCION_DIAS', 'sustento_ugel'];

export function crearApiBases({ expediente, preciosRef = null }) {
  const api = express.Router();
  const responder = fn => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) {
      if (faltaMigracion(e)) return res.status(503).json({ error: AVISO_BASES });
      if (e.status) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
      if (e.code === '23505') return res.status(409).json({ error: 'Otra exportación guardó esa versión al mismo tiempo; vuelve a intentarlo' });
      next(e);
    }
  };
  const ok = ({ data, error: e }) => { if (e) throw e; return data; };

  async function proyectoDe(id, usuarioId) {
    if (!esUuid(id)) return null;
    return ok(await supabase.from('ioarr_selector_proyectos').select('*').eq('id', id).eq('usuario_id', usuarioId).maybeSingle());
  }
  async function fichaDe(req) {
    if (!esUuid(req.params.fid)) throw error(404, 'Ficha no encontrada');
    const f = ok(await supabase.from('ioarr_bases_fichas').select('*').eq('id', req.params.fid).maybeSingle());
    const p = f && await proyectoDe(f.proyecto_id, req.usuario.id);
    if (!f || !p) throw error(404, 'Ficha no encontrada');
    return { f, p };
  }
  async function entidadRadar(p) {
    if (!p.ioarr_proyecto_id) return null;
    const { data } = await supabase.from('ioarr_proyectos').select('id, cui, nombre, entidad').eq('id', p.ioarr_proyecto_id).maybeSingle();
    return data || null;
  }
  // Lo que la app sabe de la IOARR de ese nivel. Sin locales o sin cálculo: contexto vacío con aviso.
  async function appDe(p, nivel) {
    try {
      const r = await expediente.modeloBases(p, nivel);
      // Precio por kit del catálogo de precios referenciales (nunca el precio propio)
      const precioRef = preciosRef ? await preciosRef.referenciaBases(p, r.nivel) : null;
      return { r, ctx: { ...contextoApp(r.M, r.nivel, r.nombre), precio_ref: precioRef }, aviso: null };
    } catch (e) {
      if (e.status && e.status < 500) return { r: null, ctx: { nivel, metas: [] }, aviso: e.message };
      throw e;
    }
  }
  async function precargaDe(p, nivel) {
    const [{ r, ctx, aviso }, radar] = await Promise.all([appDe(p, nivel), entidadRadar(p)]);
    return { ...(r ? precargar({ M: r.M, radar, datosDoc: r.datos }) : precargar({ M: null, radar })), ctx, aviso };
  }
  const numVersiones = async fid => ok(await supabase.from('ioarr_bases_versiones').select('version').eq('ficha_id', fid)).length;

  async function vista(f, p, extra = {}) {
    const d = limpiarFicha(f.datos);
    const { ctx, aviso } = extra.app || await appDe(p, f.nivel);
    const M = calcularMontos(d);
    return {
      ficha: { id: f.id, proyecto_id: f.proyecto_id, nivel: f.nivel, nombre: f.nombre, actualizado_en: f.actualizado_en },
      datos: d,
      calculados: { MONTO_SUPERVISION_TOTAL: M.supervision, MONTO_TOTAL: M.total, MONTO_TOTAL_LETRAS: montoEnLetras(M.total), ENTIDAD_MAYUS: d.ENTIDAD ? d.ENTIDAD.toLocaleUpperCase('es-PE') : '',
        propuesta: { min: M.min_bases, max: M.max_bases } },
      validacion: validarFicha(d, ctx),
      cantidades: cuadroCantidades(d, ctx),
      app: { nivel_nombre: ctx.nivel_nombre || null, escenario: ctx.escenario_texto || '', total_07c: ctx.total_07c ?? null, colegios: ctx.colegios ?? 0, borrador: !!ctx.borrador, aviso,
        precio_ref: ctx.precio_ref || null },
      versiones: await numVersiones(f.id),
      ...extra.respuesta
    };
  }

  // ─── Fichas del proyecto ──────────────────────────────────────────────────
  api.get('/proyectos/:id/bases', responder(async (req, res) => {
    const p = await proyectoDe(req.params.id, req.usuario.id);
    if (!p) throw error(404, 'Proyecto no encontrado');
    let fichas = [], sinMigracion = false;
    const r = await supabase.from('ioarr_bases_fichas').select('id, nivel, nombre, actualizado_en').eq('proyecto_id', p.id).order('creado_en');
    if (r.error) { if (!faltaMigracion(r.error)) throw r.error; sinMigracion = true; } else fichas = r.data;
    let niveles = [];
    try { niveles = await expediente.ioarrsBases(p); } catch (e) { if (!e.status) throw e; }
    res.json({ fichas, niveles, sin_migracion: sinMigracion, campos: SECCIONES, obligatorios_de: OBLIGATORIOS_DE, especificaciones: ESPECIFICACIONES, normas_sugeridas: NORMAS_SUGERIDAS,
      declaracion: DECLARACION, reglamento: REGLAMENTO_PLANTILLAS, propuesta: { min: PROPUESTA_MIN, max: PROPUESTA_MAX } });
  }));

  api.post('/proyectos/:id/bases', responder(async (req, res) => {
    const p = await proyectoDe(req.params.id, req.usuario.id);
    if (!p) throw error(404, 'Proyecto no encontrado');
    const nivel = String(req.body?.nivel || '');
    if (!NIVELES.includes(nivel)) throw error(400, 'Elige el nivel de la IOARR: Inicial, Primaria, Secundaria o Básica Especial (una ficha por nivel)');
    const niveles = await expediente.ioarrsBases(p);
    if (!niveles.some(x => x.nivel === nivel)) throw error(400, 'El proyecto no tiene una IOARR de ese nivel');
    const pre = await precargaDe(p, nivel);
    const datos = limpiarFicha({ ...pre.datos, _precarga: pre.datos, _precarga_notas: pre.notas });
    const nombre = String(req.body?.nombre || '').trim().slice(0, 200) || `Bases ${niveles.find(x => x.nivel === nivel).nombre}`;
    const f = ok(await supabase.from('ioarr_bases_fichas').insert({ id: randomUUID(), proyecto_id: p.id, nivel, nombre, datos, creado_por: req.usuario.id }).select('*').single());
    res.status(201).json(await vista(f, p, { app: pre }));
  }));

  // ─── Una ficha ────────────────────────────────────────────────────────────
  api.get('/bases/:fid', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    res.json(await vista(f, p));
  }));

  api.patch('/bases/:fid', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const cambios = {};
    if (req.body?.datos && typeof req.body.datos === 'object') {
      const { _precarga, _precarga_notas, ...nuevos } = req.body.datos;   // lo precargado solo lo cambia el servidor
      cambios.datos = limpiarFicha({ ...f.datos, ...nuevos, _precarga: f.datos?._precarga, _precarga_notas: f.datos?._precarga_notas });
    }
    if ('nombre' in (req.body || {})) {
      cambios.nombre = String(req.body.nombre || '').trim().slice(0, 200);
      if (!cambios.nombre) throw error(400, 'El nombre no puede quedar vacío');
    }
    const g = ok(await supabase.from('ioarr_bases_fichas').update(cambios).eq('id', f.id).select('*').single());
    res.json(await vista(g, p));
  }));

  // Vuelve a tomar de la app: solo llena lo vacío (no pisa lo que escribió el usuario)
  api.post('/bases/:fid/precargar', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const pre = await precargaDe(p, f.nivel), actual = limpiarFicha(f.datos), llenados = [];
    const datos = { ...actual };
    for (const [k, v] of Object.entries(pre.datos)) if (actual[k] == null || actual[k] === '') { datos[k] = v; llenados.push(k); }
    datos._precarga = { ...actual._precarga, ...Object.fromEntries(llenados.map(k => [k, pre.datos[k]])) };
    datos._precarga_notas = { ...actual._precarga_notas, ...Object.fromEntries(llenados.map(k => [k, pre.notas[k]])) };
    const g = ok(await supabase.from('ioarr_bases_fichas').update({ datos: limpiarFicha(datos) }).eq('id', f.id).select('*').single());
    res.json(await vista(g, p, { app: pre, respuesta: { llenados } }));
  }));

  api.post('/bases/:fid/duplicar', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const destino = req.body?.proyecto_id ? await proyectoDe(req.body.proyecto_id, req.usuario.id) : p;
    if (!destino) throw error(404, 'Proyecto de destino no encontrado');
    const nivel = req.body?.nivel ? String(req.body.nivel) : f.nivel;
    if (!NIVELES.includes(nivel)) throw error(400, 'Nivel no válido');
    let datos = limpiarFicha(f.datos), recargados = [];
    if (nivel !== f.nivel || destino.id !== p.id) {
      if (!(await expediente.ioarrsBases(destino)).some(x => x.nivel === nivel)) throw error(400, 'El proyecto de destino no tiene una IOARR de ese nivel');
      // Lo propio del nivel no se copia: se vuelve a tomar de la app (o queda vacío)
      const pre = await precargaDe(destino, nivel);
      for (const k of PROPIOS_NIVEL) { datos[k] = pre.datos[k] ?? null; delete datos._precarga[k]; delete datos._precarga_notas[k]; if (pre.datos[k] != null) { datos._precarga[k] = pre.datos[k]; datos._precarga_notas[k] = pre.notas[k]; } }
      datos.cantidades_ugel = {};
      datos = limpiarFicha(datos);
      recargados = PROPIOS_NIVEL;
    }
    const nombre = String(req.body?.nombre || '').trim().slice(0, 200) || `${f.nombre} (copia)`;
    const g = ok(await supabase.from('ioarr_bases_fichas').insert({ id: randomUUID(), proyecto_id: destino.id, nivel, nombre, datos, creado_por: req.usuario.id }).select('*').single());
    res.status(201).json(await vista(g, destino, { respuesta: { recargados } }));
  }));

  api.delete('/bases/:fid', responder(async (req, res) => {
    const { f } = await fichaDe(req);
    ok(await supabase.from('ioarr_bases_fichas').delete().eq('id', f.id));
    res.json({ ok: true });
  }));

  // ─── Word ─────────────────────────────────────────────────────────────────
  const enviarWord = (res, buf, archivo, cabeceras = {}) => res.set({
    'Content-Type': WORD, 'Cache-Control': 'no-store', ...cabeceras,
    'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`
  }).send(buf);
  const nombreArchivo = (d, f, v, fecha) => `Bases_OxI_${slug(d.N_PROCESO || f.nombre)}_${f.nivel}_${v ? 'v' + v : 'VISTA_PREVIA'}_${fecha}.docx`;

  // Vista previa: no bloquea, no guarda versión; el encabezado dice que no vale para publicar
  api.get('/bases/:fid/vista-previa', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const d = limpiarFicha(f.datos), { ctx } = await appDe(p, f.nivel), fecha = hoyLima();
    enviarWord(res, await generarBasesDocx({ datos: d, ctx, vistaPrevia: true, fecha }), nombreArchivo(d, f, null, fecha));
  }));

  api.post('/bases/:fid/exportar', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const d = limpiarFicha(f.datos), { ctx } = await appDe(p, f.nivel);
    const val = validarFicha(d, ctx);
    if (!val.ok) throw Object.assign(error(422, `No se puede exportar: ${val.errores.length} ${val.errores.length === 1 ? 'problema' : 'problemas'} por resolver`), { extra: { errores: val.errores } });
    const previas = ok(await supabase.from('ioarr_bases_versiones').select('version').eq('ficha_id', f.id));
    const version = Math.max(0, ...previas.map(v => v.version)) + 1, fecha = hoyLima(), usuario = req.usuario.email || '';
    const buf = await generarBasesDocx({ datos: d, ctx, version, fecha, usuario });
    const archivo = nombreArchivo(d, f, version, fecha);
    ok(await supabase.from('ioarr_bases_versiones').insert({
      ficha_id: f.id, version, datos: d, contexto: ctx, plantillas_hash: HASH_PLANTILLAS, archivo,
      resumen: { montos: val.montos, advertencias: val.advertencias.map(a => a.texto) }, usuario_id: req.usuario.id, usuario_email: usuario || null
    }));
    enviarWord(res, buf, archivo, { 'X-Bases-Version': String(version) });
  }));

  api.get('/bases/:fid/versiones', responder(async (req, res) => {
    const { f } = await fichaDe(req);
    const vs = ok(await supabase.from('ioarr_bases_versiones').select('version, creado_en, usuario_email, archivo, plantillas_hash, resumen').eq('ficha_id', f.id).order('version', { ascending: false }));
    res.json(vs.map(v => ({ version: v.version, fecha: v.creado_en, usuario: v.usuario_email, archivo: v.archivo, total: v.resumen?.montos?.total ?? null, plantillas_cambiaron: v.plantillas_hash !== HASH_PLANTILLAS })));
  }));

  async function versionDe(fid, n) {
    const v = ok(await supabase.from('ioarr_bases_versiones').select('*').eq('ficha_id', fid).eq('version', Number(n)).maybeSingle());
    if (!v) throw error(404, `No existe la versión ${n}`);
    return v;
  }
  api.get('/bases/:fid/versiones/:v/docx', responder(async (req, res) => {
    const { f } = await fichaDe(req);
    const v = await versionDe(f.id, req.params.v);
    const buf = await generarBasesDocx({ datos: limpiarFicha(v.datos), ctx: v.contexto || {}, version: v.version, fecha: hoyLima(new Date(v.creado_en)), usuario: v.usuario_email || '' });
    enviarWord(res, buf, v.archivo, v.plantillas_hash !== HASH_PLANTILLAS ? { 'X-Plantillas-Cambiaron': '1' } : {});
  }));

  api.get('/bases/:fid/comparar', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const lado = async x => x === 'actual' || x == null
      ? { etiqueta: 'Ficha actual', datos: limpiarFicha(f.datos), ctx: (await appDe(p, f.nivel)).ctx }
      : (v => ({ etiqueta: `Versión ${v.version}`, datos: limpiarFicha(v.datos), ctx: v.contexto || {} }))(await versionDe(f.id, x));
    const [A, B] = await Promise.all([lado(req.query.a), lado(req.query.b ?? 'actual')]);
    const cambios = compararFichas(A.datos, B.datos);
    // Lo que vino del cálculo de la app (cantidades y costos por bien)
    const metas = new Map();
    for (const [lado, x] of [['a', A], ['b', B]]) for (const m of x.ctx.metas || []) metas.set(m.k, { ...metas.get(m.k), nombre: m.nombre, [lado]: m });
    for (const [k, m] of metas) {
      if (m.a?.cantidad !== m.b?.cantidad) cambios.push({ k: 'app.cantidad.' + k, campo: `Cantidad de la app: ${m.nombre}`, antes: m.a?.cantidad ?? '—', despues: m.b?.cantidad ?? '—' });
      if (m.a?.costo !== m.b?.costo) cambios.push({ k: 'app.costo.' + k, campo: `Costo de la app: ${m.nombre}`, antes: m.a?.costo ?? '—', despues: m.b?.costo ?? '—' });
    }
    res.json({ a: A.etiqueta, b: B.etiqueta, cambios });
  }));

  return api;
}
