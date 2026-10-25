# Plantillas del documento equivalente – IOARR de mobiliario escolar

Borrador del documento equivalente (expediente técnico de la IOARR), que la empresa privada elabora **después de la buena pro** y aprueba la entidad. La estructura sale de *Plantilla del documento equivalente – IOARR de mobiliario escolar* (basada en los términos de referencia de San Juan, CUI 2711098).

## Qué contiene

- `00_plan_de_trabajo.md`: cronograma de actividades y responsables, metas y objetivos, entregables y aprobación.
- `01_tomo_I_resumen_ejecutivo.md`: 1.1 a 1.12.
- `02_tomo_II_documento_equivalente.md`: 2.1 a 2.21.
- `03_tomo_III_estudio_de_mercado.md`: 3.1 a 3.4.
- `MANIFEST.json`: descripción, fuente (`APP`, `PARCIAL`, `MANUAL`) y tipo de cada marcador.

## Sintaxis

- `# Título del tomo` y `## [id] Título de la sección` (el id es el número: `2.17`; en el plan de trabajo, `PT1`…).
- `{{CAMPO}}`: marcador declarado en el MANIFEST. Una línea con solo `{{TABLA_…}}`, `{{ESPECIFICACIONES}}` o `{{INDICE}}` es una tabla o el índice que arma la app.
- `[VERIFICAR en bases …]` es texto fijo: queda visible y resaltado en el Word.
- Líneas que empiezan con `- `: viñetas.

## Fuentes

- **APP**: la app lo tiene o lo calcula (título, entidad, localización, CUI, metas del 07-C, normas técnicas, lugar de entrega, presupuesto y especificaciones de la biblioteca neutral). Si falta, no se exporta.
- **PARCIAL**: se prellena con la plantilla o el expediente y sale marcado `[REVISAR]` hasta que el usuario marca «Revisado».
- **MANUAL**: lo completa la empresa o la entidad. Mientras falte, el marcador queda resaltado en amarillo.

No se agregó texto legal propio: donde hace falta, la plantilla remite a las bases. El código está en `src/selector-ioarr/documento-equivalente.js` (lógica), `word-documento-equivalente.js` (Word) y `documento-equivalente-api.js` (rutas).
