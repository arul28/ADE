import React, { useMemo, useState } from "react";
import { CheckCircle, Circle, CircleNotch, Cloud, Desktop, HardDrives, Info, XCircle } from "@phosphor-icons/react";
import type { CtoAvatarLook } from "../../../shared/types";
import type { CtoCloudHomeSnapshot } from "../../../shared/ctoCloudHome";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import type { ProjectMachine } from "../../state/projectMachines";
import { Banner } from "../ui/notice";
import { cn } from "../ui/cn";
import { CtoAvatar } from "./avatar/CtoAvatar";
import { ctoHomeCandidates, STILL_IDENTIFYING_THIS_COMPUTER } from "./ctoHomeMachine";
import type { CtoCloudHomeOption } from "./useCtoCloudHome";

/** The ADE Cloud row's id in the radio group. */
const CLOUD_OPTION_ID = "__ade_cloud__";

/** Why a machine cannot be picked, or null when it can. */
function unavailableReason(machine: ProjectMachine): string | null {
  if (!machine.online) return "Offline";
  if (!machine.hasRepo) return "No checkout of this repo";
  if (!machine.routable) return "Not reachable yet";
  // This computer is recorded by its account device id; without it, no other
  // machine could ever find the CTO here.
  if (machine.isThisMachine && !machine.deviceId) return STILL_IDENTIFYING_THIS_COMPUTER;
  return null;
}

/** A second line only when it adds something the name does not say. */
function machineDetail(machine: ProjectMachine): string | null {
  if (machine.isThisMachine) return /this computer/i.test(machine.machineName) ? null : "This computer";
  if (machine.isActiveBinding) return "Open in this tab";
  return null;
}

/** The ADE Cloud row's second line, and whether it can be picked. */
function cloudRow(cloud: CtoCloudHomeOption): { detail: string; disabled: boolean } {
  if (cloud.blocked) return { detail: cloud.blocked, disabled: true };
  if (!cloud.planKnown) return { detail: "Checking your plan…", disabled: true };
  if (!cloud.paid) return { detail: "Needs a paid plan", disabled: false };
  return { detail: "Its own small computer that wakes when needed", disabled: false };
}

const STAGE_LABELS: Record<string, string> = {
  computer: "Make the computer",
  join: "Join your account",
  clone: "Clone the repository",
};

