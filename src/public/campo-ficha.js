// Visitas de campo — ficha de verificación llenada en el celular o la tablet.
// El supervisor abre la ficha de un colegio asignado, la llena (lo mismo que la hoja impresa:
// secciones A a E, con el padrón y el censo ya cargados) y la envía a revisión del proveedor.
// Lo llenado se guarda en el equipo mientras se escribe (por si se cierra la página o se va la señal)
// y en el servidor con «Guardar» o al enviar. El servidor valida igual que la importación del Excel
// (src/selector-ioarr/ficha-digital.js y ficha.js).
//   abrirFicha({ proyecto: { id, nombre }, cod, toast, alCambiar(cod, ficha) })

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NF = new Intl.NumberFormat('es-PE');
const ent = n => NF.format(Math.round(n || 0));
const fechaPe = f => f ? String(f).slice(0, 10).split('-').reverse().join('/') : '';
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const vacio = v => v == null || String(v).trim() === '';
const entero = v => /^\d+$/.test(String(v ?? '').trim()) ? Number(v) : NaN;
const hora = () => new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
const LS = 'campo:ficha:';

let F = null;   // { proyecto, cod, modelo, ficha, editable, guia, d (lo llenado), sucio, toast, alCambiar }

async function api(ruta, opts = {}) {
  const r = await fetch(ruta, opts);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(b.error || `error ${r.status}`), { status: r.status, body: b });
  return b;
}
const ruta = (x = '') => `/api/campo/proyectos/${encodeURIComponent(F.proyecto.id)}/fichas/${encodeURIComponent(F.cod)}${x}`;

// ─── Borrador en el equipo ───────────────────────────────────────────────────
const claveLocal = () => LS + F.proyecto.id + ':' + F.cod;
function leerLocal() { try { return JSON.parse(localStorage.getItem(claveLocal()) || 'null'); } catch { return null; } }
function guardarLocal() { try { localStorage.setItem(claveLocal(), JSON.stringify({ ts: Date.now(), datos: datosEnvio() })); } catch { /* sin espacio: queda el servidor */ } }
function borrarLocal() { try { localStorage.removeItem(claveLocal()); } catch { /* nada */ } }

// ─── Modelo del formulario ───────────────────────────────────────────────────
const BIEN = k => F.guia.bienes.find(b => b.k === k)?.n || k;
const ORDEN = k => F.guia.bienes.findIndex(b => b.k === k);
// Cada aula con al menos una fila por bien, en el orden de la ficha (las filas de mesa extra van juntas)
function filasAula(j) {
  const a = (F.d.aulas[j] ??= { est: null, filas: [] });
  for (const b of F.guia.bienes) if (!a.filas.some(f => f.k === b.k)) a.filas.push({ k: b.k });
  a.filas.sort((x, y) => ORDEN(x.k) - ORDEN(y.k));
  return a.filas;
}
function datosVacios() {
  const M = F.modelo;
  return { a: { fecha: hoy(), verificador: '', acompanante: '', coord: M.local.lat != null ? `${M.local.lat}, ${M.local.lon}` : '' }, servicios: {}, aulas: {}, fuera: [], obs: '', firmas: {} };
}
// Lo que se manda: sin las filas vacías (el servidor vuelve a armar la ficha con el modelo)
function datosEnvio() {
  const d = F.d, lleno = o => Object.entries(o).some(([k, v]) => k !== 'k' && !vacio(v));
  const aulas = {};
  for (const [j, a] of Object.entries(d.aulas)) {
    const filas = a.filas.filter(lleno);
    if (filas.length || !vacio(a.est)) aulas[j] = { est: a.est, filas };
  }
  return { n_aulas: F.modelo.aulas.length, anio: F.modelo.anio, a: d.a, servicios: d.servicios, aulas, fuera: d.fuera.filter(lleno), obs: d.obs, firmas: d.firmas };
}

