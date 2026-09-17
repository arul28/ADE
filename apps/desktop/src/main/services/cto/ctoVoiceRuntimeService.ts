import path from "node:path";

// Type-only, and therefore erased: `bootstrap.ts` imports the factory below, so
// a value import here would close a cycle at runtime. `registry.ts` reaches for
// `AdeRuntime` the same way and for the same reason.
import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import { projectAttachmentsDir, stageAttachmentBytes } from "../../../shared/chatAttachmentStagingFs";
import { SCENE_FENCE_LANGUAGE } from "../../../shared/chatScene";
import { isContextOverflowFailureText } from "../../../shared/types/chat";
import {
  CTO_VOICE_CHAT_OVER_LIMIT_DETAIL,
  CTO_VOICE_DEFAULT,
  CTO_VOICE_INITIAL_STATE,
  CTO_VOICE_OUTPUT_AUDIO_QUEUE_LIMIT,
  CTO_VOICE_OWNER_IDLE_TIMEOUT_MS,
  CTO_VOICE_SPOKEN_CONTEXT_OVERFLOW,
  CTO_VOICE_SPOKEN_TURN_FAILED,
  CTO_VOICE_USD_PER_MINUTE,
  CTO_VOICE_VOICES,
  type CtoVoiceActionResult,
  type CtoVoiceName,
  type CtoVoiceState,
  ctoVoiceStatusLine,
  isVoiceCallLive,
} from "../../../shared/types/ctoVoice";
import { describeVoiceApproval } from "../../../shared/types/ctoVoiceDestructive";
import {
  buildCtoVoiceContext,
  buildVoiceSceneContract,
  describeVoiceActiveWork,
  readVoiceTodayLog,
  splitSpokenSceneAnswer,
  voiceRequestAsksForVisual,
} from "./ctoVoiceContext";
import { createOutputAudioQueue } from "./ctoVoiceOutputAudio";
import { getMachineApiKey } from "../ai/apiKeyStore";
import { beginIdentityConfirmHold } from "../chat/identitySessionPolicy";
import {
  createCtoVoiceCallService,
  type CtoVoiceApprovalNotice,
  type CtoVoiceCallEndReason,
  type CtoVoiceCallDeps,
  type CtoVoiceCallService,
  type CtoVoiceSocket,
} from "./ctoVoiceCallService";

/**
 * The CTO voice call, hosted by the project's runtime.
 *
 * It lives here rather than in the desktop main process because the call brain
 * needs the chat service, the CTO identity and the project's durable memory —
 * and in every real build those are the RUNTIME's instances. `ctx.agentChatService`
 * and `ctx.ctoStateService` on the desktop `AppContext` are null outside
 * `NODE_ENV=test`, which is exactly why Talk used to answer "chat + cto-state
 * service not ready for this project".
 *
 * Desktop main stays the router and keeps what only it can own: the window that
 * holds the microphone, the audio graph, and the HUD. It reaches this service
 * through the `cto_voice` action domain like every other chat action.
 *
 * Audio deliberately does NOT travel on the event buffer. That buffer is a
 * bounded, replayable log of real events (capacity 10,000, with a byte cap);
 * 10 chunks a second of PCM would evict every orchestrator and runtime event in
 * seconds. Input audio is pushed as an action argument and output audio is
 * drained by the owner with `pullAudio`.
 */

/** What this service needs from the runtime around it. A subset of `AdeRuntime`. */
export type CtoVoiceRuntimeHost = {
  projectRoot: AdeRuntime["projectRoot"];
  logger?: Pick<AdeRuntime["logger"], "info" | "warn"> | null;
  laneService?: AdeRuntime["laneService"] | null;
  ctoStateService?: AdeRuntime["ctoStateService"] | null;
  agentChatService?: AdeRuntime["agentChatService"] | null;
  ctoMemoryService?: AdeRuntime["ctoMemoryService"] | null;
  /**
   * The session row store, for the one line a call owns: the CTO row's status
   * note. Written straight rather than through the chat service because the
   * chat service's own status line is LLM-generated per settled turn, which
   * during a call always lands seconds behind the conversation.
   *
   * Optional: a host without it simply does not update the row, and the call is
   * otherwise unaffected.
   */
  sessionService?: Pick<AdeRuntime["sessionService"], "setStatusNote"> | null;
  /**
   * One coarse event per call, at its end. Optional: a runtime built without
   * analytics simply does not report, and nothing else changes.
   */
  productAnalyticsService?: AdeRuntime["productAnalyticsService"] | null;
  /**
   * State, transcript and approval events only — see the note above on why
   * audio is not one of them. Optional so an in-process host that pushes state
   * straight to its own listeners does not have to own a buffer.
   */
  eventBuffer?: Pick<AdeRuntime["eventBuffer"], "push"> | null;
};

export type CtoVoiceRuntimeOptions = {
  /** Injected by tests; the call service builds a real `ws` client otherwise. */
  createWebSocket?: (url: string, apiKey: string) => CtoVoiceSocket;
  /** Injected by tests; reads this machine's stored OpenAI key otherwise. */
  getApiKey?: () => Promise<string | null>;
  /** Injected by tests so the owner watchdog can be driven deterministically. */
  now?: () => number;
};

