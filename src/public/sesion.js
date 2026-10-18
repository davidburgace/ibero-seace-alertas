// Sesión compartida de las páginas del radar (la misma cuenta de Supabase Auth que Radar IOARR).
//
// Se carga en <head>, después de supabase-js y antes de los scripts de la página:
//   - Sin sesión → manda a /login.html y vuelve a esta página al ingresar.
//   - Rol financista → manda a /ioarr.html (es lo único que puede usar).
//   - Envuelve fetch: cada llamada a /api/* sale con "Authorization: Bearer <token>",
//     así las páginas no tienen que cambiar sus fetch. Un 401 manda al login.
//   - Oculta la página hasta confirmar la sesión, para no mostrarla vacía.
(function () {
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
    if (usuario.rol !== 'proveedor') { location.replace('/ioarr.html'); return nunca; }
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
    async salir() { await listo; await sb.auth.signOut(); location.replace('/login.html'); }
  };
})();
