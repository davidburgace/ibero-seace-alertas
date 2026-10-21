-- ============================================================================
-- 016_ioarr_inventario_antiguedad.sql — Etapa 3: antigüedad del mobiliario
--
-- Año de adquisición de cada tipo de bien en un local, tomado del inventario
-- patrimonial o de la visita: { "mesa": 2008, "silla": 2012 }. Con él se calcula
-- la antigüedad que va en el Formato 07-C (E.3) y la memoria descriptiva, y se
-- compara con la vida útil estimada (Lineamientos IOARR 2.4.C.b).
--
-- Ejecutar después de la 015. Es idempotente.
-- ============================================================================

alter table public.ioarr_expediente_inventario
  add column if not exists adquisicion jsonb not null default '{}'::jsonb;

-- Un local puede tener solo el año de adquisición, sin corregir cantidades
-- (el censo sigue valiendo para esos tipos)
comment on column public.ioarr_expediente_inventario.adquisicion is
  'Año de adquisición por tipo de bien: { "mesa": 2008 }. Vacío = sin dato.';