// Estado de un aula: 'sin' (nada contado), 'ok' (al menos un bien contado y nada a medias) o 'mal'
function estadoFila(f) {
  const q = [f.b, f.r, f.m], llenos = q.filter(v => !vacio(v)).length;
  if (!llenos) return 'sin';
  if (llenos < 3 || q.some(v => Number.isNaN(entero(v)))) return 'mal';
  if (!vacio(f.puestos) && f.k === 'mesa' && !(entero(f.puestos) >= 1 && entero(f.puestos) <= F.guia.max_puestos)) return 'mal';
  return 'ok';
}
function estadoAula(j) {
  const a = F.d.aulas[j];
  const es = (a?.filas || []).map(estadoFila);
  if (es.includes('mal') || (a && !vacio(a.est) && Number.isNaN(entero(a.est)))) return 'mal';
  return es.includes('ok') ? 'ok' : 'sin';
}
// Aviso del 15 % (como la importación): lo contado frente al censo, por bien, sin observación
function difiere(j, k) {
  const filas = (F.d.aulas[j]?.filas || []).filter(f => f.k === k && estadoFila(f) === 'ok');
  if (!filas.length || filas.some(f => !vacio(f.obs))) return null;
  const c = F.modelo.aulas[j].censo[k], cen = c.b + c.r + c.m;
  const ver = filas.reduce((s, f) => s + (entero(f.b) + entero(f.r) + entero(f.m)) * (k === 'mesa' && !vacio(f.puestos) ? entero(f.puestos) : 1), 0);
  const dif = cen ? Math.abs(ver - cen) / cen : ver ? 1 : 0;
  return dif > F.guia.tolerancia ? { ver, cen } : null;
}

// ─── Pintar ──────────────────────────────────────────────────────────────────
const campo = (p, valor, { label, tipo = 'text', num = false, ph = '', lista = '', ancho = '', max = '' } = {}) => `
  <label class="fh-campo ${ancho}"><span>${esc(label)}</span>
    <input type="${tipo}" data-p="${esc(p)}" value="${esc(valor ?? '')}" placeholder="${esc(ph)}"${num ? ' inputmode="numeric" pattern="[0-9]*" autocomplete="off"' : ''}${lista ? ` list="${lista}"` : ''}${max ? ` max="${max}"` : ''}></label>`;
const CHIP = { sin: '<span class="chip-est">Sin verificar</span>', ok: '<span class="chip-est ok">Verificada</span>', mal: '<span class="chip-est alerta">Incompleta</span>' };

