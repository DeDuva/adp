-- #239: a repository's record can leave the instance holding it.
--
-- `PUBLIC_URL` is part of the signed record rather than a display string — the
-- server signs evidence with it and hands it back in clone URLs, and
-- docs/self-hosting.md states that as a property of the design and warns
-- operators to decide it before the first change lands. The consequence nobody
-- had written down is that the record could not move. Every adoption story in
-- Phase 5 ends with a developer's record living on an instance chosen while
-- they were evaluating alone, and if it cannot move when their company adopts,
-- the funnel breaks precisely at the point it is supposed to pay off — for a
-- reason that was designed in.
--
-- Nothing is re-signed on import, and that is the decision rather than a
-- simplification. A signature says "this instance attested this, then", and
-- re-signing under the receiving instance would let it assert what it did not
-- witness — which is the substitution this whole product exists to prevent. So
-- the record keeps its original signatures, and the exporting instance's public
-- key travels with it.
--
-- The verification mechanism already existed: #102 built a key registry that
-- resolves an envelope's keyid against the active key and any retired ones. An
-- archived key is the same thing pointed at a key this instance never held.
CREATE TABLE IF NOT EXISTS "archived_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_key_hex" text NOT NULL,
  -- The PUBLIC_URL the exporting instance signed under. Display and audit:
  -- "these records were attested by that instance" is the fact a reader of an
  -- imported bundle most needs, and it is not recoverable from the key alone.
  "public_url" text NOT NULL,
  "imported_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "archived_keys_public_key_hex_unique" UNIQUE ("public_key_hex")
);
