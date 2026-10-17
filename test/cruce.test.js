// Pruebas del cruce de fuentes (correr con: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { leerArchivo, detectarMapeo, limpiaCui, datosDelBanner } from '../src/ioarr/ingesta.js';
import { filaAProyecto } from '../src/ioarr/ingesta.js';
import { financiamiento, esFuentePublica, esModalidadOxi } from '../src/ioarr/cruce.js';
import { filaACarga, filaAPmi, filtrarFilasPmi, esEducacion, textoFiltros, deduplicarPorCui, guardarCarga, borrarCarga, calcularCruce, claseFaseOxi, claveOpmi, tipoEntidad, IDEA_SIN_CUI } from '../src/ioarr/cruce.js';
import { excelProinversion } from './helpers/proinversion.js';

// ─── Réplica en memoria de lo que lee obtenerDatosCruce() ───────────────────
// cargas: [{ id, fuente, fecha_carga, nombre_archivo, opmi?, filtros?, filas: [...] }]
function vistas(cargas) {
  const orden = [...cargas].sort((a, b) => new Date(b.fecha_carga) - new Date(a.fecha_carga));
  const fuentes = [];
  for (const fuente of ['invierte_pe', 'proinversion']) {
    const deFuente = orden.filter(c => c.fuente === fuente);
    if (!deFuente.length) continue;
    const vistos = new Map();
    for (const c of deFuente) for (const f of c.filas) {
      const ex = vistos.get(f.cui);
      if (!ex) vistos.set(f.cui, { ...f, fuente, carga_id: c.id, fecha_carga: c.fecha_carga, nombre_archivo: c.nombre_archivo,
        en_ultima_carga: c.id === deFuente[0].id, entidades_previas: [] });
      else if (f.entidad) ex.entidades_previas.push(f.entidad);
    }
    fuentes.push(...vistos.values());
  }
  // ioarr_pmi (todas las cargas) y la vista ioarr_pmi_entidades_carga (migración 007)
  const dePmi = cargas.filter(c => c.fuente === 'pmi');
  const pmi = dePmi.flatMap(c => c.filas.map(f => ({ entidad: null, periodo: null, ...f, carga_id: c.id, fecha_carga: c.fecha_carga })));
  const pmiEntidadesCarga = [...new Map(pmi.filter(f => f.entidad).map(f => [`${f.carga_id}|${f.entidad}`, { carga_id: f.carga_id, entidad: f.entidad }])).values()];
  return { fuentes, pmi, pmiEntidadesCarga,
    cargas: cargas.map(({ filas, ...c }) => ({ filtros: {}, opmi: null, ...c, filas: c.fuente === 'pmi' ? filas.length : c.filas?.length })) };
}

