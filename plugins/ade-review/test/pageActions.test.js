"use strict";

/**
 * The page's half of the action table.
 *
 * `page/test/seam.test.tsx` proves the PAGE calls the right ids with the right
 * arguments. This file proves the CHILD answers them — and, more than that, that
 * it answers them in the two shapes the page tier depends on:
 *
 *   * a mutation answers `{ok: false, message}` for anything the review engine
 *     refused, and never rejects, because a rejected promise reaches a page as
 *     an exception beside a form the reader already filled in;
 *   * a read either degrades to a shape with somewhere honest to put the
 *     failure, or rejects — never quietly answers "nothing", which the product
 *     prints as "No review runs yet in this workspace".
 *
 * Together the two files are the seam. Neither half owns them.
 */

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { STARTING_UP, createPageActions, rows, runIdOf } = require("../pageActions");
const { createSdk, sampleRun } = require("./support");

/** Every id `page/src/host/actions.ts` invokes. */
const PAGE_ACTION_IDS = [
  "pageRuns",
  "pageRunDetail",
  "pageLaunchContext",
  "pageSuppressions",
  "pageQualityReport",
  "pageStartRun",
  "pageRerun",
  "pageCancelRun",
  "pageRecordFeedback",
  "pageDeleteSuppression",
];

/** The ids whose answer must be `{ok, message}` rather than a throw. */
const MUTATION_IDS = [
  "pageStartRun",
  "pageRerun",
  "pageCancelRun",
  "pageRecordFeedback",
  "pageDeleteSuppression",
];

/**
 * Field names that would mean a credential reached the page.
 *
 * The webview bridge exposes no `secrets` verb on purpose: a page that could
 * read a token would be a page that could exfiltrate it, and a plugin page is
 * ordinary web content. Nothing this table answers may carry one, including
 * inside a message.
 */
const CREDENTIAL_FIELDS = ["token", "accessToken", "refreshToken", "apiKey", "secret", "password", "clientSecret"];

function assertNoCredentials(value, path = "result") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentials(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(
      !CREDENTIAL_FIELDS.includes(key),
      `${path}.${key} is credential-shaped and must never reach the page`,
    );
    assertNoCredentials(entry, `${path}.${key}`);
  }
}

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

async function activateWith(review = {}, extras = {}) {
  const sdk = createSdk({ review, ...extras });
  await plugin.activate(sdk);
  return sdk;
}

describe("the page action table", () => {
  it("defines every id the page invokes, and shares none with the panel half", async () => {
    for (const id of PAGE_ACTION_IDS) {
      assert.equal(typeof plugin.actions[id], "function", `${id} is missing from exports.actions`);
    }
    const own = Object.keys(plugin.__internals.ownActions);
    const page = Object.keys(plugin.__internals.pageActions);
    assert.deepEqual(page.sort(), [...PAGE_ACTION_IDS].sort());
    const collisions = page.filter((id) => own.includes(id));
    assert.deepEqual(collisions, [], "the two halves must not define the same id");
  });

  it("answers before activate rather than pretending the workspace is empty", async () => {
    // The table is built at LOAD, so a page that opens before the first read
    // resolves finds a real handler. A READ says so by rejecting; a MUTATION
    // says so in the one field a form can draw.
    const table = createPageActions({ get sdk() { return null; } });
    await assert.rejects(() => table.pageRuns({}), /still starting up/);
    await assert.rejects(() => table.pageSuppressions({}), /still starting up/);
    for (const id of MUTATION_IDS) {
      const result = await table[id]({ runId: "run-1", findingId: "f", suppressionId: "s", target: { laneId: "l" } });
      assert.equal(result.ok, false, `${id} must refuse rather than throw`);
      assert.equal(result.message, STARTING_UP);
    }
    // The two degrading reads keep degrading here too.
    assert.equal(await table.pageQualityReport(), null);
    assert.equal((await table.pageLaunchContext()).message, STARTING_UP);
  });
});

