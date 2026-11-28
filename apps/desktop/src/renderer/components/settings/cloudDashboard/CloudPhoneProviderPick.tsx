import { useState } from "react";
import { DeviceMobile } from "@phosphor-icons/react";
import type { CloudPhoneProviderChoice } from "../../../../shared/cloudPhone";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { SettingsSelect } from "../primitives/SettingsControls";
import { BRAND } from "../../../../shared/brand";

const CHOICES: readonly { value: CloudPhoneProviderChoice; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "nomac", label: "NoMac" },
  { value: "revyl", label: "Revyl" },
];

const LABELS: Readonly<Record<CloudPhoneProviderChoice, string>> = { auto: "Auto", nomac: "NoMac", revyl: "Revyl" };

/**
 * Who runs a tester's ADE Cloud iPhones: Auto (the server's order), NoMac or
 * Revyl. Only for an account the server sends `phone.providerChoice` to (the
 * iPhone's beta list), and only in a tester build (`isTesterBuild`); nobody
 * else ever sees a provider's name. The pick is the account's, so the call
 * takes no pin. The next phone starts there; a running one keeps its own.
 */
export function CloudPhoneProviderPick({ choice, onChanged }: { choice: CloudPhoneProviderChoice; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const set = window.ade?.cloud?.setPhoneProvider;
  const available = isAdeAvailable(set);
  const pick = async (next: CloudPhoneProviderChoice) => {
    if (!available || next === choice) return;
    setBusy(true);
    try {
      const answer = await set(next);
      showToast({ tone: "success", title: `Cloud iPhone provider: ${LABELS[answer.provider]}`, message: "The next cloud iPhone starts there. A running one keeps its own." });
      onChanged();
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't change the cloud iPhone provider", message: ipcErrorMessage(error) || "Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kit-panel adecd-addon">
      <div className="adecd-addon-top">
        <span className="adecd-addon-icon"><DeviceMobile size={15} weight="duotone" /></span>
        <b>Cloud iPhone provider (testers)</b>
        <SettingsSelect
          value={choice}
          disabled={busy || !available}
          ariaLabel="Cloud iPhone provider (testers)"
          style={{ minWidth: 0 }}
          options={CHOICES}
          onChange={(value) => void pick(value)}
        />
      </div>
      <small className="adecd-addon-state">
        {available
          ? "Auto starts phones in the usual order. Only testers see this."
          : `This version of ${BRAND.NAME} can't change it here. Use ade cloud phone-provider.`}
      </small>
    </div>
  );
}
