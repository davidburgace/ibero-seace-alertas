# Expediente IOARR (Selector IOARR)

Arma, sobre un proyecto del Selector IOARR, la documentación de una IOARR de reposición de mobiliario escolar. Se entrega por etapas:

1. **Costos** (esta etapa): catálogo de precios, rubros, factores por zona, estructura de costos, Excel con fórmulas y aviso de 75 UIT.
2. Documentos: Formato 07-C y memoria descriptiva en Word.
3. Lista de verificación, archivos de sustento y antigüedad del mobiliario.
4. Vínculos con el kanban OxI y Radar IOARR, y ZIP del expediente.

## Etapa 1: costos

### Migración

Ejecuta `supabase/migrations/012_ioarr_expediente_costos.sql` en Supabase → SQL Editor, después de la 011. Es idempotente.

| Tabla | Alcance | Qué guarda |
|---|---|---|
| `ioarr_precios_catalogo` | Compartida (proveedores) | Precio unitario sin IGV por tipo de bien, con unidad, fecha, fuente (cotización, SEACE, histórico propio) y observación. Un solo vigente por tipo (índice único parcial). |
| `ioarr_uit` | Compartida | Valor de la UIT por año y la norma que la fija. La carga el usuario. |
| `ioarr_factores_zona` | Compartida | % adicional de flete e instalación por provincia (ubigeo de 4 dígitos), distrito (6) o área rural de una región (2). |
| `ioarr_expediente_costos` | Dueño del proyecto | Rubros del proyecto (modo, valor, base) y año de la UIT. |
| `ioarr_expediente_precios` | Dueño del proyecto | Precio fijado por tipo: copia del catálogo, para que un cambio en el catálogo no altere el proyecto sin aviso. |

RLS: el catálogo exige `es_proveedor()`; los costos del proyecto, ser dueño del proyecto y proveedor. Nada para `anon`. El servidor usa la clave secreta, igual que el resto del Selector.

No hay variables de entorno nuevas.

### Pantallas

- **Selector IOARR → pestaña Expediente.** Precios por tipo de bien (vigente del catálogo o fijado en el proyecto), rubros editables (se guardan solos), estructura de costos, faltante aparte, por distrito, por local y botón **Exportar costos a Excel**.
- **Precios y parámetros** (`selector-ioarr-precios.html`, enlazada desde la pestaña). Catálogo de precios, UIT por año y factores por zona. **Copiar de Radar IOARR** trae un precio de `ioarr_precios_referencia` (estructuras de costos leídas del Banco de Inversiones) y copia «a», el costo de adquisición, porque «d» ya incluye embalaje y entrega.

### Cálculo (`src/selector-ioarr/costos.js`)

Lo usan la API y el Excel, así la pantalla y el Excel dan lo mismo.

```
Reposición  = Malo + ROUND(Regular × % de Regular), por aula          ← entra al costo
Faltante    = MAX(0, Requerido − Existente), por aula                 ← aparte, referencial

Por local:
CD          = Σ reposición × precio unitario (sin IGV)
Transporte  = CD × % × (1 + factor de flete de la zona)
Instalación = CD × % × (1 + factor de instalación de la zona)
Embalaje    = CD × %
Subtotal    = CD + transporte + instalación + embalaje
GG, utilidad sobre el subtotal o el CD
Neto        = subtotal + GG + utilidad
IGV         = neto × %
Bienes      = neto + IGV
Supervisión, expediente, gestión, imprevistos sobre bienes, subtotal o CD
Total       = bienes + esos cuatro
```

- Cada rubro va en % o como monto fijo. El monto fijo se reparte entre los locales en proporción a su base (en partes iguales si la base suma 0).
- Factor por zona de un local: el de su distrito o, si no hay, el de su provincia; si el local es rural, se suma el factor rural de su región.
- **El faltante no entra al total.** Amplía la capacidad de la UP, y los Lineamientos IOARR del MEF (30/06/2025, sección 2.4.C) dicen que la reposición «no puede sustentarse en un incremento de la capacidad de la UP». Se valoriza con los mismos precios como referencia para evaluarlo como ampliación marginal.
- **Aviso de 75 UIT:** hasta 75 UIT el Formato 07-C va en registro abreviado (sección G); por encima, en registro completo (secciones D, E y F). Fuente: Lineamientos IOARR del MEF y capacitación del MEF de 2021.
- El sistema no propone precios, porcentajes ni UIT: todos los rubros empiezan en 0 y se avisa lo que falta.

