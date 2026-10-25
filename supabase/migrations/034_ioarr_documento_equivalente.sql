-- ============================================================================
-- 034_ioarr_documento_equivalente.sql — Borrador del documento equivalente (Selector IOARR)
--
-- 1. ioarr_de_fichas: la ficha del documento equivalente de UNA IOARR (un nivel):
--    campos del MANIFEST de templates/documento_equivalente, secciones elegidas,
--    de qué bases proviene, legajo de cotizaciones (los PDF van al bucket privado
--    ioarr-expediente, ruta de/<ficha>/<cotización>/…) y montos.
--    Ver src/selector-ioarr/documento-equivalente.js.
-- 2. ioarr_de_versiones: cada exportación del .docx (versión, fecha, usuario, la
--    ficha y el contexto de la app tal como se exportaron).
--
-- Ejecutar en Supabase → SQL Editor después de la 033. Es idempotente.
-- ============================================================================

create table if not exists public.ioarr_de_fichas (
  id              uuid primary key default gen_random_uuid(),
  proyecto_id     uuid not null references public.ioarr_selector_proyectos(id) on delete cascade,
  nivel           text not null check (nivel in ('I', 'P', 'S', 'E')),
  nombre          text not null default '',
  datos           jsonb not null default '{}'::jsonb,
  creado_por      uuid references auth.users(id) on delete set null,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index if not exists ioarr_de_fichas_proyecto_idx on public.ioarr_de_fichas (proyecto_id);

drop trigger if exists ioarr_de_fichas_actualizado on public.ioarr_de_fichas;
create trigger ioarr_de_fichas_actualizado
  before update on public.ioarr_de_fichas
  for each row execute function public.ioarr_tocar_actualizado();

create table if not exists public.ioarr_de_versiones (
  id               uuid primary key default gen_random_uuid(),
  ficha_id         uuid not null references public.ioarr_de_fichas(id) on delete cascade,
  version          integer not null check (version > 0),
  datos            jsonb not null,
  contexto         jsonb not null default '{}'::jsonb,
  resumen          jsonb not null default '{}'::jsonb,
  plantillas_hash  text not null,
  archivo          text not null,
  usuario_id       uuid references auth.users(id) on delete set null,
  usuario_email    text,
  creado_en        timestamptz not null default now(),
  unique (ficha_id, version)
);

-- RLS: solo el dueño del proyecto, y solo si es proveedor (igual que la 028).
alter table public.ioarr_de_fichas enable row level security;
drop policy if exists solo_duenio on public.ioarr_de_fichas;
create policy solo_duenio on public.ioarr_de_fichas for all to authenticated
  using (exists (select 1 from public.ioarr_selector_proyectos p
                 where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_selector_proyectos p
                      where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_de_fichas from anon;

alter table public.ioarr_de_versiones enable row level security;
drop policy if exists solo_duenio on public.ioarr_de_versiones;
create policy solo_duenio on public.ioarr_de_versiones for all to authenticated
  using (exists (select 1 from public.ioarr_de_fichas f join public.ioarr_selector_proyectos p on p.id = f.proyecto_id
                 where f.id = ficha_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_de_fichas f join public.ioarr_selector_proyectos p on p.id = f.proyecto_id
                      where f.id = ficha_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_de_versiones from anon;

notify pgrst, 'reload schema';
