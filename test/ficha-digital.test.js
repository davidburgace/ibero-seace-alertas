// Ficha de verificación llenada en la app (Visitas de campo): misma validación que el Excel,
// permisos del supervisor, envío a revisión y aprobación del proveedor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { prep, calc, filtrar, FILTRO_VACIO, DEF } from '../src/selector-ioarr/calculo.js';
import { nivelesDeLocal } from '../src/selector-ioarr/niveles.js';
import { modeloFicha, generarFichaExcel, leerFicha, procesarFicha } from '../src/selector-ioarr/ficha.js';
import { limpiarFormulario, fichaDesdeFormulario, puedeEditar, origenDigital, limpiarMetaFoto, avisosFotos, panelFotos, lugarFoto, rutaFoto } from '../src/selector-ioarr/ficha-digital.js';
import { accesoFicha, fichasDelUsuario, abrirFichaCampo, guardarBorradorFicha, enviarFicha, GUIA_FICHA, subirFotoFicha, leerImagenFoto, borrarFotoFicha } from '../src/selector-ioarr/campo.js';
import { politicaSelector } from '../src/selector-ioarr/csp.js';

const leer = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const D = prep(JSON.parse(leer('src/public/data/selector-ioarr/2025/moquegua.json')));
const C = calc(D, DEF);
const LISTA = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
const iU = LISTA.find(i => nivelesDeLocal(D, i).length === 1 && D.locAul[i].length >= 2);
const COD_U = D.locs[iU][0];
const CTX = { D, C, P: DEF, codigos: new Set(LISTA.map(i => D.locs[i][0])), proyectoId: 'p-1', anioDatos: 2025, hoy: '2026-10-21', archivo: 'ficha' };
const META = { proyecto: { id: 'p-1', nombre: 'mariscal' }, anio: 2025, fecha: '2026-10-21' };
const nAulas = D.locAul[iU].length;

// Lo que manda el formulario para el local iU: aula 1 con sillas y mesas (2 puestos), estudiantes verificados
const FORM = {
  n_aulas: nAulas, anio: 2025,
  a: { fecha: '2026-10-15', verificador: 'Ana Pérez, UGEL, DNI 12345678', acompanante: 'Director', coord: '' },
  servicios: {}, fuera: [], obs: 'Sin novedad', firmas: { director: { nombre: 'Luis Q.', dni: '87654321', fecha: '2026-10-15' } },
  aulas: { 0: { est: '25', filas: [{ k: 'mesa', b: '10', r: '2', m: '1', puestos: '2', antig: 'De 5 a 10' }, { k: 'silla', b: 20, r: 3, m: 2, baja: 'No', obs: 'foto 3' }, { k: 'esc' }] } }
};

test('la ficha llenada en la app da el mismo inventario que el Excel con los mismos datos', async () => {
  const dig = procesarFicha(fichaDesdeFormulario(FORM, { proyectoId: 'p-1', cod: COD_U, region: 'Moquegua' }), CTX);
  assert.equal(dig.rechazada, false); assert.deepEqual(dig.errores, []);

  // El mismo contenido en el Excel
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await generarFichaExcel(modeloFicha(D, C, iU, META)));
  const ws = wb.getWorksheet('Ficha'), filas = [];
  ws.eachRow((row, n) => filas.push({ n, clave: row.getCell(13).value }));
  const filaDe = (clave, j = 0) => filas.filter(f => f.clave === clave)[j]?.n;
  ws.getCell(filaDe('A|fecha'), 2).value = new Date(Date.UTC(2026, 9, 15));
  ws.getCell(filaDe('A|verificador'), 2).value = FORM.a.verificador;
  ws.getCell(filaDe('A|acompanante'), 2).value = 'Director';
  ws.getCell(filaDe('AULA|0'), 12).value = 25;
  Object.entries({ 5: 10, 6: 2, 7: 1, 8: 2, 9: 'De 5 a 10' }).forEach(([c, v]) => { ws.getCell(filaDe('ITEM|mesa', 0), Number(c)).value = v; });
  Object.entries({ 5: 20, 6: 3, 7: 2, 11: 'No', 12: 'foto 3' }).forEach(([c, v]) => { ws.getCell(filaDe('ITEM|silla', 0), Number(c)).value = v; });
  ws.getCell(filaDe('E|obs'), 1).value = 'Sin novedad';
  const xls = procesarFicha(await leerFicha(Buffer.from(await wb.xlsx.writeBuffer())), CTX);

  for (const k of ['bienes', 'adquisicion', 'por_nivel', 'fecha_visita', 'responsable', 'observacion']) assert.deepEqual(dig.fila[k], xls.fila[k], k);
  assert.deepEqual(dig.fila.ficha.verif, xls.fila.ficha.verif);
  assert.deepEqual(dig.fila.ficha.aulas[0].filas.map(({ fila, ...f }) => f), xls.fila.ficha.aulas[0].filas.map(({ fila, ...f }) => f));
  assert.equal(dig.fila.ficha.aulas[0].filas[0].b, 20, 'la mesa pasa a puestos (10 mesas de 2)');
  assert.equal(dig.fila.ficha.firmas.director.nombre, 'Luis Q.');
});

