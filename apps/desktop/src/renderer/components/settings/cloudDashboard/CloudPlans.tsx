import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowSquareOut, Clock, Coins, CreditCard, Desktop, Info, Infinity, Lightning, Megaphone, MoonStars, Robot, Sparkle } from "@phosphor-icons/react";
import { noteSponsoredNoticeShown, setCloudSponsoredConsent } from "../../../state/cloudAccountStore";
import { useOnScreen } from "../../chat/sponsored/sponsoredOnScreen";
import { turnOnSponsoredCards } from "../../chat/sponsored/SponsoredReplySlot";
import { useDocumentVisible } from "../../chat/sponsored/useSponsoredViewer";
import {
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
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
import { isTesterBuild } from "../../../lib/packageChannel";
import { openExternalUrl } from "../../../lib/openExternal";
import { showToast } from "../../app/toast/toastStore";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { cloudHoursOnSizesLine, cloudTiers } from "../../../../shared/cloudTiers";
import { cloudUnitWords } from "../../../../shared/cloudUnitWords";
import { CloudPhoneProviderPick } from "./CloudPhoneProviderPick";
import { SettingsToggle } from "../primitives/SettingsControls";
import { CloudPlanLimitsDialog, planCleanupPickSentence } from "./CloudPlanLimitsDialog";
import { CloudFreeGithubNotice } from "./CloudFreeGithubNotice";
import { useStillWhenHidden } from "./CloudSky";
import { checkoutCloudPlanUp, confirmCloudPlanMoveUp } from "./cloudPlanMoveUp";
import "./cloudPlans.css";

/** What sponsored cards do, as the chat's question and notice say it: "Free ADE Cloud chats …" when on, "When on, free …" when off. */
const SPONSORED_SETTINGS_DO = "ADE Cloud chats can show one card under a finished reply, and an agent may suggest a sponsored tool.";
/** What Gravity gets, in the row's small print. */
const SPONSORED_SETTINGS_SENDS =
  "To pick them, ADE sends Gravity, our ad partner, your last message and the reply (or the agent's search), your IP address, your device type and a hashed copy of your account email. For people 18 or older.";

/**
 * What Free's Small computers cost this person with this answer, from the
 * server's flags (`CloudSponsoredState`): free with cards on in the US, credits
 * with them off, outside the US, or a week after the last chat opened there.
 */
function sponsoredSmallNote(sponsored: NonNullable<CloudAccountState["sponsored"]>, on: boolean, noun: string): { free: boolean; text: string } | null {
  if (sponsored.smallOutsideUS) return { free: false, text: `Small computers use your ${noun} outside the US: sponsored cards keep them free only in the US.` };
  if (!sponsored.smallNeedsCards) return null;
  if (!on) return { free: false, text: `Small computers use your ${noun} while sponsored cards are off.` };
  if (sponsored.smallNeedsLook) return { free: false, text: `Small computers use your ${noun} until you open an ADE Cloud chat in the US: none was opened there in the last 7 days.` };
  return sponsored.ads ? { free: true, text: "Your Small computers are free while sponsored cards are on." } : null;
}

/** Why cards are off when a browser's Global Privacy Control turned them off (`CloudSponsoredState.gpcOff`). */
const SPONSORED_GPC_OFF =
  "A browser you use sends Global Privacy Control, which turned sponsored cards off for your account. To keep them on there, turn them on from that browser.";

/** The extra credits switch on this card: the hero's "When credits run out" links here. */
export const CLOUD_EXTRA_ANCHOR = "cloud-extra";

type Column = { id: CloudPlanId; facts: CloudPlanFacts };


/**
 * Plans side by side (what each includes, the current one marked) with one
 * action per plan, then the paid plan's extra credits, and the way to
 * Stripe's billing page (Pricing v2: cloud computers per plan, unlimited
 * Small computers, credits for everything past Small, shown as time on each
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
  // A downgrade past the cheaper plan's computers: the question first (CloudPlanLimitsDialog).
  const [asking, setAsking] = useState<CloudPaidPlanId | null>(null);

  const catalog = cloudCatalogOf(account);
  const words = cloudUnitWords(account);
  const { noun } = words;
  const tiers = cloudTiers(catalog);
  const pro = cloudCatalogHasPro(catalog) ? catalog.plans.pro : null;
  const max = cloudCatalogHasMax(catalog) ? catalog.plans.max : null;
  const current = cloudPlanIdOf(account);
  const paid = account.plan === "paid";
  const pastDue = account.billing.notice === "past_due";
  const { billing, extraHours, sponsored } = account;
  // Shown where cards can show, and to an account that said yes, so a paid
  // plan can still take that yes back before a move to Free.
  const sponsoredToggle = sponsored && (sponsored.ads || sponsored.consent === "granted") ? sponsored : null;
  // Where cards start on, this row is the notice that they are on (with the switch to turn them off): seen, it is saved.
  const sponsoredStartsOn = sponsoredToggle?.startsOn === true && sponsoredToggle.consent === null;
  const sponsoredOn = sponsoredToggle?.consent === "granted" || sponsoredStartsOn;
  const sponsoredSmall = sponsoredToggle ? sponsoredSmallNote(sponsoredToggle, sponsoredOn, noun) : null;
  // Seen (the row on screen, the window in front), the row is the notice: saved once. Its words
  // stay while this page is open, after the save turned the answer into a yes.
  const sponsoredRowRef = useRef<HTMLDivElement | null>(null);
  const sponsoredRowOnScreen = useOnScreen(sponsoredRowRef, 0.5, sponsoredStartsOn);
  const windowVisible = useDocumentVisible();
  const sponsoredRowSeen = sponsoredRowOnScreen && windowVisible;
  const [toldHere, setToldHere] = useState(false);
  useEffect(() => {
    if (!sponsoredStartsOn || !sponsoredRowSeen) return;
    setToldHere(true);
    noteSponsoredNoticeShown();
  }, [sponsoredStartsOn, sponsoredRowSeen]);
  // Where the ad switch reaches this account (`sponsored` is sent), Free's Small is unlimited only with sponsored cards on.
  const freeSmallNeedsCards = sponsored != null;
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
  // It draws from the credits, so no plan lists minutes of its own.
  const phoneOn = account.phone?.access === "on";
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

  const phone = account.phone;
  // A tester's own pick of who runs their phones: only on the beta list, and only in a beta, alpha or dev build.
  const providerPick = phoneOn && phone?.providerChoice && isTesterBuild() ? phone.providerChoice : null;

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
    notes.push(`${CLOUD_PLAN_LABELS[current]} keeps your old ${formatCloudHours(oldTerms.hoursMilli)} ${noun} until ${until}. From then ${afterId === current ? "it has" : `you're on ${CLOUD_PLAN_LABELS[afterId]}, with`} ${formatCloudHours(afterFacts.includedMilli)} ${noun}, as on its card.`);
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
                  <li title={column.id === "free" && freeSmallNeedsCards ? `In the US, Small computers use no ${noun} while sponsored cards are on. Elsewhere, or with them off, they use half a credit for each hour awake.` : CLOUD_SMALL_UNLIMITED_SENTENCE}><Sparkle size={13} /><span><b>Unlimited</b> Small computers{column.id === "free" && freeSmallNeedsCards ? " with sponsored cards" : ""}</span></li>
                  {isCurrent && oldTerms?.hoursMilli != null ? (
                    <li title={`${formatCloudHours(column.facts.includedMilli)} ${noun} from ${until}`}><Clock size={13} /><span><b className="kit-num" data-face="ui">{formatCloudHours(oldTerms.hoursMilli)}</b> credits until {until}</span></li>
                  ) : (
                    <li title={onSizes || undefined}><Clock size={13} /><span><b className="kit-num" data-face="ui">{formatCloudHours(column.facts.includedMilli)}</b> credits a month{onSizes ? <small className="adecd-plancard-sizes">{onSizes}</small> : null}</span></li>
                  )}
                  {cents == null ? (
                    <li data-quiet="true" title="Bigger computers and the iPhone stop until your credits reset; Small computers keep working"><Lightning size={13} /><span>No {words.extra.toLowerCase()}</span></li>
                  ) : (
                    <li title={`Only if you turn ${words.extra.toLowerCase()} on`}><Lightning size={13} /><span><b className="kit-num" data-face="ui">{formatCloudCentsPerHour(cents)}</b> an extra {words.one}</span></li>
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
              <p><b>{freeSmallNeedsCards ? "Unlimited Small computers on paid plans, and on Free in the US with sponsored cards on." : CLOUD_SMALL_UNLIMITED_SENTENCE}</b> Each plan has a number of cloud computers, asleep or not: one per lane.</p>
            </div>
            <div className="adecd-howto-item adecd-howto-rates">
              <span className="adecd-howto-icon"><Clock size={14} /></span>
              <div>
                <p><b>Credits</b> renew every month and pay for everything past Small.</p>
                <table className="adecd-rates" aria-label="What uses credits">
                  <tbody>
                    {tiers.map((tier) => (
                      <tr key={tier.id}>
                        <th scope="row">{tier.label}</th>
                        <td className="kit-num">{tier.multiplierMilli > 0 ? `${words.count(tier.multiplierMilli / 1000)} an hour` : "No credits"}</td>
                      </tr>
                    ))}
                    {phoneOn ? (
                      <tr><th scope="row">ADE Cloud iPhone</th><td className="kit-num">{`${words.count(words.phoneMilliPerMinute / 1000)} a minute`}</td></tr>
                    ) : null}
                    {extraHours.available && currentExtraCents != null ? (
                      <tr><th scope="row">Extra credits</th><td className="kit-num">{`${formatCloudCentsPerHour(currentExtraCents)} a credit`}</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="adecd-howto-item">
              <span className="adecd-howto-icon"><MoonStars size={14} /></span>
              <p><b>Computers sleep on their own</b> a few minutes after work stops, so your {noun} only go to real work.</p>
            </div>
          </div>
          {notes.length ? (
            <ul className="adecd-howto-notes">
              {notes.map((note) => <li key={note}><Info size={12} />{note}</li>)}
            </ul>
          ) : null}
          <p className="adecd-howto-fineprint">{CLOUD_SMALL_FAIR_USE_SENTENCE}</p>
        </div>

        {extraHours.available || sponsoredToggle || providerPick ? (
          <div className="adecd-addons">
            {sponsoredToggle ? (
              <div ref={sponsoredRowRef} className="kit-panel adecd-addon" data-on={sponsoredOn || undefined}>
                <div className="adecd-addon-top">
                  <span className="adecd-addon-icon"><Megaphone size={15} weight="duotone" /></span>
                  <b>Sponsored cards</b>
                  <SettingsToggle
                    checked={sponsoredOn}
                    disabled={busy}
                    label="Sponsored cards"
                    onChange={(enabled) => void run(() => (enabled ? turnOnSponsoredCards(sponsoredToggle.confirmYes === true) : setCloudSponsoredConsent("declined")))}
                  />
                </div>
                <small className="adecd-addon-state">
                  {!sponsoredOn
                    ? `Off. When on, free ${SPONSORED_SETTINGS_DO}`
                    : sponsoredToggle.ads
                      ? `On.${sponsoredStartsOn || toldHere ? " They start on where you are; you can turn them off here." : ""} Free ${SPONSORED_SETTINGS_DO}`
                      : "On, but none show for you now: sponsored cards run only in Free ADE Cloud chats, in the countries Gravity serves."}
                </small>
                {!sponsoredOn && sponsoredToggle.gpcOff ? (
                  <small className="adecd-addon-state">{SPONSORED_GPC_OFF}</small>
                ) : null}
                {sponsoredSmall ? (
                  <p className="adecd-addon-note" data-free={sponsoredSmall.free || undefined}>
                    {sponsoredSmall.free ? <Infinity size={13} weight="bold" aria-hidden /> : <Coins size={13} aria-hidden />}
                    <span>{sponsoredSmall.text}</span>
                  </p>
                ) : null}
                {sponsoredToggle.ads || !sponsoredOn ? (
                  <small className="adecd-addon-fine">
                    {SPONSORED_SETTINGS_SENDS}{" "}
                    <button type="button" className="adecd-linkish" onClick={() => openExternalUrl("https://ade-app.dev/privacy#sponsored")}>How it works</button>
                  </small>
                ) : null}
              </div>
            ) : null}
            {extraHours.available ? (
              <div id={CLOUD_EXTRA_ANCHOR} className="kit-panel adecd-addon" data-on={extraHours.enabled || undefined}>
                <div className="adecd-addon-top">
                  <span className="adecd-addon-icon"><Lightning size={15} weight="duotone" /></span>
                  <b>{words.extra}</b>
                  <SettingsToggle
                    checked={extraHours.enabled}
                    disabled={busy}
                    label={words.extra}
                    onChange={(enabled) => void run(() => bridge?.setExtraHours?.(enabled) ?? Promise.resolve(null))}
                  />
                </div>
                <div className="adecd-addon-price">
                  <b className="kit-num" data-face="ui">{formatCloudCentsPerHour(currentExtraCents ?? catalog.extraHourCents)}</b>
                  <span>{words.perUnit} once your plan's run out, billed after use</span>
                </div>
                <small className="adecd-addon-state">
                  {extraHours.enabled
                    ? `On.${extraHours.usedMilli > 0 ? ` ${formatCloudHours(extraHours.usedMilli)} extra credits used this month.` : " Bigger computers and the iPhone keep going when your credits run out."}`
                    : "Off. Bigger computers and the iPhone stop when your credits run out; Small computers keep working."}
                </small>
              </div>
            ) : null}
            {providerPick ? <CloudPhoneProviderPick choice={providerPick} onChanged={onChanged} /> : null}
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
