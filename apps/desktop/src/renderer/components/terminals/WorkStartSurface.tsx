import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Terminal,
  ArrowRight,
} from "@phosphor-icons/react";
import type { AgentChatPermissionMode, AgentChatSession, LaneSummary } from "../../../shared/types";
import type { WorkDraftKind } from "../../state/appStore";
import { useAppStore } from "../../state/appStore";
import { AgentChatPane } from "../chat/AgentChatPane";
import { getPermissionOptions, safetyColors } from "../shared/permissionOptions";
import { LaneCombobox } from "./LaneCombobox";
import { COLORS } from "../lanes/laneDesignTokens";
import { buildTrackedCliStartupCommand, type CliProvider } from "./cliLaunch";
import { ClaudeLogo, CodexLogo } from "./ToolLogos";
import { SmartTooltip } from "../ui/SmartTooltip";

type WorkStartSurfaceProps = {
  draftKind: WorkDraftKind;
  lanes: LaneSummary[];
  onOpenChatSession: (session: AgentChatSession) => void | Promise<void>;
  onLaunchPtySession: (args: {
    laneId: string;
    profile: "claude" | "codex" | "shell";
    title?: string;
    startupCommand?: string;
    tracked?: boolean;
  }) => Promise<unknown>;
};

export function WorkStartSurface({
  draftKind,
  lanes,
  onOpenChatSession,
  onLaunchPtySession,
}: WorkStartSurfaceProps) {
  const globallySelectedLaneId = useAppStore((s) => s.selectedLaneId);
  const selectLaneGlobal = useAppStore((s) => s.selectLane);
  const [selectedLaneId, setSelectedLaneId] = useState<string>(() => {
    if (globallySelectedLaneId && lanes.some((lane) => lane.id === globallySelectedLaneId)) {
      return globallySelectedLaneId;
    }
    return lanes[0]?.id ?? "";
  });
  const [cliProvider, setCliProvider] = useState<CliProvider>("claude");
  const [cliPermissionMode, setCliPermissionMode] = useState<AgentChatPermissionMode>("default");
  const [launchBusy, setLaunchBusy] = useState(false);
  const [chatDraftReady, setChatDraftReady] = useState(false);
  const selectedLane = useMemo(
    () => lanes.find((lane) => lane.id === selectedLaneId) ?? lanes[0] ?? null,
    [lanes, selectedLaneId],
  );

  const setLaneAndSync = useCallback((laneId: string) => {
    setSelectedLaneId(laneId);
    selectLaneGlobal(laneId);
  }, [selectLaneGlobal]);

  useEffect(() => {
    if (!lanes.length) {
      setSelectedLaneId("");
      return;
    }
    if (!selectedLaneId || !lanes.some((lane) => lane.id === selectedLaneId)) {
      const fallbackLaneId =
        globallySelectedLaneId && lanes.some((lane) => lane.id === globallySelectedLaneId)
          ? globallySelectedLaneId
          : lanes[0]!.id;
      setSelectedLaneId(fallbackLaneId);
      selectLaneGlobal(fallbackLaneId);
    }
  }, [globallySelectedLaneId, lanes, selectedLaneId, selectLaneGlobal]);

  const cliPermissionOptions = useMemo(
    () =>
      getPermissionOptions({
        family: cliProvider === "claude" ? "anthropic" : "openai",
        isCliWrapped: true,
      }),
    [cliProvider],
  );

  useEffect(() => {
    const defaultPermission = "default";
    if (!cliPermissionOptions.some((option) => option.value === cliPermissionMode)) {
      setCliPermissionMode(defaultPermission);
    }
  }, [cliPermissionMode, cliPermissionOptions, cliProvider]);

  useEffect(() => {
    if (draftKind !== "chat") {
      setChatDraftReady(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setChatDraftReady(true);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [draftKind]);

  const launchCli = async () => {
    if (!selectedLaneId || launchBusy) return;
    setLaunchBusy(true);
    try {
      // Generate a session ID upfront for Claude so resume always works
      const sessionId = cliProvider === "claude" ? crypto.randomUUID() : undefined;
      await onLaunchPtySession({
        laneId: selectedLaneId,
        profile: cliProvider,
        title: cliProvider === "claude" ? "Claude CLI" : "Codex CLI",
        startupCommand: buildTrackedCliStartupCommand({
          provider: cliProvider,
          permissionMode: cliPermissionMode,
          sessionId,
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
      <div className="flex h-full items-center justify-center px-6" style={{ background: "var(--color-bg)" }}>
        <div className="ade-liquid-glass ade-liquid-glass-menu rounded-lg p-5 text-center">
          <div className="text-[12px] font-medium text-fg">No lanes available</div>
          <div className="mt-1.5 text-[11px] text-muted-fg">
            Create or reopen a lane before starting work.
          </div>
        </div>
      </div>
    );
  }

  /* ---- Chat draft ---- */
  if (draftKind === "chat") {
    return (
      <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-bg)" }}>
        <div className="mx-auto flex w-full min-h-0 max-w-5xl flex-1 flex-col overflow-hidden">
          {chatDraftReady ? (
            <AgentChatPane
              laneId={selectedLaneId}
              laneLabel={selectedLane?.name ?? selectedLaneId}
              hideSessionTabs
              forceDraftMode
              embeddedWorkLayout
              onSessionCreated={onOpenChatSession}
              availableLanes={lanes}
              onLaneChange={setLaneAndSync}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6">
              <div className="ade-liquid-glass ade-liquid-glass-menu rounded-lg px-4 py-3 text-center">
                <div className="text-[12px] font-medium text-fg">Preparing chat draft</div>
                <div className="mt-1.5 text-[11px] text-muted-fg">
                  ADE waits briefly before mounting the full chat surface so fast tab switches stay cheap.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---- CLI draft ---- */
  if (draftKind === "cli") {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-8 px-6 py-6" style={{ background: "var(--color-bg)" }}>
        <LogoGlow size="lg" />
        <div className="flex w-full max-w-sm flex-col items-center">
          <GlassCard>
          {/* Lane */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-fg/60 shrink-0">Lane</span>
            <LaneCombobox lanes={lanes} value={selectedLaneId} onChange={setLaneAndSync} />
          </div>

          {/* Provider toggle */}
          <div className="flex items-center gap-1">
            {([
              { id: "claude" as const, label: "Claude Code", Logo: ClaudeLogo },
              { id: "codex" as const, label: "Codex CLI", Logo: CodexLogo },
            ] as const).map((opt) => {
              const active = cliProvider === opt.id;
              return (
                <SmartTooltip key={opt.id} content={{ label: opt.label, description: `Use ${opt.label} as the CLI provider for this session.` }}>
                  <button
                    type="button"
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-md py-2 transition-colors"
                    style={{
                      fontSize: 11,
                      fontWeight: active ? 500 : 400,
                      border: active ? "1px solid var(--color-accent-muted)" : "1px solid transparent",
                      background: active ? "var(--color-accent-muted)" : "transparent",
                      color: active ? "var(--color-fg)" : "var(--color-muted-fg)",
                      cursor: "pointer",
                    }}
                    onClick={() => setCliProvider(opt.id)}
                  >
                    <opt.Logo size={14} />
                    {opt.label}
                  </button>
                </SmartTooltip>
              );
            })}
          </div>

          {/* Permission pills */}
          <div className="flex flex-wrap gap-1">
            {cliPermissionOptions.map((option) => {
              const active = cliPermissionMode === option.value;
              const colors = safetyColors(option.safety);
              return (
                <SmartTooltip key={option.value} content={{ label: option.label, description: option.detail }}>
                  <button
                    type="button"
                    className={`ade-work-segmented-item ${active ? colors.activeBg : ""}`}
                    data-active={active ? "true" : undefined}
                    onClick={() => setCliPermissionMode(option.value)}
                  >
                    {option.label}
                  </button>
                </SmartTooltip>
              );
            })}
          </div>

          {/* Launch */}
          <SmartTooltip content={{ label: "Launch CLI", description: "Start a new CLI session with the selected provider and permission mode." }}>
            <button
              type="button"
              className="inline-flex w-full items-center justify-center gap-2 rounded-md py-2 text-[11px] font-medium transition-colors"
              style={{
                background: "var(--color-fg)",
                color: "var(--color-bg)",
                cursor: selectedLaneId && !launchBusy ? "pointer" : "not-allowed",
                opacity: selectedLaneId && !launchBusy ? 1 : 0.5,
              }}
              disabled={!selectedLaneId || launchBusy}
              onClick={() => void launchCli()}
            >
              Open {cliProvider === "claude" ? "Claude Code" : "Codex CLI"}
              <ArrowRight size={12} weight="regular" />
            </button>
          </SmartTooltip>
          </GlassCard>
        </div>
      </div>
    );
  }

  /* ---- Shell draft ---- */
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-8 px-6 py-6" style={{ background: "var(--color-bg)" }}>
      <LogoGlow size="lg" />
      <div className="flex w-full max-w-sm flex-col items-center">
        <GlassCard>
        {/* Lane */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-fg/60 shrink-0">Lane</span>
          <LaneCombobox lanes={lanes} value={selectedLaneId} onChange={setLaneAndSync} />
        </div>

        {/* Description */}
        <div className="ade-chat-recessed rounded-md px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Terminal size={14} weight="regular" className="text-muted-fg/50 shrink-0" />
            <div>
              <div className="text-[11px] font-medium text-fg">Shell session</div>
              <div className="mt-0.5 text-[10px] text-muted-fg/70 leading-relaxed">
                Terminal with lane context for commands and debugging.
              </div>
            </div>
          </div>
        </div>

        {/* Launch */}
        <SmartTooltip content={{ label: "Open Shell", description: "Launch a new terminal shell in this lane's worktree." }}>
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-2 rounded-md py-2 text-[11px] font-medium transition-colors"
            style={{
              background: "var(--color-fg)",
              color: "var(--color-bg)",
              cursor: selectedLaneId && !launchBusy ? "pointer" : "not-allowed",
              opacity: selectedLaneId && !launchBusy ? 1 : 0.5,
            }}
            disabled={!selectedLaneId || launchBusy}
            onClick={() => void launchShell()}
          >
            Open Shell
            <ArrowRight size={12} weight="regular" />
          </button>
        </SmartTooltip>
        </GlassCard>
      </div>
    </div>
  );
}

const LOGO_SIZES = {
  lg: { glow: "h-[680px] w-[680px]", blur: "blur(160px)", img: "h-[300px] w-[560px] max-w-[78vw]" },
  sm: { glow: "h-[280px] w-[280px]", blur: "blur(90px)", img: "h-[180px] w-[320px] max-w-[72vw]" },
} as const;

function LogoGlow({ size }: { size: "lg" | "sm" }) {
  const s = LOGO_SIZES[size];
  return (
    <div className="relative mb-6">
      <div
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ${s.glow} rounded-full pointer-events-none`}
        style={{ background: "var(--color-accent)", opacity: 0.08, filter: s.blur }}
      />
      <img
        src="./logo.png"
        alt="ADE"
        className={`relative z-10 ${s.img} object-contain`}
        style={{ filter: "drop-shadow(0 0 40px rgba(168,130,255,0.15))" }}
      />
    </div>
  );
}

function GlassCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="ade-liquid-glass ade-liquid-glass-strong flex w-full max-w-sm flex-col gap-4 rounded-xl p-5">
      {children}
    </div>
  );
}
