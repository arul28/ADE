import { createContext, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { showToast } from "../app/toast/toastStore";
import { confirmDialog } from "../ui/dialog";

/**
 * Which side chat each main chat has, as this window last heard it.
 *
 * The session row (`TerminalSessionSummary.sideChatSessionId`) is the durable
 * answer, but it arrives with the next list refresh. A `/side` that just opened
 * a side chat, a `session_meta_updated` from the brain, or an End answered here
 * must show at once, so this holds the newer answer per main chat: a side
 * chat's id, an ended one, or a start still in flight. Once the row has had
 * time to catch up (`SIDE_CHAT_TRUST_MS`), a row that disagrees wins, so a
 * side chat another client ended or replaced shows as it is.
 */
type SideChatEntry =
  | { kind: "open"; sideSessionId: string; at: number }
  /** The side chat this window ended (null when it did not know which). */
  | { kind: "ended"; sideSessionId: string | null; at: number }
  | { kind: "starting"; prompt: string; error?: string };

/**
 * How long this window's own answer outranks a session row that disagrees:
 * the time a row needs to catch up. After it, the row wins, so a side chat
 * another client ended or replaced shows as it is. iOS uses the same window.
 */
const SIDE_CHAT_TRUST_MS = 30_000;

const entries = new Map<string, SideChatEntry>();
/** The side chat the Side chat tool last drew for each main chat: what End means. */
const shownSideChats = new Map<string, string>();

/** The Side chat tool calls this for the side chat it draws. */
export function rememberShownSideChat(mainSessionId: string, sideSessionId: string): void {
  shownSideChats.set(mainSessionId, sideSessionId);
}
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getVersion = (): number => version;

/** The main chat's side chat as this window just learned it; null for "ended". */
export function noteSideChat(mainSessionId: string, sideSessionId: string | null): void {
  if (!sideSessionId) {
    const previous = entries.get(mainSessionId);
    noteSideChatEnded(mainSessionId, previous?.kind === "open" ? previous.sideSessionId : null);
    return;
  }
  entries.set(mainSessionId, { kind: "open", sideSessionId, at: Date.now() });
  emit();
}

/** This window ended `endedSessionId` (the id `endSideChat` answered). */
export function noteSideChatEnded(mainSessionId: string, endedSessionId: string | null): void {
  entries.set(mainSessionId, { kind: "ended", sideSessionId: endedSessionId, at: Date.now() });
  emit();
}

/** A start in flight for `prompt`. */
export function noteSideChatStarting(mainSessionId: string, prompt: string): void {
  entries.set(mainSessionId, { kind: "starting", prompt });
  emit();
}

/** The start for `prompt` failed; the panel shows `error` beside it. */
export function noteSideChatStartFailed(mainSessionId: string, prompt: string, error: string): void {
  entries.set(mainSessionId, { kind: "starting", prompt, error });
  emit();
}

/**
 * True inside the Side chat tool's transcript, where an assistant reply's
 * `<send_to_main>` block is drawn as a "Sent to the main chat" note. Other
 * transcripts show a reply as written.
 */
export const SideChatTranscriptContext = createContext(false);

export type SideChatView =
  | { kind: "none" }
  | { kind: "open"; sideSessionId: string }
  | { kind: "starting"; prompt: string; error: string | null };

/** The main chat's side chat: this window's newer answer, else the row's. */
export function resolveSideChatView(
  mainSessionId: string | null | undefined,
  rowSideSessionId: string | null | undefined,
  now = Date.now(),
): SideChatView {
  if (!mainSessionId) return { kind: "none" };
  const row = rowSideSessionId?.trim() || null;
  const entry = entries.get(mainSessionId);
  const fromRow = (): SideChatView => (row ? { kind: "open", sideSessionId: row } : { kind: "none" });
  if (!entry) return fromRow();
  if (entry.kind === "starting") return { kind: "starting", prompt: entry.prompt, error: entry.error ?? null };
  const trusted = now - entry.at < SIDE_CHAT_TRUST_MS;
  if (entry.kind === "open") {
    return row === entry.sideSessionId || trusted ? { kind: "open", sideSessionId: entry.sideSessionId } : fromRow();
  }
  // Ended here: the row still naming that chat (or, unknown which, any chat
  // during the trust window) is the row not having caught up.
  if (!row || row === entry.sideSessionId || (entry.sideSessionId == null && trusted)) return { kind: "none" };
  return fromRow();
}

export function useSideChatView(
  mainSessionId: string | null | undefined,
  rowSideSessionId: string | null | undefined,
): SideChatView {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return resolveSideChatView(mainSessionId, rowSideSessionId);
}

/**
 * Closing the Side chat tab asks what to do with the chat behind it. "Hide"
 * (also Escape) closes only the tab, and Tools brings it back; "End side chat"
 * deletes it, on the main chat's machine. Always asked: ending cannot be undone.
 * Resolves true when the tab should close.
 */
export async function confirmSideChatToolClose(args: {
  mainSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}): Promise<boolean> {
  const { mainSessionId, runtimePin } = args;
  if (!mainSessionId) return true;
  const end = await confirmDialog({
    title: "Close the side chat?",
    message: "Hide keeps it, and you can open it again from Tools. Ending it deletes it for good.",
    confirmLabel: "End side chat",
    cancelLabel: "Hide",
    destructive: true,
  });
  if (!end) return true;
  try {
    // The main chat's id: the brain ends whichever side chat it has.
    // The side chat this window shows: if another client replaced it, the
    // brain refuses rather than deleting one the user never saw here.
    const shown = shownSideChats.get(mainSessionId);
    const result = await window.ade.agentChat.endSideChat(
      { sessionId: mainSessionId, ...(shown ? { expectedSideSessionId: shown } : {}) },
      runtimePin,
    );
    noteSideChatEnded(mainSessionId, result.endedSessionId);
  } catch (error) {
    showToast({
      tone: "error",
      title: "Couldn't end the side chat",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
