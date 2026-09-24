-- ============================================================
-- Chitra AI — V12 migration: group @-mention replies (OpenWA)
-- Run in the Supabase SQL Editor (after earlier migrations). Safe to re-run.
-- ============================================================
--
-- Group chats stay silent unless the bot itself is @-mentioned. The opt-out
-- lives here so an org can switch group replies off without a deploy.
--
-- Default TRUE, because the mention requirement is already the safety gate: the
-- bot never answers group chatter unasked, so the useful default is "answer when
-- called". Set it to false to keep a session direct-messages-only.
--
-- The gateway itself is untouched — all the policy is in
-- backend/src/lib/openwaInbound.js and routes/openwa.js.

alter table public.whatsapp_connections
  add column if not exists group_replies_enabled boolean not null default true;

comment on column public.whatsapp_connections.group_replies_enabled is
  'V12: true (default) = reply in group chats after being @-mentioned (direct messages unaffected); false = ignore group messages entirely. Toggled from the Channels page.';
