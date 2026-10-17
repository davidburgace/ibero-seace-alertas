-- ============================================================================
-- Radar IOARR — Fuente de financiamiento y modalidad de ejecución
-- Ejecutar después de 007_ioarr_pmi_opmi.sql (idempotente).
--
-- Se leen de la ficha 07-C al subirla y del exporte del Banco de Inversiones
-- (Consulta Avanzada) si trae esas columnas. El cruce las usa:
--   modalidad con «IMPUESTOS»            → va por Obras por Impuestos
--   fuente de recursos públicos o PIM>0  → tiene presupuesto público
-- ============================================================================

alter table public.ioarr_proyectos add column if not exists fuente_financiamiento text;
alter table public.ioarr_proyectos add column if not exists modalidad_ejecucion text;

-- Filas de las cargas del Banco (fuente_financiamiento ya existe desde la 005)
alter table public.ioarr_carga_filas add column if not exists modalidad_ejecucion text;

-- La vista de la 005 expandió f.* al crearse: se recrea para que incluya la columna nueva
drop view if exists public.ioarr_cruce_fuentes;
create view public.ioarr_cruce_fuentes with (security_invoker = true) as
with filas as (
  select f.*, c.fuente, c.fecha_carga, c.nombre_archivo,
         row_number() over (partition by c.fuente, f.cui order by c.fecha_carga desc, c.id desc) as orden
  from public.ioarr_carga_filas f
  join public.ioarr_cargas c on c.id = f.carga_id
),
ultimas as (
  select distinct on (fuente) fuente, id as carga_id
  from public.ioarr_cargas
  where fuente in ('invierte_pe', 'proinversion')
  order by fuente, fecha_carga desc, id desc
)
select x.*,
       (x.carga_id = u.carga_id) as en_ultima_carga,
       (select array_agg(distinct y.entidad) from filas y
         where y.fuente = x.fuente and y.cui = x.cui and y.orden > 1 and y.entidad is not null) as entidades_previas
from filas x
join ultimas u on u.fuente = x.fuente
where x.orden = 1;

-- Lo que ya se leyó de fichas 07-C subidas antes (queda en ioarr_proyectos.ficha_07c)
update public.ioarr_proyectos
   set modalidad_ejecucion = nullif(trim(ficha_07c->>'modalidad_ejecucion'), '')
 where modalidad_ejecucion is null and ficha_07c ? 'modalidad_ejecucion';
update public.ioarr_proyectos
   set fuente_financiamiento = nullif(trim(ficha_07c->>'fuente_financiamiento'), '')
 where fuente_financiamiento is null and ficha_07c ? 'fuente_financiamiento';
