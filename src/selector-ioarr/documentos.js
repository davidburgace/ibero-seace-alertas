// ============================================================================
// src/selector-ioarr/documentos.js — Etapa 2 del expediente IOARR: documentos
//
// Arma, con los datos del proyecto, un modelo único que usan los dos Word
// (src/selector-ioarr/word.js):
//   - Borrador del Formato 07-C (Registro de IOARR). El registro oficial se hace
//     en el aplicativo del Banco de Inversiones; el Word sirve para preparar y
//     revisar lo que se va a registrar.
//   - Memoria descriptiva.
//
// Reglas (Lineamientos IOARR del MEF, 9.ª versión, junio 2025, y Anexo C de ejemplos):
//   - Un local → IOARR de reposición (07-C con E.3). Varios locales → inversión
//     masiva de reposición (2.5; 07-C con E.5 y la lista de UP). El mobiliario de
//     aula es el ejemplo de activo homogéneo del propio lineamiento.
//   - Hasta 75 UIT → registro abreviado (sección G). Más de 75 UIT → D, E y F.
//   - Lo que no sale de los datos (UF, UEI, plazo, mantenimiento, antigüedad…)
//     lo carga el usuario; si falta, se lista como pendiente. No se inventan valores.
// ============================================================================

import { ITEMS, TALLAS, NIVN, textoEscenario, textoPct, textoOrigenPct, ROTULO_UMBRAL, DEF as DEF_CRIT } from './calculo.js';
import { TIPOS, LIMITE_UIT, NOTA_FALTANTE } from './costos.js';
import { FUENTES_VIDA_UTIL, limpiarColegios, colegioDe, checklistColegio } from './lineamientos.js';

// Nota del material, dentro de la descripción técnica
export const NOTA_MATERIAL = 'El material debe respetar la ficha técnica aplicable; la entidad convocante puede exigir madera.';
// Grupo de grado de una talla, en palabras: «Educación Primaria, 1.° y 2.° grado»
const grupoTexto = k => {
  const z = TALLAS.find(x => x.k === k);
  if (!z) return '';
  return `Educación ${NIVN[z.nivel]}${z.grados.length ? ', ' + z.grados.map(g => g + '.°').join(' y ') + ' grado' : ''}`;
};
const NF = n => Number(n || 0).toLocaleString('es-PE');
/**
 * Descripción técnica de una meta (kit, mesa, silla…), según el nivel y el grupo de grado de
 * lo que se repone. No copia la descripción del catálogo en mesa, silla ni kit, porque un
 * precio general puede ser de otro nivel o grado. En escritorio, silla docente y armario usa
 * la del catálogo si la hay. Siempre termina con la nota del material y la referencia técnica.
 */
function descripcionMeta(m, precios, refTecnica) {
  const grupos = (m.porTalla || []).map(y => `${grupoTexto(y.talla)} (${NF(y.cantidad)} ${m.k === 'kit' ? (y.cantidad === 1 ? 'kit' : 'kits') : m.u})`);
  let base;
  if (m.k === 'kit') base = `Kit de mobiliario de aula: una mesa y una silla del estudiante por kit, con medidas según el grupo de grado. ${grupos.length ? 'Por grupo de grado: ' + grupos.join('; ') + '.' : ''}`;
  else if (m.k === 'mesa' || m.k === 'silla') base = `${m.n}, con medidas según el grupo de grado. ${grupos.length ? 'Por grupo de grado: ' + grupos.join('; ') + '.' : ''}`;
  else base = precios?.[m.k]?.descripcion ? `${m.n}: ${precios[m.k].descripcion}.` : `${m.n}.`;
  return `${base.trim()} ${NOTA_MATERIAL} Referencia técnica aplicable: ${refTecnica || 'PENDIENTE'}.`;
}

// ─── Datos que carga el usuario ─────────────────────────────────────────────
export const ESTADOS_ACTIVO = ['REGULAR', 'MALO', 'MUY MALO', 'IRRECUPERABLE'];
const UNIDAD_META = { kit: 'Kit de mobiliario', mesa: 'Número de mobiliario (puestos)', silla: 'Número de mobiliario', esc: 'Número de mobiliario', sdoc: 'Número de mobiliario', arm: 'Número de mobiliario' };
const PLURAL = { kit: 'kits de mobiliario (mesa + silla del estudiante)', mesa: 'mesas del estudiante', silla: 'sillas del estudiante', esc: 'escritorios del docente', sdoc: 'sillas del docente', arm: 'armarios o estantes' };
// Clasificación funcional (verificar contra el PMI). Solo el grupo de Primaria lleva código aquí.
export const CODIGOS_FUNCIONALES = { funcion: '22', division: '047', grupo: { P: '0104' } };
// Sugerencias (el usuario escribe lo que corresponda)
export const MODALIDADES = ['Administración directa', 'Administración indirecta – Por contrata', 'Administración indirecta – Obras por Impuestos', 'Administración indirecta – Núcleo ejecutor'];
export const FUENTES_FIN = ['Recursos Ordinarios', 'Recursos Directamente Recaudados', 'Recursos por Operaciones Oficiales de Crédito', 'Donaciones y Transferencias', 'Recursos Determinados'];
// Claves de las metas (para el mantenimiento por meta)
const CLAVES_META = ['kit', ...TIPOS];
const NIVEL = { I: 'INICIAL', P: 'PRIMARIA', S: 'SECUNDARIA', E: 'BÁSICA ESPECIAL' };

// Lista de verificación: lo que el sistema no puede comprobar y se marca a mano
export const VERIF_MANUAL = [
  { id: 'informe_vida_util', texto: 'Informe técnico del área correspondiente que fija la vida útil estimada del mobiliario (Lineamientos IOARR 2.4.C.b; Directiva 005-2016-EF/51.01).' },
  { id: 'cotizaciones', texto: 'Cotizaciones o estudio de mercado que sustentan los precios unitarios.' },
  { id: 'especificaciones', texto: 'Especificaciones técnicas del mobiliario conforme a la norma técnica de mobiliario escolar del Minedu.' },
  { id: 'no_duplicidad', texto: 'Consulta en el Banco de Inversiones: los locales no tienen otra inversión activa que incluya mobiliario (sin duplicidad).' },
  { id: 'pmi', texto: 'La IOARR está en la cartera del PMI de la entidad, o se coordinó su inclusión con la OPMI.' },
  { id: 'actas_directores', texto: 'Constancias de los directores sobre el estado y el uso del mobiliario.' },
  { id: 'panel_fotografico', texto: 'Panel fotográfico por aula, con fecha y firma de quien verificó.' },
  { id: 'estructura_firmada', texto: 'Estructura referencial de costos (Excel) revisada y firmada por el formulador.' },
  { id: 'porcentajes_entidad', texto: 'Porcentajes de la estructura de costos (IGV, documento equivalente, supervisión) y liquidación revisados con las bases de la entidad convocante.' }
];

