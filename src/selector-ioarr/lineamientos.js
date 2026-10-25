// ============================================================================
// src/selector-ioarr/lineamientos.js — Requisitos de los Lineamientos IOARR (MEF, 9.ª versión,
// junio 2025) que se arman por colegio. Funciones puras: las usan la API, los Excel y los Word.
//
//   fichaActivos()  estructura preliminar de costos: un lote por aula, bien y estado a reponer,
//                   con código patrimonial, denominación existente y nueva, antigüedad,
//                   mantenimiento, ambiente y estado verificado. Lo que falta queda
//                   «pendiente de verificación en campo»: no se inventan valores.
// ============================================================================

import { ITEMS, TALLAS, NIVN, tallasDeAula, regularAReponer } from './calculo.js';

export const PENDIENTE_CAMPO = 'Pendiente de verificación en campo';
const NOMBRE_BIEN = Object.fromEntries(ITEMS.map(x => [x.k, x.n]));

// ─── Ficha de activos a reponer ──────────────────────────────────────────────
// Talla del mobiliario nuevo de un aula: la de su grado; multigrado o sin grado, el nivel
const tallaTexto = (nivel, grado) => {
  const js = tallasDeAula(nivel, grado);
  return js.length === 1 ? TALLAS[js[0]].n : `${NIVN[nivel]} (según el grado; aula multigrado o sin grado)`;
};
// Lo que el censo trae como mesa del estudiante en un aula (para la denominación existente)
function mesasDelCenso(a, P, estado) {
  const f = j => a[11 + j], ix = { r: 1, m: 2 }[estado], out = [];
  if (f(ix)) out.push('mesa unipersonal');
  if (f(3 + ix)) out.push('mesa múltiple');
  if ((P?.carpEstado || 'r') === estado) { if (f(6)) out.push('carpeta unipersonal'); if (f(7)) out.push('carpeta bipersonal'); }
  return out;
}
const textoAmbiente = a => `Aula ${[a[2] ? 'edif. ' + a[2] : '', a[3] !== '' && a[3] != null ? 'piso ' + a[3] : '', a[4] ? 'N.° ' + a[4] : ''].filter(Boolean).join(', ') || '(sin número en el censo)'}`;

/**
 * Lotes de activos a reponer de una IOARR (un nivel).
 * @param {object} p
 *   x        { nivel, D (vista del nivel), C (calc), list, R (costear), inv (inventario del nivel) }
 *   P        criterios del proyecto (carpEstado)
 *   datos    datos de Documentos: mant_actual y mant_nuevo por tipo (S/ anual de todo el tipo)
 *   anioRef  año de referencia para la antigüedad según el año de adquisición
 * @returns { filas, totales: { filas, pendientes, cantidad }, sinMant: [tipos], avisos }
 *
 * Por local y tipo, en este orden:
 *   ficha de verificación → un lote por aula contada (Malo y, en «Malo + % de Regular», el Regular a
 *     reponer); las aulas no contadas siguen con el censo
 *   corrección a mano (sin ficha) → un lote por local y estado, con lo corregido
 *   censo → un lote por aula y estado, pendiente de verificación en campo
 * Si los lotes no suman lo que repone el costo (tope de matrícula, entregas previas descontadas…),
 * se agrega una fila de ajuste para que la ficha cuadre con el metrado.
 * El mantenimiento anual del tipo (Documentos) se prorratea entre sus lotes según la cantidad.
 */
