// Selector IOARR — Expediente › Oferta (USO INTERNO: NO SE EXPORTA)
// Costo propio de fabricar y poner el mobiliario en cada colegio, frente al monto de la
// estructura de costos (o a un monto referencial escrito a mano). El cálculo lo hace el
// servidor (src/selector-ioarr/oferta.js). Se guarda aparte y ningún exportador lo lee:
// no entra al 07-C, a las fichas, a la memoria, a los Excel ni al ZIP del expediente.

import { ITEMS } from '/selector-ioarr/calculo.js';

const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF = new Intl.NumberFormat('es-PE');
const soles = n => n == null ? '—' : 'S/ ' + NS.format(n);
const pct = n => n == null ? '—' : NS.format(n * 100) + ' %';
const ent = n => NF.format(Math.round(n || 0));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ctx = null, vista = null, tGuardar = null, version = 0;
const REF = {
  monto_inversion: 'Monto de inversión (estructura de costos)',
  cd_igv: 'Costo directo + IGV (estructura de costos)',
  cd: 'Costo directo sin IGV (estructura de costos)',
  manual: 'Monto referencial escrito a mano (convocatoria publicada)'
};

export async function renderOferta(c) {
  ctx = c;
  c.el.innerHTML = '<div class="panel vacio">Calculando la oferta…</div>';
  const mio = ++version;
  try {
    const v = await c.api(`/proyectos/${c.proyecto.id}/oferta`);
    if (mio !== version) return;
    vista = v; pintar();
  } catch (e) { if (mio === version) c.el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`; }
}

const inp = (attr, valor, etiqueta, o = {}) => `<div class="campo${o.ancho ? ' ancho' : ''}"><label>${etiqueta}</label><input ${attr} type="number" min="0" step="${o.step || 0.01}" inputmode="decimal" value="${valor ?? ''}" placeholder="${o.ph ?? ''}">${o.ayuda ? `<span class="sub">${o.ayuda}</span>` : ''}</div>`;

function pintar() {
  const d = vista.datos, T = vista.totales, kit = vista.kit;
  const distritos = [...new Map(vista.locales.map(l => [l.ubigeo, l.dist])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  const fab = ITEMS.map(x => inp(`data-of-fab="${x.k}"`, d.fabricacion[x.k], `${x.n} (S/ por ${x.k === 'mesa' && !kit ? 'puesto' : 'unidad'})`)).join('');
  const lrows = vista.locales.slice().sort((a, b) => (a.margen ?? 0) - (b.margen ?? 0)).map(l => `<tr class="${l.referencia != null && l.costo > l.referencia ? 'fila-alerta' : ''}">
      <td class="mono">${esc(l.cod)}</td><td><span class="nm">${esc(l.nom)}</span><span class="sub">${esc(l.dist)}</span></td>
      <td class="num">${ent(l.piezas)}</td><td class="num">${l.transporte_pieza == null ? '—' : soles(l.transporte_pieza)}</td>
      <td class="num"><b>${soles(l.costo)}</b></td><td class="num">${soles(l.referencia)}</td>
      <td class="num">${soles(l.margen)}</td><td class="num">${pct(l.margen_pct)}</td></tr>`).join('');
  ctx.el.innerHTML = `
    <div class="avisos"><div class="aviso alerta interno" role="note"><b>${esc(vista.marca)}.</b> Esta pestaña no entra al Formato 07-C, a las fichas, a la memoria, a los Excel ni al ZIP del expediente. ${esc(vista.escenario)}</div></div>
    ${vista.sin_migracion ? '<div class="avisos"><div class="aviso alerta" role="alert">Falta ejecutar supabase/migrations/027_ioarr_estructura_oferta.sql en Supabase: las entradas no se pueden guardar.</div></div>' : ''}
    <div class="kpis kpis-montos">
      <div class="kpi destacado"><div class="v">${soles(T.costo)}</div><div class="l">tu costo puesto en los colegios</div></div>
      <div class="kpi"><div class="v">${soles(T.referencia)}</div><div class="l">precio de referencia</div></div>
      <div class="kpi ${T.supera ? 'kpi-alerta' : ''}"><div class="v">${soles(T.margen)}</div><div class="l">margen total · ${pct(T.margen_pct)}</div></div>
      <div class="kpi"><div class="v">${T.por_kit ? soles(T.por_kit.margen) : '—'}</div><div class="l">margen por kit · ${ent(T.kits)} kits${T.por_kit ? ` · costo ${soles(T.por_kit.costo)} / precio ${soles(T.por_kit.referencia)}` : ''}</div></div>
    </div>
    <p class="sub">${esc(vista.nota)} Margen = precio de referencia − tu costo.</p>
    ${vista.avisos.length ? `<div class="avisos">${vista.avisos.map(a => `<div class="aviso${a.alerta ? ' alerta' : ''}" role="${a.alerta ? 'alert' : 'note'}">${esc(a.texto)}</div>`).join('')}</div>` : ''}
    <form class="panel doc-form" id="of-form" autocomplete="off">
      <div class="panel-cab"><h3>Tus costos (sin IGV)</h3><span class="guardado" id="of-guardado"></span></div>
      <h3>Fabricación por tipo de bien</h3>
      <div class="form-grid">${fab}</div>
      ${kit ? '<p class="sub">Con kit, cada kit cuenta una mesa y una silla.</p>' : ''}
      <h3>Por pieza</h3>
      <div class="form-grid">
        ${inp('data-of="embalaje"', d.embalaje, 'Embalaje (S/ por pieza)')}
        ${inp('data-of="instalacion"', d.instalacion, 'Instalación o entrega (S/ por pieza)')}
        ${inp('data-of="transporte_base"', d.transporte_base, 'Transporte puesto en colegio (S/ por pieza)', { ayuda: 'Vale para los distritos sin un valor propio.' })}
        <div class="campo"><label class="chk"><input type="checkbox" data-of-chk="usar_factor_zona" ${d.usar_factor_zona ? 'checked' : ''}> Sumar el factor de flete por zona del catálogo</label><span class="sub">Transporte × (1 + % de flete del distrito, la provincia o el área rural).</span></div>
      </div>
      <details class="pad-0"><summary>Transporte por distrito (${distritos.length})</summary>
        <div class="form-grid">${distritos.map(([u, n]) => inp(`data-of-dist="${u}"`, d.transporte_distrito[u], `${esc(n)} (${u})`, { ph: d.transporte_base ?? '' })).join('')}</div>
      </details>
      <h3>Gastos generales propios</h3>
      <div class="form-grid">
        <div class="campo"><label>Modo</label><select data-of="gg_modo"><option value="pct" ${d.gg_modo === 'pct' ? 'selected' : ''}>% sobre tu costo directo</option><option value="monto" ${d.gg_modo === 'monto' ? 'selected' : ''}>Monto fijo (S/)</option></select></div>
        ${inp('data-of="gg_valor"', d.gg_valor, d.gg_modo === 'monto' ? 'Monto (S/)' : 'Porcentaje (%)')}
      </div>
      <h3>Precio de referencia para comparar</h3>
      <div class="form-grid">
        <div class="campo ancho"><label>Comparar contra</label><select data-of="referencia">${Object.entries(REF).map(([k, t]) => `<option value="${k}" ${d.referencia === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        ${d.referencia === 'manual' ? inp('data-of="monto_manual"', d.monto_manual, 'Monto referencial de la convocatoria (S/)', { ancho: true }) : ''}
      </div>
    </form>
    <div class="panel"><div class="panel-cab"><h3>Costo puesto en cada colegio</h3><span class="sub">Ordenados por margen, de menor a mayor</span></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Código de local</th><th>Instituciones</th><th class="num">Piezas</th><th class="num">Transporte por pieza</th><th class="num">Tu costo</th><th class="num">Precio de referencia</th><th class="num">Margen (S/)</th><th class="num">Margen (%)</th></tr></thead>
      <tbody>${lrows || '<tr><td colspan="8" class="vacio">Sin locales.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="2">Total del proyecto</td><td class="num">${ent(T.piezas)}</td><td></td><td class="num">${soles(T.costo)}</td><td class="num">${soles(T.referencia)}</td><td class="num">${soles(T.margen)}</td><td class="num">${pct(T.margen_pct)}</td></tr></tfoot></table></div>
      <p class="sub pad">Desglose del total: fabricación, embalaje, transporte e instalación ${soles(T.directo)} + gastos generales propios ${soles(T.gg)}. El precio de referencia se reparte entre los colegios según su parte del monto elegido.</p></div>`;
}

function leer() {
  const o = { ...vista.datos, fabricacion: { ...vista.datos.fabricacion }, transporte_distrito: { ...vista.datos.transporte_distrito } };
  ctx.el.querySelectorAll('[data-of]').forEach(e => { o[e.dataset.of] = e.value; });
  ctx.el.querySelectorAll('[data-of-fab]').forEach(e => { o.fabricacion[e.dataset.ofFab] = e.value; });
  ctx.el.querySelectorAll('[data-of-dist]').forEach(e => { if (e.value === '') delete o.transporte_distrito[e.dataset.ofDist]; else o.transporte_distrito[e.dataset.ofDist] = e.value; });
  ctx.el.querySelectorAll('[data-of-chk]').forEach(e => { o[e.dataset.ofChk] = e.checked; });
  return o;
}
function estado(t, cls = '') { const s = document.getElementById('of-guardado'); if (s) { s.className = 'guardado ' + cls; s.textContent = t; } }

async function guardar() {
  const mio = ++version;
  estado('Guardando…', 'pend');
  try {
    const v = await ctx.api(`/proyectos/${ctx.proyecto.id}/oferta`, { method: 'PUT', body: { datos: leer() } });
    if (mio !== version) return;
    const act = document.activeElement, attrs = act ? [...act.attributes].filter(a => a.name.startsWith('data-of')).map(a => `[${a.name}="${a.value}"]`).join('') : '';
    const abierto = ctx.el.querySelector('details')?.open;
    vista = v; pintar();
    if (abierto) ctx.el.querySelector('details').open = true;
    if (attrs) ctx.el.querySelector(attrs)?.focus();
    estado('Guardado', 'ok');
  } catch (e) { if (mio === version) estado('No se pudo guardar: ' + e.message, 'error'); }
}

export function enlazarOferta(el) {
  const programar = ms => { clearTimeout(tGuardar); estado('Cambios sin guardar', 'pend'); tGuardar = setTimeout(guardar, ms); };
  el.addEventListener('input', e => { if (e.target.closest('#of-form') && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') programar(900); });
  el.addEventListener('change', e => { if (e.target.closest('#of-form') && (e.target.tagName === 'SELECT' || e.target.type === 'checkbox')) programar(50); });
  el.addEventListener('submit', e => { if (e.target.id === 'of-form') e.preventDefault(); });
}
