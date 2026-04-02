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
        startupCommand: buildTrackedCliStartupCommand({
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
      <div className="flex h-full items-center justify-center px-6" style={{ background: "var(--color-bg)" }}>
        <div className="rounded-lg p-5 text-center" style={{ background: "rgba(255,255,255,0.03)" }}>
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
        <div className="min-h-0 flex-1 overflow-hidden">
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
        </div>
      </div>
    );
  }

  /* ---- CLI draft ---- */
  if (draftKind === "cli") {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center" style={{ background: "var(--color-bg)" }}>
        {/* ADE logo with subtle glow */}
        <div className="relative mb-6">
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[400px] rounded-full pointer-events-none"
            style={{
              background: "var(--color-accent)",
              opacity: 0.08,
              filter: "blur(100px)",
            }}
          />
          <img
            src="./logo.png"
            alt="ADE"
            className="relative z-10 w-64 h-64 object-contain"
            style={{ filter: "drop-shadow(0 0 40px rgba(168,130,255,0.15))" }}
          />
        </div>
        <div
          className="flex w-full max-w-sm flex-col gap-4 rounded-lg p-5"
          style={{
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            background: "rgba(30, 30, 40, 0.7)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
          }}
        >
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
                <button
                  key={opt.id}
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
              );
            })}
          </div>

          {/* Permission pills */}
          <div className="flex flex-wrap gap-1">
            {cliPermissionOptions.map((option) => {
              const active = cliPermissionMode === option.value;
              const colors = safetyColors(option.safety);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`ade-work-segmented-item ${active ? colors.activeBg : ""}`}
                  data-active={active ? "true" : undefined}
                  onClick={() => setCliPermissionMode(option.value)}
                  title={option.detail}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {/* Launch */}
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
        </div>
      </div>
    );
  }

  /* ---- Shell draft ---- */
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center" style={{ background: "var(--color-bg)" }}>
      {/* ADE logo with subtle glow */}
      <div className="relative mb-6">
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[200px] w-[200px] rounded-full pointer-events-none"
          style={{
            background: "var(--color-accent)",
            opacity: 0.08,
            filter: "blur(80px)",
          }}
        />
        <img
          src="./logo.png"
          alt="ADE"
          className="relative z-10 h-[140px] w-[140px] object-contain"
          style={{ filter: "drop-shadow(0 0 40px rgba(168,130,255,0.15))" }}
        />
      </div>
      <div
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg p-5"
        style={{
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          background: "rgba(30, 30, 40, 0.7)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
        }}
      >
        {/* Lane */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-fg/60 shrink-0">Lane</span>
          <LaneCombobox lanes={lanes} value={selectedLaneId} onChange={setLaneAndSync} />
        </div>

        {/* Description */}
        <div className="rounded-md px-3 py-2.5" style={{ background: "rgba(255,255,255,0.02)" }}>
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
      </div>
    </div>
  );
}