describe("the reads", () => {
  it("pageRuns passes the compiled tab's own limit and reads both answer shapes", async () => {
    const calls = [];
    await activateWith({
      listRuns: async (args) => {
        calls.push(args);
        return calls.length === 1 ? [sampleRun()] : { runs: [sampleRun({ id: "run-2" })] };
      },
    });

    const bare = await plugin.actions.pageRuns({ limit: 500 });
    assert.equal(bare.length, 1);
    // Clamped to the ceiling rather than passed through: the page asked for more
    // than the engine will page, and 500 rows is not what the browser draws.
    assert.deepEqual(calls.at(-1), { laneId: undefined, status: "all", limit: 120 });

    const enveloped = await plugin.actions.pageRuns({ status: "running", laneId: "lane-1" });
    assert.equal(enveloped[0].id, "run-2");
    assert.deepEqual(calls.at(-1), { laneId: "lane-1", status: "running", limit: 120 });
  });

  it("pageRuns rejects rather than answering an empty list", async () => {
    // An empty list is what the browser prints as "No review runs yet in this
    // workspace". Answering one for a failed read tells the reader their
    // reviews are gone.
    await activateWith({
      listRuns: async () => {
        throw new Error("The review store is locked.");
      },
    });
    await assert.rejects(() => plugin.actions.pageRuns({}), /locked/);
  });

  it("pageRunDetail forwards the run id and passes the engine's own null through", async () => {
    const calls = [];
    await activateWith({
      getRunDetail: async (args) => {
        calls.push(args);
        return args.runId === "run-1" ? sampleRun() : null;
      },
    });
    assert.equal((await plugin.actions.pageRunDetail({ runId: "run-1" })).id, "run-1");
    assert.equal(await plugin.actions.pageRunDetail({ runId: "nope" }), null);
    assert.deepEqual(calls, [{ runId: "run-1" }, { runId: "nope" }]);
    // The plugin's own bug, not the engine's: a throw is right here.
    await assert.rejects(() => plugin.actions.pageRunDetail({}), /needs a runId/);
  });

  it("pageLaunchContext joins each lane's worktree onto the engine's answer", async () => {
    // The compiled page read `lane.worktreePath` from the app store. A guest has
    // no store, so this join is the only way `ui.openPathInEditor` can be given
    // a root.
    await activateWith(
      {
        listLaunchContext: async () => ({
          defaultLaneId: "lane-1",
          defaultBranchName: "main",
          lanes: [
            { id: "lane-1", name: "fix-login", laneType: "work", branchRef: "refs/heads/fix-login", baseRef: "refs/heads/main", color: null },
            { id: "lane-2", name: "remote-only", laneType: "work", branchRef: "refs/heads/x", baseRef: "refs/heads/main", color: null },
          ],
          recentCommitsByLane: { "lane-1": [] },
          recommendedModelId: "openai/gpt-5.6-sol",
        }),
      },
      {
        lanes: {
          list: async () => [
            { id: "lane-1", path: "/repo/.ade/worktrees/fix-login", name: "fix-login" },
            { id: "lane-2", path: null, name: "remote-only" },
          ],
        },
      },
    );

    const context = await plugin.actions.pageLaunchContext();
    assert.equal(context.lanes[0].path, "/repo/.ade/worktrees/fix-login");
    // Null rather than absent: "no local checkout" and "an older host reported
    // nothing" have to be told apart by the page.
    assert.equal(context.lanes[1].path, null);
    assert.equal(context.message, null);
    // An allowlist, not a spread: nothing the launch form has no use for rides
    // along on the wire.
    assert.deepEqual(
      Object.keys(context.lanes[0]).sort(),
      ["baseRef", "branchRef", "color", "id", "laneType", "name", "path"],
    );
  });

  it("pageLaunchContext degrades with a sentence the form can print", async () => {
    await activateWith({
      listLaunchContext: async () => {
        throw new Error("This project has no git remote.");
      },
    });
    const context = await plugin.actions.pageLaunchContext();
    assert.deepEqual(context.lanes, []);
    assert.match(context.message, /no git remote/);
  });

  it("pageLaunchContext survives a host with no lanes verb at all", async () => {
    await activateWith(
      { listLaunchContext: async () => ({ lanes: [{ id: "lane-1", name: "fix-login" }], recentCommitsByLane: {} }) },
      { lanes: undefined },
    );
    const context = await plugin.actions.pageLaunchContext();
    assert.equal(context.lanes[0].path, null);
    assert.equal(context.message, null);
  });

  it("pageSuppressions rejects rather than answering an empty list", async () => {
    await activateWith({
      listSuppressions: async () => {
        throw new Error("nope");
      },
    });
    await assert.rejects(() => plugin.actions.pageSuppressions({}), /nope/);
  });

  it("pageSuppressions clamps its page and reads both answer shapes", async () => {
    const calls = [];
    await activateWith({
      listSuppressions: async (args) => {
        calls.push(args);
        return { suppressions: [{ id: "sup-1", scope: "repo" }] };
      },
    });
    const list = await plugin.actions.pageSuppressions({ limit: 9_000 });
    assert.equal(list[0].id, "sup-1");
    assert.deepEqual(calls.at(-1), { limit: 100 });
  });

  it("pageQualityReport degrades to null, which the panel draws as an em-dash", async () => {
    await activateWith({
      qualityReport: async () => {
        throw new Error("no report");
      },
    });
    assert.equal(await plugin.actions.pageQualityReport(), null);
  });
});

