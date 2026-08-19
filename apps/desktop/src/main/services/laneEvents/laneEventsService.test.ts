import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createLaneEventsService } from "./laneEventsService";
import { parseCommitLog } from "./laneEventsGitLog";
import { pickTailChat } from "./laneEventsReadModel";

const PROJECT_ID = "proj-1";
const LANE_ID = "lane-1";
const WORKTREE = "/tmp/ade-lane-1";

const UNIT = "\u001f";
const RECORD = "\u001e";
const MULTI = "\u001d";

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
}

/** A git runner that answers from a fixed table and records what it was asked. */
function stubGit(responses: Array<{ match: (args: string[]) => boolean; stdout: string }>) {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    const hit = responses.find((response) => response.match(args));
    return { exitCode: hit ? 0 : 1, stdout: hit?.stdout ?? "", stderr: "" };
  });
  return { run, calls };
}

function commitRecord(args: {
  sha: string;
  subject: string;
  author?: string;
  at?: string;
  trailers?: string[];
}): string {
  return (
    RECORD +
    [
      args.sha,
      args.sha.slice(0, 7),
      args.author ?? "Arul Sharma",
      args.at ?? "2026-08-18T10:00:00+00:00",
      args.subject,
      (args.trailers ?? []).join(MULTI),
    ].join(UNIT) +
    "\n"
  );
}

