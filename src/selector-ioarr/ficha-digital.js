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

import { VERSION_FICHA, FIRMAS, generarFichaPdf } from './ficha.js';
import { TIPOS } from './costos.js';
import { BUCKET_EXPEDIENTE } from './archivos.js';

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
 * @param meta  { proyectoId, cod, region, fotos? (leerFotos: el panel fotográfico) }
 */
export function fichaDesdeFormulario(d, { proyectoId, cod, region, fotos }) {
  d = limpiarFormulario(d);
  const aula = j => `Aula ${Number(j) + 1}`;
  return {
    meta: { version: d.version, proyecto_id: proyectoId || '', cod_local: cod, region: region || '', anio_datos: d.anio, n_aulas: d.n_aulas },
    a: Object.fromEntries(Object.entries(d.a).map(([k, v]) => [k, { v }])),
    servicios: Object.entries(d.servicios).map(([modular, s]) => ({ modular, est: s.est, obs: s.obs, fila: `Cód. modular ${modular}` })),
    aulas: Object.fromEntries(Object.entries(d.aulas).map(([j, a]) => [j, { j: Number(j), fila: aula(j), est: a.est, filas: a.filas.map(f => ({ ...f, fila: aula(j) })) }])),
    fuera: d.fuera.map((f, n) => ({ ...f, fila: `Fuera de aulas, fila ${n + 1}` })),
    fotos: panelFotos(fotos), firmas: d.firmas, obs: d.obs
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

// ─── Fotos de la ficha (migración 024, tabla campo_fichas_fotos) ─────────────
// Se toman en el celular (campo-ficha.js), que las reduce, les pone el sello y arma
// una miniatura. Archivos en el bucket del expediente, en campo/<proyecto>/<local>/.
export const MAX_FOTOS_FICHA = 150;
export const MAX_FOTO = 15 * 1024 * 1024;   // el límite del bucket
export const AVISO_MIGRACION_FOTOS = 'Para tomar fotos en la ficha falta ejecutar supabase/migrations/024_campo_fichas_fotos.sql en Supabase';
export const MIMES_FOTO = ['image/jpeg', 'image/png', 'image/webp'];
const COLS_FOTO = 'id, aula, bien, muestra, ruta, ruta_mini, mime, tamano, lat, lon, tomada_en, subido_por_email, creado_en';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const esUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
export const rutaFoto = (proyectoId, cod, id, mime, mini = false) => `campo/${proyectoId}/${cod}/${id}${mini ? '_mini' : ''}.${EXT[mime] || 'jpg'}`;

/** Datos de una foto que manda el celular: dónde se tomó, qué muestra, coordenadas y hora. */
export function limpiarMetaFoto(b, ahora = Date.now()) {
  b = obj(b);
  const aula = b.aula === '' || b.aula == null ? null : Number(b.aula);
  const lat = Number(b.lat), lon = Number(b.lon);
  const coordOk = b.lat != null && b.lat !== '' && Number.isFinite(lat) && Number.isFinite(lon) && lat >= -19 && lat <= 0 && lon >= -82 && lon <= -68;
  const t = Date.parse(b.tomada_en);
  return {
    aula: Number.isInteger(aula) && aula >= 0 && aula < MAX_AULAS ? aula : null,
    bien: TIPOS.includes(b.bien) ? b.bien : null,
    muestra: txt(b.muestra, 200),
    lat: coordOk ? lat : null, lon: coordOk ? lon : null,
    tomada_en: Number.isFinite(t) && t > Date.UTC(2020, 0, 1) && t < ahora + 864e5 ? new Date(t).toISOString() : new Date(ahora).toISOString()
  };
}

const NOMBRE_BIEN = { mesa: 'Mesa del estudiante', silla: 'Silla del estudiante', esc: 'Escritorio docente', sdoc: 'Silla docente', arm: 'Armario o estante' };
/** «Fachada», «Aula 3», «Aula 3 · Silla del estudiante»… */
export function lugarFoto(f) {
  if (f.aula == null) return f.muestra || 'Local';
  return `Aula ${f.aula + 1}${f.bien ? ' · ' + NOMBRE_BIEN[f.bien] : ''}`;
}
const vistaFoto = f => ({ id: f.id, aula: f.aula, bien: f.bien, muestra: f.muestra, lugar: lugarFoto(f), mime: f.mime, tamano: f.tamano,
  lat: f.lat, lon: f.lon, tomada_en: f.tomada_en, por: f.subido_por_email || '', mini: !!f.ruta_mini });

/** Fotos de una ficha, en el orden en que se tomaron (con rutas: solo para el servidor). */
export async function leerFotos(sb, proyectoId, cod) {
  const { data, error } = await sb.from('campo_fichas_fotos').select(COLS_FOTO).eq('proyecto_id', proyectoId).eq('codigo_local', cod).order('tomada_en');
  if (error) throw error;
  return data;
}
/** Lo mismo, para el navegador (sin rutas); [] si falta la migración 024. */
export async function fotosFicha(sb, proyectoId, cod) {
  try { return (await leerFotos(sb, proyectoId, cod)).map(vistaFoto); }
  catch (e) { if (faltaMigracion(e)) return null; throw e; }
}
export const vistaDeFoto = vistaFoto;

// Panel fotográfico de la ficha: fachada y detalle de cada mueble en mal estado (avisos, no errores)
export function avisosFotos(datos, fotos) {
  if (!fotos) return [];
  const avisos = [];
  if (!fotos.some(f => f.aula == null && /fachada/i.test(f.muestra || ''))) avisos.push({ hoja: '—', fila: 'Panel fotográfico', motivo: 'Falta la foto de la fachada con el letrero de la institución.' });
  const sinFoto = [];
  for (const [j, a] of Object.entries(obj(obj(datos).aulas))) {
    const malos = new Set(arr(a.filas).filter(f => TIPOS.includes(f.k) && Number(f.m) > 0).map(f => f.k));
    for (const k of malos) if (!fotos.some(f => f.aula === Number(j) && f.bien === k)) sinFoto.push(`aula ${Number(j) + 1} (${NOMBRE_BIEN[k].toLowerCase()})`);
  }
  if (sinFoto.length) avisos.push({ hoja: '—', fila: 'Panel fotográfico', motivo: `Muebles en mal estado sin foto: ${sinFoto.slice(0, 8).join(', ')}${sinFoto.length > 8 ? ` y ${sinFoto.length - 8} más` : ''}.` });
  return avisos;
}

// Las fotos como el panel fotográfico de la ficha (sección D del Excel): van al inventario al aprobarla
export const panelFotos = fotos => (fotos || []).map((f, n) => ({ n: n + 1, ambiente: lugarFoto(f), muestra: f.aula == null ? f.muestra : (f.muestra || (f.bien ? 'Detalle del mueble' : 'Vista general del aula')), archivo: `Foto ${n + 1}` }));

// ─── Firmas en pantalla (migración 025, tabla campo_fichas_firmas) ───────────
export const CARGOS_FIRMA = FIRMAS.map(([k]) => k);           // director, ugel, registradora
export const NOMBRE_CARGO = Object.fromEntries(FIRMAS);
export const AVISO_MIGRACION_FIRMAS = 'Para firmar en la ficha falta ejecutar supabase/migrations/025_campo_fichas_firmas.sql en Supabase';
export const MAX_FIRMA = 1024 * 1024;
export const rutaFirma = (proyectoId, cod, cargo, ts = Date.now()) => `campo/${proyectoId}/${cod}/firma_${cargo}_${ts}.png`;

/** Filas de las firmas de una ficha (con rutas: solo para el servidor). */
export async function leerFirmas(sb, proyectoId, cod) {
  const { data, error } = await sb.from('campo_fichas_firmas').select('cargo, ruta, firmada_en, subido_por_email').eq('proyecto_id', proyectoId).eq('codigo_local', cod);
  if (error) throw error;
  return data;
}
/** { cargo: { firmada_en, por } } para el navegador; null si falta la migración 025. */
export async function firmasFicha(sb, proyectoId, cod) {
  try { return Object.fromEntries((await leerFirmas(sb, proyectoId, cod)).map(f => [f.cargo, { firmada_en: f.firmada_en, por: f.subido_por_email || '' }])); }
  catch (e) { if (faltaMigracion(e)) return null; throw e; }
}

// Conformidad: firma del director y del verificador de la UGEL, cada una con nombre (avisos, no errores)
export function avisosFirmas(datos, firmas, fotos = []) {
  if (!firmas) return [];
  const f = obj(obj(datos).firmas), avisos = [];
  const actaEnPapel = (fotos || []).some(x => x.aula == null && /acta/i.test(x.muestra || ''));
  const faltan = actaEnPapel ? [] : ['director', 'ugel'].filter(k => !firmas[k]);
  if (faltan.length) avisos.push({ hoja: '—', fila: 'Conformidad', motivo: `Falta la firma en pantalla de: ${faltan.map(k => NOMBRE_CARGO[k].toLowerCase()).join(' y ')}. Si firmaron en papel, adjunta la foto del acta firmada.` });
  const sinNombre = CARGOS_FIRMA.filter(k => firmas[k] && !txt(obj(f[k]).nombre));
  if (sinNombre.length) avisos.push({ hoja: '—', fila: 'Conformidad', motivo: `Firma sin nombre: ${sinNombre.map(k => NOMBRE_CARGO[k].toLowerCase()).join(', ')}. Escribe sus nombres y DNI.` });
  return avisos;
}

// ─── PDF de la ficha llena ──────────────────────────────────────────────────
async function bajar(sb, ruta) {
  const { data, error } = await sb.storage.from(BUCKET_EXPEDIENTE).download(ruta);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}
/**
 * PDF con lo llenado, las fotos y las firmas.
 * @param F      modeloFicha del local
 * @param ficha  leerFichaDigital (datos, estado, por, enviada_en, revisada_en)
 * Las fotos y las firmas se leen de sus tablas (sin las migraciones 024 o 025, el PDF sale sin ellas).
 */
export async function pdfFichaLlena(sb, proyectoId, cod, F, ficha) {
  const [fotos, firmas] = await Promise.all([
    leerFotos(sb, proyectoId, cod).catch(e => { if (faltaMigracion(e)) return []; throw e; }),
    leerFirmas(sb, proyectoId, cod).catch(e => { if (faltaMigracion(e)) return []; throw e; })
  ]);
  // Las fotos de a cuatro, para no pedir todas a la vez al bucket
  const buffers = [];
  for (let i = 0; i < fotos.length; i += 4) buffers.push(...await Promise.all(fotos.slice(i, i + 4).map(f => bajar(sb, f.ruta))));
  const panel = panelFotos(fotos);
  const llena = {
    datos: limpiarFormulario(ficha.datos), estado: ficha.estado, por: ficha.por, enviada_en: ficha.enviada_en, revisada_en: ficha.revisada_en,
    fotos: fotos.map((f, i) => ({ n: i + 1, lugar: panel[i].ambiente, muestra: panel[i].muestra, tomada_en: f.tomada_en, lat: f.lat, lon: f.lon, buffer: buffers[i] })),
    firmas: Object.fromEntries(await Promise.all(firmas.map(async f => [f.cargo, { firmada_en: f.firmada_en, buffer: await bajar(sb, f.ruta) }])))
  };
  return generarFichaPdf(F, llena);
}
export const nombrePdfLlena = F => `Ficha_verificacion_llena_${F.local.cod}.pdf`;
