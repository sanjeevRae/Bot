-- ============================================================
-- Chitra AI — Admin & Quota Extension Migration
-- Run this in Supabase SQL Editor (after schema.sql)
-- ============================================================

-- User roles: 'owner' (normal business user) | 'admin' (platform admin)
alter table public.profiles
  add column if not exists role text not null default 'owner';

-- Per-org custom monthly message quota.
-- NULL = use the platform free-tier default (QUOTA_MESSAGES_PER_MONTH).
-- Admins set this to extend AI usage for specific clients.
alter table public.organizations
  add column if not exists monthly_message_quota int;

-- ------------------------------------------------------------
-- Promote your account to platform admin:
-- update public.profiles set role = 'admin' where email = 'you@example.com';
-- ------------------------------------------------------------