export function fichaActivos({ x, P = {}, datos = {}, anioRef }) {
  const { D, C, R, inv = {} } = x, base = D.base || D, esc = C.escenario || 'malo', umbral = C.umbralVida ?? 10;
  const idx = new Map(D.locs.map((l, i) => [l[0], i]));
  const filas = [];
  for (const l of R.locales) {
    const i = idx.get(l.cod); if (i == null) continue;
    const fila = inv[l.cod], ficha = fila?.ficha, enVista = new Set(D.locAul[i]);
    const nuevo = (t, nivel, grado) => (l.kit && t < 2 ? 'Kit de mobiliario (mesa + silla del estudiante)' : NOMBRE_BIEN[ITEMS[t].k]) + (t < 2 ? ' – ' + tallaTexto(nivel, grado) : '');
    ITEMS.forEach((it, t) => {
      const rep = l.rep[t];
      if (!rep) return;
      const lotes = [];
      const push = o => { if (o.cantidad > 0) lotes.push({ cod: l.cod, colegio: l.nom, nivel: NIVN[x.nivel] || '', bien: it.k, unidad: it.u, ...o }); };
      const corregido = fila?.bienes?.[it.k] && !fila?.verif?.[it.k];
      if (corregido) {
        // Corrección a mano por local: no hay lotes por aula ni código patrimonial
        const v = fila.bienes[it.k], adq = fila.adquisicion?.[it.k];
        const regular = esc === 'malo_regular' ? Math.max(0, rep - v.m) : 0;
        for (const [estado, q] of [['Malo', Math.min(v.m, rep)], ['Regular', regular]]) push({
          ambiente: 'Todo el local (inventario corregido a mano)', grado: '', seccion: '', denom_existente: NOMBRE_BIEN[it.k],
          denom_nueva: nuevo(t, x.nivel || D.svcs[D.locSvc[i][0]]?.[2], ''), patrimonial: '', antiguedad: adq ? anioRef - adq : null, antig_origen: adq ? 'año de adquisición del local' : '',
          estado, origen: 'Verificado en campo (corrección por local)', cantidad: q });
      } else {
        base.locAul[i].forEach((ai, j) => {
          if (!enVista.has(ai)) return;
          const a = base.aulas[ai], nivel = base.svcs[a[1]][2], pct = C.pctNiv?.[nivel] ?? C.pctRegular ?? 100;
          const comun = { ambiente: textoAmbiente(a), grado: a[5] || '', seccion: a[6] || '', denom_nueva: nuevo(t, nivel, a[5]) };
          const fk = (ficha?.aulas?.[j]?.filas || []).filter(f => f.k === it.k && f.b != null);
          if (fk.length) {
            // Un lote por fila de la ficha: cada una con su código patrimonial, antigüedad y observación.
            // Regular («Malo + % de Regular»): con antigüedad ≥ umbral, todo; sin antigüedad, el % del aula
            // repartido entre esas filas; con antigüedad menor, nada (igual que en el costo).
            let est = esc === 'malo_regular' ? regularAReponer(fk.filter(f => f.antig == null).reduce((a, f) => a + f.r, 0), pct) : 0;
            for (const f of fk) {
              let reg = 0;
              if (esc === 'malo_regular') {
                if (f.antig == null) { reg = Math.min(f.r, est); est -= reg; } else if (f.antig >= umbral) reg = f.r;
              }
              const dato = { ...comun, denom_existente: NOMBRE_BIEN[it.k], patrimonial: f.patrimonial || '', antiguedad: f.antig ?? null,
                antig_origen: f.antig != null ? (f.estimada ? 'ficha (rango, estimada)' : 'ficha') : '', origen: 'Verificado en campo (ficha)', obs: f.obs || '', baja: f.baja || '' };
              push({ ...dato, estado: 'Malo', cantidad: f.m });
              push({ ...dato, estado: 'Regular', cantidad: reg });
            }
          } else {
            const m = C.A.m[t][ai], reg = Math.max(0, C.A.rep[t][ai] - m);
            const adq = fila?.adquisicion?.[it.k];
            const den = st => it.k === 'mesa' && mesasDelCenso(a, P, st).length ? `${NOMBRE_BIEN.mesa} (censo: ${mesasDelCenso(a, P, st).join(', ')})` : NOMBRE_BIEN[it.k];
            const dato = { ...comun, patrimonial: '', antiguedad: adq ? anioRef - adq : null, antig_origen: adq ? 'año de adquisición del local' : '', origen: 'Censo Educativo (sin verificar)' };
            if (esc === 'capacidad') push({ ...dato, denom_existente: NOMBRE_BIEN[it.k], estado: 'No aplica (por capacidad)', cantidad: C.A.rep[t][ai] });
            else { push({ ...dato, denom_existente: den('m'), estado: 'Malo', cantidad: m }); push({ ...dato, denom_existente: den('r'), estado: 'Regular', cantidad: reg }); }
          }
        });
      }
      // Que la ficha cuadre con el metrado del costo
      const suma = lotes.reduce((s, f) => s + f.cantidad, 0);
      if (suma !== rep) lotes.push({ cod: l.cod, colegio: l.nom, nivel: NIVN[x.nivel] || '', bien: it.k, unidad: it.u, ambiente: 'Ajuste al metrado del costo', grado: '', seccion: '',
        denom_existente: NOMBRE_BIEN[it.k], denom_nueva: nuevo(t, x.nivel, ''), patrimonial: '', antiguedad: null, antig_origen: '', estado: '', origen: 'Ajuste',
        cantidad: rep - suma, ajuste: true, obs: rep < suma ? 'Se descuenta del metrado: tope de matrícula o de capacidad de diseño, o entregas previas descontadas.' : 'Diferencia de redondeo del % de Regular.' });
      filas.push(...lotes);
    });
  }
  // Pendientes: lo que no tiene dato de campo (no se inventa)
  for (const f of filas) {
    const motivos = [];
    if (f.ajuste) { f.pendiente = false; f.motivos = []; continue; }
    if (/^Censo/.test(f.origen)) motivos.push('el estado sale del censo, falta contarlo en campo');
    if (!f.patrimonial) motivos.push('falta el código patrimonial');
    if (f.antiguedad == null) motivos.push('falta la antigüedad');
    f.pendiente = motivos.length > 0; f.motivos = motivos;
    f.situacion = f.pendiente ? PENDIENTE_CAMPO : 'Completa';
  }
  // Mantenimiento anual del tipo, prorrateado según la cantidad de cada lote
  const totTipo = {};
  for (const f of filas) totTipo[f.bien] = (totTipo[f.bien] || 0) + f.cantidad;
  const sinMant = new Set();
  for (const f of filas) {
    const kNuevo = f.denom_nueva.startsWith('Kit') ? 'kit' : f.bien;
    const ma = datos.mant_actual?.[f.bien], mn = datos.mant_nuevo?.[kNuevo] ?? datos.mant_nuevo?.[f.bien];
    const parte = totTipo[f.bien] ? f.cantidad / totTipo[f.bien] : 0;
    f.mant_existente = ma == null ? null : Math.round(ma * parte * 100) / 100;
    f.mant_nuevo = mn == null ? null : Math.round(mn * parte * 100) / 100;
    if (ma == null) sinMant.add(`${NOMBRE_BIEN[f.bien]} (existente)`);
    if (mn == null) sinMant.add(`${kNuevo === 'kit' ? 'Kit de mobiliario' : NOMBRE_BIEN[f.bien]} (nuevo)`);
  }
  const reales = filas.filter(f => !f.ajuste);
  const totales = { filas: reales.length, pendientes: reales.filter(f => f.pendiente).length, cantidad: filas.reduce((s, f) => s + f.cantidad, 0) };
  const avisos = [];
  if (totales.pendientes) avisos.push({ tipo: 'ficha_activos', texto: `${totales.pendientes} de ${totales.filas} lotes de activos a reponer están pendientes de verificación en campo (estado del censo, sin código patrimonial o sin antigüedad).` });
  if (sinMant.size) avisos.push({ tipo: 'ficha_activos', texto: `Costo anual de mantenimiento vacío en: ${[...sinMant].join(', ')}. Cárgalo en Documentos (puede ser 0).` });
  return { filas, totales, sinMant: [...sinMant], avisos };
}

