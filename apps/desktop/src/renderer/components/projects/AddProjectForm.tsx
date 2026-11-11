import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  CaretDown,
  CaretUp,
  CheckCircle,
  CircleDashed,
  CircleNotch,
  Desktop,
  DotsThree,
  LockSimple,
  XCircle,
} from "@phosphor-icons/react";
import type {
  ListMyGitHubReposResult,
  MyGitHubRepoSummary,
  RecentProjectSummary,
} from "../../../shared/types";
import { THIS_MACHINE_ID } from "../../../shared/machineIdentity";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import { extractError, relativeWhen } from "../../lib/format";
import { isWebClientMode } from "../../lib/webClientMode";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { rememberExplicitRemotePick } from "../app/usePreferLocalCheckout";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  fgTint,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { ConnectGithubPrompt } from "./ConnectGithubPrompt";
import {
  copyMachines,
  existingCopiesForRepo,
  expandRepoInput,
  offlineMachinesLabel,
  splitOfflineMachines,
  isGitHubRepoUrl,
  repoKeyForUrl,
  repoNameForUrl,
  type CopyMachine,
  type CopyOpenTarget,
  type ExistingCopy,
} from "./projectCopies";
import {
  copyJobKey,
  listCopyJobs,
  retryCopyJob,
  startCopyJob,
  useCopyJobs,
  watchCopyJobs,
  whenCopyJobReady,
  type CopyJob,
} from "./projectCopyJobs";

/**
 * Opens a copy in this window. A copy on another machine is a choice made on
 * purpose, so this computer's own copy (if any) does not take the tab back.
 */
export async function openProjectCopy(target: CopyOpenTarget): Promise<void> {
  const store = useAppStore.getState();
  if (target.kind === "remote") {
    rememberExplicitRemotePick(remoteProjectBindingKey(target.targetId, target.projectId));
    await store.switchRemoteProject(target.targetId, target.projectId);
    return;
  }
  await store.switchProjectToPath(target.rootPath, { skipWorktreeGate: true });
}

export type AddProjectFormProps = {
  /** Fills the repository, e.g. for another copy of a project that is open. */
  initialUrl?: string;
  /** Machines ticked at first, in place of the default. */
  initialMachineIds?: readonly string[];
  onCancel: () => void;
  /** The work is handed off (or done): the host may close. */
  onClose: () => void;
  /** Opens the project on the machine "Opens on" names, once its copy is there. */
  onOpenProject: (target: CopyOpenTarget) => Promise<void>;
};

const inputStyle: CSSProperties = {
  height: 36,
  padding: "0 12px",
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: fgTint(4),
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const sectionLabelStyle: CSSProperties = { ...LABEL_STYLE, letterSpacing: "0.08em", textTransform: "uppercase" };

/** The repository list gives up after 15 s, so a stalled GitHub call shows an error. */
function withRepoListDeadline(promise: Promise<ListMyGitHubReposResult>): Promise<ListMyGitHubReposResult> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error("Timed out loading repositories. Check GitHub auth and network access."));
    }, 15_000);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The machine the person last worked on, when the recent projects say so clearly. */
function lastUsedMachineId(recents: readonly RecentProjectSummary[]): string | null {
  let latest: RecentProjectSummary | null = null;
  let latestAt = -1;
  for (const recent of recents) {
    const at = Date.parse(recent.lastOpenedAt);
    if (Number.isFinite(at) && at > latestAt) {
      latest = recent;
      latestAt = at;
    }
  }
  return latest?.kind === "remote" && latest.remote ? latest.remote.targetId : null;
}

type RowState =
  | { kind: "job"; job: CopyJob }
  | { kind: "existing"; copy: ExistingCopy }
  | { kind: "offline" }
  | { kind: "web" }
  | { kind: "available" };