function pintar() {
  const M = F.modelo, L = M.local, d = F.d, f = F.ficha;
  const nAulas = M.aulas.length;
  $('cFicha').innerHTML = `
  <div class="fh-cab">
    <button class="btn btn-ghost btn-sm" type="button" data-fh="cerrar">← Volver</button>
    <div class="fh-tit"><b>Ficha de verificación</b><span class="sub">Local ${esc(L.cod)} · ${esc(L.nombre)}</span></div>
    <span id="fhEstado">${chipEstado()}</span>
  </div>
  <div class="fh-cuerpo">
    ${f?.nota && f.estado === 'observada' ? `<div class="aviso alerta" role="alert">El proveedor devolvió la ficha: ${esc(f.nota)}</div>` : ''}
    ${!F.editable ? `<div class="aviso">${f.estado === 'aprobada' ? `Aprobada el ${esc(fechaPe(f.revisada_en))}: sus cantidades ya están en el expediente.` : `Enviada a revisión el ${esc(fechaPe(f.enviada_en))}. No se puede cambiar hasta que el proveedor la apruebe o la devuelva.`}</div>` : ''}
    <div id="fhErrores"></div>
    <fieldset class="fh-form" ${F.editable ? '' : 'disabled'}>
    <datalist id="fhRangos">${F.guia.rangos.map(r => `<option value="${esc(r)}">`).join('')}</datalist>

    <section class="fh-sec"><h3>A. Datos del local y de la visita</h3>
      <p class="sub">${esc(L.region)} / ${esc(L.prov)} / ${esc(L.dist)} · UGEL ${esc(L.ugel || '—')} · ${esc(L.cp)} (${L.rural ? 'rural' : 'urbana'})${L.direccion ? ' · ' + esc(L.direccion) : ''}</p>
      <div class="fh-grid">
        ${campo('a.fecha', d.a.fecha, { label: 'Fecha de la verificación', tipo: 'date', max: hoy() })}
        ${campo('a.verificador', d.a.verificador, { label: 'Verificador: nombre, cargo y DNI', ancho: 'ancho' })}
        ${campo('a.acompanante', d.a.acompanante, { label: 'Persona de la IE que acompañó: nombre y cargo', ancho: 'ancho' })}
        <div class="fh-campo ancho"><span>Coordenadas (latitud, longitud)</span>
          <div class="fh-fila"><input type="text" data-p="a.coord" value="${esc(d.a.coord)}" inputmode="decimal" autocomplete="off">
          <button class="btn btn-ghost btn-sm" type="button" data-fh="gps">Usar mi GPS</button></div>
          <span class="sub">Del padrón. Corrígelas con el GPS si el local está en otro lugar.</span></div>
      </div>
    </section>

    <section class="fh-sec"><h3>B. Servicios educativos</h3>
      <p class="sub">Contrasta los estudiantes con la nómina o el SIAGIE.</p>
      ${M.servicios.map(s => `<div class="fh-card">
        <div><b>${esc(s.nombre)}</b><span class="sub"> · ${esc(s.nombreNivel)} · cód. modular ${esc(s.modular)}${s.turno ? ' · turno ' + esc(s.turno) : ''}</span></div>
        <div class="sub">Padrón: ${ent(s.est)} estudiantes en ${ent(s.secciones)} secciones</div>
        <div class="fh-grid">
          ${campo(`s.${s.modular}.est`, d.servicios[s.modular]?.est, { label: 'Estudiantes verificados', num: true })}
          ${campo(`s.${s.modular}.obs`, d.servicios[s.modular]?.obs, { label: 'Observación', ancho: 'ancho' })}
        </div></div>`).join('')}
    </section>

    <section class="fh-sec"><h3>C. Mobiliario por aula <span class="sub" id="fhAvance"></span></h3>
      <p class="sub">Cuenta cada mueble por unidad. Si llenas un estado, llena los tres (0 si no hay). Un aula sin contar sigue con el censo. La mesa se cuenta por unidad, con sus puestos.</p>
      <details class="fh-criterios"><summary>Criterios: Bueno, Regular y Malo</summary>
        <ul>${F.guia.criterios.map(([e, cuando]) => `<li><b>${esc(e)}:</b> ${esc(cuando)}</li>`).join('')}</ul></details>
      ${nAulas ? M.aulas.map(a => pintarAula(a)).join('') : '<p class="aviso">El censo no registra aulas en este local: anota el mobiliario en la sección D o en las observaciones.</p>'}
    </section>

    <section class="fh-sec"><h3>D. Mobiliario fuera de aulas</h3>
      <p class="sub">Dirección, sala de docentes, biblioteca, laboratorio, AIP, comedor: solo si el proyecto los incluye. Es informativo, no entra al costo.</p>
      <div id="fhFuera">${pintarFuera()}</div>
      <button class="btn btn-ghost btn-sm" type="button" data-fh="mas-fuera">+ Agregar ambiente</button>
    </section>

    <section class="fh-sec"><h3>E. Observaciones y conformidad</h3>
      <label class="fh-campo ancho"><span>Observaciones del verificador</span><textarea data-p="obs" rows="4">${esc(d.obs)}</textarea></label>
      <p class="sub">Quienes dan conformidad de lo constatado en la fecha indicada.</p>
      ${F.guia.firmas.map(([k, cargo]) => `<div class="fh-card"><b>${esc(cargo)}</b><div class="fh-grid">
        ${campo(`fi.${k}.nombre`, d.firmas[k]?.nombre, { label: 'Nombres y apellidos', ancho: 'ancho' })}
        ${campo(`fi.${k}.dni`, d.firmas[k]?.dni, { label: 'DNI', num: true })}
        ${campo(`fi.${k}.fecha`, d.firmas[k]?.fecha, { label: 'Fecha', tipo: 'date', max: hoy() })}
      </div></div>`).join('')}
    </section>
    </fieldset>
  </div>
  ${F.editable ? `<div class="fh-pie">
    <span class="sub" id="fhGuardado" role="status"></span>
    <div class="acts"><button class="btn btn-ghost" type="button" data-fh="guardar">Guardar</button>
    <button class="btn btn-primary" type="button" data-fh="enviar">Enviar a revisión</button></div>
  </div>` : ''}`;
  pintarAvance();
}

const chipEstado = (f = F.ficha) => f ? `<span class="chip-est ${f.estado === 'aprobada' ? 'ok' : f.estado === 'observada' ? 'alerta' : f.estado === 'enviada' ? 'pend' : ''}">${esc(f.estado_texto)}</span>` : '<span class="chip-est">Nueva</span>';
const repintarEstado = () => { const el = $('fhEstado'); if (el) el.innerHTML = chipEstado(); };

