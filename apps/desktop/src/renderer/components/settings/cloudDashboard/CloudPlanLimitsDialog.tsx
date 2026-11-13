import { useMemo, useState } from "react";
import {
  CLOUD_PLAN_LABELS,
  formatCloudDate,
  formatCloudGb,
  type CloudPlanCleanup,
  type CloudPlanCleanupComputer,
  type CloudPlanCleanupPick,
} from "../../../../shared/adeCloud";
import { ipcErrorMessage } from "../../../lib/format";
import { Dialog, confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { SettingsToggle } from "../primitives/SettingsControls";

type Path = "ade" | "self";

/**
 * The question before a cheaper plan's limits are passed (the owner's rules
 * of 2026-11-13): ADE never removes a computer on its own. Two paths:
 * - "I'll clean up myself": nothing changes. A downgrade is not made; the
 *   person sees which computers deleting would be enough, deletes them, and
 *   comes back.
 * - "Let ADE handle it": the person picks the computers (the oldest that make
 *   it fit, to start) and whether their work is pushed to GitHub first (on).
 *   The pick must fit the plan before it can be sent; the server checks it
 *   again and frees exactly those, at once.
 *
 * `downgrade`: asked before Pro to Plus (`onPick` makes the move with the
 * pick). `resolve`: the account is already over a cheaper plan (one in force,
 * or a cancel made in the billing portal waiting), so `onPick` only frees.
 * Account level, so no pin: the server frees the computers wherever they are.
 */
export function CloudPlanLimitsDialog({
  cleanup,
  mode,
  currentPlanLabel,
  onClose,
  onPick,
}: {
  cleanup: CloudPlanCleanup;
  mode: "downgrade" | "resolve";
  /** The plan the account is on now ("Pro"), for "Stay on Pro". */
  currentPlanLabel: string;
  onClose: () => void;
  /** Sends the pick. Throws with the server's sentence when it refused. */
  onPick: (pick: CloudPlanCleanupPick) => Promise<void>;
}) {
  const plan = CLOUD_PLAN_LABELS[cleanup.planId];
  const choices = useMemo(() => (cleanup.choices?.length ? cleanup.choices : cleanup.computers), [cleanup]);
  const [path, setPath] = useState<Path>("ade");
  const [push, setPush] = useState(true);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(cleanup.computers.map((computer) => computer.instanceId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = choices.filter((computer) => picked.has(computer.instanceId));
  const freedGb = chosen.reduce((total, computer) => total + computer.diskGb, 0);
  const after = { computers: cleanup.computerCount - chosen.length, gb: Math.max(0, cleanup.usedGb - freedGb) };
  const now = path === "ade" ? after : { computers: cleanup.computerCount, gb: cleanup.usedGb };
  const computersFit = now.computers <= cleanup.computerLimit;
  const diskFits = now.gb <= cleanup.limitGb;
  const fits = after.computers <= cleanup.computerLimit && after.gb <= cleanup.limitGb;
  const count = chosen.length;
  const many = count === 1 ? "computer" : "computers";

  const toggle = (id: string) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const send = async () => {
    if (!push) {
      const ok = await confirmDialog({
        title: `Delete ${count} ${many} without pushing?`,
        message: "ADE deletes them as they are. Work that isn't on GitHub yet is lost. Their lanes and chats stay readable.",
        confirmLabel: `Delete ${count} ${many}`,
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await onPick({ push, instanceIds: chosen.map((computer) => computer.instanceId) });
      onClose();
    } catch (pickError) {
      setError(ipcErrorMessage(pickError) || "ADE Cloud couldn't do that. Nothing changed. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const verb = push ? "free" : "delete";
  const primary = path === "self"
    ? { label: mode === "downgrade" ? `Stay on ${currentPlanLabel}` : "Close", onClick: onClose, variant: "solid" as const, autoFocus: true }
    : {
        label: busy ? "Working…" : mode === "downgrade" ? `Move to ${plan} and ${verb} ${count}` : `${push ? "Free" : "Delete"} ${count} ${many}`,
        onClick: () => void send(),
        disabled: busy || !fits || count === 0,
        variant: "solid" as const,
      };
  // The move itself waits for the period end (Pro stays until then); the freeing doesn't.
  const moveLine = mode === "downgrade" && cleanup.startsAt != null ? ` You move to ${plan} on ${formatCloudDate(cleanup.startsAt)}.` : "";
  const startLine = mode === "resolve"
    ? cleanup.startsAt != null
      ? `You move to ${plan} on ${formatCloudDate(cleanup.startsAt)}. ADE deletes nothing on its own.`
      : "ADE can't make a new computer until they fit. It deletes nothing on its own."
    : null;

  return (
    <Dialog
      open
      size="md"
      tone="warning"
      icon
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      dismissible={!busy}
      title={`Your computers don't fit ${plan}`}
      description={startLine ? `${cleanup.sentence} ${startLine}` : cleanup.sentence}
      footerStart={path === "ade"
        ? (
          <span className="adecd-sheet-total" data-tone={fits ? undefined : "warn"}>
            {count === 0 ? `Pick computers to ${verb}` : fits ? `${count} ${many}, ${formatCloudGb(freedGb)}` : `Still over ${plan}: pick more computers`}
          </span>
        )
        : undefined}
      actions={[primary, { label: "Cancel", onClick: onClose, disabled: busy, variant: "secondary" }]}
    >
      <div className="adecd-limits">
        <div className="adecd-limits-fit" aria-live="polite">
          <FitCell label="Computers" fits={computersFit} value={String(now.computers)} limit={String(cleanup.computerLimit)} />
          <FitCell label="Disk" fits={diskFits} value={formatCloudGb(now.gb)} limit={formatCloudGb(cleanup.limitGb)} />
        </div>

        <div className="adecd-fl-choices" role="radiogroup" aria-label="How to fit the plan">
          <PathButton
            on={path === "ade"}
            onPick={() => setPath("ade")}
            title="Let ADE handle it"
            hint={`${push
              ? "ADE pushes the work of the computers you pick to GitHub, then frees them now."
              : "ADE deletes the computers you pick now, without pushing their work."}${moveLine}`}
          />
          <PathButton
            on={path === "self"}
            onPick={() => setPath("self")}
            title="I'll clean up myself"
            hint={mode === "downgrade"
              ? `You stay on ${currentPlanLabel}. Delete computers until they fit, then move to ${plan} again.`
              : "Delete computers until they fit. ADE frees nothing on its own."}
          />
        </div>

        {path === "ade" ? (
          <>
            <div className="kit-panel adecd-limits-push">
              <div>
                <b>Push all work to GitHub first</b>
                <small>{push
                  ? "Each lane's work goes to its branch before its computer goes. A computer whose work can't be pushed stays."
                  : "ADE deletes them as they are. Work that isn't on GitHub yet is lost."}</small>
              </div>
              <SettingsToggle checked={push} disabled={busy} label="Push all work to GitHub first" onChange={setPush} />
            </div>
            <div className="adecd-limits-list" role="group" aria-label={`Computers to ${verb}, oldest first`}>
              <div className="adecd-limits-list-head">Computers to {verb}, oldest first</div>
              {choices.map((computer) => (
                <ComputerRow key={computer.instanceId} computer={computer} checked={picked.has(computer.instanceId)} disabled={busy} onToggle={() => toggle(computer.instanceId)} />
              ))}
            </div>
            <p className="adecd-plan-fine">Their lanes and chats stay readable. The next message to a lane makes a new computer.</p>
          </>
        ) : (
          <div className="adecd-limits-list" aria-label="Computers to delete">
            <div className="adecd-limits-list-head">Deleting these, the oldest, would be enough</div>
            {cleanup.computers.map((computer) => (
              <div key={computer.instanceId} className="adecd-limits-row" data-static="true">
                <ComputerFacts computer={computer} />
              </div>
            ))}
            <p className="adecd-plan-fine">Delete them from Lanes and computers on this page. Push their work first if you want to keep it.</p>
          </div>
        )}

        {error ? <Banner layout="inline" model={{ id: "cloud-plan-limits-error", tone: "error", title: "Nothing changed", detail: error, report: false }} /> : null}
      </div>
    </Dialog>
  );
}

function FitCell({ label, fits, value, limit }: { label: string; fits: boolean; value: string; limit: string }) {
  return (
    <div className="adecd-limits-cell" data-fits={fits ? "true" : "false"}>
      <span className="kit-dot" data-state={fits ? "ok" : "warn"} aria-hidden="true" />
      <span>{label}</span>
      <b className="kit-num" data-face="ui">{value}</b>
      <small>of {limit}{fits ? "" : ", over"}</small>
    </div>
  );
}

function PathButton({ on, onPick, title, hint }: { on: boolean; onPick: () => void; title: string; hint: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className="adecd-choice" onClick={onPick}>
      <span className="adecd-radio" aria-hidden="true" />
      <span><b>{title}</b><small>{hint}</small></span>
    </button>
  );
}

function ComputerFacts({ computer }: { computer: CloudPlanCleanupComputer }) {
  const name = computer.laneName ?? computer.name ?? computer.instanceId;
  return (
    <>
      <span className="adecd-limits-name">
        <b>{name}</b>
        <small>{computer.branch ?? "No lane"}{computer.createdAt != null ? `, made ${formatCloudDate(computer.createdAt)}` : ""}</small>
      </span>
      <span className="kit-num">{formatCloudGb(computer.diskGb)}</span>
    </>
  );
}

function ComputerRow({ computer, checked, disabled, onToggle }: { computer: CloudPlanCleanupComputer; checked: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <label className="adecd-limits-row" data-checked={checked ? "true" : "false"}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <ComputerFacts computer={computer} />
    </label>
  );
}
