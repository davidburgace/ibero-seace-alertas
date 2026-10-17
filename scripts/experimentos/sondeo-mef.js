// Sondeo de factibilidad: consulta pública del Banco de Inversiones (MEF).
// Experimento aislado, NO forma parte del servidor.
// Uso: node scripts/experimentos/sondeo-mef.js [CUI]
// Hace como máximo 3 peticiones, con 5 s entre cada una. No reintenta,
// no evade captchas ni bloqueos: si algo falla, solo lo informa.

const CUI = process.argv[2] || '2560356';
const BASE = 'https://ofi5.mef.gob.pe';
const PAUSA_MS = 5000;
const UA = 'Mozilla/5.0 (sondeo factibilidad ibero-seace-alertas)';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function pedir(url) {
  const ini = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    const cuerpo = await res.text();
    return { url, status: res.status, ms: Date.now() - ini, headers: res.headers, cuerpo };
  } catch (err) {
    return { url, error: err.cause?.code || err.message, ms: Date.now() - ini };
  }
}

function analizar(r) {
  if (r.error) return console.log(`✗ ${r.url}\n  error: ${r.error} (${r.ms} ms)\n`);
  const h = r.cuerpo;
  console.log(`✓ ${r.url}\n  HTTP ${r.status} en ${r.ms} ms, ${h.length} bytes`);
  const loc = r.headers.get('location');
  if (loc) console.log(`  redirige a: ${loc}`);
  const cookies = r.headers.getSetCookie?.() || [];
  if (cookies.length) console.log(`  cookies: ${cookies.map((c) => c.split('=')[0]).join(', ')}`);
  const señales = {
    captcha: /captcha|recaptcha|hcaptcha|turnstile/i.test(h),
    antiforgery: /__RequestVerificationToken/i.test(h),
    menciona_cui: h.includes(CUI),
    menciona_pdf: /pdf|export/i.test(h),
  };
  console.log('  señales:', señales);
  // Endpoints candidatos referenciados por la página (ajax, formularios, exportación)
  const rutas = new Set();
  for (const m of h.matchAll(/(?:url\s*:\s*|action=|href=|src=|\.(?:get|post|ajax)\(\s*)["']([^"']+)["']/gi)) {
    const v = m[1];
    if (!/\.(css|png|jpe?g|gif|svg|ico|woff2?)(\?|$)/i.test(v)) rutas.add(v);
  }
  if (rutas.size) console.log('  rutas referenciadas:\n   ' + [...rutas].slice(0, 60).join('\n   '));
  console.log();
}

const urls = [
  `${BASE}/robots.txt`,
  `${BASE}/invierte/consultapublica/consultainversiones?cui=${CUI}`,
];

for (const [i, url] of urls.entries()) {
  if (i) await esperar(PAUSA_MS);
  const r = await pedir(url);
  analizar(r);
  if (url.endsWith('robots.txt') && !r.error) console.log(r.cuerpo.slice(0, 2000), '\n');
}
