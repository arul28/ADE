/**
 * Composer send/steer decision logic, kept pure so it can be tested without a
 * DOM and reused by hosts building their own composer.
 *
 * The rule the plan locks: submitting while a turn is running is a *steer*, not
 * a queued second turn. Interrupt is a separate, explicit control.
 */

import type { ThreadStatus } from "../sdkTypes";

export type ComposerAction =
  /** Start a new turn. */
  | { kind: "send"; text: string }
  /** Deliver into the turn already running. */
  | { kind: "steer"; text: string }
  /** Nothing to do. `reason` is safe to show as a hint. */
  | { kind: "blocked"; reason: ComposerBlockReason };

export type ComposerBlockReason =
  | "empty"
  | "disabled"
  | "no_thread"
  | "steer_unsupported";

export type ComposerStateInput = {
  draft: string;
  status: ThreadStatus["state"];
  /** False while the thread handle is still resolving. */
  ready: boolean;
  /** Host-level disable (read-only embed, quota exhausted, …). */
  disabled?: boolean;
  /** Host may opt out of steering; submits are then blocked mid-turn. */
  allowSteer?: boolean;
  /** Attachments alone are a valid submission. */
  hasAttachments?: boolean;
};

export type ComposerState = {
  action: ComposerAction;
  /** The primary button is actionable. */
  canSubmit: boolean;
  /** Show the stop control instead of relying on the send button. */
  canInterrupt: boolean;
  running: boolean;
  /** Label for the primary button. */
  submitLabel: string;
};

export function resolveComposerAction(input: ComposerStateInput): ComposerAction {
  const text = input.draft.trim();
  const running = input.status === "running";

  if (input.disabled) return { kind: "blocked", reason: "disabled" };
  if (!input.ready) return { kind: "blocked", reason: "no_thread" };
  if (!text.length && !input.hasAttachments) return { kind: "blocked", reason: "empty" };
  if (running) {
    if (input.allowSteer === false) return { kind: "blocked", reason: "steer_unsupported" };
    return { kind: "steer", text };
  }
  return { kind: "send", text };
}

export function resolveComposerState(input: ComposerStateInput): ComposerState {
  const action = resolveComposerAction(input);
  const running = input.status === "running";
  return {
    action,
    canSubmit: action.kind !== "blocked",
    canInterrupt: running && !input.disabled && input.ready,
    running,
    submitLabel: running ? "Steer" : "Send",
  };
}

/** Human hint for a blocked submit. Null when the block needs no explanation. */
export function blockedHint(reason: ComposerBlockReason): string | null {
  switch (reason) {
    case "empty":
      return null;
    case "disabled":
      return null;
    case "no_thread":
      return "Connecting…";
    case "steer_unsupported":
      return "Stop the current response before sending another message.";
  }
}

export type KeyIntent = "submit" | "newline" | "interrupt" | "none";

/**
 * Keyboard contract, matching the desktop composer:
 *   Enter submits, Shift+Enter is a newline (inverted by `sendOnEnter: false`,
 *   where Cmd/Ctrl+Enter submits instead). Escape interrupts a running turn.
 *   IME composition never submits.
 */
export function resolveKeyIntent(input: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  sendOnEnter: boolean;
  running: boolean;
  hasDraft: boolean;
}): KeyIntent {
  if (input.isComposing) return "none";

  if (input.key === "Escape") {
    // Escape only steals the key when there is a turn to stop; otherwise the
    // host's dialog/popover keeps its usual dismiss behaviour.
    return input.running ? "interrupt" : "none";
  }

  if (input.key !== "Enter") return "none";
  if (input.shiftKey) return "newline";

  const commandModified = input.metaKey || input.ctrlKey;
  const shouldSubmit = input.sendOnEnter ? !commandModified : commandModified;
  return shouldSubmit ? "submit" : "newline";
}
