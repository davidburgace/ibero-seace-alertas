# Expediente IOARR (Selector IOARR)

Arma, sobre un proyecto del Selector IOARR, la documentación de una IOARR de reposición de mobiliario escolar. Se entrega por etapas:

1. **Costos** (lista): catálogo de precios, rubros, factores por zona, estructura de costos, Excel con fórmulas y aviso de 75 UIT.
2. **Documentos** (lista): borrador del Formato 07-C y memoria descriptiva en Word.
3. **Verificación** (lista): lista de verificación, archivos de sustento y antigüedad del mobiliario.
4. **Entrega** (lista): ZIP del expediente y vínculos con Radar IOARR y su kanban.

## Regla de cálculo: se repone solo lo Malo

Desde la revisión normativa de octubre de 2026 (y el expediente del Gobierno Regional de Huánuco, 2023):

- **A reponer = Malo**, por tipo de bien, aula y local. Ya no existe el criterio «% del estado Regular que se repone»: los proyectos que lo tenían guardado lo ignoran.
- **Bueno, Regular y Malo** se muestran siempre como diagnóstico: en «Mi selección», en el detalle del aula, en el expediente, en los Excel y en la memoria descriptiva.
- **Faltante (brecha de dotación, no reposición)** = Requerido − Existente, mínimo 0 por aula. Se muestra aparte, solo como información, con su total por local y por distrito. No suma a lo que se repone, al costo ni al Formato 07-C.
- Resumen «Mobiliario por tipo»: Existente, Bueno, Regular, Malo, A reponer (= Malo), Requerido y Faltante (aparte).

Caso de control (Moquegua, búsqueda «mariscal», «Seleccionar los filtrados», criterios por defecto): 11 locales, 2,085 estudiantes, 104 aulas y **198 bienes a reponer**; el faltante, aparte, suma 1,531.

| Tipo | Existente | Bueno | Regular | Malo | A reponer | Faltante |
|---|---:|---:|---:|---:|---:|---:|
| Mesa | 3,217 | 675 | 2,520 | 22 | 22 | 795 |
| Silla | 4,018 | 1,034 | 2,853 | 131 | 131 | 683 |
| Escritorio docente | 136 | 50 | 72 | 14 | 14 | 5 |
| Silla docente | 125 | 41 | 84 | 0 | 0 | 5 |
| Armario | 216 | 93 | 92 | 31 | 31 | 43 |

El Excel del Selector trae la hoja nueva **Por distrito** (con SUMIF sobre «Locales (UP)») y, en cada hoja, las columnas en ese orden. En «Aulas», «Locales (UP)» y «Reposición masiva», «A reponer» es una fórmula que apunta a la celda de Malo.

`docs/selector-ioarr/prototipo.html` aplica la misma regla. Las pruebas comparan con él el cálculo completo, por aula y por local.

## Otra inversión vigente o reciente (duplicidad, migración 017)

Ejecuta `supabase/migrations/017_ioarr_selector_duplicidad.sql`, después de la 016. Crea `ioarr_selector_duplicidad`: una fila por proyecto y local, con RLS del dueño del proyecto. Sin fila, el local está «Sin verificar».

- **Mi selección → Locales seleccionados**, columna «Otra inversión vigente o reciente». **Editar** abre una ventana con:
  - el estado: Sí, No o Sin verificar (por defecto);
  - el código de la otra inversión (CUI);
  - una nota opcional;
  - «Excluir este local de la propuesta», que solo aparece con «Sí» y viene marcado.
- Los locales marcados «Sí» llevan la etiqueta «Otra inversión» en la tabla de «Elegir locales» y en «Expediente → Por local».
- **Un local excluido** sigue en la selección, tachado y al final de la lista, pero no entra en:
  - los totales de la pantalla;
  - el Excel del Selector, que lo lista en la hoja «Excluidos por duplicidad»;
  - los costos, el Formato 07-C, la memoria descriptiva, que lo menciona en una nota, ni el ZIP.