describe("laneEventsService", () => {
  let dir: string;
  let db: Awaited<ReturnType<typeof openKvDb>>;

  const insertLane = (id = LANE_ID) => {
    db.run(
      `insert into lanes (id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, status, created_at)
       values (?, ?, ?, 'worktree', 'main', ?, ?, 'active', '2026-08-01T00:00:00.000Z')`,
      [id, PROJECT_ID, `Lane ${id}`, `ade/${id}`, WORKTREE],
    );
  };

  const makeService = (overrides: Parameters<typeof createLaneEventsService>[0] extends never ? never : Partial<Parameters<typeof createLaneEventsService>[0]> = {}) =>
    createLaneEventsService({
      db,
      projectId: PROJECT_ID,
      logger: createLogger(),
      runGitCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
      ...overrides,
    });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-events-"));
    db = await openKvDb(path.join(dir, "kv.sqlite"), createLogger());
    insertLane();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records an event and dedupes the second write on (lane, kind, ref)", async () => {
    const service = makeService();
    const first = await service.record({
      laneId: LANE_ID,
      kind: "commit",
      ts: "2026-08-18T10:00:00.000Z",
      actor: { kind: "agent", chatSessionId: "chat-1", provider: "claude", attribution: "session" },
      ref: "sha-1",
      branchRef: "ade/lane-1",
      payload: { sha: "sha-1", shortSha: "sha-1", subject: "first" },
    });
    expect(first).not.toBeNull();

    const second = await service.record({
      laneId: LANE_ID,
      kind: "commit",
      ts: "2026-08-18T11:00:00.000Z",
      actor: { kind: "unknown" },
      ref: "sha-1",
      branchRef: "ade/lane-1",
      payload: { sha: "sha-1", shortSha: "sha-1", subject: "first again" },
    });
    expect(second).toBeNull();

    const rows = db.all<{ count: number }>("select count(1) as count from lane_events");
    expect(Number(rows[0]?.count)).toBe(1);
    service.dispose();
  });

  it("drops the oldest re-derivable rows first when a lane passes the cap", async () => {
    const service = makeService();
    // Cap enforcement is checked on every insert, so seed just under it.
    const seed = db;
    for (let i = 0; i < 4000; i += 1) {
      seed.run(
        `insert into lane_events (id, project_id, lane_id, kind, ts, actor_kind, ref, payload_json, created_at)
         values (?, ?, ?, ?, ?, 'unknown', ?, '{}', ?)`,
        [
          `seed-${i}`,
          PROJECT_ID,
          LANE_ID,
          i === 0 ? "chat_started" : "commit",
          `2026-08-0${1 + (i % 9)}T00:00:0${i % 10}.000Z`,
          `ref-${i}`,
          "2026-08-01T00:00:00.000Z",
        ],
      );
    }

    await service.record({
      laneId: LANE_ID,
      kind: "pr_opened",
      ts: "2026-08-18T12:00:00.000Z",
      actor: { kind: "human" },
      ref: "pr-1",
      branchRef: null,
      payload: { prId: "pr-1", githubPrNumber: 1 },
    });

    const total = db.get<{ count: number }>("select count(1) as count from lane_events where lane_id = ?", [LANE_ID]);
    expect(Number(total?.count)).toBe(4000);
    // The lifecycle row is not evictable; a commit row went instead.
    const lifecycle = db.get<{ count: number }>(
      "select count(1) as count from lane_events where lane_id = ? and kind = 'chat_started'",
      [LANE_ID],
    );
    expect(Number(lifecycle?.count)).toBe(1);
    service.dispose();
  });

  it("forgetLane drops the queued notification without touching the rows", async () => {
    vi.useFakeTimers();
    try {
      const service = makeService();
      const seen: string[] = [];
      service.onChanged((event) => seen.push(event.laneId));
      await service.record({
        laneId: LANE_ID,
        kind: "lane_created",
        ts: "2026-08-01T00:00:00.000Z",
        actor: { kind: "human" },
        ref: LANE_ID,
        branchRef: "ade/lane-1",
        payload: { source: "human", branchRef: "ade/lane-1", baseRef: "main" },
      });

      service.forgetLane(LANE_ID);
      vi.advanceTimersByTime(1_000);

      // The rows belong to the lane teardown transaction, not to this service.
      expect(db.all("select id from lane_events where lane_id = ?", [LANE_ID])).toHaveLength(1);
      expect(seen).toEqual([]);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives commits from git with trailer attribution, and lets a persisted row win", async () => {
    const git = stubGit([
      { match: (args) => args[0] === "rev-list" && args[1] === "--count", stdout: "2\n" },
      {
        match: (args) => args[0] === "log",
        stdout:
          commitRecord({ sha: "aaa1111", subject: "agent work", trailers: ["Claude Opus 5 <noreply@anthropic.com>"] }) +
          " 2 files changed, 10 insertions(+), 3 deletions(-)\n" +
          commitRecord({ sha: "bbb2222", subject: "human work", at: "2026-08-18T09:00:00+00:00" }),
      },
      { match: (args) => args[0] === "merge-base", stdout: "base000\n" },
      { match: (args) => args[0] === "config", stdout: "Arul Sharma\n" },
    ]);
    const service = makeService({ runGitCommand: git.run });

    await service.record({
      laneId: LANE_ID,
      kind: "commit",
      ts: "2026-08-18T08:00:00.000Z",
      actor: { kind: "agent", chatSessionId: "chat-9", provider: "cursor", attribution: "session" },
      ref: "aaa1111",
      branchRef: "ade/lane-1",
      payload: { sha: "aaa1111", shortSha: "aaa1111", subject: "agent work" },
    });

    const result = await service.list({ laneId: LANE_ID });
    const commits = result.events.filter((event) => event.kind === "commit");
    expect(commits).toHaveLength(2);

    const persisted = commits.find((event) => event.ref === "aaa1111")!;
    expect(persisted.derived).toBe(false);
    expect(persisted.actor.provider).toBe("cursor");

    const derivedHuman = commits.find((event) => event.ref === "bbb2222")!;
    expect(derivedHuman.derived).toBe(true);
    expect(derivedHuman.actor.kind).toBe("human");
    expect(result.hasDerived).toBe(true);
    expect(result.baseRef).toBe("main");
    service.dispose();
  });

  it("derives a lane_created and the PR story from rows when nothing was recorded", async () => {
    db.run(
      `insert into pull_requests
         (id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url,
          state, base_branch, head_branch, additions, deletions, created_at, updated_at, merged_at, merged_by_login)
       values ('pr-1', ?, ?, 'arul', 'ADE', 42, 'https://github.com/arul/ADE/pull/42',
               'merged', 'main', 'ade/lane-1', 1, 1, '2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
               '2026-08-12T00:00:00.000Z', 'arul')`,
      [PROJECT_ID, LANE_ID],
    );

    const service = makeService();
    const result = await service.list({ laneId: LANE_ID });
    const kinds = result.events.map((event) => event.kind);
    expect(kinds).toContain("lane_created");
    expect(kinds).toContain("pr_opened");
    expect(kinds).toContain("pr_merged");
    const merged = result.events.find((event) => event.kind === "pr_merged")!;
    expect(merged.actor.login).toBe("arul");
    expect(result.events.every((event) => event.derived)).toBe(true);
    service.dispose();
  });

  it("summarizes many lanes with counts, a spine and the live chat tail", async () => {
    db.run(
      `insert into terminal_sessions
         (id, lane_id, tracked, title, started_at, transcript_path, status, chat_session_id, last_output_at)
       values ('chat-1', ?, 1, 'Build the thing', '2026-08-17T00:00:00.000Z', '/tmp/t', 'running', 'chat-1', '2026-08-18T09:00:00.000Z')`,
      [LANE_ID],
    );
    const service = makeService();
    await service.record({
      laneId: LANE_ID,
      kind: "commit",
      ts: "2026-08-18T10:00:00.000Z",
      actor: { kind: "agent", provider: "claude", attribution: "trailer" },
      ref: "sha-1",
      branchRef: "ade/lane-1",
      payload: { sha: "sha-1", shortSha: "sha-1", subject: "work" },
    });

    const { summaries } = await service.summary({ laneIds: [LANE_ID, "missing-lane"] });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.commitCount).toBe(1);
    expect(summaries[0]!.lastEventKind).toBe("commit");
    expect(summaries[0]!.spine[0]!.provider).toBe("claude");
    expect(summaries[0]!.tail?.chatSessionId).toBe("chat-1");
    expect(summaries[0]!.tail?.status).toBe("running");
    service.dispose();
  });

  it("records only the shas that are new, attributed to the calling chat session", async () => {
    const git = stubGit([
      { match: (args) => args[0] === "rev-list" && args.includes("--max-count=50"), stdout: "sha-new\nsha-old\n" },
      { match: (args) => args[0] === "log", stdout: commitRecord({ sha: "sha-new", subject: "new work" }) },
    ]);
    const service = makeService({ runGitCommand: git.run });
    await service.record({
      laneId: LANE_ID,
      kind: "commit",
      ts: "2026-08-18T09:00:00.000Z",
      actor: { kind: "human" },
      ref: "sha-old",
      branchRef: "ade/lane-1",
      payload: { sha: "sha-old", shortSha: "sha-old", subject: "old" },
    });

    await service.recordCommitRange({
      laneId: LANE_ID,
      preHeadSha: "sha-old",
      postHeadSha: "sha-new",
      actorSessionId: "chat-7",
      attribution: "session-agent",
    });

    const rows = db.all<{ ref: string; actor_session_id: string | null; attribution: string | null }>(
      "select ref, actor_session_id, attribution from lane_events where kind = 'commit' order by ref",
    );
    expect(rows.map((row) => row.ref)).toEqual(["sha-new", "sha-old"]);
    expect(rows[0]!.actor_session_id).toBe("chat-7");
    expect(rows[0]!.attribution).toBe("session");
    service.dispose();
  });


  it("credits a Git-pane commit to the human, never to a chat that happens to be running", async () => {
    db.run(
      `insert into terminal_sessions
         (id, lane_id, tracked, title, started_at, transcript_path, status, chat_session_id, head_sha_start, last_output_at)
       values ('chat-live', ?, 1, 'Busy agent', '2026-08-17T00:00:00.000Z', '/tmp/t', 'running', 'chat-live', 'sha-old', '2026-08-18T09:00:00.000Z')`,
      [LANE_ID],
    );
    const git = stubGit([
      { match: (args) => args[0] === "rev-list" && args.includes("--max-count=50"), stdout: "sha-ui\n" },
      { match: (args) => args[0] === "log", stdout: commitRecord({ sha: "sha-ui", subject: "typed in the Git pane" }) },
    ]);
    const service = makeService({ runGitCommand: git.run });

    await service.recordCommitRange({
      laneId: LANE_ID,
      preHeadSha: "sha-old",
      postHeadSha: "sha-ui",
      attribution: "session-human",
    });

    const row = db.get<{ actor_kind: string; actor_session_id: string | null; attribution: string | null }>(
      "select actor_kind, actor_session_id, attribution from lane_events where ref = 'sha-ui'",
    );
    expect(row?.actor_kind).toBe("human");
    expect(row?.actor_session_id).toBeNull();
    expect(row?.attribution).toBe("session");
    // The mid-flight-chat guess is a head-watch concept and must not run here.
    expect(git.calls.some((args) => args.includes("--not"))).toBe(false);
    service.dispose();
  });

  it("head-watch excludes the remote BASE branch, not every remote ref", async () => {
    const git = stubGit([
      {
        match: (args) => args[0] === "rev-parse" && args[3] === "origin/main",
        stdout: "base-remote-sha\n",
      },
      { match: (args) => args[0] === "rev-list" && args.includes("--not"), stdout: "" },
    ]);
    const service = makeService({ runGitCommand: git.run });

    await service.recordCommitRange({
      laneId: LANE_ID,
      preHeadSha: "sha-old",
      postHeadSha: "sha-pulled",
      attribution: "head-watch",
    });

    // `--not --remotes` would also drop this lane's own pushed commits; the
    // remote base ref drops only the upstream history a pull brought in.
    expect(git.calls).toContainEqual([
      "rev-list",
      "--max-count=50",
      "sha-old..sha-pulled",
      "--not",
      "base-remote-sha",
    ]);
    expect(db.all("select id from lane_events where lane_id = ?", [LANE_ID])).toHaveLength(0);
    service.dispose();
  });

  it("head-watch applies no filter when the remote base does not resolve", async () => {
    const git = stubGit([
      { match: (args) => args[0] === "rev-list", stdout: "" },
    ]);
    const service = makeService({ runGitCommand: git.run });

    await service.recordCommitRange({
      laneId: LANE_ID,
      preHeadSha: "sha-old",
      postHeadSha: "sha-new",
      attribution: "head-watch",
    });

    expect(git.calls).toContainEqual(["rev-list", "--max-count=50", "sha-old..sha-new"]);
    service.dispose();
  });

  it("prunes the commit rows a history rewrite orphaned", async () => {
    const git = stubGit([
      // The amend leaves the old head unreachable: `--is-ancestor` exits 1,
      // which stubGit models as "no match".
      { match: (args) => args[0] === "rev-list" && args.includes("--max-count=50"), stdout: "sha-amended\n" },
      { match: (args) => args[0] === "merge-base" && args[1] === "main", stdout: "base000\n" },
      {
        match: (args) => args[0] === "rev-list" && args.includes("--max-count=5000"),
        stdout: "sha-amended\n",
      },
      { match: (args) => args[0] === "log", stdout: commitRecord({ sha: "sha-amended", subject: "amended work" }) },
    ]);
    const service = makeService({ runGitCommand: git.run });

    await service.record({
      laneId: LANE_ID,
      kind: "commit",
      ts: "2026-08-18T09:00:00.000Z",
      actor: { kind: "human", attribution: "session" },
      ref: "sha-original",
      branchRef: "ade/lane-1",
      payload: { sha: "sha-original", shortSha: "sha-ori", subject: "original work" },
    });

    await service.recordCommitRange({
      laneId: LANE_ID,
      preHeadSha: "sha-original",
      postHeadSha: "sha-amended",
      attribution: "session-human",
    });

    const refs = db
      .all<{ ref: string }>("select ref from lane_events where lane_id = ? and kind = 'commit'", [LANE_ID])
      .map((row) => row.ref);
    expect(refs).toEqual(["sha-amended"]);
    service.dispose();
  });

  it("leaves the story alone when the head merely moved forward", async () => {
    const git = stubGit([
      // A fast-forward: the old head is still an ancestor, so nothing is pruned.
      { match: (args) => args[0] === "merge-base" && args[1] === "--is-ancestor", stdout: "" },
      { match: (args) => args[0] === "rev-list" && args.includes("--max-count=50"), stdout: "sha-next\n" },
      { match: (args) => args[0] === "log", stdout: commitRecord({ sha: "sha-next", subject: "next" }) },
    ]);
    const service = makeService({ runGitCommand: git.run });
    await service.record({
      laneId: LANE_ID,
      kind: "commit",
      ts: "2026-08-18T09:00:00.000Z",
      actor: { kind: "human", attribution: "session" },
      ref: "sha-prev",
      branchRef: "ade/lane-1",
      payload: { sha: "sha-prev", shortSha: "sha-pre", subject: "prev" },
    });

    await service.recordCommitRange({
      laneId: LANE_ID,
      preHeadSha: "sha-prev",
      postHeadSha: "sha-next",
      attribution: "session-human",
    });

    const refs = db
      .all<{ ref: string }>("select ref from lane_events where lane_id = ? and kind = 'commit' order by ref", [LANE_ID])
      .map((row) => row.ref);
    expect(refs).toEqual(["sha-next", "sha-prev"]);
    // The reachable-set walk never ran: no rewrite, no prune.
    expect(git.calls.some((args) => args.includes("--max-count=5000"))).toBe(false);
    service.dispose();
  });

  it("does not memoize a failed git read as an empty story", async () => {
    let failing = true;
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: "head-1\nbase-1\n", stderr: "" };
      if (failing) return { exitCode: 128, stdout: "", stderr: "fatal: bad object" };
      if (args[0] === "rev-list" && args[1] === "--count") return { exitCode: 0, stdout: "1\n", stderr: "" };
      if (args[0] === "log") {
        return { exitCode: 0, stdout: commitRecord({ sha: "aaa1111", subject: "work" }), stderr: "" };
      }
      return { exitCode: 0, stdout: "base000\n", stderr: "" };
    });
    const service = makeService({ runGitCommand: run });

    const broken = await service.list({ laneId: LANE_ID });
    expect(broken.events.filter((event) => event.kind === "commit")).toHaveLength(0);

    failing = false;
    const healed = await service.list({ laneId: LANE_ID });
    expect(healed.events.filter((event) => event.kind === "commit")).toHaveLength(1);
    service.dispose();
  });

  it("warns when a head move is bigger than the recorded range cap", async () => {
    const shas = Array.from({ length: 50 }, (_, i) => `sha-${i}`);
    const git = stubGit([
      { match: (args) => args[0] === "rev-list", stdout: `${shas.join("\n")}\n` },
      { match: (args) => args[0] === "log", stdout: "" },
    ]);
    const warn = vi.fn();
    const service = makeService({
      runGitCommand: git.run,
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} } as never,
    });

    await service.recordCommitRange({
      laneId: LANE_ID,
      preHeadSha: "sha-base",
      postHeadSha: "sha-tip",
      attribution: "session-agent",
      actorSessionId: "chat-1",
    });

    expect(warn).toHaveBeenCalledWith(
      "lane_events.commit_range_truncated",
      expect.objectContaining({ laneId: LANE_ID, range: "sha-base..sha-tip" }),
    );
    service.dispose();
  });

  it("validates and clamps its own arguments, whatever transport called it", async () => {
    const service = makeService();
    await expect(service.list({ laneId: "  " })).rejects.toThrow(/requires laneId/);
    await expect(service.list({ laneId: LANE_ID, limit: "5" as never })).rejects.toThrow(/finite number/);
    await expect(service.list({ laneId: LANE_ID, sinceTs: 5 as never })).rejects.toThrow(/string or null/);
    await expect(service.list({ laneId: LANE_ID, sinceTs: "not-a-date" })).rejects.toThrow(/ISO-8601/);
    await expect(service.list({ laneId: LANE_ID, persistedOnly: 1 as never })).rejects.toThrow(/boolean/);
    await expect(service.summary({ laneIds: "lane-1" as never })).rejects.toThrow(/array/);
    await expect(service.summary({ laneIds: [1] as never })).rejects.toThrow(/strings/);

    for (let i = 0; i < 3; i += 1) {
      await service.record({
        laneId: LANE_ID,
        kind: "commit",
        ts: `2026-08-1${i}T00:00:00.000Z`,
        actor: { kind: "unknown" },
        ref: `clamp-${i}`,
        branchRef: null,
        payload: { sha: `clamp-${i}`, shortSha: `clamp-${i}`, subject: "x" },
      });
    }
    // A limit below the floor is clamped up to 1, not honoured as 0.
    const clamped = await service.list({ laneId: LANE_ID, limit: 0, persistedOnly: true });
    expect(clamped.events).toHaveLength(1);

    // The summary fan-out is capped and deduped.
    const many = await service.summary({ laneIds: [LANE_ID, ` ${LANE_ID} `, ...Array.from({ length: 400 }, (_, i) => `lane-${i}`)] });
    expect(many.summaries).toHaveLength(1);
    service.dispose();
  });

  it("costs one git child per unchanged lane on a repeated read", async () => {
    const git = stubGit([
      { match: (args) => args[0] === "rev-parse", stdout: "head-sha-1\nbase-sha-1\n" },
      { match: (args) => args[0] === "rev-list" && args[1] === "--count", stdout: "1\n" },
      { match: (args) => args[0] === "log", stdout: commitRecord({ sha: "aaa1111", subject: "work" }) },
      { match: (args) => args[0] === "merge-base", stdout: "base000\n" },
      { match: (args) => args[0] === "config", stdout: "Arul Sharma\n" },
    ]);
    const service = makeService({ runGitCommand: git.run });

    await service.list({ laneId: LANE_ID });
    const firstPass = git.calls.length;
    expect(firstPass).toBeGreaterThan(1);

    git.calls.length = 0;
    await service.list({ laneId: LANE_ID });
    // Only the one rev-parse that pins BOTH ends of the range; every other
    // answer is memoized.
    expect(git.calls).toEqual([["rev-parse", "ade/lane-1", "main"]]);
    service.dispose();
  });

  it("summary never shells out for a lane that has persisted rows", async () => {
    const git = stubGit([{ match: (args) => args[0] === "rev-parse", stdout: "head-sha-1\nbase-sha-1\n" }]);
    const service = makeService({ runGitCommand: git.run });
    await service.record({
      laneId: LANE_ID,
      kind: "commit",
      ts: "2026-08-18T10:00:00.000Z",
      actor: { kind: "unknown" },
      ref: "sha-1",
      branchRef: "ade/lane-1",
      payload: { sha: "sha-1", shortSha: "sha-1", subject: "work" },
    });

    const { summaries } = await service.summary({ laneIds: [LANE_ID] });
    expect(summaries[0]!.commitCount).toBe(1);
    expect(git.calls).toEqual([]);
    service.dispose();
  });

  it("notifies subscribers once per debounce window, with every kind seen", async () => {
    vi.useFakeTimers();
    try {
      const service = makeService();
      const seen: Array<{ laneId: string; kinds: string[] }> = [];
      service.onChanged((event) => seen.push({ laneId: event.laneId, kinds: [...event.kinds].sort() }));

      await service.record({
        laneId: LANE_ID,
        kind: "commit",
        ts: "2026-08-18T10:00:00.000Z",
        actor: { kind: "unknown" },
        ref: "sha-a",
        branchRef: null,
        payload: { sha: "sha-a", shortSha: "sha-a", subject: "a" },
      });
      await service.record({
        laneId: LANE_ID,
        kind: "pr_opened",
        ts: "2026-08-18T10:00:01.000Z",
        actor: { kind: "unknown" },
        ref: "pr-a",
        branchRef: null,
        payload: { prId: "pr-a", githubPrNumber: 1 },
      });
      expect(seen).toHaveLength(0);

      vi.advanceTimersByTime(300);
      expect(seen).toEqual([{ laneId: LANE_ID, kinds: ["commit", "pr_opened"] }]);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseCommitLog", () => {
  it("parses fields, trailers and the shortstat that follows a record", () => {
    const stdout =
      commitRecord({ sha: "aaa", subject: "one", trailers: ["Claude <noreply@anthropic.com>"] }) +
      "\n 3 files changed, 12 insertions(+), 4 deletions(-)\n" +
      commitRecord({ sha: "bbb", subject: "two" });
    const commits = parseCommitLog(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: "aaa",
      subject: "one",
      filesChanged: 3,
      insertions: 12,
      deletions: 4,
      coAuthors: ["Claude <noreply@anthropic.com>"],
    });
    expect(commits[1]!.filesChanged).toBeNull();
    expect(commits[1]!.coAuthors).toBeUndefined();
  });

  it("returns nothing for empty output", () => {
    expect(parseCommitLog("")).toEqual([]);
  });
});

describe("pickTailChat", () => {
  const chat = (over: Partial<Parameters<typeof pickTailChat>[0][number]>) => ({
    chatSessionId: "c",
    title: null,
    provider: null,
    model: null,
    startedAt: "2026-08-18T00:00:00.000Z",
    endedAt: null,
    status: "ended" as const,
    statusNote: null,
    lastActivityAt: null,
    ...over,
  });

  it("prefers a chat that is waiting on the user over one that is merely running", () => {
    const picked = pickTailChat([
      chat({ chatSessionId: "running", status: "running" }),
      chat({ chatSessionId: "waiting", status: "awaiting-input" }),
    ]);
    expect(picked?.chatSessionId).toBe("waiting");
  });

  it("falls back to the most recently active chat within a rank", () => {
    const picked = pickTailChat([
      chat({ chatSessionId: "old", status: "ended", lastActivityAt: "2026-08-18T01:00:00.000Z" }),
      chat({ chatSessionId: "new", status: "ended", lastActivityAt: "2026-08-18T05:00:00.000Z" }),
    ]);
    expect(picked?.chatSessionId).toBe("new");
  });

  it("returns null when the lane has no chats", () => {
    expect(pickTailChat([])).toBeNull();
  });
});
