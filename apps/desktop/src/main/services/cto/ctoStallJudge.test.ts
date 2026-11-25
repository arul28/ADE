import { describe, expect, it } from "vitest";
import {
  CTO_STALL_IDLE_MS,
  CTO_STALL_NUDGE_GAP_MS,
  createCtoStallJudge,
  ctoChildMovedAt,
  judgeCtoChildStall,
  type CtoChildFacts,
} from "./ctoStallJudge";

const T0 = Date.parse("2026-11-25T10:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

function child(overrides: Partial<CtoChildFacts> = {}): CtoChildFacts {
  return {
    sessionId: "child-1",
    title: "Fix login",
    lastActivityAt: new Date(T0).toISOString(),
    ended: false,
    turnActive: false,
    awaitingInput: false,
    pendingKind: null,
    pendingText: null,
    quietOnPurpose: false,
    pr: null,
    lastWords: "Opened PR #12.",
    ...overrides,
  };
}

const openPr = (overrides: Partial<NonNullable<CtoChildFacts["pr"]>> = {}): NonNullable<CtoChildFacts["pr"]> => ({
  number: 12,
  state: "open",
  mergeConflicts: false,
  checks: "passing",
  behindBaseBy: 0,
  review: "none",
  ...overrides,
});

describe("judgeCtoChildStall", () => {
  it.each<[string, Partial<CtoChildFacts>, number, string | null]>([
    ["a question unanswered for 2 min", { awaitingInput: true, pendingKind: "question", pendingText: "Which DB?" }, 2 * MIN, "question"],
    ["a question unanswered for 1 min", { awaitingInput: true, pendingKind: "question" }, 1 * MIN, null],
    ["a permission prompt for 2 min", { awaitingInput: true, pendingKind: "permission", pendingText: "Run rm -rf build" }, 2 * MIN, "permission"],
    ["idle 3 min with no PR", {}, 3 * MIN, "idle"],
    ["idle 2 min", {}, 2 * MIN, null],
    ["idle with failing checks", { pr: openPr({ checks: "failing" }) }, 3 * MIN, "pr_fixable"],
    ["idle with conflicts", { pr: openPr({ mergeConflicts: true }) }, 3 * MIN, "pr_fixable"],
    ["idle behind base", { pr: openPr({ behindBaseBy: 4 }) }, 3 * MIN, "pr_fixable"],
    ["idle with changes requested", { pr: openPr({ review: "changes_requested" }) }, 3 * MIN, "pr_fixable"],
    ["a draft's red checks are not a fix", { pr: openPr({ state: "draft", checks: "failing" }) }, 3 * MIN, "idle"],
    ["idle with a green PR", { pr: openPr() }, 3 * MIN, "pr_ready"],
    ["a turn with no output for 20 min", { turnActive: true }, 20 * MIN, "hung"],
    ["a turn quiet for 10 min", { turnActive: true }, 10 * MIN, null],
    ["a turn that started 5 min ago after a long pause", { turnActive: true, turnStartedAt: at(30 * MIN) }, 35 * MIN, null],
    ["a turn started 20 min ago with no output since", { turnActive: true, turnStartedAt: at(30 * MIN) }, 50 * MIN, "hung"],
    ["a card first seen 1 min ago after old output", { awaitingInput: true, pendingKind: "permission", pendingSeenAt: at(9 * MIN) }, 10 * MIN, null],
    ["quiet on purpose (settled, snoozed, waiting on its own work)", { quietOnPurpose: true }, 30 * MIN, null],
    ["ended", { ended: true }, 30 * MIN, null],
    ["stuck more than a day ago", {}, 25 * 60 * MIN, null],
  ])("%s", (_label, overrides, elapsed, kind) => {
    expect(judgeCtoChildStall(child(overrides), T0 + elapsed)?.kind ?? null).toBe(kind);
  });

  it("stays quiet once the CTO handed the stall to the person, until the child moves", () => {
    const need = { setAt: at(4 * MIN) };
    expect(judgeCtoChildStall(child(), T0 + 10 * MIN, need)).toBeNull();
    const moved = child({ lastActivityAt: at(5 * MIN) });
    expect(judgeCtoChildStall(moved, T0 + 10 * MIN, need)?.kind).toBe("idle");
  });

  it("treats a different card as a move for a need set on a card, and keys it apart", () => {
    const waiting = (pendingKey: string) => child({ awaitingInput: true, pendingKind: "permission", pendingKey });
    const need = { setAt: at(4 * MIN), pendingKey: "card-1" };
    expect(judgeCtoChildStall(waiting("card-1"), T0 + 10 * MIN, need)).toBeNull();
    const next = judgeCtoChildStall(waiting("card-2"), T0 + 10 * MIN, need);
    expect(next?.kind).toBe("permission");
    expect(next?.stateKey).not.toBe(judgeCtoChildStall(waiting("card-1"), T0 + 10 * MIN)?.stateKey);
  });

  it("gives a child that moved and stalled again a new key", () => {
    const first = judgeCtoChildStall(child(), T0 + 5 * MIN)!;
    const again = judgeCtoChildStall(child({ lastActivityAt: new Date(T0 + 6 * MIN).toISOString() }), T0 + 12 * MIN)!;
    expect(again.stateKey).not.toBe(first.stateKey);
  });
});

type Harness = ReturnType<typeof harness>;

function harness(store: Map<string, unknown> = new Map(), seeded = true) {
  let now = T0;
  if (seeded && !store.has("cto:stall-nudges:v1")) store.set("cto:stall-nudges:v1", []);
  const children = new Map<string, CtoChildFacts>();
  // Children a pass leaves out (quiet for a day, a failed summary) but that still exist.
  const unlisted = new Map<string, CtoChildFacts>();
  let needReadFails = false;
  const wakes: Array<{ cto: string; text: string }> = [];
  let busy = false;
  const judge = createCtoStallJudge({
    db: { getJson: (key) => store.get(key) ?? null, setJson: (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); } },
    listCtoSessionIds: async () => ["cto"],
    readChildren: async () => [...children.values()],
    readNeedChild: async (id) => {
      if (needReadFails) throw new Error("summary read failed");
      const facts = children.get(id) ?? unlisted.get(id);
      return facts
        ? { title: facts.title, laneId: "lane-1", lastActivityAt: ctoChildMovedAt(facts), ended: facts.ended, pendingKey: facts.pendingKey }
        : null;
    },
    ctoBusy: () => busy,
    wakeCto: async (cto, text) => { wakes.push({ cto, text }); },
    ctoParentOf: (id) => (children.has(id) ? "cto" : null),
    isCtoSession: (id) => id === "cto",
    now: () => now,
    // Passes run by hand: no timers.
    setTimer: () => null,
    clearTimer: () => {},
  });
  return {
    judge,
    store,
    wakes,
    children,
    unlisted,
    setNeedReadFails: (value: boolean) => { needReadFails = value; },
    setNow: (ms: number) => { now = ms; },
    setBusy: (value: boolean) => { busy = value; },
    put: (facts: CtoChildFacts) => children.set(facts.sessionId, facts),
  };
}

