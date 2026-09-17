-- BillFighter — source-of-truth schema (Phase 1 MVP, migration 001)
--
-- Implements the MVP spec's data model: six tables (users, cases, documents,
-- findings, actions, events) with check-constrained enums, actions.citations
-- jsonb for the traceability invariant, row-level security scoping every row
-- to its owner via a separate `staff` role, and audit triggers that write an
-- `events` row on every case-scoped mutation.
--
-- Supabase-compatible: applies cleanly to plain Postgres 13+ and to Supabase.
-- The auth.* helpers below are created ONLY when missing, so a real Supabase
-- `auth` schema is never modified.

-- ---------------------------------------------------------------------------
-- Roles: `authenticated` (families) and `staff` (separate role — staff access
-- is granted via role membership + policies, never a shared key). Guarded so
-- they are created only when missing (Supabase ships `authenticated`).
-- ---------------------------------------------------------------------------
do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'staff') then
    create role staff nologin noinherit;
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- auth.uid() / auth.role() shims — mirror Supabase's helpers, which resolve
-- the JWT claims PostgREST sets on a connection. Created only when missing.
-- ---------------------------------------------------------------------------
do $do$
begin
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'auth') then
    create schema auth;
  end if;
end
$do$;

do $do$
begin
  if to_regprocedure('auth.uid()') is null then
    create function auth.uid() returns uuid
    language sql stable
    as $fn$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $fn$;
    grant execute on function auth.uid() to authenticated, staff;
  end if;
end
$do$;

do $do$
begin
  if to_regprocedure('auth.role()') is null then
    create function auth.role() returns text
    language sql stable
    as $fn$
      select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
    $fn$;
    grant execute on function auth.role() to authenticated, staff;
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- Tables — the spec's DDL, verbatim.
-- ---------------------------------------------------------------------------

create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  full_name text,
  inbound_alias text unique,           -- jane.k82@in.billfighter.com
  authorization_signed_at timestamptz, -- gate: no outbound action before this
  stripe_customer_id text,
  created_at timestamptz default now()
);

create table cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  status text default 'intake' check (status in (
    'intake','analyzing','awaiting_approval',
    'in_progress','waiting_reply','resolved','closed')),
  provider_name text,
  insurer_name text,
  amount_disputed numeric,
  amount_saved numeric,
  next_deadline date,
  created_at timestamptz default now()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references cases(id),
  doc_type text check (doc_type in
    ('bill','itemized','eob','denial','plan','reply','other')),
  file_path text,                      -- encrypted storage path
  extracted jsonb,
  created_at timestamptz default now()
);

create table findings (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references cases(id),
  kind text,        -- duplicate | price_outlier | nsa_protected | weak_denial | ...
  description text,
  estimated_savings numeric,
  confidence text check (confidence in ('high','medium','low')),
  source text check (source in ('rule','ai')),
  created_at timestamptz default now()
);

create table actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references cases(id),
  channel text check (channel in ('email','fax','mail','call','portal')),
  recipient text,
  subject text,
  body text,
  citations jsonb,    -- [{claim, document_id, field}] — traceability invariant
  status text default 'draft' check (status in
    ('draft','approved','sent','failed','superseded')),
  approved_by text,   -- 'user' | 'staff' | 'auto'
  sent_at timestamptz,
  follow_up_at timestamptz,
  created_at timestamptz default now()
);

