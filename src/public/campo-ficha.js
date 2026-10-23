// Visitas de campo — ficha de verificación llenada en el celular o la tablet.
// El supervisor abre la ficha de un colegio asignado, la llena (lo mismo que la hoja impresa:
// secciones A a E, con el padrón y el censo ya cargados) y la envía a revisión del proveedor.
// Lo llenado se guarda en el equipo mientras se escribe (por si se cierra la página o se va la señal)
// y en el servidor con «Guardar» o al enviar. El servidor valida igual que la importación del Excel
// (src/selector-ioarr/ficha-digital.js y ficha.js).
// Fotos (campo-fotos.js): 📷 en la fachada, en cada aula y en cada mueble. Se reducen y sellan en el
// celular, quedan en la cola del equipo y se suben solas cuando hay señal (/fichas/:cod/fotos).
// Firmas (sección E): ✍️ abre un lienzo a pantalla completa; la firma (PNG) va por la misma cola (/fichas/:cod/firmas/:cargo).
// «PDF» baja la ficha llena con fotos y firmas (/fichas/:cod/pdf).
// Sin señal (campo-equipo.js): cada ficha que se abre con señal queda guardada en el equipo (y «Llevar mis fichas»
// las guarda todas); sin señal se abre esa copia. Lo llenado, las fotos y las firmas esperan en el equipo y
// sincronizarEquipo() los sube al volver la señal, aunque la ficha esté cerrada. Enviar a revisión necesita señal.
//   abrirFicha({ proyecto: { id, nombre, region }, cod, toast, alCambiar(cod, ficha) })
//   sincronizarEquipo() → { borradores, fotos, firmas, errores }      resumenEquipo() → { borradores, fotos, firmas }
import { prepararFoto, nuevoId, encolar, enCola, quitarDeCola, colaPersistente, seguirUbicacion, dejarUbicacion, ubicacionReciente } from '/campo-fotos.js';
import { todaLaCola, guardarFichaEquipo, leerFichaEquipo } from '/campo-equipo.js';

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

let F = null;   // { proyecto, cod, modelo, ficha, editable, guia, d (lo llenado), sucio, toast, alCambiar,
                //   fotos: [{ id, aula, bien, muestra, tomada_en, lat, lon, estado: 'subida'|'pendiente'|'error', error?, reg? }] | null (sin la migración 024),
                //   urls: Map(id → URL de la miniatura), slot (dónde va la próxima foto),
                //   firmas: { cargo: { estado, firmada_en, reg? } } | null (sin la migración 025) }

async function api(ruta, opts = {}) {
  const r = await fetch(ruta, opts);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(b.error || `error ${r.status}`), { status: r.status, body: b });
  return b;
}
const rutaDe = (proyectoId, cod, x = '') => `/api/campo/proyectos/${encodeURIComponent(proyectoId)}/fichas/${encodeURIComponent(cod)}${x}`;
const ruta = (x = '') => rutaDe(F.proyecto.id, F.cod, x);
const sinSenal = e => !e?.status;   // fetch falló sin respuesta del servidor
const MSJ_SIN_SENAL = 'Sin señal: quedó guardado en este equipo y se sube solo cuando vuelva la señal.';

// ─── Borrador en el equipo ───────────────────────────────────────────────────
const claveLocal = () => LS + F.proyecto.id + ':' + F.cod;
// La copia de la ficha en el equipo, al día con lo que tiene el servidor (para abrirla sin señal)
function refrescarEquipo() {
  if (!F?.usuario || !F.modelo) return;
  const sinCola = ({ reg, estado, antes, error, reintentar, ...x }) => x;
  guardarFichaEquipo(F.usuario, F.proyecto, { cod: F.cod, modelo: F.modelo, guia: F.guia, ficha: F.ficha, editable: F.editable,
    fotos: F.fotos ? F.fotos.filter(f => f.estado === 'subida').map(sinCola) : null,
    firmas: F.firmas ? Object.fromEntries(Object.entries(F.firmas).filter(([, x]) => x.estado === 'subida').map(([k, x]) => [k, sinCola(x)])) : null });
}
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

