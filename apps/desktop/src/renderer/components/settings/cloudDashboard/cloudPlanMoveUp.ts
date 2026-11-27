import {
  CLOUD_PLAN_LABELS,
  formatCloudHours,
  type CloudOpenCheckoutResult,
  type CloudPaidPlanId,
} from "../../../../shared/adeCloud";
import { showToast } from "../../app/toast/toastStore";
import { confirmDialog } from "../../ui/dialog";
import { CLOUD_PLAN_MOMENT_TOAST_ID } from "./cloudPlanMoment";
import { BRAND } from "../../../../shared/brand";

/**
 * A move to a bigger plan, as the Plans card and the computer limit card both
 * make it. Account level, so no pin: the checkout is the account's.
 */
export type CloudPlanMoveUp = {
  planId: CloudPaidPlanId;
  priceUsd: number;
  computerLimit: number;
  /** The plan's hours for bigger computers, when the caller has the plan's facts. */
  includedMilli?: number;
};

/** The question before a paid plan moves up: it charges the difference now. */
export async function confirmCloudPlanMoveUp(plan: CloudPlanMoveUp): Promise<boolean> {
  const label = CLOUD_PLAN_LABELS[plan.planId];
  const hours = plan.includedMilli != null ? ` and ${formatCloudHours(plan.includedMilli)} credits a month` : "";
  return await confirmDialog({
    title: `Move to ${label}?`,
    message: `${label} is $${plan.priceUsd} a month with ${plan.computerLimit} cloud computers${hours}. You pay the difference for the rest of this month now. Credits you used stay used.`,
    confirmLabel: `Move to ${label}`,
  });
}

/**
 * Opens the checkout for a bigger plan and says what happened: "You're on Pro
 * now." under the plan moment's toast id (whichever lands second replaces the
 * first), or that it finishes in the browser. Throws what the checkout throws;
 * answers its result for anything else the caller says.
 */
export async function checkoutCloudPlanUp(plan: Pick<CloudPlanMoveUp, "planId" | "computerLimit">): Promise<CloudOpenCheckoutResult | null> {
  const open = window.ade?.cloud?.openCheckout;
  if (!open) throw new Error(`Open Settings › ${BRAND.CLOUD_NAME} › Plans in the ${BRAND.NAME} desktop app.`);
  const label = CLOUD_PLAN_LABELS[plan.planId];
  const result = (await open(plan.planId)) ?? null;
  const computers = `you can have ${plan.computerLimit} cloud computers.`;
  if (result?.change === "now") {
    showToast({ id: CLOUD_PLAN_MOMENT_TOAST_ID, tone: "success", title: `You're on ${label} now.`, message: `${computers.charAt(0).toUpperCase()}${computers.slice(1)}` });
  } else if (result?.opened && !result.change) {
    showToast({ title: `Finish ${label} in your browser`, message: `Once it's done, ${computers}` });
  }
  return result;
}
