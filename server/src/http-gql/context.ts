import type { Db } from "../db/client.js";
import type { AuthenticatedIdentity } from "../auth/tokens.js";

export interface GqlContext {
  db: Db;
  identity: AuthenticatedIdentity | null;
}
