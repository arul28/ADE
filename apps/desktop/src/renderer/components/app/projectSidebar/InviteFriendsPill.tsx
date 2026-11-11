import { useCallback, useEffect } from "react";
import { Gift } from "@phosphor-icons/react";
import { Banner } from "../../ui/notice";
import { useRootAppStore } from "../../../state/appStore";
import { isStarPillVisible } from "../../../lib/starPill";
import {
  INVITE_PILL_MAX_DISMISSALS,
  INVITE_PILL_SNOOZE_MESSAGES,
  captureInviteAnalytics,
  invitePillShowing,
  isInvitePillVisible,
  updateInvitePill,
  useInvitePillPrefs,
} from "../../../lib/invitePill";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { useHeaderCloudAccount } from "../../usage/HeaderCloudMeter";

/**
 * "Invite friends, get free cloud hours": the desktop pill in the star pill's
 * place. It shows only to an account ADE Cloud lets in that has used it, and
 * never while the star pill is up (one nudge at a time). The rules are in
 * `lib/invitePill.ts`; a click opens the invite card in Settings › ADE Cloud.
 */
export function InviteFriendsPill() {
  const account = useHeaderCloudAccount();
  const prefs = useInvitePillPrefs();
  const starUp = isStarPillVisible(useRootAppStore((s) => s.starPill));
  const visible = !starUp && isInvitePillVisible(prefs, account);
  const showing = invitePillShowing(prefs);

  // Once per showing, not per mount.
  useEffect(() => {
    if (!visible || prefs.shownReported > prefs.dismissCount) return;
    captureInviteAnalytics({ action: "invite_pill_shown", outcome: showing });
    updateInvitePill((prev) => ({ ...prev, shownReported: prev.dismissCount + 1 }));
  }, [prefs.dismissCount, prefs.shownReported, showing, visible]);

  const open = useCallback(() => {
    captureInviteAnalytics({ action: "invite_pill_clicked", outcome: showing });
    navigateToAppTarget({ kind: "settings", tab: "ade-cloud", anchor: "cloud-invite" });
  }, [showing]);

  const dismiss = useCallback(() => {
    captureInviteAnalytics({ action: "invite_pill_dismissed", outcome: showing });
    updateInvitePill((prev) => ({
      ...prev,
      dismissCount: prev.dismissCount + 1,
      snoozedUntilMessageCount: prev.messagesSent + INVITE_PILL_SNOOZE_MESSAGES,
    }));
  }, [showing]);

  if (!visible) return null;
  const last = prefs.dismissCount >= INVITE_PILL_MAX_DISMISSALS - 1;
  return (
    <div className="ade-star-pill">
      <Banner
        layout="floating"
        testId="invite-friends-pill"
        model={{
          id: "invite-friends",
          tone: "accent",
          icon: <Gift size={14} weight="fill" />,
          ariaLabel: "Invite friends, get free cloud hours",
          title: (
            <button type="button" className="ade-star-pill-link" onClick={open}>
              Invite friends, get free cloud hours
            </button>
          ),
          dismiss: {
            onDismiss: dismiss,
            title: last ? "Don't show again" : `Hide for ${INVITE_PILL_SNOOZE_MESSAGES} messages`,
            label: "Hide the invite prompt",
          },
        }}
      />
    </div>
  );
}