- Botones **Excluir los marcados «Sí»** y **Volver a incluir los excluidos**.
- El Excel del Selector trae, en «Locales (UP)», las columnas «Otra inversión vigente o reciente» (en rojo si es Sí) y «Código de la otra inversión». En el Resumen, el conteo sí / no / sin verificar.
- **Avisos del expediente:** un local con «Sí» que sigue en la propuesta (en rojo), los excluidos, los que siguen sin verificar y los «Sí» sin código.
- **Lista de verificación**, sección Locales, punto «Otra inversión vigente o reciente descartada en cada local»:
  - se cumple con «No» en todos los locales de la propuesta;
  - un «Sí» que sigue incluido lo bloquea.
  - El punto manual «Consulta en el Banco de Inversiones» se mantiene como constancia de la consulta.
- Al duplicar un proyecto se copian las marcas. Si se quita un local de la selección, su marca se conserva por si se vuelve a agregar.
- Sin la migración 017, todo queda «Sin verificar» y la columna lo avisa.
- **Mejora futura:** consultar el Banco de Inversiones en forma automática. Hoy la consulta la hace el usuario.

## Una IOARR o una IOARR por nivel (migración 018)

Ejecuta `supabase/migrations/018_ioarr_por_nivel.sql` después de la 017. Agrega:
- `modo_ioarr` al proyecto: `por_nivel` por defecto, o `una`.
- `por_nivel` al inventario verificado.

Sin la migración, el proyecto se calcula por nivel y no se puede cambiar a «Una IOARR».

**Por qué:** la norma permite una reposición masiva en varias UP si los activos son homogéneos y el servicio y la entidad son los mismos, pero no aclara si Inicial, Primaria y Secundaria cuentan como un mismo servicio. Está pendiente de confirmar con la OPMI. Un expediente de Huánuco (2023) presentó tres IOARR, una por nivel.

**En pantalla (Expediente):**
- El panel «Una IOARR o una por nivel» tiene dos cosas:
  - el selector de la opción;
  - el comparativo: total, UIT y tipo de registro (abreviado o completo) de la IOARR única y de cada IOARR por nivel, con la suma de las IOARR por nivel.
- Con «por nivel» hay una pestaña por IOARR. Costos, Documentos y Verificación muestran la IOARR elegida.

**Cálculo (`src/selector-ioarr/niveles.js`):**
- Un local con varios niveles entra en cada IOARR con lo de ese nivel: los estudiantes de esos servicios (padrón) y sus aulas (censo). Se usa `vistaNivel(D, nivel)` y `calc(D, P, nivel)`.
- `costear({ grupos })` costea todas las IOARR juntas:
  - los rubros en % se aplican igual en cada una;
  - los montos fijos se reparten entre todos los locales de todas, según su base.
  - Así, la suma de las IOARR por nivel es igual al total de la IOARR única.
- Cada IOARR tiene su propio aviso de 75 UIT.
- En el caso de control de Moquegua («mariscal»), Inicial repone 17 bienes, Primaria 101 y Secundaria 80, que suman 198.

**Inventario verificado:**
- En un local con varios niveles, bueno / regular / malo y el año de adquisición se cargan por nivel: la ventana «Corregir inventario» muestra un bloque por nivel. La visita, el sustento y los archivos siguen siendo por local.
- La IOARR única suma, en cada tipo corregido, lo de campo en los niveles cargados y el censo en los demás. El año de adquisición es el promedio ponderado por el mobiliario en mal estado de cada nivel.
- Lo que se cargó antes sin nivel en un local con varios niveles vale para la IOARR única. En las IOARR por nivel se usa el censo, con un aviso para volver a cargarlo por nivel.

**Documentos:**
- Con «por nivel», cada IOARR tiene su nombre y su CUI, que se guardan en `datos.por_nivel`.
- El vínculo con Radar IOARR se compara con la IOARR que tiene el mismo CUI.
- Las marcas manuales de la lista de verificación valen para todo el proyecto.

**Excel y ZIP:**
- El Excel de costos y los Word se descargan para la IOARR a la vista.
- El ZIP trae una carpeta por IOARR (`01_IOARR_Inicial/…`) con sus cinco documentos, el sustento común en `06_Sustento/` y un índice con cada IOARR.
- El Excel del Selector trae la hoja nueva **Por nivel**, y «Mi selección» el panel «Por nivel educativo».

**Radar IOARR:** la ficha del CUI muestra cada IOARR por nivel con su total y su registro.

## Cuadro de estado situacional (formato del expediente de Huánuco)

No necesita migración: las explicaciones se guardan en `ioarr_expediente_documentos` (migración 015).