const texto = (v, max = 300) => String(v ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const parrafo = (v, max = 4000) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const numero = (v, min, max) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const entero = (v, min, max) => { const n = numero(v, min, max); return n == null ? null : Math.round(n); };

const cuiValido = v => /^\d{5,8}$/.test(String(v || '').trim()) ? String(v).trim() : '';

/** Valida lo que guarda el formulario de Documentos. Lo desconocido se descarta. */
export function limpiarDatosDoc(b = {}) {
  const porTipo = (obj, f) => Object.fromEntries(CLAVES_META.map(k => [k, f(obj?.[k])]).filter(([, v]) => v != null && v !== ''));
  const fecha = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.fecha_inicio || '')) ? b.fecha_inicio : null;
  return {
    nombre_inversion: texto(b.nombre_inversion, 500),
    cui: cuiValido(b.cui),
    // Con una IOARR por nivel: nombre y CUI de cada una ({ P: { nombre_inversion, cui } })
    por_nivel: Object.fromEntries(['I', 'P', 'S', 'E'].map(n => [n, b.por_nivel?.[n]]).filter(([, v]) => v && typeof v === 'object')
      .map(([n, v]) => [n, { nombre_inversion: texto(v.nombre_inversion, 500), cui: cuiValido(v.cui) }]).filter(([, v]) => v.nombre_inversion || v.cui)),
    // A. Alineamiento (se proponen por nivel; el usuario los ajusta al PMI)
    servicio_brecha: texto(b.servicio_brecha, 300),
    tipologia: texto(b.tipologia, 300),
    indicador_brecha: texto(b.indicador_brecha, 500),
    unidad_indicador: texto(b.unidad_indicador, 200),
    contribucion_brecha: numero(b.contribucion_brecha, 0, 1e9),
    // C. Unidades productoras: por código de local (solo los que tienen bienes a reponer) o por código modular (todos)
    up_por: b.up_por === 'modular' ? 'modular' : 'local',
    // E. Descripción técnica: referencia técnica aplicable (vacía por defecto; no se inventan normas)
    ref_tecnica: texto(b.ref_tecnica, 500),
    // Datos de ejecución (sin valores por defecto)
    modalidad: texto(b.modalidad, 200),
    fuente_financiamiento: texto(b.fuente_financiamiento, 200),
    // B. Institucionalidad
    opmi: texto(b.opmi, 200), uf: texto(b.uf, 200), uf_responsable: texto(b.uf_responsable, 200),
    uei: texto(b.uei, 200), uei_responsable: texto(b.uei_responsable, 200),
    // D. Estado situacional y mantenimiento
    inventario_registrado: ['si', 'no'].includes(b.inventario_registrado) ? b.inventario_registrado : '',
    codigo_inventario: texto(b.codigo_inventario, 300),
    en_uso: ['si', 'no'].includes(b.en_uso) ? b.en_uso : '',
    ue_mantenimiento: texto(b.ue_mantenimiento, 300),
    ue_mantenimiento_codigo: texto(b.ue_mantenimiento_codigo, 50),
    // E. Por tipo de bien
    antiguedad: porTipo(b.antiguedad, v => numero(v, 0, 100)),
    vida_util_estimada: porTipo(b.vida_util_estimada, v => entero(v, 1, 50)),
    informe_vida_util: texto(b.informe_vida_util, 300),
    // Informe técnico de vida útil: fuentes de la Directiva 005-2016-EF/51.01 y quien firma
    fuentes_vida_util: Array.isArray(b.fuentes_vida_util) ? Object.keys(FUENTES_VIDA_UTIL).filter(k => b.fuentes_vida_util.includes(k)) : [],
    patrimonial_nombre: texto(b.patrimonial_nombre, 200),
    patrimonial_cargo: texto(b.patrimonial_cargo, 200),
    // Por colegio: checklist de inventario y baja… (lineamientos.js); se guarda con PUT /colegios/:cod
    colegios: limpiarColegios(b.colegios),
    // Cuadro de estado situacional: advertencias revisadas, con su explicación ({ clave: { nota, fecha } })
    situacional: { revisiones: Object.fromEntries(Object.entries(b.situacional?.revisiones || {}).slice(0, 200)
      .map(([k, v]) => [String(k).slice(0, 300), { nota: texto(v?.nota, 500), fecha: /^\d{4}-\d{2}-\d{2}$/.test(v?.fecha || '') ? v.fecha : null }]).filter(([, v]) => v.nota)) },
    verificacion: Object.fromEntries(VERIF_MANUAL.map(x => [x.id, b.verificacion?.[x.id]]).filter(([, v]) => v && typeof v === 'object')
      .map(([id, v]) => [id, { ok: v.ok === true, nota: texto(v.nota, 300) }]).filter(([, v]) => v.ok || v.nota)),
    estado_actual: porTipo(b.estado_actual, v => ESTADOS_ACTIVO.includes(v) ? v : null),
    mant_actual: porTipo(b.mant_actual, v => numero(v, 0, 1e9)),
    vida_util: porTipo(b.vida_util, v => entero(v, 1, 30)),
    mant_nuevo: porTipo(b.mant_nuevo, v => numero(v, 0, 1e9)),
    sustento: parrafo(b.sustento),
    // F. Plazo
    fecha_inicio: fecha,
    plazo_unidad: b.plazo_unidad === 'dias' ? 'dias' : 'meses',
    meses: entero(b.meses, 1, 36),
    dias: entero(b.dias, 1, 1095),
    // Memoria descriptiva
    antecedentes: parrafo(b.antecedentes),
    objetivo: parrafo(b.objetivo, 1500)
  };
}

