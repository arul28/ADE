import path from "node:path";
import type {
  ManifestSection,
  OrchestrationAgentInjectRequest,
  OrchestrationAssetRegisterRequest,
  OrchestrationClaimTaskRequest,
  OrchestrationManifestPatchRequest,
  OrchestrationOrigin,
  OrchestrationPlanAppendRequest,
  OrchestrationPlanWriteRequest,
  OrchestrationReleaseTaskRequest,
  OrchestrationRunCreateRequest,
  OrchestrationSpawnAgentRequest,
} from "../../../shared/types/orchestration";
import type { createAgentChatService } from "../chat/agentChatService";
import type { OrchestrationService } from "./orchestrationService";
import { validateSpawnBrief } from "./orchestrationService";
import {
  applyOrchestrationPermissionProfile,
  isOrchestrationPlanApproved,
  resolveOrchestrationModel,
} from "./runtimeProfile";

type LaneWorktreeResolver = {
  getLaneWorktreePath: (laneId: string) => string;
};

/**
 * Subset of the agent-chat service the orchestration domain drives. Both the
 * desktop in-process context and the daemon runtime construct the same
 * `createAgentChatService`, so the `Pick` keeps this module decoupled from the
 * full service surface while still validating the call sites.
 */
export type OrchestrationDomainAgentChat = Pick<
  ReturnType<typeof createAgentChatService>,
  "createSession" | "deleteSession" | "sendMessage" | "steer" | "interrupt" | "setOrchestrationFields"
>;

export type OrchestrationDomainDeps = {
  orchestrationService: OrchestrationService;
  laneService: LaneWorktreeResolver;
  agentChatService: OrchestrationDomainAgentChat;
};

type RunCreateArgs = Omit<OrchestrationRunCreateRequest, "bundleRoot"> & { laneId: string };

/**
 * The orchestration action domain — the single source of truth shared by the
 * daemon's `run_ade_action` registry and the desktop in-process IPC handlers.
 * Every method resolves the run's on-disk bundle from `(laneId, runId)` and
 * delegates to the long-lived {@link OrchestrationService}.
 */
