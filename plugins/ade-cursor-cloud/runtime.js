// The chat runtime: a Cursor Cloud agent AS an ADE conversation.
//
// Ported from `apps/desktop/src/main/services/chat/agentChatService.ts` —
// `runCursorCloudTurn` (:38144), `attachAndHydrateCursorCloudChat` (:38915),
// `handleCursorCloudStatusChange` (:38525) and `refreshWatchedCursorCloudMirror`
// (:39073) — onto the `ade.chat.*` seam.
//
// Every dependency is injected. `api` is the Cursor client, `host` is the thin
// slice of the SDK this module touches, and `now` is a clock. Nothing here
// opens a socket or reads a global, so the whole runtime is testable against a
// fake host and a fake API with no network at all.
//
// Four shapes worth knowing before reading further:
//
//   1. **A turn returns when it is DISPATCHED, not when it is answered.** The
//      host's reliable-delivery budget is not a place to sit for twenty
//      minutes; the reply comes back through `appendAssistant` from the mirror.
//   2. **Polling is presence-gated.** `chat.opened` starts the backoff ladder
//      and `chat.closed` stops it, so a chat nobody is looking at costs nothing
//      — which is the whole reason ADE reads Cursor at all rather than waiting
//      for a webhook that only fires at the end.
//   3. **A webhook wakes a sleeping session.** The ladder is off when nobody is
//      watching, so `FINISHED` arrives by relay, not by poll.
//   4. **Every write is deduped by fingerprint.** The same reply can reach a
//      session from the mirror and from a hydrate, and the host's own
//      suffix-tolerant matching is what stops it landing twice.

"use strict";

const {
  MIRROR_BACKOFF_MS,
  conversationFromStreamMessages,
  nextMirrorDelay,
  readEventStream,
  statusFromStreamMessages,
  transcriptFromTurns,
} = require("./conversation");
const { normalizeRunStatus } = require("./format");

/** One `chat.hydrate` call's ceiling, from `PLUGIN_CHAT_HYDRATE_MAX_ENTRIES`. */
const HYDRATE_PAGE = 500;

/** This plugin's one declared chat runtime, as the manifest spells it. */
const RUNTIME_ID = "cloud-agent";

/**
 * Cursor's run status as the four states ADE's settled lifecycle understands.
 *
 * `cancelled` is `idle`, not `failed`: the user stopping an agent is a
 * completed intention, and marking the turn failed would put an error in front
 * of somebody who got exactly what they asked for. `expired` IS a failure —
 * nobody asked for it and the work is gone.
 */
function chatStateForRunStatus(status) {
  switch (normalizeRunStatus(status)) {
    case "creating":
    case "running":
      return "running";
    case "finished":
      return "finished";
    case "error":
    case "expired":
      return "failed";
    case "cancelled":
      return "idle";
    default:
      return null;
  }
}

/** The one sentence a client shows beside a terminal state. */
function detailForRunStatus(status) {
  switch (normalizeRunStatus(status)) {
    case "finished":
      return "The cloud run finished.";
    case "error":
      return "The cloud run failed.";
    case "expired":
      return "The cloud run expired before it finished.";
    case "cancelled":
      return "The cloud run was stopped.";
    default:
      return undefined;
  }
}

/** True while Cursor still owes this run more output. */
function isLiveRunStatus(status) {
  const state = chatStateForRunStatus(status);
  return state === "running";
}

/**
 * Backfill a conversation, oldest page first.
 *
 * Stops on `accepted === 0 && skipped > 0` — the documented reading of "ADE
 * already holds this far back", which is the normal answer when a reconnect
 * re-reads a chat the user has been watching all along. A page that accepted
 * nothing AND skipped nothing is an empty page, not a full transcript, so it
 * does not stop the sweep.
 */