// ─── Fotos: dónde se toman ───────────────────────────────────────────────────
// slot: 'fachada', 'local' (otra foto del local), 'a3' (vista general del aula 4) o 'a3:mesa' (detalle del mueble)
function metaSlot(slot) {
  if (slot === 'fachada') return { aula: null, bien: null, muestra: 'Fachada y letrero' };
  if (slot === 'local') return { aula: null, bien: null, muestra: 'Otra foto del local' };
  if (slot === 'acta') return { aula: null, bien: null, muestra: 'Acta firmada en papel' };
  const [a, k] = slot.slice(1).split(':');
  return { aula: Number(a), bien: k || null, muestra: k ? 'Detalle del mueble' : 'Vista general del aula' };
}
const slotDe = f => f.aula == null ? (/fachada/i.test(f.muestra || '') ? 'fachada' : /acta/i.test(f.muestra || '') ? 'acta' : 'local') : `a${f.aula}${f.bien ? ':' + f.bien : ''}`;
const lugarSlot = slot => { const m = metaSlot(slot); return m.aula == null ? m.muestra : `Aula ${m.aula + 1}${m.bien ? ' · ' + BIEN(m.bien) : ''}`; };
const fotosDe = slot => (F.fotos || []).filter(f => slotDe(f) === slot);
const ICONO = { pendiente: '⏳', error: '⚠️', subida: '' };
function htmlSlot(slot, { titulo = '' } = {}) {
  if (!F.fotos) return '';
  const fs = fotosDe(slot);
  if (!F.editable && !fs.length) return '';
  return `<div class="fh-fotos" data-slot="${slot}">
    ${titulo ? `<span class="fh-fotos-tit">${esc(titulo)}</span>` : ''}
    <div class="fh-minis">${fs.map(f => `<button type="button" class="fh-mini ${f.estado}" data-fh="ver-foto" data-id="${f.id}" aria-label="Ver foto: ${esc(lugarSlot(slot))}">
      <img data-foto-id="${f.id}" alt="">${ICONO[f.estado] ? `<span class="fh-mini-est" title="${f.estado === 'error' ? esc(f.error || 'No se pudo subir') : 'Por subir'}">${ICONO[f.estado]}</span>` : ''}</button>`).join('')}
    ${F.editable ? `<button type="button" class="btn btn-ghost btn-sm fh-cam" data-fh="foto" data-slot="${slot}">📷 Foto</button>
      <button type="button" class="x" data-fh="galeria" data-slot="${slot}">Galería</button>` : ''}</div>
  </div>`;
}
function repintarSlot(slot) {
  const el = document.querySelector(`.fh-fotos[data-slot="${slot}"]`);
  if (el) el.outerHTML = htmlSlot(slot, { titulo: el.querySelector('.fh-fotos-tit')?.textContent || '' });
  if (slot.includes(':')) refrescarAula(metaSlot(slot).aula);
  pintarPanel(); cargarMinis();
}
// Miniaturas: la de una foto por subir sale del equipo; las demás se piden al servidor (con la sesión) una sola vez
async function cargarMinis() {
  for (const img of document.querySelectorAll('#cFicha img[data-foto-id]:not([src])')) {
    const id = img.dataset.fotoId, f = F?.fotos?.find(x => x.id === id);
    if (!f) continue;
    let url = F.urls.get(id);
    if (!url && f.reg) { url = URL.createObjectURL(f.reg.mini || f.reg.foto); F.urls.set(id, url); }
    if (!url && f.estado === 'subida') {
      img.setAttribute('src', '');   // marca: ya se pidió
      try {
        const r = await fetch(ruta(`/fotos/${id}?mini=1`));
        if (!r.ok) continue;
        url = URL.createObjectURL(await r.blob()); F?.urls.set(id, url);
      } catch { continue; }
    }
    if (url) img.src = url;
  }
}
// Panel fotográfico (sección D): cuántas hay, cuántas faltan subir y lo que falta fotografiar
function pintarPanel() {
  const el = $('fhPanel'); if (!el) return;
  if (!F.fotos) { el.innerHTML = '<p class="sub">Para tomar fotos en la ficha falta ejecutar la migración 024 en Supabase. Mientras, súbelas en «Corregir inventario» del local.</p>'; return; }
  const fs = F.fotos, pend = fs.filter(f => f.estado === 'pendiente').length, err = fs.filter(f => f.estado === 'error').length;
  const malos = [];
  for (const [j, a] of Object.entries(F.d.aulas)) for (const k of new Set(a.filas.filter(f => entero(f.m) > 0).map(f => f.k))) if (!fotosDe(`a${j}:${k}`).length) malos.push(`aula ${Number(j) + 1} (${BIEN(k).toLowerCase()})`);
  const aulasSin = F.modelo.aulas.filter(a => estadoAula(a.j) === 'ok' && !fotosDe('a' + a.j).length).length;
  const item = (ok, t) => `<li class="${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${t}</li>`;
  el.innerHTML = `<p><b>${ent(fs.length)} ${fs.length === 1 ? 'foto' : 'fotos'}</b>${pend ? ` · <span class="fh-pend">${ent(pend)} por subir (se suben solas con señal)</span>` : fs.length ? ' · todas subidas' : ''}${err ? ` · <span class="err">${ent(err)} con error: ábrela para reintentar o borrarla</span>` : ''}</p>
    <ul class="fh-check">
      ${item(fotosDe('fachada').length, 'Fachada con el letrero de la institución (sección A)')}
      ${item(!aulasSin, aulasSin ? `Vista general: falta en ${ent(aulasSin)} ${aulasSin === 1 ? 'aula verificada' : 'aulas verificadas'}` : 'Vista general de las aulas verificadas')}
      ${item(!malos.length, malos.length ? `Muebles en mal estado sin foto: ${esc(malos.slice(0, 6).join(', '))}${malos.length > 6 ? ` y ${malos.length - 6} más` : ''}` : 'Detalle de cada mueble en mal estado')}
    </ul>`;
}

// ─── Firmas en pantalla ──────────────────────────────────────────────────────
const idFirma = k => `firma:${claveLocal()}:${k}`;
function htmlFirma(k) {
  if (!F.firmas) return '';
  const x = F.firmas[k];
  if (!x) return F.editable ? `<button class="btn btn-ghost fh-firmar" type="button" data-fh="firmar" data-cargo="${k}">✍️ Firmar</button>` : '<p class="sub">Sin firma en pantalla.</p>';
  return `<div class="fh-firma ${x.estado}">
    <img data-firma-img="${k}" alt="Firma">
    <span class="sub">${x.estado === 'pendiente' ? '⏳ Por subir (se sube sola con señal) · ' : x.estado === 'error' ? `⚠️ No se pudo subir: ${esc(x.error)} · ` : ''}Firmado el ${esc(fechaHora(x.firmada_en))}</span>
    ${F.editable ? `<div class="acts"><button class="x" type="button" data-fh="firmar" data-cargo="${k}">Firmar de nuevo</button><button class="x" type="button" data-fh="borrar-firma" data-cargo="${k}">Borrar firma</button></div>` : ''}
  </div>`;
}
function repintarFirma(k) { const el = document.querySelector(`[data-firma="${k}"]`); if (el) el.innerHTML = htmlFirma(k); cargarFirmas(); }
async function cargarFirmas() {
  for (const img of document.querySelectorAll('#cFicha img[data-firma-img]:not([src])')) {
    const k = img.dataset.firmaImg, x = F?.firmas?.[k]; if (!x) continue;
    img.setAttribute('src', '');
    if (x.reg) { img.src = URL.createObjectURL(x.reg.foto); continue; }
    try { const r = await fetch(ruta(`/firmas/${k}`)); if (r.ok) img.src = URL.createObjectURL(await r.blob()); } catch { /* sin señal: queda vacía */ }
  }
}

