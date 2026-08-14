import type { ZodError } from "zod";

// #97: the wire shape of a validation failure is a CONTRACT
// (components/schemas/Error), and until 0.3.0 it was zod's raw issue
// objects — a library's internal type, sent verbatim, so any zod upgrade
// could silently break every consumer's error handling. This projection is
// the whole contract: path, message, and a stable code. Anything else an
// issue carries stays server-side.
export function validationErrors(error: ZodError): { path: (string | number)[]; message: string; code: string }[] {
  return error.issues.map((issue) => ({ path: issue.path, message: issue.message, code: issue.code }));
}
