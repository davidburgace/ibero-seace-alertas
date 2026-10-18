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