// Lienzo a pantalla completa: se firma con el dedo o un lápiz; se recorta al trazo y se guarda en PNG
function abrirLienzo(k) {
  const cargo = F.guia.firmas.find(([c]) => c === k)?.[1] || k, nombre = F.d.firmas[k]?.nombre;
  const v = $('fhVisor'); v.hidden = false; v.classList.add('firmando');
  v.innerHTML = `<div class="fh-visor-cab"><b>Firma: ${esc(cargo)}</b><span class="sub">${nombre ? esc(nombre) : 'Escribe también su nombre y DNI en la ficha'}</span></div>
    <div class="fh-lienzo"><canvas aria-label="Recuadro para firmar"></canvas><span class="fh-lienzo-linea">Firme sobre la línea</span></div>
    <div class="acts"><button class="btn btn-ghost" type="button" data-fh="firma-limpiar">Limpiar</button><button class="btn btn-ghost" type="button" data-fh="cerrar-visor">Cancelar</button>
      <button class="btn btn-primary" type="button" data-fh="firma-guardar" data-cargo="${k}">Guardar firma</button></div>`;
  const cv = v.querySelector('canvas'), dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  const g = cv.getContext('2d');
  g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#10204a'; g.lineWidth = 2.6 * dpr;
  const L = { trazos: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, ult: null };
  const pt = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  const marcar = ([x, y]) => { L.x0 = Math.min(L.x0, x); L.y0 = Math.min(L.y0, y); L.x1 = Math.max(L.x1, x); L.y1 = Math.max(L.y1, y); };
  cv.onpointerdown = e => { e.preventDefault(); cv.setPointerCapture(e.pointerId); L.ult = pt(e); marcar(L.ult); g.beginPath(); g.arc(L.ult[0], L.ult[1], g.lineWidth / 2, 0, 7); g.fillStyle = g.strokeStyle; g.fill(); L.trazos++; };
  cv.onpointermove = e => {
    if (!L.ult) return;
    for (const ev of e.getCoalescedEvents?.() || [e]) {
      const p = pt(ev), m = [(L.ult[0] + p[0]) / 2, (L.ult[1] + p[1]) / 2];
      g.beginPath(); g.moveTo(L.ult[0], L.ult[1]); g.quadraticCurveTo(L.ult[0], L.ult[1], m[0], m[1]); g.lineTo(p[0], p[1]); g.stroke();
      L.ult = p; marcar(p);
    }
  };
  cv.onpointerup = cv.onpointercancel = () => { L.ult = null; };
  F.lienzo = { cv, g, L };
}
function limpiarLienzo() { const z = F.lienzo; if (!z) return; z.g.clearRect(0, 0, z.cv.width, z.cv.height); Object.assign(z.L, { trazos: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }); }
async function guardarFirma(k) {
  const z = F.lienzo;
  if (!z?.L.trazos) { F.toast('Firma primero dentro del recuadro.'); return; }
  const pad = 12 * (window.devicePixelRatio || 1), x = Math.max(0, z.L.x0 - pad), y = Math.max(0, z.L.y0 - pad);
  const w = Math.min(z.cv.width, z.L.x1 + pad) - x, h = Math.min(z.cv.height, z.L.y1 + pad) - y;
  const esc2 = Math.min(1, 900 / w), out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * esc2)); out.height = Math.max(1, Math.round(h * esc2));
  out.getContext('2d').drawImage(z.cv, x, y, w, h, 0, 0, out.width, out.height);
  const blob = await new Promise(ok => out.toBlob(ok, 'image/png'));
  const firmada_en = new Date().toISOString(), reg = { id: idFirma(k), clave: claveLocal(), tipo: 'firma', cargo: k, meta: { firmada_en }, foto: blob };
  // La fecha de la firma, si no la escribieron, es la de hoy
  if (!F.d.firmas[k]?.fecha) { poner(`fi.${k}.fecha`, hoy()); const i = document.querySelector(`[data-p="fi.${k}.fecha"]`); if (i) i.value = hoy(); cambio(); }
  await encolar(reg);
  F.firmas[k] = { estado: 'pendiente', firmada_en, reg };
  F.lienzo = null; cerrarVisor(); repintarFirma(k);
  subirPendientes();
}
async function borrarFirma(k) {
  const x = F.firmas[k]; if (!x || !confirm('¿Borrar esta firma?')) return;
  try {
    await quitarDeCola(idFirma(k));
    if (x.estado === 'subida' || x.antes) await api(ruta(`/firmas/${k}`), { method: 'DELETE' });
  } catch (e) { F.toast(`No se pudo borrar: ${e.message}`); return; }
  delete F.firmas[k]; repintarFirma(k);
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
    <button class="btn btn-ghost btn-sm" type="button" data-fh="pdf" title="La ficha llena en PDF, con fotos y firmas"${f ? '' : ' hidden'}>PDF</button>
  </div>
  <div class="fh-cuerpo">
    ${F.sinConexion ? `<div class="aviso" id="fhSinSenal" role="status"><b>Sin señal.</b> Trabajas con la ficha guardada en este equipo el ${esc(fechaHora(F.bajadaEn))}. Lo que llenes, las fotos y las firmas quedan en el equipo y se suben solos cuando vuelva la señal. Para enviarla a revisión necesitas señal.</div>` : ''}
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
      ${htmlSlot('fachada', { titulo: 'Foto de la fachada con el letrero' })}
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

    <section class="fh-sec"><h3>D. Mobiliario fuera de aulas y panel fotográfico</h3>
      <p class="sub">Dirección, sala de docentes, biblioteca, laboratorio, AIP, comedor: solo si el proyecto los incluye. Es informativo, no entra al costo.</p>
      <div id="fhFuera">${pintarFuera()}</div>
      <button class="btn btn-ghost btn-sm" type="button" data-fh="mas-fuera">+ Agregar ambiente</button>
      <h4 class="fh-sub">Panel fotográfico</h4>
      <p class="sub">Fachada con el letrero, una vista general de cada aula y el detalle de cada mueble en mal estado. Cada foto lleva un sello con el local, el aula, la fecha y las coordenadas.</p>
      <div id="fhPanel"></div>
      ${htmlSlot('local', { titulo: 'Otras fotos del local (otros ambientes, mobiliario fuera de aulas)' })}
    </section>

    <section class="fh-sec"><h3>E. Observaciones y conformidad</h3>
      <label class="fh-campo ancho"><span>Observaciones del verificador</span><textarea data-p="obs" rows="4">${esc(d.obs)}</textarea></label>
      <p class="sub">Quienes dan conformidad de lo constatado en la fecha indicada.</p>
      ${F.firmas ? '<p class="sub">Firma al final, con la ficha completa: quien firma da conformidad de lo que dice.</p>'
        : F.editable ? `<p class="aviso">${F.sinConexion ? 'Esta copia de la ficha se guardó en el equipo sin firmas en pantalla. Ábrela con señal para firmar.' : 'La firma en pantalla no está disponible: el servidor no encuentra la tabla de firmas (migración 025). Avisa al proveedor. Mientras, firmen en papel y tómenle una foto al acta.'}</p>` : ''}
      ${F.guia.firmas.map(([k, cargo]) => `<div class="fh-card"><b>${esc(cargo)}</b><div class="fh-grid">
        ${campo(`fi.${k}.nombre`, d.firmas[k]?.nombre, { label: 'Nombres y apellidos', ancho: 'ancho' })}
        ${campo(`fi.${k}.dni`, d.firmas[k]?.dni, { label: 'DNI', num: true })}
        ${campo(`fi.${k}.fecha`, d.firmas[k]?.fecha, { label: 'Fecha', tipo: 'date', max: hoy() })}
      </div><div data-firma="${k}">${htmlFirma(k)}</div></div>`).join('')}
      ${htmlSlot('acta', { titulo: 'Si firmaron en papel: foto del acta firmada' })}
    </section>
    </fieldset>
  </div>
  <input type="file" id="fhCam" accept="image/*" capture="environment" hidden>
  <input type="file" id="fhGal" accept="image/*" multiple hidden>
  <div class="fh-visor" id="fhVisor" hidden></div>
  ${F.editable ? `<div class="fh-pie">
    <span class="sub" id="fhGuardado" role="status"></span>
    <div class="acts"><button class="btn btn-ghost" type="button" data-fh="guardar">Guardar</button>
    <button class="btn btn-primary" type="button" data-fh="enviar">Enviar a revisión</button></div>
  </div>` : ''}`;
  pintarAvance(); pintarPanel(); cargarMinis(); cargarFirmas();
}

const chipEstado = (f = F.ficha) => f ? `<span class="chip-est ${f.estado === 'aprobada' ? 'ok' : f.estado === 'observada' ? 'alerta' : f.estado === 'enviada' ? 'pend' : ''}">${esc(f.estado_texto)}</span>` : '<span class="chip-est">Nueva</span>';
// El chip del estado y el botón PDF (aparece cuando la ficha ya está guardada en el servidor)
const repintarEstado = () => {
  const el = $('fhEstado'); if (el) el.innerHTML = chipEstado();
  const b = document.querySelector('#cFicha [data-fh="pdf"]'); if (b) b.hidden = !F.ficha;
};

function pintarAula(a) {
  const j = a.j, filas = filasAula(j), est = estadoAula(j), n = F.modelo.aulas.length;
  const lugar = [a.edif && `edif. ${a.edif}`, a.piso !== '' && `piso ${a.piso}`, a.num && `N.° ${a.num}`, a.turno && `turno ${a.turno}`].filter(Boolean).join(' · ');
  return `<details class="fh-aula" id="fhAula${j}" data-aula="${j}"${est === 'mal' ? ' open' : ''}>
    <summary><span class="fh-aula-tit"><span><b>Aula ${j + 1} de ${n}</b> · ${esc(a.nombreNivel)}${a.grado ? ' · ' + esc(a.grado) + (a.seccion ? ' ' + esc(a.seccion) : '') : ''}</span>
      <span class="sub">${esc(lugar)}${lugar ? ' · ' : ''}${ent(a.est)} estudiantes (censo)</span></span>
      <span data-chip-aula="${j}">${CHIP[est]}</span></summary>
    <div class="fh-aula-cuerpo">
      ${campo(`au.${j}.est`, F.d.aulas[j]?.est, { label: 'Estudiantes verificados en el aula', num: true })}
      ${htmlSlot('a' + j, { titulo: 'Vista general del aula' })}
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
    ${filas.findIndex(x => x.k === f.k) === i ? htmlSlot(`a${j}:${f.k}`, { titulo: 'Foto del mueble (sobre todo si está en mal estado)' }) : ''}
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
  // El aviso del 15 % y el de la foto van en la última fila del bien (la suma de sus filas)
  if (filas.map(x => x.k).lastIndexOf(f.k) !== i) return '';
  const x = difiere(j, f.k);
  const sinFoto = F.fotos && F.editable && filas.some(y => y.k === f.k && entero(y.m) > 0) && !fotosDe(`a${j}:${f.k}`).length;
  return [x ? `Contaste ${ent(x.ver)}${f.k === 'mesa' ? ' puestos' : ''} y el censo dice ${ent(x.cen)}: difiere en más de 15 %. Explica la causa en la observación.` : '',
    sinFoto ? 'Hay muebles en mal estado: tómales una foto.' : ''].filter(Boolean).join(' ');
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
  pintarAvance(); pintarPanel();
}
function rehacerAula(j) {
  const el = $('fhAula' + j); if (!el) return;
  el.outerHTML = pintarAula(F.modelo.aulas[j]);
  $('fhAula' + j).open = true;
  pintarAvance(); cargarMinis();
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
    if (F.sinConexion) { F.sinConexion = false; $('fhSinSenal')?.remove(); }
    refrescarEquipo();
    return true;
  } catch (e) {
    estadoGuardado(sinSenal(e) ? 'Sin señal: lo llenado está guardado en este equipo y se sube solo con señal.' : `No se pudo guardar en el servidor (${e.message}). Lo llenado queda en este equipo.`, sinSenal(e) ? 'fh-pend' : 'err');
    if (!silencioso) F.toast(sinSenal(e) ? MSJ_SIN_SENAL : `No se pudo guardar: ${e.message}`);
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

// ─── Fotos: tomar, subir, ver y borrar ───────────────────────────────────────
const fechaHora = iso => new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
async function tomarFotos(files, slot, galeria) {
  const cod = F.cod, meta0 = metaSlot(slot);
  for (const file of files) {
    if (F?.cod !== cod) return;
    if (!/^image\//.test(file.type || 'image/')) { F.toast('Ese archivo no es una foto.'); continue; }
    const id = nuevoId();
    const tomada = galeria && file.lastModified ? new Date(file.lastModified) : new Date();
    const pos = await ubicacionReciente(galeria ? 0 : 4000);
    const meta = { ...meta0, tomada_en: tomada.toISOString(), lat: pos?.lat ?? null, lon: pos?.lon ?? null };
    const sello = [`Local ${cod} · ${lugarSlot(slot)}`, `${fechaHora(meta.tomada_en)} · ${pos ? `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}` : 'sin GPS'}`];
    let prep;
    try { prep = await prepararFoto(file, sello); }
    catch (e) { F.toast(`No se pudo procesar la foto: ${e.message}`); continue; }
    if (F?.cod !== cod) return;
    const reg = { id, clave: claveLocal(), meta, foto: prep.foto, mini: prep.mini };
    await encolar(reg);
    F.fotos.push({ id, ...meta, estado: 'pendiente', reg });
    repintarSlot(slot);
  }
  subirPendientes();
}

// Sube una foto o firma de la cola (de cualquier ficha). Lanza el error de api() (sin status = sin señal).
async function subirRegistro(proyectoId, cod, reg) {
  if (reg.tipo === 'firma') {
    const fd = new FormData(); fd.append('firma', reg.foto, `firma_${reg.cargo}.png`);
    return api(rutaDe(proyectoId, cod, `/firmas/${reg.cargo}`), { method: 'PUT', body: fd });
  }
  const fd = new FormData();
  fd.append('foto', reg.foto, reg.id + '.jpg'); if (reg.mini) fd.append('mini', reg.mini, reg.id + '_mini.jpg');
  fd.append('id', reg.id);
  for (const k of ['aula', 'bien', 'muestra', 'lat', 'lon', 'tomada_en']) fd.append(k, reg.meta[k] ?? '');
  return api(rutaDe(proyectoId, cod, '/fotos'), { method: 'POST', body: fd });
}

let subiendo = false;
// Sube las fotos de la cola, una por una. Sin señal se detiene y deja el resto para después.
async function subirPendientes() {
  if (subiendo || !F?.editable || (!F.fotos && !F.firmas)) return;
  subiendo = true;
  const yo = F, subidas = [];
  try {
    for (const f of (yo.fotos || []).filter(x => x.estado === 'pendiente' || (x.estado === 'error' && x.reintentar))) {
      if (F !== yo) return;
      try {
        await subirRegistro(yo.proyecto.id, yo.cod, f.reg);
        f.estado = 'subida'; f.reintentar = false; delete f.error;
        await quitarDeCola(f.id); subidas.push(f);
      } catch (e) {
        if (!e.status) break;                       // sin señal: queda en la cola
        f.estado = 'error'; f.error = e.message; f.reintentar = false;
        if (e.status === 503) { F.toast(e.message); break; }
      }
      if (F === yo) repintarSlot(slotDe(f));
    }
    // Firmas
    for (const [k, x] of Object.entries(yo.firmas || {})) {
      if (F !== yo || x.estado !== 'pendiente') continue;
      try {
        const r = await subirRegistro(yo.proyecto.id, yo.cod, x.reg);
        Object.assign(x, { estado: 'subida', firmada_en: r.firma.firmada_en, antes: false }); delete x.error;
        await quitarDeCola(x.reg.id); subidas.push(x);
      } catch (e) {
        if (!e.status) break;
        x.estado = 'error'; x.error = e.message;
      }
      if (F === yo) repintarFirma(k);
    }
  } finally { subiendo = false; }
  // La ficha queda creada en el servidor con la primera foto o firma: se guarda también lo llenado
  if (subidas.length && F === yo && (yo.sucio || !yo.ficha)) guardar({ silencioso: true });
  else if (subidas.length && F === yo) refrescarEquipo();
}
const pendientes = () => (F?.fotos || []).filter(f => f.estado !== 'subida').length + Object.values(F?.firmas || {}).filter(x => x.estado !== 'subida').length;

async function verFoto(id) {
  const f = F.fotos.find(x => x.id === id); if (!f) return;
  const v = $('fhVisor'), slot = slotDe(f);
  v.hidden = false;
  v.innerHTML = `<div class="fh-visor-cab"><b>${esc(lugarSlot(slot))}</b><span class="sub">${esc(fechaHora(f.tomada_en))}${f.lat != null ? ` · ${Number(f.lat).toFixed(5)}, ${Number(f.lon).toFixed(5)}` : ''}</span></div>
    <div class="fh-visor-img"><img alt="Foto: ${esc(lugarSlot(slot))}"></div>
    ${f.estado === 'error' ? `<p class="err">No se pudo subir: ${esc(f.error)}</p>` : f.estado === 'pendiente' ? '<p class="fh-pend">Por subir: se sube sola cuando haya señal.</p>' : ''}
    <div class="acts">${F.editable ? `${f.estado === 'error' ? `<button class="btn btn-ghost" type="button" data-fh="reintentar-foto" data-id="${id}">Reintentar</button>` : ''}<button class="btn btn-ghost" type="button" data-fh="borrar-foto" data-id="${id}">Borrar foto</button>` : ''}
      <button class="btn btn-primary" type="button" data-fh="cerrar-visor">Cerrar</button></div>`;
  const img = v.querySelector('img');
  if (f.reg) img.src = URL.createObjectURL(f.reg.foto);
  else {
    img.src = F.urls.get(id) || '';     // la miniatura mientras llega la foto completa
    try { const r = await fetch(ruta(`/fotos/${id}`)); if (r.ok && !v.hidden) img.src = URL.createObjectURL(await r.blob()); } catch { /* queda la miniatura */ }
  }
}
function cerrarVisor() {
  const v = $('fhVisor'); if (!v) return;
  const img = v.querySelector('img'); if (img?.src.startsWith('blob:') && ![...F.urls.values()].includes(img.src)) URL.revokeObjectURL(img.src);
  v.hidden = true; v.innerHTML = ''; v.classList.remove('firmando'); if (F) F.lienzo = null;
}
async function borrarFoto(id) {
  const f = F.fotos.find(x => x.id === id); if (!f) return;
  if (!confirm('¿Borrar esta foto?')) return;
  try {
    if (f.estado === 'subida') await api(ruta(`/fotos/${id}`), { method: 'DELETE' });
    await quitarDeCola(id);
  } catch (e) { F.toast(`No se pudo borrar: ${e.message}`); return; }
  F.fotos = F.fotos.filter(x => x.id !== id);
  const u = F.urls.get(id); if (u) { URL.revokeObjectURL(u); F.urls.delete(id); }
  cerrarVisor(); repintarSlot(slotDe(f));
}

async function bajarPdf(b) {
  if (F.editable && F.sucio && !(await guardar({ silencioso: true }))) { F.toast('Sin conexión: el PDF necesita señal.'); return; }
  if (pendientes()) F.toast('El PDF no incluye las fotos ni firmas que aún no se subieron.');
  const txt = b.textContent; b.disabled = true; b.textContent = 'Armando…';
  try {
    const r = await fetch(ruta('/pdf'));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'error ' + r.status);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: `Ficha_verificacion_llena_${F.cod}.pdf` });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) { F.toast(`No se pudo bajar el PDF: ${e.message}`); }
  finally { b.disabled = false; b.textContent = txt; }
}

