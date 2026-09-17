-- BillFighter — approval + send flow (migration 003)
--
-- Supports the two-human approval invariant (spec: nothing leaves without both
-- user and staff approval in Phase 1) and the outbound dispatch job:
--
--   user_approved_at / staff_approved_at — each of the two required approvals,
--     recorded individually and immutably from the UI path (column grants
--     below let a user session touch ONLY their own approval).
--   approved_by — WHO completed the two-approval gate: the role whose approval
--     flipped the action to 'approved' ('user' | 'staff'; 'auto' stays
--     reserved for the later autopilot phase).
--   send_attempts / next_attempt_at / last_error — the retry ledger. A failed
--     send retries with exponential backoff while status stays 'approved';
--     after MAX_SEND_ATTEMPTS failures the action parks at 'failed' with the
--     error attached — visible in the staff queue, never silently dropped,
--     never silently repeated.

alter table actions
  add column user_approved_at timestamptz,
  add column staff_approved_at timestamptz,
  add column send_attempts integer not null default 0,
  add column next_attempt_at timestamptz,
  add column last_error text;

-- The dispatcher's due query: approved actions whose next retry is due
-- (next_attempt_at is null for actions never yet attempted).
create index actions_outbound_due_idx on actions (next_attempt_at)
  where status = 'approved';

-- ---------------------------------------------------------------------------
-- Column-level grants: a user session may record ONLY its own approval.
-- 001's table-level UPDATE would otherwise let a user approve the staff gate
-- themselves (set staff_approved_at / status = 'approved') — defeating the
-- two-human invariant at the database layer. Staff keep full access; the
-- service role (approval + dispatch jobs) bypasses RLS and is unaffected.
-- ---------------------------------------------------------------------------
revoke update on actions from authenticated;
grant update (user_approved_at) on actions to authenticated;
