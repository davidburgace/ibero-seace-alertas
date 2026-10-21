-- ============================================================================
-- 018_ioarr_por_nivel.sql — Una IOARR o una IOARR por nivel educativo
--
-- 1. modo_ioarr en el proyecto del Selector:
--      'por_nivel' (por defecto) · una IOARR por nivel (Inicial, Primaria,
--                                  Secundaria, Básica Especial), cada una con
--                                  sus locales, su metrado y su total
--      'una'                     · una sola IOARR con todos los niveles
--    La norma no aclara si los tres niveles son un mismo servicio: queda por
--    confirmar con la OPMI. Un expediente de Huánuco (2023) presentó tres IOARR.
--
-- 2. por_nivel en el inventario verificado: en un local con varios niveles, las
--    cantidades y el año de adquisición se cargan por nivel:
--      { "P": { "bienes": { "mesa": { "b": 0, "r": 0, "m": 40 } }, "adquisicion": { "mesa": 2008 } }, ... }
--    La visita (fecha, responsable, sustento) y los archivos siguen siendo por local.
--
-- Ejecutar en Supabase → SQL Editor, después de la 017. Es idempotente.
-- ============================================================================

alter table public.ioarr_selector_proyectos
  add column if not exists modo_ioarr text not null default 'por_nivel';
alter table public.ioarr_selector_proyectos drop constraint if exists ioarr_selector_proyectos_modo_ioarr;
alter table public.ioarr_selector_proyectos add constraint ioarr_selector_proyectos_modo_ioarr
  check (modo_ioarr in ('una', 'por_nivel'));

alter table public.ioarr_expediente_inventario
  add column if not exists por_nivel jsonb not null default '{}'::jsonb;
