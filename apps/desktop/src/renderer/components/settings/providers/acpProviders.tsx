/**
 * The providers ADE reaches over the Agent Client Protocol.
 *
 * They share a host, so they share almost everything here: one status reader,
 * one facts builder, one auth-actions component. What differs per provider is
 * data — the label, the login command, the config-home env var, and the one
 * honest-degradation note Kimi needs — so it lives in a table rather than in
 * four near-identical descriptors.
 *
 * ADE runs its own pinned copy of each CLI, downloaded for the machine that
 * runs it, and picks its version; the page's pinned-tool row shows that copy
 * and its Download/Retry. Sign-in stays the vendor's own, in its own config
 * home.
 */
import React from "react";
import { FolderSimple, Key, Terminal, Warning, Wrench } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { listModelDescriptorsForProvider, providerTierIsPreview } from "../../../../shared/modelRegistry";
import { ACP_PROVIDER_METADATA } from "../../../../shared/acpProviderMetadata";
import { SubsectionTitle } from "./providerUi";
import { AntigravitySignIn } from "./bodies/AntigravitySignIn";
import type {
  AcpSettingsProviderId,
  ProviderDescriptor,
  ProviderFact,
  ProviderModelRow,
  ProviderStatusView,
  ProvidersViewContext,
} from "./types";
import { statusProbeFailed } from "./types";

type AcpProviderSpec = {
  id: AcpSettingsProviderId;
  label: string;
  tagline: string;
  /** Family the logo table keys off. */
  logoFamily: string;
  /**
   * What to run in a terminal to sign in. Also what the embedded modal runs.
   * Null for Antigravity, whose sign-in is ADE's own action (no terminal).
   */
  loginCommand: string | null;
  /** Environment variable that names its config directory, when it has one. */
  configHomeEnv: string | null;
  /** Where credentials come from, in one plain sentence. */
  credentialSource: string;
  /**
   * How to set this CLI up. ADE downloads and runs its own copy, but sign-in
   * and the CLI's own configuration stay the vendor's.
   */
  setup: string;
  /** One line about a capability this provider does not have. Rendered plainly. */
  degradation?: string;
};

/**
 * Kimi's usage signals are thinner than other providers'. Shown in its facts
 * and in its own Usage section.
 */
const KIMI_DEGRADATION_NOTE =
  "Token and context figures appear when Kimi reports them. Kimi sends no compaction events, so ADE detects compaction from a drop in context size.";

