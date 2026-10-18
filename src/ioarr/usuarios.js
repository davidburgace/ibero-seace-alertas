// ============================================================================
// src/ioarr/usuarios.js — Cuentas y roles para la sección «Usuarios» de Admin
//
// Las cuentas viven en Supabase Auth; el rol, en la tabla `perfiles`.
// Necesita el cliente con la clave secreta (auth.admin), así que solo se usa
// en el servidor, detrás de crearProteccionApi (rol proveedor).
// ============================================================================

import { randomInt } from 'node:crypto';
import { olvidarUsuario } from './auth.js';

export const ROLES = ['proveedor', 'financista'];
const POR_PAGINA = 200;

// Todas las cuentas de Auth con su rol (sin perfil = financista, como en requireAuth)
export async function listarUsuarios(supabase) {
  const cuentas = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: POR_PAGINA });
    if (error) throw error;
    cuentas.push(...data.users);
    if (data.users.length < POR_PAGINA) break;
  }
  const { data: perfiles, error } = await supabase.from('perfiles').select('id, rol');
  if (error) throw error;
  const rolPorId = new Map(perfiles.map(p => [p.id, p.rol]));
  return cuentas
    .map(u => ({ id: u.id, email: u.email || '', rol: rolPorId.get(u.id) || 'financista', ultimo_ingreso: u.last_sign_in_at || null }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

// Devuelve { status, error } o { status: 200, usuario }
export async function cambiarRol(supabase, { id, rol, usuarioActual }) {
  if (!ROLES.includes(rol)) return { status: 400, error: 'Rol inválido' };
  if (id === usuarioActual?.id && rol !== 'proveedor') {
    return { status: 400, error: 'No puedes quitarte tu propio acceso de proveedor' };
  }
  const { data, error: errUsuario } = await supabase.auth.admin.getUserById(id);
  if (errUsuario || !data?.user) return { status: 404, error: 'Usuario no encontrado' };

  // upsert: crea el perfil si a la cuenta le faltaba
  const { error } = await supabase.from('perfiles').upsert({ id, email: data.user.email, rol }, { onConflict: 'id' });
  if (error) throw error;
  olvidarUsuario(id);
  return { status: 200, usuario: { id, email: data.user.email, rol } };
}

// Contraseña temporal fácil de dictar: sin 0/O ni 1/l/I
const LETRAS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function contrasenaTemporal(largo = 12) {
  return Array.from({ length: largo }, () => LETRAS[randomInt(LETRAS.length)]).join('');
}

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Crea la cuenta ya confirmada (no espera el correo de Supabase) con una contraseña
// temporal que se muestra una sola vez en Admin. Devuelve { status, error } o
// { status: 201, usuario, contrasena }.
export async function crearUsuario(supabase, { email, rol }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_VALIDO.test(email)) return { status: 400, error: 'Escribe un correo válido' };
  if (!ROLES.includes(rol)) return { status: 400, error: 'Rol inválido' };

  const contrasena = contrasenaTemporal();
  const { data, error } = await supabase.auth.admin.createUser({ email, password: contrasena, email_confirm: true });
  if (error) {
    if (error.status === 422 || /already|registered|exists/i.test(error.message || '')) {
      return { status: 409, error: 'Ya existe una cuenta con ese correo' };
    }
    throw error;
  }
  // El trigger de la migración 001 crea el perfil como financista; aquí se fija el rol elegido
  const { error: errPerfil } = await supabase.from('perfiles').upsert({ id: data.user.id, email, rol }, { onConflict: 'id' });
  if (errPerfil) throw errPerfil;
  return { status: 201, usuario: { id: data.user.id, email, rol, ultimo_ingreso: null }, contrasena };
}
