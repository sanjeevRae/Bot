-- ============================================================
-- Chitra AI — V15 migration: group @-mentions in the Muse pending feed
-- Run in the Supabase SQL Editor (after migration_v14). Safe to re-run.
-- ============================================================
--
-- WHY: a group message that @-mentions the bot must wake Muse exactly like a 1:1
-- message, and she needs enough detail to answer in the group tagging the person
-- who asked — so the pending row now carries who wrote it, what they wrote and the
-- WhatsApp message id. Group chatter that does NOT mention the bot is never
-- written here at all (see the mention gate in routes/openwa.js), so a busy team
-- group cannot spam the feed.
--
--   author        the real sender inside the group (e.g. 248065197879524@lid)
--   author_name   their WhatsApp display name, when the gateway sends one
--   body          the message text (capped when read, see WA_PENDING_DETAIL_LIMIT)
--   mentioned_ids comma-joined mentions in the message, so the consumer can see
--                 which of our identities was tagged
--   match_reason  how the mention was recognised: mentionedIds | mentions |
--                 body-number | body-name (diagnostics for "why was/wasn't it
--                 counted")
--
-- No new table, no change to existing rows: everything is nullable, so an
-- un-migrated deploy keeps working (the feed falls back to the base columns).
-- ============================================================

alter table public.wa_pending_messages
  add column if not exists author text,
  add column if not exists author_name text,
  add column if not exists body text,
  add column if not exists mentioned_ids text,
  add column if not exists match_reason text;

-- Newest-first detail for the feed is already covered by wa_pending_messages_status_idx
-- (status, received_at desc). A group row is found by its own chat_id, which
-- wa_pending_messages_chat_idx already serves.
