-- ============================================================
-- Chitra AI - V7 migration: plan upgrade requests
-- Run in Supabase SQL Editor (safe to re-run)
-- ============================================================
-- The billing page asks customers to request a paid plan instead of paying
-- online. Each request gets an order id that is emailed to the customer and to
-- the Chitra team, and is stored here as a record.

create table if not exists public.plan_requests (
  id bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id text not null unique,
  plan text not null check (plan in ('pro','agency')),
  full_name text,
  email text,
  phone text,
  message text,
  status text default 'new' check (status in ('new','contacted','won','lost')),
  created_at timestamptz default now()
);

create index if not exists plan_requests_org_idx
  on public.plan_requests(organization_id, created_at desc);

alter table public.plan_requests enable row level security;

-- A tenant can read its own upgrade requests (the platform team uses the
-- service role, which bypasses RLS, to see all of them).
drop policy if exists "plan_requests_org_select" on public.plan_requests;
create policy "plan_requests_org_select" on public.plan_requests
  for select using (organization_id = public.current_user_org_id());