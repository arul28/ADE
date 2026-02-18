import type { Logger } from "../logging/logger";
import type { createPackService } from "../packs/packService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createHostedAgentService } from "../hosted/hostedAgentService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createByokLlmService } from "../byok/byokLlmService";
import { redactSecrets } from "../../utils/redaction";

type RefreshRequest = {
  laneId: string;
  reason: string;
  sessionId?: string;
};

type LaneQueueState = {
  running: boolean;
  pending: boolean;
  next: RefreshRequest | null;
};

function clipDeterministic(text: string, maxChars: number): { text: string; clipped: boolean } {
  const raw = String(text ?? "");
  if (raw.length <= maxChars) return { text: raw, clipped: false };
  return { text: `${raw.slice(0, Math.max(0, maxChars - 28)).trimEnd()}\n\n...(context clipped)...\n`, clipped: true };
}

export function createJobEngine({
  logger,
  packService,
  conflictService,
  hostedAgentService,
  projectConfigService,
  byokLlmService
}: {
  logger: Logger;
  packService: ReturnType<typeof createPackService>;
  conflictService?: ReturnType<typeof createConflictService>;
  hostedAgentService?: ReturnType<typeof createHostedAgentService>;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
  byokLlmService?: ReturnType<typeof createByokLlmService>;
}) {
  const laneQueue = new Map<string, LaneQueueState>();
  const dirtyLaneQueue = new Set<string>();
  let dirtyQueueTimer: NodeJS.Timeout | null = null;
  let fullConflictPredictionQueued = false;
  let periodicTimer: NodeJS.Timeout | null = null;

  const ensureState = (laneId: string): LaneQueueState => {
    const existing = laneQueue.get(laneId);
    if (existing) return existing;
    const created: LaneQueueState = { running: false, pending: false, next: null };
    laneQueue.set(laneId, created);
    return created;
  };

  const runLaneRefresh = async (laneId: string) => {
    const state = ensureState(laneId);
    if (state.running) return;
    state.running = true;

    while (state.pending) {
      const payload = state.next;
      state.pending = false;
      state.next = null;
      if (!payload) continue;

      try {
        logger.info("jobs.refresh_lane.begin", payload);

        const lanePack = await packService.refreshLanePack({
          laneId: payload.laneId,
          reason: payload.reason,
          sessionId: payload.sessionId
        });

        await packService.refreshProjectPack({
          reason: payload.reason,
          laneId: payload.laneId
        });

        // If AI is configured, refresh the narrative in the background after deterministic refresh.
        // This keeps packs useful without requiring users to click a separate "AI summary" button.
          void (async () => {
          const providerMode = projectConfigService?.get().effective.providerMode ?? "guest";
          if (providerMode === "guest") return;

          const laneExport = await packService.getLaneExport({ laneId: payload.laneId, level: "standard" });
          const projectExport = await packService.getProjectExport({ level: "lite" });
          const laneExportClip = clipDeterministic(redactSecrets(laneExport.content), 220_000);
          const projectExportClip = clipDeterministic(redactSecrets(projectExport.content), 120_000);
          const packBody = laneExportClip.text;
          const lanePackKey =
            typeof laneExport.header?.packKey === "string" && laneExport.header.packKey.trim().length
              ? laneExport.header.packKey
              : lanePack.packKey;
          const projectPackKey =
            typeof projectExport.header?.packKey === "string" && projectExport.header.packKey.trim().length
              ? projectExport.header.packKey
              : null;
          const peerLanesContext = packService.getPeerLanesContext(payload.laneId);
          const projectExportWithPeers = peerLanesContext
            ? `${projectExportClip.text}\n\n${peerLanesContext}`
            : projectExportClip.text;
          const projectContext = {
            projectExport: projectExportWithPeers,
            refs: {
              lanePackKey,
              projectPackKey
            },
            omissions: [
              ...(laneExport.clipReason ? [`lane_export:${laneExport.clipReason}`] : []),
              ...(projectExport.clipReason ? [`project_export:${projectExport.clipReason}`] : []),
              ...(laneExportClip.clipped ? ["lane_export:clipped_for_job"] : []),
              ...(projectExportClip.clipped ? ["project_export:clipped_for_job"] : []),
              ...((laneExport.omittedSections ?? []).map((entry) => `lane_export:${entry}`)),
              ...((projectExport.omittedSections ?? []).map((entry) => `project_export:${entry}`))
            ],
            assumptions: {
              prdPreferred: true,
              architecturePreferred: true
            }
          };

          const submittedAt = new Date().toISOString();
          let jobId: string | null = null;
          let lastStatus: "queued" | "processing" | "completed" | "failed" | null = null;

          const recordRequested = (submission: {
            jobId: string;
            status: "queued" | "processing" | "completed" | "failed";
            contextDelivery?: {
              mode: string;
              contextSource?: string;
              reasonCode: string;
              contextRefSha256: string | null;
              warnings: string[];
              confidenceLevel?: "high" | "medium" | "low";
            };
          }) => {
            jobId = submission.jobId;
            lastStatus = submission.status;
            try {
              packService.recordEvent({
                packKey: lanePack.packKey,
                eventType: "narrative_requested",
                payload: {
                  laneId: payload.laneId,
                  providerMode,
                  jobId: submission.jobId,
                  status: submission.status,
                  submittedAt,
                  trigger: payload.reason,
                  sessionId: payload.sessionId ?? null,
                  deterministicUpdatedAt: lanePack.deterministicUpdatedAt,
                  contentHash: lanePack.contentHash,
                  exportLevel: laneExport.level,
                  exportApproxTokens: laneExport.approxTokens,
                  exportMaxTokens: laneExport.maxTokens,
                  projectExportLevel: projectExport.level,
                  projectExportApproxTokens: projectExport.approxTokens,
                  projectExportMaxTokens: projectExport.maxTokens,
                  projectContextOmissions: projectContext.omissions,
                  ...(submission.contextDelivery
                    ? {
                        contextDeliveryMode: submission.contextDelivery.mode,
                        contextDeliverySource: submission.contextDelivery.contextSource ?? submission.contextDelivery.mode,
                        contextDeliveryReason: submission.contextDelivery.reasonCode,
                        contextDeliveryRefSha256: submission.contextDelivery.contextRefSha256,
                        contextDeliveryWarnings: submission.contextDelivery.warnings,
                        contextDeliveryConfidence: submission.contextDelivery.confidenceLevel ?? null,
                        contextDeliveryFallback: (submission.contextDelivery.contextSource ?? "").includes("fallback")
                      }
                    : {})
                }
              });
            } catch {
              // ignore event creation failures
            }
          };

          try {
            if (providerMode === "hosted") {
              if (!hostedAgentService?.getStatus().enabled) {
                throw new Error("Hosted AI is selected but not ready. Go to Settings → Provider, grant consent, apply bootstrap, and sign in.");
              }
              const narrative = await hostedAgentService.requestLaneNarrative({
                laneId: payload.laneId,
                packBody,
                projectContext,
                onJobSubmitted: recordRequested,
                onJobStatus: (status) => {
                  lastStatus = status.status;
                }
              });
              packService.applyHostedNarrative({
                laneId: payload.laneId,
                narrative: narrative.narrative,
                metadata: {
                  jobId: narrative.jobId,
                  artifactId: narrative.artifactId,
                  provider: narrative.provider,
                  model: narrative.model,
                  inputTokens: narrative.inputTokens,
                  outputTokens: narrative.outputTokens,
                  latencyMs: narrative.latencyMs,
                  timing: narrative.timing,
                  timeoutReason: narrative.timing?.timeoutReason ?? null,
                  trigger: payload.reason,
                  sessionId: payload.sessionId ?? null
                }
              });
              return;
            }

            if (providerMode === "byok") {
              if (!byokLlmService) {
                throw new Error("BYOK provider is selected but BYOK LLM service is unavailable.");
              }
              try {
                packService.recordEvent({
                  packKey: lanePack.packKey,
                  eventType: "narrative_requested",
                  payload: {
                    laneId: payload.laneId,
                    providerMode,
                    status: "processing",
                    submittedAt,
                    trigger: payload.reason,
                    sessionId: payload.sessionId ?? null,
                    deterministicUpdatedAt: lanePack.deterministicUpdatedAt,
                    contentHash: lanePack.contentHash
                  }
                });
              } catch {
                // ignore event creation failures
              }
              const narrative = await byokLlmService.generateLaneNarrative({
                laneId: payload.laneId,
                packBody: [packBody, "", "## Project Context", projectContext.projectExport].join("\n")
              });
              packService.applyHostedNarrative({
                laneId: payload.laneId,
                narrative: narrative.narrative,
                metadata: {
                  source: "byok",
                  provider: narrative.provider,
                  model: narrative.model,
                  trigger: payload.reason,
                  sessionId: payload.sessionId ?? null
                }
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const hostedTelemetry = providerMode === "hosted" ? hostedAgentService?.getStatus().contextTelemetry ?? null : null;
            logger.warn("jobs.refresh_lane.narrative_failed", {
              laneId: payload.laneId,
              providerMode,
              error: message
            });
            try {
              packService.recordEvent({
                packKey: lanePack.packKey,
                eventType: "narrative_failed",
                payload: {
                  laneId: payload.laneId,
                  providerMode,
                  ...(jobId ? { jobId } : {}),
                  ...(lastStatus ? { status: lastStatus } : {}),
                  submittedAt,
                  trigger: payload.reason,
                  sessionId: payload.sessionId ?? null,
                  error: message,
                  timeoutReason: hostedTelemetry?.lastNarrativeTimeoutReason ?? null,
                  timing: hostedTelemetry?.lastNarrativeTiming ?? null
                }
              });
            } catch {
              // ignore event creation failures
            }
          }
        })();

        logger.info("jobs.refresh_lane.done", payload);
      } catch (error) {
        logger.error("jobs.refresh_lane.failed", {
          ...payload,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    state.running = false;
  };

  const enqueueLaneRefresh = (request: RefreshRequest) => {
    const state = ensureState(request.laneId);
    state.pending = true;
    state.next = request;
    void runLaneRefresh(request.laneId);
  };

  const flushConflictPredictionQueue = async () => {
    dirtyQueueTimer = null;
    if (!conflictService) return;

    if (fullConflictPredictionQueued) {
      fullConflictPredictionQueued = false;
      dirtyLaneQueue.clear();
      try {
        logger.info("jobs.conflicts.predict.begin", { scope: "all" });
        await conflictService.runPrediction({});
        logger.info("jobs.conflicts.predict.done", { scope: "all" });
      } catch (error) {
        logger.warn("jobs.conflicts.predict.failed", {
          scope: "all",
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    const laneIds = Array.from(dirtyLaneQueue);
    dirtyLaneQueue.clear();
    for (const laneId of laneIds) {
      try {
        logger.info("jobs.conflicts.predict.begin", { scope: "lane", laneId });
        await conflictService.runPrediction({ laneId });
        logger.info("jobs.conflicts.predict.done", { scope: "lane", laneId });
      } catch (error) {
        logger.warn("jobs.conflicts.predict.failed", {
          scope: "lane",
          laneId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const queueConflictPrediction = (args: { laneId?: string; debounceMs?: number }) => {
    if (!conflictService) return;
    if (args.laneId) {
      dirtyLaneQueue.add(args.laneId);
    } else {
      fullConflictPredictionQueued = true;
      dirtyLaneQueue.clear();
    }
    if (dirtyQueueTimer) clearTimeout(dirtyQueueTimer);
    dirtyQueueTimer = setTimeout(() => {
      void flushConflictPredictionQueue();
    }, args.debounceMs ?? 1_200);
  };

  const startPeriodicPrediction = () => {
    if (!conflictService || periodicTimer) return;
    periodicTimer = setInterval(() => {
      queueConflictPrediction({ debounceMs: 250 });
    }, 120_000);
  };

  startPeriodicPrediction();
  queueConflictPrediction({ debounceMs: 2_000 });

  return {
    enqueueLaneRefresh,

    onSessionEnded(args: { laneId: string; sessionId: string }) {
      enqueueLaneRefresh({
        laneId: args.laneId,
        sessionId: args.sessionId,
        reason: "session_end"
      });
    },

    onHeadChanged(args: { laneId: string; reason: string }) {
      enqueueLaneRefresh({
        laneId: args.laneId,
        reason: args.reason
      });
      queueConflictPrediction({ laneId: args.laneId, debounceMs: 1_500 });
    },

    onLaneDirtyChanged(args: { laneId: string; reason: string }) {
      logger.debug("jobs.conflicts.queue_lane_dirty", args);
      queueConflictPrediction({ laneId: args.laneId, debounceMs: 900 });
    },

    runConflictPredictionNow(args: { laneId?: string } = {}) {
      queueConflictPrediction({ laneId: args.laneId, debounceMs: 0 });
    },

    dispose() {
      if (dirtyQueueTimer) {
        clearTimeout(dirtyQueueTimer);
        dirtyQueueTimer = null;
      }
      if (periodicTimer) {
        clearInterval(periodicTimer);
        periodicTimer = null;
      }
    }
  };
}
