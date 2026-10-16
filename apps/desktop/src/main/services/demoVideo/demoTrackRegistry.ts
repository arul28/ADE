/**
 * The action tracks of the recordings that are running in this process.
 *
 * A demo needs to know what happened on the screen and why: where each click
 * landed, when the agent was thinking and when it waited on a tool, when a
 * page was loading. The recorders only see pixels, so every surface reports
 * its actions here under the recording's key, and the recording's stop hands
 * the finished {@link DemoTrack} to the planner.
 *
 * Keys are `<surface>:<id>`: `mac-desktop:<laneId>`, `apple:<deviceKey>`,
 * `app-control:<laneId>`, `browser:<tabId>`. Noting to a key that has no
 * running recording does nothing, so an action path can report without first
 * asking whether anything records it.
 *
 * Times are wall-clock milliseconds until the recording's first frame is
 * known (`markFirstFrame`); `end` measures everything from that frame. An
 * event before it is placed at 0.
 *
 * One registry per process: the brain feeds it from chat events and from the
 * Mac Desktop, Apple and App Control services; the desktop app feeds it from
 * the built-in browser and the App Control screencast recorder.
 */

import type {
  DemoAgentSpan,
  DemoSurface,
  DemoTimeSpan,
  DemoTrack,
  DemoTrackEvent,
} from "../../../shared/demoVideo/demoContract";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";

type NotedEvent = Omit<DemoTrackEvent, "t"> & { atMs: number };

type Entry = {
  surface: DemoSurface;
  chatSessionId: string | null;
  laneId: string | null;
  zoom: boolean;
  beganAtMs: number;
  firstFrameAtMs: number | null;
  events: NotedEvent[];
  loads: Array<{ startMs: number; endMs: number | null }>;
  /** The newest action, load or step, for the idle stop. */
  lastActivityAtMs: number;
};

type ChatState = {
  /** Tool calls running now, by item id. Parallel tools overlap. */
  runningTools: Set<string>;
  /** Closed spans plus the open one, oldest first. Pruned by age. */
  spans: Array<{ state: DemoAgentSpan["state"]; startMs: number; endMs: number | null }>;
  /** False between turns: the agent is neither thinking nor waiting. */
  inTurn: boolean;
};

/** Longer than any recording may run, so a stop always finds its chat's spans. */
const CHAT_SPAN_RETENTION_MS = 15 * 60 * 1000;
/** A recording keeps at most this many events; a runaway action loop cannot grow it without bound. */
const MAX_EVENTS_PER_RECORDING = 5_000;
/** Labels are shown in the video; nothing longer is readable there. */
const MAX_LABEL_LENGTH = 80;

export type DemoTrackRegistry = ReturnType<typeof createDemoTrackRegistry>;

/** A recording's key: `mac-desktop:<laneId>`, `apple:<deviceKey>`, `app-control:<laneId>`, `browser:<tabId>`. */
export function demoRecordingKey(surface: DemoSurface, id: string): string {
  return `${surface}:${id}`;
}

function clampUnit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, 0), 1);
}

function cleanLabel(label: string | undefined): string | undefined {
  if (typeof label !== "string") return undefined;
  const flat = label.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > MAX_LABEL_LENGTH ? `${flat.slice(0, MAX_LABEL_LENGTH - 1)}…` : flat;
}