// ─── Utilidades ─────────────────────────────────────────────────────────────
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const mayus = s => String(s || '').toLocaleUpperCase('es-PE');
const lista = xs => xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' y ' + xs[xs.length - 1];
// Reparte un total en n partes que suman exacto (la diferencia de redondeo va a la última)
function repartir(total, n, decimales = 2) {
  if (!n) return [];
  const f = 10 ** decimales, base = Math.floor(total * f / n) / f, out = Array(n).fill(base);
  out[n - 1] = Math.round((total - base * (n - 1)) * f) / f;
  return out;
}
// Reparte unidades enteras: el resto va a los primeros meses
function repartirEnteros(total, n) {
  if (!n) return [];
  const base = Math.floor(total / n), resto = total - base * n;
  return Array.from({ length: n }, (_, j) => base + (j < resto ? 1 : 0));
}
const fechaPe = d => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ─── Modelo de los documentos ───────────────────────────────────────────────
/**
 * @param {object} p
 *   R          resultado de costear() (con el escenario y el kit del proyecto)
 *   D, list    datos de la región (prep) e índices de los locales del proyecto
 *   proyecto   { nombre, region, ioarr }
 *   datos      limpiarDatosDoc()
 *   precios    detalle de precios del catálogo por tipo (descripción de escritorio, silla docente y armario)
 *   efectivos  precios de mercado con su origen (preciosEfectivos de costos.js)
 *   P          criterios del proyecto (escenario y parámetros de capacidad)
 *   inv        inventario verificado por código de local (con archivos)
 *   fecha      fecha de generación (AAAA-MM-DD)
 */
