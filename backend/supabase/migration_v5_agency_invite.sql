-- ============================================================
-- Chitra AI — V5: Agency client invites
-- Run in Supabase SQL Editor (safe to re-run)
-- ============================================================

-- Contact email of the invited client (shown in the agency Clients table)
alter table public.organizations
  add column if not exists contact_email text;