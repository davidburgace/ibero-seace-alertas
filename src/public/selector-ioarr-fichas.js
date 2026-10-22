// Selector IOARR — Expediente › Fichas de verificación por local.
// La app genera la ficha de cada local (Excel para llenar y PDF para imprimir),
// con el padrón y el censo ya cargados. La UGEL la devuelve llena en Excel y
// aquí se importa: lo verificado reemplaza al censo en el cálculo y cada local
// queda «Verificado» o «Solo censo». El servidor valida (src/selector-ioarr/ficha.js).

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NF = new Intl.NumberFormat('es-PE');
const ent = n => NF.format(Math.round(n || 0));
const pct = n => NF.format(n) + ' %';
const fechaPe = s => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '';
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PAGE = 40;
const corto = email => String(email || '').split('@')[0] || 'supervisor';

let ctx = null, vista = null, informe = null, version = 0, pag = 0, filtro = '';

export async function renderFichas(c) {
  ctx = c;
  c.el.innerHTML = '<div class="panel vacio">Revisando las fichas de verificación…</div>';
  const mio = ++version;
  try {
    const v = await c.api(`/proyectos/${c.proyecto.id}/fichas`);
    if (mio !== version) return;
    vista = v; pintar();
  } catch (e) { if (mio === version) c.el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`; }
}

function pintar() {
  const R = vista.resumen;
  ctx.el.innerHTML = `
    ${vista.sin_migracion ? '<div class="avisos"><div class="aviso alerta" role="alert">Falta ejecutar supabase/migrations/019_ioarr_ficha_verificacion.sql en Supabase: puedes descargar las fichas, pero no importarlas.</div></div>' : ''}
    <div class="exportar">
      <div><h3>Fichas de verificación por local</h3>
        <p>Una ficha por local, con el padrón y el censo ya cargados (la mesa, en puestos). La UGEL o la institución cuenta el mobiliario en campo, llena las celdas amarillas del Excel y te lo devuelve. Al importarlo, lo verificado reemplaza al censo en el cálculo, y el Formato 07-C indica qué porcentaje está verificado.</p></div>
      <div class="fichas-zips">
        <button class="btn btn-ghost" data-fichas-zip type="button">Todas las fichas (ZIP)</button>
        ${vista.paquetes?.length ? `<span class="sub">Una carpeta por supervisor, según el reparto de Visitas de campo. O solo el paquete de:</span>
        ${vista.paquetes.map(x => `<button class="btn btn-ghost btn-sm" data-fichas-zip="${esc(x.clave)}" type="button">${esc(x.clave === 'sin' ? 'Sin asignar' : corto(x.email))} (${ent(x.n)})</button>`).join('')}` : ''}
      </div>
    </div>
    <div class="kpis">
      <div class="kpi destacado"><div class="v">${pct(R.pct)}</div><div class="l">de lo que se repone está verificado · ${ent(R.rep_verif)} de ${ent(R.rep)}</div></div>
      <div class="kpi"><div class="v">${ent(R.verificados)} de ${ent(R.locales)}</div><div class="l">locales verificados · el resto, solo censo</div></div>
      <div class="kpi"><div class="v">${ent(R.con_ficha)}</div><div class="l">con ficha importada</div></div>
    </div>
    ${R.ioarrs.length > 1 ? `<p class="sub pad">Por IOARR: ${R.ioarrs.map(x => `<b>${esc(x.nombre)}</b> ${pct(x.pct)} (${ent(x.rep_verif)} de ${ent(x.rep)})`).join(' · ')}</p>` : ''}
    <div class="panel">
      <div class="panel-cab"><h3>Importar fichas llenas</h3><span class="sub">Uno o varios Excel a la vez (hasta 50)</span></div>
      <div class="pad">
        <p class="sub">Se valida cada archivo antes de guardarlo. Se rechazan las filas con un estado a medias (si llenas uno, llena Bueno, Regular y Malo), con negativos o decimales, y los archivos de locales que no están en el proyecto. Si lo contado difiere del censo en más de 15 % sin observación, se avisa sin rechazar la fila. Volver a importar la ficha de un local reemplaza la anterior.</p>
        <label class="btn btn-primary fichas-subir" ${vista.sin_migracion ? 'aria-disabled="true"' : ''}>
          <input type="file" data-fichas-subir accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden ${vista.sin_migracion ? 'disabled' : ''}>
          Elegir Excel de fichas…</label>
        <span class="guardado" id="fichas-estado" role="status"></span>
      </div>
      <div id="fichas-informe">${pintarInforme()}</div>
    </div>
    <div class="panel" id="fichas-locales">${pintarLocales()}</div>`;
}

function pintarInforme() {
  if (!informe) return '';
  const imp = informe.filter(r => r.estado === 'importada').length, rech = informe.length - imp;
  const linea = (x, tipo) => `<li class="inf-linea">${tipo === 'error' ? '<span class="chip-est alerta">Error</span>' : '<span class="chip-est pend">Aviso</span>'}
    <span class="sub">${x.fila ? `Hoja ${esc(x.hoja)}, fila ${x.fila}` : 'Archivo'}</span> ${esc(x.motivo)}</li>`;
  return `<div class="pad informe-fichas"><h4>Informe de la importación · ${imp} importada${imp === 1 ? '' : 's'}${rech ? `, ${rech} rechazada${rech === 1 ? '' : 's'}` : ''}</h4>
    ${informe.map(r => `<div class="inf-archivo">
      <div class="inf-cab">${r.estado === 'importada' ? '<span class="chip-est ok">Importada</span>' : '<span class="chip-est alerta">Rechazada</span>'}
        <b>${esc(r.archivo)}</b>${r.cod ? ` · local <span class="mono">${esc(r.cod)}</span>${r.nom ? ' ' + esc(r.nom) : ''}` : ''}
        ${r.estado === 'importada' ? `<span class="sub">· ${ent(r.filas.ok)} fila${r.filas.ok === 1 ? '' : 's'} con cantidades${r.filas.rechazadas ? `, ${ent(r.filas.rechazadas)} rechazada${r.filas.rechazadas === 1 ? '' : 's'}` : ''}</span>` : ''}</div>
      ${r.errores.length || r.avisos.length ? `<ul class="inf-lista">${r.errores.map(x => linea(x, 'error')).join('')}${r.avisos.map(x => linea(x, 'aviso')).join('')}</ul>` : '<p class="sub">Sin errores ni avisos.</p>'}
    </div>`).join('')}</div>`;
}

function pintarLocales() {
  const q = norm(filtro).split(/\s+/).filter(Boolean);
  const locs = vista.locales.filter(l => !q.length || q.every(w => norm(`${l.cod} ${l.nom} ${l.dist} ${l.estado_texto} ${l.supervisor || ''}`).includes(w)));
  const pags = Math.max(1, Math.ceil(locs.length / PAGE));
  if (pag >= pags) pag = pags - 1;
  const desde = pag * PAGE;
  const filas = locs.slice(desde, desde + PAGE).map(l => `<tr>
    <td class="mono">${esc(l.cod)}</td>
    <td><span class="nm">${esc(l.nom)}</span><span class="sub">${esc(l.dist)} · ${esc(l.niveles.join(', '))}${vista.paquetes?.length ? ` · ${l.supervisor ? 'Supervisor: ' + esc(corto(l.supervisor)) : 'Sin supervisor'}` : ''}</span></td>
    <td class="num">${ent(l.aulas)}</td><td class="num">${ent(l.rep)}</td><td class="num">${ent(l.rep_verif)}</td>
    <td>${l.estado === 'verificado' ? `<span class="chip-est ok">Verificado${l.visita ? ' ' + fechaPe(l.visita) : ''}</span>` : '<span class="chip-est pend">Solo censo</span>'}
      ${l.ficha ? `<br><span class="sub" title="${esc(l.ficha.archivo)}">Ficha importada el ${fechaPe(l.ficha.importado_en)}${l.ficha.verificador ? ' · ' + esc(l.ficha.verificador) : ''}</span>` : l.estado === 'verificado' ? '<br><span class="sub">Corregido a mano</span>' : ''}</td>
    <td class="acciones"><button class="x" type="button" data-ficha-bajar="${esc(l.cod)}" data-formato="excel">Excel</button> <button class="x" type="button" data-ficha-bajar="${esc(l.cod)}" data-formato="pdf">PDF</button></td></tr>`).join('');
  return `<div class="panel-cab"><h3>Locales de la propuesta</h3>
      <input type="search" class="buscar" data-fichas-filtro value="${esc(filtro)}" placeholder="Buscar por código, nombre, estado o supervisor" aria-label="Buscar locales"></div>
    <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Código de local</th><th>Institución educativa</th><th class="num">Aulas</th><th class="num">A reponer</th><th class="num">Verificado</th><th>Estado</th><th>Ficha</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="7" class="vacio">${vista.locales.length ? 'Ningún local coincide con la búsqueda.' : 'El proyecto no tiene locales en la propuesta.'}</td></tr>`}</tbody></table></div>
    ${vista.excluidos ? `<p class="sub pad">${vista.excluidos === 1 ? '1 local excluido' : ent(vista.excluidos) + ' locales excluidos'} por otra inversión vigente o reciente no lleva ficha.</p>` : ''}
    ${pags > 1 ? `<div class="paginacion pad-pag"><span class="sub">${ent(desde + 1)}–${ent(Math.min(locs.length, desde + PAGE))} de ${ent(locs.length)}</span><div class="pg-btns"><button class="btn btn-ghost btn-sm" data-fichas-pag="-1" type="button" ${pag === 0 ? 'disabled' : ''}>Anterior</button><span class="mono">${pag + 1} / ${pags}</span><button class="btn btn-ghost btn-sm" data-fichas-pag="1" type="button" ${pag >= pags - 1 ? 'disabled' : ''}>Siguiente</button></div></div>` : ''}`;
}

// ─── Descargas ───────────────────────────────────────────────────────────────
async function descargar(url, btn, porDefecto, espera = 'Generando…') {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = espera;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error ' + r.status);
    const blob = await r.blob(), cd = r.headers.get('Content-Disposition') || '';
    const nombre = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || porDefecto);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) { ctx.toast('No se pudo descargar: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = txt; }
}

// ─── Importación ─────────────────────────────────────────────────────────────
function estado(t, cls = '') { const s = document.getElementById('fichas-estado'); if (s) { s.className = 'guardado ' + cls; s.textContent = t; } }
async function importar(input) {
  const archivos = [...input.files];
  if (!archivos.length) return;
  const fd = new FormData();
  for (const f of archivos) fd.append('archivos', f, f.name);
  input.disabled = true;
  estado(`Importando ${archivos.length} archivo${archivos.length === 1 ? '' : 's'}…`, 'pend');
  try {
    const r = await fetch(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/fichas/importar`, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
    informe = d.resultados; vista = d.fichas; pintar();
    const imp = informe.filter(x => x.estado === 'importada').length;
    if (imp) ctx.alCambiarInventario?.();
    ctx.toast(imp === informe.length ? `${imp === 1 ? 'Ficha importada' : imp + ' fichas importadas'}.` : `${imp} de ${informe.length} fichas importadas: revisa el informe.`);
    document.getElementById('fichas-informe')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { estado('No se pudo importar: ' + e.message, 'error'); }
  finally { input.value = ''; input.disabled = false; }
}

export function enlazarFichas(el) {
  el.addEventListener('change', e => { if (e.target.matches('[data-fichas-subir]') && ctx) importar(e.target); });
  el.addEventListener('input', e => {
    if (!e.target.matches('[data-fichas-filtro]') || !vista) return;
    filtro = e.target.value; pag = 0;
    const pos = e.target.selectionStart;
    document.getElementById('fichas-locales').innerHTML = pintarLocales();
    const i = ctx.el.querySelector('[data-fichas-filtro]'); i.focus(); try { i.setSelectionRange(pos, pos); } catch { /* sin selección */ }
  });
  el.addEventListener('click', e => {
    if (!ctx || !vista) return;
    const b = e.target.closest('[data-ficha-bajar]');
    if (b) descargar(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/fichas/${encodeURIComponent(b.dataset.fichaBajar)}/${b.dataset.formato}`, b, `Ficha_${b.dataset.fichaBajar}.${b.dataset.formato === 'pdf' ? 'pdf' : 'xlsx'}`);
    const z = e.target.closest('[data-fichas-zip]');
    if (z) descargar(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/fichas-zip${z.dataset.fichasZip ? '?paquete=' + encodeURIComponent(z.dataset.fichasZip) : ''}`, z, 'Fichas_verificacion.zip', 'Armando el ZIP…');
    const pg = e.target.closest('[data-fichas-pag]');
    if (pg) { pag += +pg.dataset.fichasPag; document.getElementById('fichas-locales').innerHTML = pintarLocales(); }
  });
}
