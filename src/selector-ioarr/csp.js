// src/selector-ioarr/csp.js — Content-Security-Policy de la página del Selector IOARR.
// Solo se aplica a /selector-ioarr.html; las demás páginas del radar no tienen CSP todavía.
//   script-src  : la app y supabase-js (cdn.jsdelivr.net, el mismo de las otras páginas)
//   style-src   : 'unsafe-inline' porque la página usa style="" y Leaflet posiciona el mapa con estilos en línea
//   img-src     : imágenes del mapa (satélite de Esri y calles de OpenStreetMap)
//   connect-src : la app y Supabase Auth (sesion.js)
//   frame-src   : la vista satelital de Google Maps en el detalle de cada local
export const ORIGENES_MAPA = ['https://server.arcgisonline.com', 'https://tile.openstreetmap.org'];

function origen(url) {
  try { return url ? new URL(url).origin : null; } catch { return null; }
}

export function politicaSelector(supabaseUrl = process.env.SUPABASE_URL) {
  const sb = origen(supabaseUrl);
  return [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src 'self' data: ${ORIGENES_MAPA.join(' ')}`,
    `connect-src 'self'${sb ? ' ' + sb : ''}`,
    'frame-src https://www.google.com https://maps.google.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; ');
}

const PAGINAS = new Set(['/selector-ioarr.html']);
export function cspSelector(req, res, next) {
  if (PAGINAS.has(req.path)) res.set('Content-Security-Policy', politicaSelector());
  next();
}
