// Types for the plain-JS driver, so the server's TypeScript e2e suite can drive
// the same implementation the published benchmark uses rather than a copy.
export interface StorageGrowthScale {
  bytesEvents: number;
  ingestEvents: number;
  writers: number;
  batchSize: number;
  checkpointEvery: number;
  lands: number;
}

export const DEFAULT_SCALE: Readonly<StorageGrowthScale>;
export const CI_SCALE: Readonly<StorageGrowthScale>;
export const OBSERVED_MEAN_PAYLOAD_BYTES: number;
export const RECORDER_BATCH_SIZE: number;

export interface ServerRss {
  reset(): void | Promise<void>;
  peak(): { baselineBytes: number; peakBytes: number } | Promise<{ baselineBytes: number; peakBytes: number }>;
}

export interface StorageGrowthOptions {
  baseUrl: string;
  token: string;
  owner: string;
  sql: (text: string, params?: unknown[]) => Promise<Record<string, any>[]>;
  rss?: ServerRss | null;
  gitBytes?: ((owner: string, repo: string) => Promise<number>) | null;
  scale?: StorageGrowthScale;
  seed?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export interface RelationDelta {
  rows: number;
  heap: number;
  toast: number;
  indexes: number;
  other: number;
  total: number;
}

export interface Dedup {
  documents: number;
  distinctDocuments: number;
  bytes: number;
  distinctBytes: number;
}

export interface StorageGrowthResult {
  arm: "storage-growth";
  config: StorageGrowthScale & {
    seed: number;
    batchPayloadBudgetBytes: number;
    maxPayloadBytes: number;
    observedMeanPayloadBytes: number;
  };
  postgres: { version: string; toastCompression: string };
  wallClockMs: number;
  events: {
    mode: "structure" | "full";
    profile: "text" | "random";
    events: number;
    wallClockMs: number;
    suppliedPayloadBytes: number;
    stored: {
      digestedEvents: number;
      redactedEvents: number;
      rowBytes: number;
      payloadDatumBytes: number;
      payloadUncompressedBytes: number;
      compressedRows: number;
    };
    relation: RelationDelta;
    compression: { perEventDeflateBytes: number; batchedDeflateBytes: Record<string, number> };
    dedup: { payloadTextBytes: number; distinctPayloadTextBytes: number };
  }[];
  ingest: {
    writers: number;
    batchSize: number;
    events: number;
    rowBytes: number;
    wallClockMs: number;
    relation: RelationDelta;
    /** [writer, completed-at ms since ingest start, events, latency ms] */
    batches: [number, number, number, number][];
  };
  checkpoints: {
    count: number;
    rowBytes: number;
    stateDatumBytes: number;
    envelopeDatumBytes: number;
    relation: RelationDelta;
    latencyMs: number[];
  };
  verify: {
    target: "run" | "session";
    coverage: "full" | "from-checkpoint";
    sessions: number;
    events: number;
    ms: number;
    baselineRssBytes: number | null;
    peakRssBytes: number | null;
    peakRssOverBaselineBytes: number | null;
  }[];
  lands: {
    count: number;
    latencyMs: number[];
    gitBytes: { before: number; after: number } | null;
    relation: Record<"changes" | "proposals" | "gate_results" | "operations", RelationDelta>;
    rows: Record<"changes" | "proposals" | "gate_results" | "operations", { rows: number; rowBytes: number }>;
    sbom: { envelopeDatumBytes: number; statement: Dedup; withoutSerialAndTimestamp: Dedup; components: Dedup };
  };
  operations: { byVerb: { verb: string; rows: number; rowBytes: number }[]; relation: RelationDelta };
  meter: Record<string, { rows: number; rowBytes: number; relationBytes: number }>;
}

export function runStorageGrowth(options: StorageGrowthOptions): Promise<StorageGrowthResult>;

export function dropArmDatabase(
  query: (text: string, params?: unknown[]) => Promise<Record<string, any>[]>,
  name: string,
  options?: { timeoutMs?: number },
): Promise<void>;
