// ============================================================================
// src/ioarr/auth.js — Autenticación con Supabase Auth + rol desde `perfiles`
//
// El navegador inicia sesión con Supabase Auth (email + contraseña) y envía
// `Authorization: Bearer <access_token>`. Aquí se valida el token con Supabase
// y se carga el rol (proveedor | financista).
//
// Protege /api/ioarr/* (cualquier rol) y, con protegerApi, el resto de la API
// (solo rol proveedor). Pendiente: endurecer el RLS de las tablas que
// seguimiento.html lee directo con la clave pública.
// ============================================================================

import { supabase } from './db.js';

const CACHE_MS = 60 * 1000;          // evita consultar Supabase en cada request
const cache = new Map();             // token → { usuario, expira }

export async function requireAuth(req, res, next) {
  try {
    if (!supabase) return res.status(503).json({ error: 'Supabase no configurado' });
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Inicia sesión para usar Radar IOARR' });

    const enCache = cache.get(token);
    if (enCache && enCache.expira > Date.now()) { req.usuario = enCache.usuario; return next(); }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Sesión inválida o vencida' });

    const { data: perfil } = await supabase.from('perfiles').select('rol').eq('id', data.user.id).maybeSingle();
    // Sin perfil = rol más limitado
    const usuario = { id: data.user.id, email: data.user.email, rol: perfil?.rol || 'financista' };

    if (cache.size > 500) cache.clear();
    cache.set(token, { usuario, expira: Date.now() + CACHE_MS });
    req.usuario = usuario;
    next();
  } catch (e) { next(e); }
}

// Tras cambiar el rol de alguien, que el cambio rija ya (sin esperar CACHE_MS)
export function olvidarUsuario(id) {
  for (const [token, v] of cache) if (v.usuario.id === id) cache.delete(token);
}

// Uso: router.post('/ruta', requireRol('proveedor'), handler)
export function requireRol(...roles) {
  return (req, res, next) => roles.includes(req.usuario?.rol)
    ? next()
    : res.status(403).json({ error: 'Tu perfil no tiene acceso a esta acción' });
}

// Resto de la API (SEACE, Infra, Seguimiento, Admin): exige sesión y rol proveedor.
// Quedan fuera /api/health y /api/ioarr/*, que tiene su propio control
// (config es pública para poder iniciar sesión; lo demás exige sesión).
// Uso: app.use('/api', crearProteccionApi())
export function crearProteccionApi(autenticar = requireAuth, autorizar = requireRol('proveedor')) {
  return (req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/ioarr/')) return next();
    autenticar(req, res, err => err ? next(err) : autorizar(req, res, next));
  };
}
