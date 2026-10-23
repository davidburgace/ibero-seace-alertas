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
// Ficha de verificación en la app (migración 023, tabla campo_fichas; ver ficha-digital.js). El supervisor, solo
// en sus colegios asignados; el proveedor, en los de sus proyectos. La revisión la hace el proveedor en Expediente → Fichas.
//   GET  /api/campo/proyectos/:id/fichas              → { fichas: { códigoLocal: { estado, nota, … } } }
//   GET  /api/campo/proyectos/:id/fichas/:cod         → { modelo (padrón y censo), ficha (lo llenado) | null, editable }
//   PUT  /api/campo/proyectos/:id/fichas/:cod         { datos } guarda el borrador
//   POST /api/campo/proyectos/:id/fichas/:cod/enviar  { datos } valida como la importación del Excel y, sin errores,
//        la manda a revisión (422 con los errores si no). Marca el colegio como visitado si aún no lo está.
// Fotos de la ficha (migración 024, tabla campo_fichas_fotos; bucket ioarr-expediente, campo/<proyecto>/<local>/):
//   POST   /api/campo/proyectos/:id/fichas/:cod/fotos           multipart: foto, mini (miniatura), id (uuid del celular),
//          aula, bien, muestra, lat, lon, tomada_en. Reintentar con el mismo id no la duplica.
//   GET    /api/campo/proyectos/:id/fichas/:cod/fotos/:fotoId   la imagen (?mini=1 la miniatura)
//   DELETE /api/campo/proyectos/:id/fichas/:cod/fotos/:fotoId   solo con la ficha en borrador u observada
// Acceso (ver crearProteccionApi en src/ioarr/auth.js): proveedor y supervisor de campo.
//   proveedor  → solo sus proyectos
//   supervisor → todos los proyectos, pero solo nombre, región y códigos de local
import express from 'express';
import multer from 'multer';
import { supabase } from '../ioarr/db.js';
import { limpiarFormulario, leerFichaDigital, estadosFichas, guardarFichaDigital, puedeEditar, origenDigital,
  AVISO_MIGRACION_FICHAS, faltaMigracion as faltaMigracionFichas, fotosFicha, leerFotos, limpiarMetaFoto, rutaFoto, vistaDeFoto, avisosFotos,
  esUuid as esUuidFoto, MAX_FOTOS_FICHA, MAX_FOTO, MIMES_FOTO, AVISO_MIGRACION_FOTOS } from './ficha-digital.js';
import { BUCKET_EXPEDIENTE, mimeDe } from './archivos.js';
import { BIENES_FICHA, RANGOS, FIRMAS, CRITERIOS, MAX_PUESTOS, TOLERANCIA } from './ficha.js';

// Lo que el formulario necesita saber de la ficha (src/public/campo-ficha.js)
export const GUIA_FICHA = { bienes: BIENES_FICHA, rangos: RANGOS.map(r => r.texto), firmas: FIRMAS, criterios: CRITERIOS, max_puestos: MAX_PUESTOS, tolerancia: TOLERANCIA };

const LOTE = 1000;
const subidaFoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 2 } });
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

// ─── Ficha de verificación en la app ────────────────────────────────────────
// ¿Puede este usuario llenar la ficha de ese colegio? → { p } o { status, error }
export async function accesoFicha(sb, usuario, proyectoId, cod) {
  if (!esCodigo(cod)) return { status: 400, error: 'Código de local no válido' };
  const p = await proyectoCampo(sb, usuario, proyectoId);
  if (!p) return { status: 404, error: 'Proyecto no encontrado' };
  if (!p.locales.includes(cod)) return { status: 404, error: 'Ese colegio no está en el proyecto' };
  if (usuario.rol === 'supervisor' && p.asignaciones?.[cod] !== usuario.id) return { status: 403, error: 'Este colegio no está asignado a ti' };
  return { p };
}

// Estado de las fichas del proyecto: el supervisor ve solo las de sus colegios → { status, body }
export async function fichasDelUsuario(sb, usuario, proyectoId) {
  const p = await proyectoCampo(sb, usuario, proyectoId);
  if (!p) return { status: 404, body: { error: 'Proyecto no encontrado' } };
  const estados = await estadosFichas(sb, p.id);
  if (!estados) return { status: 503, body: { error: AVISO_MIGRACION_FICHAS } };
  const mias = usuario.rol === 'supervisor' ? new Set(Object.entries(p.asignaciones || {}).filter(([, id]) => id === usuario.id).map(([c]) => c)) : null;
  const fichas = Object.fromEntries(Object.entries(estados).filter(([c]) => !mias || mias.has(c)).map(([c, { por_id, ...f }]) => [c, f]));
  return { status: 200, body: { fichas } };
}

