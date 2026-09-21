-- ============================================================
-- Chitra AI — V10 migration: richer knowledge sources + curation
-- Run in the Supabase SQL Editor (after schema.sql + earlier migrations).
-- Safe to re-run.
-- ============================================================
--
-- Why:
--   1. Knowledge sources grew well beyond crawl/upload/manual. Word, Excel and
--      PowerPoint files, menu photos (OCR), voice notes (Whisper), YouTube
--      videos and dashboard-entered business facts all need their own
--      source_type so the dashboard can label them.
--   2. `is_active` lets a merchant switch a source off without deleting it —
--      an outdated price list stays, but stops being retrieved.
--   3. `last_synced_at` records when a crawl/source was last refreshed so the
--      UI can show "synced 2 days ago" instead of guessing from created_at.

-- ---------- 1. Source types ----------
alter table public.documents
  drop constraint if exists documents_source_type_check;
alter table public.documents
  add constraint documents_source_type_check
  check (source_type in (
    'crawl',        -- website crawl
    'upload',       -- PDF / TXT / MD / CSV
    'manual',       -- pasted text
    'drive',        -- Google Drive shared file
    'notion',       -- public Notion page
    'structured',   -- business facts + Q&A entered in the dashboard
    'document',     -- Word (.docx)
    'sheet',        -- Excel (.xlsx) / PPT table export
    'slides',       -- PowerPoint (.pptx)
    'image',        -- menu / price-list photo (OCR)
    'audio',        -- voice note (Speech-to-Text)
    'youtube'       -- YouTube video transcript
  ));

-- ---------- 2. Curation flags ----------
alter table public.documents
  add column if not exists is_active boolean not null default true,
  add column if not exists last_synced_at timestamptz;

-- Retrieval only ever reads active documents, so index that path.
create index if not exists documents_org_active_idx
  on public.documents(organization_id, is_active);

-- ---------- 3. Retrieval skips inactive documents ----------
-- The small-corpus fast path reads document_sections directly, so the flag has
-- to be applied here in SQL too (it joins documents) — otherwise a disabled
-- source would still be answered from cache.
create or replace function public.match_document_sections(
  query_embedding vector(384),
  match_count int default 5,
  org_id uuid default null
)
returns table (id bigint, document_id bigint, content text, similarity float)
language plpgsql stable as $$
begin
  perform set_config('hnsw.ef_search', '40', true);

  return query
    select ds.id, ds.document_id, ds.content,
           1 - (ds.embedding <=> query_embedding) as similarity
    from public.document_sections ds
    join public.documents d on d.id = ds.document_id
    where ds.organization_id = org_id
      and ds.embedding is not null
      and d.is_active
    order by ds.embedding <=> query_embedding
    limit match_count;
end;
$$;

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
  join public.documents d on d.id = ds.document_id
  where ds.organization_id = org_id
    and d.is_active
    and to_tsvector('simple', ds.content) @@ plainto_tsquery('simple', query_text)
  order by similarity desc
  limit match_count;
$$;

-- ---------- Verify ----------
-- select source_type, is_active, count(*) from public.documents group by 1,2;
-- select indexname from pg_indexes where tablename = 'documents';
