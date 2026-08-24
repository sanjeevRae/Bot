-- ============================================================
-- Chitra AI — V4 migration: plans, Nepali payments, white-label
-- Run in Supabase SQL Editor (safe to re-run)
-- ============================================================

-- ---------- Billing fields on organizations ----------
alter table public.organizations
  add column if not exists plan text default 'free'
    check (plan in ('free','pro','agency')),
  add column if not exists plan_expires_at timestamptz,
  add column if not exists payment_provider text,
  add column if not exists payment_reference text;

-- ---------- Payment transactions (audit trail) ----------
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

-- ---------- White-label fields on settings ----------
alter table public.settings
  add column if not exists white_label boolean default false,
  add column if not exists custom_logo_url text;

-- ---------- Plan quotas reference ----------
-- free:   200 msgs/mo, 10 docs, 50 bookings (existing defaults)
-- pro:    2000 msgs/mo, 100 docs, unlimited bookings, white-label
-- agency: 10000 msgs/mo, 500 docs, + multi-client management (future)
