import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CreditCard, GithubLogo } from "@phosphor-icons/react";
import {
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
  cloudFreeGithubSentence,
  cloudFreePlanOf,
  formatCloudFreeGithubDay,
  type CloudAccountState,
  type CloudFreeModelsLock,
  type CloudFreePlanGithub,
} from "../../../../shared/adeCloud";
import { settingsRouteFor } from "../../../../shared/settingsManifest";
import { ipcErrorMessage } from "../../../lib/format";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { refreshCloudAccount } from "../../../state/cloudAccountStore";
import { showToast } from "../../app/toast/toastStore";
import { Banner, type NoticeAction } from "../../ui/notice";
import { BRAND } from "../../../../shared/brand";

const GITHUB_SETTINGS_ROUTE = settingsRouteFor("integrations.github");

/** The hero's one short line while the GitHub rules hold the free hours; the plan card's notice says why and what to do. */
export function cloudFreeGithubHeroLine(github: CloudFreePlanGithub): string | null {
  switch (github.state) {
    case "no_github":
      return "Free credits wait for GitHub.";
    case "too_new":
      return github.oldEnoughAt != null
        ? `Free credits start ${formatCloudFreeGithubDay(github.oldEnoughAt)}.`
        : `Free credits start when your GitHub account is ${CLOUD_FREE_GITHUB_MIN_AGE_DAYS} days old.`;
    case "used":
      return "No free credits on this account yet.";
    case "checking":
      return "Checking your GitHub account for free credits.";
    default:
      return null;
  }
}

/**
 * One GitHub hold, whatever it holds: the free plan's credits
 * (`CloudFreePlanGithub`) or ADE Free Models (`CloudFreeModelsLock`). Both
 * come from the same rule on the account server (`freePlanGithub.ts`).
 */
export type CloudFreeGithubHoldFacts = {
  reason: "no_github" | "too_new" | "used" | "checking";
  oldEnoughAt: number | null;
  githubLogin: string | null;
  /** The server says a card saved with no charge lifts this hold now. */
  canUnlockWithCard: boolean;
  /** The server's sentence; null from an older server (the shared wording fills in). */
  sentence: string | null;
};

/** What the hold keeps: the free plan's credits (Settings, ADE Cloud) or ADE Free Models (the model picker). */
export type CloudFreeGithubHoldPurpose = "credits" | "free-models";

/** The free plan's GitHub hold on its credits, or null when nothing is held (or the account isn't on the free rules). */
export function freePlanGithubHold(account: CloudAccountState | null | undefined): CloudFreeGithubHoldFacts | null {
  if (!account || account.rules !== "free") return null;
  const github = cloudFreePlanOf(account).github;
  if (!github || github.state === "ok") return null;
  return {
    reason: github.state,
    oldEnoughAt: github.oldEnoughAt,
    githubLogin: github.githubLogin,
    canUnlockWithCard: github.canUnlockWithCard,
    sentence: github.sentence,
  };
}

/** ADE Free Models' lock as a hold. */
export function freeModelsLockHold(lock: CloudFreeModelsLock): CloudFreeGithubHoldFacts {
  return {
    reason: lock.reason,
    oldEnoughAt: lock.oldEnoughAt ?? null,
    githubLogin: lock.githubLogin ?? null,
    canUnlockWithCard: lock.reason !== "checking" && lock.canUnlockWithCard,
    sentence: lock.sentence || null,
  };
}

/** The hold's title: what is held and why, in a few words. */
export function cloudFreeGithubHoldTitle(hold: CloudFreeGithubHoldFacts, purpose: CloudFreeGithubHoldPurpose): string {
  const who = hold.githubLogin ? `Your GitHub account ${hold.githubLogin}` : "Your GitHub account";
  switch (hold.reason) {
    case "no_github":
      return purpose === "credits" ? "Free credits need GitHub" : `Add a card to unlock ${BRAND.NAME} Free Models`;
    case "too_new":
      return `${who} is new`;
    case "used":
      return purpose === "credits" ? "This GitHub account already has a free plan" : "This GitHub account is already in use";
    case "checking":
      return "Checking your GitHub account…";
  }
}

/** The hold's one sentence: the server's, else the shared wording (`cloudFreeGithubSentence`). */
export function cloudFreeGithubHoldDetail(hold: CloudFreeGithubHoldFacts, purpose: CloudFreeGithubHoldPurpose, plusIncludedMilli: number | null | undefined): string {
  if (hold.sentence) {
    // A sentence that opens with the title ("Checking your GitHub account… …") says the rest only.
    const title = cloudFreeGithubHoldTitle(hold, purpose);
    const rest = hold.sentence.startsWith(title) ? hold.sentence.slice(title.length).trim() : "";
    return rest || hold.sentence;
  }
  if (purpose === "free-models") {
    return hold.reason === "checking"
      ? `${BRAND.NAME} Free Models unlock once the check is done. It runs again in a few minutes.`
      : `Add a card (no charge) to unlock ${BRAND.NAME} Free Models.`;
  }
  return cloudFreeGithubSentence(hold.reason, { oldEnoughAt: hold.oldEnoughAt, plusIncludedMilli: plusIncludedMilli ?? 0 }) ?? "";
}

/**
 * The GitHub hold, drawn one way everywhere it shows: Settings' plan card,
 * the ADE Cloud draft above the prompt box, a sleeping lane computer's tool,
 * and the ADE Free Models unlock sheet. Its actions are the caller's (the
 * sheet puts them in its own footer). Account level, so no pin.
 */
