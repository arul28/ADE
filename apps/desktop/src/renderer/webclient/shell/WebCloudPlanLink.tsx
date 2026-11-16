import { useEffect, useRef } from "react";
import { CLOUD_FREE_GITHUB_MIN_AGE_DAYS, type CloudBillingReturnOutcome } from "../../../../../account-directory/src/cloud/contract";
import { CLOUD_PLAN_LABELS, cloudCatalogOf, cloudPlanLabelOf, isPaidPlanId } from "../../../shared/adeCloud";
import { ipcErrorMessage } from "../../lib/format";
import { READABLE_TOAST_DURATION_MS, showToast, type ToastInput } from "../../components/app/toast/toastStore";
import type { BrowserAccountClient } from "../account/client";
import { createWebCloudBilling, type WebCloudBilling } from "../adapter/cloudBilling";
import { takeCloudLink, type WebCloudLink } from "./cloudPlanLink";

/** What the web app says when Stripe sends the person back (the account server's own page says the same). */
const RETURN_TOASTS: Record<CloudBillingReturnOutcome, ToastInput> = {
  done: { tone: "success", title: "You're all set", message: "Your plan shows here in a moment." },
  cancelled: { title: "Nothing changed", message: "You left checkout before paying." },
  portal: { title: "Back from billing", message: "Any changes you made show here in a moment." },
  card: { tone: "success", title: "Card saved", message: "You weren't charged. Your free hours show here in a moment." },
  card_cancelled: { title: "Nothing changed", message: `You left before saving a card. Your free hours start when your GitHub account is ${CLOUD_FREE_GITHUB_MIN_AGE_DAYS} days old.` },
};

/**
 * A plan link from ADE's website, or a return from Stripe, kept through the
 * sign-in (`cloudPlanLink.ts`). The shell already opened Settings › ADE Cloud
 * for it; this finishes it once, as the app mounts.
 *
 * A paid plan starts its checkout only when the account server says ADE Cloud
 * lets this account in and the account has no paid plan yet: a paid account
 * would otherwise change its plan with no question, so it only sees the page.
 * Both reads go to the account server itself, so a person with no computer
 * online can still buy. Never starts a sign-in: a refusal is said, not retried.
 */
export function WebCloudPlanLink({ accountClient }: { accountClient: BrowserAccountClient }) {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const link = takeCloudLink();
    if (link) void finishCloudLink(link, createWebCloudBilling(accountClient), accountClient);
  }, [accountClient]);
  return null;
}

async function finishCloudLink(link: WebCloudLink, billing: WebCloudBilling, accountClient: BrowserAccountClient): Promise<void> {
  if (link.kind === "return") {
    showToast(RETURN_TOASTS[link.outcome]);
    return;
  }
  // Free, or only the page: Settings › ADE Cloud is all it asks for.
  if (link.kind === "page" || !isPaidPlanId(link.plan)) return;
  const plan = link.plan;
  const label = CLOUD_PLAN_LABELS[plan];
  // The checkout is for the account that arrived with the link: a sign-out or switch meanwhile stops it.
  const lease = accountClient.captureSessionLease();
  try {
    if (!(await billing.accessEnabled())) {
      showToast({ title: "ADE Cloud isn't open to your account yet", message: `ADE didn't start checkout for ${label}.`, durationMs: READABLE_TOAST_DURATION_MS });
      return;
    }
    const account = await billing.readAccount();
    if (account.plan === "paid") {
      showToast({ title: `You're on ${cloudPlanLabelOf(account, cloudCatalogOf(account))} already`, message: "Change your plan under Plans on this page." });
      return;
    }
    if (!lease || !accountClient.isSessionLeaseCurrent(lease)) return;
    showToast({ title: `Opening checkout for ${label}…` });
    await billing.openCheckout(plan, undefined, { afterSignIn: false });
  } catch (error) {
    showToast({
      tone: "error",
      title: `Couldn't open checkout for ${label}`,
      message: ipcErrorMessage(error) || "Try again from Plans on this page.",
      durationMs: READABLE_TOAST_DURATION_MS,
    });
  }
}
