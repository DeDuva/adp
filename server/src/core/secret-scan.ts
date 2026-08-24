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

function scanLine(line: string): Omit<SecretFinding, "line">[] {
  const findings: Omit<SecretFinding, "line">[] = [];
  const excerpt = line.trim().slice(0, 200);

  for (const { name, re } of REGEX_PATTERNS) {
    if (re.test(line)) findings.push({ pattern: name, excerpt });
  }

  if (findings.length === 0) {
    for (const match of line.matchAll(ENTROPY_TOKEN_RE)) {
      if (shannonEntropy(match[0]) >= ENTROPY_THRESHOLD) {
        findings.push({ pattern: "high-entropy-string", excerpt });
        break;
      }
    }
  }

  return findings;
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