export function armarModelo({ R, D, list, proyecto, datos, precios, efectivos = {}, P = DEF_CRIT, inv = {}, fecha }) {
  const d = { ...limpiarDatosDoc({}), ...datos };
  const T = R.totales, U = R.uit;
  const escenario = R.escenario || P.escenario || 'malo';
  const Pesc = { ...DEF_CRIT, ...P, escenario };
  // Solo son UP (por código de local) los locales con algo que reponer
  const conRep = R.locales.filter(l => l.rep.some(q => q > 0));
  const sinRep = R.locales.filter(l => !l.rep.some(q => q > 0));
  const nLoc = conRep.length;
  const metasR = R.metas || [];
  const tiposRep = ITEMS.map((x, t) => ({ ...x, t })).filter(x => R.partidas[x.t].rep > 0);

  // ── Unidades productoras (locales) ──
  const idx = new Map(list.map(i => [D.locs[i][0], i]));
  const upDe = l => {
    const i = idx.get(l.cod), loc = D.locs[i], svcs = D.locSvc[i].map(si => D.svcs[si]);
    const niveles = [...new Set(svcs.map(s => s[2]))].sort((a, b) => 'IPSE'.indexOf(a) - 'IPSE'.indexOf(b));
    return {
      cod: l.cod, nombre: l.nom, modulares: svcs.map(s => `${s[0]} (${NIVEL[s[2]].toLowerCase()})`), servicios: svcs.map(s => ({ modular: s[0], nombre: s[1], nivel: s[2], est: s[6] })), niveles,
      dpto: D.dpto || mayus(D.region), prov: l.prov, dist: l.dist, ubigeo: l.ubigeo, cp: loc[3], direccion: loc[5], rural: l.rural,
      lat: loc[6], lon: loc[7], ugel: D.ugels?.[loc[2]] || '', est: l.est, aulas: l.aul, kits: l.kits || 0,
      rep: l.rep, fal: l.fal, total: l.total, verificado: l.verificado, archivos: inv[l.cod]?.archivos || [],
      duplicidad: l.duplicidad || { estado: 'sin_verificar', codigo: null, nota: null, excluir: false }
    };
  };
  const ups = conRep.map(upDe);
  // Filas de la lista de UP del 07-C: por código de local (los que reponen) o por código modular
  // (todos los servicios de todos los locales del proyecto, aunque un local no tenga bienes a reponer)
  const porModular = d.up_por === 'modular';
  const todos = R.locales.map(upDe);
  const upsRegistro = porModular
    ? todos.flatMap(u => u.servicios.map(s => ({ ...u, cod: s.modular, cod_local: u.cod, nombre: s.nombre, modulares: [`local ${u.cod}`], est: s.est, sinBienes: !u.rep.some(q => q > 0) })))
    : ups.map(u => ({ ...u, cod_local: u.cod }));
  const n = upsRegistro.length;
  const masiva = n > 1;
  const supera = U.valor ? U.supera : null;   // null = falta la UIT
  const base = porModular ? todos : ups;
  const niveles = [...new Set(base.flatMap(u => u.niveles))].sort((a, b) => 'IPSE'.indexOf(a) - 'IPSE'.indexOf(b));
  const ugels = [...new Set(base.map(u => u.ugel).filter(Boolean))];
  const ambito = new Set(base.map(u => u.ubigeo)).size === 1 ? 'DISTRITAL' : new Set(base.map(u => u.ubigeo.slice(0, 4))).size === 1 ? 'PROVINCIAL' : 'DEPARTAMENTAL';
  const u0 = base[0];

  // ── Nombre de la inversión (propuesto; el aplicativo lo arma con los campos que se elijan) ──
  const nomNiveles = lista(niveles.map(k => NIVEL[k]));
  const NOMNIV = nomNiveles.replace(/ y /g, ' Y ');
  const nIE = porModular ? n : nLoc;
  const nombreSugerido = !u0 ? '' : nIE > 1
    ? `ADQUISICIÓN DE MOBILIARIO DE AULA EN ${nIE} INSTITUCIONES EDUCATIVAS DE NIVEL ${NOMNIV}${ugels.length === 1 ? ' DE LA ' + mayus(ugels[0]) : ''}, ${ambito === 'DISTRITAL' ? 'DISTRITO DE ' + mayus(u0.dist) + ', ' : ''}${ambito !== 'DEPARTAMENTAL' ? 'PROVINCIA DE ' + mayus(u0.prov) + ', ' : ''}DEPARTAMENTO DE ${mayus(u0.dpto)}`
    : `ADQUISICIÓN DE MOBILIARIO DE AULA; EN EL(LA) IE ${mayus(u0.nombre)} EN LA LOCALIDAD ${mayus(u0.cp)}, DISTRITO DE ${mayus(u0.dist)}, PROVINCIA ${mayus(u0.prov)}, DEPARTAMENTO ${mayus(u0.dpto)}`;

  // ── A. Alineamiento a la brecha: códigos de la clasificación funcional; indicador y unidad editables ──
  const cod = CODIGOS_FUNCIONALES;
  const A = {
    funcion: `${cod.funcion} EDUCACIÓN`, division: `${cod.division} EDUCACIÓN BÁSICA`, sector: 'EDUCACIÓN',
    grupos: niveles.map(k => `${cod.grupo[k] ? cod.grupo[k] + ' ' : ''}EDUCACIÓN ${NIVEL[k]}`),
    servicio: d.servicio_brecha || niveles.map(k => 'SERVICIO DE EDUCACIÓN ' + NIVEL[k]).join('; '),
    tipologia: d.tipologia || niveles.map(k => 'EDUCACIÓN ' + NIVEL[k]).join('; '),
    indicadores: d.indicador_brecha
      ? [{ tipo: 'Calidad', nombre: d.indicador_brecha, unidad: d.unidad_indicador || '', valor: d.contribucion_brecha }]
      : niveles.map(k => ({ tipo: 'Calidad', nombre: `PORCENTAJE DE LOCALES EDUCATIVOS CON EDUCACIÓN ${NIVEL[k]} CON CAPACIDAD INSTALADA INADECUADA`, unidad: d.unidad_indicador || 'LOCAL EDUCATIVO', valor: d.contribucion_brecha })),
    espacio: !u0 ? '' : ambito === 'DISTRITAL' ? `${mayus(u0.dpto)}, ${mayus(u0.prov)}, ${mayus(u0.dist)}` : ambito === 'PROVINCIAL' ? `${mayus(u0.dpto)}, ${mayus(u0.prov)}` : mayus(u0.dpto),
    propuesto: !d.servicio_brecha || !d.tipologia || !d.indicador_brecha,
    sinCodigo: niveles.filter(k => !cod.grupo[k]).map(k => NIVEL[k])
  };

  // ── Metas del 07-C: cada una con su costo directo × (1 + IGV). El redondeo va a la última,
  //    así las metas suman el costo directo + IGV de la estructura ──
  const igvPct = R.estructura?.params?.igv ?? 18;
  const metas = metasR.map(m => ({ k: m.k, nombre: m.n, plural: PLURAL[m.k], activo: 'MOBILIARIO DE AULA', unidad: UNIDAD_META[m.k] || 'Número de mobiliario',
    cantidad: m.cantidad, porTalla: m.porTalla, costo: r2(m.cd * (1 + igvPct / 100)) }));
  if (metas.length) metas[metas.length - 1].costo = r2(T.cdIgv - metas.slice(0, -1).reduce((a, m) => a + m.costo, 0));
  const subtotalActivos = r2(T.cdIgv);
  const expediente = T.doc, supervision = T.sup, liquidacion = T.liq;
  const total = T.total;

  // ── Plazo y cronogramas (mensual a partir del plazo; en días, se cuentan meses de 30 días) ──
  const enDias = d.plazo_unidad === 'dias';
  const N = enDias ? (d.dias ? Math.ceil(d.dias / 30) : 0) : (d.meses || 0);
  let inicio = null, fin = null, periodos = [];
  if (d.fecha_inicio && N) {
    const [y, mo] = d.fecha_inicio.split('-').map(Number);
    inicio = new Date(Date.UTC(y, mo - 1, 1));
    fin = enDias ? new Date(Date.UTC(y, mo - 1, d.dias)) : new Date(Date.UTC(y, mo - 1 + N, 0));
    periodos = Array.from({ length: N }, (_, j) => { const f = new Date(Date.UTC(y, mo - 1 + j, 1)); return `${MESES[f.getUTCMonth()]} ${f.getUTCFullYear()}`; });
  }
  const cronograma = N && periodos.length ? {
    periodos,
    activos: metas.map(m => ({ nombre: m.nombre, valores: repartir(m.costo, N), total: m.costo })),
    expediente: { valores: [r2(expediente), ...Array(N - 1).fill(0)], total: r2(expediente) },
    supervision: { valores: repartir(r2(supervision), N), total: r2(supervision) },
    liquidacion: { valores: [...Array(N - 1).fill(0), liquidacion], total: liquidacion },
    metas: metas.map(m => ({ nombre: m.nombre, unidad: m.unidad, valores: repartirEnteros(m.cantidad, N), total: m.cantidad }))
  } : null;
  const plazoTexto = enDias ? (d.dias ? `${d.dias} días` : null) : (d.meses ? `${d.meses} ${d.meses === 1 ? 'mes' : 'meses'}` : null);

  // ── Mantenimiento de los activos nuevos (por meta; el costo puede ser 0) ──
  const anios = Math.min(20, Math.max(0, ...metas.map(m => d.vida_util[m.k] || 0)));
  const mantenimiento = {
    inicio: fin ? new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() + 1, 1)) : null,
    anios,
    filas: metas.map(m => ({ nombre: m.nombre, anual: d.mant_nuevo[m.k] ?? null, vida: d.vida_util[m.k] ?? null,
      valores: Array.from({ length: anios }, (_, j) => d.mant_nuevo[m.k] != null && j < (d.vida_util[m.k] || 0) ? d.mant_nuevo[m.k] : 0) }))
  };
  mantenimiento.totales = Array.from({ length: anios }, (_, j) => r2(mantenimiento.filas.reduce((a, f) => a + f.valores[j], 0)));

  // ── Antigüedad según el año de adquisición registrado en cada local (ponderada por lo que se repone) ──
  const anioRef = Number(String(fecha || '').slice(0, 4)) || new Date().getFullYear();
  const antInv = Object.fromEntries(tiposRep.map(x => {
    const con = ups.filter(u => u.rep[x.t] > 0 && u.verificado?.adquisicion?.[x.k]);
    const de = ups.filter(u => u.rep[x.t] > 0).length;
    if (!con.length) return [x.k, null];
    const peso = con.reduce((a, u) => a + u.rep[x.t], 0);
    const edades = con.map(u => anioRef - u.verificado.adquisicion[x.k]);
    const prom = con.reduce((a, u) => a + (anioRef - u.verificado.adquisicion[x.k]) * u.rep[x.t], 0) / peso;
    return [x.k, { promedio: Math.round(prom * 10) / 10, min: Math.min(...edades), max: Math.max(...edades), con: con.length, de,
      estimada: con.filter(u => u.verificado.adq_estimada?.includes(x.k)).length }];
  }));

  // ── E. Activos: descripción técnica según nivel y grupo de grado, y estado (por tipo de bien) ──
  const activos = tiposRep.map(x => ({
    k: x.k, nombre: x.n,
    antiguedad: d.antiguedad[x.k] ?? (antInv[x.k] ? Math.round(antInv[x.k].promedio) : null),
    antiguedad_origen: d.antiguedad[x.k] != null ? 'usuario' : antInv[x.k] ? 'inventario' : null, antiguedad_inventario: antInv[x.k],
    vida_estimada: d.vida_util_estimada[x.k] ?? null,
    estado: d.estado_actual[x.k] || null,
    mant_actual: d.mant_actual[x.k] ?? null, vida_util: d.vida_util[x.k] ?? null, mant_nuevo: d.mant_nuevo[x.k] ?? null,
    cantidad: R.partidas[x.t].rep
  }));
  // Lo que se adquiere: una fila por meta (con kit, el kit y los demás)
  const intervencion = metasR.map(m => ({ k: m.k, nombre: m.n, descripcion: descripcionMeta(m, precios, d.ref_tecnica) }));

  // ── Sustento: declara el método de cuantificación según el escenario ──
  const est = ups.reduce((a, u) => a + u.est, 0), aulas = ups.reduce((a, u) => a + u.aulas, 0);
  const verificados = ups.filter(u => u.verificado?.tipos.length);   // corrigieron cantidades
  const visitados = ups.filter(u => u.verificado);                   // tienen visita registrada
  const conActa = visitados.filter(u => u.archivos.some(a => a.tipo === 'acta'));
  const conBaja = ups.filter(u => u.archivos.some(a => a.tipo === 'baja'));
  const repVerif = T.repVerif || 0;
  const porCapacidad = escenario === 'capacidad';
  const cantidades = { rep: T.rep, verif: repVerif, pct: T.rep ? Math.round(repVerif / T.rep * 1000) / 10 : 0, locales: verificados.length, de: nLoc };
  cantidades.texto = !T.rep ? '' : porCapacidad
    ? 'Las cantidades se calculan por capacidad (aulas × ocupación × porcentaje): no salen del estado del mobiliario, así que no aplica el porcentaje verificado en campo.'
    : repVerif >= T.rep
      ? `Todas las cantidades a reponer (${T.rep.toLocaleString('es-PE')}) están verificadas en campo, en ${nLoc === 1 ? 'el local' : `los ${nLoc} locales`}.`
      : repVerif > 0
        ? `Cantidades a reponer verificadas en campo: ${cantidades.pct.toLocaleString('es-PE')} % (${repVerif.toLocaleString('es-PE')} de ${T.rep.toLocaleString('es-PE')}), en ${verificados.length} de ${nLoc} ${nLoc === 1 ? 'local' : 'locales'}. El resto sale del Censo Educativo 2025, declarado por cada institución.`
        : `Ninguna cantidad a reponer está verificada en campo (0 %): las ${T.rep.toLocaleString('es-PE')} salen del Censo Educativo 2025, declarado por cada institución. Carga las fichas de verificación de los locales.`;
  // Malo + % de Regular: el % usado, su origen y los locales con el Regular verificado por antigüedad
  const RC = R.regularCampo || { completos: 0 };
  const regDato = { n: RC.completos, de: R.locales.length };
  const pctTxt = textoPct(Pesc, niveles);
  const porDato = R.locales.filter(l => l.regular?.origen === 'dato').map(l => l.cod);
  const parciales = R.locales.filter(l => l.regular?.parcial).map(l => l.cod);
  const METODO = {
    malo: 'Método de cuantificación (escenario Solo Malo). Se repone el mobiliario en estado malo del Censo Educativo 2025; debe confirmarse con el inventario patrimonial y la verificación en campo.',
    malo_regular: `Método de cuantificación (escenario Malo + % de Regular${Pesc.pctRegular === 100 && pctTxt === '100 %' ? ', cota superior' : ''}). Se repone el mobiliario en estado malo y, del regular, ${pctTxt} por aula y tipo de bien (redondeo hacia arriba, sin pasar del regular existente), según el Censo Educativo 2025. Origen del porcentaje: ${textoOrigenPct(Pesc, regDato)}. La cantidad es una estimación hasta completar la verificación en campo y debe confirmarse con el inventario patrimonial. El mobiliario regular todavía es utilizable: su reposición se sustenta con la vida útil cumplida.`
      + (porDato.length ? ` Regular por dato verificado (antigüedad de ${Pesc.umbralVida} años o más, ${ROTULO_UMBRAL}): ${porDato.length === 1 ? 'local' : 'locales'} ${lista(porDato)}; en los demás, Regular por estimación (%).` : ' Ningún local tiene aún todo su Regular verificado por antigüedad: en todos, Regular por estimación (%).')
      + (parciales.length ? ` En ${parciales.length === 1 ? 'el local' : 'los locales'} ${lista(parciales)}, las aulas contadas con antigüedad usan el dato verificado y las demás, el %.` : ''),
    capacidad: `Método de cuantificación (escenario Por capacidad, método de convocatoria). Las cantidades se calculan como aulas × ${Pesc.capOcup} estudiantes × ${Pesc.capPct} %. Este método no usa el estado del mobiliario: no sustenta una reposición y sirve solo para comparar con una convocatoria ya publicada.`
  };
  const queSeRepone = escenario === 'malo_regular' ? `el mobiliario en estado malo y ${pctTxt} del regular` : 'el mobiliario en estado malo, que ya no es útil ni operativo y no puede recuperarse con mantenimiento correctivo (vida útil efectiva, Lineamientos IOARR 2.4.B.e)';
  const metasTexto = lista(metas.map(m => `${m.cantidad.toLocaleString('es-PE')} ${m.cantidad === 1 ? m.nombre.toLowerCase() : m.plural}`));
  const sustentoAuto = [
    METODO[escenario] || METODO.malo,
    `${nLoc > 1 ? `La inversión comprende ${nLoc} locales educativos` : `La inversión comprende el local educativo ${ups[0]?.cod || ''}`} (${nomNiveles.toLowerCase()}), ${nLoc > 1 ? 'que atienden' : 'que atiende'} a ${est.toLocaleString('es-PE')} estudiantes en ${aulas.toLocaleString('es-PE')} aulas.`,
    porCapacidad
      ? `Se adquieren ${metasTexto}, calculados por capacidad y no por el estado del mobiliario existente.`
      : `Se reponen ${metasTexto}: ${queSeRepone}.${R.kit ? ' Las mesas y sillas se presentan como kits: en cada aula, el mayor entre las mesas y las sillas a reponer.' : ''}`,
    ...(porCapacidad ? [] : [verificados.length
      ? `El estado del mobiliario sale del Censo Educativo 2025 (Minedu) y, en ${verificados.length === nLoc ? (nLoc > 1 ? 'todos los locales' : 'el local') : `${verificados.length} de los ${nLoc} locales`}, del inventario verificado en campo (${lista(verificados.map(u => fechaPe(new Date(u.verificado.fecha_visita + 'T00:00:00Z'))).filter((v, j, a) => a.indexOf(v) === j))}).`
      : 'El estado del mobiliario sale del Censo Educativo 2025 (Minedu), que es declarado por cada institución educativa.']),
    T.fal > 0 ? `No se incluyen ${T.fal.toLocaleString('es-PE')} bienes faltantes (matrícula − mobiliario existente): ${NOTA_FALTANTE} Son solo informativos y no entran al monto, porque ampliarían la capacidad de la UP (2.4.C.c). Lo que se repone no supera la matrícula ni la capacidad de diseño de cada colegio.` : 'El metrado no incluye bienes faltantes por encima de los existentes. Lo que se repone no supera la matrícula ni la capacidad de diseño de cada colegio.'
  ];
  const condiciones = [
    { texto: 'El mobiliario nuevo cumple la misma función que el reemplazado (2.4.C.a).', estado: 'cumple', nota: 'Mesas, sillas, escritorios y armarios de aula reemplazan a los del mismo uso.' },
    { texto: 'No se sustenta en un incremento de la capacidad de la UP (2.4.C.c).', estado: porCapacidad ? 'no' : 'cumple', nota: porCapacidad ? 'El escenario «Por capacidad» calcula las cantidades por aulas y ocupación, no por el mobiliario existente: no sirve como sustento de reposición.' : T.fal > 0 ? 'El faltante (brecha de dotación, no reposición) se excluyó del metrado y del costo.' : 'No hay faltante.' },
    { texto: masiva ? 'El mobiliario a reponer está en uso (2.5.c).' : 'El mobiliario a reponer está en uso: no lleva más de un año sin operar (2.4.C.d).', estado: d.en_uso === 'si' ? 'cumple' : d.en_uso === 'no' ? 'no' : 'pendiente', nota: d.en_uso === 'no' ? (masiva ? 'En una reposición masiva el mobiliario debe estar en uso.' : 'Si lleva más de un año sin operar, va como optimización o proyecto de inversión.') : '' },
    condInventario(ups, d),
    escenario === 'malo'
      ? { texto: 'Vida útil: se repone solo mobiliario en estado malo, que ya no es útil ni operativo (vida útil efectiva, 2.4.B.e).', estado: 'cumple', nota: d.informe_vida_util ? 'Informe de vida útil: ' + d.informe_vida_util : 'El informe de vida útil estimada de la entidad (2.4.C.b) es recomendable como respaldo.' }
      : { texto: 'Vida útil: el mobiliario a reponer ya no es útil ni operativo (vida útil efectiva, 2.4.B.e) o cumplió su vida útil estimada (2.4.C.b).', estado: porCapacidad ? 'no' : 'pendiente',
        nota: porCapacidad ? 'El escenario «Por capacidad» no usa el estado del mobiliario.' : `El escenario «Malo + % de Regular» incluye ${pctTxt} del mobiliario regular, que todavía se puede usar: sustenta su reposición con la verificación en campo (antigüedad de ${Pesc.umbralVida} años o más, ${ROTULO_UMBRAL})${d.informe_vida_util ? ' y el informe de vida útil (' + d.informe_vida_util + ')' : ' o con el informe de vida útil estimada'}.` },
    condBaja(ups, d, conBaja),
    { texto: 'Verificación en campo con acta.', estado: nLoc && conActa.length === nLoc ? 'cumple' : 'pendiente', nota: `${conActa.length} de ${nLoc} ${nLoc === 1 ? 'local' : 'locales'} con acta adjunta.` }
  ];
  if (masiva) condiciones.push({ texto: 'Las UP prestan el mismo servicio y las administra la misma entidad, que adquiere los activos (2.5.b).', estado: 'pendiente', nota: ugels.length > 1 ? `Los locales son de ${ugels.length} UGEL (${lista(ugels)}): confirma que la entidad que adquiere es la misma.` : `Locales de ${ugels[0] || 'una misma UGEL'}.` });

  // ── Datos pendientes ──
  const faltan = [];
  const falta = (cond, txt) => { if (cond) faltan.push(txt); };
  falta(!R.locales.length, 'El proyecto no tiene locales.');
  falta(R.locales.length && !nLoc, 'Ningún local tiene bienes a reponer.');
  falta(!T.cd, 'No hay costo directo: carga los precios unitarios.');
  falta((R.lineas || []).some(y => y.rep > 0 && y.pu == null), 'Falta el precio unitario de algún bien.');
  falta(!U.valor, 'Falta la UIT del año: no se sabe si el registro es abreviado o completo.');
  falta(!d.uf || !d.uei, 'B. Institucionalidad: Unidad Formuladora y Unidad Ejecutora de Inversiones.');
  falta(!d.opmi, 'B. Institucionalidad: OPMI.');
  falta(!d.modalidad, 'Modalidad de ejecución.');
  falta(!d.fuente_financiamiento, 'Fuente de financiamiento.');
  falta(!d.fecha_inicio || !N, `F. Fecha prevista de inicio y plazo de ejecución (${enDias ? 'días' : 'meses'}).`);
  falta(metas.some(m => d.mant_nuevo[m.k] == null || d.vida_util[m.k] == null), 'Costo anual de mantenimiento (puede ser 0) y vida útil del mobiliario nuevo, por meta.');
  falta(!d.ue_mantenimiento || !d.ue_mantenimiento_codigo, 'Entidad responsable del mantenimiento: nombre y código.');
  const sinCheck = ups.filter(u => !checklistColegio(colegioDe(d.colegios, u.cod), { registrado: d.inventario_registrado }).completo);
  falta(sinCheck.length, `Checklist de inventario y baja incompleto en ${sinCheck.length === 1 ? '1 colegio' : sinCheck.length + ' colegios'} (${sinCheck.slice(0, 10).map(u => u.cod).join(', ')}${sinCheck.length > 10 ? '…' : ''}): no entra${sinCheck.length === 1 ? '' : 'n'} al 07-C final.`);
  falta(!d.en_uso, 'Si el mobiliario a reponer está en uso.');
  if (supera && !masiva) falta(activos.some(a => a.antiguedad == null || !a.estado), 'E.3. Antigüedad y estado actual del mobiliario a reponer, por tipo.');
  falta(!d.ref_tecnica, 'Referencia técnica aplicable del mobiliario (descripción técnica).');
  falta(A.propuesto, 'A. Alineamiento a la brecha: indicador, unidad de medida y servicio propuestos; verifícalos contra el PMI.');

  return {
    fecha, proyecto: proyecto.nombre || '(sin nombre)', region: proyecto.region,
    nombre: d.nombre_inversion || nombreSugerido, nombreSugerido, cui: d.cui || proyecto.ioarr?.cui || '',
    masiva, supera, registro: supera == null ? 'pendiente' : supera ? 'completo' : 'abreviado',
    uit: U, limite: LIMITE_UIT, A,
    escenario, escenarioTexto: textoEscenario(Pesc, regDato), kit: !!R.kit,
    regular: escenario === 'malo_regular' ? { pct: pctTxt, origen: textoOrigenPct(Pesc, regDato), porDato, umbral: Pesc.umbralVida, observado: RC.observado ?? null, muestra: RC.conDato || 0 } : null,
    B: { opmi: d.opmi, uf: d.uf, uf_responsable: d.uf_responsable, uei: d.uei, uei_responsable: d.uei_responsable },
    ejecucion: { modalidad: d.modalidad, fuente: d.fuente_financiamiento, plazo: plazoTexto },
    ups, upsRegistro, upPor: d.up_por, sinRep: porModular ? [] : sinRep.map(l => ({ cod: l.cod, nombre: l.nom, fal: l.fal.reduce((a, b) => a + b, 0) })), est, aulas,
    niveles: niveles.map(k => NIVEL[k]), ugels, ambito,
    D: { inventario: d.inventario_registrado, codigo_inventario: d.codigo_inventario, mantenimiento: d.ue_mantenimiento, mantenimiento_codigo: d.ue_mantenimiento_codigo },
    E: { sustento: [...sustentoAuto, ...(d.sustento ? d.sustento.split(/\n+/) : [])], activos, intervencion, condiciones, refTecnica: d.ref_tecnica },
    F: { metas, subtotalActivos, expediente: r2(expediente), supervision: r2(supervision), liquidacion, total,
      inicio: inicio && fechaPe(inicio), fin: fin && fechaPe(fin), meses: N, plazo: plazoTexto, cronograma, mantenimiento },
    totales: T, estructura: R.estructura, partidas: R.partidas, lineas: R.lineas || R.partidas, distritos: R.distritos, excluidos: R.excluidos || [],
    faltante: { cantidad: T.fal, valor: T.falValor, partidas: R.partidas.filter(p => p.fal > 0).map(p => ({ nombre: p.n, cantidad: p.fal, valor: p.falValor })) },
    memoria: { antecedentes: d.antecedentes, objetivo: d.objetivo || `${porCapacidad ? 'Dotar de' : 'Reponer el'} mobiliario de aula${porCapacidad ? '' : escenario === 'malo_regular' ? ` en estado malo y ${pctTxt} del regular` : ' en mal estado'} ${nLoc > 1 ? `de ${nLoc} locales educativos` : 'del local educativo'} de nivel ${nomNiveles.toLowerCase()}, para mantener el nivel y la calidad del servicio educativo que reciben ${est.toLocaleString('es-PE')} estudiantes.` },
    anioRef, informe_vida_util: d.informe_vida_util, cantidades,
    faltan, completo: !faltan.length,
    ioarr: proyecto.ioarr || null,
    verificacion: armarVerificacion({ R, ups, activos, condiciones, faltan, precios, efectivos, U, d, n: nLoc, ioarr: proyecto.ioarr, total, cantidades })
  };
}

