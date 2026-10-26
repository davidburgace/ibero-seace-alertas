// Corre la prueba de punta a punta del origen del precio y del 07-C definitivo (test/integracion/origen-precio-api.mjs)
// en un proceso aparte: necesita --experimental-test-module-mocks para usar un Supabase en memoria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('origen del precio: estimación preliminar, promedio de cotizaciones, 07-C definitivo bloqueado con menos de 3 y transparencia de las bases', () => {
  const script = fileURLToPath(new URL('./integracion/origen-precio-api.mjs', import.meta.url));
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=spec', script], { encoding: 'utf8', timeout: 300000, env });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  assert.match(r.stdout, /ℹ pass 5/);
});
