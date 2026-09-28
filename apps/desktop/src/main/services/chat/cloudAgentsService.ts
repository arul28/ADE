/**
 * Cloud agents: one contract over Devin Cloud sessions and Cursor Cloud agents.
 *
 * Each provider keeps its own client — Devin through the ACP relay directory
 * (`devin acp --cloud`, CLI login, no token), Cursor through its fleet service
 * (SDK + API key) — and this service maps both onto `CloudAgent` rows and the
 * same four verbs: list, open, stop, archive.
 *
 * "Open" is the verb that makes a cloud agent part of ADE. It finds or makes
 * the agent's cloud lane — a lane on the agent's branch whose machine is the
 * provider's cloud — and opens the agent's chat in it. The chat is live: the
 * Devin chat rides the relay, the Cursor chat the SDK stream.
 */
import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { LaneSummary } from "../../../shared/types/lanes";
import type {
  AgentChatDevinCloudConfig,
  AgentChatSessionSummary,
} from "../../../shared/types/chat";
import type {
  CloudAgent,
  CloudAgentArchiveArgs,
  CloudAgentLink,
  CloudAgentLaunchArgs,
  CloudAgentList,
  CloudAgentListArgs,
  CloudAgentModelOption,
  CloudAgentOpenResult,
  CloudAgentPullRequest,
  CloudAgentRef,
  CloudAgentStatus,
} from "../../../shared/types/cloudAgents";
import type { CursorCloudFleetEntry, CursorCloudFleetResult } from "../../../shared/types/config";
import {
  DEVIN_CLOUD_DEFAULT_VERSION,
  DEVIN_CLOUD_VERSIONS,
  laneCloudProvider,
  stripDevinCloudBranchPin,
  withCloudLaneTag,
  type CloudLaneProvider,
} from "../../../shared/cloudLanes";
import { devinCloudRepoMatchKey, repoMatchKey } from "../../../shared/cursorCloudRepoMatch";
import { createDevinCloudDirectory, type DevinCloudDirectory, type DevinCloudDirectoryEntry } from "./devinCloudDirectory";

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

const ORIGIN_TTL_MS = 60_000;

const DEVIN_MODELS: CloudAgentModelOption[] = DEVIN_CLOUD_VERSIONS.map((option) => ({
  value: option.value,
  label: option.label,
  description: option.description,
  ...(option.badge ? { badge: option.badge } : {}),
}));

/** A lane name from the first line of a prompt: short, no trailing punctuation. */
export function cloudLaneNameFromPrompt(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0] ?? "";
  const words = line.replace(/\s+/g, " ").slice(0, 42).trim();
  const clipped = words.length >= 42 ? words.replace(/\s+\S*$/, "") : words;
  return clipped.replace(/[.,;:!?]+$/, "") || "Cloud agent";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "session";
}

function cursorStatus(entry: CursorCloudFleetEntry): { status: CloudAgentStatus; statusText: string } {
  if (entry.agent.archived) return { status: "archived", statusText: "Archived" };
  switch (entry.runStatus ?? entry.agent.status) {
    case "creating":
      return { status: "starting", statusText: "Starting" };
    case "running":
      return { status: "working", statusText: "Working" };
    case "error":
      return { status: "failed", statusText: "Errored" };
    case "cancelled":
      return { status: "finished", statusText: "Stopped" };
    case "expired":
      return { status: "finished", statusText: "Expired" };
    default:
      return { status: "finished", statusText: "Finished" };
  }
}

function prFromUrl(url: string | null, headRef: string | null): CloudAgentPullRequest | null {
  if (!url) return null;
  const match = /\/pull\/(\d+)/.exec(url);
  return {
    url,
    number: match ? Number(match[1]) : null,
    state: null,
    title: null,
    headRef,
    baseRef: null,
    additions: null,
    deletions: null,
  };
}

