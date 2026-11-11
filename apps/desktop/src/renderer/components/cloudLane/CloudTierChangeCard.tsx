import { useMemo, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { cloudCatalogOf, formatCloudHours, type CloudAccountState } from "../../../shared/adeCloud";
import type { CloudLaneJobSnapshot, CloudLaneTierTiming } from "../../../shared/cloudLaneLife";
import { cloudTiers, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { ipcErrorMessage } from "../../lib/format";
import { CloudMark, CloudSizeIcon } from "../remoteTargets/cloudBrand";
import { cn } from "../ui/cn";
import { CLOUD_LANE_LIFE_UNAVAILABLE, changeCloudLaneTier, cloudLaneLifeAvailable } from "./cloudLaneActions";
import "./cloudLane.css";

/**
 * The one tier-change card: what changes, why, the new rate, what the hours
 * left mean at that size, and the wait. "Yes, when idle" starts once the
 * agent finishes its turn; "Do it now" stops the turn first; "Not now"
 * leaves the size as it is.
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
  return tier ? `${tier.multiplierMilli / 1000}× hours` : "";
}

function hoursText(account: CloudAccountState | null, tier: CloudTier | null): string | null {
  const hours = (account as Partial<CloudAccountState> | null)?.hours;
  if (!hours || !tier || tier.multiplierMilli <= 0) return null;
  const atSize = (hours.leftMilli * 1000) / tier.multiplierMilli;
  return `${formatCloudHours(hours.leftMilli)} h left is about ${formatCloudHours(atSize)} h awake at this size.`;
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
}: {
  facts: CloudTierChangeFacts;
  account: CloudAccountState | null;
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
  const [error, setError] = useState<string | null>(null);
  const from = tiers.find((tier) => tier.id === facts.fromSizeId) ?? null;
  const to = tiers.find((tier) => tier.id === picked) ?? null;
  const move = Boolean(from && to && from.type !== to.type);
  const changed = to != null && to.id !== facts.fromSizeId;
  const available = cloudLaneLifeAvailable();
  const hours = hoursText(account, to);

  const start = async (timing: CloudLaneTierTiming) => {
    if (!to || !changed) return;
    setBusy(timing);
    setError(null);
    try {
      const job = await changeCloudLaneTier({ instanceId: facts.instanceId, sizeId: to.id, timing, requestId, requestedByChat });
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
        <div className="adecl-tier-pick" role="radiogroup" aria-label="New size">
          {tiers.map((tier) => (
            <button
              key={tier.id}
              type="button"
              role="radio"
              aria-checked={tier.id === picked}
              className="adecl-tier-opt"
              onClick={() => setPicked(tier.id)}
            >
              <CloudSizeIcon tier={tier.id} size={20} />
              <b>{tier.label}</b>
              <span className="kit-num">{rateText(tier)}</span>
              {tier.id === facts.fromSizeId ? <span className="adecl-tier-now">now</span> : null}
            </button>
          ))}
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
          <dt>Wait</dt><dd>{waitText(move)}</dd>
        </dl>
      ) : null}

      {error ? <p className="adecl-error" role="alert">{error}</p> : null}
      {!available ? <p className="adecl-muted">{CLOUD_LANE_LIFE_UNAVAILABLE}</p> : null}

      <div className="adecl-tier-actions">
        {changed ? <span className="adecl-muted adecl-tier-when">&quot;Yes, when idle&quot; starts when the agent finishes this turn.</span> : <span />}
        <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={busy != null} onClick={onNotNow}>Not now</button>
        <button type="button" className="kit-btn" data-size="sm" disabled={!changed || !available || busy != null} onClick={() => void start("now")}>
          {busy === "now" ? "Starting…" : "Do it now"}
        </button>
        <button type="button" className="kit-btn adecl-btn-sky" data-size="sm" disabled={!changed || !available || busy != null} onClick={() => void start("idle")}>
          {busy === "idle" ? "Starting…" : "Yes, when idle"}
        </button>
      </div>
    </div>
  );
}
