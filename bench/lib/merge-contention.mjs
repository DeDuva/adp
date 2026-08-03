// Arm 1 of the M3 benchmark: merge contention.
//
// The merge-bottleneck hypothesis is the thesis this whole project rests on,
// and until now it had zero first-party measurement (docs/m2-readiness-review.md
// §1, "the measurement gap"). This arm is the measurement: N writers race to
// land on one branch, each retrying its own rebase when the base moves under it.
//
// Deliberately model-free. There is no agent here and no LLM call — the point is
// to measure ADP's land path under contention, not an agent's ability to drive
// it, and a deterministic driver is one that can run in CI on every change and
// be reproduced exactly by a reader. The agent-backed arms (cost comparison,
// fan-out vs serial) are separate and run out of band; see bench/README.md.
//
// Everything goes over the REST API — blobs, trees, commits, refs, proposals,
// merges — so no clone is involved and clone cost never contaminates the land
// latency being measured.

const json = { "Content-Type": "application/json" };

class Api {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  async call(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : json) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  get = (p) => this.call("GET", p);
  post = (p, b) => this.call("POST", p, b);
  put = (p, b) => this.call("PUT", p, b);

  // GET /git/refs/<path> is a *prefix* match returning an array (GitHub's own
  // shape), so `refs/heads/main` would also match `refs/heads/main-2`. Pick the
  // exact ref rather than trusting position — as this arm creates a branch per
  // attempt, the array is not small and its order is not a contract.
  async refSha(owner, repo, ref) {
    const res = await this.get(`/api/v3/repos/${owner}/${repo}/git/${ref}`);
    if (res.status !== 200 || !Array.isArray(res.body)) {
      throw new Error(`cannot read ${ref}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const match = res.body.find((r) => r.ref === ref);
    if (!match) throw new Error(`ref ${ref} not found among ${res.body.length} matches`);
    return match.object.sha;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Race `writers` concurrent landers against one branch.
 *
 * Each writer loops: read the base tip, build a commit on it touching its own
 * file, open a proposal, try to merge. A 409 means the base moved — the writer
 * rebases (rebuilds its commit on the new tip) and tries again, which is
 * precisely what the MVP land model tells an agent to do (§2.5) and therefore
 * what the thesis's "bottleneck on merge" would actually look like in practice.
 *
 * Writers touch distinct paths, so every 409 is *ref contention* rather than a
 * textual conflict. That separation is the point: it measures the cost the
 * serial-land design imposes even when the work itself does not overlap, which
 * is the quantity A17 ("contention avoided upstream") is really about.
 */
export async function runMergeContention({
  baseUrl,
  token,
  owner,
  repo,
  writers = 8,
  baseRef = "main",
  maxRetriesPerWriter = 50,
  now = () => performance.now(),
}) {
  const api = new Api(baseUrl, token);

  const fullBaseRef = `refs/heads/${baseRef}`;
  const startingSha = await api.refSha(owner, repo, fullBaseRef);

  const attemptsByWriter = new Array(writers).fill(0);
  const conflictsByWriter = new Array(writers).fill(0);
  const latencies = [];
  const failures = [];

  const startedAt = now();

  const results = await Promise.all(
    Array.from({ length: writers }, async (_unused, i) => {
      const writerStart = now();
      let baseSha = startingSha;

      for (let attempt = 0; attempt <= maxRetriesPerWriter; attempt++) {
        attemptsByWriter[i]++;

        // Rebuild on the *current* base each attempt — that is what "rebase and
        // retry" means, and reusing a stale commit would just 409 forever.
        baseSha = await api.refSha(owner, repo, fullBaseRef);

        // `base_tree` takes the commit sha directly: the server resolves it with
        // `git ls-tree`, which accepts any commit-ish. That saves a round-trip
        // per attempt, and round-trips per attempt are the thing being measured.
        const tree = await api.post(`/api/v3/repos/${owner}/${repo}/git/trees`, {
          base_tree: baseSha,
          tree: [{ path: `writer-${i}.txt`, mode: "100644", type: "blob", content: `writer ${i} attempt ${attempt}\n` }],
        });

        const commit = await api.post(`/api/v3/repos/${owner}/${repo}/git/commits`, {
          message: `writer ${i} attempt ${attempt}`,
          tree: tree.body.sha,
          parents: [baseSha],
        });

        const branch = `bench/writer-${i}-${attempt}`;
        await api.post(`/api/v3/repos/${owner}/${repo}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: commit.body.sha,
        });

        const proposal = await api.post(`/api/v3/repos/${owner}/${repo}/pulls`, {
          title: `writer ${i} attempt ${attempt}`,
          head: branch,
          base: baseRef,
        });
        if (proposal.status !== 201) {
          failures.push({ writer: i, stage: "propose", status: proposal.status, body: proposal.body });
          return { writer: i, landed: false };
        }

        const merge = await api.put(`/api/v3/repos/${owner}/${repo}/pulls/${proposal.body.number}/merge`, {
          merge_method: "merge",
        });

        if (merge.status === 200) {
          latencies.push(now() - writerStart);
          return { writer: i, landed: true, attempts: attemptsByWriter[i] };
        }
        if (merge.status === 409) {
          // The base moved between our ancestry check and the CAS. This is the
          // measurement — count it and go around again.
          conflictsByWriter[i]++;
          continue;
        }

        failures.push({ writer: i, stage: "merge", status: merge.status, body: merge.body });
        return { writer: i, landed: false };
      }

      failures.push({ writer: i, stage: "merge", reason: `exceeded ${maxRetriesPerWriter} retries` });
      return { writer: i, landed: false };
    }),
  );

  const wallClockMs = now() - startedAt;
  const landed = results.filter((r) => r.landed).length;
  const totalAttempts = attemptsByWriter.reduce((a, b) => a + b, 0);
  const totalConflicts = conflictsByWriter.reduce((a, b) => a + b, 0);
  const sortedLatencies = [...latencies].sort((a, b) => a - b);

  return {
    arm: "merge-contention",
    config: { writers, baseRef, maxRetriesPerWriter },
    landed,
    failed: writers - landed,
    wallClockMs,
    // Lands per second across the whole race — the throughput number the
    // thesis is actually about.
    landsPerSecond: wallClockMs > 0 ? (landed / wallClockMs) * 1000 : 0,
    totalAttempts,
    totalConflicts,
    // Required output, not optional: A17 and the M5 speculative-batching gate
    // both consume conflict rate specifically, not throughput alone.
    conflictRate: totalAttempts > 0 ? totalConflicts / totalAttempts : 0,
    retriesPerWriter: {
      max: Math.max(0, ...conflictsByWriter),
      mean: writers > 0 ? totalConflicts / writers : 0,
      distribution: conflictsByWriter,
    },
    landLatencyMs: {
      p50: percentile(sortedLatencies, 50),
      p95: percentile(sortedLatencies, 95),
      max: sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1] : 0,
    },
    failures,
  };
}
