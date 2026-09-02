"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  branchFromRun,
  chatStateForRunStatus,
  createChatRuntime,
  detailForRunStatus,
  hydrateTranscript,
  isLiveRunStatus,
} = require("../runtime");
const { MIRROR_BACKOFF_MS, nextMirrorDelay, parseEventStream, conversationFromStreamMessages, transcriptFromTurns, statusFromStreamMessages } = require("../conversation");

/* ── Fakes ───────────────────────────────────────────────────────────────── */

/** A `chat` half that records every write, so a test reads what the user would. */
function fakeHost(options = {}) {
  const calls = [];
  const record = (name) => async (...args) => {
    calls.push({ name, args });
    if (name === "hydrate") {
      const entries = args[1] ?? [];
      return options.hydrateResult?.(entries, args[2]) ?? { accepted: entries.length, skipped: 0, sweepTotal: entries.length };
    }
    if (name === "createSession") {
      return { sessionId: options.sessionId ?? "s-1", runtimeId: args[0].runtimeId, externalId: args[0].externalId, created: true };
    }
    return undefined;
  };
  const timers = [];
  return {
    calls,
    timers,
    of: (name) => calls.filter((call) => call.name === name),
    chat: {
      createSession: record("createSession"),
      appendAssistant: record("appendAssistant"),
      appendUser: record("appendUser"),
      emitStatus: record("emitStatus"),
      setArtifacts: record("setArtifacts"),
      attachBranch: record("attachBranch"),
      hydrate: record("hydrate"),
    },
    automations: { emitTrigger: record("emitTrigger") },
    webhooks: { ack: record("ack") },
    // Timers are collected rather than run, so a ladder is inspectable and no
    // test ever waits three seconds for one.
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: (handle) => {
      if (handle) timers[handle - 1] = null;
    },
  };
}

function fakeLinks(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (agentId) => store.get(agentId) ?? null,
    set: async (agentId, value) => { store.set(agentId, value); },
    list: async () => [...store.values()],
  };
}

function fakeDeliveries() {
  const seen = new Set();
  return { seen, has: async (id) => seen.has(id), add: async (id) => { seen.add(id); } };
}

/** An SSE body, exactly as `GET /v1/agents/:id/runs/:id/stream` answers. */
function sseBody(messages) {
  return messages
    .map((message, index) => `id: e${index}\ndata: ${JSON.stringify(message)}\n\n`)
    .join("") + "data: [DONE]\n\n";
}

function fakeApi(overrides = {}) {
  return {
    getAgent: async () => ({ id: "a1", latestRunId: "r1" }),
    getRun: async () => ({ id: "r1", status: "FINISHED" }),
    createRun: async () => ({ run: { id: "r2", status: "CREATING" } }),
    cancelRun: async () => ({ id: "r1" }),
    listArtifacts: async () => ({ items: [] }),
    getArtifactDownloadUrl: async () => ({ url: "" }),
    streamRun: async () => ({ text: async () => sseBody([]) }),
    ...overrides,
  };
}

function runtimeWith(overrides = {}) {
  const host = overrides.host ?? fakeHost();
  const links = overrides.links ?? fakeLinks();
  const deliveries = overrides.deliveries ?? fakeDeliveries();
  const api = overrides.api ?? fakeApi();
  return { host, links, deliveries, api, runtime: createChatRuntime({ api, host, links, deliveries }) };
}

/* ── Status mapping ──────────────────────────────────────────────────────── */

describe("Cursor's run status as an ADE chat status", () => {
  it("maps every status Cursor can report", () => {
    assert.equal(chatStateForRunStatus("CREATING"), "running");
    assert.equal(chatStateForRunStatus("RUNNING"), "running");
    assert.equal(chatStateForRunStatus("FINISHED"), "finished");
    assert.equal(chatStateForRunStatus("ERROR"), "failed");
    assert.equal(chatStateForRunStatus("EXPIRED"), "failed");
    assert.equal(chatStateForRunStatus("something new"), null);
  });

  it("settles a cancelled run rather than marking the turn failed", () => {
    // The user pressed stop. That is a completed intention, and an error banner
    // in front of somebody who got what they asked for is a bug.
    assert.equal(chatStateForRunStatus("CANCELLED"), "idle");
    assert.match(detailForRunStatus("CANCELLED"), /stopped/);
  });

  it("knows which statuses still owe output", () => {
    assert.equal(isLiveRunStatus("RUNNING"), true);
    assert.equal(isLiveRunStatus("FINISHED"), false);
    assert.equal(isLiveRunStatus("CANCELLED"), false);
  });
});

