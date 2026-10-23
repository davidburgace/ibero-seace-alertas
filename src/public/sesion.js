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
//   - Sin señal (solo en las páginas con data-sin-senal, como /campo.html): si el servidor no responde
//     y en este equipo ya se verificó al usuario, la página abre con ese usuario (sin_conexion: true).
//     Los datos siguen protegidos: cada llamada a /api/* lleva el token y el servidor lo valida.
//     El usuario y la configuración se recuerdan en localStorage; «Salir» los borra.
(function () {
  const ROLES = ((document.currentScript && document.currentScript.dataset.roles) || 'proveedor').split(',').map(r => r.trim());
  const SIN_SENAL = !!(document.currentScript && 'sinSenal' in document.currentScript.dataset);
  const K_CFG = 'radar:cfg', K_USUARIO = 'radar:usuario', VIGENCIA = 30 * 864e5;   // el usuario recordado vale 30 días
  const leerLS = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const ponerLS = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
  const esRed = e => e instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false);
  const INICIO = { financista: '/ioarr.html', supervisor: '/campo.html', proveedor: '/' };
  const fetchOriginal = window.fetch.bind(window);
  const nunca = new Promise(() => {}); // para cortar la carga mientras se redirige
  let sb = null;

  function irALogin() {
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
  }
  function mostrarPagina() { document.documentElement.style.visibility = ''; }

  document.documentElement.style.visibility = 'hidden';

  function crearCliente(cfg) {
    if (!sb && cfg?.supabaseUrl && cfg?.supabaseKey && window.supabase) sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
    return sb;
  }
  // Sin señal: el último usuario verificado en este equipo, si es reciente y su rol entra a esta página
  function usuarioSinSenal() {
    if (!SIN_SENAL) return null;
    const u = leerLS(K_USUARIO);
    if (!u || Date.now() - (u.verificado || 0) > VIGENCIA || !ROLES.includes(u.rol)) return null;
    crearCliente(leerLS(K_CFG));
    mostrarPagina();
    return { id: u.id, email: u.email, rol: u.rol, sin_conexion: true };
  }

  const listo = (async () => {
    let cfg;
    try { cfg = await fetchOriginal('/api/ioarr/config').then(r => r.json()); }
    catch (e) { const u = esRed(e) && usuarioSinSenal(); if (u) return u; throw e; }
    if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) throw new Error('Falta configurar Supabase en el servidor');
    ponerLS(K_CFG, { supabaseUrl: cfg.supabaseUrl, supabaseKey: cfg.supabaseKey });
    crearCliente(cfg);
    const { data } = await sb.auth.getSession();
    if (!data.session) { irALogin(); return nunca; }
    let r;
    try { r = await fetchOriginal('/api/ioarr/me', { headers: { Authorization: 'Bearer ' + data.session.access_token } }); }
    catch (e) { const u = esRed(e) && usuarioSinSenal(); if (u) return u; throw e; }
    if (!r.ok) { irALogin(); return nunca; }
    const usuario = await r.json();
    if (!ROLES.includes(usuario.rol)) { location.replace(INICIO[usuario.rol] || '/ioarr.html'); return nunca; }
    ponerLS(K_USUARIO, { id: usuario.id, email: usuario.email, rol: usuario.rol, verificado: Date.now() });
    mostrarPagina();
    return usuario;
  })();
  listo.catch(e => { mostrarPagina(); alert('No se pudo verificar la sesión: ' + e.message); });

  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return fetchOriginal(input, init);
    await listo;
    // supabase-js renueva el token si venció (sin señal puede fallar: la llamada sale sin token y falla igual)
    const session = sb ? await sb.auth.getSession().then(r => r.data.session, () => null) : null;
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (session) headers.set('Authorization', 'Bearer ' + session.access_token);
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
    async salir() {
      ponerLS(K_USUARIO, null);
      await listo.catch(() => null);
      try { await sb?.auth.signOut(); } catch { /* sin señal: la sesión local se borra igual */ }
      location.replace('/login.html');
    }
  };
})();
