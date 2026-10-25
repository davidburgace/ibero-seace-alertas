// ============================================================================
// src/selector-ioarr/paquete.js — Paquete de IOARR por nivel de un proyecto (función pura)
//
// Lo usa la API del expediente (expediente.js) después de leer la base, y las pruebas.
//   calcularPaquete()  quién entra (duplicidad, checklist de inventario y baja…), las IOARR por
//                      nivel con su costo y sus avisos, la IOARR única de comparación y los escenarios
//   modeloIoarr()      el modelo de los documentos de una IOARR (07-C, memoria, anexos, vida útil)
// ============================================================================

import { calc, ESCENARIOS, textoPct } from './calculo.js';
import { costear } from './costos.js';
import { porNivel, validarNiveles, inventarioNivel, inventarioUna, sinNivel, nivelesDeLocal } from './niveles.js';
import { separarLocales, estadoDe, avisosDuplicidad } from './duplicidad.js';
import { armarModelo } from './documentos.js';
import { fichaActivos, modeloVidaUtil, checklistColegio, colegioDe, riesgoDuplicacion, ajusteTotal, VENTANA_DUP, capacidadDe, filasCapacidad } from './lineamientos.js';

/**
 * @param {object} p
 *   D, P       datos de la región (prep) y criterios (limpiarParams)
 *   codigos    códigos de local del proyecto
 *   dup        { [cod]: duplicidad } (otra inversión vigente o reciente)
 *   inv        inventario verificado por código de local (con archivos y req_ficha)
 *   comun      { precios, estructura, uit } para costear
 *   datosDoc   datos de Documentos (limpiarDatosDoc), con colegios
 *   final      true: solo los colegios con el checklist de inventario y baja completo (07-C final)
 *   modo       'por_nivel' (siempre, ver niveles.js)
 *   anioRef    año de referencia para la ventana de 3 años del chequeo de duplicación
 */
