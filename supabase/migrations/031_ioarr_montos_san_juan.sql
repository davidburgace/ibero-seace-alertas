-- ============================================================================
-- 031_ioarr_montos_san_juan.sql — Montos de San Juan (CUI 2711098) corregidos
-- con el Formato 07-C, y registros «estimado derivado» en el catálogo
--
-- Un OCR defectuoso de las bases dio valores erróneos. Los del 07-C:
--   Ejecución física (mobiliario)              S/ 739,373.42
--   Documento equivalente                      S/  43,144.10
--   Supervisión del documento equivalente      S/  41,219.36
--   Supervisión de la ejecución física         S/  96,178.51  (137,397.87 − 41,219.36)
--   Total                                      S/ 919,915.39
--   Cantidades: 1,045 mesas y 1,045 sillas de alumno (420 + 420 + 205),
--               42 escritorios con cajonera y 42 sillas docentes.
--
-- 1. Tipo de documento «estimado_derivado»: el precio sale de una fórmula sobre
--    los montos de un 07-C (no es un precio unitario publicado).
-- 2. Columnas nuevas de ioarr_precios_ref: componentes (deben sumar el total;
--    lo valida el servidor), derivacion, formula y monto_alternativo.
-- 3. El registro de San Juan queda como estimado derivado:
--    kit de alumno = 739,373.42 / 1,045 = S/ 707.53 con IGV (S/ 599.60 sin IGV);
--    alternativa   = 739,373.42 / 1,087 = S/ 680.20 con IGV (S/ 576.44 sin IGV).
--    Confianza media hasta cargar la «Memoria de costos y presupuestos San Juan».
--
-- Ejecutar en Supabase → SQL Editor después de la 030. Es idempotente.
-- ============================================================================

alter table public.ioarr_precios_ref drop constraint if exists ioarr_precios_ref_tipo_documento_check;
alter table public.ioarr_precios_ref add constraint ioarr_precios_ref_tipo_documento_check
  check (tipo_documento in ('07-C', 'bases', 'estudio_mercado', 'estimado_derivado', 'propio', 'por_confirmar'));

alter table public.ioarr_precios_ref add column if not exists componentes       jsonb;           -- { ejecucion, doc_equivalente, sup_doc_equivalente, sup_ejecucion, total }
alter table public.ioarr_precios_ref add column if not exists derivacion        jsonb;           -- { base, divisor, divisor_alternativo, detalle }
alter table public.ioarr_precios_ref add column if not exists formula           text;
alter table public.ioarr_precios_ref add column if not exists monto_alternativo numeric(12, 2) check (monto_alternativo is null or monto_alternativo > 0);

update public.ioarr_precios_ref set
  tipo_documento = 'estimado_derivado', cui = '2711098', entidad = 'Gobierno Regional de La Libertad', region = 'La Libertad', anio = 2026,
  unidad = 'kit', composicion = '[]'::jsonb, monto = 707.53, monto_hasta = null, incluye_igv = true, cotizaciones = null, confianza = 'media',
  componentes = '{"ejecucion": 739373.42, "doc_equivalente": 43144.10, "sup_doc_equivalente": 41219.36, "sup_ejecucion": 96178.51, "total": 919915.39}'::jsonb,
  derivacion = '{"base": "ejecucion", "divisor": 1045, "divisor_alternativo": 1087, "detalle": "1,045 mesas y 1,045 sillas de alumno (420 + 420 + 205); alternativa con 42 escritorios: 1,087"}'::jsonb,
  formula = 'Ejecución física S/ 739,373.42 / 1,045 = S/ 707.53; alternativa: / 1,087 = S/ 680.20 (1,045 mesas y 1,045 sillas de alumno (420 + 420 + 205); alternativa con 42 escritorios: 1,087)',
  monto_alternativo = 680.20,
  notas = 'Estimado a partir del 07-C; el precio unitario real está en la memoria de costos, pendiente'
where id = 'c0a7a10e-0000-4000-8000-000000000004';

notify pgrst, 'reload schema';
