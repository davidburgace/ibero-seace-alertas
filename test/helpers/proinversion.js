// Excel de Proinversión de prueba (compartido por ingesta.test.js y cruce.test.js)
import * as XLSX from 'xlsx';

// ─── Excel de Proinversión ("Inversiones en promoción") ─────────────────────
// Réplica del formato real: hoja PROINVERSION, banner en las filas 1-9,
// encabezados en la fila 10 desde la columna B (A vacía), "Link web" como
// hipervínculo con texto "Enlace" y una fila de pie.
export const ENC_PROINVERSION = ['CODIGO SNIP / INVIERTE.PE / CÓDIGO IDEA', 'NOMBRE DEL PROYECTO', 'ENTIDAD', 'NIVEL DE GOBIERNO',
  'DEPARTAMENTO', 'PROVINCIA', 'DISTRITO', 'FUNCIÓN', 'TIPOLOGÍA', 'TIPO DE INVERSIÓN', 'MONTO DE INVERSIÓN REFERENCIAL',
  'FASE OXI', 'ÚLTIMO NIVEL DE ESTUDIO', 'LINK WEB'];

export function excelProinversion() {
  const fila = (...v) => [null, ...v];
  const aoa = [
    fila('INVERSIONES EN PROMOCIÓN - OBRAS POR IMPUESTOS'),
    [],
    fila('Última actualización: 10/10/2026'),
    fila('Nº Registros: 4'),
    [], [], [],
    fila('Proyectos en cartera de Proinversión'),
    [],
    fila(...ENC_PROINVERSION),
    fila(2603315, 'ADQUISICIÓN DE MOBILIARIO ESCOLAR; EN LA IE 18001 DISTRITO DE CHACHAPOYAS', 'GOBIERNO REGIONAL AMAZONAS', 'Gobierno Regional',
      'AMAZONAS', 'CHACHAPOYAS', 'CHACHAPOYAS', 'EDUCACIÓN', 'Educación básica', 'IOARR', 'S/1,252,892.41', 'Priorizado', 'IOARR aprobada', 'Enlace'),
    fila('2589001', 'ADQUISICIÓN DE CARPETAS Y SILLAS; EN LA IE 20188 DISTRITO DE SAN VICENTE', 'MUNICIPALIDAD PROVINCIAL DE CAÑETE', 'Gobierno Local',
      'LIMA', 'CAÑETE', 'SAN VICENTE DE CAÑETE', 'EDUCACIÓN', 'Educación básica', 'IOARR', 'S/ 845,300.00', 'Por Priorizar', 'IOARR aprobada', 'Enlace'),
    fila('IDEA0000110', 'ADQUISICIÓN DE EQUIPAMIENTO DE AULAS; EN LA IE 16234 BAGUA', 'MUNICIPALIDAD PROVINCIAL DE BAGUA', 'Gobierno Local',
      'AMAZONAS', 'BAGUA', 'BAGUA', 'EDUCACIÓN', 'Educación básica', 'IOARR', 'S/310,000.50', 'Por Priorizar', 'Idea', 'Enlace'),
    fila(2611450, 'RENOVACIÓN DE COBERTURA; EN EL ESTADIO MUNICIPAL DE HUARAL', 'MUNICIPALIDAD PROVINCIAL DE HUARAL', 'Gobierno Local',
      'LIMA', 'HUARAL', 'HUARAL', 'DEPORTE', 'Deporte', 'IOARR', 'S/2,100,000.00', 'Por Priorizar', 'IOARR aprobada', 'Enlace'),
    [],
    fila('Fuente: PROINVERSIÓN')
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // "Link web" es la columna O; datos en las filas 11-14 (índices 10-13)
  ['2603315', '2589001', 'IDEA0000110', '2611450'].forEach((cui, i) => {
    ws[XLSX.utils.encode_cell({ r: 10 + i, c: 14 })].l = { Target: `https://www.investinperu.pe/oxi/proyecto/${cui}` };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PROINVERSION');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
