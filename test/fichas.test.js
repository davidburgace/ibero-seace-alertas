// Pruebas de la lectura de PDFs del Banco de Inversiones (correr con: npm test)
// Los PDF son SINTÉTICOS (generados aquí, imitando el texto de la ficha 07-C y
// de la estructura de costos): validan la lógica, no el formato real del MEF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extraerLineasPdf, clasificarDocumento, leerFicha07C, leerTablaCostos, preciosUnicos, anioDeLineas, dEsperado
} from '../src/ioarr/fichas.js';

// PDF mínimo con Helvetica (WinAnsi). paginas = [[ [x, y, 'texto'], ... ], ...]
function pdfSintetico(paginas) {
  const esc = (t) => t.replace(/[\\()]/g, c => '\\' + c);
  const objs = [];
  const add = (o) => { objs.push(o); return objs.length; };
  const catalogo = add(null), raiz = add(null);
  const fuente = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = paginas.map(textos => {
    const flujo = textos.map(([x, y, t]) => `BT /F1 8 Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
    const contenido = add(`<< /Length ${Buffer.byteLength(flujo, 'latin1')} >>\nstream\n${flujo}\nendstream`);
    return add(`<< /Type /Page /Parent ${raiz} 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${fuente} 0 R >> >> /Contents ${contenido} 0 R >>`);
  });
  objs[catalogo - 1] = `<< /Type /Catalog /Pages ${raiz} 0 R >>`;
  objs[raiz - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const off = Buffer.byteLength(out, 'latin1'); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return off; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const FICHA = pdfSintetico([[
  [40, 560, 'FORMATO N° 07-C: REGISTRO DE IOARR'],
  [40, 540, 'CÓDIGO ÚNICO DE INVERSIÓN:'], [220, 540, '2560356'],
  [40, 525, 'NOMBRE DE LA INVERSIÓN:'], [220, 525, 'REPOSICIÓN DE MOBILIARIO ESCOLAR EN 155 II.EE.'],
  [40, 510, 'UNIDAD FORMULADORA:'], [220, 510, 'PRONIED'],
  [40, 495, 'UNIDAD EJECUTORA DE INVERSIONES:'], [220, 495, 'PROGRAMA NACIONAL DE INFRAESTRUCTURA EDUCATIVA'],
  [40, 480, 'FUNCIÓN:'], [220, 480, 'EDUCACIÓN'],
  [40, 465, 'FECHA DE REGISTRO:'], [220, 465, '14/08/2024'],
  [40, 440, 'COSTO DE INVERSIÓN'],
  [60, 425, 'Activos'], [400, 425, '36,500,000.00'],
  [40, 410, 'COSTO TOTAL DE LA INVERSIÓN (S/)'], [400, 410, '39,137,205.62']
]]);

// a, b, c, d (= (a+b+c)×1.15), cantidad, subtotal
const COSTOS = pdfSintetico([
  [
    [40, 560, 'ESTRUCTURA DE COSTOS - Fecha: 02/09/2024'],
    [40, 540, 'ITEM'], [70, 540, 'CODIGO'], [150, 540, 'DESCRIPCION'], [420, 540, 'a'], [480, 540, 'b'], [530, 540, 'c'], [580, 540, 'd'], [650, 540, 'CANT.'], [720, 540, 'TOTAL'],
    [40, 520, '1'], [70, 520, '112200010001'], [150, 520, 'CARPETA UNIPERSONAL'], [380, 520, 'UND'], [420, 520, '250.00'], [480, 520, '10.00'], [530, 520, '20.00'], [580, 520, '322.00'], [650, 520, '1,200'], [720, 520, '386,400.00'],
    [40, 505, '2'], [70, 505, '112200010002'], [150, 505, 'SILLA DE ESTRUCTURA METALICA CON'], [420, 505, '100.00'], [480, 505, '5.00'], [530, 505, '5.00'], [580, 505, '126.50'], [650, 505, '800'], [720, 505, '101,200.00'],
    [150, 495, 'ASIENTO DE POLIPROPILENO'],
    [40, 480, '3'], [70, 480, '112200010003'], [150, 480, 'PIZARRA ACRILICA'], [420, 480, '1,000.00'], [480, 480, '20.00'], [530, 480, '30.00'], [580, 480, '1,300.00'], [650, 480, '10'], [720, 480, '13,000.00']
  ],
  [
    [40, 560, '4'], [70, 560, '112200010001'], [150, 560, 'CARPETA UNIPERSONAL'], [420, 560, '250.00'], [480, 560, '10.00'], [530, 560, '20.00'], [580, 560, '322.00'], [650, 560, '300'], [720, 560, '96,600.00'],
    [40, 540, 'TOTAL'], [720, 540, '597,200.00']
  ]
]);

test('extraerLineasPdf reconstruye las filas por altura', async () => {
  const { paginas, lineas } = await extraerLineasPdf(COSTOS);
  assert.equal(paginas, 2);
  const fila = lineas.find(l => l.texto.startsWith('1 112200010001'));
  assert.equal(fila.texto, '1 112200010001 CARPETA UNIPERSONAL UND 250.00 10.00 20.00 322.00 1,200 386,400.00');
});

test('ficha 07-C: CUI, nombre y costo total (caso CUI 2560356)', async () => {
  const { lineas } = await extraerLineasPdf(FICHA);
  const { campos, avisos } = leerFicha07C(lineas);
  assert.equal(campos.cui, '2560356');
  assert.equal(campos.nombre, 'REPOSICIÓN DE MOBILIARIO ESCOLAR EN 155 II.EE.');
  assert.equal(campos.costo_total, 39137205.62);
  assert.equal(campos.costo_total_etiqueta, 'COSTO TOTAL DE LA INVERSION');
  assert.equal(campos.unidad_formuladora, 'PRONIED');
  assert.equal(campos.uei, 'PROGRAMA NACIONAL DE INFRAESTRUCTURA EDUCATIVA');
  assert.equal(campos.funcion, 'EDUCACIÓN');
  assert.equal(campos.fecha, '2024-08-14');
  assert.equal(campos.anio, 2024);
  assert.deepEqual(avisos, []);
});

test('ficha 07-C sin texto avisa', () => {
  const { campos, avisos } = leerFicha07C([]);
  assert.equal(campos.costo_total, null);
  assert.match(avisos[0], /no tiene texto/);
});

test('clasificarDocumento por nombre y, si no, por contenido', async () => {
  assert.equal(clasificarDocumento('Exportacion_2560356.pdf'), 'ficha_07c');
  assert.equal(clasificarDocumento('Formato 07-C.pdf'), 'ficha_07c');
  assert.equal(clasificarDocumento('Estructura de costos 2560356.pdf'), 'estructura_costos');
  assert.equal(clasificarDocumento('ficha_costos.pdf'), 'estructura_costos');
  assert.equal(clasificarDocumento('Informe técnico de sustento.pdf'), 'informe_sustento');
  assert.equal(clasificarDocumento('scan001.pdf', (await extraerLineasPdf(FICHA)).lineas), 'ficha_07c');
  assert.equal(clasificarDocumento('scan002.pdf', (await extraerLineasPdf(COSTOS)).lineas), 'estructura_costos');
  assert.equal(clasificarDocumento('scan003.pdf', []), 'otro');
});

test('tabla de costos: columnas por la fórmula, descripción en dos líneas y fin de tabla', async () => {
  const { lineas } = await extraerLineasPdf(COSTOS);
  const { filas, avisos } = leerTablaCostos(lineas);
  assert.equal(filas.length, 4);
  const [f1, f2, f3] = filas;
  assert.deepEqual({ ...f1, pagina: undefined },
    { codigo_bien: '112200010001', descripcion: 'CARPETA UNIPERSONAL', a: 250, b: 10, c: 20, d: 322, cantidad: 1200, cuadra: true, pagina: undefined });
  assert.equal(f2.descripcion, 'SILLA DE ESTRUCTURA METALICA CON ASIENTO DE POLIPROPILENO');
  assert.equal(f2.cuadra, true);
  // (1000+20+30)×1.15 = 1207.50 ≠ 1300
  assert.equal(f3.cuadra, false);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /112200010003.*1300.*1207\.5/);
  assert.equal(anioDeLineas(lineas), 2024);
});

test('preciosUnicos: uno por código, suma cantidades y avisa precios distintos', () => {
  const base = { descripcion: 'X', b: 0, c: 0, cuadra: true };
  const { precios, avisos } = preciosUnicos([
    { ...base, codigo_bien: '111111', a: 100, d: 115, cantidad: 10 },
    { ...base, codigo_bien: '111111', a: 100, d: 115, cantidad: 5 },
    { ...base, codigo_bien: '111111', a: 200, d: 230, cantidad: 1 },
    { ...base, codigo_bien: '222222', a: 10, d: 11.5, cantidad: null }
  ]);
  assert.equal(precios.length, 2);
  assert.equal(precios[0].d, 115);
  assert.equal(precios[0].cantidad, 16);
  assert.equal(precios[1].cantidad, null);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /111111.*2 precios distintos/);
});

test('dEsperado redondea a céntimos', () => {
  assert.equal(dEsperado(250, 10, 20), 322);
  assert.equal(dEsperado(33.33, 0, 0), 38.33);
});
