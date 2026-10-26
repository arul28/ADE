/**
 * "This local site's certificate is not trusted": the one place a person can
 * trust a self-signed dev certificate.
 *
 * Main only sets `loadError.certificate` for a local or private address and a
 * dev-certificate error, so a public site's certificate failure never reaches
 * this banner. It is a state of the tab (it stays until the tab loads
 * something else), so it is an inline `Banner` above the page, where the page
 * itself would be blank. It names the host and shows the fingerprint, so the
 * person can compare it with what their server printed before trusting it.
 */
import { ShieldWarning } from "@phosphor-icons/react";
import type { BuiltInBrowserCertificateProblem } from "../../../../shared/types/builtInBrowser";
import { Banner } from "../../ui/notice/Banner";

function endpointLabel(problem: BuiltInBrowserCertificateProblem): string {
  const host = problem.host.includes(":") ? `[${problem.host}]` : problem.host;
  return problem.port === 443 ? host : `${host}:${problem.port}`;
}

function reasonLine(problem: BuiltInBrowserCertificateProblem): string {
  if (problem.error === "net::ERR_CERT_COMMON_NAME_INVALID") {
    return `Its certificate is for a different name than ${problem.host}.`;
  }
  if (problem.error === "net::ERR_CERT_DATE_INVALID") {
    return "Its certificate has expired or is not valid yet.";
  }
  return "Its certificate is self-signed, or from an issuer this computer doesn't trust.";
}

export function BrowserCertificateBanner({
  problem,
  isolatedProfile,
  busy,
  error,
  onTrust,
}: {
  problem: BuiltInBrowserCertificateProblem;
  /** The tab's throwaway sign-in, if any: its approvals end when it closes. */
  isolatedProfile: string | null;
  busy: boolean;
  error: string | null;
  onTrust: () => void;
}) {
  const scope = isolatedProfile
    ? `Applies to the "${isolatedProfile}" sign-in until its tabs close.`
    : "Remembered for this site until you remove it in Settings → ADE browser.";
  const issued = [
    problem.subjectName ? `Issued to ${problem.subjectName}` : null,
    problem.issuerName ? `by ${problem.issuerName}` : null,
  ].filter(Boolean).join(" ");
  // Neutral, not warning: nothing is broken. The page is blank until the
  // person decides, and the copy already says when to say yes.
  return (
    <Banner
      layout="inline"
      testId="browser-certificate-banner"
      model={{
        id: `browser-certificate-${problem.fingerprint}`,
        tone: "neutral",
        icon: <ShieldWarning size={14} weight="regular" />,
        title: `${endpointLabel(problem)} isn't trusted`,
        detail: `${reasonLine(problem)} Only trust it if this is your own server.`,
        extra: (
          <div
            className="mt-1 truncate font-mono text-[10.5px] text-muted-fg/60"
            title={[`SHA-256 ${problem.fingerprintHex}`, issued].filter(Boolean).join("\n")}
          >
            SHA-256 {problem.fingerprintHex}
          </div>
        ),
        busy,
        error: error ?? undefined,
        actions: [
          { label: "Trust and reload", onClick: onTrust, disabled: busy, title: scope },
        ],
      }}
    />
  );
}
