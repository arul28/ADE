import React, { useEffect, useMemo, useState } from "react";
import { CircleNotch, GitBranch, GithubLogo } from "@phosphor-icons/react";
import { getAppDefaultModelDescriptor, getDefaultModelDescriptor } from "../../../shared/modelRegistry";
import { sanitizeLinearIssueBranchName } from "../../../shared/linearIssueBranch";
import { createPendingRequestChannel } from "../../lib/pendingRequestChannel";
import { announceWorkChatSessionCreated } from "../../lib/chatSessionEvents";
import { ensureHarnessPresetOnBrain } from "../../lib/harnessPresetAccountSync";
import { buildChatLaunchNativePayload, defaultNativeControls } from "../../lib/nativeLaunchControls";
import { batchLaunchSupportsFastMode, resolveLaunchProviderAndModel } from "../../lib/linearBatchLaunch";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { resolveHarnessLaunchTarget } from "../settings/harnesses/harnessLaunchTarget";
import { SessionLaunchModelControls, type SessionLaunchModelConfig } from "../shared/SessionLaunchModelControls";
import { useModelRecents } from "../shared/ModelPicker/useModelRecents";
import { showToast } from "../app/toast/toastStore";
import { GitHubIssueStateIcon } from "../lanes/githubBrand";
import { Dialog } from "../ui/dialog";
import { LaneMachineSelector } from "../lanes/LaneMachineSelector";
import { useLaneMachineChoice } from "../lanes/useLaneMachineChoice";
import { requestCrossMachineLanesForMachine } from "../../state/crossMachineLanes";
import { githubIssueToContextAttachment, githubIssueToLaneIssue, type GitHubIssueDetail } from "./githubIssueStore";

/**
 * "Start a lane (and maybe an agent) for this GitHub issue."
 *
 * The Linear launch flow is a batch runner built around Linear's lane link;
 * a GitHub issue needs one lane at a time, so this is its own small flow:
 * create the lane `gh-123-slug`, then optionally start a chat in it with the
 * issue attached. The attachment records the session's GitHub issue link,
 * which is what "Linked in ADE" and the PR's `Closes #123` read.
 *
 * The viewer, the create toast and the pane ask through this channel; the host
 * is mounted once in the app shell.
 */
export type GitHubIssueLaunchRequest = { issue: GitHubIssueDetail; laneOnly?: boolean };

const channel = createPendingRequestChannel<GitHubIssueLaunchRequest>("github-issue-launch");

export function requestGitHubIssueLaunch(issue: GitHubIssueDetail, options: { laneOnly?: boolean } = {}): void {
  channel.request({ issue, laneOnly: options.laneOnly === true });
}

/** `gh-123-short-title-slug`, a valid git ref. */
export function githubIssueBranchName(issue: Pick<GitHubIssueDetail, "number" | "title">): string {
  const slug = issue.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  return sanitizeLinearIssueBranchName(slug ? `gh-${issue.number}-${slug}` : `gh-${issue.number}`);
}

export function githubIssueKickoffPrompt(): string {
  return (
    "Resolve the GitHub issue attached to this session. Its full details are in your context — work on THAT issue. "
    + "Start by checking that the issue still applies against the latest remote main. "
    + "Then make the change the issue describes, keeping your work scoped to it. "
    + "Read and comment on the issue with `ade github issue view` and `ade github issue comment`; the pull request you open closes it."
  );
}

export function GitHubIssueLaunchHost() {
  const [request, setRequest] = useState<GitHubIssueLaunchRequest | null>(null);
  useEffect(() => {
    const pending = channel.takePending();
    if (pending) setRequest(pending);
    return channel.subscribe((next) => {
      channel.clearPending();
      setRequest(next);
    });
  }, []);
  if (!request) return null;
  return <GitHubIssueLaunchDialog key={`${request.issue.owner}/${request.issue.repo}#${request.issue.number}`} request={request} onClose={() => setRequest(null)} />;
}

