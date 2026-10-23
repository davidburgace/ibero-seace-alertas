// Selección por lista pegada de códigos (correr con: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prep, buscarCodigos } from '../src/selector-ioarr/calculo.js';

const D = prep(JSON.parse(readFileSync(new URL('../src/public/data/selector-ioarr/2025/moquegua.json', import.meta.url), 'utf8')));
const cod = i => D.locs[i][0];

test('códigos de local separados por saltos de línea, comas y espacios', () => {
  const [a, b, c] = [0, 1, 2].map(cod);
  const r = buscarCodigos(D, `${a}\n${b}, ${c}\r\n\t${a}`);
  assert.deepEqual(r.idx.map(cod), [a, b, c]);
  assert.equal(r.leidos, 3);
  assert.deepEqual(r.noEncontrados, []);
});

test('un código modular selecciona su local', () => {
  const s = D.svcs[0];
  const r = buscarCodigos(D, s[0]);
  assert.deepEqual(r.idx, [s[3]]);
  assert.equal(r.porModular, 1);
});

test('repone los ceros de la izquierda que borra Excel', () => {
  const s = D.svcs.find(s => s[0].startsWith('0') && !D.locs.some(l => l[0] === s[0].replace(/^0+/, '')));
  const r = buscarCodigos(D, s[0].replace(/^0+/, ''));
  assert.deepEqual(r.idx, [s[3]]);
});

test('dos servicios del mismo local cuentan una sola vez; los que no existen se devuelven', () => {
  const i = D.locSvc.findIndex(x => x.length > 1);
  const [m1, m2] = D.locSvc[i].map(si => D.svcs[si][0]);
  const r = buscarCodigos(D, `${m1} ${m2} 999999 abc`);
  assert.deepEqual(r.idx, [i]);
  assert.deepEqual(r.noEncontrados, ['999999']);
});
