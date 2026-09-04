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
const { fleetRunStatus, normalizeRunStatus, statusTone } = require("./format");

/** One `chat.hydrate` call's ceiling, from `PLUGIN_CHAT_HYDRATE_MAX_ENTRIES`. */
const HYDRATE_PAGE = 500;

/** This plugin's one declared chat runtime, as the manifest spells it. */
const RUNTIME_ID = "cloud-agent";

/**
 * How long Cursor's own name for an agent is believed.
 *
 * Verbatim from `cursorCloudConversation.ts:CURSOR_CLOUD_REMOTE_NAME_READ_TTL_MS`.
 * A watched mirror ticks every three seconds during an active run, and a rename
 * on cursor.com is not worth twenty extra API calls a minute per chat.
 */
const REMOTE_NAME_READ_TTL_MS = 60_000;

/** The pull request one run pushed for this project, if it pushed one. */
function prUrlFromRun(run) {
  const branches = Array.isArray(run?.git?.branches) ? run.git.branches : [];
  for (const entry of branches) {
    const prUrl = typeof entry?.prUrl === "string" ? entry.prUrl.trim() : "";
    if (prUrl) return prUrl;
  }
  const flat = typeof run?.git?.prUrl === "string" ? run.git.prUrl.trim() : "";
  return flat || null;
}

/** The model id one run named, wherever Cursor put it. */
function modelIdFromRun(run) {
  const nested = typeof run?.model?.id === "string" ? run.model.id.trim() : "";
  if (nested) return nested;
  const flat = typeof run?.modelId === "string" ? run.modelId.trim() : "";
  return flat || null;
}

/**
 * The chat header's chips, in the tone words the fleet row already uses.
 *
 * `statusTone` is `format.js`'s, so a chip beside a chat and a badge on a fleet
 * row can never disagree about what colour a run is. There is no red: a failure
 * is `warning`, which is the house rule.
 */
