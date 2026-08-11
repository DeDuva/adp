import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gateJobs } from "../db/schema.js";
import { setGateJobGauges } from "./telemetry.js";

// M4-11: the queue's own health, sampled rather than counted.
//
// M4-9 shipped four slices of gate-job machinery with no telemetry at all,
// which leaves the milestone's largest new component invisible to the
// dashboards this item exists to build. The two signals here are the ones an
// operator actually needs: how much work is sitting in the queue, and — the
// one that matters — how long the oldest unclaimed job has been sitting
// there. Depth alone cannot distinguish "busy" from "the runner fleet is
// dead": a hundred jobs draining in seconds and one job stuck for an hour
// are both "the queue is non-empty".
//
// Sampled on an interval instead of maintained incrementally at the
// claim/complete call sites because queue depth is a property of the table,
// not of this process. A job can change state without this process observing
// it (a second API replica, an operator's manual fix, a crash between the
// claim and the response), and an in-process running total would drift from
// the table with nothing to notice the drift. One cheap GROUP BY every 15s
// is always right.

export interface GateJobSample {
  byStatus: Map<string, number>;
  oldestQueuedAgeSeconds: number;
}

// Non-terminal only. A gauge over terminal states would grow without bound
// for the lifetime of the instance and say nothing about right now — that
// question is `adp_gate_job_completions_total`'s (a counter, so a rate), not
// this one's.
const NON_TERMINAL = ["queued", "running"] as const;

export async function sampleGateJobMetrics(db: Db): Promise<GateJobSample> {
  const rows = await db
    .select({
      status: gateJobs.status,
      count: sql<number>`count(*)::int`,
      oldestAgeSeconds: sql<number>`coalesce(extract(epoch from (now() - min(${gateJobs.createdAt})))::int, 0)`,
    })
    .from(gateJobs)
    .where(sql`${gateJobs.status} in ('queued', 'running')`)
    .groupBy(gateJobs.status);

  // Zero-fill: a status that has no rows must still be reported as 0, not
  // omitted. An omitted series is indistinguishable from a stopped scraper
  // on the receiving end, and "the queue just drained" is exactly when an
  // operator is most likely to be looking at the chart.
  const byStatus = new Map<string, number>(NON_TERMINAL.map((status) => [status, 0]));
  let oldestQueuedAgeSeconds = 0;
  for (const row of rows) {
    byStatus.set(row.status, Number(row.count));
    if (row.status === "queued") oldestQueuedAgeSeconds = Number(row.oldestAgeSeconds);
  }

  const sample = { byStatus, oldestQueuedAgeSeconds };
  setGateJobGauges(sample);
  return sample;
}

// Same shape as startMirrorPoller/startWorkspaceSweeper: an unref'd-by-nobody
// interval owned by main.ts. Deliberately *not* sampled inside the /metrics
// handler — that route is unauthenticated (it is an operator's scraper, not a
// repo-scoped resource), and putting a database query behind an
// unauthenticated endpoint hands anyone who can reach the box a way to make
// it do work.
export function startGateJobMetricsSampler(db: Db, intervalMs: number): NodeJS.Timeout {
  void sampleGateJobMetrics(db).catch((err) => {
    console.error("gate-job metrics sample failed:", err);
  });
  return setInterval(() => {
    sampleGateJobMetrics(db).catch((err) => {
      console.error("gate-job metrics sample failed:", err);
    });
  }, intervalMs);
}
