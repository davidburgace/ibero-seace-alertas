-- ============================================================================
-- 022_campo_asignaciones.sql — Colegios de un proyecto asignados a cada supervisor
--
-- En Visitas de campo, el proveedor reparte los colegios de un proyecto del
-- Selector entre sus supervisores de campo (por zonas, con la cantidad que elija
-- para cada uno, y después a mano). Una fila por proyecto y local: un colegio
-- tiene un solo supervisor dentro de un proyecto, así los repartos no se cruzan.
-- Sin fila = sin asignar.
--
-- Solo la usa el servidor (/api/campo/*, clave secreta): RLS activado y sin
-- políticas, así nadie la lee ni la cambia con la clave pública del navegador.
--
-- Ejecutar en Supabase → SQL Editor después de la 021. Es idempotente.
-- ============================================================================

create table if not exists public.campo_asignaciones (
  proyecto_id     uuid not null references public.ioarr_selector_proyectos(id) on delete cascade,
  codigo_local    text not null,
  supervisor_id   uuid not null references auth.users(id) on delete cascade,
  asignado_por    uuid references auth.users(id) on delete set null,
  actualizado_en  timestamptz not null default now(),
  primary key (proyecto_id, codigo_local)
);

create index if not exists campo_asignaciones_supervisor on public.campo_asignaciones (supervisor_id);

alter table public.campo_asignaciones enable row level security;

comment on table public.campo_asignaciones is
  'Supervisor de campo asignado a cada colegio de un proyecto del Selector (Visitas de campo). Una fila por proyecto y código de local; sin fila = sin asignar.';
