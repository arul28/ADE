import { useEffect, useState } from "react";
import type { CloudGitSummaryCounts } from "../../../../../account-directory/src/cloud/contract";
import type { OpenProjectBinding } from "../../../shared/types";
import { captureError } from "../../../shared/sentry/capture";
import { savedChatsMachineKey } from "../../../shared/cloudSavedChats";
import { useAppStore } from "../../state/appStore";

/**
 * "As of <time>" for the Git panel of a lane whose ADE Cloud computer is at
 * rest: the account answers its Git reads from the summary the computer saved
 * (`checkedAt`), so the panel says how old that is. One read of the project
 * overview when the panel opens; nothing
 * when the computer is awake (the pin is then not an account pin).
 */
export function CloudGitAsOf({ pin, laneId }: { pin: OpenProjectBinding; laneId: string | null }): JSX.Element | null {
  const tabOrigin = useAppStore((state) => state.projectBinding?.gitOriginUrl ?? null);
  const origin = (pin.kind === "remote" ? pin.gitOriginUrl : null) ?? tabOrigin;
  const machineKey = pin.kind === "remote" ? savedChatsMachineKey(pin.targetId) : null;
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  useEffect(() => {
    setCheckedAt(null);
    const read = window.ade?.adeCloud?.projectOverview;
    if (!read || !origin || !laneId) return undefined;
    let cancelled = false;
    read({ origin }).then(
      (overview) => {
        if (cancelled || !overview) return;
        const match = (overview.git as CloudGitSummaryCounts[]).find(
          (summary) => summary.laneId === laneId && (!machineKey || summary.machineKey === machineKey),
        );
        setCheckedAt(match?.checkedAt ?? null);
      },
      // The panel's own reads say when the summary can't load; this line just stays away.
      (error: unknown) => {
        captureError(error, { level: "warning", handled: true, fingerprint: ["ade-cloud", "git-as-of-overview"] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [laneId, machineKey, origin]);
  if (checkedAt == null || !Number.isFinite(checkedAt)) return null;
  const at = new Date(checkedAt);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const label = at.toDateString() === new Date().toDateString()
    ? `As of ${time}`
    : `As of ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
  return (
    <div
      className="shrink-0 border-b border-border/30 px-3 py-1.5 text-[11px] text-muted-fg/75"
      data-testid="cloud-git-as-of"
      title="Its computer is at rest. This is what it saved; it doesn't wake to read Git."
    >
      {label}, saved by its computer at rest.
    </div>
  );
}
