-- ============================================================================
-- 037_ioarr_precios_ref_fuentes.sql — Catálogo de precios referenciales: campos
-- nuevos, factores de actualización, opciones por proyecto y precarga de Huicungo
--
-- 1. ioarr_precios_ref: fuente (etiqueta, p. ej. «Huicungo 2026»), grado (1-2,
--    3-4, 5-6), volumen_kits, anio_precio, estado (vigente | historico) y tipo
--    (publicado | derivado | propio). Unidad nueva «transporte» (por pieza).
--    Los componentes del total aceptan la supervisión en un solo monto
--    (componentes.supervision); lo valida el servidor (catalogo-ref.js).
-- 2. ioarr_factores_actualizacion: factor del año de origen al año base (2025
--    por defecto). Sin precarga: sin fila, el factor es 1.00 y el precio se
--    muestra «sin ajuste de precios». No se inventan índices.
-- 3. ioarr_precios_ref_proyecto: modo «defecto» (la referencia por defecto del
--    material: Metal/Madera → Huicungo 2026; si no hay, la mediana), incluir
--    atípicos por volumen (no por defecto), comparar a año base (sí) y año base.
-- 4. Precarga (CSV del pedido, 2026-10-25): Huicungo 2026 (mesas y sillas por
--    grado, transporte por pieza y el kit derivado, CUI vacío a propósito) y
--    Huánuco 2025 derivado (12,379 kits: atípico por volumen). A los registros
--    de antes solo se les llenan los campos nuevos o vacíos; no se pisa lo
--    corregido en la 030 a la 036:
--      - San Juan sigue con su memoria de costos (S/ 411.85 sin IGV), no con el
--        derivado de S/ 707.50 del CSV.
--      - Huánuco 2025 (rango 455-480 sin IGV, 036) queda como está; el
--        derivado del CSV entra como otro registro.
--      - Huánuco 2023 queda con IGV (cuadro comparativo, 033) y sin CUI; pasa
--        a «histórico», como dice el CSV.
--      - Loreto toma el CUI 2717248 del CSV (estaba vacío).
--      - El precio propio sigue sin nombre de empresa.
--
-- Ejecutar en Supabase → SQL Editor después de la 036. Es idempotente.
-- ============================================================================

-- ─── 1. Campos nuevos ───────────────────────────────────────────────────────
alter table public.ioarr_precios_ref add column if not exists fuente       text;
alter table public.ioarr_precios_ref add column if not exists grado        text;
alter table public.ioarr_precios_ref add column if not exists volumen_kits integer;
alter table public.ioarr_precios_ref add column if not exists anio_precio  integer;
alter table public.ioarr_precios_ref add column if not exists estado       text not null default 'vigente';
alter table public.ioarr_precios_ref add column if not exists tipo         text not null default 'publicado';

alter table public.ioarr_precios_ref drop constraint if exists ioarr_precios_ref_grado_check;
alter table public.ioarr_precios_ref add constraint ioarr_precios_ref_grado_check check (grado is null or grado in ('1-2', '3-4', '5-6'));
alter table public.ioarr_precios_ref drop constraint if exists ioarr_precios_ref_volumen_check;
alter table public.ioarr_precios_ref add constraint ioarr_precios_ref_volumen_check check (volumen_kits is null or volumen_kits > 0);
alter table public.ioarr_precios_ref drop constraint if exists ioarr_precios_ref_anio_precio_check;
alter table public.ioarr_precios_ref add constraint ioarr_precios_ref_anio_precio_check check (anio_precio is null or anio_precio between 2000 and 2100);
alter table public.ioarr_precios_ref drop constraint if exists ioarr_precios_ref_estado_check;
alter table public.ioarr_precios_ref add constraint ioarr_precios_ref_estado_check check (estado in ('vigente', 'historico'));
alter table public.ioarr_precios_ref drop constraint if exists ioarr_precios_ref_tipo_check;
alter table public.ioarr_precios_ref add constraint ioarr_precios_ref_tipo_check check (tipo in ('publicado', 'derivado', 'propio'));
alter table public.ioarr_precios_ref drop constraint if exists ioarr_precios_ref_unidad_check;
alter table public.ioarr_precios_ref add constraint ioarr_precios_ref_unidad_check
  check (unidad in ('kit', 'mesa', 'silla', 'carpeta', 'armario', 'transporte', 'pieza', 'otro'));

