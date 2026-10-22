// Selector IOARR — mapa de locales (Leaflet servido por la app en /vendor/).
// Leaflet se carga solo al abrir el mapa; si no carga, la página sigue funcionando sin mapa.
import { radioPunto } from '/selector-ioarr/cercania.js';
import { urlGoogleMaps } from '/selector-ioarr/calculo.js';
import { colorDia, GRIS_DIA } from '/selector-ioarr/visitas.js';

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
// Ruta en Google Maps desde la ubicación de quien lo abre hasta el local
export const urlComoLlegar = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
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

function popup(p, dia, soloLectura) {
  return `<div class="pop"><b>${esc(p.nom)}</b>${dia ? `<div class="pop-dia">Día ${dia} · parada ${p.orden}</div>` : ''}
    <div>Local <span class="mono">${esc(p.cod)}</span> · ${esc(p.dist)}</div>
    <div>${fmt(p.est)} estudiantes · ${fmt(p.rep)} bienes a reponer</div>
    ${p.km != null ? `<div>A ${fmtKm(p.km)} km del centro (en línea recta)</div>` : ''}
    <div class="pop-acc"><a href="${urlGoogleMaps(p.lat, p.lon)}" target="_blank" rel="noopener">Abrir en Google Maps</a>
    <a href="${urlComoLlegar(p.lat, p.lon)}" target="_blank" rel="noopener">Cómo llegar</a>
    ${soloLectura ? '' : `<button class="btn btn-sm ${p.sel ? 'btn-ghost' : 'btn-primary'}" type="button" data-popsel="${esc(p.cod)}">${p.sel ? 'Quitar de la selección' : 'Seleccionar'}</button>`}</div></div>`;
}

// box: contenedor del mapa. onPunto(lat, lon): clic en el mapa en modo «elegir centro».
// onSel(cod): botón Seleccionar / Quitar del popup (sin onSel, el mapa es de solo lectura).
export async function crearMapa(box, { onPunto, onSel }) {
  const soloLectura = !onSel;
  const L = await cargarLeaflet();
  const map = L.map(box, { zoomControl: true, attributionControl: true });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  const capas = Object.fromEntries(Object.entries(CAPAS).map(([k, c]) => [k, L.tileLayer(c.url, { maxZoom: 19, attribution: c.attribution })]));
  let base = 'sat'; capas.sat.addTo(map);
  const grupo = L.layerGroup().addTo(map);
  const marcas = new Map();          // código de local → marcador (para enfocarlo desde el listado)
  let elegir = false;
  map.setView(...PERU);
  map.on('click', e => { if (elegir) onPunto(e.latlng.lat, e.latlng.lng); });
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-popsel]'); if (!b || soloLectura) return;
    map.closePopup(); onSel(b.dataset.popsel);
  });
  return {
    get base() { return base; },
    alternarCapa() {
      const otra = base === 'sat' ? 'calles' : 'sat';
      map.removeLayer(capas[base]); capas[otra].addTo(map); base = otra;
      return base;
    },
    modoElegir(on) { elegir = on; box.classList.toggle('eligiendo', on); if (on) map.closePopup(); },
    // puntos: [{cod, nom, dist, lat, lon, est, rep, sel, km}]; centro: {lat, lon} o null; ajustar: encuadrar
    // etiquetaCentro: texto del centro (por defecto «Centro de la búsqueda»)
    pintar(puntos, centro, ajustar, etiquetaCentro = 'Centro de la búsqueda') {
      map.invalidateSize();
      grupo.clearLayers(); marcas.clear();
      const acento = color('--accent', '#3a63e0'), libre = color('--punto-libre', '#e0962b'), rojo = color('--malo', '#d6453a');
      const pts = [];
      for (const p of puntos) {
        const m = L.circleMarker([p.lat, p.lon], { radius: radioPunto(p.rep), color: '#fff', weight: 2, fillColor: p.sel ? acento : libre, fillOpacity: 0.95 })
          .bindPopup(popup(p, null, soloLectura), { maxWidth: 280 })
          .addTo(grupo);
        // Eligiendo el centro, tocar un punto también lo fija (en vez de abrir su ventana)
        m.on('click', () => { if (elegir) { m.closePopup(); onPunto(p.lat, p.lon); } });
        marcas.set(p.cod, m);
        pts.push([p.lat, p.lon]);
      }
      if (centro) {
        L.circleMarker([centro.lat, centro.lon], { radius: 11, color: rojo, weight: 3, fillColor: rojo, fillOpacity: 0.2, dashArray: '4 3' })
          .bindTooltip(etiquetaCentro).addTo(grupo);
        pts.push([centro.lat, centro.lon]);
      }
      if (ajustar && pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    },
    // Días de visita: puntos numerados por orden y la ruta aproximada de cada día.
    // activo: 0 = todos los días; n = resalta el día n (los demás quedan en gris)
    // total: cantidad de días del plan (puede ser mayor que los que se dibujan)
    pintarVisitas(dias, activo, ajustar, total = dias.length) {
      map.invalidateSize();
      grupo.clearLayers(); marcas.clear();
      const pts = [];
      for (const d of dias) {
        const resaltado = !activo || activo === d.dia;
        const c = activo ? (resaltado ? (total <= 8 ? colorDia(d.dia, total) : color('--accent', '#3a63e0')) : GRIS_DIA) : colorDia(d.dia, total);
        const ll = d.puntos.map(p => [p.lat, p.lon]);
        if (ll.length > 1) L.polyline(ll, { color: c, weight: resaltado ? 3 : 2, opacity: resaltado ? 0.9 : 0.35, dashArray: '6 6', interactive: false }).addTo(grupo);
        for (const p of d.puntos) {
          const icon = L.divIcon({ className: 'pt-visita' + (resaltado ? '' : ' apagado'), html: `<span style="background:${c}">${p.orden}</span>`, iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -10] });
          marcas.set(p.cod, L.marker([p.lat, p.lon], { icon, keyboard: true, title: `Día ${d.dia} · parada ${p.orden}: ${p.nom}`, zIndexOffset: resaltado ? 1000 : 0 })
            .bindPopup(popup({ ...p, sel: true }, d.dia, soloLectura), { maxWidth: 280 }).addTo(grupo));
          if (resaltado) pts.push([p.lat, p.lon]);
        }
      }
      if (ajustar && pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    },
    // Centra el mapa en un local y abre su ventana (botón «Ver en el mapa» del listado)
    enfocar(cod) {
      const m = marcas.get(cod); if (!m) return false;
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 16));
      m.openPopup();
      return true;
    },
    encuadrarPeru() { map.setView(...PERU); },
    cerrarPopup() { map.closePopup(); },
    invalidar() { map.invalidateSize(); }
  };
}
