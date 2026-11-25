import { useState } from "react";
import { Check, Copy, Gift } from "@phosphor-icons/react";
import {
  CLOUD_REFERRAL_REWARD_MILLI,
  cloudReferralOf,
  formatCloudDate,
  formatCloudHours,
  type CloudAccountState,
  type CloudReferralSummary,
} from "../../../../shared/adeCloud";
import { captureInviteAnalytics } from "../../../lib/invitePill";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { showToast } from "../../app/toast/toastStore";
import "./cloudDashboard.css";
import { cloudUnitWords } from "../../../../shared/cloudUnitWords";

/**
 * "Paste an invite link or code": the friend's side of an invite. Used on the
 * dashboard's invite card and in Settings › Account (for 30 days after the
 * account was made). Account level, so no pin; the server checks every rule.
 */
export function InviteCodeBox({
  initialCode = "",
  onDone,
  noun = "credits",
}: {
  /** Read once: give the box a `key` of the code so a new link fills it again. */
  initialCode?: string;
  onDone?: (referral: CloudReferralSummary | null) => void;
  /** What the reward is called (`cloudUnitWords`). */
  noun?: "credits";
}) {
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const redeem = window.ade?.cloud?.redeemInvite;
  // The web app has no code box: its stand-in for the member is truthy, so ask whether it is real.
  if (!isAdeAvailable(redeem)) return null;
  const submit = async () => {
    const value = code.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await redeem(value);
      if (outcome.ok) {
        captureInviteAnalytics({ action: "invite_code_entered", outcome: "accepted" });
        const reward = formatCloudHours(outcome.referral?.rewardMilli || CLOUD_REFERRAL_REWARD_MILLI);
        showToast({
          tone: "success",
          title: outcome.rewarded ? `You both got ${reward} free cloud ${noun}` : "Invite added",
          message: outcome.rewarded ? "They never expire." : `You both get ${reward} free cloud ${noun} when your first chat runs on ADE Cloud.`,
        });
        onDone?.(outcome.referral);
      } else {
        captureInviteAnalytics({ action: "invite_code_entered", outcome: `refused_${outcome.reason}` });
        setError(outcome.message);
      }
    } catch {
      captureInviteAnalytics({ action: "invite_code_entered", outcome: "refused_unavailable" });
      setError("ADE couldn't check that code. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="adecd-invite-enter"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        className="kit-input"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="Paste an invite link or code"
        aria-label="Invite link or code"
        aria-invalid={error ? "true" : undefined}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="kit-btn" data-size="sm" disabled={busy || !code.trim()}>
        {busy ? "Checking…" : "Add invite"}
      </button>
      {error ? <span className="adecd-invite-error" role="alert">{error}</span> : null}
    </form>
  );
}

/**
 * The dashboard's invite card: the person's own link to share, how many
 * friends joined and the credits earned, and (while they may) a box to enter
 * someone else's invite.
 */
export function CloudInviteCard({ account, onChanged }: { account: CloudAccountState; onChanged: () => void }) {
  const referral = cloudReferralOf(account);
  const [copied, setCopied] = useState(false);
  const { noun, Noun } = cloudUnitWords(account);
  if (!referral) return null;
  const reward = formatCloudHours(referral.rewardMilli);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(referral.link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      captureInviteAnalytics({ action: "invite_link_copied", outcome: "from_dashboard" });
    } catch {
      showToast({ tone: "error", title: "Couldn't copy the link", message: referral.link });
    }
  };
  return (
    <section id="cloud-invite" className="kit-card adecd-card adecd-invite" aria-label="Invite friends">
      <header className="kit-card-head">
        <Gift size={14} />
        Invite friends, get free cloud {noun}
      </header>
      <div className="kit-card-body adecd-invite-body">
        <div className="adecd-invite-main">
          <p className="adecd-lead">
            When a friend you invite runs their first chat on ADE Cloud, you both get {reward} free {noun}. They never expire, and they're used after your plan's {noun}.
          </p>
          <div className="adecd-invite-link">
            <span className="kit-num" title={referral.link}>{referral.link}</span>
            <button type="button" className="kit-btn kit-btn-primary adecd-brandbtn" data-size="sm" onClick={() => void copy()}>
              {copied ? <><Check size={12} weight="bold" />Copied</> : <><Copy size={12} />Copy link</>}
            </button>
          </div>
        </div>
        <dl className="adecd-invite-stats">
          <div className="kit-panel"><dt>Friends joined</dt><dd className="kit-num" data-face="ui">{referral.friendsJoined}</dd></div>
          <div className="kit-panel"><dt>{Noun} earned</dt><dd className="kit-num" data-face="ui">{formatCloudHours(referral.hoursEarnedMilli)}</dd></div>
          <div className="kit-panel"><dt>Rewards left</dt><dd className="kit-num" data-face="ui">{referral.rewardsLeft} of {referral.rewardLimit}</dd></div>
        </dl>
        {referral.canEnterCode && !referral.hasReferrer ? (
          <div className="adecd-invite-friend">
            <b>Were you invited?</b>
            <small>{referral.enterCodeUntil ? `Add the link or code by ${formatCloudDate(referral.enterCodeUntil)}.` : "Add the link or code."}</small>
            <InviteCodeBox onDone={onChanged} noun={noun} />
          </div>
        ) : referral.hasReferrer ? (
          <p className="adecd-invite-note">
            {referral.referredState === "rewarded"
              ? `You were invited, and you both got ${reward} ${noun}.`
              : referral.referredState === "refused"
                ? `You were invited, but that invite can't give ${noun} on this account.`
                : `You were invited. You both get ${reward} ${noun} when your first chat runs on ADE Cloud.`}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Settings › Account: "Were you invited?", for 30 days after the account was
 * made and only while ADE Cloud is on for it. An `ade://invite/<CODE>` link
 * opens here with `?invite=<CODE>` filled in.
 */
export function AccountInviteFact({ account, inviteParam }: { account: CloudAccountState | null; inviteParam: string | null }) {
  const [done, setDone] = useState(false);
  const referral = cloudReferralOf(account);
  const { noun } = cloudUnitWords(account);
  if (!referral || done || !referral.canEnterCode || referral.hasReferrer) return null;
  return (
    <div className="ade-acct-fact" id="account-invite" data-settings-anchor="account-invite">
      <dt><Gift size={13} weight="bold" />Invite</dt>
      <dd className="adecd-acct-invite">
        <span className="ade-acct-fact-note">
          Were you invited? You both get {formatCloudHours(referral.rewardMilli)} free cloud {noun}.
          {referral.enterCodeUntil ? ` Add it by ${formatCloudDate(referral.enterCodeUntil)}.` : ""}
        </span>
        <InviteCodeBox key={inviteParam ?? ""} initialCode={inviteParam ?? ""} onDone={() => setDone(true)} noun={noun} />
      </dd>
    </div>
  );
}
