/**
 * The one app banner that warns when a Claude pass for ADE Cloud ends soon,
 * may have ended, or ended (design §4.5). Mounted once in the app shell; it
 * renders nothing itself and registers its banner with the host.
 *
 * Cost: no read of its own. Desktop main adds `passEnd` to the answer of
 * `cloudAccess.read()`, the read every window already makes on open and on
 * focus, and computes it from the local pass store only while ADE Cloud is on
 * (`main/services/adeCloud/claudePassEndWarning.ts`). Off: nothing is read.
 *
 * One Renew button: the same approve sheet as the ADE Cloud page, for that
 * pass. Dismissed, it stays away until a pass changes state (once per state).
 */
import type { NavigateFunction } from "react-router-dom";
import { useAdeCloudEnabled, useAdeCloudPassEnd } from "../../../../state/cloudAccess";
import { ProviderLogo } from "../../../shared/ProviderLogos";
import { APP_BANNER_PRIORITY, useAppBanner } from "../../../ui/notice";
import { adeCloudSettingsSearch } from "../../SettingsMachineScope";
import { adeCloudEndNoticeWords } from "./adeCloudEndNotice";

/** Settings › Providers › ADE Cloud › Claude, opening the renew sheet for one pass. */
function renewRoute(renewKey: string): string {
  return `/settings${adeCloudSettingsSearch({ provider: "claude", renew: renewKey })}`;
}

export function CloudSignInEndNotice({ navigate }: { navigate: NavigateFunction }): null {
  const cloudOn = useAdeCloudEnabled();
  const end = useAdeCloudPassEnd();
  const words = cloudOn && end ? adeCloudEndNoticeWords(end, Date.now()) : null;
  useAppBanner(
    words && end
      ? {
          id: "ade-cloud-pass-end",
          // Warning, also for an ended pass: it is the plan's normal end, not an ADE failure to report.
          tone: "warning",
          // The notice is about Claude: its logo, as for any integration's notice.
          icon: <ProviderLogo family="claude" size={13} />,
          title: words.title,
          detail: words.detail,
          actions: [{ label: "Renew", variant: "primary", onClick: () => navigate(renewRoute(end.key)) }],
          dismiss: { key: "ade-cloud-pass-end", fingerprint: end.fingerprint },
        }
      : null,
    { priority: APP_BANNER_PRIORITY.integration },
  );
  return null;
}
