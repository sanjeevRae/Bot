-- ============================================================
-- Chitra AI — V4c: Custom domains for Pro widgets
-- Run in Supabase SQL Editor (safe to re-run)
-- ============================================================

alter table public.settings
  add column if not exists custom_domain text;

-- One domain can only belong to one org
create unique index if not exists settings_custom_domain_idx
  on public.settings(custom_domain)
  where custom_domain is not null;