**Qué muestra:** en **Mi selección**, el panel «Estado situacional por UGEL y nivel», y en el Excel del Selector, las hojas «Estado situacional» y «Locales por UGEL».

- **Cuadro:** una fila por nivel y UGEL, con:
  - locales;
  - población de estudiantes (matrícula del padrón);
  - número de aulas (censo);
  - mobiliario Bueno, Regular y Malo (los cinco tipos, la mesa en puestos);
  - «Cuenta con proyecto de inversión»: Sí si algún local tiene otra inversión vigente o reciente, Sin verificar si falta verificar alguno, y No en otro caso.
  - Lleva subtotales por nivel y una fila de total. En el Excel, los subtotales y el total son fórmulas.
- **Listas por UGEL:** una fila por servicio educativo, con código de local, código modular, institución, población, nivel, centro poblado, distrito y UGEL. En el Excel se agregan subtotales por UGEL.
- **Un local con varios niveles** cuenta en cada nivel.
- **Se cuentan** los locales de la propuesta; los excluidos por duplicidad quedan fuera.

**Comprobaciones** (`estadoSituacional` en `src/selector-ioarr/calculo.js`):
- Para cada UGEL, la suma de sus filas por nivel debe coincidir con lo contado por local. En el Excel, la tabla «Comprobación por UGEL» lo calcula con SUMIF.
- Los subtotales por nivel deben sumar el total de la selección.
- No debe haber dos UGEL con cifras idénticas (población, aulas, B, R y M), ni en su total ni en un mismo nivel. Un expediente real tuvo ese error.

**Si hay una advertencia:**
- Se muestra en pantalla y, al exportar, una ventana pide explicarla.
- Se puede exportar sin explicar, porque la advertencia no bloquea.
- La explicación va al Excel, debajo de la advertencia. Si falta, sale «PENDIENTE» en amarillo.
- Ruta: `PUT /api/selector-ioarr/proyectos/:id/situacional/revisiones` con `{ clave, nota }`; una nota vacía quita la explicación.

## Ficha de verificación por local (migración 019)

Ejecuta `supabase/migrations/019_ioarr_ficha_verificacion.sql` después de la 018. Agrega la columna `ficha` al inventario verificado. Sin ella, las fichas se pueden descargar, pero no importar.

**Dónde está:** Expediente → **Fichas de verificación**.

**Descargas:**
- La ficha de cada local, en Excel (para llenar) y en PDF (para imprimir y firmar).
- Un ZIP con las de todos los locales de la propuesta. Los excluidos por otra inversión no llevan ficha.

**Qué trae la ficha** (estructura del documento «Ficha de verificación de mobiliario escolar — IOARR de reposición»):
- A. Datos del local, del padrón, y de la visita: fecha, verificador y acompañante.
- B. Servicios: estudiantes del padrón y estudiantes verificados.
- C. Cinco filas por aula, con el censo ya cargado (la mesa, en puestos). Lleva columnas para Verificado Bueno, Regular y Malo, puestos por unidad, antigüedad, código patrimonial, estado de baja y observación.
- D. Mobiliario fuera de aulas y panel fotográfico.
- E. Observaciones y firmas.
- Los encabezados van completos (Censo Bueno, Verificado Bueno…), con la nota de las siglas B, R y M y la tabla de criterios.
- Lo gris lo llena la app y lo amarillo se llena en campo. Una columna y una hoja ocultas llevan las claves para importarla.

**Importación (uno o varios Excel a la vez):**
- Cada archivo se valida y se guarda por separado. El informe indica hoja, fila y motivo.
- **Se rechaza el archivo** si:
  - el local no está en el proyecto o está excluido;
  - falta la fecha de la verificación;
  - no es una ficha de la app, o se generó con otro censo;
  - no tiene ninguna fila con cantidades.
- **Se rechaza la fila** si:
  - tiene un estado a medias (si llenas uno, se llenan Bueno, Regular y Malo; B + R + M es lo existente verificado);
  - tiene cantidades negativas o con decimales;
  - los puestos por unidad están fuera de 1 a 12;
  - la antigüedad o el estado de baja no son válidos.