// Exporte de la Consulta Avanzada del Banco: banner de 3 filas y encabezado en la 4
function excelBanco(filas) {
  const enc = ['CÓDIGO ÚNICO DE INVERSIÓN', 'NOMBRE DE LA INVERSIÓN', 'ESTADO DE LA INVERSIÓN', 'NIVEL DE GOBIERNO', 'ENTIDAD',
    'DEPARTAMENTO', 'PROVINCIA', 'DISTRITO', 'FUNCIÓN', 'COSTO ACTUALIZADO', 'DEVENGADO ACUMULADO', 'PIM 2026', 'FUENTE DE FINANCIAMIENTO'];
  const ws = XLSX.utils.aoa_to_sheet([['CONSULTA AVANZADA DE INVERSIONES'], ['Fecha de consulta: 15/10/2026'], [], enc, ...filas]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Consulta');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const leerCarga = (buffer, conv = filaACarga) => {
  const { headers, rows } = leerArchivo(buffer);
  const mapeo = detectarMapeo(headers);
  return deduplicarPorCui(rows.map(r => conv(r, mapeo)).filter(Boolean)).filas;
};

const FILA_2560356 = [2560356, 'ADQUISICIÓN DE MOBILIARIO ESCOLAR; EN LA IE DE PRUEBA', 'ACTIVO', 'GL', 'MUNICIPALIDAD DISTRITAL DE PRUEBA',
  'LAMBAYEQUE', 'CHICLAYO', 'CHICLAYO', 'EDUCACIÓN', '480,000.00', 0, 0, null];

test('CUI 2560356: en el Banco, no en Proinversión, PMI sin verificar → «Viable, PMI sin verificar»', () => {
  const banco = leerCarga(excelBanco([FILA_2560356]));
  assert.equal(banco[0].cui, '2560356');
  assert.equal(banco[0].estado_inversion, 'ACTIVO');
  assert.equal(banco[0].monto_inversion, 480000);

  const datos = vistas([
    { id: 'b1', fuente: 'invierte_pe', fecha_carga: '2026-10-15T10:00:00Z', nombre_archivo: 'banco.xlsx', filas: banco },
    { id: 'p1', fuente: 'proinversion', fecha_carga: '2026-10-10T10:00:00Z', nombre_archivo: 'pro.xlsx', filas: leerCarga(excelProinversion()) }
  ]);
  const { filas, cargas } = calcularCruce(datos);
  const f = filas.find(x => x.cui === '2560356');
  assert.equal(f.en_banco, true);
  assert.equal(f.en_proinversion, false);
  assert.equal(f.en_pmi, 'sin_verificar');
  assert.equal(f.situacion, 'viable_pmi_sin_verificar');
  assert.equal(f.situacion_label, 'Viable, PMI sin verificar');
  assert.match(f.motivo, /En el Banco, no en Proinversión; PMI sin verificar/);
  assert.deepEqual(f.cargas.map(c => [c.fuente, c.nombre_archivo]), [['invierte_pe', 'banco.xlsx']]);
  assert.equal(f.es_mobiliario, true);
  assert.equal(cargas.ultimas.invierte_pe.id, 'b1');
});

test('Excel de Proinversión de 4 filas: 1 priorizada, 3 por priorizar, la idea sin CUI registrado', () => {
  const pro = leerCarga(excelProinversion());
  assert.equal(pro.length, 4);
  const { filas } = calcularCruce(vistas([{ id: 'p1', fuente: 'proinversion', fecha_carga: '2026-10-10T10:00:00Z', filas: pro }]));

  const por = (s) => filas.filter(f => f.situacion === s).map(f => f.cui);
  assert.deepEqual(por('priorizada'), ['2603315']);
  assert.deepEqual(por('por_priorizar').sort(), ['2589001', '2611450', 'IDEA0000110']);
  // Orden por prioridad: la priorizada primero
  assert.equal(filas[0].cui, '2603315');
  assert.equal(filas[0].motivo, 'Está en Proinversión como «Priorizado»');
  assert.equal(filas[0].fase_oxi, 'Priorizado');
  assert.equal(filas[0].nivel_estudio, 'IOARR aprobada');

  const idea = filas.find(f => f.cui === 'IDEA0000110');
  assert.equal(idea.codigo, IDEA_SIN_CUI);
  assert.equal(idea.en_banco, false);
  assert.equal(filas.filter(f => f.es_mobiliario).length, 3);
});

test('Desaparecida de Proinversión: estaba en una carga anterior y no en la última', () => {
  const pro = leerCarga(excelProinversion());
  const { filas } = calcularCruce(vistas([
    { id: 'p1', fuente: 'proinversion', fecha_carga: '2026-09-01T10:00:00Z', filas: pro },
    { id: 'p2', fuente: 'proinversion', fecha_carga: '2026-10-10T10:00:00Z', filas: pro.filter(f => f.cui !== '2589001') }
  ]));
  const f = filas.find(x => x.cui === '2589001');
  assert.equal(f.situacion, 'desaparecida');
  assert.equal(f.en_proinversion, false);
  assert.match(f.motivo, /carga de Proinversión del 2026-09-01 y no aparece en la última \(2026-10-10\)/);
  assert.equal(filas.find(x => x.cui === '2603315').situacion, 'priorizada');
});

test('En ejecución o descartada: desactivada, ejecución con fuente pública o descartada a mano', () => {
  const banco = leerCarga(excelBanco([
    [111, 'MOBILIARIO A', 'DESACTIVADO', 'GL', 'MUNI A', 'PIURA', 'PIURA', 'PIURA', 'EDUCACIÓN', 100, 0, 0, null],
    [222, 'MOBILIARIO B', 'ACTIVO', 'GL', 'MUNI B', 'PIURA', 'PIURA', 'PIURA', 'EDUCACIÓN', 100, 50000, 80000, 'RECURSOS DETERMINADOS'],
    [333, 'MOBILIARIO C', 'ACTIVO', 'GL', 'MUNI C', 'PIURA', 'PIURA', 'PIURA', 'EDUCACIÓN', 100, 0, 0, null],
    [444, 'MOBILIARIO D', 'ACTIVO', 'GL', 'MUNI D', 'PIURA', 'PIURA', 'PIURA', 'EDUCACIÓN', 100, 30000, 0, 'OBRAS POR IMPUESTOS']
  ]));
  const datos = vistas([{ id: 'b1', fuente: 'invierte_pe', fecha_carga: '2026-10-15T10:00:00Z', filas: banco }]);
  datos.proyectos = [{ id: 'r3', cui: '333', estado: 'descartada' }];
  const { filas } = calcularCruce(datos);
  const s = Object.fromEntries(filas.map(f => [f.cui, f]));
  assert.equal(s['111'].situacion, 'ejecucion_descartada');
  assert.match(s['111'].motivo, /DESACTIVADO/);
  assert.equal(s['222'].situacion, 'ejecucion_descartada');
  assert.match(s['222'].motivo, /presupuesto público.*devengado S\/ 50,000, fuente «RECURSOS DETERMINADOS» y PIM S\/ 80,000/);
  assert.equal(s['333'].situacion, 'ejecucion_descartada');
  assert.equal(s['333'].motivo, 'La marcaste como descartada en el radar');
  // Fuente «Obras por Impuestos»: no es presupuesto público, va por OxI
  assert.equal(s['444'].situacion, 'priorizada');
  assert.equal(s['444'].es_oxi, true);
  // Las descartadas van al final
  assert.equal(filas.at(-1).situacion, 'ejecucion_descartada');
});

test('PMI: el archivo decide si cubre a la entidad; si no, la marca manual; se señala la diferencia', () => {
  const banco = leerCarga(excelBanco([
    [501, 'MOBILIARIO E', 'ACTIVO', 'GL', 'MUNICIPALIDAD DE ÉXITO', 'ICA', 'ICA', 'ICA', 'EDUCACIÓN', 100, 0, 0, null],
    [502, 'MOBILIARIO F', 'ACTIVO', 'GL', 'MUNICIPALIDAD DE ÉXITO', 'ICA', 'ICA', 'ICA', 'EDUCACIÓN', 100, 0, 0, null],
    [503, 'MOBILIARIO G', 'ACTIVO', 'GL', 'MUNI SIN PMI', 'ICA', 'ICA', 'ICA', 'EDUCACIÓN', 100, 0, 0, null]
  ]));
  const wsPmi = XLSX.utils.aoa_to_sheet([['CARTERA DEL PMI'], [], ['CUI', 'ENTIDAD', 'AÑO'], ['501', 'Municipalidad de Éxito', '2027-2029'], ['999', 'Municipalidad de Éxito', '2027-2029']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, wsPmi, 'PMI');
  const pmi = leerCarga(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), filaAPmi);
  assert.deepEqual(pmi[0], { cui: '501', entidad: 'Municipalidad de Éxito', periodo: '2027-2029', repeticiones: 1 });

  const datos = vistas([
    { id: 'b1', fuente: 'invierte_pe', fecha_carga: '2026-10-15T10:00:00Z', filas: banco },
    { id: 'm1', fuente: 'pmi', fecha_carga: '2026-10-16T10:00:00Z', filas: pmi }
  ]);
  datos.pmiManual = [
    { cui: '502', en_pmi: 'si', revisado_en: '2026-10-01T00:00:00Z', nota: 'me dijo la UF' },
    { cui: '503', en_pmi: 'no', revisado_en: '2026-10-12T00:00:00Z', nota: 'revisé el PMI en PDF' }
  ];
  const s = Object.fromEntries(calcularCruce(datos).filas.map(f => [f.cui, f]));
  assert.equal(s['501'].en_pmi, 'si');
  assert.equal(s['501'].situacion, 'viable_pmi');
  assert.equal(s['501'].pmi_periodo, '2027-2029');
  assert.equal(s['502'].en_pmi, 'no');                // la entidad tiene PMI y el CUI no está
  assert.equal(s['502'].situacion, 'viable_fuera_pmi');
  assert.match(s['502'].avisos.join(' '), /marca manual de PMI.*difiere del archivo/);
  assert.equal(s['503'].en_pmi, 'no');                // sin archivo: manda la marca manual
  assert.equal(s['503'].en_pmi_origen, 'manual');
  assert.match(s['503'].en_pmi_detalle, /2026-10-12: revisé el PMI en PDF/);
});

test('El cruce no cambia el estado del radar: solo señala la diferencia', () => {
  const pro = leerCarga(excelProinversion());
  const datos = vistas([{ id: 'p1', fuente: 'proinversion', fecha_carga: '2026-10-10T10:00:00Z', filas: pro }]);
  const proyectos = [{ id: 'r1', cui: '2589001', estado: 'priorizada_oxi' }, { id: 'r2', cui: '2603315', estado: 'convenio' }];
  datos.proyectos = proyectos;
  const s = Object.fromEntries(calcularCruce(datos).filas.map(f => [f.cui, f]));
  assert.match(s['2589001'].diferencia_estado, /«Por priorizar», pero tu estado en el radar es «Priorizada OxI»/);
  assert.equal(s['2589001'].estado_radar, 'priorizada_oxi');
  assert.equal(proyectos[0].estado, 'priorizada_oxi');
  assert.equal(s['2603315'].diferencia_estado, null); // convenio va por delante de «Priorizado»: encaja
});

test('Casos borde: CUI repetido en la carga y proyecto que cambia de entidad', () => {
  const v1 = leerCarga(excelBanco([[700, 'MOBILIARIO H', 'ACTIVO', 'GL', 'MUNI VIEJA', 'PUNO', 'PUNO', 'PUNO', 'EDUCACIÓN', 100, 0, 0, null]]));
  const v2 = leerCarga(excelBanco([
    [700, 'MOBILIARIO H', 'ACTIVO', 'GL', 'MUNI VIEJA', 'PUNO', 'PUNO', 'PUNO', 'EDUCACIÓN', 100, 0, 0, null],
    [700, 'MOBILIARIO H', 'ACTIVO', 'GORE', 'GOBIERNO REGIONAL PUNO', 'PUNO', 'PUNO', 'PUNO', 'EDUCACIÓN', 150, 0, 0, null]
  ]));
  assert.equal(v2.length, 1);
  assert.equal(v2[0].repeticiones, 2);
  assert.equal(v2[0].entidad, 'GOBIERNO REGIONAL PUNO'); // gana la última fila

  const { filas } = calcularCruce(vistas([
    { id: 'b1', fuente: 'invierte_pe', fecha_carga: '2026-09-01T10:00:00Z', filas: v1 },
    { id: 'b2', fuente: 'invierte_pe', fecha_carga: '2026-10-01T10:00:00Z', filas: v2 }
  ]));
  const avisos = filas[0].avisos.join(' | ');
  assert.match(avisos, /CUI repetido 2 veces en la carga del Banco del 2026-10-01/);
  assert.match(avisos, /Cambió de entidad en el Banco: antes «MUNI VIEJA», ahora «GOBIERNO REGIONAL PUNO»/);
  assert.equal(filas[0].monto_inversion, 150);
  assert.equal(filas[0].entidad_tipo, 'GORE');
});

test('claseFaseOxi distingue Priorizado, Por Priorizar y otras fases', () => {
  assert.equal(claseFaseOxi('Priorizado'), 'priorizado');
  assert.equal(claseFaseOxi('POR PRIORIZAR'), 'por_priorizar');
  assert.equal(claseFaseOxi('Convenio suscrito'), 'otra');
  assert.equal(claseFaseOxi(null), null);
});

test('guardarCarga: una carga con sus filas; si fallan las filas, se borra la carga', async () => {
  const llamadas = [];
  const sb = (falla) => ({
    from: (tabla) => ({
      insert: (filas) => {
        llamadas.push([tabla, filas]);
        if (tabla === 'ioarr_cargas') return { select: () => ({ single: async () => ({ data: { id: 'c1', fecha_carga: '2026-10-16T00:00:00Z', ...filas }, error: null }) }) };
        return Promise.resolve({ error: falla ? { message: 'boom' } : null });
      },
      delete: () => ({ eq: async (col, v) => { llamadas.push([tabla, 'delete', v]); return { error: null }; } })
    })
  });
  const r = await guardarCarga(sb(false), { fuente: 'pmi', filas: [{ cui: '1', entidad: 'X', periodo: '2027' }, { cui: '1', entidad: 'X', periodo: '2027' }], nombre_archivo: 'pmi.xlsx' });
  assert.deepEqual([r.filas, r.filas_repetidas], [1, 1]);
  assert.equal(llamadas[0][1].filas_repetidas, 1);
  assert.deepEqual(llamadas[1], ['ioarr_pmi', [{ cui: '1', entidad: 'X', periodo: '2027', carga_id: 'c1', fecha_carga: '2026-10-16T00:00:00Z' }]]);

  llamadas.length = 0;
  await assert.rejects(guardarCarga(sb(true), { fuente: 'invierte_pe', filas: [{ cui: '1' }] }), { message: 'boom' });
  assert.deepEqual(llamadas.at(-1), ['ioarr_cargas', 'delete', 'c1']);
});

test('borrarCarga: borra por id y devuelve la carga, o null si no existía', async () => {
  const cargas = [{ id: 'c1', fuente: 'pmi' }];
  const sb = { from: (tabla) => ({ delete: () => ({ eq: (col, v) => ({ select: () => ({ maybeSingle: async () => {
    assert.equal(tabla, 'ioarr_cargas');
    const i = cargas.findIndex(c => c[col] === v);
    return { data: i >= 0 ? cargas.splice(i, 1)[0] : null, error: null };
  } }) }) }) }) };
  assert.deepEqual(await borrarCarga(sb, 'c1'), { id: 'c1', fuente: 'pmi' });
  assert.equal(cargas.length, 0);
  assert.equal(await borrarCarga(sb, 'c1'), null);
});

test('Al borrar la última carga de Proinversión, cuenta la anterior y ya no hay «desaparecidas»', () => {
  const pro = leerCarga(excelProinversion());
  const c1 = { id: 'p1', fuente: 'proinversion', fecha_carga: '2026-09-01T10:00:00Z', filas: pro };
  const c2 = { id: 'p2', fuente: 'proinversion', fecha_carga: '2026-10-10T10:00:00Z', filas: pro.slice(0, 1) };
  assert.equal(calcularCruce(vistas([c1, c2])).filas.filter(f => f.situacion === 'desaparecida').length, 3);
  const { filas, cargas } = calcularCruce(vistas([c1]));
  assert.equal(filas.filter(f => f.situacion === 'desaparecida').length, 0);
  assert.equal(cargas.ultimas.proinversion.id, 'p1');
});

test('PMI: filtros de Educación e IOARR con conteo de descartes', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['CARTERA DEL PMI'], [],
    ['CUI', 'ENTIDAD', 'AÑO', 'FUNCIÓN', 'TIPO DE INVERSIÓN'],
    ['601', 'Muni A', '2027', 'EDUCACIÓN', 'IOARR'],
    ['602', 'Muni A', '2027', '22 EDUCACION', 'PROYECTO DE INVERSION'],
    ['603', 'Muni A', '2027', 'SALUD', 'IOARR'],
    ['', 'Muni A', '2027', 'EDUCACIÓN', 'IOARR'],
    ['604', 'Muni A', '2027', 'Educación', 'Optimización']
  ]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'PMI');
  const { headers, rows } = leerArchivo(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const mapeo = detectarMapeo(headers);
  assert.equal(mapeo.funcion, 'FUNCIÓN');
  assert.equal(mapeo.tipo_inversion, 'TIPO DE INVERSIÓN');

  const sinFiltros = filtrarFilasPmi(rows, mapeo);
  assert.deepEqual(sinFiltros.resumen, { leidas: 5, sin_cui: 1, no_educacion: 0, no_ioarr: 0, importadas: 4 });

  const edu = filtrarFilasPmi(rows, mapeo, { soloEducacion: true });
  assert.deepEqual(edu.filas.map(f => f.cui), ['601', '602', '604']);
  assert.deepEqual(edu.resumen, { leidas: 5, sin_cui: 1, no_educacion: 1, no_ioarr: 0, importadas: 3 });

  // Una fila que falla los dos filtros se cuenta solo en el primero (Función)
  const ambos = filtrarFilasPmi(rows, mapeo, { soloEducacion: true, soloIoarr: true });
  assert.deepEqual(ambos.filas.map(f => f.cui), ['601', '604']);
  assert.deepEqual(ambos.resumen, { leidas: 5, sin_cui: 1, no_educacion: 1, no_ioarr: 1, importadas: 2 });

  // Lo que se guarda en ioarr_pmi no cambia de forma
  assert.deepEqual(ambos.filas[0], { cui: '601', entidad: 'Muni A', periodo: '2027' });

  assert.throws(() => filtrarFilasPmi(rows, { ...mapeo, funcion: null }, { soloEducacion: true }), /Función/);
  assert.throws(() => filtrarFilasPmi(rows, { ...mapeo, tipo_inversion: null }, { soloIoarr: true }), /Tipo de inversión/);
});

