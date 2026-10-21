-- ============================================================================
-- 015_ioarr_expediente_documentos.sql — Etapa 2 del expediente: documentos
--
-- Datos que carga el usuario para el borrador del Formato 07-C y la memoria
-- descriptiva (UF, UEI, plazo, mantenimiento, antigüedad…). Lo demás sale del
-- proyecto, los costos y el inventario. Ver src/selector-ioarr/documentos.js.
--
-- Ejecutar después de la 014. Es idempotente.
-- ============================================================================

create table if not exists public.ioarr_expediente_documentos (
  proyecto_id     uuid primary key references public.ioarr_selector_proyectos(id) on delete cascade,
  datos           jsonb not null default '{}'::jsonb,
  actualizado_en  timestamptz not null default now()
);

drop trigger if exists ioarr_expediente_documentos_actualizado on public.ioarr_expediente_documentos;
create trigger ioarr_expediente_documentos_actualizado
  before update on public.ioarr_expediente_documentos
  for each row execute function public.ioarr_tocar_actualizado();

-- RLS: solo el dueño del proyecto, y solo si es proveedor (igual que la 012 a la 014)
alter table public.ioarr_expediente_documentos enable row level security;
drop policy if exists solo_duenio on public.ioarr_expediente_documentos;
create policy solo_duenio on public.ioarr_expediente_documentos for all to authenticated
  using (exists (select 1 from public.ioarr_selector_proyectos p
                 where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_selector_proyectos p
                      where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_expediente_documentos from anon;
