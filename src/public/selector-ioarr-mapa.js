// Selector IOARR — mapa de locales (Leaflet servido por la app en /vendor/).
// Leaflet se carga solo al abrir el mapa; si no carga, la página sigue funcionando sin mapa.
import { radioPunto } from '/selector-ioarr/cercania.js';
import { urlGoogleMaps } from '/selector-ioarr/calculo.js';

const RUTA = '/vendor/leaflet-1.9.4';
const CAPAS = {
  sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imágenes © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics' },
  calles: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">colaboradores de OpenStreetMap</a>' }
};
const PERU = [[-9.2, -75], 5];

const NF = new Intl.NumberFormat('es-PE');
const fmt = n => NF.format(Math.round(n || 0));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtKm = km => km == null ? '—' : km.toLocaleString('es-PE', { minimumFractionDigits: km < 10 ? 2 : 1, maximumFractionDigits: km < 10 ? 2 : 1 });

let carga = null;
export function cargarLeaflet() {
  if (window.L?.map) return Promise.resolve(window.L);
  if (carga) return carga;
  carga = new Promise((ok, mal) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: RUTA + '/leaflet.css' });
    document.head.append(css);
    const js = Object.assign(document.createElement('script'), { src: RUTA + '/leaflet.js' });
    const t = setTimeout(() => mal(new Error('tiempo agotado')), 20000);
    js.onload = () => { clearTimeout(t); window.L?.map ? ok(window.L) : mal(new Error('Leaflet no quedó disponible')); };
    js.onerror = () => { clearTimeout(t); mal(new Error('no se pudo descargar Leaflet')); };
    document.head.append(js);
  }).catch(e => { carga = null; throw e; });
  return carga;
}

const color = (nombre, defecto) => getComputedStyle(document.documentElement).getPropertyValue(nombre).trim() || defecto;

function popup(p) {
  return `<div class="pop"><b>${esc(p.nom)}</b>
    <div>Local <span class="mono">${esc(p.cod)}</span> · ${esc(p.dist)}</div>
    <div>${fmt(p.est)} estudiantes · ${fmt(p.rep)} bienes a reponer</div>
    ${p.km != null ? `<div>A ${fmtKm(p.km)} km del centro (en línea recta)</div>` : ''}
    <div class="pop-acc"><a href="${urlGoogleMaps(p.lat, p.lon)}" target="_blank" rel="noopener">Abrir en Google Maps</a>
    <button class="btn btn-sm ${p.sel ? 'btn-ghost' : 'btn-primary'}" type="button" data-popsel="${esc(p.cod)}">${p.sel ? 'Quitar de la selección' : 'Seleccionar'}</button></div></div>`;
}

// box: contenedor del mapa. onPunto(lat, lon): clic en el mapa en modo «elegir centro».
// onSel(cod): botón Seleccionar / Quitar del popup.
export async function crearMapa(box, { onPunto, onSel }) {
  const L = await cargarLeaflet();
  const map = L.map(box, { zoomControl: true, attributionControl: true });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  const capas = Object.fromEntries(Object.entries(CAPAS).map(([k, c]) => [k, L.tileLayer(c.url, { maxZoom: 19, attribution: c.attribution })]));
  let base = 'sat'; capas.sat.addTo(map);
  const grupo = L.layerGroup().addTo(map);
  let elegir = false;
  map.setView(...PERU);
  map.on('click', e => { if (elegir) onPunto(e.latlng.lat, e.latlng.lng); });
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-popsel]'); if (!b) return;
    map.closePopup(); onSel(b.dataset.popsel);
  });
  return {
    get base() { return base; },
    alternarCapa() {
      const otra = base === 'sat' ? 'calles' : 'sat';
      map.removeLayer(capas[base]); capas[otra].addTo(map); base = otra;
      return base;
    },
    modoElegir(on) { elegir = on; box.classList.toggle('eligiendo', on); },
    // puntos: [{cod, nom, dist, lat, lon, est, rep, sel, km}]; centro: {lat, lon} o null; ajustar: encuadrar
    pintar(puntos, centro, ajustar) {
      map.invalidateSize();
      grupo.clearLayers();
      const acento = color('--accent', '#3a63e0'), libre = color('--punto-libre', '#e0962b'), rojo = color('--malo', '#d6453a');
      const pts = [];
      for (const p of puntos) {
        L.circleMarker([p.lat, p.lon], { radius: radioPunto(p.rep), color: '#fff', weight: 2, fillColor: p.sel ? acento : libre, fillOpacity: 0.95 })
          .bindPopup(popup(p), { maxWidth: 280 })
          .addTo(grupo);
        pts.push([p.lat, p.lon]);
      }
      if (centro) {
        L.circleMarker([centro.lat, centro.lon], { radius: 11, color: rojo, weight: 3, fillColor: rojo, fillOpacity: 0.2, dashArray: '4 3' })
          .bindTooltip('Centro de la búsqueda').addTo(grupo);
        pts.push([centro.lat, centro.lon]);
      }
      if (ajustar && pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    },
    encuadrarPeru() { map.setView(...PERU); },
    cerrarPopup() { map.closePopup(); },
    invalidar() { map.invalidateSize(); }
  };
}