test('esEducacion: igualdad exacta, con o sin código delante', () => {
  for (const v of ['EDUCACIÓN', 'educacion', '22 EDUCACIÓN', '22-EDUCACION', '22: Educación']) assert.ok(esEducacion(v), v);
  for (const v of ['SALUD', 'CULTURA Y DEPORTE', 'EDUCACION Y CULTURA', '', null]) assert.ok(!esEducacion(v), String(v));
});

test('Cruce: un PMI cargado solo con Educación no deja «fuera del PMI» a lo que no es Educación', () => {
  const fila = (cui, funcion) => [cui, 'ADQUISICIÓN DE MOBILIARIO EN LA IE ' + cui, 'ACTIVO', 'GL', 'MUNICIPALIDAD DE FILTRO',
    'PIURA', 'PIURA', 'PIURA', funcion, '100,000.00', 0, 0, null];
  const banco = leerCarga(excelBanco([fila(701, 'EDUCACIÓN'), fila(702, 'SALUD'), fila(703, 'SALUD'), fila(704, null)]));
  const datos = vistas([
    { id: 'b1', fuente: 'invierte_pe', fecha_carga: '2026-10-15T10:00:00Z', filas: banco },
    { id: 'm1', fuente: 'pmi', fecha_carga: '2026-10-16T10:00:00Z', filtros: { solo_educacion: true, solo_ioarr: false },
      filas: [{ cui: '700', entidad: 'MUNICIPALIDAD DE FILTRO', periodo: '2027-2029' }] }
  ]);
  datos.pmiManual = [{ cui: '703', en_pmi: 'si', revisado_en: '2026-10-10T00:00:00Z', nota: 'lo vi en el PDF' }];
  const s = Object.fromEntries(calcularCruce(datos).filas.map(f => [f.cui, f]));

  // Educación y no está en el PMI filtrado: sí está fuera
  assert.equal(s['701'].en_pmi, 'no');
  assert.equal(s['701'].situacion, 'viable_fuera_pmi');
  assert.match(s['701'].en_pmi_detalle, /solo Educación/);
  // Salud: la carga no podía contenerlo → sin verificar, con el motivo
  assert.equal(s['702'].en_pmi, 'sin_verificar');
  assert.equal(s['702'].situacion, 'viable_pmi_sin_verificar');
  assert.match(s['702'].en_pmi_detalle, /solo Educación y este proyecto es de la función «SALUD»/);
  // Salud con marca manual: vale la marca, sin aviso de discrepancia con el archivo
  assert.equal(s['703'].en_pmi, 'si');
  assert.equal(s['703'].en_pmi_origen, 'manual');
  assert.ok(!s['703'].avisos?.some(a => /difiere del archivo/.test(a)));
  // Sin función conocida: tampoco se concluye
  assert.equal(s['704'].en_pmi, 'sin_verificar');
  assert.match(s['704'].en_pmi_detalle, /no se sabe la función/);

  // La misma carga sin filtros sí deja fuera a todos
  datos.cargas = datos.cargas.map(c => ({ ...c, filtros: {} }));
  datos.pmiManual = [];
  const t = Object.fromEntries(calcularCruce(datos).filas.map(f => [f.cui, f]));
  for (const cui of ['701', '702', '703', '704']) assert.equal(t[cui].en_pmi, 'no', cui);
});

