// ============================================================================
// src/selector-ioarr/ficha.js — Ficha de verificación de mobiliario por local
//
// Estructura del documento «Ficha de verificación de mobiliario escolar — IOARR
// de reposición»:
//   A  datos del local (padrón) y de la visita (campo)
//   B  servicios educativos: estudiantes del padrón y verificados
//   C  verificación por aula: cinco filas por aula (mesa, silla, escritorio,
//      silla docente, armario o estante), con el censo ya cargado
//   D  mobiliario fuera de aulas y panel fotográfico
//   E  observaciones y firmas de conformidad
//
//   modeloFicha(D, C, i, meta)  datos de la ficha de un local (padrón y censo)
//   generarFichaExcel(F)        Excel para llenar en campo (lleva claves ocultas)
//   generarFichaPdf(F, llena?)  PDF imprimible (pdfkit); con llena, la ficha llenada en la app:
//                               lo verificado, el panel fotográfico con las fotos y las firmas en pantalla
//   leerFicha(buffer)           lee el Excel que devuelve la UGEL
//   procesarFicha(...)          valida y arma lo que se guarda en el inventario
//
// Reglas de la importación (decididas con el usuario):
//   - Fila completa: si se llena un estado verificado, se llenan los tres (B, R y M).
//     B + R + M es lo existente verificado. Se rechazan las filas a medias, con
//     negativos o con decimales.
//   - Mesas: se cuentan por unidad, con «Puestos por unidad» (vacío = 1); la app
//     las pasa a puestos. Si en un aula hay mesas de distinto tipo, se agrega otra
//     fila de mesa (se suman).
//   - En cada local, nivel y tipo de bien con algo verificado, lo verificado
//     reemplaza al censo en esas aulas; las aulas sin verificar siguen con el censo.
//   - Antigüedad en años o por rango (menos de 5, de 5 a 10, más de 10). El rango
//     queda marcado como «estimada».
//   - Si lo contado difiere del censo en más de 15 % y no hay observación, avisa
//     sin rechazar la fila.
// ============================================================================

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { NIVN } from './calculo.js';
import { TIPOS, tipoDesdeDescripcion } from './costos.js';

export const VERSION_FICHA = 1;
export const HOJA = 'Ficha';
const HOJA_APP = '_app';
export const BIENES_FICHA = [
  { k: 'mesa', n: 'Mesa del estudiante' }, { k: 'silla', n: 'Silla del estudiante' }, { k: 'esc', n: 'Escritorio docente' },
  { k: 'sdoc', n: 'Silla docente' }, { k: 'arm', n: 'Armario o estante' }];
const NOMBRE_BIEN = Object.fromEntries(BIENES_FICHA.map(x => [x.k, x.n]));
// Muebles de la ficha: los del modelo (los que entran a la IOARR); fichas viejas, los cinco
export const bienesDe = F => F?.bienes?.length ? F.bienes : BIENES_FICHA;
export const BAJA = { si: 'Sí', no: 'No', en_tramite: 'En trámite' };
// Antigüedad por rango: años que se usan para el cálculo (marcada como estimada)
export const RANGOS = [
  { clave: 'menos5', texto: 'Menos de 5', anios: 3, re: /^(menos\s*de\s*5|<\s*5)/ },
  { clave: '5a10', texto: 'De 5 a 10', anios: 8, re: /^(de\s*)?5\s*(a|-|–)\s*10/ },
  { clave: 'mas10', texto: 'Más de 10', anios: 12, re: /^(mas\s*de\s*10|>\s*10)/ }];
export const TOLERANCIA = 0.15;
export const MAX_PUESTOS = 12;
const COLS = 13;              // A..L visibles; M = clave oculta
const COL_CLAVE = 13;

// Niveles del local, en orden (lo mismo que niveles.js, sin importarlo: niveles.js usa este módulo)
const ORDEN = ['I', 'P', 'S', 'E'];
const nivelesDeLocal = (D, i) => [...new Set(D.locSvc[i].map(si => D.svcs[si][2]))].sort((a, b) => ORDEN.indexOf(a) - ORDEN.indexOf(b));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const NF = new Intl.NumberFormat('es-PE');
const ent = n => NF.format(n || 0);
const vacio = v => v == null || v === '';

// ─── Modelo ─────────────────────────────────────────────────────────────────
/**
 * Datos de la ficha de un local.
 * @param D     datos de la región (prep)
 * @param C     calc(D, P): censo por aula ya en puestos (mesa) con los criterios del proyecto
 * @param i     índice del local
 * @param meta  { proyecto: { id, nombre }, anio, fecha, supervisor? (correo del supervisor de campo asignado) }
 */
export function modeloFicha(D, C, i, meta = {}) {
  const l = D.locs[i], dist = D.dists[l[1]];
  const servicios = D.locSvc[i].map(si => D.svcs[si]).map(s => ({ modular: s[0], nombre: s[1], nivel: s[2], nombreNivel: NIVN[s[2]], turno: s[7] || '', secciones: s[5], est: s[6] }))
    .sort((a, b) => ORDEN.indexOf(a.nivel) - ORDEN.indexOf(b.nivel) || a.modular.localeCompare(b.modular));
  const aulas = D.locAul[i].map((ai, j) => {
    const a = D.aulas[ai], s = D.svcs[a[1]];
    return {
      j, nivel: s[2], nombreNivel: NIVN[s[2]], modular: s[0], edif: a[2] || '', piso: a[3] ?? '', num: a[4] || '', grado: a[5] || '', seccion: a[6] || '', turno: a[7] || '', est: a[8],
      censo: Object.fromEntries(TIPOS.map((k, t) => [k, { b: C.A.b[t][ai], r: C.A.r[t][ai], m: C.A.m[t][ai] }]))
    };
  });
  return {
    version: VERSION_FICHA, proyecto: meta.proyecto || { id: '', nombre: '' }, anio: meta.anio || null, fecha: meta.fecha || '', supervisor: meta.supervisor || '',
    local: { cod: l[0], nombre: D.locName[i], region: D.region, prov: D.provs[dist[2]], dist: dist[0], ubigeo: dist[1], ugel: D.ugels?.[l[2]] || '', cp: l[3] || '', rural: !!l[4], direccion: l[5] || '', lat: l[6], lon: l[7] },
    niveles: nivelesDeLocal(D, i), servicios, aulas,
    // Solo los muebles que entran a la IOARR (criterios del proyecto)
    bienes: BIENES_FICHA.filter(b => !C.incl || C.incl[TIPOS.indexOf(b.k)])
  };
}
const textoAula = (a, n) => `Aula ${a.j + 1} de ${n} · ${a.nombreNivel} (cód. modular ${a.modular}) · edificación ${a.edif || '___'} · piso ${a.piso === '' ? '___' : a.piso} · N.° ${a.num || '___'} · ${a.grado || 'grado ___'}${a.seccion ? ' ' + a.seccion : ''} · turno ${a.turno || '___'} · estudiantes (censo) ${a.est}`;

// ─── Excel ──────────────────────────────────────────────────────────────────
const AZUL = 'FF3A63E0', GRIS = 'FFEEF0F4', CAMPO = 'FFFFF8DC', BORDE = { style: 'thin', color: { argb: 'FFC9CED8' } };
const BORDES = { top: BORDE, left: BORDE, bottom: BORDE, right: BORDE };
const relleno = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const NOTA_SIGLAS = 'Censo = lo que el colegio declaró en el Censo Educativo; Verificado = lo que cuenta el verificador en campo. B = Bueno, R = Regular, M = Malo: los tres estados del mueble (criterios al final).';
export const CRITERIOS = [
  ['Bueno', 'Se usa sin reparación; estructura firme y superficie íntegra', 'No'],
  ['Regular', 'Se usa con desgaste o un desperfecto menor reparable (tablero rayado, tornillo flojo)', 'No; se informa como diagnóstico (la propuesta repone solo lo Malo)'],
  ['Malo', 'No se puede usar, o es un riesgo para el estudiante (estructura rota, tablero partido) y no conviene repararlo', 'Sí']];
