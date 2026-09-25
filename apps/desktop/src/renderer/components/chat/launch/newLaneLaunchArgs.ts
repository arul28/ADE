import type { ChatLaunchArgs, ChatLaunchChatArgs, ChatLaunchLaneConfig } from "../../../../shared/types";
import type { DraftLaunchKind, DraftLaunchMode, PreparedDraftLaunch } from "../../../lib/draftLaunchJobs";

/**
 * The `chatLaunch.start` args for a draft sent into a brand-new lane. Pure: the
 * composer picks the ids and the lane name and resolves the chat (or CLI)
 * settings; this only assembles them, so the host, the optimistic snapshot and
 * a retried `start` all see the same launch.
 */
export function buildNewLaneLaunchArgs(input: {
  kind: DraftLaunchKind;
  mode: DraftLaunchMode;
  launchId: string;
  laneId: string;
  laneName: string;
  prepared: Pick<PreparedDraftLaunch, "finalText" | "finalDisplayText" | "selectedAttachments" | "modelId">;
  /** ADE provider of the chat, or the CLI profile. */
  provider: string | null;
  /** CLI launches carry the session title they will open with. */
  cliTitle: string | null;
  /** Chat launches only. */
  chat?: ChatLaunchChatArgs;
  /** Explicit base ref for a configured root lane; omitted = project default. */
  baseBranch?: string | null;
  /** Explicit lane recipe (child/import/template/color), when the user configured one. */
  laneConfig?: ChatLaunchLaneConfig | null;
  originClientId: string;
}): ChatLaunchArgs {
  const { prepared } = input;
  return {
    kind: input.kind,
    mode: input.mode,
    launchId: input.launchId,
    laneId: input.laneId,
    laneName: input.laneName,
    prompt: prepared.finalText,
    displayPrompt: prepared.finalDisplayText,
    attachments: prepared.selectedAttachments,
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.laneConfig ? { laneConfig: input.laneConfig } : {}),
    modelId: prepared.modelId || null,
    provider: input.provider,
    title: input.cliTitle,
    originClientId: input.originClientId,
    ...(input.chat ? { chat: input.chat } : {}),
  };
}