function toIso(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export function createCloudAgentsService(deps: CloudAgentsServiceDeps) {
  const { projectRoot, logger } = deps;
  let originCache: { key: string; slug: string | null; defaultBranch: string | null; at: number } | null = null;

  /** This project's origin as a match key, `owner/repo`, and its default branch. */
  const origin = async () => {
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

  const devinEntryToAgent = (
    entry: DevinCloudDirectoryEntry,
    originKey: string,
    link: CloudAgentLink | null,
  ): CloudAgent => {
    const ours = entry.pullRequests.find((pr) => Boolean(originKey) && repoMatchKey(pr.url.replace(/\/pull\/\d+.*$/, "")) === originKey)
      ?? entry.pullRequests[0]
      ?? null;
    return {
      provider: "devin",
      id: entry.id,
      title: entry.title,
      status: entry.status,
      statusText: entry.statusText,
      unread: entry.unread,
      webUrl: entry.url ?? `https://app.devin.ai/sessions/${entry.id}`,
      repos: entry.repos,
      branch: ours?.headRef ?? null,
      pullRequest: ours,
      model: entry.model,
      platform: entry.platform,
      origin: entry.origin,
      excerpt: entry.excerpt ? stripDevinCloudBranchPin(entry.excerpt) || null : null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      inThisProject: Boolean(originKey) && entry.repos.some((repo) => devinCloudRepoMatchKey(repo) === originKey),
      link,
    };
  };

  const listDevin = async (force: boolean): Promise<CloudAgentList> => {
    const fetchedAt = new Date().toISOString();
    const capabilities = { stop: true, archive: true, vmShell: true, web: true };
    let entries: DevinCloudDirectoryEntry[];
    try {
      entries = await deps.devinDirectory.list({ force });
    } catch (error) {
      return {
        provider: "devin",
        items: [],
        fetchedAt,
        capabilities,
        unavailableReason: error instanceof Error ? error.message : String(error),
        models: DEVIN_MODELS,
      };
    }
    const [{ key }, chats, lanes] = await Promise.all([origin(), chatIndex("devinSessionId"), lanesById()]);
    return {
      provider: "devin",
      items: entries.map((entry) => devinEntryToAgent(entry, key, linkFor(chats.get(entry.id), lanes))),
      fetchedAt,
      capabilities,
      unavailableReason: null,
      models: DEVIN_MODELS,
    };
  };

  const listCursor = async (force: boolean): Promise<CloudAgentList> => {
    const fetchedAt = new Date().toISOString();
    const capabilities = { stop: true, archive: Boolean(deps.cursorArchive), vmShell: false, web: true };
    const reason = deps.cursorFleet
      ? await deps.cursorUnavailableReason?.().catch(() => null) ?? null
      : "Cursor Cloud is not available on this machine.";
    if (reason || !deps.cursorFleet) {
      return { provider: "cursor", items: [], fetchedAt, capabilities, unavailableReason: reason ?? "Cursor Cloud is not available.", models: [] };
    }
    let fleet: CursorCloudFleetResult;
    try {
      fleet = await deps.cursorFleet.getFleet({ force, includeArchived: true });
    } catch (error) {
      return {
        provider: "cursor",
        items: [],
        fetchedAt,
        capabilities,
        unavailableReason: error instanceof Error ? error.message : String(error),
        models: [],
      };
    }
    const [{ key }, chats, lanes] = await Promise.all([origin(), chatIndex("cursorCloudAgentId"), lanesById()]);
    const items = fleet.items.map((entry): CloudAgent => {
      const { status, statusText } = cursorStatus(entry);
      const repos = (entry.agent.repos ?? []).map((repo) => repo.replace(/^https?:\/\//, "").replace(/^github\.com\//, ""));
      const chat = chats.get(entry.agent.agentId);
      return {
        provider: "cursor",
        id: entry.agent.agentId,
        title: entry.agent.name || entry.agent.summary || "Cursor agent",
        status,
        statusText,
        unread: false,
        webUrl: entry.agent.webUrl ?? `https://cursor.com/agents?id=${entry.agent.agentId}`,
        repos,
        branch: entry.branch,
        pullRequest: prFromUrl(entry.prUrl, entry.branch),
        model: entry.modelId,
        platform: null,
        origin: null,
        excerpt: entry.agent.summary && entry.agent.summary !== entry.agent.name ? entry.agent.summary : null,
        createdAt: toIso(entry.agent.createdAt),
        updatedAt: toIso(entry.agent.lastModified),
        inThisProject: entry.matchedBy !== "account" || (Boolean(key) && (entry.agent.repos ?? []).some((repo) => repoMatchKey(repo) === key)),
        link: chat ? linkFor(chat, lanes) : entry.ownership.laneId && entry.ownership.sessionId
          ? {
              chatSessionId: entry.ownership.sessionId,
              laneId: entry.ownership.laneId,
              laneName: entry.ownership.laneName,
              laneIsCloud: laneCloudProvider(lanes.get(entry.ownership.laneId)) !== null,
            }
          : null,
      };
    });
    return { provider: "cursor", items, fetchedAt, capabilities, unavailableReason: null, models: [] };
  };

  const list = async (args: CloudAgentListArgs): Promise<CloudAgentList> =>
    args.provider === "devin" ? await listDevin(args.force === true) : await listCursor(args.force === true);

  /** Mark a lane ADE made for a cloud agent as that cloud's lane. */
  const tagCloudLane = (lane: LaneSummary, provider: CloudLaneProvider) => {
    if (laneCloudProvider(lane) === provider) return;
    deps.lanes.updateAppearance({ laneId: lane.id, tags: withCloudLaneTag(lane.tags, provider) });
  };

  /**
   * The Devin session's lane: the lane already on its PR branch, else a new
   * cloud lane imported from that branch, else — no PR yet — a new cloud lane
   * on a fresh branch ADE pushes, which the chat's first turn pins the VM to.
   */
  const devinLaneFor = async (entry: DevinCloudDirectoryEntry, agent: CloudAgent) => {
    const lanes = await deps.lanes.list({ includeArchived: false, includeStatus: false });
    const branch = agent.branch?.trim() || null;
    if (branch && !branch.startsWith("-")) {
      const existing = lanes.find((lane) => lane.branchRef === branch);
      if (existing) return { lane: existing, created: false, pinned: true };
      // A merged or closed PR usually took its branch with it; then the
      // session continues on a fresh lane like one that never had a PR.
      const imported = await deps.lanes
        .importBranch({ branchRef: branch, name: entry.title.slice(0, 60) })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!/not found/i.test(message)) throw error;
          logger.info("cloud_agents.devin_branch_gone", { branch });
          return null;
        });
      if (imported) {
        tagCloudLane(imported, "devin");
        return { lane: imported, created: true, pinned: true };
      }
    }
    const { defaultBranch } = await origin();
    const branchName = `devin/${slugify(entry.title)}-${entry.id.slice(0, 6)}`;
    const created = await deps.lanes.create({
      name: entry.title.slice(0, 60),
      branchName,
      ...(defaultBranch ? { baseBranch: defaultBranch } : {}),
    });
    tagCloudLane(created, "devin");
    const pushed = await runGit(["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branchName}`], {
      cwd: created.worktreePath,
      timeoutMs: 60_000,
    }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error) }));
    if (pushed.exitCode !== 0) {
      logger.warn("cloud_agents.devin_branch_push_failed", { branchName, stderr: pushed.stderr.slice(-300) });
    }
    return { lane: created, created: true, pinned: false };
  };

  const openDevin = async (id: string): Promise<CloudAgentOpenResult> => {
    const entry = await deps.devinDirectory.find(id, { force: true });
    if (!entry) throw new Error("This Devin session is no longer listed. It may be archived.");
    const [{ key, slug }, chats] = await Promise.all([origin(), chatIndex("devinSessionId")]);
    const agent = devinEntryToAgent(entry, key, null);
    const existing = chats.get(entry.id);
    const baseConfig = {
      transport: "acp" as const,
      version: entry.model,
      platform: entry.platform,
      repo: entry.repos[0] ?? slug,
    };
    if (existing) {
      const opened = await deps.chats.openDevinCloudChat({
        devinSessionId: entry.id,
        laneId: existing.laneId,
        sessionId: existing.sessionId,
        devinCloud: { ...baseConfig, branch: agent.branch, pinned: Boolean(agent.branch) },
      });
      const lanes = await lanesById();
      return { chatSessionId: opened.sessionId, laneId: existing.laneId, laneName: lanes.get(existing.laneId)?.name ?? null, createdLane: false };
    }
    const { lane, created, pinned } = await devinLaneFor(entry, agent);
    const opened = await deps.chats.openDevinCloudChat({
      devinSessionId: entry.id,
      laneId: lane.id,
      devinCloud: { ...baseConfig, branch: lane.branchRef, pinned },
    });
    deps.devinDirectory.invalidate();
    return { chatSessionId: opened.sessionId, laneId: lane.id, laneName: lane.name, createdLane: created };
  };

  const openCursor = async (id: string): Promise<CloudAgentOpenResult> => {
    if (!deps.cursorFleet) throw new Error("Cursor Cloud is not available.");
    const chats = await chatIndex("cursorCloudAgentId");
    const existing = chats.get(id);
    const resolved = existing
      ? { laneId: existing.laneId, laneName: null as string | null, created: false }
      : await deps.cursorFleet.resolveLaneForAgent(id);
    if (resolved.created) {
      const lanes = await lanesById();
      const lane = lanes.get(resolved.laneId);
      if (lane) tagCloudLane(lane, "cursor");
    }
    const opened = await deps.chats.openCursorCloudChat({
      cloudAgentId: id,
      laneId: resolved.laneId,
      ...(existing ? { sessionId: existing.sessionId } : {}),
    });
    deps.cursorFleet.invalidateCache();
    return {
      chatSessionId: opened.sessionId,
      laneId: resolved.laneId,
      laneName: resolved.laneName,
      createdLane: resolved.created,
    };
  };

  const open = async (ref: CloudAgentRef): Promise<CloudAgentOpenResult> =>
    ref.provider === "devin" ? await openDevin(ref.id) : await openCursor(ref.id);

  const stop = async (ref: CloudAgentRef): Promise<{ stopped: true }> => {
    if (ref.provider === "cursor") {
      if (!deps.cursorFleet) throw new Error("Cursor Cloud is not available.");
      await deps.cursorFleet.stopAgentRun(ref.id);
      return { stopped: true };
    }
    // A chat ADE is running owns the turn; stop it there so the chat settles.
    const chat = (await chatIndex("devinSessionId")).get(ref.id.replace(/^devin-/, ""));
    if (chat && chat.status === "active") {
      await deps.chats.interrupt(chat.sessionId);
    } else {
      await deps.devinDirectory.cancel(ref.id);
    }
    deps.devinDirectory.invalidate();
    return { stopped: true };
  };

  const archive = async (args: CloudAgentArchiveArgs): Promise<{ archived: boolean }> => {
    if (args.provider === "cursor") {
      if (!deps.cursorArchive) throw new Error("Archiving Cursor agents is not available.");
      await deps.cursorArchive(args.id, args.archived);
      deps.cursorFleet?.invalidateCache();
      return { archived: args.archived };
    }
    if (!args.archived) throw new Error("Unarchive Devin sessions on app.devin.ai.");
    await deps.devinDirectory.archive(args.id);
    return { archived: true };
  };

  /**
   * A cloud lane for new work: a fresh lane on a new branch off the default
   * branch, pushed so the VM can check it out, tagged with its cloud.
   */
  const createCloudLane = async (provider: CloudLaneProvider, prompt: string): Promise<LaneSummary> => {
    const { defaultBranch } = await origin();
    const name = cloudLaneNameFromPrompt(prompt);
    const suffix = Math.random().toString(36).slice(2, 6);
    const branchName = `${provider}/${slugify(name)}-${suffix}`;
    const lane = await deps.lanes.create({
      name,
      branchName,
      ...(defaultBranch ? { baseBranch: defaultBranch } : {}),
    });
    tagCloudLane(lane, provider);
    const pushed = await runGit(["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branchName}`], {
      cwd: lane.worktreePath,
      timeoutMs: 90_000,
    }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error) }));
    if (pushed.exitCode !== 0) {
      throw new Error(`Could not push the new lane branch to origin, so the cloud VM cannot check it out: ${pushed.stderr.trim().slice(-300)}`);
    }
    return lane;
  };

  const resolveLaunchLane = async (args: CloudAgentLaunchArgs): Promise<{ lane: LaneSummary; created: boolean }> => {
    if (args.laneId) {
      const lane = (await lanesById()).get(args.laneId);
      if (!lane) throw new Error("That lane no longer exists.");
      const cloud = laneCloudProvider(lane);
      if (cloud && cloud !== args.provider) {
        throw new Error(`That lane lives on ${cloud === "devin" ? "Devin Cloud" : "Cursor Cloud"}.`);
      }
      // Make sure the VM can see the branch before the agent tries to.
      await runGit(["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${lane.branchRef}`], {
        cwd: lane.worktreePath,
        timeoutMs: 90_000,
      }).catch(() => undefined);
      return { lane, created: false };
    }
    return { lane: await createCloudLane(args.provider, args.prompt), created: true };
  };

  const launch = async (args: CloudAgentLaunchArgs): Promise<CloudAgentOpenResult> => {
    const prompt = args.prompt.trim();
    if (!prompt) throw new Error("Tell the agent what to do.");
    const { slug } = await origin();
    if (!slug) throw new Error("This project has no GitHub origin, so a cloud agent cannot clone it.");
    if (args.laneId) {
      // One cloud agent per lane at a time: two VMs pushing one branch race.
      const running = (await deps.chats.list()).find((chat) =>
        chat.laneId === args.laneId
        && chat.status === "active"
        && (Boolean(chat.devinSessionId) || Boolean(chat.cursorCloudAgentId)));
      if (running) {
        throw new Error("A cloud agent is already working in this lane. Send it a message, or wait for it to finish.");
      }
    }
    const { lane, created } = await resolveLaunchLane(args);
    if (args.provider === "devin") {
      const chat = await deps.chats.createDevinCloudChat({
        laneId: lane.id,
        devinCloud: {
          transport: "acp",
          version: args.model?.trim() || DEVIN_CLOUD_DEFAULT_VERSION,
          platform: args.platform?.trim() || null,
          repo: slug,
          branch: lane.branchRef,
        },
      });
      // The turn runs on the relay; the chat shows it streaming. Launch returns
      // as soon as it is under way.
      void deps.chats.send({ sessionId: chat.id, text: prompt }).catch((error) => {
        logger.warn("cloud_agents.devin_launch_send_failed", {
          sessionId: chat.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      deps.devinDirectory.invalidate();
      return { chatSessionId: chat.id, laneId: lane.id, laneName: lane.name, createdLane: created };
    }
    if (!deps.cursorCreateRun) throw new Error("Cursor Cloud is not available.");
    const run = await deps.cursorCreateRun({
      promptText: prompt,
      repoUrl: `https://github.com/${slug}`,
      startingRef: lane.branchRef,
      modelId: args.model?.trim() || null,
      laneId: lane.id,
    });
    const opened = await deps.chats.openCursorCloudChat({ cloudAgentId: run.agent.agentId, laneId: lane.id });
    deps.cursorFleet?.invalidateCache();
    return { chatSessionId: opened.sessionId, laneId: lane.id, laneName: lane.name, createdLane: created };
  };

  return { list, open, stop, archive, launch };
}

export type CloudAgentsService = ReturnType<typeof createCloudAgentsService>;

/**
 * Build the service from the host's own services. Both hosts (the `ade serve`
 * brain and the in-process desktop runtime) call this, so the wiring cannot
 * drift between them.
 */
export function createCloudAgentsServiceFromHost(host: {
  projectRoot: string;
  logger: Logger;
  laneService: {
    list: LaneDeps["list"];
    importBranch: LaneDeps["importBranch"];
    create: LaneDeps["create"];
    updateAppearance: LaneDeps["updateAppearance"];
  };
  getAgentChatService: () => {
    listSessions: (laneId?: string, options?: { includeArchived?: boolean }) => Promise<AgentChatSessionSummary[]>;
    openDevinCloudChat: CloudAgentsServiceDeps["chats"]["openDevinCloudChat"];
    openCursorCloudChat: CloudAgentsServiceDeps["chats"]["openCursorCloudChat"];
    interrupt: (args: { sessionId: string }) => Promise<unknown>;
    createSession: (args: {
      laneId: string;
      provider: "devin";
      model: string;
      modelId?: string;
      devinCloud?: AgentChatDevinCloudConfig | null;
    }) => Promise<{ id: string }>;
    sendMessage: (args: { sessionId: string; text: string }) => Promise<unknown>;
  } | null;
  cursorFleet: CloudAgentsServiceDeps["cursorFleet"];
  cursorCreateRun?: CloudAgentsServiceDeps["cursorCreateRun"];
  archiveCursorAgent?: ((agentId: string) => Promise<unknown>) | null;
  unarchiveCursorAgent?: ((agentId: string) => Promise<unknown>) | null;
  resolveDevinBinary: () => Promise<{ path: string; env: NodeJS.ProcessEnv } | null>;
}): CloudAgentsService {
  const chats = () => {
    const service = host.getAgentChatService();
    if (!service) throw new Error("Agent chat service not available.");
    return service;
  };
  return createCloudAgentsService({
    projectRoot: host.projectRoot,
    logger: host.logger,
    devinDirectory: createDevinCloudDirectoryForHost(host),
    cursorFleet: host.cursorFleet,
    cursorArchive: host.archiveCursorAgent && host.unarchiveCursorAgent
      ? (agentId, archived) => (archived ? host.archiveCursorAgent!(agentId) : host.unarchiveCursorAgent!(agentId))
      : null,
    lanes: {
      list: (args) => host.laneService.list(args),
      importBranch: (args) => host.laneService.importBranch(args),
      create: (args) => host.laneService.create(args),
      updateAppearance: (args) => host.laneService.updateAppearance(args),
    },
    chats: {
      list: () => chats().listSessions(undefined, { includeArchived: false }),
      openDevinCloudChat: (args) => chats().openDevinCloudChat(args),
      openCursorCloudChat: (args) => chats().openCursorCloudChat(args),
      interrupt: (sessionId) => chats().interrupt({ sessionId }),
      createDevinCloudChat: (args) => chats().createSession({
        laneId: args.laneId,
        provider: "devin",
        model: "adaptive",
        modelId: "devin/adaptive",
        devinCloud: args.devinCloud,
      }),
      send: (args) => chats().sendMessage(args),
    },
    cursorCreateRun: host.cursorCreateRun ?? null,
  });
}

function createDevinCloudDirectoryForHost(host: {
  projectRoot: string;
  logger: Logger;
  resolveDevinBinary: () => Promise<{ path: string; env: NodeJS.ProcessEnv } | null>;
}): DevinCloudDirectory {
  return createDevinCloudDirectory({
    logger: host.logger,
    cwd: host.projectRoot,
    resolveBinary: host.resolveDevinBinary,
  });
}