function pintarAula(a) {
  const j = a.j, filas = filasAula(j), est = estadoAula(j), n = F.modelo.aulas.length;
  const lugar = [a.edif && `edif. ${a.edif}`, a.piso !== '' && `piso ${a.piso}`, a.num && `N.° ${a.num}`, a.turno && `turno ${a.turno}`].filter(Boolean).join(' · ');
  return `<details class="fh-aula" id="fhAula${j}" data-aula="${j}"${est === 'mal' ? ' open' : ''}>
    <summary><span class="fh-aula-tit"><span><b>Aula ${j + 1} de ${n}</b> · ${esc(a.nombreNivel)}${a.grado ? ' · ' + esc(a.grado) + (a.seccion ? ' ' + esc(a.seccion) : '') : ''}</span>
      <span class="sub">${esc(lugar)}${lugar ? ' · ' : ''}${ent(a.est)} estudiantes (censo)</span></span>
      <span data-chip-aula="${j}">${CHIP[est]}</span></summary>
    <div class="fh-aula-cuerpo">
      ${campo(`au.${j}.est`, F.d.aulas[j]?.est, { label: 'Estudiantes verificados en el aula', num: true })}
      ${filas.map((f, i) => pintarBien(a, f, i, filas)).join('')}
    </div></details>`;
}

