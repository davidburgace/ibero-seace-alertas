-- ============================================================================
-- 036_ioarr_huanuco_2025_sin_igv.sql — Huánuco 2025 (kit metal-madera, rango 455-480):
-- el usuario confirmó que el monto NO incluye IGV (2026-10-25).
--
-- Con eso el registro es comparable: precio por kit sin IGV = punto medio 467.50, y es
-- la referencia de Metal/Madera en Costos. Solo cambia si seguía por confirmar.
-- Huánuco 2023 no cambia: su cuadro comparativo es con IGV (migración 033).
--
-- Ejecutar en Supabase → SQL Editor después de la 035. Es idempotente.
-- ============================================================================

update public.ioarr_precios_ref set incluye_igv = false
  where id = 'c0a7a10e-0000-4000-8000-000000000003' and incluye_igv is null;
update public.ioarr_precios_ref set notas = 'Rango 455-480 sin IGV (se compara por su punto medio, 467.50).'
  where id = 'c0a7a10e-0000-4000-8000-000000000003' and notas = 'Rango 455-480 (se compara por su punto medio, 467.50); confirmar si incluye IGV.';

notify pgrst, 'reload schema';