- **Aviso sin rechazo:** lo contado difiere del censo en más de 15 % y la fila no tiene observación.
- **Mesas:** se cuentan por unidad, con sus puestos por unidad (vacío = 1); la app las pasa a puestos. Si un aula tiene mesas de distinto tipo, se copia la fila de la mesa y se anota cada tipo en su fila.
- Volver a importar la ficha de un local reemplaza la anterior.

**Cálculo (`src/selector-ioarr/ficha.js`):**
- En cada local, nivel y tipo de bien con algo verificado, las aulas contadas usan lo verificado y las demás siguen con el censo. Se guarda en `bienes` (local de un nivel) o en `por_nivel` (varios niveles), igual que una corrección a mano.
- Cada local queda **Verificado** o **Solo censo**.
- **Formato 07-C, memoria y lista de verificación:** indican qué porcentaje de las cantidades a reponer está verificado en campo. Lo verificado reemplaza al censo donde existe; el resto sigue con el censo.
- **Antigüedad:** en años, o por rango (menos de 5, de 5 a 10, más de 10, que se calculan como 3, 8 y 12 años). El rango queda marcado como estimado, y el 07-C dice en cuántos locales.
- **Estudiantes verificados por aula:** cambian el requerido de mesas y sillas, y con él el faltante, que es informativo. No cambian lo que se repone.
- **Fuera de aulas:** se guarda como información y no entra al costo, porque está por confirmar si el proyecto lo incluye.
- Si después se corrige a mano un tipo cargado desde la ficha, ese tipo cuenta como verificado en su totalidad.

## Búsqueda por cercanía y mapa de locales

**Para qué sirve:** planificar las visitas de verificación. No necesita migración.

**Dónde está:** Elegir locales → panel **Buscar por cercanía**, entre los filtros y la tabla.

**Centro de la búsqueda** (cuatro formas):
- Un distrito: el centro es el promedio de las coordenadas válidas de sus locales.
- El código de un local.
- **Centro en el mapa**, y luego un toque en el mapa.
- El botón **Cercanos** de cada fila de la tabla.

**Qué muestra:**
- Los N locales más cercanos al centro (por defecto 20, de 1 a 200), en orden de distancia y con la columna «Distancia (km)».
- La distancia es en línea recta (fórmula de Haversine), no por carretera.
- Respeta todos los filtros activos: la cercanía se aplica sobre los locales que los pasan.
- Los locales sin coordenadas válidas (latitud de −19 a 0, longitud de −82 a −68) no entran, y se dice cuántos se omitieron.
- «Seleccionar / Quitar los filtrados» actúan sobre esos N.
- **Quitar cercanía** vuelve a la lista normal.

**Mapa** (Leaflet 1.9.4, servido por la app en `/vendor/leaflet-1.9.4/`, sin CDN):
- Se abre al buscar por cercanía o con **Ver mapa de los filtrados**. Muestra hasta 500 puntos; si hay más, avisa.
- Un punto por local: el tamaño crece con los bienes a reponer, y el color distingue los seleccionados. El centro va con un círculo rojo punteado.
- Al tocar un punto: datos del local, distancia al centro, **Abrir en Google Maps** y un botón para seleccionar o quitar el local.
- Capas: satélite (Esri World Imagery) y calles (OpenStreetMap), con sus atribuciones.
- Si Leaflet no carga, se muestra un aviso y la lista por cercanía sigue funcionando.

**Content-Security-Policy:** solo la página `/selector-ioarr.html` la tiene (`src/selector-ioarr/csp.js`). Permite las imágenes del mapa (`server.arcgisonline.com`, `tile.openstreetmap.org`) en `img-src`; scripts solo de la app y de `cdn.jsdelivr.net` (supabase-js); sin `unsafe-eval` ni scripts en línea. Las demás páginas del radar todavía no tienen CSP.

**Imágenes del mapa en producción:** Esri y OSM sirven para uso interno con poco tráfico. Para uso comercial o intensivo conviene un proveedor con llave propia, por ejemplo MapTiler, o ArcGIS Location Platform de Esri. El cambio es la URL en `src/public/selector-ioarr-mapa.js` y el origen en `ORIGENES_MAPA` de `csp.js`.

**Código:**
- `src/selector-ioarr/cercania.js`: distancia, centro del distrito y más cercanos. Lo usan el Web Worker y las pruebas.
- `src/public/selector-ioarr-worker.js`: acciones `consulta` (con `near`), `centro` y `puntos`.
- `src/public/selector-ioarr-mapa.js`: el mapa.

