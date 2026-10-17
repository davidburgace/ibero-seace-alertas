// Pruebas de las funciones puras de ingestión (correr con: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { ENC_PROINVERSION, excelProinversion } from './helpers/proinversion.js';
import {
  parseMonto, mapEstado, resolverEstado, detectarMapeo, aplicarMapeoGuardado, filaAProyecto, leerArchivo, esMobiliario, importarProyectos
} from '../src/ioarr/ingesta.js';

test('parseMonto entiende formatos peruanos e ingleses', () => {
  assert.equal(parseMonto(1500.5), 1500.5);
  assert.equal(parseMonto('1,234,567.89'), 1234567.89);
  assert.equal(parseMonto('1.234.567,89'), 1234567.89);
  assert.equal(parseMonto('S/ 250,000'), 250000);
  assert.equal(parseMonto('1234,5'), 1234.5);
  assert.equal(parseMonto(''), null);
});

test('resolverEstado solo avanza y respeta estados finales', () => {
  assert.equal(resolverEstado('convenio', 'viable'), 'convenio');
  assert.equal(resolverEstado('viable', 'priorizada_oxi'), 'priorizada_oxi');
  assert.equal(resolverEstado('en_ejecucion', 'descartada'), 'descartada');
  assert.equal(resolverEstado('descartada', 'viable'), 'descartada');
  assert.equal(resolverEstado(null, 'viable'), 'viable');
});

test('mapEstado reconoce textos de las fuentes', () => {
  assert.equal(mapEstado('ACTIVO'), 'viable');
  assert.equal(mapEstado('Desactivado'), 'descartada');
  assert.equal(mapEstado('Priorizado'), 'priorizada_oxi');
  assert.equal(mapEstado('Convenio suscrito'), 'convenio');
  assert.equal(mapEstado('xyz'), null);
});

test('detectarMapeo y filaAProyecto con un exporte típico', () => {
  const headers = ['CODIGO_UNICO', 'NOMBRE_INVERSION', 'TIPO_FORMATO', 'NIVEL', 'ENTIDAD', 'DEPARTAMENTO', 'PROVINCIA', 'DISTRITO', 'FUNCION', 'COSTO_ACTUALIZADO', 'ESTADO'];
  const m = detectarMapeo(headers);
  assert.equal(m.cui, 'CODIGO_UNICO');
  assert.equal(m.nombre, 'NOMBRE_INVERSION');
  assert.equal(m.tipo_inversion, 'TIPO_FORMATO');
  assert.equal(m.monto_inversion, 'COSTO_ACTUALIZADO');
  assert.equal(m.region, 'DEPARTAMENTO');

  const p = filaAProyecto({
    CODIGO_UNICO: 2512345, NOMBRE_INVERSION: 'Adquisición de mobiliario escolar; en la IE 10123 Chiclayo',
    TIPO_FORMATO: 'IOARR', NIVEL: 'GL', ENTIDAD: 'Municipalidad Provincial de Chiclayo', DEPARTAMENTO: 'Lambayeque',
    PROVINCIA: 'Chiclayo', DISTRITO: 'Chiclayo', FUNCION: 'EDUCACION', COSTO_ACTUALIZADO: '350,000.00', ESTADO: 'ACTIVO'
  }, m, { fuente: 'invierte_pe' });
  assert.equal(p.cui, '2512345');
  assert.equal(p.region, 'LAMBAYEQUE');
  assert.equal(p.entidad_tipo, 'GL');
  assert.equal(p.tipo_inversion, 'IOARR');
  assert.equal(p.monto_inversion, 350000);
  assert.equal(p.estado, 'viable');
  assert.equal(p.es_mobiliario, true);
});

test('Proinversión implica al menos priorizada_oxi', () => {
  const p = filaAProyecto({ CUI: '1', NOMBRE: 'X' }, { cui: 'CUI', nombre: 'NOMBRE' }, { fuente: 'proinversion' });
  assert.equal(p.estado, 'priorizada_oxi');
});

