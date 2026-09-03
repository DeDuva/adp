import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { requireScope } from "../auth/plugin.js";
import { findMirrorsByUpstream } from "../core/mirrors-lookup.js";
import { decryptCredential } from "../core/mirror-crypto.js";
import { dispatchGitHubEvent, type GitHubEventPayload } from "../core/github-event-dispatch.js";
import {
  appManifest,
  convertAppManifest,
  findGitHubApp,
  newManifestState,
  recordInstallation,
  suspendInstallation,
  verifyAppSignature,
} from "../core/github-app.js";

// The manifest flow, served by the instance the App will belong to.
//
// Three routes and one of them is HTML, which is not an oversight: GitHub
// accepts an App manifest only as a form POST from a browser to
// github.com/settings/apps/new. There is no API for it, and that is the point —
// the App is created *in the user's own organisation*, by them, and the
// credentials come back to whoever served the form. That is what lets a
// self-hosted ADP offer one-click installation without a hosted control plane
// standing in the middle holding everyone's keys.

/**
 * A state parameter that survives a restart.
 *
 * HMAC over an expiry rather than a row in a table or an entry in a Map: the
 * whole flow is one redirect out and one back, and a server that forgets its
 * pending states on deploy turns a routine restart into a setup that silently
 * fails at the last step. Single use is not enforced here because it does not
 * need to be — the conversion code GitHub returns is single-use at GitHub's end,
 * so a replayed state buys nothing.
 */
