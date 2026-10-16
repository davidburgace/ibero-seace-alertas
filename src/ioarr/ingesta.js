// ============================================================================
// src/ioarr/ingesta.js — Servicio de ingestión de proyectos IOARR (aislado)
//
// Fase 1: SOLO archivos subidos a mano (Excel/CSV) exportados desde:
//   - Banco de Inversiones (Invierte.pe)       → fuente 'invierte_pe'
//   - Lista de priorización de Proinversión    → fuente 'proinversion'
// NO se hace scraping de esos portales (algunos bloquean bots en robots.txt).
//
// Flujo: leerArchivo() (detecta la fila de encabezado bajo el banner) →
// detectarMapeo() + aplicarMapeoGuardado() (el usuario puede corregirlo en la
// pantalla y se recuerda por fuente) → filaAProyecto() → importarProyectos() (upsert por CUI y evento
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

// Campos que se pueden mapear desde un archivo (el orden es el de la pantalla).
// nivel_gobierno se guarda como entidad_tipo (GORE/GL/GN); estado_oxi y estado
// se combinan en el estado del modelo.
export const CAMPOS_MAPEABLES = [
  'cui', 'nombre', 'entidad', 'nivel_gobierno', 'region', 'provincia', 'distrito',
  'funcion', 'tipologia', 'tipo_inversion', 'monto_inversion', 'estado_oxi', 'estado',
  'nivel_estudio', 'url_fuente'
];

// Orden del ciclo OxI. Las importaciones solo AVANZAN el estado (nunca retroceden).
export const ORDEN_ESTADOS = [
  'viable', 'priorizada_oxi', 'convenio', 'en_proceso_seleccion',
  'en_ejecucion', 'bienes_entregados', 'ciprl_emitido'
];
const ESTADOS_FINALES = ['cerrada', 'descartada'];

// Sinónimos de encabezados (normalizados: MAYÚSCULAS, sin tildes ni "_").
// Se busca primero la coincidencia exacta y luego la parcial por palabras
// completas ("MONTO" encaja en "MONTO DE INVERSION REFERENCIAL", pero "CUI" no
// en "CIRCUITO"). El orden de las claves importa: los campos más específicos se
// reclaman primero (nivel_estudio antes que nivel_gobierno, estado_oxi antes que estado).
const SINONIMOS = {
  cui:             ['CODIGO UNICO DE INVERSION', 'CODIGO UNICO', 'CUI', 'COD UNICO', 'CODIGO DE INVERSION', 'CODIGO SNIP', 'CODIGO IDEA'],
  nivel_estudio:   ['ULTIMO NIVEL DE ESTUDIO', 'NIVEL DE ESTUDIO'],
  tipologia:       ['TIPOLOGIA'],
  tipo_inversion:  ['TIPO DE INVERSION', 'TIPO INVERSION', 'TIPO DE FORMATO', 'TIPO FORMATO', 'TIPO DE INTERVENCION', 'NATURALEZA'],
  nivel_gobierno:  ['NIVEL DE GOBIERNO', 'NIVEL GOBIERNO', 'NIVEL'],
  monto_inversion: ['MONTO DE INVERSION REFERENCIAL', 'MONTO DE INVERSION', 'MONTO INVERSION', 'COSTO ACTUALIZADO', 'MONTO ACTUALIZADO', 'MONTO VIABLE', 'COSTO DE INVERSION', 'MONTO', 'COSTO'],
  estado_oxi:      ['FASE OXI', 'ESTADO OXI'],
  estado:          ['ESTADO DE LA INVERSION', 'ESTADO', 'SITUACION', 'FASE'],
  nombre:          ['NOMBRE DE LA INVERSION', 'NOMBRE DE INVERSION', 'NOMBRE INVERSION', 'NOMBRE DEL PROYECTO', 'INTERVENCION', 'NOMBRE', 'DESCRIPCION'],
  entidad:         ['ENTIDAD PUBLICA', 'ENTIDAD', 'UNIDAD EJECUTORA', 'UNIDAD FORMULADORA', 'UEI'],
  region:          ['DEPARTAMENTO', 'REGION'],
  provincia:       ['PROVINCIA'],
  distrito:        ['DISTRITO'],
  funcion:         ['FUNCION', 'SECTOR'],
  url_fuente:      ['LINK WEB', 'URL', 'ENLACE', 'LINK']
};

// Palabras que delatan la fila de encabezado (ver detectarFilaEncabezado)
const CLAVES_ENCABEZADO = ['CUI', 'CODIGO', 'NOMBRE', 'PROYECTO', 'ENTIDAD', 'DEPARTAMENTO'];
const FILAS_A_EXPLORAR = 30;

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
  // "S/." y "S/" van fuera antes de filtrar, o el punto de "S/." pasaría por decimal
  let s = String(v).replace(/S\/\.?/gi, '').replace(/[^\d.,-]/g, '');
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

// El CUI se guarda siempre como texto: 2603315 → "2603315"; "idea0000110" → "IDEA0000110"
export function limpiaCui(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\.0+$/, '').replace(/\s+/g, '');
  if (!s) return null;
  return esIdea(s) ? s.toUpperCase() : s;
}

