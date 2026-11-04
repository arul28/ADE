import React, { useMemo } from "react";
import { Keyboard } from "@phosphor-icons/react";
import type { KeybindingsSnapshot } from "../../../../shared/types";
import { readKeybindingsSnapshot } from "../../../lib/keybindingStore";
import { isWebClientMode } from "../../../lib/webClientMode";
import { useAppStore } from "../../../state/appStore";
import { useQuickSlotsStore } from "../../../quickSlots/quickSlotsStore";
import { SettingsColumn } from "../primitives";
import { IntegrationHero, type IntegrationFact } from "../integrations/IntegrationChrome";
import { integrationThemeVars, type IntegrationHeroBrand } from "../integrations/integrationBrand";
import { currentKeyboardPlatform, KeyCaps, leaderKeyCaps, useShortcutNotes } from "./keyboardParts";
import { QuickSlotsCards } from "./QuickSlotsCards";
import { ShortcutsCard } from "./ShortcutsCard";
import "./keyboardPage.css";

/** Keyboard wears a cool blue, the way ADE MCP wears ADE's violet. */
const KEYBOARD_ACCENT = "#5B8DEF";
const PAGE_VARS = integrationThemeVars(KEYBOARD_ACCENT);

function keyboardBrand(web: boolean): IntegrationHeroBrand {
  return {
    label: "Keyboard",
    tagline: web
      ? "Every shortcut and Quick slot in this browser. Change a key once and every project uses it."
      : "Every shortcut and Quick slot on this computer. Change a key once and every project and window uses it.",
    accent: KEYBOARD_ACCENT,
    banner: {
      background: [
        "radial-gradient(55% 130% at 70% 0%, rgba(96, 165, 250, 0.40), transparent 62%)",
        "radial-gradient(45% 120% at 0% 110%, rgba(45, 212, 191, 0.18), transparent 60%)",
        "linear-gradient(120deg, #0E1A33 0%, #13264D 50%, #1A3366 100%)",
      ].join(", "),
    },
    logo: { kind: "solid", mark: (size) => <Keyboard size={size} weight="fill" />, face: "#FFFFFF", side: "#1E3A8A", size: 72 },
  };
}

/**
 * Settings › Keyboard: a banner with what this keyboard is set to, then the
 * shortcuts, then Quick slots and the model profiles they can run. One page,
 * because a chord can only mean one thing: the shortcut list flags a chord a
 * Quick slot would take first, and the Quick slots card names the shortcuts
 * its leader hides.
 */
export function KeyboardPage() {
  const platform = useMemo(currentKeyboardPlatform, []);
  const web = isWebClientMode();
  const snapshot: KeybindingsSnapshot = useAppStore((state) => state.keybindings) ?? readKeybindingsSnapshot();
  const leader = useQuickSlotsStore((state) => state.leader);
  const slots = useQuickSlotsStore((state) => state.slots);
  const notes = useShortcutNotes(snapshot, leader, platform, web);
  const brand = useMemo(() => keyboardBrand(web), [web]);

  const changed = snapshot.overrides.length;
  const assigned = slots.filter((slot) => slot.commandId).length;
  const status = notes.size
    ? { tone: "warn" as const, label: notes.size === 1 ? "1 shortcut needs a look" : `${notes.size} shortcuts need a look` }
    : changed
      ? { tone: "ok" as const, label: changed === 1 ? "1 shortcut changed by you" : `${changed} shortcuts changed by you` }
      : { tone: "neutral" as const, label: "ADE's default keys" };
  const facts: IntegrationFact[] = [
    { label: "Shortcuts", value: `${snapshot.definitions.length} actions` },
    { label: "Changed", value: changed ? `${changed} by you` : "None" },
    {
      label: "Main modifier",
      value: platform === "mac" ? "⌘ Command" : "Ctrl",
      title: platform === "mac" ? "Shortcuts use ⌘ on this Mac." : "Shortcuts use Ctrl on this computer.",
    },
    { label: "Saved", value: web ? "In this browser" : "On this computer" },
  ];

  return (
    <SettingsColumn wide>
      <div className="ade-pv-provider ade-ig-page ade-kbp-page" style={PAGE_VARS}>
        <IntegrationHero
          brand={brand}
          className="ade-kbp-hero"
          anchor="keyboard"
          group="Keyboard"
          status={status}
          panel={(
            <>
              <span className="ade-ig-hero-panel-label">Quick slots</span>
              <div className="ade-kbp-hero-chord">
                <KeyCaps keys={leaderKeyCaps(leader, platform)} size="lg" />
                <span className="ade-kbp-hero-plus">+</span>
                <KeyCaps keys={["1–9"]} size="lg" />
              </div>
              <p className="ade-ig-hero-panel-empty">
                Hold the keys, then tap a digit. {assigned} of {slots.length} slots set.
              </p>
              <div className="ade-ig-hero-panel-actions">
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  onClick={() => document.getElementById("quick-slots")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  Edit slots
                </button>
              </div>
            </>
          )}
          facts={facts}
        />

        <ShortcutsCard snapshot={snapshot} notes={notes} platform={platform} web={web} leader={leader} />
        <QuickSlotsCards snapshot={snapshot} platform={platform} />
      </div>
    </SettingsColumn>
  );
}
