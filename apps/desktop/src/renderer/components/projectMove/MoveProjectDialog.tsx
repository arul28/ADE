import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  CircleNotch,
  FolderSimple,
  HardDrive,
  Laptop,
  Robot,
  Warning,
  XCircle,
} from "@phosphor-icons/react";
import {
  PROJECT_MOVE_STEPS,
  type ProjectMoveCheck,
  type ProjectMovePreflight,
  type ProjectMoveProgress,
  type ProjectMoveRecord,
  type ProjectMoveStepId,
  type ProjectMoveVolume,
} from "../../../shared/types/projectMove";
import { Dialog } from "../ui/dialog";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { getAppDefaultModelDescriptor, getDefaultModelDescriptor } from "../../../shared/modelRegistry";
import { issueChatLaunchArgs } from "../../lib/linearBatchLaunch";
import { defaultNativeControls } from "../../lib/nativeLaunchControls";
import { ensureHarnessPresetOnBrain } from "../../lib/harnessPresetAccountSync";
import { resolveHarnessLaunchTarget } from "../settings/harnesses/harnessLaunchTarget";
import { SessionLaunchModelControls, type SessionLaunchModelConfig } from "../shared/SessionLaunchModelControls";
import { useModelRecents } from "../shared/ModelPicker/useModelRecents";
import { showToast } from "../app/toast/toastStore";
import { SettingsToggle } from "../settings/primitives";
import { announceWorkChatSessionCreated } from "../../lib/chatSessionEvents";
import { joinParentAndName } from "../../lib/pathUtils";
import { usageLeftLevel } from "../usage/usageDesign";
import { Banner } from "../ui/notice";
import { agentCheckPrompt, announceProjectMoveChanged, displayPath, formatBytes, formatReminder, volumeFor } from "./projectMoveModel";
import { OldCopyControls } from "./oldCopyActions";
// The drive cards are the settings kit's choice cards; the dialog opens from anywhere.
import "../settings/primitives/settingsModern.css";
import "./projectMove.css";

type Stage = "setup" | "moving" | "done" | "failed";

/** Wait this long after the destination changes before checking it. */
const CHECK_DEBOUNCE_MS = 250;

function parentOf(root: string): string {
  const index = root.lastIndexOf("/");
  return index > 0 ? root.slice(0, index) : "/";
}

/** The project's own parent folder when staying on its drive, else the drive's usual projects folder. */
function defaultParentOn(volume: ProjectMoveVolume, sourceRoot: string, sourceVolume: ProjectMoveVolume | null): string {
  return volume.mountPath === sourceVolume?.mountPath ? parentOf(sourceRoot) : volume.suggestedFolder;
}

function stepState(step: ProjectMoveStepId, current: ProjectMoveStepId): "done" | "current" | "todo" {
  const order = PROJECT_MOVE_STEPS.map((entry) => entry.id);
  const a = order.indexOf(step);
  const b = order.indexOf(current);
  return a < b ? "done" : a === b ? "current" : "todo";
}

function Issue({ check }: { check: Pick<ProjectMoveCheck, "status" | "title" | "detail" | "items"> }) {
  const Icon = check.status === "blocked" ? XCircle : Warning;
  return (
    <div className="ade-pm-issue" data-status={check.status}>
      <Icon size={15} weight="fill" />
      <div>
        <div className="ade-pm-issue-title">{check.title}</div>
        {check.detail ? <div className="ade-pm-muted">{check.detail}</div> : null}
        {check.items?.length ? <div className="ade-pm-muted ade-pm-mono">{check.items.slice(0, 3).map(displayPath).join(", ")}</div> : null}
      </div>
    </div>
  );
}