describe("the mutations answer {ok, message} rather than throwing", () => {
  it("pageStartRun forwards the compiled target/config pair and answers a run id", async () => {
    const calls = [];
    await activateWith({
      listRuns: async () => [sampleRun()],
      getRunDetail: async () => sampleRun(),
      startRun: async (args) => {
        calls.push(args);
        return { runId: "run-9" };
      },
    });

    const target = { mode: "lane_diff", laneId: "lane-1" };
    const config = { compareAgainst: { kind: "default_branch" }, modelId: "m", publishBehavior: "local_only" };
    const result = await plugin.actions.pageStartRun({ target, config });

    assert.deepEqual(result, { ok: true, message: "Review started.", runId: "run-9" });
    assert.deepEqual(calls[0], { target, config });
  });

  it("pageStartRun refuses a launch with no lane, and a PR with no id", async () => {
    const calls = [];
    await activateWith({ startRun: async (args) => { calls.push(args); return { runId: "x" }; } });

    const noLane = await plugin.actions.pageStartRun({ target: { mode: "lane_diff" }, config: {} });
    assert.equal(noLane.ok, false);
    assert.match(noLane.message, /Choose a lane/);

    const noPr = await plugin.actions.pageStartRun({ target: { mode: "pr", laneId: "lane-1" }, config: {} });
    assert.equal(noPr.ok, false);
    assert.match(noPr.message, /not linked in ADE/);

    assert.equal(calls.length, 0, "nothing reaches the engine on a refused launch");
  });

  it("pageStartRun turns the engine's refusal into a sentence, not an exception", async () => {
    await activateWith({
      startRun: async () => {
        throw new Error("That lane has no worktree on this machine.");
      },
    });
    const result = await plugin.actions.pageStartRun({
      target: { mode: "lane_diff", laneId: "lane-1" },
      config: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /no worktree/);
  });

  it("pageStartRun refuses a launch that answered no run id", async () => {
    await activateWith({ startRun: async () => ({}) });
    const result = await plugin.actions.pageStartRun({
      target: { mode: "working_tree", laneId: "lane-1" },
      config: {},
    });
    assert.deepEqual(result, { ok: false, message: "Review launch did not return a run id." });
  });

  it("pageRerun answers the new run id, and refuses without one", async () => {
    await activateWith({
      listRuns: async () => [sampleRun()],
      getRunDetail: async () => sampleRun(),
      rerun: async () => "run-7",
    });
    assert.deepEqual(await plugin.actions.pageRerun({ runId: "run-1" }), {
      ok: true,
      message: "Rerun started.",
      runId: "run-7",
    });
    const missing = await plugin.actions.pageRerun({});
    assert.deepEqual(missing, { ok: false, message: "Pick a run to rerun." });
  });

  it("pageRerun turns a refusal into a sentence", async () => {
    await activateWith({
      rerun: async () => {
        throw new Error("That run's target is gone.");
      },
    });
    const result = await plugin.actions.pageRerun({ runId: "run-1" });
    assert.equal(result.ok, false);
    assert.match(result.message, /target is gone/);
  });

  it("pageCancelRun refuses without a run, and answers a sentence on failure", async () => {
    await activateWith({
      listRuns: async () => [sampleRun()],
      cancelRun: async () => {
        throw new Error("Already finished.");
      },
    });
    assert.deepEqual(await plugin.actions.pageCancelRun({}), { ok: false, message: "Pick a run to cancel." });
    const failed = await plugin.actions.pageCancelRun({ runId: "run-1" });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /Already finished/);
  });

  it("pageCancelRun answers ok when the engine took it", async () => {
    await activateWith({ listRuns: async () => [sampleRun()], cancelRun: async () => ({ id: "run-1" }) });
    assert.deepEqual(await plugin.actions.pageCancelRun({ runId: "run-1" }), { ok: true, message: "Cancelled." });
  });

  it("pageRecordFeedback forwards each of the four verbs unchanged", async () => {
    const calls = [];
    await activateWith({
      listRuns: async () => [sampleRun()],
      getRunDetail: async () => sampleRun(),
      recordFeedback: async (args) => {
        calls.push(args);
        return args;
      },
    });

    assert.deepEqual(await plugin.actions.pageRecordFeedback({ findingId: "find-1", kind: "acknowledge" }), {
      ok: true,
      message: "Saved.",
    });
    await plugin.actions.pageRecordFeedback({ findingId: "find-1", kind: "dismiss", reason: "not_a_bug" });
    await plugin.actions.pageRecordFeedback({ findingId: "find-1", kind: "snooze", snoozeDurationMs: 604800000 });
    await plugin.actions.pageRecordFeedback({
      findingId: "find-1",
      kind: "suppress",
      suppression: { scope: "path", pathPattern: "src/auth.ts" },
    });

    assert.deepEqual(calls.map((call) => call.kind), ["acknowledge", "dismiss", "snooze", "suppress"]);
    assert.equal(calls[1].reason, "not_a_bug");
    assert.equal(calls[2].snoozeDurationMs, 604800000);
    assert.deepEqual(calls[3].suppression, { scope: "path", pathPattern: "src/auth.ts" });
  });

  it("pageRecordFeedback refuses an unknown scope rather than widening it", async () => {
    // The same rule the agent tool and the panel button get, through the same
    // reader: silencing MORE than the caller asked is the one wrong answer that
    // leaves no trace.
    const calls = [];
    await activateWith({ recordFeedback: async (args) => { calls.push(args); return args; } });
    const result = await plugin.actions.pageRecordFeedback({
      findingId: "find-1",
      kind: "suppress",
      suppressionScope: "everything",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /repo, path, or global/);
    assert.equal(calls.length, 0, "nothing reaches the engine on a refused scope");
  });

  it("pageRecordFeedback refuses without a finding, and answers a sentence on failure", async () => {
    await activateWith({
      recordFeedback: async () => {
        throw new Error("That finding belongs to another project.");
      },
    });
    assert.deepEqual(await plugin.actions.pageRecordFeedback({ kind: "acknowledge" }), {
      ok: false,
      message: "Pick a finding.",
    });
    const failed = await plugin.actions.pageRecordFeedback({ findingId: "find-1", kind: "acknowledge" });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /another project/);
  });

  it("pageDeleteSuppression refuses without an id, and answers a sentence on failure", async () => {
    await activateWith({
      deleteSuppression: async () => {
        throw new Error("Already removed.");
      },
    });
    assert.deepEqual(await plugin.actions.pageDeleteSuppression({}), {
      ok: false,
      message: "Pick a suppression to remove.",
    });
    const failed = await plugin.actions.pageDeleteSuppression({ suppressionId: "sup-1" });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /Already removed/);
  });

  it("pageDeleteSuppression answers ok when the engine took it", async () => {
    await activateWith({ deleteSuppression: async () => true });
    assert.deepEqual(await plugin.actions.pageDeleteSuppression({ suppressionId: "sup-1" }), {
      ok: true,
      message: "Removed.",
    });
  });
});

