// Selector IOARR — Expediente › Verificación (Etapa 3): lista de lo que falta
// para presentar el expediente. El servidor la arma (armarVerificacion en
// src/selector-ioarr/documentos.js); aquí se marcan a mano los puntos que el
// sistema no puede comprobar. Se guardan solos, en los datos de Documentos.

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ESTADO = { ok: '<span class="chip-est ok">Listo</span>', pendiente: '<span class="chip-est pend">Pendiente</span>', no: '<span class="chip-est alerta">No cumple</span>' };
const ETAPA = { detectada: 'Detectada', evaluando: 'Evaluando', convenio: 'Convenio', financiando: 'Financiando', ciprl_emitido: 'CIPRL emitido' };
const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const si = (v, txt = 'Sí') => v ? `<span class="chip-est ok">${txt}</span>` : '<span class="chip-est pend">Falta</span>';

let ctx = null, vista = null, tGuardar = null, version = 0;
const qn = () => ctx?.nivel ? `?nivel=${ctx.nivel}` : '';

export async function renderVerificacion(c) {
  ctx = c;
  c.el.innerHTML = '<div class="panel vacio">Revisando el expediente…</div>';
  const mio = ++version;
  try {
    const v = await c.api(`/proyectos/${c.proyecto.id}/documentos${qn()}`);
    if (mio !== version) return;
    vista = v; pintar();
  } catch (e) { if (mio === version) c.el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`; }
}

function pintar() {
  const V = vista.verificacion, pct = V.total ? Math.round(V.hechos / V.total * 100) : 0;
  const seccion = s => `<div class="panel"><div class="panel-cab"><h3>${esc(s.titulo)}</h3><span class="sub">${s.items.filter(x => x.estado === 'ok').length} de ${s.items.length}</span></div>
    <div class="tabla-wrap borde-0"><table class="tabla tabla-verif"><tbody>${s.items.map(x => x.manual ? `<tr>
        <td><label class="chk verif-chk"><input type="checkbox" data-verif="${x.id}" ${x.estado === 'ok' ? 'checked' : ''}> <span>${esc(x.texto)}</span></label>
          <input type="text" class="verif-nota" data-verif-nota="${x.id}" maxlength="300" value="${esc(x.nota)}" placeholder="Nota o número de documento (opcional)" aria-label="Nota"></td>
        <td>${ESTADO[x.estado]}</td></tr>`
      : `<tr><td>${esc(x.texto)}${x.nota ? `<br><span class="sub">${esc(x.nota)}</span>` : ''}</td><td>${ESTADO[x.estado]}</td></tr>`).join('')}</tbody></table></div></div>`;
  const auto = V.secciones.filter(s => !s.items.some(x => x.manual)), manual = V.secciones.filter(s => s.items.some(x => x.manual));

  ctx.el.innerHTML = `
    ${vista.sin_migracion ? '<div class="avisos"><div class="aviso alerta" role="alert">Falta ejecutar supabase/migrations/015_ioarr_expediente_documentos.sql en Supabase: las marcas no se pueden guardar.</div></div>' : ''}
    <div class="exportar">
      <div><h3>Lista de verificación${vista.nivel ? ` de la IOARR ${esc(vista.nombre_ioarr)}` : ''} · ${V.hechos} de ${V.total} listos</h3>
        <div class="avance" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
        <p>${V.bloqueos ? `<b class="aviso-linea">${V.bloqueos} punto${V.bloqueos === 1 ? '' : 's'} no cumple${V.bloqueos === 1 ? '' : 'n'}: revísalo antes de presentar.</b> ` : ''}Lo automático se actualiza con los costos, el inventario y los documentos; lo de abajo se marca a mano. <span class="guardado" id="verif-guardado"></span></p></div>
      <button class="btn btn-primary" data-verif-bajar type="button">Lista de verificación (Word)</button>
    </div>
    <div class="exportar entrega">
      <div><h3>Expediente completo (ZIP)</h3><p>Formato 07-C, memoria, lista de verificación, Excel de costos y de selección${vista.modo === 'por_nivel' ? ' de cada IOARR por nivel, cada una en su carpeta,' : ''} y todos los archivos de sustento ordenados por local, con un índice (00_LEEME.txt).${vista.ioarr ? ' Al descargarlo se registra un hito en la línea de tiempo del CUI en Radar IOARR.' : ''}</p>
        ${vista.ioarr ? `<p class="vinc-radar">Radar IOARR: <a href="ioarr.html?id=${esc(vista.ioarr.id)}" target="_blank" rel="noopener"><b>CUI ${esc(vista.ioarr.cui)}</b></a> · etapa <b>${esc(ETAPA[vista.ioarr.etapa_financista] || vista.ioarr.etapa_financista || '—')}</b>${vista.ioarr.monto_inversion != null ? ` · monto del CUI S/ ${NS.format(vista.ioarr.monto_inversion)}` : ''}</p>`
          : '<p class="sub">Sin vínculo con Radar IOARR: vincúlalo con el botón «+ Vincular con Radar IOARR» del proyecto para ver el avance en el kanban.</p>'}</div>
      <button class="btn btn-primary" data-zip-bajar type="button">Descargar expediente (ZIP)</button>
    </div>
    <div class="cols">${auto.map(seccion).join('')}</div>
    <div class="panel"><div class="panel-cab"><h3>Sustento por local</h3><span class="sub">Se adjunta en Costos → Por local → Corregir inventario</span></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Código de local</th><th>Institución educativa</th><th>Visita</th><th>Acta</th><th>Fotos</th><th>Inventario patrimonial</th><th>Baja</th><th>Año de adquisición</th></tr></thead>
      <tbody>${V.locales.map(u => `<tr><td class="mono">${esc(u.cod)}</td><td>${esc(u.nombre)}</td><td>${u.visita ? `<span class="chip-est ok">${u.visita.split('-').reverse().join('/')}</span>` : si(false)}</td>
        <td>${si(u.acta)}</td><td>${u.fotos ? `<span class="chip-est ok">${u.fotos}</span>` : si(false)}</td><td>${si(u.inventario)}</td><td>${si(u.baja)}</td><td>${si(u.anio)}</td></tr>`).join('')
        || '<tr><td colspan="8" class="vacio">Ningún local tiene bienes a reponer.</td></tr>'}</tbody></table></div></div>
    ${manual.map(seccion).join('')}`;
}

// ─── Guardado de las marcas manuales ─────────────────────────────────────────
function leer() {
  const verificacion = {};
  ctx.el.querySelectorAll('[data-verif]').forEach(chk => {
    const nota = ctx.el.querySelector(`[data-verif-nota="${chk.dataset.verif}"]`)?.value || '';
    if (chk.checked || nota.trim()) verificacion[chk.dataset.verif] = { ok: chk.checked, nota };
  });
  return verificacion;
}
function estado(t, cls = '') { const s = document.getElementById('verif-guardado'); if (s) { s.className = 'guardado ' + cls; s.textContent = t; } }

async function guardar() {
  const mio = ++version;
  estado('Guardando…', 'pend');
  try {
    const v = await ctx.api(`/proyectos/${ctx.proyecto.id}/documentos${qn()}`, { method: 'PATCH', body: { datos: { verificacion: leer() } } });
    if (mio !== version) return;
    const activo = document.activeElement?.dataset?.verifNota, pos = activo ? document.activeElement.selectionStart : null;
    vista = v; pintar();
    if (activo) { const e = ctx.el.querySelector(`[data-verif-nota="${activo}"]`); if (e) { e.focus(); try { e.setSelectionRange(pos, pos); } catch { /* sin selección */ } } }
    estado('Guardado', 'ok');
  } catch (e) { if (mio === version) estado('No se pudo guardar: ' + e.message, 'error'); }
}

// ZIP del expediente (puede tardar: incluye todas las fotos)
export async function bajarZip(c, btn) {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Armando el ZIP…';
  try {
    // c.borrador: con todos los colegios (también los que tienen el checklist de inventario y baja incompleto)
    const r = await fetch(`/api/selector-ioarr/proyectos/${c.proyecto.id}/expediente-zip${c.borrador ? '?borrador=1' : ''}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error ' + r.status);
    const blob = await r.blob(), cd = r.headers.get('Content-Disposition') || '';
    const nombre = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'Expediente_IOARR.zip');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    c.toast('Expediente descargado.');
  } catch (e) { c.toast('No se pudo armar el ZIP: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = txt; }
}

async function bajar(btn) {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Generando…';
  try {
    if (tGuardar) { clearTimeout(tGuardar); tGuardar = null; await guardar(); }
    const r = await fetch(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/documentos/verificacion${qn()}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error ' + r.status);
    const blob = await r.blob(), cd = r.headers.get('Content-Disposition') || '';
    const nombre = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'Lista_verificacion.docx');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    ctx.toast('Word descargado.');
  } catch (e) { ctx.toast('No se pudo generar: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = txt; }
}

export function enlazarVerificacion(el) {
  const programar = ms => { clearTimeout(tGuardar); estado('Cambios sin guardar', 'pend'); tGuardar = setTimeout(() => { tGuardar = null; guardar(); }, ms); };
  el.addEventListener('change', e => { if (e.target.dataset.verif) programar(50); });
  el.addEventListener('input', e => { if (e.target.dataset.verifNota) programar(900); });
  el.addEventListener('click', e => {
    if (e.target.closest('[data-verif-bajar]')) bajar(e.target.closest('[data-verif-bajar]'));
    const z = e.target.closest('[data-zip-bajar]');
    if (z && ctx) bajarZip(ctx, z);
  });
}