function pintarBien(a, f, i, filas) {
  const j = a.j, c = a.censo[f.k], p = `f.${j}.${i}`;
  const mesa = f.k === 'mesa', extra = mesa && filas.findIndex(x => x.k === 'mesa') !== i;
  const ultimaMesa = mesa && filas.map(x => x.k).lastIndexOf('mesa') === i;
  const masDatos = [f.antig, f.patrimonial, f.baja, f.obs].some(v => !vacio(v));
  return `<div class="fh-bien" data-fila="${j}.${i}">
    <div class="fh-bien-cab"><b>${esc(BIEN(f.k))}${extra ? ' (otro tipo)' : ''}</b>
      ${extra ? '' : `<span class="sub">Censo${mesa ? ' (en puestos)' : ''}: Bueno ${ent(c.b)} · Regular ${ent(c.r)} · Malo ${ent(c.m)}</span>`}</div>
    <div class="fh-brm">
      ${campo(p + '.b', f.b, { label: 'Bueno', num: true, ph: '0' })}
      ${campo(p + '.r', f.r, { label: 'Regular', num: true, ph: '0' })}
      ${campo(p + '.m', f.m, { label: 'Malo', num: true, ph: '0' })}
      ${mesa ? campo(p + '.puestos', f.puestos, { label: 'Puestos por mesa', num: true, ph: '1' }) : ''}
    </div>
    <p class="fh-aviso" data-aviso="${j}.${i}">${avisoFila(j, f, i, filas)}</p>
    <details class="fh-mas"${masDatos ? ' open' : ''}><summary>Antigüedad, código patrimonial, baja y observación</summary>
      <div class="fh-grid">
        ${campo(p + '.antig', f.antig, { label: 'Antigüedad (años o rango)', lista: 'fhRangos', ph: 'Ej.: 6 o De 5 a 10' })}
        ${campo(p + '.patrimonial', f.patrimonial, { label: 'Cód. patrimonial' })}
        <label class="fh-campo"><span>Estado de baja</span><select data-p="${p}.baja">${['', 'Sí', 'No', 'En trámite'].map(v => `<option${(f.baja || '') === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        ${campo(p + '.obs', f.obs, { label: 'Observación', ancho: 'ancho', ph: 'N.° de foto, causa de la diferencia…' })}
      </div></details>
    ${extra ? `<button class="x" type="button" data-fh="quitar-mesa" data-aula="${j}" data-i="${i}">Quitar esta fila</button>` : ''}
    ${ultimaMesa ? `<button class="x" type="button" data-fh="otra-mesa" data-aula="${j}">+ Otra fila de mesa (mesas de distinto tipo)</button>` : ''}
  </div>`;
}
function avisoFila(j, f, i, filas) {
  const e = estadoFila(f);
  if (e === 'mal') {
    const q = [f.b, f.r, f.m];
    if (q.some(v => !vacio(v) && Number.isNaN(entero(v)))) return 'Usa números enteros de 0 o más.';
    if (q.some(vacio)) return 'Llena los tres estados: Bueno, Regular y Malo (0 si no hay).';
    return `Puestos por mesa: de 1 a ${F.guia.max_puestos}.`;
  }
  // El aviso del 15 % va en la última fila del bien (la suma de sus filas)
  if (filas.map(x => x.k).lastIndexOf(f.k) !== i) return '';
  const x = difiere(j, f.k);
  return x ? `Contaste ${ent(x.ver)}${f.k === 'mesa' ? ' puestos' : ''} y el censo dice ${ent(x.cen)}: difiere en más de 15 %. Explica la causa en la observación.` : '';
}

function pintarFuera() {
  if (!F.d.fuera.length) return '<p class="sub">Ningún ambiente agregado.</p>';
  return F.d.fuera.map((f, i) => `<div class="fh-card">
    <div class="fh-grid">
      ${campo(`x.${i}.ambiente`, f.ambiente, { label: 'Ambiente', ph: 'Ej.: Dirección' })}
      ${campo(`x.${i}.bien`, f.bien, { label: 'Bien', ph: 'Ej.: Escritorio' })}
    </div>
    <div class="fh-brm">
      ${campo(`x.${i}.b`, f.b, { label: 'Bueno', num: true, ph: '0' })}
      ${campo(`x.${i}.r`, f.r, { label: 'Regular', num: true, ph: '0' })}
      ${campo(`x.${i}.m`, f.m, { label: 'Malo', num: true, ph: '0' })}
    </div>
    <div class="fh-grid">
      ${campo(`x.${i}.antig`, f.antig, { label: 'Antigüedad (años o rango)', lista: 'fhRangos' })}
      ${campo(`x.${i}.obs`, f.obs, { label: 'Observación', ancho: 'ancho' })}
    </div>
    <button class="x" type="button" data-fh="quitar-fuera" data-i="${i}">Quitar este ambiente</button></div>`).join('');
}

function pintarAvance() {
  const n = F.modelo.aulas.length, el = $('fhAvance'); if (!el || !n) return;
  const es = F.modelo.aulas.map(a => estadoAula(a.j));
  const ok = es.filter(e => e === 'ok').length, mal = es.filter(e => e === 'mal').length;
  el.textContent = `· ${ent(ok)} de ${ent(n)} aulas verificadas${mal ? ` · ${ent(mal)} incompleta${mal === 1 ? '' : 's'}` : ''}`;
}
// Después de escribir en una fila de un aula: su aviso, el chip del aula y el avance
function refrescarAula(j) {
  const filas = F.d.aulas[j]?.filas || [];
  filas.forEach((f, i) => { const el = document.querySelector(`[data-aviso="${j}.${i}"]`); if (el) el.textContent = avisoFila(j, f, i, filas); });
  const chip = document.querySelector(`[data-chip-aula="${j}"]`); if (chip) chip.innerHTML = CHIP[estadoAula(j)];
  pintarAvance();
}
function rehacerAula(j) {
  const el = $('fhAula' + j); if (!el) return;
  el.outerHTML = pintarAula(F.modelo.aulas[j]);
  $('fhAula' + j).open = true;
  pintarAvance();
}

function estadoGuardado(t, cls = 'sub') { const el = $('fhGuardado'); if (el) { el.className = cls; el.textContent = t; } }

// ─── Cambios ─────────────────────────────────────────────────────────────────
function poner(p, v) {
  const [t, a, b, c] = p.split('.'), d = F.d;
  if (t === 'a') d.a[a] = v;
  else if (t === 's') (d.servicios[a] ??= {})[b] = v;
  else if (t === 'au') (d.aulas[a] ??= { est: null, filas: [] }).est = v;
  else if (t === 'f') d.aulas[a].filas[Number(b)][c] = v;
  else if (t === 'x') d.fuera[Number(a)][b] = v;
  else if (t === 'obs') d.obs = v;
  else if (t === 'fi') (d.firmas[a] ??= {})[b] = v;
  return t === 'f' || t === 'au' ? Number(a) : null;
}
let tLocal = null;
function cambio() {
  F.sucio = true;
  estadoGuardado('Cambios sin guardar en el servidor (quedan en este equipo)');
  clearTimeout(tLocal); tLocal = setTimeout(guardarLocal, 400);
}

async function guardar({ silencioso = false } = {}) {
  if (!F.editable) return true;
  clearTimeout(tLocal); guardarLocal();
  estadoGuardado('Guardando…');
  try {
    const r = await api(ruta(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datos: datosEnvio() }) });
    F.ficha = r.ficha; F.sucio = false; borrarLocal(); repintarEstado();
    estadoGuardado(`Guardado a las ${hora()}`);
    F.alCambiar?.(F.cod, F.ficha);
    return true;
  } catch (e) {
    estadoGuardado(`No se pudo guardar en el servidor (${e.message}). Lo llenado queda en este equipo.`, 'err');
    if (!silencioso) F.toast(`No se pudo guardar: ${e.message}`);
    return false;
  }
}

function pintarErrores(errores = [], avisos = [], titulo = '') {
  const el = $('fhErrores'); if (!el) return;
  document.querySelectorAll('.fh-aula.con-error').forEach(x => x.classList.remove('con-error'));
  if (!errores.length && !avisos.length) { el.innerHTML = ''; return; }
  for (const e of errores) {
    const m = String(e.fila || '').match(/^Aula (\d+)/);
    const a = m && $('fhAula' + (Number(m[1]) - 1));
    if (a) { a.classList.add('con-error'); a.open = true; }
  }
  const li = (x, tipo) => `<li>${tipo === 'e' ? '<span class="chip-est alerta">Error</span>' : '<span class="chip-est pend">Aviso</span>'} ${x.fila ? `<b>${esc(x.fila)}:</b> ` : ''}${esc(x.motivo)}</li>`;
  el.innerHTML = `<div class="aviso ${errores.length ? 'alerta' : ''}" role="alert">${esc(titulo)}
    <ul class="fh-errores">${errores.map(x => li(x, 'e')).join('')}${avisos.map(x => li(x, 'a')).join('')}</ul></div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function enviar() {
  if (!confirm('¿Enviar la ficha a revisión? Ya no podrás cambiarla, salvo que el proveedor te la devuelva.')) return;
  const b = document.querySelector('[data-fh="enviar"]'); b.disabled = true; b.textContent = 'Enviando…';
  clearTimeout(tLocal); guardarLocal();
  try {
    const r = await api(ruta('/enviar'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datos: datosEnvio() }) });
    F.ficha = r.ficha; F.editable = false; F.sucio = false; borrarLocal();
    F.alCambiar?.(F.cod, F.ficha);
    pintar();
    if (r.avisos?.length) pintarErrores([], r.avisos, 'Ficha enviada a revisión. Revisa estos avisos con el proveedor:');
    F.toast('Ficha enviada a revisión.');
  } catch (e) {
    b.disabled = false; b.textContent = 'Enviar a revisión';
    if (e.status === 422) {
      F.ficha = e.body.ficha || F.ficha; F.sucio = false; borrarLocal(); repintarEstado();
      estadoGuardado(`Guardado a las ${hora()}, sin enviar`);
      pintarErrores(e.body.errores || [], e.body.avisos || [], e.message);
    } else F.toast(`No se pudo enviar: ${e.message}. Lo llenado queda en este equipo.`);
  }
}

