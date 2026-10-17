-- ============================================================================
-- Radar IOARR — Filtros usados en cada carga
-- Ejecutar después de 005_ioarr_cruce_fuentes.sql (idempotente).
--
-- Una carga del PMI puede importarse solo con Educación y/o solo con IOARR.
-- Se guarda qué filtros se usaron para que el cruce no marque «fuera del PMI»
-- a un proyecto que esa carga nunca pudo contener (p. ej. uno de Salud).
-- Formato: {"solo_educacion": true, "solo_ioarr": false}; {} = sin filtros.
-- ============================================================================

alter table public.ioarr_cargas add column if not exists filtros jsonb not null default '{}'::jsonb;

-- Igual que en la 005, con los filtros de la carga al final
create or replace view public.ioarr_cruce_pmi_entidades with (security_invoker = true) as
select distinct on (upper(trim(p.entidad)))
       upper(trim(p.entidad)) as entidad_clave, p.entidad, p.carga_id, p.fecha_carga, p.periodo, c.filtros
from public.ioarr_pmi p
join public.ioarr_cargas c on c.id = p.carga_id
where p.entidad is not null and trim(p.entidad) <> ''
order by upper(trim(p.entidad)), p.fecha_carga desc, p.carga_id desc;
