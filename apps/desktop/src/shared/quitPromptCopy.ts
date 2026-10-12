import type { QuitPromptRequest } from "./types";

const agents = (count: number): string => (count === 1 ? "1 agent" : `${count} agents`);

/** "3 agents are", "1 agent is". */
export function agentsAre(count: number): string {
  return `${agents(count)} ${count === 1 ? "is" : "are"}`;
}

/**
 * The quit confirmation's words, shared by ADE's dialog and the native box
 * main falls back to, so the two never disagree.
 */
export function quitPromptCopy(request: QuitPromptRequest): { title: string; description: string } {
  const count = request.runningAgents;
  if (request.appOwnedService) {
    const stops = count > 0
      ? `ADE is running ${agents(count)} itself for now, so ${request.relaunch ? "restarting" : "quitting"} stops ${count === 1 ? "it" : "them"}.`
      : "ADE is running it itself for now.";
    const fix = request.appOwnedService.blockedByMacOS
      ? "Turn on ADE under Allow in the Background, and agents keep going after you quit."
      : count > 0
        ? "Repair it first: they pick up where they left off and keep going after you quit."
        : "Repair it, and agents keep going after you quit.";
    return { title: "ADE's background service isn't running", description: `${stops} ${fix}` };
  }
  return {
    title: request.relaunch ? "Restart ADE?" : "Quit ADE?",
    description: count > 0
      ? `${agentsAre(count)} working and will keep going in the background.`
      : request.relaunch
        ? "Your agents keep running in the background while ADE restarts."
        : "Your agents keep running in the background. Open ADE any time to check on them.",
  };
}
