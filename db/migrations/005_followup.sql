-- BillFighter — follow-up engine (migration 005)
--
-- Supports the Inngest jobs in lib/followup/ (deadline tiers + reply
-- classification):
--
--   users.notification_level / users.automated_messages_paused_at — the
--     family's email preferences, as asked by NotificationLevelPicker and
--     PauseAllMessagesSwitch. Both jobs read them before anything
--     user-facing goes out; staff-facing escalation is unaffected (an
--     escalation is how staff learns the family needs help, pause included).
--     These columns are shared with the console migration (004_consoles.sql,
--     identical definitions): the adds use `if not exists`, so this file
--     creates them on a main without the console PR and no-ops once
--     004_consoles.sql has run (it sorts first in the name-order chain).
--
--   notifications — the idempotency ledger for outbound notifications.
--     dedup_key is the gate (same pattern as intake_emails.message_id): a
--     re-run of a job that would notify again for an already-recorded
--     (tier, case, deadline) or (reply, outcome) is a no-op instead of a
--     second copy to the family.
--
--   reply_classifications — one row per classified reply document. The
--     unique document_id both records the outcome and gates re-runs: a
--     reply is classified exactly once, whatever the job cadence.
--
-- RLS posture matches 001–003: family rows are readable by their owner,
-- staff read everything, and the jobs write through the service connection,
-- which bypasses RLS. There are no insert/update policies — no user session
-- can forge a notification or a classification.

alter table users
  add column if not exists notification_level text not null default 'everything'
    check (notification_level in ('everything', 'action_needed')),
  add column if not exists automated_messages_paused_at timestamptz;

create table notifications (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references cases(id),
  user_id uuid references users(id),
  kind text not null check (kind in ('deadline_tier', 'reply_outcome')),
  tier text check (tier in ('notify', 'escalate', 'urgent')),
  outcome text check (outcome in
    ('resolved', 'partial_win', 'needs_info', 'denied_again', 'irrelevant')),
  audience text not null check (audience in ('user', 'staff')),
  subject text,
  body text,
  dedup_key text unique not null,       -- the idempotency gate
  created_at timestamptz default now(),
  -- A row is one of the two kinds, never a blend: deadline tiers carry a
  -- tier, reply outcomes carry an outcome.
  constraint notifications_kind_shape check (
    (kind = 'deadline_tier' and tier is not null and outcome is null)
    or (kind = 'reply_outcome' and tier is null and outcome is not null)
  )
);

create table reply_classifications (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique references documents(id),
  case_id uuid references cases(id),
  outcome text not null check (outcome in
    ('resolved', 'partial_win', 'needs_info', 'denied_again', 'irrelevant')),
  created_at timestamptz default now()
);

-- The jobs' scans: live deadlines inside the notify horizon, and the
-- classification ledger by document.
create index notifications_case_idx on notifications (case_id, created_at desc);
create index reply_classifications_case_idx on reply_classifications (case_id);

-- Family: read their own notifications and the classifications on their
-- cases (visible as timeline entries). Staff: read everything.
alter table notifications enable row level security;
alter table reply_classifications enable row level security;

create policy notifications_user_select on notifications
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from cases c
      where c.id = notifications.case_id and c.user_id = auth.uid()
    )
  );

create policy notifications_staff_select on notifications
  for select to staff
  using (true);

create policy reply_classifications_user_select on reply_classifications
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = reply_classifications.case_id and c.user_id = auth.uid()
    )
  );

create policy reply_classifications_staff_select on reply_classifications
  for select to staff
  using (true);

grant select on notifications to authenticated, staff;
grant select on reply_classifications to authenticated, staff;
