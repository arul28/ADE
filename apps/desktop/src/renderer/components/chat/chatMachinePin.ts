import type { OpenProjectBinding } from "../../../shared/types";

/** Said when a chat-scoped call has no computer to go to. */
export const NO_CHAT_MACHINE_MESSAGE = "The computer this runs on is not connected.";

/**
 * The chat's computer, for a call that must name one. A missing pin is an
 * error, never "the tab's computer": the call would reach the wrong machine.
 */
export function requireChatPin(pin: OpenProjectBinding | null | undefined): OpenProjectBinding {
  if (!pin) throw new Error(NO_CHAT_MACHINE_MESSAGE);
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
  return pin ? call(pin) : Promise.reject(new Error(NO_CHAT_MACHINE_MESSAGE));
}
