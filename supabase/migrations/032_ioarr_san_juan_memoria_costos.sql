-- ============================================================================
-- 032_ioarr_san_juan_memoria_costos.sql — San Juan (CUI 2711098) con el precio
-- unitario real de la «Memoria descriptiva de costos y presupuestos» (dic. 2025)
--
-- Reemplaza el estimado de la 031 (ejecución del 07-C / 1,045 = S/ 599.60 sin IGV).
-- En la memoria, el presupuesto da «costo unitario + flete» a nivel de costo directo
-- (S/ 488,865.47), SIN IGV; encima van gastos generales 18.17 %, utilidad 10 % e IGV
-- 18 % (= S/ 739,373.42 de ejecución). Cada precio unitario es el promedio de 4
-- cotizaciones con IGV / 1.18 + S/ 13.01 de flete por pieza.
--
-- Kit = mesa + silla (1,045 kits: rojo 420, verde 420, marrón 205):
--   costo directo con flete   S/ 457,577.55 / 1,045 = S/ 437.87
--   flete (2 piezas × 13.01)                          S/  26.02  → flete_transporte
--   precio del bien, sin flete, GG, utilidad ni IGV  S/ 411.85  → monto (sin IGV)
-- Elegido por el usuario el 2026-10-25: comparable con la estructura de costos de
-- la app (bienes + transporte, sin gastos generales ni utilidad).
-- Nivel Secundaria (según la memoria); confianza alta.
--
-- Ejecutar en Supabase → SQL Editor después de la 031. Es idempotente.
-- ============================================================================

update public.ioarr_precios_ref set
  tipo_documento = '07-C', cui = '2711098', entidad = 'Gobierno Regional de La Libertad', region = 'La Libertad', anio = 2026,
  nivel = 'Secundaria', unidad = 'kit', material = 'metal-polipropileno', composicion = '[]'::jsonb,
  monto = 411.85, monto_hasta = null, incluye_igv = false, flete_transporte = 26.02,
  cotizaciones = '{"valores": [], "n": 4, "promedio": null}'::jsonb, confianza = 'alta',
  componentes = '{"ejecucion": 739373.42, "doc_equivalente": 43144.10, "sup_doc_equivalente": 41219.36, "sup_ejecucion": 96178.51, "total": 919915.39}'::jsonb,
  derivacion = null, formula = null, monto_alternativo = null,
  notas = 'Memoria de costos y presupuestos (dic. 2025): precio del bien sin flete, gastos generales, utilidad ni IGV; promedio de 1,045 kits mesa + silla (rojo 420, verde 420, marrón 205). Flete S/ 13.01 por pieza (S/ 26.02 por kit). Con flete por color: S/ 434.47 / 436.09 / 448.49. Con gastos generales 18.17 % y utilidad 10 %: S/ 561.23 sin IGV.'
where id = 'c0a7a10e-0000-4000-8000-000000000004';

notify pgrst, 'reload schema';
