/**
 * The staff-queue read for failed sends.
 *
 * A parked action (status 'failed' — three failed attempts, or a structural
 * block like a missing adapter or an unsigned authorization) surfaces here
 * with its error attached, in the shape the staff console's
 * StaffQueueTable already renders (kind 'failed_send'). Nothing vanishes: if
 * it failed, it is in this queue.
 */
import type { Client as PgClient, PoolClient, QueryResultRow } from "pg";

type Queryable = PoolClient | PgClient;

export interface FailedSendEntry {
  id: string;
  caseId: string;
  /** Human case name, e.g. "Aetna — Riverwalk Imaging" (best available). */
  caseLabel: string;
  summary: string;
  /** The attached error: what failed and why, verbatim. */
  detail: string;
  createdAt: string;
}

interface FailedActionRow extends QueryResultRow {
  id: string;
  case_id: string;
  channel: string;
  insurer_name: string | null;
  provider_name: string | null;
  send_attempts: number;
  last_error: string | null;
  created_at: Date;
}

/** Failed sends, oldest action first — the queue works bottom-up. */
export async function failedSendEntries(client: Queryable): Promise<FailedSendEntry[]> {
  const result = await client.query<FailedActionRow>(
    `select a.id, a.case_id, a.channel, c.insurer_name, c.provider_name,
            a.send_attempts, a.last_error, a.created_at
       from actions a
       join cases c on c.id = a.case_id
      where a.status = 'failed'
      order by a.created_at`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    caseId: row.case_id,
    caseLabel: row.insurer_name ?? row.provider_name ?? `case ${row.case_id.slice(0, 8)}`,
    summary: `Send failed via ${row.channel} after ${row.send_attempts} attempt${
      row.send_attempts === 1 ? "" : "s"
    }`,
    detail: row.last_error ?? "(no error recorded)",
    createdAt: row.created_at.toISOString(),
  }));
}
