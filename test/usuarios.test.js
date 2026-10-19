// Pruebas de src/ioarr/usuarios.js con un cliente de Supabase FALSO
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listarUsuarios, cambiarRol } from '../src/ioarr/usuarios.js';

function supabaseFalso({ cuentas, perfiles }) {
  const upserts = [];
  return {
    upserts,
    auth: { admin: {
      listUsers: async ({ page, perPage }) => ({ data: { users: cuentas.slice((page - 1) * perPage, page * perPage) }, error: null }),
      getUserById: async id => {
        const user = cuentas.find(u => u.id === id);
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'User not found' } };
      }
    } },
    from: () => ({
      select: async () => ({ data: perfiles, error: null }),
      upsert: async (fila, opciones) => { upserts.push({ fila, opciones }); return { error: null }; }
    })
  };
}

const CUENTAS = [
  { id: 'b', email: 'zoila@ibero.pe', last_sign_in_at: '2026-10-10T12:00:00Z' },
  { id: 'a', email: 'ana@ibero.pe', last_sign_in_at: null },
  { id: 'c', email: 'carlos@banco.pe' } // sin perfil
];
const PERFILES = [{ id: 'a', rol: 'proveedor' }, { id: 'b', rol: 'financista' }];

test('listarUsuarios junta cuentas y roles, ordena por correo y sin perfil = financista', async () => {
  const lista = await listarUsuarios(supabaseFalso({ cuentas: CUENTAS, perfiles: PERFILES }));
  assert.deepEqual(lista, [
    { id: 'c', email: 'carlos@banco.pe', rol: 'financista', ultimo_ingreso: null },
    { id: 'a', email: 'ana@ibero.pe', rol: 'proveedor', ultimo_ingreso: null },
    { id: 'b', email: 'zoila@ibero.pe', rol: 'financista', ultimo_ingreso: '2026-10-10T12:00:00Z' }
  ].sort((x, y) => x.email.localeCompare(y.email)));
});

test('listarUsuarios recorre todas las páginas de Auth', async () => {
  const muchas = Array.from({ length: 450 }, (_, i) => ({ id: 'u' + i, email: `u${String(i).padStart(3, '0')}@x.pe` }));
  const lista = await listarUsuarios(supabaseFalso({ cuentas: muchas, perfiles: [] }));
  assert.equal(lista.length, 450);
});

test('cambiarRol guarda el rol con upsert (crea el perfil si faltaba)', async () => {
  const sb = supabaseFalso({ cuentas: CUENTAS, perfiles: PERFILES });
  const r = await cambiarRol(sb, { id: 'c', rol: 'proveedor', usuarioActual: { id: 'a' } });
  assert.equal(r.status, 200);
  assert.deepEqual(sb.upserts, [{ fila: { id: 'c', email: 'carlos@banco.pe', rol: 'proveedor' }, opciones: { onConflict: 'id' } }]);
});

test('cambiarRol rechaza roles inválidos', async () => {
  const sb = supabaseFalso({ cuentas: CUENTAS, perfiles: PERFILES });
  for (const rol of ['admin', '', undefined]) {
    assert.equal((await cambiarRol(sb, { id: 'b', rol, usuarioActual: { id: 'a' } })).status, 400);
  }
  assert.equal(sb.upserts.length, 0);
});

test('nadie se puede quitar su propio acceso de proveedor', async () => {
  const sb = supabaseFalso({ cuentas: CUENTAS, perfiles: PERFILES });
  const r = await cambiarRol(sb, { id: 'a', rol: 'financista', usuarioActual: { id: 'a' } });
  assert.equal(r.status, 400);
  assert.match(r.error, /propio acceso/);
  assert.equal(sb.upserts.length, 0);
});

test('cambiarRol de una cuenta que no existe da 404', async () => {
  const sb = supabaseFalso({ cuentas: CUENTAS, perfiles: PERFILES });
  assert.equal((await cambiarRol(sb, { id: 'zzz', rol: 'proveedor', usuarioActual: { id: 'a' } })).status, 404);
});

// ─── Invitar usuario ─────────────────────────────────────────────────────────
import { invitarUsuario, reenviarInvitacion, correoInvitacion } from '../src/ioarr/usuarios.js';

