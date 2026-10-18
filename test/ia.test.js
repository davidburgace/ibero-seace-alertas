// Pruebas de src/ioarr/ia.js con un cliente de OpenAI FALSO (no llaman a la API)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validarFichaIA, completarFicha, respaldoFicha, validarCostosIA, respaldoCostos, trocear, promptChat, preguntar,
  apareceMonto, apareceTexto, textoConPaginas
} from '../src/ioarr/ia.js';
import { leerFicha07C, leerTablaCostos } from '../src/ioarr/fichas.js';

const L = (pagina, ...textos) => textos.map(texto => ({ pagina, texto }));

// Ficha 07-C con un formato que las reglas no leen bien: la modalidad y la fuente
// están en una tabla con la etiqueta en otra línea, y el costo sin etiqueta conocida
const FICHA = [
  ...L(1, 'FORMATO N° 07-C: REGISTRO DE IOARR', 'CÓDIGO ÚNICO DE INVERSIÓN: 2741004',
    'NOMBRE DE LA INVERSIÓN: ADQUISICIÓN DE MOBILIARIO ESCOLAR EN LA I.E. N° 10234 DISTRITO DE CHICLAYO',
    'FECHA DE REGISTRO: 14/08/2025'),
  ...L(2, 'DATOS DE LA EJECUCIÓN', 'Modalidad | Fuente', 'ADMINISTRACIÓN INDIRECTA - OBRAS POR IMPUESTOS | RECURSOS DETERMINADOS',
    'INVERSIÓN TOTAL S/ 1,252,892.41')
];

// Cliente falso: devuelve lo que se le indique y guarda los prompts
function iaFalsa(respuestas) {
  const llamadas = [];
  return {
    llamadas,
    chat: { completions: { create: async (req) => {
      llamadas.push(req);
      const r = respuestas.shift();
      return { choices: [{ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }] };
    } } },
    embeddings: { create: async ({ input }) => ({ data: input.map((t, i) => ({ embedding: [t.length, i] })) }) }
  };
}

test('validarFichaIA: acepta lo que aparece en el PDF y descarta lo inventado', () => {
  const { aceptados, descartados } = validarFichaIA({
    cui: '2741004', nombre: 'ADQUISICION DE MOBILIARIO ESCOLAR EN LA I.E. N° 10234 DISTRITO DE CHICLAYO',
    costo_total: 1252892.41, modalidad_ejecucion: 'ADMINISTRACIÓN INDIRECTA - OBRAS POR IMPUESTOS',
    fuente_financiamiento: 'RECURSOS DETERMINADOS', fecha: '2025-08-14',
    uei: 'GOBIERNO REGIONAL LAMBAYEQUE',          // no está en el texto → inventado
    funcion: null
  }, FICHA);
  assert.deepEqual(Object.keys(aceptados).sort(), ['costo_total', 'cui', 'fecha', 'fuente_financiamiento', 'modalidad_ejecucion', 'nombre']);
  assert.deepEqual(descartados, ['uei']);
  // Montos o CUI que no están en el documento
  assert.deepEqual(validarFichaIA({ costo_total: 1252892, cui: '2741005' }, FICHA).descartados, ['cui', 'costo_total']);
});

test('apareceMonto / apareceTexto', () => {
  assert.ok(apareceMonto(1252892.41, FICHA));
  assert.ok(apareceMonto('1252892.41', FICHA));
  assert.ok(!apareceMonto(1252892.4, [{ pagina: 1, texto: 'S/ 1,252,892.41' }]));  // otro monto (1 céntimo menos)
  assert.ok(apareceMonto(1252892.41, [{ pagina: 1, texto: 'S/ 1.252.892,41' }]));
  assert.ok(!apareceMonto(999, FICHA));
  assert.ok(apareceTexto('administracion indirecta – obras por impuestos', FICHA));
  assert.ok(!apareceTexto('ADMINISTRACION DIRECTA', FICHA));
  assert.ok(!apareceTexto('AB', FICHA)); // muy corto: no prueba nada
});

test('completarFicha: solo llena lo que las reglas no encontraron', () => {
  const { campos, usados } = completarFicha({ cui: '2741004', costo_total: null, modalidad_ejecucion: 'X' },
    { cui: '9999999', costo_total: 100, modalidad_ejecucion: 'Y', fecha: '2025-08-14' });
  assert.deepEqual(usados, ['costo_total', 'fecha']);
  assert.equal(campos.cui, '2741004');
  assert.equal(campos.modalidad_ejecucion, 'X');
  assert.equal(campos.anio, 2025);
  assert.equal(campos.costo_total_etiqueta, 'leído con IA');
  assert.deepEqual(campos.leido_con_ia, ['costo_total', 'fecha']);
});

