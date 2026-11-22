import type { NavigateFunction } from "react-router-dom";
import type { ComputerUseArtifactView, OpenProjectBinding, PrSummary } from "../../../shared/types";
import { navigateToSpawnedChat } from "../chat/spawnNavigation";
import { navigateToAppTarget } from "../../lib/openExternal";

/**
 * Opening what the CTO's panel lists. Every target lives on the CTO's home
 * machine (`pin`); `pinTargetsTab` says whether that is the machine the
 * project tab is bound to.
 */

/**
 * Open a chat the CTO started, in the Work tab, on the CTO's machine.
 *
 * The same two steps as the command palette: the event carries the pin so the
 * Work tab focuses the chat on the right machine, and the route only switches
 * the visible tab. A foreign chat's ids go only in the event: the Work tab
 * would resolve a query string against the tab's own machine and drop it.
 */
export function openCtoChat(
  navigate: NavigateFunction,
  sessionId: string,
  laneId: string | null,
  pin: OpenProjectBinding | null,
  pinTargetsTab: boolean,
): void {
  navigateToSpawnedChat(sessionId, laneId, pinTargetsTab ? null : pin);
  if (!pinTargetsTab) {
    navigate("/work");
    return;
  }
  const lane = laneId ? `&laneId=${encodeURIComponent(laneId)}` : "";
  navigate(`/work?sessionId=${encodeURIComponent(sessionId)}${lane}`);
}

/** A PR: ADE's PR view on the tab's machine; GitHub for a PR on another machine. */
export function openCtoPr(pr: PrSummary, pinTargetsTab: boolean): void {
  if (pinTargetsTab) {
    navigateToAppTarget({ kind: "pr", prId: pr.id, prNumber: pr.githubPrNumber, laneId: pr.laneId });
    return;
  }
  if (pr.githubUrl && isGitHubUrl(pr.githubUrl)) void window.ade?.app?.openExternal?.(pr.githubUrl);
}

function isGitHubUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
}

/** The chat a proof artifact was filed from, when its links name one. */
export function artifactOwnerChatId(artifact: ComputerUseArtifactView): string | null {
  return artifact.links.find((link) => link.ownerKind === "chat_session")?.ownerId ?? null;
}
