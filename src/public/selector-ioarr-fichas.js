// Selector IOARR — Expediente › Fichas de verificación por local.
// La app genera la ficha de cada local (Excel para llenar y PDF para imprimir),
// con el padrón y el censo ya cargados. La UGEL la devuelve llena en Excel y
// aquí se importa: lo verificado reemplaza al censo en el cálculo y cada local
// queda «Verificado» o «Solo censo». El servidor valida (src/selector-ioarr/ficha.js).
// El supervisor también puede llenar la ficha en Visitas de campo y enviarla a revisión: aquí se
// revisa y se aprueba (pasa al inventario, igual que el Excel) o se devuelve con una nota (ficha-digital.js).

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NF = new Intl.NumberFormat('es-PE');
const ent = n => NF.format(Math.round(n || 0));
const pct = n => NF.format(n) + ' %';
const fechaPe = s => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '';
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PAGE = 40;
const corto = email => String(email || '').split('@')[0] || 'supervisor';

let ctx = null, vista = null, informe = null, version = 0, pag = 0, filtro = '';
let rev = null;   // ficha de la app en revisión: { cod, cargando, error, d: { ficha, modelo, revision } }

export async function renderFichas(c) {
  ctx = c; rev = null;
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
      ${vista.sin_migracion_digital ? '' : `<div class="kpi${R.por_revisar ? ' destacado' : ''}"><div class="v">${ent(R.por_revisar)}</div><div class="l">fichas llenadas en la app por revisar</div></div>`}
    </div>
    ${vista.sin_migracion_digital ? '<div class="avisos"><div class="aviso">Para que los supervisores llenen la ficha en la app (Visitas de campo) falta ejecutar supabase/migrations/023_campo_fichas.sql en Supabase.</div></div>' : ''}
    <div id="fichas-revision">${pintarRevision()}</div>
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
  const locs = vista.locales.filter(l => !q.length || q.every(w => norm(`${l.cod} ${l.nom} ${l.dist} ${l.estado_texto} ${l.supervisor || ''} ${l.digital ? 'app ' + l.digital.estado_texto : ''}`).includes(w)));
  const pags = Math.max(1, Math.ceil(locs.length / PAGE));
  if (pag >= pags) pag = pags - 1;
  const desde = pag * PAGE;
  const filas = locs.slice(desde, desde + PAGE).map(l => `<tr>
    <td class="mono">${esc(l.cod)}</td>
    <td><span class="nm">${esc(l.nom)}</span><span class="sub">${esc(l.dist)} · ${esc(l.niveles.join(', '))}${vista.paquetes?.length ? ` · ${l.supervisor ? 'Supervisor: ' + esc(corto(l.supervisor)) : 'Sin supervisor'}` : ''}</span></td>
    <td class="num">${ent(l.aulas)}</td><td class="num">${ent(l.rep)}</td><td class="num">${ent(l.rep_verif)}</td>
    <td>${l.estado === 'verificado' ? `<span class="chip-est ok">Verificado${l.visita ? ' ' + fechaPe(l.visita) : ''}</span>` : '<span class="chip-est pend">Solo censo</span>'}
      ${l.ficha ? `<br><span class="sub" title="${esc(l.ficha.archivo)}">Ficha importada el ${fechaPe(l.ficha.importado_en)}${l.ficha.verificador ? ' · ' + esc(l.ficha.verificador) : ''}</span>` : l.estado === 'verificado' ? '<br><span class="sub">Corregido a mano</span>' : ''}
      ${l.digital ? `<br><span class="chip-est ${CHIP_APP[l.digital.estado]}">App: ${esc(l.digital.estado_texto)}</span>${l.digital.por ? ` <span class="sub">${esc(corto(l.digital.por))}</span>` : ''}` : ''}</td>
    <td class="acciones">${l.digital && l.digital.estado !== 'borrador' ? `<button class="x" type="button" data-ficha-revisar="${esc(l.cod)}">${l.digital.estado === 'enviada' ? 'Revisar' : 'Ver'}</button> ` : ''}<button class="x" type="button" data-ficha-bajar="${esc(l.cod)}" data-formato="excel">Excel</button> <button class="x" type="button" data-ficha-bajar="${esc(l.cod)}" data-formato="pdf">PDF</button></td></tr>`).join('');
  return `<div class="panel-cab"><h3>Locales de la propuesta</h3>
      <input type="search" class="buscar" data-fichas-filtro value="${esc(filtro)}" placeholder="Buscar por código, nombre, estado o supervisor" aria-label="Buscar locales"></div>
    <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Código de local</th><th>Institución educativa</th><th class="num">Aulas</th><th class="num">A reponer</th><th class="num">Verificado</th><th>Estado</th><th>Ficha</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="7" class="vacio">${vista.locales.length ? 'Ningún local coincide con la búsqueda.' : 'El proyecto no tiene locales en la propuesta.'}</td></tr>`}</tbody></table></div>
    ${vista.excluidos ? `<p class="sub pad">${vista.excluidos === 1 ? '1 local excluido' : ent(vista.excluidos) + ' locales excluidos'} por otra inversión vigente o reciente no lleva ficha.</p>` : ''}
    ${pags > 1 ? `<div class="paginacion pad-pag"><span class="sub">${ent(desde + 1)}–${ent(Math.min(locs.length, desde + PAGE))} de ${ent(locs.length)}</span><div class="pg-btns"><button class="btn btn-ghost btn-sm" data-fichas-pag="-1" type="button" ${pag === 0 ? 'disabled' : ''}>Anterior</button><span class="mono">${pag + 1} / ${pags}</span><button class="btn btn-ghost btn-sm" data-fichas-pag="1" type="button" ${pag >= pags - 1 ? 'disabled' : ''}>Siguiente</button></div></div>` : ''}`;
}

// ─── Fichas llenadas en la app: revisión ─────────────────────────────────────
const CHIP_APP = { borrador: '', enviada: 'pend', observada: 'alerta', aprobada: 'ok' };
const NOMBRE_BIEN = { mesa: 'Mesa del estudiante', silla: 'Silla del estudiante', esc: 'Escritorio docente', sdoc: 'Silla docente', arm: 'Armario o estante' };
const FIRMA = { director: 'Director(a)', ugel: 'Verificador de la UGEL', registradora: 'Entidad registradora' };
const v = x => x == null || x === '' ? '—' : esc(x);

function pintarRevision() {
  if (!rev) return '';
  const cab = t => `<div class="panel-cab"><h3>${t}</h3><button class="btn btn-ghost btn-sm" type="button" data-ficha-revision-cerrar>Cerrar</button></div>`;
  if (rev.cargando) return `<div class="panel">${cab('Ficha llenada en la app · local ' + esc(rev.cod))}<p class="pad sub">Cargando…</p></div>`;
  if (rev.error) return `<div class="panel">${cab('Ficha llenada en la app · local ' + esc(rev.cod))}<p class="pad err">${esc(rev.error)}</p></div>`;
  const { ficha: f, modelo: M, revision: R } = rev.d, d = f.datos || {}, a = d.a || {};
  const linea = (x, tipo) => `<li class="inf-linea">${tipo === 'e' ? '<span class="chip-est alerta">Error</span>' : '<span class="chip-est pend">Aviso</span>'} ${x.fila ? `<span class="sub">${esc(x.fila)}</span> ` : ''}${esc(x.motivo)}</li>`;
  const servicios = M.servicios.map(s => ({ s, x: d.servicios?.[s.modular] })).filter(o => o.x);
  const aulas = M.aulas.filter(au => d.aulas?.[au.j]);
  const sinVer = M.aulas.length - aulas.length;
  const filasAula = au => {
    const da = d.aulas[au.j], filas = da.filas || [];
    const porBien = Object.keys(NOMBRE_BIEN).map(k => ({ k, fs: filas.filter(x => x.k === k) })).filter(o => o.fs.length);
    return porBien.map(({ k, fs }, n) => fs.map((x, i) => `<tr>
      ${n === 0 && i === 0 ? `<td rowspan="${filas.length || 1}"><b>Aula ${au.j + 1}</b><span class="sub">${esc(au.nombreNivel)}${au.grado ? ' · ' + esc(au.grado) + (au.seccion ? ' ' + esc(au.seccion) : '') : ''}${da.est != null && da.est !== '' ? ` · ${esc(da.est)} estudiantes (censo ${ent(au.est)})` : ''}</span></td>` : ''}
      <td>${esc(NOMBRE_BIEN[k])}${i ? ' (otro tipo)' : ''}</td>
      <td class="num">${i ? '' : `${ent(au.censo[k].b)} / ${ent(au.censo[k].r)} / ${ent(au.censo[k].m)}`}</td>
      <td class="num">${v(x.b)} / ${v(x.r)} / ${v(x.m)}${k === 'mesa' && x.puestos ? ` <span class="sub">× ${esc(x.puestos)} puestos</span>` : ''}</td>
      <td>${v(x.antig)}</td><td>${v(x.baja)}</td><td>${v(x.patrimonial)}</td><td>${v(x.obs)}</td></tr>`).join('')).join('');
  };
  const firmas = Object.entries(d.firmas || {});
  return `<div class="panel revision-app">
    ${cab(`Ficha llenada en la app · local <span class="mono">${esc(M.local.cod)}</span> ${esc(M.local.nombre)}`)}
    <div class="pad">
      <p><span class="chip-est ${CHIP_APP[f.estado]}">${esc(f.estado_texto)}</span>
        <span class="sub">${f.por ? 'Llenada por ' + esc(f.por) : ''}${f.enviada_en ? ' · enviada el ' + fechaPe(f.enviada_en) : ''}${f.revisada_en && f.estado !== 'enviada' ? ' · revisada el ' + fechaPe(f.revisada_en) : ''}</span></p>
      ${f.nota && f.estado === 'observada' ? `<p class="aviso">Devuelta con la nota: ${esc(f.nota)}</p>` : ''}
      ${R.errores.length || R.avisos.length ? `<ul class="inf-lista">${R.errores.map(x => linea(x, 'e')).join('')}${R.avisos.map(x => linea(x, 'a')).join('')}</ul>` : '<p class="sub">La validación no encontró errores ni avisos.</p>'}
      <h4>A. Visita</h4>
      <p>Fecha <b>${fechaPe(a.fecha) || '—'}</b> · Verificador: ${v(a.verificador)} · Acompañó: ${v(a.acompanante)} · Coordenadas: ${v(a.coord)}</p>
      ${servicios.length ? `<h4>B. Estudiantes verificados</h4><div class="tabla-wrap"><table class="tabla"><thead><tr><th>Cód. modular</th><th>Institución</th><th class="num">Padrón</th><th class="num">Verificados</th><th>Observación</th></tr></thead><tbody>
        ${servicios.map(({ s, x }) => `<tr><td class="mono">${esc(s.modular)}</td><td>${esc(s.nombre)} <span class="sub">${esc(s.nombreNivel)}</span></td><td class="num">${ent(s.est)}</td><td class="num">${v(x.est)}</td><td>${v(x.obs)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <h4>C. Mobiliario por aula <span class="sub">· ${ent(aulas.length)} de ${ent(M.aulas.length)} aulas con datos${sinVer ? `; las otras ${ent(sinVer)} siguen con el censo` : ''} · Bueno / Regular / Malo</span></h4>
      ${aulas.length ? `<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Aula</th><th>Bien</th><th class="num">Censo</th><th class="num">Verificado (unidades)</th><th>Antigüedad</th><th>Baja</th><th>Cód. patrimonial</th><th>Observación</th></tr></thead>
        <tbody>${aulas.map(filasAula).join('')}</tbody></table></div>` : '<p class="sub">Sin datos por aula.</p>'}
      ${d.fuera?.length ? `<h4>D. Fuera de aulas</h4><ul>${d.fuera.map(x => `<li>${v(x.ambiente)} · ${v(x.bien)}: ${v(x.b)} / ${v(x.r)} / ${v(x.m)}${x.antig ? ' · ' + esc(x.antig) : ''}${x.obs ? ' · ' + esc(x.obs) : ''}</li>`).join('')}</ul>` : ''}
      <h4>E. Observaciones y conformidad</h4>
      <p>${v(d.obs)}</p>
      ${firmas.length ? `<p class="sub">${firmas.map(([k, x]) => `${esc(FIRMA[k] || k)}: ${v(x.nombre)}${x.dni ? ', DNI ' + esc(x.dni) : ''}`).join(' · ')}</p>` : ''}
      ${f.estado === 'enviada' ? `<div class="revision-acc">
        <label class="field"><span class="lbl">Si la devuelves, qué debe corregir el supervisor</span><textarea data-ficha-nota rows="2" maxlength="1000" placeholder="Ej.: el aula 3 tiene sillas de más; vuelve a contarlas."></textarea></label>
        <div class="acts"><button class="btn btn-ghost" type="button" data-ficha-observar="${esc(M.local.cod)}">Devolver al supervisor</button>
        <button class="btn btn-primary" type="button" data-ficha-aprobar="${esc(M.local.cod)}"${R.rechazada || R.errores.length ? ' disabled title="Tiene errores: devuélvela al supervisor"' : ''}>Aprobar: pasar al inventario</button></div>
        <p class="sub">Al aprobarla, lo verificado reemplaza al censo en el cálculo, igual que al importar el Excel.</p></div>` : ''}
    </div></div>`;
}
const repintarRevision = () => { const el = document.getElementById('fichas-revision'); if (el) el.innerHTML = pintarRevision(); };
async function abrirRevision(cod) {
  rev = { cod, cargando: true }; repintarRevision();
  document.getElementById('fichas-revision')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try { const d = await ctx.api(`/proyectos/${ctx.proyecto.id}/fichas/${encodeURIComponent(cod)}/digital`); if (rev?.cod === cod) rev = { cod, d }; }
  catch (e) { if (rev?.cod === cod) rev = { cod, error: e.message }; }
  repintarRevision();
}
async function decidir(cod, accion, btn) {
  const nota = ctx.el.querySelector('[data-ficha-nota]')?.value.trim() || '';
  if (accion === 'observar' && !nota) { ctx.toast('Escribe qué debe corregir el supervisor.'); ctx.el.querySelector('[data-ficha-nota]')?.focus(); return; }
  if (accion === 'aprobar' && !confirm('¿Aprobar la ficha? Lo verificado reemplaza al censo de este local en el cálculo.')) return;
  btn.disabled = true;
  try {
    const r = await fetch(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/fichas/${encodeURIComponent(cod)}/digital/${accion}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(accion === 'observar' ? { nota } : {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { if (d.revision && rev?.d) rev.d.revision = d.revision; throw new Error(d.error || 'Error ' + r.status); }
    vista = d.fichas; rev = null; pintar();
    if (accion === 'aprobar') ctx.alCambiarInventario?.();
    ctx.toast(accion === 'aprobar' ? 'Ficha aprobada: el local queda verificado.' : 'Ficha devuelta al supervisor.');
  } catch (e) { ctx.toast(`No se pudo ${accion === 'aprobar' ? 'aprobar' : 'devolver'}: ${e.message}`); btn.disabled = false; repintarRevision(); }
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
    const rv = e.target.closest('[data-ficha-revisar]');
    if (rv) { abrirRevision(rv.dataset.fichaRevisar); return; }
    if (e.target.closest('[data-ficha-revision-cerrar]')) { rev = null; repintarRevision(); return; }
    const ap = e.target.closest('[data-ficha-aprobar]');
    if (ap) { decidir(ap.dataset.fichaAprobar, 'aprobar', ap); return; }
    const ob = e.target.closest('[data-ficha-observar]');
    if (ob) { decidir(ob.dataset.fichaObservar, 'observar', ob); return; }
    const pg = e.target.closest('[data-fichas-pag]');
    if (pg) { pag += +pg.dataset.fichasPag; document.getElementById('fichas-locales').innerHTML = pintarLocales(); }
  });
}
