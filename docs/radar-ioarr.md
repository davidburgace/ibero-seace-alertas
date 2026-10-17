# Radar IOARR

Seguimiento de IOARR de mobiliario escolar en Obras por Impuestos (OxI), visto desde el **financista**: la empresa que financia y recibe los CIPRL.

> ⚠️ La información es **referencial**. Debe verificarse con la **DGPPIP del MEF** o con un abogado. El D.S. 038-2026-EF no reconoce intereses de financiamiento, solo costos de gestión. La tasa de costo de capital de la calculadora es un criterio interno.

## Archivos

| Ruta | Qué hace |
|---|---|
| `supabase/migrations/001_radar_ioarr.sql` | Tablas `ioarr_*`, `perfiles` (roles) y RLS |
| `supabase/migrations/003_ioarr_importacion_proinversion.sql` | Campos del Excel de Proinversión y mapeos recordados por fuente |
| `supabase/migrations/004_ioarr_documentos.sql` | Bucket privado `ioarr-docs`, tablas `ioarr_documentos` e `ioarr_precios_referencia` |
| `supabase/migrations/005_ioarr_cruce_fuentes.sql` | Cargas por fuente (`ioarr_cargas`, `ioarr_carga_filas`), `ioarr_pmi`, `ioarr_pmi_manual` y las vistas del cruce |
| `supabase/migrations/006_ioarr_filtros_carga.sql` | Columna `filtros` en `ioarr_cargas` (PMI importado solo con Educación / IOARR) para que el cruce no marque «fuera del PMI» a lo que la carga no podía contener |
| `supabase/migrations/007_ioarr_pmi_opmi.sql` | OPMI de cada carga del PMI (`ioarr_cargas.opmi`) |
| `supabase/migrations/008_ioarr_financiamiento.sql` | Fuente de financiamiento y modalidad de ejecución en proyectos y cargas del Banco |
| `supabase/migrations/009_ioarr_ia_documentos.sql` | IA: fragmentos de los PDF con embedding (`ioarr_doc_chunks`), historial del chat (`ioarr_chats`) y `ioarr_match_chunks` |
| `src/ioarr/ia.js` | IA (OpenAI): lectura de respaldo de los PDF, validada contra el texto, y chat «Preguntar a los documentos» |
| `src/ioarr/cruce.js` | Cruce de fuentes por CUI: guarda cada carga y calcula la situación de cada proyecto |
| `src/ioarr/fichas.js` | Lee los PDF del Banco de Inversiones: ficha 07-C y tabla de bienes de la estructura de costos |
| `scripts/experimentos/` | Pruebas aisladas, fuera del servidor: sondeo del portal del MEF y diagnóstico de lectura de un PDF |
| `src/ioarr/router.js` | API `/api/ioarr/*`. Se monta en `server.js` con `app.use(ioarrRouter)` |
| `src/ioarr/auth.js` | Valida el token de Supabase Auth y carga el rol |
| `src/ioarr/ingesta.js` | Servicio de ingestión aislado: lee Excel/CSV, mapea columnas y hace upsert por CUI |
| `src/ioarr/calculadora.js` | Calculadora de rentabilidad. Es una función pura que usan el backend y el navegador |
| `src/ioarr/alertas.js` | Correo diario por SMTP (SendGrid) |
| `src/public/ioarr.html` | Pantalla del módulo |
| `test/*.test.js` | Pruebas (`npm test`) |

## 1. Correr la migración

1. Abre Supabase, entra a **SQL Editor** y crea una query nueva.
2. Pega el contenido de `supabase/migrations/001_radar_ioarr.sql` y ejecútalo con **Run**. Se puede volver a correr sin problema.
3. En **Authentication → Providers → Email**, desactiva **"Allow new users to sign up"**. La clave pública está en el navegador; si el registro queda abierto, cualquiera podría crearse una cuenta.

## 2. Usuarios y roles

- Crea los usuarios en **Authentication → Users → Add user**, con correo y contraseña.
- Cada usuario nuevo recibe automáticamente el rol **`financista`**, que es el limitado: solo ve Radar IOARR.
- Para darle acceso completo:

  ```sql
  update perfiles set rol = 'proveedor' where email = 'persona@grupoibero.pe';
  ```

