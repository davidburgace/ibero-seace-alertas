// Visitas de campo — fichas en blanco para imprimir en un solo PDF (GET /api/campo/proyectos/:id/fichas-pdf)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { prep, calc, DEF } from '../src/selector-ioarr/calculo.js';
import { modeloFicha, generarFichaPdf } from '../src/selector-ioarr/ficha.js';
import { fichasParaImprimir, MAX_FICHAS_PDF } from '../src/selector-ioarr/campo.js';
import { supabaseMemoria } from './helpers/supabase-memoria.js';

const D = prep(JSON.parse(readFileSync(new URL('../src/public/data/selector-ioarr/2025/moquegua.json', import.meta.url), 'utf8')));
const C = calc(D, DEF);
const PID = '11111111-2222-3333-4444-555555555555';
const COD = ['398477', '397642', '398316'];
const META = { proyecto: { id: PID, nombre: 'Prueba' }, anio: 2025, fecha: '2026-11-21', supervisor: 'ana@ejemplo.invalid' };
const sb = () => supabaseMemoria({
  ioarr_selector_proyectos: [{ id: PID, usuario_id: 'prov-1', nombre: 'Prueba', region: 'Moquegua' }],
  ioarr_selector_locales: COD.map(c => ({ proyecto_id: PID, codigo_local: c })),
  campo_asignaciones: [{ proyecto_id: PID, codigo_local: '398477', supervisor_id: 'sup-1' }, { proyecto_id: PID, codigo_local: '397642', supervisor_id: 'sup-1' }, { proyecto_id: PID, codigo_local: '398316', supervisor_id: 'sup-2' }],
  perfiles: [{ id: 'sup-1', email: 'ana@ejemplo.invalid', rol: 'supervisor' }, { id: 'sup-2', email: 'beto@ejemplo.invalid', rol: 'supervisor' }]
});
const pedidos = [];
const DEPS = { modelos: async (_, cods) => { pedidos.push(cods); return Object.fromEntries(cods.map(c => [c, modeloFicha(D, C, D.locs.findIndex(l => l[0] === c), META)])); } };
const ANA = { id: 'sup-1', rol: 'supervisor' }, PROV = { id: 'prov-1', rol: 'proveedor' };
const paginas = async buf => (await PDFDocument.load(buf)).getPageCount();

test('fichas para imprimir: un solo PDF con las fichas pedidas, en ese orden', async () => {
  const solas = await Promise.all(['397642', '398477'].map(c => generarFichaPdf(modeloFicha(D, C, D.locs.findIndex(l => l[0] === c), META)).then(paginas)));
  const r = await fichasParaImprimir(sb(), ANA, PID, '397642,398477', DEPS);
  assert.equal(r.n, 2);
  assert.equal(await paginas(r.buffer), solas[0] + solas[1], 'todas las páginas de las dos fichas');
  assert.deepEqual(pedidos.at(-1), ['397642', '398477'], 'en el orden pedido');
  assert.match(r.nombre, /^Fichas_verificacion_2_colegios_\d{4}-\d\d-\d\d\.pdf$/);
  const una = await fichasParaImprimir(sb(), ANA, PID, '398477', DEPS);
  assert.equal(una.nombre, 'Ficha_verificacion_398477.pdf');
});

test('fichas para imprimir: el supervisor solo de sus colegios; el proveedor, de todo el proyecto', async () => {
  const r = await fichasParaImprimir(sb(), ANA, PID, '398316,398477', DEPS);
  assert.equal(r.n, 1, 'el colegio de otro supervisor no entra');
  assert.equal((await fichasParaImprimir(sb(), ANA, PID, '398316', DEPS)).status, 400);
  assert.equal((await fichasParaImprimir(sb(), PROV, PID, COD.join(','), DEPS)).n, 3);
  assert.equal((await fichasParaImprimir(sb(), { id: 'sup-9', rol: 'supervisor' }, PID, '398477', DEPS)).status, 404, 'sin colegios en el proyecto');
  assert.equal((await fichasParaImprimir(sb(), ANA, PID, '', DEPS)).status, 400);
});

test('fichas para imprimir: tope de fichas por PDF', async () => {
  const muchos = Array.from({ length: MAX_FICHAS_PDF + 1 }, (_, i) => String(500000 + i));
  const r = await fichasParaImprimir(supabaseMemoria({
    ioarr_selector_proyectos: [{ id: PID, usuario_id: 'prov-1', nombre: 'Prueba', region: 'Moquegua' }],
    ioarr_selector_locales: muchos.map(c => ({ proyecto_id: PID, codigo_local: c }))
  }), PROV, PID, muchos.join(','), DEPS);
  assert.equal(r.status, 400); assert.match(r.error, /Máximo 50/);
});
