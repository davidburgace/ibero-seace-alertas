-- ============================================================================
-- Radar IOARR — Cruce de fuentes (Banco de Inversiones × Proinversión × PMI)
-- Ejecutar después de 004_ioarr_documentos.sql (idempotente).
--
-- Cada archivo importado queda como una «carga» con su fecha. Se guardan las
-- filas tal como vienen (una por CUI). La situación de cada proyecto NO se
-- guarda: la calcula src/ioarr/cruce.js leyendo las vistas de abajo.
-- ============================================================================

-- ─── Cargas (un archivo importado = una carga) ─────────────────────────────
create table if not exists public.ioarr_cargas (
  id              uuid primary key default gen_random_uuid(),
  fuente          text not null check (fuente in ('invierte_pe', 'proinversion', 'pmi')),
  nombre_archivo  text,
  hoja            text,
  filas           int not null default 0,          -- CUI distintos guardados
  filas_repetidas int not null default 0,          -- filas con un CUI que ya venía antes en el archivo
  fecha_carga     timestamptz not null default now(),
  cargado_por     uuid references auth.users(id) on delete set null
);
create index if not exists ioarr_cargas_fuente_idx on public.ioarr_cargas (fuente, fecha_carga desc);

-- Filas del Banco de Inversiones y de Proinversión, tal como vinieron en la carga
create table if not exists public.ioarr_carga_filas (
  carga_id               uuid not null references public.ioarr_cargas(id) on delete cascade,
  cui                    text not null,
  es_idea                boolean not null default false,
  nombre                 text,
  entidad                text,
  entidad_tipo           text,          -- GORE / GL / GN
  region                 text,
  provincia              text,
  distrito               text,
  funcion                text,
  monto_inversion        numeric(16, 2),
  estado_inversion       text,          -- Banco: «Estado de la inversión» (ACTIVO, DESACTIVADO…)
  fuente_financiamiento  text,          -- Banco: fuente o rubro asignado
  pim                    numeric(16, 2),
  devengado              numeric(16, 2),
  fase_oxi               text,          -- Proinversión: «Fase OxI» (Priorizado / Por Priorizar)
  nivel_estudio          text,          -- Proinversión: «Último nivel de estudio»
  repeticiones           int not null default 1,   -- veces que el CUI aparecía en el archivo
  primary key (carga_id, cui)
);
create index if not exists ioarr_carga_filas_cui_idx on public.ioarr_carga_filas (cui);

-- ─── Cartera del PMI ───────────────────────────────────────────────────────
create table if not exists public.ioarr_pmi (
  carga_id     uuid not null references public.ioarr_cargas(id) on delete cascade,
  cui          text not null,
  entidad      text,
  periodo      text,                    -- año o periodo del PMI (ej. «2027-2029»)
  fecha_carga  timestamptz not null default now(),
  primary key (carga_id, cui)
);
create index if not exists ioarr_pmi_cui_idx on public.ioarr_pmi (cui);

-- Marca manual cuando no hay archivo del PMI (o para dejar constancia)
create table if not exists public.ioarr_pmi_manual (
  cui           text primary key,
  en_pmi        text not null default 'sin_verificar' check (en_pmi in ('si', 'no', 'sin_verificar')),
  revisado_en   timestamptz not null default now(),
  nota          text,
  revisado_por  uuid references auth.users(id) on delete set null
);

-- ─── Vistas del cruce (security_invoker: respetan el RLS de las tablas) ────
-- Última fila de cada CUI por fuente (Banco / Proinversión), con su carga,
-- si viene de la última carga de esa fuente y las entidades de cargas anteriores.
create or replace view public.ioarr_cruce_fuentes with (security_invoker = true) as
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

-- PMI vigente por entidad: para cada entidad, su carga de PMI más reciente.
-- Un CUI está en el PMI si figura en esa carga; si la entidad aparece en el
-- PMI pero el CUI no, está fuera del PMI.
create or replace view public.ioarr_cruce_pmi_entidades with (security_invoker = true) as
select distinct on (upper(trim(p.entidad)))
       upper(trim(p.entidad)) as entidad_clave, p.entidad, p.carga_id, p.fecha_carga, p.periodo
from public.ioarr_pmi p
where p.entidad is not null and trim(p.entidad) <> ''
order by upper(trim(p.entidad)), p.fecha_carga desc, p.carga_id desc;

-- Filas sin entidad: cuentan solo si vienen de la última carga del PMI
create or replace view public.ioarr_cruce_pmi with (security_invoker = true) as
select p.cui, p.entidad, p.periodo, p.fecha_carga, p.carga_id
from public.ioarr_pmi p
left join public.ioarr_cruce_pmi_entidades e
  on e.carga_id = p.carga_id and e.entidad_clave = upper(trim(p.entidad))
where e.carga_id is not null
   or ((p.entidad is null or trim(p.entidad) = '')
       and p.carga_id = (select id from public.ioarr_cargas where fuente = 'pmi' order by fecha_carga desc, id desc limit 1));

alter table public.ioarr_cargas      enable row level security;
alter table public.ioarr_carga_filas enable row level security;
alter table public.ioarr_pmi         enable row level security;
alter table public.ioarr_pmi_manual  enable row level security;