**Límite de la fase 1:** el rol se exige en `/api/ioarr/*` y en el inicio se ocultan los demás módulos. Pero las otras páginas y APIs (SEACE, Infra, Seguimiento) siguen sin login, igual que antes. Bloquearlas, y endurecer el RLS de `procesos_seguimiento`, `reuniones` y `visitas_comerciales` (que hoy se leen con la clave pública), queda para la fase 2. Se pueden reutilizar `requireAuth` y `requireRol` de `src/ioarr/auth.js`.

## 3. Variables de entorno (Render → Environment)

Están todas en `.env.example`. Las nuevas de este módulo son:

| Variable | Uso |
|---|---|
| `SUPABASE_PUBLISHABLE_KEY` | Clave pública (Supabase → Settings → API) para el login en el navegador |
| `IOARR_CRON` | Hora del correo diario, en zona America/Lima (por defecto `0 7 * * *`) |
| `IOARR_IA_MODELO_LECTURA` | Modelo para leer PDF con IA (por defecto `gpt-4o-mini`) |
| `IOARR_IA_MODELO_CHAT` | Modelo del chat sobre los documentos (por defecto `gpt-4o`) |

También usa las que ya existían: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SMTP_*`, `MAIL_FROM`, `FRONTEND_URL` y `OPENAI_API_KEY` (la del radar SEACE; sin ella, el módulo funciona sin IA).

## 4. Importar el Excel

1. Descarga desde el navegador el exporte del **Banco de Inversiones (Invierte.pe)** o la **lista de priorización de Proinversión**. Sirve en .xlsx, .xls o .csv. El módulo no hace scraping de esos portales.
2. En Radar IOARR, entra a **Importar**, elige el archivo y la fuente, y pulsa **Previsualizar**.
3. Revisa el mapeo de columnas, que se propone solo. CUI y nombre son obligatorios. Luego pulsa **Importar**.

> Requiere `supabase/migrations/003_ioarr_importacion_proinversion.sql` (columnas `tipologia`, `nivel_estudio`, `estado_oxi_texto`, `es_idea` y la tabla `ioarr_mapeos`). Sin ella la importación falla al guardar.

Lectura del archivo:
- La fila de encabezado se detecta sola: es la primera de las 30 primeras con al menos 4 textos y alguna palabra clave (CUI, CODIGO, NOMBRE, PROYECTO, ENTIDAD, DEPARTAMENTO). Así se salta el banner del Excel de Proinversión (título, "Última actualización", "Nº Registros"), que deja los encabezados en la fila 10. Se ignoran las columnas totalmente vacías, las filas vacías y la fila de pie ("Fuente: …", "Total …").
- Las columnas se reconocen por sinónimos, sin importar mayúsculas ni tildes. Por ejemplo, "CODIGO SNIP / INVIERTE.PE / CÓDIGO IDEA" se toma como CUI, "FASE OXI" como fase OxI y "LINK WEB" como enlace. Si la celda del enlace es un hipervínculo, se guarda la URL y no el texto "Enlace".
- Si no se reconoce la columna de CUI o de nombre, la previsualización lo avisa y lista las columnas detectadas para elegirlas a mano. El mapeo confirmado se recuerda por fuente para la siguiente carga.
- Los montos aceptan formatos como "S/1,252,892.41". El CUI se guarda como texto. Un código "IDEA…" se marca como idea de inversión (`es_idea`), no como proyecto registrado.

Reglas de la importación:
- Se actualiza por **CUI**. Las notas, la etapa del financista y las marcas manuales se conservan.
- El estado **solo avanza** (viable → priorizada → convenio → …). Un exporte antiguo no lo hace retroceder. Los estados "cerrada" o "descartada" siempre se aplican.
- Todo proyecto nuevo y todo cambio de estado queda en la línea de tiempo (`ioarr_eventos`), y eso alimenta la alerta diaria.
- Fase OxI de Proinversión: "Priorizado" → `priorizada_oxi`; "Por Priorizar" → `viable`. El texto original se guarda en `estado_oxi_texto`. Si la fuente reporta un estado anterior al actual, el estado no retrocede, pero el reporte queda como hito en la línea de tiempo. Un archivo de Proinversión sin columna de fase OxI marca los proyectos como mínimo en `priorizada_oxi`.
- "Mobiliario" se detecta por el nombre (mobiliario, equipamiento, carpetas, bancas, pupitres…) y se puede corregir en la ficha.

Para agregar fuentes automáticas más adelante (por ejemplo datosabiertos.mef.gob.pe), los pasos están comentados al inicio de `src/ioarr/ingesta.js`.

## 5. Fichas del Banco de Inversiones (PDF)

**Por qué es manual.** El servidor no consulta el portal del MEF. La consulta pública (`ofi5.mef.gob.pe/invierte/consultapublica/consultainversiones`) no responde desde IPs fuera de Perú, y Render está fuera. Además, el MEF no publica condiciones para el acceso automatizado. Por eso el flujo es semiautomático:

1. En la ficha del proyecto, **↗ Abrir en el Banco de Inversiones** copia el CUI al portapapeles y abre la consulta en otra pestaña con `?cui=<CUI>`. Si la consulta no trae el CUI puesto, se pega en el buscador.
2. Ahí se descarga el PDF (la «Exportación» del Formato 07-C, la estructura de costos, el informe de sustento).
3. Se sueltan en **Subir ficha (PDF)**. Se pueden subir hasta 10 a la vez, de 40 MB como máximo cada uno.

Los PDF se clasifican por el nombre del archivo, en este orden: «sustento/informe» → informe de sustento; «costo/presupuesto/estructura» → estructura de costos; «07-C/formato/ficha/exportación/registro» → ficha 07-C. Si el nombre no dice nada, se clasifican por el contenido. Se guardan en el bucket **privado** `ioarr-docs` y se abren con **Abrir**, que pide una URL firmada de 10 minutos. Cada subida queda como hito en la línea de tiempo.

**Ficha 07-C.** Se leen el CUI, el nombre, el tipo, la UF, la UEI, la función, la modalidad, la ubicación, el **costo total** y la fecha. Se guardan en `ioarr_proyectos.ficha_07c` y completan los campos del proyecto que estaban vacíos (el monto solo si no tenía). Si el CUI del PDF es de otro proyecto, el PDF se guarda pero no se toca el proyecto. Si el monto del proyecto difiere del costo de la ficha, se avisa.

**Estructura de costos.** Se lee la tabla de bienes: código, descripción, a (adquisición), b (embalaje), c (entrega), d (costo unitario final) y cantidad. Las columnas se ubican buscando cuatro números seguidos que cumplan **d = (a + b + c) × 1.15**. Si ninguna combinación cumple, se asume el orden a, b, c, d, cantidad y la fila se marca como **no cuadra**, con un aviso que indica la página y el valor esperado. Se guarda un precio **único por código** en `ioarr_precios_referencia`, con upsert por (CUI de origen, código). Si un código trae precios distintos, gana el más repetido y se avisa. La cantidad se suma. El año (`anio_ficha`) sale de la fecha de la ficha 07-C del proyecto o, si no la hay, de la primera fecha del PDF de costos. La pestaña **Precios de referencia** muestra la columna «Fuente y fecha» (CUI, año y documento) y exporta a Excel.

**Para revisar un PDF real sin subirlo:**

```bash
node scripts/experimentos/leer-pdf.js Exportacion.pdf Costos.pdf          # campos y tabla
node scripts/experimentos/leer-pdf.js Exportacion.pdf --lineas            # + texto reconstruido
```

Si una etiqueta del PDF real no se reconoce, se agrega a `ETIQUETAS_*` en `src/ioarr/fichas.js`. Los PDF escaneados (sin texto) se guardan, pero no se leen.

**Lectura de respaldo con IA.** Si las reglas no encuentran en la ficha 07-C el CUI, el nombre, el costo total, la modalidad o la fuente, se le pide a la IA (`IOARR_IA_MODELO_LECTURA`). En la estructura de costos, se le pide si las reglas no leen la tabla o si la mayoría de las filas no cuadra. Lo que devuelve la IA **solo se acepta si una regla lo valida contra el PDF**: el texto o la cifra tiene que aparecer en el documento y, en los costos, el código y el d de cada fila tienen que estar en el PDF (la fila que no cumple d = (a+b+c) × 1.15 queda marcada como «no cuadra»). La IA solo completa lo que las reglas no encontraron. Lo propuesto que no aparece en el PDF se descarta con un aviso 🤖, y lo aceptado se marca «🤖 con ayuda de IA» en la lectura y en la línea de tiempo.

## 5b. Preguntar a los documentos (IA)

En la ficha del proyecto, **Preguntar a los documentos** responde con lo que dicen los PDF del proyecto (por ejemplo, «¿cuántas carpetas incluye?»):

- Al subir un PDF, su texto se divide en fragmentos de ~2000 caracteres con su página y un embedding (`text-embedding-3-small`), en `ioarr_doc_chunks`. Los PDF subidos antes de la migración 009 se indexan en la primera pregunta.
- Cada pregunta busca los 8 fragmentos más parecidos (`ioarr_match_chunks`) y el modelo (`IOARR_IA_MODELO_CHAT`) responde **solo con ellos**, citando cada dato como [n] → archivo y página. Si no está en los documentos, lo dice.
- Preguntas y respuestas quedan en `ioarr_chats` (últimas 20 en la ficha). La IA **no cambia** el estado, la situación del cruce ni ningún dato del proyecto.

## 6. Cruce de fuentes

La pestaña **Cruce de fuentes** compara por CUI las tres listas y calcula la situación de cada proyecto. Requiere `supabase/migrations/005_ioarr_cruce_fuentes.sql`.

**Cargas.** Cada archivo que se importa en **Importar** queda como una carga con su fecha (`ioarr_cargas`):
- **Banco de Inversiones** (exporte de la Consulta Avanzada) y **Proinversión**: además de actualizar los proyectos como antes, se guarda el archivo completo (sin el filtro «solo IOARR») en `ioarr_carga_filas`, una fila por CUI.
- **Cartera de PMI** (fuente nueva): solo se guarda en `ioarr_pmi` (CUI, entidad, periodo, fecha de carga). No crea proyectos. Basta con mapear el CUI; la entidad y el año o periodo son opcionales pero recomendados. Al importar se puede filtrar «solo Educación» (columna Función, activado por defecto) y «solo IOARR» (columna Tipo de inversión); la carga guarda qué filtros se usaron y el resultado muestra filas leídas, importadas y descartadas por cada filtro.
- La fila de encabezado se detecta igual que en las otras importaciones. Si un CUI se repite en el archivo, gana la última fila y la carga cuenta las repeticiones.

**Qué se compara** (vistas `ioarr_cruce_*`; nada calculado se guarda):
- `en_banco`: el CUI aparece en alguna carga del Banco. Se usa su fila más reciente, porque cada exporte de la Consulta Avanzada suele estar filtrado (por región, por ejemplo).
- `en_proinversion` y `fase_oxi`: el CUI está en la **última** carga de Proinversión (esa lista se toma como completa).
- `en_pmi`: «si» si el CUI está en el PMI vigente de su entidad (la carga de PMI más reciente donde aparece esa entidad); «no» si la entidad tiene PMI cargado y el CUI no está (si esa carga se filtró, solo cuando el proyecto entra en el filtro: su función es Educación y/o su tipo es IOARR; si no entra o no se sabe, se pasa a la marca manual o «sin_verificar» con el motivo); si no hay archivo que cubra a la entidad, vale la marca manual (✎ en la columna PMI, con fecha de revisión y nota); si no, «sin_verificar».

**Situación** (la primera regla que se cumple):

| | Situación | Regla |
|---|---|---|
| a | En ejecución o descartada | Banco con estado desactivada (o cerrada/cancelada), o en ejecución con fuente pública (devengado o PIM > 0, o fuente de financiamiento que no sea OxI), o la marcaste como descartada en el radar |
| b | Desaparecida de Proinversión | Estaba en una carga anterior de Proinversión y no en la última |
| c | Priorizada en búsqueda de financista | En Proinversión con fase OxI «Priorizado» |
| d | Por priorizar | En Proinversión con fase OxI «Por Priorizar» |
| e | Viable, en PMI, sin OxI | En el Banco, no en Proinversión, `en_pmi = si` |
| f | Viable, fuera del PMI | En el Banco, no en Proinversión, `en_pmi = no` |
| g | Viable, PMI sin verificar | El resto |

Cada fila muestra el motivo («Está en Proinversión como «Priorizado»») y de qué cargas viene. La tabla se ordena por prioridad: priorizadas, por priorizar, en PMI, PMI sin verificar, fuera del PMI, desaparecidas y, al final, en ejecución o descartadas.

**Avisos.** Se señalan: CUI repetido en una carga, cambio de entidad entre cargas de la misma fuente, un PMI que trae otra entidad, una marca manual de PMI que contradice el archivo, y los códigos IDEA de Proinversión que no están en el Banco («Idea, sin CUI registrado»).

**Tu estado no se toca.** El cruce no escribe en `ioarr_proyectos`. Si la situación no encaja con el estado del proyecto en el radar (por ejemplo, Proinversión dice «Por Priorizar» y tú la tienes como «Priorizada OxI»), la fila lo marca en rojo.

**Frescura.** Arriba se ve la última carga de cada fuente (fecha, archivo, CUI, hace cuántos días; se resalta si pasa de 30 días) y el historial de cargas. El botón **Exportar a Excel** baja las filas filtradas con todas las columnas calculadas y una hoja con las cargas.

**Borrar una carga equivocada.** En el historial de cargas, **🗑 Borrar** elimina la carga y sus filas (pide confirmación y no se puede deshacer). El cruce se recalcula sin ella: si era la última de su fuente, pasa a contar la anterior. Los proyectos que esa importación creó o actualizó en `ioarr_proyectos` **no** se deshacen.

## 7. Alertas

En la pestaña **Alertas** cada usuario elige el correo, las regiones y si quiere solo mobiliario. El cron envía cada día los proyectos nuevos y los cambios de estado desde el último envío. El botón **Enviar ahora** sirve para probar.

En el plan gratuito, Render apaga el servicio cuando no tiene tráfico y el cron interno no corre. Lo mismo pasa con los crons que ya existían.

## 8. Desplegar en Render

1. Haz merge de `feature/radar-ioarr` a `main`. Render despliega solo con el `render.yaml` actual, no hace falta cambiarlo.
2. Agrega `SUPABASE_PUBLISHABLE_KEY` (y, si quieres, `IOARR_CRON`) en Environment.
3. Corre las migraciones (paso 1, y de `002` a `009` en orden) **antes** de abrir la pantalla.
4. Entra a `https://<tu-servicio>.onrender.com/ioarr.html`.

