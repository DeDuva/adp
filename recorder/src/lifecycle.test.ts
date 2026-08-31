import { describe, it, expect } from "vitest";
import { Lifecycle, DEFAULT_IDLE_MS } from "./lifecycle.js";
import type { TrajectoryEvent } from "./events.js";

const message: TrajectoryEvent = { kind: "message", type: "assistant" };
const handoff: TrajectoryEvent = { kind: "handoff", type: "to-reviewer" };

/** A clock and a HEAD the test moves by hand, which is the only way to test a boundary. */
function harness(start = "a".repeat(40)) {
  let now = 1_000_000;
  let head: string | null = start;
  const lifecycle = new Lifecycle({ dir: "/nowhere", now: () => now, headSha: () => head });
  lifecycle.startedAt(head);
  return {
    lifecycle,
    advance: (ms: number) => {
      now += ms;
    },
    commit: (sha: string) => {
      head = sha;
    },
    leaveGit: () => {
      head = null;
    },
  };
}

describe("Lifecycle", () => {
  it("is not due before anything has happened", () => {
    // A checkpoint over nothing new is a DSSE signature over the state the
    // session started in, called a boundary.
    const { lifecycle } = harness();
    expect(lifecycle.due()).toBeNull();
  });

  it("does not checkpoint merely because the session started at a commit", () => {
    // The seeded sha is where the work began, not something the harness did.
    const { lifecycle } = harness();
    lifecycle.observe(message);
    expect(lifecycle.due()).toBeNull();
  });

  it("checkpoints when HEAD moves", () => {
    const h = harness();
    h.lifecycle.observe(message);
    h.commit("b".repeat(40));
    expect(h.lifecycle.due()).toEqual({ boundary: "commit", gitSha: "b".repeat(40) });
  });

  it("does not checkpoint the same commit twice", () => {
    const h = harness();
    h.lifecycle.observe(message);
    h.commit("b".repeat(40));
    const due = h.lifecycle.due()!;
    h.lifecycle.checkpointed(due.gitSha);
    expect(h.lifecycle.due()).toBeNull();
    // ...until there is something new, and somewhere new to put it.
    h.lifecycle.observe(message);
    h.commit("c".repeat(40));
    expect(h.lifecycle.due()).toMatchObject({ boundary: "commit" });
  });

  it("keeps the boundary standing when the checkpoint was not created", () => {
    // The deferred case: a local commit ADP cannot resolve yet. The recorder
    // does not call `checkpointed`, so the next tick tries again — which is
    // what turns "checkpoint on commit" into "checkpoint on a commit ADP can
    // actually resume from".
    const h = harness();
    h.lifecycle.observe(message);
    h.commit("b".repeat(40));
    expect(h.lifecycle.due()).toMatchObject({ boundary: "commit" });
    expect(h.lifecycle.due()).toMatchObject({ boundary: "commit" });
  });

  it("checkpoints on a handoff", () => {
    const h = harness();
    h.lifecycle.observe(handoff);
    expect(h.lifecycle.due()).toEqual({ boundary: "handoff", gitSha: "a".repeat(40) });
  });

  it("prefers the commit when a handoff and a commit are both pending", () => {
    // Both are covered by the one checkpoint that results, so the more
    // meaningful boundary is the one worth naming.
    const h = harness();
    h.lifecycle.observe(handoff);
    h.commit("b".repeat(40));
    expect(h.lifecycle.due()).toMatchObject({ boundary: "commit" });
  });

  it("checkpoints once per quiet stretch, not once per tick inside one", () => {
    // The difference between a boundary and an interval, which is the whole
    // design: a threshold that re-fired every tick would be a timer wearing a
    // boundary's name.
    const h = harness();
    h.lifecycle.observe(message);
    h.advance(DEFAULT_IDLE_MS);
    expect(h.lifecycle.due()).toMatchObject({ boundary: "idle" });
    h.advance(DEFAULT_IDLE_MS);
    expect(h.lifecycle.due()).toBeNull();
    // A new event ends the stretch, so the next silence is a new boundary.
    h.lifecycle.observe(message);
    h.advance(DEFAULT_IDLE_MS);
    expect(h.lifecycle.due()).toMatchObject({ boundary: "idle" });
  });

  it("takes a final boundary whatever else happened", () => {
    // What makes "killing it produces a suspended session with a usable
    // checkpoint" true rather than a hope.
    const h = harness();
    h.lifecycle.observe(message);
    expect(h.lifecycle.final()).toEqual({ boundary: "final", gitSha: "a".repeat(40) });
  });

  it("takes no final boundary when the last checkpoint already covers everything", () => {
    const h = harness();
    h.lifecycle.observe(message);
    h.lifecycle.checkpointed("a".repeat(40));
    expect(h.lifecycle.final()).toBeNull();
  });

  it("records the whole trajectory outside a git repository, and checkpoints nothing", () => {
    // The honest limit of watching from outside. Every checkpoint names a
    // commit, so with no commit there is nothing to checkpoint *at* — and a
    // session recorded without resumable state is still a session recorded.
    const h = harness();
    h.leaveGit();
    h.lifecycle.observe(message);
    h.advance(DEFAULT_IDLE_MS);
    expect(h.lifecycle.due()).toBeNull();
    expect(h.lifecycle.final()).toBeNull();
  });
});
