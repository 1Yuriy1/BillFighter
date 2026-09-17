/**
 * Shared field-path resolution for evidence references and letter citations.
 *
 * Two layers enforce the same invariant — the analyst's findings and the
 * letter engine's citations accept a fact only when a path like
 * "total_billed" or "line_items[2].billed" resolves to a real field with a
 * meaningful value on an extracted document. One implementation keeps the
 * two acceptance rules identical: drift here would let a finding cite what a
 * letter cannot, or let an unsupported claim slip into a draft.
 */

import type { ExtractedDocument } from "./extract";

export interface FieldLookup {
  exists: boolean;
  value: unknown;
}

/**
 * Resolves a "line_items[2].billed" style path through the extraction. Own
 * properties only — a model-supplied path can never traverse the prototype
 * chain ("constructor", "__proto__") because those are not own properties of
 * a parsed extraction.
 */
export function resolveField(extracted: ExtractedDocument, field: string): FieldLookup {
  const segments = parseFieldPath(field);
  if (segments === null) return { exists: false, value: undefined };

  let cursor: unknown = extracted;
  for (const segment of segments) {
    if (!isObjectLike(cursor) || !Object.hasOwn(cursor, segment.key)) {
      return { exists: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[segment.key];
    if (segment.index !== null) {
      if (!Array.isArray(cursor) || !Object.hasOwn(cursor, segment.index)) {
        return { exists: false, value: undefined };
      }
      cursor = cursor[segment.index];
    }
  }
  return { exists: true, value: cursor };
}

/**
 * A value that can support a finding or a citation: present and not empty.
 * Numbers count even at 0 (a stated $0 is a fact), booleans count even when
 * false (a stated "not emergency" is a fact), but null, empty strings, and
 * empty arrays support nothing.
 */
export function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/** One dotted segment: a key with an optional single array index. */
interface PathSegment {
  key: string;
  index: number | null;
}

function parseFieldPath(field: string): PathSegment[] | null {
  const segments: PathSegment[] = [];
  for (const raw of field.trim().split(".")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/.exec(raw.trim());
    if (!match) return null;
    segments.push({ key: match[1], index: match[2] === undefined ? null : Number(match[2]) });
  }
  return segments;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
