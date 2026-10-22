// Rol supervisor de campo y página /campo.html: permisos, usuarios, migración y CSP
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { crearProteccionApi, bloquearSupervisor } from '../src/ioarr/auth.js';
import { ROLES, cambiarRol, invitarUsuario, correoInvitacion, AVISO_SUPERVISOR } from '../src/ioarr/usuarios.js';
import { cspSelector } from '../src/selector-ioarr/csp.js';
import ioarrRouter from '../src/ioarr/router.js';
import { listarProyectosCampo, proyectoCampo, crearApiCampo, listarVisitas, marcarVisita, desmarcarVisita, fechaVisita, hoyPeru, AVISO_MIGRACION_VISITAS } from '../src/selector-ioarr/campo.js';

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

test('la página de campo solo usa /api/campo/* y solo escribe las visitas', () => {
  const js = leer('src/public/campo.js');
  const rutas = [...js.matchAll(/['"`](\/api\/[^'"`$]*)/g)].map(m => m[1]);
  assert.ok(rutas.length > 0);
  for (const r of rutas) assert.match(r, /^\/api\/campo\//, r);
  const metodos = [...js.matchAll(/method:\s*['"](\w+)/g)].map(m => m[1]).sort();
  assert.deepEqual(metodos, ['DELETE', 'PUT']);
  assert.ok(!/method:\s*['"](POST|PATCH)/.test(js));
});

test('CSP también en /campo.html', () => {
  const h = {};
  cspSelector({ path: '/campo.html' }, { set: (k, v) => { h[k] = v; } }, () => {});
  assert.match(h['Content-Security-Policy'], /img-src 'self' data: https:\/\/server\.arcgisonline\.com/);
});

test('campo: ruta del día en Google Maps y sin KML', () => {
  const js = leer('src/public/campo.js'), html = leer('src/public/campo.html');
  assert.match(js, /tramosRutaDia/);
  assert.match(js, /Ruta del día en Google Maps/);
  assert.doesNotMatch(js + html, /kml/i);
});

// ─── Proyectos del Selector en Visitas de campo ─────────────────────────────
test('/api/campo/*: entran proveedor y supervisor; financista no', () => {
  for (const [rol, pasa] of [['proveedor', true], ['supervisor', true], ['financista', false]]) {
    const proteger = crearProteccionApi((req, _, next) => { req.usuario = { rol }; next(); });
    const res = respuesta(); let paso = false;
    proteger({ path: '/campo/proyectos', headers: {} }, res, () => { paso = true; });
    assert.equal(paso, pasa, rol);
  }
  // el resto de la API sigue cerrada al supervisor
  const proteger = crearProteccionApi((req, _, next) => { req.usuario = { rol: 'supervisor' }; next(); });
  const res = respuesta(); let paso = false;
  proteger({ path: '/campos', headers: {} }, res, () => { paso = true; });
  assert.equal(paso, false);
});

// Supabase falso: registra los filtros de cada consulta
const UUID = '11111111-2222-3333-4444-555555555555';
function sbProyectos({ proyectos = [], locales = [] } = {}) {
  const consultas = [];
  const from = tabla => {
    const q = { tabla, eq: {}, rango: null };
    consultas.push(q);
    const b = {
      select: () => b, order: () => b,
      eq: (k, v) => { q.eq[k] = v; return b; },
      range: (a, z) => { q.rango = [a, z]; return b; },
      maybeSingle: async () => ({ data: filtrar()[0] || null, error: null }),
      then: (ok, mal) => Promise.resolve(tabla === 'ioarr_selector_locales'
        ? { data: locales.slice(q.rango[0], q.rango[1] + 1).map(c => ({ codigo_local: c })), error: null }
        : { data: filtrar(), error: null }).then(ok, mal)
    };
    const filtrar = () => proyectos.filter(p => Object.entries(q.eq).every(([k, v]) => p[k] === v));
    return b;
  };
  return { from, consultas };
}
const PROYS = [
  { id: UUID, usuario_id: 'prov-1', nombre: 'Moquegua 2026', region: 'Moquegua', locales: [{ count: 3 }] },
  { id: 'otro', usuario_id: 'prov-2', nombre: 'Tacna', region: 'Tacna', locales: [{ count: 9 }] }
];

test('campo: el proveedor ve solo sus proyectos; el supervisor, todos (sin datos de más)', async () => {
  const prov = await listarProyectosCampo(sbProyectos({ proyectos: PROYS }), { id: 'prov-1', rol: 'proveedor' });
  assert.deepEqual(prov, [{ id: UUID, nombre: 'Moquegua 2026', region: 'Moquegua', n_locales: 3 }]);
  const sup = await listarProyectosCampo(sbProyectos({ proyectos: PROYS }), { id: 'sup-1', rol: 'supervisor' });
  assert.equal(sup.length, 2);
  for (const p of sup) assert.deepEqual(Object.keys(p).sort(), ['id', 'n_locales', 'nombre', 'region']);
});

test('campo: abrir un proyecto trae todos sus códigos (por lotes) y respeta al dueño', async () => {
  const locales = Array.from({ length: 2500 }, (_, i) => String(100000 + i));
  const p = await proyectoCampo(sbProyectos({ proyectos: PROYS, locales }), { id: 'prov-1', rol: 'proveedor' }, UUID);
  assert.equal(p.nombre, 'Moquegua 2026'); assert.equal(p.locales.length, 2500); assert.equal(p.locales[2499], '102499');
  assert.equal(await proyectoCampo(sbProyectos({ proyectos: PROYS }), { id: 'prov-2', rol: 'proveedor' }, UUID), null);
  assert.ok(await proyectoCampo(sbProyectos({ proyectos: PROYS }), { id: 'sup-1', rol: 'supervisor' }, UUID));
  assert.equal(await proyectoCampo(sbProyectos({ proyectos: PROYS }), { id: 'sup-1', rol: 'supervisor' }, 'no-es-uuid'), null);
});

test('campo: la API solo lee proyectos; lo único que escribe son las visitas', () => {
  const rutas = crearApiCampo(sbProyectos()).stack.filter(l => l.route)
    .map(l => `${Object.keys(l.route.methods).join(',')} ${l.route.path}`).sort();
  assert.deepEqual(rutas, ['delete /visitas/:codigo', 'get /proyectos', 'get /proyectos/:id', 'get /visitas', 'put /visitas/:codigo']);
});

test('campo: el worker limita la búsqueda a los colegios del proyecto', () => {
  const js = leer('src/public/selector-ioarr-worker.js');
  assert.match(js, /limitar\(\{ codigos \}\)/);
  assert.match(js, /if \(solo\) view = view\.filter/);
  assert.match(js, /view = \[\]; solo = null;/, 'cargar otra región quita el límite');
});

// ─── Colegios visitados ─────────────────────────────────────────────────────
function sbVisitas(filas = [], { error = null } = {}) {
  const ops = [];
  const from = tabla => {
    assert.equal(tabla, 'campo_visitas');
    const q = { eq: {}, rango: null, borrar: false };
    const b = {
      select: () => b, order: () => b,
      eq: (k, v) => { q.eq[k] = v; return b; },
      range: (a, z) => { q.rango = [a, z]; return b; },
      maybeSingle: async () => ({ data: error ? null : filas.find(f => f.codigo_local === q.eq.codigo_local) || null, error }),
      upsert: async (fila, o) => { ops.push({ upsert: fila, o }); return { error }; },
      delete: () => { q.borrar = true; return b; },
      then: (ok, mal) => {
        if (q.borrar) { ops.push({ borrar: q.eq.codigo_local }); return Promise.resolve({ error }).then(ok, mal); }
        return Promise.resolve(error ? { data: null, error } : { data: filas.slice(q.rango[0], q.rango[1] + 1), error: null }).then(ok, mal);
      }
    };
    return b;
  };
  return { from, ops };
}
const SUP = { id: 'sup-1', email: 'sup@ibero.pe', rol: 'supervisor' };

test('visitas: fecha de hoy en Perú y validación de la fecha', () => {
  assert.equal(hoyPeru(Date.parse('2026-10-23T03:00:00Z')), '2026-10-22'); // 22:00 en Lima
  assert.equal(fechaVisita(undefined, '2026-10-22'), '2026-10-22');
  assert.equal(fechaVisita('2026-10-01', '2026-10-22'), '2026-10-01');
  for (const f of ['2026-10-23', '2019-12-31', '2026-02-30', '22/10/2026', 'x']) assert.equal(fechaVisita(f, '2026-10-22'), null, f);
});

test('visitas: listar trae todas (por lotes) y marca las propias', async () => {
  const filas = Array.from({ length: 1500 }, (_, i) => ({ codigo_local: String(200000 + i), fecha: '2026-10-20', visitado_por: i % 2 ? 'sup-1' : 'otro', visitado_por_email: 'x@ibero.pe' }));
  const m = await listarVisitas(sbVisitas(filas), SUP);
  assert.equal(Object.keys(m).length, 1500);
  assert.deepEqual(m['200001'], { fecha: '2026-10-20', por: 'x@ibero.pe', mia: true });
  assert.equal(m['200000'].mia, false);
});

test('visitas: marcar guarda quién y cuándo; valida código y fecha', async () => {
  const sb = sbVisitas();
  const r = await marcarVisita(sb, SUP, '276008', { fecha: '2026-10-01' });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { codigo: '276008', fecha: '2026-10-01', por: 'sup@ibero.pe', mia: true });
  assert.equal(sb.ops[0].o.onConflict, 'codigo_local');
  assert.equal(sb.ops[0].upsert.visitado_por, 'sup-1');
  assert.equal((await marcarVisita(sb, SUP, 'abc')).status, 400);
  assert.equal((await marcarVisita(sb, SUP, '276008', { fecha: '2099-01-01' })).status, 400);
  assert.equal(sb.ops.length, 1);
});

test('visitas: el supervisor solo desmarca lo suyo; el proveedor, cualquiera', async () => {
  const filas = [{ codigo_local: '111111', visitado_por: 'sup-1' }, { codigo_local: '222222', visitado_por: 'otro' }];
  const sb = sbVisitas(filas);
  assert.equal((await desmarcarVisita(sb, SUP, '111111')).status, 200);
  assert.equal((await desmarcarVisita(sb, SUP, '222222')).status, 403);
  assert.equal((await desmarcarVisita(sb, { id: 'prov-1', rol: 'proveedor' }, '222222')).status, 200);
  assert.deepEqual((await desmarcarVisita(sb, SUP, '333333')).body, { codigo: '333333', borrado: false });
  assert.deepEqual(sb.ops, [{ borrar: '111111' }, { borrar: '222222' }]);
});

test('visitas: sin la migración 021, aviso claro (503)', async () => {
  const api = crearApiCampo(sbVisitas([], { error: { code: 'PGRST205', message: 'Could not find the table in the schema cache' } }));
  const capa = api.stack.find(l => l.route?.path === '/visitas' && l.route.methods.get);
  const res = respuesta();
  await new Promise(ok => { res.json = b => { res.body = b; ok(); return res; }; capa.route.stack[0].handle({ usuario: SUP }, res, ok); });
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, AVISO_MIGRACION_VISITAS);
});

test('migración 021: tabla campo_visitas con RLS y sin políticas', () => {
  const sql = leer('supabase/migrations/021_campo_visitas.sql');
  assert.match(sql, /create table if not exists public\.campo_visitas/);
  assert.match(sql, /codigo_local\s+text primary key/);
  assert.match(sql, /enable row level security/);
  assert.doesNotMatch(sql, /create policy/);
});

test('campo: el worker omite los visitados si se pide', () => {
  const js = leer('src/public/selector-ioarr-worker.js');
  assert.match(js, /omitir\(\{ codigos \}\)/);
  assert.match(js, /if \(omitir\) view = view\.filter/);
});
