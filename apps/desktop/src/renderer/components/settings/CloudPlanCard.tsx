import { useState } from "react";
import { CalendarBlank, ClockCountdown } from "@phosphor-icons/react";
import {
  CLOUD_PLAN_LABELS,
  cloudCatalogHasPro,
  cloudCatalogOf,
  cloudPlanFactsOf,
  cloudPlanIdOf,
  cloudPlanLabelOf,
  formatCloudCents,
  formatCloudDate,
  formatCloudHours,
  type CloudAccountState,
  type CloudPaidPlanId,
} from "../../../shared/adeCloud";
import { ipcErrorMessage } from "../../lib/format";
import { showToast } from "../app/toast/toastStore";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { IntegrationCard } from "./integrations/IntegrationChrome";
import { PushAllWorkButton } from "../remoteTargets/PushAllWorkButton";
import { SettingsSelect, SettingsToggle } from "./primitives/SettingsControls";

/** The monthly limits a person picks for extra disk, in dollars. */
const EXTRA_DISK_LIMITS = ["5", "10", "20", "50"];
const DEFAULT_EXTRA_DISK_LIMIT = "10";

/**
 * Settings › ADE Cloud › Plan and hours: hours left, the plan, its reset date,
 * extra hours and extra disk, buying, changing and managing the plan, and
 * computers due for deletion.
 * Reads nothing of its own: the account comes from the page's machine list,
 * which reads only while this page is open. Account-level, so no pin.
 */