async function hydrateTranscript(host, sessionId, entries) {
  let first = true;
  let accepted = 0;
  for (let offset = 0; offset < entries.length; offset += HYDRATE_PAGE) {
    const page = entries.slice(offset, offset + HYDRATE_PAGE);
    const result = await host.chat.hydrate(sessionId, page, first ? undefined : { append: true });
    first = false;
    accepted += result?.accepted ?? 0;
    if ((result?.accepted ?? 0) === 0 && (result?.skipped ?? 0) > 0) break;
  }
  return accepted;
}

/**
 * Read one run's whole event stream and fold it into ADE's transcript shape.
 *
 * The stream is the only source: Cursor has no "get the conversation" endpoint,
 * and the SDK's own `run.conversation()` accumulates exactly these frames
 * (`@cursor/sdk` `run-interaction-accumulator`). Doing it here is that
 * accumulator without the 26 MB package.
 */
async function readRunConversation(api, agentId, runId, options = {}) {
  const response = await api.streamRun(agentId, runId, options);
  const { messages, lastEventId } = await readEventStream(response);
  const turns = conversationFromStreamMessages(messages);
  return {
    turns,
    transcript: transcriptFromTurns(turns),
    status: statusFromStreamMessages(messages),
    lastEventId,
  };
}

/**
 * The branch a finished run pushed for this project, if it pushed one.
 *
 * A branch attributed to another repository is real work this lane cannot pull,
 * so it is never attached — the same rule `fleet.js` applies to a row.
 */
function branchFromRun(run) {
  const branches = Array.isArray(run?.git?.branches) ? run.git.branches : [];
  for (const entry of branches) {
    const branch = typeof entry?.branch === "string" ? entry.branch.trim() : "";
    if (branch) return branch;
  }
  const flat = typeof run?.git?.branch === "string" ? run.git.branch.trim() : "";
  return flat || null;
}

/**
 * Build the runtime.
 *
 * `links` is the session index this plugin keeps for itself — agent id to
 * `{sessionId, laneId, title}` — because ADE's own session store answers "which
 * plugin owns this" and not "which agent is this".
 */