test('los errores dicen el aula en lugar de la fila del Excel', () => {
  const malo = { ...FORM, aulas: { 0: { filas: [{ k: 'silla', b: '5', r: '', m: '1' }] }, 1: { filas: [{ k: 'arm', b: '1', r: '0', m: '0' }] } } };
  const r = procesarFicha(fichaDesdeFormulario(malo, { proyectoId: 'p-1', cod: COD_U }), CTX);
  assert.equal(r.rechazada, false);
  assert.equal(r.errores.length, 1);
  assert.equal(r.errores[0].fila, 'Aula 1'); assert.match(r.errores[0].motivo, /Silla del estudiante: llena los tres/);
  const sinFecha = procesarFicha(fichaDesdeFormulario({ ...FORM, a: { ...FORM.a, fecha: '' } }, { proyectoId: 'p-1', cod: COD_U }), CTX);
  assert.equal(sinFecha.rechazada, true); assert.match(sinFecha.errores.at(-1).motivo, /Falta la fecha de la verificación \(sección A\)/);
  const otroCenso = procesarFicha(fichaDesdeFormulario({ ...FORM, n_aulas: nAulas + 1 }, { proyectoId: 'p-1', cod: COD_U }), CTX);
  assert.equal(otroCenso.rechazada, true);
});

test('limpiarFormulario: solo lo que va en la ficha, con textos recortados', () => {
  const d = limpiarFormulario({
    n_aulas: '3', anio: 2025, extra: 'x', a: { fecha: '2026-10-15', verificador: 'a'.repeat(500), coord: { x: 1 } },
    servicios: { '0123456': { est: ' 30 ', obs: '' }, malo: { est: 1 }, '0999999': {} },
    aulas: { 0: { est: '', filas: [{ k: 'mesa', b: '1', hack: 'x' }, { k: 'tele', b: 1 }] }, '-1': { filas: [{ k: 'silla' }] }, x: {}, 2: { filas: [] } },
    fuera: [{}, { ambiente: 'Dirección', b: 1 }], firmas: { director: { nombre: 'Ana' }, otro: { nombre: 'X' }, ugel: {} }
  });
  assert.equal(d.n_aulas, 3); assert.equal(limpiarFormulario({ n_aulas: 'x' }).n_aulas, null); assert.equal(d.anio, 2025);
  assert.equal(d.a.verificador.length, 200); assert.equal(d.a.coord, null); assert.equal(d.a.acompanante, null);
  assert.deepEqual(d.servicios, { '0123456': { est: '30', obs: null } });
  assert.deepEqual(Object.keys(d.aulas), ['0']);
  assert.deepEqual(d.aulas[0].filas, [{ k: 'mesa', b: '1', r: null, m: null, puestos: null, antig: null, patrimonial: null, baja: null, obs: null }]);
  assert.equal(d.fuera.length, 1); assert.deepEqual(Object.keys(d.firmas), ['director']);
  assert.equal('extra' in d, false);
});

test('estados: el supervisor solo cambia un borrador o una ficha devuelta', () => {
  assert.equal(puedeEditar(undefined), true); assert.equal(puedeEditar('borrador'), true); assert.equal(puedeEditar('observada'), true);
  assert.equal(puedeEditar('enviada'), false); assert.equal(puedeEditar('aprobada'), false);
  assert.equal(origenDigital('ana@ibero.pe'), 'Ficha digital de ana@ibero.pe');
});

