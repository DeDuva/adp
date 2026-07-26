import { pgTable, text, timestamp, uuid, jsonb, boolean } from "drizzle-orm/pg-core";

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const identities = pgTable("identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["human", "agent"] }).notNull(),
  principal: text("principal").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Opaque bearer tokens, hashed at rest (scrypt). Doubles as git basic-auth password.
export const tokens = pgTable("tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  identityId: uuid("identity_id").notNull().references(() => identities.id),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: text("scopes").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revoked: boolean("revoked").notNull().default(false),
});

// Append-only spine: every mutation writes its state change and its operations
// row in a single transaction. This *is* the op log and the audit log.
export const operations = pgTable("operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull().references(() => identities.id),
  verb: text("verb").notNull(),
  target: text("target").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  parentOp: uuid("parent_op"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