// ─── Informe técnico de vida útil ────────────────────────────────────────────
// Fuentes admitidas por la Directiva 005-2016-EF/51.01 para fijar la vida útil
export const FUENTES_VIDA_UTIL = {
  control_patrimonial: 'Información de la oficina de control patrimonial (o la que haga sus veces)',
  estimacion_entidad: 'Estimación técnica de la propia entidad',
  estimacion_externa: 'Estimación técnica externa (especialista o proveedor)',
  similares: 'Vida útil de elementos similares usados por la entidad u otras entidades'
};
export const VIDA_REFERENCIAL = 10;   // años, referencial para mobiliario: no se aplica en automático

/**
 * Modelo del informe de vida útil de una IOARR, a partir de la ficha de activos.
 *   Malo     · sustento por vida útil efectiva: ya no es útil ni operativo (estado verificado o del censo)
 *   Regular  · solo entra con antigüedad ≥ vida útil estimada (o el umbral, si falta) o con daño
 *              documentado en la ficha; si no, «sin sustento» y se avisa
 * @param ficha  fichaActivos()
 * @param datos  Documentos: vida_util_estimada, fuentes_vida_util, patrimonial_nombre, patrimonial_cargo, informe_vida_util
 * @param umbral años de vida útil del escenario (criterios), para el Regular sin vida útil estimada
 */