/**
 * Add project: the repository first, then one row per machine to put a copy
 * on. Each ticked machine clones on its own; a failure on one never stops the
 * others, and each row shows its own state. The project opens on the "Opens
 * on" machine as soon as its copy is there, while the other rows still clone.
 */
export function AddProjectForm({
  initialUrl,
  initialMachineIds,
  onCancel,
  onClose,
  onOpenProject,
}: AddProjectFormProps) {
  const webMode = isWebClientMode();
  const { snapshot, loaded: snapshotLoaded } = useRemoteConnectionSnapshot(true);
  const [recents, setRecents] = useState<RecentProjectSummary[] | null>(null);
  const [urlInput, setUrlInput] = useState(initialUrl ?? "");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(initialMachineIds ?? []));
  const ticksInitializedRef = useRef(initialMachineIds != null);
  const [parentByMachine, setParentByMachine] = useState<Record<string, string>>({});
  const [editingMachineId, setEditingMachineId] = useState<string | null>(null);
  const [openOnChoice, setOpenOnChoice] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One read of the recent projects, for this computer's copies and the last machine used.
  useEffect(() => {
    let cancelled = false;
    void window.ade.project
      .listRecent()
      .then((rows) => {
        if (!cancelled) setRecents(rows);
      })
      .catch(() => {
        if (!cancelled) setRecents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const repoUrl = expandRepoInput(urlInput);
  const urlValid = isGitHubRepoUrl(repoUrl);
  const repoKey = urlValid ? repoKeyForUrl(repoUrl) : null;
  const folderName = urlValid ? repoNameForUrl(repoUrl) : "";

  useEffect(() => (repoKey ? watchCopyJobs(repoKey) : undefined), [repoKey]);
  const jobs = useCopyJobs(repoKey);

  const machines = useMemo(() => copyMachines(snapshot, { includeLocal: !webMode }), [snapshot, webMode]);
  const existing = useMemo(
    () => existingCopiesForRepo(repoKey, { recents: recents ?? [], snapshot }),
    [recents, repoKey, snapshot],
  );
  const jobByMachine = useMemo(() => new Map(jobs.map((job) => [job.machine.machineId, job])), [jobs]);

  const rowState = useCallback(
    (machine: CopyMachine): RowState => {
      const job = jobByMachine.get(machine.machineId);
      if (job) return { kind: "job", job };
      const copy = existing.get(machine.machineId);
      if (copy) return { kind: "existing", copy };
      if (!machine.online) return { kind: "offline" };
      if (webMode && !machine.isLocal) return { kind: "web" };
      return { kind: "available" };
    },
    [existing, jobByMachine, webMode],
  );

  // A long list of offline machines collapses into one row, so the folder
  // row and the Add button stay in view. A machine with a copy or a clone job
  // of this repository stays out of the collapsed group.
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const { visible: visibleMachines, offline: offlineMachines } = useMemo(
    () => splitOfflineMachines(machines, (machine) => machine, (machine) => {
      const kind = rowState(machine).kind;
      return kind === "job" || kind === "existing";
    }),
    [machines, rowState],
  );

  const renderMachineRow = (machine: CopyMachine, index: number) => (
    <MachineRow
      key={machine.machineId}
      machine={machine}
      first={index === 0}
      state={rowState(machine)}
      ticked={ticked.has(machine.machineId)}
      repoChosen={Boolean(repoKey)}
      folder={parentByMachine[machine.machineId] ?? ""}
      editing={editingMachineId === machine.machineId}
      onToggle={(next) =>
        setTicked((current) => {
          const updated = new Set(current);
          if (next) updated.add(machine.machineId);
          else updated.delete(machine.machineId);
          return updated;
        })
      }
      onEditFolder={() => {
        if (machine.isLocal) {
          void chooseLocalFolder(machine);
          return;
        }
        setEditingMachineId((current) => (current === machine.machineId ? null : machine.machineId));
      }}
      onFolderChange={(value) =>
        setParentByMachine((current) => ({ ...current, [machine.machineId]: value }))
      }
      onRetry={(job) => {
        // The folder the row shows now, which the person may have changed after the failure.
        const folder = parentByMachine[machine.machineId]?.trim();
        setEditingMachineId((current) => (current === machine.machineId ? null : current));
        retryCopyJob(job.key, folder ? { parentDir: folder } : {});
      }}
    />
  );

  // Default ticks, once the machines and recents are known: this computer,
  // plus the machine last worked on when it is connected.
  useEffect(() => {
    if (ticksInitializedRef.current || recents == null || !snapshotLoaded) return;
    ticksInitializedRef.current = true;
    const next = new Set<string>();
    if (!webMode) next.add(THIS_MACHINE_ID);
    const lastUsed = lastUsedMachineId(recents);
    if (lastUsed && machines.some((machine) => machine.machineId === lastUsed && machine.online)) next.add(lastUsed);
    setTicked(next);
  }, [machines, recents, snapshotLoaded, webMode]);

  // The default folder of each machine, read once per machine, and only from
  // a machine that is connected: this form never connects to or wakes one.
  const fetchedDefaultsRef = useRef(new Set<string>());
  const onlineTargetsKey = machines
    .filter((machine) => machine.online && !machine.isLocal)
    .map((machine) => machine.targetId)
    .join("|");
  useEffect(() => {
    const wanted = machines.filter((machine) =>
      machine.online
      && !fetchedDefaultsRef.current.has(machine.machineId)
      && (machine.isLocal || !webMode));
    for (const machine of wanted) {
      fetchedDefaultsRef.current.add(machine.machineId);
      const read = machine.targetId
        ? window.ade.remoteRuntime.getDefaultParentDir(machine.targetId)
        : window.ade.project.getDefaultParentDir();
      void read
        .then((value) => {
          if (!mountedRef.current || !value) return;
          setParentByMachine((current) => (current[machine.machineId] ? current : { ...current, [machine.machineId]: value }));
        })
        .catch(() => {
          // A machine that cannot say uses its own default when it clones.
        });
    }
    // Keyed on the connected machines, not the list object: a snapshot tick
    // that changes nothing must not read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineTargetsKey, webMode]);

  const cloneableTicked = machines.filter(
    (machine) => ticked.has(machine.machineId) && rowState(machine).kind === "available",
  );
  const openOnOptions = useMemo(() => {
    const options: CopyMachine[] = [];
    for (const machine of machines) {
      const state = rowState(machine);
      const pickable =
        (state.kind === "available" && ticked.has(machine.machineId))
        || (state.kind === "existing" && machine.online)
        || (state.kind === "job" && state.job.status !== "failed");
      if (pickable) options.push(machine);
    }
    return options;
  }, [machines, rowState, ticked]);
  const defaultOpenOn =
    openOnOptions.find((machine) => machine.isLocal && ticked.has(machine.machineId))
    ?? openOnOptions.find((machine) => ticked.has(machine.machineId))
    ?? openOnOptions[0]
    ?? null;
  const openOn = openOnOptions.find((machine) => machine.machineId === openOnChoice) ?? defaultOpenOn;

  const localNeedsFolder = cloneableTicked.some((machine) => machine.isLocal && !parentByMachine[machine.machineId]);
  const canAdd = Boolean(repoKey) && folderName.length > 0 && cloneableTicked.length > 0 && !localNeedsFolder;
  const openTarget = useCallback(
    async (target: CopyOpenTarget) => {
      try {
        await onOpenProject(target);
      } catch (error) {
        const message = extractError(error);
        if (mountedRef.current) setOpenError(message);
        else showToast({ tone: "error", title: "Couldn't open the project", message });
        return;
      }
      if (!mountedRef.current) return;
      // Stay open while other copies still clone, so their rows stay in view.
      const stillCloning = repoKey ? listCopyJobs(repoKey).some((job) => job.status === "cloning") : false;
      if (!stillCloning) onClose();
    },
    [onClose, onOpenProject, repoKey],
  );

  const existingTarget = (machine: CopyMachine, copy: ExistingCopy): CopyOpenTarget | null => {
    if (machine.isLocal) return { kind: "local", rootPath: copy.rootPath, displayName: copy.displayName };
    if (!machine.targetId || !copy.projectId) return null;
    return {
      kind: "remote",
      targetId: machine.targetId,
      projectId: copy.projectId,
      rootPath: copy.rootPath,
      displayName: copy.displayName,
    };
  };

  /**
   * The copy a row can open now: one that was there, or one this form
   * finished cloning (a failed open of it can be tried again).
   */
  const openableTarget = (machine: CopyMachine, state: RowState): CopyOpenTarget | null => {
    if (state.kind === "existing") return existingTarget(machine, state.copy);
    if (state.kind === "job" && state.job.status === "ready") return state.job.result;
    return null;
  };
  const openOnlyCopy =
    Boolean(repoKey)
    && cloneableTicked.length === 0
    && openOn != null
    && openableTarget(openOn, rowState(openOn)) != null;

  const handleAdd = () => {
    if (!repoKey) return;
    setOpenError(null);
    if (openOnlyCopy && openOn) {
      const target = openableTarget(openOn, rowState(openOn));
      if (target) void openTarget(target);
      return;
    }
    if (!canAdd) return;
    const opensOnId = openOn?.machineId ?? null;
    for (const machine of cloneableTicked) {
      startCopyJob({
        repoKey,
        url: repoUrl,
        name: folderName,
        parentDir: parentByMachine[machine.machineId] ?? null,
        displayName: folderName,
        machine: { machineId: machine.machineId, name: machine.name, targetId: machine.targetId },
      });
    }
    setTicked(new Set());
    setSubmitted(true);
    if (!openOn || !opensOnId) return;
    const state = rowState(openOn);
    if (state.kind === "existing") {
      const target = existingTarget(openOn, state.copy);
      if (target) void openTarget(target);
      return;
    }
    const machineName = openOn.name;
    const repoName = folderName;
    whenCopyJobReady(copyJobKey(repoKey, opensOnId), (target) => {
      if (mountedRef.current) {
        void openTarget(target);
        return;
      }
      // The form was closed before the copy was there: the window does not
      // change project under the person. The notice opens the same copy, on
      // the same machine, when they ask.
      showToast({
        id: `project-copy-ready:${copyJobKey(repoKey, opensOnId)}`,
        tone: "success",
        title: `${repoName} is ready on ${machineName}`,
        actions: [
          {
            label: "Open",
            onClick: () => {
              void onOpenProject(target).catch((error: unknown) => {
                showToast({ tone: "error", title: "Couldn't open the project", message: extractError(error) });
              });
            },
          },
        ],
      });
    });
  };

  const chooseLocalFolder = async (machine: CopyMachine) => {
    const choose = window.ade.project.chooseDirectory;
    if (typeof choose !== "function") return;
    try {
      const picked = await choose({
        title: "Choose where the copy goes",
        defaultPath: parentByMachine[machine.machineId] || undefined,
      });
      if (picked) setParentByMachine((current) => ({ ...current, [machine.machineId]: picked }));
    } catch {
      // The picker closing with an error leaves the folder as it was.
    }
  };

  const anyJobRunning = jobs.some((job) => job.status === "cloning");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%" }}>
      <RepoField value={urlInput} onChange={setUrlInput} valid={urlValid} />

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={sectionLabelStyle}>Put a copy on</span>
        <div
          role="group"
          aria-label="Machines to put a copy on"
          style={{
            display: "flex",
            flexDirection: "column",
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            background: fgTint(2),
            overflow: "hidden",
          }}
        >
          {machines.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
              No machines are connected.
            </div>
          ) : (
            <>
              {visibleMachines.map((machine, index) => renderMachineRow(machine, index))}
              {offlineMachines.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={offlineExpanded}
                  onClick={() => setOfflineExpanded((current) => !current)}
                  className="kit-row"
                  style={{
                    minHeight: 36,
                    padding: "6px 12px",
                    borderRadius: 0,
                    borderTop: visibleMachines.length > 0 ? `1px solid ${COLORS.border}` : undefined,
                    fontFamily: SANS_FONT,
                    fontSize: 12,
                    color: COLORS.textMuted,
                  }}
                >
                  <span aria-hidden style={{ width: 16, display: "inline-flex", justifyContent: "center", flexShrink: 0 }}>
                    {offlineExpanded ? <CaretUp size={11} weight="bold" /> : <CaretDown size={11} weight="bold" />}
                  </span>
                  {offlineMachinesLabel(offlineMachines.length)}
                </button>
              ) : null}
              {offlineExpanded
                ? offlineMachines.map((machine, index) => renderMachineRow(machine, visibleMachines.length + 1 + index))
                : null}
            </>
          )}
        </div>
        {repoKey && !submitted && cloneableTicked.length === 0 && !openOnlyCopy ? (
          <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
            Pick at least one machine.
          </span>
        ) : null}
      </div>

      {openOnOptions.length > 0 ? (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
          Opens on:
          <select
            value={openOn?.machineId ?? ""}
            onChange={(event) => setOpenOnChoice(event.target.value)}
            aria-label="Opens on"
            style={{
              ...inputStyle,
              width: "auto",
              minWidth: 160,
              height: 30,
              fontFamily: SANS_FONT,
              padding: "0 8px",
            }}
          >
            {openOnOptions.map((machine) => (
              <option key={machine.machineId} value={machine.machineId}>
                {machine.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {openError ? (
        <span role="alert" style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.danger }}>
          Couldn't open the project: {openError}
        </span>
      ) : null}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
        <button
          type="button"
          style={outlineButton()}
          onClick={submitted || anyJobRunning ? onClose : onCancel}
        >
          {submitted || anyJobRunning ? "Close" : "Cancel"}
        </button>
        <button
          type="button"
          style={primaryButton({
            opacity: canAdd || openOnlyCopy ? 1 : 0.55,
            cursor: canAdd || openOnlyCopy ? "pointer" : "not-allowed",
            minWidth: 120,
          })}
          disabled={!canAdd && !openOnlyCopy}
          onClick={handleAdd}
        >
          {openOnlyCopy ? "Open" : "Add project"}
        </button>
      </div>
    </div>
  );
}

function MachineRow({
  machine,
  first,
  state,
  ticked,
  repoChosen,
  folder,
  editing,
  onToggle,
  onEditFolder,
  onFolderChange,
  onRetry,
}: {
  machine: CopyMachine;
  first: boolean;
  state: RowState;
  ticked: boolean;
  repoChosen: boolean;
  folder: string;
  editing: boolean;
  onToggle: (next: boolean) => void;
  onEditFolder: () => void;
  onFolderChange: (value: string) => void;
  onRetry: (job: CopyJob) => void;
}) {
  const muted = state.kind === "offline" || state.kind === "web";
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 40,
    padding: "6px 12px",
    borderTop: first ? "none" : `1px solid ${COLORS.border}`,
    fontFamily: SANS_FONT,
    fontSize: 12,
    color: muted ? COLORS.textMuted : COLORS.textPrimary,
  };
  const nameStyle: CSSProperties = {
    width: 132,
    flexShrink: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: 500,
  };
  const detailStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: COLORS.textMuted,
  };
  const pathStyle: CSSProperties = { ...detailStyle, fontFamily: MONO_FONT, fontSize: 11 };
  const glyph = (node: React.ReactNode) => (
    <span aria-hidden style={{ width: 16, display: "inline-flex", justifyContent: "center", flexShrink: 0 }}>{node}</span>
  );

  let lead: React.ReactNode;
  let detail: React.ReactNode;
  let trailing: React.ReactNode = null;
  switch (state.kind) {
    case "job": {
      const { job } = state;
      if (job.status === "cloning") {
        lead = glyph(<CircleNotch size={13} weight="bold" className="animate-spin" />);
        detail = <span style={detailStyle}>cloning…</span>;
      } else if (job.status === "ready") {
        lead = glyph(<CheckCircle size={14} weight="fill" color={COLORS.success} />);
        detail = <span style={detailStyle}>ready</span>;
      } else {
        lead = glyph(<XCircle size={14} weight="fill" color={COLORS.danger} />);
        detail = (
          <span style={{ ...detailStyle, color: COLORS.danger }} title={job.failure?.detail}>
            {job.failure?.reason ?? "Couldn't add the copy"}
            {folder.trim() && folder.trim() !== (job.parentDir ?? "") ? ` · Retry uses ${folder.trim()}` : null}
          </span>
        );
        // A retry calls the machine, so it waits until the machine is
        // connected again: this form never connects to or wakes one. The
        // folder can change first (a folder that does not exist, no access).
        trailing = machine.online ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <button
              type="button"
              className="kit-icon-btn"
              aria-label={`Change folder on ${machine.name}`}
              aria-expanded={machine.isLocal ? undefined : editing}
              onClick={onEditFolder}
              style={{ width: 24, height: 24, flexShrink: 0 }}
            >
              <DotsThree size={14} weight="bold" />
            </button>
            <button
              type="button"
              style={outlineButton({ height: 24, padding: "0 10px", fontSize: 11 })}
              aria-label={`Retry on ${machine.name}`}
              onClick={() => onRetry(job)}
            >
              Retry
            </button>
          </span>
        ) : null;
      }
      break;
    }
    case "existing":
      lead = glyph(<CheckCircle size={14} weight="regular" />);
      detail = (
        <span style={pathStyle} title={state.copy.rootPath}>
          already here · {state.copy.rootPath}
        </span>
      );
      break;
    case "offline":
      lead = glyph(<CircleDashed size={14} />);
      detail = <span style={detailStyle}>offline</span>;
      break;
    case "web":
      lead = glyph(<CircleDashed size={14} />);
      detail = <span style={detailStyle}>Needs the desktop app</span>;
      break;
    case "available":
      lead = (
        <input
          type="checkbox"
          checked={ticked}
          disabled={!repoChosen}
          aria-label={`Put a copy on ${machine.name}`}
          onChange={(event) => onToggle(event.target.checked)}
          style={{ width: 14, height: 14, margin: 1, flexShrink: 0, accentColor: "var(--color-accent)" }}
        />
      );
      detail = (
        <span style={pathStyle} title={folder || undefined}>
          {folder || "Default folder"}
        </span>
      );
      trailing = (
        <button
          type="button"
          className="kit-icon-btn"
          aria-label={`Change folder on ${machine.name}`}
          aria-expanded={machine.isLocal ? undefined : editing}
          onClick={onEditFolder}
          style={{ width: 24, height: 24, flexShrink: 0 }}
        >
          <DotsThree size={14} weight="bold" />
        </button>
      );
      break;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={rowStyle} aria-live={state.kind === "job" ? "polite" : undefined}>
        {lead}
        <span style={{ ...nameStyle, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Desktop size={12} weight="regular" aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{machine.name}</span>
        </span>
        {detail}
        {trailing}
      </div>
      {editing && (state.kind === "available" || (state.kind === "job" && state.job.status === "failed")) && !machine.isLocal ? (
        <div style={{ padding: "0 12px 10px 38px" }}>
          <input
            type="text"
            value={folder}
            autoFocus
            aria-label={`Folder on ${machine.name}`}
            placeholder="Folder on that machine"
            onChange={(event) => onFolderChange(event.target.value)}
            style={{ ...inputStyle, height: 30 }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The repository: a URL or `owner/repo`, or one picked from the person's
 * GitHub repositories (listed with this computer's GitHub sign-in).
 */
function RepoField({
  value,
  onChange,
  valid,
}: {
  value: string;
  onChange: (value: string) => void;
  valid: boolean;
}) {
  const [listOpen, setListOpen] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label htmlFor="add-project-repository" style={sectionLabelStyle}>Repository</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id="add-project-repository"
          autoFocus
          type="text"
          value={value}
          placeholder="owner/repo or https://github.com/owner/repo"
          onChange={(event) => onChange(event.target.value)}
          style={inputStyle}
        />
        <button
          type="button"
          style={outlineButton({ minWidth: 44 })}
          aria-label={listOpen ? "Hide your repositories" : "Show your repositories"}
          aria-expanded={listOpen}
          onClick={() => setListOpen((open) => !open)}
        >
          {listOpen ? <CaretUp size={12} weight="bold" /> : <CaretDown size={12} weight="bold" />}
        </button>
      </div>
      {value.trim().length > 0 && !valid ? (
        <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger }}>
          Enter a GitHub repo, like owner/repo or https://github.com/owner/repo
        </span>
      ) : null}
      {listOpen ? (
        <RepoList
          onPick={(repo) => {
            onChange(repo.cloneUrl);
            setListOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function RepoList({ onPick }: { onPick: (repo: MyGitHubRepoSummary) => void }) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [repos, setRepos] = useState<MyGitHubRepoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    const list = window.ade.github?.listMyRepos;
    const request: Promise<ListMyGitHubReposResult> = typeof list === "function"
      ? list({ search: debounced || undefined })
      : Promise.reject(new Error("GitHub is not available here."));
    void withRepoListDeadline(request)
      .then((result) => {
        if (requestRef.current !== requestId) return;
        setRepos([...result.repos].sort((a, b) => Date.parse(b.pushedAt ?? "") - Date.parse(a.pushedAt ?? "") || 0));
      })
      .catch((err) => {
        if (requestRef.current !== requestId) return;
        setError(extractError(err));
        setRepos([]);
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
  }, [debounced, reload]);

  if (error && /github_not_connected|not connected/i.test(error)) {
    return (
      <ConnectGithubPrompt
        statusError={null}
        onConnected={() => setReload((value) => value + 1)}
        onCancel={() => setError(null)}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <input
        type="text"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Filter your repositories…"
        aria-label="Filter your repositories"
        style={{ ...inputStyle, border: "none", borderBottom: `1px solid ${COLORS.border}`, borderRadius: 0, fontFamily: SANS_FONT }}
      />
      <div role="listbox" aria-label="Your repositories" style={{ maxHeight: 220, overflowY: "auto" }}>
        {loading && repos.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px", fontSize: 12, color: COLORS.textMuted }}>
            <CircleNotch size={12} weight="bold" className="animate-spin" />
            Loading your repositories…
          </div>
        ) : error ? (
          <div style={{ padding: "12px", fontSize: 12, color: COLORS.danger }}>{error}</div>
        ) : repos.length === 0 ? (
          <div style={{ padding: "12px", fontSize: 12, color: COLORS.textMuted }}>
            {debounced ? "No repositories match." : "No repositories found."}
          </div>
        ) : (
          repos.map((repo) => (
            <button
              key={repo.fullName}
              type="button"
              role="option"
              aria-selected={false}
              className="kit-row"
              onClick={() => onPick(repo)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 12px",
                background: "transparent",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                color: COLORS.textPrimary,
                fontFamily: MONO_FONT,
                fontSize: 12,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {repo.fullName}
              </span>
              {repo.isPrivate ? <LockSimple size={11} weight="fill" aria-label="Private" /> : null}
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                {repo.pushedAt ? relativeWhen(repo.pushedAt) : ""}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
