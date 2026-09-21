-- ============================================================
-- Chitra AI — V11 migration: channel reliability + handoff + broadcasts
-- Run in the Supabase SQL Editor (after earlier migrations). Safe to re-run.
-- ============================================================
--
-- Why this ships as JSONB + two tables instead of touching hot paths:
--   1. `settings.channel_settings` (JSONB) holds every per-org channel
--      preference — toggles, office hours, handoff ping numbers, WhatsApp
--      re-engagement templates, Telegram/Viber tokens — without a new
--      column (and a new index) for each one.
--   2. `channel_contacts` remembers opt-in + the native contact id per
--      visitor so broadcasts and handoff replies can find the right thread
--      even when the dashboard session id is all the owner has.
--   3. `channel_broadcasts` queues plain-text template broadcasts with
--      idempotent, checkpointed sending (a crash mid-send resumes, it does
--      not double-send). Delayed/paced sending is computed from
--      `scheduled_at` + row state — no new cron table needed.
--   4. `chat_history.channel` gains the senders/receivers we add in V11.
--      Star-expands stay valid: `select *` keeps working after this lands.

-- ---------- 1. Per-org channel preferences ----------
alter table public.settings
  add column if not exists channel_settings jsonb not null default '{}'::jsonb;

comment on column public.settings.channel_settings is
  'V11 channel control plane. Keys (all optional): channel_enabled {web,whatsapp,messenger,instagram,openwa,telegram,viber}, office {timezone, windows:[{days:[0-6], open:09:00, close:18:00}], message}, handoff {activeSessionIds:[...], pingNumber, pingMessage}, whatsapp {template, templateLang, templateVars[]}, telegram {botToken}, viber {botToken}, broadcast {perMinute}. Unknown keys are ignored by the backend.';

-- ---------- 2. Native contact ids per visitor (broadcasts + owner replies) ----------
create table if not exists public.channel_contacts (
  id bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel text not null check (channel in ('whatsapp','openwa','messenger','instagram','telegram','viber')),
  session_id text not null,
  remote_id text not null,
  display_name text,
  opt_in boolean not null default true,
  last_inbound_at timestamptz default now(),
  created_at timestamptz default now(),
  unique (organization_id, channel, remote_id)
);

create index if not exists channel_contacts_session_idx
  on public.channel_contacts(organization_id, channel, session_id);
create index if not exists channel_contacts_optin_idx
  on public.channel_contacts(organization_id, channel, opt_in);

-- ---------- 3. Broadcast queue (idempotent, checkpointed, resumable) ----------
create table if not exists public.channel_broadcasts (
  id bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel text not null check (channel in ('whatsapp','openwa','telegram','viber')),
  message text not null,
  template_name text,
  status text not null default 'draft' check (status in ('draft','scheduled','sending','done','cancelled','failed')),
  audience text not null default 'opted_in' check (audience in ('opted_in','all')),
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- Checkpoint: ids already attempted survive a crash; next run skips them.
  processed_ids bigint[] not null default '{}',
  sent_count int not null default 0,
  failed_count int not null default 0,
  last_error text,
  created_at timestamptz default now()
);

create index if not exists channel_broadcasts_org_status_idx
  on public.channel_broadcasts(organization_id, status);

-- ---------- 4. chat_history.channel learns the V11 senders ----------
alter table public.chat_history
  drop constraint if exists chat_history_channel_check;
alter table public.chat_history
  add constraint chat_history_channel_check
  check (channel in ('web','whatsapp','openwa','messenger','instagram','telegram','viber','sms'));

-- ---------- 5. RLS + tenant policies (same pattern as the other tenant tables) ----------
alter table public.channel_contacts enable row level security;
alter table public.channel_broadcasts enable row level security;

drop policy if exists "channel_contacts_org_all" on public.channel_contacts;
create policy "channel_contacts_org_all" on public.channel_contacts
  for all using (organization_id = public.current_user_org_id())
  with check (organization_id = public.current_user_org_id());

drop policy if exists "channel_broadcasts_org_all" on public.channel_broadcasts;
create policy "channel_broadcasts_org_all" on public.channel_broadcasts
  for all using (organization_id = public.current_user_org_id())
  with check (organization_id = public.current_user_org_id());

-- ---------- 6. Telegram/Viber webhook secrets live next to the Meta ids ----------
alter table public.settings
  add column if not exists telegram_bot_username text,
  add column if not exists telegram_webhook_secret text,
  add column if not exists viber_bot_name text,
  add column if not exists viber_webhook_token text;

-- ---------- Verify ----------
-- select column_name from information_schema.columns
--   where table_name = 'settings' and column_name = 'channel_settings';
-- select count(*) from public.channel_contacts;
-- select count(*) from public.channel_broadcasts;