-- Tipo de los registros que ya estaban (por el tipo de documento)
update public.ioarr_precios_ref set tipo = 'propio' where tipo_documento = 'propio' and tipo <> 'propio';
update public.ioarr_precios_ref set tipo = 'derivado' where tipo_documento = 'estimado_derivado' and tipo = 'publicado';

-- ─── 2. Factores de actualización ───────────────────────────────────────────
create table if not exists public.ioarr_factores_actualizacion (
  id             uuid primary key default gen_random_uuid(),
  anio_origen    integer not null check (anio_origen between 2000 and 2100),
  anio_base      integer not null default 2025 check (anio_base between 2000 and 2100),
  factor         numeric(8, 4) not null default 1.00 check (factor > 0 and factor <= 10),
  fuente_indice  text,           -- p. ej. el índice de precios usado (lo escribe el usuario)
  fecha          date,           -- fecha del índice
  creado_por     uuid references auth.users(id) on delete set null,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (anio_origen, anio_base)
);
drop trigger if exists ioarr_factores_actualizacion_actualizado on public.ioarr_factores_actualizacion;
create trigger ioarr_factores_actualizacion_actualizado
  before update on public.ioarr_factores_actualizacion
  for each row execute function public.ioarr_tocar_actualizado();

-- Compartida entre proveedores, como el catálogo
alter table public.ioarr_factores_actualizacion enable row level security;
drop policy if exists solo_proveedores on public.ioarr_factores_actualizacion;
create policy solo_proveedores on public.ioarr_factores_actualizacion for all to authenticated
  using (public.es_proveedor()) with check (public.es_proveedor());
revoke all on public.ioarr_factores_actualizacion from anon;

-- ─── 3. Opciones por proyecto ───────────────────────────────────────────────
alter table public.ioarr_precios_ref_proyecto drop constraint if exists ioarr_precios_ref_proyecto_modo_check;
alter table public.ioarr_precios_ref_proyecto add constraint ioarr_precios_ref_proyecto_modo_check check (modo in ('defecto', 'mediana', 'registro'));
alter table public.ioarr_precios_ref_proyecto alter column modo set default 'defecto';
alter table public.ioarr_precios_ref_proyecto add column if not exists incluir_atipicos   boolean not null default false;
alter table public.ioarr_precios_ref_proyecto add column if not exists comparar_anio_base boolean not null default true;
alter table public.ioarr_precios_ref_proyecto add column if not exists anio_base          integer not null default 2025;

-- ─── 4. Precarga ────────────────────────────────────────────────────────────
-- Campos nuevos de los registros de antes (solo si están vacíos)
update public.ioarr_precios_ref set fuente = 'Loreto 2026'   where id = 'c0a7a10e-0000-4000-8000-000000000001' and fuente is null;
update public.ioarr_precios_ref set cui = '2717248'          where id = 'c0a7a10e-0000-4000-8000-000000000001' and cui is null;
update public.ioarr_precios_ref set fuente = 'Huánuco 2023'  where id = 'c0a7a10e-0000-4000-8000-000000000002' and fuente is null;
update public.ioarr_precios_ref set fuente = 'Huánuco 2025'  where id = 'c0a7a10e-0000-4000-8000-000000000003' and fuente is null;
update public.ioarr_precios_ref set fuente = 'San Juan 2026' where id = 'c0a7a10e-0000-4000-8000-000000000004' and fuente is null;
update public.ioarr_precios_ref set volumen_kits = 1045      where id = 'c0a7a10e-0000-4000-8000-000000000004' and volumen_kits is null;
update public.ioarr_precios_ref set fuente = 'Propio'        where id = 'c0a7a10e-0000-4000-8000-000000000005' and fuente is null;
-- Huánuco 2023: histórico (se muestra, no entra a los estadísticos), como dice el CSV.
-- Ojo: volver a correr la migración lo vuelve a marcar histórico si alguien lo pasó a vigente.
update public.ioarr_precios_ref set estado = 'historico'
  where id = 'c0a7a10e-0000-4000-8000-000000000002' and estado = 'vigente';

