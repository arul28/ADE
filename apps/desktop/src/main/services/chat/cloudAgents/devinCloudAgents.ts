/**
 * Devin Cloud side of the cloud-agents contract. Everything rides the ACP
 * relay directory (`devin acp --cloud`, CLI login, no token); opening a
 * session puts it in a Devin cloud lane with a live relay chat.
 */
import type { LaneSummary } from "../../../../shared/types/lanes";
import type {
  CloudAgent,
  CloudAgentLink,
  CloudAgentList,
  CloudAgentModelOption,
  CloudAgentOpenResult,
} from "../../../../shared/types/cloudAgents";
import {
  DEVIN_CLOUD_DEFAULT_VERSION,
  DEVIN_CLOUD_VERSIONS,
  stripDevinCloudBranchPin,
} from "../../../../shared/devinCloud";
import { devinCloudRepoMatchKey, repoMatchKey } from "../../../../shared/cursorCloudRepoMatch";
import { devinCloudBareSessionId } from "../acpHost/acpDialects/devinCloud";
import type { DevinCloudDirectory, DevinCloudDirectoryEntry } from "../devinCloudDirectory";
import { slugify, type CloudAgentsContext, type CloudAgentsStrategy } from "./cloudAgentsContext";

const DEVIN_MODELS: CloudAgentModelOption[] = DEVIN_CLOUD_VERSIONS.map((option) => ({
  value: option.value,
  label: option.label,
  description: option.description,
  ...(option.badge ? { badge: option.badge } : {}),
}));

const CAPABILITIES = { stop: true, archive: true, vmShell: true, web: true };

function devinEntryToAgent(entry: DevinCloudDirectoryEntry, originKey: string, link: CloudAgentLink | null): CloudAgent {
  // Only a PR on this project's repo names a branch ADE can check out. A
  // session that also opened PRs elsewhere still shows one, but its branch
  // belongs to that other repo.
  const ours = originKey
    ? entry.pullRequests.find((pr) => repoMatchKey(pr.url.replace(/\/pull\/\d+.*$/, "")) === originKey) ?? null
    : null;
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
    pullRequest: ours ?? entry.pullRequests[0] ?? null,
    model: entry.model,
    platform: entry.platform,
    origin: entry.origin,
    excerpt: entry.excerpt ? stripDevinCloudBranchPin(entry.excerpt) || null : null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    inThisProject: Boolean(originKey) && entry.repos.some((repo) => devinCloudRepoMatchKey(repo) === originKey),
    link,
  };
}

/** Import failures that mean "no usable branch to import", not a real error. */
function isBranchUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // "not found": a merged or closed PR usually took its branch with it.
  // "already exists": an archived lane (or the primary) still holds it.
  return /not found|already exists/i.test(message);
}

