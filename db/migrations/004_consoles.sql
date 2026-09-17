-- BillFighter — consoles (migration 004)
--
-- Supports the user dashboard and staff console (spec: "Consoles & payments"
-- and "Gentle-by-design communication"):

--
--   users.notification_level — per-family notification level
--     ('everything' | 'action_needed'), the "everything" vs "action needed +
--     resolved" preference. Stored on the family's row; consumed by the
--     notification sender when family-facing notifications are wired.
--
--   users.automated_messages_paused_at — the crisis switch. Non-null means
--     ALL automated messages for that family halt immediately: the dispatcher
--     skips the family's approved actions (they stay queued, nothing is
--     lost) and resume un-paused. Staff or the family can flip it; staff can
--     flip it for any family.
--
--   users.is_staff — marks the staff seat for the app's session layer (the
--     DB `staff` role remains the actual authorization boundary).
--
--   caregiver_grants — delegated access: one row per (family, caregiver)
--     pair. A caregiver session sees the family's cases through RLS via
--     has_family_access(); without a grant row, zero rows are visible.
--
--   documents.needs_human_review / review_reason — the persisted low-
--     confidence flag set at extraction time (math-check failure, OCR
--     confidence, invented-value hits). The staff console's low-confidence
--     queue reads it.
--
-- RLS posture: caregiver access is enforced at the database, not in app
-- code. The session's sub claim stays the logged-in user's own id; the
-- policies below widen what that session can see only while a grant row
-- exists, and the grant table itself is RLS-guarded.

alter table users
  add column notification_level text not null default 'everything'
    check (notification_level in ('everything', 'action_needed')),
  add column automated_messages_paused_at timestamptz,
  add column is_staff boolean not null default false;

alter table documents
  add column needs_human_review boolean not null default false,
  add column review_reason text;

create table caregiver_grants (
  id uuid primary key default gen_random_uuid(),
  family_user_id uuid not null references users(id) on delete cascade,
  caregiver_user_id uuid not null references users(id) on delete cascade,
  -- Denormalized for display: the sessions on either side of the grant
  -- cannot read each other's `users` row under RLS (users_select_own), so
  -- the human label is captured at grant time.
  family_email text not null,
  caregiver_email text not null,
  created_at timestamptz default now(),
  unique (family_user_id, caregiver_user_id),
  check (family_user_id <> caregiver_user_id)
);

create index caregiver_grants_caregiver_idx on caregiver_grants (caregiver_user_id);
create index caregiver_grants_family_idx on caregiver_grants (family_user_id);

-- Access helper: does the current session's user own this family account, or
-- hold a caregiver grant for it? Invoker-rights on purpose — the subquery on
-- caregiver_grants is evaluated under caregiver_grants' own RLS, so a
-- caregiver can only ever see grants that name them.
create function public.has_family_access(p_user_id uuid)
returns boolean
language sql
stable
as $fn$
  select p_user_id = auth.uid()
     or exists (
       select 1 from caregiver_grants g
       where g.family_user_id = p_user_id
         and g.caregiver_user_id = auth.uid()
     )
$fn$;

grant execute on function public.has_family_access(uuid) to authenticated, staff;

-- has_family_access is invoker-rights and calls auth.uid() in its body. Policy
-- expressions resolve auth.uid() by stored OID, but a nested SQL function's
-- body re-resolves at execution under the caller's privileges — which needs
-- USAGE on the auth schema (the 001 shim never granted it; nothing needed it
-- until a user-defined function referenced the shim).
grant usage on schema auth to authenticated, staff;

-- caregiver_grants RLS: the family manages its own grants; a caregiver reads
-- the grants that name them (that is how the dashboard renders the
-- "viewing as caregiver" banner); staff see all.
alter table caregiver_grants enable row level security;

create policy caregiver_grants_family_manage on caregiver_grants
  for all to authenticated
  using (family_user_id = auth.uid())
  with check (family_user_id = auth.uid());

create policy caregiver_grants_caregiver_select on caregiver_grants
  for select to authenticated
  using (caregiver_user_id = auth.uid());

create policy caregiver_grants_staff_all on caregiver_grants
  for all to staff
  using (true)
  with check (true);

grant select, insert, delete on caregiver_grants to authenticated;
grant select, insert, update, delete on caregiver_grants to staff;

-- Widen read/approve visibility to caregivers: the same policies as 001,
-- re-pointed at has_family_access. Writes that create or transition cases
-- stay owner-only (cases_insert_own / cases_update_own unchanged); a
-- caregiver may approve a draft (the delegated human act) but not create or
-- close cases.

drop policy cases_select_own on cases;
create policy cases_select_own on cases
  for select to authenticated
  using (has_family_access(user_id));

drop policy documents_select_own on documents;
create policy documents_select_own on documents
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = documents.case_id and has_family_access(c.user_id)
    )
  );

drop policy documents_insert_own on documents;
create policy documents_insert_own on documents
  for insert to authenticated
  with check (
    exists (
      select 1 from cases c
      where c.id = documents.case_id and has_family_access(c.user_id)
    )
  );

drop policy findings_select_own on findings;
create policy findings_select_own on findings
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = findings.case_id and has_family_access(c.user_id)
    )
  );

drop policy actions_select_own on actions;
create policy actions_select_own on actions
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = actions.case_id and has_family_access(c.user_id)
    )
  );

drop policy actions_update_own on actions;
create policy actions_update_own on actions
  for update to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = actions.case_id and has_family_access(c.user_id)
    )
  )
  with check (
    exists (
      select 1 from cases c
      where c.id = actions.case_id and has_family_access(c.user_id)
    )
  );

drop policy events_select_own on events;
create policy events_select_own on events
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = events.case_id and has_family_access(c.user_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Column grants — lock the doors 001 left open on users
-- ---------------------------------------------------------------------------
-- 001 granted authenticated table-wide UPDATE on users. With the new columns
-- that would let a family set their own is_staff flag, re-login, and be
-- handed the staff role (dev-login derives the role from is_staff). Reduce
-- the family-side write surface to exactly the two preference columns the
-- dashboard exposes; staff keeps full control of any row.
--
-- is_staff itself is service/seed-only (no grant to authenticated).

revoke update on users from authenticated;
grant update (notification_level, automated_messages_paused_at) on users to authenticated;

-- The staff console renders per-family rows with the pause switch and the
-- notification picker; the staff role already holds full users grants (001).

