-- ============================================================
-- Chitra AI — V2 migration: messaging channels + knowledge imports
-- Run in Supabase SQL Editor (safe to re-run)
-- ============================================================

-- ---------- Channel connection fields on settings ----------
alter table public.settings
  add column if not exists whatsapp_phone_number_id text,
  add column if not exists messenger_page_id text;

-- ---------- Knowledge source types: drive / notion ----------
alter table public.documents
  drop constraint if exists documents_source_type_check;
alter table public.documents
  add constraint documents_source_type_check
  check (source_type in ('crawl','upload','manual','drive','notion'));
