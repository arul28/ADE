import { useMemo, useState } from "react";
import { Check, Question, X } from "@phosphor-icons/react";
import type { CloudAccountState } from "../../../../shared/adeCloud";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { CloudMark, CloudSizeIcon } from "../../remoteTargets/cloudBrand";
import { Dialog, confirmDialog } from "../../ui/dialog";
import { cleanupOrder, formatGb, lastRunText, type DashLane } from "./cloudDashboardModel";
import { CLOUD_LANE_LIFE_UNAVAILABLE, cloudLaneLifeAvailable, cloudLaneWorkState, deleteCloudLane, freeCloudLane } from "../../cloudLane/cloudLaneActions";
import { refreshCloudLanesWithoutComputer } from "../../cloudLane/cloudLaneStores";

type Choice = "keep" | "free" | "delete";

/**
 * "Free up space": the cloud lanes biggest first, then the longest unused,
 * each with what its computer last said about its work (Safe to delete:
 * pull request merged, nothing unpushed). The person picks per lane; ADE
 * deletes nothing they did not pick, and asks again before a delete that
 * isn't marked safe.
 */
export function CloudFreeUpSpace({
  account,
  lanes,
  now,
  onClose,
  onDone,
}: {
  account: CloudAccountState;
  lanes: readonly DashLane[];
  now: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const ordered = useMemo(() => cleanupOrder(lanes), [lanes]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const canAct = cloudLaneLifeAvailable();
  const picked = ordered.filter((lane) => (choices[lane.key] ?? "keep") !== "keep");
  const freedGb = picked.reduce((total, lane) => total + lane.diskGb, 0);

  const apply = async () => {
    setBusy(true);
    // Each lane to delete is checked on its computer first: a delete warns only when work isn't on GitHub.
    const deletes = picked.filter((lane) => choices[lane.key] === "delete" && lane.instanceId);
    const checks = await Promise.all(deletes.map(async (lane) => {
      const state = await cloudLaneWorkState(lane.instanceId!).catch(() => null);
      return { lane, unpushed: state?.unpushed ?? null };
    }));
    const risky = checks.filter((check) => check.unpushed !== false).map((check) => check.lane);
    if (risky.length) {
      setBusy(false);
      const ok = await confirmDialog({
        title: risky.length === 1 ? `${risky[0]!.name} has work that isn't on GitHub` : `${risky.length} lanes have work that isn't on GitHub`,
        message: `${risky.map((lane) => lane.name).join(", ")}: ADE found unpushed work, or couldn't check. Deleting loses it. To keep the work, pick "Keep the lane on a fresh computer" instead: ADE pushes it first. Their chats stay readable.`,
        confirmLabel: "Delete anyway",
        destructive: true,
      });
      if (!ok) return;
      setBusy(true);
    }
    const failed: string[] = [];
    for (const lane of picked) {
      if (!lane.instanceId) continue;
      try {
        const done = choices[lane.key] === "delete"
          ? await deleteCloudLane(lane.instanceId, { skipCheck: true })
          : await freeCloudLane(lane.instanceId);
        if (!done.ok) failed.push(`${lane.name}: ${done.message}`);
      } catch (error) {
        failed.push(`${lane.name}: ${ipcErrorMessage(error) || "no answer"}`);
      }
    }
    setBusy(false);
    onDone();
    refreshCloudLanesWithoutComputer();
    if (failed.length) {
      showToast({ tone: "error", title: "Some lanes kept their computer", message: failed.join(" ") });
      return;
    }
    showToast({ tone: "success", title: `Freed ${formatGb(freedGb)}`, message: "The dashboard shows the new disk." });
    onClose();
  };

  return (
    <Dialog
      open
      placement="right"
      width={440}
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      dismissible={!busy}
      title="Free up space"
      description={`${formatGb(account.disk.usedGb)} of ${formatGb(account.disk.limitGb ?? 0)} used. Biggest lanes first.`}
      footerStart={<span className="adecd-sheet-total">{picked.length ? `Frees ${formatGb(freedGb)}` : "Pick what to free"}</span>}
      actions={[
        { label: busy ? "Working…" : "Free up space", onClick: () => void apply(), disabled: busy || !picked.length || !canAct, variant: "solid" },
        { label: "Cancel", onClick: onClose, disabled: busy },
      ]}
    >
      {!canAct ? <p className="adecd-error">{CLOUD_LANE_LIFE_UNAVAILABLE}</p> : null}
      <div className="adecd-free">
        {ordered.map((lane) => {
          const choice = choices[lane.key] ?? "keep";
          const set = (next: Choice) => setChoices((current) => ({ ...current, [lane.key]: next }));
          return (
            <div key={lane.key} className="adecd-fl" data-safe={lane.safe ? "1" : "0"}>
              <div className="adecd-fl-top">
                {lane.tier ? <CloudSizeIcon tier={lane.tier.id} size={16} /> : <CloudMark size={16} brand />}
                <b>{lane.name}</b>
                <span className="kit-num">{formatGb(lane.diskGb)}</span>
                <span className="adecd-grow" />
                {lane.safe ? <span className="kit-tag" data-tone="ok">Safe to delete</span> : null}
                {lane.old ? <span className="adecd-old">Not used for a long time</span> : null}
              </div>
              <div className="adecd-fl-meta">{lastRunText(lane, now)}</div>
              <div className="adecd-fl-safe">
                {lane.work ? (
                  <>
                    <Mark state={lane.work.prState === "merged"} yes="Pull request merged" no={lane.work.prState ? `Pull request ${lane.work.prState}` : "No pull request"} />
                    <Mark state={!lane.work.unpushed} yes="Nothing unpushed" no="Has unpushed work" />
                  </>
                ) : (
                  <Mark state={null} yes="" no="" />
                )}
              </div>
              <div className="adecd-fl-choices" role="radiogroup" aria-label={`What to do with ${lane.name}`}>
                <ChoiceButton on={choice === "keep"} onPick={() => set("keep")} title="Keep it" hint="Nothing changes." />
                <ChoiceButton on={choice === "free"} onPick={() => set("free")} title="Keep the lane, free its computer" hint="ADE pushes the work, then removes the computer. The next message makes a fresh one." />
                <ChoiceButton on={choice === "delete"} onPick={() => set("delete")} title="Delete the lane" hint="The lane and its computer go. Its chats stay readable." tone="crit" />
              </div>
            </div>
          );
        })}
        {!ordered.length ? <p className="adecd-empty">No cloud lanes hold disk now.</p> : null}
      </div>
    </Dialog>
  );
}

function Mark({ state, yes, no }: { state: boolean | null; yes: string; no: string }) {
  if (state == null) return <span className="adecd-mark" data-state="unknown"><Question size={11} />Work not checked yet: the computer reports it the next time it goes idle</span>;
  return state
    ? <span className="adecd-mark" data-state="yes"><Check size={11} weight="bold" />{yes}</span>
    : <span className="adecd-mark" data-state="no"><X size={11} weight="bold" />{no}</span>;
}

function ChoiceButton({ on, onPick, title, hint, tone }: { on: boolean; onPick: () => void; title: string; hint: string; tone?: "crit" }) {
  return (
    <button type="button" role="radio" aria-checked={on} className="adecd-choice" data-tone={tone} onClick={onPick}>
      <span className="adecd-radio" aria-hidden="true" />
      <span><b>{title}</b><small>{hint}</small></span>
    </button>
  );
}
