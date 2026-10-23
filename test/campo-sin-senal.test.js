// Visitas de campo sin señal: sesión recordada, service worker, manifiesto y fichas llevadas al equipo
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fichasParaEquipo, MAX_FICHAS_EQUIPO, GUIA_FICHA } from '../src/selector-ioarr/campo.js';

const leer = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const SESION = leer('src/public/sesion.js');

// Ejecuta sesion.js con una red que falla (o responde) y un localStorage dado
function cargarSesion({ dataset = { roles: 'proveedor,supervisor', sinSenal: '' }, guardado = {}, red = 'falla', online = false } = {}) {
  const ls = new Map(Object.entries(guardado).map(([k, v]) => [k, JSON.stringify(v)]));
  const fuera = { redirigido: null, alertas: [] };
  const fetchFalso = async url => {
    if (red === 'falla') throw new TypeError('Failed to fetch');
    if (String(url).endsWith('/config')) return { ok: true, json: async () => ({ supabaseUrl: 'https://x.supabase.co', supabaseKey: 'k' }) };
    return { ok: true, status: 200, json: async () => ({ id: 'u-1', email: 'ana@ibero.pe', rol: 'supervisor' }) };
  };
  const window = {
    fetch: fetchFalso,
    supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }), signOut: async () => {} } }) }
  };
  const ctx = {
    window, document: { currentScript: { dataset }, documentElement: { style: {} } },
    location: { origin: 'https://radar.test', href: 'https://radar.test/campo.html', pathname: '/campo.html', search: '', hash: '', replace: u => { fuera.redirigido = u; } },
    localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) },
    navigator: { onLine: online }, alert: m => fuera.alertas.push(m), URL, Headers, Request: class {}, console
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(SESION, ctx);
  return { sesion: window.radarSesion, ls, fuera, ctx };
}
const RECIENTE = { 'radar:usuario': { id: 'u-1', email: 'ana@ibero.pe', rol: 'supervisor', verificado: Date.now() - 3 * 864e5 }, 'radar:cfg': { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'k' } };

test('sesión sin señal: abre con el usuario recordado en el equipo', async () => {
  const { sesion, fuera, ctx } = cargarSesion({ guardado: RECIENTE });
  const u = await sesion.usuario();
  assert.deepEqual({ ...u }, { id: 'u-1', email: 'ana@ibero.pe', rol: 'supervisor', sin_conexion: true });
  assert.equal(ctx.document.documentElement.style.visibility, '', 'la página se muestra');
  assert.equal(fuera.redirigido, null); assert.deepEqual(fuera.alertas, []);
});

test('sesión sin señal: no abre si la página no lo permite, si el usuario venció o si es de otro rol', async () => {
  const sinPermiso = cargarSesion({ dataset: { roles: 'proveedor,supervisor' }, guardado: RECIENTE });
  await assert.rejects(sinPermiso.sesion.usuario());
  const vencido = cargarSesion({ guardado: { ...RECIENTE, 'radar:usuario': { ...RECIENTE['radar:usuario'], verificado: Date.now() - 40 * 864e5 } } });
  await assert.rejects(vencido.sesion.usuario());
  const otroRol = cargarSesion({ dataset: { roles: 'proveedor', sinSenal: '' }, guardado: RECIENTE });
  await assert.rejects(otroRol.sesion.usuario());
  const nada = cargarSesion();
  await assert.rejects(nada.sesion.usuario());
});

test('sesión con señal: recuerda al usuario verificado y la configuración; «Salir» lo olvida', async () => {
  const { sesion, ls, fuera } = cargarSesion({ red: 'ok', online: true });
  const u = await sesion.usuario();
  assert.equal(u.rol, 'supervisor'); assert.equal(u.sin_conexion, undefined);
  const g = JSON.parse(ls.get('radar:usuario'));
  assert.equal(g.id, 'u-1'); assert.ok(Date.now() - g.verificado < 5000);
  assert.deepEqual(JSON.parse(ls.get('radar:cfg')), { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'k' });
  await sesion.salir();
  assert.equal(ls.has('radar:usuario'), false); assert.equal(fuera.redirigido, '/login.html');
});

test('service worker: guarda la página y sus scripts, los datos de la región, y no toca la API', () => {
  const sw = leer('src/public/campo-sw.js');
  for (const f of ['/campo.html', '/campo.js', '/campo-ficha.js', '/campo-fotos.js', '/campo-equipo.js', '/campo.css', '/sesion.js', '/selector-ioarr-worker.js', '/selector-ioarr/calculo.js', '/campo.webmanifest'])
    assert.ok(sw.includes(`'${f}'`), f);
  assert.match(sw, /if \(url\.pathname\.startsWith\('\/api\/'\)\) return;/);
  assert.match(sw, /\/data\/selector-ioarr\//);
  assert.match(sw, /req\.method !== 'GET'/);
  // Cada archivo que importa la página está en la precarga
  const js = ['src/public/campo.js', 'src/public/campo-ficha.js', 'src/public/campo-fotos.js'].map(leer).join('\n');
  for (const [, f] of js.matchAll(/from '(\/[^']+)'/g)) assert.ok(sw.includes(`'${f}'`), `precarga de ${f}`);
  const m = JSON.parse(leer('src/public/campo.webmanifest'));
  assert.equal(m.start_url, '/campo.html'); assert.equal(m.scope, '/campo'); assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some(i => i.sizes === '512x512'));
  const html = leer('src/public/campo.html');
  assert.match(html, /<link rel="manifest" href="\/campo\.webmanifest">/);
  assert.match(html, /data-roles="proveedor,supervisor" data-sin-senal/);
  assert.match(leer('src/public/campo.js'), /serviceWorker\.register\('\/campo-sw\.js', \{ scope: '\/campo' \}\)/);
  assert.match(leer('src/public/campo-equipo.js'), /indexedDB\.open\(DB, VERSION\)/);
});

