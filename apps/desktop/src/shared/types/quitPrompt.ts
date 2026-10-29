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
  /** Chats with a live turn right now; null when ADE could not check in time. */
  runningAgents: number | null;
  appOwnedService: QuitPromptAppOwnedService | null;
  /**
   * A downloaded update with automatic install on. `installs`: this quit
   * installs it; false: it waits so running work is not stopped. Absent when
   * no update is waiting, or for a restart.
   */
  updateOnQuit?: { version: string; installs: boolean } | null;
};

/**
 * `repair` restarts the service. `system_settings` opens macOS's Allow in the
 * Background, which only the person can change, so ADE stays open.
 */
export type QuitPromptChoice = "quit" | "keep" | "repair" | "system_settings";

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

/**
 * What is working right now, as far as ADE can tell. Null in a summary when
 * ADE could not check in time: unknown is never read as "nothing running".
 */
export type BackgroundServiceActivity = {
  /** Chats with a live turn in projects open in ADE; stopping ends them. */
  runningChats: UpdateInterruptedChat[];
  /**
   * The service reports busy projects (agents, shells, active sessions)
   * beyond the ones the listed chats account for. A flag per project, not an
   * agent count, so the UI says "may".
   */
  otherProjectsBusy: boolean;
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
  activity: BackgroundServiceActivity | null;
};

/** What the person saw and agreed to stop; main refuses if more is running now. */
export type StopBackgroundServiceRequest = {
  confirmedSessionIds: string[];
  confirmedOtherProjectsBusy: boolean;
};

export type StopBackgroundServiceResult =
  | { ok: true }
  | { ok: false; message: string };