## 9. Pruebas

```bash
npm test
```

Cubren la calculadora, el parseo de montos y estados, la detección de columnas, la fusión del upsert, la lectura de PDF (ficha 07-C y tabla de costos, con PDF sintéticos) y el cruce de fuentes (CUI 2560356, el Excel de Proinversión de 4 filas, desaparecidas, PMI y casos borde).

## Calculadora

```
desembolso_total = inversión + gestión + supervisión + otros
ciprl_reconocido = inversión + gestión + supervisión        ("otros" no se reconoce)
ingreso_ciprl    = ciprl_reconocido × (1 − descuento %)     (0 % = uso propio contra el IR)
costo_capital    = desembolso × ((1 + tasa %)^(meses/12) − 1)   ← criterio interno
resultado_neto   = ingreso_ciprl − desembolso_total − costo_capital + beneficio_adicional
rentabilidad %   = resultado_neto / desembolso_total
```

El CIPRL devuelve lo reconocido a valor nominal, así que sin `beneficio_adicional` el resultado nunca es positivo: la calculadora mide el **costo de financiar**. En `beneficio_adicional` se registra la ganancia que no viene del CIPRL, como el margen como proveedor de los bienes o una ventaja tributaria. Es un estimado interno: el Estado no lo reconoce ni lo paga.

Para añadir esta columna en una base existente hay que correr también `supabase/migrations/002_ioarr_beneficio_adicional.sql`.