export function calcularPaquete({ D, P, codigos, dup = {}, inv = {}, comun, datosDoc = {}, final = false, modo = 'por_nivel', anioRef = new Date().getFullYear() }) {
  // Los locales con otra inversión vigente o reciente que se excluyeron no entran a la propuesta
  const sep = separarLocales(D, codigos, dup), excluidos = sep.excluidos;
  // Checklist de inventario y baja por colegio (lineamientos.js)
  const colegios = datosDoc.colegios || {};
  const checklist = Object.fromEntries(sep.list.map(i => [D.locs[i][0], checklistColegio(colegios[D.locs[i][0]], { registrado: datosDoc.inventario_registrado })]));
  const bloqueados = sep.list.filter(i => !checklist[D.locs[i][0]].completo);
  const list = final ? sep.list.filter(i => checklist[D.locs[i][0]].completo) : sep.list;
  // Chequeo de duplicación: entregas previas en los últimos 3 años, inversión en ejecución, otra inversión
  const riesgos = Object.fromEntries(sep.list.map(i => { const cod = D.locs[i][0];
    return [cod, riesgoDuplicacion(colegios[cod], { anioRef, niveles: nivelesDeLocal(D, i), dupEstado: estadoDe(dup, cod).estado })]; }));
  // Capacidad de diseño por colegio en el nivel (con la matrícula, el tope de lo que se repone)
  const capacidadesDe = nivel => Object.fromEntries(sep.list.map(i => [D.locs[i][0], capacidadDe(colegios[D.locs[i][0]], nivel, nivelesDeLocal(D, i))]).filter(([, v]) => v != null));
  const ajustesDe = nivel => Object.fromEntries(Object.entries(riesgos).map(([cod, r]) => [cod, nivel ? r.ajuste[nivel] : (Object.keys(r.ajuste).length ? ajusteTotal(r.ajuste) : null)]).filter(([, a]) => a));

  const C = calc(D, P);
  // Una IOARR (todos los niveles) y una por nivel: se calculan las dos para compararlas
  // Niveles de toda la selección: en el 07-C final, un nivel con todos sus colegios bloqueados queda vacío
  const enList = new Set(list);
  const G = porNivel(D, P, sep.list).map(g => ({ ...g, list: g.list.filter(i => enList.has(i)) })), Cn = Object.fromEntries(G.map(g => [g.nivel, g.C]));
  const Runa = costear({ D, C, list, ...comun, inventario: inventarioUna(inv, D, Cn), ajustes: ajustesDe(null), capacidades: capacidadesDe(null) });
  // Los tres escenarios de cantidad lado a lado (IOARR única, con la misma estructura y precios)
  const escenarios = ESCENARIOS.map(e => {
    const Pe = { ...P, escenario: e.k };
    const R = e.k === P.escenario ? Runa : (() => {
      const Ce = calc(D, Pe), Gn = Object.fromEntries(porNivel(D, Pe, list).map(g => [g.nivel, g.C]));
      return costear({ D, C: Ce, list, ...comun, inventario: inventarioUna(inv, D, Gn), ajustes: ajustesDe(null), capacidades: capacidadesDe(null) });
    })();
    return { k: e.k, n: e.n, pct: e.k === 'malo_regular' ? textoPct(P, G.map(g => g.nivel)) : null, actual: e.k === P.escenario, rep: R.totales.rep, kits: R.totales.kits, cd: R.totales.cd, total: R.totales.total,
      partidas: Object.fromEntries(R.partidas.map(x => [x.k, x.excluido ? null : x.rep])), aulas: R.totales.aul };
  });
  const Rniv = costear({ ...comun, grupos: G.map(g => ({ clave: g.nivel, D: g.D, C: g.C, list: g.list, inventario: inventarioNivel(inv, D, g.nivel), ajustes: ajustesDe(g.nivel), capacidades: capacidadesDe(g.nivel) })) });
  // Cada 07-C es de un solo nivel. Sin locales no hay niveles: se muestra una IOARR vacía
  const ioarrs = !G.length
    ? [{ nivel: null, nombre: 'Todos los niveles', R: Runa, D, C, list, inv: inventarioUna(inv, D, Cn) }]
    : G.map(g => ({ nivel: g.nivel, nombre: g.nombre, R: Rniv.grupos[g.nivel], D: g.D, C: g.C, list: g.list, inv: inventarioNivel(inv, D, g.nivel) }));

  // Locales de varios niveles con inventario cargado sin nivel (antes de la 018): no valen por nivel
  const sinNiv = modo === 'por_nivel' ? Object.entries(inv).filter(([cod, f]) => { const i = D.locs.findIndex(l => l[0] === cod); return i >= 0 && enList.has(i) && sinNivel(f, nivelesDeLocal(D, i)); }).map(([c]) => c) : [];
  for (const x of ioarrs) {
    const R = x.R;
    for (const l of R.locales) l.duplicidad = estadoDe(dup, l.cod);
    const fuera = x.nivel ? excluidos.filter(i => x.D.locSvc[i].length) : excluidos;
    R.excluidos = fuera.map(i => ({ cod: D.locs[i][0], nom: x.D.locName[i], dist: D.dists[D.locs[i][1]][0], rep: x.C.L.repTot[i], ...estadoDe(dup, D.locs[i][0]) }));
    R.avisos.push(...avisosDuplicidad(dup, codigos));
    // Sustento: cada local corregido debería tener al menos el acta de la visita
    const sinActa = R.locales.filter(l => l.verificado && !inv[l.cod].archivos.some(a => a.tipo === 'acta')).map(l => l.cod);
    if (sinActa.length) R.avisos.push({ tipo: 'sustento', texto: `Falta adjuntar el acta de verificación de: ${sinActa.join(', ')}. Súbela en «Corregir inventario» del local, con las fotos y el inventario patrimonial.` });
    // Colegios con el checklist incompleto: fuera del 07-C final; en el borrador, avisados
    x.bloqueados = bloqueados.filter(i => !x.nivel || x.D.locSvc[i].length).map(i => ({ cod: D.locs[i][0], nom: D.locName[i], faltan: checklist[D.locs[i][0]].faltan }));
    if (x.bloqueados.length) {
      const cods = x.bloqueados.map(b => b.cod), n = cods.length, lst = cods.slice(0, 20).join(', ') + (n > 20 ? '…' : '');
      R.avisos.push(final
        ? { tipo: 'checklist', alerta: true, texto: `No ${n === 1 ? 'entra' : 'entran'} al Formato 07-C ${n === 1 ? '1 colegio' : n + ' colegios'} con el checklist de inventario y baja incompleto: ${lst}. Complétalo en «Por colegio» o exporta el borrador.` }
        : { tipo: 'checklist', alerta: true, texto: `${n === 1 ? '1 colegio tiene' : n + ' colegios tienen'} el checklist de inventario y baja incompleto (${lst}): ${n === 1 ? 'no entrará' : 'no entrarán'} al Formato 07-C final hasta completarlo en «Por colegio». El borrador sí ${n === 1 ? 'lo incluye' : 'los incluye'}.` });
    }
    // Riesgo de duplicación: colegios de la IOARR con entrega reciente sin descontar o inversión en ejecución
    x.riesgos = x.list.filter(i => riesgos[D.locs[i][0]]?.riesgo).map(i => ({ cod: D.locs[i][0], nom: D.locName[i], motivos: riesgos[D.locs[i][0]].motivos }));
    if (x.riesgos.length) R.avisos.push({ tipo: 'duplicacion', alerta: true, texto: `Riesgo de duplicación en ${x.riesgos.length === 1 ? '1 colegio' : x.riesgos.length + ' colegios'} (entrega de mobiliario en los últimos ${VENTANA_DUP} años sin descontar, inversión en ejecución u otra inversión): ${x.riesgos.slice(0, 10).map(r => `${r.cod} (${r.motivos.join('; ')})`).join(' · ')}${x.riesgos.length > 10 ? '…' : ''}. Descuenta la entrega o explica en «Por colegio».` });
    const sn = sinNiv.filter(c => R.locales.some(l => l.cod === c));
    if (sn.length) R.avisos.push({ tipo: 'inventario', alerta: true, texto: `El inventario verificado de ${sn.length === 1 ? 'el local' : 'los locales'} ${sn.join(', ')} se cargó sin nivel y el local tiene varios niveles: en esta IOARR se usa el censo. Vuelve a cargarlo por nivel en «Corregir inventario».` });
  }
  // Ningún aula ni servicio se cuenta dos veces entre las IOARR por nivel
  const control = validarNiveles(D, list, G);
  if (!control.ok) for (const x of ioarrs) x.R.avisos.push({ tipo: 'niveles', alerta: true, texto: 'Control por nivel: ' + control.errores.slice(0, 5).join(' ') });
  const fila_ = R => ({ total: R.totales.total, rep: R.totales.rep, locales: R.totales.locales, est: R.totales.est, en_uit: R.uit.enUit, supera: R.uit.supera, registro: R.uit.valor == null ? null : R.uit.supera ? 'completo' : 'abreviado' });
  const comparativo = {
    modo, uit: Runa.uit.valor ? { anio: Runa.uit.anio, valor: Runa.uit.valor, limite: Runa.uit.limite } : null,
    una: fila_(Runa), niveles: G.map(g => ({ nivel: g.nivel, nombre: g.nombre, ...fila_(Rniv.grupos[g.nivel]) })), suma: Rniv.totales.total,
    // Paquete: colegios distintos (un colegio con varios niveles cuenta una vez) y control de doble conteo
    colegios: list.length, control,
    // Colegios con datos inconsistentes del censo (mobiliario > matrícula) en algún nivel
    inconsistentes: new Set(Rniv.locales.filter(l => l.tope?.inconsistente).map(l => l.cod)).size
  };
  return { final, colegios, checklist, bloqueados, riesgos, anioRef, modo, niveles: G.map(g => g.nivel), ioarrs, comparativo, Runa, P, escenarios, D, C, list, inv, dup, excluidos };
}

