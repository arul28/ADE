import path from "node:path";

import type {
  AgentChatRegenerateSessionMetadataArgs,
  AgentChatRegenerateSessionMetadataResult,
  AgentChatSession,
  AgentChatSessionMetadataField,
} from "../../../shared/types/chat";
import { normalizeAgentChatSessionMetadataFields } from "../../../shared/types/chat";

import {
  buildSessionMetadataPrompt,
  buildSessionMetadataSystemPrompt,
  clipFromEnd,
  deriveDeterministicSessionMetadata,
  extractLatestAssistantParagraphs,
  formatConversationTranscript,
  formatLaneThreadsForPrompt,
  formatLaneWorkVersusRemote,
  runSessionMetadataGeneration,
  sessionMetadataPromptNeeds,
  SESSION_METADATA_TRANSCRIPT_CHAR_LIMIT,
  type SessionMetadataConversationEntry,
  type SessionMetadataLaneThread,
  type SessionMetadataPromptRunner,
} from "./sessionNaming";
import type { Logger } from "../logging/logger";

export type SessionMetadataManagedSession = {
  session: AgentChatSession;
  laneWorktreePath: string;
  preview: string | null;
  autoTitleSeed: string | null;
  deleted: boolean;
  sessionMetadataGenerationVersion: number;
  sessionMetadataTitleRevision: number;
};

export type SessionMetadataSessionRow = {
  title: string;
  laneName: string;
  statusNote: string | null;
  lastOutputPreview: string | null;
  summary: string | null;
};

export type SessionMetadataLaneSummary = {
  name: string;
  baseRef?: string | null;
  worktreePath?: string | null;
};

export type SessionMetadataLaneWorkSnapshot = {
  baseRef: string;
  commits?: string | null;
  changedFiles?: string | null;
  uncommitted?: string | null;
};

export type SessionMetadataRegeneratorDependencies<ManagedSession extends SessionMetadataManagedSession> = {
  ensureManagedSession: (sessionId: string) => ManagedSession;
  getSession: (sessionId: string) => SessionMetadataSessionRow | null;
  getLaneSummary: (
    laneId: string,
    options: { includeStatus?: boolean },
  ) => Promise<SessionMetadataLaneSummary | null>;
  resolveModelCandidates: (managed: ManagedSession) => Promise<string[]>;
  collectConversationEntries: (managed: ManagedSession) => SessionMetadataConversationEntry[];
  listLaneThreads: (managed: ManagedSession) => SessionMetadataLaneThread[];
  gatherLaneWorkVersusRemote: (args: {
    worktreePath: string;
    baseRef: string;
  }) => Promise<SessionMetadataLaneWorkSnapshot | null>;
  runPrompt: SessionMetadataPromptRunner;
  normalizeTitle: (value: string) => string | null;
  normalizeStatusLine: (value: string) => string | null;
  applyTitle: (managed: ManagedSession, title: string) => Promise<string | null>;
  setStatusNote: (sessionId: string, note: string | null) => boolean;
  renameLane: (args: { laneId: string; name: string }) => void;
  persistChatState: (managed: ManagedSession) => void;
  onRegenerated?: (event: {
    sessionId: string;
    outcome: "completed" | "partial" | "failed";
  }) => void;
  logger: Logger;
};

/**
 * Own the explicit title/lane/status refresh workflow outside the large chat
 * runtime service. Provider/model selection and persistence stay injected so
 * this module remains a narrow coordinator rather than a second chat service.
 */
