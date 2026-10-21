import React, { useMemo, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type { AgentChatSession, OpenProjectBinding } from "../../../shared/types";
import { useRootAppStore } from "../../state/appStore";
import { getAppDefaultModelDescriptor, getDefaultModelDescriptor } from "../../../shared/modelRegistry";
import { issueChatLaunchArgs } from "../../lib/linearBatchLaunch";
import { askFirstNativeControls } from "../../lib/nativeLaunchControls";
import { ensureHarnessPresetOnBrain } from "../../lib/harnessPresetAccountSync";
import { announceWorkChatSessionCreated } from "../../lib/chatSessionEvents";
import { navigateToAppTarget } from "../../lib/openExternal";
import { resolveHarnessLaunchTarget } from "../settings/harnesses/harnessLaunchTarget";
import { SessionLaunchModelControls, type SessionLaunchModelConfig } from "./SessionLaunchModelControls";
import { useModelRecents } from "./ModelPicker/useModelRecents";
import { showToast } from "../app/toast/toastStore";
import "../ui/dialog/dialog.css";
import "./agentLaunchSetup.css";

/**
 * Set up and start one agent chat in place: model, effort, permissions and the
 * prompt it starts from, all editable, then one Start button. The same launch
 * the issue launchers make, so the chat shows the whole prompt.
 *
 * Permissions start at ask-first (`askFirstNativeControls`), not the usual
 * full-access default: every caller so far promises the person the agent asks
 * before it changes anything. They can still widen them in the picker.
 *
 * Remote machines: `pin` names the machine the chat must run on (the lane's
 * machine). Leave it null for the tab's own machine. The lane lookup, the
 * launch and the jump to the chat all use the same pin.
 */
export function AgentLaunchSetup({
  defaultPrompt,
  chatTitle,
  promptLabel,
  pin,
  projectRoot,
  resolveLaneId,
  onLaunched,
  onCancel,
  failureTitle = "Couldn't start the agent",
}: {
  /** The prompt the editor starts with. Read once, when the editor mounts. */
  defaultPrompt: string;
  /** Title of the new chat. */
  chatTitle: string;
  /** Accessible name of the prompt editor. */
  promptLabel: string;
  pin: OpenProjectBinding | null;
  /** The project the chat belongs to, for the Work list's caches (unpinned only). */
  projectRoot: string | null;
  /** The lane to start in. Default: the project's primary lane on `pin`'s machine. */
  resolveLaneId?: () => Promise<string>;
  /** After the chat started and Work was asked to show it. */
  onLaunched?: () => void;
  onCancel: () => void;
  failureTitle?: string;
}) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [starting, setStarting] = useState(false);
  const harnessPresets = useRootAppStore((state) => state.harnessPresets);
  const { recents } = useModelRecents();
  const defaultModelId = useMemo(
    () => recents[0] ?? getAppDefaultModelDescriptor()?.id ?? getDefaultModelDescriptor("claude")?.id ?? "",
    [recents],
  );
  const [config, setConfig] = useState<SessionLaunchModelConfig>(() => ({
    modelId: "",
    reasoningEffort: null,
    fastMode: false,
    sessionType: "chat",
    nativeControls: askFirstNativeControls(),
  }));
  const modelId = config.modelId || defaultModelId;

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      if (!modelId && !config.presetId) throw new Error("Pick a model for the agent.");
      const laneId = resolveLaneId
        ? await resolveLaneId()
        : await primaryLaneId(pin);
      const target = config.presetId ? resolveHarnessLaunchTarget(config.presetId, harnessPresets) : null;
      if (config.presetId && !target) throw new Error("That custom provider is no longer available. Pick another one.");
      await ensureHarnessPresetOnBrain(config.presetId ?? null, { targetsAnotherMachine: pin != null });
      const { permissionMode, ...launchArgs } = issueChatLaunchArgs({
        laneId,
        config: {
          modelId,
          reasoningEffort: config.reasoningEffort,
          fastMode: config.fastMode,
          kickoffPrompt: prompt,
          branchOverride: "",
          nativeControls: config.nativeControls,
          presetLaunch: target ? { presetId: target.presetId, harness: target.harness, model: target.launchModelId } : null,
        },
        kickoffText: prompt.trim() || defaultPrompt,
      });
      const session = await window.ade.agentChat.launch({
        ...launchArgs,
        ...(permissionMode != null ? { permissionMode } : {}),
        title: chatTitle,
      }, pin);
      openChat(session, laneId, pin, projectRoot);
      onLaunched?.();
    } catch (cause) {
      showToast({ tone: "error", title: failureTitle, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="ade-agent-launch">
      <SessionLaunchModelControls
        config={{ ...config, modelId }}
        showSessionType={false}
        disabled={starting}
        onChange={(patch) => setConfig((current) => ({ ...current, ...patch }))}
      />
      <textarea
        className="ade-dialog-input ade-agent-launch-prompt"
        aria-label={promptLabel}
        value={prompt}
        disabled={starting}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <div className="ade-agent-launch-actions">
        <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={starting} onClick={onCancel}>Cancel</button>
        <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={starting} onClick={() => void start()}>
          {starting ? <CircleNotch size={12} className="animate-spin" /> : null}
          Start agent
        </button>
      </div>
    </div>
  );
}

async function primaryLaneId(pin: OpenProjectBinding | null): Promise<string> {
  const lanes = await window.ade.lanes.list({ includeStatus: false }, pin);
  const primary = lanes.find((lane) => lane.laneType === "primary");
  if (!primary) throw new Error("This project's main lane isn't ready yet. Try again in a moment.");
  return primary.id;
}

/**
 * Show the new chat on Work. A chat on another machine is focused through the
 * Work tab's select-session event with its binding: a `?sessionId=` query
 * would be resolved against the tab's own machine and dropped.
 */
function openChat(
  session: AgentChatSession,
  laneId: string,
  pin: OpenProjectBinding | null,
  projectRoot: string | null,
): void {
  if (pin) {
    window.dispatchEvent(new CustomEvent("ade:work:select-session", {
      detail: { sessionId: session.id, laneId, binding: pin },
    }));
    navigateToAppTarget({ kind: "work" });
    return;
  }
  if (projectRoot) announceWorkChatSessionCreated(projectRoot, session);
  navigateToAppTarget({ kind: "work", laneId, sessionId: session.id });
}