// ─── Condiciones con el checklist por colegio ───────────────────────────────
// Registro en el inventario y la contabilidad (2.4.C.e): por colegio; el sí/no de Documentos vale como
// valor por defecto del registro en el inventario
function condInventario(ups, d) {
  const v = ups.map(u => { const c = colegioDe(d.colegios, u.cod).inventario; return { reg: c.registrado || d.inventario_registrado, cont: c.contabilidad }; });
  const n = ups.length, ok = v.filter(x => x.reg === 'si' && x.cont === 'si').length, no = v.filter(x => x.reg === 'no' || x.cont === 'no').length;
  return { texto: 'Los bienes están registrados en la contabilidad e inventario de la entidad (2.4.C.e).', estado: no ? 'no' : n && ok === n ? 'cumple' : 'pendiente',
    nota: `Inventario y contabilidad «Sí» en ${ok} de ${n} ${n === 1 ? 'colegio' : 'colegios'}${no ? `; «No» en ${no}` : ''} (checklist por colegio).${d.codigo_inventario ? ' Código o documento: ' + d.codigo_inventario : ''}` };
}
// Baja (2.4.C.f): trámite iniciado con documento de respaldo y fecha en el checklist, o archivo de baja adjunto
function condBaja(ups, d, conBaja) {
  const n = ups.length, arch = new Set(conBaja.map(u => u.cod));
  const ok = ups.filter(u => { const c = colegioDe(d.colegios, u.cod).inventario; return (c.baja === 'si' && c.doc_tipo && c.doc_fecha) || arch.has(u.cod); }).length;
  const no = ups.filter(u => colegioDe(d.colegios, u.cod).inventario.baja === 'no').length;
  return { texto: 'Los bienes reemplazados se darán de baja o se inició su trámite (2.4.C.f).', estado: n && ok === n ? 'cumple' : 'pendiente',
    nota: `Baja iniciada con documento de respaldo en ${ok} de ${n} ${n === 1 ? 'colegio' : 'colegios'}${no ? `; sin iniciar en ${no}` : ''}. Se marca en «Por colegio» (acta, resolución o compromiso, con fecha).` };
}

