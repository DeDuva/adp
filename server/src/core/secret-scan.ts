// Bundled regex+entropy push-protection engine (
// §1.5 item — "pluggable provider API" for later, this is the first-party
// default). Deliberately conservative: false positives block a legitimate
// push, which is annoying but recoverable (rebase and retry); false
// negatives are the failure mode this whole feature exists to avoid.
export interface SecretFinding {
  pattern: string;
  line: number;
  excerpt: string;
}

export interface SecretScanProvider {
  // Scans a unified diff's *added* lines only — what's actually being
  // introduced by this push, not context or removed lines.
  scanDiff(patch: string): SecretFinding[];
}

const REGEX_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "aws-secret-access-key", re: /aws(.{0,20})?(secret|access)?_?key.{0,5}['"][0-9a-zA-Z/+]{40}['"]/i },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,255}/ },
  { name: "private-key-block", re: /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  { name: "slack-token", re: /xox[baprs]-[0-9A-Za-z-]{10,48}/ },
  { name: "generic-secret-assignment", re: /(secret|api[_-]?key|token|password)\s*[:=]\s*['"][A-Za-z0-9/+=_-]{16,}['"]/i },
];

// Shannon entropy in bits/char — high entropy over a long-enough run of
// token-shaped characters is the generic catch-all for secrets no named
// pattern covers (random API keys, generated passwords).
function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const ENTROPY_TOKEN_RE = /[A-Za-z0-9/+_-]{24,}/g;
const ENTROPY_THRESHOLD = 4.3;

// One pattern's hits in one line, with where they are. #148 needs the spans:
// push protection only had to *report* a match, but a trajectory is redacted
// rather than refused, and you cannot replace what you cannot locate.
interface PatternHit {
  pattern: string;
  spans: [number, number][];
}

// `scanDiff` reports one finding per pattern per line, and that is the
// behaviour push protection has always had. Collecting every span while
// keeping one *finding* per pattern preserves it exactly — the extra spans
// exist for the redactor, which has to replace all of them.
function hitsIn(line: string): PatternHit[] {
  const hits: PatternHit[] = [];

  for (const { name, re } of REGEX_PATTERNS) {
    // The patterns are declared without /g so that `test` stays stateless for
    // every existing caller; a per-call global copy is how this reads spans
    // without mutating shared state through `lastIndex`.
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    const spans: [number, number][] = [];
    for (const match of line.matchAll(global)) {
      if (match.index === undefined || match[0].length === 0) continue;
      spans.push([match.index, match.index + match[0].length]);
    }
    if (spans.length > 0) hits.push({ pattern: name, spans });
  }

  // Unchanged precedence: the entropy catch-all only speaks when no named
  // pattern did, so a matched AWS key is reported as an AWS key.
  if (hits.length === 0) {
    const spans: [number, number][] = [];
    for (const match of line.matchAll(ENTROPY_TOKEN_RE)) {
      if (match.index === undefined) continue;
      if (shannonEntropy(match[0]) >= ENTROPY_THRESHOLD) {
        spans.push([match.index, match.index + match[0].length]);
      }
    }
    if (spans.length > 0) hits.push({ pattern: "high-entropy-string", spans });
  }

  return hits;
}

function scanLine(line: string): Omit<SecretFinding, "line">[] {
  const excerpt = line.trim().slice(0, 200);
  return hitsIn(line).map((hit) => ({ pattern: hit.pattern, excerpt }));
}

// #148: the same engine, pointed at free text rather than at a unified diff.
//
// Push protection guards the *diff*. A trajectory records what the agent
// **read** — file contents pulled into context, environment inspected, tool
// output returned — so a `.env` the agent opened and correctly declined to
// commit never appears in any diff and would appear verbatim in a tool-call
// payload. This is where the engine runs, not a second engine: "adapters,
// never scanners" is untouched.
export function scanText(text: string): { pattern: string }[] {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    for (const hit of hitsIn(line)) seen.add(hit.pattern);
  }
  return [...seen].map((pattern) => ({ pattern }));
}

/**
 * Replace every detected secret in `text` with a marker naming the pattern
 * that fired.
 *
 * Never a silent alteration: the marker is visible in the stored value, and
 * the caller records the patterns separately so a reader sees that a redaction
 * happened without having to notice it in the text. A silently altered event
 * is a durable record that looks complete, which is worse than either a
 * refusal or an obvious hole.
 */
export function redactText(text: string): { text: string; patterns: string[] } {
  const patterns = new Set<string>();
  const lines = text.split("\n").map((line) => {
    const hits = hitsIn(line);
    if (hits.length === 0) return line;

    // Right to left, so an earlier replacement cannot shift the offsets of a
    // later one. Overlapping spans from two patterns are merged under the
    // first pattern that claimed the region rather than nested.
    const spans = hits
      .flatMap((hit) => hit.spans.map((span) => ({ span, pattern: hit.pattern })))
      .sort((a, b) => b.span[0] - a.span[0]);

    let out = line;
    let lastStart = Number.POSITIVE_INFINITY;
    for (const { span, pattern } of spans) {
      if (span[1] > lastStart) continue;
      patterns.add(pattern);
      out = `${out.slice(0, span[0])}[redacted:${pattern}]${out.slice(span[1])}`;
      lastStart = span[0];
    }
    return out;
  });

  return { text: lines.join("\n"), patterns: [...patterns] };
}

// Bundled default: the built-in engine every instance runs below the policy
// floor — a pluggable provider API for external
// scanners is scoped for later (§1.5's scanner-as-gate adapters, M2), not
// implemented here.
export class BundledSecretScanProvider implements SecretScanProvider {
  scanDiff(patch: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    const lines = patch.split("\n");
    let addedLineNumber = 0;

    for (const line of lines) {
      // Hunk headers (@@ -a,b +c,d @@) carry the starting line number for
      // the "new" side; every added line after one increments from there.
      const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunkMatch) {
        addedLineNumber = Number(hunkMatch[1]);
        continue;
      }
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (!line.startsWith("+")) continue;

      for (const finding of scanLine(line.slice(1))) {
        findings.push({ ...finding, line: addedLineNumber });
      }
      addedLineNumber++;
    }

    return findings;
  }
}
