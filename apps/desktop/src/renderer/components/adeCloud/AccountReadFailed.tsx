import type { CSSProperties } from "react";
import { Banner } from "../ui/notice";

/**
 * Codes the server sends when the person, not ADE, can fix the read: an
 * integration to renew or connect, a limit to wait out. These show as a
 * warning with no "Report"; everything else is ADE's failure.
 */
const PERSON_CAN_FIX = new Set([
  "linear_needs_renewal",
  "linear_renewing",
  "linear_not_connected",
  "jira_not_connected",
  "jira_site_unsupported",
  "rate_limited",
  "signed_out",
  "account_blocked",
  "github_app_not_installed",
  "limits_changed",
]);

/**
 * "Couldn't load <what>" with the server's sentence and Retry, for a surface
 * that reads the ADE account with no computer on. A surface shows this in
 * place of its list, never an empty list.
 */
export function AccountReadFailed({
  id,
  what,
  code,
  message,
  onRetry,
  style,
}: {
  /** Stable name of this surface ("cto-copy", "automations-account"). */
  id: string;
  /** What did not load, for the title: "the CTO's notes". */
  what: string;
  code: string;
  message: string;
  onRetry: () => void;
  style?: CSSProperties;
}): JSX.Element {
  const personCanFix = PERSON_CAN_FIX.has(code);
  return (
    <Banner
      layout="inline"
      style={style}
      model={{
        id: `ade-cloud-read-${id}`,
        tone: personCanFix ? "warning" : "error",
        title: `Couldn't load ${what}`,
        detail: message,
        actions: [{ label: "Retry", onClick: onRetry }],
        report: personCanFix ? false : { surface: `ade-cloud.${id}`, code: code || "unknown", technicalDetail: message },
      }}
    />
  );
}