// ─── API de campo con un Supabase falso ─────────────────────────────────────
const UUID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
function sbFalso({ fichas = [], visitas = [], fotos = [], sinTabla = false, sinFotos = false } = {}) {
  const tablas = {
    ioarr_selector_proyectos: [{ id: UUID, usuario_id: 'prov-1', nombre: 'Moquegua 2026', region: 'Moquegua' }],
    ioarr_selector_locales: [COD_U, '100002'].map(c => ({ proyecto_id: UUID, codigo_local: c })),
    perfiles: [{ id: 'sup-1', email: 'ana@ibero.pe', rol: 'supervisor' }, { id: 'sup-2', email: 'beto@ibero.pe', rol: 'supervisor' }],
    campo_asignaciones: [{ proyecto_id: UUID, codigo_local: COD_U, supervisor_id: 'sup-1' }, { proyecto_id: UUID, codigo_local: '100002', supervisor_id: 'sup-2' }],
    campo_fichas: fichas.map(f => ({ proyecto_id: UUID, ...f })),
    campo_visitas: [...visitas],
    campo_fichas_fotos: [...fotos]
  };
  const archivos = new Map();   // bucket: ruta → Buffer
  const storage = { from: () => ({
    upload: async (ruta, buf) => { archivos.set(ruta, buf); return { error: null }; },
    download: async ruta => archivos.has(ruta) ? { data: { arrayBuffer: async () => archivos.get(ruta) }, error: null } : { data: null, error: { message: 'not found' } },
    remove: async rutas => { rutas.forEach(r => archivos.delete(r)); return { error: null }; }
  }) };
  const CLAVES = { campo_fichas: ['proyecto_id', 'codigo_local'], campo_visitas: ['codigo_local'] };
  const from = tabla => {
    const q = { eq: {}, in: null, rango: null, borrar: false };
    const filtrar = () => tablas[tabla].filter(f => Object.entries(q.eq).every(([k, v]) => f[k] === v) && (!q.in || q.in[1].includes(f[q.in[0]])));
    const fallo = (sinTabla && tabla === 'campo_fichas') || (sinFotos && tabla === 'campo_fichas_fotos') ? { code: '42P01', message: `relation "${tabla}" does not exist` } : null;
    let escrita = null;
    const b = {
      select: () => b, order: () => b,
      eq: (k, v) => { q.eq[k] = v; return b; },
      in: (k, v) => { q.in = [k, v]; return b; },
      range: (a, z) => { q.rango = [a, z]; return b; },
      maybeSingle: async () => fallo ? { data: null, error: fallo } : { data: filtrar()[0] || null, error: null },
      single: async () => fallo ? { data: null, error: fallo } : { data: escrita, error: null },
      upsert: (fila, o = {}) => {
        if (!fallo) {
          const ks = CLAVES[tabla], i = tablas[tabla].findIndex(f => ks.every(k => f[k] === fila[k]));
          if (i >= 0 && o.ignoreDuplicates) escrita = tablas[tabla][i];
          else escrita = i >= 0 ? (tablas[tabla][i] = { ...tablas[tabla][i], ...fila }) : (tablas[tabla].push({ ...fila }), fila);
        }
        return b;
      },
      insert: async fila => { if (fallo) return { error: fallo }; tablas[tabla].push({ ...fila }); return { error: null }; },
      delete: () => { q.borrar = true; return b; },
      then: (ok, mal) => {
        if (fallo) return Promise.resolve({ data: null, error: fallo }).then(ok, mal);
        if (q.borrar) { const fuera = new Set(filtrar()); tablas[tabla] = tablas[tabla].filter(f => !fuera.has(f)); return Promise.resolve({ error: null }).then(ok, mal); }
        const d = filtrar();
        return Promise.resolve({ data: q.rango ? d.slice(q.rango[0], q.rango[1] + 1) : d, error: null }).then(ok, mal);
      }
    };
    return b;
  };
  return { from, tablas, storage, archivos };
}
const ANA = { id: 'sup-1', email: 'ana@ibero.pe', rol: 'supervisor' };
const BETO = { id: 'sup-2', email: 'beto@ibero.pe', rol: 'supervisor' };
const PROV = { id: 'prov-1', email: 'p@ibero.pe', rol: 'proveedor' };
// Lo que router.js da a campo.js: el modelo del local y la validación con el contexto del proyecto
const DEPS = {
  modelo: async (_, cod) => modeloFicha(D, C, D.locs.findIndex(l => l[0] === cod), META),
  validar: async (pid, cod, datos, origen) => procesarFicha(fichaDesdeFormulario(datos, { proyectoId: pid, cod }), { ...CTX, codigos: new Set([cod]), archivo: origen })
};

