import { IntegrationCard } from "./IntegrationChrome";
import { SettingsTextField } from "../primitives";

const AGENT37_LOGO_PATHS = [
  "M226.31 69.18 L280.18 69.18 L442.82 231.82 L442.82 278.38 L284.11 437.1 L230.73 437.1 L68.93 275.3 L68.93 226.56 Z",
  "M281.22 70.22 L126.17 225.26 L256.67 355.76",
  "M73.6 221.89 L232.07 380.36 L354.43 258",
  "M230.19 436.56 L381.59 285.16 L249.23 152.8",
  "M438.45 282.76 L278.86 123.17 L151.47 250.56",
] as const;

function Agent37Mark() {
  return (
    <svg viewBox="0 0 512 512" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={26} strokeLinejoin="round" aria-hidden="true">
      {AGENT37_LOGO_PATHS.map((path) => <path key={path} d={path} />)}
    </svg>
  );
}

/**
 * Bring your own cloud provider. Layout only: nothing is wired to it, and it
 * shows only when `BRING_YOUR_OWN_CLOUD_ENABLED` is on.
 */
export function BringYourOwnCloudCard() {
  return (
    <IntegrationCard
      anchor="cloud-own-provider"
      icon={<Agent37Mark />}
      title="Use your own Agent 37 account"
      hint="ADE keeps the key in your ADE account, so every computer you sign in to can use it."
    >
      <div className="ade-ig-form">
        <div className="ade-ig-form-row">
          <SettingsTextField value="" onChange={() => undefined} type="password" placeholder="sk_live_…" ariaLabel="Agent 37 API key" autoComplete="new-password" mono />
          <button type="button" className="ade-modern-btn" data-tone="primary" disabled>Connect</button>
        </div>
      </div>
    </IntegrationCard>
  );
}
