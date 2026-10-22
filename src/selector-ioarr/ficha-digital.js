// ============================================================================
// src/selector-ioarr/ficha-digital.js — Ficha de verificación llenada en la app
//
// El supervisor de campo llena la ficha de cada colegio asignado en Visitas de
// campo (/campo.html → src/public/campo-ficha.js) y la envía a revisión; el
// proveedor la aprueba o la devuelve en Expediente → Fichas. Tabla campo_fichas
// (migración 023).
//
// Lo llenado (datos) se convierte a la misma estructura que devuelve leerFicha()
// al leer el Excel, así pasa por procesarFicha() sin cambios: mismas reglas y el
// mismo resultado en el inventario verificado.
//
//   limpiarFormulario(d)              lo que se guarda en campo_fichas.datos
//   fichaDesdeFormulario(d, meta)     → estructura de leerFicha() para procesarFicha()
//   puedeEditar(estado)               el supervisor solo cambia un borrador o una ficha observada
//   leerFichaDigital / estadosFichas / guardarFichaDigital   acceso a la tabla
// ============================================================================

import { VERSION_FICHA, FIRMAS } from './ficha.js';
import { TIPOS } from './costos.js';

export const ESTADOS_DIGITAL = { borrador: 'Borrador', enviada: 'Por revisar', observada: 'Observada', aprobada: 'Aprobada' };
export const AVISO_MIGRACION_FICHAS = 'Para llenar la ficha en la app falta ejecutar supabase/migrations/023_campo_fichas.sql en Supabase';
export const faltaMigracion = e => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
export const puedeEditar = estado => !estado || estado === 'borrador' || estado === 'observada';

const MAX_AULAS = 500, MAX_FILAS_AULA = 20, MAX_FUERA = 30, MAX_SERVICIOS = 40;
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const arr = v => Array.isArray(v) ? v : [];
// Texto recortado; null si está vacío. Las cantidades también van como texto: las valida procesarFicha
const txt = (v, max = 300) => {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, max);
  return s === '' ? null : s;
};
const num = v => txt(v, 12);
const fila = f => ({
  k: TIPOS.includes(f.k) ? f.k : null, b: num(f.b), r: num(f.r), m: num(f.m), puestos: num(f.puestos),
  antig: txt(f.antig, 40), patrimonial: txt(f.patrimonial, 500), baja: txt(f.baja, 20), obs: txt(f.obs, 500)
});

/** Lo llenado en el formulario, sin nada de más ni textos enormes. */
export function limpiarFormulario(d) {
  d = obj(d);
  const a = obj(d.a);
  const servicios = {};
  for (const [m, s] of Object.entries(obj(d.servicios)).slice(0, MAX_SERVICIOS)) {
    if (!/^\d{5,10}$/.test(m)) continue;
    const x = { est: num(obj(s).est), obs: txt(obj(s).obs, 300) };
    if (x.est != null || x.obs != null) servicios[m] = x;
  }
  const aulas = {};
  for (const [j, au] of Object.entries(obj(d.aulas))) {
    const n = Number(j);
    if (!Number.isInteger(n) || n < 0 || n >= MAX_AULAS) continue;
    const filas = arr(obj(au).filas).slice(0, MAX_FILAS_AULA).map(f => fila(obj(f))).filter(f => f.k);
    const est = num(obj(au).est);
    if (filas.length || est != null) aulas[n] = { est, filas };
  }
  const fuera = arr(d.fuera).slice(0, MAX_FUERA).map(f => {
    f = obj(f);
    return { ambiente: txt(f.ambiente, 120), bien: txt(f.bien, 120), b: num(f.b), r: num(f.r), m: num(f.m), antig: txt(f.antig, 40), obs: txt(f.obs, 500) };
  }).filter(f => Object.values(f).some(v => v != null));
  const firmas = {};
  for (const [k] of FIRMAS) {
    const f = obj(obj(d.firmas)[k]);
    const x = { nombre: txt(f.nombre, 200), dni: txt(f.dni, 20), fecha: txt(f.fecha, 10) };
    if (x.nombre || x.dni) firmas[k] = x;
  }
  const nAulas = Number(d.n_aulas), anio = Number(d.anio);
  return {
    version: VERSION_FICHA, n_aulas: Number.isInteger(nAulas) && nAulas >= 0 ? nAulas : null, anio: Number.isInteger(anio) ? anio : null,
    a: { fecha: txt(a.fecha, 10), verificador: txt(a.verificador, 200), acompanante: txt(a.acompanante, 200), coord: txt(a.coord, 60) },
    servicios, aulas, fuera, obs: txt(d.obs, 1000), firmas
  };
}