test('acceso: el supervisor solo llena las fichas de sus colegios; el proveedor, las de su proyecto', async () => {
  const sb = sbFalso();
  assert.ok((await accesoFicha(sb, ANA, UUID, COD_U)).p);
  assert.equal((await accesoFicha(sb, BETO, UUID, COD_U)).status, 403);
  assert.ok((await accesoFicha(sb, PROV, UUID, COD_U)).p);
  assert.equal((await accesoFicha(sb, { id: 'prov-2', rol: 'proveedor' }, UUID, COD_U)).status, 404, 'otro proveedor');
  assert.equal((await accesoFicha(sb, ANA, UUID, '999999')).status, 404, 'colegio fuera del proyecto');
  assert.equal((await accesoFicha(sb, ANA, UUID, 'abc')).status, 400);
});

test('abrir: trae el padrón y el censo del local, lo llenado y la guía del formulario', async () => {
  const r = await abrirFichaCampo(sbFalso(), ANA, UUID, COD_U, DEPS);
  assert.equal(r.status, 200);
  assert.equal(r.body.modelo.local.cod, COD_U); assert.equal(r.body.modelo.aulas.length, nAulas);
  assert.equal(r.body.ficha, null); assert.equal(r.body.editable, true);
  assert.deepEqual(r.body.guia, GUIA_FICHA); assert.deepEqual(GUIA_FICHA.rangos, ['Menos de 5', 'De 5 a 10', 'Más de 10']);
  assert.equal((await abrirFichaCampo(sbFalso(), BETO, UUID, COD_U, DEPS)).status, 403);
});

test('borrador, envío con errores (queda guardado), envío correcto y bloqueo', async () => {
  const sb = sbFalso();
  const g = await guardarBorradorFicha(sb, ANA, UUID, COD_U, { datos: { ...FORM, a: { ...FORM.a, fecha: '' } } });
  assert.equal(g.status, 200); assert.equal(g.body.ficha.estado, 'borrador'); assert.equal(g.body.ficha.por, 'ana@ibero.pe');

  const mal = await enviarFicha(sb, ANA, UUID, COD_U, { datos: { ...FORM, a: { ...FORM.a, fecha: '' } } }, DEPS);
  assert.equal(mal.status, 422); assert.match(mal.body.errores.at(-1).motivo, /Falta la fecha/);
  assert.equal(sb.tablas.campo_fichas[0].estado, 'borrador');

  const ok = await enviarFicha(sb, ANA, UUID, COD_U, { datos: FORM }, DEPS);
  assert.equal(ok.status, 200); assert.equal(ok.body.ficha.estado, 'enviada'); assert.ok(ok.body.ficha.enviada_en);
  assert.equal(ok.body.filas.ok, 2);
  assert.deepEqual(sb.tablas.campo_visitas.map(v => [v.codigo_local, v.fecha, v.visitado_por]), [[COD_U, '2026-10-15', 'sup-1']], 'marca el colegio visitado');

  assert.equal((await guardarBorradorFicha(sb, ANA, UUID, COD_U, { datos: FORM })).status, 409, 'enviada: no se cambia');
  assert.equal((await enviarFicha(sb, ANA, UUID, COD_U, { datos: FORM }, DEPS)).status, 409);
  const ab = await abrirFichaCampo(sb, ANA, UUID, COD_U, DEPS);
  assert.equal(ab.body.editable, false); assert.equal(ab.body.ficha.datos.a.verificador, FORM.a.verificador);
});

