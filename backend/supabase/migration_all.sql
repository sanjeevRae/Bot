-- ============================================================
-- Chitra AI — ALL-IN-ONE migrations (V2 + V3 + V4)
-- Run this ONCE in Supabase SQL Editor. Safe to re-run.
-- Covers everything after the base schema.sql.
-- ============================================================

-- ============================================================
-- V2: Messaging channels + knowledge imports
-- ============================================================

alter table public.settings
  add column if not exists whatsapp_phone_number_id text,
  add column if not exists messenger_page_id text;

alter table public.documents
  drop constraint if exists documents_source_type_check;
alter table public.documents
  add constraint documents_source_type_check
  check (source_type in ('crawl','upload','manual','drive','notion'));

-- ============================================================
-- V3: Human handoff + Turnstile setting
-- ============================================================

alter table public.chat_history
  add column if not exists handoff_requested boolean default false,
  add column if not exists handoff_resolved boolean default false;

create index if not exists chat_history_handoff_idx
  on public.chat_history(organization_id, handoff_requested, created_at);

alter table public.settings
  add column if not exists turnstile_enabled boolean default false;

-- ============================================================
-- V4: Plans, Nepali payments, white-label
-- ============================================================

alter table public.organizations
  add column if not exists plan text default 'free',
  add column if not exists plan_expires_at timestamptz,
  add column if not exists payment_provider text,
  add column if not exists payment_reference text;

do $$ begin
  create type public.plan_tier as enum ('free','pro','agency');
exception when duplicate_object then null; end $$;

create table if not exists public.payments (
  id bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('esewa','khalti')),
  amount_npr int not null,
  plan text not null check (plan in ('pro','agency')),
  months int not null default 1,
  status text default 'pending' check (status in ('pending','completed','failed')),
  transaction_uuid text unique,
  gateway_ref text,
  created_at timestamptz default now()
);

alter table public.payments enable row level security;

drop policy if exists "payments_org_select" on public.payments;
create policy "payments_org_select" on public.payments
  for select using (organization_id = public.current_user_org_id());

alter table public.settings
  add column if not exists white_label boolean default false,
  add column if not exists custom_logo_url text;

-- ============================================================
-- Done! Restart backend after running this.
-- ============================================================
