// Pruebas de las funciones puras de ingestión (correr con: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  parseMonto, mapEstado, resolverEstado, detectarMapeo, filaAProyecto, leerArchivo, esMobiliario, importarProyectos
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