test('leerArchivo salta filas de título', () => {
  const ws = XLSX.utils.aoa_to_sheet([['Reporte Banco de Inversiones'], [], ['CUI', 'NOMBRE'], ['123', 'Mobiliario']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'h');
  const { headers, rows } = leerArchivo(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  assert.deepEqual(headers, ['CUI', 'NOMBRE']);
  assert.equal(rows.length, 1);
  assert.equal(esMobiliario('ADQUISICION DE CARPETAS'), true);
});

// ─── importarProyectos con un Supabase falso en memoria ─────────────────────
function supabaseFalso() {
  const db = { ioarr_proyectos: [], ioarr_eventos: [] };
  let n = 0;
  return {
    db,
    from(tabla) {
      return {
        select: () => ({ in: async (col, vals) => ({ data: db[tabla].filter(r => vals.includes(r[col])).map(r => ({ ...r })), error: null }) }),
        upsert: (filas) => ({
          select: async () => {
            const out = filas.map(f => {
              const i = db[tabla].findIndex(r => r.cui === f.cui);
              if (i >= 0) { db[tabla][i] = { ...db[tabla][i], ...f }; return db[tabla][i]; }
              const nuevo = { id: 'p' + (++n), creado_en: 'x', actualizado_en: 'x', ...f };
              db[tabla].push(nuevo); return nuevo;
            });
            return { data: out.map(r => ({ id: r.id, cui: r.cui })), error: null };
          }
        }),
        insert: async (filas) => { db[tabla].push(...filas); return { error: null }; }
      };
    }
  };
}

test('importarProyectos: inserta, avanza estado, preserva campos manuales y no retrocede', async () => {
  const sb = supabaseFalso();
  const base = { cui: '100', nombre: 'Mobiliario IE 1', entidad: null, entidad_tipo: 'GL', region: 'LAMBAYEQUE', provincia: null,
    distrito: null, funcion: 'EDUCACION', tipo_inversion: 'IOARR', monto_inversion: 1000, estado: 'viable', url_fuente: null, es_mobiliario: true, fuente: 'invierte_pe' };

  let r = await importarProyectos(sb, [base, { ...base }], { fuente: 'invierte_pe' });
  assert.deepEqual([r.recibidos, r.nuevos], [1, 1]);
  assert.equal(sb.db.ioarr_eventos.length, 1);

  // Cambio manual del financista
  Object.assign(sb.db.ioarr_proyectos[0], { notas: 'mi nota', etapa_financista: 'evaluando' });

  r = await importarProyectos(sb, [{ ...base }], { fuente: 'invierte_pe' });
  assert.equal(r.sin_cambios, 1);

  r = await importarProyectos(sb, [{ ...base, estado: 'priorizada_oxi', fuente: 'proinversion', entidad_tipo: null }], { fuente: 'proinversion' });
  assert.deepEqual([r.actualizados, r.cambios_estado], [1, 1]);
  const p = sb.db.ioarr_proyectos[0];
  assert.equal(p.estado, 'priorizada_oxi');
  assert.equal(p.notas, 'mi nota');
  assert.equal(p.etapa_financista, 'evaluando');
  assert.equal(p.entidad_tipo, 'GL');
  assert.match(sb.db.ioarr_eventos.at(-1).detalle, /viable → priorizada_oxi/);

  // Un exporte viejo con "viable" no hace retroceder el estado
  r = await importarProyectos(sb, [{ ...base, fuente: 'proinversion' }], { fuente: 'invierte_pe' });
  assert.equal(sb.db.ioarr_proyectos[0].estado, 'priorizada_oxi');
  assert.equal(r.cambios_estado, 0);
});

// ─── Excel de Proinversión ("Inversiones en promoción") ─────────────────────
// Réplica del formato real en test/helpers/proinversion.js

test('Proinversión: detecta el encabezado bajo un banner de 9 filas e ignora la columna A vacía', () => {
  const { headers, rows, fila_encabezado, hoja } = leerArchivo(excelProinversion());
  assert.equal(hoja, 'PROINVERSION');
  assert.equal(fila_encabezado, 10);
  assert.deepEqual(headers, ENC_PROINVERSION);
  assert.equal(rows.length, 4); // sin filas vacías ni la de pie
});

test('Proinversión: mapeo automático por sinónimos (sin tildes ni mayúsculas)', () => {
  const m = detectarMapeo(ENC_PROINVERSION);
  assert.deepEqual(m, {
    cui: 'CODIGO SNIP / INVIERTE.PE / CÓDIGO IDEA', nombre: 'NOMBRE DEL PROYECTO', entidad: 'ENTIDAD',
    nivel_gobierno: 'NIVEL DE GOBIERNO', region: 'DEPARTAMENTO', provincia: 'PROVINCIA', distrito: 'DISTRITO',
    funcion: 'FUNCIÓN', tipologia: 'TIPOLOGÍA', tipo_inversion: 'TIPO DE INVERSIÓN',
    monto_inversion: 'MONTO DE INVERSIÓN REFERENCIAL', estado_oxi: 'FASE OXI', estado: null,
    nivel_estudio: 'ÚLTIMO NIVEL DE ESTUDIO', url_fuente: 'LINK WEB',
    fuente_financiamiento: null, modalidad_ejecucion: null, pim: null, devengado: null, periodo: null
  });
  // En minúsculas y con "_" también encaja
  assert.equal(detectarMapeo(['codigo_unico', 'nombre de la inversión', 'x', 'y']).cui, 'codigo_unico');
});

test('Proinversión: limpieza de montos, CUI/IDEA, estados, mobiliario e hipervínculos', () => {
  const { headers, rows } = leerArchivo(excelProinversion());
  const ps = rows.map(r => filaAProyecto(r, detectarMapeo(headers), { fuente: 'proinversion' }));
  const [a, b, idea, d] = ps;

  assert.equal(a.cui, '2603315');
  assert.equal(a.monto_inversion, 1252892.41);
  assert.equal(a.estado, 'priorizada_oxi');
  assert.equal(a.estado_oxi_texto, 'Priorizado');
  assert.equal(a.entidad_tipo, 'GORE');
  assert.equal(a.region, 'AMAZONAS');
  assert.equal(a.tipo_inversion, 'IOARR');
  assert.equal(a.tipologia, 'Educación básica');
  assert.equal(a.nivel_estudio, 'IOARR aprobada');
  assert.equal(a.url_fuente, 'https://www.investinperu.pe/oxi/proyecto/2603315');
  assert.equal(a.es_idea, false);

  assert.equal(b.estado, 'viable');
  assert.equal(b.estado_oxi_texto, 'Por Priorizar');
  assert.equal(b.monto_inversion, 845300);
  assert.equal(b.region, 'LIMA');
  assert.equal(b.entidad_tipo, 'GL');

  assert.equal(idea.cui, 'IDEA0000110');
  assert.equal(idea.es_idea, true);
  assert.equal(idea.monto_inversion, 310000.5);

  assert.deepEqual(ps.map(p => p.es_mobiliario), [true, true, true, false]);
  assert.deepEqual(ps.map(p => p.estado), ['priorizada_oxi', 'viable', 'viable', 'viable']);
  assert.equal(d.region, 'LIMA');
});

test('parseMonto quita "S/" y "S/." y mapEstado distingue "Por Priorizar"', () => {
  assert.equal(parseMonto('S/1,252,892.41'), 1252892.41);
  assert.equal(parseMonto('S/. 1,252,892.41'), 1252892.41);
  assert.equal(mapEstado('Por Priorizar'), 'viable');
  assert.equal(mapEstado('Priorizado'), 'priorizada_oxi');
  assert.equal(esMobiliario('Adquisición de bancas'), true);
  assert.equal(esMobiliario('Servicio bancario'), false);
});

test('aplicarMapeoGuardado: el mapeo recordado gana si la columna sigue existiendo', () => {
  const headers = ['COD', 'TITULO', 'ENTIDAD', 'REGION X'];
  const auto = detectarMapeo(headers);
  assert.equal(auto.cui, null);
  const m = aplicarMapeoGuardado(headers, auto, { cui: 'COD', nombre: 'TITULO', region: 'YA NO EXISTE' });
  assert.equal(m.cui, 'COD');
  assert.equal(m.nombre, 'TITULO');
  assert.equal(m.region, auto.region);
});

test('importarProyectos: "Por Priorizar" no hace retroceder a una priorizada, pero queda el evento', async () => {
  const sb = supabaseFalso();
  const { headers, rows } = leerArchivo(excelProinversion());
  const mapeo = detectarMapeo(headers);
  const primera = filaAProyecto(rows[0], mapeo, { fuente: 'proinversion' });
  await importarProyectos(sb, [primera], { fuente: 'proinversion' });
  assert.equal(sb.db.ioarr_proyectos[0].estado, 'priorizada_oxi');

  const r = await importarProyectos(sb, [{ ...primera, estado: 'viable', estado_oxi_texto: 'Por Priorizar' }], { fuente: 'proinversion' });
  assert.equal(r.cambios_estado, 0);
  const p = sb.db.ioarr_proyectos[0];
  assert.equal(p.estado, 'priorizada_oxi');
  assert.equal(p.estado_oxi_texto, 'Por Priorizar');
  assert.match(sb.db.ioarr_eventos.at(-1).detalle, /reporta viable, fase OxI «Por Priorizar»; se mantiene priorizada_oxi/);
});
