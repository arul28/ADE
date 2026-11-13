import { formatCloudDate, formatCloudGb, formatCloudHours } from "../../../../shared/adeCloud";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { READABLE_TOAST_DURATION_MS, showToast } from "../../app/toast/toastStore";
import { CloudLogo } from "../../remoteTargets/cloudBrand";
import { useCloudAccount } from "../../../state/cloudAccountStore";
import { useCloudPlanMoment, type CloudPlanMoment } from "./cloudPlanMoment";

/** The toast's id: the in-app "Move to Pro" answer and the moment replace each other in place. */
export const CLOUD_PLAN_MOMENT_TOAST_ID = "cloud-plan-moment";

/** "You're on Plus" and the one line under it, shared by the toast and the page's banner. */
export function cloudPlanMomentWords(moment: CloudPlanMoment): { title: string; detail: string } {
  const hours = formatCloudHours(moment.includedMilli);
  const replaced = moment.replacedFreeMilli != null
    ? ` Your ${formatCloudHours(moment.replacedFreeMilli)} unused free hours were replaced by ${moment.label}'s ${hours}.`
    : "";
  return {
    title: `You're on ${moment.label}`,
    detail: `${hours} hours and ${formatCloudGb(moment.diskGb)} of disk a month. Renews ${formatCloudDate(moment.renewsAt)}.${replaced}`,
  };
}

/** The three facts of the new plan, as the toast's body. */
export function CloudPlanMomentFacts({ moment }: { moment: CloudPlanMoment }) {
  return (
    <span className="adecd-moment-facts">
      <span><b className="kit-num" data-face="ui">{formatCloudHours(moment.includedMilli)}</b> hours</span>
      <span><b className="kit-num" data-face="ui">{formatCloudGb(moment.diskGb)}</b> disk</span>
      <span>Renews <b>{formatCloudDate(moment.renewsAt)}</b></span>
    </span>
  );
}

function captureMoment(): void {
  try {
    // A plan landed (bought, or moved up). Coarse: never the plan, price or account.
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "connections", action: "cloud_plan", outcome: "completed", source: "renderer_route" },
      projectId: null,
    }).catch(() => undefined);
  } catch {
    // Analytics never changes what the person sees.
  }
}

function showMoment(moment: CloudPlanMoment): void {
  const words = cloudPlanMomentWords(moment);
  showToast({
    id: CLOUD_PLAN_MOMENT_TOAST_ID,
    tone: "success",
    icon: <CloudLogo size={14} glow />,
    title: words.title,
    message: moment.replacedFreeMilli != null
      ? `Your ${formatCloudHours(moment.replacedFreeMilli)} unused free hours were replaced by ${moment.label}'s ${formatCloudHours(moment.includedMilli)}.`
      : "Thanks for backing ADE. Your agents have room to work.",
    content: <CloudPlanMomentFacts moment={moment} />,
    durationMs: READABLE_TOAST_DURATION_MS,
    actions: [{ label: "Open ADE Cloud", onClick: () => navigateToAppTarget({ kind: "settings", tab: "ade-cloud" }) }],
  });
  captureMoment();
}

/**
 * Mounted once, app-wide (the header's usage control, which already holds
 * the account): says "You're on Plus" when a plan lands. Renders nothing.
 */
export function CloudPlanMomentWatcher() {
  const account = useCloudAccount();
  useCloudPlanMoment(account, showMoment);
  return null;
}
