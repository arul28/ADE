import type { OpenProjectBinding } from "../../../shared/types";
import { AdeExpectedError } from "../../../shared/expectedError";
import { isRemoteConnectStoppedError } from "../../../shared/runtimeErrors";
import { isLinkLostReadError } from "../../state/projectMachines";

/** Said when a chat-scoped call has no computer to go to. */
export const NO_CHAT_MACHINE_MESSAGE = "The computer this runs on is not connected.";

/**
 * The chat's machine is not known yet (its lane is still resolving) or is not
 * connected: a state the caller shows or waits out, never a defect.
 */
export function noChatMachineError(): AdeExpectedError {
  return new AdeExpectedError(NO_CHAT_MACHINE_MESSAGE, "environment");
}

/**
 * The chat's computer, for a call that must name one. A missing pin is an
 * error, never "the tab's computer": the call would reach the wrong machine.
 */
export function requireChatPin(pin: OpenProjectBinding | null | undefined): OpenProjectBinding {
  if (!pin) throw noChatMachineError();
  return pin;
}

/**
 * Runs `call` on the chat's computer, or rejects with the same message when
 * the computer is not known. For promise chains that end in `.catch`.
 */
export function withChatPin<T>(
  pin: OpenProjectBinding | null | undefined,
  call: (pin: OpenProjectBinding) => Promise<T>,
): Promise<T> {
  if (!pin) return Promise.reject(noChatMachineError());
  // A call that throws before it returns a promise still ends in the chain's `.catch`.
  try {
    return call(pin);
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * The pin for a call through a personal chat's adapter. The adapter is bound
 * to its machine when it is made and ignores the pin, so this value never
 * reaches a runtime. Pass it only to the chat API of a personal pane.
 */
export const PERSONAL_CHAT_ADAPTER_PIN: OpenProjectBinding = Object.freeze({
  kind: "local",
  key: "personal-chat-adapter",
  rootPath: "",
  displayName: "Personal chat",
});

/** The pin for a call through a pane's chat API: the adapter's own for a bound (personal or shared) pane. */
export function chatApiPin(pin: OpenProjectBinding | null | undefined, bound: boolean): OpenProjectBinding | null {
  return bound ? PERSONAL_CHAT_ADAPTER_PIN : pin ?? null;
}

/**
 * A chat-scoped read that failed, as its section shows it. `unreachable`: only
 * the way to another computer was missing (its machine not known yet, the link
 * dropped or timed out, the computer asleep). A read on this computer is never
 * "unreachable": a hung local brain is a real failure, said with its raw error.
 * Neither is a link ADE stopped retrying until the person fixes it (sign in,
 * pair again, trust a key): its error says what to do, so it stays visible.
 */
export type ChatReadFailure = { unreachable: boolean; detail: string };

/** `pin` is the machine the read went to (null: not known yet). */
export function chatReadFailure(error: unknown, pin: OpenProjectBinding | null | undefined): ChatReadFailure {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  const unreachable = pin?.kind !== "local" && isLinkLostReadError(error) && !isRemoteConnectStoppedError(error);
  return { unreachable, detail: detail.trim() };
}