export function CloudFreeGithubHold({
  hold,
  purpose,
  plusIncludedMilli,
  actions,
  busy = false,
  testId,
}: {
  hold: CloudFreeGithubHoldFacts;
  purpose: CloudFreeGithubHoldPurpose;
  plusIncludedMilli?: number | null;
  actions?: NoticeAction[];
  busy?: boolean;
  testId?: string;
}) {
  // A wait (a new account, a check that runs again) reads as information; a missing or used GitHub needs a step.
  const tone = hold.reason === "too_new" || hold.reason === "checking" || purpose === "free-models" ? "info" : "warning";
  return (
    <Banner
      layout="inline"
      testId={testId}
      model={{
        id: `cloud-free-github-${purpose}-${hold.reason}`,
        tone,
        icon: <GithubLogo />,
        busy: busy || hold.reason === "checking",
        title: cloudFreeGithubHoldTitle(hold, purpose),
        detail: cloudFreeGithubHoldDetail(hold, purpose, plusIncludedMilli),
        ...(actions && actions.length > 0 ? { actions } : {}),
        report: false,
      }}
    />
  );
}

/** Opens GitHub's settings from anywhere (a sheet opened outside the router too). */
export function openGithubSettings(): void {
  navigateToAppTarget({ kind: "settings", entryId: "integrations.github", machineId: null });
}

export type CloudFreeUnlockOutcome = "unlocked" | "opened" | "failed";

/**
 * "Add a card (no charge)": Stripe's page to save a card opens in the browser
 * (`window.ade.cloud.openFreeUnlock`), or a card already on file does it at
 * once. Account level, so no pin. `toast` false leaves the telling to the
 * caller (the unlock sheet waits for the card in place).
 */
export function useCloudFreeUnlock({ purpose, toast = true, onUnlocked }: {
  purpose: CloudFreeGithubHoldPurpose;
  toast?: boolean;
  onUnlocked?: () => void;
}): { busy: boolean; addCard: () => Promise<CloudFreeUnlockOutcome> } {
  const [busy, setBusy] = useState(false);
  const what = purpose === "credits" ? "Your free credits" : `${BRAND.NAME} Free Models`;
  const addCard = useCallback(async (): Promise<CloudFreeUnlockOutcome> => {
    const open = window.ade?.cloud?.openFreeUnlock;
    if (!open) {
      showToast({ tone: "error", title: "Couldn't open the card page", message: `Add a card in ${BRAND.NAME} on your computer or in the web app.` });
      return "failed";
    }
    setBusy(true);
    try {
      const result = await open();
      if (result?.unlocked) {
        if (toast) showToast({ tone: "success", title: `${what} are on`, message: "The card already on file counts. You weren't charged." });
        refreshCloudAccount();
        onUnlocked?.();
        return "unlocked";
      }
      if (result?.opened) {
        if (toast) showToast({ title: "Save a card in your browser", message: `You won't be charged. ${what} start once it's saved.` });
        return "opened";
      }
      return "failed";
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't open the card page", message: ipcErrorMessage(error) || "Try again in a moment." });
      return "failed";
    } finally {
      setBusy(false);
    }
  }, [onUnlocked, toast, what]);
  return { busy, addCard };
}

/**
 * The actions for a hold on the free plan's credits, where ADE Cloud is
 * used: a card when the server says it lifts the hold, GitHub's settings when
 * none is connected, the plans when this GitHub account's free plan is
 * someone else's, and a re-read while GitHub can't be asked.
 */
export function cloudFreeCreditsHoldActions(hold: CloudFreeGithubHoldFacts, handlers: {
  addCard: () => void;
  cardBusy: boolean;
  connectGithub: () => void;
  seePlans: () => void;
  checkAgain: () => void;
}): NoticeAction[] {
  const actions: NoticeAction[] = [];
  if (hold.canUnlockWithCard) {
    actions.push({ label: "Add a card (no charge)", variant: "primary", icon: <CreditCard />, busy: handlers.cardBusy, onClick: handlers.addCard });
  }
  if (hold.reason === "no_github") {
    actions.push({ label: "Connect GitHub", variant: actions.length ? "secondary" : "primary", icon: <GithubLogo />, onClick: handlers.connectGithub });
  }
  if (hold.reason === "used") actions.push({ label: "See plans", variant: "secondary", onClick: handlers.seePlans });
  if (hold.reason === "checking") actions.push({ label: "Check again", variant: "secondary", onClick: handlers.checkAgain });
  return actions;
}

/**
 * Why the free plan has no hours under its GitHub rules, with the one thing to
 * do about it: connect GitHub, add a card (no charge) or wait, or get a plan.
 * Sits at the top of the plan card. Account level, so no pin.
 */
export function CloudFreeGithubNotice({ account, onChanged }: { account: CloudAccountState; onChanged: () => void }) {
  const navigate = useNavigate();
  const { busy, addCard } = useCloudFreeUnlock({ purpose: "credits", onUnlocked: onChanged });
  const hold = freePlanGithubHold(account);
  if (!hold) return null;
  const toPlans = () => document.getElementById("cloud-plan")?.scrollIntoView({ block: "start" });
  return (
    <CloudFreeGithubHold
      hold={hold}
      purpose="credits"
      plusIncludedMilli={account.catalog?.plans?.plus?.includedMilli}
      actions={cloudFreeCreditsHoldActions(hold, {
        addCard: () => void addCard(),
        cardBusy: busy,
        connectGithub: () => navigate(GITHUB_SETTINGS_ROUTE),
        seePlans: toPlans,
        checkAgain: onChanged,
      })}
    />
  );
}
