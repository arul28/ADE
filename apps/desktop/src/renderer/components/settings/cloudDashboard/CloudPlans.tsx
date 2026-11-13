import { useState } from "react";
import { ArrowSquareOut, CreditCard } from "@phosphor-icons/react";
import {
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
  CLOUD_PLAN_LABELS,
  CLOUD_PLAN_RANK,
  cloudCatalogHasMax,
  cloudCatalogHasPro,
  cloudCatalogOf,
  cloudExtraHourCentsOf,
  cloudPlanIdOf,
  cloudPlanLabelOf,
  formatCloudCents,
  formatCloudCentsPerHour,
  formatCloudDate,
  formatCloudHours,
  type CloudAccountState,
  type CloudPaidPlanId,
  type CloudPlanCleanup,
  type CloudPlanCleanupPick,
  type CloudPlanFacts,
  type CloudPlanId,
} from "../../../../shared/adeCloud";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { SettingsSelect, SettingsToggle } from "../primitives/SettingsControls";
import { CloudPlanLimitsDialog, planCleanupPickSentence } from "./CloudPlanLimitsDialog";
import { CloudFreeGithubNotice } from "./CloudFreeGithubNotice";

/** The monthly limits a person picks for extra disk, in dollars. */
const EXTRA_DISK_LIMITS = ["5", "10", "20", "50"];
const DEFAULT_EXTRA_DISK_LIMIT = "10";

type Column = { id: CloudPlanId; facts: CloudPlanFacts };

/**
 * Plans side by side (what each includes, the current one marked) with one
 * action per plan, then the paid plan's extra hours and extra disk and the
 * way to Stripe's billing page. Replaces the two bare "Plus" / "Pro" buttons.
 *
 * Reads nothing of its own: the account comes from the page's computer list.
 * Account level, so no pin.
 */
