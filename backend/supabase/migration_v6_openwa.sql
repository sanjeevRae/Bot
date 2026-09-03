-- ============================================================
-- Chitra AI — V6 migration: OpenWA WhatsApp connections
-- Maps a self-hosted OpenWA session to exactly one Chitra organization.
-- Run once in the Supabase SQL Editor (safe to re-run).
-- provider = 'openwa' identifies the self-hosted WhatsApp gateway.
-- ============================================================

create table if not exists public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'openwa' check (provider in ('openwa')),
  openwa_session_id text not null,
  phone_number text,
  status text not null default 'disconnected' check (status in ('connected','disconnected','error')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One OpenWA connection per organization (upsert semantics in the backend).
create unique index if not exists whatsapp_connections_org_idx
  on public.whatsapp_connections(organization_id);

-- Fast lookup of the owning org from an inbound webhook's session id.
create index if not exists whatsapp_connections_session_idx
  on public.whatsapp_connections(openwa_session_id);

-- SECURITY: one WhatsApp session may belong to exactly one organization.
-- (Prevents the same OpenWA session from being claimed by a second org.)
create unique index if not exists whatsapp_connections_session_unique_idx
  on public.whatsapp_connections(openwa_session_id);

alter table public.whatsapp_connections enable row level security;

drop policy if exists "whatsapp_connections_org_all" on public.whatsapp_connections;
create policy "whatsapp_connections_org_all" on public.whatsapp_connections
  for all using (organization_id = public.current_user_org_id())
  with check (organization_id = public.current_user_org_id());