export const REGLAS = [
  'Se cuenta por unidad física: cada mueble que hay en el aula, uno por uno.',
  '«Puestos por unidad» (solo mesas): cuántos estudiantes se sientan en cada mesa. Mesa individual = 1; carpeta bipersonal = 2; mesa grupal de inicial = de 4 a 6 (de 1 a 12; vacío = 1). El censo cuenta las mesas en puestos, así que la app multiplica las mesas por sus puestos para compararlas con el censo y calcular lo que se repone. Ejemplo: 12 carpetas bipersonales (10 buenas, 1 regular y 1 mala) se anotan Bueno 10, Regular 1, Malo 1 y Puestos por unidad 2; cuentan como 20, 2 y 2 puestos. Si no anotas los puestos de una carpeta bipersonal, se cuenta como individual y lo contado saldrá muy por debajo del censo.',
  'Si en un aula hay mesas de distinto tipo (por ejemplo, bipersonales e individuales), copia la fila de la mesa debajo y anota cada tipo en su fila, con sus puestos; la app las suma.',
  'Si llenas un estado verificado, llena los tres (Bueno, Regular y Malo; 0 si no hay). Un aula sin verificar se deja en blanco y sigue con el censo.',
  'La antigüedad es en años, según el año de adquisición si hay documento. Si no lo hay, escribe un rango: «Menos de 5», «De 5 a 10» o «Más de 10»; queda marcada como estimada.',
  'Estado de baja: Sí, No o En trámite.',
  'Un mueble en mal estado se fotografía antes de anotarlo; el número de foto va en la observación.',
  'Si lo contado difiere del censo en más de 15 %, explica la causa en la observación.',
  'No cambies las celdas grises ni borres filas: la app las usa para leer la ficha.'];
export const FIRMAS = [['director', 'Director(a) de la institución educativa'], ['ugel', 'Especialista o verificador de la UGEL'], ['registradora', 'Representante de la entidad registradora (si corresponde)']];
export const CAB_C = ['Bien', 'Censo Bueno', 'Censo Regular', 'Censo Malo', 'Verificado Bueno', 'Verificado Regular', 'Verificado Malo', 'Puestos por unidad (mesas)', 'Antigüedad (años o rango)', 'Cód. patrimonial', 'Estado de baja (Sí / No / En trámite)', 'Observación'];

