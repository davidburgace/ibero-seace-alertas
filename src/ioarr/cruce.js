// ============================================================================
// src/ioarr/cruce.js — Cruce de fuentes por CUI (Banco × Proinversión × PMI)
//
// Cada archivo importado se guarda como una «carga» (tabla ioarr_cargas) con
// sus filas tal como vinieron (ioarr_carga_filas, o ioarr_pmi para el PMI).
// La situación de cada proyecto NO se guarda: calcularCruce() la calcula al
// vuelo a partir de las vistas de la migración 005. El cruce tampoco toca
// ioarr_proyectos: si el estado del radar no cuadra con las fuentes, lo señala.
// ============================================================================

import { normaliza, parseMonto, limpiaCui, esIdea, esMobiliario, esIoarr, mapEntidadTipo } from './ingesta.js';

export const FUENTES_CARGA = ['invierte_pe', 'proinversion', 'pmi'];
export const ETIQUETA_FUENTE_CARGA = { invierte_pe: 'Banco de Inversiones', proinversion: 'Proinversión', pmi: 'Cartera de PMI' };

// Orden de evaluación = orden de la lista (a → g). «prioridad» es el orden en pantalla.
export const SITUACIONES = [
  { key: 'ejecucion_descartada', label: 'En ejecución o descartada', prioridad: 7 },
  { key: 'desaparecida', label: 'Desaparecida de Proinversión', prioridad: 6 },
  { key: 'priorizada', label: 'Priorizada en búsqueda de financista', prioridad: 1 },
  { key: 'por_priorizar', label: 'Por priorizar', prioridad: 2 },
  { key: 'viable_pmi', label: 'Viable, en PMI, sin OxI', prioridad: 3 },
  { key: 'viable_fuera_pmi', label: 'Viable, fuera del PMI', prioridad: 5 },
  { key: 'viable_pmi_sin_verificar', label: 'Viable, PMI sin verificar', prioridad: 4 }
];
const SITUACION = Object.fromEntries(SITUACIONES.map(s => [s.key, s]));

export const IDEA_SIN_CUI = 'Idea, sin CUI registrado';

// Estados del radar que encajan con cada situación (si no encaja, se señala)
const AVANZADOS = ['convenio', 'en_proceso_seleccion', 'en_ejecucion', 'bienes_entregados', 'ciprl_emitido', 'cerrada', 'descartada'];
const ESTADOS_COMPATIBLES = {
  ejecucion_descartada: ['en_ejecucion', 'bienes_entregados', 'ciprl_emitido', 'cerrada', 'descartada'],
  desaparecida: AVANZADOS,
  priorizada: ['priorizada_oxi', 'convenio', 'en_proceso_seleccion'],
  por_priorizar: ['viable'],
  viable_pmi: ['viable'],
  viable_fuera_pmi: ['viable'],
  viable_pmi_sin_verificar: ['viable']
};
const ETIQUETA_ESTADO = {
  viable: 'Viable', priorizada_oxi: 'Priorizada OxI', convenio: 'Convenio', en_proceso_seleccion: 'En proceso de selección',
  en_ejecucion: 'En ejecución', bienes_entregados: 'Bienes entregados', ciprl_emitido: 'CIPRL emitido', cerrada: 'Cerrada', descartada: 'Descartada'
};

// ─── Preparar las filas de una carga ────────────────────────────────────────
const valor = (row, mapeo, campo) => {
  const col = mapeo[campo];
  const v = col ? row[col] : null;
  return v == null || String(v).trim() === '' ? null : String(v).trim();
};

