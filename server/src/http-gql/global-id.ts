// GitHub's Node global IDs are base64("TypeName:internal-id"). `gh` decodes
// these client-side in a few places (e.g. --json id), so the shape has to
// match even though our internal IDs are UUIDs, not GitHub's.
export function toGlobalId(typeName: string, internalId: string): string {
  return Buffer.from(`${typeName}:${internalId}`, "utf8").toString("base64");
}

export function fromGlobalId(globalId: string): { typeName: string; internalId: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(globalId, "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  return { typeName: decoded.slice(0, sep), internalId: decoded.slice(sep + 1) };
}
