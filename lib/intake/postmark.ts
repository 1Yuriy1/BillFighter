/**
 * The Postmark inbound payload contract and parsing helpers.
 *
 * Shape per Postmark's inbound webhook documentation
 * (postmarkapp.com/developer/webhooks/inbound-webhook). Everything is
 * validated before use: a webhook is untrusted input even after its
 * signature verifies.
 */

export interface PostmarkAddress {
  Email: string;
  Name: string;
  MailboxHash: string;
}

export interface PostmarkAttachment {
  Name: string;
  /** base64-encoded attachment bytes. */
  Content: string;
  ContentType: string;
  ContentLength: number;
  ContentID?: string;
}

export interface PostmarkInboundPayload {
  From: string;
  FromFull?: PostmarkAddress;
  To: string;
  ToFull?: PostmarkAddress[];
  Cc?: string;
  CcFull?: PostmarkAddress[];
  OriginalRecipient?: string;
  Subject?: string;
  MessageID: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
  Headers?: { Name: string; Value: string }[];
  Attachments?: PostmarkAttachment[];
}

function isPostmarkAddress(value: unknown): value is PostmarkAddress {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PostmarkAddress).Email === "string"
  );
}

function isPostmarkAttachment(value: unknown): value is PostmarkAttachment {
  if (typeof value !== "object" || value === null) return false;
  const att = value as PostmarkAttachment;
  return (
    typeof att.Name === "string" &&
    typeof att.Content === "string" &&
    typeof att.ContentType === "string"
  );
}

export function isPostmarkInboundPayload(value: unknown): value is PostmarkInboundPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as PostmarkInboundPayload;
  if (typeof payload.From !== "string" || typeof payload.To !== "string") return false;
  if (typeof payload.MessageID !== "string" || payload.MessageID.length === 0) return false;
  if (payload.Attachments !== undefined) {
    if (!Array.isArray(payload.Attachments) || !payload.Attachments.every(isPostmarkAttachment))
      return false;
  }
  if (
    payload.ToFull !== undefined &&
    !(Array.isArray(payload.ToFull) && payload.ToFull.every(isPostmarkAddress))
  ) {
    return false;
  }
  if (
    payload.CcFull !== undefined &&
    !(Array.isArray(payload.CcFull) && payload.CcFull.every(isPostmarkAddress))
  ) {
    return false;
  }
  return true;
}

/** Splits on commas that are not inside a quoted display name. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/**
 * Extracts bare addresses from a Postmark address header value, which may
 * carry display names: `"Jane K" <jane.k82@in.billfighter.com>, a@b.com`.
 */
export function parseAddressList(value: string): string[] {
  const addresses: string[] = [];
  for (const part of splitTopLevel(value)) {
    const angle = part.match(/<([^<>]+)>/);
    const candidate = (angle ? angle[1] : part).trim();
    if (candidate.length > 0) addresses.push(candidate);
  }
  return addresses;
}

/**
 * Every address this email was sent to, lowercased and deduplicated:
 * the structured ToFull/CcFull entries when present, plus the raw To/Cc
 * headers and the envelope's OriginalRecipient.
 */
export function candidateRecipients(payload: PostmarkInboundPayload): string[] {
  const candidates = [
    ...(payload.OriginalRecipient ? [payload.OriginalRecipient] : []),
    ...parseAddressList(payload.To),
    ...(payload.ToFull ?? []).map((a) => a.Email),
    ...(payload.Cc ? parseAddressList(payload.Cc) : []),
    ...(payload.CcFull ?? []).map((a) => a.Email),
  ];
  return [...new Set(candidates.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0))];
}
