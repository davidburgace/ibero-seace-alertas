-- ============================================================================
-- Radar IOARR — OPMI de cada carga del PMI y limpieza de lo ya guardado
-- Ejecutar después de 006_ioarr_filtros_carga.sql (idempotente).
--
-- El exporte «Cartera de inversiones» del PMI no trae una columna de entidad:
-- la OPMI va en el encabezado del archivo. Ahora se guarda en la carga, y el
-- cruce (src/ioarr/cruce.js) decide con ella qué carga está vigente para cada
-- OPMI y si un proyecto está «fuera del PMI».
-- Las vistas ioarr_cruce_pmi e ioarr_cruce_pmi_entidades ya no las usa el código;
-- se dejan para no romper la versión desplegada hasta que se actualice.
-- ============================================================================

alter table public.ioarr_cargas add column if not exists opmi text;

-- Entidades que trae cada carga del PMI, para archivos que sí tienen columna de entidad
create or replace view public.ioarr_pmi_entidades_carga with (security_invoker = true) as
select carga_id, entidad, count(*)::int as filas
from public.ioarr_pmi
where entidad is not null and trim(entidad) <> ''
group by carga_id, entidad;

-- ─── Datos ya cargados ──────────────────────────────────────────────────────
-- Las dos cargas del 17/10/2026 se guardaron sin OPMI (cada archivo es de una OPMI)
update public.ioarr_cargas set opmi = 'OPMI DEL MINISTERIO DE EDUCACION'
 where id = '828a346f-7eb7-4661-9662-4d4b62b8b42e' and opmi is null;   -- Cartera_261017-111601.xlsx
update public.ioarr_cargas set opmi = 'OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE'
 where id = '4a9b6e0d-6ed4-4af2-b2dc-fa65a4b9cebb' and opmi is null;   -- Cartera_261017-112354.xlsx

-- «Periodo» se llenó con la columna «Monto Año 2026 (S/)»: montos, no periodos
update public.ioarr_pmi set periodo = null
 where periodo ~ '^\d+([.,]\d+)?$' and periodo !~ '^20\d\d$';
update public.ioarr_mapeos set mapeo = jsonb_set(mapeo, '{periodo}', 'null'::jsonb)
 where fuente = 'pmi' and mapeo->>'periodo' ~* 'monto|costo|pim|devengado';

-- CUI como texto limpio (solo dígitos; las ideas IDEA… en mayúsculas).
-- Hoy no cambia nada, pero deja igual lo que se importó con versiones anteriores.
update public.ioarr_pmi p set cui = regexp_replace(regexp_replace(p.cui, '[.,]0+$', ''), '\D', '', 'g')
 where p.cui !~* '^\s*IDEA' and p.cui ~ '\d' and p.cui !~ '^\d+$'
   and not exists (select 1 from public.ioarr_pmi q where q.carga_id = p.carga_id
                    and q.cui = regexp_replace(regexp_replace(p.cui, '[.,]0+$', ''), '\D', '', 'g'));
update public.ioarr_carga_filas f set cui = regexp_replace(regexp_replace(f.cui, '[.,]0+$', ''), '\D', '', 'g')
 where f.cui !~* '^\s*IDEA' and f.cui ~ '\d' and f.cui !~ '^\d+$'
   and not exists (select 1 from public.ioarr_carga_filas g where g.carga_id = f.carga_id
                    and g.cui = regexp_replace(regexp_replace(f.cui, '[.,]0+$', ''), '\D', '', 'g'));
update public.ioarr_proyectos p set cui = regexp_replace(regexp_replace(p.cui, '[.,]0+$', ''), '\D', '', 'g')
 where p.cui !~* '^\s*IDEA' and p.cui ~ '\d' and p.cui !~ '^\d+$'
   and not exists (select 1 from public.ioarr_proyectos q
                    where q.cui = regexp_replace(regexp_replace(p.cui, '[.,]0+$', ''), '\D', '', 'g'));
