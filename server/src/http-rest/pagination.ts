import { z } from "zod";

// #97: every list endpoint is bounded. An unbounded list is a contract that
// degrades with success — the busiest repo is the one whose issue list
// stops fitting in a response — and it had seven instances here.
//
// Two idioms on purpose, matching each plane's own conventions:
//  - the compat plane paginates the way GitHub does (`per_page` capped at
//    100, `page` offsets), because gh and Octokit already send exactly
//    those;
//  - the native plane uses `limit` plus a keyset cursor (created_at, id),
//    returned in the ADP-Next-Cursor response header when — and only when —
//    a full page came back. A header rather than a changed body shape:
//    0.3.0 is a breaking release, but a break has to buy something, and
//    every existing consumer of these lists reads the body as-is.

export const PerPageQuery = z.object({
  per_page: z.coerce.number().int().positive().max(100).default(30),
  page: z.coerce.number().int().positive().default(1),
});

export const KeysetQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});

export const NEXT_CURSOR_HEADER = "adp-next-cursor";

export interface KeysetPosition {
  createdAt: Date;
  id: string;
}

export function encodeCursor(pos: KeysetPosition): string {
  return Buffer.from(`${pos.createdAt.toISOString()}|${pos.id}`, "utf8").toString("base64url");
}

// An undecodable cursor is null, and callers treat null as "from the top" —
// a garbage cursor gets a well-formed first page, not a 500.
export function decodeCursor(cursor: string | undefined): KeysetPosition | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.indexOf("|");
    if (sep === -1) return null;
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