function createChatRuntime(deps) {
  const { api, host, links, deliveries, now = () => Date.now() } = deps;
  const log = deps.log ?? (() => {});

  /** Sessions a client currently has on screen, and their poll ladder. */
  const watching = new Map();
  /** Runs this plugin dispatched and has not seen finish, by session. */
  const openTurns = new Map();

  /**
   * Bind an agent to a chat, and backfill everything it has already said.
   *
   * Idempotent on `{runtimeId, externalId}` at the host, so calling it for an
   * agent that already has a session returns that session rather than a second.
   */
  async function openAgent({ agentId, laneId, title, sessionId }) {
    const ref = await host.chat.createSession({
      runtimeId: RUNTIME_ID,
      externalId: agentId,
      laneId,
      ...(title ? { title } : {}),
      ...(sessionId ? { sessionId } : {}),
      modelLabel: "Cursor Cloud",
    });
    await links.set(agentId, {
      agentId,
      sessionId: ref.sessionId,
      laneId,
      title: title ?? null,
      openedAt: now(),
    });
    await hydrateAgent(ref.sessionId, agentId);
    return ref;
  }

  /** Read the agent's latest run and backfill it into the session. */
  async function hydrateAgent(sessionId, agentId) {
    const agent = await api.getAgent(agentId).catch(() => null);
    const runId = typeof agent?.latestRunId === "string" ? agent.latestRunId : null;
    if (!runId) return { accepted: 0, status: null };
    const read = await readRunConversation(api, agentId, runId).catch((error) => {
      log("warn", `Could not read the cloud conversation: ${error?.message ?? error}`);
      return null;
    });
    if (!read) return { accepted: 0, status: null };
    const accepted = await hydrateTranscript(host, sessionId, read.transcript);
    const state = chatStateForRunStatus(read.status);
    if (state) {
      await host.chat.emitStatus(sessionId, {
        state,
        ...(detailForRunStatus(read.status) ? { detail: detailForRunStatus(read.status) } : {}),
      });
    }
    return { accepted, status: read.status ?? null };
  }

  /**
   * The user typed. Dispatch a follow-up run and return.
   *
   * A follow-up is a new run on an agent that already exists, which is how
   * Cursor spells "keep going" — there is no separate follow-up verb, and the
   * built-in path used `Agent.resume(...).send(...)`, which is the same two
   * calls with the SDK's object model in front of them.
   */
  async function handleTurn(payload) {
    const { sessionId, externalId: agentId, message, turnId } = payload;
    await host.chat.emitStatus(sessionId, { state: "running", turnId });
    let run;
    try {
      const created = await api.createRun(agentId, { prompt: { text: message } });
      run = created?.run ?? created;
    } catch (error) {
      await host.chat.emitStatus(sessionId, {
        state: "failed",
        turnId,
        detail: error?.message ?? "Cursor refused the follow-up.",
      });
      throw error;
    }
    const runId = typeof run?.id === "string" ? run.id : null;
    openTurns.set(sessionId, { agentId, runId, turnId });
    // Somebody is looking at a chat they just typed into, so the ladder starts
    // at its floor whether or not a `chat.opened` ever arrived for it.
    startLadder({ sessionId, externalId: agentId });
    return { runId };
  }

  /** The user pressed stop. Cancel the run and settle the turn. */
  async function handleInterrupt(payload) {
    const { sessionId, externalId: agentId, turnId } = payload;
    const open = openTurns.get(sessionId);
    const runId = open?.runId ?? (await api.getAgent(agentId).catch(() => null))?.latestRunId ?? null;
    if (runId) await api.cancelRun(agentId, runId).catch(() => {});
    openTurns.delete(sessionId);
    await host.chat.emitStatus(sessionId, {
      state: "idle",
      ...(turnId ? { turnId } : {}),
      detail: "The cloud run was stopped.",
    });
  }

  /**
   * One mirror poll: read what the run has said since last time, write the new
   * part, and report where the ladder goes next.
   *
   * Returns `"new"`, `"unchanged"` or `"skipped"` — the three answers
   * `nextMirrorDelay` steps on, kept as the built-in mirror had them.
   */
  async function poll(sessionId, agentId) {
    const agent = await api.getAgent(agentId).catch(() => null);
    const runId = typeof agent?.latestRunId === "string" ? agent.latestRunId : null;
    if (!runId) return "skipped";
    const read = await readRunConversation(api, agentId, runId).catch(() => null);
    if (!read) return "skipped";

    const accepted = await hydrateTranscript(host, sessionId, read.transcript);
    const state = chatStateForRunStatus(read.status);
    if (state) {
      const open = openTurns.get(sessionId);
      await host.chat.emitStatus(sessionId, {
        state,
        ...(open?.turnId ? { turnId: open.turnId } : {}),
        ...(detailForRunStatus(read.status) ? { detail: detailForRunStatus(read.status) } : {}),
      });
    }
    if (!isLiveRunStatus(read.status)) {
      openTurns.delete(sessionId);
      await settleFinishedRun(sessionId, agentId, runId, read.status);
    }
    return accepted > 0 ? "new" : "unchanged";
  }

  /**
   * A run that stopped: attach its branch and list what it produced.
   *
   * The branch is the artifact that matters — it is the code — and the host
   * fetches it into the lane worktree, which is what lights up the ordinary
   * branch and PR affordances for work that happened somewhere else. Cursor's
   * own artifact files are listed too, and a download that the child's network
   * guard refuses costs the list, never the branch.
   */
  async function settleFinishedRun(sessionId, agentId, runId, status) {
    if (chatStateForRunStatus(status) !== "finished") return;
    const run = await api.getRun(agentId, runId).catch(() => null);
    const branch = branchFromRun(run);
    if (branch) {
      await host.chat.attachBranch(sessionId, { branch }).catch((error) => {
        log("warn", `Could not attach ${branch}: ${error?.message ?? error}`);
      });
    }
    const listed = await api.listArtifacts(agentId).catch(() => null);
    const items = Array.isArray(listed?.items) ? listed.items : [];
    if (!items.length) return;
    const artifacts = items
      .slice(0, 50)
      .map((entry) => ({
        path: String(entry?.path ?? "").replace(/^\/+/, ""),
        ...(Number.isFinite(entry?.sizeBytes) ? { bytes: entry.sizeBytes } : {}),
      }))
      .filter((entry) => entry.path);
    if (!artifacts.length) return;
    await host.chat.setArtifacts(sessionId, artifacts).catch((error) => {
      log("warn", `Could not list the run's artifacts: ${error?.message ?? error}`);
    });
  }

  /* ── Presence ─────────────────────────────────────────────────────────── */

  function startLadder(payload) {
    const { sessionId, externalId: agentId } = payload;
    const existing = watching.get(sessionId);
    if (existing) {
      // Already watching: reset to the floor rather than opening a second timer.
      existing.delayMs = MIRROR_BACKOFF_MS[0];
      return;
    }
    const entry = { agentId, delayMs: MIRROR_BACKOFF_MS[0], timer: null, stopped: false };
    watching.set(sessionId, entry);
    const tick = async () => {
      if (entry.stopped) return;
      let result = "skipped";
      try {
        result = await poll(sessionId, agentId);
      } catch (error) {
        log("debug", `Cloud mirror poll failed: ${error?.message ?? error}`);
      }
      if (entry.stopped) return;
      entry.delayMs = nextMirrorDelay(entry.delayMs, result);
      entry.timer = host.setTimeout(tick, entry.delayMs);
    };
    entry.timer = host.setTimeout(tick, entry.delayMs);
  }

  function stopLadder(payload) {
    const entry = watching.get(payload.sessionId);
    if (!entry) return;
    entry.stopped = true;
    if (entry.timer != null) host.clearTimeout(entry.timer);
    watching.delete(payload.sessionId);
  }

  function stopAllLadders() {
    for (const sessionId of [...watching.keys()]) stopLadder({ sessionId });
  }

  /* ── Webhooks ─────────────────────────────────────────────────────────── */

  /**
   * One Cursor status event.
   *
   * The relay has already verified the HMAC with this plugin's registered
   * secret, so the body is trusted by the time it reaches here. What is NOT
   * guaranteed is exactly-once: a lost ack replays the same `id`, which is why
   * the id is recorded before the ack rather than after the work.
   *
   * The ack is the last thing, deliberately. A crash between the work and the
   * ack replays a delivery that is now a no-op; a crash between the ack and the
   * work loses a run's ending forever.
   */
  async function handleWebhook(payload) {
    const { id, body } = payload;
    // Recorded durably, not in memory. The ONE thing a replay must not repeat
    // is `emitTrigger` — an automation that ran twice because an ack was lost
    // is a second PR, a second deploy, a second message to somebody. A set that
    // died with the child would forget exactly the deliveries most likely to be
    // replayed, which are the ones the child crashed in the middle of.
    if (await deliveries.has(id)) {
      await host.webhooks.ack(id);
      return { duplicate: true };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // A body this build cannot read is one delivery, not a stuck queue: ack
      // it so the relay stops replaying something nothing will ever handle.
      await host.webhooks.ack(id);
      return { duplicate: false, unreadable: true };
    }

    const agentId = typeof parsed?.id === "string" ? parsed.id.trim() : "";
    const status = typeof parsed?.status === "string" ? parsed.status.trim() : "";
    if (!agentId || !status) {
      await host.webhooks.ack(id);
      return { duplicate: false, unreadable: true };
    }

    const link = await links.get(agentId);
    const state = chatStateForRunStatus(status);
    if (link?.sessionId && state) {
      // The chat is asleep — nobody is watching it, so the ladder is off. One
      // poll now is what turns a relay event into a transcript.
      await poll(link.sessionId, agentId).catch(() => {});
      await host.chat.emitStatus(link.sessionId, {
        state,
        ...(detailForRunStatus(status) ? { detail: detailForRunStatus(status) } : {}),
      }).catch(() => {});
    }

    const triggerId = triggerForStatus(status);
    if (triggerId) {
      // `summary` and `branch` are what rules actually template on
      // (`{{trigger.summary}}`, `{{trigger.branch}}`), so they are read from the
      // run rather than left to the webhook body — Cursor's status post carries
      // an id and a status and nothing a sentence could be built from. A rule
      // that templated an absent field would render an empty PR title, which is
      // worse than a rule that did not fire.
      const enriched = await runTriggerFacts(agentId, parsed).catch(() => ({}));
      await host.automations.emitTrigger({
        triggerId,
        payload: {
          agentId,
          status,
          ...enriched,
          ...(link?.sessionId ? { sessionId: link.sessionId } : {}),
          ...(link?.laneId ? { laneId: link.laneId } : {}),
        },
      }).catch((error) => {
        log("warn", `Could not emit ${triggerId}: ${error?.message ?? error}`);
      });
    }

    // Recorded BEFORE the ack, so the window a crash can open is a replay that
    // does nothing rather than an automation that fires twice.
    await deliveries.add(id, { agentId, status, at: now() });
    await host.webhooks.ack(id);
    return { duplicate: false, agentId, status, triggerId, sessionId: link?.sessionId ?? null };
  }

  /**
   * The fields a rule templates on, read from Cursor rather than from the post.
   *
   * One extra request per FINISHED or ERROR event, which is a handful a day —
   * not per poll, and never for a status no rule can fire on.
   */
  async function runTriggerFacts(agentId, body) {
    const facts = {};
    const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
    const agent = await api.getAgent(agentId).catch(() => null);
    const name = typeof agent?.name === "string" ? agent.name.trim() : "";
    if (summary || name) facts.summary = summary || name;
    if (typeof agent?.url === "string") facts.url = agent.url;
    const runId = typeof agent?.latestRunId === "string" ? agent.latestRunId : null;
    if (!runId) return facts;
    const run = await api.getRun(agentId, runId).catch(() => null);
    const branch = branchFromRun(run);
    if (branch) facts.branch = branch;
    const prUrl = (Array.isArray(run?.git?.branches) ? run.git.branches : [])
      .map((entry) => entry?.prUrl)
      .find((value) => typeof value === "string" && value);
    if (prUrl) facts.prUrl = prUrl;
    facts.runId = runId;
    return facts;
  }

  /**
   * The two triggers the built-in dispatch fired, under this plugin's ids.
   *
   * Only `FINISHED` and `ERROR`, exactly as `cursorCloudAutomationDispatch.ts`
   * had it: a rule that fired on `RUNNING` would fire on every poll of every
   * agent, which is a notification storm rather than an automation.
   */
  function triggerForStatus(status) {
    switch (normalizeRunStatus(status)) {
      case "finished":
        return "cloud_finished";
      case "error":
        return "cloud_error";
      default:
        return null;
    }
  }

  return {
    RUNTIME_ID,
    handleInterrupt,
    handleTurn,
    handleWebhook,
    hydrateAgent,
    openAgent,
    poll,
    startLadder,
    stopAllLadders,
    stopLadder,
    triggerForStatus,
    /** Test seam: which sessions have a live ladder right now. */
    watchedSessionIds: () => [...watching.keys()],
  };
}

module.exports = {
  HYDRATE_PAGE,
  RUNTIME_ID,
  branchFromRun,
  chatStateForRunStatus,
  createChatRuntime,
  detailForRunStatus,
  hydrateTranscript,
  isLiveRunStatus,
  readRunConversation,
};
