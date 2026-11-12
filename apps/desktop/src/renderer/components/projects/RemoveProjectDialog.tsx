import React, { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CheckCircle, CircleDashed, CircleNotch, CloudSlash, Desktop, Question, Trash, UserCircle, Warning, XCircle } from "@phosphor-icons/react";
import {
  liveSessionCount,
  summarizeCopyWork,
  summarizeLiveSessions,
  type ProjectRemovalOutcome,
  type ProjectRemovalReport,
  type ProjectRemovalRequest,
} from "../../../shared/projectRemoval";
import { isRemoteOutcomeUnknownError } from "../../../shared/runtimeErrors";
import { extractError } from "../../lib/format";
import { Dialog } from "../ui/dialog/Dialog";
import { noteAccountProjectChange } from "../../state/accountProjectListClient";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import type { CopyMachine } from "./projectCopies";
import { useCopyJobs, watchCopyJobs } from "./projectCopyJobs";

/** One machine's copy, as the tab knows it. */
export type RemovalCopy = {
  machine: CopyMachine;
  rootPath: string;
  bindingKey: string;
  /** The machine's project id, for a copy on another machine; null on this computer. */
  projectId: string | null;
};

export type RemoveProjectTarget = {
  projectName: string;
  /** Null for a project with no git origin: it lives on one machine, so "all my machines" is hidden. */
  repoKey: string | null;
  /** The copy the tab is on; null for a tab with no computer online, which can only leave the account. */
  current: RemovalCopy | null;
  /** Every machine's copy, the current one included. */
  copies: readonly RemovalCopy[];
  /** The account project (`ap_…`) when the account lists it: then "From my account" shows. */
  accountProjectId: string | null;
};

export type RemoveProjectResult = {
  scope: Scope;
  /** The account no longer lists the project. */
  accountRemoved: boolean;
  /** Binding keys whose entry is gone. */
  removedBindingKeys: string[];
  /**
   * Binding keys whose machine dropped or stopped answering after the request
   * went out: ADE does not know whether the copy is gone, so it may remain.
   */
  unknownBindingKeys: string[];
  /** A machine is adding a copy of this repository now. */
  cloneRunning: boolean;
};

type ReportState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; report: ProjectRemovalReport }
  /** An older ADE: entry-only removal through `projects.remove`. */
  | { kind: "unsupported" }
  | { kind: "failed"; message: string };

type RowResult =
  | { kind: "running" }
  | { kind: "done"; outcome: ProjectRemovalOutcome }
  | { kind: "error"; message: string }
  /** The request went out and the answer never came back. */
  | { kind: "unknown" };

type Scope = "this" | "all" | "account";

type AccountStep =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "error"; message: string };

async function inspectCopy(copy: RemovalCopy): Promise<ReportState> {
  if (copy.machine.isLocal) {
    const inspect = window.ade?.project?.inspectRemoval;
    if (typeof inspect !== "function") return { kind: "unsupported" };
    return { kind: "ready", report: await inspect(copy.rootPath) };
  }
  const inspect = window.ade?.remoteRuntime?.inspectProjectRemoval;
  if (typeof inspect !== "function" || !copy.machine.targetId || !copy.projectId) return { kind: "unsupported" };
  const answer = await inspect(copy.machine.targetId, copy.projectId);
  return answer.supported ? { kind: "ready", report: answer.report } : { kind: "unsupported" };
}

async function removeCopy(copy: RemovalCopy, request: ProjectRemovalRequest): Promise<ProjectRemovalOutcome> {
  if (copy.machine.isLocal) {
    const remove = window.ade?.project?.removeCopy;
    if (typeof remove === "function") return await remove(copy.rootPath, request);
    if (request.deleteFolder) throw new Error("This ADE can't delete folders.");
    await window.ade.project.forgetRecent(copy.rootPath);
    return { status: "removed", folder: "kept", outsideLaneFolders: [] };
  }
  const remove = window.ade?.remoteRuntime?.removeProjectCopy;
  if (typeof remove !== "function" || !copy.machine.targetId || !copy.projectId) {
    throw new Error(`Update ADE on this computer to remove a project from ${copy.machine.name}.`);
  }
  return await remove(copy.machine.targetId, copy.projectId, request);
}

