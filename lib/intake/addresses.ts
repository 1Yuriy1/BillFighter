/**
 * Address schemes on the inbound domain, per the MVP spec:
 *
 * - per-user alias:  jane.k82@in.billfighter.com  (users.inbound_alias)
 * - per-case reply:  case-8f2a@in.billfighter.com (spec's example shape)
 *
 * A case's reply code is the first 8 hex chars of its UUID — deterministic,
 * so addresses need no extra table. At MVP scale (hundreds of cases) the
 * birthday risk of a shared 8-hex prefix is negligible; the router still
 * fail-safes to the orphan queue if a prefix ever matched more than one case,
 * because "a reply attaching to the wrong case" is the one outcome the spec
 * will not accept.
 */
export const DEFAULT_INBOUND_DOMAIN = "in.billfighter.com";

const CASE_LOCAL_PART = /^case-([0-9a-f]{8})$/;

export function inboundDomain(): string {
  return (process.env.INBOUND_DOMAIN ?? DEFAULT_INBOUND_DOMAIN).toLowerCase();
}

/** The 8-hex reply code baked into a case's reply address. */
export function caseCodeFor(caseId: string): string {
  return caseId.replace(/-/g, "").slice(0, 8);
}

export function caseReplyAddress(caseId: string, domain: string = inboundDomain()): string {
  return `case-${caseCodeFor(caseId)}@${domain}`;
}

export interface ParsedCaseAddress {
  /** 8 lowercase hex chars identifying the case. */
  code: string;
}

/**
 * Parses a candidate address into a case reply address, or null when the
 * address is not one (different domain, wrong local-part shape, wrong length).
 */
export function parseCaseAddress(
  address: string,
  domain: string = inboundDomain(),
): ParsedCaseAddress | null {
  const parts = address.split("@");
  if (parts.length !== 2) return null;
  const [local, addrDomain] = parts;
  if (addrDomain.toLowerCase() !== domain.toLowerCase()) return null;
  const match = local.toLowerCase().match(CASE_LOCAL_PART);
  return match ? { code: match[1] } : null;
}
