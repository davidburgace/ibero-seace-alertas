-- ============================================================================
-- 028_ioarr_bases_oxi.sql — Generador de bases de Obras por Impuestos (Selector IOARR)
--
-- 1. ioarr_bases_fichas: la ficha del proceso (los campos del MANIFEST de
--    templates/bases y los controles del generador). Una ficha es de UNA IOARR,
--    es decir, de un solo nivel (I, P, S o E). Un proyecto puede tener varias
--    (por nivel o copias para comparar). Ver src/selector-ioarr/bases.js.
-- 2. ioarr_bases_versiones: cada exportación del .docx, con su número de versión,
--    fecha, usuario, la ficha tal como se exportó y lo que se tomó del cálculo
--    de la app (cantidades y costos). El .docx se vuelve a generar desde aquí;
--    plantillas_hash avisa si las plantillas cambiaron desde esa versión.
--
-- Ejecutar en Supabase → SQL Editor después de la 027. Es idempotente.
-- ============================================================================

create table if not exists public.ioarr_bases_fichas (
  id              uuid primary key default gen_random_uuid(),
  proyecto_id     uuid not null references public.ioarr_selector_proyectos(id) on delete cascade,
  nivel           text not null check (nivel in ('I', 'P', 'S', 'E')),
  nombre          text not null default '',
  datos           jsonb not null default '{}'::jsonb,
  creado_por      uuid references auth.users(id) on delete set null,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index if not exists ioarr_bases_fichas_proyecto_idx on public.ioarr_bases_fichas (proyecto_id);

drop trigger if exists ioarr_bases_fichas_actualizado on public.ioarr_bases_fichas;
create trigger ioarr_bases_fichas_actualizado
  before update on public.ioarr_bases_fichas
  for each row execute function public.ioarr_tocar_actualizado();

create table if not exists public.ioarr_bases_versiones (
  id               uuid primary key default gen_random_uuid(),
  ficha_id         uuid not null references public.ioarr_bases_fichas(id) on delete cascade,
  version          integer not null check (version > 0),
  datos            jsonb not null,                 -- la ficha exportada
  contexto         jsonb not null default '{}'::jsonb,   -- nivel, cantidades y costos del cálculo de la app
  resumen          jsonb not null default '{}'::jsonb,   -- montos y advertencias al exportar
  plantillas_hash  text not null,
  archivo          text not null,
  usuario_id       uuid references auth.users(id) on delete set null,
  usuario_email    text,
  creado_en        timestamptz not null default now(),
  unique (ficha_id, version)
);

-- RLS: solo el dueño del proyecto, y solo si es proveedor (igual que la 012 a la 027).
-- El servidor usa la clave secreta y además filtra por dueño.
alter table public.ioarr_bases_fichas enable row level security;
drop policy if exists solo_duenio on public.ioarr_bases_fichas;
create policy solo_duenio on public.ioarr_bases_fichas for all to authenticated
  using (exists (select 1 from public.ioarr_selector_proyectos p
                 where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_selector_proyectos p
                      where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_bases_fichas from anon;

alter table public.ioarr_bases_versiones enable row level security;
drop policy if exists solo_duenio on public.ioarr_bases_versiones;
create policy solo_duenio on public.ioarr_bases_versiones for all to authenticated
  using (exists (select 1 from public.ioarr_bases_fichas f join public.ioarr_selector_proyectos p on p.id = f.proyecto_id
                 where f.id = ficha_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_bases_fichas f join public.ioarr_selector_proyectos p on p.id = f.proyecto_id
                      where f.id = ficha_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_bases_versiones from anon;

notify pgrst, 'reload schema';
