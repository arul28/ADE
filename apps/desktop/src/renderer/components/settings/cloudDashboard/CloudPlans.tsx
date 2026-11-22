import { useRef, useState, type ReactNode } from "react";
import { ArrowSquareOut, Clock, CreditCard, Desktop, DeviceMobile, Info, Lightning, Megaphone, MoonStars, Robot, Sparkle } from "@phosphor-icons/react";
import { noteCloudSponsoredState } from "../../../state/cloudAccountStore";
import {
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
  CLOUD_HOUR_UNIT_SENTENCE,
  CLOUD_SMALL_FAIR_USE_SENTENCE,
  CLOUD_SMALL_UNLIMITED_SENTENCE,
  CLOUD_PLAN_LABELS,
  CLOUD_PLAN_RANK,
  cloudCatalogHasMax,
  cloudCatalogHasPro,
  cloudCatalogOf,
  cloudExtraHourCentsOf,
  cloudFreePlanOf,
  cloudPlanIdOf,
  cloudPlanLabelOf,
  cloudPlanComputerLimitOf,
  formatCloudCents,
  formatCloudCentsPerHour,
  formatCloudCentsPerMinute,
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
import { cloudHoursOnSizesLine, cloudTiers } from "../../../../shared/cloudTiers";
import { SettingsSelect, SettingsToggle } from "../primitives/SettingsControls";
import { CloudPlanLimitsDialog, planCleanupPickSentence } from "./CloudPlanLimitsDialog";
import { CloudFreeGithubNotice } from "./CloudFreeGithubNotice";
import { useStillWhenHidden } from "./CloudSky";
import { checkoutCloudPlanUp, confirmCloudPlanMoveUp } from "./cloudPlanMoveUp";
import "./cloudPlans.css";

/** The monthly limits a person picks for extra iPhone minutes, in dollars; "none" is no limit. */
const EXTRA_PHONE_LIMITS = ["5", "10", "25", "50", "100"];

type Column = { id: CloudPlanId; facts: CloudPlanFacts };

/**
 * Plans side by side (what each includes, the current one marked) with one
 * action per plan, then the paid plan's extra hours and iPhone minutes, and
 * the way to Stripe's billing page (Pricing v2: cloud computers per plan,
 * unlimited Small computers, hours for the bigger sizes shown as time on each
 * size, no disk). Every number is the server catalog's.
 *
 * Reads nothing of its own: the account comes from the page's computer list.
 * Account level, so no pin.
 */
/**
 * A plan card's one tag: "Your plan", "From Dec 1" for the plan that takes
 * over at the period's end, or "+1 computer" on the plan right above yours
 * (`moreComputers`, counted from yours; 0 elsewhere). Null when none applies.
 */
function planCardTag({ isCurrent, startsLater, until, moreComputers }: { isCurrent: boolean; startsLater: boolean; until: string; moreComputers: number }): ReactNode {
  if (isCurrent) return <span className="adecd-plancard-tag" data-tone="current">Your plan</span>;
  if (startsLater) return <span className="adecd-plancard-tag">From {until}</span>;
  if (moreComputers > 0) return <span className="adecd-plancard-tag" data-tone="next">+{moreComputers} {moreComputers === 1 ? "computer" : "computers"}</span>;
  return null;
}

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
  const [phoneLimit, setPhoneLimit] = useState("none");
  // A downgrade past the cheaper plan's computers: the question first (CloudPlanLimitsDialog).
  const [asking, setAsking] = useState<CloudPaidPlanId | null>(null);

  const catalog = cloudCatalogOf(account);
  const tiers = cloudTiers(catalog);
  const pro = cloudCatalogHasPro(catalog) ? catalog.plans.pro : null;
  const max = cloudCatalogHasMax(catalog) ? catalog.plans.max : null;
  const current = cloudPlanIdOf(account);
  const paid = account.plan === "paid";
  const pastDue = account.billing.notice === "past_due";
  const { billing, extraHours, sponsored } = account;
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
  // The ADE Cloud iPhone shows only to an account that has it (`on`); everyone else sees nothing of it.
  const phoneOn = account.phone?.access === "on";
  const showPhoneMinutes = phoneOn && columns.some((column) => column.facts.phoneMinutes != null);
  const currentExtraCents = cloudExtraHourCentsOf(current, catalog);
  // An account from before the new plans keeps its old hours until its
  // period ends; the table lists the new ones, so the plan's column says so.
  const currentFacts = columns.find((column) => column.id === current)?.facts ?? null;
  const oldTerms = paid && !pastDue && currentFacts
    ? { hoursMilli: account.hours.includedMilli > 0 && account.hours.includedMilli !== currentFacts.includedMilli ? account.hours.includedMilli : null }
    : null;
  const keepsOldTerms = oldTerms?.hoursMilli != null;
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

  const checkout = (target: Column) => run(async () => {
    // A server that doesn't sell Pro takes no plan: its one paid plan.
    if (!pro || target.id === "free") {
      await bridge?.openCheckout?.();
      return;
    }
    const result = await checkoutCloudPlanUp({ planId: target.id, computerLimit: cloudPlanComputerLimitOf(target.facts) });
    if (result?.change === "next_period") {
      showToast({ title: `You move to ${CLOUD_PLAN_LABELS[target.id]} on ${formatCloudDate(billing.periodEnd)}. ${cloudPlanLabelOf(account, catalog)} stays until then.` });
    }
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
      await checkout(target);
      return;
    }
    const label = CLOUD_PLAN_LABELS[target.id];
    if (CLOUD_PLAN_RANK[target.id] > CLOUD_PLAN_RANK[current]) {
      const ok = await confirmCloudPlanMoveUp({
        planId: target.id,
        priceUsd: target.facts.priceUsd,
        computerLimit: cloudPlanComputerLimitOf(target.facts),
        includedMilli: target.facts.includedMilli,
      });
      if (ok) await checkout(target);
      return;
    }
    // A move down starts with the next month. Past the cheaper plan's computers,
    // ADE asks first: clean up yourself (no move), or pick what ADE frees now.
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

  // Extra iPhone minutes (paid only, and only when the server sells them).
  const phone = account.phone;
  const phoneExtra = phoneOn && phone?.extra.available && phone.minutes ? { ...phone.extra, included: phone.minutes.included } : null;
  const phoneExtraOn = phoneExtra?.enabled === true;
  // On: the saved limit (null is "none"). Off: the person's pick for when they turn it on.
  const shownPhoneLimit = phoneExtra?.enabled
    ? phoneExtra.monthlyLimitCents == null ? "none" : String(Math.floor(phoneExtra.monthlyLimitCents / 100))
    : phoneLimit;
  const phoneLimitOptions = [
    { value: "none", label: "No limit" },
    ...EXTRA_PHONE_LIMITS.map((value) => ({ value, label: `$${value}` })),
    ...(shownPhoneLimit !== "none" && !EXTRA_PHONE_LIMITS.includes(shownPhoneLimit) ? [{ value: shownPhoneLimit, label: `$${shownPhoneLimit}` }] : []),
  ];

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
  if (keepsOldTerms && afterFacts && oldTerms?.hoursMilli != null) {
    notes.push(`${CLOUD_PLAN_LABELS[current]} keeps your old ${formatCloudHours(oldTerms.hoursMilli)} hours until ${until}. From then ${afterId === current ? "it has" : `you're on ${CLOUD_PLAN_LABELS[afterId]}, with`} ${formatCloudHours(afterFacts.includedMilli)} hours, as on its card.`);
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
            const computers = cloudPlanComputerLimitOf(column.facts);
            const more = below ? Math.max(0, computers - cloudPlanComputerLimitOf(below.facts)) : 0;
            const tag = planCardTag({
              isCurrent,
              startsLater: nextPlanId === column.id || (billing.cancelAtPeriodEnd && column.id === "free"),
              until,
              moreComputers: isNext ? more : 0,
            });
            const onSizes = cloudHoursOnSizesLine(column.facts.includedMilli, tiers);
            return (
              <article
                key={column.id}
                className="kit-panel adecd-plancard"
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
                  <li title="Cloud computers your account may have, asleep or not: one per lane"><Desktop size={13} /><span><b className="kit-num" data-face="ui">{computers}</b> cloud {computers === 1 ? "computer" : "computers"} <span className="adecd-nowrap">(asleep or not)</span></span></li>
                  <li title={CLOUD_SMALL_UNLIMITED_SENTENCE}><Sparkle size={13} /><span><b>Unlimited</b> Small computers</span></li>
                  {isCurrent && oldTerms?.hoursMilli != null ? (
                    <li title={`${formatCloudHours(column.facts.includedMilli)} hours from ${until}`}><Clock size={13} /><span><b className="kit-num" data-face="ui">{formatCloudHours(oldTerms.hoursMilli)}</b> hours for bigger computers until {until}</span></li>
                  ) : (
                    <li title={onSizes || undefined}><Clock size={13} /><span><b className="kit-num" data-face="ui">{formatCloudHours(column.facts.includedMilli)}</b> hours for bigger computers{onSizes ? <small className="adecd-plancard-sizes">{onSizes}</small> : null}</span></li>
                  )}
                  {showPhoneMinutes ? (
                    <li title="Time on an iPhone simulator in the cloud, for agents to test your app."><DeviceMobile size={13} /><span><b className="kit-num" data-face="ui">{column.facts.phoneMinutes ?? "–"}</b> iOS Simulator <span className="adecd-nowrap">minutes</span></span></li>
                  ) : null}
                  {column.facts.extraPhoneMinuteCents != null && showPhoneMinutes ? (
                    <li title="Only if you turn extra iPhone minutes on"><DeviceMobile size={13} /><span><b className="kit-num" data-face="ui">{formatCloudCentsPerMinute(column.facts.extraPhoneMinuteCents)}</b> an extra iPhone minute</span></li>
                  ) : null}
                  {cents == null ? (
                    <li data-quiet="true" title="Bigger computers stop until your hours reset; Small computers keep working"><Lightning size={13} /><span>No extra hours</span></li>
                  ) : (
                    <li title="Only if you turn extra hours on"><Lightning size={13} /><span><b className="kit-num" data-face="ui">{formatCloudCentsPerHour(cents)}</b> an extra hour</span></li>
                  )}
                  {column.facts.outsideAgents === false ? (
                    <li data-quiet="true" title="Outside agents (through ADE MCP) can't start ADE Cloud work on this plan"><Robot size={13} /><span>No outside agents</span></li>
                  ) : column.facts.outsideAgents === true ? (
                    <li title="Outside agents (through ADE MCP) may start ADE Cloud work"><Robot size={13} /><span>Outside agents may use ADE Cloud</span></li>
                  ) : null}
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

        <div className="kit-panel adecd-howto" aria-label="What every plan includes">
          <div className="adecd-howto-items">
            <div className="adecd-howto-item">
              <span className="adecd-howto-icon"><Sparkle size={14} /></span>
              <p><b>{CLOUD_SMALL_UNLIMITED_SENTENCE}</b> Bigger computers use hours, and each plan has a number of cloud computers, asleep or not: one per lane.</p>
            </div>
            <div className="adecd-howto-item">
              <span className="adecd-howto-icon"><Clock size={14} /></span>
              <p>
                <b>Hours run the bigger computers</b> and renew every month. {CLOUD_HOUR_UNIT_SENTENCE}
                {extraHours.available && currentExtraCents != null
                  ? ` With extra hours on, an hour past your plan costs ${formatCloudCentsPerHour(currentExtraCents)}.`
                  : null}
              </p>
            </div>
            <div className="adecd-howto-item">
              <span className="adecd-howto-icon"><MoonStars size={14} /></span>
              <p><b>Computers sleep on their own</b> a few minutes after work stops, so your hours only go to real work.</p>
            </div>
            {showPhoneMinutes ? (
              <div className="adecd-howto-item">
                <span className="adecd-howto-icon"><DeviceMobile size={14} /></span>
                <p><b>iOS Simulator minutes</b>: time on an iPhone simulator in the cloud, for agents to test your app.</p>
              </div>
            ) : null}
          </div>
          {notes.length ? (
            <ul className="adecd-howto-notes">
              {notes.map((note) => <li key={note}><Info size={12} />{note}</li>)}
            </ul>
          ) : null}
          <p className="adecd-howto-fineprint">{CLOUD_SMALL_FAIR_USE_SENTENCE}</p>
        </div>

        {extraHours.available || phoneExtra || sponsored?.ads ? (
          <div className="adecd-addons">
            {sponsored?.ads ? (
              <div className="kit-panel adecd-addon" data-on={sponsored.consent === "granted" || undefined}>
                <div className="adecd-addon-top">
                  <span className="adecd-addon-icon"><Megaphone size={15} weight="duotone" /></span>
                  <b>Sponsored cards</b>
                  <SettingsToggle
                    checked={sponsored.consent === "granted"}
                    disabled={busy}
                    label="Sponsored cards"
                    onChange={(enabled) => void run(async () => {
                      noteCloudSponsoredState(await bridge?.setSponsoredConsent?.(enabled ? "granted" : "declined"));
                    })}
                  />
                </div>
                <small className="adecd-addon-state">
                  {sponsored.consent === "granted"
                    ? "On. A Free chat on ADE Cloud can show one sponsored card under a finished reply. Gravity, our ad partner, picks it from your last message and the reply."
                    : "Off. Your ADE Cloud chats show no sponsored cards."}
                </small>
              </div>
            ) : null}
            {extraHours.available ? (
              <div className="kit-panel adecd-addon" data-on={extraHours.enabled || undefined}>
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
                    ? `On.${extraHours.usedMilli > 0 ? ` ${formatCloudHours(extraHours.usedMilli)} extra hours used this month.` : " Bigger computers keep going when your hours run out."}`
                    : "Off. Bigger computers stop when your hours run out; Small computers keep working."}
                </small>
              </div>
            ) : null}
            {phoneExtra ? (
              <div className="kit-panel adecd-addon" data-on={phoneExtraOn || undefined}>
                <div className="adecd-addon-top">
                  <span className="adecd-addon-icon"><DeviceMobile size={15} weight="duotone" /></span>
                  <b>Extra iPhone minutes</b>
                  <SettingsSelect
                    value={shownPhoneLimit}
                    disabled={busy}
                    ariaLabel="Monthly limit for extra iPhone minutes"
                    style={{ minWidth: 0 }}
                    options={phoneLimitOptions}
                    onChange={(value) => {
                      setPhoneLimit(value);
                      if (phoneExtraOn) {
                        void run(() => bridge?.setExtraPhoneMinutes?.({ enabled: true, monthlyLimitUsd: value === "none" ? null : Number(value) }) ?? Promise.resolve(null));
                      }
                    }}
                  />
                  <SettingsToggle
                    checked={phoneExtraOn}
                    disabled={busy}
                    label="Extra iPhone minutes"
                    onChange={(enabled) => void run(() => bridge?.setExtraPhoneMinutes?.(
                      enabled ? { enabled: true, monthlyLimitUsd: shownPhoneLimit === "none" ? null : Number(shownPhoneLimit) } : { enabled: false },
                    ) ?? Promise.resolve(null))}
                  />
                </div>
                <div className="adecd-addon-price">
                  <b className="kit-num" data-face="ui">{formatCloudCentsPerMinute(phoneExtra.centsPerMinute ?? currentFacts?.extraPhoneMinuteCents ?? 0)}</b>
                  <span>a minute past your plan's {phoneExtra.included}, billed after use</span>
                </div>
                <small className="adecd-addon-state">
                  {phoneExtraOn
                    ? phoneExtra.usedMinutes > 0
                      ? `On. ${phoneExtra.usedMinutes} extra minutes (${formatCloudCents(phoneExtra.usedCents)}) this month.`
                      : "On. The iPhone keeps going when your minutes run out."
                    : "Off. The iPhone stops when your minutes run out."}
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