export function CloudPlans({ account, onChanged }: { account: CloudAccountState; onChanged: () => void }) {
  const bridge = window.ade.cloud;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diskLimit, setDiskLimit] = useState(DEFAULT_EXTRA_DISK_LIMIT);
  // A downgrade over the cheaper plan's disk: the question first (CloudPlanLimitsDialog).
  const [asking, setAsking] = useState<CloudPaidPlanId | null>(null);

  const catalog = cloudCatalogOf(account);
  const pro = cloudCatalogHasPro(catalog) ? catalog.plans.pro : null;
  const max = cloudCatalogHasMax(catalog) ? catalog.plans.max : null;
  const current = cloudPlanIdOf(account);
  const paid = account.plan === "paid";
  const pastDue = account.billing.notice === "past_due";
  const { billing, extraHours } = account;
  const nextPlanId = pro ? billing.nextPlanId ?? null : null;
  // A paid plan with a move down waiting: its own column undoes the move (uncharged).
  const canStay = paid && !pastDue && !billing.cancelAtPeriodEnd && current !== "free" && nextPlanId != null && nextPlanId !== current;
  const columns: Column[] = [
    { id: "free", facts: catalog.plans.free },
    { id: "plus", facts: catalog.plans.plus ?? catalog.plans.paid },
    ...(pro ? [{ id: "pro" as const, facts: pro }] : []),
    ...(max ? [{ id: "max" as const, facts: max }] : []),
  ];
  // What a move down to each cheaper plan would go over (only plans it goes over are sent).
  const previewFor = (plan: CloudPlanId): CloudPlanCleanup | null =>
    (account.downgradePreviews as Partial<Record<CloudPlanId, CloudPlanCleanup>> | undefined)?.[plan] ?? null;
  const showPhoneMinutes = columns.some((column) => column.facts.phoneMinutes != null);
  const currentExtraCents = cloudExtraHourCentsOf(current, catalog);

  const run = async (work: (() => Promise<unknown>) | undefined) => {
    if (!work) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (workError) {
      setError(ipcErrorMessage(workError) || "ADE Cloud couldn't do that. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const checkout = (plan?: CloudPaidPlanId) => run(async () => {
    const result = await bridge?.openCheckout?.(plan);
    if (!plan || !result?.change) return;
    const label = CLOUD_PLAN_LABELS[plan];
    if (result.change === "now") showToast({ title: `You're on ${label} now.`, tone: "success" });
    else showToast({ title: `You move to ${label} on ${formatCloudDate(billing.periodEnd)}. ${cloudPlanLabelOf(account, catalog)} stays until then.` });
  });

  // Only an answer that the plan changed now says it worked; anything else shows the plan error.
  const stay = (plan: CloudPaidPlanId) => run(async () => {
    const label = CLOUD_PLAN_LABELS[plan];
    const result = await bridge?.openCheckout?.(plan);
    if (result?.change !== "now") throw new Error(`ADE Cloud didn't keep you on ${label}. Try again in a moment, or use Manage billing.`);
    showToast({ title: `You stay on ${label}.`, tone: "success" });
  });

  const choose = async (target: Column) => {
    if (target.id === "free") return;
    if (target.id === current && canStay) {
      await stay(target.id);
      return;
    }
    if (!paid) {
      await checkout(pro ? target.id : undefined);
      return;
    }
    const label = CLOUD_PLAN_LABELS[target.id];
    if (CLOUD_PLAN_RANK[target.id] > CLOUD_PLAN_RANK[current]) {
      const ok = await confirmDialog({
        title: `Move to ${label}?`,
        message: `${label} is $${target.facts.priceUsd} a month with ${formatCloudHours(target.facts.includedMilli)} hours. You pay the difference for the rest of this month now. Hours you used stay used.`,
        confirmLabel: `Move to ${label}`,
      });
      if (ok) await checkout(target.id);
      return;
    }
    // A move down starts with the next month. Over the cheaper plan's disk, ADE
    // asks first: clean up yourself (no move), or pick what ADE frees now.
    if (previewFor(target.id)) {
      setAsking(target.id);
      return;
    }
    const ok = await confirmDialog({
      title: `Move to ${label}?`,
      message: `You move to ${label} on ${formatCloudDate(billing.periodEnd)}. ${cloudPlanLabelOf(account, catalog)} stays until then.`,
      confirmLabel: `Move to ${label}`,
    });
    if (!ok) return;
    const plan = target.id;
    await run(async () => {
      await bridge?.openCheckout?.(plan);
      showToast({ title: `You move to ${label} on ${formatCloudDate(billing.periodEnd)}.` });
    });
  };

  // The dialog shows a refusal itself; only a move that went through reaches the toast.
  const moveDownWith = async (plan: CloudPaidPlanId, pick: CloudPlanCleanupPick) => {
    const result = await bridge?.openCheckout?.(plan, pick);
    if (result?.change !== "next_period") throw new Error("ADE Cloud didn't change your plan. Nothing changed. Try again in a moment.");
    const freeing = result.freeing?.length ?? 0;
    if (pick.instanceIds.length > 0 && freeing === 0) {
      // The plan changed but the pick wasn't queued (another pick was running): say so, never a quiet success.
      showToast({
        tone: "warning",
        title: `You move to ${CLOUD_PLAN_LABELS[plan]} on ${formatCloudDate(billing.periodEnd)}.`,
        message: "ADE didn't start freeing the computers you picked. Choose them again from the notice on this page.",
      });
      onChanged();
      return;
    }
    showToast({
      tone: "success",
      title: `You move to ${CLOUD_PLAN_LABELS[plan]} on ${formatCloudDate(billing.periodEnd)}.`,
      ...(freeing ? { message: planCleanupPickSentence(pick.push, freeing) } : {}),
    });
    onChanged();
  };

  const actionFor = (column: Column): { label: string; primary: boolean } | null => {
    if (column.id === current && canStay && column.id !== "free") return { label: `Stay on ${CLOUD_PLAN_LABELS[column.id]}`, primary: true };
    if (column.id === current) return null;
    if (column.id === "free") return null;
    if (pastDue || billing.cancelAtPeriodEnd) return null;
    if (!paid) return { label: `Get ${CLOUD_PLAN_LABELS[column.id]}`, primary: column.id === "plus" };
    if (nextPlanId === column.id) return null;
    return { label: `Move to ${CLOUD_PLAN_LABELS[column.id]}`, primary: CLOUD_PLAN_RANK[column.id] > CLOUD_PLAN_RANK[current] };
  };

  // Extra disk (paid only, and only when the server sells it).
  const planGb = account.disk.limitGb;
  const extraDisk = account.extraDisk?.available && catalog.extraDiskCentsPer10GbMonth != null && planGb != null
    ? { ...account.extraDisk, centsPer10Gb: catalog.extraDiskCentsPer10GbMonth, planGb }
    : null;
  const extraDiskOn = extraDisk?.state === "on";
  const shownDiskLimit = extraDiskOn && extraDisk.monthlyLimitCents != null ? String(Math.floor(extraDisk.monthlyLimitCents / 100)) : diskLimit;
  const diskLimitOptions = (EXTRA_DISK_LIMITS.includes(shownDiskLimit) ? EXTRA_DISK_LIMITS : [...EXTRA_DISK_LIMITS, shownDiskLimit].sort((a, b) => Number(a) - Number(b)))
    .map((value) => ({ value, label: `Up to $${value} a month` }));

  const statusLine = billing.cancelAtPeriodEnd
    ? `Your plan ends ${formatCloudDate(billing.periodEnd)}. You're on Free after that.`
    : nextPlanId
      ? `You move to ${CLOUD_PLAN_LABELS[nextPlanId]} on ${formatCloudDate(billing.periodEnd)}.`
      : paid
        ? `Renews ${formatCloudDate(billing.periodEnd)}.`
        : "Free needs no card. Upgrade any time; you pay the difference for the rest of the month.";

  return (
    <section id="cloud-plan" className="kit-card adecd-card" aria-label="Plans">
      <header className="kit-card-head">
        <CreditCard size={14} />
        Plans
        <span className="adecd-head-note">{statusLine}</span>
        {paid || pastDue ? (
          <button type="button" className="kit-card-head-action" disabled={busy} onClick={() => void run(bridge?.openBillingPortal)}>
            Manage billing <ArrowSquareOut size={11} />
          </button>
        ) : null}
      </header>
      <div className="kit-card-body">
        <CloudFreeGithubNotice account={account} onChanged={onChanged} />
        <div className="adecd-plans" style={{ ["--adecd-plan-cols" as string]: columns.length }}>
          <div className="adecd-plan-col adecd-plan-keys" aria-hidden="true">
            <span className="adecd-plan-top" />
            <span>Price</span>
            <span>Hours a month</span>
            <span>Disk</span>
            {showPhoneMinutes ? <span>Phone minutes</span> : null}
            <span className="adecd-plan-wrap">Past your hours</span>
            <span className="adecd-plan-foot" />
          </div>
          {columns.map((column) => {
            const action = actionFor(column);
            const isCurrent = column.id === current;
            const label = CLOUD_PLAN_LABELS[column.id];
            return (
              <div key={column.id} className="adecd-plan-col" data-current={isCurrent || undefined} role="group" aria-label={`${label}${isCurrent ? ", your plan" : ""}`}>
                <span className="adecd-plan-top">
                  <b>{label}</b>
                  {isCurrent ? <span className="kit-tag" data-tone="accent">Your plan</span> : nextPlanId === column.id ? <span className="kit-tag">From {formatCloudDate(billing.periodEnd)}</span> : null}
                </span>
                <span><b className="kit-num" data-face="ui">{column.facts.priceUsd ? `$${column.facts.priceUsd}` : "$0"}</b><small>{column.facts.priceUsd ? " a month" : " forever"}</small></span>
                <span><b className="kit-num" data-face="ui">{Number(formatCloudHours(column.facts.includedMilli)).toLocaleString()}</b><small> hours</small></span>
                <span><b className="kit-num" data-face="ui">{column.facts.diskGb} GB</b><small> in all</small></span>
                {showPhoneMinutes ? (
                  <span><b className="kit-num" data-face="ui">{column.facts.phoneMinutes ?? "–"}</b><small> a month</small></span>
                ) : null}
                <span className="adecd-plan-wrap">{(() => {
                  const cents = cloudExtraHourCentsOf(column.id, catalog);
                  return cents == null ? <small>Work stops until the next month</small> : <small>{formatCloudCentsPerHour(cents)} an hour, if you turn it on</small>;
                })()}</span>
                <span className="adecd-plan-foot">
                  {action ? (
                    <button
                      type="button"
                      className={action.primary ? "kit-btn kit-btn-primary" : "kit-btn"}
                      data-size="sm"
                      disabled={busy}
                      onClick={() => void choose(column)}
                    >
                      {action.label}
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
        {paid && !billing.cancelAtPeriodEnd && account.downgradePreviews?.free ? (
          <p className="adecd-plan-fine" data-tone="warn">
            If you cancel in Manage billing: {account.downgradePreviews.free.sentence} ADE deletes nothing on its own. Once Free starts, you can't make a new computer until their disk fits; you clean up or pick what ADE frees here.
          </p>
        ) : null}
        {!paid ? (
          <p className="adecd-plan-fine">
            Free needs a GitHub account at least {CLOUD_FREE_GITHUB_MIN_AGE_DAYS} days old. One free plan per GitHub account and per computer.
          </p>
        ) : null}
        <p className="adecd-plan-fine">
          An hour is one hour of a Small computer while it's awake; bigger sizes use hours faster (see Sizes). Disk is what all your computers hold at one time. Make as many computers as you like.
        </p>

        {extraHours.available ? (
          <div className="kit-panel adecd-billing">
            <div className="adecd-billing-row">
              <div>
                <b>Extra hours</b>
                <small>
                  Keep working past your plan's hours at {formatCloudCentsPerHour(currentExtraCents ?? catalog.extraHourCents)} a Small-hour, billed after use.
                  {extraHours.usedMilli > 0 ? ` ${formatCloudHours(extraHours.usedMilli)} h used this month.` : ""}
                </small>
              </div>
              <SettingsToggle
                checked={extraHours.enabled}
                disabled={busy}
                label="Extra hours"
                onChange={(enabled) => void run(() => bridge?.setExtraHours?.(enabled) ?? Promise.resolve(null))}
              />
            </div>
            {extraDisk ? (
              <div className="adecd-billing-row">
                <div>
                  <b>Extra disk</b>
                  <small>
                    {extraDiskOn
                      ? `Your computers may go past ${extraDisk.planGb} GB, up to ${formatCloudCents(extraDisk.monthlyLimitCents ?? 0)} a month. ${formatCloudCents(extraDisk.usedCents)} so far this month.`
                      : `Let your computers go past ${extraDisk.planGb} GB for ${formatCloudCents(extraDisk.centsPer10Gb)} per 10 GB a month, counted by the day.`}
                  </small>
                </div>
                <div className="adecd-billing-controls">
                  <SettingsSelect
                    value={shownDiskLimit}
                    disabled={busy}
                    ariaLabel="Monthly limit for extra disk"
                    style={{ minWidth: 0 }}
                    options={diskLimitOptions}
                    onChange={(value) => {
                      setDiskLimit(value);
                      if (extraDiskOn) void run(() => bridge?.setExtraDisk?.({ enabled: true, monthlyLimitUsd: Number(value) }) ?? Promise.resolve(null));
                    }}
                  />
                  <SettingsToggle
                    checked={extraDiskOn}
                    disabled={busy}
                    label="Extra disk"
                    onChange={(enabled) => void run(() => bridge?.setExtraDisk?.(
                      enabled ? { enabled: true, monthlyLimitUsd: Number(shownDiskLimit) } : { enabled: false },
                    ) ?? Promise.resolve(null))}
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <Banner layout="inline" model={{ id: "cloud-plan-error", tone: "error", title: "ADE Cloud couldn't change your plan", detail: error, dismiss: { onDismiss: () => setError(null) } }} />
        ) : null}
      </div>
      {asking && previewFor(asking) ? (
        <CloudPlanLimitsDialog
          cleanup={previewFor(asking)!}
          mode="downgrade"
          currentPlanLabel={cloudPlanLabelOf(account, catalog)}
          onClose={() => setAsking(null)}
          onPick={(pick) => moveDownWith(asking, pick)}
        />
      ) : null}
    </section>
  );
}
