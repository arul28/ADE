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
    return `It was issued for a different name than ${problem.host}.`;
  }
  if (problem.error === "net::ERR_CERT_DATE_INVALID") {
    return "It has expired or is not valid yet.";
  }
  return "It is self-signed, or signed by an issuer this computer does not trust.";
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
    ? `Trusting it applies to the "${isolatedProfile}" sign-in until its tabs close.`
    : "Trusting it is remembered for this site until you remove it in Settings → ADE browser.";
  return (
    <Banner
      layout="inline"
      testId="browser-certificate-banner"
      model={{
        id: `browser-certificate-${problem.fingerprint}`,
        tone: "warning",
        icon: <ShieldWarning size={14} weight="bold" />,
        title: `${endpointLabel(problem)} uses a certificate ADE doesn't trust`,
        detail: `${reasonLine(problem)} Only trust it if this is your own server. ${scope}`,
        extra: (
          <div className="mt-1 space-y-0.5 text-[10.5px] text-muted-fg/75">
            <div className="break-all font-mono" title={problem.fingerprint}>
              SHA-256 {problem.fingerprintHex}
            </div>
            {problem.subjectName || problem.issuerName ? (
              <div className="truncate">
                {problem.subjectName ? `Issued to ${problem.subjectName}` : null}
                {problem.subjectName && problem.issuerName ? " · " : null}
                {problem.issuerName ? `by ${problem.issuerName}` : null}
              </div>
            ) : null}
          </div>
        ),
        busy,
        error: error ?? undefined,
        actions: [
          { label: "Trust and reload", onClick: onTrust, disabled: busy },
        ],
      }}
    />
  );
}
