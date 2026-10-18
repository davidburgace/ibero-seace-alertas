// Pruebas de la protección de la API (src/ioarr/auth.js) sin llamar a Supabase
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearProteccionApi, requireRol } from '../src/ioarr/auth.js';

// res falso que guarda el status y el cuerpo
const respuesta = () => {
  const res = { statusCode: 200, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
};
// Autenticación falsa: el header "Bearer prov" es proveedor, "Bearer fin" es financista
const autenticarFalso = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Inicia sesión' });
  req.usuario = { rol: token === 'prov' ? 'proveedor' : 'financista' };
  next();
};
const proteger = crearProteccionApi(autenticarFalso);
const llamar = (path, token) => {
  const req = { path, headers: token ? { authorization: 'Bearer ' + token } : {} };
  const res = respuesta();
  let paso = false;
  proteger(req, res, err => { if (err) throw err; paso = true; });
  return { paso, status: res.statusCode };
};

test('sin sesión, las rutas de la API responden 401', () => {
  for (const p of ['/bootstrap', '/admin/vendors', '/jobs/send-digest', '/interes', '/infra/opportunities', '/opportunities/1/ask']) {
    assert.deepEqual(llamar(p), { paso: false, status: 401 }, p);
  }
});

test('un financista no entra al resto de la API (403)', () => {
  assert.deepEqual(llamar('/bootstrap', 'fin'), { paso: false, status: 403 });
});

test('un proveedor entra', () => {
  assert.deepEqual(llamar('/bootstrap', 'prov'), { paso: true, status: 200 });
  assert.deepEqual(llamar('/admin/keywords/3', 'prov'), { paso: true, status: 200 });
});

test('/api/health y /api/ioarr/* pasan sin este control (IOARR tiene el suyo)', () => {
  assert.equal(llamar('/health').paso, true);
  assert.equal(llamar('/ioarr/config').paso, true);
  assert.equal(llamar('/ioarr/proyectos').paso, true);
});

test('rutas parecidas a las excepciones no se cuelan', () => {
  assert.equal(llamar('/healthz').paso, false);
  assert.equal(llamar('/ioarr').paso, false);
  assert.equal(llamar('/ioarrx/algo').paso, false);
});

test('requireRol deja pasar solo los roles indicados', () => {
  const res = respuesta();
  let paso = false;
  requireRol('proveedor')({ usuario: { rol: 'financista' } }, res, () => { paso = true; });
  assert.equal(paso, false);
  assert.equal(res.statusCode, 403);
});