async function enviar() {
  // Las fotos van antes que la ficha: con fotos sin subir no se envía
  if (pendientes()) {
    await subirPendientes();
    if (pendientes()) {
      pintarErrores([{ fila: 'Fotos y firmas', motivo: `Faltan subir ${pendientes()} (fotos o firmas). Espera a tener señal (se suben solas) o borra las que tienen error, y vuelve a enviar.` }], [], 'La ficha no se envió.');
      return;
    }
  }
  if (!confirm('¿Enviar la ficha a revisión? Ya no podrás cambiarla, salvo que el proveedor te la devuelva.')) return;
  const b = document.querySelector('[data-fh="enviar"]'); b.disabled = true; b.textContent = 'Enviando…';
  clearTimeout(tLocal); guardarLocal();
  try {
    const r = await api(ruta('/enviar'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datos: datosEnvio() }) });
    F.ficha = r.ficha; F.editable = false; F.sucio = false; F.sinConexion = false; borrarLocal();
    F.alCambiar?.(F.cod, F.ficha);
    refrescarEquipo();
    pintar();
    if (r.avisos?.length) pintarErrores([], r.avisos, 'Ficha enviada a revisión. Revisa estos avisos con el proveedor:');
    F.toast('Ficha enviada a revisión.');
  } catch (e) {
    b.disabled = false; b.textContent = 'Enviar a revisión';
    if (e.status === 422) {
      F.ficha = e.body.ficha || F.ficha; F.sucio = false; borrarLocal(); repintarEstado();
      estadoGuardado(`Guardado a las ${hora()}, sin enviar`);
      pintarErrores(e.body.errores || [], e.body.avisos || [], e.message);
    } else F.toast(sinSenal(e) ? 'Sin señal: para enviar a revisión necesitas señal. La ficha quedó guardada en este equipo.' : `No se pudo enviar: ${e.message}. Lo llenado queda en este equipo.`);
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
  el.addEventListener('change', e => {
    if (e.target.tagName === 'SELECT' && e.target.dataset.p && F?.editable) { poner(e.target.dataset.p, e.target.value); cambio(); }
    if ((e.target.id === 'fhCam' || e.target.id === 'fhGal') && F?.editable && F.slot && e.target.files.length) tomarFotos([...e.target.files], F.slot, e.target.id === 'fhGal');
  });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-fh]'); if (!b || !F) return;
    const acc = b.dataset.fh;
    if (acc === 'cerrar') { cerrar(); return; }
    if (acc === 'ver-foto') { verFoto(b.dataset.id); return; }
    if (acc === 'cerrar-visor') { cerrarVisor(); return; }
    if (acc === 'pdf') { bajarPdf(b); return; }
    if (!F.editable) return;
    if (acc === 'firmar') { abrirLienzo(b.dataset.cargo); return; }
    if (acc === 'firma-limpiar') { limpiarLienzo(); return; }
    if (acc === 'firma-guardar') { guardarFirma(b.dataset.cargo); return; }
    if (acc === 'borrar-firma') { borrarFirma(b.dataset.cargo); return; }
    if (acc === 'foto' || acc === 'galeria') { F.slot = b.dataset.slot; const i = $(acc === 'foto' ? 'fhCam' : 'fhGal'); i.value = ''; i.click(); return; }
    if (acc === 'borrar-foto') { borrarFoto(b.dataset.id); return; }
    if (acc === 'reintentar-foto') { const f = F.fotos.find(x => x.id === b.dataset.id); if (f) { f.estado = 'pendiente'; cerrarVisor(); repintarSlot(slotDe(f)); subirPendientes(); } return; }
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
  // Vuelve la señal: sube las fotos de la cola
  addEventListener('online', () => { subirPendientes(); if (F?.editable && F.sucio) guardar({ silencioso: true }); });
}

