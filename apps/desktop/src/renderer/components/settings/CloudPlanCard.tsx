import { useState } from "react";
import { CalendarBlank, ClockCountdown } from "@phosphor-icons/react";
import { cloudCatalogOf, formatCloudDate, formatCloudHours, type CloudAccountState } from "../../../shared/adeCloud";
import { ipcErrorMessage } from "../../lib/format";
import { Banner } from "../ui/notice";
import { IntegrationCard } from "./integrations/IntegrationChrome";
import { PushAllWorkButton } from "../remoteTargets/PushAllWorkButton";
import { SettingsToggle } from "./primitives/SettingsControls";

/**
 * Settings › ADE Cloud › Plan and hours: hours left, the plan, its reset date,
 * extra hours, buying and managing the plan, and computers due for deletion.
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

  const paid = account.plan === "paid";
  const pastDue = account.billing.notice === "past_due";
  const { hours, billing, extraHours } = account;
  const catalog = cloudCatalogOf(account);
  const planHours = formatCloudHours(catalog.plans[account.plan].includedMilli);
  const resetLabel = billing.cancelAtPeriodEnd
    ? `Plan ends ${formatCloudDate(billing.periodEnd)}`
    : `Hours reset ${formatCloudDate(billing.periodEnd)}`;

  return (
    <IntegrationCard
      anchor="cloud-plan"
      span="full"
      icon={<ClockCountdown size={15} weight="fill" />}
      title="Plan and hours"
      actions={paid || pastDue ? (
        <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={() => void run(bridge?.openBillingPortal)}>
          Manage
        </button>
      ) : (
        <button type="button" className="ade-modern-btn" data-size="sm" data-tone="primary" disabled={busy} onClick={() => void run(bridge?.openCheckout)}>
          Buy, ${catalog.paidPriceUsd} a month
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
          <b>{paid ? `$${catalog.paidPriceUsd} plan` : "Free"}<small>{planHours} hours a month</small></b>
        </div>
        <div className="ade-ig-figure">
          <span className="kit-eyebrow">Computers</span>
          <b>{account.computers.total}<small>of {account.computers.limit}</small></b>
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