export function createDemoTrackRegistry(deps: { now?: () => number } = {}) {
  const now = deps.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  const chats = new Map<string, ChatState>();
  /**
   * Recordings this process only hears about (a browser recording runs in the
   * desktop app): key → owning chat and when the note stops counting, so a
   * stop that never reaches here cannot leave a chat "recording" forever.
   */
  const external = new Map<string, { chatSessionId: string; expiry: ReturnType<typeof setTimeout> }>();
  const recordingListeners = new Set<(chatSessionId: string, recording: boolean) => void>();

  const chatIsRecording = (chatSessionId: string): boolean => {
    for (const entry of entries.values()) if (entry.chatSessionId === chatSessionId) return true;
    // A note counts until a stop or its expiry timer removes it; the timer
    // tells the listeners, so a status never stays on after it.
    for (const note of external.values()) if (note.chatSessionId === chatSessionId) return true;
    return false;
  };
  /** Tells listeners when a chat starts or stops having any recording. */
  const withRecordingChange = (chatSessionId: string | null, change: () => void): void => {
    if (!chatSessionId) {
      change();
      return;
    }
    const before = chatIsRecording(chatSessionId);
    change();
    const after = chatIsRecording(chatSessionId);
    if (before === after) return;
    for (const listener of recordingListeners) {
      try {
        listener(chatSessionId, after);
      } catch {
        // A listener that throws must not break the recording it heard about.
      }
    }
  };

  const chatState = (chatSessionId: string): ChatState => {
    let state = chats.get(chatSessionId);
    if (!state) {
      state = { runningTools: new Set(), spans: [], inTurn: false };
      chats.set(chatSessionId, state);
    }
    return state;
  };

  /** Closes the open span and opens `next` (or nothing, between turns). */
  const switchSpan = (state: ChatState, next: DemoAgentSpan["state"] | null, atMs: number): void => {
    const open = state.spans[state.spans.length - 1];
    if (open && open.endMs === null) {
      if (open.state === next) return;
      open.endMs = Math.max(atMs, open.startMs);
    }
    if (next) state.spans.push({ state: next, startMs: atMs, endMs: null });
    const horizon = atMs - CHAT_SPAN_RETENTION_MS;
    while (state.spans.length > 0 && state.spans[0]!.endMs !== null && state.spans[0]!.endMs! < horizon) {
      state.spans.shift();
    }
  };

  const toSeconds = (entry: Entry, atMs: number): number => {
    const zero = entry.firstFrameAtMs ?? entry.beganAtMs;
    return Math.max(0, (atMs - zero) / 1000);
  };

  return {
    /** A recording started. A second `begin` on a running key replaces it. */
    begin(key: string, args: { surface: DemoSurface; chatSessionId: string | null; laneId?: string | null; zoom?: boolean; atMs?: number }): void {
      const atMs = args.atMs ?? now();
      const previous = entries.get(key)?.chatSessionId ?? null;
      if (previous && previous !== args.chatSessionId) withRecordingChange(previous, () => entries.delete(key));
      withRecordingChange(args.chatSessionId, () => entries.set(key, {
        surface: args.surface,
        chatSessionId: args.chatSessionId,
        laneId: args.laneId ?? null,
        zoom: args.zoom === true,
        beganAtMs: atMs,
        firstFrameAtMs: null,
        events: [],
        loads: [],
        lastActivityAtMs: atMs,
      }));
    },

    /** A running recording's caller asked for zoom after it started. */
    requestZoom(key: string): void {
      const entry = entries.get(key);
      if (entry) entry.zoom = true;
    },

    /** Does any recording this chat owns run right now? */
    isChatRecording(chatSessionId: string): boolean {
      return chatIsRecording(chatSessionId);
    },

    /** Hears each chat that starts or stops recording. Returns the unsubscribe. */
    onChatRecordingChange(listener: (chatSessionId: string, recording: boolean) => void): () => void {
      recordingListeners.add(listener);
      return () => recordingListeners.delete(listener);
    },

    /**
     * A recording that runs in another process started (`running: true`) or
     * stopped. Kept for at most `maxMs`, the longest any recording may run.
     */
    noteExternalRecording(key: string, chatSessionId: string | null, running: boolean, maxMs: number): void {
      const owner = running ? chatSessionId : external.get(key)?.chatSessionId ?? chatSessionId;
      withRecordingChange(owner, () => {
        const previous = external.get(key);
        if (previous?.expiry) clearTimeout(previous.expiry);
        external.delete(key);
        if (!running || !chatSessionId) return;
        // A stop that never arrives: the note ends at its expiry, and the
        // chat's status hears about it then.
        const expiry: ReturnType<typeof setTimeout> = setTimeout(() => {
          if (external.get(key)?.expiry !== expiry) return;
          withRecordingChange(chatSessionId, () => external.delete(key));
        }, maxMs);
        expiry.unref?.();
        external.set(key, { chatSessionId, expiry });
      });
    },

    /** The raw file's time 0, by the wall clock. The first call wins. */
    markFirstFrame(key: string, atMs?: number): void {
      const entry = entries.get(key);
      if (entry && entry.firstFrameAtMs === null) entry.firstFrameAtMs = atMs ?? now();
    },

    isRecording(key: string): boolean {
      return entries.has(key);
    },

    /** An action on the recorded screen. Points and rects are normalized to the recorded frame. */
    note(key: string, event: Omit<DemoTrackEvent, "t"> & { atMs?: number }): void {
      const entry = entries.get(key);
      if (!entry || entry.events.length >= MAX_EVENTS_PER_RECORDING) return;
      const atMs = event.atMs ?? now();
      const rect = event.rect && event.rect.every((value) => Number.isFinite(value))
        ? event.rect.map((value) => Math.min(Math.max(value, 0), 1)) as DemoTrackEvent["rect"]
        : undefined;
      entry.events.push({
        kind: event.kind,
        by: event.by,
        atMs,
        ...(clampUnit(event.x) !== undefined ? { x: clampUnit(event.x) } : {}),
        ...(clampUnit(event.y) !== undefined ? { y: clampUnit(event.y) } : {}),
        ...(rect ? { rect } : {}),
        ...(cleanLabel(event.label) ? { label: cleanLabel(event.label) } : {}),
      });
      entry.lastActivityAtMs = Math.max(entry.lastActivityAtMs, atMs);
    },

    /** A page load started or finished on the recorded surface. */
    noteLoad(key: string, phase: "start" | "end", atMs?: number): void {
      const entry = entries.get(key);
      if (!entry) return;
      const at = atMs ?? now();
      const open = entry.loads[entry.loads.length - 1];
      if (phase === "start") {
        if (open && open.endMs === null) return;
        entry.loads.push({ startMs: at, endMs: null });
      } else if (open && open.endMs === null) {
        open.endMs = Math.max(at, open.startMs);
      }
      entry.lastActivityAtMs = Math.max(entry.lastActivityAtMs, at);
    },

    /**
     * A step caption for every running recording in scope: the lane's, or the
     * chat's when no lane is given. Returns how many recordings took it.
     */
    noteStep(scope: { laneId?: string | null; chatSessionId?: string | null }, text: string, atMs?: number): number {
      const label = cleanLabel(text);
      if (!label) return 0;
      let noted = 0;
      for (const entry of entries.values()) {
        const inScope = scope.laneId
          ? entry.laneId === scope.laneId
          : Boolean(scope.chatSessionId) && entry.chatSessionId === scope.chatSessionId;
        if (!inScope || entry.events.length >= MAX_EVENTS_PER_RECORDING) continue;
        const at = atMs ?? now();
        entry.events.push({ kind: "step", by: "agent", label, atMs: at });
        entry.lastActivityAtMs = Math.max(entry.lastActivityAtMs, at);
        noted += 1;
      }
      return noted;
    },

    /** Wall-clock ms of the newest action, load or step, or null when the key is not recording. */
    lastActivityAt(key: string): number | null {
      return entries.get(key)?.lastActivityAtMs ?? null;
    },

    // -- Agent state, from the chat's own events ------------------------------

    noteTurnStarted(chatSessionId: string, atMs?: number): void {
      const state = chatState(chatSessionId);
      state.inTurn = true;
      state.runningTools.clear();
      switchSpan(state, "thinking", atMs ?? now());
    },

    noteToolStarted(chatSessionId: string, itemId: string, atMs?: number): void {
      const state = chatState(chatSessionId);
      state.inTurn = true;
      state.runningTools.add(itemId);
      switchSpan(state, "tool", atMs ?? now());
    },

    noteToolFinished(chatSessionId: string, itemId: string, atMs?: number): void {
      const state = chats.get(chatSessionId);
      if (!state) return;
      state.runningTools.delete(itemId);
      if (state.runningTools.size === 0 && state.inTurn) switchSpan(state, "thinking", atMs ?? now());
    },

    noteTurnEnded(chatSessionId: string, atMs?: number): void {
      const state = chats.get(chatSessionId);
      if (!state) return;
      const at = atMs ?? now();
      state.inTurn = false;
      state.runningTools.clear();
      switchSpan(state, null, at);
      // Every chat that emits events gets a state here. One whose last span
      // ended before the retention horizon can tell no recording anything.
      const horizon = at - CHAT_SPAN_RETENTION_MS;
      for (const [id, chat] of chats) {
        const last = chat.spans[chat.spans.length - 1];
        if (!chat.inTurn && (!last || (last.endMs !== null && last.endMs < horizon))) chats.delete(id);
      }
    },

    /** The recording stopped: its finished track, measured from its first frame. */
    end(key: string, args: { durationSeconds: number; atMs?: number }): DemoTrack | null {
      const entry = entries.get(key);
      if (!entry) return null;
      withRecordingChange(entry.chatSessionId, () => entries.delete(key));
      const endMs = args.atMs ?? now();
      const zeroMs = entry.firstFrameAtMs ?? entry.beganAtMs;
      const duration = Math.max(0, args.durationSeconds);
      const clip = (seconds: number) => Math.min(Math.max(seconds, 0), duration);

      const agentSpans: DemoAgentSpan[] = [];
      const chat = entry.chatSessionId ? chats.get(entry.chatSessionId) : undefined;
      for (const span of chat?.spans ?? []) {
        const start = clip((span.startMs - zeroMs) / 1000);
        const end = clip(((span.endMs ?? endMs) - zeroMs) / 1000);
        if (end > start) agentSpans.push({ state: span.state, start, end });
      }

      const loadSpans: DemoTimeSpan[] = [];
      for (const load of entry.loads) {
        const start = clip((load.startMs - zeroMs) / 1000);
        const end = clip(((load.endMs ?? endMs) - zeroMs) / 1000);
        if (end > start) loadSpans.push({ start, end });
      }

      const events: DemoTrackEvent[] = entry.events
        .map(({ atMs, ...rest }) => ({ ...rest, t: clip(toSeconds(entry, atMs)) }))
        .sort((a, b) => a.t - b.t);

      return {
        version: 1,
        surface: entry.surface,
        durationSeconds: duration,
        events,
        agentSpans,
        loadSpans,
        ...(entry.zoom ? { zoom: true } : {}),
      };
    },

    /** The recording ended with nothing to file. */
    discard(key: string): void {
      withRecordingChange(entries.get(key)?.chatSessionId ?? null, () => entries.delete(key));
    },
  };
}

