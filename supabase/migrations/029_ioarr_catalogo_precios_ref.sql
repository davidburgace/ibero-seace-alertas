-- ============================================================================
-- 029_ioarr_catalogo_precios_ref.sql — Catálogo de precios referenciales de
-- mobiliario escolar tomados de IOARR publicadas (Selector IOARR)
--
-- 1. ioarr_precios_ref: un registro por precio publicado (07-C, bases, estudio de
--    mercado) o el precio propio (tipo_documento = 'propio', USO INTERNO: no entra
--    a los estadísticos ni a ningún exportable). El precio por kit sin IGV se
--    calcula en el servidor (src/selector-ioarr/catalogo-ref.js), no se guarda.
--    El PDF fuente va en el bucket ioarr-expediente (catalogo-ref/<id>/…).
-- 2. ioarr_precios_ref_proyecto: qué referencia usa cada proyecto (mediana o una
--    fuente, y el material) para estimar el monto del convenio.
-- 3. Precarga de 5 registros (material «por_confirmar», confianza «media»).
--    Lo que no se conoce queda «por_confirmar» o vacío: no se inventa.
--
-- Ejecutar en Supabase → SQL Editor después de la 028. Es idempotente.
-- ============================================================================

create table if not exists public.ioarr_precios_ref (
  id               uuid primary key default gen_random_uuid(),
  tipo_documento   text not null check (tipo_documento in ('07-C', 'bases', 'estudio_mercado', 'propio', 'por_confirmar')),
  cui              text check (cui is null or cui ~ '^\d{5,8}$'),
  entidad          text,
  region           text,
  anio             integer not null check (anio between 2000 and 2100),
  url              text,
  archivo_ruta     text,          -- PDF fuente en el bucket ioarr-expediente
  archivo_nombre   text,
  nivel            text not null check (nivel in ('Inicial', 'Primaria', 'Secundaria', 'por_confirmar')),
  unidad           text not null check (unidad in ('kit', 'mesa', 'silla', 'carpeta', 'pieza')),
  material         text not null check (material in ('metal-madera', 'metal-polipropileno', 'por_confirmar')),
  monto            numeric(12, 2) not null check (monto > 0),
  monto_hasta      numeric(12, 2) check (monto_hasta is null or monto_hasta >= monto),   -- rango «aprox. de … a …»
  incluye_igv      boolean,       -- null = por confirmar (el registro no es comparable)
  cotizaciones     jsonb,         -- { valores: [], n, promedio }
  composicion      jsonb not null default '[]'::jsonb,   -- [{ unidad, cantidad, precio }] si la unidad no es kit
  flete_transporte numeric(12, 2) check (flete_transporte is null or flete_transporte >= 0),
  confianza        text not null check (confianza in ('alta', 'media', 'baja')),
  notas            text,
  creado_por       uuid references auth.users(id) on delete set null,
  creado_en        timestamptz not null default now(),
  actualizado_en   timestamptz not null default now()
);
create index if not exists ioarr_precios_ref_filtros_idx on public.ioarr_precios_ref (material, nivel, region, anio);

drop trigger if exists ioarr_precios_ref_actualizado on public.ioarr_precios_ref;
create trigger ioarr_precios_ref_actualizado
  before update on public.ioarr_precios_ref
  for each row execute function public.ioarr_tocar_actualizado();

create table if not exists public.ioarr_precios_ref_proyecto (
  proyecto_id     uuid primary key references public.ioarr_selector_proyectos(id) on delete cascade,
  modo            text not null default 'mediana' check (modo in ('mediana', 'registro')),
  registro_id     uuid references public.ioarr_precios_ref(id) on delete set null,
  material        text not null default 'todos' check (material in ('todos', 'metal-madera', 'metal-polipropileno', 'por_confirmar')),
  actualizado_en  timestamptz not null default now()
);

-- RLS: el catálogo es compartido entre proveedores (como ioarr_precios_catalogo);
-- la elección del proyecto, solo el dueño.
alter table public.ioarr_precios_ref enable row level security;
drop policy if exists solo_proveedores on public.ioarr_precios_ref;
create policy solo_proveedores on public.ioarr_precios_ref for all to authenticated
  using (public.es_proveedor()) with check (public.es_proveedor());
revoke all on public.ioarr_precios_ref from anon;

alter table public.ioarr_precios_ref_proyecto enable row level security;
drop policy if exists solo_duenio on public.ioarr_precios_ref_proyecto;
create policy solo_duenio on public.ioarr_precios_ref_proyecto for all to authenticated
  using (exists (select 1 from public.ioarr_selector_proyectos p
                 where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()))
  with check (exists (select 1 from public.ioarr_selector_proyectos p
                      where p.id = proyecto_id and p.usuario_id = auth.uid() and public.es_proveedor()));
revoke all on public.ioarr_precios_ref_proyecto from anon;

-- ─── Precarga ───────────────────────────────────────────────────────────────
-- Ids fijos: volver a correr la migración no duplica ni pisa lo que se haya corregido.
insert into public.ioarr_precios_ref (id, tipo_documento, entidad, region, anio, nivel, unidad, material, monto, monto_hasta, incluye_igv, cotizaciones, confianza, notas) values
  ('c0a7a10e-0000-4000-8000-000000000001', 'por_confirmar', null, 'Loreto', 2026, 'por_confirmar', 'kit', 'por_confirmar', 624.00, null, false, null, 'media',
   'Precarga: S/ 624 por kit, sin IGV. Confirmar documento fuente, CUI, nivel y material.'),
  ('c0a7a10e-0000-4000-8000-000000000002', 'por_confirmar', null, 'Huánuco', 2023, 'por_confirmar', 'pieza', 'por_confirmar', 267.50, null, true,
   '{"valores": [], "n": 4, "promedio": 267.50}'::jsonb, 'media',
   'Precarga: S/ 267.50 por mobiliario, con IGV, promedio de 4 cotizaciones. No comparable hasta indicar la composición del kit (cuántas piezas y de qué tipo).'),
  ('c0a7a10e-0000-4000-8000-000000000003', 'por_confirmar', null, 'Huánuco', 2025, 'por_confirmar', 'kit', 'por_confirmar', 455.00, 480.00, null, null, 'media',
   'Precarga: aprox. S/ 455 a 480 por set. No comparable hasta confirmar si incluye IGV.'),
  ('c0a7a10e-0000-4000-8000-000000000004', 'por_confirmar', 'Gobierno Regional de La Libertad', 'La Libertad', 2026, 'por_confirmar', 'kit', 'por_confirmar', 700.00, null, null, null, 'media',
   'Precarga: I.E. San Juan, aprox. S/ 700 por set. No comparable hasta confirmar si incluye IGV.'),
  ('c0a7a10e-0000-4000-8000-000000000005', 'propio', null, null, 2026, 'por_confirmar', 'kit', 'por_confirmar', 850.00, null, false, null, 'media',
   'Referencia propia: S/ 850 + IGV por kit. Uso interno: no entra a los estadísticos ni a los exportables.')
on conflict (id) do nothing;

notify pgrst, 'reload schema';
