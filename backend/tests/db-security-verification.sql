-- =====================================================================
-- Database security verification — Chitra AI (companion to migration V16)
-- =====================================================================
-- HOW TO USE
--   Part 1 (read-only): run in the Supabase SQL Editor BEFORE applying V16
--     to see the current posture, and again AFTER to confirm the change.
--   Part 2 (write attempts): run ONLY against a scratch/staging project —
--     never production — inside a transaction that is rolled back. Each
--     statement is expected to FAIL after V16 (permission denied / guard
--     exception). Replace the two placeholder UUIDs with real test rows
--     from the scratch project.
--
-- This file was NOT executed against production during the 2026-11-23
-- hardening (read-only rules). Results are therefore NOT TESTED live.
-- =====================================================================

-- ============================ PART 1 =================================
-- 1a. Live RLS policies on the sensitive tables
select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename in ('profiles', 'organizations', 'settings')
order by tablename, policyname;

-- 1b. Table grants for the client roles.
--     BEFORE V16: expect UPDATE/INSERT/DELETE rows for authenticated.
--     AFTER  V16: authenticated keeps SELECT only; anon has nothing.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated')
  and table_schema = 'public'
order by table_name, grantee, privilege_type;

-- 1c. Column-level grants (informational — remember a column REVOKE does
--     NOT override a table-level grant; 1b is the decisive check).
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where grantee in ('anon', 'authenticated')
  and table_name in ('profiles', 'organizations')
order by table_name, column_name;

-- 1d. Who can execute the SECURITY DEFINER agency function?
select has_function_privilege('anon', 'public.create_client_org(text)', 'execute')          as anon_can_create_client_org,
       has_function_privilege('authenticated', 'public.create_client_org(text)', 'execute') as auth_can_create_client_org,
       has_function_privilege('service_role', 'public.create_client_org(text)', 'execute')  as service_can_create_client_org;
--     AFTER V16: anon=false, authenticated=false, service_role=true.

-- 1e. Guard triggers present?
select tgname, tgrelid::regclass as table_name
from pg_trigger
where tgname in ('trg_guard_profiles', 'trg_guard_organizations');

-- ============================ PART 2 =================================
-- Scratch project only. Replace:
--   <TEST_USER_ID>  — a normal user's auth.users id (their profiles row)
--   <TEST_ORG_ID>   — that user's organization id
--
-- begin;
-- set local role authenticated;
-- select set_config('request.jwt.claims',
--   '{"sub":"<TEST_USER_ID>","role":"authenticated"}', true);
--
-- -- T1 role escalation — MUST FAIL after V16
-- update public.profiles set role = 'admin' where id = '<TEST_USER_ID>';
--
-- T2 plan escalation — MUST FAIL after V16
-- update public.organizations set plan = 'agency' where id = '<TEST_ORG_ID>';
--
-- T3 quota manipulation — MUST FAIL after V16
-- update public.organizations set monthly_message_quota = 999999 where id = '<TEST_ORG_ID>';
--
-- T4 cross-tenant read — MUST return 0 rows (RLS, true before and after V16)
-- select * from public.organizations where id <> '<TEST_ORG_ID>';
--
-- T5 privileged RPC — MUST FAIL after V16
-- select public.create_client_org('Escalation Test Co');
--
-- rollback;
--
-- Anonymous checks (no JWT): as the anon role, every select from
-- profiles/organizations/settings/documents MUST fail or return 0 rows:
-- set local role anon;
-- select * from public.organizations limit 1;
