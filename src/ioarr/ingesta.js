// ============================================================================
// src/ioarr/ingesta.js — Servicio de ingestión de proyectos IOARR (aislado)
//
// Fase 1: SOLO archivos subidos a mano (Excel/CSV) exportados desde:
//   - Banco de Inversiones (Invierte.pe)       → fuente 'invierte_pe'
//   - Lista de priorización de Proinversión    → fuente 'proinversion'
// NO se hace scraping de esos portales (algunos bloquean bots en robots.txt).
//
// Flujo: leerArchivo() → detectarMapeo() (el usuario puede corregirlo en la
// pantalla) → filaAProyecto() → importarProyectos() (upsert por CUI y evento
// 'cambio_estado' cuando el estado avanza).
//
// ─── Puntos de extensión para FASES FUTURAS ─────────────────────────────────
// Para agregar una fuente oficial/automática (p. ej. datosabiertos.mef.gob.pe,
// que publica el Banco de Inversiones como CSV/API abierta):
//   1. Crear una función `obtenerDesdeDatosAbiertos()` que descargue el recurso
//      (respetando robots.txt y términos de uso) y devuelva un Buffer o filas.
//   2. Pasar esas filas por detectarMapeo()/filaAProyecto() con su `fuente`.
//   3. Llamar importarProyectos() — el upsert, la regla de "solo avanzar
//      estado" y los eventos ya quedan resueltos aquí.
//   4. Programarla con node-cron en server.js (igual que IOARR_CRON).
// ============================================================================

import * as XLSX from 'xlsx';

// Campos de ioarr_proyectos que se pueden mapear desde un archivo
export const CAMPOS_MAPEABLES = [
  'cui', 'nombre', 'entidad', 'entidad_tipo', 'region', 'provincia', 'distrito',
  'funcion', 'tipo_inversion', 'monto_inversion', 'estado', 'url_fuente'
];

// Orden del ciclo OxI. Las importaciones solo AVANZAN el estado (nunca retroceden).
export const ORDEN_ESTADOS = [
  'viable', 'priorizada_oxi', 'convenio', 'en_proceso_seleccion',
  'en_ejecucion', 'bienes_entregados', 'ciprl_emitido'
];
const ESTADOS_FINALES = ['cerrada', 'descartada'];

// Sinónimos de encabezados (normalizados: MAYÚSCULAS, sin tildes ni "_").
// El orden de las claves importa: los campos más específicos se reclaman primero.
const SINONIMOS = {
  cui:             ['CODIGO UNICO DE INVERSION', 'CODIGO UNICO', 'CUI', 'COD UNICO', 'CODIGO DE INVERSION'],
  tipo_inversion:  ['TIPO DE INVERSION', 'TIPO INVERSION', 'TIPO DE FORMATO', 'TIPO FORMATO', 'TIPO DE INTERVENCION', 'NATURALEZA'],
  entidad_tipo:    ['NIVEL DE GOBIERNO', 'NIVEL GOBIERNO', 'NIVEL'],
  monto_inversion: ['MONTO DE INVERSION', 'MONTO INVERSION', 'COSTO ACTUALIZADO', 'MONTO ACTUALIZADO', 'MONTO VIABLE', 'COSTO DE INVERSION', 'MONTO', 'COSTO'],
  estado:          ['ESTADO DE LA INVERSION', 'ESTADO', 'SITUACION', 'FASE'],
  nombre:          ['NOMBRE DE LA INVERSION', 'NOMBRE DE INVERSION', 'NOMBRE INVERSION', 'NOMBRE DEL PROYECTO', 'INTERVENCION', 'NOMBRE', 'DESCRIPCION'],
  entidad:         ['ENTIDAD PUBLICA', 'ENTIDAD', 'UNIDAD EJECUTORA', 'UNIDAD FORMULADORA', 'UEI'],
  region:          ['DEPARTAMENTO', 'REGION'],
  provincia:       ['PROVINCIA'],
  distrito:        ['DISTRITO'],
  funcion:         ['FUNCION', 'SECTOR'],
  url_fuente:      ['URL', 'ENLACE', 'LINK']
};

// ─── Helpers puros ──────────────────────────────────────────────────────────
export function normaliza(v) {
  if (v == null) return '';
  return String(v).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[_\s]+/g, ' ').trim();
}

