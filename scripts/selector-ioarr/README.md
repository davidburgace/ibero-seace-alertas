# Datos del Selector IOARR

`build_national.py` genera un JSON por región en `src/public/data/selector-ioarr/<año>/` y un `index.json` con la lista de regiones.

Los datos actuales salen de:

- **Padrón de ESCALE – Minedu**, registros al 29/10/2025.
- **Censo Educativo 2025**, cédula de Local escolar, pregunta 6.1 (aulas y mobiliario).

El alcance son los servicios públicos, escolarizados y activos de Inicial, Primaria, Secundaria y Básica Especial.

## Regenerar los datos cuando salga un censo nuevo

1. Descarga de ESCALE (http://escale.minedu.gob.pe):
   - el **Padrón** de instituciones educativas (`Padron.dbf`);
   - la base del **Censo Educativo**, Local escolar, archivo de aulas de la pregunta 6.1 (`Loc_P61_Aulas.dbf`).
2. Revisa que los nombres de columnas sigan iguales. El script usa, entre otros, `P61_3`, `P61_5_*`, `P61_16_*` a `P61_22_*`, `CODLOCAL`, `COD_MOD`, `D_NIV_MOD`, `D_GESTION` y `NLAT_IE`. Si el Minedu cambió la cédula, ajusta el script.
3. Corre el script:
   ```bash
   pip install dbfread
   python3 scripts/selector-ioarr/build_national.py \
     --padron ~/descargas/Padron.dbf \
     --aulas  ~/descargas/Loc_P61_Aulas.dbf \
     --anio   2026 \
     --fuente "Padrón de ESCALE – Minedu (registros al DD/MM/2026) y Censo Educativo 2026 (Local escolar, pregunta 6.1)"
   ```
4. Cambia el año de los datos en dos lugares:
   - `ANIO_DATOS` en `src/selector-ioarr/router.js`;
   - `ANIO` en `src/public/selector-ioarr.js`.
5. Actualiza el caso de control en `test/selector-ioarr.test.js` y corre `npm test`.
6. Puedes borrar la carpeta del año anterior. Los proyectos guardados conservan los mismos códigos de local, y `anio_datos` registra con qué censo se armó cada uno.

La carpeta de cada año se sirve con caché inmutable de un año. Como un censo nuevo va en otra carpeta, no hace falta invalidar nada.
