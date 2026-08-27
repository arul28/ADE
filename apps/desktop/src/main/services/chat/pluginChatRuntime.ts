/**
 * The plugin chat-runtime seam — a plugin owning an ADE conversation.
 *
 * ## Why a module-level bus, a third time
 *
 * The same argument `pluginEvents.ts` and `pluginRuntimeHooks.ts` make, except
 * this one runs in BOTH directions and that is the only new thing about it.
 * A project's `agentChatService` is built in `bootstrap.ts` long before anyone
 * knows whether a plugin is installed; the plugin host is machine-scoped and
 * built beside it, knowing nothing about which projects are open. Threading a
 * handle either way would put a plugin dependency in the middle of the turn
 * loop and a chat dependency in the middle of the plugin host.
 *
 * So: the chat service registers a {@link PluginChatRuntimeWriter} (how to
 * write into a transcript), the plugin host registers a
 * {@link PluginChatRuntimeDelivery} (how to reach a plugin child), and each
 * side finds the other here. A machine with no plugins pays one null check per
 * turn; a machine with no projects open answers every plugin write with a
 * refusal rather than a crash.
 *
 * ## The one invariant
 *
 * **A plugin may write only into a session whose `runtimeRef.pluginId` is
 * itself.** That check is {@link requirePluginChatWriteTarget}, it is the only
 * door, and the plugin id it compares against is the one the HOST read off the
 * child connection — never a value the plugin passed in. A plugin can write
 * words the user reads as an agent's; the only question that matters is which
 * conversation, and the plugin does not get to answer it.
 *
 * ## What this module deliberately does not do
 *
 * It holds no state about conversations, runs no timers, and never talks to a
 * child process or a database. It is a lookup table with an ownership check.
 * Everything real happens on one side or the other, which is what keeps the
 * two sides testable without each other.
 */

import type { AgentChatRuntimeRef } from "../../../shared/types/chat";
import type { PluginManifestChatRuntimeCapabilities } from "../../../shared/plugins/manifest";
import {
  PluginSdkError,
  type PluginChatArtifact,
  type PluginChatAssistantChunk,
  type PluginChatAttachment,
  type PluginChatSessionCreateInput,
  type PluginChatSessionRef,
  type PluginChatStatus,
  type PluginChatTranscriptEntry,
  type PluginChatUserAppend,
} from "../../../shared/plugins/sdk";

// ---------------------------------------------------------------------------
// Chat service → plugin host
// ---------------------------------------------------------------------------

/** A user turn on its way to the plugin that owns the conversation. */
export type PluginChatRuntimeTurnDelivery = {
  ref: AgentChatRuntimeRef;
  sessionId: string;
  /** Absolute checkout the chat runs in. The host maps it to a project id. */
  projectRoot: string | null;
  turnId: string;
  message: string;
  attachments: PluginChatAttachment[];
  /** False for the conversation's first turn from ADE. */
  followUp: boolean;
};

export type PluginChatRuntimeInterruptDelivery = {
  ref: AgentChatRuntimeRef;
  sessionId: string;
  projectRoot: string | null;
  /** The turn the user asked to stop; null when the host knows of none. */
  turnId: string | null;
};

export type PluginChatRuntimePresenceDelivery = {
  ref: AgentChatRuntimeRef;
  sessionId: string;
  projectRoot: string | null;
  watching: boolean;
};

/**
 * What the host resolved from a plugin's manifest about one bound runtime.
 *
 * Null from {@link describePluginChatRuntime} means the binding is DEAD — the
 * plugin was uninstalled, disabled, or updated with that runtime removed. The
 * caller shows the conversation as unreachable; it never guesses a fallback
 * runtime, because dispatching a user's turn to a plugin that did not declare
 * it is worse than telling them nobody is home.
 */
export type PluginChatRuntimeDescriptor = {
  /** The runtime's own name: "Cursor Cloud". */
  displayName: string;
  /** Phosphor icon name from the manifest. */
  icon?: string;
  /** The owning plugin's display name. */
  pluginDisplayName: string;
  capabilities: PluginManifestChatRuntimeCapabilities;
};

/**
 * How the plugin host reaches a child. Registered by `pluginHostService`.
 *
 * `deliverTurn` and `deliverInterrupt` are RELIABLE: they start a stopped
 * child, wait for it, and reject with a `PluginSdkError` the chat service turns
 * into a visibly failed turn. `notifyPresence` is fire-and-forget for the
 * reason presence is a hint — see `PLUGIN_CHAT_RUNTIME_EVENTS`.
 */