/** The process-wide registry every surface reports to. */
export const demoTrackRegistry = createDemoTrackRegistry();

/**
 * Feeds the agent's state from its own chat events: a turn starts thinking, a
 * tool call (or a shell command) runs a tool until its result, and `done` ends
 * the turn. Every provider emits these, so the demo knows when the agent was
 * thinking and when it waited, whoever the provider is.
 */
export function feedDemoTrackFromChatEvent(
  envelope: AgentChatEventEnvelope,
  registry: DemoTrackRegistry = demoTrackRegistry,
): void {
  const sessionId = envelope.sessionId;
  const event = envelope.event;
  const parsed = Date.parse(envelope.timestamp);
  const atMs = Number.isFinite(parsed) ? parsed : undefined;
  switch (event.type) {
    case "status":
      if (event.turnStatus === "started") registry.noteTurnStarted(sessionId, atMs);
      else registry.noteTurnEnded(sessionId, atMs);
      break;
    case "done":
      registry.noteTurnEnded(sessionId, atMs);
      break;
    case "tool_call":
      registry.noteToolStarted(sessionId, event.itemId, atMs);
      break;
    case "tool_result":
      registry.noteToolFinished(sessionId, event.itemId, atMs);
      break;
    case "command":
      if (event.status === "running") registry.noteToolStarted(sessionId, event.itemId, atMs);
      else registry.noteToolFinished(sessionId, event.itemId, atMs);
      break;
    default:
      break;
  }
}
