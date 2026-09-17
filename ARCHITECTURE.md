# Architecture

One Next.js app, six subsystems, one case pipeline:

```
INTAKE -> EXTRACT -> ANALYZE -> PLAN -> ACT -> TRACK -> RESOLVE
            ^                                    |
            +-------- replies re-enter ----------+
```

Every outbound action is human-approved (user + staff in Phase 1); every claim in a letter
traces to a document via `actions.citations`; every case-scoped mutation lands in `events`.

## Where things will live

| Subsystem           | Home                                               | Notes                                                                        |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Intake              | `app/(intake)/`, `lib/intake/`                     | Upload API, Postmark inbound webhook (`/api/inbound`), alias generator       |
| Extraction          | `lib/extract.ts`                                   | Strict-JSON Claude contract (`ExtractedDocument`), math check (`verifyMath`) |
| Analysis            | `lib/rules.ts`, `lib/analyze.ts`                   | Deterministic rules + AI analyst; findings carry source/confidence           |
| Actions & letters   | `lib/actions/`, `components/actions/`              | Template engine, draft editor with evidence highlights                       |
| Follow-up engine    | `lib/followup/`                                    | Inngest jobs: deadline tiers, reply classification                           |
| Consoles & payments | `app/(dashboard)/`, `app/(staff)/`, `lib/billing/` | User dashboard, staff console, Stripe fee flow                               |

## Already in place (this PR)

- `app/` — App Router shell (layout, landing page, Tailwind globals)
- `lib/caseState.ts` — the case state machine (spec's statuses + transitions)
- `lib/extract.ts` — extraction contract + `verifyMath`
- `db/migrations/001_init.sql` — six tables, check constraints, RLS (separate staff role),
  audit triggers writing `events` on every case-scoped mutation
- `db/test/` — RLS/audit acceptance suite against local (Supabase-compatible) Postgres
- `.github/workflows/ci.yml` — lint, typecheck, unit+db tests, Playwright smoke
