/**
 * Cursor Cloud side of the cloud-agents contract: the fleet service (SDK +
 * API key) lists and stops agents, the chat service streams them. Archive and
 * launch need their own host capability; without it the verb says so.
 */
import type {
  CloudAgent,
  CloudAgentList,
  CloudAgentOpenResult,
  CloudAgentPullRequest,
  CloudAgentStatus,
} from "../../../../shared/types/cloudAgents";
import type { CursorCloudFleetEntry, CursorCloudFleetResult } from "../../../../shared/types/config";
import { laneCloudProvider } from "../../../../shared/cloudLanes";
import { repoMatchKey } from "../../../../shared/cursorCloudRepoMatch";
import { pullRequestNumber } from "../../../../shared/cursorCloudRepoMatch";
import type { CloudAgentsServiceDeps } from "./cloudAgentsContext";
import type { CloudAgentsContext, CloudAgentsStrategy } from "./cloudAgentsContext";

export type CursorCloudAgentsDeps = {
  /** Null when this host has no Cursor fleet; every verb then says so. */
  fleet: NonNullable<CloudAgentsServiceDeps["cursorFleet"]> | null;
  /** Null when this host cannot archive; the capability is then off. */
  archive: ((agentId: string, archived: boolean) => Promise<unknown>) | null;
  /** Null when this host cannot start runs; launch then says so. */
  createRun: NonNullable<CloudAgentsServiceDeps["cursorCreateRun"]> | null;
  /** Why Cursor cannot list right now (no API key), or null. */
  unavailableReason: (() => Promise<string | null>) | null;
};

const NOT_AVAILABLE = "Cursor Cloud is not available.";

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
  return {
    url,
    number: pullRequestNumber(url),
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

export function cursorCloudAgents(ctx: CloudAgentsContext, cursor: CursorCloudAgentsDeps): CloudAgentsStrategy {
  const { deps } = ctx;
  const capabilities = { stop: Boolean(cursor.fleet), archive: Boolean(cursor.archive), vmShell: false, web: true };

  const requireFleet = () => {
    if (!cursor.fleet) throw new Error(NOT_AVAILABLE);
    return cursor.fleet;
  };

  const list = async (force: boolean): Promise<CloudAgentList> => {
    const fetchedAt = new Date().toISOString();
    const unavailable = (reason: string): CloudAgentList =>
      ({ provider: "cursor", items: [], fetchedAt, capabilities, unavailableReason: reason, models: [] });
    if (!cursor.fleet) return unavailable("Cursor Cloud is not available on this machine.");
    const reason = await cursor.unavailableReason?.().catch(() => null) ?? null;
    if (reason) return unavailable(reason);
    let fleet: CursorCloudFleetResult;
    try {
      fleet = await cursor.fleet.getFleet({ force, includeArchived: true });
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
    const [{ key }, chats, lanes] = await Promise.all([ctx.origin(), ctx.chatIndex("cursorCloudAgentId"), ctx.lanesById()]);
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
        link: chat ? ctx.linkFor(chat, lanes) : entry.ownership.laneId && entry.ownership.sessionId
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

  const open = async (id: string): Promise<CloudAgentOpenResult> => {
    const fleet = requireFleet();
    const chats = await ctx.chatIndex("cursorCloudAgentId");
    const existing = chats.get(id);
    const resolved = existing
      ? { laneId: existing.laneId, laneName: null as string | null, created: false }
      : await fleet.resolveLaneForAgent(id);
    if (resolved.created) {
      const lane = (await ctx.lanesById()).get(resolved.laneId);
      if (lane) ctx.tagCloudLane(lane, "cursor");
    }
    const opened = await deps.chats.openCursorCloudChat({
      cloudAgentId: id,
      laneId: resolved.laneId,
      ...(existing ? { sessionId: existing.sessionId } : {}),
    });
    fleet.invalidateCache();
    return {
      chatSessionId: opened.sessionId,
      laneId: resolved.laneId,
      laneName: resolved.laneName,
      createdLane: resolved.created,
    };
  };

  const stop = async (id: string): Promise<{ stopped: true }> => {
    await requireFleet().stopAgentRun(id);
    return { stopped: true };
  };

  const archive = async (id: string, archived: boolean): Promise<{ archived: boolean }> => {
    if (!cursor.archive) throw new Error("Archiving Cursor agents is not available.");
    await cursor.archive(id, archived);
    cursor.fleet?.invalidateCache();
    return { archived };
  };

  const launch: CloudAgentsStrategy["launch"] = async (args) => {
    // Checked before the lane: a launch that cannot start must not leave one.
    const createRun = cursor.createRun;
    if (!createRun) throw new Error(NOT_AVAILABLE);
    const { prompt, slug, lane, created } = await ctx.prepareLaunch(args);
    const run = await createRun({
      promptText: prompt,
      repoUrl: `https://github.com/${slug}`,
      startingRef: lane.branchRef,
      modelId: args.model?.trim() || null,
      laneId: lane.id,
    });
    const opened = await deps.chats.openCursorCloudChat({ cloudAgentId: run.agent.agentId, laneId: lane.id });
    cursor.fleet?.invalidateCache();
    return { chatSessionId: opened.sessionId, laneId: lane.id, laneName: lane.name, createdLane: created };
  };

  return { list, open, stop, archive, launch };
}