// deps.modelo(proyectoId, cod): la ficha del local con el padrón y el censo (modeloFicha)
export async function abrirFichaCampo(sb, usuario, proyectoId, cod, deps) {
  const acc = await accesoFicha(sb, usuario, proyectoId, cod);
  if (acc.error) return { status: acc.status, body: { error: acc.error } };
  const ficha = await leerFichaDigital(sb, acc.p.id, cod);
  const [modelo, fotos] = await Promise.all([deps.modelo(acc.p.id, cod), fotosFicha(sb, acc.p.id, cod)]);
  // fotos: null = falta la migración 024 (la ficha funciona sin fotos)
  return { status: 200, body: { modelo, ficha, editable: puedeEditar(ficha?.estado), guia: GUIA_FICHA, fotos } };
}

const quien = usuario => ({ editado_por: usuario.id, editado_por_email: usuario.email || null });
const YA_ENVIADA = f => f.estado === 'aprobada' ? 'La ficha ya fue aprobada: no se puede cambiar.' : 'La ficha ya está enviada a revisión: no se puede cambiar hasta que el proveedor la devuelva.';

export async function guardarBorradorFicha(sb, usuario, proyectoId, cod, { datos } = {}) {
  const acc = await accesoFicha(sb, usuario, proyectoId, cod);
  if (acc.error) return { status: acc.status, body: { error: acc.error } };
  const actual = await leerFichaDigital(sb, acc.p.id, cod);
  if (!puedeEditar(actual?.estado)) return { status: 409, body: { error: YA_ENVIADA(actual), ficha: actual } };
  const ficha = await guardarFichaDigital(sb, acc.p.id, cod, { estado: actual?.estado === 'observada' ? 'observada' : 'borrador', datos: limpiarFormulario(datos), ...quien(usuario) });
  return { status: 200, body: { ficha } };
}

// deps.validar(proyectoId, cod, datos, origen): procesarFicha con el contexto del proyecto (como la importación)
export async function enviarFicha(sb, usuario, proyectoId, cod, { datos } = {}, deps) {
  const acc = await accesoFicha(sb, usuario, proyectoId, cod);
  if (acc.error) return { status: acc.status, body: { error: acc.error } };
  const actual = await leerFichaDigital(sb, acc.p.id, cod);
  if (!puedeEditar(actual?.estado)) return { status: 409, body: { error: YA_ENVIADA(actual), ficha: actual } };
  const limpio = limpiarFormulario(datos);
  const fotos = actual ? await fotosFicha(sb, acc.p.id, cod) : [];
  const r = await deps.validar(acc.p.id, cod, limpio, origenDigital(usuario.email));
  r.avisos = [...r.avisos, ...avisosFotos(limpio, fotos)];
  if (r.rechazada || r.errores.length) {
    // Lo llenado no se pierde: queda como borrador
    const ficha = await guardarFichaDigital(sb, acc.p.id, cod, { estado: actual?.estado === 'observada' ? 'observada' : 'borrador', datos: limpio, ...quien(usuario) });
    return { status: 422, body: { error: 'La ficha tiene errores: corrígelos y vuelve a enviarla.', errores: r.errores, avisos: r.avisos, ficha } };
  }
  const ficha = await guardarFichaDigital(sb, acc.p.id, cod, { estado: 'enviada', datos: limpio, enviada_en: new Date().toISOString(), ...quien(usuario) });
  // El colegio queda visitado con la fecha de la ficha, si nadie lo marcó antes (sin la migración 021, nada)
  try {
    const { data: v, error } = await sb.from('campo_visitas').select('codigo_local').eq('codigo_local', cod).maybeSingle();
    if (!error && !v) await marcarVisita(sb, usuario, cod, { fecha: limpio.a.fecha });
  } catch (e) { console.warn('[CAMPO] No se pudo marcar la visita al enviar la ficha:', e.message); }
  return { status: 200, body: { ficha, avisos: r.avisos, filas: r.filas } };
}

