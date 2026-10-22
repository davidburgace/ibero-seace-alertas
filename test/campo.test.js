// Rol supervisor de campo y página /campo.html: permisos, usuarios, migración y CSP
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { crearProteccionApi, bloquearSupervisor } from '../src/ioarr/auth.js';
import { ROLES, cambiarRol, invitarUsuario, correoInvitacion, AVISO_SUPERVISOR } from '../src/ioarr/usuarios.js';
import { cspSelector } from '../src/selector-ioarr/csp.js';
import ioarrRouter from '../src/ioarr/router.js';

const respuesta = () => {
  const res = { statusCode: 200, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
};
const leer = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('el supervisor no entra al resto de la API: Selector, Admin, SEACE (403)', () => {
  const proteger = crearProteccionApi((req, _, next) => { req.usuario = { rol: 'supervisor' }; next(); });
  for (const path of ['/selector-ioarr/proyectos', '/selector-ioarr/visitas.xlsx', '/admin/usuarios', '/bootstrap', '/infra/opportunities']) {
    const res = respuesta(); let paso = false;
    proteger({ path, headers: {} }, res, () => { paso = true; });
    assert.equal(paso, false, path); assert.equal(res.statusCode, 403, path);
  }
});

test('bloquearSupervisor: 403 al supervisor, pasan proveedor y financista', () => {
  for (const [rol, pasa] of [['supervisor', false], ['proveedor', true], ['financista', true]]) {
    const res = respuesta(); let paso = false;
    bloquearSupervisor({ usuario: { rol } }, res, () => { paso = true; });
    assert.equal(paso, pasa, rol);
    if (!pasa) { assert.equal(res.statusCode, 403); assert.match(res.body.error, /supervisor/); }
  }
});

test('Radar IOARR: el supervisor solo llega a /api/ioarr/me (el bloqueo va justo después)', () => {
  const capas = ioarrRouter.stack;
  const i = (pred) => capas.findIndex(pred);
  const iMe = i(l => l.route?.path === '/api/ioarr/me');
  const iBloqueo = i(l => l.handle?.name === 'bloquearSupervisor');
  assert.ok(iMe >= 0 && iBloqueo > iMe, 'el bloqueo va después de /me');
  const publicas = new Set(['/api/ioarr/config', '/ioarr/calculadora.js', '/api/ioarr/me']);
  const protegidas = capas.filter(l => l.route && String(l.route.path).startsWith('/api/ioarr') && !publicas.has(l.route.path));
  assert.ok(protegidas.length > 10);
  for (const l of protegidas) assert.ok(capas.indexOf(l) > iBloqueo, `${l.route.path} queda detrás del bloqueo`);
});

// ─── Usuarios ────────────────────────────────────────────────────────────────
function sbFalso({ errorUpsert = null } = {}) {
  const upserts = [];
  return {
    upserts,
    auth: { admin: {
      getUserById: async id => ({ data: { user: { id, email: 'sup@ibero.pe' } }, error: null }),
      createUser: async ({ email }) => ({ data: { user: { id: 'nuevo-1', email } }, error: null }),
      generateLink: async () => ({ data: { properties: { action_link: 'https://sb.test/v', hashed_token: 'h1' } }, error: null })
    } },
    from: () => ({ upsert: async (fila) => { upserts.push(fila); return { error: errorUpsert }; } })
  };
}

test('el rol supervisor existe y se puede asignar e invitar', async () => {
  assert.deepEqual(ROLES, ['proveedor', 'financista', 'supervisor']);
  const sb = sbFalso();
  const r = await cambiarRol(sb, { id: 'x', rol: 'supervisor', usuarioActual: { id: 'yo' } });
  assert.equal(r.status, 200); assert.equal(sb.upserts[0].rol, 'supervisor');
  const correos = [];
  const inv = await invitarUsuario(sbFalso(), async c => { correos.push(c); }, { email: 'campo@ibero.pe', rol: 'supervisor', baseUrl: 'https://radar.test' });
  assert.equal(inv.status, 201); assert.equal(inv.usuario.rol, 'supervisor');
  assert.match(correos[0].html, /Visitas de campo/);
});

test('sin la migración 020, asignar supervisor da un aviso claro (no un error 500)', async () => {
  const errorCheck = { code: '23514', message: 'new row for relation "perfiles" violates check constraint "perfiles_rol_check"' };
  const r = await cambiarRol(sbFalso({ errorUpsert: errorCheck }), { id: 'x', rol: 'supervisor', usuarioActual: { id: 'yo' } });
  assert.deepEqual(r, { status: 503, error: AVISO_SUPERVISOR });
  const inv = await invitarUsuario(sbFalso({ errorUpsert: errorCheck }), async () => {}, { email: 'c@ibero.pe', rol: 'supervisor', baseUrl: 'https://radar.test' });
  assert.equal(inv.status, 503); assert.match(inv.error, /020_rol_supervisor/); assert.match(inv.error, /financista/);
  // otros errores no se disfrazan
  await assert.rejects(cambiarRol(sbFalso({ errorUpsert: { code: '42501', message: 'otro' } }), { id: 'x', rol: 'supervisor', usuarioActual: { id: 'yo' } }));
});

test('correo de invitación según el rol', () => {
  const acceso = rol => correoInvitacion({ email: 'a@b.pe', enlace: 'https://x', rol }).html;
  assert.match(acceso('proveedor'), /todo el Radar Ibero/);
  assert.match(acceso('financista'), /Radar IOARR/);
  assert.match(acceso('supervisor'), /Visitas de campo/);
});

test('migración 020: amplía el CHECK de perfiles.rol con supervisor', () => {
  const sql = leer('supabase/migrations/020_rol_supervisor.sql');
  assert.match(sql, /drop constraint if exists perfiles_rol_check/);
  assert.match(sql, /check \(rol in \('proveedor', 'financista', 'supervisor'\)\)/);
});

// ─── Páginas ─────────────────────────────────────────────────────────────────
test('solo /campo.html acepta al supervisor; las demás páginas con sesión son solo para proveedor', () => {
  const paginas = readdirSync(new URL('../src/public/', import.meta.url)).filter(f => f.endsWith('.html'));
  for (const f of paginas) {
    const html = leer('src/public/' + f);
    const tag = html.match(/<script src="\/sesion\.js"([^>]*)><\/script>/);
    if (!tag) continue;
    const roles = (tag[1].match(/data-roles="([^"]*)"/) || [, 'proveedor'])[1].split(',');
    if (f === 'campo.html') assert.deepEqual(roles, ['proveedor', 'supervisor']);
    else assert.ok(!roles.includes('supervisor'), f);
  }
});

test('sesion.js manda a cada rol a su inicio', () => {
  const js = leer('src/public/sesion.js');
  assert.match(js, /supervisor: '\/campo\.html'/);
  assert.match(js, /financista: '\/ioarr\.html'/);
  // Radar IOARR y el inicio tienen su propio control: también mandan al supervisor a campo
  assert.match(leer('src/public/ioarr.html'), /usuario\.rol === 'supervisor'\) \{ location\.replace\('\/campo\.html'\)/);
  assert.match(leer('src/public/index.html'), /me\?\.rol === 'supervisor'\) \{ location\.replace\('\/campo\.html'\)/);
});

test('la página de campo no usa la API ni guarda nada en el servidor', () => {
  const js = leer('src/public/campo.js');
  assert.ok(!/fetch\(['"`]\/api\//.test(js), 'sin llamadas a /api');
  assert.ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)/.test(js));
});

test('CSP también en /campo.html', () => {
  const h = {};
  cspSelector({ path: '/campo.html' }, { set: (k, v) => { h[k] = v; } }, () => {});
  assert.match(h['Content-Security-Policy'], /img-src 'self' data: https:\/\/server\.arcgisonline\.com/);
});
