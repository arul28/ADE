import React from "react";
import { Lightning } from "@phosphor-icons/react";
import { setFastModeEnabled, useFastModeEnabled } from "../../lib/fastModePolicy";
import { showToast } from "../app/toast/toastStore";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";

/**
 * The account's Fast-mode permission, alone at the top of Chat settings.
 *
 * One switch, one explanation of the cost, and the same anchor the locked Fast
 * dialog's Continue deep-links to (`fast-mode`). It lives apart from Composer
 * because it is a spend guardrail, not a chat-appearance choice.
 */
export function FastModeSection() {
  const fastModeEnabled = useFastModeEnabled();

  const handleChange = (next: boolean) => {
    void setFastModeEnabled(next).then((ok) => {
      if (ok) return;
      showToast({
        tone: "error",
        title: "Couldn't change Fast mode",
        message: "ADE's background service isn't available on this computer. Try again in a moment.",
      });
    });
  };

  return (
    <ModernSection
      group="Speed & spend"
      title="Speed & spend"
      hint="The paid faster tier, and who may turn it on."
      icon={<Lightning size={16} weight="fill" />}
      tone="amber"
    >
      <ModernRows>
        <ModernRow
          anchor="fast-mode"
          title="Allow Fast mode"
          hint="About 2× cost (Ultrafast up to 8×). Chats start at Standard; turn Fast on per chat."
          control={(
            <SettingsToggle
              label="Allow Fast mode"
              checked={fastModeEnabled}
              onChange={handleChange}
            />
          )}
        />
      </ModernRows>
    </ModernSection>
  );
}
