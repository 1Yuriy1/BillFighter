/**
 * Attachment persistence for intake.
 *
 * The production store is Supabase's encrypted object storage (the spec calls
 * documents.file_path an "encrypted storage path"); until that vendor is
 * wired, intake writes to a local directory behind the same interface, so
 * swapping stores later is a change to this file only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface IntakeStore {
  /** Persists content under the given scope (a case id) and returns its path. */
  save(scope: string, filename: string, content: Buffer): Promise<string>;
}

export function makeLocalStore(rootDir?: string): IntakeStore {
  const root =
    rootDir ?? process.env.INTAKE_STORAGE_DIR ?? path.join(tmpdir(), "billfighter-intake");
  return {
    async save(scope: string, filename: string, content: Buffer): Promise<string> {
      const dir = path.join(root, scope);
      await mkdir(dir, { recursive: true });
      // Strip anything path-like or shell-like out of attacker-controlled names.
      const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+/, "") || "attachment";
      const name = `${randomUUID()}-${safeName}`;
      const filePath = path.join(dir, name);
      await writeFile(filePath, content);
      return filePath;
    },
  };
}
