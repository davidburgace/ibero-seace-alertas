-- ============================================================================
-- 030_ioarr_precios_ref_material.sql — Material «madera» en el catálogo de
-- precios referenciales y material de los registros precargados
--
-- 1. Se agrega el material «madera» (mobiliario solo de madera).
-- 2. Material de la precarga de la 029 (indicado por el usuario el 2026-10-25):
--      Loreto 2026      → madera
--      Huánuco 2023     → metal-madera
--      Huánuco 2025     → metal-madera
--      San Juan 2026    → metal-polipropileno
--    Solo si siguen «por_confirmar»: no se pisa lo que ya se haya corregido.
--
-- Ejecutar en Supabase → SQL Editor después de la 029. Es idempotente.
-- ============================================================================

alter table public.ioarr_precios_ref drop constraint if exists ioarr_precios_ref_material_check;
alter table public.ioarr_precios_ref add constraint ioarr_precios_ref_material_check
  check (material in ('madera', 'metal-madera', 'metal-polipropileno', 'por_confirmar'));

alter table public.ioarr_precios_ref_proyecto drop constraint if exists ioarr_precios_ref_proyecto_material_check;
alter table public.ioarr_precios_ref_proyecto add constraint ioarr_precios_ref_proyecto_material_check
  check (material in ('todos', 'madera', 'metal-madera', 'metal-polipropileno', 'por_confirmar'));

update public.ioarr_precios_ref set material = 'madera'
  where id = 'c0a7a10e-0000-4000-8000-000000000001' and material = 'por_confirmar';
update public.ioarr_precios_ref set material = 'metal-madera'
  where id in ('c0a7a10e-0000-4000-8000-000000000002', 'c0a7a10e-0000-4000-8000-000000000003') and material = 'por_confirmar';
update public.ioarr_precios_ref set material = 'metal-polipropileno'
  where id = 'c0a7a10e-0000-4000-8000-000000000004' and material = 'por_confirmar';

notify pgrst, 'reload schema';
