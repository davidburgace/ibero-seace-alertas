-- ============================================================================
-- 035_ioarr_precios_materiales_kit.sql — Unidades «armario» y «otro» en el catálogo
-- de precios referenciales y datos que faltaban en la precarga
--
-- 1. Unidades nuevas: armario (precio por defecto del armario en Costos, por material) y otro.
-- 2. Precarga: solo se llenan los campos que estaban vacíos o «por confirmar», con los
--    datos que dio el usuario (CSV del pedido de materiales y kit). No se pisa nada de lo
--    corregido en la 030 a la 033 (San Juan con su memoria de costos; Huánuco 2023 con su
--    cuadro comparativo, sin CUI). El precio propio no lleva nombre de empresa.
--
-- El material, la selección de muebles y los precios por material de Costos van en la
-- estructura del expediente (ioarr_expediente_costos.estructura, jsonb): sin tabla nueva.
--
-- Ejecutar en Supabase → SQL Editor después de la 034. Es idempotente.
-- ============================================================================

alter table public.ioarr_precios_ref drop constraint if exists ioarr_precios_ref_unidad_check;
alter table public.ioarr_precios_ref add constraint ioarr_precios_ref_unidad_check
  check (unidad in ('kit', 'mesa', 'silla', 'carpeta', 'armario', 'pieza', 'otro'));

-- Loreto 2026: entidad, confianza y nota (el CUI queda vacío a propósito)
update public.ioarr_precios_ref set entidad = 'Gobierno Regional Loreto'
  where id = 'c0a7a10e-0000-4000-8000-000000000001' and entidad is null;
update public.ioarr_precios_ref set confianza = 'alta'
  where id = 'c0a7a10e-0000-4000-8000-000000000001' and confianza = 'media';
update public.ioarr_precios_ref set notas = 'Precio por kit sin IGV.'
  where id = 'c0a7a10e-0000-4000-8000-000000000001' and (notas is null or notas = '');

-- Huánuco 2025: CUI, entidad, nivel y nota (el IGV sigue por confirmar: no es comparable)
update public.ioarr_precios_ref set cui = '2586831'
  where id = 'c0a7a10e-0000-4000-8000-000000000003' and cui is null;
update public.ioarr_precios_ref set entidad = 'Gobierno Regional Huánuco'
  where id = 'c0a7a10e-0000-4000-8000-000000000003' and entidad is null;
update public.ioarr_precios_ref set nivel = 'Primaria'
  where id = 'c0a7a10e-0000-4000-8000-000000000003' and nivel = 'por_confirmar';
update public.ioarr_precios_ref set notas = 'Rango 455-480 (se compara por su punto medio, 467.50); confirmar si incluye IGV.'
  where id = 'c0a7a10e-0000-4000-8000-000000000003' and (notas is null or notas = '');

-- Precio propio: material y confianza (sigue fuera de los estadísticos y sin entidad)
update public.ioarr_precios_ref set material = 'metal-polipropileno'
  where id = 'c0a7a10e-0000-4000-8000-000000000005' and material = 'por_confirmar';
update public.ioarr_precios_ref set confianza = 'alta'
  where id = 'c0a7a10e-0000-4000-8000-000000000005' and confianza = 'media';
update public.ioarr_precios_ref set notas = 'Excluir de estadísticos.'
  where id = 'c0a7a10e-0000-4000-8000-000000000005' and (notas is null or notas = '');

notify pgrst, 'reload schema';
