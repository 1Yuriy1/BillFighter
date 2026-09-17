-- The case-mutation audit triggers (001_init.sql) wrote raw "<table> <op>"
-- rows into each case's events — the family-visible timeline — so every
-- status transition and document insert surfaced as noise next to the
-- meaningful entries the app writes explicitly (approvals, sends, savings,
-- fees). Worse, the cases-table trigger made every case deletion fail: its
-- AFTER DELETE audit insert referenced the case row being deleted and
-- violated events_case_id_fkey, so the deletion rolled back every time.
-- The app-level events are the audit trail; drop the triggers and their
-- now-unused function.
drop trigger if exists audit_cases on cases;
drop trigger if exists audit_documents on documents;
drop trigger if exists audit_findings on findings;
drop trigger if exists audit_actions on actions;
drop function if exists public.audit_case_mutation();
