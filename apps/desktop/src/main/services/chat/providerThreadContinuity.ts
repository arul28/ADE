import { isAcpChatProvider, type AgentChatProvider } from "../../../shared/types/chat";
import type { ThreadPointerLedgerEntry } from "./threadPointerLedger";

/**
 * Which provider-side thread a chat is talking to, and whether it has moved.
 *
 * Two things ride a turn only when the thread on the other end has NOT already
 * heard them: the conversation tail (~10 KB of re-orientation) and the CTO's
 * static context block (~21 KB of doctrine). Both need the same answer to the
 * same question, and it has exactly one correct source — the provider pointer
 * mapping below, which is also what the thread-pointer ledger is keyed on.
 */

/** Thread-ref placeholder used before a provider thread exists. */
export const UNOPENED_PROVIDER_THREAD_REF = "none";

/** Every field a provider might keep its thread pointer in. */
export type ThreadPointerFields = {
  provider: AgentChatProvider;
  threadId?: string | null;
  sdkSessionId?: string | null;
  providerSessionId?: string | null;
  droidSdkSessionId?: string | null;
  piSessionId?: string | null;
  piSessionFile?: string | null;
  cursorSdkAgentId?: string | null;
  cursorCloudAgentId?: string | null;
  acpSessionId?: string | null;
};

export type PersistedPointerState = {
  provider: ThreadPointerLedgerEntry["provider"];
  pointer: string | null;
};

