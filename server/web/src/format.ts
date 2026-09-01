import type { RunVerification, TrajectoryEvent, VerifySession } from "./api.js";

// Rendering decisions that are worth testing, kept out of the components so
// they can be. The browser-driven acceptance spec is not a CI gate — it runs
// only under `make acceptance-ui` — so anything here that could silently render
// the wrong thing has to be a function with a vitest around it, the same
// argument api.test.ts makes about hand-copied enums.

// Cost is stored in micro-USD because a trajectory's per-event cost is far
// below a cent and floating-point dollars lose it. Render it as money, and
// never round a nonzero cost to "$0.00" — a caller comparing two arms needs to
// see that the cheap one still cost something.
export function formatCost(microUsd: number | null): string {
  if (microUsd === null) return "—";
  if (microUsd === 0) return "$0";
  const usd = microUsd / 1_000_000;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(n: number | null): string {
  if (n === null) return "—";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function shortSha(sha: string | null, length = 8): string {
  return sha ? sha.slice(0, length) : "—";
}

// #152 / #156: verification is two separate answers plus a statement of how
// much was looked at, and the badge must not collapse them.
//
//   chains   — the events ADP holds were not edited
//   emitters — ADP was given all of them
//
// A run can pass the first and fail the second, and that combination is the
// interesting one: a perfectly verified chain that is missing events the
// emitter numbered and never delivered. So this returns both, and `tone` is
// derived from the pair rather than from the single `ok`.
export type VerificationTone = "ok" | "warn" | "bad" | "unknown";

export interface VerificationBadge {
  tone: VerificationTone;
  chains: { tone: VerificationTone; label: string };
  emitters: { tone: VerificationTone; label: string };
  attestation: { tone: VerificationTone; label: string };
  // How much of each chain was recomputed, stated rather than implied. Null
  // when every session was verified in full, which is the ordinary case and
  // does not need saying.
  partial: string | null;
}

export function verificationBadge(v: RunVerification): VerificationBadge {
  const chains = v.chains_ok
    ? { tone: "ok" as const, label: "chains verify" }
    : { tone: "bad" as const, label: "a chain does not verify" };

  // Untracked is not incomplete. An emitter that never claimed completeness has
  // not failed to deliver it, and colouring that red would teach people to
  // ignore the badge.
  const tracked = v.sessions.filter((s) => s.emitter_tracked);
  const emitters =
    tracked.length === 0
      ? { tone: "unknown" as const, label: "no emitter counted" }
      : v.emitters_ok
        ? { tone: "ok" as const, label: "nothing was dropped" }
        : { tone: "bad" as const, label: "events were never delivered" };

  const attestation =
    v.envelope_verified === null
      ? { tone: "unknown" as const, label: "not attested" }
      : !v.envelope_verified
        ? { tone: "bad" as const, label: "signature does not verify" }
        : v.trajectory_digest_matches === false
          ? { tone: "bad" as const, label: "attested digest does not match" }
          : { tone: "ok" as const, label: "attestation checks out" };

  const anchored = v.sessions.filter((s) => s.prefix !== "recomputed");
  const partial =
    anchored.length === 0
      ? null
      : `${anchored.length} of ${v.sessions.length} chains verified from a signed checkpoint, not from the start`;

  const tones = [chains.tone, emitters.tone, attestation.tone];
  const tone: VerificationTone = tones.includes("bad")
    ? "bad"
    : tones.includes("unknown")
      ? "warn"
      : "ok";

  return { tone, chains, emitters, attestation, partial };
}

// The one-line answer for a session row, on the same terms.
export function sessionVerdict(s: VerifySession): string {
  if (!s.ok) return s.reason ?? "does not verify";
  const range = s.prefix === "recomputed" ? "from the start" : `from event ${s.verified_from_seq}`;
  const dropped = s.emitter_tracked && !s.emitter_complete ? `, missing from ${s.emitter_first_gap}` : "";
  return `${s.verified_to_seq} events verified ${range}${dropped}`;
}

// What a payload is, without the server ever having parsed it.
//
// **Payloads are opaque to the server by invariant** — nothing server-side
// branches on their contents, which is what keeps the protocol harness-neutral.
// That invariant is about the *server*. A client may render what it recognises,
// because rendering is not branching: nothing downstream depends on the guess,
// and a guess that is wrong shows a slightly worse preview rather than
// corrupting a record. Doing this server-side would be the violation; doing it
// here is the reason the typed columns exist beside the payload at all.
//
// #199: under the default `payloads: structure` policy every string has already
// been replaced by `[adp:str bytes=N]`, so what reaches the browser is shape
// rather than content. The preview says so instead of pretending otherwise.
export function payloadPreview(event: TrajectoryEvent, limit = 120): string {
  const payload = event.payload;
  if (payload === null || payload === undefined) return "—";
  if (typeof payload === "string") return projectedOr(payload, limit);
  if (typeof payload !== "object") return truncate(String(payload), limit);

  const record = payload as Record<string, unknown>;
  // The keys a harness most often puts the human-readable part under. Tried in
  // order, and a miss falls through to the shape — never to an exception.
  for (const key of ["text", "message", "content", "command", "summary", "name"]) {
    const value = record[key];
    if (typeof value === "string" && !isProjectedString(value)) return truncate(value, limit);
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return "{}";
  return truncate(`{ ${keys.join(", ")} }`, limit);
}

// #199 stores a payload as its *structure* by default: objects, arrays, keys,
// numbers and booleans kept, and every string replaced by `[adp:str bytes=N]`.
//
// Rendering that marker as the event's content is worse than rendering nothing.
// It reads as something the agent said, it is the same on every row, and it
// pushes the columns that *do* still say what happened — the tool's name, its
// verdict, what it cost, how long it took — off to the side. So a projected
// string is not content, and the preview falls through to the shape instead.
const PROJECTED = /^\[adp:str bytes=\d+\]$/;

export function isProjectedString(value: string): boolean {
  return PROJECTED.test(value.trim());
}

function projectedOr(value: string, limit: number): string {
  return isProjectedString(value) ? "(text not retained)" : truncate(value, limit);
}

// #199 again: a payload stored as structure carries a digest of what was
// actually sent, and a reader has to be able to tell "this is all there was"
// from "this is what is left of it".
export function payloadIsProjected(event: TrajectoryEvent): boolean {
  return event.payload_digest !== null;
}

function truncate(s: string, limit: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

// The label a run row leads with. `labels` is where an A/B arm records what it
// was, and it is signed inside the run attestation — so this reads the arm, not
// a guess from `external_ref`, whose format nothing enforces.
export function runArm(labels: Record<string, string>): string {
  const model = labels.model ?? labels.Model;
  const provider = labels.provider ?? labels.Provider;
  const harness = labels.harness ?? labels.Harness;
  const parts = [harness, provider, model].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}
