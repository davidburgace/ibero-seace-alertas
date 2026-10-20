-- ============================================================================
-- Selector IOARR — proyectos de selección de locales escolares
-- Ejecutar en Supabase → SQL Editor, después de 010 (idempotente).
--
-- Cada usuario guarda sus proyectos (región, criterios de cálculo y locales
-- marcados). Opcionalmente, un proyecto se vincula a un registro de Radar IOARR.
--
-- Acceso: el navegador pasa por /api/selector-ioarr/* (servidor con clave
-- secreta, que filtra por usuario). Igual se deja RLS con políticas de dueño:
-- con la clave pública, un usuario proveedor solo ve y cambia lo suyo.
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.ioarr_selector_proyectos (
  id                 uuid primary key default gen_random_uuid(),
  usuario_id         uuid not null references auth.users(id) on delete cascade,
  nombre             text not null check (length(trim(nombre)) between 1 and 200),
  region             text not null,                 -- nombre de la región, ej. «Moquegua»
  anio_datos         int  not null default 2025,    -- año del censo de los datos usados
  criterios          jsonb not null default '{}'::jsonb,
  ioarr_proyecto_id  uuid references public.ioarr_proyectos(id) on delete set null,
  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now()
);
create index if not exists ioarr_selector_proyectos_usuario_idx
  on public.ioarr_selector_proyectos (usuario_id, actualizado_en desc);

create table if not exists public.ioarr_selector_locales (
  proyecto_id   uuid not null references public.ioarr_selector_proyectos(id) on delete cascade,
  codigo_local  text not null,
  agregado_en   timestamptz not null default now(),
  primary key (proyecto_id, codigo_local)
);

-- Reusa ioarr_tocar_actualizado() de 001_radar_ioarr.sql
drop trigger if exists ioarr_selector_proyectos_actualizado on public.ioarr_selector_proyectos;
create trigger ioarr_selector_proyectos_actualizado
  before update on public.ioarr_selector_proyectos
  for each row execute function public.ioarr_tocar_actualizado();

-- ─── RLS: solo el dueño, y solo si es proveedor (es_proveedor() viene de 010) ─
alter table public.ioarr_selector_proyectos enable row level security;
alter table public.ioarr_selector_locales  enable row level security;

drop policy if exists solo_duenio on public.ioarr_selector_proyectos;
create policy solo_duenio on public.ioarr_selector_proyectos for all to authenticated
  using (usuario_id = auth.uid() and public.es_proveedor())
  with check (usuario_id = auth.uid() and public.es_proveedor());

drop policy if exists solo_duenio on public.ioarr_selector_locales;
create policy solo_duenio on public.ioarr_selector_locales for all to authenticated
  using (exists (select 1 from public.ioarr_selector_proyectos p
                 where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_selector_proyectos p
                      where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()));

revoke all on public.ioarr_selector_proyectos from anon;
revoke all on public.ioarr_selector_locales  from anon;
