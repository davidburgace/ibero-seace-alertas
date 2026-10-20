-- ============================================================================
-- Expediente IOARR — Etapa 1: costos
-- Ejecutar en Supabase → SQL Editor, después de 011 (idempotente).
--
-- Compartido entre los usuarios proveedores (catálogo):
--   ioarr_precios_catalogo   precios unitarios por tipo de bien (uno vigente por tipo)
--   ioarr_uit                valor de la UIT por año (lo carga el usuario)
--   ioarr_factores_zona      % adicional de flete e instalación por provincia, distrito o área rural
-- Por proyecto del Selector IOARR (solo el dueño):
--   ioarr_expediente_costos  rubros (transporte, GG, utilidad, IGV…) y año de la UIT
--   ioarr_expediente_precios precio unitario usado por tipo de bien (copia del catálogo)
--
-- Acceso: el navegador pasa por /api/selector-ioarr/* (servidor con clave
-- secreta). Igual se deja RLS: con la clave pública, el catálogo solo lo ven y
-- cambian los proveedores, y los costos de un proyecto solo su dueño.
-- ============================================================================

create extension if not exists pgcrypto;

-- Tipos de bien: los mismos 5 del cálculo (src/selector-ioarr/calculo.js, ITEMS)
-- mesa = mesa del estudiante (puestos) · silla = silla del estudiante
-- esc = escritorio docente · sdoc = silla docente · arm = armario o estante

-- ─── Catálogo de precios unitarios ──────────────────────────────────────────
create table if not exists public.ioarr_precios_catalogo (
  id              uuid primary key default gen_random_uuid(),
  tipo_bien       text not null check (tipo_bien in ('mesa', 'silla', 'esc', 'sdoc', 'arm')),
  descripcion     text not null check (length(trim(descripcion)) between 1 and 300),
  precio          numeric(14, 2) not null check (precio >= 0),   -- precio unitario SIN IGV
  moneda          text not null default 'PEN' check (moneda = 'PEN'),
  unidad          text not null default 'unidad',
  fecha           date not null,
  fuente          text not null check (fuente in ('cotizacion', 'seace', 'historico')),
  observacion     text,
  vigente         boolean not null default false,
  creado_por      uuid references auth.users(id) on delete set null,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index if not exists ioarr_precios_catalogo_tipo_idx on public.ioarr_precios_catalogo (tipo_bien, fecha desc);
-- Un solo precio vigente por tipo de bien
create unique index if not exists ioarr_precios_catalogo_vigente_uq
  on public.ioarr_precios_catalogo (tipo_bien) where vigente;

drop trigger if exists ioarr_precios_catalogo_actualizado on public.ioarr_precios_catalogo;
create trigger ioarr_precios_catalogo_actualizado
  before update on public.ioarr_precios_catalogo
  for each row execute function public.ioarr_tocar_actualizado();

-- ─── UIT por año ────────────────────────────────────────────────────────────
create table if not exists public.ioarr_uit (
  anio            int primary key check (anio between 2000 and 2100),
  valor           numeric(12, 2) not null check (valor > 0),
  fuente          text,                -- ej. el decreto supremo que la fija
  actualizado_en  timestamptz not null default now()
);

drop trigger if exists ioarr_uit_actualizado on public.ioarr_uit;
create trigger ioarr_uit_actualizado
  before update on public.ioarr_uit
  for each row execute function public.ioarr_tocar_actualizado();

-- ─── Factores por zona ──────────────────────────────────────────────────────
-- ambito = provincia (codigo = ubigeo de 4 dígitos), distrito (6 dígitos) o
-- rural (codigo = ubigeo del departamento, 2 dígitos). A cada local se le aplica
-- el factor de su distrito o, si no hay, el de su provincia; si el local es
-- rural se suma además el factor rural de su departamento.
create table if not exists public.ioarr_factores_zona (
  id               uuid primary key default gen_random_uuid(),
  ambito           text not null check (ambito in ('provincia', 'distrito', 'rural')),
  codigo           text not null check (codigo ~ '^\d{2}(\d{2}(\d{2})?)?$'),
  nombre           text,
  pct_flete        numeric(7, 3) not null default 0 check (pct_flete >= 0 and pct_flete <= 500),
  pct_instalacion  numeric(7, 3) not null default 0 check (pct_instalacion >= 0 and pct_instalacion <= 500),
  observacion      text,
  actualizado_en   timestamptz not null default now(),
  unique (ambito, codigo),
  check ((ambito = 'provincia' and length(codigo) = 4) or (ambito = 'distrito' and length(codigo) = 6) or (ambito = 'rural' and length(codigo) = 2))
);

drop trigger if exists ioarr_factores_zona_actualizado on public.ioarr_factores_zona;
create trigger ioarr_factores_zona_actualizado
  before update on public.ioarr_factores_zona
  for each row execute function public.ioarr_tocar_actualizado();

-- ─── Costos por proyecto ────────────────────────────────────────────────────
-- rubros: [{ clave, modo: 'pct' | 'monto', valor, base }] (ver src/selector-ioarr/costos.js)
create table if not exists public.ioarr_expediente_costos (
  proyecto_id     uuid primary key references public.ioarr_selector_proyectos(id) on delete cascade,
  rubros          jsonb not null default '[]'::jsonb,
  anio_uit        int,
  actualizado_en  timestamptz not null default now()
);

drop trigger if exists ioarr_expediente_costos_actualizado on public.ioarr_expediente_costos;
create trigger ioarr_expediente_costos_actualizado
  before update on public.ioarr_expediente_costos
  for each row execute function public.ioarr_tocar_actualizado();

-- Precio fijado en el proyecto: copia del catálogo para que un cambio en el
-- catálogo no altere el proyecto sin aviso
create table if not exists public.ioarr_expediente_precios (
  proyecto_id      uuid not null references public.ioarr_selector_proyectos(id) on delete cascade,
  tipo_bien        text not null check (tipo_bien in ('mesa', 'silla', 'esc', 'sdoc', 'arm')),
  precio_id        uuid references public.ioarr_precios_catalogo(id) on delete set null,
  precio_unitario  numeric(14, 2) not null check (precio_unitario >= 0),
  descripcion      text,
  fuente           text,
  fecha            date,
  actualizado_en   timestamptz not null default now(),
  primary key (proyecto_id, tipo_bien)
);

-- ─── RLS ────────────────────────────────────────────────────────────────────
alter table public.ioarr_precios_catalogo   enable row level security;
alter table public.ioarr_uit                enable row level security;
alter table public.ioarr_factores_zona      enable row level security;
alter table public.ioarr_expediente_costos  enable row level security;
alter table public.ioarr_expediente_precios enable row level security;

-- Catálogo compartido: cualquier proveedor (es_proveedor() viene de 010)
do $$
declare t text;
begin
  foreach t in array array['ioarr_precios_catalogo', 'ioarr_uit', 'ioarr_factores_zona'] loop
    execute format('drop policy if exists solo_proveedores on public.%I', t);
    execute format(
      'create policy solo_proveedores on public.%I for all to authenticated
         using (public.es_proveedor()) with check (public.es_proveedor())', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Costos del proyecto: solo el dueño del proyecto, y solo si es proveedor
do $$
declare t text;
begin
  foreach t in array array['ioarr_expediente_costos', 'ioarr_expediente_precios'] loop
    execute format('drop policy if exists solo_duenio on public.%I', t);
    execute format(
      'create policy solo_duenio on public.%I for all to authenticated
         using (exists (select 1 from public.ioarr_selector_proyectos p
                        where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
         with check (exists (select 1 from public.ioarr_selector_proyectos p
                             where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
