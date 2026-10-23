-- ============================================================================
-- 025_campo_fichas_firmas.sql — Firmas en pantalla de la ficha llenada en la app
--
-- En la sección E de la ficha (Visitas de campo), cada cargo firma con el dedo o
-- un lápiz en el celular o la tablet: director(a) de la IE, verificador de la UGEL
-- y representante de la entidad registradora (si corresponde). La firma es una
-- imagen PNG en el bucket privado ioarr-expediente (campo/<proyecto>/<local>/).
-- Va en el PDF de la ficha llena, que al aprobarla pasa al sustento del local
-- como acta de verificación.
--
-- Una fila por ficha y cargo: firmar de nuevo la reemplaza.
-- Solo la usa el servidor (clave secreta): RLS activado y sin políticas.
-- Ejecutar en Supabase → SQL Editor después de la 024. Es idempotente.
-- ============================================================================

create table if not exists public.campo_fichas_firmas (
  proyecto_id       uuid not null,
  codigo_local      text not null,
  cargo             text not null check (cargo in ('director', 'ugel', 'registradora')),
  ruta              text not null unique,
  firmada_en        timestamptz not null default now(),
  subido_por        uuid references auth.users(id) on delete set null,
  subido_por_email  text,
  primary key (proyecto_id, codigo_local, cargo),
  foreign key (proyecto_id, codigo_local)
    references public.campo_fichas (proyecto_id, codigo_local) on delete cascade
);

alter table public.campo_fichas_firmas enable row level security;

comment on table public.campo_fichas_firmas is
  'Firmas en pantalla de la ficha llenada en la app (Visitas de campo), una por cargo. Imagen PNG en el bucket ioarr-expediente, campo/<proyecto>/<local>/.';