export async function abrirFicha({ proyecto, cod, toast, alCambiar }) {
  enlazar();
  const el = $('cFicha');
  F = { proyecto, cod, toast, alCambiar, sucio: false };
  el.hidden = false; document.body.classList.add('ficha-abierta');
  el.innerHTML = `<div class="fh-cab"><button class="btn btn-ghost btn-sm" type="button" data-fh="cerrar">← Volver</button><div class="fh-tit"><b>Ficha de verificación</b><span class="sub">Local ${esc(cod)} · cargando…</span></div></div>`;
  history.pushState({ ficha: cod }, '');
  F.usuario = (await window.radarSesion?.usuario().catch(() => null))?.id || null;
  let r;
  try { r = await api(ruta()); }
  catch (e) {
    // Sin señal: la copia guardada en el equipo
    const copia = sinSenal(e) && F.usuario ? await leerFichaEquipo(F.usuario, proyecto.id, cod) : null;
    if (!copia) {
      el.innerHTML += `<div class="fh-cuerpo"><p class="aviso alerta">${sinSenal(e) ? 'Sin señal, y esta ficha no está guardada en el equipo. Con señal, ábrela una vez o usa «Llevar mis fichas al equipo» antes de salir.' : 'No se pudo abrir la ficha: ' + esc(e.message)}</p></div>`;
      return;
    }
    r = copia; F.sinConexion = true; F.bajadaEn = copia.bajada_en;
  }
  if (F?.cod !== cod) return;
  Object.assign(F, { modelo: r.modelo, ficha: r.ficha, editable: r.editable, guia: r.guia, urls: new Map(),
    fotos: r.fotos ? r.fotos.map(f => ({ ...f, estado: 'subida' })) : null,
    firmas: r.firmas ? Object.fromEntries(Object.entries(r.firmas).map(([k, x]) => [k, { ...x, estado: 'subida' }])) : null });
  const cola = F.editable ? await enCola(claveLocal()) : [];
  // Firmas hechas en este equipo que aún no llegaron al servidor (reemplazan a la anterior, si había)
  for (const reg of cola.filter(x => x.tipo === 'firma')) {
    if (!F.firmas) continue;
    const srv = F.firmas[reg.cargo];
    if (srv && srv.firmada_en >= reg.meta.firmada_en) { quitarDeCola(reg.id); continue; }
    F.firmas[reg.cargo] = { estado: 'pendiente', firmada_en: reg.meta.firmada_en, reg, antes: !!srv };
  }
  if (F.fotos) {
    // Las fotos de la cola de este equipo que aún no llegaron al servidor
    const enServidor = new Set(F.fotos.map(f => f.id));
    for (const reg of cola.filter(x => x.tipo !== 'firma')) {
      if (enServidor.has(reg.id)) { quitarDeCola(reg.id); continue; }
      F.fotos.push({ id: reg.id, ...reg.meta, estado: 'pendiente', reg });
    }
    F.fotos.sort((a, b) => String(a.tomada_en).localeCompare(String(b.tomada_en)));
    if (F.editable) { seguirUbicacion(); if (!(await colaPersistente())) F.toast('Este navegador no guarda fotos sin señal (¿navegación privada?): súbelas antes de cerrar la página.'); }
  }
  F.d = { ...datosVacios(), ...(r.ficha?.datos || {}) };
  F.d.aulas = Object.fromEntries(Object.entries(F.d.aulas || {}).map(([j, a]) => [j, { est: a.est ?? null, filas: (a.filas || []).map(f => ({ ...f })) }]));
  F.d.fuera ||= []; F.d.servicios ||= {}; F.d.firmas ||= {}; F.d.a = { ...datosVacios().a, ...(r.ficha?.datos?.a || {}) };
  // Lo llenado en este equipo y aún no guardado en el servidor (se cortó la señal o se cerró la página)
  const loc = F.editable ? leerLocal() : null;
  // (una ficha creada en el servidor solo por una foto llega sin datos: manda lo del equipo)
  if (loc && (loc.ts > Date.parse(r.ficha?.actualizado_en || 0) || !r.ficha?.datos?.a)) {
    const d = loc.datos;
    F.d = { ...F.d, ...d, a: { ...F.d.a, ...d.a }, aulas: Object.fromEntries(Object.entries(d.aulas || {}).map(([j, a]) => [j, { est: a.est ?? null, filas: a.filas || [] }])) };
    F.sucio = true;
  } else if (loc) borrarLocal();
  pintar();
  if (F.sucio) estadoGuardado(F.sinConexion ? 'Lo llenado está guardado en este equipo: se sube solo con señal.' : 'Se recuperó lo que llenaste en este equipo: guárdalo cuando tengas señal.', F.sinConexion ? 'fh-pend' : 'err');
  else if (r.ficha && F.editable) estadoGuardado(`Guardado el ${fechaPe(r.ficha.actualizado_en)}`);
  if (!F.sinConexion) refrescarEquipo();
  subirPendientes();
}

