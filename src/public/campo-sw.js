// Service worker de Visitas de campo (/campo.html): la página abre sin señal.
// Se registra con alcance /campo (solo controla esa página y los workers que crea).
//   - Página, scripts, estilos e íconos: primero la red (con 4 s de espera); sin red, lo guardado.
//     Así cada versión nueva llega apenas hay señal.
//   - Datos de la región (/data/selector-ioarr/…): guardados la primera vez; no cambian en el año.
//   - supabase-js (cdn.jsdelivr.net): guardado la primera vez (la versión va en la URL).
//   - /api/*: nunca pasa por aquí. Los datos de las fichas los guarda la página en el equipo
//     (IndexedDB, campo-equipo.js), separados por usuario.
const VERSION = 'campo-v1';
const ESTATICOS = 'campo-estaticos-' + VERSION, DATOS = 'campo-datos';
const PRECARGA = [
  '/campo.html', '/campo.js', '/campo-ficha.js', '/campo-fotos.js', '/campo-equipo.js', '/campo.css', '/selector-ioarr.css', '/sesion.js',
  '/selector-ioarr-worker.js', '/selector-ioarr-mapa.js', '/selector-ioarr-listado.js',
  '/selector-ioarr/calculo.js', '/selector-ioarr/cercania.js', '/selector-ioarr/visitas.js',
  '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/campo.webmanifest', '/data/selector-ioarr/2025/index.json'
];
const CDN = 'https://cdn.jsdelivr.net/';

self.addEventListener('install', e => {
  // Lo que no se pueda bajar ahora se guarda la próxima vez que la página lo pida
  e.waitUntil(caches.open(ESTATICOS).then(c => Promise.all(PRECARGA.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('campo-estaticos-') && k !== ESTATICOS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const conEspera = (p, ms) => new Promise((ok, mal) => { const t = setTimeout(() => mal(new Error('lento')), ms); p.then(r => { clearTimeout(t); ok(r); }, e => { clearTimeout(t); mal(e); }); });
async function primeroRed(req, cache) {
  const c = await caches.open(cache);
  const red = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; });
  try { return await conEspera(red, 4000); }
  catch {
    const guardada = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (guardada) { red.catch(() => null); return guardada; }   // la red sigue y actualiza para la próxima
    return red;
  }
}
async function primeroGuardado(req, cache) {
  const c = await caches.open(cache);
  const guardada = await c.match(req);
  if (guardada) return guardada;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone());
  return r;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    if (url.pathname.startsWith('/data/selector-ioarr/') && !url.pathname.endsWith('index.json')) { e.respondWith(primeroGuardado(req, DATOS)); return; }
    e.respondWith(primeroRed(req, ESTATICOS));
    return;
  }
  if (req.url.startsWith(CDN)) e.respondWith(primeroGuardado(req, ESTATICOS));
});