/** What a row allows for a delete, from its report. */
function deleteAllowance(report: ReportState): { canTick: boolean; tickedByDefault: boolean } {
  if (report.kind !== "ready") return { canTick: false, tickedByDefault: false };
  const { state, deleteRefusal } = report.report;
  if (deleteRefusal || state.folder === "missing" || liveSessionCount(state) > 0) {
    return { canTick: false, tickedByDefault: false };
  }
  return { canTick: true, tickedByDefault: !summarizeCopyWork(state).hasWork };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Removes a project from the machine the tab is on, or from every machine
 * that has a copy. By default only the entries go and every folder stays.
 * With "Also delete the folders", each machine first reports its own copy;
 * a clean copy is ticked, a copy with work that is not pushed is ticked only
 * by name, and a copy with something running cannot be ticked. Each machine
 * checks its copy again right before it deletes, and refuses when it changed.
 *
 * Every call goes to the machine the copy is on. A machine that is offline is
 * never called (and never woken): it keeps its copy and its entry.
 */
export function RemoveProjectDialog({
  target,
  onClose,
  onRemoved,
}: {
  target: RemoveProjectTarget;
  onClose: () => void;
  onRemoved: (result: RemoveProjectResult) => void;
}) {
  const { projectName, repoKey, current, copies, accountProjectId } = target;
  const canLeaveAccount = accountProjectId != null && typeof window.ade?.project?.accountRemove === "function";
  const [scope, setScope] = useState<Scope>(current ? "this" : "account");
  const [accountStep, setAccountStep] = useState<AccountStep>({ kind: "idle" });
  const [deleteFolders, setDeleteFolders] = useState(false);
  const [reports, setReports] = useState<Record<string, ReportState>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [phase, setPhase] = useState<"choose" | "running" | "done">("choose");
  const requested = useRef(new Set<string>());
  const jobs = useCopyJobs(repoKey);

  useEffect(() => (repoKey ? watchCopyJobs(repoKey) : undefined), [repoKey]);

  const rows = useMemo<readonly RemovalCopy[]>(
    () => (scope === "this" || !repoKey ? (current ? [current] : []) : copies),
    [copies, current, repoKey, scope],
  );
  const cloningMachines = useMemo(
    () => (scope !== "this"
      ? jobs.filter((job) => job.status === "cloning" && !copies.some((copy) => copy.machine.machineId === job.machine.machineId))
      : []),
    [copies, jobs, scope],
  );

  // Each shown machine reports its copy once, when it first shows: on open
  // for the tab's machine, and when "all my machines" shows the rest.
  useEffect(() => {
    for (const copy of rows) {
      const key = copy.bindingKey;
      if (!copy.machine.online || requested.current.has(key)) continue;
      requested.current.add(key);
      setReports((prev) => ({ ...prev, [key]: { kind: "loading" } }));
      void inspectCopy(copy).then(
        (report) => {
          setReports((prev) => ({ ...prev, [key]: report }));
          setTicked((prev) => (key in prev ? prev : { ...prev, [key]: deleteAllowance(report).tickedByDefault }));
        },
        (error: unknown) => setReports((prev) => ({ ...prev, [key]: { kind: "failed", message: extractError(error) } })),
      );
    }
  }, [rows]);

  const actionable = rows.filter((copy) => copy.machine.online);
  const deleting = deleteFolders
    ? actionable.filter((copy) => ticked[copy.bindingKey] && deleteAllowance(reports[copy.bindingKey] ?? { kind: "idle" }).canTick)
    : [];
  const stillLoading = deleteFolders && actionable.some((copy) => {
    const report = reports[copy.bindingKey];
    return !report || report.kind === "loading";
  });
  const modeOf = (copy: RemovalCopy) => {
    const report = reports[copy.bindingKey];
    return report?.kind === "ready" ? report.report.deleteMode : null;
  };
  const anyTrash = deleting.some((copy) => modeOf(copy) === "trash");
  const anyPermanent = deleting.some((copy) => modeOf(copy) === "permanent");

  const confirmLabel = (() => {
    if (deleting.length > 0) return `Remove and delete ${plural(deleting.length, "folder", "folders")}`;
    if (scope === "account") return "Remove from my account";
    if (scope === "this" || actionable.length <= 1) return `Remove from ${actionable[0]?.machine.name ?? current?.machine.name ?? "this computer"}`;
    return `Remove from ${plural(actionable.length, "computer", "computers")}`;
  })();

  // Runs once, from the confirm button; a plain function reads this render's choices.
  const run = async () => {
    setPhase("running");
    const outcomes = await Promise.all(actionable.map(async (copy) => {
      const key = copy.bindingKey;
      const report = reports[key];
      const willDelete = deleting.includes(copy);
      const state = report?.kind === "ready" ? report.report.state : null;
      const request: ProjectRemovalRequest = {
        deleteFolder: willDelete,
        stateToken: willDelete && report?.kind === "ready" ? report.report.stateToken : null,
        // Ticked by name while it showed work: the person accepted losing it.
        acceptWork: willDelete && state != null && summarizeCopyWork(state).hasWork,
      };
      setResults((prev) => ({ ...prev, [key]: { kind: "running" } }));
      try {
        const outcome = await removeCopy(copy, request);
        setResults((prev) => ({ ...prev, [key]: { kind: "done", outcome } }));
        return { copy, result: outcome.status === "refused" ? "kept" as const : "removed" as const };
      } catch (error) {
        // A dropped connection or a timeout after the request went out: the
        // machine may have finished. It is never reported as kept.
        if (isRemoteOutcomeUnknownError(error)) {
          setResults((prev) => ({ ...prev, [key]: { kind: "unknown" } }));
          return { copy, result: "unknown" as const };
        }
        setResults((prev) => ({ ...prev, [key]: { kind: "error", message: extractError(error) } }));
        return { copy, result: "kept" as const };
      }
    }));
    const keysWith = (result: "removed" | "unknown") =>
      outcomes.filter((entry) => entry.result === result).map((entry) => entry.copy.bindingKey);
    // The account step runs after the computers: a copy that stays (offline,
    // refused) keeps its folder either way, and the account forgets the
    // project for every device.
    let accountRemoved = false;
    const accountRemove = window.ade?.project?.accountRemove;
    if (scope === "account" && accountProjectId && typeof accountRemove === "function") {
      setAccountStep({ kind: "running" });
      const answer = await accountRemove(accountProjectId).catch((error: unknown) => ({
        ok: false as const,
        code: "unavailable",
        message: extractError(error),
      }));
      if (answer.ok) {
        accountRemoved = true;
        noteAccountProjectChange({ removedId: accountProjectId });
        setAccountStep({ kind: "done" });
      } else {
        setAccountStep({ kind: "error", message: answer.message });
      }
    }
    setPhase("done");
    onRemoved({
      scope,
      accountRemoved,
      removedBindingKeys: keysWith("removed"),
      unknownBindingKeys: keysWith("unknown"),
      cloneRunning: jobs.some((job) => job.status === "cloning"),
    });
  };

  const busy = phase === "running";
  const machineName = current?.machine.name ?? null;
  const keptLine = deleteFolders && deleting.length > 0
    ? "Folders that are not ticked stay on disk."
    : "ADE keeps the folders. Each copy stays on disk where it is.";
  const accountOnly = scope === "account" && actionable.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      dismissible={!busy}
      title={`Remove ${projectName}?`}
      description={phase === "choose" ? keptLine : undefined}
      tone={deleting.length > 0 ? "error" : "warning"}
      icon={<Trash size={16} weight="duotone" />}
      size="lg"
      role="alertdialog"
      actions={phase === "done"
        ? [{ label: "Done", variant: "solid", onClick: onClose, autoFocus: true }]
        : [
          {
            label: confirmLabel,
            variant: "solid",
            onClick: () => void run(),
            busy,
            disabled: busy || (actionable.length === 0 && !(scope === "account" && canLeaveAccount)) || stillLoading,
          },
          { label: "Cancel", variant: "secondary", onClick: onClose, disabled: busy },
        ]}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: SANS_FONT, fontSize: 12 }}>
        {phase === "choose" ? (
          <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <legend style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
              Where to remove it from
            </legend>
            {current ? (
              <ChoiceRow
                type="radio"
                checked={scope === "this"}
                onChange={() => setScope("this")}
                label={current.machine.isLocal ? "From this computer" : `From ${machineName}`}
              />
            ) : null}
            {repoKey && copies.length > 0 ? (
              <ChoiceRow
                type="radio"
                checked={scope === "all"}
                onChange={() => setScope("all")}
                label="From all my computers"
              />
            ) : null}
            {canLeaveAccount ? (
              <ChoiceRow
                type="radio"
                checked={scope === "account"}
                onChange={() => setScope("account")}
                label="From my account"
                hint="Every computer and device stops listing it."
              />
            ) : null}
            {actionable.length > 0 ? (
              <>
                <div style={{ height: 4 }} />
                <ChoiceRow
                  type="checkbox"
                  checked={deleteFolders}
                  onChange={(next) => setDeleteFolders(next)}
                  label="Also delete the folders"
                />
              </>
            ) : null}
          </fieldset>
        ) : null}

        <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: "hidden" }}>
          {rows.length === 0 && !accountOnly ? (
            <div style={rowStyle(true, true)}>
              <span style={glyphStyle}><CloudSlash size={13} aria-hidden /></span>
              <span style={detailStyle}>No computer with this project is online.</span>
            </div>
          ) : null}
          {scope === "account" ? (
            <AccountRow
              first
              step={accountStep}
              offlineCount={rows.filter((copy) => !copy.machine.online).length}
              noComputers={rows.length === 0}
            />
          ) : null}
          {rows.map((copy, index) => (
            <CopyRow
              key={copy.bindingKey}
              copy={copy}
              scope={scope}
              first={index === 0 && scope !== "account"}
              deleteFolders={deleteFolders && phase === "choose"}
              report={reports[copy.bindingKey] ?? { kind: "idle" }}
              ticked={Boolean(ticked[copy.bindingKey])}
              onTick={(next) => setTicked((prev) => ({ ...prev, [copy.bindingKey]: next }))}
              result={results[copy.bindingKey] ?? null}
              locked={phase !== "choose"}
            />
          ))}
          {cloningMachines.map((job) => (
            <div key={job.key} style={rowStyle(false, true)}>
              <span style={glyphStyle}><CircleNotch size={13} weight="bold" className="animate-spin" /></span>
              <MachineName name={job.machine.name} />
              <span style={detailStyle}>Adding a copy now. It is not removed.</span>
            </div>
          ))}
        </div>

        {phase === "choose" && deleting.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, color: COLORS.textMuted }}>
            {anyTrash ? <span>Folders on this computer move to the Trash, where you can get them back.</span> : null}
            {anyPermanent ? (
              <span style={{ color: COLORS.danger }}>Folders on other machines are deleted permanently. They can't be recovered.</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function ChoiceRow({
  type,
  checked,
  onChange,
  label,
  hint,
}: {
  type: "radio" | "checkbox";
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: COLORS.textPrimary }}>
      <input
        type={type}
        name={type === "radio" ? "remove-project-scope" : undefined}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        style={{ width: 14, height: 14, margin: 0, accentColor: "var(--color-accent)" }}
      />
      {label}
      {hint ? <span style={{ color: COLORS.textMuted }}>{hint}</span> : null}
    </label>
  );
}

