import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createSessionService } from "./sessionService";
import { createSettleLifecycleWriter } from "./settleLifecycleWriter";
import { createSettleWiring } from "./settleWiring";
import type { SettleAbortedReason, SettleSessionsOutcome } from "./settlingStateRegistry";


/**
 * The race matrix from the settle design (§2), tested directly against the
 * lifecycle revision and the settling window — with a real, awaited check.
 *
 * A settle reads whether the session's turn is running and only then writes.
 * The check callback is a seam we drive by hand: whatever it does is what the
 * world would have been doing while that read was in flight.
 */

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as const;
}

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-settle-race-"));
  fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
  return root;
}

function insertProjectGraph(db: Awaited<ReturnType<typeof openKvDb>>) {
  const now = "2026-08-11T00:00:00.000Z";
  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["project-1", "/repo/ade", "ADE", "main", now, now],
  );
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
      is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "lane-1", "project-1", "Lane 1", null, "worktree", "main", "ade/lane-1",
      "/repo/ade/.ade/worktrees/lane-1", null, 0, null, null, null, "[]", null, "active", now, null,
    ],
  );
}

describe("settle race matrix", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()?.();
  });

  async function fixture() {
    const projectRoot = makeProjectRoot();
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    disposers.push(async () => db.close());
    insertProjectGraph(db);
    // The check seam the race matrix drives. Whatever this does is what the
    // world was doing while the settle's turn read was in flight.
    let duringCheck: (sessionId: string) => void | Promise<void> = () => {};
    // What a check that refused reports back (a working chat).
    let checkAbortedBy: SettleAbortedReason | null = null;
    const remoteWrites: Array<{ columns: string[]; changesetSessionCount: number }> = [];
    const service = createSessionService({
      db,
      onRemoteSettleWrite: (args) => { remoteWrites.push(args); },
      checkSettle: async (sessionId) => {
        await duringCheck(sessionId);
        return checkAbortedBy ? { abortedBy: checkAbortedBy } : {};
      },
    });
    const setDuringCheck = (fn: (sessionId: string) => void | Promise<void>) => {
      duringCheck = fn;
    };
    const setCheckAbortedBy = (reason: SettleAbortedReason | null) => {
      checkAbortedBy = reason;
    };
    const create = (id: string) =>
      service.create({
        sessionId: id,
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Chat",
        startedAt: "2026-08-11T00:01:00.000Z",
        transcriptPath: `/tmp/${id}.log`,
        toolType: "codex-chat",
      });
    create("session-1");
    return {
      db,
      service,
      create,
      setDuringCheck,
      setCheckAbortedBy,
      remoteWrites,
    };
  }

  /**
   * A leaked window makes every later settle of the session join one that
   * never ends, so the session can never be settled again. Proven through
   * behavior: the next settle must not come back `joined_in_flight`.
   */
  async function expectWindowClosed(
    service: Awaited<ReturnType<typeof fixture>>["service"],
    sessionId = "session-1",
  ): Promise<void> {
    const next = await service.settleSessionsReportingAborts([sessionId]);
    expect(next.aborted.map((entry) => entry.reason)).not.toContain("joined_in_flight");
  }

  /**
   * R1 — settle vs turn start. The worst case: the user is actively working and
   * the row goes quiet. C3 fires during the check; the settle must be abandoned,
   * not applied afterwards.
   */
  it("R1: a turn starting during the check abandons the settle", async () => {
    const { service, setDuringCheck } = await fixture();
    await service.settleSessions(["session-1"]);
    service.unsettleSession("session-1");

    setDuringCheck(() => {
      service.clearTurnStartMarkers("session-1");
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(outcome.settled).toEqual([]);
    expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "turn_start" }]);
    expect(service.get("session-1")?.settledAt).toBeNull();
    // A leaked window would swallow this session's output forever and leave it
    // permanently unsettleable — the mechanism's worst failure mode.
    service.unsettleSession("session-1");
    await expectWindowClosed(service);
  });

  /**
   * A working chat cannot be settled, whoever asks, and settling stops nothing.
   *
   * Through the real wiring the hosts use: a running turn and a turn accepted
   * but not yet started both refuse with `turn_running`; a read that never
   * answers, or a chat another brain runs, refuses with `status_unknown` rather
   * than filing a chat it could not see; a resting chat settles.
   */
  it.each([
    ["user", { status: "active" }, "turn_running"],
    ["operator", { status: "active" }, "turn_running"],
    ["pr_merge", { status: "active" }, "turn_running"],
    ["user", { status: "idle", turnAcceptedAt: "2026-08-11T00:02:00.000Z" }, "turn_running"],
    ["pr_merge", { status: "idle", turnAcceptedAt: "2026-08-11T00:02:00.000Z" }, "turn_running"],
    ["user", "never", "status_unknown"],
    ["pr_merge", { status: "idle", runtimeOwnedElsewhere: { pid: 4242 } }, "status_unknown"],
    ["user", { status: "idle" }, null],
    ["pr_merge", { status: "idle" }, null],
  ] as const)("a %s settle of a chat reading %j is refused with %s", async (source, summary, reason) => {
    const { db } = await fixture();
    const service = createSessionService({
      db,
      checkSettle: createSettleWiring({
        surface: "desktop",
        agentChatService: {
          getSessionSummary: async () => (summary === "never" ? await new Promise<never>(() => {}) : summary),
        },
      }).checkSettle,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = service.settleSessionsReportingAborts(["session-1"], { source });
      await vi.advanceTimersByTimeAsync(10_000);
      const outcome = await pending;
      if (reason) {
        expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason }]);
        expect(outcome.settled).toEqual([]);
        expect(service.get("session-1")?.settledAt).toBeNull();
      } else {
        expect(outcome.aborted).toEqual([]);
        expect(outcome.settled).toEqual(["session-1"]);
        expect(service.get("session-1")?.settledAt).toBeTruthy();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not settle a session whose check refused", async () => {
    const { service, setCheckAbortedBy } = await fixture();
    setCheckAbortedBy("turn_running");

    const outcome = await service.settleSessionsReportingAborts(["session-1"], { source: "pr_merge" });

    expect(outcome.settled).toEqual([]);
    expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "turn_running" }]);
    expect(service.get("session-1")?.settledAt).toBeNull();
    setCheckAbortedBy(null);
    await expectWindowClosed(service);
  });

  /**
   * Any turn start — a scheduled wake, a cron, a background job reporting back
   * — takes a chat out of settled, and touches nothing else: the question the
   * agent raised stays up, a keep-active pin survives, and a settle still in
   * its window is abandoned rather than landing on a working chat.
   */
  it("a host-started turn unsettles the chat and touches nothing else", async () => {
    const { db, service, setDuringCheck } = await fixture();
    await service.settleSessionsReportingAborts(["session-1"]);
    // An `ade chat ask` hand raised after the settle, written as the agent's
    // request lands (a settle clears attention, so it cannot come first).
    db.run(
      "update terminal_sessions set attention_requested_at = ?, attention_source = 'agent_explicit' where id = ?",
      ["2026-08-11T00:05:00.000Z", "session-1"],
    );

    expect(service.clearSettleOnTurnStart("session-1")).toBe(true);
    expect(service.get("session-1")?.settledAt).toBeNull();
    expect(service.get("session-1")?.attentionRequestedAt).toBe("2026-08-11T00:05:00.000Z");

    // Not settled, pinned keep-active: nothing to clear, so nothing is written.
    service.setSettleOverride("session-1", "active");
    const revision = service.getSettleLifecycleRevision("session-1");
    expect(service.clearSettleOnTurnStart("session-1")).toBe(false);
    expect(service.getSettleLifecycleRevision("session-1")).toBe(revision);
    expect(service.get("session-1")?.settleOverride).toBe("active");

    // A turn that starts while a settle is mid-check abandons it, pin intact.
    setDuringCheck(() => { service.clearSettleOnTurnStart("session-1"); });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);
    expect(outcome).toEqual({ settled: [], aborted: [{ sessionId: "session-1", reason: "turn_start" }] });
    expect(service.get("session-1")?.settleOverride).toBe("active");
  });

  /**
   * R2 — settle abandoned after the check ran. What this pins is the reporting
   * half: the caller is told, and never sees silent success. #1059 returned
   * success and that is what a caller built on.
   */
  it("R2: an abandoned settle reports the reason instead of silent success", async () => {
    const { service, setDuringCheck } = await fixture();
    let checkRan = false;

    setDuringCheck(() => {
      checkRan = true;
      service.requestAttention("session-1", "need you");
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(checkRan).toBe(true);
    expect(outcome.settled).toEqual([]);
    expect(outcome.aborted[0]).toMatchObject({ sessionId: "session-1", reason: "attention_requested" });
  });

  it("rejects lifecycle activity arriving after the check but before the guarded commit", async () => {
    const { db, service } = await fixture();
    const sibling = createSessionService({ db });
    const result = await service.settleSessionsReportingAborts(["session-1"], { source: "pr_merge" }, () => {
      // A separate service has its own in-memory revision map; the final
      // commit must see its shared database revision, not just local state.
      sibling.clearTurnStartMarkers("session-1");
      return true;
    });
    expect(result.settled).toEqual([]);
    expect(result.aborted).toEqual([{ sessionId: "session-1", reason: "lifecycle_changed" }]);
    expect(service.get("session-1")?.settledAt).toBeNull();
  });

  /**
   * R4 — concurrent settle sources. PR-merge auto-settle racing a user settle
   * must not file one session twice.
   */
  it("R4: a second settle joins the in-flight one instead of settling twice", async () => {
    const { service, setDuringCheck } = await fixture();
    let checks = 0;

    let inner: Awaited<ReturnType<typeof service.settleSessionsReportingAborts>> | null = null;
    setDuringCheck(async () => {
      checks += 1;
      // Re-entrant settle, exactly as a PR-merge poll landing mid-user-settle.
      // The window is already open, so this must JOIN rather than check
      // again — the check counter is what proves it.
      inner = await service.settleSessionsReportingAborts(["session-1"]);
    });

    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(checks, "the joined settle must not start its own check").toBe(1);
    expect(outcome.settled).toEqual(["session-1"]);
    // The joiner does NOT report success. It filed nothing, and a caller with a
    // durable consequence — the PR poller marking a merge handled — must not
    // consume that merge on the strength of someone else's in-flight settle,
    // which may yet abort. It is also not counted as settled, so a bulk caller
    // cannot see one session twice.
    expect(inner).toMatchObject({
      settled: [],
      aborted: [{ sessionId: "session-1", reason: "joined_in_flight" }],
    });
  });

  /**
   * R6 — output during the check, the high-frequency shape of R1. Settle stops
   * nothing, so a background shell keeps printing while the settle is in its
   * window. C4/C5 must be swallowed on all three axes or a chat with live
   * background work could never be settled.
   */
  it("R6: output during the check is swallowed on all three axes", async () => {
    const { service, setDuringCheck } = await fixture();
    const revisionBefore = service.getSettleLifecycleRevision("session-1");

    setDuringCheck(() => {
      service.setLastOutputPreview("session-1", "final chunk", { clearSettled: true });
      service.touchSessionActivity("session-1", "2026-08-11T00:09:00.000Z");
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    // 1. did not abort
    expect(outcome.aborted).toEqual([]);
    expect(outcome.settled).toEqual(["session-1"]);
    // 2. did not bump the revision (only the settle itself did)
    expect(service.getSettleLifecycleRevision("session-1")).toBe(revisionBefore + 1);
    // 3. did not clear the tuple — and the preview still landed, so the row
    //    keeps showing live output while it settles.
    const row = service.get("session-1");
    expect(row?.settledAt).toBeTruthy();
    expect(row?.lastOutputPreview).toBe("final chunk");
  });

  it("R6b: the same output OUTSIDE the settling window clears normally", async () => {
    const { service } = await fixture();
    await service.settleSessions(["session-1"]);
    expect(service.get("session-1")?.settledAt).toBeTruthy();

    service.setLastOutputPreview("session-1", "later output", { clearSettled: true });

    // The swallow is scoped to the window and nothing else.
    expect(service.get("session-1")?.settledAt).toBeNull();
  });

  /**
   * R7 — a peer's settle bypassing the writer.
   *
   * Not in the original matrix: it surfaced while implementing step 1. A paired
   * DESKTOP peer's settle arrives through `crsql_changes` and never passes the
   * chokepoint, so this host's revision does not move for it. Step 0
   * deliberately left desktop peers replicating, so this is reachable in
   * production.
   *
   * This test exists to show the BLAST RADIUS of a bypassing write, per the
   * coordinator's step-3 review scope — it asserts today's real behavior, not
   * the behavior we want.
   */
  /**
   * NOTE (step 3): R7 and R7b below still write the row with a raw `db.run`,
   * which is a bypass NO inbound changeset can produce any more — the apply
   * layer now hands settle-tuple writes to `reconcileRemoteSettleTuple`. They
   * are kept, unchanged, because they still pin the underlying property they
   * always pinned: a write that reaches the tuple without the chokepoint is
   * invisible to the guard. That is the reason the apply layer must intercept,
   * so deleting these would delete the evidence for the fix. The reconciled
   * path is asserted immediately after them.
   */
  it("R7: a peer-style write that bypasses the writer is invisible to the guard", async () => {
    const { db, service, setDuringCheck } = await fixture();
    const revisionBefore = service.getSettleLifecycleRevision("session-1");

    setDuringCheck(() => {
      // Exactly what a replicated peer settle looks like locally: the row's
      // settle tuple changes without the writer being involved.
      db.run(
        "update terminal_sessions set settled_at = ?, settle_source = ? where id = ?",
        ["2026-08-11T00:07:00.000Z", "user", "session-1"],
      );
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    // Observed behaviour, not the behaviour we would have guessed.
    //
    // The revision does NOT move: the write bypassed the chokepoint, so the
    // guard is blind to it exactly as §3a says.
    expect(service.getSettleLifecycleRevision("session-1")).toBe(revisionBefore);

    // And `settleMany`'s own guard — `settled_at is null or settle_override is
    // not null` — then finds nothing to do, so the settle silently no-ops.
    // The id appears in NEITHER list.
    expect(outcome.settled).toEqual([]);
    expect(outcome.aborted).toEqual([]);

    // The peer's value stands.
    expect(service.get("session-1")?.settledAt).toBe("2026-08-11T00:07:00.000Z");
  });

  /**
   * The blast radius of R7, stated as a contract so step 3 has to confront it.
   *
   * For a peer SETTLE the data outcome is benign — both parties wanted the row
   * settled — but the REPORTING is not: the caller asked to settle a session,
   * and got back an id that is neither settled nor aborted. That is precisely
   * the silent absence the typed outcome exists to eliminate, reappearing
   * through a path the writer never sees.
   *
   * A peer UNSETTLE is the dangerous shape: it moves the tuple the other way
   * without bumping the revision, so a revision-conditional apply in step 3
   * would not notice it either.
   */
  it("R7b: a bypassing peer write leaves the caller unable to tell what happened", async () => {
    const { db, service, setDuringCheck } = await fixture();

    setDuringCheck(() => {
      db.run(
        "update terminal_sessions set settled_at = ?, settle_source = ? where id = ?",
        ["2026-08-11T00:07:00.000Z", "user", "session-1"],
      );
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    const accountedFor = [
      ...outcome.settled,
      ...outcome.aborted.map((entry) => entry.sessionId),
    ];
    expect(
      accountedFor,
      "an id the writer never saw change must not vanish from both lists",
    ).toEqual([]);
  });

  /**
   * `clearOnActivity` is single-session by construction, and the writer now says
   * so rather than carrying a per-session partition no test could reach.
   *
   * This replaced two tests that were green against the bug they were written to
   * catch: a multi-id MECHANICAL clear is not expressible through the service
   * API, so any test built from C4/C5 calls filters to a single id and proves
   * nothing about batching.
   */
  it("refuses a multi-id clear rather than guessing one disposition for the batch", async () => {
    const { service, db, create } = await fixture();
    create("session-2");
    await service.settleSessions(["session-1", "session-2"]);

    // The service API cannot express a multi-id `clearOnActivity`, so reach the
    // writer directly — otherwise the refusal this test is named for is never
    // executed and the test passes on unrelated behavior.
    const writer = createSettleLifecycleWriter(db);
    expect(() =>
      writer.write({
        intent: { kind: "clearOnActivity", cause: "turn_start" },
        sessionIds: ["session-1", "session-2"],
      }),
    ).toThrow();

    // A declared multi-id unsettle is a different intent and stays allowed.
    service.unsettleSessions(["session-1", "session-2"]);
    expect(service.get("session-1")?.settledAt).toBeNull();
    expect(service.get("session-2")?.settledAt).toBeNull();
  });

  /**
   * A check whose read throws could not tell whether the chat is working. It
   * must refuse rather than file it, must not leak the window, and must not
   * discard the accounting for the rest of the batch.
   */
  it("refuses a session whose check throws and still closes its window", async () => {
    const { service, create, setDuringCheck } = await fixture();
    create("session-2");

    setDuringCheck((sessionId) => {
      if (sessionId === "session-1") throw new Error("chat service unavailable");
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1", "session-2"]);

    expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "status_unknown" }]);
    // The rest of the batch was still attempted and accounted for.
    expect(outcome.settled).toEqual(["session-2"]);
    setDuringCheck(() => {});
    await expectWindowClosed(service);
  });

  /**
   * A delete force-closes the window mid-check. Whatever occupies the id
   * afterwards — a recreated session — is not this settle's, and a settle
   * reading `abortedBy` alone would see "not aborted" and file the new row.
   */
  it("does not file a recreated session whose old window was force-closed", async () => {
    const { service, create, setDuringCheck } = await fixture();

    setDuringCheck(() => {
      service.deleteSession("session-1");
      create("session-1");
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(outcome.settled).toEqual([]);
    expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "lifecycle_changed" }]);
    expect(service.get("session-1")?.settledAt).toBeNull();
  });

  it("crash safety: the settling window does not survive the process", async () => {
    const { db, service, setDuringCheck } = await fixture();

    // A fresh service on the same database is what a restart sees. Captured,
    // not asserted, inside the callback: a failing `expect` in there throws,
    // the check catch turns it into `status_unknown`, and the test stays green
    // while proving nothing.
    let afterRestart: SettleSessionsOutcome | null = null;
    setDuringCheck(async () => {
      afterRestart = await createSessionService({ db }).settleSessionsReportingAborts(["session-1"]);
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    // The restarted service holds no window, so it settles rather than joining.
    expect(afterRestart).toEqual({ settled: ["session-1"], aborted: [] });
    // And the original, whose revision moved under it, does not file twice.
    expect(outcome).toEqual({ settled: [], aborted: [{ sessionId: "session-1", reason: "lifecycle_changed" }] });
    setDuringCheck(() => {});
    service.unsettleSession("session-1");
    await expectWindowClosed(service);
  });

  it("stops the queue when a persistence failure propagates", async () => {
    const { service, db, create, setDuringCheck } = await fixture();
    const ids = ["session-1"];
    for (let n = 2; n <= 12; n += 1) {
      create(`session-${n}`);
      ids.push(`session-${n}`);
    }

    // Fail the write for one session only. The pool must stop taking new work
    // rather than settling rows the caller has already given up on.
    const realRunChanged = db.runChanged.bind(db);
    let checked = 0;
    setDuringCheck(() => { checked += 1; });
    db.runChanged = ((sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && /update\s+terminal_sessions/i.test(sql)
        && Array.isArray(params) && params.includes("session-2")) {
        throw new Error("database is locked");
      }
      return realRunChanged(sql, params as never);
    }) as typeof db.runChanged;

    await expect(service.settleSessionsReportingAborts(ids)).rejects.toThrow(/locked/);
    db.runChanged = realRunChanged;

    // Far short of all twelve: the queue was drained, so the pool stopped
    // taking new sessions instead of running on past the caller. The few
    // already in flight when it failed still finish, which is the point —
    // nothing is abandoned half-written.
    expect(checked, "the pool must stop taking new sessions after a failure").toBeLessThan(ids.length);
    // And every window closed, or those rows would be unsettleable for the
    // life of the process.
    await expectWindowClosed(service, "session-2");
  });

  it("keeps a persistence failure distinct from a failed check", async () => {
    const { service, db, setDuringCheck } = await fixture();
    let checked = 0;
    setDuringCheck(() => {
      checked += 1;
    });
    // The check passes; saving the row is what breaks. The settle tuple lands
    // via `runChanged` (the bump needs the matched-row count), so patching
    // `run` alone would sail straight past it.
    const realRunChanged = db.runChanged.bind(db);
    db.runChanged = ((sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && /update\s+terminal_sessions/i.test(sql)) {
        throw new Error("database is locked");
      }
      return realRunChanged(sql, params as never);
    }) as typeof db.runChanged;

    // It must NOT come back as `status_unknown`: the check answered, and
    // labelling a lock as "could not tell" hides the real failure.
    await expect(service.settleSessionsReportingAborts(["session-1"])).rejects.toThrow(/locked/);
    expect(checked, "the check ran, so it must not be reported as failed").toBe(1);
    db.runChanged = realRunChanged;
    // The window still closed, or the session would be permanently unsettleable.
    await expectWindowClosed(service);
  });

  it("does not erase an existing status note when a re-settle supplies none", async () => {
    const { service, db } = await fixture();
    expect(await service.settleSession("session-1", { outcome: "shipped the fix" })).toBe(true);
    service.unsettleSession("session-1");

    // Re-settling with no outcome must leave the previous note alone.
    expect(await service.settleSession("session-1")).toBe(true);
    const row = db.get<{ status_note: string | null }>(
      "select status_note from terminal_sessions where id = ?",
      ["session-1"],
    );
    expect(row?.status_note).toBe("shipped the fix");
  });

  it("tells an aborted single-session settle apart from a missing one", async () => {
    const { service, setDuringCheck } = await fixture();
    // A turn starts while the settle is mid-check, exactly as in R1.
    setDuringCheck(() => {
      service.clearTurnStartMarkers("session-1");
    });

    // The boolean form must not claim success...
    expect(await service.settleSession("session-1")).toBe(false);
    // ...and the typed form must say WHY, so a caller does not report a session
    // that is sitting right there working as "not found".
    const aborted = await service.settleSessionReportingAbort("session-1");
    expect(aborted).toEqual({ found: true, settled: false, abortedBy: "turn_start" });
    expect(await service.settleSessionReportingAbort("no-such-session")).toEqual({
      found: false,
      settled: false,
    });
  });
  /**
   * Decision 1 for step 3: finish host authority instead of building consensus
   * machinery. A replicated settle-tuple write is routed back through the
   * chokepoint, so it gains the revision, the settling window and the abort
   * semantics a local decision has — no peer-visible concurrency token.
   */
  it("checks sessions concurrently, and still reports in the caller's order", async () => {
    const { service, create, setDuringCheck } = await fixture();
    for (const id of ["session-2", "session-3"]) create(id);

    let inFlight = 0;
    let peakInFlight = 0;
    const release: Array<() => void> = [];
    setDuringCheck(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => { release.push(resolve); });
      inFlight -= 1;
    });

    const pending = service.settleSessionsReportingAborts(["session-3", "session-1", "session-2"]);
    // Let all three checks start before any finishes.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    // Asserted BEFORE draining: serial checks park two of the three behind
    // the first, and the drain below would then hang until vitest's timeout —
    // a real failure, but reported as "test timed out" instead of as this.
    expect(release.length, "bulk settle must not check one session at a time").toBeGreaterThan(1);
    while (release.length) release.pop()!();
    const outcome = await pending;

    // Serial checks were the regression: a slow read is paid once per session,
    // and iOS gives the whole command 30s.
    expect(peakInFlight, "bulk settle must not check one session at a time").toBeGreaterThan(1);
    // Order follows the request, not whichever check finished first.
    expect(outcome.settled).toEqual(["session-3", "session-1", "session-2"]);
  });

  describe("remote settle-tuple reconciliation", () => {
    /** Stands in for `applyChanges` having merged the peer's columns. */
    const applyPeerWrite = (db: Awaited<ReturnType<typeof fixture>>["db"], sql: string, params: unknown[]) => {
      db.run(sql, params as never);
    };

    it("bumps the revision for a peer settle, without re-deciding the value", async () => {
      const { db, service, remoteWrites } = await fixture();
      const revisionBefore = service.getSettleLifecycleRevision("session-1");
      applyPeerWrite(
        db,
        "update terminal_sessions set settled_at = ?, settle_source = ? where id = ?",
        ["2026-08-11T00:07:00.000Z", "user", "session-1"],
      );

      service.reconcileRemoteSettleTuple([
        { sessionId: "session-1", column: "settled_at" },
        { sessionId: "session-1", column: "settle_source" },
      ]);

      // The peer's value stands exactly as CRR merged it.
      expect(service.get("session-1")?.settledAt).toBe("2026-08-11T00:07:00.000Z");
      // And an in-flight settle can now see that the world moved.
      expect(service.getSettleLifecycleRevision("session-1")).toBeGreaterThan(revisionBefore);
      expect(remoteWrites).toEqual([{ columns: ["settle_source", "settled_at"], changesetSessionCount: 1 }]);
    });

    it("makes a peer reactivation abort an in-flight settle instead of being overwritten", async () => {
      const { db, service, setDuringCheck } = await fixture();
      await service.settleSessionsReportingAborts(["session-1"]);
      service.unsettleSession("session-1");

      setDuringCheck(() => {
        // The mirror case Codex raised: a peer reactivates the session while
        // this host is mid-settle.
        applyPeerWrite(
          db,
          "update terminal_sessions set settle_override = ? where id = ?",
          ["active", "session-1"],
        );
        service.reconcileRemoteSettleTuple([
          { sessionId: "session-1", column: "settle_override" },
        ]);
      });
      const outcome = await service.settleSessionsReportingAborts(["session-1"]);

      expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "remote_lifecycle_changed" }]);
      expect(outcome.settled).toEqual([]);
      // `remote_lifecycle_changed`, not `lifecycle_changed`: the abort tripped
      // while the check was still in flight, not only via the revision after.
      // The peer's reactivation survives.
      expect(service.get("session-1")?.settleOverride).toBe("active");
      expect(service.get("session-1")?.settledAt).toBeNull();
    });

    it("ignores a change for a row this host does not have", async () => {
      const { service, remoteWrites } = await fixture();

      service.reconcileRemoteSettleTuple([{ sessionId: "not-here", column: "settled_at" }]);

      expect(remoteWrites).toEqual([]);
    });

    it("keeps reconciling the rest of the batch when one session is unknown", async () => {
      const { db, service, create, remoteWrites } = await fixture();
      create("session-2");
      applyPeerWrite(db, "update terminal_sessions set settled_at = ? where id = ?", ["2026-08-11T00:07:00.000Z", "session-2"]);

      service.reconcileRemoteSettleTuple([
        { sessionId: "not-here", column: "settled_at" },
        { sessionId: "session-2", column: "settled_at" },
      ]);

      // The missing row must not cost session-2 its revision bump — and the
      // report is ONE event for the batch, not one per session.
      expect(remoteWrites).toEqual([{ columns: ["settled_at"], changesetSessionCount: 2 }]);
    });
  });
});
