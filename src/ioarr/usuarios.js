// ============================================================================
// src/ioarr/usuarios.js — Cuentas y roles para la sección «Usuarios» de Admin
//
// Las cuentas viven en Supabase Auth; el rol, en la tabla `perfiles`.
// Necesita el cliente con la clave secreta (auth.admin), así que solo se usa
// en el servidor, detrás de crearProteccionApi (rol proveedor).
// ============================================================================

import { olvidarUsuario } from './auth.js';

export const ROLES = ['proveedor', 'financista', 'supervisor'];
const POR_PAGINA = 200;
// Sin la migración 020, el CHECK de perfiles.rol rechaza 'supervisor' (código 23514)
export const AVISO_SUPERVISOR = 'Falta ejecutar supabase/migrations/020_rol_supervisor.sql en Supabase para usar el rol de supervisor de campo';
const sinRolSupervisor = (e, rol) => rol === 'supervisor' && (e?.code === '23514' || /perfiles_rol_check/.test(e?.message || ''));

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
  if (sinRolSupervisor(error, rol)) return { status: 503, error: AVISO_SUPERVISOR };
  if (error) throw error;
  olvidarUsuario(id);
  return { status: 200, usuario: { id, email: data.user.email, rol } };
}

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Correo de bienvenida con el enlace para crear la contraseña
export function correoInvitacion({ email, enlace, rol }) {
  const acceso = { proveedor: 'todo el Radar Ibero', supervisor: 'Visitas de campo (mapa y listado de colegios por cercanía)' }[rol] || 'Radar IOARR';
  return {
    to: email,
    subject: 'Tu acceso a Radar Ibero',
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#16181d;line-height:1.5">
      <h2 style="margin:0 0 12px">Bienvenido a Radar Ibero</h2>
      <p>Se creó tu cuenta con el correo <b>${esc(email)}</b>, con acceso a ${acceso}.</p>
      <p>Para entrar, crea tu contraseña con este botón:</p>
      <p style="margin:22px 0"><a href="${esc(enlace)}" style="background:#3a63e0;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">Crear mi contraseña</a></p>
      <p style="font-size:13px;color:#5c6270">El enlace sirve una sola vez y vence en unas horas. Si vence, pide que te reenvíen la invitación o usa «¿Olvidaste tu contraseña?» en la pantalla de ingreso.</p>
    </div>`
  };
}

// Genera el enlace (tipo recovery) y lo envía. El enlace va directo a login.html con el
// token, y es la página la que lo valida y pide la contraseña. No se usa el action_link
// de Supabase: si su redirectTo no está en la lista de URLs permitidas, Supabase manda
// al Site URL (el launcher) con la sesión abierta y nunca se pide la contraseña.
// Si el correo falla, devuelve el enlace para que Admin lo copie y lo envíe a mano.
async function enviarInvitacion(supabase, enviarCorreo, { email, rol, baseUrl }) {
  const { data, error } = await supabase.auth.admin.generateLink({ type: 'recovery', email });
  if (error) throw error;
  const enlace = `${baseUrl}/login.html?modo=bienvenida&type=recovery&token_hash=${encodeURIComponent(data.properties.hashed_token)}`;
  try {
    await enviarCorreo(correoInvitacion({ email, enlace, rol }));
    return { enviado: true };
  } catch (e) {
    return { enviado: false, enlace, aviso: 'No se pudo enviar el correo (' + e.message + '). Copia el enlace y envíaselo.' };
  }
}

// Crea la cuenta sin contraseña y envía la invitación. Devuelve { status, error } o
// { status: 201, usuario, enviado, enlace?, aviso? }.
export async function invitarUsuario(supabase, enviarCorreo, { email, rol, baseUrl }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_VALIDO.test(email)) return { status: 400, error: 'Escribe un correo válido' };
  if (!ROLES.includes(rol)) return { status: 400, error: 'Rol inválido' };

  const { data, error } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (error) {
    if (error.status === 422 || /already|registered|exists/i.test(error.message || '')) {
      return { status: 409, error: 'Ya existe una cuenta con ese correo. Si no tiene contraseña, usa «Reenviar» en la lista de usuarios.' };
    }
    throw error;
  }
  // El trigger de la migración 001 crea el perfil como financista; aquí se fija el rol elegido
  const { error: errPerfil } = await supabase.from('perfiles').upsert({ id: data.user.id, email, rol }, { onConflict: 'id' });
  if (sinRolSupervisor(errPerfil, rol)) return { status: 503, error: AVISO_SUPERVISOR + '. La cuenta quedó creada como financista: después de la migración, cámbiale el rol.' };
  if (errPerfil) throw errPerfil;

  const envio = await enviarInvitacion(supabase, enviarCorreo, { email, rol, baseUrl });
  return { status: 201, usuario: { id: data.user.id, email, rol, ultimo_ingreso: null }, ...envio };
}

// Vuelve a enviar la invitación (enlace nuevo) a una cuenta existente
export async function reenviarInvitacion(supabase, enviarCorreo, { id, baseUrl }) {
  const { data, error } = await supabase.auth.admin.getUserById(id);
  if (error || !data?.user) return { status: 404, error: 'Usuario no encontrado' };
  const { data: perfil } = await supabase.from('perfiles').select('rol').eq('id', id).maybeSingle();
  const envio = await enviarInvitacion(supabase, enviarCorreo, { email: data.user.email, rol: perfil?.rol || 'financista', baseUrl });
  return { status: 200, ...envio };
}