function usarGps() {
  if (!('geolocation' in navigator) || !window.isSecureContext) { F.toast('Este navegador no da la ubicación.'); return; }
  const b = document.querySelector('[data-fh="gps"]'); b.disabled = true; b.textContent = 'Buscando…';
  navigator.geolocation.getCurrentPosition(pos => {
    b.disabled = false; b.textContent = 'Usar mi GPS';
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    const v = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    document.querySelector('[data-p="a.coord"]').value = v; poner('a.coord', v); cambio();
    F.toast(`Coordenadas tomadas${accuracy > 50 ? ` (precisión de ±${ent(accuracy)} m: mejor al aire libre)` : ''}.`);
  }, () => { b.disabled = false; b.textContent = 'Usar mi GPS'; F.toast('No se pudo obtener tu ubicación. Revisa el permiso del navegador.'); },
  { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

// ─── Abrir y cerrar ──────────────────────────────────────────────────────────
let enlazado = false;
function enlazar() {
  if (enlazado) return; enlazado = true;
  const el = $('cFicha');
  el.addEventListener('input', e => {
    const p = e.target.dataset?.p; if (!p || !F?.editable) return;
    const j = poner(p, e.target.value);
    if (j != null) refrescarAula(j);
    cambio();
  });
  el.addEventListener('change', e => { if (e.target.tagName === 'SELECT' && e.target.dataset.p && F?.editable) { poner(e.target.dataset.p, e.target.value); cambio(); } });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-fh]'); if (!b || !F) return;
    const acc = b.dataset.fh;
    if (acc === 'cerrar') { cerrar(); return; }
    if (!F.editable) return;
    if (acc === 'guardar') guardar();
    else if (acc === 'enviar') enviar();
    else if (acc === 'gps') usarGps();
    else if (acc === 'otra-mesa' || acc === 'quitar-mesa') {
      const j = Number(b.dataset.aula), filas = F.d.aulas[j].filas;
      if (acc === 'otra-mesa') filas.splice(filas.map(x => x.k).lastIndexOf('mesa') + 1, 0, { k: 'mesa' });
      else filas.splice(Number(b.dataset.i), 1);
      rehacerAula(j); cambio();
    } else if (acc === 'mas-fuera' || acc === 'quitar-fuera') {
      if (acc === 'mas-fuera') F.d.fuera.push({}); else F.d.fuera.splice(Number(b.dataset.i), 1);
      $('fhFuera').innerHTML = pintarFuera(); cambio();
    }
  });
  // Botón «atrás» del celular: cierra la ficha en lugar de salir de la página
  addEventListener('popstate', () => { if (F && history.state?.ficha !== F.cod) cerrar({ desdeHistorial: true }); });
}