// ─── Fotos de la ficha ──────────────────────────────────────────────────────
// La ficha tiene que existir (las fotos cuelgan de ella): si aún no se guardó, se crea vacía como borrador
async function asegurarFicha(sb, usuario, proyectoId, cod) {
  const { error } = await sb.from('campo_fichas').upsert({ proyecto_id: proyectoId, codigo_local: cod, estado: 'borrador', datos: {}, editado_por: usuario.id, editado_por_email: usuario.email || null },
    { onConflict: 'proyecto_id,codigo_local', ignoreDuplicates: true });
  if (error) throw error;
}

/** archivo: { buffer, size }, mini: { buffer } | null, campos: { id, aula, bien, muestra, lat, lon, tomada_en } → { status, body } */
export async function subirFotoFicha(sb, usuario, proyectoId, cod, { archivo, mini, campos = {} }) {
  const acc = await accesoFicha(sb, usuario, proyectoId, cod);
  if (acc.error) return { status: acc.status, body: { error: acc.error } };
  if (!archivo?.buffer) return { status: 400, body: { error: 'Falta la foto' } };
  const id = String(campos.id || '');
  if (!esUuidFoto(id)) return { status: 400, body: { error: 'Identificador de foto no válido' } };
  const mime = mimeDe(archivo.buffer);
  if (!MIMES_FOTO.includes(mime)) return { status: 400, body: { error: 'Solo se aceptan fotos JPG, PNG o WEBP' } };
  const mimeMini = mini?.buffer ? mimeDe(mini.buffer) : null;
  const p = acc.p, actual = await leerFichaDigital(sb, p.id, cod);
  if (!puedeEditar(actual?.estado)) return { status: 409, body: { error: actual.estado === 'aprobada' ? 'La ficha ya fue aprobada: no se le agregan fotos.' : 'La ficha ya está enviada a revisión: no se le agregan fotos hasta que el proveedor la devuelva.' } };
  const previas = actual ? await leerFotos(sb, p.id, cod) : [];
  const ya = previas.find(f => f.id === id);
  if (ya) return { status: 200, body: { foto: vistaDeFoto(ya) } };     // reintento de una subida que sí llegó
  if (previas.length >= MAX_FOTOS_FICHA) return { status: 400, body: { error: `Máximo ${MAX_FOTOS_FICHA} fotos por ficha` } };
  if (!actual) await asegurarFicha(sb, usuario, p.id, cod);

  const meta = limpiarMetaFoto(campos);
  const ruta = rutaFoto(p.id, cod, id, mime), rutaMini = MIMES_FOTO.includes(mimeMini) ? rutaFoto(p.id, cod, id, mimeMini, true) : null;
  const bucket = sb.storage.from(BUCKET_EXPEDIENTE);
  const { error: eUp } = await bucket.upload(ruta, archivo.buffer, { contentType: mime, upsert: true });
  if (eUp) return { status: /bucket not found/i.test(eUp.message) ? 503 : 500, body: { error: 'No se pudo guardar la foto: ' + eUp.message } };
  if (rutaMini) { const { error: eMini } = await bucket.upload(rutaMini, mini.buffer, { contentType: mimeMini, upsert: true }); if (eMini) console.warn('[CAMPO] Miniatura no guardada:', eMini.message); }
  const fila = { id, proyecto_id: p.id, codigo_local: cod, ...meta, ruta, ruta_mini: rutaMini, mime, tamano: archivo.size ?? archivo.buffer.length, subido_por: usuario.id, subido_por_email: usuario.email || null };
  const { error } = await sb.from('campo_fichas_fotos').insert(fila);
  if (error) {
    await bucket.remove([ruta, rutaMini].filter(Boolean));
    throw error;
  }
  return { status: 201, body: { foto: vistaDeFoto({ ...fila, creado_en: new Date().toISOString() }) } };
}

async function fotoDeFicha(sb, usuario, proyectoId, cod, fotoId) {
  const acc = await accesoFicha(sb, usuario, proyectoId, cod);
  if (acc.error) return { error: acc.error, status: acc.status };
  if (!esUuidFoto(fotoId)) return { status: 404, error: 'Foto no encontrada' };
  const { data, error } = await sb.from('campo_fichas_fotos').select('id, ruta, ruta_mini, mime').eq('id', fotoId).eq('proyecto_id', acc.p.id).eq('codigo_local', cod).maybeSingle();
  if (error) throw error;
  return data ? { p: acc.p, foto: data } : { status: 404, error: 'Foto no encontrada' };
}

