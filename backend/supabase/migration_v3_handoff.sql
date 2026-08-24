-- ============================================================
-- Chitra AI — V3 migration: human handoff
-- Run in Supabase SQL Editor (safe to re-run)
-- ============================================================

-- ---------- Handoff requests on chat sessions ----------
-- A session flagged for handoff appears in the owner's inbox until resolved.
alter table public.chat_history
  add column if not exists handoff_requested boolean default false,
  add column if not exists handoff_resolved boolean default false;

create index if not exists chat_history_handoff_idx
  on public.chat_history(organization_id, handoff_requested, created_at);

-- ---------- Turnstile captcha settings ----------
alter table public.settings
  add column if not exists turnstile_enabled boolean default false;
