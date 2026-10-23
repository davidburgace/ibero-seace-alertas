-- ============================================================================
-- 027_ioarr_estructura_oferta.sql — Estructura de costos del 07-C y oferta interna
--
-- 1. ioarr_expediente_costos.estructura: parámetros de la estructura referencial
--    de adquisición de bienes (sin utilidad), ver src/selector-ioarr/costos.js:
--    { igv, doc_pct, sup_pct, liquidacion, transporte_pieza, kit, kit_dist, precios }.
--    La columna rubros queda sin uso (la estructura anterior con GG y utilidad).
-- 2. ioarr_expediente_oferta: análisis interno de la oferta (costo propio y margen).
--    USO INTERNO: ningún exportador la lee (07-C, fichas, memoria, Excel, ZIP).
--    Ver src/selector-ioarr/oferta.js.
--
-- El escenario de cantidad (Solo Malo, Malo + Regular, Por capacidad) se guarda en
-- ioarr_selector_proyectos.criterios: no necesita columnas nuevas.
--
-- Ejecutar en Supabase → SQL Editor después de la 026. Es idempotente.
-- ============================================================================

alter table public.ioarr_expediente_costos add column if not exists estructura jsonb not null default '{}'::jsonb;

create table if not exists public.ioarr_expediente_oferta (
  proyecto_id     uuid primary key references public.ioarr_selector_proyectos(id) on delete cascade,
  datos           jsonb not null default '{}'::jsonb,
  actualizado_en  timestamptz not null default now()
);

drop trigger if exists ioarr_expediente_oferta_actualizado on public.ioarr_expediente_oferta;
create trigger ioarr_expediente_oferta_actualizado
  before update on public.ioarr_expediente_oferta
  for each row execute function public.ioarr_tocar_actualizado();

-- RLS: solo el dueño del proyecto, y solo si es proveedor (igual que la 012 a la 015)
alter table public.ioarr_expediente_oferta enable row level security;
drop policy if exists solo_duenio on public.ioarr_expediente_oferta;
create policy solo_duenio on public.ioarr_expediente_oferta for all to authenticated
  using (exists (select 1 from public.ioarr_selector_proyectos p
                 where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_selector_proyectos p
                      where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_expediente_oferta from anon;

notify pgrst, 'reload schema';
