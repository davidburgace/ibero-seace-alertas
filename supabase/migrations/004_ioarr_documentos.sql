-- ============================================================================
-- Radar IOARR — documentos del Banco de Inversiones y precios de referencia
-- Ejecutar después de 003_ioarr_importacion_proinversion.sql (idempotente).
-- ============================================================================

-- Bucket PRIVADO: los PDF solo se abren con URL firmada (10 min) desde el backend
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ioarr-docs', 'ioarr-docs', false, 41943040, array['application/pdf'])
on conflict (id) do update set public = false;

-- PDF subidos a mano en la ficha del proyecto
create table if not exists public.ioarr_documentos (
  id              uuid primary key default gen_random_uuid(),
  proyecto_id     uuid not null references public.ioarr_proyectos(id) on delete cascade,
  tipo            text not null check (tipo in ('ficha_07c', 'estructura_costos', 'informe_sustento', 'otro')),
  nombre_archivo  text not null,
  ruta            text not null,          -- ruta dentro del bucket ioarr-docs
  tamano          bigint,
  paginas         int,
  campos          jsonb,                  -- lo leído del PDF (ficha 07-C o resumen de costos)
  avisos          text[],
  subido_por      uuid references auth.users(id) on delete set null,
  creado_en       timestamptz not null default now()
);
create index if not exists ioarr_documentos_proyecto_idx on public.ioarr_documentos (proyecto_id, creado_en desc);

-- Últimos datos leídos de la ficha 07-C (se muestran en la ficha del proyecto)
alter table public.ioarr_proyectos
  add column if not exists ficha_07c jsonb;

-- Precios únicos por código de bien, tomados de la estructura de costos de cada CUI.
-- d = (a + b + c) × 1.15; «cuadra» = false si la fila del PDF no cumple la fórmula.
create table if not exists public.ioarr_precios_referencia (
  id              uuid primary key default gen_random_uuid(),
  cui_origen      text not null,
  codigo_bien     text not null,
  descripcion     text,
  a               numeric(16, 2),         -- costo de adquisición
  b               numeric(16, 2),         -- embalaje
  c               numeric(16, 2),         -- entrega
  d               numeric(16, 2),         -- costo unitario final
  cantidad        numeric(16, 2),         -- suma de las filas del mismo código
  cuadra          boolean not null default true,
  anio_ficha      int,                    -- año del documento (fecha de la ficha o del PDF de costos)
  fuente          text,                   -- nombre del PDF de origen
  documento_id    uuid references public.ioarr_documentos(id) on delete set null,
  actualizado_en  timestamptz not null default now(),
  unique (cui_origen, codigo_bien)
);
create index if not exists ioarr_precios_codigo_idx on public.ioarr_precios_referencia (codigo_bien);

alter table public.ioarr_documentos         enable row level security;
alter table public.ioarr_precios_referencia enable row level security;
