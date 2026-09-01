import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * Steps C9–C12 of docs/manual-test-plan.md — the half of the §2.1 definition of
 * done that `gh` cannot see: "A human then opens the ADP web UI and sees the
 * intent, the signed evidence bundle, the provenance, the operation log — and
 * clicks undo."
 *
 * Driven by acceptance/run.sh, which has already completed the agent's loop
 * against this server. Everything here reads that state back through a real
 * browser, because the point of this step is the rendering: the REST assertions
 * in run.sh already prove the data exists, and repeating them through fetch()
 * would prove nothing new.
 *
 * Screenshots go to ADP_UI_ARTIFACTS at each stage. They are the deliverable for
 * the one thing that stays permanently manual — whether the UI actually reads
 * well — so that judgement costs a minute of looking rather than a full manual
 * walkthrough.
 */

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run this through acceptance/run.sh`);
  return value;
};

const TOKEN = env("ADP_UI_TOKEN");
const OWNER = env("ADP_UI_OWNER");
const REPO = env("ADP_UI_REPO");
const ARTIFACTS = env("ADP_UI_ARTIFACTS");
// run.sh sets this when it wants the undo performed here rather than over REST,
// so that "clicks undo" is literally what gets tested.
const CLICK_UNDO = process.env.ADP_UI_UNDO === "1";

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: true });

async function connect(page: Page) {
  await page.goto("/ui/");
  // The connect form is the first thing a human meets; it stores the token in
  // localStorage and every later view depends on it.
  await page.fill("#token", TOKEN);
  await page.fill("#owner", OWNER);
  await page.fill("#repo", REPO);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();
}

test("C9-C12: the supervision UI shows intent, evidence, provenance, op log — and undoes the merge", async ({
  page,
}) => {
  // Surface anything the app logs as an error; a React render that throws still
  // leaves a partly-drawn page that naive selectors can pass against.
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });
  // Chromium's console text for a failed subresource is "Failed to load
  // resource: the server responded with a status of 404 (Not Found)" — no URL,
  // which makes the assertion below name a problem without naming its subject.
  // Recording responses separately restores that, and costs nothing when the
  // test passes. Not a complete substitute: requests the browser process makes
  // on its own (the favicon probe, notably) never reach this event, so an
  // empty list here alongside a console error means "look outside the page".
  const httpErrors: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400) httpErrors.push(`${res.status()} ${res.url()}`);
  });

  await test.step("C9 connect and list issues", async () => {
    await connect(page);
    // The issue run.sh filed — which is a typed intent server-side.
    await expect(page.getByText("Add a description to the README")).toBeVisible();
    await shot(page, "01-issues");
  });

  await test.step("C10 open the proposal and its evidence bundle", async () => {
    await page.getByRole("button", { name: "Pull requests" }).click();
    await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
    await page.getByText("Describe the widget").click();
    await shot(page, "02-proposal");

    await page.getByRole("button", { name: "View evidence" }).click();
    // The claim the thesis rests on: intent, provenance and signature are one
    // record, not two systems joined by hand.
    await expect(page.getByRole("heading", { name: /Change \(intent, provenance, signature\)/ })).toBeVisible();
    await expect(page.getByText("Provenance", { exact: true })).toBeVisible();
    await expect(page.getByText("Signature", { exact: true })).toBeVisible();
    await shot(page, "03-evidence");
  });

  await test.step("C11 read the operation log", async () => {
    await page.getByRole("button", { name: "Operation log" }).click();
    await expect(page.getByRole("heading", { name: "Operation log" })).toBeVisible();
    // One row per mutation, each written in the same transaction as the
    // mutation itself.
    //
    // Scoped to .list-row deliberately: the verb filter above the log is a
    // <select> whose <option> values are the same strings, so a bare
    // getByText() matches the hidden option element instead of the row and
    // fails with "unexpected value: hidden" — asserting on a control rather
    // than on data.
    for (const verb of ["issue.create", "change.create", "proposal.create", "review.create", "proposal.merge"]) {
      await expect(page.locator(".list-row").filter({ hasText: verb }).first()).toBeVisible();
    }
    await shot(page, "04-operations");
  });

  await test.step("C12 click undo on the merge", async () => {
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    if (!CLICK_UNDO) {
      // run.sh already undid it over REST; the button should say so rather than
      // offer to undo a second time.
      await expect(page.getByRole("button", { name: "Undone" }).first()).toBeVisible();
      await shot(page, "05-already-undone");
      return;
    }
    await expect(undo.first()).toBeEnabled();
    await undo.first().click();
    // The row flips to "Undone" once the server confirms; run.sh then verifies
    // the ref actually moved back, which is the assertion that matters.
    await expect(page.getByRole("button", { name: "Undone" }).first()).toBeVisible();
    await shot(page, "05-undone");
  });

  // M4-7 — the org policy console. Not part of §2.1's definition of done, so
  // it runs after C12 rather than inside it: the walkthrough above must fail
  // for §2.1 reasons only.
  //
  // The token run.sh mints is org-scoped as of M4-7 (`bootstrap.ts --org`),
  // scoped to the org that owns this very repo, so the console has something
  // real to render rather than its "not org-scoped" empty state.
  await test.step("C13 read the org's resolved policy", async () => {
    await page.getByRole("button", { name: "Organization" }).click();
    await expect(page.getByRole("heading", { name: OWNER })).toBeVisible();

    // The kill switch is off and says so. Asserting the off state matters as
    // much as the on state would: an operator reading this page during an
    // incident is asking exactly this question.
    await expect(page.locator(".kill-switch").getByText("off", { exact: true })).toBeVisible();

    // The three layers, named. This is the view's whole reason to exist —
    // "gates_green because the instance says so" is not derivable from any
    // other screen.
    //
    // Scoped to .layer-name rather than a bare getByText: the explanatory
    // banner above also says "instance floor" in prose, so an unscoped match
    // is ambiguous and Playwright is right to refuse it.
    const layers = page.locator(".layer-name");
    await expect(layers.filter({ hasText: "Instance floor" })).toBeVisible();
    await expect(layers.filter({ hasText: "Org floor" })).toBeVisible();

    // This org designates no policy repo, so it contributes nothing — and the
    // console says which of the four reasons an empty floor can have applies,
    // rather than rendering the same blank either way.
    await expect(page.getByText("No policy repo is designated")).toBeVisible();

    // The resolved table: the acceptance repo, and the instance floor showing
    // up as its requirement with the layer that imposed it named.
    const row = page.locator(".gate-table tbody tr").filter({ hasText: `${OWNER}/${REPO}` });
    await expect(row).toBeVisible();
    await expect(row.getByText("gates green").first()).toBeVisible();
    await expect(row.getByText("instance", { exact: false }).first()).toBeVisible();

    await shot(page, "06-org-console");
  });

  // #156 — the M3 surface. Until this the supervision UI had six views and none
  // of them was a run, a session, a trajectory, a checkpoint or an eval, so the
  // part of ADP that has no GitHub analogue was reachable only by writing an API
  // client. run.sh's C14 seeded a real run for this to read back.
  //
  // The exit criterion is a judgement — "answer 'what was this agent doing when
  // it wrote this line' in under a minute" — which is what the screenshots are
  // for. What is asserted here is the part a judgement cannot catch: that the
  // numbers are rendered as the things they are, and that verification's two
  // answers stay apart.
  await test.step("C14 read a run, its trajectory, its verification and its lineage", async () => {
    await page.getByRole("button", { name: "Runs" }).click();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();

    // The arm, off the signed labels rather than guessed from external_ref.
    const row = page.locator("table.grid tbody tr").filter({ hasText: "claude-opus-5" });
    await expect(row).toBeVisible();
    await shot(page, "07-runs");

    await row.click();
    await expect(page.getByRole("heading", { name: /claude-opus-5/ })).toBeVisible();

    // Verification is three separate tiles, never one tick. The chain verifying
    // and nothing having been dropped are different assurances.
    await expect(page.locator(".check").filter({ hasText: "Chain" })).toBeVisible();
    await expect(page.locator(".check").filter({ hasText: "Completeness" })).toBeVisible();
    await expect(page.locator(".check").filter({ hasText: "Attestation" })).toBeVisible();
    await expect(page.locator(".check.ok").filter({ hasText: "chains verify" })).toBeVisible();

    // The trajectory, with its typed columns rendered as what they are. The
    // cost is the one worth asserting: 9400 micro-USD is $0.0094, and a view
    // that rounded it to $0.00 would be useless for the comparison the column
    // exists for.
    await expect(page.getByRole("heading", { name: "Trajectory" })).toBeVisible();
    const modelCall = page.locator("table.trajectory tbody tr").filter({ hasText: "completion" });
    await expect(modelCall).toContainText("$0.0094");
    await expect(modelCall).toContainText("2.2k");
    await expect(modelCall).toContainText("3.1s");

    // A failed tool call is findable by scanning rather than by reading.
    await expect(page.locator("table.trajectory tbody tr.row-bad").filter({ hasText: "Bash" })).toBeVisible();
    await shot(page, "08-run-detail");

    // The kind filter is rendered from a copy of the server's own EVENT_KINDS
    // (bound to it by api.test.ts), so every kind here is one the server writes.
    await page.getByRole("button", { name: "tool_call" }).click();
    await expect(page.locator("table.trajectory tbody tr").filter({ hasText: "completion" })).toHaveCount(0);
    await expect(page.locator("table.trajectory tbody tr").filter({ hasText: "Bash" })).toBeVisible();
    await page.getByRole("button", { name: "clear" }).click();

    // "What was this agent doing when it wrote this line": open the commit
    // event and the payload is there.
    await page.locator("table.trajectory tbody tr").filter({ hasText: "git" }).first().click();
    await expect(page.locator(".payload")).toBeVisible();
    await shot(page, "09-trajectory-event");

    // D2, drawn rather than asserted: one continuous signed history across two
    // harnesses. The seeded run checkpointed under claude-code and resumed
    // under codex — so the *resumed* session is the one that has a chain to
    // show. Opening the root instead shows a lineage of one, which is correct
    // and proves nothing.
    await page.locator("table.grid tbody tr").filter({ hasText: "codex" }).first().click();
    await expect(page.getByRole("heading", { name: "Lineage" })).toBeVisible();
    const chain = page.locator(".lineage li");
    await expect(chain).toHaveCount(2);
    await expect(chain.nth(0)).toContainText("claude-code");
    await expect(chain.nth(1)).toContainText("codex");
    // The current session is the one you are on, and it is marked rather than
    // merely present — a chain you cannot locate yourself in is a list.
    await expect(page.locator(".lineage li.current")).toHaveCount(1);
    await shot(page, "10-session-lineage");

    // And the root, reached by following the chain back — which is the
    // navigation the lineage exists to provide.
    await chain.nth(0).getByRole("button").click();
    await expect(page.getByRole("heading", { name: "Checkpoints" })).toBeVisible();
    await expect(page.locator("table.grid tbody tr")).toContainText("claude-code");
  });

  // #157 — the record is navigable in both directions. The done-when is
  // literal: "from any landed commit, a person reaches the intent and the
  // trajectory without typing a URL", and "the path works for a commit recorded
  // by a plain `git push`, not only for one recorded through the explicit API".
  //
  // The commit walked here is the one Part B pushed with `git push` and an
  // `ADP-Intent` trailer. Nothing called a run or session route for it.
  await test.step("C15 walk from a landed commit to the intent that asked for it", async () => {
    await page.getByRole("button", { name: "Operation log" }).click();
    // The change the push auto-recorded — the ordinary case, not an API call.
    const pushed = page.locator(".list-row").filter({ hasText: "change.create" }).first();
    await pushed.getByRole("button", { name: "Evidence" }).click();
    await expect(page.getByRole("heading", { name: /^Evidence/ })).toBeVisible();

    // The intent, by issue number and title rather than as a uuid. This is the
    // exact point at which JTBD-2 was one click from being answered and was
    // not.
    const intentLink = page.locator(".linkish").filter({ hasText: "#1" }).first();
    await expect(intentLink).toBeVisible();
    await shot(page, "11-evidence-navigable");

    await intentLink.click();
    await expect(page.getByRole("heading", { name: /#1$/ })).toBeVisible();

    // And the other direction: the issue lists the runs against its intent,
    // each pairing what it produced with what it cost. C14 seeded one.
    await expect(page.getByRole("heading", { name: /^Attempts/ })).toBeVisible();
    const attempt = page.locator("table.grid tbody tr").filter({ hasText: "claude-opus-5" });
    await expect(attempt).toBeVisible();
    await shot(page, "12-issue-attempts");

    // Issue → run → the commits it produced → back into evidence. A loop, which
    // is what "navigable in both directions" has to mean to be worth anything.
    await attempt.click();
    await expect(page.getByRole("heading", { name: "Commits" })).toBeVisible();
    await page.locator(".commit-list .linkish").first().click();
    await expect(page.getByRole("heading", { name: /^Evidence/ })).toBeVisible();

    // From that commit, the session that produced it — reached without typing
    // a URL, which is the whole criterion.
    await expect(page.locator(".edge-label").filter({ hasText: "Session" })).toBeVisible();
    await page.locator(".edge").filter({ hasText: "Session" }).locator(".linkish").first().click();
    await expect(page.getByRole("heading", { name: "Lineage" })).toBeVisible();
    await shot(page, "13-commit-to-session");
  });

  expect(
    pageErrors,
    `the page reported errors:\n${pageErrors.join("\n")}` +
      (httpErrors.length ? `\nfailed requests:\n${httpErrors.join("\n")}` : ""),
  ).toEqual([]);
});