export async function generarFichaExcel(F) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Radar Ibero — Selector IOARR'; wb.created = new Date();
  const ws = wb.addWorksheet(HOJA, {
    views: [{ showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: `&L${F.local.cod} · Ficha de verificación&RPágina &P de &N` }
  });
  [30, 11, 11, 11, 12, 12, 12, 12, 14, 16, 15, 34, 12].forEach((w, j) => { ws.getColumn(j + 1).width = w; });
  ws.getColumn(COL_CLAVE).hidden = true;
  let r = 0;
  const fila = (clave, alto) => { r++; if (clave) ws.getCell(r, COL_CLAVE).value = clave; if (alto) ws.getRow(r).height = alto; return r; };
  const celda = (c, v, o = {}) => {
    const x = ws.getCell(r, c);
    if (v !== undefined) x.value = v;
    x.font = { name: 'Calibri', size: o.size || 10, bold: !!o.bold, italic: !!o.italic, color: { argb: o.color || (o.cab ? 'FFFFFFFF' : 'FF16181D') } };
    x.alignment = { vertical: 'middle', horizontal: o.align || (typeof v === 'number' ? 'right' : 'left'), wrapText: true };
    if (o.fill) x.fill = relleno(o.fill);
    if (o.borde !== false && (o.fill || o.cab || o.borde)) x.border = BORDES;
    if (o.fmt) x.numFmt = o.fmt;
    return x;
  };
  const unir = (c1, c2, v, o) => {
    if (c2 > c1) ws.mergeCells(r, c1, r, c2);
    celda(c1, v, o);
    for (let c = c1 + 1; c <= c2; c++) { const x = ws.getCell(r, c); if (o?.fill) x.fill = relleno(o.fill); if (o?.borde !== false) x.border = BORDES; }
  };
  const titulo = t => { fila(null, 22); unir(1, 12, t, { bold: true, size: 13, color: 'FF3A63E0', borde: false }); };
  const parrafo = (t, o = {}) => { fila(null, o.alto); unir(1, 12, t, { italic: o.italic, size: 9, color: 'FF5C6270', borde: false }); };
  const cab = (tramos) => { fila('CAB'); for (const [c1, c2, t] of tramos) unir(c1, c2, t, { cab: true, fill: AZUL, bold: true, size: 9, align: 'center' }); ws.getRow(r).height = 30; };

  const L = F.local;
  fila(null, 24); unir(1, 12, 'Ficha de verificación de mobiliario escolar — IOARR de reposición', { bold: true, size: 15, borde: false });
  fila(); unir(1, 12, `Local ${L.cod} · ${L.nombre} · Proyecto «${F.proyecto.nombre}» · generada el ${F.fecha} con el Padrón ESCALE y el Censo Educativo ${F.anio || ''}${F.supervisor ? ` · Supervisor asignado: ${F.supervisor}` : ''}`, { size: 9, color: 'FF5C6270', borde: false });
  parrafo('Las celdas grises las llenó la app; las amarillas se llenan en campo. Una ficha por local. Al terminar, súbela en Selector IOARR → Expediente → Fichas: las cantidades verificadas reemplazan a las del censo en el cálculo.', { italic: true, alto: 28 });
  parrafo(NOTA_SIGLAS, { italic: true, alto: 28 });

  // A. Datos del local
  fila(); titulo('A. Datos del local educativo');
  cab([[1, 1, 'Campo'], [2, 8, 'Valor'], [9, 12, 'Origen']]);
  const filaA = (campo, valor, origen, clave, editable) => {
    fila(clave, editable ? 22 : undefined);
    unir(1, 1, campo, { fill: GRIS, bold: true, size: 9 });
    unir(2, 8, valor ?? '', { fill: editable ? CAMPO : GRIS, size: 10 });
    unir(9, 12, origen, { fill: GRIS, size: 9, color: 'FF5C6270' });
  };
  filaA('Código de local', L.cod, 'Padrón (app)', 'A|cod');
  filaA('Región / provincia / distrito', `${L.region} / ${L.prov} / ${L.dist}`, 'Padrón (app)');
  filaA('UGEL', L.ugel, 'Padrón (app)');
  filaA('Centro poblado y área', `${L.cp} · ${L.rural ? 'rural' : 'urbana'}`, 'Padrón (app)');
  filaA('Dirección', L.direccion, 'Padrón (app)');
  filaA('Coordenadas (latitud, longitud)', L.lat != null ? `${L.lat}, ${L.lon}` : '', 'Padrón (app); corrígelas con GPS si difieren', 'A|coord', true);
  filaA('Fecha de la verificación (dd/mm/aaaa)', null, 'Campo (obligatoria para importar)', 'A|fecha', true);
  ws.getCell(r, 2).numFmt = 'dd/mm/yyyy';
  ws.getCell(r, 2).dataValidation = { type: 'date', operator: 'greaterThan', formulae: [new Date(Date.UTC(2000, 0, 1))], allowBlank: true, showErrorMessage: true, errorTitle: 'Fecha', error: 'Escribe una fecha (dd/mm/aaaa)' };
  filaA('Verificador: nombre, cargo y DNI', null, 'Campo', 'A|verificador', true);
  filaA('Persona de la IE que acompañó: nombre y cargo', null, 'Campo', 'A|acompanante', true);

  // B. Servicios
  fila(); titulo('B. Servicios educativos del local');
  parrafo('Una fila por código modular. Contrasta los estudiantes con la nómina o el SIAGIE de la institución.');
  cab([[1, 1, 'Código modular'], [2, 4, 'Institución'], [5, 5, 'Nivel'], [6, 6, 'Turno'], [7, 7, 'Secciones (padrón)'], [8, 8, 'Estudiantes (padrón)'], [9, 9, 'Estudiantes verificados'], [10, 12, 'Observación']]);
  for (const s of F.servicios) {
    fila('B|' + s.modular, 20);
    unir(1, 1, s.modular, { fill: GRIS }); unir(2, 4, s.nombre, { fill: GRIS }); unir(5, 5, s.nombreNivel, { fill: GRIS }); unir(6, 6, s.turno, { fill: GRIS });
    unir(7, 7, s.secciones, { fill: GRIS }); unir(8, 8, s.est, { fill: GRIS }); unir(9, 9, null, { fill: CAMPO }); unir(10, 12, null, { fill: CAMPO });
    ws.getCell(r, 9).dataValidation = { type: 'whole', operator: 'greaterThanOrEqual', formulae: [0], allowBlank: true, showErrorMessage: true, error: 'Número entero de 0 o más' };
  }

  // C. Verificación por aula
  fila(); titulo('C. Verificación del mobiliario por aula');
  parrafo(`${F.aulas.length} ${F.aulas.length === 1 ? 'aula' : 'aulas'} en uso según el censo. ${bienesDe(F).length === 1 ? 'Una fila' : bienesDe(F).length + ' filas'} por aula, con las cantidades del censo ya cargadas (la mesa, en puestos). Anota lo que cuentas: Bueno, Regular y Malo, la antigüedad y lo demás. ${NOTA_SIGLAS}`, { alto: 40 });
  const entero0 = { type: 'whole', operator: 'greaterThanOrEqual', formulae: [0], allowBlank: true, showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Cantidad', error: 'Número entero de 0 o más' };
  for (const a of F.aulas) {
    fila('AULA|' + a.j, 30);
    unir(1, 10, textoAula(a, F.aulas.length), { fill: GRIS, bold: true, size: 9 });
    unir(11, 11, 'Estudiantes verificados', { fill: GRIS, size: 9, align: 'right' });
    unir(12, 12, null, { fill: CAMPO });
    ws.getCell(r, 12).dataValidation = entero0;
    cab(CAB_C.map((t, j) => [j + 1, j + 1, t]));
    for (const b of bienesDe(F)) {
      const c = a.censo[b.k];
      fila('ITEM|' + b.k, 18);
      unir(1, 1, b.n + (b.k === 'mesa' ? ' (censo en puestos)' : ''), { fill: GRIS, size: 9 });
      unir(2, 2, c.b, { fill: GRIS }); unir(3, 3, c.r, { fill: GRIS }); unir(4, 4, c.m, { fill: GRIS });
      for (let col = 5; col <= 12; col++) unir(col, col, null, { fill: b.k !== 'mesa' && col === 8 ? GRIS : CAMPO });
      for (const col of [5, 6, 7]) ws.getCell(r, col).dataValidation = entero0;
      if (b.k === 'mesa') ws.getCell(r, 8).dataValidation = { type: 'whole', operator: 'between', formulae: [1, MAX_PUESTOS], allowBlank: true, showErrorMessage: true, error: `Puestos por unidad: de 1 a ${MAX_PUESTOS} (vacío = 1)` };
      ws.getCell(r, 11).dataValidation = { type: 'list', formulae: ['"Sí,No,En trámite"'], allowBlank: true, showErrorMessage: true, error: 'Elige Sí, No o En trámite' };
    }
  }
  if (!F.aulas.length) parrafo('El censo no registra aulas en este local: anota el mobiliario en la sección D o en las observaciones.');

  // D. Fuera de aulas y panel fotográfico
  fila(); titulo('D. Mobiliario fuera de aulas y panel fotográfico');
  parrafo('El censo solo cubre las aulas. Estos ambientes (dirección, sala de docentes, biblioteca, laboratorio, AIP, comedor) se anotan solo si el proyecto los incluye.');
  cab([[1, 1, 'Ambiente'], [2, 3, 'Bien'], [4, 4, 'Bueno'], [5, 5, 'Regular'], [6, 6, 'Malo'], [7, 7, 'Antigüedad (años o rango)'], [8, 12, 'Observación']]);
  for (let k = 0; k < 6; k++) {
    fila('FUERA', 18);
    unir(1, 1, null, { fill: CAMPO }); unir(2, 3, null, { fill: CAMPO });
    for (const col of [4, 5, 6]) { unir(col, col, null, { fill: CAMPO }); ws.getCell(r, col).dataValidation = entero0; }
    unir(7, 7, null, { fill: CAMPO }); unir(8, 12, null, { fill: CAMPO });
  }
  parrafo('Panel fotográfico mínimo por local: fachada con el letrero de la institución, una vista general de cada tipo de aula y un detalle de cada tipo de mueble en mal estado. Cada foto lleva fecha, código de local y aula. Las fotos se suben en «Corregir inventario» del local.', { alto: 28 });
  cab([[1, 1, 'N.°'], [2, 4, 'Ambiente o aula'], [5, 8, 'Qué muestra'], [9, 12, 'Archivo']]);
  for (let k = 1; k <= 8; k++) {
    fila('FOTO', 18);
    unir(1, 1, k, { fill: GRIS, align: 'center' }); unir(2, 4, k === 1 ? 'Fachada' : null, { fill: CAMPO }); unir(5, 8, k === 1 ? 'Local y letrero' : null, { fill: CAMPO }); unir(9, 12, null, { fill: CAMPO });
  }

  // E. Observaciones y conformidad
  fila(); titulo('E. Observaciones y conformidad');
  fila(null); unir(1, 12, 'Observaciones del verificador:', { bold: true, size: 9, borde: false });
  fila('E|obs', 60); unir(1, 12, null, { fill: CAMPO });
  parrafo('Declaración: las cantidades, estados y antigüedades de esta ficha corresponden a lo constatado en el local en la fecha indicada.');
  cab([[1, 1, 'Cargo'], [2, 5, 'Nombres y apellidos'], [6, 7, 'DNI'], [8, 10, 'Firma y sello'], [11, 12, 'Fecha']]);
  for (const [clave, cargo] of FIRMAS) {
    fila('FIRMA|' + clave, 40);
    unir(1, 1, cargo, { fill: GRIS, size: 9 }); unir(2, 5, null, { fill: CAMPO }); unir(6, 7, null, { fill: CAMPO }); unir(8, 10, null, { fill: CAMPO }); unir(11, 12, null, { fill: CAMPO });
  }

  // Criterios
  fila(); titulo('Criterios de estado y reglas de llenado');
  cab([[1, 1, 'Estado'], [2, 8, 'Cuándo se marca'], [9, 12, 'Entra a reponer']]);
  for (const [e, cuando, rep] of CRITERIOS) { fila(null, 30); unir(1, 1, e, { fill: GRIS, bold: true }); unir(2, 8, cuando, { fill: GRIS, size: 9 }); unir(9, 12, rep, { fill: GRIS, size: 9 }); }
  // Alto según el largo del texto (unas 170 letras por línea), para que no se corte
  for (const t of REGLAS) parrafo('• ' + t, { alto: Math.max(26, Math.ceil((t.length + 2) / 170) * 13 + 4) });

  // Claves para la importación (hoja oculta)
  const app = wb.addWorksheet(HOJA_APP, { state: 'veryHidden' });
  [['ficha_verificacion', VERSION_FICHA], ['proyecto_id', F.proyecto.id || ''], ['cod_local', L.cod], ['region', L.region], ['anio_datos', F.anio || ''], ['n_aulas', F.aulas.length], ['generada', F.fecha]]
    .forEach(([k, v], j) => { app.getCell(j + 1, 1).value = k; app.getCell(j + 1, 2).value = v; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── PDF (pdfkit) ───────────────────────────────────────────────────────────
// Números de aula en tramos: [1,2,3,5] → «1 a 3, 5»
const tramos = ns => {
  const out = [];
  for (const n of ns) { const t = out.at(-1); if (t && n === t[1] + 1) t[1] = n; else out.push([n, n]); }
  return out.map(([a, b]) => a === b ? `${a}` : b === a + 1 ? `${a}, ${b}` : `${a} a ${b}`).join(', ');
};
const fechaHoraPe = iso => iso ? new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const fechaPe = f => f ? String(f).slice(0, 10).split('-').reverse().join('/') : '';
// Fecha en Perú de un instante (un ISO en UTC puede caer en el día siguiente)
const fechaLima = iso => iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(iso)) : '';
const v = x => x == null ? '' : String(x);

/**
 * @param F      modeloFicha del local
 * @param llena  (opcional) la ficha llenada en la app:
 *   { datos (limpiarFormulario), estado, por, enviada_en, revisada_en,
 *     fotos: [{ n, lugar, muestra, tomada_en, lat, lon, buffer? }],
 *     firmas: { director|ugel|registradora: { buffer, firmada_en } } }
 */
export function generarFichaPdf(F, llena = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 30, bottom: 36, left: 28, right: 28 }, bufferPages: true,
      info: { Title: `Ficha de verificación — local ${F.local.cod}`, Author: 'Radar Ibero — Selector IOARR' } });
    const partes = [];
    doc.on('data', b => partes.push(b)); doc.on('end', () => resolve(Buffer.concat(partes))); doc.on('error', reject);
    const X0 = doc.page.margins.left, ANCHO = doc.page.width - X0 - doc.page.margins.right;
    const limite = () => doc.page.height - doc.page.margins.bottom;
    const texto = (t, o = {}) => {
      doc.font(o.bold ? 'Helvetica-Bold' : o.italic ? 'Helvetica-Oblique' : 'Helvetica').fontSize(o.size || 9).fillColor(o.color || '#16181D');
      const h = doc.heightOfString(String(t), { width: ANCHO });
      if (doc.y + h > limite()) doc.addPage();
      doc.text(String(t), X0, doc.y, { width: ANCHO }); doc.moveDown(o.despues ?? 0.3);
    };
    const titulo = t => { if (doc.y + 60 > limite()) doc.addPage(); doc.moveDown(0.4); texto(t, { bold: true, size: 12, color: '#3A63E0', despues: 0.25 }); };
    // Tabla: anchos en fracciones; filas = [{ v: [..], fill: [..], bold }]
    const tabla = (anchos, cabecera, filas, o = {}) => {
      const W = anchos.map(a => a * ANCHO), PAD = 3, size = o.size || 8;
      const alto = (vals, bold, min) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
        return Math.max(min || o.minAlto || 14, ...vals.map((v, j) => doc.heightOfString(String(v ?? ''), { width: W[j] - 2 * PAD }) + 2 * PAD));
      };
      const dibujar = (vals, { fill, bold, cab, minAlto } = {}) => {
        const h = alto(vals, bold || cab, minAlto);
        if (doc.y + h > limite()) { doc.addPage(); if (!cab && cabecera) dibujar(cabecera, { cab: true }); }
        let x = X0; const y = doc.y;
        vals.forEach((v, j) => {
          const f = cab ? '#3A63E0' : Array.isArray(fill) ? fill[j] : fill;
          if (f) doc.rect(x, y, W[j], h).fill(f);
          doc.rect(x, y, W[j], h).lineWidth(0.5).strokeColor('#C9CED8').stroke();
          doc.font(bold || cab ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(cab ? '#FFFFFF' : '#16181D')
            .text(String(v ?? ''), x + PAD, y + PAD, { width: W[j] - 2 * PAD, align: typeof v === 'number' ? 'right' : 'left' });
          x += W[j];
        });
        doc.x = X0; doc.y = y + h;
      };
      if (cabecera) dibujar(cabecera, { cab: true });
      for (const f of filas) dibujar(f.v, f);
      doc.moveDown(0.4);
    };
    const G = '#EEF0F4', A = '#FFF8DC', L = F.local;
    const d = llena?.datos || null, da = d?.a || {};
    const ESTADO = { borrador: 'borrador, aún sin enviar', enviada: 'enviada a revisión', observada: 'devuelta para corregir', aprobada: 'aprobada' };

    texto('Ficha de verificación de mobiliario escolar — IOARR de reposición', { bold: true, size: 15, despues: 0.1 });
    texto(`Local ${L.cod} · ${L.nombre} · Proyecto «${F.proyecto.nombre}» · generada el ${F.fecha} con el Padrón ESCALE y el Censo Educativo ${F.anio || ''}${F.supervisor ? ` · Supervisor asignado: ${F.supervisor}` : ''}`, { size: 8, color: '#5C6270' });
    if (llena) texto(`Ficha llenada en la app${llena.por ? ' por ' + llena.por : ''} · ${ESTADO[llena.estado] || llena.estado || ''}${llena.enviada_en ? ' · enviada el ' + fechaHoraPe(llena.enviada_en) : ''}${llena.estado === 'aprobada' && llena.revisada_en ? ' · aprobada el ' + fechaHoraPe(llena.revisada_en) : ''}. Lo gris viene del padrón y del censo; lo amarillo se llenó en campo.`, { italic: true, size: 8, color: '#5C6270' });
    else texto('Lo gris lo llenó la app; lo amarillo se llena en campo. Para cargar los datos en la app, usa el Excel de esta misma ficha.', { italic: true, size: 8, color: '#5C6270' });

    titulo('A. Datos del local educativo');
    tabla([0.3, 0.45, 0.25], ['Campo', 'Valor', 'Origen'], [
      ['Código de local', L.cod, 'Padrón (app)'], ['Región / provincia / distrito', `${L.region} / ${L.prov} / ${L.dist}`, 'Padrón (app)'], ['UGEL', L.ugel, 'Padrón (app)'],
      ['Centro poblado y área', `${L.cp} · ${L.rural ? 'rural' : 'urbana'}`, 'Padrón (app)'], ['Dirección', L.direccion, 'Padrón (app)'],
      ['Coordenadas (latitud, longitud)', d?.a?.coord || (L.lat != null ? `${L.lat}, ${L.lon}` : ''), d && da.coord && da.coord !== `${L.lat}, ${L.lon}` ? 'Campo (GPS)' : 'Padrón (app); se corrigen con GPS si difieren'],
    ].map(v => ({ v, fill: [G, G, G] })).concat([['Fecha de la verificación', fechaPe(da.fecha), 'Campo'], ['Verificador: nombre, cargo y DNI', v(da.verificador), 'Campo'], ['Persona de la IE que acompañó: nombre y cargo', v(da.acompanante), 'Campo']]
      .map(v => ({ v, fill: [G, A, G], minAlto: d ? 14 : 20 }))), { minAlto: 14 });

    titulo('B. Servicios educativos del local');
    tabla([0.1, 0.3, 0.11, 0.09, 0.1, 0.1, 0.1, 0.1], ['Código modular', 'Institución', 'Nivel', 'Turno', 'Secciones (padrón)', 'Estudiantes (padrón)', 'Estudiantes verificados', 'Observación'],
      F.servicios.map(s => ({ v: [s.modular, s.nombre, s.nombreNivel, s.turno, s.secciones, s.est, v(d?.servicios?.[s.modular]?.est), v(d?.servicios?.[s.modular]?.obs)], fill: [G, G, G, G, G, G, A, A] })), { minAlto: d ? 14 : 18 });

    titulo('C. Verificación del mobiliario por aula');
    texto(`${F.aulas.length} ${F.aulas.length === 1 ? 'aula' : 'aulas'} en uso según el censo, con sus cantidades ya cargadas (la mesa, en puestos). ${NOTA_SIGLAS}`, { size: 8, color: '#5C6270' });
    const anchosC = [0.13, 0.06, 0.06, 0.06, 0.07, 0.07, 0.07, 0.07, 0.08, 0.09, 0.09, 0.15];
    if (d) {
      // Ficha llena: las aulas con datos, con lo contado; las demás en una línea (siguen con el censo)
      const conDatos = F.aulas.filter(a => d.aulas?.[a.j]), sin = F.aulas.filter(a => !d.aulas?.[a.j]).map(a => a.j + 1);
      for (const a of conDatos) {
        const x = d.aulas[a.j];
        if (doc.y + 120 > limite()) doc.addPage();
        texto(`${textoAula(a, F.aulas.length)} · estudiantes verificados: ${x.est == null || x.est === '' ? '—' : x.est}`, { bold: true, size: 8, despues: 0.15 });
        const filas = [];
        for (const b of bienesDe(F)) {
          const c = a.censo[b.k], fs = (x.filas || []).filter(f => f.k === b.k);
          if (!fs.length) { filas.push({ v: [b.n, c.b, c.r, c.m, '', '', '', b.k === 'mesa' ? '' : '—', '', '', '', 'Sin contar: sigue el censo'], fill: [G, G, G, G, A, A, A, G, A, A, A, A] }); continue; }
          fs.forEach((f, i) => filas.push({ v: [b.n + (i ? ' (otro tipo)' : b.k === 'mesa' ? ' (censo en puestos)' : ''), i ? '' : c.b, i ? '' : c.r, i ? '' : c.m, v(f.b), v(f.r), v(f.m), b.k === 'mesa' ? v(f.puestos) || '1' : '—', v(f.antig), v(f.patrimonial), v(f.baja), v(f.obs)],
            fill: [G, G, G, G, A, A, A, b.k === 'mesa' ? A : G, A, A, A, A] }));
        }
        tabla(anchosC, CAB_C, filas, { size: 7 });
      }
      if (sin.length) texto(`${sin.length === F.aulas.length ? 'Ninguna aula verificada' : `Aulas sin verificar: ${tramos(sin)}`}. Siguen con las cantidades del censo.`, { size: 8, color: '#5C6270' });
    }
    for (const a of d ? [] : F.aulas) {
      if (doc.y + 120 > limite()) doc.addPage();
      texto(`${textoAula(a, F.aulas.length)} · estudiantes verificados: ______`, { bold: true, size: 8, despues: 0.15 });
      tabla(anchosC, CAB_C, bienesDe(F).map(b => {
        const c = a.censo[b.k];
        return { v: [b.n + (b.k === 'mesa' ? ' (censo en puestos)' : ''), c.b, c.r, c.m, '', '', '', b.k === 'mesa' ? '' : '—', '', '', '', ''], fill: [G, G, G, G, A, A, A, b.k === 'mesa' ? A : G, A, A, A, A], minAlto: 17 };
      }), { size: 7 });
    }
    if (!F.aulas.length) texto('El censo no registra aulas en este local: anota el mobiliario en la sección D o en las observaciones.');

    titulo('D. Mobiliario fuera de aulas y panel fotográfico');
    texto('El censo solo cubre las aulas. Estos ambientes (dirección, sala de docentes, biblioteca, laboratorio, AIP, comedor) se anotan solo si el proyecto los incluye.', { size: 8, color: '#5C6270' });
    const fuera = d ? (d.fuera || []).map(f => ({ v: [v(f.ambiente), v(f.bien), v(f.b), v(f.r), v(f.m), v(f.antig), v(f.obs)], fill: A })) : Array.from({ length: 5 }, () => ({ v: Array(7).fill(''), fill: A, minAlto: 18 }));
    if (d && !fuera.length) texto('Sin mobiliario fuera de aulas anotado.', { size: 8 });
    else tabla([0.16, 0.16, 0.08, 0.08, 0.08, 0.12, 0.32], ['Ambiente', 'Bien', 'Bueno', 'Regular', 'Malo', 'Antigüedad (años o rango)', 'Observación'], fuera);
    texto('Panel fotográfico mínimo: fachada con el letrero, una vista general de cada tipo de aula y un detalle de cada tipo de mueble en mal estado. Cada foto lleva fecha, código de local y aula.', { size: 8, color: '#5C6270' });
    if (d) {
      const fotos = llena.fotos || [];
      if (!fotos.length) texto('Sin fotos tomadas en la app.', { size: 8 });
      else {
        tabla([0.06, 0.3, 0.3, 0.34], ['N.°', 'Ambiente o aula', 'Qué muestra', 'Fecha y coordenadas'],
          fotos.map(f => ({ v: [f.n, f.lugar, v(f.muestra), `${fechaHoraPe(f.tomada_en)}${f.lat != null ? ` · ${Number(f.lat).toFixed(5)}, ${Number(f.lon).toFixed(5)}` : ''}`], fill: [G, A, A, A] })));
        // Las fotos, de a tres por fila
        const COL = 3, GAP = 10, w = (ANCHO - GAP * (COL - 1)) / COL, h = w * 0.75, pie = 12;
        for (let i = 0; i < fotos.length; i += COL) {
          if (doc.y + h + pie > limite()) doc.addPage();
          const y = doc.y;
          fotos.slice(i, i + COL).forEach((f, c) => {
            const x = X0 + c * (w + GAP);
            doc.rect(x, y, w, h).fill('#EEF0F4');
            if (f.buffer) { try { doc.image(f.buffer, x, y, { fit: [w, h], align: 'center', valign: 'center' }); } catch { /* formato que pdfkit no lee */ } }
            doc.font('Helvetica').fontSize(7).fillColor('#5C6270').text(`Foto ${f.n} · ${f.lugar}`, x, y + h + 2, { width: w, lineBreak: false, ellipsis: true });
          });
          doc.x = X0; doc.y = y + h + pie + 6;
        }
      }
    } else tabla([0.06, 0.3, 0.34, 0.3], ['N.°', 'Ambiente o aula', 'Qué muestra', 'Archivo'],
      Array.from({ length: 6 }, (_, k) => ({ v: [k + 1, k ? '' : 'Fachada', k ? '' : 'Local y letrero', ''], fill: [G, A, A, A], minAlto: 16 })));

    titulo('E. Observaciones y conformidad');
    tabla([1], null, [{ v: ['Observaciones del verificador:' + (d?.obs ? ' ' + d.obs : '')], fill: A, minAlto: d ? 30 : 70 }]);
    texto('Declaración: las cantidades, estados y antigüedades de esta ficha corresponden a lo constatado en el local en la fecha indicada.', { size: 8 });
    if (d) {
      // Firmas en pantalla: la imagen va en su celda, con la fecha y hora en que se firmó
      const anchos = [0.24, 0.26, 0.1, 0.28, 0.12].map(a => a * ANCHO), H = 58;
      tabla([0.24, 0.26, 0.1, 0.28, 0.12], ['Cargo', 'Nombres y apellidos', 'DNI', 'Firma', 'Fecha'], []);
      doc.moveUp(0.4);
      for (const [k, cargo] of FIRMAS) {
        const f = d.firmas?.[k] || {}, img = llena.firmas?.[k];
        if (doc.y + H > limite()) doc.addPage();
        const y = doc.y; let x = X0;
        const celdas = [cargo, v(f.nombre), v(f.dni), '', fechaPe(f.fecha) || (img ? fechaPe(fechaLima(img.firmada_en)) : '')];
        celdas.forEach((t, j) => {
          doc.rect(x, y, anchos[j], H).fill(j ? A : G);
          doc.rect(x, y, anchos[j], H).lineWidth(0.5).strokeColor('#C9CED8').stroke();
          doc.font('Helvetica').fontSize(8).fillColor('#16181D').text(t, x + 3, y + 3, { width: anchos[j] - 6 });
          if (j === 3) {
            if (img?.buffer) { try { doc.image(img.buffer, x + 4, y + 3, { fit: [anchos[j] - 8, H - 16], align: 'center', valign: 'center' }); } catch { /* imagen no válida */ } }
            doc.font('Helvetica').fontSize(6).fillColor('#5C6270').text(img ? `Firmado en pantalla el ${fechaHoraPe(img.firmada_en)}` : 'Sin firma en pantalla', x + 3, y + H - 10, { width: anchos[j] - 6, lineBreak: false });
          }
          x += anchos[j];
        });
        doc.x = X0; doc.y = y + H;
      }
      doc.moveDown(0.4);
    } else tabla([0.28, 0.28, 0.12, 0.2, 0.12], ['Cargo', 'Nombres y apellidos', 'DNI', 'Firma y sello', 'Fecha'],
      FIRMAS.map(([, cargo]) => ({ v: [cargo, '', '', '', ''], fill: [G, A, A, A, A], minAlto: 40 })));

    titulo('Criterios de estado y reglas de llenado');
    tabla([0.12, 0.5, 0.38], ['Estado', 'Cuándo se marca', 'Entra a reponer'], CRITERIOS.map(v => ({ v, fill: G })));
    for (const t of llena ? REGLAS.filter(r => !/celdas grises/.test(r)) : REGLAS) texto('• ' + t, { size: 8, despues: 0.15 });

    const n = doc.bufferedPageRange().count;
    for (let k = 0; k < n; k++) {
      doc.switchToPage(k);
      const y = doc.page.height - 24, mb = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7).fillColor('#5C6270').text(`Local ${L.cod} · Ficha de verificación${llena ? ' llenada en la app' : ''} · Página ${k + 1} de ${n}`, X0, y, { width: ANCHO, align: 'right', lineBreak: false });
      doc.page.margins.bottom = mb;
    }
    doc.end();
  });
}