test('envío: no cambia una visita que ya marcó otro', async () => {
  const sb = sbFalso({ visitas: [{ codigo_local: COD_U, fecha: '2026-09-01', visitado_por: 'sup-2' }] });
  assert.equal((await enviarFicha(sb, ANA, UUID, COD_U, { datos: FORM }, DEPS)).status, 200);
  assert.deepEqual(sb.tablas.campo_visitas, [{ codigo_local: COD_U, fecha: '2026-09-01', visitado_por: 'sup-2' }]);
});

test('ficha devuelta: el supervisor la corrige (sigue «observada») y la reenvía', async () => {
  const sb = sbFalso({ fichas: [{ codigo_local: COD_U, estado: 'observada', datos: FORM, nota_revision: 'Recuenta el aula 1' }] });
  const g = await guardarBorradorFicha(sb, ANA, UUID, COD_U, { datos: FORM });
  assert.equal(g.body.ficha.estado, 'observada'); assert.equal(g.body.ficha.nota, 'Recuenta el aula 1');
  assert.equal((await enviarFicha(sb, ANA, UUID, COD_U, { datos: FORM }, DEPS)).body.ficha.estado, 'enviada');
});

test('lista de fichas: el supervisor ve solo las de sus colegios; sin la migración 023, aviso claro', async () => {
  const fichas = [{ codigo_local: COD_U, estado: 'enviada', editado_por: 'sup-1' }, { codigo_local: '100002', estado: 'borrador', editado_por: 'sup-2' }];
  assert.deepEqual(Object.keys((await fichasDelUsuario(sbFalso({ fichas }), ANA, UUID)).body.fichas), [COD_U]);
  assert.deepEqual(Object.keys((await fichasDelUsuario(sbFalso({ fichas }), PROV, UUID)).body.fichas).sort(), ['100002', COD_U].sort());
  const sin = await fichasDelUsuario(sbFalso({ sinTabla: true }), ANA, UUID);
  assert.equal(sin.status, 503); assert.match(sin.body.error, /023_campo_fichas\.sql/);
});

test('migración 023, rutas de revisión y páginas', () => {
  const sql = leer('supabase/migrations/023_campo_fichas.sql');
  assert.match(sql, /create table if not exists public\.campo_fichas/);
  assert.match(sql, /check \(estado in \('borrador', 'enviada', 'observada', 'aprobada'\)\)/);
  assert.match(sql, /primary key \(proyecto_id, codigo_local\)/);
  assert.match(sql, /enable row level security/); assert.doesNotMatch(sql, /create policy/);
  const exp = leer('src/selector-ioarr/expediente.js');
  for (const r of ["'/proyectos/:id/fichas/:cod/digital'", "'/proyectos/:id/fichas/:cod/digital/aprobar'", "'/proyectos/:id/fichas/:cod/digital/observar'"]) assert.ok(exp.includes(r), r);
  assert.match(exp, /if \(f\.estado !== 'enviada'\)/, 'solo se aprueba o devuelve una ficha enviada');
  assert.match(leer('src/public/campo.html'), /id="cFicha"/);
  assert.match(leer('src/public/campo.js'), /import \{ abrirFicha \} from '\/campo-ficha\.js'/);
  assert.match(leer('src/public/selector-ioarr-fichas.js'), /data-ficha-aprobar/);
});

// ─── Fotos (migración 024) ──────────────────────────────────────────────────
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const MINI = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 2)]);
const ID1 = '11111111-2222-4333-8444-555555555555', ID2 = '11111111-2222-4333-8444-666666666666';
const campos = (id, x = {}) => ({ id, aula: '0', bien: 'silla', muestra: '', lat: '-16.14', lon: '-70.53', tomada_en: '2026-10-15T15:00:00Z', ...x });

test('datos de la foto: aula, mueble, coordenadas en Perú y hora válida', () => {
  const ahora = Date.parse('2026-10-22T12:00:00Z');
  assert.deepEqual(limpiarMetaFoto(campos(ID1), ahora), { aula: 0, bien: 'silla', muestra: null, lat: -16.14, lon: -70.53, tomada_en: '2026-10-15T15:00:00.000Z' });
  const m = limpiarMetaFoto({ aula: '', bien: 'tele', muestra: 'Fachada y letrero', lat: '40', lon: '-3', tomada_en: '2030-01-01' }, ahora);
  assert.equal(m.aula, null); assert.equal(m.bien, null); assert.equal(m.lat, null); assert.equal(m.tomada_en, new Date(ahora).toISOString(), 'una hora futura se cambia por la de ahora');
  assert.equal(lugarFoto({ aula: 2, bien: 'mesa' }), 'Aula 3 · Mesa del estudiante');
  assert.equal(lugarFoto({ aula: null, muestra: 'Fachada y letrero' }), 'Fachada y letrero');
  assert.equal(rutaFoto('p', '123', ID1, 'image/jpeg', true), `campo/p/123/${ID1}_mini.jpg`);
});

