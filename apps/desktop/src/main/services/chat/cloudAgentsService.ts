/**
 * Cloud agents: one contract over Devin Cloud sessions and Cursor Cloud agents.
 *
 * Each provider keeps its own client — Devin through the ACP relay directory
 * (`devin acp --cloud`, CLI login, no token), Cursor through its fleet service
 * (SDK + API key) — and this service maps both onto `CloudAgent` rows and the
 * same verbs: list, open, stop, archive, launch. Each provider is one
 * strategy (`cloudAgents/devinCloudAgents.ts`, `cloudAgents/cursorCloudAgents.ts`)
 * over a shared context (`cloudAgents/cloudAgentsContext.ts`).
 *
 * "Open" is the verb that makes a cloud agent part of ADE. It finds or makes
 * the agent's cloud lane — a lane on the agent's branch whose machine is the
 * provider's cloud — and opens the agent's chat in it. The chat is live: the
 * Devin chat rides the relay, the Cursor chat the SDK stream.
 */
import type { Logger } from "../logging/logger";
import type { LaneSummary } from "../../../shared/types/lanes";
import type {
  AgentChatDevinCloudConfig,
  AgentChatSessionSummary,
} from "../../../shared/types/chat";
import type {
  CloudAgentArchiveArgs,
  CloudAgentLaunchArgs,
  CloudAgentList,
  CloudAgentListArgs,
  CloudAgentOpenResult,
  CloudAgentProvider,
  CloudAgentRef,
} from "../../../shared/types/cloudAgents";
import type { CursorCloudFleetResult } from "../../../shared/types/config";
import { normalizeDevinCloudSessionId } from "../../../shared/devinCloud";
import { createDevinCloudDirectory, type DevinCloudDirectory } from "./devinCloudDirectory";
import {
  ONE_AGENT_PER_LANE_MESSAGE,
  createCloudAgentsContext,
  type CloudAgentsServiceDeps,
  type CloudAgentsStrategy,
} from "./cloudAgents/cloudAgentsContext";

export type { CloudAgentsServiceDeps };
import { devinCloudAgents } from "./cloudAgents/devinCloudAgents";
import { cursorCloudAgents } from "./cloudAgents/cursorCloudAgents";



/**
 * The service over both strategies. Each verb dispatches to the provider's
 * strategy; two calls that would race on the same thing share one flight
 * instead — opening one agent twice, or two launches into one lane.
 */
export function createCloudAgentsService(deps: CloudAgentsServiceDeps) {
  const ctx = createCloudAgentsContext(deps);
  const strategies: Record<CloudAgentProvider, CloudAgentsStrategy> = {
    devin: devinCloudAgents(ctx, deps.devinDirectory),
    cursor: cursorCloudAgents(ctx, {
      fleet: deps.cursorFleet,
      archive: deps.cursorArchive ?? null,
      createRun: deps.cursorCreateRun ?? null,
      unavailableReason: deps.cursorUnavailableReason ?? null,
    }),
  };
  const inflight = new Map<string, Promise<CloudAgentOpenResult>>();
  const shareFlight = (key: string, run: () => Promise<CloudAgentOpenResult>): Promise<CloudAgentOpenResult> => {
    const current = inflight.get(key);
    if (current) return current;
    const flight = run().finally(() => {
      if (inflight.get(key) === flight) inflight.delete(key);
    });
    inflight.set(key, flight);
    return flight;
  };

  const list = async (args: CloudAgentListArgs): Promise<CloudAgentList> =>
    await strategies[args.provider].list(args.force === true);

  /** One id form per provider for every verb: Devin's bare web id, validated. */
  const agentId = (provider: CloudAgentProvider, id: string): string =>
    provider === "devin" ? normalizeDevinCloudSessionId(id) : id.trim();

  const open = async (ref: CloudAgentRef): Promise<CloudAgentOpenResult> => {
    const id = agentId(ref.provider, ref.id);
    return await shareFlight(`${ref.provider}:${id}`, () => strategies[ref.provider].open(id));
  };

  const stop = async (ref: CloudAgentRef): Promise<{ stopped: true }> =>
    await strategies[ref.provider].stop(agentId(ref.provider, ref.id));

  const archive = async (args: CloudAgentArchiveArgs): Promise<{ archived: boolean }> =>
    await strategies[args.provider].archive(agentId(args.provider, args.id), args.archived);

  const launch = async (args: CloudAgentLaunchArgs): Promise<CloudAgentOpenResult> => {
    const laneId = args.laneId?.trim();
    if (!laneId) return await strategies[args.provider].launch(args);
    // A second launch into a lane whose first is still starting would pass
    // the running-chat check (no chat yet) and put two VMs on one branch.
    const key = `lane:${laneId}`;
    if (inflight.has(key)) throw new Error(ONE_AGENT_PER_LANE_MESSAGE);
    return await shareFlight(key, () => strategies[args.provider].launch({ ...args, laneId }));
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
    list: CloudAgentsServiceDeps["lanes"]["list"];
    importBranch: CloudAgentsServiceDeps["lanes"]["importBranch"];
    create: CloudAgentsServiceDeps["lanes"]["create"];
    updateAppearance: CloudAgentsServiceDeps["lanes"]["updateAppearance"];
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
  const { archiveCursorAgent, unarchiveCursorAgent } = host;
  return createCloudAgentsService({
    projectRoot: host.projectRoot,
    logger: host.logger,
    devinDirectory: createDevinCloudDirectory({ logger: host.logger, cwd: host.projectRoot, resolveBinary: host.resolveDevinBinary }),
    cursorFleet: host.cursorFleet,
    cursorArchive: archiveCursorAgent && unarchiveCursorAgent
      ? (agentId, archived) => (archived ? archiveCursorAgent(agentId) : unarchiveCursorAgent(agentId))
      : null,
    lanes: {
      list: (args) => host.laneService.list(args),
      importBranch: (args) => host.laneService.importBranch(args),
      create: (args) => host.laneService.create(args),
      updateAppearance: (args) => host.laneService.updateAppearance(args),
    },
    chats: {
      // Archived chats included: an agent linked to one is still that chat's,
      // and opening it must reuse it rather than make a second lane.
      list: () => chats().listSessions(undefined, { includeArchived: true }),
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