export function normalizedPersistedPointer(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

/**
 * THE mapping from a chat's stored fields to the one pointer that names its
 * provider thread. Every reader goes through here rather than reimplementing
 * the switch — a second, hand-rolled copy had already drifted into omitting
 * codex and pi entirely, never reading `cursorCloudAgentId`, and missing the
 * `unified` → opencode fold.
 */
export function persistedPointerState(state: ThreadPointerFields): PersistedPointerState {
  // Every ACP provider stores its pointer in the same field, so they share one
  // arm rather than four identical ones.
  if (isAcpChatProvider(state.provider)) {
    return { provider: state.provider, pointer: normalizedPersistedPointer(state.acpSessionId) };
  }
  switch (state.provider) {
    case "codex":
      return { provider: state.provider, pointer: normalizedPersistedPointer(state.threadId) };
    case "claude":
      return { provider: state.provider, pointer: normalizedPersistedPointer(state.sdkSessionId) };
    case "opencode":
      return { provider: state.provider, pointer: normalizedPersistedPointer(state.providerSessionId) };
    case "unified":
      return { provider: "opencode", pointer: normalizedPersistedPointer(state.providerSessionId) };
    case "droid":
      return { provider: state.provider, pointer: normalizedPersistedPointer(state.droidSdkSessionId) };
    case "pi":
      return { provider: state.provider, pointer: normalizedPersistedPointer(state.piSessionId ?? state.piSessionFile) };
    case "cursor":
      return {
        provider: state.provider,
        pointer: normalizedPersistedPointer(state.cursorSdkAgentId)
          ?? normalizedPersistedPointer(state.cursorCloudAgentId),
      };
    default:
      return { provider: "opencode", pointer: normalizedPersistedPointer(state.providerSessionId) };
  }
}

export function pointerFingerprint(state: PersistedPointerState): string {
  return JSON.stringify([state.provider, state.pointer]);
}

/**
 * Identity of the provider-side thread this chat is currently talking to.
 *
 * A record rather than a packed `provider:ref` string, because every reader
 * wants the two halves separately and the packed form had to be re-split with a
 * hand-rolled parser that a ref containing a colon could confuse.
 */
export type ProviderThreadRef = {
  provider: ThreadPointerLedgerEntry["provider"];
  /** The provider's own thread id, or `UNOPENED_PROVIDER_THREAD_REF`. */
  ref: string;
  /**
   * The live runtime handle this ref was read from, compared by identity and
   * never by value.
   *
   * A thread's NAME is not stable even while the thread is: ADE mints the
   * Claude SDK session id itself before the first query and adopts whatever the
   * provider reports back, and the pointer for most providers lives only in the
   * runtime, so it reads as `none` whenever the prefix is rebuilt with the
   * runtime down. The runtime object is the thread. While it is the same
   * object, nothing has changed no matter what the conversation is called now.
   */
  instance?: unknown;
};

/**
 * A stable ref means the model still holds the conversation verbatim in its own
 * context; a changed one means it is a different thread (rotated agent, torn
 * down runtime, provider reset, model switch, fresh resume) that has never seen
 * the earlier turns. `none` is used while no thread exists yet, which reads as
 * "changed" against any real id and re-arms exactly once when the thread opens.
 */
export function providerThreadRef(
  pointers: ThreadPointerFields,
  instance?: unknown,
): ProviderThreadRef {
  const state = persistedPointerState(pointers);
  return {
    provider: state.provider,
    ref: state.pointer?.trim() || UNOPENED_PROVIDER_THREAD_REF,
    ...(instance == null ? {} : { instance }),
  };
}

/**
 * Did the provider thread actually change between two continuity keys?
 *
 * Three rules, in order:
 *
 * 1. A different provider is always a change — a handoff moves the
 *    conversation onto a model that has heard none of it.
 * 2. The same live runtime object is never a change, whatever the thread calls
 *    itself now. ADE names a Claude SDK session itself and then adopts the id
 *    the provider reports, so a fresh thread legitimately renames itself once;
 *    that is one thread learning its name, not a second thread.
 * 3. Otherwise compare the refs, treating `none` as UNKNOWN rather than as a
 *    different thread. The send path builds the turn prefix before it ensures
 *    the runtime, and most providers keep their pointer only in that runtime,
 *    so `none` shows up both before a thread opens and whenever the prefix is
 *    rebuilt with the runtime down. Counting either as a change re-staged the
 *    whole ~21 KB prefix on turns that were talking to the same thread all
 *    along, which is precisely the cost this key exists to avoid.
 */
export function providerThreadContinuityChanged(
  previous: ProviderThreadRef | null,
  next: ProviderThreadRef,
): boolean {
  if (previous === null) return true;
  if (previous.provider !== next.provider) return true;
  if (previous.instance != null && previous.instance === next.instance) return false;
  if (previous.ref === next.ref) return false;
  return previous.ref !== UNOPENED_PROVIDER_THREAD_REF
    && next.ref !== UNOPENED_PROVIDER_THREAD_REF;
}

/**
 * A prefix section that is sent once per provider thread rather than per turn.
 *
 * The conversation tail and the CTO's static context block are the same state
 * machine: arm when the thread (or, for the static block, the content) moves,
 * stay armed until a send actually carries the section, then go quiet. One
 * record type rather than two triples of loose fields, because they were kept
 * in step by hand across three construction sites.
 */
export type StagedSection = {
  /** The provider thread this section was last armed for; null before it ever was. */
  threadKey: ProviderThreadRef | null;
  /** Content identity as last staged, for a body that can change under a live thread. */
  contentKey: string | null;
  /** True once a key change armed the section and no send has consumed it yet. */
  pending: boolean;
};

/** A section that has never been armed: no thread, no content, nothing pending. */
export function newStagedSection(): StagedSection {
  return { threadKey: null, contentKey: null, pending: false };
}

/**
 * The thread this section was staged for is gone — a provider-side conversation
 * reset, or a cleared SDK session id that guarantees the next query opens a new
 * one. Forget it and arm.
 *
 * Needed because a reset does not necessarily change anything `armIfStale`
 * looks at: the runtime OBJECT survives these paths, and the runtime is the
 * thread's identity of last resort, so a reset that reuses the handle reads as
 * continuity. Clearing the key is how the next rebuild is told otherwise —
 * without it a brand-new provider session was never told the CTO's doctrine,
 * and the thread went on answering as a generic coding agent.
 */
export function resetStagedSection(staged: StagedSection): void {
  staged.threadKey = null;
  staged.contentKey = null;
  staged.pending = true;
}

/**
 * Stand a section down without sending it: something else is already carrying
 * that content this turn. The replay-overflow recovery is the one caller — it
 * re-sends the whole transcript, so the conversation tail on top of it would be
 * the same conversation twice, which is what overflowed the chat to begin with.
 */
export function suppressStagedSection(staged: StagedSection): void {
  staged.pending = false;
}

/**
 * Arm a staged section if the thread it was staged for has moved — or, for a
 * section that passes one, if its own content has.
 *
 * Arming is sticky: the turn context is rebuilt several times per turn and a
 * later rebuild must not disarm a section no send has carried yet, so `pending`
 * is only ever set here and only ever cleared by a send that delivered it.
 *
 * The recorded key advances on every call that KNOWS something. That is not
 * bookkeeping for its own sake: `none` → id is deliberately not a change, so a
 * key left at `none` would go on comparing every future thread against `none`
 * and never register a rotation at all — the section would be staged once in
 * the life of the chat. The converse matters just as much, so a real ref is
 * never overwritten by `none`: forgetting the thread a section was staged for
 * would make the NEXT real thread look like the same one.
 */
export function armIfStale(
  staged: StagedSection,
  threadKey: ProviderThreadRef,
  contentKey?: string,
): void {
  const threadMoved = providerThreadContinuityChanged(staged.threadKey, threadKey);
  const contentMoved = contentKey !== undefined && staged.contentKey !== contentKey;
  const learnedSomething = threadKey.ref !== UNOPENED_PROVIDER_THREAD_REF
    || staged.threadKey === null
    || staged.threadKey.provider !== threadKey.provider;
  if (learnedSomething) staged.threadKey = threadKey;
  if (contentKey !== undefined) staged.contentKey = contentKey;
  if (threadMoved || contentMoved) staged.pending = true;
}