test('subir foto: crea la ficha si no existe, guarda foto y miniatura, y un reintento no la duplica', async () => {
  const sb = sbFalso();
  const r = await subirFotoFicha(sb, ANA, UUID, COD_U, { archivo: { buffer: JPG, size: JPG.length }, mini: { buffer: MINI }, campos: campos(ID1) });
  assert.equal(r.status, 201); assert.equal(r.body.foto.lugar, 'Aula 1 · Silla del estudiante'); assert.equal(r.body.foto.mini, true);
  assert.equal(sb.tablas.campo_fichas.length, 1); assert.equal(sb.tablas.campo_fichas[0].estado, 'borrador');
  assert.deepEqual([...sb.archivos.keys()].sort(), [`campo/${UUID}/${COD_U}/${ID1}.jpg`, `campo/${UUID}/${COD_U}/${ID1}_mini.jpg`]);
  const otra = await subirFotoFicha(sb, ANA, UUID, COD_U, { archivo: { buffer: JPG }, campos: campos(ID1) });
  assert.equal(otra.status, 200); assert.equal(sb.tablas.campo_fichas_fotos.length, 1, 'mismo id: no se duplica');

  // Con la ficha ya llenada, subir otra foto no le borra los datos
  await guardarBorradorFicha(sb, ANA, UUID, COD_U, { datos: FORM });
  await subirFotoFicha(sb, ANA, UUID, COD_U, { archivo: { buffer: JPG }, campos: campos(ID2, { aula: '', bien: '', muestra: 'Fachada y letrero' }) });
  assert.equal(sb.tablas.campo_fichas[0].datos.a.verificador, FORM.a.verificador);
  assert.equal(sb.tablas.campo_fichas_fotos.length, 2);

  const img = await leerImagenFoto(sb, ANA, UUID, COD_U, ID1, true);
  assert.deepEqual(img.buffer, MINI); assert.equal(img.mime, 'image/jpeg');
  assert.equal((await leerImagenFoto(sb, BETO, UUID, COD_U, ID1)).status, 403, 'otro supervisor no la ve');
  const ab = await abrirFichaCampo(sb, ANA, UUID, COD_U, DEPS);
  assert.deepEqual(ab.body.fotos.map(f => f.id).sort(), [ID1, ID2].sort());
});

test('subir foto: rechaza lo que no es foto, ids inválidos, colegios ajenos y fichas enviadas', async () => {
  const sb = sbFalso();
  const pdf = Buffer.from('%PDF-1.4 xxxxxxxxxxxx');
  assert.equal((await subirFotoFicha(sb, ANA, UUID, COD_U, { archivo: { buffer: pdf }, campos: campos(ID1) })).status, 400);
  assert.equal((await subirFotoFicha(sb, ANA, UUID, COD_U, { archivo: { buffer: JPG }, campos: campos('no-uuid') })).status, 400);
  assert.equal((await subirFotoFicha(sb, BETO, UUID, COD_U, { archivo: { buffer: JPG }, campos: campos(ID1) })).status, 403);
  const env = sbFalso({ fichas: [{ codigo_local: COD_U, estado: 'enviada', datos: FORM }] });
  assert.equal((await subirFotoFicha(env, ANA, UUID, COD_U, { archivo: { buffer: JPG }, campos: campos(ID1) })).status, 409);
});