export function modeloVidaUtil({ ficha, datos = {}, umbral = VIDA_REFERENCIAL, nombreIoarr = '' }) {
  const filas = ficha.filas.filter(f => !f.ajuste);
  const vidaDe = k => datos.vida_util_estimada?.[k] ?? null;
  const sustento = f => {
    if (f.estado === 'Malo') return { ok: true, motivo: /^Verificado/.test(f.origen) ? 'Malo verificado en campo: vida útil efectiva cumplida' : 'Malo según el censo: confirmar en campo' };
    if (f.estado !== 'Regular') return { ok: true, motivo: f.estado };
    const lim = vidaDe(f.bien) ?? umbral, ant = typeof f.antiguedad === 'number' ? f.antiguedad : parseFloat(String(f.antiguedad ?? '').split(' a ').pop());
    if (Number.isFinite(ant) && ant >= lim) return { ok: true, motivo: `Antigüedad ${f.antiguedad} años ≥ vida útil ${lim} años` };
    if (f.obs && /^Verificado/.test(f.origen)) return { ok: true, motivo: 'Daño documentado en la ficha: ' + f.obs };
    return { ok: false, motivo: Number.isFinite(ant) ? `Antigüedad ${f.antiguedad} años < vida útil ${lim} años y sin daño documentado` : 'Sin antigüedad ni daño documentado' };
  };
  const agrupar = fs => {
    const g = new Map();
    for (const f of fs) {
      const o = g.get(f.bien) || { k: f.bien, nombre: NOMBRE_BIEN[f.bien], malo: 0, regular: 0, regularSin: 0, ants: [], vida: vidaDe(f.bien), lotes: 0, pendientes: 0 };
      const s = sustento(f);
      if (f.estado === 'Malo') o.malo += f.cantidad;
      if (f.estado === 'Regular') { o.regular += f.cantidad; if (!s.ok) o.regularSin += f.cantidad; }
      if (typeof f.antiguedad === 'number') o.ants.push([f.antiguedad, f.cantidad]);
      o.lotes++; if (f.pendiente) o.pendientes++;
      g.set(f.bien, o);
    }
    return ITEMS.map(x => g.get(x.k)).filter(Boolean).map(o => {
      const peso = o.ants.reduce((a, [, q]) => a + q, 0);
      return { ...o, antiguedad: peso ? Math.round(o.ants.reduce((a, [v, q]) => a + v * q, 0) / peso * 10) / 10 : null,
        antMin: o.ants.length ? Math.min(...o.ants.map(([v]) => v)) : null, antMax: o.ants.length ? Math.max(...o.ants.map(([v]) => v)) : null };
    });
  };
  const colegios = [];
  for (const f of filas) { let c = colegios.find(x => x.cod === f.cod); if (!c) colegios.push(c = { cod: f.cod, colegio: f.colegio, filas: [] }); c.filas.push(f); }
  for (const c of colegios) { c.tipos = agrupar(c.filas); c.lotes = c.filas.map(f => ({ ...f, sustento: sustento(f) })); }
  const tipos = agrupar(filas);
  const fuentes = (datos.fuentes_vida_util || []).filter(k => FUENTES_VIDA_UTIL[k]);
  const regularSin = tipos.reduce((a, t) => a + t.regularSin, 0);
  const faltan = [];
  if (!fuentes.length) faltan.push('Fuente de la vida útil estimada (Directiva 005-2016-EF/51.01): control patrimonial, estimación técnica o elementos similares.');
  const sinVida = tipos.filter(t => t.vida == null).map(t => t.nombre.toLowerCase());
  if (sinVida.length) faltan.push(`Vida útil estimada de: ${sinVida.join(', ')} (${VIDA_REFERENCIAL} años es solo referencial).`);
  if (!datos.patrimonial_nombre) faltan.push('Nombre y cargo del responsable de control patrimonial que firma el informe.');
  if (regularSin) faltan.push(`${regularSin.toLocaleString('es-PE')} bienes en estado Regular sin antigüedad ni daño documentado: no se sustenta su reposición hasta documentarlos en campo.`);
  return { nombreIoarr, tipos, colegios, fuentes, umbral, referencial: VIDA_REFERENCIAL, regularSin, documento: datos.informe_vida_util || '',
    responsable: { nombre: datos.patrimonial_nombre || '', cargo: datos.patrimonial_cargo || '' }, faltan };
}

