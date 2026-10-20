// ============================================================================
// src/selector-ioarr/expediente.js — API del expediente IOARR (Etapa 1: costos)
//
// Se monta dentro de /api/selector-ioarr (router.js), detrás de la misma
// protección: sesión y rol proveedor. Tablas: supabase/migrations/012_ioarr_expediente_costos.sql
//
//   Catálogo compartido (todos los proveedores)
//     GET    /catalogo                          precios, UIT y factores por zona
//     POST   /catalogo/precios                  nuevo precio
//     PATCH  /catalogo/precios/:id              editar (vigente: true lo marca como el vigente de su tipo)
//     DELETE /catalogo/precios/:id
//     PUT    /catalogo/uit/:anio                { valor, fuente }
//     DELETE /catalogo/uit/:anio
//     PUT    /catalogo/factores                 alta o cambio por (ámbito, código)
//     DELETE /catalogo/factores/:id
//     GET    /catalogo/referencias?q=           precios leídos de estructuras de costos (Radar IOARR)
//     GET    /ubigeos?region=                   provincias y distritos de una región
//   Costos del proyecto (solo el dueño)
//     GET    /proyectos/:id/costos              parámetros + estructura de costos calculada
//     PATCH  /proyectos/:id/costos              { rubros?, anio_uit? }
//     PUT    /proyectos/:id/costos/precios/:tipo  { precio_id } fija un precio del catálogo
//     DELETE /proyectos/:id/costos/precios/:tipo  vuelve a usar el vigente del catálogo
//     GET    /proyectos/:id/costos/excel
// ============================================================================

import express from 'express';
import { supabase } from '../ioarr/db.js';
import { calc, limpiarParams, CRIT } from './calculo.js';
import { costear, limpiarRubros, TIPOS, FUENTES_PRECIO } from './costos.js';
import { generarExcelCostos } from './excel-costos.js';

const AVISO = 'Falta ejecutar supabase/migrations/012_ioarr_expediente_costos.sql en Supabase';
const faltaMigracion = e => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));
const texto = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const fechaValida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const hoyLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const anioLima = () => Number(hoyLima().slice(0, 4));
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proyecto';
const ok = d => { if (d.error) throw d.error; return d.data; };

// Valida un precio del catálogo. parcial = PATCH (solo los campos enviados)
function limpiarPrecio(b, parcial) {
  const out = {}, err = m => { const e = new Error(m); e.status = 400; throw e; };
  const tiene = k => !parcial || k in b;
  if (tiene('tipo_bien')) { if (!TIPOS.includes(b.tipo_bien)) err('Tipo de bien no válido'); out.tipo_bien = b.tipo_bien; }
  if (tiene('descripcion')) { out.descripcion = texto(b.descripcion); if (!out.descripcion) err('Escribe una descripción'); }
  if (tiene('precio')) {
    const p = Number(b.precio);
    if (!Number.isFinite(p) || p < 0 || p > 1e9) err('Precio no válido');
    out.precio = Math.round(p * 100) / 100;
  }
  if (tiene('unidad')) out.unidad = texto(b.unidad, 40) || 'unidad';
  if (tiene('fecha')) { if (!fechaValida(b.fecha)) err('Fecha no válida (AAAA-MM-DD)'); out.fecha = b.fecha; }
  if (tiene('fuente')) { if (!FUENTES_PRECIO[b.fuente]) err('Fuente no válida'); out.fuente = b.fuente; }
  if (tiene('observacion')) out.observacion = texto(b.observacion, 1000) || null;
  return out;
}

async function marcarVigente(id, tipo) {
  // Primero se quita el vigente actual del tipo (índice único parcial)
  ok(await supabase.from('ioarr_precios_catalogo').update({ vigente: false }).eq('tipo_bien', tipo).eq('vigente', true).neq('id', id));
  ok(await supabase.from('ioarr_precios_catalogo').update({ vigente: true }).eq('id', id));
}

/**
 * @param {object} deps funciones de router.js: proyectoDelUsuario(req), leerCodigos(id), cargarRegion(nombre), leerIndice()
 */