async function cerrar({ desdeHistorial = false } = {}) {
  if (!F) return;
  // Al salir se intenta guardar en el servidor; si no hay señal, queda en el equipo
  if (F.editable && F.sucio && F.modelo) {
    const ok = await guardar({ silencioso: true });
    if (!ok) F.toast('Sin conexión: lo llenado quedó guardado en este equipo. Ábrela de nuevo para enviarla.');
  }
  if (pendientes()) F.toast(`${pendientes() === 1 ? 'Una foto quedó' : pendientes() + ' fotos quedaron'} en este equipo: se suben al abrir la ficha con señal.`);
  dejarUbicacion();
  for (const u of F.urls?.values() || []) URL.revokeObjectURL(u);
  F = null;
  $('cFicha').hidden = true; $('cFicha').innerHTML = ''; document.body.classList.remove('ficha-abierta');
  dispatchEvent(new Event('campo:ficha-cerrada'));   // la página actualiza lo pendiente de subir
  if (!desdeHistorial && history.state?.ficha) history.back();
}

// ─── Sincronizar todo lo que quedó en el equipo ──────────────────────────────
// Lo llenado (localStorage) y la cola de fotos y firmas de todas las fichas, aunque estén cerradas.
// La ficha abierta se encarga de lo suyo. Sin señal se detiene; un error del servidor deja el registro en la cola.
const borradores = () => {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(LS)) continue;
      const [proyecto, cod] = k.slice(LS.length).split(':');
      if (proyecto && cod) out.push({ k, proyecto, cod });
    }
  } catch { /* sin almacenamiento */ }
  return out;
};
const esLaAbierta = (proyecto, cod) => F && F.proyecto.id === proyecto && F.cod === cod;
export async function resumenEquipo() {
  const cola = await todaLaCola();
  return { borradores: borradores().filter(b => !esLaAbierta(b.proyecto, b.cod)).length, fotos: cola.filter(r => r.tipo !== 'firma').length, firmas: cola.filter(r => r.tipo === 'firma').length };
}
let sincronizando = null;
export function sincronizarEquipo() {
  sincronizando ||= (async () => {
    const out = { borradores: 0, fotos: 0, firmas: 0, errores: 0, sinSenal: false };
    try {
      for (const b of borradores()) {
        if (esLaAbierta(b.proyecto, b.cod)) continue;
        let d; try { d = JSON.parse(localStorage.getItem(b.k)); } catch { continue; }
        if (!d?.datos) continue;
        try {
          await api(rutaDe(b.proyecto, b.cod), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datos: d.datos }) });
          localStorage.removeItem(b.k); out.borradores++;
        } catch (e) {
          if (sinSenal(e)) { out.sinSenal = true; return out; }
          // La ficha ya se envió o no es de este usuario: lo guardado en el equipo ya no se puede subir
          if ([403, 404, 409].includes(e.status)) localStorage.removeItem(b.k); else out.errores++;
        }
      }
      for (const reg of await todaLaCola()) {
        const [proyecto, cod] = String(reg.clave || '').slice(LS.length).split(':');
        if (!proyecto || !cod || esLaAbierta(proyecto, cod)) continue;
        try {
          await subirRegistro(proyecto, cod, reg);
          await quitarDeCola(reg.id); out[reg.tipo === 'firma' ? 'firmas' : 'fotos']++;
        } catch (e) {
          if (sinSenal(e)) { out.sinSenal = true; return out; }
          out.errores++;
        }
      }
      return out;
    } finally { sincronizando = null; }
  })();
  return sincronizando;
}