test('textoFiltros', () => {
  assert.equal(textoFiltros({ solo_educacion: true, solo_ioarr: true }), 'solo Educación e IOARR');
  assert.equal(textoFiltros({ solo_educacion: false, solo_ioarr: true }), 'solo IOARR');
  assert.equal(textoFiltros({}), '');
  assert.equal(textoFiltros(null), '');
});

// ─── PMI por OPMI (el caso del 17/10/2026) ──────────────────────────────────
// Exporte «Cartera de inversiones» del PMI: banner de 5 filas con la OPMI y el
// encabezado en la fila 6; sin columna de entidad; con «Monto Año 2026 (S/)».
function excelCarteraPmi(opmi, filas) {
  const enc = ['Prioridad', 'Código Único', 'Nombre de la inversión', 'Tipo inversión', 'Función', 'Estado', 'Monto Año 2026 (S/)', 'Monto Año 2027 (S/)'];
  const ws = XLSX.utils.aoa_to_sheet([
    ['PROGRAMACIÓN MULTIANUAL DE INVERSIONES 2027-2029'], ['Cartera de inversiones'], ['OPMI:', opmi], ['Fecha de reporte: 17/10/2026'], [],
    enc, ...filas]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Cartera');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const filaCartera = (cui, funcion = 'EDUCACIÓN') => [1, cui, 'MEJORAMIENTO DE LA IE ' + cui, 'IOARR', funcion, 'ACTIVO', 1051206, 0];

// Importa un archivo del PMI como lo hace POST /api/ioarr/importar
function importarPmi(buffer, opciones = { soloEducacion: true }) {
  const leido = leerArchivo(buffer);
  const mapeo = detectarMapeo(leido.headers);
  const { filas } = filtrarFilasPmi(leido.rows, mapeo, { ...opciones, periodo: leido.periodo_detectado });
  return { leido, mapeo, filas: deduplicarPorCui(filas).filas };
}

test('Cartera del PMI: encabezado en la fila 6, OPMI y periodo del banner, «Monto Año 2026» no es el periodo', () => {
  const { leido, mapeo, filas } = importarPmi(excelCarteraPmi('OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE', [filaCartera(2649342), filaCartera(' 2649343 '), filaCartera(2649344, 'SALUD')]));
  assert.equal(leido.fila_encabezado, 6);
  assert.equal(leido.opmi_detectada, 'OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE');
  assert.equal(leido.periodo_detectado, '2027-2029');
  assert.equal(mapeo.cui, 'Código Único');
  assert.equal(mapeo.periodo, null);
  assert.equal(mapeo.entidad, null);
  assert.deepEqual(filas.map(f => [f.cui, f.periodo]), [['2649342', '2027-2029'], ['2649343', '2027-2029']]);
});

test('limpiaCui: texto de solo dígitos (espacios, decimales, «.0», separadores); sin dígitos no es CUI', () => {
  for (const v of [2560356, '2560356', ' 2560356 ', '2560356.0', '2560356,00', '2,560,356', '2 560 356', 'CUI 2560356']) assert.equal(limpiaCui(v), '2560356', String(v));
  assert.equal(limpiaCui('idea0000110'), 'IDEA0000110');
  assert.equal(limpiaCui('Enlace'), null);
  assert.equal(limpiaCui(''), null);
  assert.equal(limpiaCui(null), null);
});

test('claveOpmi: la entidad del proyecto y la OPMI casan por equivalencia, no por texto idéntico', () => {
  const igual = (a, b) => assert.equal(claveOpmi(a), claveOpmi(b), `${a} ↔ ${b}`);
  igual('GOBIERNO REGIONAL LAMBAYEQUE', 'OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE');
  igual('Gobierno Regional de Lambayeque', 'OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE');
  igual('GOB. REGIONAL LAMBAYEQUE - SEDE CENTRAL', 'OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE');
  igual('MINISTERIO DE EDUCACION', 'OPMI DEL MINISTERIO DE EDUCACION');
  igual('MINISTERIO DE EDUCACIÓN', 'OPMI del Ministerio de Educación');
  igual('PROGRAMA NACIONAL DE INFRAESTRUCTURA EDUCATIVA - PRONIED', 'OPMI DEL MINISTERIO DE EDUCACION');
  igual('MUNICIPALIDAD PROVINCIAL CHICLAYO', 'OPMI de la Municipalidad Provincial de Chiclayo');
  assert.notEqual(claveOpmi('GOBIERNO REGIONAL LAMBAYEQUE'), claveOpmi('GOBIERNO REGIONAL LA LIBERTAD'));
  assert.equal(datosDelBanner([['OPMI: OPMI DEL MINISTERIO DE EDUCACION']]).opmi, 'OPMI DEL MINISTERIO DE EDUCACION');
});

test('CUI 2560356 (PMI del MINEDU) y 2649342 (PMI del GR Lambayeque) → «En PMI», aunque no haya carga del Banco', () => {
  const minedu = importarPmi(excelCarteraPmi('OPMI DEL MINISTERIO DE EDUCACION', [filaCartera(2560356), filaCartera(2560999)]));
  const lamba = importarPmi(excelCarteraPmi('OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE', [filaCartera(2649342)]));
  const datos = vistas([
    // La de Lambayeque se cargó antes: no debe perderse al cargar la del MINEDU
    { id: 'pmi-lamba', fuente: 'pmi', fecha_carga: '2026-10-17T20:36:01Z', nombre_archivo: 'Cartera_261017-112354.xlsx',
      opmi: lamba.leido.opmi_detectada, filtros: { solo_educacion: true, solo_ioarr: false }, filas: lamba.filas },
    { id: 'pmi-minedu', fuente: 'pmi', fecha_carga: '2026-10-17T20:47:21Z', nombre_archivo: 'Cartera_261017-111601.xlsx',
      opmi: minedu.leido.opmi_detectada, filtros: { solo_educacion: true, solo_ioarr: false }, filas: minedu.filas }
  ]);
  // Proyectos del radar importados del Banco antes de que existieran las cargas
  const proy = (cui, entidad, extra = {}) => ({ id: 'r' + cui, cui, nombre: 'IE ' + cui, entidad, funcion: 'EDUCACIÓN', tipo_inversion: 'IOARR', estado: 'viable', ...extra });
  datos.proyectos = [
    proy('2560356', 'MINISTERIO DE EDUCACION'),
    proy('2649342', 'GOBIERNO REGIONAL LAMBAYEQUE'),
    proy('2649400', 'GOBIERNO REGIONAL LAMBAYEQUE'),                  // su OPMI está cargada y el CUI no
    proy('2700001', 'GOBIERNO REGIONAL PIURA'),                       // su OPMI no se cargó
    proy('2649500', 'GOBIERNO REGIONAL LAMBAYEQUE', { funcion: 'SALUD' }), // la carga era solo Educación
    proy('2560999', 'MUNICIPALIDAD DISTRITAL DE OTRA')                // está en el PMI del MINEDU con otra entidad
  ];
  const { filas, pmi_cargados } = calcularCruce(datos);
  const s = Object.fromEntries(filas.map(f => [f.cui, f]));

  assert.equal(s['2560356'].en_pmi, 'si');
  assert.equal(s['2560356'].situacion, 'viable_pmi');
  assert.equal(s['2560356'].situacion_label, 'Viable, en PMI, sin OxI');
  assert.equal(s['2560356'].pmi_opmi, 'OPMI DEL MINISTERIO DE EDUCACION');
  assert.equal(s['2560356'].pmi_periodo, '2027-2029');

  assert.equal(s['2649342'].en_pmi, 'si');
  assert.equal(s['2649342'].situacion, 'viable_pmi');
  assert.equal(s['2649342'].pmi_opmi, 'OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE');
  assert.match(s['2649342'].motivo, /En el radar \(sin carga del Banco\), no en Proinversión\. En el PMI 2027-2029 de OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE/);

  // Regla 5: la OPMI de su entidad sí se cargó y el CUI no está → fuera del PMI
  assert.equal(s['2649400'].en_pmi, 'no');
  assert.equal(s['2649400'].situacion, 'viable_fuera_pmi');
  assert.equal(s['2649400'].en_pmi_motivo, null);
  // Sin verificar, con el motivo exacto
  assert.equal(s['2700001'].situacion, 'viable_pmi_sin_verificar');
  assert.equal(s['2700001'].en_pmi_motivo, 'opmi_no_cargada');
  assert.equal(s['2700001'].en_pmi_motivo_label, 'Su OPMI no fue cargada');
  assert.equal(s['2649500'].en_pmi_motivo, 'cui_no_encontrado');
  assert.equal(s['2649500'].en_pmi_motivo_label, 'CUI no encontrado');
  assert.match(s['2649500'].en_pmi_motivo_texto, /solo Educación y este proyecto es de la función «SALUD»/);
  // Regla 4: el CUI está en un PMI cargado aunque la entidad no case → «En PMI (del sector)», con nota, sin aviso
  assert.equal(s['2560999'].en_pmi, 'si');
  assert.equal(s['2560999'].situacion, 'viable_pmi');
  assert.equal(s['2560999'].pmi_del_sector, true);
  assert.equal(s['2560999'].pmi_opmi, 'OPMI DEL MINISTERIO DE EDUCACION');
  assert.deepEqual(s['2560999'].avisos, []);
  assert.deepEqual(s['2560999'].notas, ['Programado en el PMI de «OPMI DEL MINISTERIO DE EDUCACION», que no es la OPMI de su entidad ' +
    '«MUNICIPALIDAD DISTRITAL DE OTRA». Es frecuente en universidades públicas, cuyas inversiones se programan en el PMI del sector.']);
  assert.equal(s['2560356'].pmi_del_sector, false);
  assert.deepEqual(s['2560356'].notas, []);

  // Panel «PMI cargados»
  assert.deepEqual(pmi_cargados.cargas.map(c => [c.opmi, c.filas, c.vigente, c.proyectos_cubiertos, c.proyectos_en_pmi]), [
    ['OPMI DEL MINISTERIO DE EDUCACION', 2, true, 1, 2],
    ['OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE', 1, true, 3, 1]
  ]);
  assert.deepEqual(pmi_cargados.opmi_faltantes, [{ entidad: 'GOBIERNO REGIONAL PIURA', proyectos: 1 }]);
});

test('Una carga nueva de la misma OPMI reemplaza a la anterior; la de otra OPMI sigue contando', () => {
  const lamba1 = importarPmi(excelCarteraPmi('OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE', [filaCartera(2649342), filaCartera(2649400)]));
  const lamba2 = importarPmi(excelCarteraPmi('OPMI del Gobierno Regional de Lambayeque', [filaCartera(2649342)]));
  const minedu = importarPmi(excelCarteraPmi('OPMI DEL MINISTERIO DE EDUCACION', [filaCartera(2560356)]));
  const datos = vistas([
    { id: 'l1', fuente: 'pmi', fecha_carga: '2026-09-01T10:00:00Z', opmi: lamba1.leido.opmi_detectada, filas: lamba1.filas },
    { id: 'm1', fuente: 'pmi', fecha_carga: '2026-09-15T10:00:00Z', opmi: minedu.leido.opmi_detectada, filas: minedu.filas },
    { id: 'l2', fuente: 'pmi', fecha_carga: '2026-10-01T10:00:00Z', opmi: lamba2.leido.opmi_detectada, filas: lamba2.filas }
  ]);
  datos.proyectos = [
    { id: 'a', cui: '2649400', entidad: 'GOBIERNO REGIONAL LAMBAYEQUE', estado: 'viable' },
    { id: 'b', cui: '2560356', entidad: 'MINISTERIO DE EDUCACION', estado: 'viable' }
  ];
  const { filas, pmi_cargados } = calcularCruce(datos);
  const s = Object.fromEntries(filas.map(f => [f.cui, f]));
  assert.equal(s['2649400'].en_pmi, 'no');   // salió del PMI en la carga nueva de Lambayeque
  assert.equal(s['2560356'].en_pmi, 'si');   // la del MINEDU no se pierde por ser más antigua
  const l1 = pmi_cargados.cargas.find(c => c.id === 'l1');
  assert.equal(l1.vigente, false);
  assert.equal(l1.reemplazada_por.id, 'l2');
});

test('PMI del sector: una universidad en el PMI del MINEDU sigue «En PMI», nunca «sin verificar» ni «fuera»', () => {
  const minedu = importarPmi(excelCarteraPmi('OPMI DEL MINISTERIO DE EDUCACION', [filaCartera(2480001)]));
  const lamba = importarPmi(excelCarteraPmi('OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE', [filaCartera(2649342)]));
  const datos = vistas([
    { id: 'm', fuente: 'pmi', fecha_carga: '2026-10-17T20:47:21Z', opmi: minedu.leido.opmi_detectada, filas: minedu.filas },
    { id: 'u', fuente: 'pmi', fecha_carga: '2026-10-17T20:50:00Z', opmi: 'OPMI DE LA UNIVERSIDAD NACIONAL PEDRO RUIZ GALLO', filas: [{ cui: '2480002' }] },
    { id: 'l', fuente: 'pmi', fecha_carga: '2026-10-17T20:36:01Z', opmi: lamba.leido.opmi_detectada, filas: lamba.filas }
  ]);
  // Su propia OPMI está cargada y no lo tiene, y la OPMI de su GORE tampoco: igual está en el PMI del sector
  datos.proyectos = [{ id: 'x', cui: '2480001', entidad: 'UNIVERSIDAD NACIONAL PEDRO RUIZ GALLO', nombre: 'LABORATORIO DE LA FACULTAD DE AGRONOMIA', estado: 'viable' }];
  const f = calcularCruce(datos).filas.find(x => x.cui === '2480001');
  assert.equal(f.en_pmi, 'si');
  assert.equal(f.situacion, 'viable_pmi');
  assert.equal(f.pmi_del_sector, true);
  assert.equal(f.en_pmi_motivo, null);
  assert.equal(f.tipo_entidad, 'universidad');
  assert.match(f.notas[0], /^Programado en el PMI de «OPMI DEL MINISTERIO DE EDUCACION», que no es la OPMI de su entidad «UNIVERSIDAD NACIONAL PEDRO RUIZ GALLO»/);
});

test('tipoEntidad: separa colegios/UGEL de institutos, universidades y el resto', () => {
  const casos = [
    ['GOBIERNO REGIONAL LAMBAYEQUE', 'ADQUISICION DE MOBILIARIO; EN EL(LA) I.E. N° 10234 DISTRITO DE CHICLAYO', 'colegio_ugel'],
    ['MUNICIPALIDAD DISTRITAL DE SAN MARCOS', 'MEJORAMIENTO DE LA INSTITUCIÓN EDUCATIVA INICIAL 123', 'colegio_ugel'],
    ['MUNICIPALIDAD DISTRITAL DE X', 'MOBILIARIO EN EL(LA) IE SANTA ROSA', 'colegio_ugel'],
    ['GOBIERNO REGIONAL PUNO', 'EQUIPAMIENTO DE LA UGEL AZANGARO', 'colegio_ugel'],
    ['UGEL 03', 'OFICINAS', 'colegio_ugel'],
    ['GOBIERNO REGIONAL ICA', 'EQUIPO DE TALLER; EN EL(LA) INSTITUTO SUPERIOR TECNOLÓGICO PUBLICO NASCA', 'instituto'],
    ['GOBIERNO REGIONAL APURIMAC', 'SALA DE USOS MULTIPLES EN EL(LA) IESPP JOSE CARLOS MARIATEGUI', 'instituto'],
    ['UNIVERSIDAD NACIONAL DE PIURA', 'LABORATORIO DE QUIMICA', 'universidad'],
    ['UNIVERSIDAD NACIONAL DE EDUCACION ENRIQUE GUZMAN Y VALLE', 'AULAS DEL COLEGIO DE APLICACION', 'universidad'],
    ['GOBIERNO REGIONAL JUNIN', 'EDIFICACION EN EL(LA) DIRECCIÓN REGIONAL DE TRABAJO', 'gore'],
    ['MANCOMUNIDAD MUNICIPAL ECOTURISTICA', 'MIRADOR', 'municipalidad'],
    ['MINISTERIO DE EDUCACION', 'SISTEMA DE GESTION', 'ministerio'],
    ['CENTRO DE FORMACION EN TURISMO - CENFOTUR', 'AULAS', 'instituto'],
    ['GOBIERNO REGIONAL AMAZONAS', 'EQUIPAMIENTO DE AULA EN EL(LA) CENTRO TECNICO PRODUCTIVO CHACHAPOYAS', 'instituto'],
    ['GOBIERNO REGIONAL UCAYALI', 'ADQUISICION DE MOBILIARIO DE AULA; EN SETENTA Y CINCO A NIVEL DEPARTAMENTAL (UCAYALI)', 'colegio_ugel'],
    ['MUNICIPALIDAD DISTRITAL DE Y', 'EN EL(LA) PRESTACION DE SERVICIOS EDUCATIVOS EN EL AMBITO DISTRITAL', 'colegio_ugel'],
    ['SEGURO SOCIAL', 'OFICINAS', 'otra']
  ];
  for (const [entidad, nombre, tipo] of casos) assert.equal(tipoEntidad(entidad, nombre), tipo, `${entidad} | ${nombre}`);
});

// ─── Fuente de financiamiento y modalidad de ejecución ──────────────────────
// Consulta Avanzada con las dos columnas nuevas
function excelBancoFin(filas) {
  const enc = ['CÓDIGO ÚNICO DE INVERSIÓN', 'NOMBRE DE LA INVERSIÓN', 'ESTADO DE LA INVERSIÓN', 'ENTIDAD', 'FUNCIÓN',
    'COSTO ACTUALIZADO', 'DEVENGADO ACUMULADO', 'PIM 2026', 'FUENTE DE FINANCIAMIENTO', 'MODALIDAD DE EJECUCIÓN'];
  const ws = XLSX.utils.aoa_to_sheet([['CONSULTA AVANZADA DE INVERSIONES'], [], enc, ...filas]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Consulta');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('Banco con fuente y modalidad: se mapean solas y llegan al proyecto y a la carga', () => {
  const { headers, rows } = leerArchivo(excelBancoFin([[801, 'MOBILIARIO EN LA IE 801', 'ACTIVO', 'GOBIERNO REGIONAL PIURA', 'EDUCACIÓN', 100, 0, 0, 'RECURSOS ORDINARIOS', 'ADMINISTRACIÓN INDIRECTA - POR CONTRATA']]));
  const mapeo = detectarMapeo(headers);
  assert.equal(mapeo.fuente_financiamiento, 'FUENTE DE FINANCIAMIENTO');
  assert.equal(mapeo.modalidad_ejecucion, 'MODALIDAD DE EJECUCIÓN');
  const p = filaAProyecto(rows[0], mapeo, { fuente: 'invierte_pe' });
  assert.equal(p.fuente_financiamiento, 'RECURSOS ORDINARIOS');
  assert.equal(p.modalidad_ejecucion, 'ADMINISTRACIÓN INDIRECTA - POR CONTRATA');
  assert.equal(filaACarga(rows[0], mapeo).modalidad_ejecucion, 'ADMINISTRACIÓN INDIRECTA - POR CONTRATA');
});

test('Reglas: modalidad con IMPUESTOS = OxI; fuente pública o PIM > 0 = presupuesto público', () => {
  assert.ok(esModalidadOxi('OBRAS POR IMPUESTOS'));
  assert.ok(esModalidadOxi('Modalidad: Obras por Impuestos (OxI)'));
  assert.ok(!esModalidadOxi('ADMINISTRACION DIRECTA'));
  for (const f of ['RECURSOS ORDINARIOS', 'RECURSOS DIRECTAMENTE RECAUDADOS', 'RECURSOS DETERMINADOS', 'DONACIONES Y TRANSFERENCIAS', '1. RECURSOS ORDINARIOS'])
    assert.ok(esFuentePublica(f), f);
  for (const f of ['OBRAS POR IMPUESTOS', 'PRIVADO', 'NO ASIGNADO', '', null]) assert.ok(!esFuentePublica(f), String(f));
  assert.equal(financiamiento({ fuente: null, modalidad: null, pim: 5000 }).presupuesto_publico, true);
  assert.equal(financiamiento({ fuente: null, modalidad: null, pim: 0 }).presupuesto_publico, false);
  // Una OxI con fuente «Recursos determinados» (el CIPRL se paga con canon) sigue siendo OxI
  const oxi = financiamiento({ fuente: 'RECURSOS DETERMINADOS', modalidad: 'OBRAS POR IMPUESTOS', pim: 0 });
  assert.equal(oxi.oxi, true);
});

test('Cruce: OxI por modalidad → priorizada; presupuesto público en ejecución o con PIM → ejecución', () => {
  const banco = leerCarga(excelBancoFin([
    [901, 'IE 901', 'ACTIVO', 'GR PIURA', 'EDUCACIÓN', 100, 0, 0, 'RECURSOS DETERMINADOS', 'OBRAS POR IMPUESTOS'],          // OxI
    [902, 'IE 902', 'ACTIVO', 'GR PIURA', 'EDUCACIÓN', 100, 0, 250000, 'RECURSOS ORDINARIOS', 'ADMINISTRACION DIRECTA'],   // PIM > 0
    [903, 'IE 903', 'ACTIVO', 'GR PIURA', 'EDUCACIÓN', 100, 0, 0, 'RECURSOS ORDINARIOS', 'ADMINISTRACION INDIRECTA'],      // solo fuente pública
    [904, 'IE 904', 'ACTIVO', 'GR PIURA', 'EDUCACIÓN', 100, 0, 0, null, null],                                              // sin datos
    [905, 'IE 905', 'ACTIVO', 'GR PIURA', 'EDUCACIÓN', 100, 40000, 90000, 'RECURSOS DETERMINADOS', 'OBRAS POR IMPUESTOS']  // OxI con devengado
  ]));
  const datos = vistas([{ id: 'b1', fuente: 'invierte_pe', fecha_carga: '2026-10-15T10:00:00Z', filas: banco }]);
  // Sin carga del Banco: la modalidad de la ficha 07-C (guardada en el proyecto) también cuenta
  datos.proyectos = [{ id: 'r1', cui: '906', nombre: 'IE 906', entidad: 'GR PIURA', estado: 'viable', modalidad_ejecucion: 'OBRAS POR IMPUESTOS', fuente_financiamiento: null }];
  const s = Object.fromEntries(calcularCruce(datos).filas.map(f => [f.cui, f]));

  assert.equal(s['901'].situacion, 'priorizada');
  assert.match(s['901'].motivo, /Va por Obras por Impuestos: modalidad de ejecución «OBRAS POR IMPUESTOS»/);
  assert.equal(s['901'].es_oxi, true);
  assert.equal(s['901'].con_presupuesto_publico, true);   // fuente RD, pero manda OxI
  assert.equal(s['902'].situacion, 'ejecucion_descartada');
  assert.match(s['902'].motivo, /Con presupuesto público asignado en el Banco \(fuente «RECURSOS ORDINARIOS» y PIM S\/ 250,000\)/);
  assert.equal(s['903'].situacion, 'viable_pmi_sin_verificar');
  assert.equal(s['903'].con_presupuesto_publico, true);
  assert.match(s['903'].avisos.join(' '), /Con presupuesto público \(fuente «RECURSOS ORDINARIOS»\): podría financiarse sin OxI/);
  assert.equal(s['904'].con_presupuesto_publico, false);
  assert.equal(s['904'].es_oxi, false);
  assert.equal(s['905'].situacion, 'priorizada');
  assert.equal(s['906'].situacion, 'priorizada');
  assert.equal(s['906'].modalidad_ejecucion, 'OBRAS POR IMPUESTOS');
});
