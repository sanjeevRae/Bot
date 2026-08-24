-- ============================================================
-- Chitra AI — V4b: Agency multi-client management
-- Run in Supabase SQL Editor (safe to re-run)
-- ============================================================

-- ---------- Client orgs owned by an agency org ----------
alter table public.organizations
  add column if not exists parent_org_id uuid references public.organizations(id) on delete cascade;

create index if not exists organizations_parent_idx
  on public.organizations(parent_org_id);

-- Agencies can see their client orgs
drop policy if exists "org_select_client" on public.organizations;
create policy "org_select_client" on public.organizations
  for select using (parent_org_id = public.current_user_org_id());

-- ============================================================
-- Helper: is current user an agency?
-- ============================================================
create or replace function public.current_user_is_agency()
returns boolean as $$
  select exists (
    select 1 from public.organizations o
    where o.id = public.current_user_org_id()
      and o.plan = 'agency'
  );
$$ language sql security definer stable;

-- ============================================================
-- RPC: create a client org (agency only, enforced server-side too)
-- ============================================================
create or replace function public.create_client_org(client_name text)
returns uuid as $$
declare new_id uuid;
begin
  if not public.current_user_is_agency() then
    raise exception 'Only agency plans can create client workspaces';
  end if;

  insert into public.organizations (name, owner_user_id, parent_org_id, plan)
  values (client_name, auth.uid(), public.current_user_org_id(), 'pro')
  returning id into new_id;

  insert into public.settings (organization_id) values (new_id);

  return new_id;
end;
$$ language plpgsql security definer;
