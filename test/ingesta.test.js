// Pruebas de las funciones puras de ingestión (correr con: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  parseMonto, mapEstado, resolverEstado, detectarMapeo, filaAProyecto, leerArchivo, esMobiliario
} from '../src/ioarr/ingesta.js';

test('parseMonto entiende formatos peruanos e ingleses', () => {
  assert.equal(parseMonto(1500.5), 1500.5);
  assert.equal(parseMonto('1,234,567.89'), 1234567.89);
  assert.equal(parseMonto('1.234.567,89'), 1234567.89);
  assert.equal(parseMonto('S/ 250,000'), 250000);
  assert.equal(parseMonto('1234,5'), 1234.5);
  assert.equal(parseMonto(''), null);
});

test('resolverEstado solo avanza y respeta estados finales', () => {
  assert.equal(resolverEstado('convenio', 'viable'), 'convenio');
  assert.equal(resolverEstado('viable', 'priorizada_oxi'), 'priorizada_oxi');
  assert.equal(resolverEstado('en_ejecucion', 'descartada'), 'descartada');
  assert.equal(resolverEstado('descartada', 'viable'), 'descartada');
  assert.equal(resolverEstado(null, 'viable'), 'viable');
});

test('mapEstado reconoce textos de las fuentes', () => {
  assert.equal(mapEstado('ACTIVO'), 'viable');
  assert.equal(mapEstado('Desactivado'), 'descartada');
  assert.equal(mapEstado('Priorizado'), 'priorizada_oxi');
  assert.equal(mapEstado('Convenio suscrito'), 'convenio');
  assert.equal(mapEstado('xyz'), null);
});

test('detectarMapeo y filaAProyecto con un exporte típico', () => {
  const headers = ['CODIGO_UNICO', 'NOMBRE_INVERSION', 'TIPO_FORMATO', 'NIVEL', 'ENTIDAD', 'DEPARTAMENTO', 'PROVINCIA', 'DISTRITO', 'FUNCION', 'COSTO_ACTUALIZADO', 'ESTADO'];
  const m = detectarMapeo(headers);
  assert.equal(m.cui, 'CODIGO_UNICO');
  assert.equal(m.nombre, 'NOMBRE_INVERSION');
  assert.equal(m.tipo_inversion, 'TIPO_FORMATO');
  assert.equal(m.monto_inversion, 'COSTO_ACTUALIZADO');
  assert.equal(m.region, 'DEPARTAMENTO');

  const p = filaAProyecto({
    CODIGO_UNICO: 2512345, NOMBRE_INVERSION: 'Adquisición de mobiliario escolar; en la IE 10123 Chiclayo',
    TIPO_FORMATO: 'IOARR', NIVEL: 'GL', ENTIDAD: 'Municipalidad Provincial de Chiclayo', DEPARTAMENTO: 'Lambayeque',
    PROVINCIA: 'Chiclayo', DISTRITO: 'Chiclayo', FUNCION: 'EDUCACION', COSTO_ACTUALIZADO: '350,000.00', ESTADO: 'ACTIVO'
  }, m, { fuente: 'invierte_pe' });
  assert.equal(p.cui, '2512345');
  assert.equal(p.region, 'LAMBAYEQUE');
  assert.equal(p.entidad_tipo, 'GL');
  assert.equal(p.tipo_inversion, 'IOARR');
  assert.equal(p.monto_inversion, 350000);
  assert.equal(p.estado, 'viable');
  assert.equal(p.es_mobiliario, true);
});

test('Proinversión implica al menos priorizada_oxi', () => {
  const p = filaAProyecto({ CUI: '1', NOMBRE: 'X' }, { cui: 'CUI', nombre: 'NOMBRE' }, { fuente: 'proinversion' });
  assert.equal(p.estado, 'priorizada_oxi');
});

test('leerArchivo salta filas de título', () => {
  const ws = XLSX.utils.aoa_to_sheet([['Reporte Banco de Inversiones'], [], ['CUI', 'NOMBRE'], ['123', 'Mobiliario']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'h');
  const { headers, rows } = leerArchivo(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  assert.deepEqual(headers, ['CUI', 'NOMBRE']);
  assert.equal(rows.length, 1);
  assert.equal(esMobiliario('ADQUISICION DE CARPETAS'), true);
});