function headerChips(state) {
  const chips = [];
  if (state.status) {
    chips.push({ text: String(state.status).toUpperCase(), tone: statusTone(state.status) });
  }
  if (state.branch) chips.push({ text: state.branch, tone: "neutral" });
  if (state.modelId) chips.push({ text: state.modelId, tone: "neutral" });
  return chips;
}

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
  /** What each session's header currently says, so an unchanged run is silent. */
  const headerState = new Map();
  /** When Cursor's own name for each session's agent was last read. */
  const remoteNameReadAt = new Map();
  /**
   * Set once a host has told us it has no `chat.setHeader`.
   *
   * The verb is newer than this plugin's floor, and a host that lacks it
   * rejects EVERY call — so one refusal stands the feature down for the life of
   * the child rather than paying a rejected promise on every poll of every
   * chat. A chat on such a host simply keeps the header ADE gave it.
   */
  let headerUnsupported = false;

  /** True for the rejection a host raises when the method is not there at all. */
  function isMissingMethod(error) {
    const code = typeof error?.code === "string" ? error.code : "";
    if (code === "unsupported_method" || code === "method_not_found") return true;
    return /no such method|unsupported method|method not found|is not a function/i
      .test(String(error?.message ?? ""));
  }

  /**
   * Write the chat header, if this host has the verb.
   *
   * `chat.setHeader` is being added to the platform alongside this version. It
   * is called through here and NOWHERE else, so a host that predates it degrades
   * to the header it already draws instead of failing a poll — the whole reason
   * this is a helper rather than four call sites.
   */
  async function writeHeader(sessionId, header) {
    if (headerUnsupported) return false;
    const setHeader = host.chat?.setHeader;
    if (typeof setHeader !== "function") {
      headerUnsupported = true;
      return false;
    }
    try {
      await setHeader.call(host.chat, sessionId, header);
      return true;
    } catch (error) {
      if (isMissingMethod(error)) {
        headerUnsupported = true;
        return false;
      }
      log("debug", `Could not set the chat header: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * Merge what we just learned into the header and publish it if it moved.
   *
   * Accumulated rather than rebuilt: a poll knows the status, a settle knows the
   * branch and the model, and a name read knows the label. Publishing only on a
   * change is what keeps a three-second ladder from writing the same header
   * twenty times a minute.
   */
  async function publishHeader(sessionId, patch) {
    if (!sessionId) return;
    const current = headerState.get(sessionId) ?? { label: null, status: null, branch: null, modelId: null };
    const next = { ...current };
    for (const key of ["label", "status", "branch", "modelId"]) {
      const value = patch?.[key];
      if (typeof value === "string" && value.trim()) next[key] = value.trim();
    }
    if (
      next.label === current.label && next.status === current.status
      && next.branch === current.branch && next.modelId === current.modelId
    ) {
      return;
    }
    headerState.set(sessionId, next);
    const chips = headerChips(next);
    if (!chips.length && !next.label) return;
    await writeHeader(sessionId, { chips, ...(next.label ? { label: next.label } : {}) });
  }

  /**
   * Attach a finished run's branch, and its pull request when it has one.
   *
   * `prUrl` is a newer field on `chat.attachBranch`. A host that refuses the
   * extra key must still get the BRANCH — that is the thing that fetches the
   * work into the lane worktree — so the refusal retries without it rather than
   * dropping the attach.
   */
  async function attachBranch(sessionId, branch, prUrl) {
    const withPr = prUrl ? { branch, prUrl } : { branch };
    try {
      await host.chat.attachBranch(sessionId, withPr);
      return;
    } catch (error) {
      if (!prUrl) {
        log("warn", `Could not attach ${branch}: ${error?.message ?? error}`);
        return;
      }
      log("debug", `Retrying the branch attach without prUrl: ${error?.message ?? error}`);
    }
    await host.chat.attachBranch(sessionId, { branch }).catch((error) => {
      log("warn", `Could not attach ${branch}: ${error?.message ?? error}`);
    });
  }

  /**
   * Cursor's own name for the agent, at most once a minute per session.
   *
   * Ported from `attachAndHydrateCursorCloudChat`'s `readRemoteName`. The stamp
   * is written BEFORE the request so a failing read is rate-limited too — a
   * revoked key must not turn every poll into a retry.
   *
   * This is the ONLY thing that names a session after `openAgent`, which is what
   * `ownsName: true` in the manifest means: Cursor owns the name of a Cursor
   * agent, and neither ADE's auto-titler nor this plugin overwrites it.
   */
  async function readRemoteName(sessionId, agentId, known) {
    const last = remoteNameReadAt.get(sessionId);
    if (last !== undefined && now() - last < REMOTE_NAME_READ_TTL_MS) return null;
    remoteNameReadAt.set(sessionId, now());
    const agent = known ?? await api.getAgent(agentId).catch(() => null);
    const name = typeof agent?.name === "string" ? agent.name.trim() : "";
    return name || null;
  }

  /**
   * Bind an agent to a chat, and backfill everything it has already said.
   *
   * Idempotent on `{runtimeId, externalId}` at the host, so calling it for an
   * agent that already has a session returns that session rather than a second.
   */
  async function openAgent({ agentId, laneId, title, sessionId }) {
    // The rename lock, on this side of the seam. `createSession` is idempotent
    // on `{runtimeId, externalId}`, so a second open of the SAME agent would
    // otherwise re-send a title and rename a chat Cursor had already named. A
    // title is offered only when this plugin has no session for the agent yet.
    const existing = await links.get(agentId).catch(() => null);
    const firstOpen = !existing?.sessionId;
    const ref = await host.chat.createSession({
      runtimeId: RUNTIME_ID,
      externalId: agentId,
      laneId,
      ...(title && firstOpen ? { title } : {}),
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
    const label = await readRemoteName(sessionId, agentId, agent).catch(() => null);
    // One run read per hydrate — not per poll — for the two facts the header
    // wants that the conversation stream does not carry. This is the same
    // single-row read the fleet does for an active agent.
    const page = await api.listRuns(agentId, { limit: 1 }).catch(() => null);
    const latest = Array.isArray(page?.items) ? page.items[0] : null;
    await publishHeader(sessionId, {
      ...(label ? { label } : {}),
      ...(latest ? { branch: branchFromRun(latest), modelId: modelIdFromRun(latest) } : {}),
    });
    const runId = typeof agent?.latestRunId === "string" ? agent.latestRunId : null;
    if (!runId) return { accepted: 0, status: null };
    const read = await readRunConversation(api, agentId, runId).catch((error) => {
      log("warn", `Could not read the cloud conversation: ${error?.message ?? error}`);
      return null;
    });
    if (!read) return { accepted: 0, status: null };
    const accepted = await hydrateTranscript(host, sessionId, read.transcript);
    const state = chatStateForRunStatus(read.status);
    await publishHeader(sessionId, { status: normalizeRunStatus(read.status) ?? null });
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
    await publishHeader(sessionId, { status: normalizeRunStatus(read.status) ?? null });
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
   * own artifact files are listed too. A signed HTTPS URL rides with the
   * listing so the host can fetch and write the file into the lane cache — the
   * child has no worktree path, and the download host is usually not
   * `api.cursor.com`. A mint that fails still lists the path.
   */
  async function settleFinishedRun(sessionId, agentId, runId, status) {
    if (chatStateForRunStatus(status) !== "finished") return;
    const run = await api.getRun(agentId, runId).catch(() => null);
    const branch = branchFromRun(run);
    const prUrl = prUrlFromRun(run);
    await publishHeader(sessionId, {
      status: "finished",
      ...(branch ? { branch } : {}),
      ...(modelIdFromRun(run) ? { modelId: modelIdFromRun(run) } : {}),
    });
    if (branch) await attachBranch(sessionId, branch, prUrl);
    await listRunArtifacts(sessionId, agentId);
  }

  /**
   * List what a finished run produced, on the chat.
   *
   * Split out of `settleFinishedRun` because a webhook `FINISHED` reaches this
   * plugin without going through a poll's terminal branch, and
   * `handleCursorCloudStatusChange` ran `materializeCloudArtifacts` there too.
   * A run whose artifacts were listed by a poll and again by the relay lists
   * the same files, which the host writes once.
   */
  async function listRunArtifacts(sessionId, agentId) {
    const listed = await api.listArtifacts(agentId).catch(() => null);
    const items = Array.isArray(listed?.items) ? listed.items : [];
    if (!items.length) return;
    const artifacts = [];
    for (const entry of items.slice(0, 50)) {
      const artifactPath = String(entry?.path ?? "").replace(/^\/+/, "");
      if (!artifactPath) continue;
      if (Number.isFinite(entry?.sizeBytes) && entry.sizeBytes > 10 * 1024 * 1024) continue;
      const artifact = {
        path: artifactPath,
        ...(Number.isFinite(entry?.sizeBytes) ? { bytes: entry.sizeBytes } : {}),
      };
      try {
        const download = await api.getArtifactDownloadUrl(agentId, artifactPath);
        const sourceUrl = typeof download?.url === "string" ? download.url.trim() : "";
        if (sourceUrl.startsWith("https:")) artifact.sourceUrl = sourceUrl;
      } catch {
        // A signed URL this child cannot mint still lists the file; the host
        // has nothing to fetch and the card names the path.
      }
      artifacts.push(artifact);
    }
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
    const normalized = normalizeRunStatus(status);
    const bodyPrUrl = typeof parsed?.prUrl === "string" ? parsed.prUrl.trim() : "";
    if (link?.sessionId && state) {
      // The chat is asleep — nobody is watching it, so the ladder is off. One
      // poll now is what turns a relay event into a transcript. The poll also
      // emits the run's status and, for a terminal run, attaches the branch and
      // lists the artifacts — which is the whole of what the compiled
      // `handleCursorCloudStatusChange` did on `FINISHED`.
      await poll(link.sessionId, agentId).catch(() => {});
      await publishHeader(link.sessionId, { status: normalized ?? null }).catch(() => {});
      // The compiled dispatch emitted a `cloud_status` event only for a run
      // that ENDED badly, or one that carried a pull request. A plain FINISHED
      // with no PR emitted nothing and still hydrated: the poll above already
      // said "finished", and a second identical status beside it was a
      // duplicate the reader saw as a flicker.
      const worthEmitting = normalized === "error"
        || normalized === "cancelled"
        || normalized === "expired"
        || Boolean(bodyPrUrl);
      if (worthEmitting) {
        await host.chat.emitStatus(link.sessionId, {
          state,
          ...(detailForRunStatus(status) ? { detail: detailForRunStatus(status) } : {}),
        }).catch(() => {});
      }
      if (normalized === "finished") {
        // Belt for the poll's braces: a poll that could not read the stream
        // returns "skipped" without reaching its terminal branch, and a relay
        // FINISHED is the last chance this chat gets to list what ran.
        await listRunArtifacts(link.sessionId, agentId).catch(() => {});
      }
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
    /** Test seam: the header this runtime believes each session is showing. */
    headerFor: (sessionId) => headerState.get(sessionId) ?? null,
  };
}

module.exports = {
  HYDRATE_PAGE,
  REMOTE_NAME_READ_TTL_MS,
  RUNTIME_ID,
  branchFromRun,
  headerChips,
  modelIdFromRun,
  prUrlFromRun,
  chatStateForRunStatus,
  createChatRuntime,
  detailForRunStatus,
  hydrateTranscript,
  isLiveRunStatus,
  readRunConversation,
};
