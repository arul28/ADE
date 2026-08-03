import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AiClaudeAvailability,
  AiConfig,
  AiFeatureKey,
  AiSettingsStatus,
} from "../../../shared/types";
import { ArrowUpRight, Check, Copy, Key } from "@phosphor-icons/react";
import { ClaudeLogo, CodexLogo, CursorAgentLogo, OpenCodeLogo } from "../terminals/ToolLogos";
import { DroidLogo, ProviderLogo } from "../shared/ProviderLogos";
import { COLORS, SANS_FONT, MONO_FONT } from "../lanes/laneDesignTokens";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { openExternalUrl } from "../../lib/openExternal";
import { rendererPlatformAttribute } from "../../lib/platform";
import { docs } from "../../onboarding/docsLinks";
import { InputPopover } from "./InputPopover";
import { RescanButton } from "./RescanButton";
import { BRAND, CARD_BASE, SECTION_LABEL, brandCard } from "./onboardingTheme";

type FeatureKey = AiFeatureKey | "auto_title";

type CliName = "claude" | "codex" | "cursor" | "droid";

type RuntimeMeta = {
  id: CliName | "opencode";
  label: string;
  brand: string;
  Logo: React.ComponentType<{ size?: number }>;
  /** Installation instructions ADE can follow to detect this runtime. */
  docsUrl: string;
  /** Shell command to install the CLI (omit for bundled / API-key runtimes). */
  installCommand?: string;
  /** Shell command to sign in once the CLI is installed. */
  authCommand?: string;
};

// Factory publishes a PowerShell installer for its native Windows build; the
// POSIX shell pipeline is not runnable there. The command shown here is the one
// the user is expected to paste into their own shell.
// https://docs.factory.ai/cli/getting-started/quickstart
const DROID_INSTALL_COMMAND = rendererPlatformAttribute() === "win32"
  ? "irm https://app.factory.ai/cli/windows | iex"
  : "curl -fsSL https://app.factory.ai/cli | sh";

const RUNTIMES: RuntimeMeta[] = [
  { id: "claude", label: "Claude Code", brand: BRAND.claude, Logo: ClaudeLogo, docsUrl: docs.multiAgentSetup, installCommand: "npm install -g @anthropic-ai/claude-code", authCommand: "claude /login" },
  { id: "codex", label: "Codex", brand: BRAND.codex, Logo: CodexLogo, docsUrl: docs.multiAgentSetup, installCommand: "npm install -g @openai/codex", authCommand: "codex login" },
  { id: "cursor", label: "Cursor", brand: BRAND.cursor, Logo: CursorAgentLogo, docsUrl: docs.multiAgentSetup, installCommand: 'mkdir -p "$HOME/.local/bin" && curl https://cursor.com/install -fsS | bash' },
  { id: "droid", label: "Factory Droid", brand: BRAND.droid, Logo: DroidLogo, docsUrl: "https://docs.factory.ai/cli/getting-started/quickstart", installCommand: DROID_INSTALL_COMMAND, authCommand: "droid login" },
  { id: "opencode", label: "OpenCode", brand: BRAND.opencode, Logo: OpenCodeLogo, docsUrl: docs.multiAgentSetup },
];

const FEATURES: Array<{ key: FeatureKey; label: string }> = [
  { key: "terminal_summaries", label: "Terminal summaries" },
  { key: "pr_descriptions", label: "PR descriptions" },
  { key: "commit_messages", label: "Commit messages" },
  { key: "auto_title", label: "Auto-name chats" },
];