test('respaldoFicha: con la ficha real de reglas, la IA completa lo que falta y avisa lo descartado', async () => {
  const reglas = leerFicha07C(FICHA).campos;
  assert.equal(reglas.cui, '2741004');
  assert.equal(reglas.costo_total, null);           // «INVERSIÓN TOTAL» no es una etiqueta conocida
  const ia = iaFalsa([{ costo_total: 1252892.41, modalidad_ejecucion: 'ADMINISTRACIÓN INDIRECTA - OBRAS POR IMPUESTOS',
    fuente_financiamiento: 'RECURSOS ORDINARIOS' /* inventado: dice DETERMINADOS */ }]);
  const { campos, avisos } = await respaldoFicha(reglas, FICHA, ia);
  assert.equal(campos.costo_total, 1252892.41);
  assert.equal(campos.modalidad_ejecucion, 'ADMINISTRACIÓN INDIRECTA - OBRAS POR IMPUESTOS');
  assert.equal(campos.fuente_financiamiento, null);
  assert.match(avisos[0], /Leído con IA y verificado en el texto del PDF: costo total, modalidad de ejecución/);
  assert.match(avisos[1], /La IA propuso fuente de financiamiento, pero no aparece así en el PDF: se descartó/);
  // El prompt lleva el texto con las páginas y pide JSON
  assert.equal(ia.llamadas[0].response_format.type, 'json_object');
  assert.match(ia.llamadas[0].messages[0].content, /\[Página 2\]\nDATOS DE LA EJECUCIÓN/);
});

test('respaldoFicha: no llama a la IA si no falta nada, ni si no hay IA, y un error no rompe la lectura', async () => {
  const completo = { cui: '1', nombre: 'x', costo_total: 1, modalidad_ejecucion: 'x', fuente_financiamiento: 'x' };
  const ia = iaFalsa([]);
  assert.deepEqual(await respaldoFicha(completo, FICHA, ia), { campos: completo, avisos: [] });
  assert.equal(ia.llamadas.length, 0);
  assert.deepEqual((await respaldoFicha({ cui: null }, FICHA, null)).avisos, []);
  const rota = { chat: { completions: { create: async () => { throw new Error('429 rate limit'); } } } };
  assert.deepEqual(await respaldoFicha({ cui: null }, FICHA, rota), { campos: { cui: null }, avisos: ['No se pudo leer con IA: 429 rate limit'] });
});

// Tabla de costos que las reglas no entienden (columnas separadas por «|»)
const COSTOS = L(1,
  'ESTRUCTURA DE COSTOS',
  'CODIGO | DESCRIPCION | a | b | c | d | CANT',
  '112200010001|CARPETA UNIPERSONAL|250.00|10.00|20.00|322.00|1,200',
  '112200010002|SILLA METALICA|100.00|5.00|5.00|126.50|800',
  '112200010003|PIZARRA ACRILICA|1,000.00|20.00|30.00|1,300.00|10');

test('validarCostosIA: fila aceptada si su código y su d están en el PDF; marca las que no cuadran', () => {
  const v = validarCostosIA({ filas: [
    { codigo_bien: '112200010001', descripcion: 'CARPETA UNIPERSONAL', a: 250, b: 10, c: 20, d: 322, cantidad: 1200, pagina: 1 },
    { codigo_bien: '112200010003', descripcion: 'PIZARRA ACRILICA', a: 1000, b: 20, c: 30, d: 1300, cantidad: 10 },   // no cuadra (1207.5)
    { codigo_bien: '112200019999', descripcion: 'ESTANTE', a: 1, b: 1, c: 1, d: 3.45, cantidad: 1 },                // código inventado
    { codigo_bien: '112200010002', descripcion: 'SILLA METALICA', a: 100, b: 5, c: 5, d: 999, cantidad: 800 }        // d inventado
  ] }, COSTOS);
  assert.deepEqual(v.filas.map(f => [f.codigo_bien, f.cuadra]), [['112200010001', true], ['112200010003', false]]);
  assert.deepEqual(v.descartadas, ['112200019999', '112200010002']);
  assert.match(v.avisos[0], /Código 112200010003 \(leído con IA\): d = 1300 pero \(a\+b\+c\) × 1.15 = 1207.5/);
});

test('validarCostosIA: acepta códigos de catálogo que están en el PDF', () => {
  const lineas = L(1, 'SPM-03 SILLA DE METAL MADERA 90 260.68 3.92 15.68 322.32 29,008.80');
  const v = validarCostosIA({ filas: [
    { codigo_bien: 'SPM-03', descripcion: 'SILLA DE METAL MADERA', a: 260.68, b: 3.92, c: 15.68, d: 322.32, cantidad: 90 },
    { codigo_bien: 'SPM-99', descripcion: 'INVENTADA', a: 260.68, b: 3.92, c: 15.68, d: 322.32, cantidad: 1 }
  ] }, lineas);
  assert.deepEqual(v.filas.map(f => [f.codigo_bien, f.cuadra]), [['SPM-03', true]]);
  assert.deepEqual(v.descartadas, ['SPM-99']);
});

