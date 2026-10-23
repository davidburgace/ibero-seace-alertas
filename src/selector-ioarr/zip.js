// ============================================================================
// src/selector-ioarr/zip.js — ZIP del expediente IOARR (etapa 4)
//
// Se escribe en flujo con archiver: cada archivo se agrega y se espera a que
// se procese antes de bajar el siguiente, así la memoria no crece con el
// número de fotos. La descarga de cada archivo de sustento la hace quien llama.
// ============================================================================

import archiver from 'archiver';
import { nombreSeguro } from './archivos.js';

const ETIQ = { acta: 'Acta', foto: 'Foto', inventario_patrimonial: 'Inventario_patrimonial', baja: 'Baja', otro: 'Otro' };
const S2 = n => 'S/ ' + Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * @param {import('stream').Writable} salida   respuesta HTTP u otro destino
 * @param {object} o
 *   base        carpeta raíz dentro del ZIP
 *   piezas      [{ nombre, contenido: Buffer }] documentos generados (Word, Excel); el nombre
 *               puede llevar carpeta («01_IOARR_Inicial/01_Formato_07C_borrador.docx»)
 *   archivos    filas de ioarr_expediente_archivos (con ruta)
 *   nombreLocal { [codLocal]: nombre } para las carpetas de sustento
 *   descargar   async (ruta) => Buffer   lanza si no se pudo
 *   modelos     modelos de armarModelo(), uno por IOARR (para el índice); o M si hay una sola
 *   autor, proyecto
 * @returns {Promise<{ incluidos: string[], fallidos: string[] }>}
 */
export async function escribirZip(salida, { base, piezas, archivos, nombreLocal = {}, descargar, M, modelos, autor, proyecto }) {
  const Ms = modelos?.length ? modelos : [M];
  const zip = archiver('zip', { zlib: { level: 6 } });
  const fallo = new Promise((_, mal) => zip.on('error', mal));
  zip.on('warning', e => console.warn('[EXPEDIENTE][ZIP]', e.message));
  zip.pipe(salida);
  const agregar = (contenido, name) => Promise.race([fallo, new Promise(ok => { zip.once('entry', ok); zip.append(contenido, { name: `${base}/${name}` }); })]);

  for (const x of piezas) await agregar(x.contenido, x.nombre);

  const carpeta = cod => `06_Sustento/${nombreSeguro(`${cod} ${nombreLocal[cod] || ''}`.trim()).slice(0, 80)}`;
  const incluidos = [], fallidos = [], usados = new Set();
  for (const [j, a] of archivos.entries()) {
    let nombre = `${carpeta(a.cod_local)}/${String(j + 1).padStart(2, '0')}_${ETIQ[a.tipo] || 'Otro'}_${nombreSeguro(a.nombre_archivo)}`;
    while (usados.has(nombre)) nombre = nombre.replace(/(\.[^./]+)?$/, '_$1');
    usados.add(nombre);
    let buf;
    try { buf = await descargar(a.ruta); } catch (e) { fallidos.push(`${a.cod_local}: ${a.nombre_archivo} (${e.message})`); continue; }
    await agregar(buf, nombre);
    incluidos.push(nombre);
  }

  const varias = Ms.length > 1 || Ms[0].nivel;
  const codsUp = [...new Set(Ms.flatMap(M => M.ups.map(u => u.cod)))];
  const sinArchivos = codsUp.filter(c => !archivos.some(a => a.cod_local === c));
  const bloque = M => {
    const V = M.verificacion;
    return [
      ...(varias ? [`IOARR ${(M.nombreIoarr || '').toUpperCase()}`] : []), M.nombre,
      M.cui ? `CUI: ${M.cui}` : 'CUI: se asigna al registrar',
      `Tipo: ${M.masiva ? `inversión masiva de reposición, ${(M.upsRegistro || M.ups).length} UP` : 'IOARR de reposición, 1 UP'}`,
      M.escenarioTexto || '',
      `Monto de inversión: ${S2(M.F.total)} · Registro: ${M.registro}`,
      `Verificación: ${V.hechos} de ${V.total} puntos listos${V.bloqueos ? ` · ${V.bloqueos} no cumple(n)` : ''}`,
      ...(M.faltan.length ? ['DATOS PENDIENTES', ...M.faltan.map(x => '- ' + x)] : []), ''
    ];
  };
  const leeme = [
    `EXPEDIENTE IOARR — ${proyecto}`,
    `Generado: ${Ms[0].fecha}${autor ? ' por ' + autor : ''} (Selector IOARR, Radar Ibero)`,
    ...(varias ? [`Una IOARR por nivel: ${Ms.length} IOARR, cada una en su carpeta. Monto total de las ${Ms.length}: ${S2(Ms.reduce((a, M) => a + M.F.total, 0))}.`,
      'La norma no aclara si los niveles cuentan como un mismo servicio: confirmar con la OPMI si van separadas o en una sola IOARR.'] : []), '',
    ...Ms.flatMap(bloque),
    'CONTENIDO',
    ...piezas.map(x => '  ' + x.nombre + (x.descripcion ? ' — ' + x.descripcion : '')),
    `  06_Sustento/ — ${incluidos.length} archivo(s) de sustento, una carpeta por local${varias ? ' (comunes a todas las IOARR)' : ''}`, '',
    ...(sinArchivos.length ? ['LOCALES SIN ARCHIVOS DE SUSTENTO', ...sinArchivos.map(x => '- ' + x), ''] : []),
    ...(fallidos.length ? ['ARCHIVOS QUE NO SE PUDIERON INCLUIR', ...fallidos.map(x => '- ' + x), ''] : []),
    'El Formato 07-C es un borrador de trabajo: el registro oficial se hace en el aplicativo del Banco de Inversiones del MEF.',
    'Fuentes: Padrón de ESCALE y Censo Educativo 2025 (Minedu); Lineamientos IOARR del MEF (9.ª versión, junio 2025).'
  ].join('\r\n');
  await agregar(Buffer.from('﻿' + leeme, 'utf8'), '00_LEEME.txt');
  await Promise.race([fallo, zip.finalize()]);
  return { incluidos, fallidos };
}
