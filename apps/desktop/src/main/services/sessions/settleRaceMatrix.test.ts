import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createSessionService } from "./sessionService";

/**
 * The race matrix from the settle-teardown design (§2), tested directly against
 * the lifecycle revision and the settling window — with teardown still a NO-OP.
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

describe("settle race matrix (teardown is a no-op)", () => {
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
    let teardown: (sessionId: string) => void = () => {};
    const service = createSessionService({
      db,
      runSettleTeardown: (sessionId) => teardown(sessionId),
    });
    const setTeardown = (fn: (sessionId: string) => void) => {
      teardown = fn;
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
    return { db, service, create, setTeardown };
  }

  /**
   * R1 — settle vs turn start. The worst case: the user is actively working and
   * the row goes quiet. C3 fires during teardown; the settle must be abandoned,
   * not applied afterwards.
   */
  it("R1: a turn starting during teardown abandons the settle", async () => {
    const { service, setTeardown } = await fixture();
    service.settleSessions(["session-1"]);
    service.unsettleSession("session-1");

    setTeardown(() => {
      service.clearTurnStartMarkers("session-1");
    });
    const outcome = service.settleSessionsReportingAborts(["session-1"]);

    expect(outcome.settled).toEqual([]);
    expect(outcome.aborted).toEqual([{ sessionId: "session-1", reason: "turn_start" }]);
    expect(service.get("session-1")?.settledAt).toBeNull();
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
    const outcome = service.settleSessionsReportingAborts(["session-1"]);

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
    const outcome = service.settleSessionsReportingAborts(["session-1"]);

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

    let inner: ReturnType<typeof service.settleSessionsReportingAborts> | null = null;
    setTeardown(() => {
      teardowns += 1;
      // Re-entrant settle, exactly as a PR-merge poll landing mid-user-settle.
      // The window is already open, so this must JOIN rather than tear down
      // again — the teardown counter is what proves it.
      inner = service.settleSessionsReportingAborts(["session-1"]);
    });

    const outcome = service.settleSessionsReportingAborts(["session-1"]);

    expect(teardowns, "the joined settle must not start its own teardown").toBe(1);
    expect(outcome.settled).toEqual(["session-1"]);
    // The joiner reports nothing: the owner reports the outcome, and
    // double-counting would make a bulk caller see one session twice.
    expect(inner).toMatchObject({ settled: [], aborted: [] });
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
    const outcome = service.settleSessionsReportingAborts(["session-1"]);

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
    service.settleSessions(["session-1"]);
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
    const outcome = service.settleSessionsReportingAborts(["session-1"]);

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
    const outcome = service.settleSessionsReportingAborts(["session-1"]);

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
   * The swallow is per session, not per batch.
   *
   * Unreachable today — every mechanical caller is single-session — but deciding
   * one disposition for a whole array would silently stop a NON-settling
   * session's own output from clearing its settle, and nothing in the signature
   * warns the caller who first passes two ids.
   */
  it("swallows only the settling session in a mixed batch", async () => {
    const { db, service, create, setTeardown } = await fixture();
    create("session-2");
    service.settleSessions(["session-2"]);
    expect(service.get("session-2")?.settledAt).toBeTruthy();

    setTeardown(() => {
      // Drive the writer directly with both ids: session-1's window is open,
      // session-2's is not.
      db.run("update terminal_sessions set last_output_at = ? where id = ?",
        ["2026-08-11T00:09:00.000Z", "session-2"]);
      service.setLastOutputPreview("session-2", "other session output", { clearSettled: true });
      service.setLastOutputPreview("session-1", "settling session output", { clearSettled: true });
    });
    const outcome = service.settleSessionsReportingAborts(["session-1"]);

    // The settling session's output was swallowed: it still settled.
    expect(outcome.settled).toEqual(["session-1"]);
    // The other session's output cleared its settle normally.
    expect(service.get("session-2")?.settledAt).toBeNull();
    expect(service.get("session-2")?.lastOutputPreview).toBe("other session output");
  });

  /** A settling row found after a restart resolves to not-settled. */
  it("crash safety: the settling window does not survive the process", async () => {
    const { service, setTeardown } = await fixture();
    expect(service.settlingSessionIds()).toEqual([]);

    setTeardown(() => {
      expect(service.settlingSessionIds()).toEqual(["session-1"]);
    });
    service.settleSessionsReportingAborts(["session-1"]);

    // Always ended, even on the abandoned path — a leaked window would make the
    // session permanently unsettleable.
    expect(service.settlingSessionIds()).toEqual([]);
  });
});