export type PluginChatRuntimeDelivery = {
  deliverTurn(delivery: PluginChatRuntimeTurnDelivery): Promise<void>;
  deliverInterrupt(delivery: PluginChatRuntimeInterruptDelivery): Promise<void>;
  notifyPresence(delivery: PluginChatRuntimePresenceDelivery): void;
  describe(ref: AgentChatRuntimeRef): PluginChatRuntimeDescriptor | null;
};

let delivery: PluginChatRuntimeDelivery | null = null;

/**
 * Publish the plugin host's delivery side. Returns a detach function.
 *
 * Last writer wins, matching `setPluginActionInvoker`: there is one plugin host
 * per process, and a second registration means the first host was disposed.
 */
export function setPluginChatRuntimeDelivery(next: PluginChatRuntimeDelivery | null): () => void {
  delivery = next;
  return () => {
    if (delivery === next) delivery = null;
  };
}

/** Null on a machine with no plugin host attached — every headless test. */
export function getPluginChatRuntimeDelivery(): PluginChatRuntimeDelivery | null {
  return delivery;
}

/**
 * What a bound runtime is called and can do, or null when the binding is dead.
 *
 * Null-returning rather than throwing because "the plugin is gone" is an
 * ordinary state a session can be in — the user uninstalled it — and every
 * caller renders it rather than failing.
 */
