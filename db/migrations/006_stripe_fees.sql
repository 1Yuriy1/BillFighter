-- BillFighter — Stripe success-fee flow (migration 006)
--
-- Supports lib/billing/ (spec Architecture, fee model): when a case resolves,
-- staff confirm the savings by attaching a proof document (the new bill or
-- EOB showing the corrected amount), and the system charges the success fee —
-- min(15% of confirmed savings, $500 cap) — against the Stripe customer the
-- family saved a card on at signup (users.stripe_customer_id, migration 001).
--
--   savings_proofs — the staff confirmation record. proof_document_id is NOT
--     NULL and must be a bill/eob on the same case: at the database level a
--     confirmation is unrepresentable without its proof document, and at the
--     code level (lib/billing/charge.ts) a charge is unrepresentable without
--     a confirmation. Two independent gates on the same invariant.
--
--   payments — one fee charge per case. fee_cents is the integer Stripe
--     amount (smallest currency unit); the numeric columns keep the display
--     dollars. The partial unique index (case_id where status <> 'failed')
--     is the structural no-double-charge guarantee: a retry after a failure
--     may create a new row, but a pending or succeeded charge makes any
--     second live charge impossible.
--
--   receipt_line_items — the receipt the family sees: disputed amount,
--     confirmed savings, fee, in that order, so the math travels with the
--     charge record even after Stripe's own receipt ages out of view.
--
-- RLS posture matches 001–005: families read their own payment and receipt
-- rows (scoped through the case's owner); staff read everything; there are
-- no insert/update policies for families — confirming savings and charging
-- are staff+service actions. Writes go through the service connection,
-- which bypasses RLS. The audit trigger from migration 001 picks payments
-- up automatically (case_id column) — every charge lands on the timeline.

-- Who confirmed the savings. The corrected amount lives on the proof
-- document itself; staff enter the confirmed savings figure they verified
-- against it.
create table savings_proofs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id),
  document_id uuid not null references documents(id),
  doc_kind text not null check (doc_kind in ('new_bill', 'eob')),
  confirmed_savings numeric not null check (confirmed_savings >= 0),
  confirmed_by text,
  note text,
  created_at timestamptz default now()
);

-- The fee charge. proof_document_id is NOT NULL on purpose — see header.
create table payments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id),
  user_id uuid references users(id),
  proof_document_id uuid not null references documents(id),
  -- Snapshot at charge time, in display dollars (cases.amount_disputed at
  -- confirmation, the staff-confirmed savings, the computed fee).
  disputed_amount numeric not null,
  confirmed_savings numeric not null,
  fee_amount numeric not null,
  -- Stripe amount: integer cents, exactly what the API was called with.
  fee_cents integer not null check (fee_cents > 0),
  currency text not null default 'usd',
  status text not null default 'pending' check (status in
    ('pending','succeeded','failed')),
  stripe_charge_id text,               -- pi_... when the gateway accepted it
  receipt_url text,                    -- Stripe-hosted receipt, when available
  error_message text,                  -- gateway failure detail (failed only)
  created_at timestamptz default now()
);

-- At most one live (pending or succeeded) charge per case. A failed charge
-- releases the slot so the flow can retry.
create unique index payments_case_live_idx on payments (case_id)
  where status <> 'failed';

create index savings_proofs_case_idx on savings_proofs (case_id, created_at desc);
create index payments_case_idx on payments (case_id, created_at desc);

create table receipt_line_items (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id),
  -- disputed | savings | fee — the receipt shows the math in this order.
  kind text not null check (kind in ('disputed','savings','fee')),
  label text not null,                 -- human text incl. the cap note when capped
  amount numeric not null,             -- display dollars (fee row: the charged fee)
  created_at timestamptz default now()
);

create index receipt_line_items_payment_idx on receipt_line_items (payment_id);

-- ---------------------------------------------------------------------------
-- Row-level security: families read their own payments, proofs, and receipt
-- line items through the case's owner; staff read everything. No family
-- writes — the charge flow runs on the service connection.
-- ---------------------------------------------------------------------------

alter table savings_proofs enable row level security;
alter table payments enable row level security;
alter table receipt_line_items enable row level security;

create policy savings_proofs_user_select on savings_proofs
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = savings_proofs.case_id and c.user_id = auth.uid()
    )
  );

create policy savings_proofs_staff_select on savings_proofs
  for select to staff
  using (true);

create policy payments_user_select on payments
  for select to authenticated
  using (
    exists (
      select 1 from cases c
      where c.id = payments.case_id and c.user_id = auth.uid()
    )
  );

create policy payments_staff_select on payments
  for select to staff
  using (true);

create policy receipt_line_items_user_select on receipt_line_items
  for select to authenticated
  using (
    exists (
      select 1
      from payments p
      join cases c on c.id = p.case_id
      where p.id = receipt_line_items.payment_id and c.user_id = auth.uid()
    )
  );

create policy receipt_line_items_staff_select on receipt_line_items
  for select to staff
  using (true);

-- Families may read only. Staff read everything; the service connection
-- bypasses RLS for the writes.
grant select on savings_proofs to authenticated, staff;
grant select on payments to authenticated, staff;
grant select on receipt_line_items to authenticated, staff;
