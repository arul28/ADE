import { useEffect, useMemo, useState } from "react";
import {
  ChatCircleDots,
  Code,
  Lightning,
  Terminal,
  ArrowRight,
} from "@phosphor-icons/react";
import type { LaneSummary, AgentChatPermissionMode } from "../../../shared/types";
import type { WorkDraftKind } from "../../state/appStore";
import { AgentChatPane } from "../chat/AgentChatPane";
import { getPermissionOptions, safetyColors } from "../shared/permissionOptions";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { ClaudeLogo, CodexLogo } from "./ToolLogos";

type WorkStartSurfaceProps = {
  draftKind: WorkDraftKind;
  lanes: LaneSummary[];
  onOpenChatSession: (sessionId: string) => void;
  onLaunchPtySession: (args: {
    laneId: string;
    profile: "claude" | "codex" | "shell";
    title?: string;
    startupCommand?: string;
    tracked?: boolean;
  }) => Promise<unknown>;
};

type CliProvider = "claude" | "codex";

function buildCliStartupCommand(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode;
}): string {
  if (args.provider === "claude") {
    const parts = ["claude"];
    if (args.permissionMode === "full-auto") {
      parts.push("--dangerously-skip-permissions");
    } else if (args.permissionMode === "edit") {
      parts.push("--permission-mode", "acceptEdits");
    } else if (args.permissionMode === "default") {
      parts.push("--permission-mode", "default");
    } else {
      parts.push("--permission-mode", "plan");
    }
    return parts.join(" ");
  }

  const parts = ["codex"];
  if (args.permissionMode === "full-auto") {
    parts.push("--full-auto");
  } else if (args.permissionMode !== "config-toml") {
    const approvalPolicy = args.permissionMode === "edit" ? "on-failure" : "untrusted";
    const sandboxMode = args.permissionMode === "edit" ? "workspace-write" : "read-only";
    parts.push("-c", `approval_policy=${approvalPolicy}`, "-c", `sandbox_mode=${sandboxMode}`);
  }
  return parts.join(" ");
}

function LaunchModeHero({
  kind,
  title,
  body,
}: {
  kind: WorkDraftKind;
  title: string;
  body: string;
}) {
  const config = {
    chat: { icon: ChatCircleDots, color: COLORS.accent },
    cli: { icon: Code, color: COLORS.warning },
    shell: { icon: Terminal, color: COLORS.success },
  }[kind];
  const Icon = config.icon;

  return (
    <div className="flex items-center gap-3 px-5 py-3.5" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center"
        style={{
          background: `${config.color}18`,
          border: `1px solid ${config.color}30`,
        }}
      >
        <Icon size={16} weight="bold" style={{ color: config.color }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>{title}</span>
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              padding: "2px 8px",
              color: config.color,
              background: `${config.color}18`,
              border: `1px solid ${config.color}30`,
            }}
          >
            {kind}
          </span>
        </div>
        <div className="mt-1 max-w-2xl" style={{ fontSize: 11, lineHeight: 1.5, color: COLORS.textMuted, fontFamily: MONO_FONT }}>{body}</div>
      </div>
    </div>
  );
}

