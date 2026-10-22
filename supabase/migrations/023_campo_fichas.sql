-- ============================================================================
-- 023_campo_fichas.sql — Ficha de verificación llenada en la app (Visitas de campo)
--
-- El supervisor de campo llena en su celular o tablet la ficha de verificación
-- de cada colegio que tiene asignado, en lugar de la hoja impresa o el Excel.
-- La ficha pasa por la revisión del proveedor dueño del proyecto:
--   borrador   el supervisor la está llenando (la puede cambiar)
--   enviada    la mandó a revisión: ya no la cambia
--   observada  el proveedor la devolvió con una nota: el supervisor la corrige y la reenvía
--   aprobada   el proveedor la aprobó: sus cantidades pasan al inventario verificado del
--              local (ioarr_expediente_inventario, igual que al importar el Excel, ver 019)
-- datos guarda lo llenado, con la misma estructura que lee la importación del Excel
-- (src/selector-ioarr/ficha-digital.js).
--
-- Una fila por proyecto y local. Solo la usa el servidor (/api/campo/*, y la revisión
-- en /api/selector-ioarr/*, clave secreta): RLS activado y sin políticas.
--
-- Ejecutar en Supabase → SQL Editor después de la 022. Es idempotente.
-- ============================================================================

create table if not exists public.campo_fichas (
  proyecto_id        uuid not null references public.ioarr_selector_proyectos(id) on delete cascade,
  codigo_local       text not null,
  estado             text not null default 'borrador' check (estado in ('borrador', 'enviada', 'observada', 'aprobada')),
  datos              jsonb not null default '{}'::jsonb,
  editado_por        uuid references auth.users(id) on delete set null,
  editado_por_email  text,
  enviada_en         timestamptz,
  revisado_por       uuid references auth.users(id) on delete set null,
  revisada_en        timestamptz,
  nota_revision      text,
  actualizado_en     timestamptz not null default now(),
  primary key (proyecto_id, codigo_local)
);

create index if not exists campo_fichas_estado on public.campo_fichas (proyecto_id, estado);

alter table public.campo_fichas enable row level security;

comment on table public.campo_fichas is
  'Fichas de verificación llenadas en la app por el supervisor de campo (Visitas de campo), con su estado de revisión: borrador, enviada, observada o aprobada. Al aprobarla, pasa al inventario verificado del local.';
