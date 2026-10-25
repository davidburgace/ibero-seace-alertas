// Corre la prueba de punta a punta de las rutas del generador de bases (test/integracion/bases-api.mjs)
// en un proceso aparte: necesita --experimental-test-module-mocks para usar un Supabase en memoria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('rutas del generador de bases: ficha precargada, validación, versiones, comparación y duplicado', () => {
  const script = fileURLToPath(new URL('./integracion/bases-api.mjs', import.meta.url));
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=spec', script], { encoding: 'utf8', timeout: 300000, env });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  assert.match(r.stdout, /ℹ pass 6/);
});