**Pruebas:** `test/selector-cercania.test.js`. En Moquegua, los 20 más cercanos al distrito de Moquegua llegan hasta 1.20 km y suman 7,373 estudiantes.

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
Reposición  = Malo, por aula                                          ← entra al costo
Faltante    = MAX(0, Requerido − Existente), por aula                 ← aparte: brecha de dotación, no reposición

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
Reposición = Malo
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

Con los criterios por defecto, el caso de control de Moquegua («mariscal», 11 locales) da **198 bienes a reponer** (Malo). El faltante, 1,531 bienes, va aparte y no entra al costo.

## Etapa 2: documentos (Formato 07-C y memoria descriptiva)

### Migración

Ejecuta `supabase/migrations/015_ioarr_expediente_documentos.sql`, después de la 014. Crea `ioarr_expediente_documentos`: los datos que carga el usuario, uno por proyecto, con RLS del dueño.

### Pantalla

**Selector IOARR → Expediente → Documentos.** Muestra:

- Un resumen: total, si la IOARR es individual o masiva, y si el registro es abreviado o completo.
- Los datos pendientes y las condiciones de la reposición.
- El formulario, que se guarda solo.
- Dos botones: **Formato 07-C (Word)** y **Memoria descriptiva (Word)**.

### Reglas (`src/selector-ioarr/documentos.js`)

Fuente: Lineamientos IOARR del MEF, 9.ª versión, junio de 2025, y el Anexo C con los ejemplos del Formato 07-C.

- **Un local con bienes a reponer** → IOARR de reposición (07-C con la sección E.3). **Varios** → inversión masiva de reposición (2.5; 07-C con la sección E.5 y la lista de UP). El lineamiento pone el mobiliario de aula como ejemplo de activo homogéneo.
- Los locales del proyecto sin bienes a reponer no entran como UP. Se listan en una nota.
- **Hasta 75 UIT** → sección G (registro abreviado). **Más de 75 UIT** → secciones D, E y F. Sin la UIT cargada, el Word trae las dos versiones.
- **Costo por tipo de bien** (F.1 y G.2): en cada local, el costo de los bienes con IGV, más gestión e imprevistos, se reparte según el costo directo de cada tipo. El expediente, la supervisión y la liquidación van en filas aparte. El total es igual al de la estructura de costos.
- **Cronogramas:** el costo y las metas se reparten por igual entre los meses del plazo. Los redondeos van al último mes, para que las sumas sean exactas.
- **Mantenimiento** (F.4 y G.3): el costo anual del mobiliario nuevo durante su vida útil, por tipo.
- **Datos propuestos:**
  - Del proyecto salen la función, la división y el grupo funcional, el servicio, la tipología y el indicador de brecha (según el nivel educativo), el nombre de la inversión, la UGEL responsable del mantenimiento y la descripción técnica (tomada del precio del catálogo).
  - Lo demás lo carga el usuario: UF, UEI, OPMI, plazo, mantenimiento, antigüedad, inventario y antecedentes.
  - Si un dato falta, sale como «PENDIENTE» en amarillo y en la lista de pendientes. No se inventan valores.
- **Condiciones de la reposición** (2.4.C y 2.5): cada una sale como cumple, pendiente o no cumple, según los datos y los archivos adjuntos (acta y baja).

El Word dice **«Borrador de trabajo»**: el registro oficial se hace en el aplicativo del Banco de Inversiones.

### Pruebas

`npm test` (`test/expediente-documentos.test.js`) cubre:

- El caso individual de Chiclayo 276008 (registro abreviado).
- El caso masivo de Moquegua «mariscal» (registro completo, sin pendientes).
- Que las sumas de los cronogramas sean exactas.
- Las secciones de cada Word.

Si LibreOffice Writer está instalado (`libreoffice-writer-nogui`), una prueba comprueba además que los Word abren.

## Etapa 3: verificación y antigüedad

### Migración

Ejecuta `supabase/migrations/016_ioarr_inventario_antiguedad.sql`, después de la 015. Agrega a `ioarr_expediente_inventario` la columna `adquisicion`, con el año de adquisición por tipo de bien. Sin esta migración, el inventario se guarda igual, pero sin los años.

### Antigüedad del mobiliario

