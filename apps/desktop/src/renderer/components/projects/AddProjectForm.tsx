import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CheckCircle, CircleNotch, Desktop, XCircle } from "@phosphor-icons/react";
import type { RecentProjectSummary } from "../../../shared/types";
import { extractError } from "../../lib/format";
import { captureError } from "../../../shared/sentry/capture";
import { isWebClientMode } from "../../lib/webClientMode";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { useAccountStatus } from "../../lib/account";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { Banner } from "../ui/notice";
import { useAddToAccount } from "./useAddToAccount";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  fgTint,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { RepoField, inputStyle, sectionLabelStyle } from "./AddProjectRepoField";
import {
  copyMachines,
  existingCopiesForRepo,
  expandRepoInput,
  isGitHubRepoUrl,
  joinMachinePath,
  repoKeyForUrl,
  readMachineDefaultParentDir,
  repoNameForUrl,
  type CopyMachine,
  type CopyOpenTarget,
  type ExistingCopy,
} from "./projectCopies";
import {
  copyJobKey,
  retryCopyJob,
  startCopyJob,
  useCopyJobs,
  watchCopyJobs,
  whenCopyJobReady,
  type CopyJob,
} from "./projectCopyJobs";

/**
 * Opens a copy in this window. Its repository tab shows that copy; nothing
 * moves the tab back to this computer's copy (S4).
 */
export async function openProjectCopy(target: CopyOpenTarget): Promise<void> {
  const store = useAppStore.getState();
  if (target.kind === "remote") {
    await store.switchRemoteProject(target.targetId, target.projectId);
    return;
  }
  await store.switchProjectToPath(target.rootPath, { skipWorktreeGate: true });
}

export type AddProjectFormProps = {
  /** Fills the repository, e.g. for another copy of a project that is open. */
  initialUrl?: string;
  /** Machines ticked at first. Nothing is ticked by default. */
  initialMachineIds?: readonly string[];
  /**
   * Adding a copy of a project that is already open: the form opens the
   * ticked copy once it is there, in place of the project's tab.
   */
  opensCopy?: boolean;
  onCancel: () => void;
  /** The work is handed off (or done): the host may close. */
  onClose: () => void;
  /** Opens one copy of the project, once it is there. */
  onOpenProject: (target: CopyOpenTarget) => Promise<void>;
  /** The other ways to add a project (open a folder, a new empty project), under the form. */
  moreActions?: React.ReactNode;
};

type RowState =
  | { kind: "job"; job: CopyJob }
  | { kind: "existing"; copy: ExistingCopy }
  | { kind: "available" };

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A machine's name mid-sentence: this computer reads "this computer". */
function machineLabel(machine: CopyMachine): string {
  return machine.isLocal ? "this computer" : machine.name;
}

/** Where an existing copy opens; null for another machine's copy with no project id. */
function existingTarget(machine: CopyMachine, copy: ExistingCopy): CopyOpenTarget | null {
  if (machine.isLocal) return { kind: "local", rootPath: copy.rootPath, displayName: copy.displayName };
  if (!machine.targetId || !copy.projectId) return null;
  return {
    kind: "remote",
    targetId: machine.targetId,
    projectId: copy.projectId,
    rootPath: copy.rootPath,
    displayName: copy.displayName,
  };
}

/** The one line under the list that says what Add will do; null when there is nothing to say. */
function addOutcomeLine(state: {
  repoChosen: boolean;
  submitted: boolean;
  waitingOn: string | null;
  localNeedsFolder: boolean;
  opensProjectTab: boolean;
  opensOnly: boolean;
  tickedNames: readonly string[];
}): string | null {
  if (state.waitingOn) return `Opens on ${state.waitingOn} when its copy is ready.`;
  if (!state.repoChosen || state.submitted || state.opensOnly) return null;
  if (state.localNeedsFolder) return "Choose a folder on this computer for the copy.";
  if (state.opensProjectTab) {
    return state.tickedNames.length > 0
      ? `Opens now. ADE clones it on ${listNames(state.tickedNames)} in the background.`
      : "Opens now with no copy. When you start work on a computer, ADE clones it there.";
  }
  if (state.tickedNames.length === 0) return "Pick a computer to put a copy on.";
  return `Opens on ${state.tickedNames[0]} when its copy is ready.`;
}

