// ============================================================================
// src/selector-ioarr/duplicidad.js — Otra inversión vigente o reciente por local
//
// Por proyecto y local: Sí, No o Sin verificar (por defecto), el código de la
// otra inversión y si el local se excluye de la propuesta (solo si es Sí).
// Tabla: supabase/migrations/017_ioarr_selector_duplicidad.sql
//
// La consulta al Banco de Inversiones la hace el usuario. Consultarlo en forma
// automática queda como mejora futura.
//
// Lo usan el Selector (router.js), el expediente (expediente.js) y los Excel.
// ============================================================================

export const ROTULO_DUP = 'Otra inversión vigente o reciente';
export const ESTADOS_DUP = { si: 'Sí', no: 'No', sin_verificar: 'Sin verificar' };
export const SIN_VERIFICAR = Object.freeze({ estado: 'sin_verificar', codigo: null, nota: null, excluir: false });
export const AVISO_DUP = 'Falta ejecutar supabase/migrations/017_ioarr_selector_duplicidad.sql en Supabase';

const error400 = m => Object.assign(new Error(m), { status: 400 });
const texto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Valida lo que manda el navegador: { estado, codigo?, nota?, excluir? }
export function limpiarDuplicidad(b = {}) {
  const estado = String(b.estado || '');
  if (!ESTADOS_DUP[estado]) throw error400('Estado no válido: usa Sí, No o Sin verificar');
  const codigo = texto(b.codigo, 30);
  if (codigo && !/^[\p{L}\d][\p{L}\d .\/-]*$/u.test(codigo)) throw error400('Código de inversión no válido (letras, números, guion o barra)');
  return { estado, codigo: codigo || null, nota: texto(b.nota, 500) || null, excluir: estado === 'si' && !!b.excluir };
}

// Fila guardada → forma del navegador
export const deFila = f => ({ estado: f.estado, codigo: f.codigo_inversion || null, nota: f.nota || null, excluir: !!f.excluir && f.estado === 'si', actualizado_en: f.actualizado_en || null });
export const aFila = (proyectoId, cod, d, usuarioId) => ({
  proyecto_id: proyectoId, cod_local: cod, estado: d.estado, codigo_inversion: d.codigo, nota: d.nota, excluir: d.excluir,
  actualizado_por: usuarioId || null, actualizado_en: new Date().toISOString()
});
// Sin verificar y sin código ni nota: no hace falta guardar la fila
export const esVacia = d => d.estado === 'sin_verificar' && !d.codigo && !d.nota;

export const estadoDe = (mapa, cod) => mapa?.[cod] || SIN_VERIFICAR;
export const excluidosDe = mapa => new Set(Object.entries(mapa || {}).filter(([, d]) => d.excluir && d.estado === 'si').map(([c]) => c));

// Índices de los locales del proyecto en la región: los de la propuesta y los excluidos
export function separarLocales(D, codigos, mapa) {
  const cod = new Set(codigos), fuera = excluidosDe(mapa), list = [], excluidos = [];
  D.locs.forEach((l, i) => { if (cod.has(l[0])) (fuera.has(l[0]) ? excluidos : list).push(i); });
  return { list, excluidos };
}

// Conteo sobre los locales del proyecto (códigos)
export function resumenDuplicidad(mapa, codigos) {
  const r = { si: 0, no: 0, sin_verificar: 0, excluidos: 0, si_incluidos: 0, si_sin_codigo: 0 };
  for (const c of codigos) {
    const d = estadoDe(mapa, c);
    r[d.estado]++;
    if (d.estado === 'si') { if (d.excluir) r.excluidos++; else r.si_incluidos++; if (!d.codigo) r.si_sin_codigo++; }
  }
  return r;
}

// Avisos para el expediente (pantalla y documentos)
export function avisosDuplicidad(mapa, codigos) {
  const r = resumenDuplicidad(mapa, codigos), out = [], loc = n => n === 1 ? '1 local' : `${n} locales`;
  if (r.si_incluidos) out.push({ tipo: 'duplicidad', alerta: true, texto: `${loc(r.si_incluidos)} con otra inversión vigente o reciente sigue${r.si_incluidos === 1 ? '' : 'n'} en la propuesta. Hay riesgo de duplicidad: exclúyelo${r.si_incluidos === 1 ? '' : 's'} en «Mi selección» o explica en la nota por qué no hay duplicidad.` });
  if (r.excluidos) out.push({ tipo: 'duplicidad', texto: `${loc(r.excluidos)} con otra inversión vigente o reciente ${r.excluidos === 1 ? 'quedó excluido' : 'quedaron excluidos'} de la propuesta: no entra${r.excluidos === 1 ? '' : 'n'} al metrado, al costo ni a los documentos.` });
  if (r.sin_verificar) out.push({ tipo: 'duplicidad', texto: `${loc(r.sin_verificar)} sin verificar si tiene${r.sin_verificar === 1 ? '' : 'n'} otra inversión vigente o reciente. Consulta el Banco de Inversiones y márcalo en «Mi selección».` });
  if (r.si_sin_codigo) out.push({ tipo: 'duplicidad', texto: `Falta el código de la otra inversión en ${loc(r.si_sin_codigo)} marcado${r.si_sin_codigo === 1 ? '' : 's'} «Sí».` });
  return out;
}

// Lee las marcas de un proyecto. Sin la migración 017: mapa vacío (todo «Sin verificar»).
export async function leerDuplicidad(supabase, proyectoId) {
  const mapa = {};
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase.from('ioarr_selector_duplicidad').select('*')
      .eq('proyecto_id', proyectoId).order('cod_local').range(desde, desde + 999);
    if (error) {
      if (error.code === 'PGRST205' || error.code === '42P01' || /schema cache|does not exist/i.test(error.message || '')) return { mapa: {}, sinMigracion: true };
      throw error;
    }
    for (const f of data) mapa[f.cod_local] = deFila(f);
    if (data.length < 1000) return { mapa, sinMigracion: false };
  }
}
