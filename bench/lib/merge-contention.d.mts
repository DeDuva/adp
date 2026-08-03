// Types for the plain-JS driver, so the server's TypeScript e2e suite can drive
// the same implementation the published benchmark uses rather than a copy.
export interface MergeContentionOptions {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
  writers?: number;
  baseRef?: string;
  maxRetriesPerWriter?: number;
  now?: () => number;
}

export interface MergeContentionResult {
  arm: "merge-contention";
  config: { writers: number; baseRef: string; maxRetriesPerWriter: number };
  landed: number;
  failed: number;
  wallClockMs: number;
  landsPerSecond: number;
  totalAttempts: number;
  totalConflicts: number;
  conflictRate: number;
  retriesPerWriter: { max: number; mean: number; distribution: number[] };
  landLatencyMs: { p50: number; p95: number; max: number };
  failures: { writer: number; stage: string; status?: number; body?: unknown; reason?: string }[];
}

export function runMergeContention(options: MergeContentionOptions): Promise<MergeContentionResult>;
