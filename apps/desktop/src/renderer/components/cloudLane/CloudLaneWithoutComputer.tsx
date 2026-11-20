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
import { refreshCloudLanesWithoutComputer } from "./cloudLaneStores";
import { CloudLaneSavedWork } from "./CloudLaneSavedWork";
import { keptLaneFateSentence } from "./cloudLanesWithoutComputer";
import "./cloudLane.css";

/**
 * A lane kept without a computer, in Settings › ADE Cloud: its computer was
 * freed to save space, removed by the idle cleanup after its work was saved
 * (or by the old 30-day rule), or freed to fit a cheaper plan. Work that
 * wasn't on GitHub shows under it (`CloudLaneSavedWork`), and a new computer
 * for the lane gets it back. It says what happened in the shared words
 * (`keptLaneFateSentence`) and offers one next step, "New computer on the
 * same branch": a new ADE Cloud launch for the same lane id on
 * `origin/<branch>`, the same launch a new lane uses, so its card shows the
 * same steps. "Forget lane" removes the record; the lane's chats stay
 * readable from the saved copy either way. In Work, Lanes and the chat the
 * same lane shows as a normal row with "Computer deleted"
 * (`CloudLaneComputerDeletedBanner`).
 */

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

/**
 * "New computer on the same branch" for a lane kept without one: the problem
 * that blocks it here, whether a start runs, and the start (a failure shows a toast).
 */
export function useStartLaneOnNewComputer(lane: CloudLaneWithoutComputer | null, account: CloudAccountState | null) {
  const [busy, setBusy] = useState(false);
  const binding = useAppStore((state) => state.projectBinding);
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const originUrl = originUrlForBinding(binding);
  const problem = lane ? cloudLaneRestartProblem(lane, binding, originUrl) : null;
  const sizeId = useMemo(() => (lane ? cloudLaneRestartTier(lane, account, defaultTier) : defaultTier), [account, defaultTier, lane]);
  const launch = async (): Promise<boolean> => {
    if (!lane || problem || !binding || !lane.branchRef) return false;
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
  const start = async (): Promise<void> => {
    if (!lane) return;
    setBusy(true);
    try {
      await launch();
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't start ${lane.laneName}`, message: ipcErrorMessage(error) || "Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };
  return { problem, busy, start, sizeId };
}

export function CloudLaneWithoutComputerNotice({
  lane,
  account,
  className,
}: {
  lane: CloudLaneWithoutComputer;
  account: CloudAccountState | null;
  className?: string;
}) {
  const { problem, busy: starting, start } = useStartLaneOnNewComputer(lane, account);
  const [forgetting, setForgetting] = useState(false);
  const busy = starting || forgetting;
  const problemId = `adecl-nocomp-why-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  const onForget = async () => {
    const ok = await confirmDialog({
      title: `Forget ${lane.laneName}?`,
      message: "ADE stops listing this lane and deletes its saved work that isn't on GitHub. Download that work first if you need it. Its branch on GitHub and its chats stay.",
      confirmLabel: "Forget lane",
    });
    if (!ok) return;
    setForgetting(true);
    try {
      await forgetCloudLaneWithoutComputer(lane.laneId);
      refreshCloudLanesWithoutComputer();
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't forget ${lane.laneName}`, message: ipcErrorMessage(error) || "Try again in a moment." });
    } finally {
      setForgetting(false);
    }
  };

  return (
    <div className={cn("adecl-nocomp", className)} data-cloud-lane-without-computer={lane.laneId}>
      <span className="adecl-nocomp-mark" aria-hidden><CloudMark size={14} brand /></span>
      <div className="adecl-nocomp-text">
        <span>{keptLaneFateSentence(lane)}</span>
        {problem ? <span id={problemId} role="status" className="adecl-muted">{problem}</span> : null}
        <CloudLaneSavedWork laneId={lane.laneId} laneName={lane.laneName} />
      </div>
      <div className="adecl-nocomp-actions">
        <button type="button" className="kit-btn adecl-btn-sky" data-size="xs" disabled={Boolean(problem) || busy} aria-describedby={problem ? problemId : undefined} onClick={() => void start()}>
          <Plus size={11} />
          {starting ? "Starting…" : "New computer on the same branch"}
        </button>
        {cloudLaneLifeAvailable() ? (
          <button type="button" className="kit-btn kit-btn-ghost" data-size="xs" disabled={busy} onClick={() => void onForget()} aria-label={`Forget ${lane.laneName}`}>
            <X size={11} />
            Forget
          </button>
        ) : null}
      </div>
    </div>
  );
}
