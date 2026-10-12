import type { QuitPromptChoice, QuitPromptRequest } from "./types";

/** "1 agent", "3 agents". */
export function agentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}

/** "1 agent is", "3 agents are". */
export function agentsAre(count: number): string {
  return `${agentCount(count)} ${count === 1 ? "is" : "are"}`;
}

/** "it", "them". */
export function agentsPronoun(count: number): string {
  return count === 1 ? "it" : "them";
}

export type QuitPromptAction = {
  choice: QuitPromptChoice;
  label: string;
  /** The default: focused in ADE's dialog, `defaultId` in the native box. */
  primary?: boolean;
};

export type QuitPromptModel = {
  title: string;
  description: string;
  tone: "accent" | "warning";
  /** "Don't ask again", unticked. Never offered when quitting stops agents. */
  offerDontAskAgain: boolean;
  /** In display order, the cancel action first. */
  actions: QuitPromptAction[];
};

function appOwnedFix(
  repair: NonNullable<QuitPromptRequest["appOwnedService"]>["repair"],
  count: number,
  canRepair: boolean,
): string {
  if (repair === "system_settings") {
    return "Turn on ADE under Allow in the Background, and agents keep going after you quit.";
  }
  if (repair === "wait") return "ADE keeps trying to restart the service on its own.";
  const where = canRepair ? "" : " from the banner in ADE";
  if (count === 0) return `Repair it${where}, and agents keep going after you quit.`;
  return `Repair it${where} first: they pick up where they left off and keep going after you quit.`;
}

/**
 * The quit confirmation: words and buttons, shared by ADE's dialog and the
 * native box main falls back to, so the two never disagree. `canRepair` is
 * false for the native box, which has nowhere to show a repair's progress.
 */
export function quitPromptModel(request: QuitPromptRequest, options: { canRepair: boolean }): QuitPromptModel {
  const verb = request.relaunch ? "Restart" : "Quit";
  const count = request.runningAgents;
  const owned = request.appOwnedService;
  if (owned) {
    const stops = count > 0
      ? `ADE is running ${agentCount(count)} itself for now, so ${request.relaunch ? "restarting" : "quitting"} stops ${agentsPronoun(count)}.`
      : "ADE is running it itself for now.";
    const repairLabel = owned.repair === "system_settings" ? "Open System Settings" : "Repair service";
    const offerRepair = options.canRepair && owned.repair !== "wait";
    return {
      title: "ADE's background service isn't running",
      description: `${stops} ${appOwnedFix(owned.repair, count, options.canRepair)}`,
      tone: "warning",
      offerDontAskAgain: false,
      actions: [
        { choice: "keep", label: "Keep ADE open", primary: !offerRepair },
        { choice: "quit", label: `${verb} anyway` },
        ...(offerRepair ? [{ choice: "repair" as const, label: repairLabel, primary: true }] : []),
      ],
    };
  }
  let description = "Your agents keep running in the background. Open ADE any time to check on them.";
  if (count > 0) description = `${agentsAre(count)} working and will keep going in the background.`;
  else if (request.relaunch) description = "Your agents keep running in the background while ADE restarts.";
  return {
    title: `${verb} ADE?`,
    description,
    tone: "accent",
    offerDontAskAgain: true,
    actions: [
      { choice: "keep", label: "Keep ADE open" },
      { choice: "quit", label: `${verb} ADE`, primary: true },
    ],
  };
}
