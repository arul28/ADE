import type { UpdateInterruptedChat } from "./core";

/**
 * Who would stop agents if ADE quit. Null in the normal case: agents run in
 * the background service and keep going after the desktop quits. Set only
 * when the desktop is running the service itself, the one case where quitting
 * stops agents, with the fix ADE can offer from the prompt:
 * - `restart`: the service could not start; a restart can hand agents over.
 * - `system_settings`: macOS refuses the background item; only the person can allow it.
 * - `wait`: ADE is already retrying on its own (an isolated brain).
 */
export type QuitPromptAppOwnedService = {
  repair: "restart" | "system_settings" | "wait";
};

/** The quit confirmation main asks a window to show. */
export type QuitPromptRequest = {
  requestId: string;
  relaunch: boolean;
  /** Chats with a live turn right now. */
  runningAgents: number;
  appOwnedService: QuitPromptAppOwnedService | null;
};

export type QuitPromptChoice = "quit" | "keep" | "repair";

/** The window's answer; the "it is on screen" signal is a separate send. */
export type QuitPromptAnswer = {
  requestId: string;
  choice: QuitPromptChoice;
  dontAskAgain: boolean;
};

/** The outcome of a "Repair service" answer, once the repair has finished. */
export type QuitPromptRepairResult = {
  repaired: boolean;
  /** Chats queued to pick up where they stopped. */
  resumedChats: number;
};

/** Settings → Background service: what is running, and whether it can be stopped here. */
export type BackgroundServiceSummary = {
  /**
   * False in a dev build and wherever ADE does not manage the login service,
   * so a dev app can never stop the installed service.
   */
  manageable: boolean;
  /** `service`: the login service runs agents. `desktop`: this app runs them itself. */
  runner: "service" | "desktop";
  /** Chats with a live turn right now; stopping ends them. */
  runningChats: UpdateInterruptedChat[];
};

export type StopBackgroundServiceResult =
  | { ok: true }
  | { ok: false; message: string };
