// Creates an identity and mints its first token. Run once against a fresh DB:
//   tsx src/bootstrap.ts <principal> [--org <name>]
//
// --org is optional (M4-1): omit it and you get exactly the pre-M4 token,
// scoped to nothing but the three repo-level scopes. Pass it and bootstrap
// finds-or-creates an org by that name, makes this identity an admin member,
// and mints the token scoped to it — the smallest real path from CLI to an
// org-scoped token, exercising requireOrgAccess (auth/plugin.ts) end to end
// without inventing an org-management REST route ahead of the item that
// actually needs one (M4-2, the org policy plane).
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { identities, orgMemberships } from "./db/schema.js";
import { mintToken } from "./auth/tokens.js";
import { findOrCreateOrg } from "./core/org-lookup.js";

async function main() {
  const args = process.argv.slice(2);
  const principal = args[0];
  if (!principal || principal.startsWith("--")) {
    console.error("Usage: tsx src/bootstrap.ts <principal> [--org <name>]");
    process.exit(1);
  }
  const orgFlagIdx = args.indexOf("--org");
  const orgName = orgFlagIdx !== -1 ? args[orgFlagIdx + 1] : undefined;
  if (orgFlagIdx !== -1 && !orgName) {
    console.error("--org requires a name");
    process.exit(1);
  }

  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);

  const [identity] = await db
    .insert(identities)
    .values({ kind: "human", principal })
    .returning();

  let orgId: string | undefined;
  if (orgName) {
    orgId = await findOrCreateOrg(db, orgName);
    await db.insert(orgMemberships).values({ orgId, identityId: identity!.id, role: "admin" });
  }

  const token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"], { orgId });

  console.log(`Identity: ${identity!.id}`);
  if (orgId) console.log(`Org:      ${orgId} (${orgName})`);
  console.log(`Token:    ${token}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