export const ACP_PROVIDER_SPECS: readonly AcpProviderSpec[] = [
  {
    ...ACP_PROVIDER_METADATA.qwen,
    id: "qwen",
    tagline: "ADE's pinned Qwen Code, with your Qwen configuration.",
    logoFamily: "qwen",
    credentialSource: "OPENAI_API_KEY (and optional OPENAI_BASE_URL), a custom provider in ~/.qwen/settings.json, or `qwen --auth-type=openai` / `qwen --auth-type=openai-responses`. Recent releases no longer ship the `qwen auth` subcommand.",
    setup: "ADE downloads Qwen Code for this machine. Configure it the way Qwen documents; ADE does not write ~/.qwen. Point Qwen at DashScope, OpenRouter, or any OpenAI-compatible server (OPENAI_BASE_URL plus a dummy or real key). Models you add with /model show up here after a refresh.",
  },
  {
    ...ACP_PROVIDER_METADATA.kimi,
    id: "kimi",
    tagline: "Uses your Moonshot account through the kimi CLI.",
    logoFamily: "kimi",
    credentialSource: "Signed in through `kimi login`; stored in its config.toml. ADE does not write that file.",
    setup: "ADE downloads Kimi Code for this machine; sign in with `kimi login` (Sign in runs it with ADE's copy). Use `--region global` for kimi.ai or `--region mainland-cn` for kimi.com. ADE reuses ~/.kimi-code and does not configure Kimi for you. On Windows the binary needs Git for Windows, because Git Bash is its shell.",
    // Stated plainly rather than hidden behind a tooltip: Kimi's usage signals
    // are thinner than other providers', and a user who is not told why will
    // read a gap as a bug in ADE.
    degradation: KIMI_DEGRADATION_NOTE,
  },
  {
    ...ACP_PROVIDER_METADATA.grok,
    id: "grok",
    tagline: "Uses your grok login, or XAI_API_KEY.",
    logoFamily: "xai",
    credentialSource: "Signed in through `grok login` (GROK_HOME/auth.json, default ~/.grok/auth.json), or XAI_API_KEY. ADE does not write Grok's config.",
    setup: "ADE downloads the Grok CLI for this machine; sign in with `grok login` (Sign in runs it with ADE's copy), or set XAI_API_KEY. ADE passes GROK_HOME through to the ACP process and defaults to ~/.grok. Permission cards in ADE chats are the ones ADE can honour; Grok's own defaultMode is not the source of truth.",
  },
  {
    ...ACP_PROVIDER_METADATA.devin,
    id: "devin",
    tagline: "ADE's pinned Devin CLI, with your Devin login.",
    logoFamily: "devin",
    credentialSource: "`devin auth login`, or WINDSURF_API_KEY.",
    setup: "ADE downloads the Devin CLI for this machine; sign in with `devin auth login` (Sign in runs it with ADE's copy).",
    degradation: "No org Knowledge, Playbooks, or Secrets in local sessions.",
  },
  {
    ...ACP_PROVIDER_METADATA.antigravity,
    id: "antigravity",
    tagline: "Google's Antigravity agent, with your Google sign-in.",
    logoFamily: "antigravity",
    credentialSource: "Antigravity's own sign-in (Google account or Gemini Enterprise), kept by the agent under ~/.gemini/antigravity-acp (the macOS keychain on a Mac); or a Gemini API key / Agent Platform credentials. Separate from the Antigravity app's and the agy CLI's login.",
    setup: "ADE downloads Google's Antigravity ACP agent for this machine and signs it in here: pick a method and choose Sign in. ADE does not write ~/.gemini; the agent saves its own login there, shared with other apps that run it.",
    degradation: "No rewind or edit of earlier turns, and no read-only Plan mode (use Antigravity's /plan). Subagent work shows as tool activity.",
  },
];

function specFor(id: AcpSettingsProviderId): AcpProviderSpec {
  const found = ACP_PROVIDER_SPECS.find((spec) => spec.id === id);
  if (!found) throw new Error(`Unknown ACP provider ${id}`);
  return found;
}

/**
 * Status for one ACP provider.
 *
 * Read from the same `providerConnections` entry every other CLI provider uses,
 * so the vocabulary matches: the auth detector proves presence and a credential
 * artifact, and `acpAuthProbe` promotes or demotes that through the runtime
 * health channel the connection status already folds in.
 */
function acpStatus(ctx: ProvidersViewContext, id: AcpSettingsProviderId): ProviderStatusView {
  const spec = specFor(id);
  if (statusProbeFailed(ctx)) {
    return {
      state: "attention",
      label: "Needs attention",
      message: `Could not load ${spec.label} status.`,
      errorLine: ctx.statusLoadError,
    };
  }
  if (ctx.isInitialCheckInFlight) {
    return {
      state: "checking",
      label: "Checking…",
      message: `Checking whether ${spec.label} is on this machine and signed in.`,
    };
  }
  const connection = ctx.status?.providerConnections?.[id] ?? null;
  if (!connection) {
    // The host answered without an entry for this provider, which means it is
    // running a build that predates it — not that the CLI is missing.
    return {
      state: "not-installed",
      label: "Not downloaded",
      message: `This machine did not report ${spec.label} status.`,
    };
  }
  if (connection.runtimeAvailable) {
    return { state: "connected", label: "Connected", message: "Connection verified." };
  }
  if (connection.runtimeDetected) {
    return {
      state: "sign-in",
      label: "Sign in required",
      message: connection.blocker
        ?? (spec.loginCommand
          ? `${spec.label} is ready but no login was detected. Run \`${spec.loginCommand}\`.`
          : `${spec.label} is ready but not signed in. Sign in below.`),
    };
  }
  // ADE's copy is not on this machine yet; the host's sentence says whether it
  // is downloading, failed, or has no build for this machine.
  const blocker = connection.blocker
    ?? `ADE downloads ${spec.label} for this machine the first time it is used.`;
  return {
    state: "not-installed",
    label: "Not downloaded",
    message: blocker,
    errorLine: connection.blocker ?? null,
  };
}