/** The account's part of "From my account": its own row, above the computers. */
function AccountRow({
  first,
  step,
  offlineCount,
  noComputers,
}: {
  first: boolean;
  step: AccountStep;
  offlineCount: number;
  noComputers: boolean;
}) {
  let glyph: React.ReactNode = <UserCircle size={14} weight="regular" aria-hidden />;
  let line: { text: string; tone?: "danger" } = {
    text: "Your project list forgets it. Lanes and chats come back if you add it again.",
  };
  if (step.kind === "running") {
    glyph = <CircleNotch size={13} weight="bold" className="animate-spin" aria-hidden />;
    line = { text: "Removing…" };
  } else if (step.kind === "done") {
    glyph = <CheckCircle size={14} weight="fill" color={COLORS.success} aria-hidden />;
    line = { text: "Removed from your account." };
  } else if (step.kind === "error") {
    glyph = <XCircle size={14} weight="fill" color={COLORS.danger} aria-hidden />;
    line = { text: `Still on your account. ${step.message}`, tone: "danger" };
  }
  const extra = step.kind === "idle" && offlineCount > 0
    ? `${plural(offlineCount, "computer is", "computers are")} offline and keep their folders.`
    : step.kind === "idle" && noComputers
      ? "No computer is online, so no folder changes."
      : null;
  return (
    <div style={rowStyle(first, false)} aria-live={step.kind === "idle" ? undefined : "polite"}>
      <span style={glyphStyle}>{glyph}</span>
      <MachineName name="Your account" icon="account" />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ color: line.tone === "danger" ? COLORS.danger : COLORS.textMuted, overflowWrap: "anywhere" }}>{line.text}</span>
        {extra ? <span style={{ color: COLORS.textMuted }}>{extra}</span> : null}
      </div>
    </div>
  );
}

