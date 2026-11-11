/**
 * The one app banner that warns when a Claude pass for ADE Cloud ends soon,
 * may have ended, or ended (design §4.5), or when a key ADE Cloud carries ends
 * on the date its provider set (Cloud 5 decision 2; never a guessed date). Mounted once in the app shell; it
 * renders nothing itself and registers its banner with the host.
 *
 * Cost: no read of its own. Desktop main adds `passEnd` to the answer of
 * `cloudAccess.read()`, the read every window already makes on open and on
 * focus, and computes it from the local pass store only while ADE Cloud is on
 * (`main/services/adeCloud/cloudSignInEndWarning.ts`). Off: nothing is read.
 *
 * One button. A pass: Renew, the same approve sheet as the ADE Cloud page, for
 * that pass. A key: Replace, that provider's ADE Cloud page, where the person
 * signs in again or adds a key. Dismissed, it stays away until a sign-in
 * changes state (once per state).
 */
import type { NavigateFunction } from "react-router-dom";
import type { CloudSignInEnd } from "../../../../../shared/cloudSignIns";
import { useAdeCloudEnabled, useAdeCloudPassEnd } from "../../../../state/cloudAccess";
import { ProviderLogo } from "../../../shared/ProviderLogos";
import { APP_BANNER_PRIORITY, useAppBanner } from "../../../ui/notice";
import { adeCloudSettingsSearch } from "../../SettingsMachineScope";
import { adeCloudEndNoticeWords } from "./adeCloudEndNotice";

/** Settings › Providers › ADE Cloud › Claude with the renew sheet for one pass, or the key's provider page. */
function actionRoute(end: CloudSignInEnd): string {
  if (end.kind === "key") return `/settings${adeCloudSettingsSearch({ provider: end.provider })}`;
  return `/settings${adeCloudSettingsSearch({ provider: "claude", renew: end.key })}`;
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
          // The notice is about the provider: its logo, as for any integration's notice.
          icon: <ProviderLogo family={end.kind === "key" ? end.provider : "claude"} size={13} />,
          title: words.title,
          detail: words.detail,
          actions: [{ label: words.action, variant: "primary", onClick: () => navigate(actionRoute(end)) }],
          dismiss: { key: "ade-cloud-pass-end", fingerprint: end.fingerprint },
        }
      : null,
    { priority: APP_BANNER_PRIORITY.integration },
  );
  return null;
}
