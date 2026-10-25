// Genera un borrador de bases OxI de ejemplo con datos de prueba ficticios (test/helpers/ficha-bases.js).
//   node scripts/selector-ioarr/bases-ejemplo.mjs [salida.docx]
import { writeFileSync } from 'node:fs';
import { limpiarFicha, validarFicha } from '../../src/selector-ioarr/bases.js';
import { generarBasesDocx } from '../../src/selector-ioarr/word-bases.js';
import { FICHA_PRUEBA, CTX_PRUEBA } from '../../test/helpers/ficha-bases.js';

const salida = process.argv[2] || 'bases_ejemplo.docx';
const d = limpiarFicha(FICHA_PRUEBA), v = validarFicha(d, CTX_PRUEBA);
console.log(v.ok ? 'Ficha válida.' : 'Errores:\n- ' + v.errores.map(e => e.texto).join('\n- '));
if (v.advertencias.length) console.log('Advertencias:\n- ' + v.advertencias.map(a => a.texto).join('\n- '));
writeFileSync(salida, await generarBasesDocx({ datos: d, ctx: CTX_PRUEBA, version: 1, fecha: new Date().toISOString().slice(0, 10), usuario: 'prueba@ejemplo.invalid' }));
console.log('Escrito:', salida);
