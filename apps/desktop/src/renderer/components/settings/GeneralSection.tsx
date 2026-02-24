import React, { useEffect, useState, useCallback } from "react";
import type { AppInfo, ProjectConfigSnapshot } from "../../../shared/types";
import { useAppStore, ThemeId, THEME_IDS } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import { ClaudeLogo, CodexLogo } from "../terminals/ToolLogos";
import { Info, CheckCircle, XCircle } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  LABEL_STYLE,
  primaryButton,
} from "../lanes/laneDesignTokens";

/* ------------------------------------------------------------------ */
/*  Theme metadata                                                     */
/* ------------------------------------------------------------------ */

const THEME_META: Record<
  ThemeId,
  {
    label: string;
    description: string;
    colors: { bg: string; fg: string; accent: string; card: string; border: string };
  }
> = {
  dark: {
    label: "DARK",
    description: "After-hours office. Cyan glows against dark surfaces.",
    colors: { bg: "#0f0f11", fg: "#e4e4e7", accent: "#A78BFA", card: "#18181b", border: "#27272a" },
  },
  light: {
    label: "LIGHT",
    description: "Morning office. Sunlit, clean, crisp accent.",
    colors: { bg: "#f5f5f6", fg: "#0f0f11", accent: "#7C3AED", card: "#ffffff", border: "#d4d4d8" },
  },
};

/* ------------------------------------------------------------------ */
/*  Config helpers                                                     */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBool(primary: unknown, fallback: unknown, defaultValue: boolean): boolean {
  if (typeof primary === "boolean") return primary;
  if (typeof fallback === "boolean") return fallback;
  return defaultValue;
}

function readString(primary: unknown, fallback: unknown, defaultValue: string): string {
  if (typeof primary === "string" && primary.length > 0) return primary;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return defaultValue;
}

/* ------------------------------------------------------------------ */
/*  Shared inline styles                                               */
/* ------------------------------------------------------------------ */

const selectStyle: React.CSSProperties = {
  width: "100%",
  height: 32,
  padding: "0 8px",
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 0,
  outline: "none",
  appearance: "none" as const,
  WebkitAppearance: "none" as const,
  cursor: "pointer",
};

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

/* ------------------------------------------------------------------ */
/*  ThemeSwatch                                                        */
/* ------------------------------------------------------------------ */

function ThemeSwatch({
  themeId,
  selected,
  onClick,
}: {
  themeId: ThemeId;
  selected: boolean;
  onClick: () => void;
}) {
  const { label, description, colors } = THEME_META[themeId];
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: 14,
        flex: 1,
        background: selected ? `${COLORS.accent}08` : hovered ? COLORS.hoverBg : COLORS.cardBg,
        border: selected
          ? `1px solid ${COLORS.accent}`
          : `1px solid ${hovered ? COLORS.outlineBorder : COLORS.border}`,
        borderLeft: selected ? `3px solid ${COLORS.accent}` : undefined,
        borderRadius: 0,
        cursor: "pointer",
        position: "relative",
        transition: "border-color 150ms, background 150ms",
      }}
    >
      {/* Mini preview */}
      <div
        style={{
          width: 72,
          height: 48,
          flexShrink: 0,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ height: 8, background: colors.card }} />
        <div
          style={{
            width: 40,
            height: 4,
            margin: "6px auto 0",
            background: colors.accent,
            borderRadius: 0,
          }}
        />
        <div style={{ margin: "5px 6px 0", display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ height: 2, width: 36, background: colors.fg, opacity: 0.4 }} />
          <div style={{ height: 2, width: 24, background: colors.fg, opacity: 0.25 }} />
        </div>
      </div>

      {/* Text */}
      <div style={{ textAlign: "left" }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: selected ? COLORS.accent : COLORS.textPrimary,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
            marginTop: 4,
          }}
        >
          {description}
        </div>
      </div>

      {/* Selected check */}
      {selected && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            color: COLORS.accent,
          }}
        >
          <CheckCircle size={16} weight="fill" />
        </div>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  ProviderCard                                                       */
/* ------------------------------------------------------------------ */