export function devinCloudAgents(ctx: CloudAgentsContext, directory: DevinCloudDirectory): CloudAgentsStrategy {
  const { deps, logger } = ctx;

  const list = async (force: boolean): Promise<CloudAgentList> => {
    const fetchedAt = new Date().toISOString();
    let entries: DevinCloudDirectoryEntry[];
    try {
      entries = await directory.list({ force });
    } catch (error) {
      return {
        provider: "devin",
        items: [],
        fetchedAt,
        capabilities: CAPABILITIES,
        unavailableReason: error instanceof Error ? error.message : String(error),
        models: DEVIN_MODELS,
      };
    }
    const [{ key }, chats, lanes] = await Promise.all([ctx.origin(), ctx.chatIndex("devinSessionId"), ctx.lanesById()]);
    return {
      provider: "devin",
      items: entries.map((entry) => devinEntryToAgent(entry, key, ctx.linkFor(chats.get(entry.id), lanes))),
      fetchedAt,
      capabilities: CAPABILITIES,
      unavailableReason: null,
      models: DEVIN_MODELS,
    };
  };

  /**
   * The session's lane: a non-primary lane already on its PR branch, else a
   * new cloud lane imported from that branch, else — no PR yet, or the branch
   * is gone — a new cloud lane on a fresh branch ADE pushes, which the chat's
   * first turn pins the VM to.
   */
  const laneFor = async (
    entry: DevinCloudDirectoryEntry,
    agent: CloudAgent,
  ): Promise<{ lane: LaneSummary; created: boolean; pinned: boolean }> => {
    const branch = agent.branch?.trim() || null;
    if (branch && !branch.startsWith("-")) {
      const lanes = await deps.lanes.list({ includeArchived: false, includeStatus: false });
      // The primary lane is the user's own checkout; it never becomes a cloud lane.
      const existing = lanes.find((lane) => lane.branchRef === branch && lane.laneType !== "primary");
      if (existing) {
        ctx.tagCloudLane(existing, "devin");
        return { lane: existing, created: false, pinned: true };
      }
      const imported = await deps.lanes
        .importBranch({ branchRef: branch, name: entry.title.slice(0, 60) })
        .catch((error: unknown) => {
          if (!isBranchUnavailable(error)) throw error;
          logger.info("cloud_agents.devin_branch_unavailable", {
            branch,
            reason: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
      if (imported) {
        ctx.tagCloudLane(imported, "devin");
        return { lane: imported, created: true, pinned: true };
      }
    }
    // Opening must not fail on a push: the chat's first turn pins the branch
    // and says so if the VM cannot see it.
    const lane = await ctx.createCloudLane("devin", {
      name: entry.title.slice(0, 60),
      branchName: `devin/${slugify(entry.title)}-${entry.id.slice(0, 6)}`,
      onPushFailure: "warn",
    });
    return { lane, created: true, pinned: false };
  };

  const open = async (id: string): Promise<CloudAgentOpenResult> => {
    const [entry, { key, slug }, chats] = await Promise.all([
      directory.find(id, { force: true }),
      ctx.origin(),
      ctx.chatIndex("devinSessionId"),
    ]);
    const existing = chats.get(id);
    if (!entry && existing) {
      // The relay no longer lists it (archived there), but ADE has its chat:
      // reattach with the chat's own relay config, which keeps its history.
      const opened = await deps.chats.openDevinCloudChat({
        devinSessionId: id,
        laneId: existing.laneId,
        sessionId: existing.sessionId,
      });
      const lanes = await ctx.lanesById();
      return { chatSessionId: opened.sessionId, laneId: existing.laneId, laneName: lanes.get(existing.laneId)?.name ?? null, createdLane: false };
    }
    if (!entry) throw new Error("This Devin session is no longer listed. It may be archived.");
    const agent = devinEntryToAgent(entry, key, null);
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
      const lanes = await ctx.lanesById();
      return { chatSessionId: opened.sessionId, laneId: existing.laneId, laneName: lanes.get(existing.laneId)?.name ?? null, createdLane: false };
    }
    // A lane here is a checkout of this project. A session on another repo
    // has nothing to check out, and pinning it to a branch of ours would
    // point its VM at code it never cloned.
    if (!agent.inThisProject) {
      throw new Error(entry.repos.length
        ? `This session works on ${entry.repos.join(", ")}, not this project.`
        : "This session is not tied to a repository, so it has no lane in this project.");
    }
    const { lane, created, pinned } = await laneFor(entry, agent);
    const opened = await deps.chats.openDevinCloudChat({
      devinSessionId: entry.id,
      laneId: lane.id,
      devinCloud: { ...baseConfig, branch: lane.branchRef, pinned },
    });
    directory.invalidate();
    return { chatSessionId: opened.sessionId, laneId: lane.id, laneName: lane.name, createdLane: created };
  };

  const stop = async (id: string): Promise<{ stopped: true }> => {
    // A chat ADE is running owns the turn; stop it there so the chat settles.
    const chat = (await ctx.chatIndex("devinSessionId")).get(id);
    if (chat && chat.status === "active") {
      await deps.chats.interrupt(chat.sessionId);
    } else {
      await directory.cancel(id);
    }
    directory.invalidate();
    return { stopped: true };
  };

  const archive = async (id: string, archived: boolean): Promise<{ archived: boolean }> => {
    if (!archived) throw new Error("Unarchive Devin sessions on app.devin.ai.");
    await directory.archive(id);
    return { archived: true };
  };

  const launch: CloudAgentsStrategy["launch"] = async (args) => {
    const { prompt, slug, lane, created } = await ctx.prepareLaunch(args);
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
    directory.invalidate();
    return { chatSessionId: chat.id, laneId: lane.id, laneName: lane.name, createdLane: created };
  };

  return { list, open, stop, archive, launch };
}