function supabaseInvitar({ existentes = [] } = {}) {
  const creados = [], upserts = [], enlaces = [];
  const cuentas = new Map(existentes.map((email, i) => [ 'old' + i, { id: 'old' + i, email } ]));
  return {
    creados, upserts, enlaces,
    auth: { admin: {
      createUser: async ({ email, password, email_confirm }) => {
        if ([...cuentas.values()].some(u => u.email === email)) return { data: null, error: { status: 422, message: 'A user with this email address has already been registered' } };
        const user = { id: 'nuevo-' + (creados.length + 1), email };
        creados.push({ email, password, email_confirm }); cuentas.set(user.id, user);
        return { data: { user }, error: null };
      },
      getUserById: async id => cuentas.has(id) ? { data: { user: cuentas.get(id) }, error: null } : { data: { user: null }, error: { message: 'not found' } },
      generateLink: async ({ type, email }) => {
        enlaces.push({ type, email });
        return { data: { properties: { action_link: `https://sb.test/verify?token=t${enlaces.length}`, hashed_token: `h${enlaces.length}` } }, error: null };
      }
    } },
    from: () => ({
      upsert: async (fila, opciones) => { upserts.push({ fila, opciones }); return { error: null }; },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { rol: 'proveedor' } }) }) })
    })
  };
}
const BASE = 'https://radar.test';

test('invitarUsuario crea la cuenta sin contraseña, fija el rol y envía el enlace por correo', async () => {
  const sb = supabaseInvitar(); const correos = [];
  const r = await invitarUsuario(sb, async c => { correos.push(c); }, { email: '  Maria.Perez@Ibero.pe ', rol: 'proveedor', baseUrl: BASE });
  assert.equal(r.status, 201);
  assert.equal(r.enviado, true);
  assert.equal(r.enlace, undefined); // si el correo salió, el enlace no se muestra en Admin
  assert.deepEqual(sb.creados, [{ email: 'maria.perez@ibero.pe', password: undefined, email_confirm: true }]);
  assert.deepEqual(sb.upserts[0].fila, { id: 'nuevo-1', email: 'maria.perez@ibero.pe', rol: 'proveedor' });
  assert.deepEqual(sb.enlaces, [{ type: 'recovery', email: 'maria.perez@ibero.pe' }]);
  assert.equal(correos[0].to, 'maria.perez@ibero.pe');
  // El botón lleva directo a la pantalla de crear contraseña, no al verify de Supabase
  assert.match(correos[0].html, /href="https:\/\/radar\.test\/login\.html\?modo=bienvenida&amp;type=recovery&amp;token_hash=h1"/);
  assert.doesNotMatch(correos[0].html, /sb\.test\/verify/);
});

test('si el correo falla, la cuenta queda creada y se devuelve el enlace para enviarlo a mano', async () => {
  const sb = supabaseInvitar();
  const r = await invitarUsuario(sb, async () => { throw new Error('SMTP no configurado'); }, { email: 'a@ibero.pe', rol: 'financista', baseUrl: BASE });
  assert.equal(r.status, 201);
  assert.equal(r.enviado, false);
  assert.match(r.enlace, /^https:\/\/radar\.test\/login\.html\?modo=bienvenida&type=recovery&token_hash=h1$/);
  assert.match(r.aviso, /SMTP no configurado/);
});

test('invitarUsuario rechaza correos y roles inválidos sin crear nada', async () => {
  const sb = supabaseInvitar();
  for (const datos of [{ email: 'sin-arroba', rol: 'proveedor' }, { email: '', rol: 'proveedor' }, { email: 'a@b.pe', rol: 'admin' }]) {
    assert.equal((await invitarUsuario(sb, async () => {}, { ...datos, baseUrl: BASE })).status, 400);
  }
  assert.equal(sb.creados.length, 0);
});

test('invitar un correo ya registrado da 409 y sugiere reenviar', async () => {
  const sb = supabaseInvitar({ existentes: ['ya@ibero.pe'] });
  const r = await invitarUsuario(sb, async () => {}, { email: 'ya@ibero.pe', rol: 'financista', baseUrl: BASE });
  assert.equal(r.status, 409);
  assert.match(r.error, /Reenviar invitación/);
  assert.equal(sb.upserts.length, 0);
});

test('reenviarInvitacion genera un enlace nuevo para la cuenta existente', async () => {
  const sb = supabaseInvitar({ existentes: ['ya@ibero.pe'] }); const correos = [];
  const r = await reenviarInvitacion(sb, async c => { correos.push(c); }, { id: 'old0', baseUrl: BASE });
  assert.equal(r.status, 200);
  assert.equal(r.enviado, true);
  assert.equal(correos[0].to, 'ya@ibero.pe');
  assert.equal((await reenviarInvitacion(sb, async () => {}, { id: 'no-existe', baseUrl: BASE })).status, 404);
});

test('el correo de invitación escapa el correo y dice el acceso según el rol', () => {
  const c = correoInvitacion({ email: '<x>@ibero.pe', enlace: 'https://sb.test/v?a=1&b=2', rol: 'financista' });
  assert.match(c.html, /&lt;x&gt;@ibero\.pe/);
  assert.match(c.html, /href="https:\/\/sb\.test\/v\?a=1&amp;b=2"/);
  assert.match(c.html, /Radar IOARR/);
  assert.match(correoInvitacion({ email: 'a@b.pe', enlace: 'x', rol: 'proveedor' }).html, /todo el Radar Ibero/);
});
