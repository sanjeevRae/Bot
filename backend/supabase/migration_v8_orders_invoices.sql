-- ============================================================
-- Chitra AI - V8 migration: order workflow + invoices
-- Run in Supabase SQL Editor (safe to re-run)
-- ============================================================

-- ---------- 1) plan_requests: order workflow ----------
create table if not exists public.plan_requests (
  id bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id text not null unique,
  plan text not null check (plan in ('pro','agency')),
  full_name text,
  email text,
  phone text,
  message text,
  status text default 'received',
  created_at timestamptz default now()
);

alter table public.plan_requests add column if not exists amount_npr int;
alter table public.plan_requests add column if not exists admin_notes text;
alter table public.plan_requests add column if not exists updated_at timestamptz;

-- Drop the old vocabulary FIRST. Moving rows onto the new labels while the
-- old constraint is still in force fails with 23514.
alter table public.plan_requests drop constraint if exists plan_requests_status_check;
alter table public.plan_requests alter column status set default 'received';

-- move any old labels onto the team's vocabulary
update public.plan_requests set status = case status
  when 'new' then 'received'
  when 'contacted' then 'pending'
  when 'won' then 'completed'
  when 'lost' then 'cancelled'
  else status end
where status in ('new','contacted','won','lost');

-- nothing unexpected may block the new constraint
update public.plan_requests set status = 'received'
where status is null or status not in ('received','pending','completed','cancelled');

alter table public.plan_requests add constraint plan_requests_status_check
  check (status in ('received','pending','completed','cancelled'));

create index if not exists plan_requests_status_idx
  on public.plan_requests(status, created_at desc);

-- ---------- 2) Issuer details printed on invoices (single row) ----------
create table if not exists public.billing_profile (
  id int primary key default 1 check (id = 1),
  company_name text default 'Chitra Tech',
  address text,
  phone text,
  email text,
  website text,
  reg_no text,
  tpin text,
  pan_no text,
  logo_url text,
  payment_qr_url text,
  payment_instructions text,
  bank_details text,
  signature_url text,
  stamp_url text,
  footer_note text default 'This is a computer-generated invoice and does not require a physical signature.',
  thank_you text default 'Thank you for your business!',
  updated_at timestamptz default now()
);

insert into public.billing_profile (id, company_name, email, website, payment_instructions)
values (
  1,
  'Chitra Tech',
  'info@chitratech.com.np',
  'chitratech.com.np',
  'Pay by bank transfer or wallet and mention the invoice number as the payment reference.'
)
on conflict (id) do nothing;

-- ---------- 3) Invoices ----------
create table if not exists public.invoices (
  id bigserial primary key,
  organization_id uuid references public.organizations(id) on delete set null,
  plan_request_id bigint references public.plan_requests(id) on delete set null,
  invoice_no text not null unique,
  status text not null default 'draft'
    check (status in ('draft','sent','paid','cancelled')),
  copy_status text default 'Original',
  issue_date date,
  transaction_date date,
  reprint_date date,
  due_date date,
  company jsonb not null default '{}'::jsonb,
  customer jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  subtotal numeric(12,2) default 0,
  discount numeric(12,2) default 0,
  service_charge numeric(12,2) default 0,
  total numeric(12,2) default 0,
  total_in_words text,
  payment_mode text,
  payment_ref text,
  notes text,
  terms text,
  sent_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists invoices_org_idx on public.invoices(organization_id, created_at desc);

-- ---------- 4) Row level security ----------
alter table public.plan_requests enable row level security;
alter table public.invoices enable row level security;
alter table public.billing_profile enable row level security;

-- A tenant can read its own orders and invoices. The platform team uses the
-- service role, which bypasses RLS, so it sees everything.
drop policy if exists "plan_requests_org_select" on public.plan_requests;
create policy "plan_requests_org_select" on public.plan_requests
  for select using (organization_id = public.current_user_org_id());

drop policy if exists "invoices_org_select" on public.invoices;
create policy "invoices_org_select" on public.invoices
  for select using (organization_id = public.current_user_org_id());