// Código de idea de inversión (aún no es un proyecto registrado con CUI)
export function esIdea(cui) {
  return /^IDEA/i.test(String(cui ?? '').trim());
}

// Detecta mobiliario escolar por el nombre de la inversión
export function esMobiliario(texto) {
  return /MOBILIARI|EQUIPAMIENTO|CARPETA|\bBANCAS?\b|PUPITRE|\bSILLAS?\b|\bMESAS?\b|\bESTANTE/.test(normaliza(texto));
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
  // "Por Priorizar" (Proinversión) = viable aún sin priorizar; va antes de PRIORIZ
  if (/POR PRIORIZAR|SIN PRIORIZ|NO PRIORIZ|PENDIENTE DE PRIORIZ/.test(t)) return 'viable';
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
// Las URL de las celdas con hipervínculo viajan en esta propiedad oculta de cada
// fila (no sale en JSON), para guardar el destino del enlace y no su texto ("Enlace").
const LINKS = Symbol('links');

// Palabra completa dentro de un texto ya normalizado
const contienePalabra = (texto, palabra) => new RegExp(`(^|[^A-Z0-9])${palabra}([^A-Z0-9]|$)`).test(texto);

function valorDeCelda(cell) {
  if (!cell || cell.v == null) return null;
  if (typeof cell.v === 'string') return cell.v.trim() || null;
  return cell.v;
}

// Destino de un hipervínculo de Excel, sea enlace de celda o fórmula =HIPERVINCULO("url"; "texto")
function urlDeCelda(cell) {
  if (!cell) return null;
  if (cell.l?.Target) return cell.l.Target;
  const m = /HYPERLINK\(\s*"([^"]+)"/i.exec(cell.f || '');
  return m ? m[1] : null;
}

// Primera fila (de las 30 primeras) con al menos 4 textos y alguna palabra clave
// de encabezado. Los reportes oficiales traen arriba un banner con título,
// "Última actualización", "Nº Registros"… que no cumple ambas condiciones.
// Si ninguna llega a 4, se repite con 2 (archivos pequeños hechos a mano).
export function detectarFilaEncabezado(matriz) {
  for (const minimo of [4, 2]) {
    for (let i = 0; i < Math.min(matriz.length, FILAS_A_EXPLORAR); i++) {
      const textos = matriz[i].filter(v => typeof v === 'string' && v.trim()).map(normaliza);
      if (textos.length >= minimo && textos.some(t => CLAVES_ENCABEZADO.some(k => t.includes(k)))) return i;
    }
  }
  return -1;
}

// Pie del reporte ("Fuente: …", "Total …") o fila con una sola celda escrita
function esFilaPie(valores) {
  const llenos = valores.filter(v => v != null);
  if (llenos.length < 2) return true;
  return /^(TOTAL|FUENTE|NOTA|ELABORAD|ELABORACION)\b/.test(normaliza(llenos[0]));
}

function leerHoja(hoja) {
  if (!hoja?.['!ref']) return null;
  const rango = XLSX.utils.decode_range(hoja['!ref']);
  const celda = (r, c) => hoja[XLSX.utils.encode_cell({ r: rango.s.r + r, c: rango.s.c + c })];
  const nFilas = rango.e.r - rango.s.r + 1, nCols = rango.e.c - rango.s.c + 1;
  const matriz = Array.from({ length: nFilas }, (_, r) => Array.from({ length: nCols }, (_, c) => valorDeCelda(celda(r, c))));

  const filaEnc = detectarFilaEncabezado(matriz);
  if (filaEnc < 0) return null;
  const datos = matriz.slice(filaEnc + 1);

  // Columnas: se ignoran las totalmente vacías (p. ej. la columna A del Excel de
  // Proinversión); una columna con datos pero sin título recibe su letra.
  const columnas = [];
  const vistos = new Map();
  for (let c = 0; c < nCols; c++) {
    let titulo = matriz[filaEnc][c] == null ? '' : String(matriz[filaEnc][c]).replace(/\s+/g, ' ').trim();
    if (!titulo && datos.every(f => f[c] == null)) continue;
    if (!titulo) titulo = `Columna ${XLSX.utils.encode_col(rango.s.c + c)}`;
    const n = (vistos.get(titulo) || 0) + 1;
    vistos.set(titulo, n);
    columnas.push({ c, titulo: n > 1 ? `${titulo} (${n})` : titulo });
  }

  const rows = [];
  datos.forEach((fila, i) => {
    const valores = columnas.map(({ c }) => fila[c]);
    if (esFilaPie(valores)) return;
    const row = Object.fromEntries(columnas.map(({ titulo }, k) => [titulo, valores[k]]));
    const links = {};
    for (const { c, titulo } of columnas) {
      const url = urlDeCelda(celda(filaEnc + 1 + i, c));
      if (url) links[titulo] = url;
    }
    if (Object.keys(links).length) row[LINKS] = links;
    rows.push(row);
  });
  return { headers: columnas.map(x => x.titulo), rows, fila_encabezado: rango.s.r + filaEnc + 1 };
}