/* ── The stream ──────────────────────────────────────────────────────────── */

describe("reading a run's event stream", () => {
  it("folds user, assistant, thinking and shell into turns", () => {
    const messages = [
      { type: "user", message: { content: [{ type: "text", text: "fix the test" }] } },
      { type: "thinking", text: "looking at the failure" },
      { type: "assistant", message: { content: [{ type: "text", text: "Found it." }] } },
      { type: "tool_call", name: "shell", args: { command: "npm test" }, result: { stdout: "ok", stderr: "", exitCode: 0 } },
      { type: "status", status: "FINISHED" },
    ];
    const turns = conversationFromStreamMessages(messages);
    const transcript = transcriptFromTurns(turns);

    assert.equal(statusFromStreamMessages(messages), "FINISHED");
    assert.deepEqual(transcript[0], { role: "user", text: "fix the test", fingerprint: "user:fix the test" });
    assert.equal(transcript[1].role, "assistant");
    assert.deepEqual(transcript[1].parts.map((part) => part.kind), ["thinking", "text"]);
    assert.equal(transcript[1].fingerprint, "text:Found it.");
    assert.deepEqual(transcript[2].parts, [{ kind: "tool", name: "shell", detail: "npm test" }]);
  });

  it("drops one unreadable frame rather than the whole transcript", () => {
    const body = 'id: e0\ndata: {"type":"user"\n\nid: e1\ndata: {"type":"thinking","text":"ok"}\n\n';
    const events = parseEventStream(body);
    assert.equal(events.length, 1);
    assert.equal(events[0].message.text, "ok");
  });

  it("ignores the [DONE] sentinel", () => {
    assert.equal(parseEventStream(sseBody([])).length, 0);
  });
});

/* ── Hydrate ─────────────────────────────────────────────────────────────── */

describe("backfilling a long conversation", () => {
  it("pages at 500, oldest first, appending after the first page", async () => {
    const host = fakeHost();
    const entries = Array.from({ length: 1_100 }, (_, i) => ({ role: "user", text: `m${i}` }));

    await hydrateTranscript(host, "s-1", entries);

    const pages = host.of("hydrate");
    assert.equal(pages.length, 3);
    assert.equal(pages[0].args[1].length, 500);
    assert.equal(pages[0].args[2], undefined, "the first page starts a sweep");
    assert.deepEqual(pages[1].args[2], { append: true });
    assert.equal(pages[2].args[1].length, 100);
    assert.equal(pages[0].args[1][0].text, "m0", "oldest first");
  });

  it("stops when ADE already holds that far back", async () => {
    const host = fakeHost({ hydrateResult: (entries) => ({ accepted: 0, skipped: entries.length, sweepTotal: 0 }) });
    await hydrateTranscript(host, "s-1", Array.from({ length: 1_100 }, (_, i) => ({ role: "user", text: `m${i}` })));
    assert.equal(host.of("hydrate").length, 1, "a fully skipped page ends the sweep");
  });

  it("keeps paging through an empty page, which is not a full transcript", async () => {
    const host = fakeHost({ hydrateResult: () => ({ accepted: 0, skipped: 0, sweepTotal: 0 }) });
    await hydrateTranscript(host, "s-1", Array.from({ length: 600 }, (_, i) => ({ role: "user", text: `m${i}` })));
    assert.equal(host.of("hydrate").length, 2);
  });
});

/* ── Adopting an agent ───────────────────────────────────────────────────── */

