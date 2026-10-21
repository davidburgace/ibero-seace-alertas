-- ============================================================================
-- 014_ioarr_expediente_archivos.sql — Sustento del inventario verificado
--
-- Acta de verificación, fotos, inventario patrimonial y resolución de baja de
-- cada local corregido en campo (ver 013). Los archivos van en un bucket
-- PRIVADO: solo se abren con URL firmada que da el servidor.
--
-- Ejecutar después de la 013. Es idempotente.
-- ============================================================================

-- Bucket privado: PDF y fotos, hasta 15 MB por archivo
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ioarr-expediente', 'ioarr-expediente', false, 15728640,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Un archivo pertenece a la verificación de un local: si se quita la
-- verificación, se borran sus filas (el servidor borra antes los archivos del bucket)
create table if not exists public.ioarr_expediente_archivos (
  id              uuid primary key default gen_random_uuid(),
  proyecto_id     uuid not null,
  cod_local       text not null,
  tipo            text not null check (tipo in ('acta', 'foto', 'inventario_patrimonial', 'baja', 'otro')),
  nombre_archivo  text not null,
  ruta            text not null unique,      -- ruta dentro del bucket ioarr-expediente
  mime            text not null,
  tamano          bigint,
  descripcion     text,
  subido_por      uuid references auth.users(id) on delete set null,
  creado_en       timestamptz not null default now(),
  foreign key (proyecto_id, cod_local)
    references public.ioarr_expediente_inventario (proyecto_id, cod_local) on delete cascade
);
create index if not exists ioarr_expediente_archivos_local_idx
  on public.ioarr_expediente_archivos (proyecto_id, cod_local, creado_en);

-- RLS: solo el dueño del proyecto, y solo si es proveedor (igual que la 012 y la 013)
alter table public.ioarr_expediente_archivos enable row level security;
drop policy if exists solo_duenio on public.ioarr_expediente_archivos;
create policy solo_duenio on public.ioarr_expediente_archivos for all to authenticated
  using (exists (select 1 from public.ioarr_selector_proyectos p
                 where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_selector_proyectos p
                      where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_expediente_archivos from anon;
-- Sin políticas en storage.objects para este bucket: el navegador no lo lee ni
-- escribe directo; todo pasa por el servidor con la clave secreta.
