import { useMemo, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { cloudCatalogOf, cloudHoursLeftMilli, formatCloudHours, type CloudAccountState } from "../../../shared/adeCloud";
import type { CloudLaneJobSnapshot, CloudLaneTierTiming } from "../../../shared/cloudLaneLife";
import { cloudTierHoursAt, cloudTierRateLabel, cloudTiers, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { ipcErrorMessage } from "../../lib/format";
import { CloudMark, CloudSizeIcon } from "../remoteTargets/cloudBrand";
import { CloudSizeCards } from "../settings/cloudDashboard/CloudSizeCards";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { noticeTone } from "../ui/notice/noticeTones";
import { CLOUD_LANE_LIFE_UNAVAILABLE, changeCloudLaneTier, cloudLaneLifeAvailable } from "./cloudLaneActions";
import { tierChangeAndroidNote, tierChangeDiskChoices, tierChangeDiskLine, type TierChangeComputer } from "./cloudTierChangeFacts";
import "./cloudLane.css";

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

function rateText(tier: CloudTier | null): string {
  return tier ? cloudTierRateLabel(tier) : "";
}

/** The hours left, the plan's and the earned ones (as the ADE Cloud page counts them); null before the account is read. */
function hoursLeftOf(account: CloudAccountState | null): number | null {
  return account?.hours ? cloudHoursLeftMilli(account) : null;
}

function hoursText(leftMilli: number | null, tier: CloudTier | null): string | null {
  if (leftMilli == null || !tier || tier.multiplierMilli <= 0) return null;
  return `${formatCloudHours(leftMilli)} h left is about ${cloudTierHoursAt(tier, leftMilli)} awake at this size.`;
}

export function CloudTierChangeCard({
  facts,
  account,
  pickable,
  requestId = null,
  requestedByChat = null,
  onStarted,
  onNotNow,
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
  requestId?: string | null;
  requestedByChat?: string | null;
  onStarted?: (job: CloudLaneJobSnapshot) => void;
  onNotNow: () => void;
  className?: string;
  /** Inside a dialog whose title already names the change: no heading of its own. */
  headless?: boolean;
}) {
  const tiers = useMemo(() => cloudTiers(cloudCatalogOf(account)), [account]);
  const [picked, setPicked] = useState<CloudTierId | null>(facts.toSizeId);
  const [busy, setBusy] = useState<CloudLaneTierTiming | null>(null);
  // One action: by default the change starts once the agent finishes its turn.
  const [stopTurn, setStopTurn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = tiers.find((tier) => tier.id === facts.fromSizeId) ?? null;
  const to = tiers.find((tier) => tier.id === picked) ?? null;
  const move = Boolean(from && to && from.type !== to.type);
  const changed = to != null && to.id !== facts.fromSizeId;
  const available = cloudLaneLifeAvailable();
  const leftMilli = hoursLeftOf(account);
  const hours = hoursText(leftMilli, to);
  const currentDiskGb = computer?.diskGb ?? null;
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
    if (!to || !changed) return;
    setBusy(timing);
    setError(null);
    try {
      const job = await changeCloudLaneTier({ instanceId: facts.instanceId, sizeId: to.id, timing, diskGb: growDiskGb, requestId, requestedByChat });
      onStarted?.(job);
    } catch (startError) {
      setError(ipcErrorMessage(startError) || "ADE couldn't change the size. Try again in a moment.");
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
    <div className={cn("adecl-tier", className)} data-cloud-tier-card={requestId ?? "person"}>
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
            extraHourCents={account?.extraHours?.available ? cloudCatalogOf(account).extraHourCents : null}
            markId={facts.fromSizeId}
            markLabel="Now"
            ariaLabel="New size"
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
            {from ? `${rateText(from)} to ` : ""}{rateText(to)}
          </span>
        </div>
      ) : null}

      {changed ? (
        <dl className="adecl-tier-facts">
          {facts.reason ? (<><dt>Why</dt><dd>{facts.reason}</dd></>) : null}
          {hours ? (<><dt>Hours</dt><dd>{hours}</dd></>) : null}
          {diskLine || diskGrow.choices.length || diskGrow.why ? (
            <>
              <dt>Disk</dt>
              <dd>
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
        {changed ? (
          <label className="adecl-tier-now-check">
            <input type="checkbox" checked={stopTurn} onChange={(event) => setStopTurn(event.target.checked)} />
            <span>Stop the running turn and do it now</span>
          </label>
        ) : <span />}
        <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={busy != null} onClick={onNotNow}>Not now</button>
        <button type="button" className="kit-btn adecl-btn-sky" data-size="sm" disabled={!changed || !available || busy != null} onClick={() => void start(stopTurn ? "now" : "idle")}>
          {busy ? "Starting…" : move ? "Move it" : "Change size"}
        </button>
      </div>
    </div>
  );
}