export function MoveProjectDialog({
  open,
  onClose,
  projectRoot,
  projectName,
}: {
  open: boolean;
  onClose: () => void;
  projectRoot: string;
  projectName: string;
}) {
  const api = window.ade?.projectMove;
  const [stage, setStage] = useState<Stage>("setup");
  const [volumes, setVolumes] = useState<ProjectMoveVolume[] | null>(null);
  const [parentFolder, setParentFolder] = useState<string | null>(null);
  const [moveHistory, setMoveHistory] = useState(false);
  const [preflight, setPreflight] = useState<ProjectMovePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<ProjectMoveProgress | null>(null);
  const [record, setRecord] = useState<ProjectMoveRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingCheck, setStartingCheck] = useState(false);
  // The check agent is set up in place, like the issue launchers: model,
  // effort and permissions, and the prompt it starts from, all editable.
  const [checkOpen, setCheckOpen] = useState(false);
  const [checkPrompt, setCheckPrompt] = useState("");
  const harnessPresets = useRootAppStore((state) => state.harnessPresets);
  const { recents } = useModelRecents();
  const defaultModelId = useMemo(
    () => recents[0] ?? getAppDefaultModelDescriptor()?.id ?? getDefaultModelDescriptor("claude")?.id ?? "",
    [recents],
  );
  const [checkConfig, setCheckConfig] = useState<SessionLaunchModelConfig>(() => ({
    modelId: "",
    reasoningEffort: null,
    fastMode: false,
    sessionType: "chat",
    nativeControls: defaultNativeControls("persistent_identity"),
  }));
  const checkModelId = checkConfig.modelId || defaultModelId;
  const checkRequest = useRef(0);
  const moveStarted = useRef(false);

  const sourceVolume = useMemo(() => (volumes ? volumeFor(projectRoot, volumes) : null), [projectRoot, volumes]);
  const destinationRoot = parentFolder ? joinParentAndName(parentFolder, projectName) : null;
  const selectedVolume = volumes && destinationRoot ? volumeFor(destinationRoot, volumes) : null;

  useEffect(() => {
    if (!open || !api) return undefined;
    setStage("setup");
    setPreflight(null);
    setRecord(null);
    setProgress(null);
    setError(null);
    let cancelled = false;
    void api.listVolumes().then((list) => {
      if (cancelled) return;
      setVolumes(list);
      const here = volumeFor(projectRoot, list);
      // Suggest the roomiest other drive: the usual reason to move is space.
      const suggestion = list
        .filter((volume) => volume.mountPath !== here?.mountPath)
        .sort((a, b) => b.freeBytes - a.freeBytes)[0] ?? here;
      if (suggestion) setParentFolder(defaultParentOn(suggestion, projectRoot, here));
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      cancelled = true;
    };
  }, [api, open, projectRoot]);

  useEffect(() => {
    if (!open || !api) return undefined;
    return api.onProgress((next) => setProgress(next));
  }, [api, open]);

  // Check the destination as soon as it is picked; a newer pick wins.
  const runChecks = useCallback(() => {
    if (!api || !destinationRoot) return;
    const request = ++checkRequest.current;
    setChecking(true);
    setError(null);
    void api.preflight({ projectRoot, destinationRoot }).then((result) => {
      if (request === checkRequest.current) setPreflight(result);
    }).catch((cause) => {
      if (request === checkRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (request === checkRequest.current) setChecking(false);
    });
  }, [api, destinationRoot, projectRoot]);

  useEffect(() => {
    if (stage !== "setup" || !destinationRoot) return undefined;
    setPreflight(null);
    const timer = window.setTimeout(runChecks, CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [destinationRoot, runChecks, stage]);

  const chooseFolder = async () => {
    if (!api) return;
    const picked = await api.chooseFolder(parentFolder ?? undefined);
    if (picked) setParentFolder(picked);
  };

  const startMove = async () => {
    // Set before the first await: a double click must not start two moves.
    if (!api || !destinationRoot || moveStarted.current) return;
    moveStarted.current = true;
    setStage("moving");
    setProgress(null);
    setError(null);
    try {
      const result = await api.start({ projectRoot, destinationRoot, moveAgentHistory: moveHistory });
      setRecord(result.record);
      if (result.ok) {
        // The window reopened the project at its new folder; its tab replaces
        // the old one rather than sitting beside a tab for a folder that moved.
        const oldRoots = new Set(result.record.resume?.sourceSpellings ?? [result.record.sourceRoot]);
        useAppStore.getState().setOpenProjectTabRoots((roots) => {
          const next = roots.filter((root) => !oldRoots.has(root));
          return next.includes(result.record.destinationRoot) ? next : [...next, result.record.destinationRoot];
        });
        setStage("done");
        announceProjectMoveChanged();
      } else if (result.record) {
        setError(result.error);
        setStage("failed");
      } else {
        // Refused before anything started (a check failed meanwhile).
        moveStarted.current = false;
        setError(result.error);
        setStage("setup");
        runChecks();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("failed");
    }
  };

  const startAgentCheck = async () => {
    if (!record) return;
    setStartingCheck(true);
    try {
      const lanes = await window.ade.lanes.list({ includeStatus: false });
      const primary = lanes.find((lane) => lane.laneType === "primary");
      if (!primary) throw new Error("The moved project's main lane isn't ready yet. Try again in a moment.");
      if (!checkModelId && !checkConfig.presetId) throw new Error("Pick a model for the agent.");
      const target = checkConfig.presetId ? resolveHarnessLaunchTarget(checkConfig.presetId, harnessPresets) : null;
      if (checkConfig.presetId && !target) throw new Error("That custom provider is no longer available. Pick another one.");
      await ensureHarnessPresetOnBrain(checkConfig.presetId ?? null, { targetsAnotherMachine: false });
      // The same launch the issue launchers make; the chat shows the whole prompt.
      const { permissionMode, ...launchArgs } = issueChatLaunchArgs({
        laneId: primary.id,
        config: {
          modelId: checkModelId,
          reasoningEffort: checkConfig.reasoningEffort,
          fastMode: checkConfig.fastMode,
          kickoffPrompt: checkPrompt,
          branchOverride: "",
          nativeControls: checkConfig.nativeControls,
          presetLaunch: target ? { presetId: target.presetId, harness: target.harness, model: target.launchModelId } : null,
        },
        kickoffText: checkPrompt.trim() || agentCheckPrompt(record),
      });
      const session = await window.ade.agentChat.launch({
        ...launchArgs,
        ...(permissionMode != null ? { permissionMode } : {}),
        title: "Check the project move",
      });
      announceWorkChatSessionCreated(record.destinationRoot, session);
      onClose();
      window.location.hash = `#/work?sessionId=${encodeURIComponent(session.id)}&laneId=${encodeURIComponent(primary.id)}`;
    } catch (cause) {
      showToast({ tone: "error", title: "Couldn't start the check", message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setStartingCheck(false);
    }
  };

  if (!api) return null;

  const issues = (preflight?.checks ?? [])
    .filter((check) => check.status !== "ok")
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "blocked" ? -1 : 1));
  const blocked = issues.some((check) => check.status === "blocked");
  const otherHistory = (preflight?.agentHistory ?? []).filter((entry) => entry.handling === "move" && entry.count > 0 && !entry.adeOwned);
  const afterMove = [
    ...(preflight?.notes ?? []),
    ...(preflight?.agentHistory ?? [])
      .filter((entry) => entry.handling === "report")
      .map((entry) => ({ id: entry.provider, title: `${entry.label} chats stay at the old location`, detail: entry.detail })),
  ];
  const moving = stage === "moving";
  const canMove = stage === "setup" && !checking && Boolean(preflight) && !blocked && Boolean(destinationRoot);
  const problems = record?.problems ?? [];

  const title: Record<Stage, string> = {
    setup: `Move ${projectName}`,
    moving: `Moving ${projectName}`,
    done: `${projectName} moved`,
    failed: "The move didn't finish",
  };

  const footers: Record<Stage, React.ReactNode> = {
    setup: (
      <>
        <button type="button" className="kit-btn kit-btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="kit-btn kit-btn-primary" disabled={!canMove} onClick={() => void startMove()}>Move</button>
      </>
    ),
    moving: <span className="ade-pm-muted">Keep the drive connected.</span>,
    failed: (
      <>
        <button type="button" className="kit-btn kit-btn-ghost" onClick={onClose}>Close</button>
        <button type="button" className="kit-btn kit-btn-primary" onClick={() => { moveStarted.current = false; setStage("setup"); runChecks(); }}>Try again</button>
      </>
    ),
    done: <button type="button" className="kit-btn kit-btn-primary" onClick={onClose}>Done</button>,
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !moving) onClose();
      }}
      title={title[stage]}
      size="md"
      dismissible={!moving}
      hideClose={moving}
      hideHeader={stage === "done"}
      footer={<div className="ade-pm-footer">{footers[stage]}</div>}
      testId="move-project-dialog"
    >
      <div className="ade-pm">
        {stage === "setup" ? (
          <>
            <div className="ade-modern-choices" role="radiogroup" aria-label="Drive">
              {(volumes ?? []).map((volume) => {
                const percentFree = volume.totalBytes ? (volume.freeBytes / volume.totalBytes) * 100 : 100;
                const selected = selectedVolume?.mountPath === volume.mountPath;
                return (
                  <button
                    key={volume.mountPath}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className="ade-ap-choice"
                    data-active={selected ? "true" : undefined}
                    onClick={() => setParentFolder(defaultParentOn(volume, projectRoot, sourceVolume))}
                  >
                    <span className="ade-modern-choice-body">
                      <span className="ade-modern-choice-title">
                        {volume.internal ? <Laptop size={15} /> : <HardDrive size={15} />}
                        <span className="ade-pm-drive-name">{volume.name}</span>
                        {volume.mountPath === sourceVolume?.mountPath ? <span className="kit-tag">Now</span> : null}
                      </span>
                      <span className="kit-meter" data-level={usageLeftLevel(percentFree)}>
                        <span style={{ width: `${Math.round(100 - percentFree)}%` }} />
                      </span>
                      <span className="ade-modern-choice-hint kit-num">{formatBytes(volume.freeBytes)} free</span>
                    </span>
                  </button>
                );
              })}
              {volumes === null ? <span className="ade-pm-muted"><CircleNotch size={12} className="animate-spin" /> Finding drives</span> : null}
            </div>

            {destinationRoot ? (
              <button type="button" className="ade-pm-path" onClick={() => void chooseFolder()} title="Choose another folder">
                <FolderSimple size={14} />
                <span className="ade-pm-mono">{displayPath(destinationRoot)}</span>
                <span className="ade-pm-path-action">Change</span>
              </button>
            ) : null}

            <div className="ade-pm-status" aria-live="polite">
              {checking || (!preflight && !error) ? (
                <span className="ade-pm-muted"><CircleNotch size={12} className="animate-spin" /> Checking</span>
              ) : preflight && !blocked ? (
                <span className="ade-pm-ready">
                  <span className="kit-dot" data-state="ok" />
                  Ready
                  <span className="ade-pm-muted kit-num">
                    {formatBytes(preflight.copyBytes)} · {preflight.laneCount} lane{preflight.laneCount === 1 ? "" : "s"}
                  </span>
                </span>
              ) : null}
              {error && stage === "setup" ? <Issue check={{ status: "blocked", title: error }} /> : null}
              {issues.map((check) => <Issue key={check.id} check={check} />)}
            </div>

            {otherHistory.length ? (
              <label className="ade-pm-option">
                <span>
                  <span className="ade-pm-issue-title">Move {otherHistory.map((entry) => entry.label).join(", ")} history too</span>
                  <span className="ade-pm-muted">Renames this project's folders only.</span>
                </span>
                <SettingsToggle checked={moveHistory} onChange={setMoveHistory} label="Move other tools' history" />
              </label>
            ) : null}

            {preflight && afterMove.length ? (
              <div className="ade-pm-after">
                <span className="kit-eyebrow">After the move</span>
                <ul>
                  {afterMove.map((note) => <li key={note.id} title={note.detail}>{note.title}</li>)}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}

        {stage === "moving" ? (
          <>
            <div className="ade-pm-route ade-pm-mono">
              <span>{displayPath(projectRoot)}</span>
              <ArrowRight size={12} />
              <span>{destinationRoot ? displayPath(destinationRoot) : ""}</span>
            </div>
            <ol className="ade-pm-steps">
              {PROJECT_MOVE_STEPS.map((step) => {
                const state = stepState(step.id, progress?.step ?? "prepare");
                return (
                  <li key={step.id} data-state={state}>
                    {state === "done" ? <CheckCircle size={14} weight="fill" />
                      : state === "current" ? <CircleNotch size={14} className="animate-spin" />
                        : <span className="ade-pm-step-dot" />}
                    {step.label}
                    {state === "current" && step.id === "copy" && progress?.fraction != null ? (
                      <span className="ade-pm-muted kit-num">{Math.round((progress.fraction ?? 0) * 100)}%</span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {progress?.step === "copy" && progress.fraction != null ? (
              <span className="kit-meter"><span style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></span>
            ) : null}
          </>
        ) : null}

        {stage === "failed" ? (
          <Banner
            layout="inline"
            model={{
              id: "project-move-failed",
              tone: "error",
              title: error ?? "Something went wrong.",
              // Only the engine's own report proves the original was left alone.
              detail: record && !record.originalParkedAt
                ? "Your project wasn't changed."
                : "Check that the project opens where it was before you try again.",
            }}
          />
        ) : null}

        {stage === "done" && record ? (
          <>
            <div className="ade-pm-hero">
              <CheckCircle size={22} weight="fill" />
              <div>
                <div className="ade-pm-hero-title">{projectName} is now on {record.destinationInternal ? "this Mac" : record.destinationVolumeName ?? "the new drive"}</div>
                <div className="ade-pm-muted ade-pm-mono">{displayPath(record.destinationRoot)}</div>
              </div>
            </div>

            {problems.map((line) => <Issue key={line} check={{ status: "warning", title: line }} />)}

            <div className="kit-card">
              <div className="kit-card-body" data-flush="true">
                <div className="ade-pm-row">
                  <Robot size={16} />
                  <div className="ade-pm-row-text">
                    <div className="ade-pm-issue-title">Check it with an agent</div>
                    <div className="ade-pm-muted">Reinstalls, builds, finds old paths. Asks before changing anything.</div>
                  </div>
                  {checkOpen ? null : (
                    <button
                      type="button"
                      className="kit-btn"
                      onClick={() => {
                        setCheckPrompt((current) => current || agentCheckPrompt(record));
                        setCheckOpen(true);
                      }}
                    >
                      Set up…
                    </button>
                  )}
                </div>
                {checkOpen ? (
                  <div className="ade-pm-check">
                    <SessionLaunchModelControls
                      config={{ ...checkConfig, modelId: checkModelId }}
                      showSessionType={false}
                      disabled={startingCheck}
                      onChange={(patch) => setCheckConfig((current) => ({ ...current, ...patch }))}
                    />
                    <textarea
                      className="ade-dialog-input ade-pm-check-prompt"
                      aria-label="Prompt for the check agent"
                      value={checkPrompt}
                      disabled={startingCheck}
                      onChange={(event) => setCheckPrompt(event.target.value)}
                    />
                    <div className="ade-pm-check-actions">
                      <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={startingCheck} onClick={() => setCheckOpen(false)}>Cancel</button>
                      <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={startingCheck} onClick={() => void startAgentCheck()}>
                        {startingCheck ? <CircleNotch size={12} className="animate-spin" /> : null}
                        Start agent
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="kit-rule" />
                <div className="ade-pm-row">
                  <FolderSimple size={16} />
                  <div className="ade-pm-row-text">
                    <div className="ade-pm-issue-title">
                      Old copy <span className="ade-pm-muted kit-num">{formatBytes(record.originalBytes)}</span>
                    </div>
                    {record.cleanup.choice === "pending" ? (
                      <>
                        <div className="ade-pm-muted ade-pm-mono" title={record.originalParkedAt ?? ""}>{displayPath(record.originalParkedAt ?? "")}</div>
                        <div className="ade-pm-muted">No rush: you can clean it up later from Settings → Project location.</div>
                      </>
                    ) : (
                      <div className="ade-pm-muted">
                        {record.cleanup.choice === "deleted" ? "Deleted"
                          : record.cleanup.choice === "remind" ? `ADE will ask ${formatReminder(record.cleanup.remindAt)}`
                            : "Kept"}
                      </div>
                    )}
                  </div>
                  {record.cleanup.choice === "deleted" ? null : <OldCopyControls record={record} onChange={setRecord} />}
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
