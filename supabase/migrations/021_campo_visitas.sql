-- ============================================================================
-- 021_campo_visitas.sql — Colegios visitados (Visitas de campo)
--
-- El supervisor de campo (y el proveedor) marca en /campo.html los colegios que
-- ya visitó. Una fila por local (código de local del padrón): la visita es del
-- colegio, no de un proyecto, así que la ven todos los que usan Visitas de campo.
-- Desmarcar borra la fila.
--
-- Solo la usa el servidor (/api/campo/visitas, clave secreta): RLS activado y sin
-- políticas, así nadie la lee ni la cambia con la clave pública del navegador.
--
-- Ejecutar en Supabase → SQL Editor después de la 020. Es idempotente.
-- ============================================================================

create table if not exists public.campo_visitas (
  codigo_local        text primary key,
  fecha               date not null default current_date,
  visitado_por        uuid references auth.users(id) on delete set null,
  visitado_por_email  text,
  actualizado_en      timestamptz not null default now()
);

alter table public.campo_visitas enable row level security;

comment on table public.campo_visitas is
  'Colegios ya visitados en campo, marcados en Visitas de campo (/campo.html). Una fila por código de local; desmarcar la borra.';