-- Huicungo 2026 y Huánuco 2025 derivado (ids fijos: volver a correr no duplica ni pisa)
insert into public.ioarr_precios_ref (id, fuente, tipo_documento, tipo, estado, cui, entidad, region, anio, nivel, grado, unidad, material, monto, incluye_igv, volumen_kits, confianza, componentes, notas) values
  ('c0a7a10e-0000-4000-8000-000000000006', 'Huicungo 2026', '07-C', 'publicado', 'vigente', null, 'Municipalidad Distrital de Huicungo', 'San Martín', 2026, 'Primaria', '1-2', 'mesa',  'metal-madera', 370.00, true, 455, 'media', null,
   'Precio unitario del 07-C; material según el usuario (fichas homologadas)'),
  ('c0a7a10e-0000-4000-8000-000000000007', 'Huicungo 2026', '07-C', 'publicado', 'vigente', null, 'Municipalidad Distrital de Huicungo', 'San Martín', 2026, 'Primaria', '3-4', 'mesa',  'metal-madera', 375.00, true, 455, 'media', null,
   'Precio unitario del 07-C; material según el usuario'),
  ('c0a7a10e-0000-4000-8000-000000000008', 'Huicungo 2026', '07-C', 'publicado', 'vigente', null, 'Municipalidad Distrital de Huicungo', 'San Martín', 2026, 'Primaria', '5-6', 'mesa',  'metal-madera', 380.00, true, 455, 'media', null,
   'Precio unitario del 07-C; material según el usuario'),
  ('c0a7a10e-0000-4000-8000-000000000009', 'Huicungo 2026', '07-C', 'publicado', 'vigente', null, 'Municipalidad Distrital de Huicungo', 'San Martín', 2026, 'Primaria', '1-2', 'silla', 'metal-madera', 173.00, true, 455, 'media', null,
   'Precio unitario del 07-C; material según el usuario'),
  ('c0a7a10e-0000-4000-8000-00000000000a', 'Huicungo 2026', '07-C', 'publicado', 'vigente', null, 'Municipalidad Distrital de Huicungo', 'San Martín', 2026, 'Primaria', '3-4', 'silla', 'metal-madera', 178.00, true, 455, 'media', null,
   'Precio unitario del 07-C; material según el usuario'),
  ('c0a7a10e-0000-4000-8000-00000000000b', 'Huicungo 2026', '07-C', 'publicado', 'vigente', null, 'Municipalidad Distrital de Huicungo', 'San Martín', 2026, 'Primaria', '5-6', 'silla', 'metal-madera', 183.00, true, 455, 'media', null,
   'Precio unitario del 07-C; material según el usuario'),
  ('c0a7a10e-0000-4000-8000-00000000000c', 'Huicungo 2026', 'por_confirmar', 'publicado', 'vigente', null, 'Municipalidad Distrital de Huicungo', 'San Martín', 2026, 'Primaria', null, 'transporte', 'metal-madera', 25.00, true, 455, 'media', null,
   'Por pieza (S/ 50 por kit)'),
  ('c0a7a10e-0000-4000-8000-00000000000d', 'Huicungo 2026', 'bases', 'derivado', 'vigente', null, 'Municipalidad Distrital de Huicungo', 'San Martín', 2026, 'Primaria', null, 'kit', 'metal-madera', 675.50, true, 455, 'media',
   '{"ejecucion": 307333.60, "doc_equivalente": 13720.25, "supervision": 24696.45, "total": 345750.30}'::jsonb,
   'Ejecución 307333.60 / 455 kits; incluye GG 12% y transporte; bases: monto incluye IGV'),
  ('c0a7a10e-0000-4000-8000-00000000000e', 'Huánuco 2025', 'bases', 'derivado', 'vigente', '2586831', 'Gobierno Regional Huánuco', 'Huánuco', 2025, 'Secundaria', null, 'kit', 'metal-madera', 479.50, true, 12379, 'media', null,
   'Ejecución 5935849.58 / 12379 mesas (369 II.EE.); bases: monto incluye IGV; atípico por volumen')
on conflict (id) do nothing;

notify pgrst, 'reload schema';
