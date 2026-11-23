-- =====================================================================
-- Migration V16 — Database security hardening (2026-11-23)
-- =====================================================================
-- STATUS: PREPARED, NOT APPLIED. Apply manually in the Supabase SQL Editor
-- (or psql as the postgres role) AFTER reviewing this file and running the
-- read-only checks in backend/tests/db-security-verification.sql.
--
-- Why this migration exists
-- -------------------------
-- The Phase-0 audit found that the RLS policies in schema.sql are row-level
-- only: with the default Supabase grants, ANY signed-in user could call the
-- PostgREST API directly and UPDATE their own profiles row (setting
-- role='admin') or their own organizations row (setting plan='agency',
-- monthly_message_quota, plan_expires_at, parent_org_id) — full privilege
-- and billing escalation that bypasses the backend entirely. A table-level
-- UPDATE grant makes column-level REVOKEs ineffective, so this migration
-- revokes the broad grants FIRST and then adds a guard trigger as a second
-- layer.
--
-- Why this is safe for the application
-- ------------------------------------
-- Verified 2026-11-23: the frontend uses Supabase Auth only — it performs
-- NO direct table reads or writes (zero .from()/.rpc() calls). Every data
-- operation goes through the backend's service-role client, which bypasses
-- RLS and table grants. The signup trigger (handle_new_user) is SECURITY
-- DEFINER and unaffected. Nothing legitimate uses anon/authenticated
-- direct table writes.
--
-- What changes
-- ------------
--  1. anon:          ALL privileges on public tables revoked.
--  2. authenticated: INSERT/UPDATE/DELETE (and TRUNCATE/REFERENCES/TRIGGER)
--                    revoked on public tables. SELECT remains, still gated
--                    row-by-row by the existing RLS policies.
--  3. Guard trigger: even if write grants are ever re-added, the sensitive
--                    columns (profiles.role / organization_id /
--                    is_platform_admin; organizations.plan / plan_expires_at
--                    / monthly_message_quota / parent_org_id / payment_*)
--                    cannot be changed by anon/authenticated callers.
--  4. Functions:     EXECUTE revoked from anon on all public functions;
--                    create_client_org (SECURITY DEFINER) restricted to
--                    service_role; policy helper + match functions granted
--                    to authenticated explicitly.
--  5. Default privileges tightened so future tables don't silently reopen
--     the hole (applies to objects created by the executing role).
--
-- Rollback: see the commented ROLLBACK section at the bottom.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) Anonymous role: no direct table access at all.
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------
-- 2) Authenticated role: revoke broad write grants FIRST (a column-level
--    revoke cannot override a table-level grant — the broad grant has to
--    go), keep reads (RLS still decides which rows).
-- ---------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from authenticated;

-- ---------------------------------------------------------------------
-- 3) Guard trigger on the sensitive columns (defence in depth).
--    Fires for direct PostgREST callers (anon/authenticated). The backend
--    (service_role), the postgres owner and SECURITY DEFINER functions are
--    unaffected.
-- ---------------------------------------------------------------------
create or replace function public.guard_sensitive_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_table_name = 'profiles' then
      if new.role is distinct from old.role
         or new.organization_id is distinct from old.organization_id
         or new.is_platform_admin is distinct from old.is_platform_admin then
        raise exception 'profiles: role, organization_id and is_platform_admin can only be changed by the backend';
      end if;
    elsif tg_table_name = 'organizations' then
      if new.plan is distinct from old.plan
         or new.plan_expires_at is distinct from old.plan_expires_at
         or new.monthly_message_quota is distinct from old.monthly_message_quota
         or new.parent_org_id is distinct from old.parent_org_id
         or new.payment_status is distinct from old.payment_status
         or new.payment_method is distinct from old.payment_method
         or new.payment_reference is distinct from old.payment_reference
         or new.billing_cycle_start is distinct from old.billing_cycle_start then
        raise exception 'organizations: plan, quota, parent and payment fields can only be changed by the backend';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profiles on public.profiles;
create trigger trg_guard_profiles
  before update on public.profiles
  for each row execute function public.guard_sensitive_columns();

drop trigger if exists trg_guard_organizations on public.organizations;
create trigger trg_guard_organizations
  before update on public.organizations
  for each row execute function public.guard_sensitive_columns();

-- ---------------------------------------------------------------------
-- 4) Function privileges.
-- ---------------------------------------------------------------------
-- 4a. anon gets no function execution in the public schema.
do $$
declare r record;
begin
  for r in
    select oid::regprocedure as sig
    from pg_proc
    where pronamespace = 'public'::regnamespace
  loop
    execute format('revoke execute on function %s from anon', r.sig);
  end loop;
end $$;

-- 4b. Policy helpers must stay executable by authenticated (RLS policies
--     call them), and by service_role.
grant execute on function public.current_user_org_id() to authenticated, service_role;
grant execute on function public.current_user_is_agency() to authenticated, service_role;

-- 4c. Vector-search RPCs: backend (service_role) + authenticated (whose
--     rows remain RLS-gated — the functions are SECURITY INVOKER).
do $$
declare r record;
begin
  for r in
    select oid::regprocedure as sig
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('match_document_sections', 'match_document_sections_keyword', 'match_document_sections_scoped')
  loop
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;

-- 4d. create_client_org is SECURITY DEFINER and creates organizations:
--     restrict it to the service role. (The backend does not call it — the
--     agency routes perform the inserts directly — so nothing breaks.)
revoke execute on function public.create_client_org(text) from public, anon, authenticated;
grant execute on function public.create_client_org(text) to service_role;

-- ---------------------------------------------------------------------
-- 5) Future objects: don't silently re-grant what was just revoked.
--    (Default privileges apply per creating role; run this migration as
--    postgres, which is the role migrations run under.)
-- ---------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from authenticated;

commit;

-- =====================================================================
-- ROLLBACK (run manually if the hardening must be undone)
-- =====================================================================
-- begin;
-- grant select, insert, update, delete on all tables in schema public to anon, authenticated;
-- grant execute on all functions in schema public to anon, authenticated;
-- drop trigger if exists trg_guard_profiles on public.profiles;
-- drop trigger if exists trg_guard_organizations on public.organizations;
-- commit;
-- Note: rollback restores the ORIGINAL (vulnerable) grant posture on
-- purpose — only use it while diagnosing a breakage, and re-apply V16
-- immediately after.
