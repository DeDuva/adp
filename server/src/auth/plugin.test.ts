import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../db/client.js";
import { identities, orgs, orgMemberships } from "../db/schema.js";
import { isOrgMember, type AuthenticatedIdentity } from "./tokens.js";
import { hasScope, requireOrgAccess } from "./plugin.js";
import { skipWithoutDb } from "../../test/require-db.js";

// No database needed — hasScope is pure. The full nesting table, pinned:
// the interesting rows are the two directions of #90 (audit §P0-4) — admin
// no longer satisfies runner, and runner satisfies nothing else.
describe("hasScope", () => {
  it("admin satisfies the CRUD scopes and itself", () => {
    expect(hasScope(["admin"], "repo:read")).toBe(true);
    expect(hasScope(["admin"], "repo:write")).toBe(true);
    expect(hasScope(["admin"], "admin")).toBe(true);
  });

  it("admin does NOT satisfy runner — the untrusted-host plane is not a privilege level (#90)", () => {
    expect(hasScope(["admin"], "runner")).toBe(false);
    expect(hasScope(["repo:read", "repo:write", "admin"], "runner")).toBe(false);
  });

  it("runner satisfies runner and nothing else", () => {
    expect(hasScope(["runner"], "runner")).toBe(true);
    expect(hasScope(["runner"], "repo:read")).toBe(false);
    expect(hasScope(["runner"], "repo:write")).toBe(false);
    expect(hasScope(["runner"], "admin")).toBe(false);
  });

  it("repo:write satisfies repo:read; nothing but admin satisfies admin", () => {
    expect(hasScope(["repo:write"], "repo:read")).toBe(true);
    expect(hasScope(["repo:read"], "repo:write")).toBe(false);
    expect(hasScope(["repo:read", "repo:write", "runner"], "admin")).toBe(false);
  });
});

function identity(overrides: Partial<AuthenticatedIdentity>): AuthenticatedIdentity {
  return {
    identityId: "unset",
    kind: "human",
    principal: "test",
    scopes: [],
    orgId: null,
    harness: null,
    model: null,
    sessionId: null,
    ...overrides,
  };
}

function mockReply() {
  const state: { code?: number; body?: unknown } = {};
  const reply = {
    code(c: number) {
      state.code = c;
      return reply;
    },
    send(b: unknown) {
      state.body = b;
      return reply;
    },
  };
  return { reply, state };
}

// M4-1: requireOrgAccess is the mechanism, not yet wired into any route —
// M4-2 (the org policy plane) is the first consumer. Tested directly here so
// the logic is proven before anything depends on it.
describe.skipIf(skipWithoutDb)("M4-1: org-scoped access", () => {
  let db: Db;
  let pool: import("pg").Pool;
  let orgAId: string;
  let orgBId: string;
  let memberIdentityId: string;
  let nonMemberIdentityId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

    const stamp = Date.now();
    const [orgA] = await db.insert(orgs).values({ name: `plugin-test-org-a-${stamp}` }).returning();
    const [orgB] = await db.insert(orgs).values({ name: `plugin-test-org-b-${stamp}` }).returning();
    orgAId = orgA!.id;
    orgBId = orgB!.id;

    const [member] = await db.insert(identities).values({ kind: "human", principal: `member-${stamp}` }).returning();
    const [nonMember] = await db.insert(identities).values({ kind: "human", principal: `nonmember-${stamp}` }).returning();
    memberIdentityId = member!.id;
    nonMemberIdentityId = nonMember!.id;

    // Only memberIdentityId is ever added to org A — nonMemberIdentityId
    // stands in for "membership was revoked after the token was minted".
    await db.insert(orgMemberships).values({ orgId: orgAId, identityId: memberIdentityId, role: "member" });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("isOrgMember", () => {
    it("is true for a real membership", async () => {
      expect(await isOrgMember(db, orgAId, memberIdentityId)).toBe(true);
    });

    it("is false for an identity with no membership row anywhere", async () => {
      expect(await isOrgMember(db, orgAId, nonMemberIdentityId)).toBe(false);
    });

    it("is false for the right identity in the wrong org", async () => {
      expect(await isOrgMember(db, orgBId, memberIdentityId)).toBe(false);
    });
  });

  describe("requireOrgAccess", () => {
    it("passes a token scoped to the org, with a real membership", async () => {
      const { reply, state } = mockReply();
      const req = { identity: identity({ identityId: memberIdentityId, orgId: orgAId }), params: { orgId: orgAId } };
      await requireOrgAccess(db, "orgId")(req as never, reply as never);
      expect(state.code).toBeUndefined();
    });

    it("refuses a token scoped to a different org than the route targets", async () => {
      const { reply, state } = mockReply();
      const req = { identity: identity({ identityId: memberIdentityId, orgId: orgBId }), params: { orgId: orgAId } };
      await requireOrgAccess(db, "orgId")(req as never, reply as never);
      expect(state.code).toBe(403);
    });

    it("refuses a token minted with no org at all", async () => {
      const { reply, state } = mockReply();
      const req = { identity: identity({ identityId: memberIdentityId, orgId: null }), params: { orgId: orgAId } };
      await requireOrgAccess(db, "orgId")(req as never, reply as never);
      expect(state.code).toBe(403);
    });

    it("refuses when membership was revoked after the token was minted", async () => {
      const { reply, state } = mockReply();
      // A token that (somehow) still claims orgA, for an identity that was
      // never added to org_memberships — the request-time check, not just
      // the mint-time one, is what catches this.
      const req = { identity: identity({ identityId: nonMemberIdentityId, orgId: orgAId }), params: { orgId: orgAId } };
      await requireOrgAccess(db, "orgId")(req as never, reply as never);
      expect(state.code).toBe(403);
    });

    it("refuses an unauthenticated request", async () => {
      const { reply, state } = mockReply();
      const req = { identity: undefined, params: { orgId: orgAId } };
      await requireOrgAccess(db, "orgId")(req as never, reply as never);
      expect(state.code).toBe(401);
    });

    it("refuses when the route's own org param is missing", async () => {
      const { reply, state } = mockReply();
      const req = { identity: identity({ identityId: memberIdentityId, orgId: orgAId }), params: {} };
      await requireOrgAccess(db, "orgId")(req as never, reply as never);
      expect(state.code).toBe(400);
    });
  });
});
