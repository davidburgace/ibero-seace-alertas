// Selector IOARR — Expediente › Por colegio: lo que los Lineamientos IOARR piden por colegio
// (checklist de inventario y baja…). El servidor guarda cada colegio en los datos de
// Documentos (src/selector-ioarr/lineamientos.js) y decide quién entra al 07-C final.

const NF = new Intl.NumberFormat('es-PE');
const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ent = n => NF.format(Math.round(n || 0));
const soles = n => n == null ? '—' : 'S/ ' + NS.format(n);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PAGE = 40;
const SINO = [['', 'Sin indicar'], ['si', 'Sí'], ['no', 'No']];

let ctx = null, vista = null, version = 0, pag = 0, filtro = '', soloPend = false, editando = null;

export async function renderColegios(c) {
  ctx = c;
  c.el.innerHTML = '<div class="panel vacio">Cargando los colegios…</div>';
  const mio = ++version;
  try {
    const v = await c.api(`/proyectos/${c.proyecto.id}/colegios`);
    if (mio !== version) return;
    vista = v; pintar();
  } catch (e) { if (mio === version) c.el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`; }
}

// ─── Pintado ─────────────────────────────────────────────────────────────────
// Chips de lo que falta o de lo que avisa (los demás puntos agregan los suyos en chipsDe)
export function chipsDe(f) {
  const out = [];
  out.push(f.checklist.completo ? '<span class="chip-est ok">Inventario y baja completos</span>'
    : `<span class="chip-est alerta" title="${esc('Falta: ' + f.checklist.faltan.join('; '))}">No entra al 07-C final: checklist incompleto</span>`);
  if (f.excluido_dup) out.push('<span class="chip-est">Excluido por otra inversión</span>');
  return out.join(' ');
}
function pintar() {
  const R = vista.resumen, K = vista.comparativo;
  const q = norm(filtro).trim();
  const filas = vista.filas.filter(f => (!q || f.cod.includes(q) || norm(f.nombre).includes(q) || norm(f.dist).includes(q)) && (!soloPend || !f.checklist.completo));
  const pags = Math.max(1, Math.ceil(filas.length / PAGE)); pag = Math.min(pag, pags - 1);
  const desde = pag * PAGE;
  const rows = filas.slice(desde, desde + PAGE).map(f => `<tr>
    <td class="mono">${esc(f.cod)}</td>
    <td><span class="nm">${esc(f.nombre)}</span><span class="sub">${esc(f.dist)} · ${esc(f.niveles.join(', '))} · ${ent(f.est)} estudiantes</span></td>
    <td class="num">${f.costo ? soles(f.costo.total) : '—'}${f.costo?.niveles.length > 1 ? `<br><span class="sub">${f.costo.niveles.map(n => `${esc(n.nombre)} ${soles(n.total)}`).join(' · ')}</span>` : ''}</td>
    <td>${chipsDe(f)}</td>
    <td><button class="x" type="button" data-col-editar="${esc(f.cod)}">Editar</button></td></tr>`).join('');
  ctx.el.innerHTML = `
    <div class="kpis kpis-montos">
      <div class="kpi"><div class="v">${ent(R.colegios)}</div><div class="l">colegios en el paquete</div></div>
      <div class="kpi"><div class="v">${ent(R.completos)}</div><div class="l">con el checklist de inventario y baja completo</div></div>
      <div class="kpi${R.bloqueados ? ' destacado' : ''}"><div class="v">${ent(R.bloqueados)}</div><div class="l">no entran al 07-C final (checklist incompleto)</div></div>
      <div class="kpi"><div class="v">${soles(K?.suma)}</div><div class="l">total del paquete · ${K?.niveles.length || 0} IOARR por nivel</div></div>
    </div>
    <div class="panel"><div class="panel-cab"><h3>Por nivel</h3></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>IOARR</th><th class="num">Colegios</th><th class="num">Monto</th></tr></thead>
      <tbody>${(K?.niveles || []).map(x => `<tr><td>IOARR ${esc(x.nombre)}</td><td class="num">${ent(x.locales)}</td><td class="num">${soles(x.total)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total del paquete</td><td class="num">${ent(K?.colegios)}</td><td class="num">${soles(K?.suma)}</td></tr></tfoot></table></div></div>
    <div class="panel"><div class="panel-cab"><h3>Colegios</h3><span class="sub">Lo que los Lineamientos IOARR piden por colegio</span></div>
      <p class="sub pad">Un colegio sin el checklist de inventario y baja completo (registro en el inventario y la contabilidad, trámite de baja iniciado y documento de respaldo con fecha) no entra al Formato 07-C final. En Documentos puedes exportar un borrador con todos.</p>
      <div class="pad acciones-fila"><input id="col-buscar" type="search" placeholder="Buscar por código de local, nombre o distrito" value="${esc(filtro)}" autocomplete="off" aria-label="Buscar colegio">
        <label class="chk"><input type="checkbox" id="col-pend" ${soloPend ? 'checked' : ''}> Solo los que no entran al 07-C final</label></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Código de local</th><th>Colegio</th><th class="num">Monto</th><th>Lineamientos</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="vacio">Ningún colegio coincide.</td></tr>'}</tbody></table></div>
      ${pags > 1 ? `<div class="paginacion pad-pag"><span class="sub">${ent(desde + 1)}–${ent(Math.min(filas.length, desde + PAGE))} de ${ent(filas.length)}</span><div class="pg-btns"><button class="btn btn-ghost btn-sm" data-col-pag="-1" type="button" ${pag === 0 ? 'disabled' : ''}>Anterior</button><span class="mono">${pag + 1} / ${pags}</span><button class="btn btn-ghost btn-sm" data-col-pag="1" type="button" ${pag >= pags - 1 ? 'disabled' : ''}>Siguiente</button></div></div>` : ''}
    </div>`;
}

// ─── Edición de un colegio ───────────────────────────────────────────────────
const sel = (id, v, opciones) => `<select id="${id}">${opciones.map(([k, t]) => `<option value="${k}" ${String(v ?? '') === k ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
function modal() {
  let m = document.getElementById('m-col');
  if (m) return m;
  m = document.createElement('div');
  m.className = 'modal-overlay'; m.id = 'm-col';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'm-col-tit');
  m.innerHTML = `<form class="modal" id="f-col"><button class="cerrar" type="button" data-cerrar aria-label="Cerrar">×</button>
    <h2 id="m-col-tit">Colegio</h2><div id="col-cuerpo"></div><p class="err" id="col-err" hidden></p>
    <div class="modal-acts"><button class="btn btn-ghost" type="button" data-cerrar>Cancelar</button><button class="btn btn-primary" type="submit">Guardar</button></div></form>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-cerrar]')) m.classList.remove('open'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') m.classList.remove('open'); });
  m.querySelector('#f-col').addEventListener('submit', guardar);
  return m;
}
// Secciones del formulario: cada punto de los Lineamientos agrega la suya
export const SECCIONES = [
  {
    html: f => {
      const v = f.datos.inventario;
      return `<h3>Inventario y baja</h3>
      <p class="sub">Lineamientos 2.4.C.e y 2.4.C.f. Sin completar, el colegio no entra al Formato 07-C final.${f.checklist.completo ? '' : ` Falta: ${esc(f.checklist.faltan.join('; '))}.`}</p>
      <div class="form-grid">
        <div class="campo"><label for="col-reg">¿Registrado en el inventario?</label>${sel('col-reg', v.registrado, SINO)}</div>
        <div class="campo"><label for="col-cont">¿Registrado en la contabilidad?</label>${sel('col-cont', v.contabilidad, SINO)}</div>
        <div class="campo"><label for="col-baja">¿Trámite de baja iniciado?</label>${sel('col-baja', v.baja, SINO)}</div>
        <div class="campo"><label for="col-doc">Documento de respaldo</label>${sel('col-doc', v.doc_tipo, [['', 'Sin indicar'], ...Object.entries(vista.docs_baja)])}</div>
        <div class="campo"><label for="col-docnum">N.° del documento</label><input id="col-docnum" type="text" maxlength="120" value="${esc(v.doc_numero)}" placeholder="Ej.: Resolución Directoral N.° …"></div>
        <div class="campo"><label for="col-docfecha">Fecha del documento</label><input id="col-docfecha" type="date" value="${esc(v.doc_fecha || '')}"></div>
      </div>`;
    },
    leer: m => ({ inventario: { registrado: m.querySelector('#col-reg').value, contabilidad: m.querySelector('#col-cont').value, baja: m.querySelector('#col-baja').value,
      doc_tipo: m.querySelector('#col-doc').value, doc_numero: m.querySelector('#col-docnum').value, doc_fecha: m.querySelector('#col-docfecha').value || null } })
  },
  {
    html: f => `<div class="form-grid"><div class="campo ancho"><label for="col-nota">Nota</label><textarea id="col-nota" maxlength="500" rows="2">${esc(f.datos.nota)}</textarea></div></div>`,
    leer: m => ({ nota: m.querySelector('#col-nota').value })
  }
];
function abrir(cod) {
  const f = vista.filas.find(x => x.cod === cod); if (!f) return;
  editando = cod;
  const m = modal();
  m.querySelector('#m-col-tit').textContent = `${f.cod} · ${f.nombre}`;
  m.querySelector('#col-cuerpo').innerHTML = `<p class="sub">${esc(f.dist)} · ${esc(f.niveles.join(', '))} · ${ent(f.est)} estudiantes (padrón) · ${ent(f.aulas)} aulas (censo)</p>` + SECCIONES.map(s => s.html(f, vista)).join('');
  m.querySelector('#col-err').hidden = true;
  m.classList.add('open');
}
async function guardar(e) {
  e.preventDefault();
  const m = modal(), err = m.querySelector('#col-err'), f = vista.filas.find(x => x.cod === editando);
  const datos = SECCIONES.reduce((a, s) => ({ ...a, ...s.leer(m, f) }), {});
  try {
    await ctx.api(`/proyectos/${ctx.proyecto.id}/colegios/${encodeURIComponent(editando)}`, { method: 'PUT', body: { datos } });
    m.classList.remove('open');
    ctx.toast('Colegio guardado.');
    ctx.alCambiar?.();
    await renderColegios(ctx);
  } catch (x) { err.textContent = x.message; err.hidden = false; }
}

// Eventos delegados sobre el contenedor (se enganchan una vez)
export function enlazarColegios(el) {
  el.addEventListener('input', e => {
    if (e.target.id !== 'col-buscar' || !vista) return;
    filtro = e.target.value; pag = 0;
    const pos = e.target.selectionStart; pintar();
    const b = document.getElementById('col-buscar'); b.focus(); b.setSelectionRange(pos, pos);
  });
  el.addEventListener('change', e => { if (e.target.id === 'col-pend') { soloPend = e.target.checked; pag = 0; pintar(); } });
  el.addEventListener('click', e => {
    const ed = e.target.closest('[data-col-editar]'); if (ed) abrir(ed.dataset.colEditar);
    const pg = e.target.closest('[data-col-pag]'); if (pg) { pag += +pg.dataset.colPag; pintar(); }
  });
}