function StageRow({ stage, repo }: { stage: CtoCloudHomeSnapshot["stages"][number]; repo: string }) {
  const label = stage.id === "clone" ? `Clone ${repo}` : (STAGE_LABELS[stage.id] ?? stage.id);
  const done = stage.status === "done" || stage.status === "skipped" || stage.status === "warning";
  const icon = stage.status === "running"
    ? <CircleNotch size={15} weight="bold" className="shrink-0 animate-spin" style={{ color: "var(--cto-accent)" }} aria-hidden />
    : stage.status === "failed"
      ? <XCircle size={15} weight="fill" className="shrink-0 text-[var(--kit-crit)]" aria-hidden />
      : done
        ? <CheckCircle size={15} weight="fill" className="shrink-0" style={{ color: "var(--cto-accent)" }} aria-hidden />
        : <Circle size={15} className="shrink-0 text-muted-fg/30" aria-hidden />;
  const detail = stage.status === "running" || stage.status === "failed" ? stage.detail : null;
  return (
    <li className="flex min-w-0 items-center gap-2.5 py-1" data-testid={`cto-cloud-stage-${stage.id}`} data-status={stage.status}>
      {icon}
      <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", done || stage.status === "running" || stage.status === "failed" ? "text-fg" : "text-muted-fg/60")}>
        {label}
      </span>
      {detail ? <span className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-fg/55" title={detail}>{detail}</span> : null}
    </li>
  );
}

/**
 * The one question the CTO's home asks: which machine does it live on.
 *
 * There is no default: the person picks one of their machines with a
 * checkout of this repo, or ADE Cloud (paid plans; a free plan is sent to the
 * upgrade). Changing it later says in one line what comes along: the notes
 * and the recent chat, from the account copy, when this computer is signed in.
 */
export function CtoHomeChooser({
  look,
  name,
  machines,
  current,
  currentName,
  copyFollows,
  cloud,
  onChoose,
  onCancel,
}: {
  look: CtoAvatarLook;
  name: string;
  machines: readonly ProjectMachine[];
  /** The present home, when changing it. Null on first run. */
  current: ProjectMachine | null;
  /** The present home's name, even when this computer cannot see it. */
  currentName: string | null;
  /** False when this computer can't reach the account: nothing comes along then. */
  copyFollows: boolean;
  /** ADE Cloud as a home; null hides the row. */
  cloud: CtoCloudHomeOption | null;
  onChoose: (machine: ProjectMachine) => Promise<void>;
  onCancel?: () => void;
}) {
  const changing = currentName != null;
  const { computers: laneComputers } = useAdeCloudLaneComputers();
  const options = useMemo(
    () => ctoHomeCandidates(machines, current?.machineId ?? null, laneComputers),
    [current?.machineId, laneComputers, machines],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showCloud = Boolean(cloud?.shown);
  const cloudPick = showCloud && cloud ? cloudRow(cloud) : null;
  const cloudSelected = selectedId === CLOUD_OPTION_ID && cloudPick != null && !cloudPick.disabled;
  const selected = cloudSelected ? null : options.find((machine) => machine.machineId === selectedId) ?? null;
  const sameAsCurrent = Boolean(current && selected && current.machineId === selected.machineId);
  const busy = saving || Boolean(cloud?.busy);
  const canConfirm = !busy && (cloudSelected || Boolean(selected && !unavailableReason(selected) && !sameAsCurrent));

  const confirm = async () => {
    if (!canConfirm) return;
    setError(null);
    if (cloudSelected && cloud) {
      await (cloud.paid ? cloud.start() : cloud.upgrade());
      return;
    }
    if (!selected) return;
    setSaving(true);
    try {
      await onChoose(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the home machine.");
    } finally {
      setSaving(false);
    }
  };

  const job = cloud?.job && cloud.job.phase !== "cancelled" ? cloud.job : null;
  const shownError = error ?? cloud?.error ?? null;
  const clearShownError = () => {
    setError(null);
    cloud?.clearError();
  };

  const confirmLabel = saving
    ? "Saving…"
    : cloudSelected && cloud
      ? (cloud.busy ? "Starting…" : cloud.paid ? "Use ADE Cloud" : "Upgrade to use ADE Cloud")
      : selected
        ? selected.isThisMachine
          ? (changing ? "Move here" : "Use this computer")
          : `${changing ? "Move to" : "Use"} ${selected.machineName}`
        : "Pick a machine";

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6" data-testid="cto-home-chooser">
      <div className="flex w-full min-w-0 max-w-[400px] flex-col items-center">
        <CtoAvatar look={look} state={job ? "thinking" : changing ? "idle" : "asleep"} size={64} motion="lazy" />
        <h1 className="m-0 mt-3 max-w-full truncate text-[17px] font-semibold tracking-[-0.01em] text-fg">
          {job ? `Setting up ${name} on ADE Cloud` : changing ? `Move ${name}` : `Where should ${name} live?`}
        </h1>
        {job ? (
          <p className="m-0 mt-1.5 max-w-full truncate text-[12.5px] text-[var(--kit-text-2)]" title={job.computerName}>
            {job.phase === "failed"
              ? "Stopped partway. Try again, or cancel to delete the computer."
              : job.reused ? `Using ${job.computerName} again` : "A few minutes. You can leave this page."}
          </p>
        ) : changing ? (
          <p
            className={cn(
              "m-0 mt-1.5 inline-flex max-w-full items-center gap-1.5 text-[12.5px]",
              copyFollows ? "text-[var(--kit-text-2)]" : "text-[color-mix(in_srgb,var(--kit-warn)_85%,var(--color-fg))]",
            )}
            data-testid="cto-home-change-note"
            title={copyFollows
              ? "ADE keeps a copy in your account after each turn. Work already running on the old machine stays there."
              : "This computer can't reach your ADE account, so the new machine starts with its own notes and chat."}
          >
            <Info size={13} className="shrink-0" aria-hidden />
            <span className="truncate">
              {copyFollows ? `Notes and recent chat come along` : `Notes and chat stay on ${currentName}`}
            </span>
          </p>
        ) : (
          <p className="m-0 mt-1.5 max-w-full truncate text-[12.5px] text-[var(--kit-text-2)]">
            Pick one that's usually on
          </p>
        )}

        {job && cloud ? (
          <>
            <ul className="m-0 mt-5 w-full list-none rounded-lg border border-fg/[0.08] px-3 py-2" data-testid="cto-cloud-progress">
              {job.stages.map((stage) => (
                <StageRow key={stage.id} stage={stage} repo={job.projectOrigin.replace(/^github\.com\//i, "")} />
              ))}
              {job.phase === "ready" ? (
                <li className="flex min-w-0 items-center gap-2.5 py-1 text-[12.5px] text-fg">
                  <CircleNotch size={15} weight="bold" className="shrink-0 animate-spin" style={{ color: "var(--cto-accent)" }} aria-hidden />
                  <span className="truncate">Moving {name} in…</span>
                </li>
              ) : null}
            </ul>
            {job.phase === "ready" && cloud.linkStalled ? (
              <p className="m-0 mt-2 w-full text-[11.5px] text-muted-fg/70" data-testid="cto-cloud-link-stalled">
                It's ready, but hasn't connected to this computer yet. ADE keeps trying; you can leave this page.
              </p>
            ) : null}
            {job.warning && job.phase !== "ready" ? (
              <p className="m-0 mt-2 w-full text-[11.5px] text-muted-fg/70">{job.warning}</p>
            ) : null}
            {job.phase === "failed" && job.error ? (
              <Banner
                layout="inline"
                style={{ marginTop: 12, width: "100%" }}
                model={{ id: "cto-cloud-home-failed", tone: "error", title: job.error, report: { surface: "cto_cloud_home" } }}
              />
            ) : null}
            <div className="mt-4 flex w-full items-center gap-2">
              {job.phase === "failed" ? (
                <button
                  type="button"
                  data-testid="cto-cloud-retry"
                  disabled={cloud.busy}
                  onClick={() => void cloud.retry()}
                  className="kit-btn kit-btn-primary"
                >
                  {cloud.busy ? "Trying again…" : "Try again"}
                </button>
              ) : null}
              <button
                type="button"
                data-testid="cto-cloud-cancel"
                // While the ready computer is being made the home, a cancel
                // would delete the machine the home record now names. A move
                // in that stalls gets its way out back.
                disabled={cloud.busy || (cloud.linking && !cloud.linkStalled)}
                onClick={() => void cloud.cancel()}
                className="kit-btn kit-btn-ghost"
                title={job.reused ? "Stops here. The computer stays." : "Stops and deletes the computer ADE made."}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-5 flex w-full flex-col gap-1.5" role="radiogroup" aria-label={`Home machine for ${name}`}>
              {options.map((machine) => {
                const reason = unavailableReason(machine);
                const detail = reason ?? machineDetail(machine);
                const isSelected = machine.machineId === selectedId;
                const isCurrent = current?.machineId === machine.machineId;
                const Icon = machine.isThisMachine ? Desktop : HardDrives;
                return (
                  <OptionRow
                    key={machine.machineId}
                    testId={`cto-home-option-${machine.machineId}`}
                    icon={<Icon size={15} className="shrink-0 text-muted-fg/70" />}
                    title={machine.machineName}
                    current={isCurrent}
                    detail={detail}
                    selected={isSelected}
                    disabled={reason != null}
                    onSelect={() => setSelectedId(machine.machineId)}
                  />
                );
              })}
              {showCloud && cloudPick ? (
                <OptionRow
                  testId="cto-home-option-cloud"
                  icon={<Cloud size={15} className="shrink-0 text-muted-fg/70" />}
                  title="ADE Cloud"
                  current={false}
                  detail={cloudPick.detail}
                  selected={selectedId === CLOUD_OPTION_ID}
                  disabled={cloudPick.disabled}
                  onSelect={() => setSelectedId(CLOUD_OPTION_ID)}
                />
              ) : null}
            </div>

            <div className="mt-4 flex w-full items-center gap-2">
              <button
                type="button"
                data-testid="cto-home-confirm"
                disabled={!canConfirm}
                onClick={() => void confirm()}
                className="kit-btn kit-btn-primary min-w-0 max-w-full"
                title={selected ? selected.machineName : undefined}
              >
                <span className="truncate">{confirmLabel}</span>
              </button>
              {onCancel ? (
                <button type="button" onClick={onCancel} className="kit-btn kit-btn-ghost">
                  Cancel
                </button>
              ) : null}
            </div>
          </>
        )}

        {shownError ? (
          <Banner
            layout="inline"
            style={{ marginTop: 12, width: "100%" }}
            model={{
              id: "cto-home-save-error",
              tone: "error",
              title: shownError,
              report: { surface: "cto_home_save" },
              dismiss: { onDismiss: clearShownError },
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function OptionRow({
  testId,
  icon,
  title,
  current,
  detail,
  selected,
  disabled,
  onSelect,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  current: boolean;
  detail: string | null;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      data-testid={testId}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-[var(--cto-accent-line)]",
        selected
          ? "border-[var(--cto-accent-line)] bg-[var(--cto-accent-soft)]"
          : "border-fg/[0.08] hover:bg-fg/[0.03]",
        disabled && "cursor-default opacity-45 hover:bg-transparent",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">
          {title}
          {current ? <span className="ml-1.5 text-[11px] font-normal text-muted-fg/55">Current</span> : null}
        </span>
        {detail ? <span className="block truncate text-[11px] text-muted-fg/55" title={detail}>{detail}</span> : null}
      </span>
      {selected
        ? <CheckCircle size={16} weight="fill" className="shrink-0" style={{ color: "var(--cto-accent)" }} />
        : <Circle size={16} className="shrink-0 text-muted-fg/30" />}
    </button>
  );
}
