// Diagnóstico: cómo lee Radar IOARR un PDF del Banco de Inversiones, sin subirlo.
// Uso: node scripts/experimentos/leer-pdf.js <archivo.pdf> [más.pdf …] [--lineas]
// Muestra el tipo detectado, los campos de la ficha 07-C o la tabla de costos,
// y con --lineas el texto reconstruido (para ajustar etiquetas si algo falla).
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  extraerLineasPdf, clasificarDocumento, leerFicha07C, leerTablaCostos, preciosUnicos, anioDeLineas
} from '../../src/ioarr/fichas.js';

const args = process.argv.slice(2);
const verLineas = args.includes('--lineas');
const archivos = args.filter(a => a !== '--lineas');
if (!archivos.length) { console.log('Uso: node scripts/experimentos/leer-pdf.js <archivo.pdf> [--lineas]'); process.exit(1); }

for (const ruta of archivos) {
  const { paginas, lineas } = await extraerLineasPdf(await readFile(ruta));
  const tipo = clasificarDocumento(basename(ruta), lineas);
  console.log(`\n═══ ${basename(ruta)} · ${paginas} pág. · ${lineas.length} líneas · tipo: ${tipo}`);
  if (verLineas) lineas.forEach(l => console.log(`  p${l.pagina} | ${l.texto}`));

  if (tipo === 'ficha_07c') {
    const { campos, avisos } = leerFicha07C(lineas);
    console.table(campos);
    avisos.forEach(a => console.log('  ⚠️ ', a));
  } else if (tipo === 'estructura_costos') {
    const { filas, avisos } = leerTablaCostos(lineas);
    const unicos = preciosUnicos(filas);
    console.log(`  ${filas.length} filas, ${unicos.precios.length} códigos únicos, año ${anioDeLineas(lineas) ?? 's/d'}`);
    console.table(unicos.precios.slice(0, 30));
    [...avisos, ...unicos.avisos].forEach(a => console.log('  ⚠️ ', a));
  }
}
