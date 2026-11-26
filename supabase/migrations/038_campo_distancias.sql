-- ============================================================================
-- 038_campo_distancias.sql — Distancias por carretera entre colegios
--
-- En Visitas de campo, el plan del día se arma con los km por carretera entre
-- los colegios del supervisor. Los calcula OpenRouteService (perfil auto, con el
-- mapa de OpenStreetMap) y se guardan aquí para no pedirlos otra vez: un par de
-- colegios se calcula una sola vez, aunque esté en varios proyectos.
--
-- Una fila por par, con el código menor en cod_a. km null = OpenRouteService no
-- encontró ruta (p. ej., el colegio está lejos de cualquier vía del mapa): ese
-- tramo va en línea recta.
--
-- Solo la usa el servidor (/api/campo/*, clave secreta): RLS activado y sin
-- políticas, así nadie la lee ni la cambia con la clave pública del navegador.
--
-- Ejecutar en Supabase → SQL Editor. Es idempotente.
-- ============================================================================

create table if not exists public.campo_distancias (
  cod_a         text not null,
  cod_b         text not null,
  km            real,
  calculado_en  timestamptz not null default now(),
  primary key (cod_a, cod_b),
  check (cod_a < cod_b)
);

create index if not exists campo_distancias_cod_b on public.campo_distancias (cod_b);

alter table public.campo_distancias enable row level security;

comment on table public.campo_distancias is
  'Km por carretera entre dos colegios (OpenRouteService), para el plan de Visitas de campo. Una fila por par (cod_a < cod_b); km null = sin ruta.';