// Fila del Banco o de Proinversión → fila de ioarr_carga_filas (solo exige CUI)
export function filaACarga(row, mapeo) {
  const cui = limpiaCui(valor(row, mapeo, 'cui'));
  if (!cui) return null;
  const entidad = valor(row, mapeo, 'entidad');
  return {
    cui,
    es_idea: esIdea(cui),
    nombre: valor(row, mapeo, 'nombre'),
    entidad,
    entidad_tipo: mapEntidadTipo(valor(row, mapeo, 'nivel_gobierno'), entidad),
    region: normaliza(valor(row, mapeo, 'region')) || null,
    provincia: normaliza(valor(row, mapeo, 'provincia')) || null,
    distrito: normaliza(valor(row, mapeo, 'distrito')) || null,
    funcion: valor(row, mapeo, 'funcion'),
    monto_inversion: parseMonto(mapeo.monto_inversion ? row[mapeo.monto_inversion] : null),
    estado_inversion: valor(row, mapeo, 'estado'),
    fuente_financiamiento: valor(row, mapeo, 'fuente_financiamiento'),
    pim: parseMonto(mapeo.pim ? row[mapeo.pim] : null),
    devengado: parseMonto(mapeo.devengado ? row[mapeo.devengado] : null),
    fase_oxi: valor(row, mapeo, 'estado_oxi'),
    nivel_estudio: valor(row, mapeo, 'nivel_estudio')
  };
}

// Fila del PMI → fila de ioarr_pmi (`periodo`: el del encabezado del archivo, si la fila no trae uno)
export function filaAPmi(row, mapeo, periodo = null) {
  const cui = limpiaCui(valor(row, mapeo, 'cui'));
  if (!cui) return null;
  return { cui, entidad: valor(row, mapeo, 'entidad'), periodo: valor(row, mapeo, 'periodo') || periodo };
}

// ─── Entidad ↔ OPMI ─────────────────────────────────────────────────────────
// La entidad del proyecto («GOBIERNO REGIONAL LAMBAYEQUE») y la OPMI del PMI
// («OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE») se comparan por una clave común.
// Equivalencias explícitas (ya normalizadas, sin «OPMI DEL»): agrega aquí las
// entidades cuyo PMI lo programa otra OPMI.
export const EQUIVALENCIAS_OPMI = {
  'MINEDU': 'MINISTERIO DE EDUCACION',
  'SECTOR EDUCACION': 'MINISTERIO DE EDUCACION',
  'PRONIED': 'MINISTERIO DE EDUCACION',
  'PROGRAMA NACIONAL DE INFRAESTRUCTURA EDUCATIVA': 'MINISTERIO DE EDUCACION'
};

