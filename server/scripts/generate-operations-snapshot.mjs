// Regenerates spec/operations.snapshot.json from spec/openapi.yaml — run via
// `npm run spec:snapshot` whenever the operation set changes ON PURPOSE,
// together with the version bump that change requires. The snapshot is what
// lets spec-coverage.test.ts fail when the set of operations changes without
// `info.version` moving (#97 C-1): eleven M4 operations shipped under an
// unmoved 0.2.0 because nothing bound "what the spec offers" to "what the
// spec claims to be".
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const specUrl = new URL("../../spec/openapi.yaml", import.meta.url);
const snapshotUrl = new URL("../../spec/operations.snapshot.json", import.meta.url);

const spec = parse(readFileSync(specUrl, "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];

const operations = Object.entries(spec.paths)
  .flatMap(([path, entry]) => METHODS.filter((m) => m in entry).map((m) => `${m.toUpperCase()} ${path}`))
  .sort();

writeFileSync(snapshotUrl, JSON.stringify({ version: spec.info.version, operations }, null, 2) + "\n");
console.log(`spec/operations.snapshot.json: ${operations.length} operations at version ${spec.info.version}`);