/**
 * Add project: a repository, and optionally the computers to put a copy on.
 *
 * The project belongs to the account, not to a computer: Add puts it on the
 * account and opens its tab at once, with or without a copy. Each ticked
 * computer clones in the background, on its own (a failure on one never stops
 * the others), and the tab moves to the first copy that is there
 * (`useAdeCloudTabFollowsCopy`). A computer with no copy can still be picked
 * later, when work starts on it.
 *
 * Only connected computers are listed: the form never connects to or wakes
 * one. Signed out (or an address only the cloning computer can read), and
 * when adding a copy of an open project (`opensCopy`), the form opens a copy
 * instead: the first ticked one once its clone ends, else one already there.
 */
export function AddProjectForm({
  initialUrl,
  initialMachineIds,
  opensCopy = false,
  onCancel,
  onClose,
  onOpenProject,
  moreActions = null,
}: AddProjectFormProps) {
  const webMode = isWebClientMode();
  const { snapshot } = useRemoteConnectionSnapshot(true);
  const { status: accountStatus, loading: accountLoading } = useAccountStatus();
  const [recents, setRecents] = useState<RecentProjectSummary[] | null>(null);
  const [urlInput, setUrlInput] = useState(initialUrl ?? "");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(initialMachineIds ?? []));
  const [parentByMachine, setParentByMachine] = useState<Record<string, string>>({});
  const [editingMachineId, setEditingMachineId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  /** The machine whose copy opens once its clone ends (no project tab to open). */
  const [waitingOnId, setWaitingOnId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One read of the recent projects, for this computer's copies.
  useEffect(() => {
    let cancelled = false;
    void window.ade.project
      .listRecent()
      .then((rows) => {
        if (!cancelled) setRecents(rows);
      })
      .catch((error: unknown) => {
        // No recents: the form still lists the machines, with no copy marked as there.
        captureError(error, { fingerprint: ["add-project", "list-recent"], level: "warning", handled: true });
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
  const { accountError, addingToAccount, canAddToAccount, addToAccount } = useAddToAccount({ folderName, onClose });
  // Known signed out: the account cannot take the project, so the form puts
  // a copy on a computer and opens that. Unknown (still loading, or a client
  // that cannot say) counts as signed in; the add then says what went wrong.
  const knownSignedOut = typeof window.ade?.account?.status === "function"
    && !accountLoading
    && !accountStatus.signedIn;
  // The project opens on its tab (the account's), unless this form adds a
  // copy of a project that is already open.
  const opensProjectTab = canAddToAccount && !opensCopy && !knownSignedOut;

  useEffect(() => (repoKey ? watchCopyJobs(repoKey) : undefined), [repoKey]);
  const jobs = useCopyJobs(repoKey);
  const jobByMachine = useMemo(() => new Map(jobs.map((job) => [job.machine.machineId, job])), [jobs]);

  const existing = useMemo(
    () => existingCopiesForRepo(repoKey, { recents: recents ?? [], snapshot }),
    [recents, repoKey, snapshot],
  );
  // This computer first, then the connected computers as saved. A computer
  // that is not connected is not listed, unless a clone this window started
  // there still has something to say.
  const machines = useMemo(
    () => copyMachines(snapshot, { includeLocal: !webMode })
      .filter((machine) => machine.online || jobByMachine.has(machine.machineId)),
    [jobByMachine, snapshot, webMode],
  );

  const rowState = useCallback(
    (machine: CopyMachine): RowState => {
      const job = jobByMachine.get(machine.machineId);
      if (job) return { kind: "job", job };
      const copy = existing.get(machine.machineId);
      if (copy) return { kind: "existing", copy };
      return { kind: "available" };
    },
    [existing, jobByMachine],
  );

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
      && (machine.isLocal || machine.targetId != null));
    for (const machine of wanted) {
      fetchedDefaultsRef.current.add(machine.machineId);
      // A machine that cannot say uses its own default when it clones.
      void readMachineDefaultParentDir(machine.targetId).then((value) => {
        if (!mountedRef.current || !value) return;
        setParentByMachine((current) => (current[machine.machineId] ? current : { ...current, [machine.machineId]: value }));
      });
    }
    // Keyed on the connected machines, not the list object: a snapshot tick
    // that changes nothing must not read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineTargetsKey]);

  // An offline machine is listed only with a job, so a ticked available row is online.
  const cloneableTicked = machines.filter(
    (machine) => ticked.has(machine.machineId) && rowState(machine).kind === "available",
  );
  const tickedNames = cloneableTicked.map(machineLabel);
  const localNeedsFolder = cloneableTicked.some((machine) => machine.isLocal && !parentByMachine[machine.machineId]);

  /** A copy that is there now, on a connected computer. */
  const openNowTarget = (() => {
    for (const machine of machines) {
      if (!machine.online) continue;
      const state = rowState(machine);
      if (state.kind === "existing") {
        const target = existingTarget(machine, state.copy);
        if (target) return target;
      }
      if (state.kind === "job" && state.job.status === "ready" && state.job.result) return state.job.result;
    }
    return null;
  })();

  // The wait ends when its clone fails: the row shows why, and its folder
  // can change before Retry. The ready callback still opens a retried copy.
  const waitingOnMachine = waitingOnId ? machines.find((machine) => machine.machineId === waitingOnId) ?? null : null;
  const waiting = waitingOnId != null && jobByMachine.get(waitingOnId)?.status !== "failed";
  const busy = addingToAccount || waiting;
  const canAdd = Boolean(repoKey)
    && folderName.length > 0
    && !localNeedsFolder
    && !busy
    && (opensProjectTab || cloneableTicked.length > 0 || openNowTarget != null);
  // With nothing to clone and a copy already there, Add only opens it.
  const opensOnly = !opensProjectTab && cloneableTicked.length === 0 && openNowTarget != null;

  const openTarget = async (target: CopyOpenTarget) => {
    try {
      await onOpenProject(target);
    } catch (error) {
      const message = extractError(error);
      if (mountedRef.current) {
        setWaitingOnId(null);
        setOpenError(message);
      } else {
        showToast({ tone: "error", title: "Couldn't open the project", message });
      }
      return;
    }
    if (mountedRef.current) onClose();
  };

  /**
   * Says when a copy is there, once the form is closed: the tab already moves
   * to the first copy, so the notice is for the others (and Open moves the
   * tab to that one).
   */
  const noteWhenReady = (key: string, machineName: string, repoName: string) => {
    whenCopyJobReady(key, (target) => {
      if (mountedRef.current) return;
      showToast({
        id: `project-copy-ready:${key}`,
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

  /**
   * No project tab to open: open a copy. The first ticked one once its clone
   * ends (what the line under the list promised), else one already there.
   */
  const openCopyFallback = (started: readonly CopyMachine[]) => {
    const first = started[0];
    if (first && repoKey) {
      setWaitingOnId(first.machineId);
      whenCopyJobReady(copyJobKey(repoKey, first.machineId), (target) => {
        if (!mountedRef.current) return;
        void openTarget(target);
      });
      return;
    }
    if (openNowTarget) void openTarget(openNowTarget);
  };

  const handleAdd = async () => {
    if (!repoKey || !canAdd) return;
    setOpenError(null);
    const started = [...cloneableTicked];
    for (const machine of started) {
      startCopyJob({
        repoKey,
        url: repoUrl,
        name: folderName,
        parentDir: parentByMachine[machine.machineId] ?? null,
        displayName: folderName,
        machine: { machineId: machine.machineId, name: machine.name, targetId: machine.targetId },
      });
      noteWhenReady(copyJobKey(repoKey, machine.machineId), machineLabel(machine), folderName);
    }
    setTicked(new Set());
    setSubmitted(true);

    if (opensProjectTab) {
      const added = await addToAccount(repoUrl, {
        openTab: true,
        // Signed out: the copies still open, as before the account kept projects.
        quietIfNoAccount: started.length > 0 || openNowTarget != null,
        ...(started.length > 0 ? { successMessage: `Cloning on ${listNames(started.map(machineLabel))}.` } : {}),
      });
      // Added: the tab is open and the form closed. Closed: another account
      // signed in, so nothing of this add opens. Otherwise open a copy.
      if (added === "added" || added === "closed" || !mountedRef.current) return;
      if (added === "failed" && started.length === 0 && openNowTarget) {
        // The copy opens and the form closes with it: the error goes with the person.
        showToast({
          tone: "warning",
          title: `Opened ${folderName}, but couldn't add it to your account`,
          message: "Add it again from Add project to see it on your other computers.",
        });
      }
    } else if (canAddToAccount && !knownSignedOut) {
      // The account lists the project too; the copy does not wait for it.
      void addToAccount(repoUrl, { openTab: false });
    }
    openCopyFallback(started);
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
    } catch (error) {
      // The picker closing with an error leaves the folder as it was.
      captureError(error, { fingerprint: ["add-project", "choose-folder"], level: "warning", handled: true });
    }
  };

  const outcomeLine = addOutcomeLine({
    repoChosen: Boolean(repoKey),
    submitted,
    waitingOn: waiting && waitingOnMachine ? machineLabel(waitingOnMachine) : null,
    localNeedsFolder,
    opensProjectTab,
    opensOnly,
    tickedNames,
  });
  // The add was handed off, or a clone still runs: the form only closes now.
  const handedOff = submitted || jobs.some((job) => job.status === "cloning");
  let addLabel = opensCopy ? "Add copy" : "Add project";
  if (addingToAccount) addLabel = "Adding…";
  else if (waiting) addLabel = "Cloning…";
  else if (opensOnly) addLabel = "Open";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, width: "100%" }}>
      <RepoField value={urlInput} onChange={setUrlInput} valid={urlValid} />

      {machines.length === 0 ? (
        // No computer connected (or none at all): the project goes on the
        // account, and ADE Cloud makes its copy at the first chat.
        <p style={{ margin: 0, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
          ADE Cloud makes a copy when you send the first chat.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={sectionLabelStyle}>{opensProjectTab ? "Also put a copy on" : "Put a copy on"}</span>
            {opensProjectTab ? (
              <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>optional</span>
            ) : null}
          </div>
          <div
            role="group"
            aria-label="Computers to put a copy on"
            style={{
              display: "flex",
              flexDirection: "column",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 10,
              background: fgTint(2),
              overflow: "hidden",
            }}
          >
            {machines.map((machine, index) => (
              <MachineRow
                key={machine.machineId}
                machine={machine}
                first={index === 0}
                state={rowState(machine)}
                ticked={ticked.has(machine.machineId)}
                repoName={folderName}
                folder={parentByMachine[machine.machineId] ?? ""}
                editing={editingMachineId === machine.machineId}
                locked={busy}
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
            ))}
          </div>
          {outcomeLine ? (
            <span aria-live="polite" style={{ fontSize: 11.5, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
              {outcomeLine}
            </span>
          ) : null}
        </div>
      )}

      {accountError ? (
        <Banner
          layout="inline"
          model={{
            id: "add-project-account",
            tone: "error",
            title: `Couldn't add ${folderName || "the project"} to your account`,
            detail: accountError,
            report: { surface: "add-project", code: "account_add_failed", technicalDetail: accountError },
            actions: opensProjectTab
              ? [{ label: "Try again", onClick: () => void addToAccount(repoUrl, { openTab: true }) }]
              : [],
          }}
        />
      ) : null}

      {openError ? (
        <Banner
          layout="inline"
          model={{
            id: "add-project-open",
            tone: "error",
            title: "Couldn't open the project",
            detail: openError,
            report: { surface: "add-project", code: "open_failed", technicalDetail: openError },
          }}
        />
      ) : null}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          style={outlineButton()}
          onClick={handedOff ? onClose : onCancel}
        >
          {handedOff ? "Close" : "Cancel"}
        </button>
        <button
          type="button"
          style={primaryButton({
            opacity: canAdd ? 1 : 0.55,
            cursor: canAdd ? "pointer" : "not-allowed",
            minWidth: 120,
          })}
          disabled={!canAdd}
          onClick={() => void handleAdd()}
        >
          {addLabel}
        </button>
      </div>
      {moreActions}
    </div>
  );
}

function MachineRow({
  machine,
  first,
  state,
  ticked,
  repoName,
  folder,
  editing,
  locked,
  onToggle,
  onEditFolder,
  onFolderChange,
  onRetry,
}: {
  machine: CopyMachine;
  first: boolean;
  state: RowState;
  ticked: boolean;
  /** The folder the copy gets, once a repository is chosen; "" before. */
  repoName: string;
  /** The parent folder on that machine; "" while it is not known. */
  folder: string;
  editing: boolean;
  /** The add is running: the ticks and folders stay as they are. */
  locked: boolean;
  onToggle: (next: boolean) => void;
  onEditFolder: () => void;
  onFolderChange: (value: string) => void;
  onRetry: (job: CopyJob) => void;
}) {
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    padding: "6px 8px 6px 12px",
    borderTop: first ? "none" : `1px solid ${COLORS.border}`,
    fontFamily: SANS_FONT,
    fontSize: 12.5,
    color: COLORS.textPrimary,
  };
  const nameStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    width: 150,
    flexShrink: 0,
    overflow: "hidden",
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
  // Where the copy goes: the full path once the repository is known.
  const destination = folder ? (repoName ? joinMachinePath(folder, repoName) : folder) : "";
  const changeFolderButton = (
    <button
      type="button"
      className="kit-btn kit-btn-ghost"
      data-size="sm"
      aria-label={`Change folder on ${machine.name}`}
      aria-expanded={machine.isLocal ? undefined : editing}
      disabled={locked}
      onClick={(event) => {
        // Inside the row's label: the click changes the folder, not the tick.
        event.preventDefault();
        onEditFolder();
      }}
      style={{ flexShrink: 0 }}
    >
      Change…
    </button>
  );

  let lead: React.ReactNode;
  let detail: React.ReactNode;
  let trailing: React.ReactNode = null;
  switch (state.kind) {
    case "job": {
      const { job } = state;
      const where = job.parentDir && job.name ? joinMachinePath(job.parentDir, job.name) : destination;
      if (job.status !== "failed") {
        const cloning = job.status === "cloning";
        lead = glyph(cloning
          ? <CircleNotch size={13} weight="bold" className="animate-spin" />
          : <CheckCircle size={14} weight="fill" color={COLORS.success} />);
        detail = (
          <span style={detailStyle} title={where || undefined}>
            {cloning ? "Cloning…" : "Ready"}
            {where ? <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}> {where}</span> : null}
          </span>
        );
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
            {changeFolderButton}
            <button
              type="button"
              className="kit-btn"
              data-size="sm"
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
      lead = glyph(<CheckCircle size={14} weight="regular" color={COLORS.textMuted} />);
      detail = (
        <span style={detailStyle} title={state.copy.rootPath}>
          Already here <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{state.copy.rootPath}</span>
        </span>
      );
      break;
    case "available":
      lead = (
        <input
          type="checkbox"
          checked={ticked}
          disabled={locked}
          aria-label={`Put a copy on ${machine.name}`}
          onChange={(event) => onToggle(event.target.checked)}
          style={{ width: 14, height: 14, margin: 1, flexShrink: 0, accentColor: "var(--color-accent)", cursor: locked ? "default" : "pointer" }}
        />
      );
      detail = (
        <span style={{ ...pathStyle, opacity: ticked ? 1 : 0.75 }} title={destination || undefined}>
          {destination || "Default folder"}
        </span>
      );
      trailing = changeFolderButton;
      break;
  }

  const name = (
    <span style={nameStyle}>
      <Desktop size={13} weight="regular" aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{machine.name}</span>
    </span>
  );
  // A row that can be ticked is one label: a click anywhere on it ticks it.
  const row = state.kind === "available" ? (
    <label className="kit-row" style={{ ...rowStyle, borderRadius: 0, cursor: locked ? "default" : "pointer" }}>
      {lead}
      {name}
      {detail}
      {trailing}
    </label>
  ) : (
    <div style={rowStyle} aria-live={state.kind === "job" ? "polite" : undefined}>
      {lead}
      {name}
      {detail}
      {trailing}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {row}
      {editing && (state.kind === "available" || (state.kind === "job" && state.job.status === "failed")) && !machine.isLocal ? (
        <div style={{ padding: "0 12px 10px 38px" }}>
          <input
            type="text"
            value={folder}
            autoFocus
            aria-label={`Folder on ${machine.name}`}
            placeholder={`Folder on ${machine.name}`}
            onChange={(event) => onFolderChange(event.target.value)}
            style={{ ...inputStyle, height: 30 }}
          />
        </div>
      ) : null}
    </div>
  );
}
