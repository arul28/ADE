import { useSyncExternalStore } from "react";
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
 * chat's id, `null` for "ended", or a start still in flight. A row value wins
 * again as soon as it agrees with nothing here to override.
 */
type SideChatEntry =
  | { kind: "open"; sideSessionId: string }
  /** The side chat this window ended; a different one on the row is newer. */
  | { kind: "ended"; sideSessionId: string | null }
  | { kind: "starting"; prompt: string; error?: string | null };

const entries = new Map<string, SideChatEntry>();
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

export function noteSideChat(mainSessionId: string, sideSessionId: string | null): void {
  const previous = entries.get(mainSessionId);
  entries.set(mainSessionId, sideSessionId
    ? { kind: "open", sideSessionId }
    : { kind: "ended", sideSessionId: previous?.kind === "open" ? previous.sideSessionId : null });
  emit();
}

export function noteSideChatStarting(mainSessionId: string, prompt: string): void {
  entries.set(mainSessionId, { kind: "starting", prompt });
  emit();
}

export function noteSideChatStartFailed(mainSessionId: string, prompt: string, error: string): void {
  entries.set(mainSessionId, { kind: "starting", prompt, error });
  emit();
}

export type SideChatView =
  | { kind: "none" }
  | { kind: "open"; sideSessionId: string }
  | { kind: "starting"; prompt: string; error: string | null };

/** The main chat's side chat: this window's newer answer, else the row's. */
export function resolveSideChatView(
  mainSessionId: string | null | undefined,
  rowSideSessionId: string | null | undefined,
): SideChatView {
  if (!mainSessionId) return { kind: "none" };
  const entry = entries.get(mainSessionId);
  if (entry?.kind === "starting") return { kind: "starting", prompt: entry.prompt, error: entry.error ?? null };
  if (entry?.kind === "open") return { kind: "open", sideSessionId: entry.sideSessionId };
  if (entry?.kind === "ended" && (!rowSideSessionId || !entry.sideSessionId || rowSideSessionId === entry.sideSessionId)) {
    return { kind: "none" };
  }
  return rowSideSessionId ? { kind: "open", sideSessionId: rowSideSessionId } : { kind: "none" };
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
    await window.ade.agentChat.endSideChat({ sessionId: mainSessionId }, runtimePin);
    noteSideChat(mainSessionId, null);
  } catch (error) {
    showToast({
      tone: "error",
      title: "Couldn't end the side chat",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