create table events (                 -- case timeline + audit log
  id bigserial primary key,
  case_id uuid references cases(id),
  actor text check (actor in ('agent','staff','user','system')),
  message text,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (additive to the spec's DDL — FK lookups and the case timeline).
-- ---------------------------------------------------------------------------
create index cases_user_id_idx on cases (user_id);
create index documents_case_id_idx on documents (case_id);
create index findings_case_id_idx on findings (case_id);
create index actions_case_id_idx on actions (case_id);
create index actions_case_status_idx on actions (case_id, status);
create index events_case_id_created_at_idx on events (case_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Audit: every mutation of a case-scoped table writes an `events` row.
-- Runs as SECURITY DEFINER so the audit write succeeds regardless of the
-- session's own RLS grants — the trail cannot be skipped or suppressed.
-- Actor is derived from the JWT claims: staff claim -> staff, authenticated
-- subject -> user, otherwise system (service role / triggers).
-- ---------------------------------------------------------------------------
create or replace function public.audit_case_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row jsonb;
  v_case_id uuid;
  v_actor text;
begin
  -- Serialize once and pull the case id out of jsonb: plpgsql must type both
  -- branches of a CASE when planning, so `new.case_id` cannot be referenced on
  -- the `cases` table (no such field). jsonb extraction degrades gracefully —
  -- missing keys are just null.
  v_row := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_case_id := coalesce(
    nullif(v_row ->> 'case_id', ''),
    nullif(v_row ->> 'id', '')
  )::uuid;

  if v_case_id is not null then
    -- Staff either carries the 'staff' claim (Supabase JWT) or the session's
    -- effective role is 'staff' (SET ROLE). The role GUC survives the SECURITY
    -- DEFINER switch; current_user would not.
    v_actor := case
      when auth.role() = 'staff' or coalesce(current_setting('role', true), '') = 'staff'
        then 'staff'
      when auth.uid() is not null then 'user'
      else 'system'
    end;

    insert into events (case_id, actor, message)
    values (v_case_id, v_actor, tg_table_name || ' ' || lower(tg_op));
  end if;

  return coalesce(new, old);
end;
$fn$;

create trigger audit_cases after insert or update or delete on cases
  for each row execute function public.audit_case_mutation();

create trigger audit_documents after insert or update or delete on documents
  for each row execute function public.audit_case_mutation();

create trigger audit_findings after insert or update or delete on findings
  for each row execute function public.audit_case_mutation();

create trigger audit_actions after insert or update or delete on actions
  for each row execute function public.audit_case_mutation();

-- ---------------------------------------------------------------------------
-- Row-level security: every row scoped to its user_id. Child tables
-- (documents, findings, actions, events) scope through their case's owner.
-- Staff get full access via the separate `staff` role. Users may not delete
-- anything (cases close; actions supersede) and may not write `events`
-- (the audit trail is append-only, written by triggers).
-- ---------------------------------------------------------------------------
alter table users enable row level security;
alter table cases enable row level security;
alter table documents enable row level security;
alter table findings enable row level security;
alter table actions enable row level security;
alter table events enable row level security;

-- users — a user sees exactly their own profile.
create policy users_select_own on users
  for select to authenticated
  using (id = auth.uid());

create policy users_insert_own on users
  for insert to authenticated
  with check (id = auth.uid());

create policy users_update_own on users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy users_staff_all on users
  for all to staff
  using (true)
  with check (true);

-- cases
create policy cases_select_own on cases
  for select to authenticated
  using (user_id = auth.uid());

create policy cases_insert_own on cases
  for insert to authenticated
  with check (user_id = auth.uid());

create policy cases_update_own on cases
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy cases_staff_all on cases
  for all to staff
  using (true)
  with check (true);

-- documents — readable/uploadable by the case owner; writes by the agent
-- (extraction) go through the service role.
create policy documents_select_own on documents
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = documents.case_id and c.user_id = auth.uid()
    )
  );

create policy documents_insert_own on documents
  for insert to authenticated
  with check (
    exists (
      select 1 from cases c
      where c.id = documents.case_id and c.user_id = auth.uid()
    )
  );

create policy documents_staff_all on documents
  for all to staff
  using (true)
  with check (true);

-- findings — produced by rules/AI, reviewed by staff; users read only.
create policy findings_select_own on findings
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = findings.case_id and c.user_id = auth.uid()
    )
  );

create policy findings_staff_all on findings
  for all to staff
  using (true)
  with check (true);

-- actions — users see drafts and record approvals; creating/sending is the
-- agent's job (service role), deleting is never allowed (supersede instead).
create policy actions_select_own on actions
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = actions.case_id and c.user_id = auth.uid()
    )
  );

create policy actions_update_own on actions
  for update to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = actions.case_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from cases c
      where c.id = actions.case_id and c.user_id = auth.uid()
    )
  );

create policy actions_staff_all on actions
  for all to staff
  using (true)
  with check (true);

-- events — the audit log is readable by the case owner, writable only by the
-- audit trigger (as owner) and staff.
create policy events_select_own on events
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = events.case_id and c.user_id = auth.uid()
    )
  );

create policy events_staff_all on events
  for all to staff
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- Grants — RLS is the boundary; these are the doors.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, staff;

grant select, insert, update on users to authenticated;
grant select, insert, update on cases to authenticated;
grant select, insert on documents to authenticated;
grant select on findings to authenticated;
grant select, update on actions to authenticated;
grant select on events to authenticated;

grant select, insert, update, delete on
  users, cases, documents, findings, actions, events
  to staff;

grant usage, select on all sequences in schema public to authenticated, staff;