// Lee Excel (.xlsx/.xls) o CSV. Usa la primera hoja donde se reconozca un
// encabezado; si ninguna lo tiene, toma la fila 1 de la primera hoja.
export function leerArchivo(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false, cellFormula: true });
  for (const nombre of wb.SheetNames) {
    const r = leerHoja(wb.Sheets[nombre]);
    if (r) return { ...r, hoja: nombre };
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  return { headers: rows.length ? Object.keys(rows[0]) : [], rows, fila_encabezado: 1, hoja: wb.SheetNames[0] };
}

// Propone un mapeo campo → encabezado (primero coincidencia exacta, luego por palabras)
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
        elegido = headers.find(h => !usados.has(h) && contienePalabra(normaliza(h), s));
        if (elegido) break;
      }
    }
    mapeo[campo] = elegido || null;
    if (elegido) usados.add(elegido);
  }
  return Object.fromEntries(CAMPOS_MAPEABLES.map(c => [c, mapeo[c] ?? null]));
}

// Combina el mapeo automático con el que el usuario confirmó en la última carga
// de la misma fuente: gana el guardado, siempre que esa columna siga existiendo.
export function aplicarMapeoGuardado(headers, auto, guardado) {
  if (!guardado) return auto;
  const mapeo = { ...auto };
  for (const campo of CAMPOS_MAPEABLES) {
    const col = guardado[campo];
    if (!col || !headers.includes(col)) continue;
    for (const otro of CAMPOS_MAPEABLES) if (otro !== campo && mapeo[otro] === col && !guardado[otro]) mapeo[otro] = null;
    mapeo[campo] = col;
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

  // El estado combina la columna de estado general y la fase OxI (la más avanzada;
  // un estado final como "Desactivado" siempre manda)
  const estadoOxiTexto = val('estado_oxi');
  const deEstado = mapEstado(val('estado')), deOxi = mapEstado(estadoOxiTexto);
  let estado = deEstado && deOxi ? resolverEstado(deEstado, deOxi) : (deEstado || deOxi);
  // Sin columna de fase OxI, la lista de Proinversión implica, como mínimo, priorización
  if (fuente === 'proinversion' && !estadoOxiTexto && (!estado || estado === 'viable')) estado = 'priorizada_oxi';

  // Hipervínculo: se guarda su destino, no el texto visible de la celda
  const colUrl = mapeo.url_fuente;
  const url = (colUrl && row[LINKS]?.[colUrl]) || val('url_fuente');

  return {
    cui,
    nombre,
    entidad: val('entidad'),
    entidad_tipo: mapEntidadTipo(val('nivel_gobierno') ?? val('entidad_tipo'), val('entidad')),
    region: normaliza(val('region')) || null,
    provincia: normaliza(val('provincia')) || null,
    distrito: normaliza(val('distrito')) || null,
    funcion: val('funcion'),
    tipologia: val('tipologia'),
    tipo_inversion: val('tipo_inversion') ? (esIoarr(val('tipo_inversion')) ? 'IOARR' : val('tipo_inversion')) : null,
    monto_inversion: parseMonto(mapeo.monto_inversion ? row[mapeo.monto_inversion] : null),
    estado: estado || 'viable',
    estado_oxi_texto: estadoOxiTexto,
    nivel_estudio: val('nivel_estudio'),
    url_fuente: url && /^(https?:\/\/|www\.)/i.test(url) ? url : null,
    es_mobiliario: esMobiliario(nombre),
    es_idea: esIdea(cui),
    fuente
  };
}

// ─── Upsert en Supabase ─────────────────────────────────────────────────────
const CAMPOS_COMPARABLES = ['nombre', 'entidad', 'entidad_tipo', 'region', 'provincia', 'distrito',
  'funcion', 'tipologia', 'tipo_inversion', 'monto_inversion', 'estado', 'estado_oxi_texto', 'nivel_estudio',
  'url_fuente', 'es_mobiliario', 'es_idea', 'fuente'];

const textoFuente = (p) => p.estado_oxi_texto ? `, fase OxI «${p.estado_oxi_texto}»` : '';

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
      eventosPendientes.push({ cui: p.cui, tipo: 'hito',
        detalle: `${p.es_idea ? 'Idea de inversión' : 'Proyecto'} detectado vía ${origen} (estado: ${p.estado}${textoFuente(p)})` });
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
      eventosPendientes.push({ cui: p.cui, tipo: 'cambio_estado', detalle: `${ex.estado} → ${fusion.estado} (${origen}${textoFuente(p)})` });
      resumen.cambios_estado++;
    } else if (p.estado !== ex.estado && fusion.estado_oxi_texto !== ex.estado_oxi_texto) {
      // La fuente reporta un estado anterior: no se retrocede, pero queda constancia
      eventosPendientes.push({ cui: p.cui, tipo: 'hito',
        detalle: `${origen} reporta ${p.estado}${textoFuente(p)}; se mantiene ${ex.estado} (el estado solo avanza)` });
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
