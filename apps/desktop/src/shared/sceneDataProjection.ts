import { buildDeeplink } from "./deeplinks";
import type { LaneListSnapshot, LaneSummary, PrSummary, TerminalSessionSummary } from "./types";

/**
 * The live ADE data a scene can ask for (`data="lanes,sessions,prs"`), as one
 * read-only projection shared by the chat (`sceneData.ts`, from the renderer's
 * stores) and `ade scene preview` (from the brain's services), so a preview
 * draws exactly what the chat will. Names, branches, counts, states and
 * `ade://` links only: no paths, transcripts or file contents.
 */

/** The most chats a snapshot carries, newest first. */
export const SCENE_DATA_MAX_SESSIONS = 100;
const MAX_PRS = 100;

export type SceneDataPayload = {
  at: string;
  lanes?: Array<{
    id: string;
    name: string;
    branch: string;
    base: string;
    primary: boolean;
    color: string | null;
    ahead: number;
    behind: number;
    dirty: boolean;
    changedFiles: number;
    running: number;
    awaitingInput: number;
    sessions: number;
    url: string;
  }>;
  sessions?: Array<{
    id: string;
    title: string;
    laneId: string;
    laneName: string;
    tool: string | null;
    status: string;
    startedAt: string;
    endedAt: string | null;
    url: string;
  }>;
  prs?: Array<{
    number: number;
    title: string;
    state: string;
    checks: string;
    review: string;
    laneId: string;
    additions: number;
    deletions: number;
    updatedAt: string;
    githubUrl: string;
    url: string;
  }>;
};

/**
 * Lanes from the chat machine's lane list; run counts from the Lanes tab's
 * snapshots when it has loaded them (zero otherwise — the list alone does not
 * carry them).
 */
export function projectSceneLanes(lanes: LaneSummary[], snapshots: LaneListSnapshot[] = []): NonNullable<SceneDataPayload["lanes"]> {
  const runtimeById = new Map(snapshots.map((snapshot) => [snapshot.lane.id, snapshot.runtime]));
  return lanes
    .filter((lane) => !lane.archivedAt)
    .map((lane) => {
      const runtime = runtimeById.get(lane.id);
      return {
        id: lane.id,
        name: lane.name,
        branch: lane.branchRef,
        base: lane.baseRef,
        primary: lane.laneType === "primary",
        color: lane.color,
        ahead: lane.status.ahead,
        behind: lane.status.behind,
        dirty: lane.status.dirty,
        changedFiles: lane.status.changedFileCount ?? 0,
        running: runtime?.runningCount ?? 0,
        awaitingInput: runtime?.awaitingInputCount ?? 0,
        sessions: runtime?.sessionCount ?? 0,
        url: buildDeeplink({ kind: "lane", laneId: lane.id }, { form: "ade" }),
      };
    });
}

export function projectSceneSessions(sessions: TerminalSessionSummary[]): NonNullable<SceneDataPayload["sessions"]> {
  return sessions
    .filter((session) => !session.archivedAt)
    .slice(0, SCENE_DATA_MAX_SESSIONS)
    .map((session) => ({
      id: session.id,
      title: session.title,
      laneId: session.laneId,
      laneName: session.laneName,
      tool: session.toolType,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      url: buildDeeplink({ kind: "session", sessionId: session.id }, { form: "ade" }),
    }));
}

export function projectScenePrs(prs: PrSummary[]): NonNullable<SceneDataPayload["prs"]> {
  return prs.slice(0, MAX_PRS).map((pr) => ({
    number: pr.githubPrNumber,
    title: pr.title,
    state: pr.state,
    checks: pr.checksStatus,
    review: pr.reviewStatus,
    laneId: pr.laneId,
    additions: pr.additions,
    deletions: pr.deletions,
    updatedAt: pr.updatedAt,
    githubUrl: pr.githubUrl,
    url: buildDeeplink({ kind: "pr", repoOwner: pr.repoOwner, repoName: pr.repoName, prNumber: pr.githubPrNumber }, { form: "ade" }),
  }));
}