export function describePluginChatRuntime(
  ref: AgentChatRuntimeRef | null | undefined,
): PluginChatRuntimeDescriptor | null {
  if (!ref || !delivery) return null;
  try {
    return delivery.describe(ref);
  } catch {
    // A host mid-teardown answers "unknown", never throws into a turn path.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin host → chat service
// ---------------------------------------------------------------------------

/**
 * The transcript-write side, registered by each project's `agentChatService`.
 *
 * Every method takes a session id the caller has ALREADY had checked by
 * {@link requirePluginChatWriteTarget}. The writer does not re-derive
 * ownership: one check, one place, one test.
 */
export type PluginChatRuntimeWriter = {
  /**
   * The absolute checkout this writer serves.
   *
   * Keyed on the ROOT rather than on a project id because the chat service is
   * built from a path and never learns the plugin surface's id for it. The
   * plugin host holds both on every binding, so it does the mapping — one side
   * knowing both beats two sides half-knowing each.
   */
  readonly projectRoot: string;
  /**
   * The plugin binding on a session this writer knows, or null.
   *
   * Null covers three different facts on purpose — no such session here, a
   * session with no plugin owner, and a session this writer cannot open — and
   * the caller treats all three the same way: not yours.
   */
  ownerOf(sessionId: string): AgentChatRuntimeRef | null;
  createSession(pluginId: string, input: PluginChatSessionCreateInput): Promise<PluginChatSessionRef>;
  appendAssistant(sessionId: string, chunk: PluginChatAssistantChunk): Promise<void>;
  appendUser(sessionId: string, input: PluginChatUserAppend): Promise<void>;
  emitStatus(sessionId: string, status: PluginChatStatus): Promise<void>;
  setArtifacts(sessionId: string, artifacts: PluginChatArtifact[]): Promise<void>;
  attachBranch(sessionId: string, input: { branch: string; remote?: string }): Promise<void>;
  hydrate(sessionId: string, transcript: PluginChatTranscriptEntry[]): Promise<void>;
};

const writers = new Set<PluginChatRuntimeWriter>();

/** Register one project's chat service. Returns a detach function. */
export function registerPluginChatRuntimeWriter(writer: PluginChatRuntimeWriter): () => void {
  writers.add(writer);
  return () => {
    writers.delete(writer);
  };
}

/**
 * The writer serving one project, for a call that names no session yet.
 *
 * Only `chat.createSession` needs this — every other verb is addressed by a
 * session id, which is globally unique and therefore identifies its project
 * without anybody having to say so.
 */
/**
 * Compare two checkout paths the way the platform they are on does.
 *
 * On Windows the same directory reaches these two sides spelled differently —
 * `C:\repo` from one record and `c:/repo` from another — and an exact string
 * compare would answer "no such project" for a project that is plainly open.
 * Separators are folded and case is folded only where the filesystem folds it,
 * because on Linux `/repo` and `/Repo` really are two directories.
 */
function sameProjectRoot(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return true;
  return process.platform === "win32" && a.toLowerCase() === b.toLowerCase();
}

export function findPluginChatRuntimeWriterForProjectRoot(
  projectRoot: string | null,
): PluginChatRuntimeWriter | null {
  if (!projectRoot) return null;
  for (const writer of writers) {
    if (sameProjectRoot(writer.projectRoot, projectRoot)) return writer;
  }
  return null;
}

/** Test seam and teardown aid. Production code detaches through the returned function. */
export function resetPluginChatRuntimeForTests(): void {
  writers.clear();
  delivery = null;
}

// ---------------------------------------------------------------------------
// The ownership gate
// ---------------------------------------------------------------------------

/**
 * The refusal every ownership failure answers with.
 *
 * One message for four different facts — no such session, an unowned session,
 * a session owned by another plugin, and a host with no project open — and
 * that is deliberate. A caller that could tell them apart could enumerate the
 * machine's sessions and their owners by probing this verb, which is exactly
 * the reconnaissance the check exists to prevent. The plugin's own sessions
 * are the ones it created; it needs no oracle for the rest.
 */
export function pluginChatNotOwned(sessionId: string): PluginSdkError {
  return new PluginSdkError(
    "not_permitted",
    `This plugin does not own chat session "${sessionId}".`,
  );
}

export type PluginChatWriteTarget = {
  writer: PluginChatRuntimeWriter;
  ref: AgentChatRuntimeRef;
};

/**
 * Resolve the session a plugin is allowed to write to, or throw.
 *
 * `pluginId` is the id the HOST derived from the child connection. Nothing in
 * `sessionId`'s neighbourhood is trusted: the session's own `runtimeRef` is
 * read from the chat service that owns it, and the comparison is exact.
 *
 * This is the entire enforcement surface of the chat seam. Every `sdk.chat.*`
 * verb but `createSession` passes through here, so widening it is a visible
 * change to one function rather than a missing check in one verb.
 */
export function requirePluginChatWriteTarget(pluginId: string, sessionId: string): PluginChatWriteTarget {
  for (const writer of writers) {
    const ref = writer.ownerOf(sessionId);
    if (!ref) continue;
    if (ref.pluginId !== pluginId) throw pluginChatNotOwned(sessionId);
    return { writer, ref };
  }
  throw pluginChatNotOwned(sessionId);
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * Ref-counted presence, generalized from `cursorCloudMirrorWatch`.
 *
 * Two clients on the same chat — a desktop pane and a phone — must produce ONE
 * `chat.opened` and one `chat.closed`, or a plugin's poll ladder restarts every
 * time a second viewer appears and stops while a first one is still looking.
 * The count is what makes "is anybody watching" a fact rather than a race.
 *
 * Unlike the Cursor watch this registry runs no timers: the plugin owns its own
 * polling inside its child, and the host's only job is to say when it matters.
 * That is the difference between this and `ade.schedules`, which is floored at
 * 60 seconds and cannot know who is looking.
 */
export function createPluginChatPresenceRegistry(args: {
  onChange: (sessionId: string, watching: boolean) => void;
}): {
  watch: (input: { sessionId: string; watching: boolean }) => void;
  isWatched: (sessionId: string) => boolean;
  clearAll: () => void;
} {
  const counts = new Map<string, number>();

  const watch = ({ sessionId, watching }: { sessionId: string; watching: boolean }): void => {
    const current = counts.get(sessionId) ?? 0;
    if (watching) {
      counts.set(sessionId, current + 1);
      // Only the 0→1 transition is news. Every later viewer joins a
      // conversation the plugin is already polling for.
      if (current === 0) args.onChange(sessionId, true);
      return;
    }
    if (current <= 0) return;
    const next = current - 1;
    if (next > 0) {
      counts.set(sessionId, next);
      return;
    }
    counts.delete(sessionId);
    args.onChange(sessionId, false);
  };

  return {
    watch,
    isWatched: (sessionId) => (counts.get(sessionId) ?? 0) > 0,
    clearAll: () => {
      // Told, not merely forgotten: a plugin left believing somebody is
      // watching polls a dead conversation until its child restarts.
      const watched = [...counts.keys()];
      counts.clear();
      for (const sessionId of watched) args.onChange(sessionId, false);
    },
  };
}
