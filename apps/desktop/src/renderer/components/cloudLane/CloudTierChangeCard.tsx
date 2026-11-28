import { useMemo, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { cloudCatalogOf, cloudHoursLeftMilli, type CloudAccountState } from "../../../shared/adeCloud";
import type { CloudLaneJobSnapshot, CloudLaneTierTiming } from "../../../shared/cloudLaneLife";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { cloudTierChangeRateText, cloudTierHoldsDisk, cloudTierHoursOnText, cloudTiers, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { cloudUnitWords, type CloudUnitWords } from "../../../shared/cloudUnitWords";
import { ipcErrorMessage } from "../../lib/format";
import { CloudMark, CloudSizeIcon } from "../remoteTargets/cloudBrand";
import { CloudSizeCards } from "../settings/cloudDashboard/CloudSizeCards";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { noticeTone } from "../ui/notice/noticeTones";
import { CLOUD_LANE_LIFE_UNAVAILABLE, changeCloudLaneTier, cloudLaneChangesAvailable } from "./cloudLaneActions";
import { tierChangeAndroidNote, tierChangeDiskChoices, tierChangeDiskLine, type TierChangeComputer } from "./cloudTierChangeFacts";
import "./cloudLane.css";
import { BRAND } from "../../../shared/brand";

/**
 * The one tier-change card: what changes, why, the new rate, what the hours
 * left mean at that size, and the wait. "Change size" starts once the
 * agent finishes its turn, or at once with "Stop the running turn and do it
 * now" ticked; "Not now" leaves the size as it is.
 *
 * The same card serves a person's change (Settings › ADE Cloud, the chat's
 * ADE Cloud chip), with the four sizes to pick from, and an agent's request
 * (`ade cloud resize --request`), with the size the agent asked for and its
 * reason. Account level: the change runs in this app's main process by the
 * computer's ADE Cloud id, with no pin, and goes on with the window closed.
 */

export type CloudTierChangeFacts = {
  laneName: string;
  instanceId: string;
  fromSizeId: CloudTierId | null;
  /** An agent's request names the size; a person picks it on the card. */
  toSizeId: CloudTierId | null;
  /** The agent's reason, in its words; null for a person's change. */
  reason: string | null;
};

/** How long a change takes, as the person reads it. A move makes a new computer and copies the lane. */
function waitText(move: boolean): string {
  return move
    ? "About 5 to 10 minutes: a new computer gets the lane's files, then the old one goes. Your files and chats stay."
    : "About 2 minutes: the computer restarts at the new size. Your files and chats stay.";
}

/** The hours left, the plan's and the earned ones (as the ADE Cloud page counts them); null before the account is read. */
function hoursLeftOf(account: CloudAccountState | null): number | null {
  return account?.hours ? cloudHoursLeftMilli(account) : null;
}

function hoursText(leftMilli: number | null, tier: CloudTier | null, words: CloudUnitWords): string | null {
  return leftMilli == null || !tier ? null : cloudTierHoursOnText(tier, leftMilli, words);
}

export function CloudTierChangeCard({
  facts,
  account,
  pickable,
  request = null,
  onStarted,
  onNotNow,
  notNowLabel = "Not now",
  notNowBusy = false,
  className,
  headless = false,
  computer = null,
}: {
  facts: CloudTierChangeFacts;
  account: CloudAccountState | null;
  /** The lane's computer's disk, for what the change does to it; null before the list is read. */
  computer?: TierChangeComputer | null;
  /** A person's change: the four sizes show and the person picks one. */
  pickable: boolean;
  /**
   * The agent's size request this card answers: its chat, and that chat's
   * runtime pin, which hears how the change ended from whatever runs it.
   */
  request?: { requestId: string; chatSessionId: string; chatPin: OpenProjectBinding | null } | null;
  onStarted?: (job: CloudLaneJobSnapshot) => void;
  onNotNow: () => void;
  /** An agent's request: "Keep the size", which ADE tells the agent. */
  notNowLabel?: string;
  /** The not-now answer is on its way. */
  notNowBusy?: boolean;
  className?: string;
  /** Inside a dialog whose title already names the change: no heading of its own. */
  headless?: boolean;
}) {
  const tiers = useMemo(() => cloudTiers(cloudCatalogOf(account)), [account]);
  const words = cloudUnitWords(account);
  const [picked, setPicked] = useState<CloudTierId | null>(facts.toSizeId);
  const [busy, setBusy] = useState<CloudLaneTierTiming | null>(null);
  // One action: by default the change starts once the agent finishes its turn.
  const [stopTurn, setStopTurn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = tiers.find((tier) => tier.id === facts.fromSizeId) ?? null;
  const to = tiers.find((tier) => tier.id === picked) ?? null;
  const move = Boolean(from && to && from.type !== to.type);
  const changed = to != null && to.id !== facts.fromSizeId;
  const available = cloudLaneChangesAvailable();
  const leftMilli = hoursLeftOf(account);
  const hours = hoursText(leftMilli, to, words);
  const currentDiskGb = computer?.diskGb ?? null;
  // A disk never shrinks: a size whose cap is below it is refused, so it can't be started.
  const diskFits = !to || cloudTierHoldsDisk(to, currentDiskGb);
  const diskLine = to && changed ? tierChangeDiskLine({ to, move, currentGb: currentDiskGb }) : null;
  const diskGrow = useMemo(
    () => (to && changed && !move ? tierChangeDiskChoices({ account, to, currentGb: currentDiskGb }) : { choices: [], why: null }),
    [account, changed, currentDiskGb, move, to],
  );
  // The disk to grow to with the resize: none until the person picks one.
  const [growTo, setGrowTo] = useState<number | null>(null);
  const growDiskGb = growTo != null && diskGrow.choices.includes(growTo) ? growTo : null;
  const android = to && changed && from?.type !== to.type
    ? tierChangeAndroidNote({ account, to, computer: computer ?? { diskGb: null, usedGb: null } })
    : null;

  const start = async (timing: CloudLaneTierTiming) => {
    if (!to || !changed || !diskFits) return;
    setBusy(timing);
    setError(null);
    try {
      const job = await changeCloudLaneTier({
        instanceId: facts.instanceId,
        sizeId: to.id,
        timing,
        diskGb: growDiskGb,
        requestId: request?.requestId ?? null,
        requestedByChat: request?.chatSessionId ?? null,
        requestedByChatPin: request?.chatPin ?? null,
      });
      onStarted?.(job);
    } catch (startError) {
      setError(ipcErrorMessage(startError) || `${BRAND.NAME} couldn't change the size. Try again in a moment.`);
    } finally {
      setBusy(null);
    }
  };

  const title = to && changed
    ? move
      ? `Move ${facts.laneName} to a ${to.label} computer?`
      : `Change ${facts.laneName} to ${to.label}?`
    : `Change the size of ${facts.laneName}`;

  return (
    <div className={cn("adecl-tier", className)} data-cloud-tier-card={request?.requestId ?? "person"}>
      {headless ? null : (
        <div className="adecl-tier-head">
          <span className="adecl-tier-mark" aria-hidden><CloudMark size={14} bold /></span>
          <b>{title}</b>
        </div>
      )}

      {pickable ? (
        <div className="adecl-tier-cards">
          <CloudSizeCards
            tiers={tiers}
            picked={picked}
            onPick={setPicked}
            leftMilli={leftMilli}
            markId={facts.fromSizeId}
            markLabel="Now"
            ariaLabel="New size"
            words={words}
            currentDiskGb={currentDiskGb}
          />
        </div>
      ) : null}

      {to ? (
        <div className="adecl-tier-path" aria-label={`From ${from?.label ?? "its size"} to ${to.label}`}>
          <span className="adecl-tier-size">
            {from ? <CloudSizeIcon tier={from.id} size={16} /> : null}
            {from?.label ?? "Now"}
          </span>
          <span className="adecl-tier-arrow" aria-hidden><ArrowRight size={12} /></span>
          <span className="adecl-tier-size" data-to="true">
            <CloudSizeIcon tier={to.id} size={16} />
            {to.label}
          </span>
          <span className="adecl-tier-rate kit-num">
            {cloudTierChangeRateText(from, to, words)}
          </span>
        </div>
      ) : null}

      {changed ? (
        <dl className="adecl-tier-facts">
          {facts.reason ? (<><dt>Why</dt><dd>{facts.reason}</dd></>) : null}
          {hours ? (<><dt>{words.Noun}</dt><dd>{hours}</dd></>) : null}
          {diskLine || diskGrow.choices.length || diskGrow.why ? (
            <>
              <dt>Disk</dt>
              <dd style={diskFits ? undefined : { color: noticeTone("warning").text }}>
                {diskLine}
                {diskGrow.choices.length ? (
                  <label className="adecl-tier-grow">
                    <input
                      type="checkbox"
                      checked={growDiskGb != null}
                      onChange={(event) => setGrowTo(event.target.checked ? diskGrow.choices[0]! : null)}
                    />
                    <span>Grow it now to</span>
                    <select
                      className="kit-input"
                      data-size="sm"
                      aria-label="New disk size"
                      value={growDiskGb ?? diskGrow.choices[0]}
                      onChange={(event) => setGrowTo(Number(event.target.value))}
                    >
                      {diskGrow.choices.map((gb) => <option key={gb} value={gb}>{gb} GB</option>)}
                    </select>
                  </label>
                ) : diskGrow.why ? <span className="adecl-tier-sub">{diskGrow.why}</span> : null}
              </dd>
            </>
          ) : null}
          {android ? (<><dt>Android</dt><dd style={android.fits ? undefined : { color: noticeTone("warning").text }}>{android.sentence}</dd></>) : null}
          <dt>Wait</dt><dd>{waitText(move)}{growDiskGb ? " Growing the disk adds a few minutes." : ""}</dd>
        </dl>
      ) : null}

      {error ? (
        <Banner
          layout="inline"
          style={{ marginTop: 6 }}
          model={{
            id: "cloud-tier-change-error",
            tone: "error",
            title: error,
            report: { surface: "cloud_tier_change" },
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}
      {!available ? <p className="adecl-muted">{CLOUD_LANE_LIFE_UNAVAILABLE}</p> : null}

      <div className="adecl-tier-actions">
        {changed && !computer?.resting ? (
          <label className="adecl-tier-now-check">
            <input type="checkbox" checked={stopTurn} onChange={(event) => setStopTurn(event.target.checked)} />
            <span>Stop the running turn and do it now</span>
          </label>
        ) : <span />}
        <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={busy != null || notNowBusy} onClick={onNotNow}>{notNowLabel}</button>
        <button type="button" className="kit-btn adecl-btn-sky" data-size="sm" disabled={!changed || !available || !diskFits || busy != null} onClick={() => void start(stopTurn ? "now" : "idle")}>
          {busy ? "Starting…" : move ? "Move it" : "Change size"}
        </button>
      </div>
    </div>
  );
}