export type CtoVoicePullAudioResult = CtoVoiceActionResult & {
  chunks: string[];
  /** Chunks the queue had to drop because nobody was draining it. */
  dropped: number;
};

export type CtoVoiceRuntimeService = ReturnType<typeof createCtoVoiceRuntimeService>;

/** The event payload the `cto_voice` category carries. State, never audio. */
export type CtoVoiceRuntimeEvent = {
  type: "cto_voice_state";
  state: CtoVoiceState;
};

/** One window holds the microphone and the speaker; the rest may only watch. */
const NOT_OWNER: CtoVoiceActionResult = {
  ok: false,
  error: "not-call-owner",
  detail: "another window is holding this call",
};


/** How a call ended, in the closed vocabulary the analytics allowlist holds. */
type CtoVoiceCallOutcome =
  | "completed"
  | "rejected_key"
  | "connection_failed"
  | "microphone_unavailable"
  | "ended_early";

/**
 * A call's length, in the buckets the taxonomy already has.
 *
 * Deliberately the existing `duration_bucket` vocabulary rather than a
 * voice-specific one: a parallel spelling of "about a minute" is how a
 * dimension stops being comparable across features.
 */
function voiceCallDurationBucket(elapsedMs: number): string {
  if (elapsedMs < 60_000) return "under_1m";
  if (elapsedMs < 5 * 60_000) return "under_5m";
  if (elapsedMs < 30 * 60_000) return "under_30m";
  if (elapsedMs < 2 * 60 * 60_000) return "under_2h";
  return "over_2h";
}

function readOwnerToken(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const value = (args as { ownerToken?: unknown }).ownerToken;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Base64 chunks the desktop batched from the microphone.
 *
 * Accepts `chunks` (the batched shape) and `audio` (one frame) so a caller on
 * an older desktop build is not silently mute.
 */
function readAudioChunks(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as { chunks?: unknown; audio?: unknown };
  const out: string[] = [];
  if (Array.isArray(record.chunks)) {
    for (const chunk of record.chunks) {
      if (typeof chunk === "string" && chunk.length > 0) out.push(chunk);
    }
  }
  if (typeof record.audio === "string" && record.audio.length > 0) out.push(record.audio);
  return out;
}

/**
 * The level each chunk of a batch arrived with.
 *
 * Positional: `levels[i]` belongs to `chunks[i]`. Absent from an older desktop
 * build, and absent is not the same as zero — the caller falls back to the batch
 * maximum there, which is exactly what every frame used to be credited.
 */
function readAudioLevels(args: unknown): Array<number | null> {
  if (!args || typeof args !== "object") return [];
  const value = (args as { levels?: unknown }).levels;
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "number" && Number.isFinite(entry) ? entry : null));
}

