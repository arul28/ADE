import os from "node:os";
import type { Logger } from "../logging/logger";
import type { AgentChatEventEnvelope, LaneLinearIssue, LinearAgentOverview, NormalizedLinearIssue } from "../../../shared/types";
import type { LinearIngressEventRecord } from "../../../shared/types/linearSync";
import { linearIssueLaneName } from "../../../shared/linearIssueBranch";
import { resolveLinearRelayBaseUrl, type LinearRelayKvStore } from "../automations/linearRelayConfig";
import { normalizeTriggerType, type createAutomationService } from "../automations/automationService";
import { createLinearAgentRelayClient, type LinearAgentRelayClient } from "./linearAgentRelayClient";
import { createLinearAgentService, type LinearAgentService, type LinearAgentServiceDeps } from "./linearAgentService";

type AutomationService = ReturnType<typeof createAutomationService>;

/**
 * Builds the Linear agent for one runtime (the desktop's embedded runtime or
 * the headless brain), so both wire it the same way.
 */
export function createLinearAgentRuntime(args: {
  db: LinearRelayKvStore & { getJson<T>(key: string): T | null; setJson(key: string, value: unknown): void };
  logger: Logger;
  automationService: AutomationService;
  getLinearAccessToken: () => Promise<string | null>;
  getAccountAccessToken: () => Promise<string | null>;
  getAccountId: () => string | null;
  getMachineId: () => string | null;
  chat: LinearAgentServiceDeps["chat"];
  laneService: {
    create(args: { name: string; linearIssue?: LaneLinearIssue | null; branchName?: string }): Promise<{ id: string; name: string }>;
    attachLinearIssueToSession(args: { chatSessionId: string; issues: LaneLinearIssue[]; source?: "chat_attach" }): unknown;
    list?: (args?: { includeArchived?: boolean }) => Promise<Array<{ id: string; name: string }>>;
    getLaneName?: (laneId: string) => string | null;
  };
  fetchIssue: (issueId: string) => Promise<NormalizedLinearIssue | null>;
}): {
  relay: LinearAgentRelayClient;
  agent: LinearAgentService;
  /** Hand every Linear ingress record here; only agent session events are handled. */
  dispatch: (record: LinearIngressEventRecord) => void;
  onChatEvent: (envelope: AgentChatEventEnvelope) => void;
  getOverview: () => Promise<LinearAgentOverview>;
  dispose: () => void;
} {
  const relay = createLinearAgentRelayClient({
    getRelayBaseUrl: () => resolveLinearRelayBaseUrl(args.db),
    getLinearAccessToken: args.getLinearAccessToken,
    getAccountAccessToken: args.getAccountAccessToken,
  });
  const laneNames = new Map<string, string>();
  const machineName = os.hostname().replace(/\.local$/i, "") || null;

  const agent = createLinearAgentService({
    relay,
    logger: args.logger,
    machine: { id: args.getMachineId() ?? `host:${os.hostname()}`, name: machineName },
    getAccountId: args.getAccountId,
    kv: args.db,
    automation: {
      dispatchIngressTrigger: async (dispatch) => {
        const result = await args.automationService.dispatchIngressTrigger(dispatch);
        return result ? { status: result.status, errorMessage: result.errorMessage ?? null } : null;
      },
      hasMatchingLinearAgentRule: (match) => args.automationService.hasMatchingLinearAgentRule(match),
      setLinearAgentHooks: (hooks) => args.automationService.setLinearAgentHooks(hooks),
      listAgentRules: () =>
        args.automationService.listRules()
          .filter((rule) => rule.triggers.some((trigger) => normalizeTriggerType(trigger.type).startsWith("linear.agent_")))
          .map((rule) => ({
            id: rule.id,
            name: rule.name,
            enabled: rule.enabled,
            triggerTypes: rule.triggers.map((trigger) => normalizeTriggerType(trigger.type)),
            modelId: rule.modelConfig?.modelId ?? null,
            laneMode: rule.execution?.laneMode ?? null,
          })),
    },
    chat: args.chat,
    lanes: {
      createLaneForIssue: async (issue) => {
        const lane = await args.laneService.create({ name: linearIssueLaneName(issue), linearIssue: issue });
        laneNames.set(lane.id, lane.name);
        return lane.id;
      },
      attachIssueToSession: async ({ chatSessionId, issue }) => {
        args.laneService.attachLinearIssueToSession({ chatSessionId, issues: [issue], source: "chat_attach" });
      },
      getLaneName: async (laneId) => {
        const known = laneNames.get(laneId) ?? args.laneService.getLaneName?.(laneId) ?? null;
        if (known) return known;
        const lanes = await args.laneService.list?.({ includeArchived: false }).catch(() => []) ?? [];
        const lane = lanes.find((entry) => entry.id === laneId);
        if (lane) laneNames.set(lane.id, lane.name);
        return lane?.name ?? null;
      },
    },
    fetchIssue: args.fetchIssue,
  });

  return {
    relay,
    agent,
    dispatch: (record) => {
      if ((record.entityType ?? "").toLowerCase() !== "agentsessionevent") return;
      // Not awaited: a machine without a matching rule waits before it
      // answers, and the ingress cursor must not wait for that.
      void agent.handleEvent(record).catch((error) => {
        args.logger.warn("linear_agent.handle_event_failed", {
          eventId: record.eventId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onChatEvent: (envelope) => agent.onChatEvent(envelope),
    getOverview: () => agent.getOverview(),
    dispose: () => agent.dispose(),
  };
}

export type LinearAgentRuntime = ReturnType<typeof createLinearAgentRuntime>;
