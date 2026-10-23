// Visitas de campo — lo que se guarda en el equipo (IndexedDB), para trabajar sin señal.
//   pendientes  fotos y firmas por subir: { id, clave: '<proyecto>:<local>', tipo?: 'firma', cargo?, meta, foto: Blob, mini?: Blob, creada }
//   fichas      fichas llevadas al equipo: { clave: '<usuario>:<proyecto>:<local>', usuario, proyecto, cod, modelo, guia, ficha,
//               editable, fotos, firmas, bajada_en } (lo que devuelve el servidor al abrir la ficha)
// Lo llenado y aún no guardado en el servidor va aparte, en localStorage (campo-ficha.js).
// Sin IndexedDB (navegación privada), todo vive en memoria mientras la página está abierta.
const DB = 'campo-fotos', VERSION = 2;   // el nombre viene del paso de las fotos: se conserva para no perder la cola
const memoria = { pendientes: new Map(), fichas: new Map() };
let dbP = null;
function abrirDb() {
  if (dbP) return dbP;
  dbP = new Promise(ok => {
    try {
      const rq = indexedDB.open(DB, VERSION);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('pendientes')) db.createObjectStore('pendientes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('fichas')) db.createObjectStore('fichas', { keyPath: 'clave' });
      };
      rq.onsuccess = () => ok(rq.result);
      rq.onerror = () => ok(null);
      rq.onblocked = () => ok(null);
    } catch { ok(null); }
  });
  return dbP;
}
async function tx(st, modo, fn) {
  const db = await abrirDb();
  if (!db) return undefined;
  return new Promise((ok, mal) => {
    const t = db.transaction(st, modo), r = fn(t.objectStore(st));
    t.oncomplete = () => ok(r?.result ?? r); t.onerror = () => mal(t.error); t.onabort = () => mal(t.error);
  });
}
const seguro = async (fn, porDefecto) => { try { return await fn(); } catch (e) { console.warn('Equipo', e); return porDefecto; } };
export const colaPersistente = async () => !!(await abrirDb());

// ─── Cola de fotos y firmas ──────────────────────────────────────────────────
export async function encolar(reg) {
  const r = { ...reg, creada: reg.creada || Date.now() };
  memoria.pendientes.set(r.id, r);
  await seguro(() => tx('pendientes', 'readwrite', st => st.put(r)));
}
export async function todaLaCola() {
  const guardadas = (await seguro(() => tx('pendientes', 'readonly', st => st.getAll()), [])) || [];
  const porId = new Map([...memoria.pendientes.values(), ...guardadas].map(r => [r.id, r]));
  return [...porId.values()].sort((a, b) => a.creada - b.creada);
}
export const enCola = async clave => (await todaLaCola()).filter(r => r.clave === clave);
export async function quitarDeCola(id) {
  memoria.pendientes.delete(id);
  await seguro(() => tx('pendientes', 'readwrite', st => st.delete(id)));
}

// ─── Fichas en el equipo ─────────────────────────────────────────────────────
const claveFicha = (usuario, proyectoId, cod) => `${usuario}:${proyectoId}:${cod}`;
export async function guardarFichaEquipo(usuario, proyecto, x) {
  const r = { ...x, clave: claveFicha(usuario, proyecto.id, x.cod), usuario, proyecto: { id: proyecto.id, nombre: proyecto.nombre, region: proyecto.region }, bajada_en: x.bajada_en || new Date().toISOString() };
  memoria.fichas.set(r.clave, r);
  await seguro(() => tx('fichas', 'readwrite', st => st.put(r)));
}
export async function leerFichaEquipo(usuario, proyectoId, cod) {
  const k = claveFicha(usuario, proyectoId, cod);
  return memoria.fichas.get(k) || (await seguro(() => tx('fichas', 'readonly', st => st.get(k)), null)) || null;
}
/** { cod: bajada_en } de las fichas de un proyecto que este usuario tiene en el equipo */
export async function fichasEnEquipo(usuario, proyectoId) {
  const todas = (await seguro(() => tx('fichas', 'readonly', st => st.getAll()), [])) || [];
  const out = {};
  for (const f of [...todas, ...memoria.fichas.values()]) if (f.usuario === usuario && f.proyecto?.id === proyectoId) out[f.cod] = f.bajada_en;
  return out;
}
