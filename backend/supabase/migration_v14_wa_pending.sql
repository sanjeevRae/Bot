-- ============================================================
-- Chitra AI — V14 migration: durable WhatsApp pending messages (OpenWA)
-- Run in the Supabase SQL Editor (after earlier migrations). Safe to re-run.
-- ============================================================
--
-- WHY: the Muse-mode pending counter used to live in the backend's memory. A
-- Render restart (deploys happen) or a redeploy lost it, and the message with it —
-- the webhook had already been acknowledged, so OpenWA never retried. A prospect's
-- message silently vanished from GET /wa-pending. This table makes the count
-- durable: routes/openwa.js stores the row BEFORE acknowledging the delivery, so
-- an acknowledged message can no longer be lost.
--
-- One row per inbound message, never message content — a chat id, the gateway's
-- message id, two timestamps. That is why the public feed can stay unauthenticated.
--
--   event_key  unique → OpenWA retries are idempotent, across restarts too
--   status     pending  = nobody has answered it yet (what the feed reports)
--              handled  = our own outbound message was seen for that chat
--              expired  = nobody answered it within WA_PENDING_EXPIRE_DAYS
-- ============================================================

create table if not exists public.wa_pending_messages (
  id bigserial primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  session_id text not null,
  chat_id text not null,
  message_id text,
  event_key text not null,
  is_group boolean not null default false,
  status text not null default 'pending' check (status in ('pending','handled','expired')),
  received_at timestamptz not null default now(),
  handled_at timestamptz
);

-- Idempotency: a redelivered webhook (retry, restart, duplicate delivery) is
-- ignored instead of counted twice.
create unique index if not exists wa_pending_messages_event_key_idx
  on public.wa_pending_messages(event_key);

-- The feed's query: still-unanswered rows, newest first.
create index if not exists wa_pending_messages_status_idx
  on public.wa_pending_messages(status, received_at desc);

-- Clearing a chat when our reply is observed.
create index if not exists wa_pending_messages_chat_idx
  on public.wa_pending_messages(session_id, chat_id) where status = 'pending';

-- Housekeeping (expire/delete by age).
create index if not exists wa_pending_messages_received_idx
  on public.wa_pending_messages(received_at);

alter table public.wa_pending_messages enable row level security;

-- Same tenant pattern as every other table. The backend uses the service role, so
-- this only matters if the dashboard ever reads the table directly; rows with no
-- resolved org (a session that is not mapped yet) stay visible only to the backend.
drop policy if exists "wa_pending_messages_org_all" on public.wa_pending_messages;
create policy "wa_pending_messages_org_all" on public.wa_pending_messages
  for all using (organization_id = public.current_user_org_id())
  with check (organization_id = public.current_user_org_id());
