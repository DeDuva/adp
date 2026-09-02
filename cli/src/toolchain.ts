// #153: what a repository already says about itself.
//
// `adp.yaml` asks for the gate names, the runner's image, its setup command and
// what each gate runs — and a repository has already answered all four. The
// lockfile names the ecosystem, the scripts block names the gates, and the
// presence of a lockfile at all decides whether setup is `npm ci` or
// `npm install`. Asking a person to retype it is asking them to restate what
// they have already written down.
//
// **Detect and write, don't prompt.** Detection is right most of the time and a
// wrong default is a two-line edit; a prompt is a decision the user is least
// equipped to make on the day they know least about the system asking. So this
// writes, prints what it wrote, and says to review it.

export interface DetectedGate {
  name: string;
  run: string;
}

export interface Toolchain {
  /** What was recognised — `node`, `python`, … — or null when nothing was. */
  ecosystem: string | null;
  image: string;
  setup: string | null;
  gates: DetectedGate[];
  /** Files this conclusion was drawn from, so the write can say why. */
  evidence: string[];
}

/** The repository's own files, as a set of paths relative to its root. */
export interface RepoFiles {
  has(path: string): boolean;
  read(path: string): string | null;
}

// Ordered: the first ecosystem whose marker is present wins. A polyglot
// repository gets one answer and a note rather than a merged guess, because a
// merged guess produces an `adp.yaml` that runs neither toolchain correctly.
const ECOSYSTEMS: {
  name: string;
  markers: string[];
  image: string;
  detect(files: RepoFiles): { setup: string | null; gates: DetectedGate[] };
}[] = [
  {
    name: "node",
    // `package.json` is what decides; the lockfile is listed so that the
    // evidence a write reports names every file the conclusion was drawn from.
    markers: ["package.json", "package-lock.json"],
    // Pinned to a major rather than `latest`: a gate whose image drifts under
    // it is a gate whose failures nobody can reproduce.
    image: "node:22",
    detect(files) {
      // `npm ci` requires a lockfile and fails loudly without one, which is the
      // right command when there is one and the wrong one when there is not.
      const setup = files.has("package-lock.json") ? "npm ci" : "npm install";
      const scripts = scriptsOf(files.read("package.json"));
      const gates: DetectedGate[] = [];
      // The scripts a repository actually gates on, in the order a reader
      // would run them. Only scripts that exist — an `adp.yaml` naming a
      // script the repo does not have is a gate that can only ever fail.
      for (const name of ["lint", "typecheck", "build", "test"]) {
        if (scripts.includes(name)) gates.push({ name, run: `npm run ${name}` });
      }
      // `npm test` is special-cased by npm itself and is often the only one.
      if (gates.length === 0 && scripts.includes("test")) gates.push({ name: "test", run: "npm test" });
      return { setup, gates };
    },
  },
  {
    name: "python",
    markers: ["pyproject.toml", "requirements.txt", "setup.py"],
    image: "python:3.12",
    detect(files) {
      const setup = files.has("requirements.txt")
        ? "pip install -r requirements.txt"
        : files.has("pyproject.toml")
          ? "pip install -e ."
          : null;
      return { setup, gates: [{ name: "test", run: "pytest" }] };
    },
  },
  {
    name: "go",
    markers: ["go.mod"],
    image: "golang:1.23",
    detect() {
      return { setup: "go mod download", gates: [{ name: "test", run: "go test ./..." }] };
    },
  },
  {
    name: "rust",
    markers: ["Cargo.toml"],
    image: "rust:1",
    detect() {
      return { setup: "cargo fetch", gates: [{ name: "test", run: "cargo test" }] };
    },
  },
  {
    name: "ruby",
    markers: ["Gemfile"],
    image: "ruby:3.3",
    detect() {
      return { setup: "bundle install", gates: [{ name: "test", run: "bundle exec rake test" }] };
    },
  },
];

export function detectToolchain(files: RepoFiles): Toolchain {
  for (const eco of ECOSYSTEMS) {
    const marker = eco.markers.find((m) => files.has(m));
    if (!marker) continue;
    const { setup, gates } = eco.detect(files);
    const evidence = eco.markers.filter((m) => files.has(m));
    return { ecosystem: eco.name, image: eco.image, setup, gates, evidence };
  }
  // Nothing recognised is a real answer, not a failure. A repository ADP cannot
  // read is still a repository ADP can host — it just gets an `adp.yaml` with
  // no runner block, and a line saying so.
  return { ecosystem: null, image: "node:22", setup: null, gates: [], evidence: [] };
}

function scriptsOf(packageJson: string | null): string[] {
  if (!packageJson) return [];
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    return Object.keys(parsed.scripts ?? {});
  } catch {
    // A package.json that does not parse is the repository's problem and not
    // this command's: detection degrades to "node, no gates" rather than
    // failing the init that was going fine until it read a file.
    return [];
  }
}

// The file, as it will be written. Rendered by hand rather than through a YAML
// library: this is a dozen lines with a fixed shape, the comments are the
// point, and a serializer would drop them.
export function renderAdpYaml(toolchain: Toolchain, options: { landRequire: string[] }): string {
  const lines: string[] = [
    "# Written by `adp init` from what this repository already says about itself.",
    "# Review it — detection is right most of the time, and a wrong default here is",
    "# a two-line edit rather than something you have to discover in a refusal.",
    "",
  ];

  if (toolchain.gates.length > 0) {
    lines.push("# The gates a change must satisfy before it can land.");
    lines.push("gates:");
    for (const gate of toolchain.gates) lines.push(`  - ${gate.name}`);
  } else {
    lines.push("# No gates detected. A repository with none still lands changes —");
    lines.push("# `gates_green` is satisfied vacuously — so this is a choice to make,");
    lines.push("# not a gap to fill in before anything works.");
    lines.push("gates: []");
  }
  lines.push("");

  lines.push("land:");
  if (options.landRequire.length === 0) {
    lines.push("  # Add `one_approval` once this repository has a second principal: it is");
    lines.push("  # author-independent, so a solo evaluator cannot satisfy it.");
    lines.push("  require: []");
  } else {
    lines.push("  require:");
    for (const req of options.landRequire) lines.push(`    - ${req}`);
  }
  lines.push("");

  if (toolchain.gates.length > 0) {
    lines.push("# What runs each gate, in an isolated container: network-deny, no host");
    lines.push("# mounts, no ambient secrets, resource caps. The image is pinned to a major");
    lines.push("# on purpose — a gate whose image drifts is one whose failures nobody can");
    lines.push("# reproduce.");
    lines.push("runner:");
    lines.push(`  image: ${toolchain.image}`);
    if (toolchain.setup) lines.push(`  setup: ${toolchain.setup}`);
    lines.push("  gates:");
    for (const gate of toolchain.gates) {
      lines.push(`    - name: ${gate.name}`);
      lines.push(`      run: ${gate.run}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
