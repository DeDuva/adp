import { describe, it, expect } from "vitest";
import { redactEventPayloads, redactPayload } from "./trajectory-redaction.js";
import { redactText, scanText } from "./secret-scan.js";

const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";
const GH_TOKEN = `ghp_${"a".repeat(36)}`;

describe("#148: secret detection at the trajectory ingest path", () => {
  it("scans free text, not only a diff — which is the whole point", () => {
    // The engine's existing entry point takes a unified diff and reads added
    // lines. A trajectory payload is neither.
    expect(scanText(`AWS_KEY = '${AWS_KEY}'`).map((f) => f.pattern)).toEqual(["aws-access-key-id"]);
    expect(scanText("nothing to see")).toEqual([]);
  });

  it("replaces the matched span with a marker naming the pattern", () => {
    const { text, patterns } = redactText(`export AWS_KEY=${AWS_KEY}`);
    expect(text).toBe("export AWS_KEY=[redacted:aws-access-key-id]");
    expect(patterns).toEqual(["aws-access-key-id"]);
    // Surgical: what surrounded the secret is still legible, which is what
    // makes the redacted trajectory worth keeping.
    expect(text).toContain("export AWS_KEY=");
    expect(text).not.toContain(AWS_KEY);
  });

  it("replaces every occurrence on a line, not just the first", () => {
    const { text } = redactText(`a=${AWS_KEY} b=${AWS_KEY}`);
    expect(text).toBe("a=[redacted:aws-access-key-id] b=[redacted:aws-access-key-id]");
    expect(text).not.toContain(AWS_KEY);
  });

  it("walks to the string leaves of an arbitrary payload without knowing its shape", () => {
    // The harness-neutrality half of the opaqueness invariant: this payload is
    // a format ADP has never seen, and the walker neither knows nor cares.
    const { value, redactions } = redactPayload({
      tool: "cat",
      output: { lines: ["harmless", `AWS_KEY=${AWS_KEY}`] },
      nested: [{ deep: { token: GH_TOKEN } }],
      count: 7,
      flag: true,
      nothing: null,
    });

    const v = value as Record<string, unknown>;
    expect(v.tool).toBe("cat");
    // Non-strings round-trip untouched.
    expect(v.count).toBe(7);
    expect(v.flag).toBe(true);
    expect(v.nothing).toBeNull();

    expect(JSON.stringify(value)).not.toContain(AWS_KEY);
    expect(JSON.stringify(value)).not.toContain(GH_TOKEN);

    // Located by path, so a reader can see *where* without re-scanning.
    expect(redactions).toEqual(
      expect.arrayContaining([
        { path: "$.output.lines[1]", pattern: "aws-access-key-id" },
        { path: "$.nested[0].deep.token", pattern: "github-token" },
      ]),
    );
  });

  it("leaves object keys alone", () => {
    // A key is structure. Rewriting one would change the shape of a payload
    // ADP promises not to interpret, and the redaction would be
    // indistinguishable from the harness having written a different document.
    const { value } = redactPayload({ [AWS_KEY]: "harmless" });
    expect(Object.keys(value as object)).toEqual([AWS_KEY]);
  });

  it("reports nothing, and copies nothing, for a clean payload", () => {
    const payload = { tool: "ls", output: "a\nb\nc" };
    const { value, redactions } = redactPayload(payload);
    expect(redactions).toEqual([]);
    expect(value).toEqual(payload);
  });

  it("indexes redactions by event so a batch says which event was touched", () => {
    const { events, redactions } = redactEventPayloads([
      { payload: { fine: "yes" } },
      { payload: { leaked: `key=${AWS_KEY}` } },
      { payload: null },
    ]);
    expect(redactions).toEqual([{ index: 1, path: "$.leaked", pattern: "aws-access-key-id" }]);
    expect(JSON.stringify(events)).not.toContain(AWS_KEY);
    // Untouched events are returned by identity — nothing is rewritten that
    // did not need rewriting.
    expect(events[0]!.payload).toEqual({ fine: "yes" });
    expect(events[2]!.payload).toBeNull();
  });
});