/**
 * Models for one ACP provider.
 *
 * Curated rows and anything a live session discovered arrive together from the
 * registry, in the order the picker uses, with the provider's default first.
 * The status payload's copy is preferred when the host sent one, because it has
 * already been filtered by what this machine can actually reach.
 */
function acpModels(ctx: ProvidersViewContext, id: AcpSettingsProviderId): ProviderModelRow[] {
  const fromStatus = ctx.status?.models?.[id] ?? null;
  const registry = listModelDescriptorsForProvider(id);
  const defaultId = registry[0]?.id ?? null;
  if (fromStatus?.length) {
    return fromStatus.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      isDefault: model.id === defaultId,
    }));
  }
  return registry.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.displayName,
    isDefault: descriptor.id === defaultId,
  }));
}

function acpFacts(ctx: ProvidersViewContext, id: AcpSettingsProviderId): ProviderFact[] {
  const spec = specFor(id);
  const diagnostics = ctx.acpDiagnostics[id] ?? null;
  const connectionPath = ctx.status?.providerConnections?.[id]?.path ?? null;
  const binary = diagnostics?.binaryPath ?? connectionPath;
  const configHome = diagnostics?.configHome ?? null;
  return [
    ...(binary ? [{ label: "Binary", value: binary, mono: true, icon: <Terminal size={12} weight="bold" /> }] : []),
    ...(configHome
      ? [{
          label: spec.configHomeEnv ? `Config home (${spec.configHomeEnv})` : "Config home",
          value: configHome,
          mono: true,
          icon: <FolderSimple size={12} weight="bold" />,
        }]
      : []),
    { label: "Credentials", value: spec.credentialSource, icon: <Key size={12} weight="bold" /> },
    { label: "Setup", value: spec.setup, icon: <Wrench size={12} weight="bold" /> },
    ...(spec.degradation ? [{ label: "Known limitation", value: spec.degradation, icon: <Warning size={12} weight="bold" /> }] : []),
  ];
}

/**
 * Version, only where a version was actually read.
 *
 * `--version` is a spawn, so it is not on the status path: it arrives with the
 * detail page's diagnostics load. Until then there is nothing to render, and
 * rendering a guess would be worse than rendering nothing.
 */
function acpVersion(ctx: ProvidersViewContext, id: AcpSettingsProviderId): string | null {
  return ctx.acpDiagnostics[id]?.version ?? null;
}

/**
 * The tile's one-line credential for an ACP provider.
 *
 * The detector proves exactly one thing about these four: whether the CLI wrote
 * a credential file (`~/.grok/auth.json` and friends). It cannot tell a
 * subscription from an API key the way `providerConnections[].sources` can for
 * the CLI providers, so this says only what was actually established — a
 * connection that works with no credential file on disk (an env key) gets an
 * empty slot rather than an invented "API key".
 */
function acpCredentialLine(ctx: ProvidersViewContext, id: AcpSettingsProviderId): string | null {
  if (ctx.isInitialCheckInFlight) return null;
  return ctx.status?.providerConnections?.[id]?.authAvailable ? "Signed in" : null;
}

function AcpAuthActions({ ctx, id }: { ctx: ProvidersViewContext; id: AcpSettingsProviderId }) {
  const spec = specFor(id);
  const status = acpStatus(ctx, id);
  if (status.state === "checking") return null;
  // No terminal login: ADE runs the agent's own `authenticate` on that
  // machine. Shown when connected too, to switch method or account.
  if (!spec.loginCommand) return <AntigravitySignIn ctx={ctx} />;
  if (status.state === "connected") return null;
  // Signed in and only waiting on the download: the pinned-tool row says so.
  if (status.state === "not-installed" && ctx.status?.providerConnections?.[id]?.authAvailable) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        style={outlineButton({ height: 28 })}
        onClick={() => ctx.actions.openSignInTerminal(id)}
      >
        Sign in
      </button>
      <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
        Opens a terminal on this machine and runs <code style={{ fontFamily: MONO_FONT }}>{spec.loginCommand}</code> with
        ADE's copy (downloading it first if needed). It closes itself once you are signed in.
      </div>
    </div>
  );
}

/**
 * The vendor's own `doctor`, for the two CLIs that ship one.
 *
 * Its output goes into the copyable report alongside status, version, binary
 * path, config home, and the last probe error, so one paste answers "what does
 * this machine think about this provider".
 */
