/**
 * Auth for the CLI providers ADE only observes: Claude, Codex, Droid, Copilot.
 *
 * Claude and Codex sign in through the same guided sheet the Accounts panel
 * uses, run on the Settings page's own machine: the provider's login command
 * for the default account, with its link and code shown in the sheet. Droid
 * and Copilot sign in through the agent CLI sheet (`AgentCliSignInSheet`),
 * the same flow without accounts; an older host shows the command to run.
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
import { SettingsAgentCliSignIn } from "../AgentCliSignInSheet";
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
    onChanged: (signedIn) => {
      void reload();
      // A sign-in that worked gets the CLI's own check, which reads the
      // status again after it.
      void (signedIn ? ctx.actions.verifySignIn(provider) : ctx.actions.refreshStatus({ force: true, silent: true }));
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
  if (ctx.isInitialCheckInFlight) return null;
  if (connection?.runtimeAvailable || connection?.authAvailable) {
    // Copilot can sign in again (switch accounts, renew). Droid cannot: signed
    // in, its CLI opens a normal session instead of a login, so only the host
    // of a sheet still showing its result stays. Codex has accounts.
    if (cli === "copilot") return <SettingsAgentCliSignIn ctx={ctx} provider="copilot" providerLabel={tool.label} fallback={null} again />;
    if (cli === "droid") return <SettingsAgentCliSignIn ctx={ctx} provider="droid" providerLabel={tool.label} fallback={null} offered={false} />;
    return null;
  }
  if (cli === "codex") return <DefaultAccountSignIn ctx={ctx} provider="codex" providerLabel="Codex" />;
  const commandToRun = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        Sign in from a terminal, then refresh:
      </div>
      <CopyableCommand command={tool.loginCmd} />
    </div>
  );
  return (
    <SettingsAgentCliSignIn
      ctx={ctx}
      provider={cli}
      providerLabel={tool.label}
      fallback={commandToRun}
    />
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
