import React from "react";
import { ModernPage, SettingsColumn } from "./primitives";
import { QuickSlotsSection } from "./QuickSlotsSection";

/**
 * Settings › Keyboard. Quick slots are a per-window preference (the keys are
 * read by this renderer), so the page is filed under This computer and never
 * follows a remote machine.
 */
export function KeyboardSection() {
  return (
    <SettingsColumn wide>
      <ModernPage>
        <QuickSlotsSection />
      </ModernPage>
    </SettingsColumn>
  );
}