// ─── Lectura del Excel devuelto ─────────────────────────────────────────────
function valor(c) {
  let v = c?.value;
  if (v == null) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join('');
    else if ('text' in v) v = v.text;
    else return null;
  }
  if (typeof v === 'string') { v = v.trim(); return v === '' ? null : v; }
  return v ?? null;
}
const cadena = v => v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();

/**
 * Lee una ficha llenada. No valida contra el proyecto (eso lo hace procesarFicha).
 * @returns { meta, a, servicios, aulas: { [j]: { fila, est, filas: [...] } }, fuera, fotos, firmas, obs, error? }
 */
export async function leerFicha(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { return { error: 'No es un archivo de Excel válido (.xlsx).' }; }
  const app = wb.getWorksheet(HOJA_APP), ws = wb.getWorksheet(HOJA);
  if (!app || !ws || valor(app.getCell(1, 1)) !== 'ficha_verificacion') return { error: 'No es una ficha de verificación generada por la app (falta su hoja de claves). Descarga la ficha del local desde Expediente → Fichas y llénala.' };
  const meta = {};
  for (let k = 1; k <= 20; k++) { const c = valor(app.getCell(k, 1)); if (c) meta[c] = valor(app.getCell(k, 2)); }
  const out = { meta: { version: Number(meta.ficha_verificacion), proyecto_id: cadena(meta.proyecto_id), cod_local: cadena(meta.cod_local), region: cadena(meta.region), anio_datos: Number(meta.anio_datos) || null, n_aulas: Number(meta.n_aulas) }, a: {}, servicios: [], aulas: {}, fuera: [], fotos: [], firmas: {}, obs: null };
  let aula = null;   // aula en curso: las filas de bienes sin clave (agregadas a mano) van a esta aula
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const clave = cadena(valor(row.getCell(COL_CLAVE)));
    const v = c => valor(row.getCell(c));
    if (clave.startsWith('A|')) { out.a[clave.slice(2)] = { v: v(2), fila: n }; return; }
    if (clave.startsWith('B|')) { out.servicios.push({ modular: clave.slice(2), est: v(9), obs: v(10), fila: n }); return; }
    if (clave.startsWith('AULA|')) { const j = Number(clave.slice(5)); aula = out.aulas[j] = { j, fila: n, est: v(12), filas: [] }; return; }
    if (clave === 'CAB') return;
    // Un título de sección cierra el aula en curso
    if (!clave && typeof v(1) === 'string' && /^[A-E]\. /.test(v(1))) { aula = null; return; }
    let k = clave.startsWith('ITEM|') ? clave.slice(5) : null;
    // Fila agregada a mano dentro de un aula (sin clave): se reconoce por el nombre del bien
    if (!k && aula && !clave && typeof v(1) === 'string') k = tipoDesdeDescripcion(v(1));
    if (k && aula && TIPOS.includes(k)) {
      aula.filas.push({ k, fila: n, b: v(5), r: v(6), m: v(7), puestos: v(8), antig: v(9), patrimonial: v(10), baja: v(11), obs: v(12) });
      return;
    }
    if (clave) aula = null;
    if (clave === 'FUERA') { const x = { fila: n, ambiente: v(1), bien: v(2), b: v(4), r: v(5), m: v(6), antig: v(7), obs: v(8) }; if ([x.ambiente, x.bien, x.b, x.r, x.m, x.antig, x.obs].some(y => !vacio(y))) out.fuera.push(x); return; }
    if (clave === 'FOTO') {
      const x = { fila: n, n: v(1), ambiente: v(2), muestra: v(5), archivo: v(9) };
      const porDefecto = x.ambiente === 'Fachada' && x.muestra === 'Local y letrero';
      if (!vacio(x.archivo) || (!porDefecto && (!vacio(x.ambiente) || !vacio(x.muestra)))) out.fotos.push(x);
      return;
    }
    if (clave === 'E|obs') { out.obs = v(1); return; }
    if (clave.startsWith('FIRMA|')) { out.firmas[clave.slice(6)] = { nombre: v(2), dni: v(6), fecha: v(11), fila: n }; return; }
  });
  return out;
}

