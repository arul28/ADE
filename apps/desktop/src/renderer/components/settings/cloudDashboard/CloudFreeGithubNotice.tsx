import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CreditCard, GithubLogo } from "@phosphor-icons/react";
import {
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
  cloudFreePlanOf,
  formatCloudFreeGithubDay,
  formatCloudHours,
  type CloudAccountState,
  type CloudFreePlanGithub,
} from "../../../../shared/adeCloud";
import { settingsRouteFor } from "../../../../shared/settingsManifest";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { Banner } from "../../ui/notice";

const GITHUB_SETTINGS_ROUTE = settingsRouteFor("integrations.github");

/** The hero's one line under the hours while the GitHub rules hold the free hours (the plan card's notice says the rest). */
export function cloudFreeGithubHeroLine(github: CloudFreePlanGithub): string | null {
  switch (github.state) {
    case "no_github":
      return "No free hours until you connect GitHub.";
    case "too_new":
      return github.oldEnoughAt != null
        ? `Free hours start ${formatCloudFreeGithubDay(github.oldEnoughAt)}, or now with a card (no charge).`
        : "Free hours start when your GitHub account is 30 days old, or now with a card (no charge).";
    case "used":
      return "This GitHub account's free plan is on another ADE account.";
    case "checking":
      return "Checking your GitHub account for free hours.";
    default:
      return null;
  }
}

/**
 * Why the free plan has no hours under its GitHub rules, with the one thing to
 * do about it: connect GitHub, add a card (no charge) or wait, or get a plan.
 * Sits at the top of the plan card. Account level, so no pin.
 */
export function CloudFreeGithubNotice({ account, onChanged }: { account: CloudAccountState; onChanged: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const github = cloudFreePlanOf(account).github;
  if (!github || github.state === "ok" || account.rules !== "free") return null;

  const addCard = async () => {
    setBusy(true);
    try {
      const result = await window.ade.cloud?.openFreeUnlock?.();
      if (result?.unlocked) {
        showToast({ tone: "success", title: "Your free hours are on", message: "The card already on file counts. You weren't charged." });
        onChanged();
      } else if (result?.opened) {
        showToast({ title: "Save a card in your browser", message: "You won't be charged. Your free hours show here once it's saved." });
      }
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't open the card page", message: ipcErrorMessage(error) || "Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };
  const toPlans = () => document.getElementById("cloud-plan")?.scrollIntoView({ block: "start" });
  const plusHours = account.catalog?.plans?.plus?.includedMilli;

  switch (github.state) {
    case "no_github":
      return (
        <Banner
          layout="inline"
          model={{
            id: "cloud-free-github-none",
            tone: "warning",
            icon: <GithubLogo />,
            title: "Free hours need GitHub",
            detail: `Connect a GitHub account that is at least ${CLOUD_FREE_GITHUB_MIN_AGE_DAYS} days old. ADE Cloud uses it to get your code.`,
            actions: [{ label: "Connect GitHub", variant: "primary", onClick: () => navigate(GITHUB_SETTINGS_ROUTE) }],
            report: false,
          }}
        />
      );
    case "too_new":
      return (
        <Banner
          layout="inline"
          model={{
            id: "cloud-free-github-new",
            tone: "info",
            icon: <GithubLogo />,
            title: github.githubLogin ? `Your GitHub account ${github.githubLogin} is new` : "Your GitHub account is new",
            detail: github.oldEnoughAt != null
              ? `Free hours start once it is ${CLOUD_FREE_GITHUB_MIN_AGE_DAYS} days old. Add a card (no charge) to start now, or wait until ${formatCloudFreeGithubDay(github.oldEnoughAt)}.`
              : `Free hours start once it is ${CLOUD_FREE_GITHUB_MIN_AGE_DAYS} days old. Add a card (no charge) to start now, or wait.`,
            actions: github.canUnlockWithCard
              ? [{ label: "Add a card (no charge)", variant: "primary", icon: <CreditCard />, busy, onClick: () => void addCard() }]
              : [],
            report: false,
          }}
        />
      );
    case "used":
      return (
        <Banner
          layout="inline"
          model={{
            id: "cloud-free-github-used",
            tone: "warning",
            icon: <GithubLogo />,
            title: "This GitHub account already has a free plan",
            detail: `${github.githubLogin ? `${github.githubLogin} gives` : "It gives"} its free hours to another ADE account, so this one has none.${plusHours ? ` Plus gives you ${formatCloudHours(plusHours)} hours a month.` : ""}`,
            actions: [{ label: "See plans", variant: "secondary", onClick: toPlans }],
            report: false,
          }}
        />
      );
    case "checking":
      return (
        <Banner
          layout="inline"
          model={{
            id: "cloud-free-github-checking",
            tone: "info",
            icon: <GithubLogo />,
            title: "Checking your GitHub account",
            detail: "ADE couldn't reach GitHub just now. It tries again in a few minutes; your free hours start once it can.",
            actions: [{ label: "Check again", variant: "secondary", onClick: onChanged }],
            report: false,
          }}
        />
      );
  }
}