export async function abrirFicha({ proyecto, cod, toast, alCambiar }) {
  enlazar();
  const el = $('cFicha');
  F = { proyecto, cod, toast, alCambiar, sucio: false };
  el.hidden = false; document.body.classList.add('ficha-abierta');
  el.innerHTML = `<div class="fh-cab"><button class="btn btn-ghost btn-sm" type="button" data-fh="cerrar">← Volver</button><div class="fh-tit"><b>Ficha de verificación</b><span class="sub">Local ${esc(cod)} · cargando…</span></div></div>`;
  history.pushState({ ficha: cod }, '');
  let r;
  try { r = await api(ruta()); }
  catch (e) { el.innerHTML += `<div class="fh-cuerpo"><p class="aviso alerta">No se pudo abrir la ficha: ${esc(e.message)}</p></div>`; return; }
  if (F?.cod !== cod) return;
  Object.assign(F, { modelo: r.modelo, ficha: r.ficha, editable: r.editable, guia: r.guia });
  F.d = { ...datosVacios(), ...(r.ficha?.datos || {}) };
  F.d.aulas = Object.fromEntries(Object.entries(F.d.aulas || {}).map(([j, a]) => [j, { est: a.est ?? null, filas: (a.filas || []).map(f => ({ ...f })) }]));
  F.d.fuera ||= []; F.d.servicios ||= {}; F.d.firmas ||= {}; F.d.a = { ...datosVacios().a, ...(r.ficha?.datos?.a || {}) };
  // Lo llenado en este equipo y aún no guardado en el servidor (se cortó la señal o se cerró la página)
  const loc = F.editable ? leerLocal() : null;
  if (loc && loc.ts > Date.parse(r.ficha?.actualizado_en || 0)) {
    const d = loc.datos;
    F.d = { ...F.d, ...d, a: { ...F.d.a, ...d.a }, aulas: Object.fromEntries(Object.entries(d.aulas || {}).map(([j, a]) => [j, { est: a.est ?? null, filas: a.filas || [] }])) };
    F.sucio = true;
  } else if (loc) borrarLocal();
  pintar();
  if (F.sucio) { estadoGuardado('Se recuperó lo que llenaste en este equipo: guárdalo cuando tengas señal.', 'err'); }
  else if (r.ficha && F.editable) estadoGuardado(`Guardado el ${fechaPe(r.ficha.actualizado_en)}`);
}

async function cerrar({ desdeHistorial = false } = {}) {
  if (!F) return;
  // Al salir se intenta guardar en el servidor; si no hay señal, queda en el equipo
  if (F.editable && F.sucio && F.modelo) {
    const ok = await guardar({ silencioso: true });
    if (!ok) F.toast('Sin conexión: lo llenado quedó guardado en este equipo. Ábrela de nuevo para enviarla.');
  }
  F = null;
  $('cFicha').hidden = true; $('cFicha').innerHTML = ''; document.body.classList.remove('ficha-abierta');
  if (!desdeHistorial && history.state?.ficha) history.back();
}
