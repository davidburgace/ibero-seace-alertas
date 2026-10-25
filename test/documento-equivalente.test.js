// Documento equivalente: plantillas y marcadores, promedio de cotizaciones, presupuesto, validaciones y .docx de ejemplo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  MANIFEST, TOMOS, SECCIONES_BASE, DECLARADOS, CAMPOS, OBLIGATORIAS, marcadoresPlantillas, limpiarFicha, armarTexto,
  promedioItem, precioSinIgv, presupuesto, cuadraPresupuesto, validarFicha, seccionesDe, precargar, comparacionCatalogo
} from '../src/selector-ioarr/documento-equivalente.js';
import { generarDocumentoEquivalenteDocx } from '../src/selector-ioarr/word-documento-equivalente.js';
import { FICHA_DE, CTX_DE, COTIZACIONES_DE, HOY } from './helpers/ficha-de.js';

const ficha = (cambios = {}) => limpiarFicha({ ...FICHA_DE, ...cambios });
const textoDocx = async buf => (await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string'))
  .replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const errores = (d, ctx = CTX_DE) => validarFicha(d, ctx, { hoy: HOY }).errores;

// ─── Plantillas y marcadores ────────────────────────────────────────────────
test('plantillas: plan de trabajo y tomos I a III con las secciones de la plantilla', () => {
  assert.deepEqual(TOMOS.map(t => t.id), ['PT', 'I', 'II', 'III']);
  const ids = SECCIONES_BASE.map(s => s.id);
  const rango = (t, n) => Array.from({ length: n }, (_, i) => `${t}.${i + 1}`);
  assert.deepEqual(ids, ['PT1', 'PT2', 'PT3', ...rango(1, 12), ...rango(2, 21), ...rango(3, 4)]);
  assert.equal(SECCIONES_BASE.find(s => s.id === '2.17').titulo, 'Presupuesto referencial');
  for (const id of OBLIGATORIAS) assert.ok(ids.includes(id));
});

test('marcadores: todos declarados en el MANIFEST, con fuente APP, PARCIAL o MANUAL, y todos usados', () => {
  const usados = marcadoresPlantillas();
  assert.deepEqual(usados.filter(m => !DECLARADOS.has(m)), [], 'marcadores sin declarar');
  assert.deepEqual([...DECLARADOS].filter(k => !usados.includes(k)), [], 'campos del MANIFEST que ninguna plantilla usa');
  for (const [k, c] of Object.entries(MANIFEST.campos)) {
    assert.ok(['APP', 'PARCIAL', 'MANUAL'].includes(c.fuente), k);
    assert.ok(c.descripcion, k);
  }
});

test('sustitución: con la ficha completa no queda ningún marcador de texto; las tablas las pone el Word', () => {
  const A = armarTexto(ficha());
  assert.deepEqual(A.faltan, []);
  const todo = A.tomos.flatMap(t => [t.intro, ...t.secciones.map(s => s.texto)]).join('\n');
  const restos = [...todo.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(m => m[1]);
  assert.ok(restos.every(k => ['tabla', 'indice'].includes(MANIFEST.campos[k].tipo)), 'solo quedan tablas e índice: ' + restos.join(', '));
  assert.ok(!/\[REVISAR\]/.test(todo), 'los PARCIALES revisados no llevan la marca');
  // Los «verificar en bases» de la plantilla no se quitan
  assert.equal((todo.match(/\[VERIFICAR en bases\]/g) || []).length, 8);
});

test('sustitución: lo MANUAL vacío queda visible; lo PARCIAL sin revisar lleva [REVISAR]', () => {
  const d = ficha({ GARANTIA_COMERCIAL: '', POST_VENTA: null, revisados: {} });
  const A = armarTexto(d), s = id => A.tomos.flatMap(t => t.secciones).find(x => x.id === id).texto;
  assert.ok(A.faltan.includes('GARANTIA_COMERCIAL') && A.faltan.includes('POST_VENTA'));
  assert.match(s('2.7'), /^\{\{GARANTIA_COMERCIAL\}\} \[VERIFICAR en bases\]$/);
  assert.match(s('2.1'), /Finalidad pública de prueba\. \[REVISAR\]/);
  assert.match(s('1.3'), /\[REVISAR\]/);
});

// ─── Cotizaciones ───────────────────────────────────────────────────────────
test('promedio: sin IGV tal cual; con IGV se divide entre 1,18; las vencidas no entran', () => {
  const kit = promedioItem(COTIZACIONES_DE, 'kit', { hoy: HOY });
  assert.deepEqual([kit.vigentes, kit.proveedores, kit.sin_igv, kit.con_igv, kit.min, kit.max], [3, 3, 250, 295, 240, 260]);
  const esc = promedioItem(COTIZACIONES_DE, 'esc', { hoy: HOY });
  assert.deepEqual(esc.filas.map(f => f.sin), [300, 350, 400], 'con IGV ÷ 1,18');
  assert.equal(esc.sin_igv, 350);
  assert.equal(esc.con_igv, 413);
  assert.equal(precioSinIgv({ incluye_igv: true, precios: { kit: 100 } }, 'kit'), 84.75);
  // Mezcla: una con IGV y otra sin IGV del mismo ítem
  const mix = promedioItem([{ id: 'a', proveedor: 'A', fecha: HOY, vigencia_dias: 10, incluye_igv: true, precios: { mesa: 118 } },
    { id: 'b', proveedor: 'B', fecha: HOY, vigencia_dias: 10, incluye_igv: false, precios: { mesa: 120 } }], 'mesa', { hoy: HOY });
  assert.equal(mix.sin_igv, 110);
  // Vencida (fecha + vigencia antes de hoy) o sin vigencia: fuera del promedio
  const vencida = { id: 'v', proveedor: 'Vieja', fecha: '2026-01-01', vigencia_dias: 30, incluye_igv: false, precios: { kit: 1000 } };
  const sinVig = { id: 's', proveedor: 'Sin vigencia', fecha: HOY, vigencia_dias: null, incluye_igv: false, precios: { kit: 1000 } };
  const k2 = promedioItem([...COTIZACIONES_DE, vencida, sinVig], 'kit', { hoy: HOY });
  assert.equal(k2.sin_igv, 250);
  assert.equal(k2.filas.filter(f => !f.vigente).length, 2);
});

// ─── Presupuesto ────────────────────────────────────────────────────────────
test('presupuesto: costo directo + gastos generales + utilidad = subtotal; + IGV = total; resumen suma sus componentes', () => {
  const P = presupuesto(ficha({ GG_PCT: 10, UTILIDAD_PCT: 5 }), CTX_DE, { hoy: HOY });
  assert.deepEqual(P.items.map(x => [x.k, x.cantidad, x.pu, x.parcial]), [['kit', 120, 250, 30000], ['esc', 4, 350, 1400]]);
  assert.equal(P.cd, 31400);
  assert.equal(P.gg, 3140);
  assert.equal(P.ut, 1570);
  assert.equal(P.subtotal, 36110);
  assert.equal(P.igv, 6499.8);
  assert.equal(P.total, 42609.8);
  assert.deepEqual(P.resumen, { ejecucion: 42609.8, doc: 2287.5, supervision: 4500, total: 49397.3 });
  assert.deepEqual(cuadraPresupuesto(P), []);
  // Sin gastos generales ni utilidad (lo de la estructura de costos de la app)
  const P0 = presupuesto(ficha(), CTX_DE, { hoy: HOY });
  assert.equal(P0.subtotal, P0.cd);
  assert.equal(P0.total, 37052);
  // Sin precio de un ítem no hay costo directo
  assert.equal(presupuesto(ficha({ cotizaciones: COTIZACIONES_DE.slice(0, 3) }), CTX_DE, { hoy: HOY }).cd, null);
  // Comparación con el catálogo (kit sin IGV)
  assert.deepEqual(comparacionCatalogo(P0, CTX_DE.precio_ref), { k: 'kit', promedio: 250, catalogo: 250, n: 3, dif_pct: 0 });
});

// ─── Validaciones ───────────────────────────────────────────────────────────
test('validación: la ficha completa se puede exportar', () => {
  const V = validarFicha(ficha(), CTX_DE, { hoy: HOY });
  assert.deepEqual(V.errores, []);
  assert.ok(V.ok);
});

test('validación: campos APP, normas confirmadas, monto del convenio y total declarado', () => {
  assert.ok(errores(ficha({ ENTIDAD: '' })).some(e => e.k === 'ENTIDAD'));
  assert.ok(errores(ficha({ LOCALIZACION: null })).some(e => e.k === 'LOCALIZACION'));
  assert.ok(errores(ficha({ CUI: 'ABC' })).some(e => e.k === 'CUI'));
  assert.ok(errores(ficha({ normas_verificadas: false })).some(e => e.k === 'normas_verificadas'));
  assert.ok(errores(ficha({ MONTO_CONVENIO_EJECUCION: null })).some(e => e.k === 'MONTO_CONVENIO_EJECUCION'));
  assert.ok(errores(ficha(), { ...CTX_DE, locales: [] }).some(e => e.k === 'locales'));
  assert.ok(errores(ficha({ MONTO_TOTAL_DECLARADO: 43839.5 })).length === 0, 'el total declarado coincide');
  assert.ok(errores(ficha({ MONTO_TOTAL_DECLARADO: 50000 })).some(e => e.k === 'MONTO_TOTAL_DECLARADO'));
  // Lo MANUAL vacío no bloquea: queda resaltado
  const V = validarFicha(ficha({ GARANTIA_COMERCIAL: '', FORMULA_REAJUSTE: '' }), CTX_DE, { hoy: HOY });
  assert.ok(V.ok && V.advertencias.some(a => a.k === 'manual'));
});

test('validación: al menos 3 cotizaciones vigentes por ítem o una justificación escrita', () => {
  const dos = COTIZACIONES_DE.filter(c => c.proveedor !== 'Proveedor Tres EIRL');
  assert.ok(errores(ficha({ cotizaciones: dos })).some(e => e.k === 'justificaciones' && /Kit/.test(e.texto)));
  assert.ok(errores(ficha({ cotizaciones: dos, justificaciones: { kit: 'corta' } })).some(e => e.k === 'justificaciones'));
  assert.deepEqual(errores(ficha({ cotizaciones: dos, justificaciones: { kit: 'Solo dos fabricantes de la región atienden el plazo de entrega pedido.' } })), []);
  // Una vencida no cuenta como vigente
  const vencida = COTIZACIONES_DE.map(c => c.proveedor === 'Proveedor Tres EIRL' ? { ...c, fecha: '2026-01-01', vigencia_dias: 30 } : c);
  const V = validarFicha(ficha({ cotizaciones: vencida }), CTX_DE, { hoy: HOY });
  assert.ok(V.errores.some(e => e.k === 'justificaciones'));
  assert.ok(V.advertencias.some(a => /venció/.test(a.texto)));
  // Sin cotizaciones de un ítem: no hay precio unitario
  assert.ok(errores(ficha({ cotizaciones: COTIZACIONES_DE.slice(0, 3) })).some(e => e.k === 'cotizaciones' && /Escritorio/.test(e.texto)));
});

test('validación: cantidades iguales al 07-C y topes del convenio y del 07-C', () => {
  assert.ok(errores(ficha({ cantidades: { kit: 121, esc: 4 } })).some(e => e.k === 'cantidades' && /121/.test(e.texto)));
  assert.ok(errores(ficha({ cantidades: { kit: 120, esc: 4, arm: 2 } })).some(e => e.k === 'cantidades' && /no es una meta/.test(e.texto)));
  // Supera el convenio
  assert.ok(errores(ficha({ MONTO_CONVENIO_EJECUCION: 37000 })).some(e => e.k === 'MONTO_CONVENIO_EJECUCION' && /supera/.test(e.texto)));
  assert.deepEqual(errores(ficha({ MONTO_CONVENIO_EJECUCION: 37052 })), [], 'igual al convenio: no supera');
  // Supera el costo de los activos del 07-C
  assert.ok(errores(ficha(), { ...CTX_DE, total_activos: 30000 }).some(e => e.k === 'presupuesto' && /07-C/.test(e.texto)));
});

// ─── Secciones por proyecto ─────────────────────────────────────────────────
test('secciones: se pueden quitar, renombrar y agregar (salvo 2.17 y 3.4), con las bases de origen', () => {
  const d = ficha({ secciones: { quitar: ['2.18', '2.17', '3.4', 'zzz'], titulos: { '2.6': 'Servicio post venta y mantenimiento' },
    extras: [{ tomo: 'II', titulo: 'Plan de seguridad y salud', texto: '' }] } });
  assert.deepEqual(d.secciones.quitar, ['2.18'], 'las obligatorias y las desconocidas no se quitan');
  const II = seccionesDe(d).find(t => t.id === 'II').secciones;
  assert.ok(!II.some(s => s.id === '2.18') && II.some(s => s.id === '2.17'));
  assert.equal(II.find(s => s.id === '2.6').titulo, 'Servicio post venta y mantenimiento');
  assert.equal(II.at(-1).titulo, 'Plan de seguridad y salud');
  assert.match(II.at(-1).texto, /\[COMPLETAR: Plan de seguridad y salud\]/);
  // Un campo de una sección quitada no se pide
  const V = validarFicha(limpiarFicha({ ...d, FORMULA_REAJUSTE: '' }), CTX_DE, { hoy: HOY });
  assert.ok(!V.advertencias.some(a => a.k === 'manual' && /reajuste/.test(a.texto)));
});

test('precarga: toma de la ficha de bases, del expediente y de la plantilla; no inventa lo MANUAL', () => {
  const M = { nombre: 'IOARR X', cui: '2600001', F: { expediente: 2000, subtotalActivos: 70000, supervision: 3500 }, memoria: { objetivo: 'Reponer el mobiliario en mal estado.' } };
  const { datos, notas } = precargar({ M, ctx: CTX_DE, bases: { ENTIDAD: 'Gobierno Regional de Prueba', N_PROCESO: '001-2026', PLAZO_EJECUCION_DIAS: 60, normas_tecnicas: 'RVM N° 331-2021-MINEDU', MONTO_SUP_DOC_EQUIVALENTE: 500, MONTO_SUP_EJECUCION: 3000 } });
  assert.equal(datos.ENTIDAD, 'Gobierno Regional de Prueba');
  assert.match(notas.ENTIDAD, /bases/);
  assert.equal(datos.NOMBRE_IOARR, 'IOARR X');
  assert.equal(datos.MONTO_DOC_EQUIVALENTE, 2000);
  assert.equal(datos.MONTO_SUPERVISION, 3500, 'las dos supervisiones de las bases');
  assert.equal(datos.NORMAS_TECNICAS, 'RVM N° 331-2021-MINEDU');
  assert.equal(datos.bases_origen, 'Bases del Proceso de Selección N° 001-2026');
  assert.match(datos.LOCALIZACION, /MOQUEGUA.*Moquegua \(Mariscal Nieto\) y Samegua/);
  assert.equal(datos.OBJETIVO_PRINCIPAL, 'Reponer el mobiliario en mal estado.');
  assert.match(datos.CONDICIONES_AMBIENTALES, /1 de 2 en zona rural.*\[COMPLETAR\]/);
  for (const k of CAMPOS.filter(c => c.fuente === 'MANUAL' && c.k !== 'PLAZO_EJECUCION_DIAS').map(c => c.k)) assert.ok(!(k in datos), 'MANUAL sin inventar: ' + k);
});

// ─── Word ───────────────────────────────────────────────────────────────────
test('.docx de ejemplo: portada, tomos en orden, índice, presupuesto, legajo y sin la oferta interna', async () => {
  const buf = await generarDocumentoEquivalenteDocx({ datos: ficha({ GG_PCT: 10, UTILIDAD_PCT: 5 }), ctx: CTX_DE, version: 2, fecha: HOY, usuario: 'prueba@ejemplo.invalid', hoy: HOY });
  const dir = mkdtempSync(path.join(tmpdir(), 'de-'));
  writeFileSync(path.join(dir, 'documento_equivalente_ejemplo.docx'), buf);
  const z = await JSZip.loadAsync(buf), xml = await z.file('word/document.xml').async('string'), t = await textoDocx(buf);
  assert.doesNotMatch(xml, /[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  // Portada y orden (la 2.ª aparición de cada tomo: la 1.ª es su línea del índice)
  assert.match(t, /^DOCUMENTO EQUIVALENTE\nIOARR:\n“ADQUISICIÓN DE MOBILIARIO/);
  assert.match(t, /Versión 2 · 25\/10\/2026/);
  assert.match(t, /Contenido mínimo según: Bases del Proceso de Selección N° 001-2026-CE-PRUEBA, Anexo 3-A/);
  const seg = x => t.indexOf(x, t.indexOf(x) + 1);
  const orden = ['PLAN DE TRABAJO', 'TOMO I – RESUMEN EJECUTIVO', 'TOMO II – DOCUMENTO EQUIVALENTE', 'TOMO III – ESTUDIO DE MERCADO'].map(seg);
  assert.ok(orden.every((x, i) => x > (orden[i - 1] ?? 0)), 'orden: ' + orden.join(', '));
  assert.match(xml, /TOC \\h \\o &quot;1-2&quot;/);
  assert.match(await z.file('word/settings.xml').async('string'), /<w:updateFields(?: w:val="(?:true|1)")?\/>/);
  // Sin marcadores de texto pendientes
  assert.doesNotMatch(t, /\{\{[A-Z0-9_]+\}\}/);
  // Presupuesto referencial (2.17) y resumen (1.9)
  const p17 = t.slice(seg('2.17. Presupuesto referencial'));
  assert.match(p17, /Kit de mobiliario \(mesa \+ silla del estudiante\)\nKit de mobiliario\n120\n250\.00\n30,000\.00/);
  assert.match(p17, /Costo directo\n31,400\.00\nGastos generales \(10 % del costo directo\)\n3,140\.00\nUtilidad \(5 % del costo directo\)\n1,570\.00\nSubtotal\n36,110\.00\nIGV \(18 %\)\n6,499\.80\nTotal del presupuesto referencial\n42,609\.80/);
  assert.match(t.slice(seg('1.9. Presupuesto resumen')), /Total\n49,397\.30/);
  // Legajo (3.4) y precios promedio (3.1)
  const l34 = t.slice(seg('3.4. Legajo de cotizaciones'));
  assert.match(l34, /1\nProveedor Uno SAC\nRUC 20123456789\n01\/10\/2026\n30\/11\/2026/);
  assert.match(l34, /Escritorio docente: S\/ 354\.00\n\(incluye IGV\)/);
  assert.match(t.slice(seg('3.1. Criterios para determinar costos')), /Escritorio docente\n3\n300\.00\n400\.00\n350\.00\n413\.00/);
  assert.match(t, /Catálogo de precios referenciales de IOARR publicadas: S\/ 250\.00 por kit sin IGV/);
  // Verificar en bases: resaltado en amarillo
  assert.match(xml, /<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>)[\s\S])*\[VERIFICAR en bases\]/);
  // Sin la oferta interna ni nombres de empresa en los metadatos
  assert.doesNotMatch(t, /oferta \(uso interno\)|precio propio|costo propio|margen/i);
  for (const f of Object.keys(z.files).filter(f => f.endsWith('.xml'))) assert.doesNotMatch(await z.file(f).async('string'), /ibero/i, f);
});

test('vista previa: con la ficha vacía, lo pendiente queda visible y resaltado', async () => {
  const buf = await generarDocumentoEquivalenteDocx({ datos: limpiarFicha({}), ctx: CTX_DE, vistaPrevia: true, fecha: HOY, hoy: HOY });
  const z = await JSZip.loadAsync(buf), xml = await z.file('word/document.xml').async('string'), t = await textoDocx(buf);
  assert.match(t, /\{\{GARANTIA_COMERCIAL\}\}/);
  assert.match(t, /\{\{TABLA_COTIZACIONES\}\}/);
  assert.match(xml, /<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>)[\s\S])*\{\{RESPONSABLE_ELABORACION\}\}/);
  const cab = await Promise.all(Object.keys(z.files).filter(f => /header\d*\.xml$/.test(f)).map(f => z.file(f).async('string')));
  assert.ok(cab.some(h => /VISTA PREVIA CON DATOS PENDIENTES/.test(h)));
});