export function CloudPlanCard({ account, onChanged }: {
  account: CloudAccountState;
  /** Read the account again after a change here. */
  onChanged: () => void;
}) {
  const bridge = window.ade.cloud;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The limit picked before extra disk is turned on; while it is on, the account's own limit shows. */
  const [diskLimit, setDiskLimit] = useState(DEFAULT_EXTRA_DISK_LIMIT);

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

  /** Buys a plan in the browser, or on a paid account switches to the other plan without one. */
  const checkout = (plan?: CloudPaidPlanId) => run(async () => {
    const result = await bridge?.openCheckout?.(plan);
    if (!plan || !result?.change) return;
    const label = CLOUD_PLAN_LABELS[plan];
    if (result.change === "now") showToast({ title: `You're on ${label} now.`, tone: "success" });
    else showToast({ title: `You move to ${label} on ${formatCloudDate(billing.periodEnd)}. ${cloudPlanLabelOf(account, catalog)} stays until then.` });
  });

  /** Moving to Pro charges now, so it asks first. */
  const moveToPro = async (proFacts: { priceUsd: number; includedMilli: number }) => {
    const confirmed = await confirmDialog({
      title: "Move to Pro?",
      message: `Pro is $${proFacts.priceUsd} a month with ${formatCloudHours(proFacts.includedMilli)} hours. You pay the difference for the rest of this period now. Hours you used stay used.`,
      confirmLabel: "Move to Pro",
    });
    if (confirmed) await checkout("pro");
  };

  const paid = account.plan === "paid";
  const pastDue = account.billing.notice === "past_due";
  const { hours, billing, extraHours, disk } = account;
  const catalog = cloudCatalogOf(account);
  // Pro, moving between plans and extra disk only when the server sells them: a server
  // before Pro sells Plus for any plan asked, so the card stays as it was there.
  const pro = cloudCatalogHasPro(catalog) ? catalog.plans.pro : null;
  const planId = cloudPlanIdOf(account);
  const plan = cloudPlanFactsOf(account, catalog);
  const nextPlanId = pro ? billing.nextPlanId ?? null : null;
  // Null from a server before Pro on a free account: each free computer has its own disk there, nothing shared.
  const planGb = disk.limitGb;
  const extraDisk = account.extraDisk?.available && catalog.extraDiskCentsPer10GbMonth != null && planGb != null
    ? { ...account.extraDisk, centsPer10Gb: catalog.extraDiskCentsPer10GbMonth, planGb }
    : null;
  const extraDiskOn = extraDisk?.state === "on";
  const shownDiskLimit = extraDiskOn && extraDisk.monthlyLimitCents != null ? String(Math.floor(extraDisk.monthlyLimitCents / 100)) : diskLimit;
  const diskLimitOptions = (EXTRA_DISK_LIMITS.includes(shownDiskLimit) ? EXTRA_DISK_LIMITS : [...EXTRA_DISK_LIMITS, shownDiskLimit].sort((a, b) => Number(a) - Number(b)))
    .map((value) => ({ value, label: `Up to $${value} a month` }));
  const resetLabel = billing.cancelAtPeriodEnd
    ? `Plan ends ${formatCloudDate(billing.periodEnd)}`
    : nextPlanId
      ? `${CLOUD_PLAN_LABELS[nextPlanId]} from ${formatCloudDate(billing.periodEnd)}`
      : `Hours reset ${formatCloudDate(billing.periodEnd)}`;

  return (
    <IntegrationCard
      anchor="cloud-plan"
      span="full"
      icon={<ClockCountdown size={15} weight="fill" />}
      title="Plan and hours"
      actions={paid || pastDue ? (
        <>
          {pro && paid && !pastDue && !billing.cancelAtPeriodEnd && (planId === "plus" || nextPlanId === "plus") ? (
            <button
              type="button"
              className="ade-modern-btn"
              data-size="sm"
              data-tone="primary"
              disabled={busy}
              onClick={() => void (nextPlanId === "plus" ? checkout("pro") : moveToPro(pro))}
            >
              {nextPlanId === "plus" ? "Stay on Pro" : "Move to Pro"}
            </button>
          ) : null}
          {pro && paid && !pastDue && !billing.cancelAtPeriodEnd && planId === "pro" && nextPlanId == null ? (
            <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={() => void checkout("plus")}>
              Move to Plus
            </button>
          ) : null}
          <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={() => void run(bridge?.openBillingPortal)}>
            Manage
          </button>
        </>
      ) : pro ? (
        <>
          <button type="button" className="ade-modern-btn" data-size="sm" data-tone="primary" disabled={busy} onClick={() => void checkout("plus")}>
            Plus, ${catalog.plans.paid.priceUsd} a month
          </button>
          <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={() => void checkout("pro")}>
            Pro, ${pro.priceUsd} a month
          </button>
        </>
      ) : (
        <button type="button" className="ade-modern-btn" data-size="sm" data-tone="primary" disabled={busy} onClick={() => void checkout()}>
          Buy, ${catalog.plans.paid.priceUsd} a month
        </button>
      )}
    >
      <div className="ade-ig-figures">
        <div className="ade-ig-figure">
          <span className="kit-eyebrow">Hours left</span>
          <b>{formatCloudHours(hours.leftMilli)}<small>of {formatCloudHours(hours.includedMilli)}</small></b>
        </div>
        <div className="ade-ig-figure">
          <span className="kit-eyebrow">Plan</span>
          <b>{cloudPlanLabelOf(account, catalog)}<small>{formatCloudHours(plan.includedMilli)} hours a month</small></b>
        </div>
        <div className="ade-ig-figure">
          <span className="kit-eyebrow">Computers</span>
          <b>{account.computers.total}<small>of {account.computers.limit} at one time</small></b>
        </div>
        <div className="ade-ig-figure">
          <span className="kit-eyebrow">Disk</span>
          {planGb != null
            ? <b>{disk.usedGb} GB<small>of {planGb} GB at one time</small></b>
            : <b>{disk.usedGb} GB<small>up to {catalog.plans.free.diskGb} GB each</small></b>}
        </div>
      </div>
      <p className="ade-ig-note"><CalendarBlank size={13} /> {resetLabel}. {hours.percentUsed}% used.</p>

      {extraHours.available ? (
        <div className="ade-ig-limit-rows">
          <div className="ade-ig-limit-row">
            <div>
              <b>Extra hours</b>
              <small>
                Keep going past your plan at {catalog.extraHourCents}¢ a Small-hour, charged after use.
                {extraHours.usedMilli > 0 ? ` ${formatCloudHours(extraHours.usedMilli)} used this period.` : ""}
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
            <div className="ade-ig-limit-row">
              <div>
                <b>Extra disk</b>
                <small>
                  {extraDiskOn
                    ? `Your computers may go past ${extraDisk.planGb} GB at one time, up to ${formatCloudCents(extraDisk.monthlyLimitCents ?? 0)} a month. ${formatCloudCents(extraDisk.usedCents)} used this period.`
                    : `Let your computers go past ${extraDisk.planGb} GB at one time. It costs ${formatCloudCents(extraDisk.centsPer10Gb)} for each 10 GB a month, counted by the day.`}
                </small>
              </div>
              <div className="ade-ig-limit-controls">
                <SettingsSelect
                  value={shownDiskLimit}
                  disabled={busy}
                  ariaLabel="Monthly limit for extra disk"
                  style={{ minWidth: 0 }}
                  options={diskLimitOptions}
                  onChange={(value) => {
                    setDiskLimit(value);
                    // While it is on, a new limit applies at once.
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

      {account.dueForDeletion.length ? (
        <div className="ade-ig-mini-rows" aria-label="Computers due for deletion">
          {account.dueForDeletion.map((computer) => (
            <div key={computer.instanceId} className="ade-ig-mini-row">
              <span className="ade-ig-mini-title">{computer.name ?? computer.instanceId}</span>
              <span className="ade-ig-mini-detail">Deleted {formatCloudDate(computer.deletesAt)} unless it's used</span>
              <PushAllWorkButton instanceId={computer.instanceId} />
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <Banner layout="inline" model={{ id: "cloud-plan-error", tone: "error", title: "ADE Cloud couldn't change your plan", detail: error, dismiss: { onDismiss: () => setError(null) } }} />
      ) : null}
    </IntegrationCard>
  );
}
