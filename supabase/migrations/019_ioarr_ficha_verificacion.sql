-- ============================================================================
-- 019_ioarr_ficha_verificacion.sql — Ficha de verificación de mobiliario por local
--
-- La app genera, por local, la ficha de verificación en Excel y PDF (padrón y
-- censo ya cargados). La UGEL la llena en campo y la devuelve en Excel; al
-- importarla, las cantidades verificadas reemplazan a las del censo en el
-- inventario verificado del local (bienes / por_nivel, ver 013 y 018), con la
-- fecha de la visita y el verificador.
--
-- ficha guarda el detalle de la ficha importada:
--   archivo, importado_en, fecha, verificador, acompanante, coord (si se corrigieron)
--   servicios  { codModular: { est, obs } }          estudiantes verificados (sección B)
--   aulas      { j: { nivel, est, filas: [{ k, b, r, m, unidades, puestos,
--                antig, estimada, patrimonial, baja, obs }] } }   (sección C; j = n.° de aula - 1)
--   fuera      mobiliario fuera de aulas (informativo, no entra al costo)
--   fotos, firmas, observaciones
--   verif      { '_' | nivel: { tipo: { b, r, m, mv, mc } } }  mv = Malo contado en
--              campo, mc = Malo del censo en las aulas sin verificar (para el % del 07-C)
--   adq_estimada { '_' | nivel: [tipos] }  antigüedad estimada por rango
--
-- Ejecutar en Supabase → SQL Editor, después de la 018. Es idempotente.
-- ============================================================================

alter table public.ioarr_expediente_inventario
  add column if not exists ficha jsonb;

comment on column public.ioarr_expediente_inventario.ficha is
  'Ficha de verificación importada (Excel devuelto por la UGEL): detalle por aula, código patrimonial, estado de baja, estudiantes verificados, fuera de aulas y firmas. Null = cargado a mano o sin ficha.';