// ─── Lista de verificación del expediente ───────────────────────────────────
// Monto del expediente frente al del CUI vinculado en Radar IOARR (tolerancia 1 %)
const S2 = n => 'S/ ' + Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function montoCui(ioarr, total) {
  const texto = `Monto coherente con el CUI ${ioarr.cui} de Radar IOARR.`;
  if (ioarr.monto_inversion == null) return { texto, estado: 'pendiente', nota: 'El CUI no tiene monto en Radar IOARR.' };
  const m = Number(ioarr.monto_inversion), dif = m ? (total - m) / m : null;
  const ok = dif != null && Math.abs(dif) <= 0.01;
  return { texto, estado: ok ? 'ok' : 'pendiente', nota: ok ? `CUI: ${S2(m)}.` : `CUI: ${S2(m)} · expediente: ${S2(total)} (${dif > 0 ? '+' : ''}${(dif * 100).toFixed(1)} %). Actualiza el monto del CUI o revisa los costos.` };
}

// Otra inversión vigente o reciente: «No» en cada local de la propuesta. Un «Sí» que sigue incluido bloquea.
function dupItem(ups, n, excluidos) {
  const texto = 'Otra inversión vigente o reciente descartada en cada local (sin duplicidad).';
  const si = ups.filter(u => u.duplicidad.estado === 'si'), no = ups.filter(u => u.duplicidad.estado === 'no').length;
  const fuera = excluidos.length ? ` ${excluidos.length === 1 ? '1 local excluido' : excluidos.length + ' locales excluidos'} por otra inversión.` : '';
  if (si.length) return { texto, estado: 'no', nota: `Con otra inversión y aún en la propuesta: ${si.map(u => u.cod + (u.duplicidad.codigo ? ` (${u.duplicidad.codigo})` : '')).join(', ')}.${fuera}` };
  return { texto, estado: n > 0 && no === n ? 'ok' : 'pendiente', nota: `«No» en ${no} de ${n} ${n === 1 ? 'local' : 'locales'}${no < n ? '; el resto, sin verificar' : ''}.${fuera}` };
}