// ─── Validación e inventario a guardar ──────────────────────────────────────
// Número entero ≥ 0 (acepta «12» o 12); null si está vacío; NaN si no es válido
function enteroNoNeg(v) {
  if (vacio(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isInteger(n) && n >= 0 && n <= 1e6 ? n : NaN;
}
// Antigüedad: años (0 a 100) o un rango → { anios, estimada, texto } | null | { error }
export function leerAntiguedad(v) {
  if (vacio(v)) return null;
  if (typeof v === 'number' || /^\d+([.,]\d+)?$/.test(String(v).trim())) {
    const n = Number(String(v).replace(',', '.'));
    return n >= 0 && n <= 100 ? { anios: Math.round(n), estimada: false, texto: String(v) } : { error: 'La antigüedad debe estar entre 0 y 100 años' };
  }
  const t = norm(v).replace(/\s*anos?$/, '');
  const r = RANGOS.find(x => x.re.test(t));
  return r ? { anios: r.anios, estimada: true, rango: r.clave, texto: r.texto } : { error: `Antigüedad no válida («${v}»): escribe los años o un rango: Menos de 5, De 5 a 10 o Más de 10` };
}
function leerBaja(v) {
  if (vacio(v)) return null;
  const t = norm(v);
  if (/^(si|sí)$/.test(t)) return 'si';
  if (t === 'no') return 'no';
  if (/^en tramite/.test(t)) return 'en_tramite';
  return undefined;
}
// Fecha de la visita: Date de Excel, AAAA-MM-DD o DD/MM/AAAA
function leerFecha(v) {
  if (vacio(v)) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return isNaN(Date.parse(s)) ? undefined : s;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) { const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; const d = new Date(iso + 'T00:00:00Z'); return !isNaN(d) && d.getUTCDate() === Number(m[1]) ? iso : undefined; }
  return undefined;
}
const corto = (v, max = 300) => vacio(v) ? null : cadena(v).replace(/\s+/g, ' ').slice(0, max);

/**
 * Valida una ficha leída y arma lo que se guarda en ioarr_expediente_inventario.
 * @param x        resultado de leerFicha
 * @param ctx      { D, C, P, codigos: Set de códigos del proyecto, proyectoId, anioDatos, hoy, archivo, filaPrevia }
 *                 C = calc(D, P) (el censo por aula con los criterios del proyecto)
 * @returns { cod, errores: [{ hoja, fila, motivo }], avisos: [...], rechazada, filas: { ok, rechazadas }, fila? }
 */
export function procesarFicha(x, { D, C, codigos, proyectoId, anioDatos, hoy, archivo, filaPrevia }) {
  const errores = [], avisos = [];
  const err = (fila, motivo) => errores.push({ hoja: fila ? HOJA : '—', fila: fila || null, motivo });
  const avi = (fila, motivo) => avisos.push({ hoja: HOJA, fila: fila || null, motivo });
  const rechazo = motivo => ({ cod: x.meta?.cod_local || null, errores: [...errores, { hoja: '—', fila: null, motivo }], avisos, rechazada: true, filas: { ok: 0, rechazadas: 0 } });
  if (x.error) return rechazo(x.error);
  const M = x.meta, cod = M.cod_local;
  if (M.version > VERSION_FICHA) return rechazo('La ficha es de una versión más nueva de la app.');
  if (!codigos.has(cod)) return rechazo(`El código de local ${cod || '(vacío)'} no está en el proyecto. Descarga la ficha desde este proyecto o agrega el local en Mi selección.`);
  const i = D.locs.findIndex(l => l[0] === cod);
  if (i < 0) return rechazo(`El local ${cod} no está en los datos de la región del proyecto.`);
  if (M.anio_datos && anioDatos && M.anio_datos !== anioDatos) return rechazo(`La ficha se generó con el censo ${M.anio_datos} y el proyecto usa el ${anioDatos}: descarga la ficha otra vez.`);
  const aulasLoc = D.locAul[i];
  if (M.n_aulas !== aulasLoc.length) return rechazo(`La ficha tiene ${M.n_aulas} aulas y el censo del local tiene ${aulasLoc.length}: descarga la ficha otra vez.`);
  if (M.proyecto_id && proyectoId && M.proyecto_id !== proyectoId) avi(null, 'La ficha se descargó de otro proyecto con el mismo local; se importa en este.');

  // A. Fecha (obligatoria), verificador, acompañante, coordenadas
  const fA = x.a.fecha?.fila;
  const fecha = leerFecha(x.a.fecha?.v);
  if (fecha === null) return rechazo(`Falta la fecha de la verificación (sección A${fA ? ', fila ' + fA : ''}).`);
  if (fecha === undefined) return rechazo(`La fecha de la verificación no es válida (sección A${fA ? ', fila ' + fA : ''}): usa dd/mm/aaaa.`);
  if (fecha > hoy) return rechazo(`La fecha de la verificación (${fecha.split('-').reverse().join('/')}) es futura.`);
  const anioVisita = Number(fecha.slice(0, 4));
  let coord = null;
  const cTxt = cadena(x.a.coord?.v), l = D.locs[i];
  if (cTxt && cTxt !== (l[6] != null ? `${l[6]}, ${l[7]}` : '')) {
    const m = cTxt.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m && Number(m[1]) >= -19 && Number(m[1]) <= 0 && Number(m[2]) >= -82 && Number(m[2]) <= -68) coord = { lat: Number(m[1]), lon: Number(m[2]) };
    else avi(x.a.coord?.fila, `Coordenadas no válidas («${cTxt}»): usa «latitud, longitud» en grados decimales. Se ignoran.`);
  }

  // B. Estudiantes verificados por servicio
  const modulares = new Set(D.locSvc[i].map(si => D.svcs[si][0]));
  const servicios = {};
  for (const s of x.servicios) {
    if (!modulares.has(s.modular)) { err(s.fila, `El código modular ${s.modular} no es de este local.`); continue; }
    const n = enteroNoNeg(s.est);
    if (Number.isNaN(n)) err(s.fila, 'Estudiantes verificados: usa un número entero de 0 o más.');
    else if (n != null || !vacio(s.obs)) servicios[s.modular] = { est: n, obs: corto(s.obs) };
  }

  // C. Filas por aula
  let ok = 0, rechazadas = 0;
  const aulas = {};
  for (const [jTxt, a] of Object.entries(x.aulas)) {
    const j = Number(jTxt);
    if (!Number.isInteger(j) || j < 0 || j >= aulasLoc.length) { err(a.fila, 'Aula desconocida: no borres ni cambies las celdas grises.'); continue; }
    const ai = aulasLoc[j], nivel = D.svcs[D.aulas[ai][1]][2];
    const est = enteroNoNeg(a.est);
    if (Number.isNaN(est)) err(a.fila, 'Estudiantes verificados del aula: usa un número entero de 0 o más.');
    const filas = [];
    for (const f of a.filas) {
      const q = [f.b, f.r, f.m].map(enteroNoNeg), llenos = q.filter(n => n != null).length;
      const motivos = [];
      if (llenos && llenos < 3) motivos.push('llena los tres estados verificados (Bueno, Regular y Malo; 0 si no hay)');
      if (q.some(n => Number.isNaN(n))) motivos.push('las cantidades verificadas deben ser números enteros de 0 o más');
      let puestos = 1;
      if (!vacio(f.puestos)) {
        const p = enteroNoNeg(f.puestos);
        if (f.k !== 'mesa') { if (p !== 1) avi(f.fila, `«Puestos por unidad» solo aplica a las mesas; se ignora en ${NOMBRE_BIEN[f.k].toLowerCase()}.`); }
        else if (Number.isNaN(p) || p < 1 || p > MAX_PUESTOS) motivos.push(`puestos por unidad: de 1 a ${MAX_PUESTOS} (vacío = 1)`);
        else puestos = p;
      }
      const ant = leerAntiguedad(f.antig);
      if (ant?.error) motivos.push(ant.error.charAt(0).toLowerCase() + ant.error.slice(1));
      const baja = leerBaja(f.baja);
      if (baja === undefined) motivos.push(`estado de baja no válido («${f.baja}»): Sí, No o En trámite`);
      if (motivos.length) { err(f.fila, `${NOMBRE_BIEN[f.k]}: ${motivos.join('; ')}. La fila no se importa.`); rechazadas++; continue; }
      const contado = llenos === 3;
      const fila = { k: f.k, fila: f.fila, ...(contado ? { b: q[0] * puestos, r: q[1] * puestos, m: q[2] * puestos, unidades: q[0] + q[1] + q[2], puestos } : {}),
        ...(ant ? { antig: ant.anios, estimada: ant.estimada, antig_texto: ant.texto } : {}), patrimonial: corto(f.patrimonial, 500), baja, obs: corto(f.obs, 500) };
      if (contado || ant || fila.patrimonial || baja || fila.obs) { filas.push(fila); if (contado) ok++; }
    }
    // Aviso del 15 %: por aula y bien, lo contado frente al censo
    for (const k of TIPOS) {
      const fk = filas.filter(f => f.k === k && f.b != null);
      if (!fk.length) continue;
      const t = TIPOS.indexOf(k), cen = C.A.b[t][ai] + C.A.r[t][ai] + C.A.m[t][ai], ver = fk.reduce((s, f) => s + f.b + f.r + f.m, 0);
      const dif = cen ? Math.abs(ver - cen) / cen : ver ? 1 : 0;
      if (dif > TOLERANCIA && !fk.some(f => f.obs))
        avi(fk[0].fila, `${NOMBRE_BIEN[k]} (aula ${j + 1}): lo contado (${ent(ver)}${k === 'mesa' ? ' puestos' : ''}) difiere del censo (${ent(cen)}) en más de 15 % y no hay observación. Explica la causa.`);
    }
    if (filas.length || est != null) aulas[j] = { nivel, est: Number.isNaN(est) ? null : est, filas };
  }

  // D. Fuera de aulas (informativo)
  const fuera = [];
  for (const f of x.fuera) {
    const q = [f.b, f.r, f.m].map(enteroNoNeg), ant = leerAntiguedad(f.antig);
    if (q.some(n => Number.isNaN(n)) || ant?.error) { err(f.fila, 'Mobiliario fuera de aulas: las cantidades deben ser enteros de 0 o más y la antigüedad, años o un rango. La fila no se importa.'); continue; }
    fuera.push({ ambiente: corto(f.ambiente, 120), bien: corto(f.bien, 120), b: q[0], r: q[1], m: q[2], antig: ant?.anios ?? null, estimada: !!ant?.estimada, obs: corto(f.obs, 500) });
  }
  if (fuera.length) avi(null, 'El mobiliario fuera de aulas se guarda como información: no entra al costo (está por confirmar si el proyecto lo incluye).');

  if (!ok) return { cod, ...rechazo('La ficha no tiene ninguna fila con cantidades verificadas válidas (Bueno, Regular y Malo).'), avisos, filas: { ok, rechazadas } };

  // ── Lo que se guarda: por nivel y tipo, lo verificado reemplaza al censo en las aulas verificadas ──
  const niveles = nivelesDeLocal(D, i), varios = niveles.length > 1;
  const resumen = {};   // { nivel: { k: { b, r, m, mv, mc, aulas_v, aulas } } }
  const adq = {};       // { nivel: { k: { suma, peso, estimada } } }
  for (const [j, ai] of aulasLoc.entries()) {
    const nivel = D.svcs[D.aulas[ai][1]][2], ax = aulas[j];
    for (const [t, k] of TIPOS.entries()) {
      const o = ((resumen[nivel] ??= {})[k] ??= { b: 0, r: 0, m: 0, mv: 0, mc: 0, aulas_v: 0, aulas: 0, verificado: false });
      const fk = ax?.filas.filter(f => f.k === k && f.b != null) || [];
      o.aulas++;
      if (fk.length) {
        o.verificado = true; o.aulas_v++;
        for (const f of fk) { o.b += f.b; o.r += f.r; o.m += f.m; o.mv += f.m; }
      } else { o.b += C.A.b[t][ai]; o.r += C.A.r[t][ai]; o.m += C.A.m[t][ai]; o.mc += C.A.m[t][ai]; }
      for (const f of ax?.filas.filter(f => f.k === k && f.antig != null) || []) {
        const w = f.m || 1, z = ((adq[nivel] ??= {})[k] ??= { suma: 0, peso: 0, estimada: false });
        z.suma += (anioVisita - f.antig) * w; z.peso += w; z.estimada ||= f.estimada;
      }
    }
  }
  const bienesDe = n => Object.fromEntries(Object.entries(resumen[n] || {}).filter(([, o]) => o.verificado).map(([k, o]) => [k, { b: o.b, r: o.r, m: o.m }]));
  const adqDe = n => Object.fromEntries(Object.entries(adq[n] || {}).map(([k, z]) => [k, Math.max(1950, Math.min(anioVisita, Math.round(z.suma / z.peso)))]));
  const estimadaDe = n => Object.entries(adq[n] || {}).filter(([, z]) => z.estimada).map(([k]) => k);
  const verifDe = n => Object.fromEntries(Object.entries(resumen[n] || {}).filter(([, o]) => o.verificado).map(([k, o]) => [k, { b: o.b, r: o.r, m: o.m, mv: o.mv, mc: o.mc, aulas_v: o.aulas_v, aulas: o.aulas }]));
  // Todo el local (para la IOARR única): suma de los niveles
  const verifLocal = {};
  for (const n of niveles) for (const [k, o] of Object.entries(resumen[n] || {})) {
    const z = (verifLocal[k] ??= { b: 0, r: 0, m: 0, mv: 0, mc: 0, aulas_v: 0, aulas: 0, verificado: false });
    for (const c of ['b', 'r', 'm', 'mv', 'mc', 'aulas_v', 'aulas']) z[c] += o[c];
    z.verificado ||= o.verificado;
  }
  const verif = { _: Object.fromEntries(Object.entries(verifLocal).filter(([, o]) => o.verificado).map(([k, { verificado: _, ...o }]) => [k, o])) };
  if (varios) for (const n of niveles) verif[n] = verifDe(n);

  const previa = filaPrevia || {};
  const n0 = niveles[0];
  const bienes = varios ? {} : bienesDe(n0);
  const adquisicion = varios ? { ...(previa.adquisicion || {}) } : { ...(previa.adquisicion || {}), ...adqDe(n0) };
  const por_nivel = varios ? Object.fromEntries(niveles.map(n => [n, {
    bienes: bienesDe(n), adquisicion: { ...(previa.por_nivel?.[n]?.adquisicion || {}), ...adqDe(n) }
  }]).filter(([, v]) => Object.keys(v.bienes).length || Object.keys(v.adquisicion).length)) : {};
  const verificador = corto(x.a.verificador?.v, 200), acompanante = corto(x.a.acompanante?.v, 200), obs = corto(x.obs, 1000);
  const firmas = Object.fromEntries(FIRMAS.map(([k]) => [k, x.firmas[k]]).filter(([, f]) => f && (f.nombre || f.dni)).map(([k, f]) => [k, { nombre: corto(f.nombre, 200), dni: corto(f.dni, 20), fecha: leerFecha(f.fecha) || null }]));
  const estimadas = Object.fromEntries((varios ? niveles : ['_']).map(n => [n, estimadaDe(varios ? n : n0)]).filter(([, v]) => v.length));
  const ficha = {
    version: VERSION_FICHA, archivo: String(archivo || '').slice(0, 200), importado_en: new Date().toISOString(), fecha, verificador, acompanante, coord,
    servicios, aulas, fuera, fotos: x.fotos.filter(f => !vacio(f.archivo) || !vacio(f.muestra)).map(f => ({ n: f.n, ambiente: corto(f.ambiente, 120), muestra: corto(f.muestra, 200), archivo: corto(f.archivo, 200) })),
    firmas, observaciones: obs, verif, adq_estimada: estimadas,
    filas: { ok, rechazadas }
  };
  const fila = {
    bienes, adquisicion, por_nivel, fecha_visita: fecha, responsable: verificador,
    observacion: obs || `Ficha de verificación importada (${ficha.archivo || 'Excel'})${verificador ? ', verificador: ' + verificador : ''}.`,
    ficha
  };
  return { cod, i, errores, avisos, rechazada: false, filas: { ok, rechazadas }, fila };
}