export function claveOpmi(texto) {
  let t = normaliza(texto).replace(/[.,;:"'()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  t = t.replace(/^(OFICINA DE PROGRAMACION MULTIANUAL DE INVERSIONES|OPMI)( -)?( DE LA| DE LOS| DEL| DE)? /, '')
    .replace(/^(OPMI)( DE LA| DE LOS| DEL| DE)? /, '')
    .replace(/^(GOB REG|GOB REGIONAL|GOBIERNO REG|GORE|GR) /, 'GOBIERNO REGIONAL ')
    .replace(/^GOBIERNO REGIONAL (DEL DEPARTAMENTO DE |DEL |DE )?/, 'GOBIERNO REGIONAL ')
    .replace(/^MUNICIPALIDAD (PROVINCIAL|DISTRITAL) (DEL |DE LA |DE )?/, 'MUNICIPALIDAD $1 DE ');
  const partes = t.split(/ - /).map(x => x.trim()).filter(Boolean);
  for (const x of [t, ...partes]) if (EQUIVALENCIAS_OPMI[x]) return EQUIVALENCIAS_OPMI[x];
  // «GOBIERNO REGIONAL LAMBAYEQUE - SEDE CENTRAL» → «GOBIERNO REGIONAL LAMBAYEQUE»
  return partes[0] || t;
}

const masReciente = (a, b) => new Date(b.fecha_carga) - new Date(a.fecha_carga) || String(b.id).localeCompare(String(a.id));

// Qué OPMI cubre cada carga del PMI (la de la carga y las entidades de sus filas)
// y cuál es la carga vigente de cada OPMI: la más reciente.
export function vigenciaPmi(cargas = [], pmiEntidadesCarga = []) {
  const pmiCargas = cargas.filter(c => c.fuente === 'pmi').sort(masReciente);
  const claves = new Map(pmiCargas.map(c => [c.id, new Set(claveOpmi(c.opmi) ? [claveOpmi(c.opmi)] : [])]));
  for (const e of pmiEntidadesCarga) {
    const k = claveOpmi(e.entidad);
    if (k && claves.has(e.carga_id)) claves.get(e.carga_id).add(k);
  }
  const vigentePorClave = new Map();
  for (const c of pmiCargas) for (const k of claves.get(c.id)) if (!vigentePorClave.has(k)) vigentePorClave.set(k, c);
  return { pmiCargas, claves, vigentePorClave };
}

// Función = EDUCACIÓN (acepta el código delante, p. ej. «22 EDUCACIÓN» o «22-EDUCACION»)
export const esEducacion = (funcion) => /^(\d+\s*[-:.]?\s*)?EDUCACION$/.test(normaliza(funcion));

// Filas del PMI → filas a guardar, aplicando en orden: CUI, Función, Tipo de inversión.
// Cada fila descartada se cuenta solo en el primer filtro que la deja fuera.
// Lanza un error si un filtro está activo pero su columna no está mapeada.
export function filtrarFilasPmi(rows, mapeo, { soloEducacion = false, soloIoarr = false, periodo = null } = {}) {
  if (soloEducacion && !mapeo.funcion) throw new Error('Para importar solo Educación, mapea la columna «Función» (o desmarca la casilla)');
  if (soloIoarr && !mapeo.tipo_inversion) throw new Error('Para importar solo IOARR, mapea la columna «Tipo de inversión» (o desmarca la casilla)');
  const resumen = { leidas: rows.length, sin_cui: 0, no_educacion: 0, no_ioarr: 0, importadas: 0 };
  const filas = [];
  for (const row of rows) {
    const fila = filaAPmi(row, mapeo, periodo);
    if (!fila) { resumen.sin_cui++; continue; }
    if (soloEducacion && !esEducacion(valor(row, mapeo, 'funcion'))) { resumen.no_educacion++; continue; }
    if (soloIoarr && !esIoarr(valor(row, mapeo, 'tipo_inversion'))) { resumen.no_ioarr++; continue; }
    filas.push(fila);
  }
  resumen.importadas = filas.length;
  return { filas, resumen };
}

// Un CUI por carga: si se repite, gana la última fila y se cuentan las repeticiones
export function deduplicarPorCui(filas) {
  const porCui = new Map();
  for (const f of filas) {
    const prev = porCui.get(f.cui);
    porCui.set(f.cui, { ...f, repeticiones: (prev?.repeticiones || 0) + 1 });
  }
  const unicas = [...porCui.values()];
  return { filas: unicas, repetidas: filas.length - unicas.length };
}

// Guarda una carga y sus filas. Si falla a medias, se borra la carga (cascade).
// `filtros` ({ solo_educacion, solo_ioarr }) exige la migración 006 y `opmi` la 007; si no se pasan, no se envían.
export async function guardarCarga(supabase, { fuente, filas, nombre_archivo = null, hoja = null, usuario_id = null, filtros = null, opmi = null }) {
  if (!FUENTES_CARGA.includes(fuente)) throw new Error('Fuente de carga inválida');
  const { filas: unicas, repetidas } = deduplicarPorCui(filas);
  const { data: carga, error } = await supabase.from('ioarr_cargas').insert({
    fuente, nombre_archivo, hoja, filas: unicas.length, filas_repetidas: repetidas, cargado_por: usuario_id,
    ...(filtros ? { filtros } : {}),
    ...(opmi ? { opmi } : {})
  }).select().single();
  if (error) throw error;

  const tabla = fuente === 'pmi' ? 'ioarr_pmi' : 'ioarr_carga_filas';
  const registros = fuente === 'pmi'
    ? unicas.map(({ repeticiones, ...f }) => ({ ...f, carga_id: carga.id, fecha_carga: carga.fecha_carga }))
    : unicas.map(f => ({ ...f, carga_id: carga.id }));
  for (let i = 0; i < registros.length; i += 500) {
    const { error: e2 } = await supabase.from(tabla).insert(registros.slice(i, i + 500));
    if (e2) {
      await supabase.from('ioarr_cargas').delete().eq('id', carga.id);
      throw e2;
    }
  }
  return { carga, filas: unicas.length, filas_repetidas: repetidas };
}

// Borra una carga y, en cascada, sus filas (ioarr_carga_filas o ioarr_pmi).
// No deshace lo que la importación ya escribió en ioarr_proyectos.
export async function borrarCarga(supabase, id) {
  const { data, error } = await supabase.from('ioarr_cargas').delete().eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data; // null si no existía
}

// ─── Leer los datos del cruce ───────────────────────────────────────────────
async function todo(consulta) {
  const out = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await consulta().range(desde, desde + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

export async function obtenerDatosCruce(supabase) {
  const [fuentes, proyectos, pmiEntidadesCarga, pmiManual, cargas] = await Promise.all([
    todo(() => supabase.from('ioarr_cruce_fuentes').select('*').order('fuente').order('cui')),
    todo(() => supabase.from('ioarr_proyectos')
      .select('id, cui, nombre, entidad, entidad_tipo, region, provincia, distrito, funcion, tipo_inversion, monto_inversion, estado, es_mobiliario, es_idea')
      .order('cui')),
    todo(() => supabase.from('ioarr_pmi_entidades_carga').select('*').order('carga_id').order('entidad')),
    todo(() => supabase.from('ioarr_pmi_manual').select('*').order('cui')),
    todo(() => supabase.from('ioarr_cargas').select('*').order('fecha_carga', { ascending: false }))
  ]);
  // El PMI puede ser grande: solo se traen los CUI que están en el cruce (de todas
  // las cargas; calcularCruce decide cuál está vigente para cada OPMI)
  const universo = [...new Set([...fuentes.map(f => f.cui), ...proyectos.map(p => p.cui)])];
  const pmi = [];
  for (let i = 0; i < universo.length; i += 200) {
    const cuis = universo.slice(i, i + 200);
    pmi.push(...await todo(() => supabase.from('ioarr_pmi').select('cui, entidad, periodo, carga_id, fecha_carga')
      .in('cui', cuis).order('carga_id').order('cui')));
  }
  return { fuentes, proyectos, pmi, pmiEntidadesCarga, pmiManual, cargas };
}

// ─── Cálculo (función pura) ─────────────────────────────────────────────────
const num = (v) => (v == null || v === '' ? null : Number(v));
const fechaCorta = (d) => d ? new Date(d).toISOString().slice(0, 10) : '¿?';
const soles = (n) => 'S/ ' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

// «Priorizado» / «Por Priorizar» / otra fase / sin dato
export function claseFaseOxi(texto) {
  const t = normaliza(texto);
  if (!t) return null;
  if (/POR PRIORIZAR|SIN PRIORIZ|NO PRIORIZ|PENDIENTE DE PRIORIZ/.test(t)) return 'por_priorizar';
  if (/PRIORIZAD/.test(t)) return 'priorizado';
  return 'otra';
}

// ¿En ejecución con fuente pública asignada? (devuelve el motivo o null)
function ejecucionPublica(b) {
  const estado = normaliza(b.estado_inversion);
  const fuente = normaliza(b.fuente_financiamiento);
  const pim = num(b.pim) || 0, devengado = num(b.devengado) || 0;
  if (/OBRAS POR IMPUESTOS|\bOXI\b|CIPRL/.test(fuente)) return null; // financiada vía OxI: no es fuente pública directa
  const enEjecucion = /EJECUCION/.test(estado) || devengado > 0;
  const conFuente = pim > 0 || devengado > 0 || !!fuente;
  if (!enEjecucion || !conFuente) return null;
  const detalle = [devengado > 0 && `devengado ${soles(devengado)}`, pim > 0 && `PIM ${soles(pim)}`, fuente && `fuente «${b.fuente_financiamiento}»`]
    .filter(Boolean).join(', ');
  return `En ejecución con fuente pública asignada en el Banco (${detalle})`;
}

// Texto corto de los filtros de una carga: «solo Educación e IOARR» ('' si no tiene)
export function textoFiltros(filtros) {
  const f = [filtros?.solo_educacion && 'Educación', filtros?.solo_ioarr && 'IOARR'].filter(Boolean);
  return f.length ? `solo ${f.join(' e ')}` : '';
}

// ¿Podía este proyecto estar en una carga del PMI con esos filtros?
// Devuelve null si sí, o el motivo por el que no se puede concluir que falta.
function fueraDeFiltros(filtros, { funcion, tipo }) {
  if (filtros?.solo_educacion) {
    if (!funcion) return 'no se sabe la función de este proyecto';
    if (!esEducacion(funcion)) return `este proyecto es de la función «${funcion}»`;
  }
  if (filtros?.solo_ioarr) {
    if (!tipo) return 'no se sabe el tipo de inversión de este proyecto';
    if (!esIoarr(tipo)) return `este proyecto es de tipo «${tipo}»`;
  }
  return null;
}

function cambiosDeEntidad(fila, nombreFuente) {
  if (!fila?.entidad || !fila.entidades_previas?.length) return [];
  const actual = normaliza(fila.entidad);
  const otras = fila.entidades_previas.filter(e => e && normaliza(e) !== actual);
  return otras.length ? [`Cambió de entidad en ${nombreFuente}: antes «${otras.join('», «')}», ahora «${fila.entidad}»`] : [];
}

// Motivo de «PMI sin verificar»
export const MOTIVO_PMI = { opmi_no_cargada: 'Su OPMI no fue cargada', cui_no_encontrado: 'CUI no encontrado' };

export function calcularCruce({ fuentes = [], proyectos = [], pmi = [], pmiEntidadesCarga = [], pmiManual = [], cargas = [] }) {
  const banco = new Map(), pro = new Map();
  for (const f of fuentes) {
    if (f.fuente === 'invierte_pe') banco.set(f.cui, f);
    else if (f.fuente === 'proinversion') pro.set(f.cui, f);
  }
  const proyecto = new Map(proyectos.map(p => [p.cui, p]));
  const manual = new Map(pmiManual.map(m => [m.cui, m]));

  // PMI: una fila cuenta si viene de la carga vigente de su OPMI (la de la fila o
  // la de la carga). Si no se sabe su OPMI, cuenta igual: el CUI está en un PMI cargado.
  const { pmiCargas, claves, vigentePorClave } = vigenciaPmi(cargas, pmiEntidadesCarga);
  const cargaPorId = new Map(cargas.map(c => [c.id, c]));
  const pmiPorCui = new Map();
  for (const f of pmi) {
    const carga = cargaPorId.get(f.carga_id);
    const clave = claveOpmi(f.entidad) || claveOpmi(carga?.opmi);
    if (clave && vigentePorClave.get(clave)?.id !== f.carga_id) continue;
    const opmi = f.entidad || carga?.opmi || null;
    const fila = { ...f, opmi, clave, fecha_carga: f.fecha_carga || carga?.fecha_carga };
    const prev = pmiPorCui.get(f.cui);
    if (!prev || new Date(fila.fecha_carga) > new Date(prev.fecha_carga)) pmiPorCui.set(f.cui, fila);
  }

  const ultima = {};
  for (const c of cargas) if (!ultima[c.fuente] || new Date(c.fecha_carga) > new Date(ultima[c.fuente].fecha_carga)) ultima[c.fuente] = c;

  const cuis = [...new Set([...banco.keys(), ...pro.keys(), ...proyecto.keys()])];
  const filas = cuis.map(cui => {
    const b = banco.get(cui), p = pro.get(cui), r = proyecto.get(cui);
    const enBanco = !!b;
    const enPro = !!p?.en_ultima_carga;
    const faseOxi = enPro ? p.fase_oxi : null;
    const clase = enPro ? claseFaseOxi(faseOxi) : null;
    const idea = esIdea(cui);
    const avisos = [];

    // ── PMI. Regla 4: si el CUI está en un PMI cargado, está en el PMI (aunque la
    // entidad no case). Regla 5: si no está y la OPMI de su entidad sí se cargó,
    // está fuera. Si no, queda sin verificar, con el motivo (o vale la marca manual).
    const entidades = [b?.entidad, p?.entidad, r?.entidad].filter(Boolean);
    const filaPmi = pmiPorCui.get(cui);
    const clavesEntidad = [...new Set(entidades.map(claveOpmi).filter(Boolean))];
    const cargaOpmi = filaPmi ? null : clavesEntidad.map(k => vigentePorClave.get(k)).find(Boolean);
    const m = manual.get(cui);
    // Si el PMI de la OPMI se cargó filtrado y el proyecto no entra en el filtro, la ausencia no prueba nada
    const fuera = cargaOpmi && fueraDeFiltros(cargaOpmi.filtros,
      { funcion: b?.funcion || p?.funcion || r?.funcion, tipo: r?.tipo_inversion });
    const nombreOpmi = (c) => c.opmi || 'la OPMI';
    let enPmi = 'sin_verificar', pmiOrigen = null, pmiDetalle = null, motivoSv = null;
    if (filaPmi) {
      enPmi = 'si'; pmiOrigen = 'archivo';
      pmiDetalle = `En el PMI ${filaPmi.periodo || ''} de ${filaPmi.opmi || 'una OPMI sin nombre'} (carga del ${fechaCorta(filaPmi.fecha_carga)})`.replace(/\s+/g, ' ');
      if (filaPmi.clave && clavesEntidad.length && !clavesEntidad.includes(filaPmi.clave))
        avisos.push(`Está en el PMI de «${filaPmi.opmi}», que no es la OPMI de su entidad («${entidades[0]}»)`);
    } else if (cargaOpmi && !fuera) {
      enPmi = 'no'; pmiOrigen = 'archivo';
      const filtro = textoFiltros(cargaOpmi.filtros);
      pmiDetalle = `El PMI de ${nombreOpmi(cargaOpmi)} está cargado (${fechaCorta(cargaOpmi.fecha_carga)}${filtro ? ', ' + filtro : ''}) y este CUI no está`;
    } else {
      if (cargaOpmi) motivoSv = { clave: 'cui_no_encontrado',
        texto: `CUI no encontrado en el PMI de ${nombreOpmi(cargaOpmi)}, pero esa carga es ${textoFiltros(cargaOpmi.filtros)} y ${fuera}` };
      else if (entidades.length) motivoSv = { clave: 'opmi_no_cargada',
        texto: `Su OPMI no fue cargada (entidad «${entidades[0]}»)${pmiCargas.length ? '' : '; aún no hay ningún PMI cargado'}` };
      else motivoSv = { clave: 'cui_no_encontrado', texto: 'CUI no encontrado en los PMI cargados, y no se sabe su entidad' };
      if (m) {
        enPmi = m.en_pmi; pmiOrigen = 'manual';
        pmiDetalle = `Marcado a mano el ${fechaCorta(m.revisado_en)}${m.nota ? ': ' + m.nota : ''}`;
        if (enPmi === 'sin_verificar' || cargaOpmi) pmiDetalle += `. ${motivoSv.texto}`;
      } else pmiDetalle = motivoSv.texto;
      if (enPmi !== 'sin_verificar') motivoSv = null;
    }
    if (pmiOrigen === 'archivo' && m && m.en_pmi !== 'sin_verificar' && m.en_pmi !== enPmi)
      avisos.push(`Tu marca manual de PMI («${m.en_pmi}», ${fechaCorta(m.revisado_en)}) difiere del archivo («${enPmi}»)`);

    // ── Situación (a → g, la primera que se cumple)
    let situacion, motivo;
    // Viable sin OxI: en el Banco o en el radar (importado antes de que hubiera cargas), y no en Proinversión
    const viableSinOxi = (enBanco || !!r) && !enPro;
    const base = enBanco ? 'En el Banco, no en Proinversión' : 'En el radar (sin carga del Banco), no en Proinversión';
    const estadoBanco = normaliza(b?.estado_inversion);
    const ejecucion = b ? ejecucionPublica(b) : null;
    if (b && /DESACTIV/.test(estadoBanco)) {
      situacion = 'ejecucion_descartada'; motivo = `Estado de la inversión «${b.estado_inversion}» en el Banco`;
    } else if (b && /CERRAD|CANCELAD|ANULAD/.test(estadoBanco)) {
      situacion = 'ejecucion_descartada'; motivo = `Inversión «${b.estado_inversion}» en el Banco`;
    } else if (ejecucion) {
      situacion = 'ejecucion_descartada'; motivo = ejecucion;
    } else if (r?.estado === 'descartada') {
      situacion = 'ejecucion_descartada'; motivo = 'La marcaste como descartada en el radar';
    } else if (p && !p.en_ultima_carga) {
      situacion = 'desaparecida';
      motivo = `Estaba en la carga de Proinversión del ${fechaCorta(p.fecha_carga)} y no aparece en la última (${fechaCorta(ultima.proinversion?.fecha_carga)})`;
    } else if (clase === 'priorizado') {
      situacion = 'priorizada'; motivo = `Está en Proinversión como «${faseOxi}»`;
    } else if (clase === 'por_priorizar') {
      situacion = 'por_priorizar'; motivo = `Está en Proinversión como «${faseOxi}»`;
    } else if (viableSinOxi && enPmi === 'si') {
      situacion = 'viable_pmi'; motivo = `${base}. ${pmiDetalle}`;
    } else if (viableSinOxi && enPmi === 'no') {
      situacion = 'viable_fuera_pmi'; motivo = `${base}. ${pmiDetalle}`;
    } else {
      situacion = 'viable_pmi_sin_verificar';
      if (enPro) motivo = `Está en Proinversión con fase «${faseOxi || 'sin dato'}» (no es Priorizado ni Por Priorizar)`;
      else if (viableSinOxi) motivo = `${base}; PMI sin verificar${pmiDetalle ? ` (${pmiDetalle})` : ''}`;
      else motivo = 'No aparece en ninguna carga del Banco ni de Proinversión';
    }

    // ── Casos borde
    for (const [f, de, en] of [[b, 'del Banco', 'el Banco'], [p, 'de Proinversión', 'Proinversión']]) {
      if (f?.repeticiones > 1) avisos.push(`CUI repetido ${f.repeticiones} veces en la carga ${de} del ${fechaCorta(f.fecha_carga)}; se tomó la última fila`);
      avisos.push(...cambiosDeEntidad(f, en));
    }

    // ── Diferencia con el estado del radar (no se cambia, solo se señala)
    let diferencia = null;
    if (r && !ESTADOS_COMPATIBLES[situacion].includes(r.estado))
      diferencia = `Las fuentes indican «${SITUACION[situacion].label}», pero tu estado en el radar es «${ETIQUETA_ESTADO[r.estado] || r.estado}»`;

    const cargasFila = [
      b && { fuente: 'invierte_pe', carga_id: b.carga_id, fecha_carga: b.fecha_carga, nombre_archivo: b.nombre_archivo },
      p && { fuente: 'proinversion', carga_id: p.carga_id, fecha_carga: p.fecha_carga, nombre_archivo: p.nombre_archivo },
      filaPmi && { fuente: 'pmi', carga_id: filaPmi.carga_id, fecha_carga: filaPmi.fecha_carga, nombre_archivo: null },
      !filaPmi && cargaOpmi && { fuente: 'pmi', carga_id: cargaOpmi.id, fecha_carga: cargaOpmi.fecha_carga, nombre_archivo: cargaOpmi.nombre_archivo || null }
    ].filter(Boolean);
    for (const c of cargasFila) if (!c.nombre_archivo) c.nombre_archivo = cargas.find(x => x.id === c.carga_id)?.nombre_archivo || null;

    const nombre = b?.nombre || p?.nombre || r?.nombre || null;
    return {
      cui,
      es_idea: idea,
      codigo: idea && !enBanco ? IDEA_SIN_CUI : cui,
      nombre,
      entidad: b?.entidad || p?.entidad || r?.entidad || null,
      entidad_tipo: b?.entidad_tipo || p?.entidad_tipo || r?.entidad_tipo || null,
      region: b?.region || p?.region || r?.region || null,
      provincia: b?.provincia || p?.provincia || r?.provincia || null,
      distrito: b?.distrito || p?.distrito || r?.distrito || null,
      funcion: b?.funcion || p?.funcion || r?.funcion || null,
      monto_inversion: num(b?.monto_inversion) ?? num(p?.monto_inversion) ?? num(r?.monto_inversion),
      es_mobiliario: esMobiliario(nombre) || !!r?.es_mobiliario,
      en_banco: enBanco,
      estado_inversion: b?.estado_inversion || null,
      en_proinversion: enPro,
      fase_oxi: faseOxi,
      nivel_estudio: (enPro ? p.nivel_estudio : null) || null,
      en_pmi: enPmi,
      en_pmi_origen: pmiOrigen,
      en_pmi_detalle: pmiDetalle,
      en_pmi_motivo: motivoSv?.clave || null,          // solo si en_pmi = sin_verificar
      en_pmi_motivo_label: motivoSv ? MOTIVO_PMI[motivoSv.clave] : null,
      en_pmi_motivo_texto: motivoSv?.texto || null,
      pmi_opmi: filaPmi?.opmi || cargaOpmi?.opmi || null,
      pmi_periodo: filaPmi?.periodo || null,
      pmi_manual: m ? { en_pmi: m.en_pmi, revisado_en: m.revisado_en, nota: m.nota } : null,
      situacion,
      situacion_label: SITUACION[situacion].label,
      prioridad: SITUACION[situacion].prioridad,
      motivo,
      cargas: cargasFila,
      avisos,
      claves_opmi: clavesEntidad,
      proyecto_id: r?.id || null,
      estado_radar: r?.estado || null,
      diferencia_estado: diferencia
    };
  });

  filas.sort((x, y) => x.prioridad - y.prioridad || (y.monto_inversion ?? -1) - (x.monto_inversion ?? -1) || x.cui.localeCompare(y.cui));
  const pmiCargados = resumenPmi(pmiCargas, claves, vigentePorClave, filas);
  for (const f of filas) delete f.claves_opmi;
  return { filas, cargas: resumenCargas(cargas), pmi_cargados: pmiCargados };
}

// Panel «PMI cargados»: cada carga del PMI con su OPMI, filas y fecha; si está
// vigente o la reemplazó otra más reciente; cuántos proyectos del cruce cubre.
// Y las entidades con más proyectos cuya OPMI falta cargar.
export function resumenPmi(pmiCargas, claves, vigentePorClave, filas) {
  const lista = pmiCargas.map(c => {
    const ks = [...claves.get(c.id)];
    const reemplazo = ks.map(k => vigentePorClave.get(k)).find(v => v && v.id !== c.id);
    return {
      id: c.id, opmi: c.opmi || null, nombre_archivo: c.nombre_archivo, filas: c.filas, fecha_carga: c.fecha_carga,
      filtros: c.filtros || {}, vigente: !ks.length || ks.some(k => vigentePorClave.get(k)?.id === c.id),
      reemplazada_por: reemplazo ? { id: reemplazo.id, fecha_carga: reemplazo.fecha_carga, nombre_archivo: reemplazo.nombre_archivo } : null,
      proyectos_cubiertos: filas.filter(f => f.claves_opmi.some(k => ks.includes(k))).length,
      proyectos_en_pmi: filas.filter(f => f.en_pmi_origen === 'archivo' && f.en_pmi === 'si' && f.cargas.some(x => x.fuente === 'pmi' && x.carga_id === c.id)).length
    };
  });
  const faltan = new Map();
  for (const f of filas) if (f.en_pmi_motivo === 'opmi_no_cargada' && f.entidad) faltan.set(f.entidad, (faltan.get(f.entidad) || 0) + 1);
  const opmi_faltantes = [...faltan].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([entidad, proyectos]) => ({ entidad, proyectos }));
  return { cargas: lista, opmi_faltantes, total_opmi_faltantes: faltan.size };
}

// Última carga de cada fuente y el historial (para saber cuán fresca es la información)
export function resumenCargas(cargas) {
  const ordenadas = [...cargas].sort((a, b) => new Date(b.fecha_carga) - new Date(a.fecha_carga));
  const ultimas = Object.fromEntries(FUENTES_CARGA.map(f => [f, ordenadas.find(c => c.fuente === f) || null]));
  const totales = Object.fromEntries(FUENTES_CARGA.map(f => [f, ordenadas.filter(c => c.fuente === f).length]));
  return { ultimas, totales, historial: ordenadas.slice(0, 50) };
}