export function AiRuntimesBand() {
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const [nextStatus, snapshot] = await Promise.all([
        window.ade.ai.getStatus({ force, refreshOpenCodeInventory: force }),
        window.ade.projectConfig.get(),
      ]);
      setStatus(nextStatus);
      const eff = snapshot.effective?.ai;
      setAiConfig(eff && typeof eff === "object" ? (eff as AiConfig) : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const readyCount = useMemo(() => {
    if (!status) return 0;
    let n = 0;
    if (status.availableProviders.claude.binary.present && status.availableProviders.claude.auth.ready) n++;
    if (status.providerConnections?.codex?.runtimeAvailable) n++;
    if (status.providerConnections?.cursor?.runtimeAvailable) n++;
    if (status.providerConnections?.droid?.runtimeAvailable) n++;
    if (status.opencodeBinaryInstalled !== false) n++;
    return n;
  }, [status]);

  const enabledFeatureMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    if (status?.features) {
      for (const f of status.features) map[f.feature] = f.enabled;
    }
    return map;
  }, [status]);

  const titlesEnabled = aiConfig?.sessionIntelligence?.titles?.enabled ?? false;
  const hasAnyModel = (status?.availableModelIds?.length ?? 0) > 0;
  const availableModelIds = useMemo(() => deriveConfiguredModelIds(status), [status]);

  const selectedModelFor = (key: FeatureKey): string => {
    if (key === "auto_title") return aiConfig?.sessionIntelligence?.titles?.modelId ?? "";
    if (key === "terminal_summaries") {
      return aiConfig?.sessionIntelligence?.summaries?.modelId
        ?? aiConfig?.featureModelOverrides?.terminal_summaries
        ?? "";
    }
    return aiConfig?.featureModelOverrides?.[key] ?? "";
  };

  const setModelFor = async (key: FeatureKey, modelId: string) => {
    if (saving) return;
    setSaving(true);
    try {
      if (key === "auto_title") {
        await window.ade.ai.updateConfig({
          sessionIntelligence: { titles: { modelId: modelId || null } } as AiConfig["sessionIntelligence"],
        });
      } else {
        const overrides: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(aiConfig?.featureModelOverrides ?? {})) {
          if (typeof v === "string" && v) overrides[k] = v;
        }
        if (modelId) overrides[key] = modelId;
        else overrides[key] = null;
        await window.ade.ai.updateConfig({
          featureModelOverrides: overrides as AiConfig["featureModelOverrides"],
          ...(key === "terminal_summaries"
            ? { sessionIntelligence: { summaries: { modelId: modelId || null } } as AiConfig["sessionIntelligence"] }
            : {}),
        });
      }
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const toggleFeature = async (key: FeatureKey, next: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      if (key === "auto_title") {
        await window.ade.ai.updateConfig({
          sessionIntelligence: {
            titles: { enabled: next },
          } as AiConfig["sessionIntelligence"],
        });
      } else {
        const features: Record<string, boolean> = { ...enabledFeatureMap, [key]: next };
        await window.ade.ai.updateConfig({
          features: features as AiConfig["features"],
          ...(key === "terminal_summaries"
            ? { sessionIntelligence: { summaries: { enabled: next } } as AiConfig["sessionIntelligence"] }
            : {}),
        });
      }
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const saveCursorKey = async (key: string) => {
    try {
      await window.ade.ai.storeApiKey("cursor", key);
      const verified = await window.ade.ai.verifyApiKey("cursor");
      await refresh(true);
      return { ok: verified.ok, message: verified.ok ? "Cursor connected" : verified.message };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };

  return (
    <section style={sectionStyle}>
      <div style={sectionHeader}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={SECTION_LABEL}>AI runtimes</span>
          <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
            {loading ? "Checking…" : `${readyCount} of ${RUNTIMES.length} ready`}
          </span>
        </div>
        <RescanButton loading={loading} onClick={() => void refresh(true)} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 12 }}>
        {RUNTIMES.map((rt) => (
          <RuntimeCard key={rt.id} meta={rt} status={status} onSaveCursorKey={saveCursorKey} />
        ))}
      </div>

      <div style={{ marginTop: 22 }}>
        <div style={{ ...SECTION_LABEL, marginBottom: 10 }}>Background helpers</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {FEATURES.map((f) => {
            const checked = f.key === "auto_title" ? titlesEnabled : Boolean(enabledFeatureMap[f.key]);
            const locked = !hasAnyModel && !checked;
            return (
              <div key={f.key} style={helperCardStyle(checked, locked)}>
                <button
                  type="button"
                  disabled={saving || locked}
                  onClick={() => void toggleFeature(f.key, !checked)}
                  style={helperToggleStyle(locked)}
                >
                  <Toggle checked={checked} />
                  <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: checked ? COLORS.textPrimary : COLORS.textMuted }}>
                    {f.label}
                  </span>
                </button>
                {checked ? (
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ ...SECTION_LABEL, fontSize: 9, color: COLORS.textDim }}>Model</span>
                    <ModelPicker
                      compact
                      hidePermissionRail
                      value={selectedModelFor(f.key)}
                      onChange={(modelId) => void setModelFor(f.key, modelId)}
                      availableModelIds={availableModelIds}
                      surfaceKey={`onboarding-helper-${f.key}`}
                      disabled={saving}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
          {hasAnyModel
            ? "Each helper can use its own model · API keys in Settings · AI Connections."
            : "Connect a runtime to enable helpers · API keys in Settings · AI Connections."}
        </div>
      </div>
    </section>
  );
}

function RuntimeCard({
  meta, status, onSaveCursorKey,
}: {
  meta: RuntimeMeta;
  status: AiSettingsStatus | null;
  onSaveCursorKey: (key: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const phase = getPhase(meta, status);
  const tone = getTone(phase);
  const { Logo } = meta;
  const detail = getDetailText(meta, status, phase);
  const cta = getCta(meta, status, phase, onSaveCursorKey);
  return (
    <div style={brandCard(meta.brand, { padding: 12, display: "flex", flexDirection: "column" })}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Logo size={22} />
        <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.2, color: tone.color, fontFamily: SANS_FONT, whiteSpace: "nowrap", flexShrink: 0 }}>
          {tone.label}
        </span>
      </div>
      <div style={{ marginTop: 7, fontSize: 11.5, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.4 }}>
        {detail}
      </div>
      {cta ? <div style={{ marginTop: 12 }}>{cta}</div> : null}
    </div>
  );
}

function Toggle({ checked }: { checked: boolean }) {
  return (
    <span
      style={{
        position: "relative",
        width: 28,
        height: 16,
        borderRadius: 8,
        background: checked ? COLORS.accent : COLORS.outlineBorder,
        flexShrink: 0,
        transition: "background 120ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 14 : 2,
          width: 12,
          height: 12,
          borderRadius: 6,
          background: COLORS.textPrimary,
          transition: "left 120ms ease",
        }}
      />
    </span>
  );
}

type RuntimePhase = "ready" | "auth" | "missing" | "checking";

function getPhase(meta: RuntimeMeta, status: AiSettingsStatus | null): RuntimePhase {
  if (!status) return "checking";
  if (meta.id === "claude") {
    const a: AiClaudeAvailability = status.availableProviders.claude;
    if (a.binary.present && a.auth.ready) return "ready";
    if (a.binary.present) return "auth";
    return "missing";
  }
  if (meta.id === "opencode") {
    return status.opencodeBinaryInstalled === false ? "missing" : "ready";
  }
  const conn = status.providerConnections?.[meta.id as Exclude<CliName, never>];
  if (conn?.runtimeAvailable) return "ready";
  if (conn?.runtimeDetected || conn?.authAvailable) return "auth";
  return "missing";
}

function getTone(phase: RuntimePhase): { color: string; label: string } {
  switch (phase) {
    case "ready": return { color: COLORS.success, label: "Ready" };
    case "auth": return { color: COLORS.warning, label: "Sign in needed" };
    case "missing": return { color: COLORS.danger, label: "Not detected" };
    default: return { color: COLORS.textDim, label: "Checking" };
  }
}

function getDetailText(meta: RuntimeMeta, status: AiSettingsStatus | null, phase: RuntimePhase): string {
  if (phase === "checking") return "Checking…";
  if (meta.id === "claude") {
    if (phase === "ready") return "Signed in";
    if (phase === "auth") return status?.availableProviders.claude.auth.detail || "Installed · sign in to continue";
    return "CLI not found on PATH";
  }
  if (meta.id === "opencode") {
    return phase === "missing" ? "CLI not found on PATH" : "Bundled with ADE";
  }
  if (phase === "ready") return "Connected and ready";
  if (phase === "auth") return "Installed · sign in to continue";
  return "CLI not found on PATH";
}

function getCta(
  meta: RuntimeMeta,
  status: AiSettingsStatus | null,
  phase: RuntimePhase,
  onSaveCursorKey: (key: string) => Promise<{ ok: boolean; message?: string }>,
): React.ReactNode {
  if (phase === "checking") return null;
  if (meta.id === "opencode") return <OpenCodeProviders />;
  if (phase === "ready") return null;
  // Cursor authenticates with an API key, not a login command: install the CLI
  // first (missing), then add the key once it's detected (auth).
  if (meta.id === "cursor") {
    if (phase === "missing") return <InstallBlock docsUrl={meta.docsUrl} command={meta.installCommand} />;
    return <CursorKeyPopover onSave={onSaveCursorKey} />;
  }
  if (phase === "auth" && meta.authCommand) {
    return <AuthBlock command={meta.authCommand} docsUrl={meta.docsUrl} />;
  }
  return <InstallBlock docsUrl={meta.docsUrl} command={meta.installCommand} />;
}

function CursorKeyPopover({ onSave }: { onSave: (key: string) => Promise<{ ok: boolean; message?: string }> }) {
  return (
    <InputPopover
      triggerLabel="Add key"
      title="Cursor API key"
      helpText={<>Get a key at <code style={codeStyle}>cursor.com/dashboard/api</code></>}
      placeholder="cur_..."
      onSave={onSave}
      align="left"
    />
  );
}

function InstallBlock({ docsUrl, command }: { docsUrl: string; command?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <DocsLink url={docsUrl} label="Installation guide" />
      {command ? <CommandLine text={command} /> : null}
    </div>
  );
}

function AuthBlock({ command, docsUrl }: { command: string; docsUrl: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <DocsLink url={docsUrl} label="Sign-in guide" />
      <CommandLine text={command} />
    </div>
  );
}

function DocsLink({ url, label }: { url: string; label: string }) {
  return (
    <button type="button" onClick={() => openExternalUrl(url)} style={docsLinkStyle}>
      <span>{label}</span>
      <ArrowUpRight size={11} weight="bold" />
    </button>
  );
}

function CommandLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try { void navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div style={cmdRowStyle}>
      <code style={cmdTextStyle}>{text}</code>
      <button type="button" onClick={copy} aria-label="Copy command" title="Copy" style={cmdCopyStyle}>
        {copied ? <Check size={11} weight="bold" /> : <Copy size={11} weight="bold" />}
      </button>
    </div>
  );
}

function OpenCodeProviders() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <ProviderLogo family="ollama" size={16} />
        <ProviderLogo family="lmstudio" size={16} />
        <Key size={14} weight="bold" color={COLORS.textMuted} />
      </div>
      <span style={{ fontSize: 10.5, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: 1.4 }}>
        Local models &amp; API key providers
      </span>
    </div>
  );
}

const docsLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  alignSelf: "flex-start",
  padding: 0,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: SANS_FONT,
  fontWeight: 600,
  color: COLORS.accent,
};

const cmdRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 7px",
  borderRadius: 7,
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${COLORS.border}`,
  minWidth: 0,
};

const cmdTextStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: MONO_FONT,
  fontSize: 10,
  lineHeight: 1.4,
  color: COLORS.textSecondary,
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

const cmdCopyStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 20,
  height: 20,
  padding: 0,
  borderRadius: 5,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: COLORS.textDim,
};

const sectionStyle: React.CSSProperties = {
  ...CARD_BASE,
  padding: 22,
  flex: 1,
  width: "100%",
  display: "flex",
  flexDirection: "column",
};

const sectionHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 16,
};

function helperCardStyle(checked: boolean, dimmed: boolean): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: "9px 12px",
    background: checked ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : "rgba(255,255,255,0.02)",
    border: `1px solid ${checked ? "color-mix(in srgb, var(--color-accent) 28%, transparent)" : COLORS.border}`,
    borderRadius: 10,
    opacity: dimmed ? 0.5 : 1,
    minWidth: 0,
  };
}

function helperToggleStyle(dimmed: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: 0,
    background: "transparent",
    border: "none",
    cursor: dimmed ? "not-allowed" : "pointer",
    minWidth: 0,
    textAlign: "left",
  };
}

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  padding: "1px 4px",
  borderRadius: 3,
  background: "rgba(255,255,255,0.08)",
  color: COLORS.textPrimary,
};