test('respaldoCostos: se usa la IA solo si mejora la lectura por reglas', async () => {
  const reglas = leerTablaCostos(COSTOS);
  assert.equal(reglas.filas.length, 0);
  const propuesta = { filas: [
    { codigo_bien: '112200010001', descripcion: 'CARPETA UNIPERSONAL', a: 250, b: 10, c: 20, d: 322, cantidad: 1200 },
    { codigo_bien: '112200010002', descripcion: 'SILLA METALICA', a: 100, b: 5, c: 5, d: 126.5, cantidad: 800 }
  ] };
  const r = await respaldoCostos(reglas, COSTOS, iaFalsa([propuesta]));
  assert.equal(r.usada, true);
  assert.equal(r.tabla.filas.length, 2);
  assert.ok(r.tabla.filas.every(f => f.leido_con_ia && f.cuadra));
  assert.match(r.avisos[0], /Tabla leída con IA: 2 filas verificadas en el PDF \(2 cuadran/);

  // Si las reglas ya leen bien la tabla, ni se pregunta
  const buena = { filas: [{ cuadra: true }, { cuadra: true }], avisos: [] };
  const ia = iaFalsa([]);
  assert.equal((await respaldoCostos(buena, COSTOS, ia)).usada, false);
  assert.equal(ia.llamadas.length, 0);
  // Si la IA no mejora, se queda la de reglas
  const peor = await respaldoCostos({ filas: [{ cuadra: false }], avisos: [] }, COSTOS, iaFalsa([{ filas: [] }]));
  assert.equal(peor.usada, false);
});

test('trocear: fragmentos acotados, sin cortar líneas, con páginas y solape', () => {
  const lineas = [];
  for (let p = 1; p <= 3; p++) for (let i = 0; i < 40; i++) lineas.push({ pagina: p, texto: `Página ${p} línea ${i} ` + 'x'.repeat(60) });
  const f = trocear(lineas, 1000);
  assert.ok(f.length > 5);
  assert.ok(f.every(x => x.content.length <= 1200));
  assert.equal(f[0].pagina_desde, 1);
  assert.equal(f.at(-1).pagina_hasta, 3);
  assert.deepEqual(f.map(x => x.chunk_index), f.map((_, i) => i));
  // La última línea de un fragmento abre el siguiente
  const ultima = f[0].content.split('\n').at(-1).replace(/^\[Página \d+\] /, '');
  assert.ok(f[1].content.startsWith(ultima));
  assert.match(f[0].content, /^\[Página 1\] /);
  assert.deepEqual(trocear([]), []);
});

test('preguntar: busca fragmentos del proyecto, arma el prompt con citas y devuelve las fuentes', async () => {
  const proyecto = { id: 'p1', cui: '2741004', nombre: 'MOBILIARIO IE 10234', estado: 'priorizada_oxi', monto_inversion: 1252892.41,
    modalidad_ejecucion: 'OBRAS POR IMPUESTOS', ficha_07c: { costo_total: 1252892.41 } };
  const rpc = [];
  const supabase = { rpc: async (fn, args) => { rpc.push([fn, args]); return { data: [
    { documento_id: 'd2', pagina_desde: 3, pagina_hasta: 3, content: '1,200 CARPETAS UNIPERSONALES', similitud: 0.8123 },
    { documento_id: 'd1', pagina_desde: 1, pagina_hasta: 2, content: 'I.E. N° 10234', similitud: 0.71 }
  ], error: null }; } };
  const ia = iaFalsa(['Incluye 1,200 carpetas [1] para la I.E. N° 10234 [2].']);
  const r = await preguntar(supabase, ia, { proyecto, pregunta: '¿Cuántas carpetas?',
    documentos: [{ id: 'd1', nombre_archivo: 'ficha.pdf' }, { id: 'd2', nombre_archivo: 'costos.pdf' }] });

  assert.equal(rpc[0][0], 'ioarr_match_chunks');
  assert.equal(rpc[0][1].p_proyecto_id, 'p1');
  assert.equal(r.respuesta, 'Incluye 1,200 carpetas [1] para la I.E. N° 10234 [2].');
  assert.deepEqual(r.fuentes.map(f => [f.n, f.nombre_archivo, f.pagina_desde, f.similitud]), [[1, 'costos.pdf', 3, 0.812], [2, 'ficha.pdf', 1, 0.71]]);
  const prompt = ia.llamadas[0].messages[0].content;
  assert.match(prompt, /\[1\] costos\.pdf, pág\. 3\n1,200 CARPETAS/);
  assert.match(prompt, /\[2\] ficha\.pdf, págs\. 1–2/);
  assert.match(prompt, /No aparece en los documentos subidos/);
  assert.match(prompt, /Modalidad de ejecución: OBRAS POR IMPUESTOS/);
  assert.match(prompt, /PREGUNTA: ¿Cuántas carpetas\?/);
});

test('promptChat sin fragmentos lo dice', () => {
  assert.match(promptChat({ cui: '1', nombre: 'x', estado: 'viable' }, [], '¿?', new Map()), /\(ninguno\)/);
  assert.equal(textoConPaginas([]), '');
});
