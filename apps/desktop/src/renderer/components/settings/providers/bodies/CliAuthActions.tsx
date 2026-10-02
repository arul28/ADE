/**
 * Auth for the three CLI providers ADE only observes: Claude, Codex, Droid.
 *
 * Claude and Codex sign in through the same guided sheet the Accounts panel
 * uses, run on the Settings page's own machine: the provider's login command
 * for the default account, with its link and code shown in the sheet. Droid has
 * no such flow, so the honest surface there is the command to run.
 */
import React, { useState } from "react";
import { SignIn } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { CopyableCommand } from "../providerUi";
import { AddProviderAccountSheet } from "../accounts/AddProviderAccountSheet";
import { useProviderInstances } from "../accounts/useProviderInstances";
import { providerColor } from "../../../usage/providerColors";
import { useAppStore } from "../../../../state/appStore";
import type { ProviderInstanceProvider } from "../../../../../shared/types/providerInstances";
import { cliTool, installHintFor } from "../cliTools";
import type { ProvidersViewContext } from "../types";

/** Signs the provider's default account in through the guided sheet. */
function DefaultAccountSignIn({ provider, providerLabel }: { provider: ProviderInstanceProvider; providerLabel: string }) {
  const theme = useAppStore((state) => state.theme);
  const { instances, bridgeMissing, reload } = useProviderInstances(provider);
  const [open, setOpen] = useState(false);
  const defaultInstance = instances.find((instance) => instance.isDefault) ?? null;
  // An older host has no account bridge; the command still works there.
  if (bridgeMissing || !defaultInstance) return <CopyableCommand command={provider === "claude" ? "claude auth login" : "codex login"} />;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
      >
        <SignIn size={13} /> Sign in to {providerLabel}
      </button>
      {open ? (
        <AddProviderAccountSheet
          provider={provider}
          providerLabel={providerLabel}
          existingInstance={defaultInstance}
          defaultAccent={providerColor(provider, theme)}
          onClose={(changed) => {
            setOpen(false);
            if (changed) void reload();
          }}
        />
      ) : null}
    </>
  );
}

export function ClaudeAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  const availability = ctx.status?.availableProviders?.claude ?? null;
  if (ctx.isInitialCheckInFlight) return null;
  if (!availability?.binary.present) {
    return <CopyableCommand command={installHintFor(cliTool("claude"))} />;
  }
  if (!availability.auth.ready) {
    return <DefaultAccountSignIn provider="claude" providerLabel="Claude Code" />;
  }
  return null;
}

function CliAuthActions({ ctx, cli }: { ctx: ProvidersViewContext; cli: "codex" | "droid" }) {
  const tool = cliTool(cli);
  const connection = ctx.status?.providerConnections?.[cli] ?? null;
  if (ctx.isInitialCheckInFlight || connection?.runtimeAvailable) return null;
  const needsInstall = !connection?.runtimeDetected;
  if (cli === "codex" && !needsInstall) return <DefaultAccountSignIn provider="codex" providerLabel="Codex" />;
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