const glyphStyle: CSSProperties = { width: 16, display: "inline-flex", justifyContent: "center", flexShrink: 0, marginTop: 1 };
const detailStyle: CSSProperties = { flex: 1, minWidth: 0, color: COLORS.textMuted };
const pathStyle: CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 11,
  color: COLORS.textMuted,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function rowStyle(first: boolean, muted: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    minHeight: 40,
    padding: "8px 12px",
    borderTop: first ? "none" : `1px solid ${COLORS.border}`,
    color: muted ? COLORS.textMuted : COLORS.textPrimary,
  };
}

function MachineName({ name, icon = "computer" }: { name: string; icon?: "computer" | "account" }) {
  return (
    <span style={{ width: 132, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 500 }}>
      {icon === "account" ? null : <Desktop size={12} weight="regular" aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
    </span>
  );
}

function outcomeLine(outcome: ProjectRemovalOutcome): { tone: "ok" | "kept" | "warn"; text: string } {
  if (outcome.status === "refused") return { tone: "kept", text: `Kept. ${outcome.reason}` };
  if (outcome.status === "partial") {
    return { tone: "warn", text: `Removed. ${outcome.reason} The rest is in ${outcome.remainingPath}; delete it yourself.` };
  }
  if (outcome.alreadyRemoved) return { tone: "ok", text: "Already removed." };
  switch (outcome.folder) {
    case "trashed":
      return { tone: "ok", text: "Removed. The folder is in the Trash." };
    case "deleted":
      return { tone: "ok", text: "Removed. The folder is deleted." };
    case "missing":
      return { tone: "ok", text: "Removed. The folder was already gone." };
    default:
      return { tone: "ok", text: "Removed. The folder stays on disk." };
  }
}

function CopyRow({
  copy,
  scope,
  first,
  deleteFolders,
  report,
  ticked,
  onTick,
  result,
  locked,
}: {
  copy: RemovalCopy;
  scope: Scope;
  first: boolean;
  deleteFolders: boolean;
  report: ReportState;
  ticked: boolean;
  onTick: (next: boolean) => void;
  result: RowResult | null;
  locked: boolean;
}) {
  const { machine } = copy;
  const lines: Array<{ text: string; tone?: "danger" | "warning" | "muted" }> = [];
  let glyph: React.ReactNode = <CircleDashed size={13} aria-hidden />;
  let control: React.ReactNode = null;
  const allowance = deleteAllowance(report);
  const ready = report.kind === "ready" ? report.report : null;

  if (!machine.online) {
    lines.push({
      text: scope === "account"
        ? `${machine.name} is offline. It keeps its folder.`
        : `${machine.name} is offline. It keeps its copy and its entry.`,
    });
  } else if (result) {
    if (result.kind === "running") {
      glyph = <CircleNotch size={13} weight="bold" className="animate-spin" aria-hidden />;
      lines.push({ text: "Removing…" });
    } else if (result.kind === "error") {
      glyph = <XCircle size={14} weight="fill" color={COLORS.danger} aria-hidden />;
      lines.push({ text: `Kept. ${result.message}`, tone: "danger" });
    } else if (result.kind === "unknown") {
      glyph = <Question size={14} weight="regular" color={COLORS.textMuted} aria-hidden />;
      lines.push({ text: `Not known: ${machine.name} disconnected. Open this again to check.`, tone: "muted" });
    } else {
      const line = outcomeLine(result.outcome);
      glyph = line.tone === "ok"
        ? <CheckCircle size={14} weight="fill" color={COLORS.success} aria-hidden />
        : line.tone === "warn"
          ? <Warning size={14} weight="fill" color={COLORS.warning} aria-hidden />
          : <XCircle size={14} weight="fill" color={COLORS.danger} aria-hidden />;
      lines.push({ text: line.text, tone: line.tone === "kept" ? "danger" : line.tone === "warn" ? "warning" : undefined });
      if (result.outcome.status === "removed" && result.outcome.outsideLaneFolders.length > 0) {
        lines.push({ text: `Lane folders outside the project stay: ${result.outcome.outsideLaneFolders.join(", ")}`, tone: "muted" });
      }
    }
  } else if (report.kind === "loading") {
    glyph = <CircleNotch size={13} weight="bold" className="animate-spin" aria-hidden />;
    if (deleteFolders) lines.push({ text: "Checking the copy…" });
  } else if (report.kind === "unsupported") {
    lines.push({ text: `Update ADE on ${machine.name} to delete its folder from here. Its entry can still be removed.`, tone: "muted" });
  } else if (report.kind === "failed") {
    lines.push({ text: `Couldn't check the copy: ${report.message}`, tone: "warning" });
  } else if (ready) {
    const running = summarizeLiveSessions(ready.state);
    const work = summarizeCopyWork(ready.state);
    if (ready.state.folder === "missing") {
      lines.push({ text: "The folder isn't there (moved, deleted, or on a disk that isn't connected). Only the entry is removed." });
    } else if (running) {
      glyph = <Warning size={14} weight="fill" color={COLORS.warning} aria-hidden />;
      lines.push({
        text: deleteFolders ? running : `${running.replace(/ Stop (it|them) first\.$/, "")} Removing the entry stops ${liveSessionCount(ready.state) === 1 ? "it" : "them"}.`,
        tone: "warning",
      });
    } else if (deleteFolders) {
      if (ready.deleteRefusal) {
        lines.push({ text: `ADE won't delete this folder. ${ready.deleteRefusal}`, tone: "muted" });
      } else if (work.summary) {
        lines.push({ text: work.summary, tone: "warning" });
      } else {
        lines.push({ text: "Clean: everything is pushed." });
      }
    }
    if (deleteFolders && allowance.canTick && ready.outsideLaneFolders.length > 0) {
      lines.push({
        text: `Lane folders outside the project stay on disk, but their git history is in the project folder and goes with it: ${ready.outsideLaneFolders.join(", ")}`,
        tone: "muted",
      });
    }
  }

  if (deleteFolders && machine.online && !result) {
    if (allowance.canTick && ready) {
      const work = summarizeCopyWork(ready.state);
      const mode = ready.deleteMode === "trash" ? "moves to Trash" : "deleted permanently";
      control = (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, cursor: "pointer", color: COLORS.textPrimary }}>
          <input
            type="checkbox"
            checked={ticked}
            disabled={locked}
            aria-label={work.hasWork
              ? `Delete the folder on ${machine.name}, with what only this copy has`
              : `Delete the folder on ${machine.name}`}
            onChange={(event) => onTick(event.target.checked)}
            style={{ width: 14, height: 14, margin: 0, accentColor: "var(--color-error)" }}
          />
          <span style={{ fontSize: 11, color: ready.deleteMode === "permanent" ? COLORS.danger : COLORS.textMuted }}>
            {work.hasWork ? `Delete anyway (${mode})` : `Delete (${mode})`}
          </span>
        </label>
      );
    } else if (report.kind === "ready" || report.kind === "unsupported" || report.kind === "failed") {
      control = <span style={{ fontSize: 11, color: COLORS.textMuted, flexShrink: 0 }}>Folder stays</span>;
    }
  }

  const toneColor = (tone?: "danger" | "warning" | "muted") =>
    tone === "danger" ? COLORS.danger : tone === "warning" ? COLORS.warning : COLORS.textMuted;

  return (
    <div style={rowStyle(first, !machine.online)} aria-live={result ? "polite" : undefined}>
      <span style={glyphStyle}>{glyph}</span>
      <MachineName name={machine.name} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={pathStyle} title={copy.rootPath}>{copy.rootPath}</span>
        {lines.map((line, index) => (
          <span key={index} style={{ color: toneColor(line.tone), overflowWrap: "anywhere" }}>{line.text}</span>
        ))}
      </div>
      {control}
    </div>
  );
}