export function signState(key: string, ttlMs = 900_000, now = Date.now()): string {
  const payload = `${now + ttlMs}.${newManifestState()}`;
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyState(key: string, state: string | undefined, now = Date.now()): boolean {
  if (!state) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [expiry, nonce, mac] = parts as [string, string, string];
  const expected = Buffer.from(createHmac("sha256", key).update(`${expiry}.${nonce}`).digest("base64url"));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  return Number(expiry) > now;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function registerGitHubAppRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  credentialKey: string,
  publicUrl: string,
  fetchImpl: typeof fetch = fetch,
) {
  // The form. Self-submitting, because the page exists only to carry a POST
  // the browser has to make and nothing here benefits from a click.
  //
  // No auth: it creates nothing on this instance, it hands GitHub a manifest
  // that is public information (it is displayed to the installer in full), and
  // requiring a bearer token would mean a browser flow that cannot start from a
  // browser. The credential-bearing half is the callback, which is gated by the
  // signed state issued here.
  app.get("/github-app/new", async (req, reply) => {
    const existing = await findGitHubApp(db);
    if (existing) {
      reply.code(409).type("text/html").send(
        `<!doctype html><meta charset="utf-8"><title>ADP</title>` +
          `<p>This instance already has a GitHub App: ` +
          `<a href="${escapeHtml(existing.htmlUrl)}">${escapeHtml(existing.name)}</a>.</p>` +
          `<p>Install it on more repositories from that page. One App per instance is deliberate — ` +
          `the App is this deployment's identity to GitHub.</p>`,
      );
      return;
    }

    const { org } = req.query as { org?: string };
    // An App can be created under a personal account or an organisation, and
    // GitHub's endpoint differs. Asked for as a query parameter rather than
    // guessed, because guessing wrong sends the installer to a 404 in their
    // own settings.
    const action = org
      ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
      : "https://github.com/settings/apps/new";
    const name = `ADP (${new URL(publicUrl).host})`;
    const manifest = JSON.stringify(appManifest(publicUrl, name));
    const state = signState(credentialKey);

    reply
      .type("text/html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>Create the ADP GitHub App</title>` +
          `<form id="f" method="post" action="${escapeHtml(action)}?state=${encodeURIComponent(state)}">` +
          `<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">` +
          `<noscript><button type="submit">Create the ADP GitHub App on GitHub</button></noscript>` +
          `</form><script>document.getElementById("f").submit()</script>`,
      );
  });

  // GitHub redirects here with a single-use conversion code. This is the one
  // moment the whole App exists in memory; everything it returns is written
  // encrypted with the same key and mechanism as mirror credentials.
  app.get("/api/adp/github-app/callback", async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!verifyState(credentialKey, state)) {
      reply.code(400).send({ message: "missing or expired state — start again at /github-app/new" });
      return;
    }
    if (!code) {
      reply.code(400).send({ message: "GitHub did not return a manifest conversion code" });
      return;
    }
    if (await findGitHubApp(db)) {
      reply.code(409).send({ message: "this instance already has a GitHub App" });
      return;
    }

    try {
      const created = await convertAppManifest(db, credentialKey, code, fetchImpl);
      reply.send({
        app_id: created.appId,
        slug: created.slug,
        name: created.name,
        html_url: created.htmlUrl,
        // Where the installer goes next. Named rather than redirected to,
        // because a redirect out of an API response is a surprise for the
        // agent calling it and a convenience only for the browser.
        install_url: `${created.htmlUrl}/installations/new`,
      });
    } catch (err) {
      reply.code(502).send({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  // What this instance has, for anything deciding whether the App path is
  // available — `adp init`, the supervision UI, and 5c's check-run publisher,
  // which has nothing to authenticate as without it.
  app.get("/api/adp/github-app", { preHandler: requireScope("repo:read") }, async (_req, reply) => {
    const existing = await findGitHubApp(db);
    if (!existing) {
      reply.code(404).send({
        message: "this instance has no GitHub App",
        adp_equivalent: `Create one at ${publicUrl}/github-app/new — GitHub creates it in your own organisation.`,
      });
      return;
    }
    // Deliberately no secrets, not even truncated. There is no caller that
    // needs one and a read route that can leak a private key is a read route
    // somebody eventually points at a log.
    reply.send({
      app_id: existing.appId,
      slug: existing.slug,
      name: existing.name,
      html_url: existing.htmlUrl,
      client_id: existing.clientId,
      created_at: existing.createdAt.toISOString(),
    });
  });

  // One endpoint for every installation, which is the whole difference from the
  // per-repository webhook: there is no owner and name in the URL, so the
  // repository has to be found from `repository.full_name`.
  //
  // Under `/webhooks/github/` on purpose. The raw-body parser and the
  // spec-coverage exemption are both scoped to that prefix, and the payload
  // contract here is GitHub's rather than ADP's — the same reason the
  // per-repository receiver is exempt.
  app.post("/webhooks/github/app", async (req, reply) => {
    const rawBody = req.body as Buffer;
    const existing = await findGitHubApp(db);
    if (!existing) {
      // 404 rather than an error: an instance with no App is not misconfigured,
      // it is one that never ran the manifest flow, and GitHub is not
      // delivering to it in that state anyway.
      reply.code(404).send({ message: "this instance has no GitHub App" });
      return;
    }

    const secret = decryptCredential(existing.webhookSecretCiphertext, credentialKey);
    if (!verifyAppSignature(secret, rawBody, req.headers["x-hub-signature-256"] as string | undefined)) {
      reply.code(401).send({ message: "invalid signature" });
      return;
    }

    let payload: GitHubEventPayload & {
      installation?: { id?: number; account?: { login?: string } };
      repository?: { full_name?: string; html_url?: string };
    };
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      reply.code(400).send({ message: "malformed payload" });
      return;
    }

    const event = (req.headers["x-github-event"] as string | undefined) ?? "";
    const installationId = payload.installation?.id ? String(payload.installation.id) : null;

    // The lifecycle events. `deleted` and `suspend` mark the installation gone
    // rather than removing it: "uninstalling is clean" means ADP stops
    // receiving events, not that the record of what it ingested while installed
    // disappears.
    if (event === "installation" || event === "installation_repositories") {
      if (!installationId) {
        reply.send({ ok: true, skipped: "installation event names no installation" });
        return;
      }
      const action = (payload as { action?: string }).action;
      if (action === "deleted" || action === "suspend") {
        await suspendInstallation(db, existing.id, installationId);
        reply.send({ ok: true, installation: "suspended" });
        return;
      }
      await recordInstallation(db, existing.id, installationId, payload.installation?.account?.login ?? "");
      reply.send({ ok: true, installation: "recorded" });
      return;
    }

    const fullName = payload.repository?.full_name;
    if (!fullName) {
      reply.send({ ok: true, skipped: `event '${event}' names no repository` });
      return;
    }

    // The App is installed on a GitHub repository; ADP knows it through the
    // mirror pointing at it. An installed repository that nobody has run
    // `adp init` against is not an error — the installer selected it through
    // GitHub's picker, which is a wider gesture than configuring a mirror.
    // The host from the repository's own URL, so an App on GitHub Enterprise
    // finds the mirror configured against that hostname rather than one
    // configured against github.com.
    const found = await findMirrorsByUpstream(db, hostOfRepository(payload.repository), fullName);
    if (found.length === 0) {
      reply.send({ ok: true, skipped: `no mirrored repository for ${fullName}` });
      return;
    }

    // Every ADP repository mirroring this upstream, not the first one. Nothing
    // stops two of them, and picking one would make which gets the record an
    // arbitrary function of insertion order.
    const results = [];
    for (const { repo, mirror } of found) {
      results.push({
        repo: `${repo.owner}/${repo.name}`,
        ...(await dispatchGitHubEvent(
          { db, gitBackend, signer, credentialKey, publicUrl },
          event,
          payload,
          repo,
          mirror,
        )),
      });
    }
    reply.send(results.length === 1 ? results[0] : { ok: true, results });
  });
}

function hostOfRepository(repository: { html_url?: string } | undefined): string {
  try {
    return new URL(repository?.html_url ?? "").host || "github.com";
  } catch {
    return "github.com";
  }
}
