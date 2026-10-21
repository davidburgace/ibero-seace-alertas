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

import { ITEMS } from './calculo.js';
import { TIPOS, LIMITE_UIT } from './costos.js';

// ─── Datos que carga el usuario ─────────────────────────────────────────────
export const ESTADOS_ACTIVO = ['REGULAR', 'MALO', 'MUY MALO', 'IRRECUPERABLE'];
const UNIDAD_META = { mesa: 'Número de mobiliario (puestos)', silla: 'Número de mobiliario', esc: 'Número de mobiliario', sdoc: 'Número de mobiliario', arm: 'Número de mobiliario' };
const PLURAL = { mesa: 'mesas del estudiante', silla: 'sillas del estudiante', esc: 'escritorios del docente', sdoc: 'sillas del docente', arm: 'armarios o estantes' };
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
  { id: 'estructura_firmada', texto: 'Estructura referencial de costos (Excel) revisada y firmada por el formulador.' }
];

const texto = (v, max = 300) => String(v ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const parrafo = (v, max = 4000) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const numero = (v, min, max) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const entero = (v, min, max) => { const n = numero(v, min, max); return n == null ? null : Math.round(n); };

const cuiValido = v => /^\d{5,8}$/.test(String(v || '').trim()) ? String(v).trim() : '';

/** Valida lo que guarda el formulario de Documentos. Lo desconocido se descarta. */
export function limpiarDatosDoc(b = {}) {
  const porTipo = (obj, f) => Object.fromEntries(TIPOS.map(k => [k, f(obj?.[k])]).filter(([, v]) => v != null && v !== ''));
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
    // B. Institucionalidad
    opmi: texto(b.opmi, 200), uf: texto(b.uf, 200), uf_responsable: texto(b.uf_responsable, 200),
    uei: texto(b.uei, 200), uei_responsable: texto(b.uei_responsable, 200),
    // D. Estado situacional y mantenimiento
    inventario_registrado: ['si', 'no'].includes(b.inventario_registrado) ? b.inventario_registrado : '',
    codigo_inventario: texto(b.codigo_inventario, 300),
    en_uso: ['si', 'no'].includes(b.en_uso) ? b.en_uso : '',
    ue_mantenimiento: texto(b.ue_mantenimiento, 300),
    // E. Por tipo de bien
    antiguedad: porTipo(b.antiguedad, v => numero(v, 0, 100)),
    vida_util_estimada: porTipo(b.vida_util_estimada, v => entero(v, 1, 50)),
    informe_vida_util: texto(b.informe_vida_util, 300),
    verificacion: Object.fromEntries(VERIF_MANUAL.map(x => [x.id, b.verificacion?.[x.id]]).filter(([, v]) => v && typeof v === 'object')
      .map(([id, v]) => [id, { ok: v.ok === true, nota: texto(v.nota, 300) }]).filter(([, v]) => v.ok || v.nota)),
    estado_actual: porTipo(b.estado_actual, v => ESTADOS_ACTIVO.includes(v) ? v : null),
    mant_actual: porTipo(b.mant_actual, v => numero(v, 0, 1e9)),
    vida_util: porTipo(b.vida_util, v => entero(v, 1, 30)),
    mant_nuevo: porTipo(b.mant_nuevo, v => numero(v, 0, 1e9)),
    sustento: parrafo(b.sustento),
    // F. Plazo
    fecha_inicio: fecha,
    meses: entero(b.meses, 1, 36),
    liquidacion: numero(b.liquidacion, 0, 1e10),
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
 *   R          resultado de costear()
 *   D, list    datos de la región (prep) e índices de los locales del proyecto
 *   proyecto   { nombre, region, ioarr }
 *   datos      limpiarDatosDoc()
 *   precios    detalle de precios por tipo (descripción = descripción técnica)
 *   inv        inventario verificado por código de local (con archivos)
 *   fecha      fecha de generación (AAAA-MM-DD)
 */
export function armarModelo({ R, D, list, proyecto, datos, precios, inv = {}, fecha }) {
  const d = { ...limpiarDatosDoc({}), ...datos };
  const T = R.totales, U = R.uit;
  // Solo son UP de la inversión los locales con algo que reponer
  const conRep = R.locales.filter(l => l.rep.some(q => q > 0));
  const sinRep = R.locales.filter(l => !l.rep.some(q => q > 0));
  const n = conRep.length;
  const masiva = n > 1;
  const supera = U.valor ? U.supera : null;   // null = falta la UIT
  const tiposRep = ITEMS.map((x, t) => ({ ...x, t })).filter(x => R.partidas[x.t].rep > 0);

  // ── Unidades productoras (locales) ──
  const idx = new Map(list.map(i => [D.locs[i][0], i]));
  const ups = conRep.map(l => {
    const i = idx.get(l.cod), loc = D.locs[i], svcs = D.locSvc[i].map(si => D.svcs[si]);
    const niveles = [...new Set(svcs.map(s => s[2]))].sort((a, b) => 'IPSE'.indexOf(a) - 'IPSE'.indexOf(b));
    return {
      cod: l.cod, nombre: l.nom, modulares: svcs.map(s => `${s[0]} (${NIVEL[s[2]].toLowerCase()})`), niveles,
      dpto: D.dpto || mayus(D.region), prov: l.prov, dist: l.dist, ubigeo: l.ubigeo, cp: loc[3], direccion: loc[5], rural: l.rural,
      lat: loc[6], lon: loc[7], ugel: D.ugels?.[loc[2]] || '', est: l.est, aulas: l.aul,
      rep: l.rep, fal: l.fal, total: l.total, verificado: l.verificado, archivos: inv[l.cod]?.archivos || [],
      duplicidad: l.duplicidad || { estado: 'sin_verificar', codigo: null, nota: null, excluir: false }
    };
  });
  const niveles = [...new Set(ups.flatMap(u => u.niveles))].sort((a, b) => 'IPSE'.indexOf(a) - 'IPSE'.indexOf(b));
  const ugels = [...new Set(ups.map(u => u.ugel).filter(Boolean))];
  const ambito = new Set(ups.map(u => u.ubigeo)).size === 1 ? 'DISTRITAL' : new Set(ups.map(u => u.ubigeo.slice(0, 4))).size === 1 ? 'PROVINCIAL' : 'DEPARTAMENTAL';
  const u0 = ups[0];

  // ── Nombre de la inversión (propuesto; el aplicativo lo arma con los campos que se elijan) ──
  const nomNiveles = lista(niveles.map(k => NIVEL[k]));
  const NOMNIV = nomNiveles.replace(/ y /g, ' Y ');
  const nombreSugerido = !u0 ? '' : masiva
    ? `ADQUISICIÓN DE MOBILIARIO DE AULA EN ${n} INSTITUCIONES EDUCATIVAS DE NIVEL ${NOMNIV}${ugels.length === 1 ? ' DE LA ' + mayus(ugels[0]) : ''}, ${ambito === 'DISTRITAL' ? 'DISTRITO DE ' + mayus(u0.dist) + ', ' : ''}${ambito !== 'DEPARTAMENTAL' ? 'PROVINCIA DE ' + mayus(u0.prov) + ', ' : ''}DEPARTAMENTO DE ${mayus(u0.dpto)}`
    : `ADQUISICIÓN DE MOBILIARIO DE AULA; EN EL(LA) IE ${mayus(u0.nombre)} EN LA LOCALIDAD ${mayus(u0.cp)}, DISTRITO DE ${mayus(u0.dist)}, PROVINCIA ${mayus(u0.prov)}, DEPARTAMENTO ${mayus(u0.dpto)}`;

  // ── A. Alineamiento a la brecha (propuesto por nivel; se verifica contra el PMI) ──
  const porNivel = niveles.map(k => ({ nivel: k, locales: ups.filter(u => u.niveles.includes(k)).length }));
  const A = {
    funcion: 'EDUCACIÓN', division: 'EDUCACIÓN BÁSICA', sector: 'EDUCACIÓN',
    grupos: niveles.map(k => 'EDUCACIÓN ' + NIVEL[k]),
    servicio: d.servicio_brecha || niveles.map(k => 'SERVICIO DE EDUCACIÓN ' + NIVEL[k]).join('; '),
    tipologia: d.tipologia || niveles.map(k => 'EDUCACIÓN ' + NIVEL[k]).join('; '),
    indicadores: d.indicador_brecha
      ? [{ tipo: 'Calidad', nombre: d.indicador_brecha, unidad: 'LOCAL EDUCATIVO', valor: n }]
      : porNivel.map(x => ({ tipo: 'Calidad', nombre: `PORCENTAJE DE LOCALES EDUCATIVOS CON EDUCACIÓN ${NIVEL[x.nivel]} CON CAPACIDAD INSTALADA INADECUADA`, unidad: 'LOCAL EDUCATIVO', valor: x.locales })),
    espacio: !u0 ? '' : ambito === 'DISTRITAL' ? `${mayus(u0.dpto)}, ${mayus(u0.prov)}, ${mayus(u0.dist)}` : ambito === 'PROVINCIAL' ? `${mayus(u0.dpto)}, ${mayus(u0.prov)}` : mayus(u0.dpto),
    propuesto: !d.servicio_brecha || !d.tipologia || !d.indicador_brecha
  };

  // ── Costo por tipo de bien: los rubros de cada local se reparten según el costo directo de cada tipo ──
  const porTipo = ITEMS.map(() => 0);
  let expediente = 0, supervision = 0;
  const cdTot = T.cd;
  for (const l of R.locales) {
    const aRepartir = l.bienes + (l.r.gestion || 0) + (l.r.imprevistos || 0);
    ITEMS.forEach((_, t) => {
      const share = l.cd > 0 ? l.cdTipo[t] / l.cd : cdTot > 0 ? R.partidas[t].parcial / cdTot : 0;
      porTipo[t] += aRepartir * share;
    });
    expediente += l.r.expediente || 0; supervision += l.r.supervision || 0;
  }
  const liquidacion = d.liquidacion || 0;
  const metas = tiposRep.map(x => ({ k: x.k, nombre: x.n, plural: PLURAL[x.k], activo: 'MOBILIARIO DE AULA', unidad: UNIDAD_META[x.k], cantidad: R.partidas[x.t].rep, costo: r2(porTipo[x.t]) }));
  const subtotalActivos = r2(metas.reduce((a, m) => a + m.costo, 0));
  const total = r2(subtotalActivos + r2(expediente) + r2(supervision) + liquidacion);

  // ── Plazo y cronogramas ──
  let inicio = null, fin = null, periodos = [];
  if (d.fecha_inicio && d.meses) {
    const [y, mo] = d.fecha_inicio.split('-').map(Number);
    inicio = new Date(Date.UTC(y, mo - 1, 1));
    fin = new Date(Date.UTC(y, mo - 1 + d.meses, 0));
    periodos = Array.from({ length: d.meses }, (_, j) => { const f = new Date(Date.UTC(y, mo - 1 + j, 1)); return `${MESES[f.getUTCMonth()]} ${f.getUTCFullYear()}`; });
  }
  const N = d.meses || 0;
  const cronograma = N ? {
    periodos,
    activos: metas.map(m => ({ nombre: m.nombre, valores: repartir(m.costo, N), total: m.costo })),
    expediente: { valores: [r2(expediente), ...Array(N - 1).fill(0)], total: r2(expediente) },
    supervision: { valores: repartir(r2(supervision), N), total: r2(supervision) },
    liquidacion: { valores: [...Array(N - 1).fill(0), liquidacion], total: liquidacion },
    metas: metas.map(m => ({ nombre: m.nombre, unidad: m.unidad, valores: repartirEnteros(m.cantidad, N), total: m.cantidad }))
  } : null;

  // ── Mantenimiento de los activos nuevos ──
  const anios = Math.min(20, Math.max(0, ...tiposRep.map(x => d.vida_util[x.k] || 0)));
  const mantenimiento = {
    inicio: fin ? new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() + 1, 1)) : null,
    anios,
    filas: tiposRep.map(x => ({ nombre: x.n, anual: d.mant_nuevo[x.k] ?? null, vida: d.vida_util[x.k] ?? null,
      valores: Array.from({ length: anios }, (_, j) => d.mant_nuevo[x.k] != null && j < (d.vida_util[x.k] || 0) ? d.mant_nuevo[x.k] : 0) }))
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
    return [x.k, { promedio: Math.round(prom * 10) / 10, min: Math.min(...edades), max: Math.max(...edades), con: con.length, de }];
  }));

  // ── E. Activos: descripción técnica (del catálogo de precios) y estado ──
  const activos = tiposRep.map(x => ({
    k: x.k, nombre: x.n, descripcion: precios?.[x.k]?.descripcion || '',
    antiguedad: d.antiguedad[x.k] ?? (antInv[x.k] ? Math.round(antInv[x.k].promedio) : null),
    antiguedad_origen: d.antiguedad[x.k] != null ? 'usuario' : antInv[x.k] ? 'inventario' : null, antiguedad_inventario: antInv[x.k],
    vida_estimada: d.vida_util_estimada[x.k] ?? null,
    estado: d.estado_actual[x.k] || null,
    mant_actual: d.mant_actual[x.k] ?? null, vida_util: d.vida_util[x.k] ?? null, mant_nuevo: d.mant_nuevo[x.k] ?? null,
    cantidad: R.partidas[x.t].rep
  }));

  // ── Sustento ──
  const est = ups.reduce((a, u) => a + u.est, 0), aulas = ups.reduce((a, u) => a + u.aulas, 0);
  const verificados = ups.filter(u => u.verificado?.tipos.length);   // corrigieron cantidades
  const visitados = ups.filter(u => u.verificado);                   // tienen visita registrada
  const conActa = visitados.filter(u => u.archivos.some(a => a.tipo === 'acta'));
  const conBaja = ups.filter(u => u.archivos.some(a => a.tipo === 'baja'));
  const sustentoAuto = [
    `${masiva ? `La inversión repone el mobiliario de aula de ${n} locales educativos` : `La inversión repone el mobiliario de aula del local educativo ${u0?.cod}`} (${nomNiveles.toLowerCase()}), ${masiva ? 'que atienden' : 'que atiende'} a ${est.toLocaleString('es-PE')} estudiantes en ${aulas.toLocaleString('es-PE')} aulas.`,
    `Se reponen ${lista(metas.map(m => `${m.cantidad.toLocaleString('es-PE')} ${m.cantidad === 1 ? m.nombre.toLowerCase() : m.plural}`))}: el mobiliario en estado malo, que ya no es útil ni operativo y no puede recuperarse con mantenimiento correctivo (vida útil efectiva, Lineamientos IOARR 2.4.B.e).`,
    verificados.length
      ? `El estado del mobiliario sale del Censo Educativo 2025 (Minedu) y, en ${verificados.length === n ? (masiva ? 'todos los locales' : 'el local') : `${verificados.length} de los ${n} locales`}, del inventario verificado en campo (${lista(verificados.map(u => fechaPe(new Date(u.verificado.fecha_visita + 'T00:00:00Z'))).filter((v, j, a) => a.indexOf(v) === j))}).`
      : 'El estado del mobiliario sale del Censo Educativo 2025 (Minedu), que es declarado por cada institución educativa; debe confirmarse con el inventario patrimonial y una verificación en campo.',
    T.fal > 0 ? `No se incluyen ${T.fal.toLocaleString('es-PE')} bienes faltantes (por encima de los existentes): ampliarían la capacidad de la UP y una reposición no puede sustentarse en eso (2.4.C.c). Corresponde evaluarlos como ampliación marginal.` : 'El metrado no incluye bienes por encima de los existentes, por lo que no se incrementa la capacidad de la UP (2.4.C.c).'
  ];
  const condiciones = [
    { texto: 'El mobiliario nuevo cumple la misma función que el reemplazado (2.4.C.a).', estado: 'cumple', nota: 'Mesas, sillas, escritorios y armarios de aula reemplazan a los del mismo uso.' },
    { texto: 'No se sustenta en un incremento de la capacidad de la UP (2.4.C.c).', estado: 'cumple', nota: T.fal > 0 ? 'El faltante (brecha de dotación, no reposición) se excluyó del metrado y del costo.' : 'No hay faltante.' },
    { texto: masiva ? 'El mobiliario a reponer está en uso (2.5.c).' : 'El mobiliario a reponer está en uso: no lleva más de un año sin operar (2.4.C.d).', estado: d.en_uso === 'si' ? 'cumple' : d.en_uso === 'no' ? 'no' : 'pendiente', nota: d.en_uso === 'no' ? (masiva ? 'En una reposición masiva el mobiliario debe estar en uso.' : 'Si lleva más de un año sin operar, va como optimización o proyecto de inversión.') : '' },
    { texto: 'Los bienes están registrados en la contabilidad e inventario de la entidad (2.4.C.e).', estado: d.inventario_registrado === 'si' ? 'cumple' : d.inventario_registrado === 'no' ? 'no' : 'pendiente', nota: d.codigo_inventario ? 'Código o documento: ' + d.codigo_inventario : '' },
    { texto: 'Vida útil: se repone solo mobiliario en estado malo, que ya no es útil ni operativo (vida útil efectiva, 2.4.B.e).', estado: 'cumple', nota: d.informe_vida_util ? 'Informe de vida útil: ' + d.informe_vida_util : 'El informe de vida útil estimada de la entidad (2.4.C.b) es recomendable como respaldo.' },
    { texto: 'Los bienes reemplazados se darán de baja o se inició su trámite (2.4.C.f).', estado: conBaja.length === n ? 'cumple' : 'pendiente', nota: conBaja.length ? `Hay sustento de baja en ${conBaja.length} de ${n} ${n === 1 ? 'local' : 'locales'}.` : 'Adjunta la resolución o el trámite de baja en «Corregir inventario» de cada local.' },
    { texto: 'Verificación en campo con acta.', estado: n && conActa.length === n ? 'cumple' : 'pendiente', nota: `${conActa.length} de ${n} ${n === 1 ? 'local' : 'locales'} con acta adjunta.` }
  ];
  if (masiva) condiciones.push({ texto: 'Las UP prestan el mismo servicio y las administra la misma entidad, que adquiere los activos (2.5.b).', estado: 'pendiente', nota: ugels.length > 1 ? `Los locales son de ${ugels.length} UGEL (${lista(ugels)}): confirma que la entidad que adquiere es la misma.` : `Locales de ${ugels[0] || 'una misma UGEL'}.` });

  // ── Datos pendientes ──
  const faltan = [];
  const falta = (cond, txt) => { if (cond) faltan.push(txt); };
  falta(!R.locales.length, 'El proyecto no tiene locales.');
  falta(R.locales.length && !n, 'Ningún local tiene bienes a reponer.');
  falta(!T.cd, 'No hay costo directo: carga los precios unitarios.');
  falta(R.partidas.some(p => p.rep > 0 && p.pu == null), 'Falta el precio unitario de algún tipo de bien.');
  falta(!U.valor, 'Falta la UIT del año: no se sabe si el registro es abreviado o completo.');
  falta(!d.uf || !d.uei, 'B. Institucionalidad: Unidad Formuladora y Unidad Ejecutora de Inversiones.');
  falta(!d.opmi, 'B. Institucionalidad: OPMI.');
  falta(!d.fecha_inicio || !d.meses, 'F. Fecha prevista de inicio y plazo de ejecución (meses).');
  falta(tiposRep.some(x => d.mant_nuevo[x.k] == null || d.vida_util[x.k] == null), 'Costo anual de mantenimiento y vida útil del mobiliario nuevo, por tipo.');
  falta(!d.ue_mantenimiento && !ugels.length, 'Unidad ejecutora responsable del mantenimiento.');
  falta(!d.inventario_registrado, 'Si el mobiliario a reponer está registrado en el inventario de la entidad (Lineamientos 2.4.C.e).');
  falta(!d.en_uso, 'Si el mobiliario a reponer está en uso.');
  if (supera && !masiva) falta(activos.some(a => a.antiguedad == null || !a.estado), 'E.3. Antigüedad y estado actual del mobiliario a reponer, por tipo.');
  falta(tiposRep.some(x => !precios?.[x.k]?.descripcion), 'Descripción técnica de algún tipo de bien (se toma del precio del catálogo).');
  falta(A.propuesto, 'A. Alineamiento a la brecha: se propuso por nivel; verifícalo contra el PMI.');

  return {
    fecha, proyecto: proyecto.nombre || '(sin nombre)', region: proyecto.region,
    nombre: d.nombre_inversion || nombreSugerido, nombreSugerido, cui: d.cui || proyecto.ioarr?.cui || '',
    masiva, supera, registro: supera == null ? 'pendiente' : supera ? 'completo' : 'abreviado',
    uit: U, limite: LIMITE_UIT, A,
    B: { opmi: d.opmi, uf: d.uf, uf_responsable: d.uf_responsable, uei: d.uei, uei_responsable: d.uei_responsable },
    ups, sinRep: sinRep.map(l => ({ cod: l.cod, nombre: l.nom, fal: l.fal.reduce((a, b) => a + b, 0) })), est, aulas,
    niveles: niveles.map(k => NIVEL[k]), ugels, ambito,
    D: { inventario: d.inventario_registrado, codigo_inventario: d.codigo_inventario, mantenimiento: d.ue_mantenimiento || lista(ugels) },
    E: { sustento: [...sustentoAuto, ...(d.sustento ? d.sustento.split(/\n+/) : [])], activos, condiciones },
    F: { metas, subtotalActivos, expediente: r2(expediente), supervision: r2(supervision), liquidacion, total,
      inicio: inicio && fechaPe(inicio), fin: fin && fechaPe(fin), meses: d.meses, cronograma, mantenimiento },
    totales: T, rubros: R.rubros, partidas: R.partidas, distritos: R.distritos, excluidos: R.excluidos || [],
    faltante: { cantidad: T.fal, valor: T.falValor, partidas: R.partidas.filter(p => p.fal > 0).map(p => ({ nombre: p.n, cantidad: p.fal, valor: p.falValor })) },
    memoria: { antecedentes: d.antecedentes, objetivo: d.objetivo || `Reponer el mobiliario de aula en mal estado ${masiva ? `de ${n} locales educativos` : 'del local educativo'} de nivel ${nomNiveles.toLowerCase()}, para mantener el nivel y la calidad del servicio educativo que reciben ${est.toLocaleString('es-PE')} estudiantes.` },
    anioRef, informe_vida_util: d.informe_vida_util,
    faltan, completo: !faltan.length,
    ioarr: proyecto.ioarr || null,
    verificacion: armarVerificacion({ R, ups, activos, condiciones, faltan, precios, U, d, n, ioarr: proyecto.ioarr, total })
  };
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
function armarVerificacion({ R, ups, activos, condiciones, faltan, precios, U, d, n, ioarr, total }) {
  const it = (texto, ok, nota = '', extra = {}) => ({ texto, estado: ok === true ? 'ok' : ok === false ? 'pendiente' : ok, nota, ...extra });
  const todos = (f) => n > 0 && ups.every(f);
  const cuenta = (f) => `${ups.filter(f).length} de ${n} ${n === 1 ? 'local' : 'locales'}`;
  const tiene = tipo => u => u.archivos.some(a => a.tipo === tipo);
  const sinPrecio = R.partidas.filter(p => p.rep > 0 && p.pu == null).map(p => p.n.toLowerCase());
  const sinDesc = activos.filter(a => !a.descripcion).map(a => a.nombre.toLowerCase());
  const conAnio = u => activos.every(a => !u.rep[R.partidas.findIndex(p => p.k === a.k)] || u.verificado?.adquisicion?.[a.k]);

  const secciones = [
    { titulo: 'Costos', items: [
      it('Precio unitario de cada tipo de bien a reponer.', !sinPrecio.length, sinPrecio.length ? 'Falta: ' + sinPrecio.join(', ') : ''),
      it('Descripción técnica de cada tipo de bien (del precio del catálogo).', !sinDesc.length, sinDesc.length ? 'Falta: ' + sinDesc.join(', ') : ''),
      it('Rubros de la estructura de costos cargados.', !R.rubros.every(r => r.valor === 0), R.rubros.every(r => r.valor === 0) ? 'Todos los rubros están en 0.' : ''),
      it('Valor de la UIT del año.', !!U.valor, U.valor ? `UIT ${U.anio}: S/ ${U.valor.toLocaleString('es-PE')}` : ''),
      ...(ioarr ? [montoCui(ioarr, total)] : [])
    ] },
    { titulo: 'Locales: visita y sustento', items: [
      it('Visita de campo registrada.', todos(u => u.verificado), cuenta(u => u.verificado)),
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
