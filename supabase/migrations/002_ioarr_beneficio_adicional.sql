-- ============================================================================
-- Radar IOARR — beneficio adicional en la calculadora
-- Ganancia del financista que NO viene del CIPRL (margen como proveedor,
-- beneficio tributario, etc.). Estimado interno; el Estado no lo reconoce.
-- Ejecutar después de 001_radar_ioarr.sql (idempotente).
-- ============================================================================
alter table public.ioarr_evaluaciones
  add column if not exists beneficio_adicional numeric(16, 2) not null default 0;