function GitHubIssueLaunchDialog({ request, onClose }: { request: GitHubIssueLaunchRequest; onClose: () => void }) {
  const { issue } = request;
  const projectRoot = useAppStore((state) => state.project?.rootPath ?? null);
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const harnessPresets = useRootAppStore((state) => state.harnessPresets);
  const { recents } = useModelRecents();
  // Same choice as the Linear launcher: the lane, and the chat in it, go to
  // one machine that has this repository open.
  const machineChoice = useLaneMachineChoice(true);
  const { selectedMachineId, targetPin } = machineChoice;
  const [laneOnly, setLaneOnly] = useState(request.laneOnly === true);
  const [branch, setBranch] = useState(() => githubIssueBranchName(issue));
  const [prompt, setPrompt] = useState(githubIssueKickoffPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultModelId = useMemo(
    () => recents[0] ?? getAppDefaultModelDescriptor()?.id ?? getDefaultModelDescriptor("claude")?.id ?? "",
    [recents],
  );
  const [config, setConfig] = useState<SessionLaunchModelConfig>(() => ({
    modelId: "",
    reasoningEffort: null,
    fastMode: false,
    sessionType: "chat",
    nativeControls: defaultNativeControls("persistent_identity"),
  }));
  const modelId = config.modelId || defaultModelId;

  const launch = async () => {
    const branchName = sanitizeLinearIssueBranchName(branch);
    if (!branchName) {
      setError("Give the lane a branch name.");
      return;
    }
    if (!selectedMachineId) {
      setError("No connected machine has this repository open.");
      return;
    }
    if (!laneOnly && !modelId && !config.presetId) {
      setError("Pick a model for the agent.");
      return;
    }
    setBusy(true);
    setError(null);
    let laneId: string | null = null;
    try {
      const target = config.presetId ? resolveHarnessLaunchTarget(config.presetId, harnessPresets) : null;
      if (config.presetId && !target) throw new Error("That custom provider is no longer available. Pick another one.");
      const pin = targetPin;
      const createArgs = {
        name: `#${issue.number} ${issue.title}`.slice(0, 120),
        branchName,
        githubIssue: githubIssueToLaneIssue(issue),
      };
      const lane = pin ? await window.ade.lanes.create(createArgs, pin) : await window.ade.lanes.create(createArgs);
      laneId = lane.id;
      if (!laneOnly) {
        await ensureHarnessPresetOnBrain(config.presetId ?? null, { targetsAnotherMachine: pin?.kind === "remote" });
        const { provider, model } = target
          ? { provider: target.harness as Parameters<typeof window.ade.agentChat.launch>[0]["provider"], model: target.launchModelId }
          : resolveLaunchProviderAndModel(modelId);
        const native = buildChatLaunchNativePayload(modelId, config.nativeControls);
        const launchArgs: Parameters<typeof window.ade.agentChat.launch>[0] = {
          laneId: lane.id,
          provider,
          model,
          modelId,
          reasoningEffort: config.reasoningEffort,
          ...(batchLaunchSupportsFastMode(modelId) ? { fastMode: config.fastMode } : {}),
          ...(native ?? {}),
          kickoffText: prompt.trim() || githubIssueKickoffPrompt(),
          contextAttachments: [githubIssueToContextAttachment(issue)],
          ...(target ? { presetId: target.presetId } : {}),
        };
        const session = pin ? await window.ade.agentChat.launch(launchArgs, pin) : await window.ade.agentChat.launch(launchArgs);
        if (projectRoot && !pin) announceWorkChatSessionCreated(projectRoot, session);
      }
      if (pin) requestCrossMachineLanesForMachine(selectedMachineId);
      else await refreshLanes({ includeStatus: false }).catch(() => undefined);
      showToast({
        tone: "success",
        title: laneOnly ? `Lane ready for #${issue.number}` : `Agent started on #${issue.number}`,
        message: branchName,
      });
      onClose();
      window.location.hash = "#/lanes?drawer=stack";
    } catch (cause) {
      // An agent that failed to start leaves no half-made lane behind.
      if (laneId && !laneOnly) {
        const deleteArgs = { laneId, force: true, deleteBranch: true, deleteRemoteBranch: false, remoteName: "origin" };
        await (targetPin ? window.ade.lanes.delete(deleteArgs, targetPin) : window.ade.lanes.delete(deleteArgs)).catch(() => undefined);
      }
      setError(cause instanceof Error ? cause.message : "The lane was not created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={laneOnly ? "Start a lane" : "Launch an agent"}
      size="md"
      testId="github-issue-launch"
      footer={(
        <div className="flex w-full items-center gap-2">
          {error ? <span role="alert" className="min-w-0 flex-1 truncate text-[11.5px] text-[color:var(--kit-crit)]" title={error}>{error}</span> : <span className="flex-1" />}
          <button type="button" className="kit-btn kit-btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="kit-btn kit-btn-primary" disabled={busy} onClick={() => void launch()}>
            {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
            {laneOnly ? "Create lane" : "Launch"}
          </button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-[color:var(--kit-panel-edge)] bg-[color:var(--kit-panel-bg)] px-2.5 py-2">
          <GithubLogo size={13} weight="fill" className="shrink-0" />
          <GitHubIssueStateIcon state={issue.state} stateReason={issue.stateReason} size={12} />
          <span className="kit-num shrink-0 text-[11.5px] text-[color:var(--kit-text-2)]">#{issue.number}</span>
          <span className="truncate text-[12.5px] text-fg/90">{issue.title}</span>
        </div>
        <div className="kit-seg self-start" data-case="sentence" role="group" aria-label="What to start">
          <button type="button" aria-pressed={!laneOnly} onClick={() => setLaneOnly(false)}>Lane + agent</button>
          <button type="button" aria-pressed={laneOnly} onClick={() => setLaneOnly(true)}>Lane only</button>
        </div>
        <label className="block">
          <span className="kit-eyebrow mb-1 flex items-center gap-1"><GitBranch size={11} /> Branch</span>
          <input
            className="ade-dialog-input font-mono"
            aria-label="Branch name"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
        </label>
        {machineChoice.machines.length > 1 ? (
          <LaneMachineSelector
            machines={machineChoice.machines}
            selectedMachineId={selectedMachineId}
            onSelectMachine={(machineId) => {
              if (machineChoice.machineTargets.has(machineId)) machineChoice.setPickedMachineId(machineId);
            }}
          />
        ) : null}
        {!laneOnly ? (
          <>
            <SessionLaunchModelControls
              config={{ ...config, modelId }}
              showSessionType={false}
              onChange={(patch) => setConfig((current) => ({ ...current, ...patch }))}
            />
            <label className="block">
              <span className="kit-eyebrow mb-1 block">Kickoff prompt</span>
              <textarea
                className="ade-dialog-input !h-auto min-h-[96px] resize-y py-2 text-[12px] leading-relaxed"
                aria-label="Kickoff prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <span className="mt-1 block text-[11px] text-[color:var(--kit-text-3)]">
                The issue goes to the agent as context; the pull request it opens says “Closes #{issue.number}”.
              </span>
            </label>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