// ─── Datos por colegio (Documentos → datos.colegios[codLocal]) ───────────────
// Se guardan en ioarr_expediente_documentos.datos (migración 015): no hace falta otra tabla.
export const DOCS_BAJA = { acta: 'Acta', resolucion: 'Resolución', compromiso: 'Compromiso' };
export const SI_NO = { si: 'Sí', no: 'No' };
const txt = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const sino = v => ['si', 'no'].includes(v) ? v : '';
const fechaOk = v => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(v || '')) ? v : null;

/** Valida los datos de un colegio. Lo desconocido se descarta; lo vacío queda vacío. */
export function limpiarColegio(b = {}) {
  const x = b && typeof b === 'object' ? b : {}, inv = x.inventario && typeof x.inventario === 'object' ? x.inventario : {};
  return {
    // Inventario y baja (Lineamientos 2.4.C.e y 2.4.C.f)
    inventario: {
      registrado: sino(inv.registrado), contabilidad: sino(inv.contabilidad), baja: sino(inv.baja),
      doc_tipo: DOCS_BAJA[inv.doc_tipo] ? inv.doc_tipo : '', doc_numero: txt(inv.doc_numero, 120), doc_fecha: fechaOk(inv.doc_fecha)
    },
    nota: txt(x.nota, 500)
  };
}
// Sin nada cargado: no hace falta guardar la fila
export const colegioVacio = c => !c.nota && !Object.values(c.inventario).some(Boolean);
export function limpiarColegios(obj) {
  const out = {};
  for (const [cod, v] of Object.entries(obj && typeof obj === 'object' ? obj : {}).slice(0, 50000)) {
    if (!/^\d{4,10}$/.test(cod)) continue;
    const c = limpiarColegio(v);
    if (!colegioVacio(c)) out[cod] = c;
  }
  return out;
}
export const colegioDe = (colegios, cod) => colegios?.[cod] || limpiarColegio({});

/**
 * Checklist de inventario y baja de un colegio. Sin completar, el colegio no entra al 07-C
 * (se puede exportar un borrador con todos).
 * @returns { completo, faltan: [texto] }
 */
export function checklistColegio(c, def = {}) {
  // registrado: lo del colegio o, si no lo tiene, lo marcado para todo el proyecto en Documentos
  const v0 = (c || limpiarColegio({})).inventario, v = { ...v0, registrado: v0.registrado || sino(def.registrado) }, faltan = [];
  if (v.registrado !== 'si') faltan.push(v.registrado === 'no' ? 'el mobiliario no está registrado en el inventario (2.4.C.e)' : 'registro en el inventario');
  if (v.contabilidad !== 'si') faltan.push(v.contabilidad === 'no' ? 'el mobiliario no está registrado en la contabilidad (2.4.C.e)' : 'registro en la contabilidad');
  if (v.baja !== 'si') faltan.push(v.baja === 'no' ? 'el trámite de baja no se inició (2.4.C.f)' : 'trámite de baja iniciado');
  if (!v.doc_tipo) faltan.push('documento de respaldo (acta, resolución o compromiso)');
  if (!v.doc_fecha) faltan.push('fecha del documento de respaldo');
  return { completo: !faltan.length, faltan };
}
export const AVISO_BORRADOR = 'BORRADOR CON TODOS LOS COLEGIOS: incluye colegios con el checklist de inventario y baja incompleto, que no entran al Formato 07-C final.';
