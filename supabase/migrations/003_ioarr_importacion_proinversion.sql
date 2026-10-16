-- ============================================================================
-- Radar IOARR — importación del Excel de Proinversión ("Inversiones en promoción")
-- Ejecutar después de 002_ioarr_beneficio_adicional.sql (idempotente).
-- ============================================================================

-- Campos nuevos que trae la lista de Proinversión
alter table public.ioarr_proyectos
  add column if not exists tipologia        text,
  add column if not exists nivel_estudio    text,   -- "Último nivel de estudio"
  add column if not exists estado_oxi_texto text,   -- texto original de "Fase OxI" (ej. "Por Priorizar")
  add column if not exists es_idea          boolean not null default false;  -- código IDEA…, aún sin CUI

-- Último mapeo de columnas confirmado por fuente (se propone en la próxima carga)
create table if not exists public.ioarr_mapeos (
  fuente           text primary key,
  mapeo            jsonb not null,
  actualizado_por  uuid references auth.users(id) on delete set null,
  actualizado_en   timestamptz not null default now()
);

alter table public.ioarr_mapeos enable row level security;
