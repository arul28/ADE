import type { ChatLaunchArgs, ChatLaunchChatArgs, ChatLaunchLaneConfig } from "../../../../shared/types";
import type { DraftLaunchKind, DraftLaunchMode, PreparedDraftLaunch } from "../../../lib/draftLaunchJobs";
import { cloudLaunchAppArgs, cloudLaunchLaneFields } from "../../../../shared/cloudLaneLaunch";
import { isCloudTierId } from "../../../../shared/cloudTiers";
import { newCloudLaunchId } from "../../../../shared/accountCloudLaunches";
import type { StartAccountCloudChat } from "../../../state/accountCloudLaunches";

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
  /** Left out, the host names the lane (ADE Web's start: the account server does, from the launch id). */
  laneId?: string;
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
  /** Left out when no window of this client follows the launch (ADE Web's start). */
  originClientId?: string;
}): ChatLaunchArgs {
  const { prepared } = input;
  return {
    kind: input.kind,
    mode: input.mode,
    launchId: input.launchId,
    ...(input.laneId ? { laneId: input.laneId } : {}),
    laneName: input.laneName,
    prompt: prepared.finalText,
    displayPrompt: prepared.finalDisplayText,
    attachments: prepared.selectedAttachments,
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.laneConfig ? { laneConfig: input.laneConfig } : {}),
    modelId: prepared.modelId || null,
    provider: input.provider,
    title: input.cliTitle,
    ...(input.originClientId ? { originClientId: input.originClientId } : {}),
    ...(input.chat ? { chat: input.chat } : {}),
  };
}

/**
 * ADE Web's start of a draft chat on a new ADE Cloud lane (`POST /cloud/launches`
 * through the account server): the same lane fields and launch args the
 * desktop's main process sends (`cloudLaneComputerStages.ts`), less the ids
 * into one machine's stores (a provider account, a harness preset, a stored
 * key), which the web leaves out: the new computer's provider then signs in
 * on its own, as it did before the web sent these args. The server names the
 * lane from the launch id.
 */
export function buildAccountCloudDraftStart(input: {
  prepared: Pick<PreparedDraftLaunch, "finalText" | "finalDisplayText" | "selectedAttachments" | "modelId">;
  chat: ChatLaunchChatArgs;
  /** `https://github.com/owner/repo`. */
  origin: string;
  accountProjectId: string | null;
  laneName: string;
  laneConfig: ChatLaunchLaneConfig | null;
  sizeId: string;
  sizeChoice: "default" | "picked";
}): StartAccountCloudChat {
  const { create, message } = input.chat;
  const { instanceId: _instanceId, presetId: _presetId, presetSnapshot: _presetSnapshot, credentialId: _credentialId, ...portable } = create;
  const launchId = newCloudLaunchId();
  const launch = cloudLaunchAppArgs(buildNewLaneLaunchArgs({
    kind: "chat",
    mode: "foreground",
    launchId,
    laneName: input.laneName,
    prepared: input.prepared,
    provider: create.provider,
    cliTitle: null,
    chat: { create: portable, message },
    laneConfig: input.laneConfig,
  }));
  return {
    launchId,
    accountProjectId: input.accountProjectId,
    origin: input.origin,
    provider: create.provider,
    modelId: create.modelId ?? create.model,
    effort: create.reasoningEffort ?? null,
    fast: create.fastMode === true,
    permissions: create.permissionMode ?? null,
    prompt: message.text ?? "",
    ...(isCloudTierId(input.sizeId) ? { sizeId: input.sizeId } : {}),
    sizeChoice: input.sizeChoice,
    lane: cloudLaunchLaneFields(input.laneName, input.laneConfig),
    launch,
  };
}
