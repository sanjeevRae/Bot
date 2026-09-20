-- ============================================================
-- Chitra AI — RAG performance & retrieval-recall migration (v9)
-- Run this in the Supabase SQL Editor (after schema.sql).
-- ============================================================
--
-- Why:
--   1. schema.sql created an ivfflat index with lists = 100. ivfflat trains
--      100 clusters, but pgvector defaults to probes = 1, so on a small
--      knowledge base (few rows) the single probed cluster is usually EMPTY and
--      similarity search returns zero rows — the bot silently answers from no
--      knowledge at all. HNSW has no training step, gives better recall on both
--      tiny and large corpora, and is faster to query. Requires pgvector >= 0.5
--      (all current Supabase projects).
--   2. Add a lexical (full-text) search RPC as an automatic fallback for when
--      vector search still comes back empty — e.g. a rare term, a SKU, a name.
--      Hybrid vector + keyword retrieval is the standard fix for this class of
--      miss.
--   3. Cover the hot paths with indexes so the per-message queries never scan.

-- ---------- 1. Replace ivfflat with HNSW ----------
drop index if exists public.document_sections_embedding_idx;

create index if not exists document_sections_embedding_hnsw_idx
  on public.document_sections using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ---------- 2. Keyword/full-text support ----------
create index if not exists document_sections_content_fts_idx
  on public.document_sections using gin (to_tsvector('simple', content));

-- ---------- 3. Supporting indexes for the per-message queries ----------
create index if not exists documents_org_idx on public.documents(organization_id);
create index if not exists chat_history_session_idx
  on public.chat_history(organization_id, session_id, created_at desc);
create index if not exists usage_events_org_type_idx
  on public.usage_events(organization_id, event_type, created_at desc);

-- ---------- 4. Vector search (tenant-scoped), tuned for latency ----------
-- Raises hnsw.ef_search locally so small knowledge bases still match, and
-- ignores rows with a NULL embedding (documents still being ingested).
create or replace function public.match_document_sections(
  query_embedding vector(384),
  match_count int default 5,
  org_id uuid default null
)
returns table (id bigint, document_id bigint, content text, similarity float)
language plpgsql stable as $$
begin
  -- 40 candidates is plenty for top-5 while staying fast; the default (40)
  -- would be fine too, but being explicit documents the intent.
  perform set_config('hnsw.ef_search', '40', true);

  return query
    select ds.id, ds.document_id, ds.content,
           1 - (ds.embedding <=> query_embedding) as similarity
    from public.document_sections ds
    where ds.organization_id = org_id
      and ds.embedding is not null
    order by ds.embedding <=> query_embedding
    limit match_count;
end;
$$;

-- ---------- 5. Lexical fallback (tenant-scoped) ----------
-- 'simple' config = no stemming/stopwords, so it works for any language
-- (English, Nepali, product codes) without extra dictionaries.
create or replace function public.match_document_sections_keyword(
  query_text text,
  match_count int default 5,
  org_id uuid default null
)
returns table (id bigint, document_id bigint, content text, similarity float)
language sql stable as $$
  select ds.id, ds.document_id, ds.content,
         ts_rank(to_tsvector('simple', ds.content), plainto_tsquery('simple', query_text))::float as similarity
  from public.document_sections ds
  where ds.organization_id = org_id
    and to_tsvector('simple', ds.content) @@ plainto_tsquery('simple', query_text)
  order by similarity desc
  limit match_count;
$$;

-- ---------- Verify ----------
-- select indexname from pg_indexes where tablename = 'document_sections';
-- select count(*) from public.document_sections where embedding is not null;
