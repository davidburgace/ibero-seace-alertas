-- ============================================================================
-- 026_ioarr_precios_por_talla.sql — Precios de mesa y silla por talla
--
-- La mesa y la silla del estudiante se costean por talla, según el grado del
-- aula (src/selector-ioarr/calculo.js, TALLAS):
--   i   Inicial                    e   Básica Especial
--   p12 Primaria 1.° y 2.°         s12 Secundaria 1.° y 2.°
--   p34 Primaria 3.° y 4.°         s34 Secundaria 3.° y 4.°
--   p56 Primaria 5.° y 6.°         s5  Secundaria 5.°
-- tipo_bien acepta, además de los 5 tipos, 'mesa_<talla>' y 'silla_<talla>'.
-- El precio del tipo ('mesa', 'silla') sigue valiendo para las tallas sin
-- precio propio, así que los proyectos y precios existentes no cambian.
--
-- Ejecutar en Supabase → SQL Editor después de la 025. Es idempotente.
-- ============================================================================

alter table public.ioarr_precios_catalogo drop constraint if exists ioarr_precios_catalogo_tipo_bien_check;
alter table public.ioarr_precios_catalogo drop constraint if exists ioarr_precios_catalogo_tipo_bien;
alter table public.ioarr_precios_catalogo add constraint ioarr_precios_catalogo_tipo_bien
  check (tipo_bien ~ '^(mesa|silla|esc|sdoc|arm)$' or tipo_bien ~ '^(mesa|silla)_(i|p12|p34|p56|s12|s34|s5|e)$');

alter table public.ioarr_expediente_precios drop constraint if exists ioarr_expediente_precios_tipo_bien_check;
alter table public.ioarr_expediente_precios drop constraint if exists ioarr_expediente_precios_tipo_bien;
alter table public.ioarr_expediente_precios add constraint ioarr_expediente_precios_tipo_bien
  check (tipo_bien ~ '^(mesa|silla|esc|sdoc|arm)$' or tipo_bien ~ '^(mesa|silla)_(i|p12|p34|p56|s12|s34|s5|e)$');