describe("nothing the page can read is a credential", () => {
  it("walks every handler's answer", async () => {
    await activateWith({
      listRuns: async () => [sampleRun()],
      getRunDetail: async () => sampleRun(),
      listLaunchContext: async () => ({ lanes: [{ id: "lane-1", name: "fix-login" }], recentCommitsByLane: {} }),
      listSuppressions: async () => [{ id: "sup-1", scope: "repo", title: "x" }],
      qualityReport: async () => ({ totalRuns: 1, totalFindings: 0 }),
      startRun: async () => ({ runId: "run-9" }),
      rerun: async () => ({ runId: "run-9" }),
      cancelRun: async () => ({}),
      recordFeedback: async (args) => args,
      deleteSuppression: async () => true,
    });

    const answers = await Promise.all([
      plugin.actions.pageRuns({}),
      plugin.actions.pageRunDetail({ runId: "run-1" }),
      plugin.actions.pageLaunchContext(),
      plugin.actions.pageSuppressions({}),
      plugin.actions.pageQualityReport(),
      plugin.actions.pageStartRun({ target: { mode: "lane_diff", laneId: "lane-1" }, config: {} }),
      plugin.actions.pageRerun({ runId: "run-1" }),
      plugin.actions.pageCancelRun({ runId: "run-1" }),
      plugin.actions.pageRecordFeedback({ findingId: "find-1", kind: "acknowledge" }),
      plugin.actions.pageDeleteSuppression({ suppressionId: "sup-1" }),
    ]);
    for (const answer of answers) assertNoCredentials(answer);
  });
});

describe("the shape readers", () => {
  it("reads a list out of either answer shape", () => {
    assert.deepEqual(rows([1, 2], "runs"), [1, 2]);
    assert.deepEqual(rows({ runs: [3] }, "runs"), [3]);
    assert.deepEqual(rows({ other: [3] }, "runs"), []);
    assert.deepEqual(rows(null, "runs"), []);
  });

  it("reads a run id out of every shape startRun has answered", () => {
    assert.equal(runIdOf("run-1"), "run-1");
    assert.equal(runIdOf({ runId: "run-2" }), "run-2");
    assert.equal(runIdOf({ id: "run-3" }), "run-3");
    assert.equal(runIdOf({}), null);
    assert.equal(runIdOf(null), null);
  });
});