export function crearApiExpediente({ proyectoDelUsuario, leerCodigos, cargarRegion, leerIndice }) {
  const api = express.Router();
  const responder = (fn) => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) {
      if (faltaMigracion(e)) return res.status(503).json({ error: AVISO });
      if (e.status) return res.status(e.status).json({ error: e.message });
      if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un registro con esos datos' });
      next(e);
    }
  };

  // ─── Catálogo ─────────────────────────────────────────────────────────────
  api.get('/catalogo', responder(async (_, res) => {
    const [precios, uit, factores] = await Promise.all([
      supabase.from('ioarr_precios_catalogo').select('*').order('tipo_bien').order('vigente', { ascending: false }).order('fecha', { ascending: false }),
      supabase.from('ioarr_uit').select('*').order('anio', { ascending: false }),
      supabase.from('ioarr_factores_zona').select('*').order('ambito').order('codigo')
    ]);
    res.json({ precios: ok(precios), uit: ok(uit), factores: ok(factores) });
  }));

  api.post('/catalogo/precios', responder(async (req, res) => {
    const fila = limpiarPrecio(req.body || {}, false);
    const data = ok(await supabase.from('ioarr_precios_catalogo').insert({ ...fila, moneda: 'PEN', vigente: false, creado_por: req.usuario.id }).select('*').single());
    if (req.body?.vigente) await marcarVigente(data.id, data.tipo_bien);
    res.status(201).json({ ...data, vigente: !!req.body?.vigente });
  }));

  api.patch('/catalogo/precios/:id', responder(async (req, res) => {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Precio no encontrado' });
    const cambios = limpiarPrecio(req.body || {}, true);
    const actual = ok(await supabase.from('ioarr_precios_catalogo').select('*').eq('id', req.params.id).maybeSingle());
    if (!actual) return res.status(404).json({ error: 'Precio no encontrado' });
    const tipo = cambios.tipo_bien || actual.tipo_bien;
    // Si cambia de tipo, deja de ser el vigente del tipo anterior
    if (cambios.tipo_bien && cambios.tipo_bien !== actual.tipo_bien) cambios.vigente = false;
    if (req.body?.vigente === false) cambios.vigente = false;
    if (Object.keys(cambios).length) ok(await supabase.from('ioarr_precios_catalogo').update(cambios).eq('id', actual.id));
    if (req.body?.vigente === true) await marcarVigente(actual.id, tipo);
    res.json(ok(await supabase.from('ioarr_precios_catalogo').select('*').eq('id', actual.id).single()));
  }));

  api.delete('/catalogo/precios/:id', responder(async (req, res) => {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Precio no encontrado' });
    ok(await supabase.from('ioarr_precios_catalogo').delete().eq('id', req.params.id));
    res.json({ ok: true });
  }));

  api.put('/catalogo/uit/:anio', responder(async (req, res) => {
    const anio = Number(req.params.anio), valor = Number(req.body?.valor);
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) return res.status(400).json({ error: 'Año no válido' });
    if (!Number.isFinite(valor) || valor <= 0 || valor > 1e6) return res.status(400).json({ error: 'Valor de la UIT no válido' });
    res.json(ok(await supabase.from('ioarr_uit').upsert({ anio, valor: Math.round(valor * 100) / 100, fuente: texto(req.body?.fuente) || null }, { onConflict: 'anio' }).select('*').single()));
  }));

  api.delete('/catalogo/uit/:anio', responder(async (req, res) => {
    ok(await supabase.from('ioarr_uit').delete().eq('anio', Number(req.params.anio)));
    res.json({ ok: true });
  }));

  api.put('/catalogo/factores', responder(async (req, res) => {
    const b = req.body || {}, largo = { provincia: 4, distrito: 6, rural: 2 }[b.ambito];
    const codigo = String(b.codigo || '');
    if (!largo) return res.status(400).json({ error: 'Ámbito no válido' });
    if (!new RegExp(`^\\d{${largo}}$`).test(codigo)) return res.status(400).json({ error: `El código debe ser un ubigeo de ${largo} dígitos` });
    const pct = v => { const n = Number(v ?? 0); if (!Number.isFinite(n) || n < 0 || n > 500) { const e = new Error('Porcentaje no válido (0 a 500)'); e.status = 400; throw e; } return n; };
    res.json(ok(await supabase.from('ioarr_factores_zona').upsert({
      ambito: b.ambito, codigo, nombre: texto(b.nombre, 120) || null,
      pct_flete: pct(b.pct_flete), pct_instalacion: pct(b.pct_instalacion), observacion: texto(b.observacion, 500) || null
    }, { onConflict: 'ambito,codigo' }).select('*').single()));
  }));

  api.delete('/catalogo/factores/:id', responder(async (req, res) => {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Factor no encontrado' });
    ok(await supabase.from('ioarr_factores_zona').delete().eq('id', req.params.id));
    res.json({ ok: true });
  }));

  // Precios leídos de las estructuras de costos del Banco de Inversiones (Radar IOARR)
  api.get('/catalogo/referencias', responder(async (req, res) => {
    const q = String(req.query.q || '').replace(/[,()%*\\]/g, ' ').trim();
    let c = supabase.from('ioarr_precios_referencia').select('id, cui_origen, codigo_bien, descripcion, a, b, c, d, anio_ficha, fuente, cuadra')
      .order('anio_ficha', { ascending: false, nullsFirst: false }).limit(50);
    if (q) c = c.or(`descripcion.ilike.%${q}%,codigo_bien.ilike.%${q}%,cui_origen.ilike.%${q}%`);
    const { data, error } = await c;
    if (error) { if (faltaMigracion(error)) return res.json([]); throw error; }
    res.json(data);
  }));

  api.get('/ubigeos', responder(async (req, res) => {
    const D = await cargarRegion(String(req.query.region || ''));
    if (!D) return res.status(404).json({ error: 'Región no encontrada' });
    const provs = new Map();
    const distritos = D.dists.map(([nombre, ubigeo, ip]) => {
      provs.set(ubigeo.slice(0, 4), D.provs[ip]);
      return { codigo: ubigeo, nombre, provincia: D.provs[ip] };
    }).sort((a, b) => a.provincia.localeCompare(b.provincia, 'es') || a.nombre.localeCompare(b.nombre, 'es'));
    res.json({
      region: D.region, departamento: D.dists[0]?.[1].slice(0, 2) || null,
      provincias: [...provs].map(([codigo, nombre]) => ({ codigo, nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
      distritos
    });
  }));

  // ─── Costos del proyecto ──────────────────────────────────────────────────
  async function proyecto(req) {
    const p = await proyectoDelUsuario(req);
    if (!p) { const e = new Error('Proyecto no encontrado'); e.status = 404; throw e; }
    return p;
  }

  // Junta todo y calcula. Devuelve también lo necesario para el Excel.
  async function armar(p) {
    const [fila, fijados, vigentes, factores, D, codigos] = await Promise.all([
      supabase.from('ioarr_expediente_costos').select('*').eq('proyecto_id', p.id).maybeSingle().then(ok),
      supabase.from('ioarr_expediente_precios').select('*').eq('proyecto_id', p.id).then(ok),
      supabase.from('ioarr_precios_catalogo').select('*').eq('vigente', true).then(ok),
      supabase.from('ioarr_factores_zona').select('*').then(ok),
      cargarRegion(p.region),
      leerCodigos(p.id)
    ]);
    if (!D) { const e = new Error('No hay datos para la región ' + p.region); e.status = 400; throw e; }
    const anioUit = fila?.anio_uit || anioLima();
    const uit = ok(await supabase.from('ioarr_uit').select('*').eq('anio', anioUit).maybeSingle());

    // Precio de cada tipo: el fijado en el proyecto o, si no hay, el vigente del catálogo
    const vig = Object.fromEntries(vigentes.map(v => [v.tipo_bien, v]));
    const fij = Object.fromEntries(fijados.map(v => [v.tipo_bien, v]));
    const precios = {}, detalle = {};
    for (const t of TIPOS) {
      const f = fij[t], v = vig[t];
      if (f) {
        detalle[t] = { origen: 'proyecto', precio_id: f.precio_id, precio: Number(f.precio_unitario), descripcion: f.descripcion, fuente: f.fuente, fecha: f.fecha,
          // Aviso si el catálogo tiene otro vigente o si cambió el precio de origen
          vigente_distinto: v && (v.id !== f.precio_id || Number(v.precio) !== Number(f.precio_unitario)) ? { id: v.id, precio: Number(v.precio), descripcion: v.descripcion } : null };
      } else if (v) {
        detalle[t] = { origen: 'vigente', precio_id: v.id, precio: Number(v.precio), descripcion: v.descripcion, fuente: v.fuente, fecha: v.fecha, observacion: v.observacion };
      } else detalle[t] = { origen: null, precio: null };
      precios[t] = detalle[t].precio;
    }

    const cod = new Set(codigos), list = [];
    D.locs.forEach((l, i) => { if (cod.has(l[0])) list.push(i); });
    const P = limpiarParams(p.criterios);
    const R = costear({ D, C: calc(D, P), list, precios, rubros: fila?.rubros, factores, uit: { anio: anioUit, valor: uit?.valor ?? null } });
    return { R, P, detalle, anioUit, uit };
  }

  const vista = ({ R, detalle, anioUit, uit }) => ({
    anio_uit: anioUit, uit: uit || null, precios: detalle,
    rubros: R.rubros, partidas: R.partidas, totales: R.totales, distritos: R.distritos, uitCalc: R.uit, avisos: R.avisos,
    locales: R.locales.map(l => ({ cod: l.cod, nom: l.nom, dist: l.dist, prov: l.prov, rural: l.rural, est: l.est, zona: l.zona,
      rep: l.rep.reduce((a, b) => a + b, 0), fal: l.fal.reduce((a, b) => a + b, 0), cd: l.cd, total: l.total }))
  });

  api.get('/proyectos/:id/costos', responder(async (req, res) => {
    res.json(vista(await armar(await proyecto(req))));
  }));

  api.patch('/proyectos/:id/costos', responder(async (req, res) => {
    const p = await proyecto(req), b = req.body || {}, fila = { proyecto_id: p.id };
    if ('rubros' in b) fila.rubros = limpiarRubros(b.rubros);
    if ('anio_uit' in b) {
      const a = Number(b.anio_uit);
      if (!Number.isInteger(a) || a < 2000 || a > 2100) return res.status(400).json({ error: 'Año de la UIT no válido' });
      fila.anio_uit = a;
    }
    ok(await supabase.from('ioarr_expediente_costos').upsert(fila, { onConflict: 'proyecto_id' }));
    res.json(vista(await armar(p)));
  }));

  api.put('/proyectos/:id/costos/precios/:tipo', responder(async (req, res) => {
    const p = await proyecto(req), tipo = req.params.tipo;
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de bien no válido' });
    if (!esUuid(req.body?.precio_id)) return res.status(400).json({ error: 'Elige un precio del catálogo' });
    const c = ok(await supabase.from('ioarr_precios_catalogo').select('*').eq('id', req.body.precio_id).maybeSingle());
    if (!c || c.tipo_bien !== tipo) return res.status(400).json({ error: 'Ese precio no es de este tipo de bien' });
    ok(await supabase.from('ioarr_expediente_precios').upsert({
      proyecto_id: p.id, tipo_bien: tipo, precio_id: c.id, precio_unitario: c.precio, descripcion: c.descripcion, fuente: c.fuente, fecha: c.fecha,
      actualizado_en: new Date().toISOString()
    }, { onConflict: 'proyecto_id,tipo_bien' }));
    res.json(vista(await armar(p)));
  }));

  api.delete('/proyectos/:id/costos/precios/:tipo', responder(async (req, res) => {
    const p = await proyecto(req);
    ok(await supabase.from('ioarr_expediente_precios').delete().eq('proyecto_id', p.id).eq('tipo_bien', req.params.tipo));
    res.json(vista(await armar(p)));
  }));

  api.get('/proyectos/:id/costos/excel', responder(async (req, res) => {
    const p = await proyecto(req), A = await armar(p);
    if (!A.R.locales.length) return res.status(400).json({ error: 'El proyecto no tiene locales seleccionados' });
    const fecha = hoyLima();
    const buffer = await generarExcelCostos(A.R, {
      proyecto: p.nombre, region: p.region, fecha, ioarr: p.ioarr, fuente: (await leerIndice()).fuente,
      criterios: textoCriterios(A.P), precios: A.detalle
    });
    const archivo = `Costos_IOARR_${slug(p.nombre)}_${fecha}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
      'Cache-Control': 'no-store'
    }).send(buffer);
  }));

  return api;
}

export function textoCriterios(P) {
  const est = { b: 'Bueno', r: 'Regular', m: 'Malo' }[P.carpEstado];
  return CRIT.map(([k, l]) => `${l}: ${k === 'regPct' ? Math.round(P[k] * 100) + ' %' : P[k]}`).join(' · ') + ` · Estado asignado a las carpetas: ${est}`;
}

