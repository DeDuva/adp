import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { requireScope } from "../auth/plugin.js";
import { findRepo } from "../core/repos-lookup.js";
import { findMirror } from "../core/mirrors-lookup.js";
import { decryptCredential } from "../core/mirror-crypto.js";

// Read-only GitHub Actions passthrough for mirrored repos
// (docs/pragmatic_mvp.md M2, "Read-only Actions passthrough").
//
// In mirror mode the upstream repo is on GitHub by definition, so `gh run list`
// and `gh run view` can be made to work against GH_HOST=adp by relaying the
// read endpoints upstream instead of returning 404. This adds no workflow
// engine: it is mirror-mode-only by construction, and every write path
// (dispatch, re-run, cancel) stays unimplemented, because a write would make
// ADP responsible for an execution model it deliberately does not have.
//
// Relay, do not record. The authoritative evidence row for a run is written by
// webhook ingest when the run completes (core/actions-ingest.ts). A proxy that
// also recorded would produce two provenance records for one CI run and leave
// the operations log describing a read as though it were a state change — so
// the evidence plane keeps exactly one writer, and it is not this file.

// GitHub's own paths, relative to a repo. Kept as a list so the route table and
// the upstream URL are derived from one place and cannot drift apart.
const RELAYED = [
  { adp: "/actions/runs", upstream: "/actions/runs" },
  { adp: "/actions/runs/:runId", upstream: "/actions/runs/:runId" },
  { adp: "/actions/runs/:runId/jobs", upstream: "/actions/runs/:runId/jobs" },
  { adp: "/actions/workflows", upstream: "/actions/workflows" },
] as const;

// https://github.com/<owner>/<repo>(.git) -> { owner, repo }. Mirrors are
// created against a GitHub HTTPS remote (http-rest/mirrors.ts validates the
// URL), so anything else here is a misconfiguration worth surfacing rather
// than guessing at.
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function registerActionsRoutes(
  app: FastifyInstance,
  db: Db,
  credentialKey: string,
  // Injectable so tests can stand up a fake upstream instead of reaching
  // api.github.com — same shape core/dependency-admission.ts uses.
  fetchImpl: typeof fetch = fetch,
) {
  for (const route of RELAYED) {
    app.get(
      `/api/v3/repos/:owner/:repo${route.adp}`,
      { preHandler: requireScope("repo:read") },
      async (req, reply) => {
        const params = req.params as { owner: string; repo: string; runId?: string };
        const { owner, repo: name } = params;

        const repo = await findRepo(db, owner, name);
        if (!repo) {
          reply.code(404).send({ message: `Repository ${owner}/${name} not found` });
          return;
        }

        const mirror = await findMirror(db, repo.id);
        // A disabled mirror is treated exactly like no mirror at all. The
        // passthrough decrypts and forwards the operator's PAT upstream, and
        // `enabled: false` is how an operator stops ADP talking to GitHub for
        // this repo — mirror-webhook.ts already honours it on ingest, so a
        // read path that ignored it would leave "disabled" meaning two
        // different things in two files.
        //
        // Direction is deliberately *not* checked. An outbound-only mirror is
        // still a repo whose code is on GitHub with Actions running against it,
        // and since the webhook route only ingests for inbound|both, this
        // passthrough is the sole way such a repo's CI results are visible at
        // all — narrowing by direction would remove that rather than tighten
        // anything.
        if (!mirror || !mirror.enabled) {
          // The passthrough is a property of *being mirrored*, not of the
          // endpoint. A self-describing 404 (§2.4) costs an agent one turn;
          // a hang or a 500 costs it the trajectory.
          reply.code(404).send({
            message: "Actions is not implemented for non-mirrored repositories",
            documentation_url: "https://github.com/DeDuva/adp/blob/main/docs/pragmatic_mvp.md",
            adp_equivalent:
              "ADP does not run workflows. Gates are `image + commands` in adp.yaml and report to " +
              "POST /api/v3/repos/{owner}/{repo}/gates; read them back from " +
              "GET /api/v3/repos/{owner}/{repo}/commits/{ref}/check-runs. For a repo mirrored from " +
              "GitHub, these Actions endpoints relay upstream instead.",
          });
          return;
        }

        const upstream = parseGitHubRemote(mirror.remoteUrl);
        if (!upstream) {
          reply.code(502).send({
            message: `mirror remote '${mirror.remoteUrl}' is not a recognisable GitHub repository URL`,
          });
          return;
        }

        const path = route.upstream.replace(":runId", encodeURIComponent(params.runId ?? ""));
        const query = req.raw.url?.includes("?") ? `?${req.raw.url.split("?")[1]}` : "";
        const target = `https://api.github.com/repos/${upstream.owner}/${upstream.repo}${path}${query}`;

        let res: Response;
        try {
          res = await fetchImpl(target, {
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              Authorization: `Bearer ${decryptCredential(mirror.credentialCiphertext, credentialKey)}`,
              "User-Agent": "adp-mirror-passthrough",
            },
          });
        } catch (err) {
          // Never a synthesized empty run list: an agent that believes CI
          // passed because the proxy fabricated silence is the worst outcome
          // available here.
          reply.code(502).send({
            message: `upstream GitHub request failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }

        const body = await res.text();
        if (!res.ok) {
          reply.code(502).send({
            message: `upstream GitHub returned ${res.status} for ${upstream.owner}/${upstream.repo}${path}`,
            upstream_status: res.status,
            upstream_body: body.slice(0, 2000),
          });
          return;
        }

        reply.code(200).type(res.headers.get("content-type") ?? "application/json").send(body);
      },
    );
  }
}
