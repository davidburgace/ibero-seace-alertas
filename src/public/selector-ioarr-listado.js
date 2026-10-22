// Selector IOARR — listado de locales con dirección, en orden de cercanía.
// Lo usan el Selector (panel «Buscar por cercanía») y la página de campo.
import { urlComoLlegar, fmtKm } from '/selector-ioarr-mapa.js';

const NF = new Intl.NumberFormat('es-PE');
const fmt = n => NF.format(Math.round(n || 0));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, uno, varios) => `${fmt(n)} ${n === 1 ? uno : varios}`;

// filas: acción «listado» del worker (o puntos de un día de visita, con `orden`).
// opts.numero(f): número que se muestra (por defecto f.n); opts.mapa: muestra «Ver en el mapa»
export function itemListado(f, { numero = x => x.n, mapa = true } = {}) {
  const dir = f.dir ? esc(f.dir) : '<span class="sub">Sin dirección en el padrón</span>';
  const lugar = [f.cp, f.dist].filter(Boolean).map(esc).join(' · ') + (f.rural == null ? '' : ` · ${f.rural ? 'Rural' : 'Urbana'}`);
  const datos = [`Local <span class="mono">${esc(f.cod)}</span>`, f.niv?.length ? f.niv.join(', ') : '', plural(f.est, 'estudiante', 'estudiantes'), `${fmt(f.rep)} a reponer`].filter(Boolean).join(' · ');
  const coord = f.coord ?? (typeof f.lat === 'number');
  return `<li class="lst-item" data-cod="${esc(f.cod)}">
    <span class="lst-n" aria-hidden="true">${numero(f)}</span>
    <div class="lst-cuerpo">
      <div class="lst-nom">${esc(f.nom)}</div>
      <div class="lst-dir">${dir}</div>
      <div class="sub">${lugar}</div>
      <div class="sub">${datos}</div>
    </div>
    ${f.km != null ? `<span class="lst-km" title="Distancia en línea recta al centro">${fmtKm(f.km)} km</span>` : ''}
    <div class="lst-acc">
      ${coord ? `<a class="btn btn-primary btn-sm" href="${urlComoLlegar(f.lat, f.lon)}" target="_blank" rel="noopener" aria-label="Cómo llegar a ${esc(f.nom)} (Google Maps)">Cómo llegar</a>` : '<span class="sub">Sin coordenadas</span>'}
      ${coord && mapa ? `<button class="btn btn-ghost btn-sm" type="button" data-vermapa="${esc(f.cod)}" aria-label="Ver ${esc(f.nom)} en el mapa">Ver en el mapa</button>` : ''}
    </div>
  </li>`;
}

export const htmlListado = (filas, opts) => filas.length
  ? `<ol class="lst">${filas.map(f => itemListado(f, opts)).join('')}</ol>`
  : '<p class="sub lst-vacio">No hay locales para mostrar.</p>';