async function pass(h: Harness, at: number) {
  h.setNow(at);
  await h.judge.checkNow();
}

describe("createCtoStallJudge", () => {
  it("wakes the CTO once per stall with the child's state and last message", async () => {
    const h = harness();
    h.put(child({ awaitingInput: true, pendingKind: "permission", pendingText: "Run the migration", lastWords: "Ready to migrate." }));
    await pass(h, T0 + 3 * MIN);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].text.startsWith("Stall nudge:")).toBe(true);
    expect(h.wakes[0].text).toContain("permission prompt: Run the migration");
    expect(h.wakes[0].text).toContain("Last message: \"Ready to migrate.\"");
    await pass(h, T0 + 30 * MIN);
    expect(h.wakes).toHaveLength(1);
  });

  it("does not tell the same stall again after a restart", async () => {
    const store = new Map<string, unknown>();
    const first = harness(store);
    first.put(child());
    await pass(first, T0 + 4 * MIN);
    expect(first.wakes).toHaveLength(1);
    const second = harness(store);
    second.put(child());
    await pass(second, T0 + 40 * MIN);
    expect(second.wakes).toHaveLength(0);
  });

  it("on its very first run records what is already stuck without waking anyone", async () => {
    const h = harness(new Map(), false);
    h.put(child());
    await pass(h, T0 + 10 * MIN);
    expect(h.wakes).toHaveLength(0);
    h.put(child({ sessionId: "child-2", lastActivityAt: new Date(T0 + 11 * MIN).toISOString() }));
    await pass(h, T0 + 11 * MIN + CTO_STALL_IDLE_MS);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].text).toContain("child-2");
    expect(h.wakes[0].text).not.toContain("child-1");
  });

  it("keeps nudges to one CTO apart and folds the stalls in between into the next", async () => {
    const h = harness();
    h.put(child());
    await pass(h, T0 + 4 * MIN);
    expect(h.wakes).toHaveLength(1);
    const later = new Date(T0 + 5 * MIN).toISOString();
    h.put(child({ sessionId: "child-2", lastActivityAt: later }));
    h.put(child({ sessionId: "child-3", lastActivityAt: later }));
    await pass(h, T0 + 8 * MIN);
    expect(h.wakes).toHaveLength(1);
    await pass(h, T0 + 4 * MIN + CTO_STALL_NUDGE_GAP_MS);
    expect(h.wakes).toHaveLength(2);
    expect(h.wakes[1].text).toContain("2 chats you started are stuck");
  });

  it("holds a nudge while the CTO is mid-turn and sends it after", async () => {
    const h = harness();
    h.put(child());
    h.setBusy(true);
    await pass(h, T0 + 4 * MIN);
    expect(h.wakes).toHaveLength(0);
    h.setBusy(false);
    await pass(h, T0 + 5 * MIN);
    expect(h.wakes).toHaveLength(1);
  });

  it("keeps a need until its child moves, then drops it", async () => {
    const h = harness();
    h.put(child());
    h.setNow(T0 + 4 * MIN);
    h.judge.setNeed({ ctoSessionId: "cto", childSessionId: "child-1", line: "Approve the merge of PR #12" });
    const read = () => h.judge.listNeeds("cto");
    expect((await read()).map((need) => need.line)).toEqual(["Approve the merge of PR #12"]);
    // A need set by the CTO also stops the nudge for that stall.
    await pass(h, T0 + 10 * MIN);
    expect(h.wakes).toHaveLength(0);
    h.put(child({ lastActivityAt: new Date(T0 + 11 * MIN).toISOString() }));
    expect(await read()).toEqual([]);
    await pass(h, T0 + 12 * MIN);
    expect(h.store.get("cto:needs:v1")).toEqual([]);
  });

  it("keeps a need whose child a pass left out or could not read, and drops it once the child is gone", async () => {
    const h = harness();
    h.unlisted.set("child-1", child());
    h.setNow(T0 + 4 * MIN);
    h.judge.setNeed({ ctoSessionId: "cto", childSessionId: "child-1", line: "Sign in to Vercel" });
    await pass(h, T0 + 30 * 60 * MIN);
    h.setNeedReadFails(true);
    await pass(h, T0 + 31 * 60 * MIN);
    h.setNeedReadFails(false);
    expect((await h.judge.listNeeds("cto")).map((need) => need.line)).toEqual(["Sign in to Vercel"]);
    h.unlisted.delete("child-1");
    await pass(h, T0 + 32 * 60 * MIN);
    expect(h.store.get("cto:needs:v1")).toEqual([]);
  });

  it("drops a need set on a card once that card is answered, even with no new output", async () => {
    const h = harness();
    h.put(child({ awaitingInput: true, pendingKind: "permission", pendingKey: "card-1" }));
    h.setNow(T0 + 4 * MIN);
    h.judge.setNeed({ ctoSessionId: "cto", childSessionId: "child-1", line: "Approve the deploy", pendingKey: "card-1" });
    expect(await h.judge.listNeeds("cto")).toHaveLength(1);
    h.put(child({ turnActive: true, pendingKey: null }));
    expect(await h.judge.listNeeds("cto")).toEqual([]);
  });
});
