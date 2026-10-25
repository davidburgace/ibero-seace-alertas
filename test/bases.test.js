// Generador de bases OxI: marcadores, documento equivalente, montos, validaciones y .docx de ejemplo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  PLANTILLAS, MANIFEST, DECLARADOS, CAMPOS, CAMPOS_FICHA, OBLIGATORIOS_DE, RESIDUOS_ORIGEN, DECLARACION,
  marcadoresDe, sustituir, sinComentario, armarTexto, limpiarFicha, validarFicha, calcularMontos, verificarTotal,
  montoEnLetras, compararFichas, revisarNeutralidad, valoresMarcadores, cuadroCantidades, precargar
} from '../src/selector-ioarr/bases.js';
import { ESPECIFICACIONES } from '../src/selector-ioarr/bases-especificaciones.js';
import { GOBIERNOS_REGIONALES, goreDe } from '../src/selector-ioarr/entidades-gore.js';
import { generarBasesDocx } from '../src/selector-ioarr/word-bases.js';
import { FICHA_PRUEBA, CTX_PRUEBA } from './helpers/ficha-bases.js';

const ficha = (cambios = {}) => limpiarFicha({ ...FICHA_PRUEBA, ...cambios });
const RE_MARCADOR = /\{\{[A-Z0-9_]+\}\}|(?<!\{)\{[A-Z][A-Z0-9_]*\}(?!\})/;
const textoDocx = async buf => {
  const z = await JSZip.loadAsync(buf);
  return (await z.file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
};

// ─── Marcadores ─────────────────────────────────────────────────────────────
test('plantillas: 20 archivos (00 a 19) en orden y todos sus marcadores declarados', () => {
  assert.equal(PLANTILLAS.length, 20);
  assert.deepEqual(PLANTILLAS.map(t => t.file.slice(0, 2)), Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0')));
  const noDeclarados = PLANTILLAS.flatMap(t => marcadoresDe(t.texto).filter(m => !DECLARADOS.has(m)).map(m => `${t.file}: ${m}`));
  assert.deepEqual(noDeclarados, [], 'marcadores que no están en el MANIFEST ni en el calendario');
  // Cada campo del MANIFEST tiene su lugar en la ficha
  assert.deepEqual(Object.keys(MANIFEST.campos).filter(k => !CAMPOS_FICHA.includes(k)), []);
});

test('sustitución: con la ficha completa no queda ningún marcador', () => {
  const A = armarTexto(ficha());
  assert.deepEqual(A.faltan, []);
  for (const b of A.bloques) assert.doesNotMatch(b.texto, RE_MARCADOR, b.file);
  assert.equal(A.bloques.length, 20);
  assert.match(A.bloques[0].texto, /Nombre de la Entidad Pública : Gobierno Regional de Prueba/);
  assert.match(A.bloques.at(-1).texto, /\| Convocatoria y publicación de Bases \| 01\/09\/2026 \|/);
  assert.match(A.bloques.at(-1).texto, /Del 02\/09\/2026 hasta 08\/09\/2026/);
});

test('sustitución: un dato que falta deja el marcador visible; un valor con llaves no crea marcadores', () => {
  const A = armarTexto(ficha({ ENTIDAD_RUC: '', DIRECCION_COMITE: 'Calle {{CUI}} {X}' }));
  assert.ok(A.faltan.includes('ENTIDAD_RUC'));
  assert.match(A.bloques[0].texto, /RUC N° : \{\{ENTIDAD_RUC\}\}/);
  assert.match(A.bloques.at(-1).texto, /Calle CUI X/);
  const s = sustituir('a {{X}} b {Y} c {{Z}}', { X: '1', Y: null });
  assert.equal(s.texto, 'a 1 b {Y} c {{Z}}');
  assert.deepEqual([...s.faltan].sort(), ['Y', 'Z']);
});

test('texto fijo: la Sección II y el Anexo 1 salen igual a la plantilla', () => {
  const A = armarTexto(ficha());
  for (const f of ['01_', '02_', '03_', '04_']) {
    const t = PLANTILLAS.find(x => x.file.startsWith(f));
    assert.equal(A.bloques.find(b => b.file === t.file).texto, sinComentario(t.texto), t.file);
  }
});

test('avisos «verificar»: visibles mientras no se confirmen; el de 1.5.1 siempre', () => {
  const sin = armarTexto(ficha({ VERIFICAR_REGLAMENTO_VIGENTE: false, VERIFICAR_VIGENCIA: false })).bloques[0].texto;
  assert.match(sin, /\[VERIFICAR: confirmar que el Decreto Supremo N° 038-2026-EF es el Reglamento vigente/);
  assert.match(sin, /\[VERIFICAR: confirmar con el MEF la vigencia de la RD/);
  const con = armarTexto(ficha({ VERIFICAR_REGLAMENTO_VIGENTE: true, VERIFICAR_VIGENCIA: true })).bloques[0].texto;
  assert.doesNotMatch(con, /\[VERIFICAR:/);
  assert.match(con, /\[VERIFICAR texto y artículos con el Reglamento vigente y la Entidad\]/);
});

test('nueva convocatoria: si no lo es, sus textos quedan «NO APLICA» y no se exigen', () => {
  const d = ficha({ nueva_convocatoria: false });
  assert.match(valoresMarcadores(d).CIRCULAR_DESIERTO, /^\[NO APLICA/);
  assert.ok(validarFicha(d, CTX_PRUEBA).ok);
  const v = validarFicha(ficha({ nueva_convocatoria: true }), CTX_PRUEBA);
  assert.ok(!v.ok);
  assert.ok(v.pendientes.includes('CIRCULAR_DESIERTO'));
});

// ─── Documento equivalente ──────────────────────────────────────────────────
test('documento equivalente: siempre en la tabla 1.5, en 1.5.1 y en el convenio; no hay opción para omitirlo', () => {
  const A = armarTexto(ficha({ incluir_doc_equivalente: false, sin_documento_equivalente: true }));
  const s1 = A.bloques[0].texto, conv = A.bloques.find(b => b.file.startsWith('18_')).texto;
  assert.match(s1, /\| Prestación N° 1: Elaboración de documento equivalente \[OBLIGATORIO\] \| 2,287\.50 \| 2,287\.50 \|/);
  assert.match(s1, /\| Prestación N° 3: Financiamiento de la supervisión del documento equivalente \[OBLIGATORIO\] \| 1,000\.25 \|/);
  assert.match(s1, /1\.5\.1\. DOCUMENTO EQUIVALENTE \(REQUISITO OBLIGATORIO\)/);
  assert.match(s1, /Plazo de elaboración del documento equivalente: 30 días calendario\. Plazo de ejecución física: 60 días calendario/);
  assert.ok((conv.match(/documento equivalente/gi) || []).length >= 20, 'cláusulas del convenio');
  // La ficha no tiene ningún campo para quitarlo
  assert.deepEqual(CAMPOS.filter(c => ['confirmacion', 'si_no', 'opcion'].includes(c.tipo) && /equivalente/i.test(c.k + c.etiqueta)).map(c => c.k), []);
  assert.equal(limpiarFicha({ incluir_doc_equivalente: false }).incluir_doc_equivalente, undefined);
});

test('documento equivalente: sin monto, supervisión o plazos no se puede generar', () => {
  assert.deepEqual(OBLIGATORIOS_DE, ['MONTO_DOC_EQUIVALENTE', 'MONTO_SUP_DOC_EQUIVALENTE', 'PLAZO_DOC_EQUIVALENTE_DIAS', 'PLAZO_EJECUCION_DIAS']);
  for (const k of OBLIGATORIOS_DE) {
    const v = validarFicha(ficha({ [k]: null }), CTX_PRUEBA);
    assert.ok(!v.ok, k);
    assert.ok(v.errores.some(e => e.k === k && /Documento equivalente \(obligatorio\)/.test(e.texto)), k);
  }
  for (const k of ['MONTO_DOC_EQUIVALENTE', 'MONTO_SUP_DOC_EQUIVALENTE']) {
    const v = validarFicha(ficha({ [k]: 0 }), CTX_PRUEBA);
    assert.ok(v.errores.some(e => e.k === k && /mayor que cero/.test(e.texto)), k);
  }
});

// ─── Montos ─────────────────────────────────────────────────────────────────
test('MONTO_TOTAL = documento equivalente + ejecución + supervisión del documento equivalente + supervisión de la ejecución', () => {
  const M = calcularMontos(ficha());
  assert.equal(M.total, 83300.15);
  assert.equal(M.total, Math.round((2287.5 + 76200 + 1000.25 + 3812.4) * 100) / 100);
  assert.equal(M.supervision, 4812.65);
  assert.ok(verificarTotal(ficha()));
  // Céntimos que en coma flotante no suman exacto
  const d = ficha({ MONTO_DOC_EQUIVALENTE: 0.1, MONTO_EJECUCION: 0.2, MONTO_SUP_DOC_EQUIVALENTE: 0.3, MONTO_SUP_EJECUCION: 0.4 });
  assert.equal(calcularMontos(d).total, 1);
  assert.ok(verificarTotal(d));
  // Falta uno → sin total
  assert.equal(calcularMontos(ficha({ MONTO_SUP_EJECUCION: null })).total, null);
  // En el texto
  const s1 = armarTexto(ficha()).bloques[0].texto;
  assert.match(s1, /S\/ 83,300\.15 \(OCHENTA Y TRES MIL TRESCIENTOS CON 15\/100 SOLES\)/);
  assert.match(s1, /\| \*\*Presupuesto total referencial\*\* \| \| \*\*83,300\.15\*\* \|/);
  // El total no se escribe a mano
  assert.equal(limpiarFicha({ MONTO_TOTAL: 1 }).MONTO_TOTAL, undefined);
});

test('monto en letras', () => {
  assert.equal(montoEnLetras(0), 'CERO CON 00/100 SOLES');
  assert.equal(montoEnLetras(100), 'CIEN CON 00/100 SOLES');
  assert.equal(montoEnLetras(121000), 'CIENTO VEINTIÚN MIL CON 00/100 SOLES');
  assert.equal(montoEnLetras(1234567.89), 'UN MILLÓN DOSCIENTOS TREINTA Y CUATRO MIL QUINIENTOS SESENTA Y SIETE CON 89/100 SOLES');
  assert.equal(montoEnLetras(31001000.05), 'TREINTA Y UN MILLONES MIL CON 05/100 SOLES');
});

test('propuesta económica 90 %–110 %: solo advierte si la ficha dice otra cosa', () => {
  assert.ok(!validarFicha(ficha(), CTX_PRUEBA).advertencias.some(a => a.k === 'propuesta_min_pct'));
  const v = validarFicha(ficha({ propuesta_min_pct: 85 }), CTX_PRUEBA);
  assert.ok(v.ok, 'no bloquea');
  assert.ok(v.advertencias.some(a => a.k === 'propuesta_min_pct' && /90 % y 110 %/.test(a.texto)));
  assert.deepEqual([calcularMontos(ficha()).min_bases, calcularMontos(ficha()).max_bases], [74970.14, 91630.17]);
});

// ─── Validaciones ───────────────────────────────────────────────────────────
test('la ficha de prueba completa es válida', () => {
  const v = validarFicha(ficha(), CTX_PRUEBA);
  assert.deepEqual(v.errores, []);
  assert.ok(v.ok);
});

test('obligatorios: una ficha vacía no se puede exportar', () => {
  const v = validarFicha(limpiarFicha({}), CTX_PRUEBA);
  assert.ok(!v.ok);
  assert.ok(v.pendientes.includes('ENTIDAD') && v.pendientes.includes('N_PROCESO') && v.pendientes.includes('FECHA_CONVOCATORIA'));
});

test('calendario: fechas fuera de orden bloquean; fines de semana solo advierten', () => {
  const v = validarFicha(ficha({ FECHA_INTEGRACION: '2026-09-08', FECHA_ABSOLUCION_FIN: '2026-09-11' }), CTX_PRUEBA);
  assert.ok(!v.ok);
  assert.ok(v.errores.some(e => e.k === 'FECHA_INTEGRACION' && /fuera de orden/.test(e.texto)));
  const w = validarFicha(ficha({ FECHA_CONVENIO: '2026-10-24' }), CTX_PRUEBA);   // sábado
  assert.ok(w.ok);
  assert.ok(w.advertencias.some(a => /sábado o domingo/.test(a.texto)));
  assert.equal(limpiarFicha({ FECHA_CONVENIO: '2026-02-30' }).FECHA_CONVENIO, '');
});

test('reglamento: obligatorio, y otro distinto al de las plantillas bloquea', () => {
  assert.ok(validarFicha(ficha({ reglamento: 'Decreto Supremo N° 038-2026-EF' }), CTX_PRUEBA).ok);
  assert.ok(validarFicha(ficha({ reglamento: '' }), CTX_PRUEBA).errores.some(e => e.k === 'reglamento'));
  assert.ok(validarFicha(ficha({ reglamento: 'DS 210-2022-EF' }), CTX_PRUEBA).errores.some(e => e.k === 'reglamento' && /plantillas citan/.test(e.texto)));
});

test('formatos: RUC, DNI, CUI y correo', () => {
  const v = validarFicha(ficha({ ENTIDAD_RUC: '123', DNI_REPRESENTANTE: '1234', CUI: 'ABC', ENTIDAD_CORREO_COMITE: 'no-es-correo' }), CTX_PRUEBA);
  assert.deepEqual(v.errores.map(e => e.k).sort(), ['CUI', 'DNI_REPRESENTANTE', 'ENTIDAD_CORREO_COMITE', 'ENTIDAD_RUC']);
});

test('neutralidad: la biblioteca es neutral; marcas o el nombre de un postor bloquean', () => {
  for (const [k, e] of Object.entries(ESPECIFICACIONES)) assert.deepEqual(revisarNeutralidad(e.texto), { prohibido: [], dudoso: [] }, k);
  assert.ok(!validarFicha(ficha({ especificaciones: { mesa: 'Mesa MarcaX® modelo 9' } }), CTX_PRUEBA).ok);
  assert.ok(!validarFicha(ficha({ NORMAS_ADICIONALES: 'Según Grupo Ibero' }), CTX_PRUEBA).ok);
  const v = validarFicha(ficha({ especificaciones: { silla: 'Silla de la marca indicada o similar' } }), CTX_PRUEBA);
  assert.ok(v.ok && v.advertencias.some(a => /neutrales/.test(a.texto)));
  assert.ok(!validarFicha(ficha({ normas_verificadas: false }), CTX_PRUEBA).ok, 'normas técnicas sin verificar');
});

test('cantidades: del cálculo de la app o «Malo» declarado por la UGEL con el precio de la app', () => {
  const app = cuadroCantidades(ficha(), CTX_PRUEBA);
  assert.deepEqual(app.filas.map(f => [f.k, f.cantidad, f.pu, f.parcial]), [['kit', 120, 600, 72000], ['esc', 6, 700, 4200]]);
  assert.equal(app.total, 76200);
  const ugel = ficha({ metodo_cantidades: 'malo_ugel', sustento_ugel: 'Oficio N° 1-2026-UGEL', cantidades_ugel: { kit: 100, esc: 5 } });
  const q = cuadroCantidades(ugel, CTX_PRUEBA);
  assert.deepEqual(q.filas.map(f => [f.cantidad, f.parcial]), [[100, 60000], [5, 3500]]);
  assert.match(q.texto, /declarado por la UGEL \(Oficio N° 1-2026-UGEL\)/);
  const v = validarFicha(ugel, CTX_PRUEBA);
  assert.ok(v.ok && v.advertencias.some(a => a.k === 'MONTO_EJECUCION'), 'la ejecución no coincide con el cuadro: advierte');
  assert.ok(!validarFicha(ficha({ metodo_cantidades: 'malo_ugel', sustento_ugel: 'Oficio', cantidades_ugel: { kit: 100 } }), CTX_PRUEBA).ok, 'falta una cantidad');
  assert.ok(!validarFicha(ficha({ metodo_cantidades: 'malo_ugel', cantidades_ugel: { kit: 100, esc: 5 } }), CTX_PRUEBA).ok, 'falta el documento de la UGEL');
});

test('precarga: toma de la app nombre, CUI, entidad, montos y no inventa la supervisión del documento equivalente', () => {
  const M = { nombre: 'IOARR X', cui: '2600001', F: { expediente: 2000, subtotalActivos: 70000, supervision: 3500 } };
  const { datos, notas } = precargar({ M, radar: { entidad: 'Gobierno Regional X' }, datosDoc: { uf: 'UF X', plazo_unidad: 'meses', meses: 2 } });
  assert.deepEqual(datos, { NOMBRE_IOARR: 'IOARR X', CUI: '2600001', ENTIDAD: 'Gobierno Regional X', UF_NOMBRE: 'UF X', COMPONENTE: 'Equipamiento', MONTO_DOC_EQUIVALENTE: 2000, MONTO_EJECUCION: 70000, MONTO_SUP_EJECUCION: 3500 });
  assert.ok(!('MONTO_SUP_DOC_EQUIVALENTE' in datos) && !('PLAZO_EJECUCION_DIAS' in datos) && !('PLAZO_DOC_EQUIVALENTE_DIAS' in datos));
  assert.match(notas.COMPONENTE, /Supuesto/);
});

test('precarga del Gobierno Regional: RUC, domicilio y sede de la región del proyecto; nunca si la entidad es otra', () => {
  const gore = goreDe('Moquegua');
  const { datos, notas } = precargar({ M: null, gore });
  assert.equal(datos.ENTIDAD, 'Gobierno Regional de Moquegua');
  assert.equal(datos.ENTIDAD_RUC, '20519752604');
  assert.match(datos.ENTIDAD_DOMICILIO, /MARISCAL DOMINGO NIETO.*distrito de Moquegua, provincia de Mariscal Nieto/);
  assert.equal(datos.PROVINCIA_NOTIFICACION, 'Mariscal Nieto');
  assert.equal(datos.CIUDAD_JURISDICCION, 'Moquegua');
  assert.match(notas.ENTIDAD_RUC, /SUNAT/);
  // La ficha valida el RUC precargado
  assert.ok(!validarFicha(ficha({ ENTIDAD_RUC: datos.ENTIDAD_RUC }), CTX_PRUEBA).errores.some(e => e.k === 'ENTIDAD_RUC'));
  // Radar con un Gobierno Regional: su nombre manda, los demás datos siguen
  const conRadar = precargar({ M: null, gore, radar: { entidad: 'GOBIERNO REGIONAL MOQUEGUA' } }).datos;
  assert.equal(conRadar.ENTIDAD, 'GOBIERNO REGIONAL MOQUEGUA');
  assert.equal(conRadar.ENTIDAD_RUC, '20519752604');
  // Radar con una municipalidad: nada del Gobierno Regional
  const muni = precargar({ M: null, gore, radar: { entidad: 'Municipalidad Provincial de Ilo' } }).datos;
  assert.deepEqual(Object.keys(muni).filter(k => k.startsWith('ENTIDAD_') || ['PROVINCIA_NOTIFICACION', 'CIUDAD_JURISDICCION'].includes(k)), []);
  assert.equal(muni.ENTIDAD, 'Municipalidad Provincial de Ilo');
  // La Libertad: domicilio legal completo y teléfono de sus bases (el padrón corta la vía)
  const ll = precargar({ M: null, gore: goreDe('La Libertad') });
  assert.match(ll.datos.ENTIDAD_DOMICILIO, /^Calle Baquíjano y Carrillo Altura Cuadra 18 .*distrito de La Esperanza/);
  assert.equal(ll.datos.ENTIDAD_TELEFONO, '044-604000');
  assert.match(ll.notas.ENTIDAD_DOMICILIO, /015-2026-GRLL/);
  assert.equal(ll.datos.ENTIDAD_RUC, '20440374248');
  assert.ok(!('ENTIDAD_TELEFONO' in datos), 'sin teléfono publicado no se inventa');
  // Lima: aviso de Lima Metropolitana
  assert.match(precargar({ M: null, gore: goreDe('Lima') }).notas.ENTIDAD, /Lima Metropolitana/);
});

test('gobiernos regionales: uno por cada región del selector, con RUC válido, activo y habido', () => {
  const indice = JSON.parse(readFileSync(new URL('../src/public/data/selector-ioarr/2025/index.json', import.meta.url), 'utf8'));
  const regiones = indice.regiones.map(r => r.nombre);
  assert.equal(GOBIERNOS_REGIONALES.length, 25);
  assert.deepEqual(GOBIERNOS_REGIONALES.map(g => g.region).sort(), [...regiones].sort());
  assert.equal(new Set(GOBIERNOS_REGIONALES.map(g => g.ruc)).size, 25, 'RUC repetido');
  for (const g of GOBIERNOS_REGIONALES) {
    assert.match(g.ruc, /^20\d{9}$/, g.region);
    assert.ok(g.estado === 'ACTIVO' && g.condicion === 'HABIDO', g.region);
    assert.ok(g.domicilio && g.provincia && g.ciudad, g.region);
  }
  assert.equal(goreDe('Región inventada'), null);
});

test('residuos del proceso de origen: siguen en el convenio fijo y se detectan', () => {
  const conv = PLANTILLAS.find(t => t.file.startsWith('18_')).texto;
  for (const r of RESIDUOS_ORIGEN) assert.match(conv, r.re, r.texto);
  assert.equal(armarTexto(ficha()).residuos.length, RESIDUOS_ORIGEN.length);
  assert.ok(validarFicha(ficha(), CTX_PRUEBA).advertencias.some(a => /proceso de origen/.test(a.texto)));
});

test('comparar dos versiones de la ficha', () => {
  const c = compararFichas(ficha(), ficha({ MONTO_EJECUCION: 80000, PLAZO_DOC_EQUIVALENTE_DIAS: 60, cantidades_ugel: { kit: 3 } }));
  const k = c.map(x => x.k);
  assert.ok(k.includes('MONTO_EJECUCION') && k.includes('MONTO_TOTAL') && k.includes('PLAZO_DOC_EQUIVALENTE_DIAS') && k.includes('cantidades_ugel.kit'));
  assert.equal(c.find(x => x.k === 'MONTO_EJECUCION').antes, 'S/ 76,200.00');
  assert.deepEqual(compararFichas(ficha(), ficha()), []);
});

// ─── Word ───────────────────────────────────────────────────────────────────
test('.docx de ejemplo con datos de prueba: transparencia primero, sin marcadores, documento equivalente y neutral', async () => {
  const buf = await generarBasesDocx({ datos: ficha(), ctx: CTX_PRUEBA, version: 1, fecha: '2026-10-25', usuario: 'prueba@ejemplo.invalid' });
  const dir = mkdtempSync(path.join(tmpdir(), 'bases-'));
  writeFileSync(path.join(dir, 'bases_ejemplo.docx'), buf);
  const z = await JSZip.loadAsync(buf), xml = await z.file('word/document.xml').async('string'), t = await textoDocx(buf);
  // XML válido para Word: sin caracteres de control (los saltos de página del PDF)
  assert.doesNotMatch(xml, /[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  // Hoja de transparencia: primera página, en su propia sección, con la declaración
  // Orden: transparencia, portada, contenido y la Sección I (la 2.ª vez que aparece: la 1.ª es su línea del contenido)
  const SEC_I = 'SECCIÓN I: CONDICIONES ESPECIALES DEL PROCESO DE SELECCIÓN';
  const iT = t.indexOf('HOJA DE TRANSPARENCIA'), iP = t.indexOf('BASES DEL PROCESO DE SELECCIÓN DE LA EMPRESA PRIVADA'),
    iC = t.indexOf('CONTENIDO\n'), iS = t.indexOf(SEC_I, t.indexOf(SEC_I) + 1);
  assert.ok(iT >= 0 && iP > iT && iC > iP && iS > iC, `orden transparencia ${iT}, portada ${iP}, contenido ${iC}, Sección I ${iS}`);
  assert.ok(t.slice(iT, iP).includes(DECLARACION));
  assert.match(t.slice(iT, iP), /Datos tomados de la aplicación[\s\S]*Supuestos[\s\S]*Campos pendientes/);
  assert.equal((xml.match(/<w:sectPr/g) || []).length, 2, 'dos secciones: transparencia y bases');
  // Portada con los datos del proceso
  const port = t.slice(iP, iC);
  assert.match(port, /PROCESO DE SELECCIÓN N° 001-2026-CE-PRUEBA/);
  assert.match(port, /CONTRATACIÓN DE LA EJECUCIÓN Y FINANCIAMIENTO DE LA IOARR:\n“[^”]+” CON CÓDIGO ÚNICO DE INVERSIÓN N° \d{7}/);
  // Contenido: campo de índice (títulos 1 y 2) ya escrito, y Word actualiza los campos al abrir
  assert.match(xml, /TOC \\h \\o &quot;1-2&quot;/);
  assert.match(await z.file('word/settings.xml').async('string'), /<w:updateFields(?: w:val="(?:true|1)")?\/>/);
  const indice = t.slice(iC, iS);
  for (const x of [SEC_I, 'CAPÍTULO ÚNICO: GENERALIDADES', '1.12. PRESENTACIÓN DE LAS PROPUESTAS, APERTURA DE LOS SOBRES N°01, N°02 Y N° 03, Y EVALUACIÓN DE SOBRES N° 1, N° 2:',
    'CAPÍTULO III: DEL CONVENIO DE INVERSIÓN', 'ANEXO N° 1: DEFINICIONES', 'ANEXO N° 6: FORMATO DE CONVENIO', 'ANEXO N° 3-A: TÉRMINOS DE REFERENCIA']) assert.ok(indice.includes(x), 'en el contenido: ' + x);
  for (const x of ['IMPORTANTE:', 'HOJA DE TRANSPARENCIA', 'Supuestos', '1.5.1.', '[INDICAR LUGAR Y FECHA]', '1. Objeto']) assert.ok(!indice.includes(x), 'fuera del contenido: ' + x);
  // Sin marcadores y con todo en orden
  assert.doesNotMatch(t, RE_MARCADOR);
  const orden = ['SECCIÓN I:', 'SECCIÓN II:', 'ANEXO N° 1', 'ANEXO N° 4-A', 'ANEXO N° 4-E', 'ANEXO N° 6', 'ANEXO N° 2', 'ANEXO N° 3-A: TÉRMINOS'].map(x => t.indexOf(x, iS));
  assert.ok(orden.every((x, i) => x > (orden[i - 1] ?? -1)), 'plantillas en orden: ' + orden.join(', '));
  // Documento equivalente: tabla 1.5, 1.5.1 y cronograma del Anexo 3-A
  assert.match(t, /Prestación N° 1: Elaboración de documento equivalente \[OBLIGATORIO\]/);
  assert.match(t, /1\.5\.1\. DOCUMENTO EQUIVALENTE \(REQUISITO OBLIGATORIO\)/);
  const a3 = t.slice(t.lastIndexOf('ANEXO N° 3-A'));
  assert.match(a3, /Elaboración del documento equivalente \(obligatorio\)\n30\n2,287\.50/);
  assert.match(a3, /Total\n\n90\n83,300\.15/);
  assert.match(a3, /Kit de mobiliario \(mesa \+ silla del estudiante\)\nNúmero de mobiliario\n120\n600\.00\n72,000\.00/);
  assert.match(a3, /Normas técnicas aplicables: RVM N° 331-2021-MINEDU; RM N° 355-2023-MINEDU \(verificadas por el usuario\)/);
  // Residuos del convenio resaltados en turquesa
  assert.match(xml, /<w:highlight w:val="cyan"\/>[\s\S]{0,400}Doscientos diez \(210\)/);
  // Neutralidad: ni el texto ni los metadatos nombran a la empresa
  for (const f of Object.keys(z.files).filter(f => f.endsWith('.xml'))) assert.doesNotMatch(await z.file(f).async('string'), /ibero/i, f);
});

test('vista previa: los marcadores sin dato quedan visibles y resaltados en amarillo', async () => {
  const d = ficha({ ENTIDAD_RUC: '', FECHA_PROPUESTAS: '' });
  const buf = await generarBasesDocx({ datos: d, ctx: CTX_PRUEBA, vistaPrevia: true, fecha: '2026-10-25' });
  const z = await JSZip.loadAsync(buf), xml = await z.file('word/document.xml').async('string');
  assert.match(xml, /<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>)[\s\S])*\{\{ENTIDAD_RUC\}\}/);
  assert.match(xml, /<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>)[\s\S])*\{FECHA_PROPUESTAS\}/);
  const cab = await Promise.all(Object.keys(z.files).filter(f => /header\d*\.xml$/.test(f)).map(f => z.file(f).async('string')));
  assert.ok(cab.some(h => /VISTA PREVIA CON DATOS PENDIENTES/.test(h)));
});
