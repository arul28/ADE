import { pluralCount } from "./formatting";
import type { QuitPromptChoice, QuitPromptRequest } from "./types";

/** "1 agent is", "3 agents are". */
export function agentsAre(count: number): string {
  return `${pluralCount(count, "agent")} ${count === 1 ? "is" : "are"}`;
}

/** "it", "they" as a subject; "it", "them" as an object. */
export function agentsPronoun(count: number, role: "subject" | "object"): string {
  if (count === 1) return "it";
  return role === "subject" ? "they" : "them";
}

type QuitPromptAction = {
  choice: QuitPromptChoice;
  label: string;
  /** The default: focused in ADE's dialog, `defaultId` in the native box. */
  primary?: boolean;
};

type QuitPromptModel = {
  title: string;
  description: string;
  tone: "accent" | "warning";
  /** The "Don't ask again" checkbox, unticked. Null when quitting stops agents. */
  dontAskAgainLabel: string | null;
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
 * native box main falls back to. The one difference is `canRepair`: false for
 * the native box, which has nowhere to show a repair's progress, so it offers
 * no repair action and points at the banner instead.
 */
export function quitPromptModel(request: QuitPromptRequest, options: { canRepair: boolean }): QuitPromptModel {
  const verb = request.relaunch ? "Restart" : "Quit";
  const count = request.runningAgents;
  const owned = request.appOwnedService;
  if (owned) {
    const stops = count > 0
      ? `ADE is running ${pluralCount(count, "agent")} itself for now, so ${request.relaunch ? "restarting" : "quitting"} stops ${agentsPronoun(count, "object")}.`
      : "ADE is running it itself for now.";
    const offerRepair = options.canRepair && owned.repair !== "wait";
    const fixAction: QuitPromptAction = owned.repair === "system_settings"
      ? { choice: "settings", label: "Open System Settings", primary: true }
      : { choice: "repair", label: "Repair service", primary: true };
    return {
      title: "ADE's background service isn't running",
      description: `${stops} ${appOwnedFix(owned.repair, count, options.canRepair)}`,
      tone: "warning",
      dontAskAgainLabel: null,
      actions: [
        { choice: "keep", label: "Keep ADE open", primary: !offerRepair },
        { choice: "quit", label: `${verb} anyway` },
        ...(offerRepair ? [fixAction] : []),
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
    dontAskAgainLabel: "Don't ask again",
    actions: [
      { choice: "keep", label: "Keep ADE open" },
      { choice: "quit", label: `${verb} ADE`, primary: true },
    ],
  };
}