export function createOrchestrationDomainService(deps: OrchestrationDomainDeps) {
  const { orchestrationService: service, laneService, agentChatService } = deps;

  const bundlePathFor = (laneId: string, runId: string): string =>
    path.join(laneService.getLaneWorktreePath(laneId), ".ade", "orchestration", runId);

  return {
    runCreate: async (arg: RunCreateArgs) => {
      const worktree = laneService.getLaneWorktreePath(arg.laneId);
      const result = await service.runCreate({ ...arg, bundleRoot: worktree });
      // Stitch the run id + bundle path back into the lead chat's persisted
      // record so the OrchestrationPanel mounts after a restart and downstream
      // tooling can discover the bundle from the chat session alone.
      try {
        agentChatService.setOrchestrationFields(arg.leadSessionId, {
          orchestrationRunId: result.runId,
          orchestrationRole: "lead",
          orchestrationBundlePath: result.manifest.bundlePath,
        });
      } catch {
        // Best-effort; the renderer also patches its local cache so the panel
        // mounts immediately, and persisted state falls through to a later
        // updateSession call if needed.
      }
      return result;
    },

    bundleRead: (arg: { runId: string; laneId: string }) =>
      service.bundleRead(arg.runId, bundlePathFor(arg.laneId, arg.runId)),

    manifestReadSection: (arg: { runId: string; laneId: string; section: ManifestSection }) =>
      service.manifestReadSection(arg.runId, bundlePathFor(arg.laneId, arg.runId), arg.section),

    manifestPatch: (arg: OrchestrationManifestPatchRequest & { laneId: string }) =>
      service.manifestPatch(arg, bundlePathFor(arg.laneId, arg.runId)),

    planAppend: (arg: OrchestrationPlanAppendRequest & { laneId: string }) =>
      service.planAppend(arg, bundlePathFor(arg.laneId, arg.runId)),

    planWrite: (arg: OrchestrationPlanWriteRequest & { laneId: string }) =>
      service.planWrite(arg, bundlePathFor(arg.laneId, arg.runId)),

    assetRegister: (arg: OrchestrationAssetRegisterRequest & { laneId: string }) =>
      service.assetRegister(arg, bundlePathFor(arg.laneId, arg.runId)),

    claimTask: (arg: OrchestrationClaimTaskRequest & { laneId: string }) =>
      service.claimTask(arg, bundlePathFor(arg.laneId, arg.runId)),

    releaseTask: (arg: OrchestrationReleaseTaskRequest & { laneId: string }) =>
      service.releaseTask(arg, bundlePathFor(arg.laneId, arg.runId)),

    runList: (arg: { laneId?: string } = {}) => service.runList(arg?.laneId),

    spawnAgent: async (
      arg: OrchestrationSpawnAgentRequest & { laneId: string; leadSessionId: string },
    ): Promise<{ sessionId: string; etag: string }> => {
      const bundlePath = bundlePathFor(arg.laneId, arg.runId);
      const manifest = service.getManifestForRun(arg.runId);
      if (!manifest) {
        throw new Error(`run ${arg.runId} not loaded — call orchestrationBundleRead first`);
      }
      if (!isOrchestrationPlanApproved(manifest)) {
        throw new Error("spawnAgent is blocked until the user approves the orchestration plan.");
      }
      const brief = validateSpawnBrief(arg.initialMessage);
      if (!brief.ok) {
        throw new Error(`spawn brief missing required sections: ${brief.missing.join(", ")}`);
      }
      const routedSelection = resolveOrchestrationModel(manifest, arg.role, arg.tag, arg.modelOverride);
      const interactionMode =
        arg.role === "validator" ? "orchestrator-validator" : "orchestrator-worker";
      const created = await agentChatService.createSession({
        laneId: arg.laneId,
        provider: routedSelection.provider,
        model: routedSelection.modelId,
        reasoningEffort: routedSelection.reasoningEffort ?? null,
        fastMode: routedSelection.fastMode,
        interactionMode,
        surface: "work",
        ...applyOrchestrationPermissionProfile(routedSelection.provider),
        orchestrationRunId: arg.runId,
        orchestrationRole: arg.role,
        orchestrationParentSessionId: arg.leadSessionId,
        orchestrationTag: arg.tag,
        orchestrationStepId: arg.stepId,
        orchestrationBundlePath: bundlePath,
        goal: arg.goalSummary,
      });
      const spawnedAt = new Date().toISOString();
      const fp = {
        provider: routedSelection.provider,
        modelId: routedSelection.modelId,
        reasoningEffort: routedSelection.reasoningEffort ?? null,
        fastMode: routedSelection.fastMode,
        resolvedAt: spawnedAt,
        routingKey: routedSelection.routingKey,
      };
      const buildSpawnPatch = (etag: string, summary: string) => ({
        runId: arg.runId,
        ifMatchEtag: etag,
        actorRole: "lead" as const,
        actorSessionId: arg.leadSessionId,
        summary,
        patches: [
          {
            op: "add" as const,
            path: "/agents/-",
            value: {
              sessionId: created.id,
              role: arg.role,
              tag: arg.tag,
              goalSummary: arg.goalSummary,
              status: "pending",
              spawnedAt,
              currentStepId: arg.stepId,
              spawnFingerprint: fp,
            },
          },
        ],
      });
      let patchRes = await service.manifestPatch(buildSpawnPatch(manifest.etag, "spawn worker"), bundlePath);
      if (!patchRes.ok && "manifest" in patchRes && patchRes.manifest) {
        patchRes = await service.manifestPatch(
          buildSpawnPatch(patchRes.manifest.etag, "spawn worker (retry)"),
          bundlePath,
        );
      }
      if (!patchRes.ok) {
        await agentChatService.deleteSession({ sessionId: created.id });
        throw new Error(
          `spawn manifest patch failed: ${"error" in patchRes ? patchRes.error : "unknown"}`,
        );
      }
      const origin: OrchestrationOrigin = {
        runId: arg.runId,
        fromSessionId: arg.leadSessionId,
        kind: "wake",
        intent: "directive",
        taskId: arg.stepId,
      };
      await agentChatService.sendMessage(
        {
          sessionId: created.id,
          text: arg.initialMessage,
          metadata: { orchestrationOrigin: origin },
        },
        { awaitDispatch: false },
      );
      return { sessionId: created.id, etag: patchRes.etag };
    },

    agentInject: async (arg: OrchestrationAgentInjectRequest): Promise<void> => {
      const manifest = service.getManifestForRun(arg.runId);
      if (!manifest) throw new Error(`run ${arg.runId} not loaded`);
      const fromAgent = manifest.agents.find((a) => a.sessionId === arg.fromSessionId);
      const targetAgent = manifest.agents.find((a) => a.sessionId === arg.targetSessionId);
      if (!fromAgent || !targetAgent) {
        throw new Error("orchestrationAgentInject: source/target not in same run");
      }
      const origin: OrchestrationOrigin = {
        runId: arg.runId,
        fromSessionId: arg.fromSessionId,
        kind: arg.payload.kind,
        intent: arg.payload.intent,
        taskId: arg.payload.taskId,
      };
      if (arg.payload.kind === "queue") {
        await agentChatService.steer({
          sessionId: arg.targetSessionId,
          text: arg.payload.text,
          metadata: { orchestrationOrigin: origin },
        });
      } else if (arg.payload.kind === "interrupt-replace") {
        await agentChatService.interrupt({ sessionId: arg.targetSessionId });
        await agentChatService.sendMessage(
          {
            sessionId: arg.targetSessionId,
            text: arg.payload.text,
            metadata: { orchestrationOrigin: origin },
          },
          { awaitDispatch: false },
        );
      } else {
        await agentChatService.sendMessage(
          {
            sessionId: arg.targetSessionId,
            text: arg.payload.text,
            metadata: { orchestrationOrigin: origin },
          },
          { awaitDispatch: false },
        );
      }
    },

    subscribe: async (arg: { runId: string; laneId?: string }) => {
      if (typeof arg.laneId === "string" && arg.laneId.trim()) {
        await service.subscribe(arg.runId, bundlePathFor(arg.laneId, arg.runId));
      }
      return { ok: true, runId: arg.runId };
    },

    unsubscribe: async (arg: { runId: string }) => {
      await service.release(arg.runId);
      return { ok: true };
    },
  };
}

export type OrchestrationDomainService = ReturnType<typeof createOrchestrationDomainService>;