// Junta lo que el sistema comprueba solo (costos, archivos por local, datos del
// 07-C, condiciones) y lo que se marca a mano (VERIF_MANUAL).
function armarVerificacion({ R, ups, activos, condiciones, faltan, precios, efectivos = {}, U, d, n, ioarr, total, cantidades }) {
  const it = (texto, ok, nota = '', extra = {}) => ({ texto, estado: ok === true ? 'ok' : ok === false ? 'pendiente' : ok, nota, ...extra });
  const todos = (f) => n > 0 && ups.every(f);
  const cuenta = (f) => `${ups.filter(f).length} de ${n} ${n === 1 ? 'local' : 'locales'}`;
  const tiene = tipo => u => u.archivos.some(a => a.tipo === tipo);
  const sinPrecio = (R.lineas || []).filter(p => p.rep > 0 && p.pu == null).map(p => p.n.toLowerCase());
  // Líneas con algo que reponer cuyo precio sigue siendo la referencia precargada
  const claves = (R.lineas || []).filter(p => p.rep > 0).flatMap(p => p.tipo === 'kit' ? [`mesa_${p.talla}`, `silla_${p.talla}`] : [p.k]);
  const deReferencia = [...new Set(claves.filter(k => efectivos[k]?.origen === 'referencia'))];
  const conAnio = u => activos.every(a => !u.rep[R.partidas.findIndex(p => p.k === a.k)] || u.verificado?.adquisicion?.[a.k]);

  const secciones = [
    { titulo: 'Costos', items: [
      it('Precio unitario de mercado de cada bien a reponer.', !sinPrecio.length, sinPrecio.length ? 'Falta: ' + sinPrecio.join(', ') : ''),
      it('Precios revisados: ninguno se queda en la referencia precargada.', !deReferencia.length, deReferencia.length ? `${deReferencia.length} ${deReferencia.length === 1 ? 'precio usa' : 'precios usan'} la referencia (Loreto 2026): reemplázalos por tus cotizaciones.` : ''),
      it('Referencia técnica aplicable en la descripción técnica.', !!d.ref_tecnica, d.ref_tecnica ? '' : 'Escríbela en Documentos (no se inventan normas).'),
      it('Valor de la UIT del año.', !!U.valor, U.valor ? `UIT ${U.anio}: S/ ${U.valor.toLocaleString('es-PE')}` : ''),
      ...(ioarr ? [montoCui(ioarr, total)] : [])
    ] },
    { titulo: 'Locales: visita y sustento', items: [
      it('Visita de campo registrada.', todos(u => u.verificado), cuenta(u => u.verificado)),
      it('Cantidades a reponer verificadas en campo (fichas de verificación).', !!cantidades?.rep && cantidades.verif >= cantidades.rep,
        cantidades?.rep ? `${cantidades.pct.toLocaleString('es-PE')} % verificado (${cantidades.verif.toLocaleString('es-PE')} de ${cantidades.rep.toLocaleString('es-PE')}); el resto, del censo.` : ''),
      it('Acta de verificación adjunta.', todos(tiene('acta')), cuenta(tiene('acta'))),
      it('Fotos del mobiliario adjuntas.', todos(tiene('foto')), cuenta(tiene('foto'))),
      it('Inventario patrimonial adjunto.', todos(tiene('inventario_patrimonial')), cuenta(tiene('inventario_patrimonial'))),
      it('Resolución o trámite de baja adjunto.', todos(tiene('baja')), cuenta(tiene('baja'))),
      it('Año de adquisición de cada tipo de bien a reponer.', todos(conAnio), cuenta(conAnio)),
      dupItem(ups, n, R.excluidos || [])
    ] },
    { titulo: 'Formato 07-C y memoria descriptiva', items: [
      it('Datos del Formato 07-C y de la memoria completos.', !faltan.length, faltan.length ? `${faltan.length} pendiente${faltan.length === 1 ? '' : 's'} (ver Documentos).` : '')
    ] },
    { titulo: 'Condiciones de los Lineamientos IOARR', items: condiciones.map(c => it(c.texto, c.estado === 'cumple' ? true : c.estado === 'no' ? 'no' : false, c.nota)) },
    { titulo: 'Documentos y coordinaciones (se marcan a mano)', items: VERIF_MANUAL.map(x => it(x.texto, !!d.verificacion?.[x.id]?.ok, d.verificacion?.[x.id]?.nota || '', { id: x.id, manual: true })) }
  ];
  const items = secciones.flatMap(s => s.items);
  return {
    secciones,
    locales: ups.map(u => ({ cod: u.cod, nombre: u.nombre, visita: u.verificado?.fecha_visita || null, acta: tiene('acta')(u), fotos: u.archivos.filter(a => a.tipo === 'foto').length,
      inventario: tiene('inventario_patrimonial')(u), baja: tiene('baja')(u), anio: conAnio(u) })),
    hechos: items.filter(x => x.estado === 'ok').length, total: items.length, bloqueos: items.filter(x => x.estado === 'no').length
  };
}
