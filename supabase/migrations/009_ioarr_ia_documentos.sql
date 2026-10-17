-- ============================================================================
-- Radar IOARR — IA sobre los documentos del proyecto
-- Ejecutar después de 008_ioarr_financiamiento.sql (idempotente). Requiere la
-- extensión pgvector (ya la usa el radar SEACE).
--
--   ioarr_doc_chunks   fragmentos del texto de cada PDF con su embedding, para
--                      el chat «Preguntar a los documentos» (src/ioarr/ia.js)
--   ioarr_chats        preguntas y respuestas por proyecto
-- ============================================================================

create extension if not exists vector;

-- Para no volver a indexar un PDF (p. ej. uno escaneado, que no tiene texto)
alter table public.ioarr_documentos add column if not exists indexado_en timestamptz;
alter table public.ioarr_documentos add column if not exists fragmentos int;

create table if not exists public.ioarr_doc_chunks (
  id            uuid primary key default gen_random_uuid(),
  documento_id  uuid not null references public.ioarr_documentos(id) on delete cascade,
  proyecto_id   uuid not null references public.ioarr_proyectos(id) on delete cascade,
  chunk_index   int not null,
  pagina_desde  int,
  pagina_hasta  int,
  content       text not null,
  embedding     vector(1536),               -- text-embedding-3-small
  creado_en     timestamptz not null default now(),
  unique (documento_id, chunk_index)
);
create index if not exists ioarr_doc_chunks_proyecto_idx on public.ioarr_doc_chunks (proyecto_id);

create table if not exists public.ioarr_chats (
  id           uuid primary key default gen_random_uuid(),
  proyecto_id  uuid not null references public.ioarr_proyectos(id) on delete cascade,
  pregunta     text not null,
  respuesta    text not null,
  fuentes      jsonb not null default '[]'::jsonb,   -- [{documento_id, nombre_archivo, pagina_desde, pagina_hasta, similitud}]
  modelo       text,
  usuario_id   uuid references auth.users(id) on delete set null,
  creado_en    timestamptz not null default now()
);
create index if not exists ioarr_chats_proyecto_idx on public.ioarr_chats (proyecto_id, creado_en desc);

-- Fragmentos de un proyecto más parecidos a la pregunta (pocos por proyecto: sin índice vectorial)
create or replace function public.ioarr_match_chunks(query_embedding vector(1536), p_proyecto_id uuid, match_count int default 8)
returns table (id uuid, documento_id uuid, chunk_index int, pagina_desde int, pagina_hasta int, content text, similitud double precision)
language sql stable as $$
  select c.id, c.documento_id, c.chunk_index, c.pagina_desde, c.pagina_hasta, c.content,
         1 - (c.embedding <=> query_embedding) as similitud
  from public.ioarr_doc_chunks c
  where c.proyecto_id = p_proyecto_id and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

alter table public.ioarr_doc_chunks enable row level security;
alter table public.ioarr_chats      enable row level security;
