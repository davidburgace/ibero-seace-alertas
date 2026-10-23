// Visitas de campo — fotos de la ficha de verificación (las usa campo-ficha.js).
//   prepararFoto(file, sello)   reduce la foto (lado mayor 1600 px, JPEG), le pone el sello abajo
//                               (local, aula, fecha y coordenadas) y arma una miniatura de 320 px
//   cola en el equipo (campo-equipo.js): la foto queda guardada hasta que se sube, aunque no haya señal
//   o se cierre la página: encolar, enCola(clave), quitarDeCola(id)
//   ubicación: seguirUbicacion() / ubicacionReciente(ms) / dejarUbicacion()

export const MAX_LADO = 1600, LADO_MINI = 320;

// ─── Imagen ──────────────────────────────────────────────────────────────────
async function decodificar(file) {
  // createImageBitmap respeta la orientación de la cámara (EXIF) en los navegadores actuales
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* sigue con <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async'; img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
const aBlob = (canvas, calidad) => new Promise((ok, mal) => canvas.toBlob(b => b ? ok(b) : mal(new Error('No se pudo comprimir la foto')), 'image/jpeg', calidad));

/**
 * @param file   la foto de la cámara o de la galería
 * @param sello  líneas de texto que van en una franja abajo de la foto
 * @returns { foto: Blob, mini: Blob, ancho, alto }
 */
export async function prepararFoto(file, sello = []) {
  const img = await decodificar(file);
  const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
  if (!w0 || !h0) throw new Error('No se pudo leer la foto');
  const k = Math.min(1, MAX_LADO / Math.max(w0, h0));
  const W = Math.round(w0 * k), H = Math.round(h0 * k);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0, W, H);
  img.close?.();
  if (sello.length) {
    const fs = Math.max(14, Math.round(Math.max(W, H) * 0.018)), pad = Math.round(fs * 0.6), alto = sello.length * fs * 1.3 + pad * 2;
    g.fillStyle = 'rgba(0,0,0,.58)'; g.fillRect(0, H - alto, W, alto);
    g.fillStyle = '#fff'; g.textBaseline = 'top'; g.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    sello.forEach((t, i) => g.fillText(String(t), pad, H - alto + pad + i * fs * 1.3, W - pad * 2));
  }
  const foto = await aBlob(cv, 0.8);
  const km = Math.min(1, LADO_MINI / Math.max(W, H));
  const cm = document.createElement('canvas'); cm.width = Math.round(W * km); cm.height = Math.round(H * km);
  cm.getContext('2d').drawImage(cv, 0, 0, cm.width, cm.height);
  const mini = await aBlob(cm, 0.7);
  return { foto, mini, ancho: W, alto: H };
}

// Identificador de la foto (el servidor lo usa para no duplicarla si la subida se reintenta)
export function nuevoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ─── Cola en el equipo: vive en campo-equipo.js (junto con las fichas guardadas para trabajar sin señal) ───
export { encolar, enCola, quitarDeCola, colaPersistente } from '/campo-equipo.js';

// ─── Ubicación ───────────────────────────────────────────────────────────────
// Mientras la ficha está abierta se sigue la ubicación, así cada foto lleva coordenadas sin esperar
let vigia = null, ultima = null;
export function seguirUbicacion() {
  if (vigia != null || !('geolocation' in navigator) || !window.isSecureContext) return;
  vigia = navigator.geolocation.watchPosition(p => { ultima = { lat: p.coords.latitude, lon: p.coords.longitude, prec: p.coords.accuracy, ts: Date.now() }; },
    () => { /* sin permiso o sin señal de GPS: las fotos van sin coordenadas */ }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 });
}
export function dejarUbicacion() {
  if (vigia != null) navigator.geolocation.clearWatch(vigia);
  vigia = null;
}
// La última ubicación de los últimos 2 minutos; si no hay, espera hasta ms milisegundos
export async function ubicacionReciente(ms = 4000) {
  const fresca = () => ultima && Date.now() - ultima.ts < 120000 ? ultima : null;
  if (fresca() || !ms) return fresca();
  seguirUbicacion();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await new Promise(r => setTimeout(r, 250)); if (fresca()) return fresca(); }
  return null;
}
