// Relay-style connections with cursor pagination, per docs/pragmatic_mvp.md
// §2.4 Tier 3. Cursors are just base64(index) — an offset in disguise. Fine
// at MVP scale (repos.select().from() already loads full result sets; see
// core/repos-lookup.ts and friends), and it keeps the two things `gh`
// actually needs — hasNextPage and a cursor it can echo back — correct.
export interface ConnectionArgs {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
}

export interface Connection<T> {
  edges: { node: T; cursor: string }[];
  nodes: T[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  totalCount: number;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, "utf8").toString("base64");
}

function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function buildConnection<T>(items: T[], args: ConnectionArgs): Connection<T> {
  let start = 0;
  let end = items.length;

  if (args.after) {
    const idx = decodeCursor(args.after);
    if (idx !== null) start = idx + 1;
  }
  if (args.before) {
    const idx = decodeCursor(args.before);
    if (idx !== null) end = idx;
  }

  let slice = items.slice(start, end);
  let sliceStart = start;

  if (typeof args.first === "number") {
    slice = slice.slice(0, args.first);
  } else if (typeof args.last === "number") {
    const drop = Math.max(0, slice.length - args.last);
    slice = slice.slice(drop);
    sliceStart = start + drop;
  }

  const edges = slice.map((node, i) => ({ node, cursor: encodeCursor(sliceStart + i) }));

  return {
    edges,
    nodes: slice,
    pageInfo: {
      hasNextPage: sliceStart + slice.length < items.length,
      hasPreviousPage: sliceStart > 0,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
    totalCount: items.length,
  };
}
