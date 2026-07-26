import { describe, it, expect } from "vitest";
import { buildConnection } from "./connections.js";

describe("buildConnection", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("returns everything with no args", () => {
    const conn = buildConnection(items, {});
    expect(conn.nodes).toEqual(items);
    expect(conn.totalCount).toBe(5);
    expect(conn.pageInfo.hasNextPage).toBe(false);
    expect(conn.pageInfo.hasPreviousPage).toBe(false);
  });

  it("respects first", () => {
    const conn = buildConnection(items, { first: 2 });
    expect(conn.nodes).toEqual(["a", "b"]);
    expect(conn.pageInfo.hasNextPage).toBe(true);
    expect(conn.pageInfo.hasPreviousPage).toBe(false);
  });

  it("respects last", () => {
    const conn = buildConnection(items, { last: 2 });
    expect(conn.nodes).toEqual(["d", "e"]);
    expect(conn.pageInfo.hasNextPage).toBe(false);
    expect(conn.pageInfo.hasPreviousPage).toBe(true);
  });

  it("pages forward using endCursor as after", () => {
    const page1 = buildConnection(items, { first: 2 });
    const page2 = buildConnection(items, { first: 2, after: page1.pageInfo.endCursor });
    expect(page2.nodes).toEqual(["c", "d"]);
    expect(page2.pageInfo.hasNextPage).toBe(true);
    expect(page2.pageInfo.hasPreviousPage).toBe(true);

    const page3 = buildConnection(items, { first: 2, after: page2.pageInfo.endCursor });
    expect(page3.nodes).toEqual(["e"]);
    expect(page3.pageInfo.hasNextPage).toBe(false);
  });

  it("pages backward using startCursor as before", () => {
    const conn = buildConnection(items, { last: 2, before: buildConnection(items, {}).pageInfo.endCursor });
    // before points at the last element's cursor, so the window excludes it
    expect(conn.nodes).toEqual(["c", "d"]);
  });

  it("produces edges with matching cursors", () => {
    const conn = buildConnection(items, { first: 3 });
    expect(conn.edges.map((e) => e.node)).toEqual(conn.nodes);
    expect(conn.edges.every((e) => typeof e.cursor === "string" && e.cursor.length > 0)).toBe(true);
  });

  it("handles an empty list", () => {
    const conn = buildConnection([], { first: 10 });
    expect(conn.nodes).toEqual([]);
    expect(conn.pageInfo.startCursor).toBeNull();
    expect(conn.pageInfo.endCursor).toBeNull();
    expect(conn.pageInfo.hasNextPage).toBe(false);
  });

  it("ignores a garbage cursor rather than throwing", () => {
    expect(() => buildConnection(items, { after: "not-a-real-cursor" })).not.toThrow();
  });
});
