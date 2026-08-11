import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createSessionService } from "./sessionService";
import { createSettleLifecycleWriter } from "./settleLifecycleWriter";
import type { SettleResidueItem, SettleTeardownContext } from "./sessionSettleTeardown";


/**
 * The race matrix from the settle-teardown design (§2), tested directly against
 * the lifecycle revision and the settling window — with a real, awaited teardown.
 *
 * That ordering is the point. Every one of these races was previously argued
 * about in review rather than executed, and the six rounds of PR #1059 are what
 * that cost. Here the teardown callback is a seam we drive by hand: whatever it
 * does is what a real provider stop would have been doing when the race landed.
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
    // The teardown seam the race matrix drives. Whatever this does is what a
    // real provider stop would have been doing when the race landed.
    let teardown: (sessionId: string) => void | Promise<void> = () => {};
    // Records what the seam was handed, so a test can assert the abort was
    // visible to teardown WHILE it ran rather than only afterwards.
    const teardownContexts: SettleTeardownContext[] = [];
    let residue: SettleResidueItem[] = [];
    const remoteWrites: Array<{ columns: string[] }> = [];
    const service = createSessionService({
      db,
      onRemoteSettleWrite: (args) => { remoteWrites.push(args); },
      runSettleTeardown: async (sessionId, ctx) => {
        teardownContexts.push(ctx);
        await teardown(sessionId);
        return { residue };
      },
    });
    const setTeardown = (fn: (sessionId: string) => void | Promise<void>) => {
      teardown = fn;
    };
    const setResidue = (items: SettleResidueItem[]) => {
      residue = items;
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
    return { db, service, create, setTeardown, setResidue, teardownContexts, remoteWrites };
  }

  /**
   * R1 — settle vs turn start. The worst case: the user is actively working and
   * the row goes quiet. C3 fires during teardown; the settle must be abandoned,
   * not applied afterwards.
   */
  it("R1: a turn starting during teardown abandons the settle", async () => {
    const { service, setTeardown } = await fixture();
    await service.settleSessions(["session-1"]);
    service.unsettleSession("session-1");

    setTeardown(() => {
      service.clearTurnStartMarkers("session-1");
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(outcome.settled).toEqual([]);
    expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "turn_start" }]);
    expect(service.get("session-1")?.settledAt).toBeNull();
    // A leaked window would swallow this session's output forever and leave it
    // permanently unsettleable — the mechanism's worst failure mode.
    expect(service.settlingSessionIds()).toEqual([]);
  });

  /**
   * R2 — settle abandoned after teardown ran. Teardown is a no-op here, so what
   * this pins is the reporting half: the caller is told, and never sees silent
   * success. #1059 returned success and that is what a caller built on.
   */
  it("R2: an abandoned settle reports the reason instead of silent success", async () => {
    const { service, setTeardown } = await fixture();
    let teardownRan = false;

    setTeardown(() => {
      teardownRan = true;
      service.requestAttention("session-1", "need you");
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(teardownRan).toBe(true);
    expect(outcome.settled).toEqual([]);
    expect(outcome.aborted[0]).toMatchObject({ sessionId: "session-1", reason: "attention_requested" });
  });

  /** R3 — work drains on its own during teardown. Benign; the settle lands. */
  it("R3: background work finishing during teardown does not block the settle", async () => {
    const { service, setTeardown } = await fixture();

    setTeardown(() => {
      // A stop against an already-finished task is a no-op, and nothing touches
      // the settle tuple.
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(outcome.aborted).toEqual([]);
    expect(outcome.settled).toEqual(["session-1"]);
    expect(service.get("session-1")?.settledAt).toBeTruthy();
  });

  /**
   * R4 — concurrent settle sources. PR-merge auto-settle racing a user settle
   * must not run two teardowns against one session.
   */
  it("R4: a second settle joins the in-flight one instead of tearing down twice", async () => {
    const { service, setTeardown } = await fixture();
    let teardowns = 0;

    let inner: Awaited<ReturnType<typeof service.settleSessionsReportingAborts>> | null = null;
    setTeardown(async () => {
      teardowns += 1;
      // Re-entrant settle, exactly as a PR-merge poll landing mid-user-settle.
      // The window is already open, so this must JOIN rather than tear down
      // again — the teardown counter is what proves it.
      inner = await service.settleSessionsReportingAborts(["session-1"]);
    });

    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(teardowns, "the joined settle must not start its own teardown").toBe(1);
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
   * R6 — output during teardown, the high-frequency shape of R1. This is the
   * case that would make the feature dead on arrival: stopping a process emits
   * output, so C4/C5 fire BECAUSE teardown is running. They must be swallowed on
   * all three axes or no settle could ever land.
   */
  it("R6: output during teardown is swallowed on all three axes", async () => {
    const { service, setTeardown } = await fixture();
    const revisionBefore = service.getSettleLifecycleRevision("session-1");

    setTeardown(() => {
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
   * This test exists to show the BLAST RADIUS before teardown exists, per the
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
    const { db, service, setTeardown } = await fixture();
    const revisionBefore = service.getSettleLifecycleRevision("session-1");

    setTeardown(() => {
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
    const { db, service, setTeardown } = await fixture();

    setTeardown(() => {
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
      "step 3 must account for an id the writer never saw change",
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
   * A teardown that throws is routine in step 3 — a process refuses to die, a
   * cloud stop 500s. It must be reported, must not leak the window, and must not
   * discard the accounting for the rest of the batch.
   */
  it("reports a throwing teardown and still closes its window", async () => {
    const { service, create, setTeardown } = await fixture();
    create("session-2");

    setTeardown((sessionId) => {
      if (sessionId === "session-1") throw new Error("provider stop failed");
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1", "session-2"]);

    expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "teardown_failed" }]);
    // The rest of the batch was still attempted and accounted for.
    expect(outcome.settled).toEqual(["session-2"]);
    expect(service.settlingSessionIds()).toEqual([]);
  });

  /** A settling row found after a restart resolves to not-settled. */
  it("crash safety: the settling window does not survive the process", async () => {
    const { service, setTeardown } = await fixture();
    expect(service.settlingSessionIds()).toEqual([]);

    // Captured, not asserted, inside the callback: a failing `expect` in there
    // throws, the teardown catch turns it into `teardown_failed`, and the test
    // stays green while proving nothing.
    let duringWindow: string[] | null = null;
    setTeardown(() => {
      duringWindow = service.settlingSessionIds();
    });
    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(outcome.aborted, "the teardown must not have thrown").toEqual([]);
    expect(duringWindow, "the session must be visibly settling mid-teardown").toEqual([
      "session-1",
    ]);
    // Always ended, even on the abandoned path — a leaked window would make the
    // session permanently unsettleable.
    expect(service.settlingSessionIds()).toEqual([]);
  });
  it("keeps a persistence failure distinct from a failed teardown", async () => {
    const { service, db, setTeardown } = await fixture();
    let stopped = 0;
    setTeardown(() => {
      stopped += 1;
    });
    // Teardown succeeds; saving the row is what breaks.
    // The settle tuple lands via `runChanged` (the bump needs the matched-row
    // count), so patching `run` alone would sail straight past it.
    const realRunChanged = db.runChanged.bind(db);
    db.runChanged = ((sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && /update\s+terminal_sessions/i.test(sql)) {
        throw new Error("database is locked");
      }
      return realRunChanged(sql, params as never);
    }) as typeof db.runChanged;

    // It must NOT come back as `teardown_failed`: the work really did stop, and
    // labelling it a teardown failure invites a caller to retry the stop.
    await expect(service.settleSessionsReportingAborts(["session-1"])).rejects.toThrow(/locked/);
    expect(stopped, "teardown ran, so it must not be reported as failed").toBe(1);
    db.runChanged = realRunChanged;
    // The window still closed, or the session would be permanently unsettleable.
    expect(service.settlingSessionIds()).toEqual([]);
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
    const { service, setTeardown } = await fixture();
    // A turn starts while the settle is mid-teardown, exactly as in R1.
    setTeardown(() => {
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
   * R5, end to end: an unconfirmed stop does NOT block the settle (3d option 3),
   * and the residue is discoverable on the row afterwards rather than only
   * returned to whoever happened to call.
   */
  it("R5: settles with recorded residue when teardown cannot confirm the stop", async () => {
    const { service, setResidue } = await fixture();
    setResidue([{
      kind: "background_tasks",
      reason: "no_stop_control",
      count: 2,
      detail: "2 jobs on codex could not be stopped",
    }]);

    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    // Filed, not blocked: option 1 (reject the settle) was explicitly not chosen.
    expect(outcome.settled).toEqual(["session-1"]);
    expect(outcome.aborted).toEqual([]);
    expect(service.get("session-1")?.settledAt).not.toBeNull();

    const residue = service.getSettleResidue("session-1");
    expect(residue?.items).toEqual([{
      kind: "background_tasks",
      reason: "no_stop_control",
      count: 2,
      detail: "2 jobs on codex could not be stopped",
    }]);
  });

  it("does not leave residue hanging on a session the user reactivated", async () => {
    const { service, setResidue } = await fixture();
    setResidue([{
      kind: "background_tasks", reason: "timeout", count: 1, detail: "1 job could not be stopped",
    }]);
    await service.settleSessionsReportingAborts(["session-1"]);
    expect(service.getSettleResidue("session-1")).not.toBeNull();

    service.unsettleSession("session-1");

    // The row is working again. A stale "1 job could not be stopped" marker
    // would re-light a session that is fine.
    expect(service.getSettleResidue("session-1")).toBeNull();
  });

  it("records no residue for a settle that was abandoned", async () => {
    const { service, setResidue, setTeardown } = await fixture();
    setResidue([{
      kind: "background_tasks", reason: "timeout", count: 1, detail: "1 job could not be stopped",
    }]);
    setTeardown(() => {
      service.clearTurnStartMarkers("session-1");
    });

    const outcome = await service.settleSessionsReportingAborts(["session-1"]);

    expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "turn_start" }]);
    // Nothing was filed, so there is no settled row for residue to describe.
    expect(service.getSettleResidue("session-1")).toBeNull();
  });
  /**
   * Decision 1 for step 3: finish host authority instead of building consensus
   * machinery. A replicated settle-tuple write is routed back through the
   * chokepoint, so it gains the revision, the settling window and the abort
   * semantics a local decision has — no peer-visible concurrency token.
   */
  describe("remote settle-tuple reconciliation", () => {
    /**
     * Decision 1 for step 3: finish host authority rather than add consensus.
     *
     * The VALUES are applied by CRR merge before the session layer is told —
     * that is what keeps the per-column clocks convergent, and an earlier
     * version that rebuilt the intent instead left this host's clock behind the
     * peer forever, so its next genuine decision lost every merge. What
     * reconciliation adds is the lifecycle revision, which is what an in-flight
     * settle re-reads after its teardown await.
     */
    const applyPeerWrite = (db: Awaited<ReturnType<typeof fixture>>["db"], sql: string, params: unknown[]) => {
      // Stands in for `applyChanges` having merged the peer's columns.
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
      expect(remoteWrites).toEqual([{ columns: ["settle_source", "settled_at"] }]);
    });

    it("makes a peer reactivation abort an in-flight settle instead of being overwritten", async () => {
      const { db, service, setTeardown } = await fixture();
      await service.settleSessionsReportingAborts(["session-1"]);
      service.unsettleSession("session-1");

      setTeardown(() => {
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

      expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "lifecycle_changed" }]);
      expect(outcome.settled).toEqual([]);
      // The peer's reactivation survives.
      expect(service.get("session-1")?.settleOverride).toBe("active");
      expect(service.get("session-1")?.settledAt).toBeNull();
    });

    it("ignores a change for a row this host does not have", async () => {
      const { service, remoteWrites } = await fixture();

      service.reconcileRemoteSettleTuple([{ sessionId: "not-here", column: "settled_at" }]);

      expect(remoteWrites).toEqual([]);
    });

    it("keeps reconciling the rest of the batch when one session fails", async () => {
      const { db, service, create, remoteWrites } = await fixture();
      create("session-2");
      applyPeerWrite(db, "update terminal_sessions set settled_at = ? where id = ?", ["2026-08-11T00:07:00.000Z", "session-2"]);

      service.reconcileRemoteSettleTuple([
        { sessionId: "not-here", column: "settled_at" },
        { sessionId: "session-2", column: "settled_at" },
      ]);

      // The missing row must not cost session-2 its revision bump.
      expect(remoteWrites).toEqual([{ columns: ["settled_at"] }]);
    });
  });
});
