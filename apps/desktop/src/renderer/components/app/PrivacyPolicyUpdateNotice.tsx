import { useCallback, useState } from "react";
import { ShieldCheck } from "@phosphor-icons/react";

import { PRIVACY_CHANGES_URL } from "../../../shared/legalLinks";
import { openExternalUrl } from "../../lib/openExternal";
import { markPrivacyPolicyNoticeSeen, privacyPolicyNoticeSeen } from "../../lib/privacyPolicyNotice";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { BRAND } from "../../../shared/brand";

/**
 * "We updated our Privacy Policy", once per policy version on this window's
 * origin. Any answer (read it, Got it, ×) counts as seen. It sends no
 * analytics event.
 */
export function PrivacyPolicyUpdateNotice(): null {
  const [visible, setVisible] = useState(() => !privacyPolicyNoticeSeen());

  const close = useCallback(() => {
    markPrivacyPolicyNoticeSeen();
    setVisible(false);
  }, []);

  useAppBanner(
    visible
      ? {
          id: "privacy-policy-updated",
          tone: "info",
          icon: <ShieldCheck size={14} weight="bold" />,
          title: "We updated our Privacy Policy",
          detail: `It now lists everything ${BRAND.NAME} collects and where it goes, and adds sponsored cards on the ${BRAND.CLOUD_NAME} Free plan.`,
          actions: [
            {
              label: "Read what changed",
              variant: "solid",
              // For the ↗ glyph; `onClick` opens it and records the answer.
              href: PRIVACY_CHANGES_URL,
              onClick: () => {
                openExternalUrl(PRIVACY_CHANGES_URL);
                close();
              },
            },
            { label: "Got it", variant: "secondary", onClick: close },
          ],
          dismiss: { onDismiss: close },
        }
      : null,
    { placement: "floating", priority: APP_BANNER_PRIORITY.prompt },
  );

  return null;
}
