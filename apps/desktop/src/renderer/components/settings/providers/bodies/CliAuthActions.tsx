/**
 * Auth for the three CLI providers ADE only observes: Claude, Codex, Droid.
 * ADE cannot sign you in to any of them from here, so the honest surface is the
 * command to run — except Claude, which can open a real login terminal in Work.
 */
import React from "react";
import { COLORS, SANS_FONT } from "../../../lanes/laneDesignTokens";
import { ClaudeLoginPromptButton } from "../../../work/ClaudeLoginPromptButton";
import { CopyableCommand } from "../providerUi";
import { cliTool, installHintFor } from "../cliTools";
import type { ProvidersViewContext } from "../types";
import { useSettingsMachineScope } from "../../SettingsMachineScope";

export function ClaudeAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  // The login terminal button opens its shell on the tab's own machine. For
  // any other machine, say where to run it instead of opening it in the wrong place.
  const { pin, machineName } = useSettingsMachineScope();
  const availability = ctx.status?.availableProviders?.claude ?? null;
  if (ctx.isInitialCheckInFlight) return null;
  if (availability?.binary.present && !availability.auth.ready && pin) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
          Run this in a terminal on {machineName} to sign in:
        </span>
        <CopyableCommand command="claude" />
      </div>
    );
  }
  if (availability?.binary.present && !availability.auth.ready) {
    return (
      <div style={{ display: "flex" }}>
        <ClaudeLoginPromptButton
          visible
          storageKey="settings:claude-auth"
          dismissible={false}
          onTerminalCreated={ctx.actions.revealClaudeLoginTerminal}
        />
      </div>
    );
  }
  if (!availability?.binary.present) {
    return <CopyableCommand command={installHintFor(cliTool("claude"))} />;
  }
  return null;
}

function CliAuthActions({ ctx, cli }: { ctx: ProvidersViewContext; cli: "codex" | "droid" }) {
  const tool = cliTool(cli);
  const connection = ctx.status?.providerConnections?.[cli] ?? null;
  if (ctx.isInitialCheckInFlight || connection?.runtimeAvailable) return null;
  const needsInstall = !connection?.runtimeDetected;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        {needsInstall ? "Install it, then refresh:" : "Sign in from a terminal, then refresh:"}
      </div>
      <CopyableCommand command={needsInstall ? installHintFor(tool) : tool.loginCmd} />
    </div>
  );
}

export function CodexAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  return <CliAuthActions ctx={ctx} cli="codex" />;
}

export function DroidAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  return <CliAuthActions ctx={ctx} cli="droid" />;
}
