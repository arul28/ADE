import { useId, useMemo, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { cloudCatalogOf, type CloudAccountState } from "../../../shared/adeCloud";
import type { CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import { cloudTiers, type CloudTierId } from "../../../shared/cloudTiers";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { ipcErrorMessage } from "../../lib/format";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { startAdeCloudLaunch } from "../chat/launch/adeCloudLaunch";
import { originUrlForBinding } from "../lanes/laneMachines";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { confirmDialog } from "../ui/dialog";
import { cn } from "../ui/cn";
import { CLOUD_LANE_LIFE_UNAVAILABLE, cloudLaneLifeAvailable, forgetCloudLaneWithoutComputer } from "./cloudLaneActions";
import { refreshCloudLanesWithoutComputer, useCloudLanesWithoutComputer } from "./cloudLaneStores";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import "./cloudLane.css";

/**
 * A lane kept without a computer: its computer was freed to save space, or
 * removed after 30 days unused. It says so in plain words and offers one
 * next step, "New computer on the same branch": a new ADE Cloud launch for
 * the same lane id on `origin/<branch>`, the same launch a new lane uses, so
 * its card shows the same steps. "Forget lane" removes the record; the
 * lane's chats stay readable from the saved copy either way.
 */

function cloudLaneWithoutComputerSentence(lane: CloudLaneWithoutComputer): string {
  const since = Number.isFinite(lane.since) ? new Date(lane.since).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  const when = since ? ` on ${since}` : "";
  if (lane.reason === "freed") return `${lane.laneName} has no computer now. You freed it${when} to save space; its work is on GitHub.`;
  if (lane.reason === "plan_limit") {
    return `${lane.laneName} has no computer now. ADE Cloud removed it${when} to fit your plan, after pushing its work to GitHub. A new computer starts from the branch on GitHub.`;
  }
  return `${lane.laneName} has no computer now. ADE Cloud removed it${when} after 30 days without use. Work you pushed to GitHub is safe, and a new computer starts from the branch on GitHub.`;
}

/** The size the old computer had, as a tier of today's catalog; the saved default when none matches. */
export function cloudLaneRestartTier(lane: CloudLaneWithoutComputer, account: CloudAccountState | null, fallback: CloudTierId): CloudTierId {
  const tiers = cloudTiers(cloudCatalogOf(account));
  return tiers.find((tier) => tier.type === lane.type && tier.cpu === lane.cpu && tier.memoryGb === lane.memoryGb)?.id ?? fallback;
}

/** The lane's branch on GitHub, as a new computer starts from it. */
export function cloudLaneRestartBranchRef(branchRef: string): string {
  return `origin/${branchRef.replace(/^origin\//, "")}`;
}

/** Why a new computer for this lane (its card's button, or a send in its chat) can't start from this window, or null. */
export function cloudLaneRestartProblem(lane: CloudLaneWithoutComputer, binding: OpenProjectBinding | null, originUrl: string | null): string | null {
  if (!cloudLaneLifeAvailable()) return CLOUD_LANE_LIFE_UNAVAILABLE;
  if (!lane.branchRef) return "ADE never learned this lane's branch. Start a new lane on ADE Cloud instead.";
  if (!binding) return "Open the lane's project in ADE to start it.";
  const here = normalizeGitRemoteIdentity(originUrl);
  if (lane.projectOrigin && here !== lane.projectOrigin) return `Open ${lane.projectOrigin} in ADE to start it there.`;
  return null;
}

function useStartLaneOnNewComputer(lane: CloudLaneWithoutComputer, account: CloudAccountState | null) {
  const binding = useAppStore((state) => state.projectBinding);
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const originUrl = originUrlForBinding(binding);
  const problem = cloudLaneRestartProblem(lane, binding, originUrl);
  const sizeId = useMemo(() => cloudLaneRestartTier(lane, account, defaultTier), [account, defaultTier, lane]);
  const start = async (): Promise<boolean> => {
    if (problem || !binding || !lane.branchRef) return false;
    const outcome = await startAdeCloudLaunch({
      args: {
        kind: "lane",
        mode: "background",
        launchId: crypto.randomUUID(),
        laneId: lane.laneId,
        laneName: lane.laneName,
        title: lane.laneName,
        prompt: "",
        laneConfig: { mode: "existing", branchRef: cloudLaneRestartBranchRef(lane.branchRef) },
      },
      sizeId,
      originUrl,
      binding,
    });
    // A failed start shows on its own launch card (Launches), with Retry.
    if (outcome === "unsupported") {
      showToast({ tone: "error", title: `Couldn't start ${lane.laneName}`, message: "This ADE can't start ADE Cloud lanes. Update ADE, then try again." });
      return false;
    }
    if (outcome === "failed") return false;
    showToast({ tone: "success", title: `Making a new computer for ${lane.laneName}`, message: "It starts on the same branch. Its steps show under Launches." });
    return true;
  };
  return { problem, start, sizeId };
}

export function CloudLaneWithoutComputerNotice({
  lane,
  account,
  variant = "strip",
  className,
}: {
  lane: CloudLaneWithoutComputer;
  account: CloudAccountState | null;
  /** `strip`: above a chat's prompt box. `row`: one row in a list of lanes. */
  variant?: "strip" | "row";
  className?: string;
}) {
  const { problem, start } = useStartLaneOnNewComputer(lane, account);
  const [busy, setBusy] = useState<"start" | "forget" | null>(null);
  const problemId = `adecl-nocomp-why-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  const onStart = async () => {
    setBusy("start");
    try {
      await start();
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't start ${lane.laneName}`, message: ipcErrorMessage(error) || "Try again in a moment." });
    } finally {
      setBusy(null);
    }
  };

  const onForget = async () => {
    const ok = await confirmDialog({
      title: `Forget ${lane.laneName}?`,
      message: "ADE stops listing this lane. Its branch stays on GitHub and its chats stay readable.",
      confirmLabel: "Forget lane",
    });
    if (!ok) return;
    setBusy("forget");
    try {
      await forgetCloudLaneWithoutComputer(lane.laneId);
      refreshCloudLanesWithoutComputer();
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't forget ${lane.laneName}`, message: ipcErrorMessage(error) || "Try again in a moment." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn("adecl-nocomp", className)} data-variant={variant} data-cloud-lane-without-computer={lane.laneId} role={variant === "strip" ? "status" : undefined}>
      <span className="adecl-nocomp-mark" aria-hidden><CloudMark size={14} brand /></span>
      <div className="adecl-nocomp-text">
        <span>{cloudLaneWithoutComputerSentence(lane)}</span>
        {problem ? <span id={problemId} className="adecl-muted">{problem}</span> : null}
      </div>
      <div className="adecl-nocomp-actions">
        <button type="button" className="kit-btn adecl-btn-sky" data-size="xs" disabled={Boolean(problem) || busy != null} aria-describedby={problem ? problemId : undefined} onClick={() => void onStart()}>
          <Plus size={11} />
          {busy === "start" ? "Starting…" : "New computer on the same branch"}
        </button>
        {cloudLaneLifeAvailable() ? (
          <button type="button" className="kit-btn kit-btn-ghost" data-size="xs" disabled={busy != null} onClick={() => void onForget()} aria-label={`Forget ${lane.laneName}`}>
            <X size={11} />
            Forget
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The project's ADE Cloud lanes that have no computer now, for a list of
 * lanes (the Lanes tab): one row each with its next step. Nothing when there
 * are none, when ADE Cloud is off, or where this ADE can't ask.
 */
export function CloudLanesWithoutComputerList({ originUrl, className }: { originUrl: string | null; className?: string }) {
  const enabled = useAdeCloudEnabled() && cloudLaneLifeAvailable();
  const { lanes } = useCloudLanesWithoutComputer(enabled);
  const identity = normalizeGitRemoteIdentity(originUrl);
  const mine = useMemo(
    () => (identity ? lanes.filter((lane) => lane.projectOrigin === identity) : []),
    [identity, lanes],
  );
  if (!enabled || !mine.length) return null;
  return (
    <div className={cn("adecl-nocomp-list", className)} aria-label="ADE Cloud lanes without a computer">
      <div className="adecl-nocomp-list-head">
        <CloudMark size={11} brand />
        <span>{mine.length === 1 ? "1 ADE Cloud lane has no computer now" : `${mine.length} ADE Cloud lanes have no computer now`}</span>
      </div>
      {mine.map((lane) => <CloudLaneWithoutComputerNotice key={lane.laneId} lane={lane} account={null} variant="row" />)}
    </div>
  );
}
