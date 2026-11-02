import React from "react";
import { ModernPage, SettingsColumn } from "./primitives";
import { KeyboardShortcutsSection } from "./KeyboardShortcutsSection";
import { QuickSlotsSection } from "./QuickSlotsSection";

/**
 * Settings › Keyboard: ADE's shortcuts, then Quick slots. One page, because a
 * chord can only mean one thing — the shortcut editor flags a chord a Quick
 * slot would take first.
 */
export function KeyboardSection() {
  return (
    <SettingsColumn wide>
      <ModernPage>
        <KeyboardShortcutsSection />
        <QuickSlotsSection />
      </ModernPage>
    </SettingsColumn>
  );
}