/**
 * Lo llenado → la estructura de leerFicha(). En lugar del número de fila del Excel,
 * cada parte lleva dónde está en el formulario («Aula 3», «Cód. modular …»).
 * @param d     datos ya limpios (limpiarFormulario)
 * @param meta  { proyectoId, cod, region }
 */
export function fichaDesdeFormulario(d, { proyectoId, cod, region }) {
  d = limpiarFormulario(d);
  const aula = j => `Aula ${Number(j) + 1}`;
  return {
    meta: { version: d.version, proyecto_id: proyectoId || '', cod_local: cod, region: region || '', anio_datos: d.anio, n_aulas: d.n_aulas },
    a: Object.fromEntries(Object.entries(d.a).map(([k, v]) => [k, { v }])),
    servicios: Object.entries(d.servicios).map(([modular, s]) => ({ modular, est: s.est, obs: s.obs, fila: `Cód. modular ${modular}` })),
    aulas: Object.fromEntries(Object.entries(d.aulas).map(([j, a]) => [j, { j: Number(j), fila: aula(j), est: a.est, filas: a.filas.map(f => ({ ...f, fila: aula(j) })) }])),
    fuera: d.fuera.map((f, n) => ({ ...f, fila: `Fuera de aulas, fila ${n + 1}` })),
    fotos: [], firmas: d.firmas, obs: d.obs
  };
}

// Nombre con que la ficha queda en el inventario (lo que en el Excel es el nombre del archivo)
export const origenDigital = email => `Ficha digital${email ? ' de ' + email : ''}`.slice(0, 200);

// ─── Tabla campo_fichas ─────────────────────────────────────────────────────
const COLS = 'codigo_local, estado, editado_por, editado_por_email, enviada_en, revisada_en, nota_revision, actualizado_en';
const vista = f => f && ({ cod: f.codigo_local, estado: f.estado, estado_texto: ESTADOS_DIGITAL[f.estado], por: f.editado_por_email || '', por_id: f.editado_por || null,
  enviada_en: f.enviada_en, revisada_en: f.revisada_en, nota: f.nota_revision || null, actualizado_en: f.actualizado_en, ...(f.datos ? { datos: f.datos } : {}) });

/** Una ficha con lo llenado; null si no hay. Lanza el error de Supabase (también si falta la migración). */
export async function leerFichaDigital(sb, proyectoId, cod) {
  const { data, error } = await sb.from('campo_fichas').select(COLS + ', datos').eq('proyecto_id', proyectoId).eq('codigo_local', cod).maybeSingle();
  if (error) throw error;
  return vista(data);
}

/** { cod: { estado, … } } de un proyecto (sin lo llenado); null si falta la migración 023. */
export async function estadosFichas(sb, proyectoId) {
  const out = {};
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb.from('campo_fichas').select(COLS).eq('proyecto_id', proyectoId).order('codigo_local').range(desde, desde + 999);
    if (error) { if (faltaMigracion(error)) return null; throw error; }
    for (const f of data) out[f.codigo_local] = vista(f);
    if (data.length < 1000) return out;
  }
}

/** Crea o cambia la ficha de un local. cambios: columnas de campo_fichas. */
export async function guardarFichaDigital(sb, proyectoId, cod, cambios) {
  const { data, error } = await sb.from('campo_fichas')
    .upsert({ proyecto_id: proyectoId, codigo_local: cod, ...cambios, actualizado_en: new Date().toISOString() }, { onConflict: 'proyecto_id,codigo_local' })
    .select(COLS + ', datos').single();
  if (error) throw error;
  return vista(data);
}