- En **Corregir inventario**, cada tipo de bien tiene un campo **Año de adquisición**. Se toma del inventario patrimonial o de la placa del bien.
- Se puede cargar sin corregir las cantidades. En ese caso, para esos tipos sigue valiendo el censo.
- La antigüedad del proyecto, por tipo, es el promedio de los locales con año cargado, ponderado por la cantidad que se repone. Si en **Documentos** se escribe una antigüedad, esa tiene prioridad.
- La antigüedad va en el 07-C (E.3) y en la memoria, con su origen y con una tabla del año de adquisición por local. En el Excel, la hoja «Inventario verificado» trae el año y la antigüedad, esta con fórmula.
- **Vida útil (2.4.C.b):** se repone solo el estado **Malo**, así que se sustenta con la vida útil efectiva (2.4.B.e). El informe de vida útil estimada es opcional y, si se carga en Documentos, se cita como respaldo.

### Lista de verificación

En **Expediente → Verificación**. Se actualiza sola con los costos, el inventario y los documentos:

- **Costos:** precios, descripción técnica, rubros y UIT.
- **Locales:** visita, acta, fotos, inventario patrimonial, baja y año de adquisición, en cada local.
- **Formato 07-C y memoria:** los pendientes.
- **Condiciones de los Lineamientos IOARR.**
- **Documentos y coordinaciones**, que se marcan a mano y aceptan una nota (`VERIF_MANUAL` en `documentos.js`): informe de vida útil, cotizaciones, especificaciones del Minedu, no duplicidad, PMI, constancias de los directores, panel fotográfico y estructura de costos firmada. Se guardan en `ioarr_expediente_documentos.datos.verificacion`, así que no hace falta una migración nueva.

**Lista de verificación (Word)** descarga la misma lista.

`PATCH /documentos` fusiona lo que recibe con lo ya guardado: Documentos y Verificación mandan solo sus campos.

## Etapa 4: ZIP del expediente y vínculos con Radar IOARR

No hay migración nueva.

### ZIP del expediente

**Expediente → Verificación → Descargar expediente (ZIP)**. También está en Documentos. Ruta: `GET /api/selector-ioarr/proyectos/:id/expediente-zip`. Contiene:

```
Expediente_IOARR_<proyecto>_<fecha>/
  00_LEEME.txt                              índice, monto, registro, avance y pendientes
  01_Formato_07C_borrador.docx
  02_Memoria_descriptiva.docx
  03_Lista_de_verificacion.docx
  04_Estructura_de_costos.xlsx              con fórmulas
  05_Seleccion_de_locales_y_metrado.xlsx    el Excel del Selector, con la hoja Aulas
  06_Sustento/<código de local> <nombre>/NN_<Tipo>_<archivo>
```

- Se arma en flujo (`src/selector-ioarr/zip.js`, con archiver): los archivos del bucket se agregan de a uno, así la memoria no crece con el número de fotos.
- Los Word y los Excel se generan antes de empezar el envío. Si un archivo del bucket no se puede bajar, el ZIP se entrega igual y `00_LEEME.txt` lo lista.
- Si el proyecto está vinculado a un CUI, cada descarga registra un **hito** en la línea de tiempo de ese CUI en Radar IOARR, con el monto, el registro y el avance.

### Vínculos con Radar IOARR

Solo los ve el rol **proveedor**. El financista no ve el expediente.

- **Kanban:** la tarjeta del CUI muestra «📁 Expediente» si algún proyecto del Selector está vinculado a él.
- **Ficha del CUI**, sección «📁 Expediente IOARR»: cada proyecto vinculado, con su total, si es masivo o individual, el tipo de registro y el avance de la verificación. Muestra un aviso si el monto difiere más de 1 % del monto del CUI. El dueño ve el enlace **Abrir el expediente**, que lleva a `selector-ioarr.html?proyecto=<id>&tab=exp`.
- **En el Expediente:** el CUI vinculado, con su etapa del kanban y su monto. El enlace lleva a `ioarr.html?id=<id>`.
- **Lista de verificación:** suma el punto «Monto coherente con el CUI», con una tolerancia de 1 %.

Funciones para Radar (`src/selector-ioarr/router.js`): `conteoExpedientes()` y `expedientesDeIoarr(id, usuarioId)`. Esta última usa `api.resumen(p)` de `expediente.js`.