function AcpDiagnostics({ ctx, id }: { ctx: ProvidersViewContext; id: AcpSettingsProviderId }) {
  const spec = specFor(id);
  const diagnostics = ctx.acpDiagnostics[id] ?? null;
  const error = ctx.acpDiagnosticsError[id] ?? null;
  const busy = ctx.acpDoctorBusy === id;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        style={outlineButton({ height: 28 })}
        disabled={busy}
        onClick={() => void ctx.actions.runAcpDoctor(id)}
      >
        {busy ? "Running…" : `Run ${spec.id} doctor`}
      </button>
      {error ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, lineHeight: 1.5, color: COLORS.danger, overflowWrap: "anywhere" }}>
          {error}
        </div>
      ) : null}
      {diagnostics?.doctor ? (
        <pre
          style={{
            margin: 0,
            maxHeight: 220,
            overflow: "auto",
            fontSize: 10,
            fontFamily: MONO_FONT,
            lineHeight: 1.5,
            color: COLORS.textSecondary,
            background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)",
            border: `1px solid ${COLORS.border}`,
            padding: "8px 10px",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {diagnostics.doctor.output}
        </pre>
      ) : null}
    </div>
  );
}

/** Kimi's honest-degradation note, stated where a user would look for it. */
function KimiBody() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <SubsectionTitle>Usage</SubsectionTitle>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
        {KIMI_DEGRADATION_NOTE}
      </div>
    </div>
  );
}

/**
 * Devin Cloud rides the same CLI login as local Devin (`devin acp --cloud`),
 * so there is nothing extra to configure here — the page only says so and
 * points at where cloud sessions live.
 */
function DevinBody() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <SubsectionTitle>Devin Cloud</SubsectionTitle>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
        Devin Cloud uses your Devin CLI login
        (<span style={{ fontFamily: MONO_FONT }}>devin auth login</span>) — no
        API token needed. Cloud sessions appear in the Devin Cloud panel in the
        top bar.
      </div>
    </div>
  );
}

const ACP_EXTRA_BODIES: Partial<Record<AcpSettingsProviderId, () => React.JSX.Element>> = {
  kimi: KimiBody,
  devin: DevinBody,
};

function buildAcpDescriptor(spec: AcpProviderSpec): ProviderDescriptor {
  const ExtraBody = ACP_EXTRA_BODIES[spec.id];
  return {
    id: spec.id,
    label: spec.label,
    tagline: spec.tagline,
    logo: (size) => <ProviderLogo family={spec.logoFamily} size={size} />,
    // The tier is a property of the models, so it is read from the registry
    // rather than restated here — a model graduating out of preview moves this
    // chip on its own.
    preview: providerTierIsPreview(spec.id),
    // All four share one permission vocabulary because they share one host.
    permissions: {
      family: spec.id === "kimi" ? "moonshot" : spec.id === "grok" ? "xai" : spec.id === "devin" ? "devin" : spec.id === "antigravity" ? "antigravity" : "qwen",
      isCliWrapped: true,
      key: spec.id,
    },
    status: (ctx) => acpStatus(ctx, spec.id),
    models: (ctx) => acpModels(ctx, spec.id),
    version: (ctx) => acpVersion(ctx, spec.id),
    facts: (ctx) => acpFacts(ctx, spec.id),
    credentialLine: (ctx) => acpCredentialLine(ctx, spec.id),
    AuthActions: ({ ctx }) => <AcpAuthActions ctx={ctx} id={spec.id} />,
    ...(spec.id === "grok" || spec.id === "kimi"
      ? { Diagnostics: ({ ctx }: { ctx: ProvidersViewContext }) => <AcpDiagnostics ctx={ctx} id={spec.id} /> }
      : {}),
    ...(ExtraBody ? { Body: ExtraBody } : {}),
  };
}

export const ACP_PROVIDER_DESCRIPTORS: ProviderDescriptor[] = ACP_PROVIDER_SPECS.map(buildAcpDescriptor);

/** The terminal command that signs a user in to one provider. */
export function acpLoginCommand(id: string): string | null {
  return ACP_PROVIDER_SPECS.find((spec) => spec.id === id)?.loginCommand ?? null;
}

export function acpProviderLabel(id: string): string | null {
  return ACP_PROVIDER_SPECS.find((spec) => spec.id === id)?.label ?? null;
}
