import { useRef, useState } from "react";
import { ArrowSquareOut, Clock, CreditCard, DeviceMobile, HardDrives, Info, Lightning, MoonStars, Sparkle } from "@phosphor-icons/react";
import {
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
  CLOUD_PLAN_LABELS,
  CLOUD_PLAN_RANK,
  cloudCatalogHasMax,
  cloudCatalogHasPro,
  cloudCatalogOf,
  cloudExtraHourCentsOf,
  cloudFreePlanOf,
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
import { useStillWhenHidden } from "./CloudSky";
import { CLOUD_PLAN_MOMENT_TOAST_ID } from "./CloudPlanMomentNotice";

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
export function CloudPlans({ account, onChanged, newPlanId = null }: {
  account: CloudAccountState;
  onChanged: () => void;
  /** A plan that just landed ("You're on Plus"): its card is highlighted once. */
  newPlanId?: CloudPlanId | null;
}) {
  const bridge = window.ade.cloud;
  const sectionRef = useRef<HTMLElement | null>(null);
  useStillWhenHidden(sectionRef);
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
  // An account from before the new plans keeps its old hours and disk until its
  // period ends; the table lists the new ones, so the plan's column says so.
  const currentFacts = columns.find((column) => column.id === current)?.facts ?? null;
  const oldTerms = paid && !pastDue && currentFacts
    ? {
        hoursMilli: account.hours.includedMilli > 0 && account.hours.includedMilli !== currentFacts.includedMilli ? account.hours.includedMilli : null,
        diskGb: account.disk.limitGb != null && account.disk.limitGb !== currentFacts.diskGb ? account.disk.limitGb : null,
      }
    : null;
  const keepsOldTerms = oldTerms != null && (oldTerms.hoursMilli != null || oldTerms.diskGb != null);
  const until = formatCloudDate(billing.periodEnd);
  // The plan after renewal: a waiting move, Free after a cancel, or the same plan on the new numbers.
  const afterId = billing.cancelAtPeriodEnd ? "free" : nextPlanId != null && nextPlanId !== current ? nextPlanId : current;
  const afterFacts = columns.find((column) => column.id === afterId)?.facts ?? null;
  const githubState = account.rules === "free" ? cloudFreePlanOf(account).github?.state : undefined;
  const githubHeld = githubState != null && githubState !== "ok";

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
    // The same toast as the plan moment (cloudPlanMoment.ts): whichever lands second replaces the first.
    if (result.change === "now") showToast({ id: CLOUD_PLAN_MOMENT_TOAST_ID, title: `You're on ${label} now.`, tone: "success" });
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
    // One filled button per card: the next plan up.
    return { label: `Move to ${CLOUD_PLAN_LABELS[column.id]}`, primary: CLOUD_PLAN_RANK[column.id] === CLOUD_PLAN_RANK[current] + 1 };
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

  const statusLine = pastDue
    ? "Your last payment failed. Update your card in Manage billing."
    : billing.cancelAtPeriodEnd
      ? `Your plan ends ${until}, then you're on Free. To keep it, use Manage billing.`
      : nextPlanId
        ? `You move to ${CLOUD_PLAN_LABELS[nextPlanId]} on ${until}.`
        : paid
          ? `Renews ${until}.`
          : "Upgrade any time; you pay the difference for the rest of the month.";

  // The account's own notes (a cancel's what-if, old terms, the free plan's rule): said once, in the "how it works" panel.
  const notes: string[] = [];
  if (paid && !billing.cancelAtPeriodEnd && account.downgradePreviews?.free) {
    notes.push(`If you cancel: ${account.downgradePreviews.free.sentence} ADE deletes nothing on its own; once Free starts, new computers wait until you clean up or pick what ADE frees here.`);
  }
  if (keepsOldTerms && afterFacts) {
    notes.push(`${CLOUD_PLAN_LABELS[current]} keeps your old ${[oldTerms?.hoursMilli != null ? `${formatCloudHours(oldTerms.hoursMilli)} hours` : null, oldTerms?.diskGb != null ? `${oldTerms.diskGb} GB` : null].filter(Boolean).join(" and ")} until ${until}. From then ${afterId === current ? "it has" : `you're on ${CLOUD_PLAN_LABELS[afterId]}, with`} ${formatCloudHours(afterFacts.includedMilli)} hours and ${afterFacts.diskGb} GB, as on its card.`);
  }
  // The rule, unless the GitHub notice above already says how it applies to you.
  if (!paid && !githubHeld) {
    notes.push(`Free needs a GitHub account at least ${CLOUD_FREE_GITHUB_MIN_AGE_DAYS} days old, or a card on file (no charge). One free plan per GitHub account and per computer.`);
  }

  return (
    <section ref={sectionRef} id="cloud-plan" className="kit-card adecd-card adecd-plancard-section" aria-label="Plans">
      <header className="kit-card-head">
        <CreditCard size={14} />
        Plans
        {/* "Renews Dec 13" is on the hero and the plan's card: the head says only what's different. */}
        {statusLine && !(paid && !pastDue && !billing.cancelAtPeriodEnd && !nextPlanId) ? (
          <span className="adecd-head-note" data-tone={pastDue ? "crit" : billing.cancelAtPeriodEnd ? "warn" : undefined}>{statusLine}</span>
        ) : null}
        {paid || pastDue ? (
          <button type="button" className="kit-card-head-action" disabled={busy} onClick={() => void run(bridge?.openBillingPortal)}>
            Manage billing <ArrowSquareOut size={11} />
          </button>
        ) : null}
      </header>
      <div className="kit-card-body">
        <CloudFreeGithubNotice account={account} onChanged={onChanged} />
        <div className="adecd-plancards" style={{ ["--adecd-plan-cols" as string]: columns.length }}>
          {columns.map((column, index) => {
            const action = actionFor(column);
            const isCurrent = column.id === current;
            const label = CLOUD_PLAN_LABELS[column.id];
            const cents = cloudExtraHourCentsOf(column.id, catalog);
            // The plan right above the current one: the one to sell, with how much more it gives.
            const isNext = !isCurrent && CLOUD_PLAN_RANK[column.id] === CLOUD_PLAN_RANK[current] + 1 && action != null;
            const below = index > 0 ? columns[index - 1]! : null;
            const more = below && below.facts.includedMilli > 0 ? Math.floor(column.facts.includedMilli / below.facts.includedMilli) : 0;
            const tag = isCurrent ? <span className="adecd-plancard-tag" data-tone="current">Your plan</span>
              : nextPlanId === column.id || (billing.cancelAtPeriodEnd && column.id === "free") ? <span className="adecd-plancard-tag">From {until}</span>
              // Only the plan right above yours: "3× the hours" on a plan further up would read as 3× yours.
              : isNext && more >= 2 ? <span className="adecd-plancard-tag" data-tone="next">{more}× the hours</span>
              : null;
            return (
              <article
                key={column.id}
                className="adecd-plancard"
                data-current={isCurrent || undefined}
                data-next={isNext || undefined}
                data-new={column.id === newPlanId || undefined}
                aria-label={`${label}${isCurrent ? ", your plan" : ""}`}
              >
                {isCurrent ? <span className="adecd-plancard-sky" aria-hidden="true" /> : null}
                <header className="adecd-plancard-head">
                  <b>{label}</b>
                  {column.id === newPlanId ? <span className="adecd-plancard-tag" data-tone="new"><Sparkle size={10} weight="fill" />New</span> : null}
                  {tag}
                </header>
                <div className="adecd-plancard-price">
                  <b className="kit-num" data-face="ui">{column.facts.priceUsd ? `$${column.facts.priceUsd}` : "$0"}</b>
                  <span>{column.facts.priceUsd ? "a month" : "forever"}</span>
                </div>
                <ul className="adecd-plancard-facts">
                  {isCurrent && oldTerms?.hoursMilli != null ? (
                    <li title={`${formatCloudHours(column.facts.includedMilli)} hours from ${until}`}><Clock size={13} /><span><b className="kit-num" data-face="ui">{formatCloudHours(oldTerms.hoursMilli)}</b> hours until {until}</span></li>
                  ) : (
                    <li><Clock size={13} /><span><b className="kit-num" data-face="ui">{formatCloudHours(column.facts.includedMilli)}</b> hours a month</span></li>
                  )}
                  {isCurrent && oldTerms?.diskGb != null ? (
                    <li title={`${column.facts.diskGb} GB from ${until}`}><HardDrives size={13} /><span><b className="kit-num" data-face="ui">{oldTerms.diskGb} GB</b> disk until {until}</span></li>
                  ) : (
                    <li><HardDrives size={13} /><span><b className="kit-num" data-face="ui">{column.facts.diskGb} GB</b> disk</span></li>
                  )}
                  {showPhoneMinutes ? (
                    <li title="The phone simulator on a cloud computer. Coming soon."><DeviceMobile size={13} /><span><b className="kit-num" data-face="ui">{column.facts.phoneMinutes ?? "–"}</b> phone minutes <em>soon</em></span></li>
                  ) : null}
                  {cents == null ? (
                    <li data-quiet="true" title="Work stops until your hours reset"><Lightning size={13} /><span>Work stops at the limit</span></li>
                  ) : (
                    <li title="Only if you turn extra hours on"><Lightning size={13} /><span><b className="kit-num" data-face="ui">{formatCloudCentsPerHour(cents)}</b> an extra hour</span></li>
                  )}
                </ul>
                <footer className="adecd-plancard-foot">
                  {action ? (
                    <button
                      type="button"
                      className={action.primary ? "adecd-cta" : "adecd-planbtn"}
                      disabled={busy}
                      onClick={() => void choose(column)}
                    >
                      <span>{action.label}</span>
                    </button>
                  ) : isCurrent ? (
                    <span className="adecd-plancard-state" data-tone={pastDue ? "crit" : billing.cancelAtPeriodEnd ? "warn" : undefined}>
                      {pastDue ? "Payment failed" : billing.cancelAtPeriodEnd ? `Ends ${until}` : paid ? `Renews ${until}` : `Resets ${until}`}
                    </span>
                  ) : null}
                </footer>
              </article>
            );
          })}
        </div>

        <div className="adecd-howto" aria-label="How hours and disk work">
          <div className="adecd-howto-items">
            <div className="adecd-howto-item">
              <span className="adecd-howto-icon"><Clock size={14} /></span>
              <p>
                <b>An hour</b> is one hour of a Small computer while it&apos;s awake. Bigger sizes use hours faster (2× uses two).
                {extraHours.available && currentExtraCents != null
                  ? ` With extra hours on, an hour past your plan costs ${formatCloudCentsPerHour(currentExtraCents)} times the size's rate.`
                  : null}
              </p>
            </div>
            <div className="adecd-howto-item">
              <span className="adecd-howto-icon"><HardDrives size={14} /></span>
              <p><b>Disk</b> is what all your computers hold at one time. Make as many computers as you like.</p>
            </div>
            <div className="adecd-howto-item">
              <span className="adecd-howto-icon"><MoonStars size={14} /></span>
              <p><b>Asleep, a computer uses no hours.</b> It falls asleep a few minutes after its agent stops.</p>
            </div>
          </div>
          {notes.length ? (
            <ul className="adecd-howto-notes">
              {notes.map((note) => <li key={note}><Info size={12} />{note}</li>)}
            </ul>
          ) : null}
        </div>

        {extraHours.available ? (
          <div className="adecd-addons">
            <div className="adecd-addon" data-on={extraHours.enabled || undefined}>
              <div className="adecd-addon-top">
                <span className="adecd-addon-icon"><Lightning size={15} weight="duotone" /></span>
                <b>Extra hours</b>
                <SettingsToggle
                  checked={extraHours.enabled}
                  disabled={busy}
                  label="Extra hours"
                  onChange={(enabled) => void run(() => bridge?.setExtraHours?.(enabled) ?? Promise.resolve(null))}
                />
              </div>
              <div className="adecd-addon-price">
                <b className="kit-num" data-face="ui">{formatCloudCentsPerHour(currentExtraCents ?? catalog.extraHourCents)}</b>
                <span>an hour past your plan, billed after use</span>
              </div>
              <small className="adecd-addon-state">
                {extraHours.enabled
                  ? `On.${extraHours.usedMilli > 0 ? ` ${formatCloudHours(extraHours.usedMilli)} hours used this month.` : " Work keeps going when your hours run out."}`
                  : "Off. Work stops when your hours run out."}
              </small>
            </div>
            {extraDisk ? (
              <div className="adecd-addon" data-on={extraDiskOn || undefined}>
                <div className="adecd-addon-top">
                  <span className="adecd-addon-icon"><HardDrives size={15} weight="duotone" /></span>
                  <b>Extra disk</b>
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
                <div className="adecd-addon-price">
                  <b className="kit-num" data-face="ui">{formatCloudCents(extraDisk.centsPer10Gb)}</b>
                  <span>per 10 GB a month past {extraDisk.planGb} GB, counted by the day</span>
                </div>
                <small className="adecd-addon-state">
                  {extraDiskOn
                    ? `On. ${formatCloudCents(extraDisk.usedCents)} so far this month.`
                    : "Off. Computers stop growing at your plan's disk."}
                </small>
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
