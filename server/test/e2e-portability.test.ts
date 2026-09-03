import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { skipWithoutDb } from "./require-db.js";
import {
  archivedKeys,
  changes,
  gateResults,
  identities,
  intents,
  issues,
  operations,
} from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { KeyRegistry, Signer } from "../src/core/signing.js";
import { signStatement, verifyEnvelope, type DsseEnvelope } from "../src/core/dsse.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerPortabilityRoutes } from "../src/http-rest/portability.js";
import { findRepo } from "../src/core/repos-lookup.js";
import type { ExportBundle } from "../src/core/portability.js";

// #239 — a repository's record can leave the instance holding it.
//
// `PUBLIC_URL` is part of the signed record rather than a display string: the
// server signs evidence with it and hands it back in clone URLs, and
// `docs/self-hosting.md` states that as a property of the design. The
// consequence nobody had written down is that the record could not move — and
// every adoption path in this phase ends with a developer's record living on an
// instance chosen while they were evaluating alone. If it cannot move when
// their company adopts, the funnel breaks exactly where it is supposed to pay
// off, for a reason that was designed in.
//
// **The decision this pins: nothing is re-signed.** A signature says "this
// instance attested this, then". Re-signing under the receiving instance would
// let it assert what it did not witness, which is the substitution this product
// exists to prevent. So the record keeps its original signatures and the
// exporting instance's public key travels with it — and the central test below
// is that a record verifies under a registry whose own key is a *different* key.
//
// **Two compromises in the shape of this file, both stated rather than hidden.**
//
// The two instances share a database. The first version of this gave the
// receiving side a real second database, which is literally what a second
// instance is — and creating one inside a suite that runs in parallel with
// ninety others made an unrelated storage-quota test time out. A test that makes
// its neighbours flaky is worse than the literalism it buys.
//
// And the source records are deleted after the export, before the import. Ids
// are preserved deliberately — an operation pointing at a renumbered row is a
// record that no longer says what it said — so in one database the import would
// otherwise skip every row as already present. Deleting first makes this a
// restore, which exercises exactly the inserts a migration does.
//
// What a shared database therefore cannot prove is that the imported rows
// insert against foreign keys the receiving instance does not have. The
// bundle-contents assertion carries that weight instead, and it is the property
// that makes the insert possible at all — it is also the defect the
// two-database version found before it was withdrawn.
describe.skipIf(skipWithoutDb)("#239: portability", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let identityId: string;
  let sourceRepoId: string;
  let bundle: ExportBundle;
  const owner = `portability-owner-${Date.now()}`;
  const source = "source-repo";
  const target = "target-repo";
  const sha = "a".repeat(40);

  // Two instances. The exporting one signs everything; the receiving one has
  // its own key and has never seen the other.
  const oldSigner = new Signer(`evaluated-on-${Date.now()}`);
  const newSigner = new Signer(`their-company-${Date.now()}`);
  const OLD_URL = "https://evaluated-on.example.com";
  let receivingRegistry: KeyRegistry;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-portability-"));
    const gitBackend = new GitBackend(gitRoot);
    receivingRegistry = new KeyRegistry(newSigner);

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, OLD_URL);
    registerIssueRoutes(app, db);
    registerPortabilityRoutes(app, db, oldSigner, OLD_URL, receivingRegistry);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `portability-e2e-${Date.now()}` })
      .returning();
    identityId = identity!.id;
    token = await mintToken(db, identityId, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identityId, owner);

    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: source }) });
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: target }) });
    sourceRepoId = (await findRepo(db, owner, source))!.id;

    // A record worth moving: an intent, a signed change bound to it, and a gate
    // result carrying a DSSE envelope — one of each thing the bundle claims to
    // carry, all signed by the *old* instance.
    const issue = await api(`/api/v3/repos/${owner}/${source}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "the work they did while evaluating" }),
    });
    const intentId = (issue.body as { intent_id: string }).intent_id;

    const provenance = { kind: "agent", principal: "github:someone", via: "push", model: "old-model" };
    await db.insert(changes).values({
      repoId: sourceRepoId,
      gitSha: sha,
      intentId,
      provenance,
      signature: oldSigner.sign({ repo: `${owner}/${source}`, git_sha: sha, intent_id: intentId, provenance }),
    });

    await db.insert(gateResults).values({
      repoId: sourceRepoId,
      gitSha: sha,
      name: "test",
      status: "success",
      summary: "green",
      reporterId: identityId,
      envelope: signStatement(oldSigner, {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: `git+${OLD_URL}/${owner}/${source}`, digest: { sha1: sha } }],
        predicateType: "https://adp.dev/attestations/gate/v1",
        predicate: { status: "success" },
      }),
    });

    const exported = await api(`/api/adp/repos/${owner}/${source}/export`);
    expect(exported.status).toBe(200);
    bundle = exported.body as unknown as ExportBundle;

    // The exporting instance is gone, as far as the rest of this file is
    // concerned. In dependency order, because these are the same foreign keys
    // the import has to satisfy from the other direction.
    await db.delete(gateResults).where(eq(gateResults.repoId, sourceRepoId));
    await db.delete(operations).where(eq(operations.repoId, sourceRepoId));
    await db.delete(changes).where(eq(changes.repoId, sourceRepoId));
    await db.delete(issues).where(eq(issues.repoId, sourceRepoId));
    await db.delete(intents).where(eq(intents.repoId, sourceRepoId));
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function api(pathAndQuery: string, init: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  const importBundle = (body: unknown) =>
    api(`/api/adp/repos/${owner}/${target}/import`, { method: "POST", body: JSON.stringify(body) });

  it("carries the record, and the key without which none of it is evidence", () => {
    expect(bundle.format).toBe("adp.repository.export/v1");
    expect(bundle.instance).toEqual({ public_url: OLD_URL, signing_public_key: oldSigner.publicKeyHex });
    expect(bundle.intents).toHaveLength(1);
    expect(bundle.changes).toHaveLength(1);
    expect(bundle.gate_results).toHaveLength(1);
    expect(bundle.operations.length).toBeGreaterThan(0);

    // Git history is deliberately not here: a change record references a
    // commit, and the commit travels by `git push`.
    expect(bundle).not.toHaveProperty("commits");
    expect(bundle).not.toHaveProperty("git");
  });

  // **What a shared database cannot prove, and this assertion must.**
  // `operations.actor_id`, `issues.author_id` and `gate_results.reporter_id` are
  // hard foreign keys; on a genuinely separate instance those rows do not exist,
  // so a bundle without the principals is one that cannot be inserted at all.
  // Rewriting every actor to whoever ran the import would instead make the log
  // say one person did everything — a falsified record rather than a migrated
  // one.
  it("carries every principal the record names, and nothing that can act as them", () => {
    const carried = new Set((bundle.identities as { id: string }[]).map((i) => i.id));
    const referenced = new Set<string>([
      ...(bundle.operations as { actorId: string }[]).map((o) => o.actorId),
      ...(bundle.issues as { authorId: string }[]).map((i) => i.authorId),
      ...(bundle.gate_results as { reporterId: string }[]).map((g) => g.reporterId),
    ]);
    expect(referenced.size).toBeGreaterThan(0);
    for (const id of referenced) expect(carried.has(id)).toBe(true);

    // Id, kind and principal only. What moves is who the record names, not the
    // ability to act as them.
    for (const identity of bundle.identities as Record<string, unknown>[]) {
      expect(Object.keys(identity).sort()).toEqual(["id", "kind", "principal"]);
    }
  });

  // **The item, in one test.** Before the import, the receiving registry cannot
  // verify the old instance's envelope — it has never seen that key. Afterwards
  // it can, with nothing re-signed and no restart.
  it("moves the record so it verifies under a registry whose own key is a different key", async () => {
    const envelope = (bundle.gate_results[0] as { envelope: DsseEnvelope }).envelope;
    expect(verifyEnvelope(receivingRegistry, envelope)).toBe(false);

    const imported = await importBundle(bundle);
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ key_archived: true });
    expect(imported.body!.imported).toMatchObject({ intents: 1, changes: 1, gate_results: 1 });

    expect(verifyEnvelope(receivingRegistry, envelope)).toBe(true);
    // And the receiving instance's own key is still its own: a bundle cannot
    // replace the verifier for the key this instance actually signs with.
    expect(receivingRegistry.resolve(newSigner.publicKeyHex)).not.toBeNull();

    // The signature is the one the old instance made, byte for byte.
    const targetRepoId = (await findRepo(db, owner, target))!.id;
    const [moved] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.repoId, targetRepoId), eq(changes.gitSha, sha)));
    const original = bundle.changes[0] as { signature: string; provenance: unknown };
    expect(moved!.signature).toBe(original.signature);
    expect(moved!.provenance).toEqual(original.provenance);
    expect(moved!.signature).not.toBe(
      newSigner.sign({
        repo: `${owner}/${target}`,
        git_sha: sha,
        intent_id: moved!.intentId,
        provenance: moved!.provenance,
      }),
    );

    // The migration is recorded, because the imported log cannot say how it got
    // here — those operations were written somewhere else.
    const [op] = await db
      .select()
      .from(operations)
      .where(and(eq(operations.repoId, targetRepoId), eq(operations.verb, "repo.import")));
    expect(op).toBeDefined();
    expect(op!.after).toMatchObject({ from: OLD_URL, signingPublicKey: oldSigner.publicKeyHex });

    // Every actor the imported rows name resolves here.
    const actorIds = [...new Set((bundle.operations as { actorId: string }[]).map((o) => o.actorId))];
    const present = await db.select({ id: identities.id }).from(identities).where(inArray(identities.id, actorIds));
    expect(present).toHaveLength(actorIds.length);
  });

  // A migration that half-failed has to be safe to run again. An import that is
  // only safe once is one nobody will retry when they most need to.
  it("is a no-op on re-import rather than a duplicate history", async () => {
    const again = await importBundle(bundle);
    expect(again.status).toBe(200);
    expect(again.body!.imported).toMatchObject({ changes: 0, intents: 0, gate_results: 0 });
    expect(again.body).toMatchObject({ key_archived: false });

    const targetRepoId = (await findRepo(db, owner, target))!.id;
    expect(await db.select().from(changes).where(eq(changes.repoId, targetRepoId))).toHaveLength(1);
    expect(await db.select().from(intents).where(eq(intents.repoId, targetRepoId))).toHaveLength(1);
    expect(
      await db.select().from(archivedKeys).where(eq(archivedKeys.publicKeyHex, oldSigner.publicKeyHex)),
    ).toHaveLength(1);
  });

  it("refuses a bundle whose shape it does not read", async () => {
    const refused = await importBundle({ ...bundle, format: "adp.repository.export/v99" });
    expect(refused.status).toBe(422);
    expect(refused.body!.message).toContain("adp.repository.export/v1");
  });

  // Without the key, every signature in the bundle is unverifiable here — and
  // an unverifiable record is not evidence, which is the whole reason to move
  // it at all.
  it("refuses a bundle that names no signing key", async () => {
    const refused = await importBundle({ ...bundle, instance: { public_url: OLD_URL } });
    expect(refused.status).toBe(422);
    expect(refused.body!.message).toContain("unverifiable");
  });

  // Creating the repository as a side effect would let an import place one
  // under an org the caller was never admitted to, which is the check #91
  // exists to make.
  it("refuses to import into a repository that does not exist, and says what to do", async () => {
    const refused = await api(`/api/adp/repos/${owner}/never-created/import`, {
      method: "POST",
      body: JSON.stringify(bundle),
    });
    expect(refused.status).toBe(404);
    expect(refused.body!.adp_equivalent).toContain("Create it first");
    // And says the thing an operator will otherwise assume happened.
    expect(refused.body!.adp_equivalent).toContain("git push");
  });
});