test('borrar foto: quita la fila y los archivos; no con la ficha enviada', async () => {
  const sb = sbFalso();
  await subirFotoFicha(sb, ANA, UUID, COD_U, { archivo: { buffer: JPG }, mini: { buffer: MINI }, campos: campos(ID1) });
  const r = await borrarFotoFicha(sb, ANA, UUID, COD_U, ID1);
  assert.equal(r.status, 200); assert.equal(sb.tablas.campo_fichas_fotos.length, 0); assert.equal(sb.archivos.size, 0);
  const env = sbFalso({ fichas: [{ codigo_local: COD_U, estado: 'enviada', datos: FORM }], fotos: [{ id: ID1, proyecto_id: UUID, codigo_local: COD_U, ruta: 'x.jpg', mime: 'image/jpeg' }] });
  assert.equal((await borrarFotoFicha(env, ANA, UUID, COD_U, ID1)).status, 409);
});

test('sin la migración 024 la ficha funciona igual, sin fotos', async () => {
  const r = await abrirFichaCampo(sbFalso({ sinFotos: true }), ANA, UUID, COD_U, DEPS);
  assert.equal(r.status, 200); assert.equal(r.body.fotos, null);
  assert.equal((await enviarFicha(sbFalso({ sinFotos: true, fichas: [{ codigo_local: COD_U, estado: 'borrador', datos: {} }] }), ANA, UUID, COD_U, { datos: FORM }, DEPS)).status, 200);
});

test('panel fotográfico: avisa la fachada y los muebles en mal estado sin foto, y pasa a la ficha', async () => {
  const sinNada = avisosFotos(FORM, []);
  assert.equal(sinNada.length, 2);
  assert.match(sinNada[0].motivo, /fachada/); assert.match(sinNada[1].motivo, /aula 1 \(mesa del estudiante\), aula 1 \(silla del estudiante\)/);
  const fotos = [{ aula: null, bien: null, muestra: 'Fachada y letrero' }, { aula: 0, bien: 'mesa' }, { aula: 0, bien: 'silla' }, { aula: 0, bien: null }];
  assert.deepEqual(avisosFotos(FORM, fotos), []);
  assert.deepEqual(avisosFotos(FORM, null), [], 'sin la migración, sin avisos');
  assert.deepEqual(panelFotos(fotos).map(f => [f.n, f.ambiente, f.muestra]), [[1, 'Fachada y letrero', 'Fachada y letrero'], [2, 'Aula 1 · Mesa del estudiante', 'Detalle del mueble'], [3, 'Aula 1 · Silla del estudiante', 'Detalle del mueble'], [4, 'Aula 1', 'Vista general del aula']]);
  const r = procesarFicha(fichaDesdeFormulario(FORM, { proyectoId: 'p-1', cod: COD_U, fotos }), CTX);
  assert.equal(r.fila.ficha.fotos.length, 4); assert.equal(r.fila.ficha.fotos[0].ambiente, 'Fachada y letrero');

  // Al enviar, los avisos de fotos salen junto con los de la validación
  const sb = sbFalso({ fichas: [{ codigo_local: COD_U, estado: 'borrador', datos: {} }] });
  const env = await enviarFicha(sb, ANA, UUID, COD_U, { datos: FORM }, DEPS);
  assert.equal(env.status, 200); assert.ok(env.body.avisos.some(a => /fachada/.test(a.motivo)));
});

test('migración 024, copia al sustento al aprobar, CSP y páginas', () => {
  const sql = leer('supabase/migrations/024_campo_fichas_fotos.sql');
  assert.match(sql, /create table if not exists public\.campo_fichas_fotos/);
  assert.match(sql, /references public\.campo_fichas \(proyecto_id, codigo_local\) on delete cascade/);
  assert.match(sql, /enable row level security/); assert.doesNotMatch(sql, /create policy/);
  const exp = leer('src/selector-ioarr/expediente.js');
  assert.match(exp, /copiarFotosAlSustento\(p, cod, fotos/);
  assert.match(exp, /tipo: 'foto'/);
  assert.match(exp, /campo_fichas_fotos'\)\.select\('ruta, ruta_mini'\)\.eq\('proyecto_id', proyectoId\)/, 'al borrar el proyecto se borran sus fotos de campo');
  assert.match(politicaSelector('https://x.supabase.co'), /img-src 'self' data: blob:/);
  const js = leer('src/public/campo-ficha.js');
  assert.match(js, /capture="environment"/);
  assert.match(js, /from '\/campo-fotos\.js'/);
  assert.match(leer('src/public/campo-fotos.js'), /indexedDB\.open/);
});
