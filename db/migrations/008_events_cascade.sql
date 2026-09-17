-- The events timeline is owned by its case: the FK already guarantees no
-- event outlives its case's existence, but without ON DELETE CASCADE a
-- case with any history cannot be deleted at all (the timeline's purpose
-- is to document a dispute that no longer exists once the case is gone).
-- Migrations 007 removed the broken audit triggers; this completes the
-- case-deletion story so admin/service deletions no longer fail with a
-- foreign-key violation on the case's own timeline.
alter table events
  drop constraint events_case_id_fkey,
  add constraint events_case_id_fkey
    foreign key (case_id) references cases(id) on delete cascade;
