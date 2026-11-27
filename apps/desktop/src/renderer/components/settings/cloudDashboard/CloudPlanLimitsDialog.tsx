import { useMemo, useState } from "react";
import {
  CLOUD_PLAN_LABELS,
  formatCloudDate,
  type CloudPlanCleanup,
  type CloudPlanCleanupComputer,
  type CloudPlanCleanupPick,
} from "../../../../shared/adeCloud";
import { ipcErrorMessage } from "../../../lib/format";
import { Dialog, confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { SettingsToggle } from "../primitives/SettingsControls";
import { BRAND } from "../../../../shared/brand";

type Path = "ade" | "self";

/** What ADE does now with a pick that was sent: one sentence for the toast. */
export function planCleanupPickSentence(push: boolean, count: number): string {
  const computers = count === 1 ? "1 computer" : `${count} computers`;
  return push ? `${BRAND.NAME} is checking that the work of ${computers} is saved, then freeing ${count === 1 ? "it" : "them"}.` : `${BRAND.NAME} is deleting ${computers} now.`;
}

/**
 * The question before a cheaper plan's computer limit is passed (the owner's
 * rules of 2026-11-13, Pricing v2): ADE never removes a computer on its own.
 * Only the number of computers counts, asleep or not. Two paths:
 * - "I'll clean up myself": nothing changes. A downgrade is not made; the
 *   person sees which computers deleting would be enough, deletes them, and
 *   comes back.
 * - "Let ADE handle it": the person picks the computers (the oldest that make
 *   it fit, to start) and whether each lane's work must be saved first (on;
 *   a lane backup, nothing pushed, no wake).
 *   The pick must fit the plan before it can be sent; the server checks it
 *   again and frees exactly those, at once.
 *
 * `downgrade`: asked before a move to a cheaper paid plan (`onPick` makes the
 * move with the pick). `resolve`: the account is already over a cheaper plan (one in force,
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
  const count = chosen.length;
  // Only the number of computers counts. The server sends both; an answer without them reads as the suggested pick fitting.
  const total = cleanup.computerCount ?? choices.length;
  const limit = cleanup.computerLimit ?? Math.max(0, total - cleanup.computers.length);
  const after = Math.max(0, total - count);
  const shown = path === "ade" ? after : total;
  const fits = after <= limit;
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
        title: `Delete ${count} ${many} without the check?`,
        message: `${BRAND.NAME} deletes them as they are, without checking that each lane's work is saved. Work since a computer last rested can be lost. Their lanes and chats stay readable.`,
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
      setError(ipcErrorMessage(pickError) || `${BRAND.CLOUD_NAME} couldn't do that. Nothing changed. Try again in a moment.`);
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
  // The move itself waits for the period end (the plan now stays until then); the freeing doesn't.
  const moveLine = mode === "downgrade" && cleanup.startsAt != null ? ` You move to ${plan} on ${formatCloudDate(cleanup.startsAt)}.` : "";
  const startLine = mode === "resolve"
    ? cleanup.startsAt != null
      ? `You move to ${plan} on ${formatCloudDate(cleanup.startsAt)}. ${BRAND.NAME} deletes nothing on its own.`
      : `${BRAND.NAME} can't make a new computer until you have fewer. It deletes nothing on its own.`
    : null;

  return (
    <Dialog
      open
      size="md"
      tone="warning"
      icon
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      dismissible={!busy}
      title={`You have more cloud computers than ${plan} allows`}
      description={startLine ? `${cleanup.sentence} ${startLine}` : cleanup.sentence}
      footerStart={path === "ade"
        ? (
          <span className="adecd-sheet-total" data-tone={fits ? undefined : "warn"}>
            {count === 0 ? `Pick computers to ${verb}` : fits ? `${count} ${many} to ${verb}` : `Still over ${plan}: pick more computers`}
          </span>
        )
        : undefined}
      actions={[primary, { label: "Cancel", onClick: onClose, disabled: busy, variant: "secondary" }]}
    >
      <div className="adecd-limits">
        <div aria-live="polite">
          <div className="adecd-limits-list-head">{path === "ade" ? `Left after ${BRAND.NAME} frees the ${count === 1 ? "computer" : "computers"} you pick` : "Now"}</div>
          <div className="adecd-limits-fit">
            <FitCell label="Cloud computers" fits={shown <= limit} value={String(shown)} limit={String(limit)} />
          </div>
        </div>

        <div className="adecd-fl-choices" role="radiogroup" aria-label="How to fit the plan">
          <PathButton
            on={path === "ade"}
            onPick={() => setPath("ade")}
            title={`Let ${BRAND.NAME} handle it`}
            hint={`${push
              ? `${BRAND.NAME} frees the computers you pick now, once each lane's work is saved. Nothing is pushed to GitHub.`
              : `${BRAND.NAME} deletes the computers you pick now, without checking that their work is saved.`}${moveLine}`}
          />
          <PathButton
            on={path === "self"}
            onPick={() => setPath("self")}
            title="I'll clean up myself"
            hint={mode === "downgrade"
              ? `You stay on ${currentPlanLabel}. Free up or delete computers until you have ${limit} or fewer, then move to ${plan} again.`
              : `Free up or delete computers until you have few enough. ${BRAND.NAME} frees nothing on its own.`}
          />
        </div>

        {path === "ade" ? (
          <>
            <div className="kit-panel adecd-limits-push">
              <div>
                <b>Save each lane's work first</b>
                <small>{push
                  ? `A computer goes only when its lanes' work that isn't on GitHub is saved in ${BRAND.CLOUD_NAME}. ${BRAND.NAME} never wakes it for that and pushes nothing. A computer whose work isn't saved stays.`
                  : `${BRAND.NAME} deletes them as they are. Work since a computer last rested can be lost.`}</small>
              </div>
              <SettingsToggle checked={push} disabled={busy} label="Save each lane's work first" onChange={setPush} />
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
            <p className="adecd-plan-fine">Delete them from Lanes and computers on this page. Before a delete, {BRAND.NAME} shows the lane's work that isn't on GitHub and offers to push it.</p>
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
  const name = computer.laneName ?? computer.name ?? "Computer without a lane";
  return (
    <>
      <span className="adecd-limits-name">
        <b>{name}</b>
        <small>{computer.branch ?? "No lane"}{computer.createdAt != null ? `, made ${formatCloudDate(computer.createdAt)}` : ""}</small>
      </span>
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
