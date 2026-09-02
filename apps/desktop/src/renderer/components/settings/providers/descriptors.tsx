/**
 * The six providers ADE ships today, as descriptors.
 *
 * Everything provider-specific lives here or in `bodies/`. The grid, the tile,
 * and the detail page below read nothing but this table, which is what lets a
 * seventh provider be an entry rather than another four hundred lines of JSX.
 */
import React from "react";
import { ClaudeLogo, CodexLogo, CursorAgentLogo, OpenCodeLogo } from "../../terminals/ToolLogos";
import { PiLogo, ProviderLogo } from "../../shared/ProviderLogos";
import { cursorProviderAvailable } from "../../../lib/platform";
import { buildPiMessage } from "../PiProvidersPanel";
import {
  buildClaudeAvailabilityMessage,
  buildCliMessage,
  cliTool,
  describeCredentialSource,
  shortCredentialSource,
} from "./cliTools";
import { ClaudeAuthActions, CodexAuthActions, DroidAuthActions } from "./bodies/CliAuthActions";
import { CursorAuthActions, CursorBody, cursorOauthSignedIn } from "./bodies/CursorBody";
import { PiBody } from "./bodies/PiBody";
import { OpenCodeBody } from "./bodies/OpenCodeBody";
import { ACP_PROVIDER_DESCRIPTORS } from "./acpProviders";
import type {
  ProviderDescriptor,
  ProviderFact,
  ProviderModelRow,
  ProviderStatusView,
  ProvidersViewContext,
  SettingsProviderId,
} from "./types";
import { statusProbeFailed } from "./types";

// The six words a tile is allowed to say — sentence case, no ellipsis-free
// exceptions. "Verification failed" and "Unavailable" used to leak out of two
// descriptors, which made the grid's vocabulary seven and eight words long.
const CHECKING: ProviderStatusView = {
  state: "checking",
  label: "Checking…",
  message: "Checking availability and login status.",
};

function pathFacts(path: string | null | undefined, label = "Path"): ProviderFact[] {
  return path ? [{ label, value: path, mono: true }] : [];
}

function credentialFacts(ctx: ProvidersViewContext, cli: "claude" | "codex" | "cursor" | "droid"): ProviderFact[] {
  const connection = ctx.status?.providerConnections?.[cli] ?? null;
  const description = describeCredentialSource(connection);
  if (!description || connection?.runtimeAvailable || ctx.isInitialCheckInFlight) return [];
  return [{ label: "Credentials", value: description }];
}

/** The tile's one-line credential, read from the same source as the fact row. */
function credentialLine(ctx: ProvidersViewContext, cli: "claude" | "codex" | "cursor" | "droid" | "pi"): string | null {
  if (ctx.isInitialCheckInFlight) return null;
  return shortCredentialSource(ctx.status?.providerConnections?.[cli] ?? null);
}

function descriptorModels(rows: Array<{ id: string; label: string; description?: string; default?: boolean }>): ProviderModelRow[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    isDefault: row.default === true,
  }));
}

function probeFailedView(ctx: ProvidersViewContext, who: string): ProviderStatusView {
  return {
    state: "attention",
    label: "Needs attention",
    message: `Could not load ${who} status.`,
    errorLine: ctx.statusLoadError,
  };
}

/** Status for the three providers ADE only detects on PATH. */
function cliStatus(ctx: ProvidersViewContext, cli: "codex" | "droid" | "cursor"): ProviderStatusView {
  if (statusProbeFailed(ctx)) return probeFailedView(ctx, cliTool(cli).label);
  if (ctx.isInitialCheckInFlight) return CHECKING;
  const tool = cliTool(cli);
  const connection = ctx.status?.providerConnections?.[cli] ?? null;
  const message = buildCliMessage(tool, connection);
  if (connection?.runtimeAvailable) {
    return { state: "connected", label: "Connected", message };
  }
  if (connection?.runtimeDetected || connection?.authAvailable) {
    return { state: "sign-in", label: "Sign in required", message };
  }
  return { state: "not-installed", label: "Not installed", message, errorLine: connection?.blocker ?? null };
}