/**
 * Modelo de los documentos de una IOARR (un nivel). Cada IOARR tiene su nombre y su CUI
 * (datos.por_nivel), y el vínculo con Radar IOARR vale para la IOARR que tiene ese CUI.
 * @param A  calcularPaquete() + { detalle, efectivos } (precios del catálogo y efectivos)
 */
export function modeloIoarr(A, x, datos, p, fecha) {
  const porNiv = A.modo === 'por_nivel';
  const dn = porNiv ? datos.por_nivel?.[x.nivel] || {} : null;
  const datosX = porNiv ? { ...datos, nombre_inversion: dn.nombre_inversion || '', cui: dn.cui || '' } : datos;
  const proyectoX = porNiv ? { ...p, nombre: `${p.nombre} — IOARR ${x.nombre}`, ioarr: p.ioarr && dn.cui && dn.cui === p.ioarr.cui ? p.ioarr : null } : p;
  const M = armarModelo({ R: x.R, D: x.D, list: x.list, proyecto: proyectoX, datos: datosX, precios: A.detalle, efectivos: A.efectivos, P: A.P, inv: A.inv, fecha });
  // Estructura preliminar de costos: lotes de activos a reponer (anexo de la memoria y Excel)
  const ficha = fichaActivos({ x, P: A.P, datos: datosX, anioRef: M.anioRef });
  const vida = modeloVidaUtil({ ficha, datos: datosX, umbral: A.P.umbralVida, nombreIoarr: x.nombre });
  // El Regular sin antigüedad ni daño documentado no se sustenta: queda como pendiente del expediente
  if (vida.regularSin) M.faltan.push(vida.faltan.find(t => /Regular sin antigüedad/.test(t)));
  // Checklist de inventario y baja de los colegios de la IOARR (también los que no entran al 07-C final)
  const cods = [...new Set([...x.list.map(i => x.D.locs[i][0]), ...(x.bloqueados || []).map(b => b.cod)])];
  const nom = Object.fromEntries([...x.list.map(i => [x.D.locs[i][0], x.D.locName[i]]), ...(x.bloqueados || []).map(b => [b.cod, b.nom])]);
  const checklist = cods.map(cod => { const v = colegioDe(A.colegios, cod).inventario, ch = A.checklist?.[cod] || checklistColegio(null);
    return { cod, nombre: nom[cod], ...v, registrado: v.registrado || datos.inventario_registrado || '', completo: ch.completo, faltan: ch.faltan }; });
  // Listado de riesgos de duplicación: los colegios de la IOARR con entregas o riesgo
  const riesgos = cods.map(cod => ({ cod, nombre: nom[cod], ...(A.riesgos?.[cod] || riesgoDuplicacion(null, { anioRef: A.anioRef })), descuento: x.R.locales.find(l => l.cod === cod)?.descuento || null }))
    .filter(r => r.riesgo || r.recientes.length || r.antiguas.length);
  const enRiesgo = riesgos.filter(r => r.riesgo);
  if (enRiesgo.length) M.faltan.push(`Riesgo de duplicación en ${enRiesgo.length === 1 ? '1 colegio' : enRiesgo.length + ' colegios'} (${enRiesgo.slice(0, 10).map(r => r.cod).join(', ')}${enRiesgo.length > 10 ? '…' : ''}): descuenta las entregas de los últimos ${VENTANA_DUP} años o explica por qué no hay duplicación.`);
  // No aumentar capacidad: matrícula, capacidad de diseño y existente por colegio
  const capacidad = filasCapacidad(x.R);
  if (capacidad.some(f => f.inconsistente)) M.faltan.push(`Datos inconsistentes del censo en ${capacidad.filter(f => f.inconsistente).length} colegios (más mesas o sillas que matrícula): verifícalos en campo.`);
  return Object.assign(M, { nivel: x.nivel, nombreIoarr: x.nombre, fichaActivos: ficha, vidaUtil: vida, completo: !M.faltan.length,
    borrador: !A.final, bloqueados: x.bloqueados || [], checklist, riesgos, capacidad, anioRef: A.anioRef ?? M.anioRef });
}

// La IOARR pedida (nivel); sin nivel o si no está, la primera
export const elegirIoarr = (A, nivel) => A.ioarrs.find(x => x.nivel === nivel) || A.ioarrs[0];
