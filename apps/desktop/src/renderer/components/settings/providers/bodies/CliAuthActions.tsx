/**
 * Auth for the three CLI providers ADE only observes: Claude, Codex, Droid.
 *
 * Claude and Codex sign in through the same guided sheet the Accounts panel
 * uses, run on the Settings page's own machine: the provider's login command
 * for the default account, with its link and code shown in the sheet. Droid has
 * no such flow, so the honest surface there is the command to run.
 *
 * None of these offers an install: ADE runs its own pinned copy, and the
 * page's pinned-tool row downloads it. A login run before that download lands
 * waits for it on that machine.
 */
import React from "react";
import { SignIn } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { CopyableCommand } from "../providerUi";
import { useAccountSignInSheet } from "../accounts/AddProviderAccountSheet";
import { useDefaultProviderInstance } from "../accounts/useProviderInstances";
import type { ProviderInstanceProvider } from "../../../../../shared/types/providerInstances";
import { cliTool } from "../cliTools";
import type { ProvidersViewContext } from "../types";

/** The login command for a host with no account bridge. */
const FALLBACK_LOGIN_COMMAND: Record<ProviderInstanceProvider, string> = {
  claude: "claude auth login",
  codex: "codex login",
};

/** Signs the provider's default account in through the guided sheet. */
function DefaultAccountSignIn({
  ctx,
  provider,
  providerLabel,
}: {
  ctx: ProvidersViewContext;
  provider: ProviderInstanceProvider;
  providerLabel: string;
}) {
  const { instance, bridgeMissing, reload } = useDefaultProviderInstance(provider);
  const sheet = useAccountSignInSheet({
    provider,
    providerLabel,
    // The card's own "Sign in" state comes from the AI status, not the
    // account list, so both are read again.
    onChanged: () => {
      void reload();
      void ctx.actions.refreshStatus({ force: true, silent: true });
    },
  });
  // An older host has no account bridge; the command still works there.
  if (bridgeMissing || !instance) return <CopyableCommand command={FALLBACK_LOGIN_COMMAND[provider]} />;
  return (
    <>
      <button
        type="button"
        onClick={() => sheet.open({ existing: instance })}
        style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
      >
        <SignIn size={13} /> Sign in to {providerLabel}
      </button>
      {sheet.element}
    </>
  );
}

export function ClaudeAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  const availability = ctx.status?.availableProviders?.claude ?? null;
  if (ctx.isInitialCheckInFlight) return null;
  if (!availability?.auth.ready) {
    return <DefaultAccountSignIn ctx={ctx} provider="claude" providerLabel="Claude Code" />;
  }
  return null;
}

function CliAuthActions({ ctx, cli }: { ctx: ProvidersViewContext; cli: "codex" | "droid" | "copilot" }) {
  const tool = cliTool(cli);
  const connection = ctx.status?.providerConnections?.[cli] ?? null;
  // Signed in already: what is left is the download, which the pinned-tool
  // row above shows.
  if (ctx.isInitialCheckInFlight || connection?.runtimeAvailable || connection?.authAvailable) return null;
  if (cli === "codex") return <DefaultAccountSignIn ctx={ctx} provider="codex" providerLabel="Codex" />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        Sign in from a terminal, then refresh:
      </div>
      <CopyableCommand command={tool.loginCmd} />
    </div>
  );
}

export function CodexAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  return <CliAuthActions ctx={ctx} cli="codex" />;
}

export function DroidAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  return <CliAuthActions ctx={ctx} cli="droid" />;
}

export function CopilotAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  return <CliAuthActions ctx={ctx} cli="copilot" />;
}