/** La imagen: { status, error } o { buffer, mime } */
export async function leerImagenFoto(sb, usuario, proyectoId, cod, fotoId, mini = false) {
  const r = await fotoDeFicha(sb, usuario, proyectoId, cod, fotoId);
  if (r.error) return r;
  return descargarFoto(sb, r.foto, mini);
}
export async function descargarFoto(sb, foto, mini = false) {
  const ruta = mini && foto.ruta_mini ? foto.ruta_mini : foto.ruta;
  const { data, error } = await sb.storage.from(BUCKET_EXPEDIENTE).download(ruta);
  if (error || !data) return { status: 404, error: 'No se encontró la imagen' };
  return { buffer: Buffer.from(await data.arrayBuffer()), mime: ruta.endsWith('.png') ? 'image/png' : ruta.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
}

export async function borrarFotoFicha(sb, usuario, proyectoId, cod, fotoId) {
  const r = await fotoDeFicha(sb, usuario, proyectoId, cod, fotoId);
  if (r.error) return { status: r.status, body: { error: r.error } };
  const actual = await leerFichaDigital(sb, r.p.id, cod);
  if (!puedeEditar(actual?.estado)) return { status: 409, body: { error: 'La ficha ya está enviada: no se le quitan fotos.' } };
  const { error } = await sb.from('campo_fichas_fotos').delete().eq('id', fotoId);
  if (error) throw error;
  const { error: eDel } = await sb.storage.from(BUCKET_EXPEDIENTE).remove([r.foto.ruta, r.foto.ruta_mini].filter(Boolean));
  if (eDel) console.warn('[CAMPO] No se pudo borrar la foto del bucket:', eDel.message);
  return { status: 200, body: { id: fotoId, borrada: true } };
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

  // Ficha en la app: deps.fichas = { modelo(proyectoId, cod), validar(proyectoId, cod, datos, origen) }
  const enFicha = fn => async (req, res, next) => {
    try {
      if (!deps.fichas) return res.status(503).json({ error: 'Las fichas no están disponibles' });
      const r = await fn(req);
      res.status(r.status).json(r.body);
    } catch (e) {
      if (faltaMigracionFichas(e)) return res.status(503).json({ error: AVISO_MIGRACION_FICHAS });
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  };
  const cod = req => String(req.params.cod);
  api.get('/proyectos/:id/fichas', enFicha(req => fichasDelUsuario(sb, req.usuario, req.params.id)));
  api.get('/proyectos/:id/fichas/:cod', enFicha(req => abrirFichaCampo(sb, req.usuario, req.params.id, cod(req), deps.fichas)));
  api.put('/proyectos/:id/fichas/:cod', enFicha(req => guardarBorradorFicha(sb, req.usuario, req.params.id, cod(req), req.body || {})));
  api.post('/proyectos/:id/fichas/:cod/enviar', enFicha(req => enviarFicha(sb, req.usuario, req.params.id, cod(req), req.body || {}, deps.fichas)));

  // Fotos: sin la migración 024, aviso claro
  const enFoto = fn => async (req, res, next) => {
    try { const r = await fn(req, res); if (r) res.status(r.status).json(r.body); }
    catch (e) {
      if (faltaMigracionFichas(e)) return res.status(503).json({ error: /campo_fichas_fotos/.test(e.message || '') || e.code === 'PGRST205' ? AVISO_MIGRACION_FOTOS : AVISO_MIGRACION_FICHAS });
      next(e);
    }
  };
  const recibirFoto = (req, res, next) => subidaFoto.fields([{ name: 'foto', maxCount: 1 }, { name: 'mini', maxCount: 1 }])(req, res, err => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `La foto pasa de ${MAX_FOTO / 1024 / 1024} MB` : 'No se pudo recibir la foto: ' + err.message });
  });
  api.post('/proyectos/:id/fichas/:cod/fotos', recibirFoto, enFoto(req => subirFotoFicha(sb, req.usuario, req.params.id, cod(req),
    { archivo: req.files?.foto?.[0], mini: req.files?.mini?.[0], campos: req.body || {} })));
  api.get('/proyectos/:id/fichas/:cod/fotos/:fotoId', enFoto(async (req, res) => {
    const r = await leerImagenFoto(sb, req.usuario, req.params.id, cod(req), req.params.fotoId, !!req.query.mini);
    if (r.error) return { status: r.status, body: { error: r.error } };
    res.set({ 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=86400' }).send(r.buffer);
  }));
  api.delete('/proyectos/:id/fichas/:cod/fotos/:fotoId', enFoto(req => borrarFotoFicha(sb, req.usuario, req.params.id, cod(req), req.params.fotoId)));

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
