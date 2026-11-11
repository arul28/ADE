/**
 * "Sign-ins on ADE Cloud": how many of the account's sign-ins ADE Cloud uses,
 * the one off switch for all of them, and the way to Providers › ADE Cloud,
 * where each one is managed. Self-contained: it reads and writes on its own,
 * so any page can place it (Settings › Integrations › ADE Cloud today).
 *
 * Read: `providerLogins.status({}, accountPin)` on open and on
 * `providerLogins.onChanged`, keyed on the pin's key; a read for an old key is
 * dropped. No timer. Write: `setCloudAll({ on }, accountPin)`, with no confirm
 * (the same switch undoes it); its returned status is the new read.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Key } from "@phosphor-icons/react";
import { isClaudePassKey, type ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { ipcErrorMessage } from "../../../../lib/format";
import { showToast } from "../../../app/toast/toastStore";
import { IntegrationCard } from "../../integrations/IntegrationChrome";
import { SettingsToggle } from "../../primitives/SettingsControls";
import { adeCloudSettingsSearch } from "../../SettingsMachineScope";
import { readClaudePasses } from "./adeCloudSignInModel";
import { useThisComputerPin } from "./useAdeCloudSignIns";
import { usePinnedProviderLoginStatus } from "./usePinnedProviderLoginStatus";

/** The settings anchor of this row; the manifest's `integrations.ade-cloud-sign-ins` points here. */
const ADE_CLOUD_SIGN_INS_ANCHOR = "cloud-sign-ins";

/** Sign-ins ADE Cloud uses now: carried sign-ins in use, saved keys in use, and passes that are on and not ended. */
function adeCloudSignInCount(status: ProviderLoginStatus): number {
  const signIns = status.signIns.filter((signIn) => signIn.inUseOnCloud && !isClaudePassKey(signIn.key)).length;
  const keys = Object.values(status.cloud.inUse).filter((key) => key === "key").length;
  const passes = readClaudePasses(status).filter((pass) => !pass.unreadable && pass.on && pass.state !== "ended").length;
  return signIns + keys + passes;
}

export function AdeCloudSignInsRow({
  onCount,
}: {
  /** The count when ADE Cloud uses the account's sign-ins, 0 when they are off, null before a read. */
  onCount?: (count: number | null) => void;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.ade?.providerLogins;
  const { accountPin } = useThisComputerPin();
  const pinRef = useRef(accountPin);
  pinRef.current = accountPin;
  const navigate = useNavigate();
  const location = useLocation();
  const { status, failed, apply } = usePinnedProviderLoginStatus({ pin: accountPin });
  const [pending, setPending] = useState<boolean | null>(null);

  const enabled = pending ?? status?.cloud.enabled ?? false;
  const count = status ? (status.cloud.enabled ? adeCloudSignInCount(status) : 0) : null;
  useEffect(() => {
    onCount?.(count);
  }, [count, onCount]);

  const setAll = useCallback(async (on: boolean) => {
    const pin = pinRef.current;
    const key = pin?.key ?? null;
    setPending(on);
    try {
      const next = await bridge?.setCloudAll?.({ on }, pin);
      if (next) apply(key, next);
    } catch (error) {
      showToast({
        tone: "error",
        title: on ? "ADE couldn't turn on sign-ins for ADE Cloud" : "ADE couldn't turn off sign-ins for ADE Cloud",
        message: ipcErrorMessage(error) || "Try again.",
      });
    } finally {
      setPending(null);
    }
  }, [apply, bridge]);

  if (typeof bridge?.status !== "function") return null;

  const openProviders = () => {
    navigate({ pathname: location.pathname, search: adeCloudSettingsSearch() });
  };

  const summary = failed && !status
    ? "ADE couldn't read your sign-ins. It tries again when they change."
    : !status
      ? "Reading your sign-ins…"
      : !status.cloud.enabled
        ? "Sign-ins are off for ADE Cloud."
        : count === 0
          ? "ADE Cloud uses none of your sign-ins yet. Sign in to a provider on one of your computers, and it reaches ADE Cloud."
          : `ADE Cloud uses ${count} of your sign-in${count === 1 ? "" : "s"}.`;

  return (
    <IntegrationCard
      anchor={ADE_CLOUD_SIGN_INS_ANCHOR}
      icon={<Key size={15} weight="fill" />}
      title="Sign-ins on ADE Cloud"
      hint={summary}
      actions={(
        <button type="button" className="ade-modern-btn" data-size="sm" onClick={openProviders}>
          Show in Providers
        </button>
      )}
    >
      <div className="ade-ig-limit-rows">
        <div className="ade-ig-limit-row">
          <div>
            <b>Use my sign-ins on ADE Cloud</b>
            <small>When it is off, each cloud computer signs in on its own.</small>
          </div>
          <SettingsToggle
            checked={enabled}
            disabled={!status || pending !== null}
            label="Use my sign-ins on ADE Cloud"
            onChange={(on) => void setAll(on)}
          />
        </div>
      </div>
    </IntegrationCard>
  );
}
