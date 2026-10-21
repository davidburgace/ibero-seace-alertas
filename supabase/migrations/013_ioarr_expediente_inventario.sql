-- ============================================================================
-- 013_ioarr_expediente_inventario.sql — Inventario verificado en campo
--
-- Corrige, para el expediente de un proyecto, el mobiliario que el Censo
-- Educativo reporta en un local (por ejemplo, el censo no trae mesas pero en
-- la visita se comprobó que existen y están en mal estado).
-- Solo afecta la estructura de costos y su Excel; el Selector sigue con el censo.
--
-- Ejecutar después de la 012. Es idempotente.
-- ============================================================================

-- bienes: { "mesa": { "b": 0, "r": 0, "m": 569 }, ... }  solo los tipos corregidos
-- censo:  copia de lo que decía el censo al guardar, para el sustento
create table if not exists public.ioarr_expediente_inventario (
  proyecto_id     uuid not null references public.ioarr_selector_proyectos(id) on delete cascade,
  cod_local       text not null,
  bienes          jsonb not null default '{}'::jsonb,
  censo           jsonb,
  fecha_visita    date not null,
  responsable     text,
  observacion     text not null check (length(trim(observacion)) between 1 and 1000),
  creado_por      uuid references auth.users(id) on delete set null,
  actualizado_en  timestamptz not null default now(),
  primary key (proyecto_id, cod_local)
);

drop trigger if exists ioarr_expediente_inventario_actualizado on public.ioarr_expediente_inventario;
create trigger ioarr_expediente_inventario_actualizado
  before update on public.ioarr_expediente_inventario
  for each row execute function public.ioarr_tocar_actualizado();

-- RLS: solo el dueño del proyecto, y solo si es proveedor (igual que la 012)
alter table public.ioarr_expediente_inventario enable row level security;
drop policy if exists solo_duenio on public.ioarr_expediente_inventario;
create policy solo_duenio on public.ioarr_expediente_inventario for all to authenticated
  using (exists (select 1 from public.ioarr_selector_proyectos p
                 where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_selector_proyectos p
                      where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_expediente_inventario from anon;
