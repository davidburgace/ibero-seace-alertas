-- ============================================================================
-- 017_ioarr_selector_duplicidad.sql — Otra inversión vigente o reciente por local
--
-- Por proyecto del Selector y local: si el local tiene otra inversión vigente o
-- reciente (riesgo de duplicidad), su código y si se excluye de la propuesta.
-- Sin fila = «Sin verificar». La consulta al Banco de Inversiones es manual.
--
-- La fila se conserva aunque el local se quite de la selección: si se vuelve a
-- marcar, no se pierde lo verificado.
--
-- Ejecutar en Supabase → SQL Editor, después de la 016. Es idempotente.
-- ============================================================================

create table if not exists public.ioarr_selector_duplicidad (
  proyecto_id       uuid not null references public.ioarr_selector_proyectos(id) on delete cascade,
  cod_local         text not null,
  estado            text not null check (estado in ('si', 'no', 'sin_verificar')),
  codigo_inversion  text check (codigo_inversion is null or length(codigo_inversion) <= 30),
  nota              text check (nota is null or length(nota) <= 500),
  excluir           boolean not null default false,
  actualizado_por   uuid references auth.users(id) on delete set null,
  actualizado_en    timestamptz not null default now(),
  primary key (proyecto_id, cod_local),
  -- Solo se excluye un local que tiene otra inversión
  constraint ioarr_selector_duplicidad_excluir check (not excluir or estado = 'si')
);

drop trigger if exists ioarr_selector_duplicidad_actualizado on public.ioarr_selector_duplicidad;
create trigger ioarr_selector_duplicidad_actualizado
  before update on public.ioarr_selector_duplicidad
  for each row execute function public.ioarr_tocar_actualizado();

-- RLS: solo el dueño del proyecto, y solo si es proveedor (igual que la 011)
alter table public.ioarr_selector_duplicidad enable row level security;
drop policy if exists solo_duenio on public.ioarr_selector_duplicidad;
create policy solo_duenio on public.ioarr_selector_duplicidad for all to authenticated
  using (exists (select 1 from public.ioarr_selector_proyectos p
                 where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_selector_proyectos p
                      where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_selector_duplicidad from anon;
