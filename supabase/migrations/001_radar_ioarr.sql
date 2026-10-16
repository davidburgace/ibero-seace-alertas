-- ============================================================================
-- Radar IOARR — migración inicial (Fase 1)
-- Ejecutar en Supabase → SQL Editor (es idempotente: se puede correr dos veces).
--
-- Acceso: todas las tablas tienen RLS ACTIVADO y SIN políticas públicas.
-- Solo el backend (service key) lee/escribe; el navegador pasa siempre por
-- /api/ioarr/*, que valida el token de Supabase Auth y el rol del usuario.
-- ============================================================================

create extension if not exists pgcrypto;

-- ─── Perfiles y roles ───────────────────────────────────────────────────────
-- proveedor  = usuario actual de Radar Ibero (ve todos los módulos)
-- financista = rol limitado (solo ve Radar IOARR)
create table if not exists public.perfiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  rol        text not null default 'financista' check (rol in ('proveedor', 'financista')),
  creado_en  timestamptz not null default now()
);

-- Cada usuario nuevo de Supabase Auth recibe un perfil con el rol MÁS limitado.
-- Para dar acceso completo: update perfiles set rol = 'proveedor' where email = '...';
create or replace function public.ioarr_crear_perfil()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists ioarr_on_auth_user_created on auth.users;
create trigger ioarr_on_auth_user_created
  after insert on auth.users
  for each row execute function public.ioarr_crear_perfil();

-- Usuarios que ya existían antes de esta migración
insert into public.perfiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- ─── Proyectos IOARR ────────────────────────────────────────────────────────
create table if not exists public.ioarr_proyectos (
  id               uuid primary key default gen_random_uuid(),
  cui              text not null unique,
  nombre           text not null,
  entidad          text,
  entidad_tipo     text check (entidad_tipo in ('GORE', 'GL', 'GN')),
  region           text,          -- se guarda en MAYÚSCULAS sin tildes (ej. LAMBAYEQUE)
  provincia        text,
  distrito         text,
  funcion          text,
  tipo_inversion   text default 'IOARR',
  monto_inversion  numeric(16, 2),
  -- Estado "oficial" del ciclo OxI (según la fuente o actualización manual)
  estado           text not null default 'viable' check (estado in (
                     'viable', 'priorizada_oxi', 'convenio', 'en_proceso_seleccion',
                     'en_ejecucion', 'bienes_entregados', 'ciprl_emitido', 'cerrada', 'descartada')),
  -- Etapa interna del financista (kanban); independiente del estado oficial
  etapa_financista text not null default 'detectada' check (etapa_financista in (
                     'detectada', 'evaluando', 'convenio', 'financiando', 'ciprl_emitido')),
  fuente           text,          -- invierte_pe | proinversion | manual | ...
  url_fuente       text,
  es_mobiliario    boolean not null default false,
  notas            text,
  creado_en        timestamptz not null default now(),
  actualizado_en   timestamptz not null default now()
);

create index if not exists ioarr_proyectos_region_idx on public.ioarr_proyectos (region);
create index if not exists ioarr_proyectos_estado_idx on public.ioarr_proyectos (estado);
create index if not exists ioarr_proyectos_creado_idx on public.ioarr_proyectos (creado_en);

create or replace function public.ioarr_tocar_actualizado()
returns trigger language plpgsql as $$
begin
  new.actualizado_en := now();
  return new;
end $$;

drop trigger if exists ioarr_proyectos_actualizado on public.ioarr_proyectos;
create trigger ioarr_proyectos_actualizado
  before update on public.ioarr_proyectos
  for each row execute function public.ioarr_tocar_actualizado();

-- ─── Línea de tiempo ────────────────────────────────────────────────────────
create table if not exists public.ioarr_eventos (
  id           uuid primary key default gen_random_uuid(),
  proyecto_id  uuid not null references public.ioarr_proyectos(id) on delete cascade,
  fecha        timestamptz not null default now(),
  tipo         text not null check (tipo in ('cambio_estado', 'hito', 'nota', 'alerta')),
  detalle      text
);
create index if not exists ioarr_eventos_proyecto_idx on public.ioarr_eventos (proyecto_id, fecha desc);
create index if not exists ioarr_eventos_fecha_idx on public.ioarr_eventos (fecha);

-- ─── Evaluaciones de rentabilidad (cada cálculo guardado) ──────────────────
-- IMPORTANTE: el reglamento (D.S. 038-2026-EF) NO reconoce intereses de
-- financiamiento; solo costos de gestión. tasa_costo_capital_anual es un
-- criterio INTERNO del financista, no un monto reconocido por el Estado.
create table if not exists public.ioarr_evaluaciones (
  id                               uuid primary key default gen_random_uuid(),
  proyecto_id                      uuid not null references public.ioarr_proyectos(id) on delete cascade,
  monto_inversion                  numeric(16, 2) not null,
  costos_gestion                   numeric(16, 2) not null default 0,
  costo_supervision                numeric(16, 2) not null default 0,
  otros_costos                     numeric(16, 2) not null default 0,
  descuento_negociacion_ciprl_pct  numeric(6, 3)  not null default 0,  -- en %, ej. 3.5
  meses_hasta_cobro                numeric(6, 2)  not null default 0,
  tasa_costo_capital_anual         numeric(6, 3)  not null default 0,  -- en %, ej. 12
  -- Resultados (calculados en el backend con src/ioarr/calculadora.js)
  desembolso_total                 numeric(16, 2),
  ciprl_reconocido                 numeric(16, 2),
  ingreso_ciprl                    numeric(16, 2),
  costo_capital                    numeric(16, 2),
  resultado_neto                   numeric(16, 2),
  rentabilidad_pct                 numeric(9, 3),
  creado_por                       uuid references auth.users(id) on delete set null,
  creado_en                        timestamptz not null default now()
);
create index if not exists ioarr_evaluaciones_proyecto_idx on public.ioarr_evaluaciones (proyecto_id, creado_en desc);

-- ─── Contrapartes (no existía una tabla de empresas con RUC en el repo) ────
create table if not exists public.ioarr_contrapartes (
  id            uuid primary key default gen_random_uuid(),
  ruc           text unique,
  nombre        text not null,
  tipo          text not null check (tipo in ('entidad', 'ejecutora', 'supervisora')),
  riesgo_notas  text,
  historial     text,
  creado_en     timestamptz not null default now()
);

-- Un proyecto puede tener varias contrapartes (entidad, ejecutora, supervisora)
create table if not exists public.ioarr_proyecto_contrapartes (
  proyecto_id     uuid not null references public.ioarr_proyectos(id) on delete cascade,
  contraparte_id  uuid not null references public.ioarr_contrapartes(id) on delete cascade,
  primary key (proyecto_id, contraparte_id)
);

-- ─── Configuración de alertas por usuario ──────────────────────────────────
create table if not exists public.ioarr_alertas_config (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references auth.users(id) on delete cascade,
  email            text not null,
  regiones         text[] not null default array['LAMBAYEQUE'],
  solo_mobiliario  boolean not null default false,
  activo           boolean not null default true,
  ultimo_envio     timestamptz
);

-- ─── RLS: activado, sin políticas → solo service key (backend) ─────────────
alter table public.perfiles                    enable row level security;
alter table public.ioarr_proyectos             enable row level security;
alter table public.ioarr_eventos               enable row level security;
alter table public.ioarr_evaluaciones          enable row level security;
alter table public.ioarr_contrapartes          enable row level security;
alter table public.ioarr_proyecto_contrapartes enable row level security;
alter table public.ioarr_alertas_config        enable row level security;
