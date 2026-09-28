/**
 * What both cloud-agent strategies share: this project's origin, the chat and
 * lane lookups that link an agent to ADE, and the cloud-lane helpers — make a
 * lane, tag it, push its branch so the VM can check it out.
 */
import { runGit } from "../../git/git";
import type { LaneSummary } from "../../../../shared/types/lanes";
import type { AgentChatSessionSummary } from "../../../../shared/types/chat";
import type {
  CloudAgentLaunchArgs,
  CloudAgentLink,
  CloudAgentList,
  CloudAgentOpenResult,
} from "../../../../shared/types/cloudAgents";
import {
  CLOUD_LANE_LABELS,
  laneCloudProvider,
  withCloudLaneTag,
  type CloudLaneProvider,
} from "../../../../shared/cloudLanes";
import { repoMatchKey } from "../../../../shared/cursorCloudRepoMatch";
import type { Logger } from "../../logging/logger";
import type { AgentChatDevinCloudConfig } from "../../../../shared/types/chat";
import type { CursorCloudFleetResult } from "../../../../shared/types/config";
import type { DevinCloudDirectory } from "../devinCloudDirectory";

const ORIGIN_TTL_MS = 60_000;
const PUSH_TIMEOUT_MS = 90_000;

type LaneDeps = {
  list: (args: { includeArchived?: boolean; includeStatus?: boolean }) => Promise<LaneSummary[]>;
  importBranch: (args: { branchRef: string; name?: string; description?: string; baseBranch?: string }) => Promise<LaneSummary>;
  create: (args: { name: string; baseBranch?: string; branchName?: string; description?: string }) => Promise<LaneSummary>;
  updateAppearance: (args: { laneId: string; tags?: string[] | null }) => void;
};

export type CloudAgentsServiceDeps = {
  projectRoot: string;
  logger: Logger;
  devinDirectory: DevinCloudDirectory;
  cursorFleet: {
    getFleet: (args?: { force?: boolean; includeArchived?: boolean }) => Promise<CursorCloudFleetResult>;
    resolveLaneForAgent: (agentId: string) => Promise<{ laneId: string; laneName: string; created: boolean }>;
    stopAgentRun: (agentId: string) => Promise<{ stopped: boolean }>;
    invalidateCache: () => void;
  } | null;
  cursorArchive?: ((agentId: string, archived: boolean) => Promise<unknown>) | null;
  /** Null when Cursor has no API key; the Cursor list then says so. */
  cursorUnavailableReason?: () => Promise<string | null>;
  lanes: LaneDeps;
  chats: {
    list: () => Promise<AgentChatSessionSummary[]>;
    openDevinCloudChat: (args: {
      devinSessionId: string;
      laneId: string;
      sessionId?: string | null;
      devinCloud?: AgentChatDevinCloudConfig | null;
    }) => Promise<{ sessionId: string }>;
    openCursorCloudChat: (args: { cloudAgentId: string; laneId: string; sessionId?: string | null }) => Promise<{ sessionId: string }>;
    interrupt: (sessionId: string) => Promise<unknown>;
    createDevinCloudChat: (args: { laneId: string; devinCloud: AgentChatDevinCloudConfig }) => Promise<{ id: string }>;
    send: (args: { sessionId: string; text: string }) => Promise<unknown>;
  };
  cursorCreateRun?: ((args: {
    promptText: string;
    repoUrl: string;
    startingRef: string;
    modelId?: string | null;
    laneId: string;
  }) => Promise<{ agent: { agentId: string } }>) | null;
};

/** How long a just-launched Devin chat without a session id still counts as running. */
const LAUNCH_SETTLE_MS = 120_000;

export const ONE_AGENT_PER_LANE_MESSAGE =
  "A cloud agent is already working in this lane. Send it a message, or wait for it to finish.";

export type ProjectOrigin = {
  /** Match key (`github.com/owner/repo`); empty without an origin. */
  key: string;
  /** `owner/repo`, the form cloud providers clone. */
  slug: string | null;
  defaultBranch: string | null;
  at: number;
};

/** A lane name from the first line of a prompt: short, no trailing punctuation. */
export function cloudLaneNameFromPrompt(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0] ?? "";
  const words = line.replace(/\s+/g, " ").slice(0, 42).trim();
  const clipped = words.length >= 42 ? words.replace(/\s+\S*$/, "") : words;
  return clipped.replace(/[.,;:!?]+$/, "") || "Cloud agent";
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "session";
}