function ProviderCard({
  name,
  logo,
  connected,
  children,
}: {
  name: string;
  logo: React.ReactNode;
  connected: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        ...cardStyle(),
        flex: 1,
        borderLeft: connected ? `3px solid ${COLORS.success}` : `3px solid ${COLORS.textDim}`,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {logo}
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              fontFamily: SANS_FONT,
              color: COLORS.textPrimary,
              textTransform: "uppercase",
              letterSpacing: "1px",
            }}
          >
            {name}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {connected ? (
            <CheckCircle size={16} weight="fill" color={COLORS.success} />
          ) : (
            <XCircle size={16} weight="fill" color={COLORS.textDim} />
          )}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: connected ? COLORS.success : COLORS.textDim,
            }}
          >
            {connected ? "CONNECTED" : "NOT CONNECTED"}
          </span>
        </div>
      </div>

      {/* Permission controls when connected */}
      {connected && children && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
      )}

      {!connected && (
        <div
          style={{
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
            lineHeight: 1.5,
          }}
        >
          Sign in via your terminal to connect this provider.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SelectField                                                        */
/* ------------------------------------------------------------------ */

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={LABEL_STYLE}>{label}</span>
      <div style={{ position: "relative" }}>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={selectStyle}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {/* Dropdown arrow */}
        <div
          style={{
            position: "absolute",
            right: 8,
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
            color: COLORS.textMuted,
            fontSize: 10,
          }}
        >
          &#9662;
        </div>
      </div>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  GeneralSection (main export)                                       */
/* ------------------------------------------------------------------ */

export function GeneralSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configSnapshot, setConfigSnapshot] = useState<ProjectConfigSnapshot | null>(null);

  // Provider detection
  const [claudeDetected, setClaudeDetected] = useState(false);
  const [codexDetected, setCodexDetected] = useState(false);

  // Worker permission state
  const [workerPermDraft, setWorkerPermDraft] = useState({
    claudePermissionMode: "acceptEdits" as string,
    codexSandboxPermissions: "workspace-write" as string,
    codexApprovalMode: "full-auto" as string,
  });

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providerMode = useAppStore((s) => s.providerMode);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  /* Load app info */
  useEffect(() => {
    let cancelled = false;
    window.ade.app
      .getInfo()
      .then((v) => {
        if (!cancelled) setInfo(v);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Load config (worker permissions + provider detection) */
  const refreshConfig = useCallback(async () => {
    const snapshot = await window.ade.projectConfig.get();
    setConfigSnapshot(snapshot);

    const effectiveAi = isRecord(snapshot.effective.ai) ? snapshot.effective.ai : {};

    // Detect providers
    const providers = isRecord(snapshot.effective.providers)
      ? snapshot.effective.providers
      : {};
    const claudeProvider = isRecord(providers.claude) ? providers.claude : {};
    const codexProvider = isRecord(providers.codex) ? providers.codex : {};

    // Use detected field if present, otherwise fallback to providerMode
    const claudeIsDetected =
      typeof claudeProvider.detected === "boolean"
        ? claudeProvider.detected
        : providerMode === "subscription";
    const codexIsDetected =
      typeof codexProvider.detected === "boolean"
        ? codexProvider.detected
        : providerMode === "subscription";

    setClaudeDetected(claudeIsDetected);
    setCodexDetected(codexIsDetected);

    // Worker permissions
    const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
    const localPermissions = isRecord(localAi.permissions) ? localAi.permissions : {};
    const effectivePermissions = isRecord(effectiveAi.permissions) ? effectiveAi.permissions : {};
    const localClaude = isRecord(localPermissions.claude) ? localPermissions.claude : {};
    const effectiveClaude = isRecord(effectivePermissions.claude) ? effectivePermissions.claude : {};
    const localCodex = isRecord(localPermissions.codex) ? localPermissions.codex : {};
    const effectiveCodex = isRecord(effectivePermissions.codex) ? effectivePermissions.codex : {};

    setWorkerPermDraft({
      claudePermissionMode: readString(
        localClaude.permissionMode,
        effectiveClaude.permissionMode,
        "acceptEdits"
      ),
      codexSandboxPermissions: readString(
        localCodex.sandboxPermissions,
        effectiveCodex.sandboxPermissions,
        "workspace-write"
      ),
      codexApprovalMode: readString(
        localCodex.approvalMode,
        effectiveCodex.approvalMode,
        "full-auto"
      ),
    });
  }, [providerMode]);

  useEffect(() => {
    void refreshConfig().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [refreshConfig]);

  /* Save worker permissions */
  const savePermissions = async () => {
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const snapshot = configSnapshot ?? (await window.ade.projectConfig.get());
      const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};

      const nextPermissions: Record<string, Record<string, unknown>> = {};

      const claudePerms: Record<string, unknown> = {};
      if (workerPermDraft.claudePermissionMode && workerPermDraft.claudePermissionMode !== "acceptEdits") {
        claudePerms.permissionMode = workerPermDraft.claudePermissionMode;
      }
      if (Object.keys(claudePerms).length) nextPermissions.claude = claudePerms;

      const codexPerms: Record<string, unknown> = {};
      if (
        workerPermDraft.codexSandboxPermissions &&
        workerPermDraft.codexSandboxPermissions !== "workspace-write"
      ) {
        codexPerms.sandboxPermissions = workerPermDraft.codexSandboxPermissions;
      }
      if (workerPermDraft.codexApprovalMode && workerPermDraft.codexApprovalMode !== "full-auto") {
        codexPerms.approvalMode = workerPermDraft.codexApprovalMode;
      }
      if (Object.keys(codexPerms).length) nextPermissions.codex = codexPerms;

      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          ai: {
            ...(snapshot.local.ai ?? {}),
            ...localAi,
            permissions: Object.keys(nextPermissions).length > 0 ? nextPermissions : undefined,
          },
        },
      });
      await refreshConfig();
      setNotice("Settings saved to .ade/local.yaml.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  if (loadError) {
    return <EmptyState title="General" description={`Failed to load: ${loadError}`} />;
  }

  if (!info) {
    return <EmptyState title="General" description="Loading..." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      {/* Status banners */}
      {notice && (
        <div
          style={{
            padding: "8px 14px",
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.success,
            background: `${COLORS.success}12`,
            border: `1px solid ${COLORS.success}30`,
            borderRadius: 0,
          }}
        >
          {notice}
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "8px 14px",
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.danger,
            background: `${COLORS.danger}12`,
            border: `1px solid ${COLORS.danger}30`,
            borderRadius: 0,
          }}
        >
          {error}
        </div>
      )}

      {/* ------------------------------------------------------------ */}
      {/*  1. THEME                                                     */}
      {/* ------------------------------------------------------------ */}
      <section>
        <div style={sectionLabelStyle}>THEME</div>
        <div style={{ display: "flex", gap: 12 }}>
          {THEME_IDS.map((id) => (
            <ThemeSwatch key={id} themeId={id} selected={theme === id} onClick={() => setTheme(id)} />
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------ */}
      {/*  2. CONNECTIONS                                               */}
      {/* ------------------------------------------------------------ */}
      <section>
        <div style={sectionLabelStyle}>CONNECTIONS</div>

        <div style={{ display: "flex", gap: 12 }}>
          {/* Claude card */}
          <ProviderCard
            name="Claude"
            logo={<ClaudeLogo size={28} />}
            connected={claudeDetected}
          >
            <SelectField
              label="PERMISSION MODE"
              value={workerPermDraft.claudePermissionMode}
              onChange={(v) => setWorkerPermDraft((prev) => ({ ...prev, claudePermissionMode: v }))}
              options={[
                { value: "plan", label: "Plan (read-only)" },
                { value: "acceptEdits", label: "Accept edits" },
                { value: "bypassPermissions", label: "Bypass permissions" },
              ]}
            />
          </ProviderCard>

          {/* Codex card */}
          <ProviderCard
            name="Codex"
            logo={<CodexLogo size={28} />}
            connected={codexDetected}
          >
            <SelectField
              label="SANDBOX MODE"
              value={workerPermDraft.codexSandboxPermissions}
              onChange={(v) =>
                setWorkerPermDraft((prev) => ({ ...prev, codexSandboxPermissions: v }))
              }
              options={[
                { value: "read-only", label: "Read-only" },
                { value: "workspace-write", label: "Workspace write" },
                { value: "danger-full-access", label: "Full access (dangerous)" },
              ]}
            />
            <SelectField
              label="APPROVAL MODE"
              value={workerPermDraft.codexApprovalMode}
              onChange={(v) =>
                setWorkerPermDraft((prev) => ({ ...prev, codexApprovalMode: v }))
              }
              options={[
                { value: "suggest", label: "Suggest" },
                { value: "auto-edit", label: "Auto-edit" },
                { value: "full-auto", label: "Full auto" },
              ]}
            />
          </ProviderCard>
        </div>

        {/* Info note */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            marginTop: 14,
            padding: "10px 14px",
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 0,
          }}
        >
          <Info size={16} color={COLORS.textMuted} style={{ flexShrink: 0, marginTop: 1 }} />
          <span
            style={{
              fontSize: 11,
              fontFamily: MONO_FONT,
              color: COLORS.textMuted,
              lineHeight: 1.6,
            }}
          >
            ADE uses your existing CLI subscriptions. Sign in via your terminal &mdash; this app
            detects them automatically.
          </span>
        </div>

        {/* Save button */}
        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={() => void savePermissions()}
            disabled={saving}
            style={{
              ...primaryButton(),
              opacity: saving ? 0.6 : 1,
              cursor: saving ? "not-allowed" : "pointer",
              padding: "0 24px",
            }}
          >
            {saving ? "SAVING..." : "SAVE"}
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------ */}
      {/*  3. APP VERSION (footer)                                      */}
      {/* ------------------------------------------------------------ */}
      <section
        style={{
          paddingTop: 20,
          borderTop: `1px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: COLORS.textDim,
          }}
        >
          APP VERSION
        </span>
        <span
          style={{
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
          }}
        >
          v{info.appVersion}
        </span>
        <span
          style={{
            fontSize: 9,
            fontFamily: MONO_FONT,
            color: COLORS.textDim,
            padding: "1px 6px",
            background: `${COLORS.textDim}18`,
            border: `1px solid ${COLORS.textDim}30`,
            borderRadius: 0,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          {info.isPackaged ? "PACKAGED" : "DEV"}
        </span>
      </section>
    </div>
  );
}