export function createSessionMetadataRegenerator<ManagedSession extends SessionMetadataManagedSession>(
  dependencies: SessionMetadataRegeneratorDependencies<ManagedSession>,
): (
  args: AgentChatRegenerateSessionMetadataArgs,
) => Promise<AgentChatRegenerateSessionMetadataResult> {
  return async (
    args: AgentChatRegenerateSessionMetadataArgs,
  ): Promise<AgentChatRegenerateSessionMetadataResult> => {
    const sessionId = args.sessionId.trim();
    const managed = dependencies.ensureManagedSession(sessionId);
    const fields = normalizeAgentChatSessionMetadataFields(args.fields);
    if (!fields.length) {
      throw new Error("Choose at least one piece of session metadata to generate.");
    }

    // This version belongs to the explicit request, not to manual title edits.
    // A later generation therefore cancels this whole result, while a manual
    // title edit is handled per-field by comparing the title snapshot and
    // revision below.
    const generationVersion = ++managed.sessionMetadataGenerationVersion;
    const initialRow = dependencies.getSession(sessionId);
    if (!initialRow) throw new Error(`Chat session '${sessionId}' was not found.`);
    const initialLane = await dependencies.getLaneSummary(managed.session.laneId, { includeStatus: false }).catch(() => null);
    const snapshot = {
      title: initialRow.title,
      titleRevision: managed.sessionMetadataTitleRevision,
      laneName: initialLane?.name ?? initialRow.laneName,
      statusLine: initialRow.statusNote ?? null,
    };
    const applied: AgentChatSessionMetadataField[] = [];
    const skipped: AgentChatSessionMetadataField[] = [];
    let selectedModelId: string | null = null;
    let attemptCount = 0;

    const notifyOutcome = (outcome: "completed" | "partial" | "failed"): void => {
      try {
        dependencies.onRegenerated?.({ sessionId, outcome });
      } catch (error) {
        dependencies.logger.warn("agent_chat.session_metadata_callback_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    try {
      const candidateModelIds = await dependencies.resolveModelCandidates(managed);
      const needs = sessionMetadataPromptNeeds(fields);
      const conversationEntries = (needs.title || needs.statusLine)
        ? dependencies.collectConversationEntries(managed)
        : [];
      const threadTranscript = needs.title
        ? clipFromEnd(
          formatConversationTranscript(conversationEntries),
          SESSION_METADATA_TRANSCRIPT_CHAR_LIMIT,
        )
        : "";
      const latestAssistantParagraphs = needs.statusLine
        ? extractLatestAssistantParagraphs(conversationEntries)
        : "";
      let latestOutputPreview: string | null = null;
      if (needs.statusLine) {
        const storedOutputPreview = initialRow.lastOutputPreview?.trim();
        if (storedOutputPreview) {
          latestOutputPreview = storedOutputPreview.slice(0, 4_000);
        } else {
          const managedOutputPreview = managed.preview?.trim();
          if (managedOutputPreview) {
            latestOutputPreview = managedOutputPreview.slice(0, 4_000);
          }
        }
      }
      const statusSource = latestAssistantParagraphs || latestOutputPreview;
      const laneThreads = needs.laneName
        ? formatLaneThreadsForPrompt(dependencies.listLaneThreads(managed))
        : "";
      const laneWorkSnapshot = needs.laneName
        ? await dependencies.gatherLaneWorkVersusRemote({
          worktreePath: initialLane?.worktreePath || managed.laneWorktreePath,
          baseRef: initialLane?.baseRef?.trim() || "HEAD",
        }).catch(() => null)
        : null;
      const laneWorkVersusRemote = laneWorkSnapshot
        ? formatLaneWorkVersusRemote(laneWorkSnapshot)
        : "";
      const worktreeName = path.basename(
        initialLane?.worktreePath || managed.laneWorktreePath,
      ) || null;

      let generated: {
        result: ReturnType<typeof deriveDeterministicSessionMetadata>;
        selectedModelId: string | null;
        attemptCount: number;
      } = { result: null, selectedModelId: null, attemptCount: 0 };
      if (candidateModelIds.length) {
        const prompt = buildSessionMetadataPrompt({
          provider: managed.session.provider,
          chatModel: managed.session.modelId ?? managed.session.model,
          currentLaneName: snapshot.laneName,
          currentChatTitle: snapshot.title,
          currentStatusLine: snapshot.statusLine,
          worktreeName,
          requestedFields: fields,
          goal: managed.session.goal?.trim().slice(0, 2_000) ?? null,
          summary: initialRow.summary?.trim().slice(0, 2_000) ?? null,
          latestOutputPreview,
          originalRequest: managed.autoTitleSeed?.trim().slice(0, 2_000) ?? null,
          threadTranscript: threadTranscript || null,
          latestAssistantParagraphs: statusSource,
          laneThreads: laneThreads || null,
          laneWorkVersusRemote: laneWorkVersusRemote || null,
        });
        generated = await runSessionMetadataGeneration({
          candidateModelIds,
          cwd: managed.laneWorktreePath,
          prompt,
          systemPrompt: buildSessionMetadataSystemPrompt(fields),
          runPrompt: dependencies.runPrompt,
          normalizeTitle: dependencies.normalizeTitle,
          normalizeStatusLine: dependencies.normalizeStatusLine,
          shouldStop: () => managed.deleted || managed.sessionMetadataGenerationVersion !== generationVersion,
          onFailure: ({ descriptor, provider, providerLevelFailure, attemptCount: currentAttempt, error }) => {
            dependencies.logger.warn("agent_chat.session_metadata_generation_failed", {
              sessionId,
              modelId: descriptor.id,
              provider,
              providerLevelFailure,
              attemptCount: currentAttempt,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });
      }
      selectedModelId = generated.selectedModelId;
      attemptCount = generated.attemptCount;
      const laneNameOnly = needs.laneName && !needs.title && !needs.statusLine;
      const metadata = generated.result ?? (laneNameOnly
        ? null
        : deriveDeterministicSessionMetadata({
          seeds: needs.statusLine && !needs.title && !needs.laneName
            ? [latestAssistantParagraphs, latestOutputPreview]
            : [
              initialRow.summary,
              threadTranscript,
              latestAssistantParagraphs,
              latestOutputPreview,
              managed.autoTitleSeed,
            ],
          normalizeTitle: dependencies.normalizeTitle,
          normalizeStatusLine: dependencies.normalizeStatusLine,
        }));
      if (!metadata) {
        throw new Error("The AI returned no usable session metadata.");
      }
      if (!generated.result) {
        dependencies.logger.info("agent_chat.session_metadata_deterministic_fallback", {
          sessionId,
          attemptCount,
        });
      }

      // A newer explicit request cancels every field from this response. Manual
      // edits do not change the request version, so untouched fields can still
      // land while the edited title is protected by its value and revision
      // comparison.
      if (managed.deleted || managed.sessionMetadataGenerationVersion !== generationVersion) {
        skipped.push(...fields);
        notifyOutcome("partial");
        return { sessionId, applied, skipped, modelId: selectedModelId };
      }

      if (fields.includes("title")) {
        const current = dependencies.getSession(sessionId);
        if (
          metadata.chatTitle && current?.title === snapshot.title
          && managed.sessionMetadataTitleRevision === snapshot.titleRevision
        ) {
          const title = await dependencies.applyTitle(managed, metadata.chatTitle);
          if (title) applied.push("title");
          else skipped.push("title");
        } else {
          skipped.push("title");
        }
      }

      if (managed.deleted || managed.sessionMetadataGenerationVersion !== generationVersion) {
        for (const field of fields) {
          if (!applied.includes(field) && !skipped.includes(field)) skipped.push(field);
        }
        dependencies.persistChatState(managed);
        notifyOutcome("partial");
        return { sessionId, applied, skipped, modelId: selectedModelId };
      }

      if (fields.includes("statusLine")) {
        const current = dependencies.getSession(sessionId);
        if (metadata.statusLine && current?.statusNote === snapshot.statusLine) {
          if (dependencies.setStatusNote(sessionId, metadata.statusLine)) applied.push("statusLine");
          else skipped.push("statusLine");
        } else {
          skipped.push("statusLine");
        }
      }

      if (fields.includes("laneName")) {
        const currentLane = await dependencies.getLaneSummary(managed.session.laneId, { includeStatus: false }).catch(() => null);
        if (managed.deleted || managed.sessionMetadataGenerationVersion !== generationVersion) {
          for (const field of fields) {
            if (!applied.includes(field) && !skipped.includes(field)) skipped.push(field);
          }
          dependencies.persistChatState(managed);
          notifyOutcome("partial");
          return { sessionId, applied, skipped, modelId: selectedModelId };
        }
        if (metadata.laneName && currentLane && currentLane.name === snapshot.laneName) {
          try {
            dependencies.renameLane({ laneId: managed.session.laneId, name: metadata.laneName });
            applied.push("laneName");
          } catch (error) {
            skipped.push("laneName");
            dependencies.logger.warn("agent_chat.session_metadata_lane_rename_failed", {
              sessionId,
              laneId: managed.session.laneId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          skipped.push("laneName");
        }
      }

      dependencies.persistChatState(managed);
      dependencies.logger.info("agent_chat.session_metadata_regenerated", {
        sessionId,
        appliedFields: applied.length,
        requestedFields: fields.length,
        attemptCount,
      });
      notifyOutcome(applied.length === fields.length ? "completed" : "partial");
      return { sessionId, applied, skipped, modelId: selectedModelId };
    } catch (error) {
      notifyOutcome("failed");
      dependencies.logger.warn("agent_chat.session_metadata_generation_failed", {
        sessionId,
        modelId: selectedModelId,
        attemptCount,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