function LanePicker({
  lanes,
  value,
  onChange,
}: {
  lanes: LaneSummary[];
  value: string;
  onChange: (laneId: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: COLORS.textMuted }}>
        Lane
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
        {lanes.map((lane) => {
          const isActive = lane.id === value;
          const laneColor = lane.color ?? COLORS.accent;
          return (
            <button
              key={lane.id}
              type="button"
              className="inline-flex shrink-0 items-center gap-2 px-3 py-1.5 text-[10px] font-bold uppercase transition-colors"
              style={{
                fontFamily: MONO_FONT,
                letterSpacing: "0.5px",
                border: isActive
                  ? `1px solid ${laneColor}55`
                  : `1px solid ${COLORS.border}`,
                borderLeft: isActive ? `3px solid ${laneColor}` : `1px solid ${COLORS.border}`,
                background: isActive ? `${laneColor}12` : COLORS.recessedBg,
                color: isActive ? COLORS.textPrimary : COLORS.textMuted,
              }}
              onClick={() => onChange(lane.id)}
            >
              <span className="h-2 w-2" style={{ background: laneColor }} />
              <span className="truncate">{lane.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function WorkStartSurface({
  draftKind,
  lanes,
  onOpenChatSession,
  onLaunchPtySession,
}: WorkStartSurfaceProps) {
  const [selectedLaneId, setSelectedLaneId] = useState<string>(lanes[0]?.id ?? "");
  const [cliProvider, setCliProvider] = useState<CliProvider>("claude");
  const [cliPermissionMode, setCliPermissionMode] = useState<AgentChatPermissionMode>("default");
  const [launchBusy, setLaunchBusy] = useState(false);
  const selectedLane = useMemo(
    () => lanes.find((lane) => lane.id === selectedLaneId) ?? lanes[0] ?? null,
    [lanes, selectedLaneId],
  );
  useEffect(() => {
    if (!lanes.length) {
      setSelectedLaneId("");
      return;
    }
    if (!selectedLaneId || !lanes.some((lane) => lane.id === selectedLaneId)) {
      setSelectedLaneId(lanes[0]!.id);
    }
  }, [lanes, selectedLaneId]);

  const cliPermissionOptions = useMemo(
    () => getPermissionOptions({
      family: cliProvider === "claude" ? "anthropic" : "openai",
      isCliWrapped: true,
    }),
    [cliProvider],
  );

  useEffect(() => {
    const defaultPermission = cliProvider === "claude" ? "default" : "plan";
    if (!cliPermissionOptions.some((option) => option.value === cliPermissionMode)) {
      setCliPermissionMode(defaultPermission);
    }
  }, [cliPermissionMode, cliPermissionOptions, cliProvider]);

  const launchCli = async () => {
    if (!selectedLaneId || launchBusy) return;
    setLaunchBusy(true);
    try {
      await onLaunchPtySession({
        laneId: selectedLaneId,
        profile: cliProvider,
        title: cliProvider === "claude" ? "Claude CLI" : "Codex CLI",
        startupCommand: buildCliStartupCommand({
          provider: cliProvider,
          permissionMode: cliPermissionMode,
        }),
      });
    } finally {
      setLaunchBusy(false);
    }
  };

  const launchShell = async () => {
    if (!selectedLaneId || launchBusy) return;
    setLaunchBusy(true);
    try {
      await onLaunchPtySession({
        laneId: selectedLaneId,
        profile: "shell",
        title: "Shell",
      });
    } finally {
      setLaunchBusy(false);
    }
  };

  if (!lanes.length) {
    return (
      <div className="flex h-full items-center justify-center px-6" style={{ background: COLORS.cardBg }}>
        <div style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "20px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>No lanes available</div>
          <div className="mt-2" style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            Create or reopen a lane before starting chat, CLI, or shell work.
          </div>
        </div>
      </div>
    );
  }

  if (draftKind === "chat") {
    return (
      <div className="flex h-full min-h-0 flex-col" style={{ background: COLORS.cardBg }}>
        <div style={{ background: COLORS.cardBg, borderBottom: `1px solid ${COLORS.border}` }}>
          <LaunchModeHero
            kind="chat"
            title="New chat"
            body="Choose the lane, then send the opening prompt."
          />
          <div className="px-5 py-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
            <LanePicker lanes={lanes} value={selectedLaneId} onChange={setSelectedLaneId} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <AgentChatPane
            laneId={selectedLaneId}
            laneLabel={selectedLane?.name ?? selectedLaneId}
            hideSessionTabs
            forceDraftMode
            draftLayout="embedded"
            onSessionCreated={onOpenChatSession}
          />
        </div>
      </div>
    );
  }

  if (draftKind === "cli") {
    return (
      <div className="flex h-full min-h-0 flex-col" style={{ background: COLORS.cardBg }}>
        <div style={{ background: COLORS.cardBg }}>
          <LaunchModeHero
            kind="cli"
            title="New CLI Tool"
            body="Launch Claude Code or Codex CLI in a lane. Model selection happens inside the tool."
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-5">
          <div style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: 16 }}>
            <LanePicker lanes={lanes} value={selectedLaneId} onChange={setSelectedLaneId} />

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {[
                { id: "claude" as const, label: "Claude Code", color: COLORS.warning },
                { id: "codex" as const, label: "Codex CLI", color: COLORS.info },
              ].map((option) => {
                const active = cliProvider === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className="inline-flex items-center gap-2 px-3 py-2 text-[10px] font-bold uppercase transition-colors"
                    style={{
                      fontFamily: MONO_FONT,
                      letterSpacing: "1px",
                      border: active ? `1px solid ${option.color}55` : `1px solid ${COLORS.border}`,
                      borderLeft: active ? `3px solid ${option.color}` : `1px solid ${COLORS.border}`,
                      background: active ? `${option.color}12` : COLORS.recessedBg,
                      color: active ? COLORS.textPrimary : COLORS.textMuted,
                    }}
                    onClick={() => setCliProvider(option.id)}
                  >
                    {option.id === "claude"
                      ? <ClaudeLogo size={14} />
                      : <CodexLogo size={14} />}
                    {option.label}
                  </button>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {cliPermissionOptions.map((option) => {
                const active = cliPermissionMode === option.value;
                const colors = safetyColors(option.safety);
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`inline-flex items-center gap-2 px-3 py-2 text-[10px] font-bold uppercase transition-colors ${active ? colors.activeBg : ""}`}
                    style={{
                      fontFamily: MONO_FONT,
                      letterSpacing: "0.5px",
                      border: active ? `1px solid ${COLORS.accent}` : `1px solid ${COLORS.border}`,
                      color: active ? COLORS.textPrimary : COLORS.textMuted,
                    }}
                    onClick={() => setCliPermissionMode(option.value)}
                    title={option.detail}
                  >
                    <Lightning size={11} weight="fill" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-auto flex items-center justify-between gap-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "12px 16px" }}>
            <div className="min-w-0">
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                {cliProvider === "claude" ? "Claude Code" : "Codex CLI"}
              </div>
              <div className="mt-0.5" style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: COLORS.textMuted }}>
                Lane {lanes.find((lane) => lane.id === selectedLaneId)?.name ?? selectedLaneId}
              </div>
            </div>
            <button
              type="button"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 32,
                padding: "0 16px",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "1px",
                color: COLORS.pageBg,
                background: COLORS.accent,
                border: `1px solid ${COLORS.accent}`,
                cursor: selectedLaneId && !launchBusy ? "pointer" : "not-allowed",
                opacity: selectedLaneId && !launchBusy ? 1 : 0.5,
              }}
              disabled={!selectedLaneId || launchBusy}
              onClick={() => void launchCli()}
            >
              Open CLI
              <ArrowRight size={12} weight="bold" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: COLORS.cardBg }}>
      <div style={{ background: COLORS.cardBg }}>
        <LaunchModeHero
          kind="shell"
          title="New shell"
          body="Open a terminal in any lane. No agent wrapper — just a clean shell."
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-5">
        <div style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: 16 }}>
          <LanePicker lanes={lanes} value={selectedLaneId} onChange={setSelectedLaneId} />
          <div className="mt-4" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "12px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>Blank shell session</div>
            <div className="mt-1" style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              Starts a regular terminal with lane context for manual commands, scripts, or debugging.
            </div>
          </div>
        </div>

        <div className="mt-auto flex items-center justify-between gap-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "12px 16px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: COLORS.textMuted }}>
            Lane {lanes.find((lane) => lane.id === selectedLaneId)?.name ?? selectedLaneId}
          </div>
          <button
            type="button"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 32,
              padding: "0 16px",
              fontSize: 11,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: COLORS.pageBg,
              background: COLORS.accent,
              border: `1px solid ${COLORS.accent}`,
              cursor: selectedLaneId && !launchBusy ? "pointer" : "not-allowed",
              opacity: selectedLaneId && !launchBusy ? 1 : 0.5,
            }}
            disabled={!selectedLaneId || launchBusy}
            onClick={() => void launchShell()}
          >
            Open Shell
            <ArrowRight size={12} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}
