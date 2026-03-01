import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Play, Stop, Plus, MagnifyingGlass } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { RunSidebar } from "./RunSidebar";
import { CommandCard } from "./CommandCard";
import { ProcessMonitor } from "./ProcessMonitor";
import { AddCommandDialog } from "./AddCommandDialog";
import { AiScanPanel, type AiScanSuggestion } from "./AiScanPanel";
import type {
  ProcessDefinition,
  ProcessRuntime,
  ProcessEvent,
  StackButtonDefinition,
  ProjectConfigSnapshot,
  ConfigProcessDefinition,
  ConfigStackButtonDefinition,
} from "../../../shared/types";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function RunPage() {
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const runLaneId = useAppStore((s) => s.runLaneId);
  const selectRunLane = useAppStore((s) => s.selectRunLane);

  const [config, setConfig] = useState<ProjectConfigSnapshot | null>(null);
  const [definitions, setDefinitions] = useState<ProcessDefinition[]>([]);
  const [runtime, setRuntime] = useState<ProcessRuntime[]>([]);
  const [selectedStackId, setSelectedStackId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [scanPanelOpen, setScanPanelOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());

  const effectiveLaneId = runLaneId ?? selectedLaneId ?? lanes[0]?.id ?? null;
  const effectiveLaneName = lanes.find((l) => l.id === effectiveLaneId)?.name ?? null;

  // Sync runLaneId from selectedLaneId
  useEffect(() => {
    if (!runLaneId && selectedLaneId) {
      selectRunLane(selectedLaneId);
    }
  }, [runLaneId, selectedLaneId, selectRunLane]);

  // Tick for uptime display
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Load config, definitions, runtime
  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [nextConfig, nextDefs] = await Promise.all([
        window.ade.projectConfig.get(),
        window.ade.processes.listDefinitions(),
      ]);
      setConfig(nextConfig);
      setDefinitions(nextDefs);
      if (effectiveLaneId) {
        const nextRuntime = await window.ade.processes.listRuntime(effectiveLaneId);
        setRuntime(nextRuntime);
      }
    } catch (err) {
      console.error("RunPage.refreshAll", err);
    } finally {
      setLoading(false);
    }
  }, [effectiveLaneId]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Subscribe to process events
  useEffect(() => {
    const unsub = window.ade.processes.onEvent((ev: ProcessEvent) => {
      if (ev.type === "runtime") {
        setRuntime((prev) => {
          const idx = prev.findIndex(
            (r) => r.processId === ev.runtime.processId && r.laneId === ev.runtime.laneId
          );
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = ev.runtime;
            return next;
          }
          return [...prev, ev.runtime];
        });
      }
    });
    return unsub;
  }, []);

  // Derived
  const stacks: StackButtonDefinition[] = config?.effective.stackButtons ?? [];
  const processNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of definitions) map[d.id] = d.name;
    return map;
  }, [definitions]);

  const filteredDefinitions = useMemo(() => {
    if (!selectedStackId) return definitions;
    const stack = stacks.find((s) => s.id === selectedStackId);
    if (!stack) return definitions;
    const ids = new Set(stack.processIds);
    return definitions.filter((d) => ids.has(d.id));
  }, [definitions, selectedStackId, stacks]);

  const runtimeMap = useMemo(() => {
    const map: Record<string, ProcessRuntime> = {};
    for (const r of runtime) map[r.processId] = r;
    return map;
  }, [runtime]);

  // Actions
  const handleRun = useCallback(
    async (processId: string) => {
      if (!effectiveLaneId) return;
      const def = definitions.find((d) => d.id === processId);
      if (!def) return;
      // Start the managed process
      await window.ade.processes.start({ laneId: effectiveLaneId, processId });
      // Also open a terminal in the Work tab for visibility
      try {
        await window.ade.pty.create({
          laneId: effectiveLaneId,
          cols: 120,
          rows: 30,
          title: def.name,
          tracked: true,
          startupCommand: def.command.join(" "),
        });
      } catch {
        // Terminal creation is best-effort
      }
    },
    [effectiveLaneId, definitions]
  );

  const handleStop = useCallback(
    async (processId: string) => {
      if (!effectiveLaneId) return;
      await window.ade.processes.stop({ laneId: effectiveLaneId, processId });
    },
    [effectiveLaneId]
  );

  const handleKill = useCallback(
    async (processId: string) => {
      if (!effectiveLaneId) return;
      await window.ade.processes.kill({ laneId: effectiveLaneId, processId });
    },
    [effectiveLaneId]
  );

  const handleStartAll = useCallback(async () => {
    if (!effectiveLaneId) return;
    if (selectedStackId) {
      await window.ade.processes.startStack({ laneId: effectiveLaneId, stackId: selectedStackId });
    } else {
      await window.ade.processes.startAll({ laneId: effectiveLaneId });
    }
  }, [effectiveLaneId, selectedStackId]);

  const handleStopAll = useCallback(async () => {
    if (!effectiveLaneId) return;
    if (selectedStackId) {
      await window.ade.processes.stopStack({ laneId: effectiveLaneId, stackId: selectedStackId });
    } else {
      await window.ade.processes.stopAll({ laneId: effectiveLaneId });
    }
  }, [effectiveLaneId, selectedStackId]);

  // Config mutations
  const saveProcessToConfig = useCallback(
    async (cmd: {
      name: string;
      command: string;
      stackId: string | null;
      newStackName: string | null;
      cwd: string;
    }) => {
      if (!config) return;
      const processId = generateId();
      const newProcess: ConfigProcessDefinition = {
        id: processId,
        name: cmd.name,
        command: cmd.command.split(/\s+/),
        cwd: cmd.cwd === "." ? undefined : cmd.cwd,
      };

      const shared = { ...config.shared };
      const processes = [...(shared.processes ?? []), newProcess];
      shared.processes = processes;

      // Handle stack assignment
      let stackButtons = [...(shared.stackButtons ?? [])];
      let targetStackId = cmd.stackId;

      if (cmd.newStackName) {
        const newStack: ConfigStackButtonDefinition = {
          id: generateId(),
          name: cmd.newStackName,
          processIds: [processId],
        };
        stackButtons = [...stackButtons, newStack];
        targetStackId = newStack.id;
      } else if (targetStackId) {
        stackButtons = stackButtons.map((s) =>
          s.id === targetStackId
            ? { ...s, processIds: [...(s.processIds ?? []), processId] }
            : s
        );
      }
      shared.stackButtons = stackButtons;

      await window.ade.projectConfig.save({ shared, local: config.local });
      await refreshAll();
    },
    [config, refreshAll]
  );

  const handleDeleteProcess = useCallback(
    async (processId: string) => {
      if (!config) return;
      const shared = { ...config.shared };
      shared.processes = (shared.processes ?? []).filter((p) => p.id !== processId);
      shared.stackButtons = (shared.stackButtons ?? []).map((s) => ({
        ...s,
        processIds: (s.processIds ?? []).filter((id) => id !== processId),
      }));
      await window.ade.projectConfig.save({ shared, local: config.local });
      await refreshAll();
    },
    [config, refreshAll]
  );

  const handleCreateStack = useCallback(
    async (name: string) => {
      if (!config) return;
      const shared = { ...config.shared };
      const newStack: ConfigStackButtonDefinition = {
        id: generateId(),
        name,
        processIds: [],
      };
      shared.stackButtons = [...(shared.stackButtons ?? []), newStack];
      await window.ade.projectConfig.save({ shared, local: config.local });
      await refreshAll();
    },
    [config, refreshAll]
  );

  const handleRenameStack = useCallback(
    async (stackId: string, name: string) => {
      if (!config) return;
      const shared = { ...config.shared };
      shared.stackButtons = (shared.stackButtons ?? []).map((s) =>
        s.id === stackId ? { ...s, name } : s
      );
      await window.ade.projectConfig.save({ shared, local: config.local });
      await refreshAll();
    },
    [config, refreshAll]
  );

  const handleDeleteStack = useCallback(
    async (stackId: string) => {
      if (!config) return;
      const shared = { ...config.shared };
      shared.stackButtons = (shared.stackButtons ?? []).filter((s) => s.id !== stackId);
      await window.ade.projectConfig.save({ shared, local: config.local });
      if (selectedStackId === stackId) setSelectedStackId(null);
      await refreshAll();
    },
    [config, refreshAll, selectedStackId]
  );

  const handleAddFromScan = useCallback(
    async (suggestion: AiScanSuggestion) => {
      await saveProcessToConfig({
        name: suggestion.name,
        command: suggestion.command,
        stackId: null,
        newStackName: suggestion.stack,
        cwd: ".",
      });
    },
    [saveProcessToConfig]
  );

  const handleAddAllFromScan = useCallback(
    async (suggestions: AiScanSuggestion[]) => {
      for (const s of suggestions) {
        await handleAddFromScan(s);
      }
      setScanPanelOpen(false);
    },
    [handleAddFromScan]
  );

  const handleEditProcess = useCallback((_processId: string) => {
    // TODO: open edit dialog (reuse AddCommandDialog in edit mode)
  }, []);

  const handleMoveToStack = useCallback((_processId: string) => {
    // TODO: show stack picker
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: COLORS.pageBg,
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "16px 20px",
          borderBottom: `1px solid ${COLORS.border}`,
          flexShrink: 0,
        }}
      >
        {/* Page title */}
        <h1
          style={{
            fontFamily: SANS_FONT,
            fontSize: 18,
            fontWeight: 700,
            color: COLORS.textPrimary,
            margin: 0,
          }}
        >
          Run
        </h1>

        {/* Lane selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={LABEL_STYLE}>Lane</span>
          <select
            value={effectiveLaneId ?? ""}
            onChange={(e) => selectRunLane(e.target.value || null)}
            style={{
              height: 28,
              padding: "0 8px",
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.outlineBorder}`,
              borderRadius: 0,
              fontFamily: MONO_FONT,
              fontSize: 11,
              color: COLORS.textPrimary,
              outline: "none",
              minWidth: 120,
            }}
          >
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ flex: 1 }} />

        {/* Action buttons */}
        <button
          type="button"
          onClick={() => setAddDialogOpen(true)}
          style={outlineButton()}
        >
          <Plus size={14} weight="bold" />
          Add
        </button>
        <button
          type="button"
          onClick={() => setScanPanelOpen(true)}
          style={outlineButton()}
        >
          <MagnifyingGlass size={14} weight="bold" />
          Scan
        </button>
      </div>

      {/* ── Body: Sidebar + Main ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar */}
        <RunSidebar
          stacks={stacks}
          selectedStackId={selectedStackId}
          onSelectStack={setSelectedStackId}
          onCreateStack={handleCreateStack}
          onRenameStack={handleRenameStack}
          onDeleteStack={handleDeleteStack}
        />

        {/* Main content */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Stack actions bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 20px",
              borderBottom: `1px solid ${COLORS.border}`,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: 12,
                fontWeight: 700,
                color: COLORS.textPrimary,
              }}
            >
              {selectedStackId
                ? stacks.find((s) => s.id === selectedStackId)?.name ?? "Stack"
                : "All Commands"}
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: 10,
                color: COLORS.textDim,
              }}
            >
              ({filteredDefinitions.length})
            </span>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={handleStartAll} style={primaryButton({ height: 28, fontSize: 10 })}>
              <Play size={12} weight="fill" />
              Start All
            </button>
            <button
              type="button"
              onClick={handleStopAll}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                height: 28,
                padding: "0 12px",
                fontSize: 10,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "1px",
                color: COLORS.danger,
                background: `${COLORS.danger}18`,
                border: `1px solid ${COLORS.danger}30`,
                borderRadius: 0,
                cursor: "pointer",
              }}
            >
              <Stop size={12} weight="fill" />
              Stop All
            </button>
          </div>

          {/* Command cards grid */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 20,
            }}
          >
            {loading && filteredDefinitions.length === 0 ? (
              <div
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: COLORS.textDim,
                  textAlign: "center",
                  padding: "40px 0",
                }}
              >
                Loading...
              </div>
            ) : filteredDefinitions.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  padding: "60px 20px",
                }}
              >
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: COLORS.textMuted,
                    textAlign: "center",
                  }}
                >
                  No commands configured
                </div>
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    color: COLORS.textDim,
                    textAlign: "center",
                    maxWidth: 300,
                  }}
                >
                  Add commands manually or scan your repo to detect dev servers, build scripts, and deploy commands.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button type="button" onClick={() => setAddDialogOpen(true)} style={primaryButton()}>
                    <Plus size={14} weight="bold" />
                    Add Command
                  </button>
                  <button type="button" onClick={() => setScanPanelOpen(true)} style={outlineButton()}>
                    <MagnifyingGlass size={14} weight="bold" />
                    Scan Repo
                  </button>
                </div>
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: 12,
                }}
              >
                {filteredDefinitions.map((def) => (
                  <CommandCard
                    key={def.id}
                    definition={def}
                    runtime={runtimeMap[def.id] ?? null}
                    onRun={handleRun}
                    onStop={handleStop}
                    onEdit={handleEditProcess}
                    onDelete={handleDeleteProcess}
                    onMoveToStack={handleMoveToStack}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Process Monitor (bottom bar) ── */}
      <ProcessMonitor
        runtimes={runtime}
        processNames={processNames}
        onKill={handleKill}
      />

      {/* ── Dialogs ── */}
      <AddCommandDialog
        stacks={stacks}
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onSubmit={saveProcessToConfig}
      />

      <AiScanPanel
        open={scanPanelOpen}
        onClose={() => setScanPanelOpen(false)}
        onAddCommand={handleAddFromScan}
        onAddAll={handleAddAllFromScan}
      />
    </div>
  );
}
