-- ============================================================================
-- 024_campo_fichas_fotos.sql — Fotos de la ficha de verificación llenada en la app
--
-- El supervisor toma las fotos del panel fotográfico desde la ficha (Visitas de
-- campo): la fachada, la vista general de cada aula y el detalle de cada mueble
-- en mal estado. El celular las reduce y les pone un sello con el local, el aula,
-- la fecha y las coordenadas. Se guardan en el bucket privado ioarr-expediente
-- (ver 014), en campo/<proyecto>/<local>/, con una miniatura para las listas.
-- Al aprobar la ficha, el servidor las copia al sustento del local
-- (ioarr_expediente_archivos, tipo «foto»), así salen en el expediente y su ZIP.
--
-- id lo genera el celular: si la subida se corta y se reintenta, no se duplica.
-- aula = n.° de aula - 1 (null = el local: fachada u otra); bien = tipo de mueble.
--
-- Solo la usa el servidor (clave secreta): RLS activado y sin políticas.
-- Ejecutar en Supabase → SQL Editor después de la 023. Es idempotente.
-- ============================================================================

create table if not exists public.campo_fichas_fotos (
  id                uuid primary key,
  proyecto_id       uuid not null,
  codigo_local      text not null,
  aula              integer check (aula is null or aula >= 0),
  bien              text check (bien is null or bien in ('mesa', 'silla', 'esc', 'sdoc', 'arm')),
  muestra           text,
  ruta              text not null unique,
  ruta_mini         text,
  mime              text not null,
  tamano            bigint,
  lat               double precision,
  lon               double precision,
  tomada_en         timestamptz,
  subido_por        uuid references auth.users(id) on delete set null,
  subido_por_email  text,
  creado_en         timestamptz not null default now(),
  foreign key (proyecto_id, codigo_local)
    references public.campo_fichas (proyecto_id, codigo_local) on delete cascade
);

create index if not exists campo_fichas_fotos_ficha on public.campo_fichas_fotos (proyecto_id, codigo_local, tomada_en);

alter table public.campo_fichas_fotos enable row level security;

comment on table public.campo_fichas_fotos is
  'Fotos del panel fotográfico de la ficha llenada en la app (Visitas de campo). Archivos en el bucket ioarr-expediente, campo/<proyecto>/<local>/. Al aprobar la ficha se copian al sustento del local.';