describe("opening a cloud agent as a chat", () => {
  it("binds the session, records the link and backfills the history", async () => {
    const { runtime, host, links } = runtimeWith({
      api: fakeApi({
        streamRun: async () => ({
          text: async () => sseBody([
            { type: "user", message: { content: [{ type: "text", text: "fix it" }] } },
            { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
            { type: "status", status: "FINISHED" },
          ]),
        }),
      }),
    });

    const ref = await runtime.openAgent({ agentId: "a1", laneId: "lane-1", title: "Fix it" });

    assert.equal(ref.sessionId, "s-1");
    const created = host.of("createSession")[0].args[0];
    assert.equal(created.runtimeId, "cloud-agent", "the manifest's declared runtime id");
    assert.equal(created.externalId, "a1");
    assert.equal(created.laneId, "lane-1");

    assert.deepEqual(await links.get("a1"), {
      agentId: "a1",
      sessionId: "s-1",
      laneId: "lane-1",
      title: "Fix it",
      openedAt: (await links.get("a1")).openedAt,
    });
    assert.equal(host.of("hydrate").length, 1);
    assert.equal(host.of("emitStatus")[0].args[1].state, "finished");
  });

  it("binds the session even when the agent has never run", async () => {
    const { runtime, host } = runtimeWith({ api: fakeApi({ getAgent: async () => ({ id: "a1" }) }) });
    await runtime.openAgent({ agentId: "a1", laneId: "lane-1" });
    assert.equal(host.of("createSession").length, 1);
    assert.equal(host.of("hydrate").length, 0, "nothing to backfill is not an error");
  });
});

/* ── A turn ──────────────────────────────────────────────────────────────── */

describe("the user types into a cloud chat", () => {
  it("dispatches a follow-up run and returns without waiting for the answer", async () => {
    const created = [];
    const { runtime, host } = runtimeWith({
      api: fakeApi({
        createRun: async (agentId, body) => {
          created.push({ agentId, body });
          return { run: { id: "r2", status: "CREATING" } };
        },
      }),
    });

    const result = await runtime.handleTurn({
      sessionId: "s-1",
      externalId: "a1",
      message: "also fix the lint",
      turnId: "t-1",
      event: "chat.turn",
    });

    assert.equal(result.runId, "r2");
    assert.deepEqual(created, [{ agentId: "a1", body: { prompt: { text: "also fix the lint" } } }]);
    // Running is reported BEFORE the API call, so the composer settles the
    // moment the user presses send rather than a network round trip later.
    assert.deepEqual(host.of("emitStatus")[0].args[1], { state: "running", turnId: "t-1" });
    // Somebody just typed into this chat, so the ladder is on it.
    assert.deepEqual(runtime.watchedSessionIds(), ["s-1"]);
  });

  it("fails the turn visibly when Cursor refuses it", async () => {
    const { runtime, host } = runtimeWith({
      api: fakeApi({ createRun: async () => { throw new Error("agent is archived"); } }),
    });

    await assert.rejects(() => runtime.handleTurn({
      sessionId: "s-1", externalId: "a1", message: "go", turnId: "t-1", event: "chat.turn",
    }));

    const failed = host.of("emitStatus").at(-1).args[1];
    assert.equal(failed.state, "failed");
    assert.equal(failed.turnId, "t-1");
    assert.match(failed.detail, /archived/);
  });

  it("stops the run and settles the turn on interrupt", async () => {
    const cancelled = [];
    const { runtime, host } = runtimeWith({
      api: fakeApi({ cancelRun: async (agentId, runId) => { cancelled.push([agentId, runId]); } }),
    });

    await runtime.handleInterrupt({ sessionId: "s-1", externalId: "a1", turnId: "t-1", event: "chat.interrupt" });

    assert.deepEqual(cancelled, [["a1", "r1"]]);
    assert.equal(host.of("emitStatus").at(-1).args[1].state, "idle");
  });
});

/* ── Presence ────────────────────────────────────────────────────────────── */

describe("polling follows attention", () => {
  it("starts a ladder at its floor when a chat opens", () => {
    const { runtime, host } = runtimeWith();
    runtime.startLadder({ sessionId: "s-1", externalId: "a1" });
    assert.deepEqual(runtime.watchedSessionIds(), ["s-1"]);
    assert.equal(host.timers.at(-1).ms, MIRROR_BACKOFF_MS[0]);
  });

  it("does not open a second timer for a chat it is already watching", () => {
    const { runtime, host } = runtimeWith();
    runtime.startLadder({ sessionId: "s-1", externalId: "a1" });
    runtime.startLadder({ sessionId: "s-1", externalId: "a1" });
    assert.equal(host.timers.filter(Boolean).length, 1);
  });

  it("stops polling entirely when the chat closes", () => {
    const { runtime, host } = runtimeWith();
    runtime.startLadder({ sessionId: "s-1", externalId: "a1" });
    runtime.stopLadder({ sessionId: "s-1" });
    assert.deepEqual(runtime.watchedSessionIds(), []);
    assert.deepEqual(host.timers, [null]);
  });

  it("steps the ladder out when nothing changed and resets when it did", () => {
    assert.equal(nextMirrorDelay(3_000, "unchanged"), 8_000);
    assert.equal(nextMirrorDelay(8_000, "unchanged"), 20_000);
    assert.equal(nextMirrorDelay(45_000, "unchanged"), 45_000);
    assert.equal(nextMirrorDelay(45_000, "new"), 3_000);
    // A poll that never ran must not spend a rung.
    assert.equal(nextMirrorDelay(20_000, "skipped"), 20_000);
  });

  it("writes new turns and attaches the branch when a run finishes", async () => {
    const { runtime, host } = runtimeWith({
      api: fakeApi({
        streamRun: async () => ({
          text: async () => sseBody([
            { type: "assistant", message: { content: [{ type: "text", text: "pushed" }] } },
            { type: "status", status: "FINISHED" },
          ]),
        }),
        getRun: async () => ({
          id: "r1",
          status: "FINISHED",
          git: { branches: [{ repoUrl: "https://github.com/acme/app", branch: "cursor/fix-1" }] },
        }),
        listArtifacts: async () => ({ items: [{ path: "/report.md", sizeBytes: 12 }] }),
      }),
    });

    assert.equal(await runtime.poll("s-1", "a1"), "new");

    assert.equal(host.of("emitStatus").at(-1).args[1].state, "finished");
    assert.deepEqual(host.of("attachBranch")[0].args[1], { branch: "cursor/fix-1" });
    // An absolute path is refused by the host, so it is made lane-relative here.
    assert.deepEqual(host.of("setArtifacts")[0].args[1], [{ path: "report.md", bytes: 12 }]);
  });

  it("hands the host the signed download URL so the file can land in the lane", async () => {
    const { runtime, host } = runtimeWith({
      api: fakeApi({
        streamRun: async () => ({
          text: async () => sseBody([
            { type: "assistant", message: { content: [{ type: "text", text: "pushed" }] } },
            { type: "status", status: "FINISHED" },
          ]),
        }),
        getRun: async () => ({
          id: "r1",
          status: "FINISHED",
          git: { branches: [{ repoUrl: "https://github.com/acme/app", branch: "cursor/fix-1" }] },
        }),
        listArtifacts: async () => ({ items: [{ path: "/report.md", sizeBytes: 12 }] }),
        getArtifactDownloadUrl: async () => ({ url: "https://files.cursor.com/report.md", expiresAt: "2099-01-01T00:00:00.000Z" }),
      }),
    });

    await runtime.poll("s-1", "a1");
    assert.deepEqual(host.of("setArtifacts")[0].args[1], [{
      path: "report.md",
      bytes: 12,
      sourceUrl: "https://files.cursor.com/report.md",
    }]);
  });

  it("does not attach a branch for a run that is still going", async () => {
    const { runtime, host } = runtimeWith({
      api: fakeApi({
        streamRun: async () => ({ text: async () => sseBody([{ type: "status", status: "RUNNING" }]) }),
      }),
    });
    await runtime.poll("s-1", "a1");
    assert.equal(host.of("attachBranch").length, 0);
  });

  it("skips rather than stepping the ladder when the agent has no run yet", async () => {
    const { runtime } = runtimeWith({ api: fakeApi({ getAgent: async () => ({ id: "a1" }) }) });
    assert.equal(await runtime.poll("s-1", "a1"), "skipped");
  });

  it("reads a branch out of either shape Cursor answers with", () => {
    assert.equal(branchFromRun({ git: { branches: [{ branch: "a" }] } }), "a");
    assert.equal(branchFromRun({ git: { branch: "b" } }), "b");
    assert.equal(branchFromRun({}), null);
  });
});

/* ── Webhooks ────────────────────────────────────────────────────────────── */

describe("a Cursor status webhook", () => {
  const delivery = (over = {}) => ({
    event: "webhook.received",
    id: "d-1",
    channel: "cursor",
    eventType: "statusChange",
    receivedAt: "2026-08-26T10:00:00.000Z",
    headers: {},
    attempt: 1,
    body: JSON.stringify({ id: "a1", status: "FINISHED" }),
    ...over,
  });

  it("wakes the sleeping chat, fires the trigger, then acks", async () => {
    const links = fakeLinks({ a1: { agentId: "a1", sessionId: "s-1", laneId: "lane-1" } });
    const { runtime, host } = runtimeWith({
      links,
      api: fakeApi({
        getAgent: async () => ({ id: "a1", name: "Fix the flaky sync test", latestRunId: "r1" }),
        getRun: async () => ({
          id: "r1",
          status: "FINISHED",
          git: { branches: [{ repoUrl: "https://github.com/acme/app", branch: "cursor/fix-1" }] },
        }),
        streamRun: async () => ({ text: async () => sseBody([{ type: "status", status: "FINISHED" }]) }),
      }),
    });

    const result = await runtime.handleWebhook(delivery());

    assert.equal(result.triggerId, "cloud_finished");
    assert.equal(result.sessionId, "s-1");
    const trigger = host.of("emitTrigger")[0].args[0];
    assert.equal(trigger.triggerId, "cloud_finished");
    assert.deepEqual(trigger.payload, {
      agentId: "a1",
      status: "FINISHED",
      // Read from Cursor, not from the post: a rule templating
      // `{{trigger.branch}}` would otherwise render an empty PR title.
      summary: "Fix the flaky sync test",
      branch: "cursor/fix-1",
      runId: "r1",
      sessionId: "s-1",
      laneId: "lane-1",
    });
    assert.deepEqual(host.of("ack")[0].args, ["d-1"]);
    // The ack is LAST: a crash before it replays a delivery that does nothing,
    // where a crash after it would lose a run's ending forever.
    assert.equal(host.calls.at(-1).name, "ack");
  });

  it("fires cloud_error on a failure and nothing on a status nobody built a rule for", async () => {
    const { runtime, host } = runtimeWith();
    assert.equal((await runtime.handleWebhook(delivery({ body: JSON.stringify({ id: "a1", status: "ERROR" }) }))).triggerId, "cloud_error");
    assert.equal((await runtime.handleWebhook(delivery({ id: "d-2", body: JSON.stringify({ id: "a1", status: "RUNNING" }) }))).triggerId, null);
    // A rule that fired on RUNNING would fire on every poll of every agent.
    assert.equal(host.of("emitTrigger").length, 1);
  });

  it("acks a redelivery without firing the automation twice", async () => {
    const { runtime, host } = runtimeWith();

    await runtime.handleWebhook(delivery());
    const again = await runtime.handleWebhook(delivery({ attempt: 2 }));

    assert.equal(again.duplicate, true);
    assert.equal(host.of("emitTrigger").length, 1, "a lost ack must not run the automation twice");
    assert.equal(host.of("ack").length, 2, "but it must still be acked");
  });

  it("acks a body it cannot read rather than leaving the queue stuck", async () => {
    const { runtime, host } = runtimeWith();
    const result = await runtime.handleWebhook(delivery({ body: "not json" }));
    assert.equal(result.unreadable, true);
    assert.equal(host.of("ack").length, 1);
    assert.equal(host.of("emitTrigger").length, 0);
  });

  it("acks a body with no agent id, which nothing could ever act on", async () => {
    const { runtime, host } = runtimeWith();
    assert.equal((await runtime.handleWebhook(delivery({ body: JSON.stringify({ status: "FINISHED" }) }))).unreadable, true);
    assert.equal(host.of("ack").length, 1);
  });

  it("still fires the trigger for an agent no chat here owns", async () => {
    const { runtime, host } = runtimeWith();
    const result = await runtime.handleWebhook(delivery());
    assert.equal(result.sessionId, null);
    assert.equal(host.of("emitTrigger").length, 1);
    assert.equal(host.of("emitStatus").length, 0, "there is no session to report a status on");
  });
});
