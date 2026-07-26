// Creates an identity and mints its first token. Run once against a fresh DB:
//   tsx src/bootstrap.ts <principal>
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { identities } from "./db/schema.js";
import { mintToken } from "./auth/tokens.js";

async function main() {
  const principal = process.argv[2];
  if (!principal) {
    console.error("Usage: tsx src/bootstrap.ts <principal>");
    process.exit(1);
  }

  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);

  const [identity] = await db
    .insert(identities)
    .values({ kind: "human", principal })
    .returning();

  const token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);

  console.log(`Identity: ${identity!.id}`);
  console.log(`Token:    ${token}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
