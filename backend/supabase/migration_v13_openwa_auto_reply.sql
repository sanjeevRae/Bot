-- ============================================================
-- Chitra AI — V13 migration: WhatsApp auto-reply switch (OpenWA)
-- Run in the Supabase SQL Editor (after earlier migrations). Safe to re-run.
-- ============================================================
--
-- Who answers inbound WhatsApp: this backend, or Muse?
--
--   false (default) = "Muse mode". The backend NEVER replies; it only counts
--     incoming messages per chat (backend/src/lib/waPending.js) and publishes
--     them on GET /wa-pending, which Muse's event hook polls before reading the
--     real messages through the OpenWA API and answering them herself.
--   true = the original behaviour: the backend answers WhatsApp messages itself
--     through the existing RAG/Groq/tools pipeline (nothing was deleted).
--
-- The toggle lives here so an org can switch modes from the Channels page with
-- no deploy. The env var WHATSAPP_AUTO_REPLY=on still forces `true` for every
-- org, so the ops rollback stays a single flag flip.
--
-- Without this migration the backend reads "Muse mode" for every session and the
-- Channels toggle reports that this file must be run.

alter table public.whatsapp_connections
  add column if not exists auto_reply_enabled boolean not null default false;

comment on column public.whatsapp_connections.auto_reply_enabled is
  'V13: true = this backend auto-replies to WhatsApp messages; false (default) = count only, Muse replies through OpenWA. Toggled from the Channels page; WHATSAPP_AUTO_REPLY=on on the server overrides it.';
