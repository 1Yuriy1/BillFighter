-- BillFighter — email intake (migration 002)
--
-- Supports the /api/inbound Postmark webhook (lib/intake/, app/(intake)/api/inbound):
--
--   intake_emails — one row per processed inbound email, keyed by Postmark's
--     MessageID. Postmark delivers webhooks at-least-once (it retries on any
--     non-200), so the unique message_id is the idempotency gate: a replayed
--     webhook is a no-op instead of a second copy of every attachment.
--
--   orphan_emails — mail whose recipients match no user alias and no case
--     reply address. Parked here with a status instead of being dropped; the
--     staff console (later in Phase 1) works the 'pending' queue.
--
-- RLS posture matches 001_init.sql: users get nothing here (the orphan queue
-- is staff-only surface), staff can read both tables and work the queue.
-- The webhook itself writes through the server-side service connection,
-- which bypasses RLS.

create table intake_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text unique not null,      -- Postmark MessageID (delivery dedup)
  routing text not null check (routing in ('alias', 'case_reply')),
  user_id uuid references users(id),
  case_id uuid references cases(id),
  created_at timestamptz default now()
);

create table orphan_emails (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'dismissed')),
  message_id text unique,               -- Postmark MessageID (delivery dedup)
  from_email text,
  recipients text not null,             -- every address this mail was sent to
  subject text,
  reason text not null,                 -- unknown_alias | unknown_case_address | ambiguous_case_address
  raw_payload jsonb not null,           -- the full Postmark inbound payload, verbatim
  created_at timestamptz default now()
);

create index orphan_emails_status_idx on orphan_emails (status, created_at desc);

-- Staff: read everything, work the orphan queue (claim/dismiss = status update).
alter table intake_emails enable row level security;
alter table orphan_emails enable row level security;

create policy intake_emails_staff_select on intake_emails
  for select to staff
  using (true);

create policy orphan_emails_staff_select on orphan_emails
  for select to staff
  using (true);

create policy orphan_emails_staff_update on orphan_emails
  for update to staff
  using (true)
  with check (true);

grant select on intake_emails to staff;
grant select, update on orphan_emails to staff;
