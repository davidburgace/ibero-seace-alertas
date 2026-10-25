// ============================================================================
// src/selector-ioarr/bases-especificaciones.js — Biblioteca NEUTRAL de
// especificaciones técnicas para el Anexo 3-A de las bases (generador de bases)
//
// Neutralidad: sin marcas, modelos, fabricantes ni referencias a un postor.
// No fija medidas ni materiales: remite a las normas técnicas que el usuario
// indica y verifica en la ficha (campo «Normas técnicas aplicables»). Cada
// texto se puede editar por ficha; lo editado pasa por la misma revisión de
// neutralidad (bases.js, revisarNeutralidad).
// ============================================================================

// Ejemplos para el campo editable (el usuario confirma cuáles aplican y si están vigentes)
export const NORMAS_SUGERIDAS = ['RVM N° 331-2021-MINEDU', 'RVM N° 019-2023-MINEDU', 'RM N° 355-2023-MINEDU'];

const COMUN = 'Dimensiones, materiales, acabados, ergonomía y tolerancias: según las normas técnicas aplicables indicadas en este anexo, para el nivel y el grupo de grado que corresponda. '
  + 'Bien nuevo, sin uso, sin aristas vivas, astillas ni piezas sueltas, estable sobre piso nivelado. '
  + 'Se acepta cualquier bien que cumpla estas especificaciones y las normas técnicas.';

export const ESPECIFICACIONES = {
  kit: { nombre: 'Kit de mobiliario del estudiante (mesa + silla)', texto: 'Conjunto de una mesa y una silla del estudiante, con medidas correspondientes entre sí y al grupo de grado. ' + COMUN },
  mesa: { nombre: 'Mesa del estudiante', texto: 'Mesa para el trabajo del estudiante en el aula (unipersonal o para varios puestos, según la norma técnica del nivel). Superficie de trabajo lisa y lavable. ' + COMUN },
  silla: { nombre: 'Silla del estudiante', texto: 'Silla para el estudiante, con asiento y respaldo, de altura correspondiente a la mesa del mismo grupo de grado. ' + COMUN },
  esc: { nombre: 'Escritorio del docente', texto: 'Escritorio para el docente en el aula, con superficie de trabajo y espacio de guardado según la norma técnica. ' + COMUN },
  sdoc: { nombre: 'Silla del docente', texto: 'Silla para el docente, con asiento y respaldo, de altura correspondiente al escritorio del docente. ' + COMUN },
  arm: { nombre: 'Armario o estante', texto: 'Mueble de guardado para materiales del aula, con divisiones internas y, si la norma lo indica, puertas con cierre. ' + COMUN }
};
