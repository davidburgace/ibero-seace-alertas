// ============================================================================
// src/selector-ioarr/archivos.js — Archivos de sustento del inventario verificado
// (acta, fotos, inventario patrimonial, baja). Bucket privado ioarr-expediente,
// tabla ioarr_expediente_archivos: supabase/migrations/014_ioarr_expediente_archivos.sql
// ============================================================================

export const BUCKET_EXPEDIENTE = 'ioarr-expediente';
export const MAX_ARCHIVO = 15 * 1024 * 1024;   // igual al límite del bucket
export const MAX_POR_LOCAL = 60;
export { TIPOS_ARCHIVO } from './costos.js';

// Tipo real del archivo por sus primeros bytes (no se confía en el nombre ni en el navegador)
export function mimeDe(buf) {
  if (!buf || buf.length < 12) return null;
  const h = buf.subarray(0, 12);
  if (h.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
  if (h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (h.subarray(4, 8).toString('latin1') === 'ftyp') {
    const marca = h.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'heim', 'heis'].includes(marca)) return 'image/heic';
    if (['mif1', 'msf1'].includes(marca)) return 'image/heif';
  }
  return null;
}

// multer 1.x entrega el nombre en latin1; los nombres con tildes llegan rotos
export const nombreUtf8 = n => { try { return Buffer.from(n, 'latin1').toString('utf8'); } catch { return n; } };
export const nombreSeguro = n => String(n || 'archivo').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w.-]+/g, '_').replace(/^_+/, '').slice(-120) || 'archivo';
