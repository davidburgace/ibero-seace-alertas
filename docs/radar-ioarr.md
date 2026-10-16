# Radar IOARR

Seguimiento de IOARR de mobiliario escolar en Obras por Impuestos (OxI), visto desde el **financista**: la empresa que financia y recibe los CIPRL.

> ⚠️ La información es **referencial**. Debe verificarse con la **DGPPIP del MEF** o con un abogado. El D.S. 038-2026-EF no reconoce intereses de financiamiento, solo costos de gestión. La tasa de costo de capital de la calculadora es un criterio interno.

## Archivos

| Ruta | Qué hace |
|---|---|
| `supabase/migrations/001_radar_ioarr.sql` | Tablas `ioarr_*`, `perfiles` (roles) y RLS |
| `supabase/migrations/003_ioarr_importacion_proinversion.sql` | Campos del Excel de Proinversión y mapeos recordados por fuente |
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

También usa las que ya existían: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SMTP_*`, `MAIL_FROM` y `FRONTEND_URL`.

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

## 5. Alertas

En la pestaña **Alertas** cada usuario elige el correo, las regiones y si quiere solo mobiliario. El cron envía cada día los proyectos nuevos y los cambios de estado desde el último envío. El botón **Enviar ahora** sirve para probar.

En el plan gratuito, Render apaga el servicio cuando no tiene tráfico y el cron interno no corre. Lo mismo pasa con los crons que ya existían.

## 6. Desplegar en Render

1. Haz merge de `feature/radar-ioarr` a `main`. Render despliega solo con el `render.yaml` actual, no hace falta cambiarlo.
2. Agrega `SUPABASE_PUBLISHABLE_KEY` (y, si quieres, `IOARR_CRON`) en Environment.
3. Corre la migración (paso 1) **antes** de abrir la pantalla.
4. Entra a `https://<tu-servicio>.onrender.com/ioarr.html`.

## 7. Pruebas

```bash
npm test
```

Cubren la calculadora, el parseo de montos y estados, la detección de columnas y la fusión del upsert.

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