### Inventario verificado en campo (migración 013)

El Censo Educativo lo declara cada colegio y a veces está incompleto. Por ejemplo, el local 276008 (11124 Nuestra Señora de la Paz, Chiclayo) no reporta ninguna mesa, así que sus 569 mesas salen como faltante y no entran al costo. Si en la visita se comprueba que las mesas existen y están en mal estado, se corrige el inventario de ese local:

1. Ejecuta `supabase/migrations/013_ioarr_expediente_inventario.sql`, después de la 012. Crea `ioarr_expediente_inventario`, una fila por proyecto y local, con RLS del dueño del proyecto.
2. En **Expediente → Por local**, busca el local y pulsa **Corregir inventario**.
3. Marca los tipos que verificaste, escribe bueno, regular y malo, la fecha de la visita y el sustento (acta, fotos, firma del director).

En esos tipos se reemplaza el censo, por local:

```
Faltante   = MAX(0, Requerido − (Bueno + Regular + Malo))
Reposición = Malo + ROUND(Regular × % de Regular)
```

- Solo cambia el expediente (pantalla y Excel). El Selector sigue mostrando el censo.
- Se guarda una copia de lo que decía el censo al momento de corregir.
- Aparece un aviso con los locales corregidos.
- El Excel trae la columna **Inventario** en «Metrado y costos por local» y la hoja **Inventario verificado**, que compara censo y campo e incluye el sustento.
- Sin la migración 013, el expediente se calcula con el censo, y al guardar una corrección se avisa que falta ejecutarla.

#### Sustento: acta y fotos (migración 014)

Ejecuta `supabase/migrations/014_ioarr_expediente_archivos.sql`, después de la 013. Crea el bucket **privado** `ioarr-expediente` (PDF, JPG, PNG, WEBP y HEIC, hasta 15 MB por archivo) y la tabla `ioarr_expediente_archivos`, con RLS del dueño del proyecto.

- Los archivos se adjuntan en la misma ventana de **Corregir inventario**, una vez guardado el inventario.
- Tipos: acta de verificación, foto, inventario patrimonial, resolución o trámite de baja, y otro. Si se deja en «Automático», un PDF se guarda como acta y una imagen como foto.
- Las fotos de más de 800 KB se reducen en el navegador a 2400 px de lado (JPEG al 85 %) antes de subirse. HEIC se sube tal cual.
- El servidor comprueba el tipo real por el contenido del archivo, no por el nombre.
- Se admiten hasta 60 archivos por local. Se abren con una URL firmada de 10 minutos.
- Si a un local corregido le falta el acta, el expediente muestra un aviso.
- En el Excel, la hoja «Inventario verificado» trae la columna «Archivos adjuntos», en amarillo si falta el acta.
- Al quitar la corrección de un local o al borrar el proyecto, se borran también sus archivos del bucket.

### Excel (`src/selector-ioarr/excel-costos.js`)

Hojas: **Resumen**, **Parámetros**, **Partidas**, **Metrado y costos por local** y **Por distrito**. Cada cifra calculada es una fórmula de Excel. Si se cambia un precio, un % o la UIT en **Parámetros**, el libro se recalcula, incluido el texto «Registro que corresponde». Las celdas sin cargar van en amarillo. Las cantidades del metrado van como valor: salen del cálculo por aula del Selector, cuyo Excel trae esas fórmulas en la hoja Aulas.

### Cómo probarlo

1. Corre la migración 012.
2. En **Precios y parámetros**, carga un precio por tipo de bien (marcado «PRUEBA» si es de prueba), la UIT del año y, si quieres, un factor por zona.
3. En el Selector, abre o crea un proyecto (por ejemplo, Moquegua con la búsqueda «mariscal»), entra a **Expediente** y completa los rubros.
4. **Exportar costos a Excel** y compara el total con el de la pantalla.
5. Borra los datos «PRUEBA» del catálogo.

Pruebas automáticas: `npm test` (`test/expediente-costos.test.js`). Si LibreOffice está instalado, una prueba recalcula el Excel, comprueba que el total coincide con el cálculo y que cambia al editar un precio y la UIT.

Con los criterios por defecto, el caso de control de Moquegua («mariscal», 11 locales) da 1,729 bienes en el metrado: **198 de reposición** (Malo) y **1,531 de faltante**.
