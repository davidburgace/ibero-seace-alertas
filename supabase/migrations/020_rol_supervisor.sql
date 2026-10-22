-- ============================================================================
-- 020_rol_supervisor.sql — Rol «supervisor» (supervisor de campo)
--
-- El supervisor de campo solo entra a /campo.html: el mapa y el listado de
-- colegios por cercanía de cualquier región, con datos estáticos. No ve costos,
-- proyectos, Admin ni Radar IOARR, y no cambia nada (la API lo rechaza).
-- Se asigna en Admin → Usuarios (invitar o cambiar el rol).
--
-- Ejecutar en Supabase → SQL Editor después de la 019. Es idempotente.
-- Las políticas de RLS que miran el rol (010) solo aceptan 'proveedor':
-- el supervisor no gana acceso a ninguna tabla.
-- ============================================================================

alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles
  add constraint perfiles_rol_check check (rol in ('proveedor', 'financista', 'supervisor'));
