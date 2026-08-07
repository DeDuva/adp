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

  expect(
    pageErrors,
    `the page reported errors:\n${pageErrors.join("\n")}` +
      (httpErrors.length ? `\nfailed requests:\n${httpErrors.join("\n")}` : ""),
  ).toEqual([]);
});