export function createCtoVoiceRuntimeService(
  host: CtoVoiceRuntimeHost,
  options: CtoVoiceRuntimeOptions = {},
) {
  const now = options.now ?? (() => Date.now());
  const hostLogger = host.logger ?? null;
  const listeners = new Set<(state: CtoVoiceState) => void>();

  let service: CtoVoiceCallService | null = null;
  /** The desktop window currently holding the microphone, as an opaque token. */
  let ownerToken: string | null = null;
  let lastOwnerContactMs = 0;
  let ownerWatchdog: NodeJS.Timeout | null = null;
  let state: CtoVoiceState = { ...CTO_VOICE_INITIAL_STATE };
  /** Output PCM waiting for the owner to drain it. Never event-buffered. */
  const outputAudio = createOutputAudioQueue(CTO_VOICE_OUTPUT_AUDIO_QUEUE_LIMIT);
  /** The CTO session this call is driving, once confirm mode is on. */
  let callSessionId: string | null = null;
  /**
   * The same session id, kept for the call's LAST status line.
   *
   * `callSessionId` is deliberately cleared when confirm mode is released, and
   * that release happens on the way out of `endCall` — before the final
   * exchange report. Without a second binding the closing line ("Voice call
   * ended · 3 exchanges") had nowhere to be written and the row stayed reading
   * as though the call were still up.
   */
  let statusLineSessionId: string | null = null;
  let releaseConfirmHold: (() => void) | null = null;
  let inFlightInterrupt: Promise<unknown> = Promise.resolve();

  /**
   * Serializes start and end, for the same reason the desktop used to.
   *
   * Tearing a call down hangs up the socket, gives the confirm-first hold back
   * and writes the transcript, and it nulls `service` before all of that. Two
   * overlapping starts would otherwise leave a stranded hold, which leaves the
   * CTO asking for confirmation in every chat for the life of the runtime.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  /**
   * True only while a call from a PREVIOUS attempt is being cleared out.
   *
   * Clearing a dead service is bookkeeping, not news: the desktop subscribes
   * before it calls `start`, so that teardown's `ended` was the first thing the
   * NEW call's slot ever saw. It hung up a call that was 120 ms old and still
   * connecting, and "closed before the connection was established" became the
   * sentence the user read.
   *
   * Keyed on the REASON, never on the phase. Keying it on "the phase is already
   * terminal" swallowed the `ended` that follows a `failed` — the call's own
   * teardown — and `failed` keeps the HUD on screen, so the pill sat there
   * forever showing a failure with no way out and the page notice, which only
   * appears once the HUD unmounts, never came. A call that failed still has to
   * end.
   *
   * `state` still moves, so `getState` stays honest; only the broadcast stops.
   */
  let suppressPublish = false;
  /**
   * Call ids already reported. One event per call, whichever teardown ran.
   *
   * Emitted from `publish` rather than from a teardown path because there are
   * six of those and a call reaches a terminal phase through all of them; the
   * state transition is the one fact they share.
   */
  const reportedCalls = new Set<string>();
  /** Coarse, set by the router when the renderer said why it hung up. */
  let endKind: CtoVoiceCallOutcome | null = null;

  const reportCallEnded = (terminal: CtoVoiceState): void => {
    const callId = terminal.callId;
    if (!callId || reportedCalls.has(callId)) return;
    reportedCalls.add(callId);
    const outcome: CtoVoiceCallOutcome = endKind
      ?? service?.getConnectionFailureKind()
      ?? (terminal.phase === "failed"
        ? "connection_failed"
        : terminal.elapsedMs > 0 ? "completed" : "ended_early");
    host.productAnalyticsService?.captureInternal({
      event: "ade_feature_used",
      surface: "desktop",
      properties: {
        feature: "cto",
        action: "voice_call",
        outcome,
        duration_bucket: voiceCallDurationBucket(terminal.elapsedMs),
      },
      // Per call, so the two terminal states one call publishes — `failed` then
      // `ended` — are one product fact rather than two.
      dedupeKey: `cto_voice_call:${callId}`,
    });
  };

  const publish = (next: CtoVoiceState): void => {
    const wasInterrupted = state.interrupted;
    state = next;
    // A barge-in silences the speaker, and everything already queued here was
    // generated before the user started talking — so draining it after the
    // interrupt is the CTO carrying on over them. The renderer flushes its own
    // playback graph; this is the other half, and without it the next pull
    // hands back up to twenty seconds of the answer the user just stopped.
    // Not counted as dropped audio: these chunks were cancelled, not lost.
    if (next.interrupted && !wasInterrupted) outputAudio.clear();
    // Before the suppression check: a call cleared by a later one still ended,
    // and its outcome is the same product fact whether anyone was listening.
    if (!isVoiceCallLive(next.phase)) reportCallEnded(next);
    if (suppressPublish) return;
    const event: CtoVoiceRuntimeEvent = { type: "cto_voice_state", state: next };
    try {
      host.eventBuffer?.push({
        timestamp: new Date().toISOString(),
        category: "cto_voice",
        payload: { ...event },
      });
    } catch (error) {
      host.logger?.warn("cto_voice.event_push_failed", { error: String(error) });
    }
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // One subscriber must not break the call.
      }
    }
  };

  const resolvePrimaryLaneId = async (): Promise<string> => {
    const laneService = host.laneService;
    if (!laneService) throw new Error("No lane service is available to host the CTO chat session.");
    await laneService.ensurePrimaryLane();
    const lanes = await laneService.list();
    const primary = lanes.find((lane) => lane.laneType === "primary");
    if (!primary?.id) throw new Error("No primary lane is available to host the CTO chat session.");
    return primary.id;
  };

  const readApiKey = async (): Promise<string | null> => {
    if (options.getApiKey) return await options.getApiKey();
    // A locked Windows `safeStorage` or a denied macOS Keychain makes this
    // throw. An unreadable store is "no key", not a crash.
    try {
      return getMachineApiKey("openai");
    } catch {
      return null;
    }
  };

  function buildCallDeps(
    agentChatService: NonNullable<AdeRuntime["agentChatService"]>,
    ctoStateService: NonNullable<AdeRuntime["ctoStateService"]>,
    apiKey: string,
  ): CtoVoiceCallDeps {
    const ctoMemoryService = host.ctoMemoryService ?? null;
    // The project record carries no display name at this layer; the folder name
    // is what the user calls this project everywhere else in ADE.
    // `path.basename` rather than a hand-rolled split, so a Windows root with a
    // trailing separator reads the same as a POSIX one. Computed once: the
    // context block and the session prompt must not be able to disagree about
    // what this project is called.
    const projectName = path.basename(host.projectRoot.replace(/[\\/]+$/, "")) || "this project";

    /**
     * A call puts the CTO in confirm-first mode, and restores full-auto when it
     * hangs up. The hold is what enforces it: writing a mode onto the session
     * alone does nothing, because `normalizeIdentityPermissionMode` snaps the
     * CTO back to full-auto on every `ensureIdentitySession`.
     */
    const setCallConfirmMode = async (confirmFirst: boolean): Promise<void> => {
      if (!confirmFirst) {
        releaseConfirmHold?.();
        releaseConfirmHold = null;
      }
      // Take the hold BEFORE resolving the lane: resolution can fail, and a
      // call must never reach the socket with the CTO still on full-auto. It
      // starts unscoped for exactly that reason — the session it belongs to is
      // not known yet — and is narrowed to that session the moment it is, so a
      // call on one project does not hold every other project's CTO in
      // confirm-first mode for longer than the handful of milliseconds it takes
      // to resolve the lane.
      if (confirmFirst && !releaseConfirmHold) releaseConfirmHold = beginIdentityConfirmHold();
      try {
        const laneId = await resolvePrimaryLaneId();
        const session = await agentChatService.ensureIdentitySession({ identityKey: "cto", laneId });
        callSessionId = confirmFirst ? session.id : null;
        if (confirmFirst) statusLineSessionId = session.id;
        if (confirmFirst) {
          // Narrow first, release second: the gate is never open between them.
          const scoped = beginIdentityConfirmHold(session.id);
          releaseConfirmHold?.();
          releaseConfirmHold = scoped;
        }
        await agentChatService.updateSession({
          sessionId: session.id,
          permissionMode: confirmFirst ? "default" : "full-auto",
        });
      } catch (error) {
        // A hold nobody will release leaves the CTO asking forever, so a
        // failure on the way in gives it back. On the way out a missing lane
        // means there is no session left to restore, which is not an error.
        if (!confirmFirst) return;
        releaseConfirmHold?.();
        releaseConfirmHold = null;
        throw error;
      }
    };

    return {
      getApiKey: async () => apiKey,
      setCallConfirmMode,

      /**
       * Let a blocked turn through, or turn it away. Same call the approval
       * card in the chat makes, so a spoken yes and a tap land on one path.
       */
      resolveApproval: async ({ itemId, approved }: { itemId: string; approved: boolean }) => {
        if (!callSessionId) return;
        await agentChatService.approveToolUse({
          sessionId: callSessionId,
          itemId,
          decision: approved ? "accept" : "decline",
        });
      },

      /**
       * Watch the CTO thread for approvals while a call is up. The gate lives
       * in `canUseTool`, which parks the turn on a promise, so nothing comes
       * back through `runBackendTurn` to say the call is waiting.
       */
      watchApprovals: (onApproval: (a: CtoVoiceApprovalNotice) => void) =>
        agentChatService.subscribeToEvents((envelope) => {
          if (!callSessionId || envelope.sessionId !== callSessionId) return;
          const event = envelope.event;
          if (event.type !== "approval_request") return;
          // `requestKind` distinguishes "approve this tool" from "answer this
          // question"; only the former is a yes/no a voice can carry.
          if (event.requestKind && event.requestKind !== "approval") return;
          // The verdict is decided HERE, where the whole event is in hand. A
          // tool name alone cannot tell a force-push from a `git status`: a
          // bash approval arrives as `kind: "command"` with the command in its
          // description, and `detail` is an object, never the string the first
          // version of this searched. Getting that wrong made every
          // confirmation non-destructive, so a misheard "yes" could force-push.
          const described = describeVoiceApproval(event);
          onApproval({
            itemId: event.itemId,
            toolName: described.toolName,
            destructive: described.destructive,
            prompt: event.description.trim() || "Go ahead?",
          });
        }),

      /**
       * The context block, rebuilt on demand.
       *
       * Every read is cheap except the lane list, which is one await — and it
       * is the fact most likely to be asked about ("how many lanes do we
       * have?"), so it is worth the await rather than worth a guess. Every
       * source is individually guarded: a project whose memory files are
       * unreadable should get a smaller block, not a call that will not start.
       */
      context: async (): Promise<string> => {
        const identity = ctoStateService.getIdentity();
        let laneNames: string[] = [];
        let lanesTotal = 0;
        try {
          const lanes = await (host.laneService?.list({
            includeArchived: false,
            includeStatus: false,
          }) ?? Promise.resolve([]));
          lanesTotal = lanes.length;
          laneNames = lanes.map((lane) => lane.name || lane.id);
        } catch (error) {
          hostLogger?.warn("cto_voice.context_lanes_failed", { error: String(error) });
        }
        let memorySections: Array<{ title: string; body: string }> = [];
        try {
          // The memory service's own three labelled sections — durable memory,
          // thread state, recent daily log — rather than a second assembly of
          // the same files here. One place decides what the CTO remembers.
          memorySections = ctoMemoryService?.buildMemoryContextSections() ?? [];
        } catch (error) {
          hostLogger?.warn("cto_voice.context_memory_failed", { error: String(error) });
        }
        // Refreshed rather than read off the cache: the block is rebuilt after
        // every completed request, which is exactly when what is in flight has
        // just changed. A snapshot that cannot be captured — a host with no
        // live-state sources — leaves the section out rather than failing.
        let activeWork: string[] = [];
        try {
          const live = (await ctoStateService.refreshLiveState())
            ?? ctoStateService.getLiveStateSnapshot();
          if (live) activeWork = describeVoiceActiveWork(live);
        } catch (error) {
          hostLogger?.warn("cto_voice.context_live_state_failed", { error: String(error) });
        }
        let todayLog: string[] = [];
        try {
          todayLog = readVoiceTodayLog(ctoMemoryService?.getSnapshot() ?? null);
        } catch (error) {
          hostLogger?.warn("cto_voice.context_daily_log_failed", { error: String(error) });
        }
        const preferred = identity.modelPreferences;
        return buildCtoVoiceContext({
          activeWork,
          todayLog,
          ctoName: identity.name || "CTO",
          persona: identity.persona || "Persistent project CTO for this ADE workspace.",
          projectName,
          projectRoot: host.projectRoot,
          modelName: preferred ? `${preferred.provider}/${preferred.model}` : null,
          laneNames,
          lanesTotal,
          memorySections,
        });
      },

      ctoName: () => ctoStateService.getIdentity().name || "CTO",
      projectName: () => projectName,
      // Read per call from the identity, so a change in settings applies to the
      // next call without a restart.
      backchannelsEnabled: () => ctoStateService.getIdentity().voiceBackchannels !== false,
      voice: () => {
        const stored = ctoStateService.getIdentity().voiceName;
        return (CTO_VOICE_VOICES as readonly string[]).includes(stored ?? "")
          ? (stored as CtoVoiceName)
          : CTO_VOICE_DEFAULT;
      },

      runBackendTurn: async ({ intent, callId, imageBase64, signal }: {
        intent: string;
        callId: string;
        signal: AbortSignal;
        imageBase64?: string | null;
      }) => {
        // The call already resolved this session — `setCallConfirmMode` runs
        // before the socket opens and is what the confirm-first hold is keyed
        // on. Re-resolving it per turn walked the lane list and re-normalized
        // the session again between the user finishing a sentence and the
        // provider seeing it, which is time the user spends listening to
        // nothing. Falling back to a full resolve keeps a call that never took
        // the hold (confirm mode off) working exactly as before.
        const sessionId = callSessionId
          ?? (await agentChatService.ensureIdentitySession({
            identityKey: "cto",
            laneId: await resolvePrimaryLaneId(),
          })).id;

        const attachments: Array<{ path: string; type: "image" }> = [];
        if (imageBase64) {
          const saved = await stageAttachmentBytes({
            content: Buffer.from(imageBase64, "base64"),
            filename: `voice-capture-${Date.now()}.png`,
            attachmentsDir: projectAttachmentsDir(host.projectRoot),
          });
          attachments.push({ path: saved.path, type: "image" });
        }

        // A barge-in aborts the controller the call service handed us. The turn
        // is already running on the CTO's one session, so the only way to stop
        // it is to interrupt that session — otherwise superseded turns stack up
        // and each still speaks its answer over the next one.
        const onAbort = () => {
          // Published to the shared slot, not a local: the superseding turn
          // reads it immediately, long before this invocation's `finally`.
          inFlightInterrupt = agentChatService
            // `stop_only`, not `stop_and_clear`: the CTO thread is one shared
            // session, so clearing the queue would throw away a message the
            // user typed into the chat and is still waiting on.
            .interrupt({ sessionId, mode: "stop_only" })
            .catch(() => { /* the turn had already finished */ });
        };
        // Registered before anything can be awaited below, and checked once
        // after: `addEventListener` on a signal that is ALREADY aborted never
        // fires, so a turn aborted between being scheduled and starting would
        // otherwise never interrupt the session it is about to collide with.
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        // `runSessionTurn` throws on a session that already has a turn running.
        // This await is necessary and not sufficient: `interrupt` resolves when
        // the interrupt is ASKED for, not when the turn it stops is over. What
        // makes a replace safe is the call service running requests serially —
        // it starts the next one only after this function has returned.
        await inFlightInterrupt;

        // What the call cannot see from the other side of `runBackendTurn`: how
        // long the model took to say its first word, and how much of the wait
        // was tools. Both go in `cto_voice.turn_timing`, which is the only
        // place a slow call can be told apart from a slow model. Scoped to this
        // call's own events — the CTO thread is shared with the chat.
        let firstTextAtMs: number | null = null;
        let toolCalls = 0;
        const turnStartedAtMs = now();
        const releaseTurnWatch = agentChatService.subscribeToEvents((envelope) => {
          if (envelope.sessionId !== sessionId) return;
          if (callId && envelope.provenance?.voiceCallId !== callId) return;
          if (envelope.event.type === "tool_call") { toolCalls += 1; return; }
          if (envelope.event.type !== "text") return;
          if (firstTextAtMs === null) firstTextAtMs = now();
        });
        try {
          const result = await agentChatService.runSessionTurn({
            sessionId,
            text: [
              "[voice call] The user is on a call. A voice assistant speaking as you will relay"
              + " your answer out loud, so write for the ear: at most three plain sentences, no"
              + " markdown, no lists, no code, no formatting of any kind.",
              "Answer the question itself — the voice assistant adds nothing and looks nothing up.",
              // The transcriber is pinned to English, so a reply in another
              // language would be read aloud by an English voice. Said here as
              // well because the intent text can still arrive with a foreign
              // word in it, and the CTO used to answer in kind.
              "Answer in English.",
              // Everything outside the fence is still spoken aloud, so the
              // picture supplements the sentences rather than replacing them.
              // The conditional line is not decoration — on the live call of
              // 2026-09-16 the user asked for "a visual of the PRs merged
              // yesterday" and the voice offered to DESCRIBE them, because
              // "you may add a fence" reads as an option and "show me" did not
              // read as an instruction to draw.
              voiceRequestAsksForVisual(intent)
                ? `The user asked to SEE this, so draw it: end your sentences with exactly one \`\`\`${SCENE_FENCE_LANGUAGE} fence containing a real rendering of what they asked for — actual values, actual labels, not a placeholder or a description of a picture. Say your sentences as well; the fence is what they look at while you talk.\n${buildVoiceSceneContract()}`
                : `When a picture says it better than words, you may add exactly one \`\`\`${SCENE_FENCE_LANGUAGE} fence after your sentences. Never more than one, and never instead of speaking.`,
              // This sentence does not create the gate — the hold in
              // `setCallConfirmMode` does. It only tells the CTO what is about
              // to happen, so the pause reads as deliberate rather than broken.
              "You can do anything here that you can do in the chat. Before anything that writes, ADE will stop you and ask the user out loud — say what you are about to do in one short sentence and wait for their answer.",
              "",
              intent,
            ].join("\n"),
            displayText: intent,
            attachments,
            // Every event this turn emits carries the call, so the transcript
            // folds the whole call into one card instead of a stream of
            // messages the user never typed.
            ...(callId ? { voiceCallId: callId } : {}),
          });
          // The turn's own verdict decides what is spoken — never its text.
          // `outputText` on a failed turn is the provider's error sentence
          // ('Prompt is too long'), and speaking that is how the CTO ended up
          // reading an error out loud in its own voice.
          const measured = {
            ...(firstTextAtMs === null ? {} : { firstTextMs: Math.round(firstTextAtMs - turnStartedAtMs) }),
            toolCalls,
          };
          if (result.status === "completed") {
            return {
              ...splitSpokenSceneAnswer(result.outputText),
              status: "completed" as const,
              ...measured,
            };
          }
          const reason = result.errorMessage ?? result.outputText;
          if (result.status === "interrupted") {
            hostLogger?.info("cto_voice.turn_interrupted", { callId, sessionId });
            return {
              spoken: "",
              status: "interrupted" as const,
              reason: "That was stopped before it finished.",
              ...measured,
            };
          }
          const overLimit = isContextOverflowFailureText(reason);
          hostLogger?.warn("cto_voice.turn_failed", {
            callId,
            sessionId,
            status: result.status,
            cause: overLimit ? "context_overflow" : "error",
            error: reason,
          });
          // The provider's own words never travel: `reason` here is a house
          // sentence, because whatever goes back is read out loud by a model
          // that will happily relay a stack trace.
          return {
            spoken: "",
            status: "failed" as const,
            reason: overLimit ? CTO_VOICE_SPOKEN_CONTEXT_OVERFLOW : CTO_VOICE_SPOKEN_TURN_FAILED,
            ...measured,
          };
        } finally {
          releaseTurnWatch();
          signal.removeEventListener("abort", onAbort);
        }
      },

      persistCall: async ({ callId, startedAt, endedAt, captions, costUsd }: {
        callId: string;
        startedAt: string;
        endedAt: string;
        captions: CtoVoiceState["captions"];
        costUsd: number;
      }) => {
        if (!ctoMemoryService) return;
        const minutes = Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000);
        const lines = [
          `# Voice call ${callId}`,
          "",
          `- Started: ${startedAt}`,
          `- Ended: ${endedAt}`,
          `- Length: ${minutes.toFixed(1)} min`,
          `- Cost: $${costUsd.toFixed(2)} at $${CTO_VOICE_USD_PER_MINUTE.toFixed(2)}/min`,
          "",
          "## Transcript",
          "",
          ...captions.map((caption) => `**${caption.role}**: ${caption.text}`),
          "",
        ].join("\n");
        await ctoMemoryService.writeCallTranscript(callId, lines);
      },

      /**
       * Keep the CTO row honest while the call runs.
       *
       * The row's second line is normally the LLM-generated status line a
       * settled turn produces. On a call that generation is always behind: the
       * owner watched the line read "hey there?" three exchanges later, because
       * each regeneration takes seconds and a spoken turn takes one. A call
       * therefore writes the line itself, deterministically, and the generated
       * one stands down for the duration (`isIdentityConfirmHeld`).
       *
       * Written with the session the call is HELD on, so a call that never got
       * as far as resolving a session writes nothing at all.
       */
      onExchange: ({ exchanges, live }: { exchanges: number; live: boolean }) => {
        const sessionId = statusLineSessionId;
        if (!sessionId || !host.sessionService) return;
        try {
          host.sessionService.setStatusNote(sessionId, ctoVoiceStatusLine({ exchanges, live }));
        } catch (error) {
          hostLogger?.warn("cto_voice.status_line_write_failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },

      onState: (next: CtoVoiceState) => publish(next),
      onOutputAudio: (base64: string) => outputAudio.push(base64),
      // Adapted rather than passed through: the runtime `Logger` takes a
      // `Record<string, unknown>` meta and the call service declares `unknown`,
      // which do not assign to each other under strict function types.
      ...(hostLogger
        ? {
          logger: {
            info: (msg: string, meta?: unknown) => hostLogger.info(msg, meta as Record<string, unknown> | undefined),
            warn: (msg: string, meta?: unknown) => hostLogger.warn(msg, meta as Record<string, unknown> | undefined),
          },
        }
        : {}),
      ...(options.createWebSocket ? { createWebSocket: options.createWebSocket } : {}),
    };
  }

  const stopWatchdog = (): void => {
    if (!ownerWatchdog) return;
    clearInterval(ownerWatchdog);
    ownerWatchdog = null;
  };

  const endCurrentCall = async (reason: CtoVoiceCallEndReason = "unknown"): Promise<void> => {
    // Logged whether or not there is anything to end: "end was called and there
    // was no call" is itself an answer, and it was the missing one.
    hostLogger?.info("cto_voice.call_end", {
      reason,
      scope: "runtime",
      callId: state.callId,
      phase: state.phase,
      hasService: Boolean(service),
    });
    stopWatchdog();
    const ending = service;
    // The only two teardowns nobody is listening for: a dead service being
    // swept aside by a new call, and the project closing. Every other reason is
    // this call's own ending, and its `ended` is exactly what the HUD is
    // waiting for.
    const silent = reason === "replaced" || reason === "dispose";
    service = null;
    ownerToken = null;
    outputAudio.reset();
    callSessionId = null;
    if (!ending) return;
    suppressPublish = silent;
    try {
      await ending.end(reason);
    } finally {
      suppressPublish = false;
    }
  };

  /**
   * Hang up a call whose owner stopped talking to us.
   *
   * The desktop drains output audio ten times a second for the whole call, so
   * silence means the window holding the microphone is gone — killed, crashed,
   * or disconnected from the runtime. Without this the socket, the billing and
   * the CTO's confirm-first hold would all outlive it, inside a process the
   * user cannot see.
   */
  const startWatchdog = (): void => {
    stopWatchdog();
    lastOwnerContactMs = now();
    ownerWatchdog = setInterval(() => {
      if (!service) return;
      if (now() - lastOwnerContactMs < CTO_VOICE_OWNER_IDLE_TIMEOUT_MS) return;
      host.logger?.warn("cto_voice.owner_went_quiet", {
        idleMs: now() - lastOwnerContactMs,
      });
      void serialize(() => endCurrentCall("watchdog"));
    }, 1_000);
    ownerWatchdog.unref?.();
  };

  /** Any owner-authenticated call is proof the window is still there. */
  const touchOwner = (token: string): boolean => {
    if (!ownerToken || token !== ownerToken) return false;
    lastOwnerContactMs = now();
    return true;
  };

  return {
    /** The current call state. Free to read: every window renders the HUD. */
    getState(): CtoVoiceState {
      return state;
    },

    /** True when this machine has an OpenAI key a call could bill to. */
    async hasKey(): Promise<boolean> {
      return Boolean(await readApiKey());
    },

    async start(args?: { ownerToken?: string; callSessionId?: string }): Promise<CtoVoiceActionResult> {
      const token = readOwnerToken(args);
      if (!token) {
        return { ok: false, error: "bad-request", detail: "the caller did not identify itself as the call owner" };
      }
      return await serialize(async (): Promise<CtoVoiceActionResult> => {
        if (service) {
          // The same window asking twice for a live call is not an error.
          if (ownerToken === token && isVoiceCallLive(state.phase)) return { ok: true };
          if (isVoiceCallLive(state.phase)) return NOT_OWNER;
          // A call can end without anyone being told — the socket closed, or
          // errored — leaving the service and its owner behind.
          await endCurrentCall("replaced");
        }

        const agentChatService = host.agentChatService ?? null;
        const ctoStateService = host.ctoStateService ?? null;
        if (!agentChatService) {
          return {
            ok: false,
            error: "chat-unavailable",
            detail: "the CTO chat session is not ready on this machine",
          };
        }
        if (!ctoStateService) {
          return {
            ok: false,
            error: "cto-state-unavailable",
            detail: "this project has no CTO yet",
          };
        }
        const apiKey = await readApiKey();
        if (!apiKey) {
          return { ok: false, error: "missing-key", detail: "no OpenAI key on this machine" };
        }

        // Pre-flight: a call is only worth opening a billed socket for if the
        // thread behind it can still answer. The CTO thread is shared with the
        // chat, and once it is over its context limit EVERY turn fails the same
        // way — so the call would connect, listen, think, and then read an
        // error out loud. Refusing here costs one cheap read of the session's
        // own persisted turn health and no provider round-trip.
        try {
          const laneId = await resolvePrimaryLaneId();
          const session = await agentChatService.ensureIdentitySession({ identityKey: "cto", laneId });
          const health = agentChatService.getSessionTurnHealth({ sessionId: session.id });
          if (!health.canTakeTurn) {
            host.logger?.warn("cto_voice.start_refused_chat_unavailable", {
              sessionId: session.id,
              reason: health.blockedReason,
            });
            return {
              ok: false,
              error: "chat-unavailable",
              detail: CTO_VOICE_CHAT_OVER_LIMIT_DETAIL,
            };
          }
        } catch (error) {
          // The pre-flight is a guard, not a gate: a lane or a session that
          // could not be resolved is the START path's problem to report, with
          // the sentence it already has.
          host.logger?.warn("cto_voice.preflight_failed", { error: String(error) });
        }

        outputAudio.reset();
        endKind = null;
        ownerToken = token;
        service = createCtoVoiceCallService(buildCallDeps(agentChatService, ctoStateService, apiKey));
        startWatchdog();
        try {
          const result = await service.start();
          if (!result.ok) {
            const detail = state.error ?? "the call could not be started";
            await endCurrentCall("start_rejected");
            return { ok: false, ...(result.error ? { error: result.error } : {}), detail };
          }
          return { ok: true };
        } catch (error) {
          host.logger?.warn("cto_voice.start_failed", { error: String(error) });
          await endCurrentCall("start_rejected");
          return { ok: false, error: "start-failed", detail: String(error) };
        }
      });
    },

    async end(args?: { ownerToken?: string; endKind?: string }): Promise<CtoVoiceActionResult> {
      const token = readOwnerToken(args);
      // The only coarse end reason a caller can name. Anything else is decided
      // here from the call's own terminal state, and the sentence the renderer
      // showed the user never travels.
      if (args?.endKind === "microphone_unavailable") endKind = "microphone_unavailable";
      // Serialized before the checks, not after: a hang-up that raced a start
      // still in flight would otherwise read a null `service`, answer "already
      // over", and leave the call it was meant to end running.
      return await serialize(async (): Promise<CtoVoiceActionResult> => {
        // A call nobody owns is already over; saying so is not a failure.
        if (!service) return { ok: true };
        if (ownerToken && token !== ownerToken) return NOT_OWNER;
        await endCurrentCall("owner_end");
        return { ok: true };
      });
    },

    async setMuted(args?: { ownerToken?: string; muted?: boolean }): Promise<CtoVoiceActionResult> {
      const token = readOwnerToken(args);
      if (!touchOwner(token)) return NOT_OWNER;
      service?.setMuted(Boolean(args?.muted));
      return { ok: true };
    },

    /**
     * Microphone frames from the owning window, batched. Not awaited on the
     * desktop side: a reply per frame would be pure overhead on the busiest
     * path in the app.
     */
    pushAudio(args?: {
      ownerToken?: string;
      chunks?: string[];
      audio?: string;
      level?: number;
      levels?: number[];
    }): CtoVoiceActionResult {
      const token = readOwnerToken(args);
      if (!touchOwner(token)) return NOT_OWNER;
      const chunks = readAudioChunks(args);
      if (!chunks.length) return { ok: true };
      const level = typeof args?.level === "number" ? args.level : undefined;
      const levels = readAudioLevels(args);
      // This action must not reject. Ten times a second the desktop pump calls
      // it, and a rejection there reads as "the runtime is gone": the pump ends
      // the call locally, which used to drop the state subscription before the
      // runtime's own failure could be forwarded, leaving the HUD counting time
      // and cost against a call that had already been refused.
      try {
        for (let index = 0; index < chunks.length; index += 1) {
          // Each frame is credited ITS OWN level. Every frame in the batch needs
          // one — the transcript gate can only count a frame it was given a
          // level for, and crediting one frame per ~100 ms batch undercounted
          // real speech by half — but they must not all be credited the batch
          // MAXIMUM either, which turned one transient into ten loud frames and
          // helped a hallucinated transcript clear the gate. `levels` is absent
          // on an older desktop; there the batch maximum is still the best the
          // caller knows. The call service emits one meter update per distinct
          // level, so the HUD sees no more traffic than before.
          service?.pushAudio(chunks[index]!, levels[index] ?? level);
        }
      } catch (error) {
        host.logger?.warn("cto_voice.push_audio_failed", { error: String(error) });
        return { ok: false, error: "push-audio-failed", detail: String(error) };
      }
      return { ok: true };
    },

    /** Drain queued output audio. The owner polls this while a call is live. */
    pullAudio(args?: { ownerToken?: string }): CtoVoicePullAudioResult {
      const token = readOwnerToken(args);
      if (!touchOwner(token)) return { ...NOT_OWNER, chunks: [], dropped: 0 };
      return { ok: true, ...outputAudio.drain() };
    },

    async resolveApproval(args?: {
      ownerToken?: string;
      approvalId?: string;
      approved?: boolean;
    }): Promise<CtoVoiceActionResult> {
      const token = readOwnerToken(args);
      if (!touchOwner(token)) return NOT_OWNER;
      const approvalId = typeof args?.approvalId === "string" ? args.approvalId : "";
      if (!approvalId) return { ok: false, error: "bad-request", detail: "no approval was named" };
      if (args?.approved) service?.approve(approvalId);
      else service?.deny(approvalId);
      return { ok: true };
    },

    /**
     * Hand the call a window the user is looking at. The image goes to the CTO
     * thread, never to the voice model, which cannot read one.
     */
    async sendCapture(args?: {
      ownerToken?: string;
      pngBase64?: string;
      note?: string;
    }): Promise<CtoVoiceActionResult> {
      const token = readOwnerToken(args);
      if (!touchOwner(token)) return NOT_OWNER;
      const pngBase64 = typeof args?.pngBase64 === "string" ? args.pngBase64 : "";
      if (!pngBase64) return { ok: false, error: "bad-request", detail: "the capture carried no image" };
      service?.attachImage({ pngBase64, note: typeof args?.note === "string" ? args.note : "" });
      return { ok: true };
    },

    /**
     * Local state subscription for the in-process path. The runtime path reads
     * the same states off the `cto_voice` event category instead.
     */
    subscribeState(listener: (next: CtoVoiceState) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    dispose(): void {
      stopWatchdog();
      listeners.clear();
      void serialize(() => endCurrentCall("dispose"));
    },
  };
}
