// Sesión compartida de las páginas del radar (la misma cuenta de Supabase Auth que Radar IOARR).
//
// Se carga en <head>, después de supabase-js y antes de los scripts de la página:
//   - Sin sesión → manda a /login.html y vuelve a esta página al ingresar.
//   - Roles: la página dice cuáles acepta con data-roles (por defecto solo proveedor):
//       <script src="/sesion.js" data-roles="proveedor,supervisor"></script>
//     Otro rol va a su inicio: financista → /ioarr.html, supervisor → /campo.html.
//   - Envuelve fetch: cada llamada a /api/* sale con "Authorization: Bearer <token>",
//     así las páginas no tienen que cambiar sus fetch. Un 401 manda al login.
//   - Oculta la página hasta confirmar la sesión, para no mostrarla vacía.
(function () {
  const ROLES = ((document.currentScript && document.currentScript.dataset.roles) || 'proveedor').split(',').map(r => r.trim());
  const INICIO = { financista: '/ioarr.html', supervisor: '/campo.html', proveedor: '/' };
  const fetchOriginal = window.fetch.bind(window);
  const nunca = new Promise(() => {}); // para cortar la carga mientras se redirige
  let sb = null;

  function irALogin() {
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
  }
  function mostrarPagina() { document.documentElement.style.visibility = ''; }

  document.documentElement.style.visibility = 'hidden';

  const listo = (async () => {
    const cfg = await fetchOriginal('/api/ioarr/config').then(r => r.json());
    if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) throw new Error('Falta configurar Supabase en el servidor');
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
    const { data } = await sb.auth.getSession();
    if (!data.session) { irALogin(); return nunca; }
    const r = await fetchOriginal('/api/ioarr/me', { headers: { Authorization: 'Bearer ' + data.session.access_token } });
    if (!r.ok) { irALogin(); return nunca; }
    const usuario = await r.json();
    if (!ROLES.includes(usuario.rol)) { location.replace(INICIO[usuario.rol] || '/ioarr.html'); return nunca; }
    mostrarPagina();
    return usuario;
  })();
  listo.catch(e => { mostrarPagina(); alert('No se pudo verificar la sesión: ' + e.message); });

  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return fetchOriginal(input, init);
    await listo;
    const { data } = await sb.auth.getSession(); // supabase-js renueva el token si venció
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (data.session) headers.set('Authorization', 'Bearer ' + data.session.access_token);
    const res = await fetchOriginal(input, { ...init, headers });
    if (res.status === 401) irALogin();
    return res;
  };

  window.radarSesion = {
    listo,
    // Usuario de la sesión ({ id, email, rol }), cuando ya se verificó
    usuario: () => listo,
    // Cliente de Supabase con la sesión del usuario (para leer tablas directo desde la página)
    async cliente() { await listo; return sb; },
    async salir() { await listo; await sb.auth.signOut(); location.replace('/login.html'); }
  };
})();
