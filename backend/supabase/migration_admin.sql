-- ============================================================
-- Chitra AI — Admin & Quota Extension Migration
-- Run this in Supabase SQL Editor (after schema.sql)
-- ============================================================

-- User roles: 'owner' (normal business user) | 'admin' (platform admin)
alter table public.profiles
  add column if not exists role text not null default 'owner';

-- Per-org custom message allowance.
-- NULL = use the platform free allowance (QUOTA_MESSAGES_TOTAL), which is a
-- one-time (lifetime) allowance for free orgs and a monthly one for paid orgs.
-- Admins set this to extend AI usage for specific clients.
alter table public.organizations
  add column if not exists monthly_message_quota int;

-- ------------------------------------------------------------
-- Promote your account to platform admin:
-- update public.profiles set role = 'admin' where email = 'you@example.com';
-- ------------------------------------------------------------