// Acepta 1234567.89 | "1,234,567.89" | "1.234.567,89" | "S/ 1 234 567" → número o null
export function parseMonto(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const ultComa = s.lastIndexOf(','), ultPunto = s.lastIndexOf('.');
  if (ultComa > -1 && ultPunto > -1) {
    // El separador que aparece al final es el decimal
    s = ultComa > ultPunto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (ultComa > -1) {
    // Solo comas: "1,234,567" = miles; "1234,5" = decimal
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    s = s.replace(/\./g, ''); // "1.234.567" = miles
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function limpiaCui(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\.0+$/, '');
  return s || null;
}

// Detecta mobiliario escolar por el nombre de la inversión
export function esMobiliario(texto) {
  return /MOBILIARI|CARPETA|PUPITRE|\bSILLAS?\b|\bMESAS?\b|\bESTANTE/.test(normaliza(texto));
}

export function esIoarr(tipo) {
  const t = normaliza(tipo);
  return t.includes('IOARR') || /OPTIMIZACION|AMPLIACION MARGINAL|REPOSICION|REHABILITACION/.test(t);
}

export function mapEntidadTipo(nivel, entidad) {
  const t = normaliza(`${nivel || ''} ${entidad || ''}`);
  if (/\bGR\b|GORE|REGIONAL/.test(t)) return 'GORE';
  if (/\bGL\b|LOCAL|MUNICIPAL/.test(t)) return 'GL';
  if (/\bGN\b|NACIONAL|MINISTERIO|PROGRAMA NACIONAL/.test(t)) return 'GN';
  return null;
}

// Texto de estado de la fuente → estado del modelo (null si no se reconoce)
export function mapEstado(texto) {
  const t = normaliza(texto);
  if (!t) return null;
  if (/DESACTIV|CANCELAD|DESCART|ANULAD/.test(t)) return 'descartada';
  if (/CERRAD|CIERRE/.test(t)) return 'cerrada';
  if (t.includes('CIPRL')) return 'ciprl_emitido';
  if (/ENTREG|CONFORMIDAD|RECEPCION/.test(t)) return 'bienes_entregados';
  if (/EJECUCION|CONTRATAD/.test(t)) return 'en_ejecucion';
  if (/SELECCION|CONVOCA|BUENA PRO|ADJUDIC/.test(t)) return 'en_proceso_seleccion';
  if (t.includes('CONVENIO')) return 'convenio';
  if (t.includes('PRIORIZ')) return 'priorizada_oxi';
  if (/VIABLE|ACTIVO|APROBAD|REGISTRAD|FORMULACION/.test(t)) return 'viable';
  return null;
}

// Regla de actualización: un estado final (cerrada/descartada) siempre se aplica;
// si el actual ya es final, se respeta (decisión manual); si no, solo se avanza.
export function resolverEstado(actual, nuevo) {
  if (!nuevo) return actual || 'viable';
  if (!actual) return nuevo;
  if (ESTADOS_FINALES.includes(nuevo)) return nuevo;
  if (ESTADOS_FINALES.includes(actual)) return actual;
  return ORDEN_ESTADOS.indexOf(nuevo) > ORDEN_ESTADOS.indexOf(actual) ? nuevo : actual;
}

// ─── Lectura del archivo ────────────────────────────────────────────────────
// Lee Excel (.xlsx/.xls) o CSV. Busca la fila de encabezado en las primeras 10
// (los exportes oficiales suelen traer títulos arriba).
export function leerArchivo(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  for (let fila = 0; fila < 10; fila++) {
    const rows = XLSX.utils.sheet_to_json(hoja, { range: fila, defval: null });
    if (!rows.length) continue;
    const headers = Object.keys(rows[0]);
    if (headers.some(h => SINONIMOS.cui.some(s => normaliza(h).includes(s)))) {
      return { headers, rows };
    }
  }
  // Sin columna CUI reconocible: se devuelve la primera fila como encabezado
  const rows = XLSX.utils.sheet_to_json(hoja, { defval: null });
  return { headers: rows.length ? Object.keys(rows[0]) : [], rows };
}

// Propone un mapeo campo → encabezado (primero coincidencia exacta, luego "contiene")
export function detectarMapeo(headers) {
  const usados = new Set();
  const mapeo = {};
  for (const [campo, sinonimos] of Object.entries(SINONIMOS)) {
    let elegido = null;
    for (const s of sinonimos) {
      elegido = headers.find(h => !usados.has(h) && normaliza(h) === s);
      if (elegido) break;
    }
    if (!elegido) {
      for (const s of sinonimos) {
        elegido = headers.find(h => !usados.has(h) && normaliza(h).includes(s));
        if (elegido) break;
      }
    }
    mapeo[campo] = elegido || null;
    if (elegido) usados.add(elegido);
  }
  return mapeo;
}

// Convierte una fila del archivo en un proyecto (o null si no tiene CUI/nombre)
export function filaAProyecto(row, mapeo, { fuente }) {
  const val = (campo) => {
    const col = mapeo[campo];
    const v = col ? row[col] : null;
    return v == null || String(v).trim() === '' ? null : String(v).trim();
  };
  const cui = limpiaCui(val('cui'));
  const nombre = val('nombre');
  if (!cui || !nombre) return null;

  let estado = mapEstado(val('estado'));
  // La lista de Proinversión implica, como mínimo, priorización OxI
  if (fuente === 'proinversion' && (!estado || estado === 'viable')) estado = 'priorizada_oxi';

  return {
    cui,
    nombre,
    entidad: val('entidad'),
    entidad_tipo: mapEntidadTipo(val('entidad_tipo'), val('entidad')),
    region: normaliza(val('region')) || null,
    provincia: normaliza(val('provincia')) || null,
    distrito: normaliza(val('distrito')) || null,
    funcion: val('funcion'),
    tipo_inversion: val('tipo_inversion') ? (esIoarr(val('tipo_inversion')) ? 'IOARR' : val('tipo_inversion')) : null,
    monto_inversion: parseMonto(mapeo.monto_inversion ? row[mapeo.monto_inversion] : null),
    estado: estado || 'viable',
    url_fuente: val('url_fuente'),
    es_mobiliario: esMobiliario(nombre),
    fuente
  };
}

// ─── Upsert en Supabase ─────────────────────────────────────────────────────
const CAMPOS_COMPARABLES = ['nombre', 'entidad', 'entidad_tipo', 'region', 'provincia', 'distrito',
  'funcion', 'tipo_inversion', 'monto_inversion', 'estado', 'url_fuente', 'es_mobiliario', 'fuente'];

const ETIQUETA_FUENTE = { invierte_pe: 'Banco de Inversiones (Invierte.pe)', proinversion: 'Priorización Proinversión' };

export async function importarProyectos(supabase, proyectos, { fuente }) {
  // Deduplicar por CUI (la última fila gana)
  const porCui = new Map();
  proyectos.forEach(p => porCui.set(p.cui, p));
  const entrantes = [...porCui.values()];

  // Traer los existentes en bloques
  const existentes = new Map();
  for (let i = 0; i < entrantes.length; i += 200) {
    const cuis = entrantes.slice(i, i + 200).map(p => p.cui);
    const { data, error } = await supabase.from('ioarr_proyectos').select('*').in('cui', cuis);
    if (error) throw error;
    data.forEach(p => existentes.set(p.cui, p));
  }

  const resumen = { recibidos: entrantes.length, nuevos: 0, actualizados: 0, cambios_estado: 0, sin_cambios: 0 };
  const filas = [];
  const eventosPendientes = []; // { cui, tipo, detalle }
  const origen = ETIQUETA_FUENTE[fuente] || fuente;

  for (const p of entrantes) {
    const ex = existentes.get(p.cui);
    if (!ex) {
      filas.push({ ...p, etapa_financista: 'detectada', notas: null });
      eventosPendientes.push({ cui: p.cui, tipo: 'hito', detalle: `Proyecto detectado vía ${origen} (estado: ${p.estado})` });
      resumen.nuevos++;
      continue;
    }
    // Fusionar: el dato entrante no vacío reemplaza; se preservan campos manuales
    const fusion = { ...ex };
    for (const k of CAMPOS_COMPARABLES) {
      if (p[k] !== null && p[k] !== undefined) fusion[k] = p[k];
    }
    fusion.estado = resolverEstado(ex.estado, p.estado);
    fusion.es_mobiliario = ex.es_mobiliario || p.es_mobiliario;
    fusion.entidad_tipo = p.entidad_tipo || ex.entidad_tipo;

    const cambio = CAMPOS_COMPARABLES.some(k => String(fusion[k] ?? '') !== String(ex[k] ?? '')
      && !(k === 'monto_inversion' && Number(fusion[k]) === Number(ex[k])));
    if (!cambio) { resumen.sin_cambios++; continue; }

    if (fusion.estado !== ex.estado) {
      eventosPendientes.push({ cui: p.cui, tipo: 'cambio_estado', detalle: `${ex.estado} → ${fusion.estado} (${origen})` });
      resumen.cambios_estado++;
    }
    const { id, creado_en, actualizado_en, ...resto } = fusion;
    filas.push(resto);
    resumen.actualizados++;
  }

  // Upsert por CUI en bloques de 500; todas las filas llevan las mismas columnas
  const idPorCui = new Map();
  for (let i = 0; i < filas.length; i += 500) {
    const { data, error } = await supabase.from('ioarr_proyectos')
      .upsert(filas.slice(i, i + 500), { onConflict: 'cui' }).select('id, cui');
    if (error) throw error;
    data.forEach(r => idPorCui.set(r.cui, r.id));
  }

  const eventos = eventosPendientes
    .filter(e => idPorCui.has(e.cui))
    .map(e => ({ proyecto_id: idPorCui.get(e.cui), tipo: e.tipo, detalle: e.detalle }));
  for (let i = 0; i < eventos.length; i += 500) {
    const { error } = await supabase.from('ioarr_eventos').insert(eventos.slice(i, i + 500));
    if (error) throw error;
  }
  return resumen;
}