// ─── Lo verificado frente al censo, para costos y documentos ─────────────────
/**
 * Lo que vino de la ficha para un nivel ('_' = todo el local), solo si las
 * cantidades guardadas siguen siendo las de la ficha (una corrección a mano
 * posterior cuenta como verificada en su totalidad).
 * @returns { [k]: { mv, mc } } con mv = Malo verificado en campo, mc = Malo del censo (aulas sin verificar)
 */
export function verifFicha(fila, clave, bienes) {
  const v = fila?.ficha?.verif?.[clave];
  if (!v) return null;
  const out = {};
  for (const [k, o] of Object.entries(v)) {
    const x = bienes?.[k];
    if (x && x.b === o.b && x.r === o.r && x.m === o.m) out[k] = { mv: o.mv, mc: o.mc };
  }
  return out;
}

/**
 * Requerido de mesas y sillas con los estudiantes verificados por aula (las aulas
 * sin dato usan el censo). Solo cambia el faltante, que es informativo.
 * @returns { _: { mesa, silla }, [nivel]: { mesa, silla } } | null
 */
export function requeridoFicha(fila, D, P, i) {
  const aulas = fila?.ficha?.aulas;
  if (!aulas || !Object.values(aulas).some(a => a.est != null)) return null;
  const out = { _: { mesa: 0, silla: 0 } };
  D.locAul[i].forEach((ai, j) => {
    const a = D.aulas[ai], n = D.svcs[a[1]][2], est = aulas[j]?.est ?? a[8];
    const o = (out[n] ??= { mesa: 0, silla: 0 });
    const mesa = Math.round(est * P.mesaEst), silla = Math.round(est * P.sillaEst);
    o.mesa += mesa; o.silla += silla; out._.mesa += mesa; out._.silla += silla;
  });
  return out;
}

// Estado del local para la lista de fichas
export const ESTADO_VERIF = { verificado: 'Verificado', solo_censo: 'Solo censo' };