export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: "claude",
    label: "Claude Code",
    tagline: cliTool("claude").authStory,
    logo: (size) => <ClaudeLogo size={size} />,
    permissions: { family: "anthropic", isCliWrapped: true, key: "claude" },
    status: (ctx) => {
      if (statusProbeFailed(ctx)) return probeFailedView(ctx, "Claude Code");
      if (ctx.isInitialCheckInFlight) {
        return { ...CHECKING, message: "Checking Claude SDK binary and login status." };
      }
      const availability = ctx.status?.availableProviders?.claude ?? null;
      const message = buildClaudeAvailabilityMessage(availability);
      if (availability?.binary.present && availability.auth.ready) {
        return { state: "connected", label: "Connected", message };
      }
      if (availability?.binary.present) {
        return { state: "sign-in", label: "Sign in required", message };
      }
      return { state: "not-installed", label: "Not installed", message, errorLine: message };
    },
    models: (ctx) => descriptorModels(ctx.status?.models?.claude ?? []),
    facts: (ctx) => [
      ...pathFacts(ctx.status?.availableProviders?.claude?.binary.path ?? ctx.status?.providerConnections?.claude?.path, "Binary"),
      ...credentialFacts(ctx, "claude"),
    ],
    credentialLine: (ctx) => credentialLine(ctx, "claude"),
    AuthActions: ClaudeAuthActions,
  },
  {
    id: "codex",
    label: "Codex CLI",
    tagline: cliTool("codex").authStory,
    logo: (size) => <CodexLogo size={size} className="text-zinc-100" />,
    permissions: { family: "openai", isCliWrapped: true, key: "codex" },
    status: (ctx) => cliStatus(ctx, "codex"),
    models: (ctx) => descriptorModels(ctx.status?.models?.codex ?? []),
    facts: (ctx) => [
      ...pathFacts(ctx.status?.providerConnections?.codex?.path, "Binary"),
      ...credentialFacts(ctx, "codex"),
    ],
    credentialLine: (ctx) => credentialLine(ctx, "codex"),
    AuthActions: CodexAuthActions,
  },
  {
    id: "cursor",
    label: "Cursor",
    tagline: cliTool("cursor").authStory,
    logo: (size) => <CursorAgentLogo size={size} />,
    // Hidden entirely on Windows on ARM: @cursor/sdk has no win32-arm64 build,
    // so the card could only ever offer a provider that cannot start.
    // See shared/providerPlatformSupport.ts.
    isAvailable: () => cursorProviderAvailable(),
    permissions: { family: "cursor", isCliWrapped: true, key: "cursor" },
    status: (ctx) => {
      if (statusProbeFailed(ctx)) return probeFailedView(ctx, "Cursor");
      const verification = ctx.verificationByProvider.cursor;
      if (ctx.verifyingProvider === "cursor") {
        return { state: "checking", label: "Checking…", message: "Verifying Cursor API key with the Cursor SDK." };
      }
      if (verification?.ok) {
        return {
          state: "connected",
          label: "Connected",
          message: "Cursor SDK connected. ADE uses this key for Cursor chat and Cursor Cloud agents.",
        };
      }
      if (verification && !verification.ok) {
        return {
          state: "attention",
          label: "Needs attention",
          message: verification.message,
          errorLine: verification.message,
        };
      }
      if (ctx.isInitialCheckInFlight) {
        return { ...CHECKING, message: "Checking Cursor SDK API key." };
      }
      const base = cliStatus(ctx, "cursor");
      const message = ctx.status?.providerConnections?.cursor?.blocker
        ?? (base.state === "connected" ? base.message : "Sign in with Cursor or enter a Cursor API key.");
      // OAuth can show an email on the detail page while ADE still needs a
      // verified Cursor API key for chat. Do not label that "Sign in required".
      if (base.state === "sign-in" && cursorOauthSignedIn(ctx)) {
        return { state: "attention", label: "Needs attention", message };
      }
      return { ...base, message };
    },
    models: (ctx) => descriptorModels(ctx.status?.models?.cursor ?? []),
    facts: (ctx) => [
      ...pathFacts(ctx.status?.providerConnections?.cursor?.path, "SDK"),
      ...credentialFacts(ctx, "cursor"),
    ],
    credentialLine: (ctx) => credentialLine(ctx, "cursor"),
    AuthActions: CursorAuthActions,
    Body: CursorBody,
  },
  {
    id: "droid",
    label: "Droid",
    tagline: cliTool("droid").authStory,
    logo: (size) => <ProviderLogo family="factory" size={size} />,
    permissions: { family: "factory", isCliWrapped: true, key: "droid" },
    status: (ctx) => cliStatus(ctx, "droid"),
    models: (ctx) => descriptorModels(ctx.status?.models?.droid ?? []),
    facts: (ctx) => [
      ...pathFacts(ctx.status?.providerConnections?.droid?.path, "Binary"),
      ...credentialFacts(ctx, "droid"),
    ],
    credentialLine: (ctx) => credentialLine(ctx, "droid"),
    AuthActions: DroidAuthActions,
  },
  {
    id: "pi",
    label: "Pi",
    tagline: "Uses Pi’s installed SDK package and redacted auth status from its native profile.",
    logo: (size) => <PiLogo size={size} />,
    permissions: { family: "pi", isCliWrapped: false, key: "pi" },
    status: (ctx) => {
      const installation = ctx.status?.piInstallation ?? null;
      const connection = ctx.status?.providerConnections?.pi ?? null;
      const loadFailed = ctx.isInitialCheckInFlight && !ctx.loading && ctx.statusLoadError !== null;
      if (loadFailed) {
        return {
          state: "attention",
          label: "Needs attention",
          message: `Could not load Pi status: ${ctx.statusLoadError}`,
          errorLine: ctx.statusLoadError,
        };
      }
      if (ctx.isInitialCheckInFlight) {
        return { ...CHECKING, message: "Checking Pi installation and provider inventory." };
      }
      const message = buildPiMessage(connection, installation);
      const errorLine = installation?.error ? `Inventory fallback: ${installation.error}` : null;
      if (connection?.runtimeAvailable) {
        return { state: "connected", label: "Connected", message, errorLine };
      }
      if (!installation?.installed && !connection?.runtimeDetected) {
        return { state: "not-installed", label: "Not installed", message, errorLine };
      }
      if (installation?.installed && !installation.sdkAvailable) {
        return { state: "attention", label: "Needs attention", message, errorLine: errorLine ?? message };
      }
      return { state: "sign-in", label: "Sign in required", message, errorLine };
    },
    models: (ctx) => (ctx.status?.piInstallation?.availableModelIds ?? []).map((id) => ({ id, label: id })),
    version: (ctx) => {
      const installation = ctx.status?.piInstallation ?? null;
      if (!installation?.version) return null;
      return installation.stale ? `${installation.version} · cached` : installation.version;
    },
    facts: (ctx) => pathFacts(ctx.status?.providerConnections?.pi?.path, "Path"),
    credentialLine: (ctx) => credentialLine(ctx, "pi"),
    Body: PiBody,
  },
  {
    id: "opencode",
    label: "OpenCode",
    tagline: "SuperGrok OAuth, ChatGPT, Copilot, or API keys — the same providers OpenCode connects.",
    logo: (size) => <OpenCodeLogo size={size} />,
    permissions: { family: "opencode", isCliWrapped: true, key: "opencode" },
    status: (ctx) => {
      const known = ctx.status !== null;
      if (!known) {
        const loadFailed = !ctx.loading && ctx.statusLoadError !== null;
        if (loadFailed) {
          return {
            state: "attention",
            label: "Needs attention",
            message: "Could not load OpenCode status.",
            errorLine: ctx.statusLoadError,
          };
        }
        return { ...CHECKING, message: "Checking OpenCode and its provider catalog…" };
      }
      if (ctx.status?.opencodeBinaryInstalled === false) {
        return {
          state: "not-installed",
          label: "Not installed",
          message: "OpenCode powers every subscription, API key, and local model. Install it, then re-check.",
        };
      }
      if (ctx.status?.opencodeInventoryError) {
        return {
          state: "attention",
          label: "Needs attention",
          message: "OpenCode is installed, but its provider catalog could not be read.",
          errorLine: ctx.status.opencodeInventoryError,
        };
      }
      const connected = ctx.connectedOpenCodeProviders.length;
      return {
        state: "connected",
        label: "Connected",
        message: connected === 0
          ? "OpenCode is installed. No model providers are connected yet."
          : `OpenCode is installed with ${connected} connected provider${connected === 1 ? "" : "s"}.`,
      };
    },
    models: (ctx) => (ctx.status?.availableModelIds ?? []).map((id) => ({ id, label: String(id) })),
    facts: (ctx) => {
      const source = ctx.status?.opencodeBinarySource;
      return source ? [{ label: "Binary", value: source }] : [];
    },
    // OpenCode holds no credential of its own — every one belongs to a
    // sub-provider inside it, and naming one of forty on the tile would be
    // arbitrary. The count of connected providers is already in the message.
    credentialLine: () => null,
    Body: OpenCodeBody,
  },
  // The four ACP providers. They are built from one shared table rather than
  // written out here, because everything that differs between them is data.
  ...ACP_PROVIDER_DESCRIPTORS,
];

const BY_ID = new Map(PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor] as const));

/**
 * The status a tile and a page should show.
 *
 * "Disabled" outranks everything a probe could say: whether the CLI is present
 * or signed in is not the question once the user has switched the provider off,
 * and reporting "Connected" for a provider that offers no models would be a
 * lie. Read through this rather than calling `descriptor.status` directly.
 */
export function providerStatusFor(
  descriptor: ProviderDescriptor,
  ctx: ProvidersViewContext,
): ProviderStatusView {
  if (ctx.disabledProviders.has(descriptor.id)) {
    return {
      state: "disabled",
      label: "Disabled",
      message: `${descriptor.label} is switched off. Its models do not appear in any picker on this machine.`,
    };
  }
  return descriptor.status(ctx);
}

export function providerDescriptor(id: string): ProviderDescriptor | null {
  return BY_ID.get(id as SettingsProviderId) ?? null;
}

/** Descriptors this platform can actually run. */
export function availableProviderDescriptors(): ProviderDescriptor[] {
  return PROVIDER_DESCRIPTORS.filter((descriptor) => descriptor.isAvailable?.() !== false);
}
