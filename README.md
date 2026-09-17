# BillFighter

An AI case worker that turns medical bills, EOBs, and denial letters into findings, appeal
letters, and confirmed savings — with human approval on everything that leaves the building.
Built for cancer families first.

## Stack

- **Next.js 15 + TypeScript** (App Router), **Tailwind CSS**
- **Supabase-compatible Postgres** — schema lives in `db/migrations/`, RLS enforced in the database
- **Vitest** for unit + database tests, **Playwright** for E2E (minimal smoke spec for now)
- **ESLint + Prettier**, **GitHub Actions** CI (lint, typecheck, tests, e2e)

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
```

## Database

`db/migrations/001_init.sql` is the source-of-truth schema: the six tables (`users`, `cases`,
`documents`, `findings`, `actions`, `events`), check-constrained enums, row-level security
scoping every row to its owner with a separate `staff` role, and audit triggers that write an
`events` row on every case-scoped mutation.

It applies cleanly to plain Postgres 13+ **and** to Supabase: the `auth.uid()` / `auth.role()`
helpers and the roles are created only when missing, so a real Supabase `auth` schema is never
touched.

### Running the database tests locally

The RLS/audit suite needs a local Postgres (Supabase-compatible):

```bash
# Debian/Ubuntu example
sudo apt-get install postgresql
sudo pg_ctlcluster 17 main start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"

npm install
npm test             # vitest; recreates billfighter_test and applies migrations automatically
```

Connection string is read from `DATABASE_URL`
(default `postgres://postgres:postgres@localhost:5432/billfighter_test`).

## Scripts

| Script                                    | What it does                                          |
| ----------------------------------------- | ----------------------------------------------------- |
| `npm run dev`                             | Next dev server                                       |
| `npm run build` / `npm start`             | Production build / serve                              |
| `npm run lint`                            | ESLint (zero warnings allowed)                        |
| `npm run typecheck`                       | `tsc --noEmit`                                        |
| `npm test`                                | Vitest units + RLS/audit suite against local Postgres |
| `npm run e2e`                             | Playwright smoke test                                 |
| `npm run format` / `npm run format:check` | Prettier                                              |