export function createCloudAgentsContext(deps: CloudAgentsServiceDeps) {
  const { projectRoot, logger } = deps;
  let originCache: ProjectOrigin | null = null;

  /** This project's origin as a match key, `owner/repo`, and its default branch. */
  const origin = async (): Promise<ProjectOrigin> => {
    if (originCache && Date.now() - originCache.at < ORIGIN_TTL_MS) return originCache;
    const url = await runGit(["remote", "get-url", "origin"], { cwd: projectRoot, timeoutMs: 8_000 })
      .then((result) => (result.exitCode === 0 ? result.stdout.trim() : ""))
      .catch(() => "");
    const head = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: projectRoot, timeoutMs: 8_000 })
      .then((result) => (result.exitCode === 0 ? result.stdout.trim().replace(/^origin\//, "") : ""))
      .catch(() => "");
    const key = repoMatchKey(url);
    const slugMatch = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
    originCache = { key, slug: slugMatch ? slugMatch[1] : null, defaultBranch: head || null, at: Date.now() };
    return originCache;
  };

  const lanesById = async (): Promise<Map<string, LaneSummary>> => {
    const lanes = await deps.lanes.list({ includeArchived: false, includeStatus: false });
    return new Map(lanes.map((lane) => [lane.id, lane]));
  };

  const linkFor = (
    chat: AgentChatSessionSummary | undefined,
    lanes: Map<string, LaneSummary>,
  ): CloudAgentLink | null => {
    if (!chat) return null;
    const lane = lanes.get(chat.laneId) ?? null;
    return {
      chatSessionId: chat.sessionId,
      laneId: chat.laneId,
      laneName: lane?.name ?? null,
      laneIsCloud: laneCloudProvider(lane) !== null,
    };
  };

  /** Most recent chat per provider id, so a relinked agent shows its live chat. */
  const chatIndex = async (key: "devinSessionId" | "cursorCloudAgentId") => {
    const chats = await deps.chats.list();
    const index = new Map<string, AgentChatSessionSummary>();
    for (const chat of [...chats].sort((a, b) => Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt))) {
      const id = chat[key]?.trim();
      if (id) index.set(id, chat);
    }
    return index;
  };

  /** Mark a lane ADE uses for a cloud agent as that cloud's lane. */
  const tagCloudLane = (lane: LaneSummary, provider: CloudLaneProvider) => {
    if (laneCloudProvider(lane) === provider) return;
    deps.lanes.updateAppearance({ laneId: lane.id, tags: withCloudLaneTag(lane.tags, provider) });
  };

  /**
   * Push the lane's branch to origin so a cloud VM can check it out. No
   * upstream is set: the lane's own tracking is not this push's business.
   *
   * A rejected (non-fast-forward) push means origin already has the branch
   * with commits the lane lacks — the cloud agent pushed them. The VM can
   * check that out, so it is not a failure.
   */
  const pushLaneBranch = async (
    lane: LaneSummary,
    options: { onFailure: "throw" | "warn" },
  ): Promise<boolean> => {
    const pushed = await runGit(["push", "--quiet", "origin", `HEAD:refs/heads/${lane.branchRef}`], {
      cwd: lane.worktreePath,
      timeoutMs: PUSH_TIMEOUT_MS,
    }).catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: String(error) }));
    if (pushed.exitCode === 0) return true;
    const stderr = pushed.stderr.trim().slice(-300);
    // Rejected because origin is ahead: fine when the lane holds nothing origin
    // lacks (the cloud agent pushed past it), since the VM checks out origin.
    // A lane with commits of its own would start the agent without them.
    if (/non-fast-forward|fetch first/i.test(stderr)) {
      const behindOnly = await runGit(["fetch", "--quiet", "origin", `refs/heads/${lane.branchRef}`], {
        cwd: lane.worktreePath,
        timeoutMs: PUSH_TIMEOUT_MS,
      })
        .then(async (fetched) => fetched.exitCode === 0
          && (await runGit(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"], { cwd: lane.worktreePath, timeoutMs: 15_000 })).exitCode === 0)
        .catch(() => false);
      if (behindOnly) {
        logger.info("cloud_agents.lane_branch_behind_origin", { laneId: lane.id, branch: lane.branchRef });
        return true;
      }
      if (options.onFailure === "throw") {
        throw new Error(`${lane.branchRef} has diverged from origin. Pull or push it first so the cloud agent starts from your commits.`);
      }
    }
    if (options.onFailure === "throw") {
      throw new Error(`Could not push ${lane.branchRef} to origin, so the cloud VM cannot check it out: ${stderr || "git push failed"}`);
    }
    logger.warn("cloud_agents.lane_branch_push_failed", { laneId: lane.id, branch: lane.branchRef, stderr });
    return false;
  };

  /**
   * A cloud lane for new work: a fresh lane on a new branch off the default
   * branch, tagged with its cloud and pushed so the VM can check it out.
   */
  const createCloudLane = async (
    provider: CloudLaneProvider,
    args: { name: string; branchName: string; onPushFailure: "throw" | "warn" },
  ): Promise<LaneSummary> => {
    const { defaultBranch } = await origin();
    const lane = await deps.lanes.create({
      name: args.name,
      branchName: args.branchName,
      ...(defaultBranch ? { baseBranch: defaultBranch } : {}),
    });
    tagCloudLane(lane, provider);
    await pushLaneBranch(lane, { onFailure: args.onPushFailure });
    return lane;
  };

  /**
   * Everything a launch needs before the provider starts its agent: a task,
   * a GitHub origin to clone, and a lane — the one asked for (never the
   * primary, never another cloud's, branch pushed) or a new cloud lane.
   */
  const prepareLaunch = async (args: CloudAgentLaunchArgs) => {
    const prompt = args.prompt.trim();
    if (!prompt) throw new Error("Tell the agent what to do.");
    const { slug } = await origin();
    if (!slug) throw new Error("This project has no GitHub origin, so a cloud agent cannot clone it.");
    if (!args.laneId) {
      const name = cloudLaneNameFromPrompt(prompt);
      const suffix = Math.random().toString(36).slice(2, 6);
      const lane = await createCloudLane(args.provider, {
        name,
        branchName: `${args.provider}/${slugify(name)}-${suffix}`,
        onPushFailure: "throw",
      });
      return { prompt, slug, lane, created: true };
    }
    // One cloud agent per lane at a time: two VMs pushing one branch race.
    // A Devin chat just launched is still spawning its relay: it has its cloud
    // config but no session id yet, and it is not "active" until the relay is up.
    // Bounded, so a launch that failed does not hold the lane forever.
    const running = (await deps.chats.list()).find((chat) =>
      chat.laneId === args.laneId
      && (
        (chat.status === "active" && (Boolean(chat.devinSessionId) || Boolean(chat.cursorCloudAgentId)))
        || (Boolean(chat.devinCloud) && !chat.devinSessionId && chat.status !== "ended" && Date.now() - Date.parse(chat.startedAt) < LAUNCH_SETTLE_MS)
      ));
    if (running) throw new Error(ONE_AGENT_PER_LANE_MESSAGE);
    const lane = (await lanesById()).get(args.laneId);
    if (!lane) throw new Error("That lane no longer exists.");
    if (lane.laneType === "primary") {
      throw new Error("The primary lane can't move to a cloud. Pick a cloud lane or start a new one.");
    }
    const cloud = laneCloudProvider(lane);
    if (cloud && cloud !== args.provider) throw new Error(`That lane lives on ${CLOUD_LANE_LABELS[cloud]}.`);
    // Make sure the VM can see the branch before the agent tries to.
    await pushLaneBranch(lane, { onFailure: "throw" });
    return { prompt, slug, lane, created: false };
  };

  return {
    deps,
    logger,
    origin,
    lanesById,
    linkFor,
    chatIndex,
    tagCloudLane,
    pushLaneBranch,
    createCloudLane,
    prepareLaunch,
  };
}

export type CloudAgentsContext = ReturnType<typeof createCloudAgentsContext>;

/** One provider's side of the cloud-agents contract. */
export type CloudAgentsStrategy = {
  list: (force: boolean) => Promise<CloudAgentList>;
  open: (id: string) => Promise<CloudAgentOpenResult>;
  stop: (id: string) => Promise<{ stopped: true }>;
  archive: (id: string, archived: boolean) => Promise<{ archived: boolean }>;
  launch: (args: CloudAgentLaunchArgs) => Promise<CloudAgentOpenResult>;
};
