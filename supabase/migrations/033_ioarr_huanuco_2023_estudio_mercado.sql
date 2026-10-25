-- ============================================================================
-- 033_ioarr_huanuco_2023_estudio_mercado.sql — Huánuco 2023 con su cuadro
-- comparativo y estructura preliminar de costos (marzo 2023)
--
-- Fuente: «Reposición de mobiliario de aulas del nivel primario en las diferentes
-- IIEE de las 11 provincias de la región Huánuco», Gobierno Regional Huánuco
-- (sin CUI en el documento). Cotizaciones de enero 2023, con IGV y transporte:
--   Mobiliarios Yi SAC     polipropileno     S/ 370
--   Carpintería Garay      madera tornillo   S/ 250
--   Mobi Edu               polipropileno     S/ 270
--   Maderera Burgos        madera            S/ 180
--   promedio                                 S/ 267.50 con IGV (S/ 226.69 sin IGV)
-- Costo directo: 12,310 × 267.50 = S/ 3,292,925.00 con IGV (S/ 2,790,614.41 sin IGV).
-- Indirectos: expediente 1.19 %, supervisión 0.9 %, liquidación 0.8 %
-- (= S/ 95,165.53); total S/ 3,388,090.53 con IGV.
--
-- Unidad: pieza suelta (confirmado por el usuario el 2026-10-25); sigue sin ser
-- comparable hasta tener la composición del kit. Material: metal y madera
-- (indicado por el usuario; las cotizaciones mezclan polipropileno y madera).
-- El transporte va incluido en el precio: flete_transporte queda vacío.
--
-- Ejecutar en Supabase → SQL Editor después de la 032. Es idempotente.
-- ============================================================================

update public.ioarr_precios_ref set
  tipo_documento = 'estudio_mercado', cui = null, entidad = 'Gobierno Regional Huánuco', region = 'Huánuco', anio = 2023,
  nivel = 'Primaria', unidad = 'pieza', material = 'metal-madera', composicion = '[]'::jsonb,
  monto = 267.50, monto_hasta = null, incluye_igv = true, flete_transporte = null,
  cotizaciones = '{"valores": [370, 250, 270, 180], "n": 4, "promedio": 267.50}'::jsonb, confianza = 'media',
  componentes = null, derivacion = null, formula = null, monto_alternativo = null,
  notas = 'Cuadro comparativo y estructura preliminar de costos (mar. 2023), «Reposición de mobiliario de aulas del nivel primario … 11 provincias de la región Huánuco»; sin CUI. Promedio de 4 cotizaciones con IGV y transporte incluido (ene. 2023): Mobiliarios Yi 370 (polipropileno), Carpintería Garay 250 (madera tornillo), Mobi Edu 270 (polipropileno), Maderera Burgos 180 (madera). 12,310 piezas × 267.50 = S/ 3,292,925.00 con IGV; con expediente 1.19 %, supervisión 0.9 % y liquidación 0.8 %: S/ 3,388,090.53. No comparable hasta indicar la composición del kit.'
where id = 'c0a7a10e-0000-4000-8000-000000000002';

notify pgrst, 'reload schema';