// ─── Fichas al equipo ───────────────────────────────────────────────────────
const UUID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
function sb({ sinFichas = false, sinFotos = false } = {}) {
  const tablas = {
    ioarr_selector_proyectos: [{ id: UUID, usuario_id: 'prov-1', nombre: 'Moquegua 2026', region: 'Moquegua' }],
    ioarr_selector_locales: ['100001', '100002', '100003'].map(c => ({ proyecto_id: UUID, codigo_local: c })),
    perfiles: [{ id: 'sup-1', email: 'ana@ibero.pe' }, { id: 'sup-2', email: 'beto@ibero.pe' }],
    campo_asignaciones: [{ proyecto_id: UUID, codigo_local: '100001', supervisor_id: 'sup-1' }, { proyecto_id: UUID, codigo_local: '100002', supervisor_id: 'sup-1' }, { proyecto_id: UUID, codigo_local: '100003', supervisor_id: 'sup-2' }],
    campo_fichas: [{ proyecto_id: UUID, codigo_local: '100001', estado: 'observada', datos: { a: { verificador: 'Ana' } }, nota_revision: 'Recuenta', editado_por: 'sup-1' }],
    campo_fichas_fotos: [{ id: 'f1', proyecto_id: UUID, codigo_local: '100001', aula: null, muestra: 'Fachada y letrero', ruta: 'x', mime: 'image/jpeg' }],
    campo_fichas_firmas: []
  };
  const from = t => {
    const q = { eq: {}, in: null, rango: null };
    const filtrar = () => tablas[t].filter(f => Object.entries(q.eq).every(([k, v]) => f[k] === v) && (!q.in || q.in[1].includes(f[q.in[0]])));
    const err = (sinFichas && t === 'campo_fichas') || (sinFotos && t === 'campo_fichas_fotos') ? { code: '42P01', message: `relation "${t}" does not exist` } : null;
    const b = {
      select: () => b, order: () => b, eq: (k, v) => { q.eq[k] = v; return b; }, in: (k, v) => { q.in = [k, v]; return b; }, range: (a, z) => { q.rango = [a, z]; return b; },
      maybeSingle: async () => err ? { data: null, error: err } : { data: filtrar()[0] || null, error: null },
      then: (ok, mal) => Promise.resolve(err ? { data: null, error: err } : { data: q.rango ? filtrar().slice(q.rango[0], q.rango[1] + 1) : filtrar(), error: null }).then(ok, mal)
    };
    return b;
  };
  return { from };
}
const DEPS = { modelos: async (_, cods) => Object.fromEntries(cods.map(c => [c, { local: { cod: c }, aulas: [] }])) };

test('llevar al equipo: el supervisor recibe solo sus colegios, con lo llenado, fotos y firmas', async () => {
  const r = await fichasParaEquipo(sb(), { id: 'sup-1', rol: 'supervisor' }, UUID, '100003', DEPS);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.fichas.map(f => f.cod), ['100001', '100002'], 'pide otro colegio y recibe los suyos');
  const [a, b] = r.body.fichas;
  assert.equal(a.ficha.estado, 'observada'); assert.equal(a.ficha.nota, 'Recuenta'); assert.equal(a.editable, true); assert.equal('por_id' in a.ficha, false);
  assert.equal(a.fotos.length, 1); assert.deepEqual(a.firmas, {});
  assert.equal(b.ficha, null); assert.deepEqual(b.fotos, []); assert.equal(b.editable, true);
  assert.deepEqual(r.body.guia, GUIA_FICHA); assert.equal(r.body.proyecto.region, 'Moquegua'); assert.ok(r.body.bajada_en);
});

test('llevar al equipo: el proveedor elige los colegios; límites y migraciones', async () => {
  const prov = { id: 'prov-1', rol: 'proveedor' };
  assert.deepEqual((await fichasParaEquipo(sb(), prov, UUID, '100003,999999', DEPS)).body.fichas.map(f => f.cod), ['100003']);
  assert.equal((await fichasParaEquipo(sb(), prov, UUID, '', DEPS)).status, 400);
  assert.equal((await fichasParaEquipo(sb(), { id: 'sup-9', rol: 'supervisor' }, UUID, '', DEPS)).status, 400, 'sin colegios asignados');
  assert.equal((await fichasParaEquipo(sb(), { id: 'prov-2', rol: 'proveedor' }, UUID, '100001', DEPS)).status, 404, 'otro proveedor');
  assert.equal((await fichasParaEquipo(sb({ sinFichas: true }), prov, UUID, '100001', DEPS)).status, 503);
  const sinFotos = await fichasParaEquipo(sb({ sinFotos: true }), prov, UUID, '100001', DEPS);
  assert.equal(sinFotos.body.fichas[0].fotos, null, 'sin la migración 024: fotos null');
  assert.equal(MAX_FICHAS_EQUIPO, 300);
});

test('formulario: sin la tabla de firmas, la sección E lo avisa en lugar de esconder el botón', () => {
  const js = leer('src/public/campo-ficha.js');
  assert.match(js, /el servidor no encuentra la tabla de firmas \(migración 025\)/);
  assert.match(js, /Esta copia de la ficha se guardó en el equipo sin firmas en pantalla/);
});
