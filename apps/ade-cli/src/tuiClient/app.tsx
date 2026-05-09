import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { spawn } from "node:child_process";
import path from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import { getDefaultModelDescriptor } from "../../../desktop/src/shared/modelRegistry";
import type {
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatModelInfo,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
} from "../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import {
  DEFAULT_CODEX_REASONING_EFFORT,
  approveToolUse,
  createChatSession,
  getAvailableModels,
  getChatHistory,
  getSlashCommands,
  interruptChat,
  latestTokenStats,
  listChatSessions,
  listLanes,
  navigateDesktop,
  newestSession,
  renameChat,
  respondToInput,
  resumeChat,
  sendChatMessage,
  updateChatModel,
} from "./adeApi";
import { paletteCommands, parseCommand } from "./commands";
import { connectToAde } from "./connection";
import { Drawer } from "./components/Drawer";
import { ChatView } from "./components/ChatView";
import { Header } from "./components/Header";
import { RightPane } from "./components/RightPane";
import { SlashPalette } from "./components/SlashPalette";
import { MentionPalette } from "./components/MentionPalette";
import { ApprovalPrompt } from "./components/ApprovalPrompt";
import { chooseInitialLane } from "./project";
import { latestExpandableFailureId, renderObject, summarizeDiffChanges } from "./format";
import { startTuiHeartbeat, type TuiHeartbeat } from "./heartbeat";
import { buildLinearToolRequest } from "./linearCommands";
import { buildPendingInputAnswers, latestPendingApproval } from "./pendingInput";
import type {
  AdeCodeConnection,
  AdeCodeModelState,
  LocalNotice,
  MentionSuggestion,
  PendingApproval,
  ProjectLaunchContext,
  RightPaneContent,
  RuntimeMode,
} from "./types";

const PURPLE = "#A78BFA";
const EFFORTS = ["low", "medium", "high", "xhigh"];
const PROVIDERS = new Set(["codex", "claude", "opencode", "cursor", "droid"]);
const DESKTOP_COMMAND_ROUTES: Record<string, string> = {
  "/app-control": "/app-control",
  "/browser": "/browser",
  "/computer": "/proof",
  "/computer-use": "/proof",
  "/ios": "/ios-sim",
  "/ios-sim": "/ios-sim",
  "/macos-vm": "/macos-vm",
  "/mission": "/missions",
  "/missions": "/missions",
  "/pencil": "/pencil",
  "/proof": "/proof",
};

type AdeCodeAppProps = {
  project: ProjectLaunchContext;
  forceEmbedded?: boolean;
  requireSocket?: boolean;
  socketPath?: string | null;
};

function initialModelState(): AdeCodeModelState {
  const descriptor = getDefaultModelDescriptor("codex");
  return {
    provider: "codex",
    model: descriptor?.providerModelId ?? "gpt-5.5",
    modelId: descriptor?.id ?? null,
    displayName: descriptor?.displayName ?? "GPT-5.5",
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  };
}

function noticeId(): string {
  return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function routeRows(value: unknown): string[] {
  if (Array.isArray(value)) return value.slice(0, 16).map((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return String(record.title ?? record.name ?? record.branchRef ?? record.id ?? JSON.stringify(entry)).slice(0, 90);
  });
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const list = Object.values(record).find(Array.isArray);
  return Array.isArray(list) ? routeRows(list) : renderObject(value, 12).split(/\r?\n/);
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatTokenSummary(stats: ReturnType<typeof latestTokenStats>): string | null {
  const parts: string[] = [];
  if (stats.inputTokens != null) parts.push(`in ${compactNumber(stats.inputTokens)}`);
  if (stats.outputTokens != null) parts.push(`out ${compactNumber(stats.outputTokens)}`);
  if (stats.costUsd != null) parts.push(`$${stats.costUsd.toFixed(2)}`);
  return parts.length ? parts.join(" · ") : null;
}

function desktopRouteForCommand(commandName: string | null | undefined): string | null {
  if (!commandName) return null;
  return DESKTOP_COMMAND_ROUTES[commandName] ?? null;
}

function splitFirstArg(input: string): { first: string; rest: string } {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    first: match?.[1] ?? "",
    rest: match?.[2]?.trim() ?? "",
  };
}

type ParsedAdeActionPayload =
  | { args: Record<string, unknown> }
  | { argsList: unknown[] }
  | { arg: unknown };

function parseAdeActionPayload(input: string): ParsedAdeActionPayload {
  const trimmed = input.trim();
  if (!trimmed) return { args: {} };
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) {
    return { argsList: parsed };
  }
  if (parsed && typeof parsed === "object") {
    return { args: parsed as Record<string, unknown> };
  }
  return { arg: parsed };
}

function parseLinearIssueListArgs(input: string): Record<string, unknown> {
  const projectSlugs: string[] = [];
  const stateTypes: string[] = [];
  let limit: number | undefined;
  const tokens = input.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g)?.map((token) => (
    token.startsWith("\"") && token.endsWith("\"")
      ? token.slice(1, -1).replace(/\\"/g, "\"")
      : token.startsWith("'") && token.endsWith("'")
        ? token.slice(1, -1)
        : token
  )) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1];
    if ((token === "--project" || token === "--project-slug" || token === "--projects") && next) {
      projectSlugs.push(...next.split(",").map((entry) => entry.trim()).filter(Boolean));
      index += 1;
    } else if ((token === "--state" || token === "--states" || token === "--state-type") && next) {
      stateTypes.push(...next.split(",").map((entry) => entry.trim()).filter(Boolean));
      index += 1;
    } else if (token === "--limit" && next && Number.isFinite(Number(next))) {
      limit = Math.max(1, Math.min(100, Math.floor(Number(next))));
      index += 1;
    } else if (!token.startsWith("--")) {
      projectSlugs.push(token);
    }
  }
  return {
    projectSlugs,
    stateTypes,
    ...(limit ? { limit } : {}),
  };
}

function printableInput(input: string): string {
  return input.replace(/[\u0000-\u001f\u007f]/g, "");
}

function inputBeforeLineBreak(input: string): string | null {
  const index = input.search(/[\r\n]/);
  return index === -1 ? null : input.slice(0, index);
}

function activeMention(value: string): { start: number; query: string } | null {
  const match = value.match(/(^|\s)@([^\s@]*)$/);
  if (!match || match.index == null) return null;
  return {
    start: match.index + match[1].length,
    query: match[2] ?? "",
  };
}

function useTerminalDimensions(): [number, number] {
  const read = (): [number, number] => [
    process.stdout.columns ?? 120,
    process.stdout.rows ?? 40,
  ];
  const [dimensions, setDimensions] = useState<[number, number]>(read);
  useEffect(() => {
    const handleResize = () => setDimensions(read());
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);
  return dimensions;
}

export function AdeCodeApp({ project, forceEmbedded, requireSocket, socketPath }: AdeCodeAppProps) {
  const { exit } = useApp();
  const [columns, rows] = useTerminalDimensions();
  const [connection, setConnection] = useState<AdeCodeConnection | null>(null);
  const [mode, setMode] = useState<RuntimeMode | "connecting">("connecting");
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [activeLaneId, setActiveLaneId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentChatEventEnvelope[]>([]);
  const [notices, setNotices] = useState<LocalNotice[]>([]);
  const [slashCommands, setSlashCommands] = useState<AgentChatSlashCommand[]>([]);
  const [models, setModels] = useState<AgentChatModelInfo[]>([]);
  const [modelState, setModelState] = useState<AdeCodeModelState>(initialModelState);
  const [rightPane, setRightPane] = useState<RightPaneContent>({ kind: "empty" });
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formFieldIndex, setFormFieldIndex] = useState(0);
  const [rightSelectionIndex, setRightSelectionIndex] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tuiCount, setTuiCount] = useState(1);
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const [tokenSummary, setTokenSummary] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [desktopDriving, setDesktopDriving] = useState(false);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [expandedLineIds, setExpandedLineIds] = useState<Set<string>>(() => new Set());
  const [mentionSuggestions, setMentionSuggestions] = useState<MentionSuggestion[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [selectedMentions, setSelectedMentions] = useState<MentionSuggestion[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [drawerSection, setDrawerSection] = useState<"lanes" | "chats">("lanes");
  const [drawerLaneId, setDrawerLaneId] = useState<string | null>(null);
  const [selectedDrawerLaneId, setSelectedDrawerLaneId] = useState<string | null>(null);
  const [selectedDrawerChatId, setSelectedDrawerChatId] = useState<string | null>(null);

  const connectionRef = useRef<AdeCodeConnection | null>(null);
  const activeLaneIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const lastLocalSendAtRef = useRef<number>(0);
  const eventCountRef = useRef<number>(0);
  const heartbeatRef = useRef<TuiHeartbeat | null>(null);

  const selectActiveLaneId = useCallback((laneId: string | null) => {
    activeLaneIdRef.current = laneId;
    setActiveLaneId(laneId);
  }, []);

  const selectActiveSessionId = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  }, []);

  const projectName = path.basename(project.projectRoot);
  const activeLane = useMemo(
    () => lanes.find((lane) => lane.id === activeLaneId) ?? null,
    [activeLaneId, lanes],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.sessionId === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const latestFailedLineId = useMemo(() => latestExpandableFailureId(events), [events]);
  const drawerLaneRows = useMemo(() => lanes.slice(0, 10), [lanes]);
  const drawerLaneSessions = useMemo(
    () => sessions.filter((session) => session.laneId === drawerLaneId),
    [drawerLaneId, sessions],
  );
  const selectedLaneIndex = useMemo(() => {
    const targetId = selectedDrawerLaneId ?? drawerLaneId ?? activeLaneId;
    const index = drawerLaneRows.findIndex((lane) => lane.id === targetId);
    return index >= 0 ? index : 0;
  }, [activeLaneId, drawerLaneId, drawerLaneRows, selectedDrawerLaneId]);
  const selectedChatIndex = useMemo(() => {
    const targetId = selectedDrawerChatId
      ?? (drawerLaneId === activeLaneId ? activeSessionId : null);
    const index = drawerLaneSessions.findIndex((session) => session.sessionId === targetId);
    return index >= 0 ? index : 0;
  }, [activeLaneId, activeSessionId, drawerLaneId, drawerLaneSessions, selectedDrawerChatId]);
  const activeMentionRange = useMemo(() => activeMention(prompt), [prompt]);
  const slashRows = useMemo(() => (
    prompt.startsWith("/") ? paletteCommands(prompt, slashCommands) : []
  ), [prompt, slashCommands]);
  const pendingApproval = useMemo(() => latestPendingApproval(events), [events]);
  const activeFormField = rightPane.kind === "form"
    ? rightPane.fields[formFieldIndex] ?? rightPane.fields[0] ?? null
    : null;

  useEffect(() => {
    activeLaneIdRef.current = activeLaneId;
  }, [activeLaneId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!drawerLaneId || !lanes.some((lane) => lane.id === drawerLaneId)) {
      setDrawerLaneId(activeLaneId);
    }
  }, [activeLaneId, drawerLaneId, lanes]);

  useEffect(() => {
    if (selectedDrawerLaneId && drawerLaneRows.some((lane) => lane.id === selectedDrawerLaneId)) return;
    setSelectedDrawerLaneId(drawerLaneId ?? activeLaneId ?? drawerLaneRows[0]?.id ?? null);
  }, [activeLaneId, drawerLaneId, drawerLaneRows, selectedDrawerLaneId]);

  useEffect(() => {
    if (selectedDrawerChatId && drawerLaneSessions.some((session) => session.sessionId === selectedDrawerChatId)) return;
    const activeChatInDrawer = drawerLaneSessions.find((session) => session.sessionId === activeSessionId);
    setSelectedDrawerChatId(activeChatInDrawer?.sessionId ?? drawerLaneSessions[0]?.sessionId ?? null);
  }, [activeSessionId, drawerLaneSessions, selectedDrawerChatId]);

  useEffect(() => {
    setSlashIndex(0);
  }, [prompt]);

  const addNotice = useCallback((text: string, tone: LocalNotice["tone"] = "info") => {
    setNotices((prev) => [
      ...prev.slice(-10),
      { id: noticeId(), timestamp: new Date().toISOString(), text, tone },
    ]);
  }, []);

  const openForm = useCallback((content: Extract<RightPaneContent, { kind: "form" }>) => {
    const nextValues = Object.fromEntries(content.fields.map((field) => [field.name, field.initialValue ?? ""]));
    setFormValues(nextValues);
    setFormFieldIndex(0);
    setPrompt(content.fields[0]?.initialValue ?? "");
    setRightPane(content);
    setRightOpen(true);
  }, []);

  useEffect(() => {
    const range = activeMentionRange;
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (!range) {
      setMentionSuggestions([]);
      setMentionIndex(0);
      return;
    }
    let cancelled = false;
    const query = range.query.toLowerCase();
    const localSuggestions: MentionSuggestion[] = [
      ...lanes.map((lane) => ({
        kind: "lane" as const,
        label: lane.name,
        insertText: `@lane:${lane.id}`,
        detail: lane.branchRef ?? lane.id,
      })),
      ...sessions.slice(0, 30).map((session) => ({
        kind: "chat" as const,
        label: session.title ?? session.sessionId,
        insertText: `@chat:${session.sessionId}`,
        detail: session.laneId,
      })),
    ].filter((suggestion) => (
      !query
      || suggestion.label.toLowerCase().includes(query)
      || suggestion.insertText.toLowerCase().includes(query)
      || suggestion.detail?.toLowerCase().includes(query)
    ));

    const loadRemoteSuggestions = async () => {
      const remote: MentionSuggestion[] = [];
      if (conn && laneId) {
        const [files, commits, prs] = await Promise.all([
          query
            ? conn.action<Array<{ path: string }>>("file", "quickOpen", {
                workspaceId: laneId,
                query,
                limit: 5,
              }).catch(() => [])
            : Promise.resolve([]),
          conn.action<Array<Record<string, unknown>>>("git", "listRecentCommits", {
            laneId,
            limit: 8,
          }).catch(() => []),
          conn.action<Array<Record<string, unknown>>>("pr", "listAll", { laneId }).catch(() => []),
        ]);
        remote.push(...files.map((file) => ({
          kind: "file" as const,
          label: file.path,
          insertText: `@file:${file.path}`,
          detail: "file",
          filePath: file.path,
        })));
        remote.push(...commits
          .filter((commit) => {
            const subject = String(commit.subject ?? commit.message ?? "");
            const sha = String(commit.shortSha ?? commit.sha ?? "");
            return !query || subject.toLowerCase().includes(query) || sha.toLowerCase().includes(query);
          })
          .slice(0, 5)
          .map((commit) => {
            const sha = String(commit.shortSha ?? commit.sha ?? "commit");
            return {
              kind: "commit" as const,
              label: String(commit.subject ?? commit.message ?? sha),
              insertText: `@commit:${sha}`,
              detail: sha,
            };
          }));
        remote.push(...prs
          .filter((pr) => {
            const title = String(pr.title ?? "");
            const number = String(pr.number ?? pr.prNumber ?? "");
            return !query || title.toLowerCase().includes(query) || number.includes(query);
          })
          .slice(0, 5)
          .map((pr) => {
            const id = String(pr.id ?? pr.prId ?? pr.number ?? "pr");
            return {
              kind: "pr" as const,
              label: String(pr.title ?? `PR ${id}`),
              insertText: `@pr:${id}`,
              detail: pr.number != null ? `#${String(pr.number)}` : id,
            };
          }));
      }
      if (cancelled) return;
      const next = [...localSuggestions, ...remote].slice(0, 10);
      setMentionSuggestions(next);
      setMentionIndex((index) => Math.min(index, Math.max(0, next.length - 1)));
    };
    void loadRemoteSuggestions();
    return () => {
      cancelled = true;
    };
  }, [activeMentionRange, lanes, sessions]);

  const refreshState = useCallback(async () => {
    const conn = connectionRef.current;
    if (!conn) return;
    const nextLanes = await listLanes(conn);
    const nextLane = nextLanes.find((lane) => lane.id === activeLaneIdRef.current)
      ?? chooseInitialLane(nextLanes, project);
    const nextLaneId = nextLane?.id ?? null;
    const nextSessions = await listChatSessions(conn);
    const laneSessions = nextSessions.filter((session) => session.laneId === nextLaneId);
    const activeSessionId = activeSessionIdRef.current;
    const nextSession = activeSessionId
      ? nextSessions.find((session) => session.sessionId === activeSessionId) ?? null
      : null;
    const nextSessionId = nextSession?.sessionId ?? null;
    let nextEvents: AgentChatEventEnvelope[] = [];
    if (nextSessionId) {
      const history = await getChatHistory(conn, nextSessionId);
      nextEvents = clearedAt
        ? history.events.filter((event) => event.timestamp > clearedAt)
        : history.events;
      const stats = latestTokenStats(history.events);
      setContextPercent(stats.percent);
      setTokenSummary(formatTokenSummary(stats));
      setStreaming(nextSession?.status === "active");
      const previousCount = eventCountRef.current;
      eventCountRef.current = history.events.length;
      if (previousCount > 0 && history.events.length > previousCount && Date.now() - lastLocalSendAtRef.current > 4_000) {
        setDesktopDriving(true);
        setTimeout(() => setDesktopDriving(false), 3_000);
      }
    }
    const nextProvider = nextSession?.provider ?? "codex";
    const nextCommands = await getSlashCommands(conn, nextSessionId).catch(() => []);
    const nextModels = await getAvailableModels(conn, nextProvider).catch(() => []);
    const activeModel = nextModels.find((model) => model.modelId === nextSession?.modelId || model.id === nextSession?.modelId)
      ?? nextModels.find((model) => model.isDefault)
      ?? null;
    setLanes(nextLanes);
    setSessions(nextSessions);
    selectActiveLaneId(nextLaneId);
    selectActiveSessionId(nextSessionId);
    setEvents(nextEvents);
    setSlashCommands(nextCommands);
    setModels(nextModels);
    setTuiCount(heartbeatRef.current?.readCount() ?? 1);
    setModelState({
      provider: PROVIDERS.has(nextProvider) ? nextProvider as AdeCodeModelState["provider"] : "codex",
      model: nextSession?.model ?? activeModel?.id ?? modelState.model,
      modelId: nextSession?.modelId ?? activeModel?.modelId ?? activeModel?.id ?? modelState.modelId,
      displayName: activeModel?.displayName ?? nextSession?.model ?? modelState.displayName,
      reasoningEffort: nextSession?.reasoningEffort ?? modelState.reasoningEffort,
    });
  }, [clearedAt, modelState.displayName, modelState.model, modelState.modelId, modelState.reasoningEffort, project, selectActiveLaneId, selectActiveSessionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const conn = await connectToAde({ project, forceEmbedded, requireSocket, socketPath });
        if (cancelled) {
          await conn.close();
          return;
        }
        heartbeatRef.current = startTuiHeartbeat(project.projectRoot);
        connectionRef.current = conn;
        setConnection(conn);
        setMode(conn.mode);
        await refreshState();
      } catch (err) {
        heartbeatRef.current?.stop();
        heartbeatRef.current = null;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      heartbeatRef.current?.stop();
      heartbeatRef.current = null;
      const conn = connectionRef.current;
      connectionRef.current = null;
      void conn?.close().catch(() => {});
    };
  }, [forceEmbedded, project, requireSocket, socketPath]);

  useEffect(() => {
    if (!connection) return;
    return connection.onChatEvent((envelope) => {
      if (envelope.sessionId !== activeSessionIdRef.current) {
        void refreshState().catch(() => undefined);
        return;
      }
      if (clearedAt && envelope.timestamp <= clearedAt) return;
      setEvents((prev) => {
        const key = `${envelope.sequence ?? ""}:${envelope.timestamp}:${envelope.event.type}`;
        if (prev.some((entry) => `${entry.sequence ?? ""}:${entry.timestamp}:${entry.event.type}` === key)) return prev;
        return [...prev, envelope].slice(-500);
      });
      const event = envelope.event as Record<string, unknown>;
      if (event.type === "status" && event.turnStatus === "started") setStreaming(true);
      if (event.type === "done" || (event.type === "status" && event.turnStatus === "completed")) setStreaming(false);
      if (Date.now() - lastLocalSendAtRef.current > 4_000) {
        setDesktopDriving(true);
        setTimeout(() => setDesktopDriving(false), 3_000);
      }
    });
  }, [clearedAt, connection, refreshState]);

  useEffect(() => {
    if (!connection) return;
    const timer = setInterval(() => {
      void refreshState().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [connection, refreshState]);

  const ensureActiveSession = useCallback(async (): Promise<string | null> => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (!conn || !laneId) return null;
    if (activeSessionIdRef.current) return activeSessionIdRef.current;
    const created = await createChatSession({
      connection: conn,
      laneId,
      modelId: modelState.modelId,
      reasoningEffort: modelState.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
    });
    selectActiveSessionId(created.id);
    await refreshState();
    return created.id;
  }, [modelState.modelId, modelState.reasoningEffort, refreshState, selectActiveSessionId]);

  const resolvePendingApproval = useCallback(async (
    approval: PendingApproval,
    decision: "accept" | "decline" | "cancel" | "accept_for_session",
    responseText?: string | null,
  ) => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId) return;
    await approveToolUse({
      connection: conn,
      sessionId,
      itemId: approval.itemId,
      decision,
      responseText,
    });
    addNotice(decision === "accept" || decision === "accept_for_session" ? "Approved request." : "Declined request.", "info");
    await refreshState();
  }, [addNotice, refreshState]);

  const answerPendingInput = useCallback(async (approval: PendingApproval, text: string) => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId) return;
    const trimmed = text.trim();
    const lowered = trimmed.toLowerCase();
    if (lowered === "deny" || lowered === "decline" || lowered === "cancel") {
      await respondToInput({
        connection: conn,
        sessionId,
        itemId: approval.itemId,
        decision: lowered === "cancel" ? "cancel" : "decline",
      });
      addNotice("Declined request.", "info");
      await refreshState();
      return;
    }
    await respondToInput({
      connection: conn,
      sessionId,
      itemId: approval.itemId,
      decision: "accept",
      answers: buildPendingInputAnswers(approval.request, trimmed),
      responseText: trimmed,
    });
    addNotice("Answered request.", "success");
    await refreshState();
  }, [addNotice, refreshState]);

  const runRightCommand = useCallback(async (name: string, args: string) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    setRightOpen(true);

    if (name === "/help") {
      setRightPane({ kind: "help", title: "Help" });
      return;
    }
    if (name === "/status") {
      setRightPane({
        kind: "status",
        rows: [
          ["project", project.projectRoot],
          ["workspace", project.workspaceRoot],
          ["lane", activeLane?.name ?? laneId ?? "none"],
          ["chat", activeSession?.title ?? activeSession?.sessionId ?? "none"],
          ["runtime", mode],
          ["socket", conn.socketPath ?? "embedded"],
        ],
      });
      return;
    }
    if (name === "/new chat") {
      if (!laneId) {
        setRightPane({ kind: "details", title: "New chat", body: "No active lane is available." });
        return;
      }
      if (!args) {
        openForm({
          kind: "form",
          title: "New chat",
          command: "new-chat",
          fields: [
            { name: "title", label: "Title", placeholder: "Untitled chat" },
            { name: "message", label: "First message", placeholder: "Optional" },
          ],
        });
        return;
      }
      const created = await createChatSession({
        connection: conn,
        laneId,
        title: args,
        modelId: modelState.modelId,
        reasoningEffort: modelState.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
      });
      selectActiveSessionId(created.id);
      addNotice(`Created chat "${args}".`, "success");
      await refreshState();
      return;
    }
    if (name === "/new lane") {
      if (!args) {
        openForm({
          kind: "form",
          title: "New lane",
          command: "new-lane",
          fields: [
            { name: "name", label: "Name", required: true, placeholder: "feature-name" },
            { name: "baseBranch", label: "Base branch", placeholder: "default" },
          ],
        });
        return;
      }
      const created = await conn.action<LaneSummary>("lane", "create", { name: args });
      selectActiveLaneId(created.id);
      selectActiveSessionId(null);
      setRightPane({ kind: "details", title: "New lane", body: renderObject(created, 20) });
      await refreshState();
      return;
    }
    if (name === "/rename") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Rename chat", body: "No active chat is selected." });
        return;
      }
      if (!args) {
        openForm({
          kind: "form",
          title: "Rename chat",
          command: "rename",
          fields: [
            { name: "title", label: "Title", required: true, initialValue: activeSession?.title ?? "" },
          ],
        });
        return;
      }
      await renameChat(conn, sessionId, args);
      addNotice(`Renamed chat to "${args}".`, "success");
      await refreshState();
      return;
    }
    if (name === "/diff") {
      if (!laneId) {
        setRightPane({ kind: "details", title: "Diff", body: "No active lane is selected." });
        return;
      }
      const diff = await conn.actionList("diff", "getChanges", [laneId]);
      setRightPane({ kind: "diff", title: "Diff", files: summarizeDiffChanges(diff) });
      return;
    }
    if (name === "/log") {
      if (!laneId) {
        setRightPane({ kind: "details", title: "Recent commits", body: "No active lane is selected." });
        return;
      }
      const log = await conn.action("git", "listRecentCommits", { laneId, limit: 12 });
      setRightPane({ kind: "list", title: "Recent commits", rows: routeRows(log), emptyText: "No commits." });
      return;
    }
    if (name.startsWith("/pr")) {
      if (!laneId) {
        setRightPane({ kind: "details", title: name.slice(1) || "PR", body: "No active lane is selected." });
        return;
      }
      const prs = await conn.action<Array<Record<string, unknown>>>("pr", "listAll", laneId ? { laneId } : {});
      const activePr = prs[0] ?? null;
      const prId = activePr ? String(activePr.id ?? activePr.prId ?? "") : "";
      if (name === "/pr") {
        const ahead = activeLane?.status?.ahead ?? 0;
        setRightPane({
          kind: "details",
          title: "PR",
          body: activePr
            ? renderObject(activePr, 24)
            : `No PR is linked to this lane yet.\n${ahead > 0 ? `${ahead} commit${ahead === 1 ? "" : "s"} ahead of base.\n` : ""}Run /pr open <title> to create a draft.`,
        });
        return;
      }
      if (name === "/pr open") {
        if (activePr) {
          await navigateDesktop(conn, {
            source: "ade-code",
            target: {
              kind: "pr",
              prId,
              laneId,
              prNumber: typeof activePr.number === "number" ? activePr.number : null,
            },
          });
          setRightPane({ kind: "details", title: "PR open", body: renderObject(activePr, 24) });
          return;
        }
        if (!args) {
          openForm({
            kind: "form",
            title: "Open PR",
            command: "pr-open",
            fields: [
              { name: "title", label: "Title", required: true, placeholder: activeLane?.name ?? "Draft PR" },
              { name: "body", label: "Body", placeholder: "Optional" },
            ],
          });
          return;
        }
        const created = await conn.action("pr", "createFromLane", {
          laneId,
          title: args,
          body: "",
          draft: true,
        });
        setRightPane({ kind: "details", title: "PR open", body: renderObject(created, 24) });
        return;
      }
      if (!prId) {
        setRightPane({ kind: "details", title: name.slice(1), body: "No PR is linked to this lane yet." });
        return;
      }
      const pr = name === "/pr checks"
        ? await conn.actionList("pr", "getChecks", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
        : await Promise.all([
            conn.actionList("pr", "getReviews", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
            conn.actionList("pr", "getReviewThreads", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
          ]).then(([reviews, threads]) => ({ reviews, threads }));
      setRightPane({ kind: "details", title: name.slice(1), body: renderObject(pr, 24) });
      return;
    }
    if (name === "/linear list") {
      const linear = await conn.action("linear_issue_tracker", "listIssues", parseLinearIssueListArgs(args || "--limit 20"));
      setRightPane({ kind: "list", title: "Linear", rows: routeRows(linear), emptyText: "No Linear issues." });
      return;
    }
    if (name === "/linear status") {
      const status = await conn.action("linear_issue_tracker", "getStatus", {});
      setRightPane({ kind: "details", title: "Linear status", body: renderObject(status, 24) });
      return;
    }
    if (name === "/linear pull") {
      if (!args) {
        setRightPane({ kind: "details", title: "Linear pull", body: "Usage: /linear pull <issue-id>" });
        return;
      }
      const issue = await conn.actionList("linear_issue_tracker", "fetchIssueById", [args]);
      if (!issue) {
        setRightPane({ kind: "details", title: "Linear pull", body: `Linear issue ${args} was not found.` });
        return;
      }
      const targetSessionId = await ensureActiveSession();
      const issueContext = `Linear issue context:\n${renderObject(issue, 28)}`;
      if (targetSessionId) {
        await sendChatMessage(conn, targetSessionId, issueContext);
      }
      setRightPane({ kind: "details", title: "Linear pull", body: issueContext });
      return;
    }
    if (name === "/linear comment") {
      const parsed = splitFirstArg(args);
      if (!parsed.first || !parsed.rest) {
        setRightPane({ kind: "details", title: "Linear comment", body: "Usage: /linear comment <issue-id> <text>" });
        return;
      }
      const result = await conn.actionList("linear_issue_tracker", "createComment", [parsed.first, parsed.rest]);
      setRightPane({ kind: "details", title: "Linear comment", body: renderObject(result, 12) });
      addNotice(`Commented on ${parsed.first}.`, "success");
      return;
    }
    if (name === "/linear assign") {
      const parsed = splitFirstArg(args);
      if (!parsed.first || !parsed.rest) {
        setRightPane({ kind: "details", title: "Linear assign", body: "Usage: /linear assign <issue-id> <user-id|none>" });
        return;
      }
      const normalizedAssignee = parsed.rest.toLowerCase();
      const assigneeId = normalizedAssignee === "none" || normalizedAssignee === "null" || normalizedAssignee === "unassigned"
        ? null
        : parsed.rest;
      await conn.actionList("linear_issue_tracker", "updateIssueAssignee", [parsed.first, assigneeId]);
      setRightPane({
        kind: "details",
        title: "Linear assign",
        body: assigneeId ? `Assigned ${parsed.first} to ${assigneeId}.` : `Cleared assignee for ${parsed.first}.`,
      });
      addNotice(`Updated ${parsed.first}.`, "success");
      return;
    }
    if (name === "/linear" || name.startsWith("/linear ")) {
      const linearInput = `${name.slice("/linear".length)} ${args}`.trim();
      const request = buildLinearToolRequest(linearInput);
      if (request.kind === "usage") {
        setRightPane({ kind: "details", title: request.title, body: request.body });
        return;
      }
      const result = await conn.tool(request.toolName, request.args);
      setRightPane({ kind: "details", title: request.title, body: renderObject(result, 24) });
      return;
    }
    if (name === "/memory") {
      const query = args || "project";
      const result = await conn.tool("memory_search", { query, scope: "project", limit: 10 });
      setRightPane({ kind: "details", title: "Memory", body: renderObject(result, 24) });
      return;
    }
    if (name === "/forget") {
      setRightPane({ kind: "details", title: "Forget", body: "Memory lifecycle controls are available in desktop. Run /open to continue there." });
      return;
    }
    if (name === "/chats") {
      const laneSessions = sessions.filter((session) => session.laneId === laneId);
      const selectedIndex = Math.max(0, laneSessions.findIndex((session) => session.sessionId === sessionId));
      setRightSelectionIndex(selectedIndex);
      setRightPane({
        kind: "list",
        title: "Chats",
        rows: laneSessions.map((session) => `${session.sessionId === sessionId ? "●" : "○"} ${session.title ?? session.sessionId}`),
        emptyText: "No chats in this lane.",
        action: { kind: "switch-chat", ids: laneSessions.map((session) => session.sessionId) },
      });
      return;
    }
    if (name === "/switch") {
      const query = args.toLowerCase();
      if (!query) {
        const selectedIndex = Math.max(0, lanes.findIndex((lane) => lane.id === laneId));
        setRightSelectionIndex(selectedIndex);
        setRightPane({
          kind: "list",
          title: "Switch",
          rows: lanes.map((lane) => `${lane.id === laneId ? "●" : "○"} ${lane.name}`),
          emptyText: "No lanes.",
          action: { kind: "switch-lane", ids: lanes.map((lane) => lane.id) },
        });
        return;
      }
      const lane = lanes.find((entry) => entry.id.toLowerCase() === query || entry.name.toLowerCase().includes(query));
      if (lane) {
        selectActiveLaneId(lane.id);
        setDrawerLaneId(lane.id);
        setSelectedDrawerLaneId(lane.id);
        const session = newestSession(sessions.filter((entry) => entry.laneId === lane.id));
        selectActiveSessionId(session?.sessionId ?? null);
        setSelectedDrawerChatId(session?.sessionId ?? null);
        addNotice(`Switched to lane ${lane.name}.`, "success");
      } else {
        setRightPane({ kind: "details", title: "Switch", body: `No lane matched "${args}".` });
      }
      return;
    }
    if (name === "/resume") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Resume", body: "No active chat is selected." });
        return;
      }
      await resumeChat(conn, sessionId);
      addNotice("Resumed chat.", "success");
      await refreshState();
      return;
    }
    if (name === "/model") {
      if (args) {
        if (!sessionId) {
          const model = models.find((entry) => entry.id === args || entry.modelId === args);
          setModelState((prev) => ({
            ...prev,
            model: model?.id ?? args,
            modelId: model?.modelId ?? model?.id ?? args,
            displayName: model?.displayName ?? args,
          }));
          addNotice(`Default model set to ${model?.displayName ?? args}.`, "success");
          return;
        }
        await updateChatModel({ connection: conn, sessionId, modelId: args });
        addNotice(`Model set to ${args}.`, "success");
        await refreshState();
        return;
      }
      setRightSelectionIndex(Math.max(0, models.findIndex((model) => (
        model.id === modelState.modelId || model.modelId === modelState.modelId
      ))));
      setRightPane({ kind: "models", models, activeModelId: modelState.modelId });
      return;
    }
    if (name === "/effort") {
      if (args) {
        if (!EFFORTS.includes(args)) {
          setRightPane({ kind: "details", title: "Effort", body: `Usage: /effort <${EFFORTS.join("|")}>` });
          return;
        }
        if (!sessionId) {
          setModelState((prev) => ({ ...prev, reasoningEffort: args }));
          addNotice(`Default effort set to ${args}.`, "success");
          return;
        }
        await updateChatModel({ connection: conn, sessionId, reasoningEffort: args });
        addNotice(`Effort set to ${args}.`, "success");
        await refreshState();
        return;
      }
      setRightSelectionIndex(Math.max(0, EFFORTS.findIndex((effort) => effort === modelState.reasoningEffort)));
      setRightPane({ kind: "effort", efforts: EFFORTS, activeEffort: modelState.reasoningEffort });
      return;
    }
    if (name === "/system") {
      setRightPane({
        kind: "details",
        title: "System",
        body: renderObject({ mode, project, socketPath: conn.socketPath, pid: process.pid }, 24),
      });
      return;
    }
    if (name === "/ade") {
      const parsed = splitFirstArg(args);
      const possibleBuiltin = parsed.first.startsWith("/") ? parsed.first : `/${parsed.first}`;
      const alias = possibleBuiltin !== "/ade"
        ? parseCommand(`${possibleBuiltin}${parsed.rest ? ` ${parsed.rest}` : ""}`, [])
        : null;
      if (alias?.spec?.placement === "right") {
        await runRightCommand(alias.name, alias.args);
        return;
      }
      if (alias?.spec?.placement === "inline") {
        setRightPane({
          kind: "details",
          title: "ADE command",
          body: `/${parsed.first.replace(/^\//, "")} is an inline TUI command. Run it before creating a runtime chat, or use the keyboard shortcut when available.`,
        });
        return;
      }
      const [domain, action] = parsed.first.split(".", 2);
      if (!domain || !action) {
        setRightPane({
          kind: "details",
          title: "ADE action",
          body: "Usage: /ade <domain.action|status|diff|model|effort|help> [json-object|json-array|json-scalar]",
        });
        return;
      }
      const result = await conn.tool("run_ade_action", {
        domain,
        action,
        ...parseAdeActionPayload(parsed.rest),
      });
      const body = result && typeof result === "object" && "result" in result
        ? (result as { result?: unknown }).result
        : result;
      setRightPane({ kind: "details", title: `ADE ${domain}.${action}`, body: renderObject(body, 24) });
    }
  }, [activeLane?.name, activeSession?.sessionId, activeSession?.title, addNotice, ensureActiveSession, lanes, mode, modelState.modelId, modelState.reasoningEffort, models, openForm, project, refreshState, selectActiveLaneId, selectActiveSessionId, sessions]);

  const runInlineCommand = useCallback(async (name: string, args: string) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    if (name === "/quit") {
      exit();
      return;
    }
    if (name === "/clear") {
      setClearedAt(new Date().toISOString());
      setEvents([]);
      addNotice("Local transcript view cleared. The durable chat remains in ADE.", "info");
      return;
    }
    if (name === "/end") {
      if (!sessionId) {
        addNotice("No active chat is selected.", "error");
        return;
      }
      await conn.action("chat", "dispose", { sessionId });
      addNotice("Ended active chat runtime.", "success");
      await refreshState();
      return;
    }
    if (name === "/commit") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      if (!args) {
        addNotice("Usage: /commit <message>", "error");
        return;
      }
      const result = await conn.action("git", "commit", { laneId, message: args });
      addNotice(`Commit complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/push") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      const result = await conn.action("git", "push", { laneId });
      addNotice(`Push complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/remember") {
      if (!args) {
        addNotice("Usage: /remember <durable fact>", "error");
        return;
      }
      const result = await conn.tool("memory_add", {
        content: args,
        scope: "project",
        category: "decision",
        importance: "medium",
      });
      addNotice(`Memory saved: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/open") {
      const target = sessionId
        ? { kind: "chat" as const, sessionId, laneId }
        : laneId
          ? { kind: "lane" as const, laneId }
          : { kind: "work" as const };
      const result = await navigateDesktop(conn, { source: "ade-code", target });
      if (result.ok) {
        addNotice("Opened ADE desktop at this context.", "success");
        return;
      }
      if (process.platform === "darwin") {
        spawn("open", [
          "-a",
          "ADE",
          "--env",
          `ADE_PROJECT_ROOT=${project.projectRoot}`,
          project.projectRoot,
        ], { stdio: "ignore", detached: true }).unref();
        addNotice(result.message ?? "Desktop route unavailable; launched ADE.", "info");
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await delay(750);
          const attached = await connectToAde({ project, forceEmbedded: false, socketPath }).catch(() => null);
          if (!attached || attached.mode !== "attached") {
            await attached?.close().catch(() => {});
            continue;
          }
          const retry = await navigateDesktop(attached, { source: "ade-code", target }).catch(() => null);
          if (!retry?.ok) {
            await attached.close().catch(() => {});
            continue;
          }
          const previous = connectionRef.current;
          connectionRef.current = attached;
          setConnection(attached);
          setMode(attached.mode);
          await previous?.close().catch(() => {});
          addNotice("Attached to desktop and opened this context.", "success");
          await refreshState();
          return;
        }
      } else {
        addNotice(result.message ?? "Desktop route unavailable from this runtime.", "error");
      }
    }
  }, [addNotice, exit, project, refreshState, socketPath]);

  const submitRightForm = useCallback(async (
    form: Extract<RightPaneContent, { kind: "form" }>,
    values: Record<string, string>,
  ) => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn) return;

    const requireField = (name: string, label: string): string | null => {
      const value = values[name]?.trim() ?? "";
      if (value) return value;
      addNotice(`${label} is required.`, "error");
      return null;
    };

    if (form.command === "new-chat") {
      if (!laneId) return;
      const title = values.title?.trim() || null;
      const message = values.message?.trim() ?? "";
      const created = await createChatSession({
        connection: conn,
        laneId,
        title,
        modelId: modelState.modelId,
        reasoningEffort: modelState.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
      });
      selectActiveSessionId(created.id);
      if (message) {
        await sendChatMessage(conn, created.id, message);
      }
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      addNotice(title ? `Created chat "${title}".` : "Created chat.", "success");
      await refreshState();
      return;
    }

    if (form.command === "new-lane") {
      const name = requireField("name", "Name");
      if (!name) return;
      const baseBranch = values.baseBranch?.trim();
      const created = await conn.action<LaneSummary>("lane", "create", {
        name,
        ...(baseBranch ? { baseBranch } : {}),
      });
      selectActiveLaneId(created.id);
      selectActiveSessionId(null);
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      addNotice(`Created lane ${created.name}.`, "success");
      await refreshState();
      return;
    }

    if (form.command === "rename") {
      if (!sessionId) return;
      const title = requireField("title", "Title");
      if (!title) return;
      await renameChat(conn, sessionId, title);
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      addNotice(`Renamed chat to "${title}".`, "success");
      await refreshState();
      return;
    }

    if (form.command === "pr-open") {
      if (!laneId) return;
      const title = requireField("title", "Title");
      if (!title) return;
      const body = values.body?.trim() ?? "";
      const created = await conn.action("pr", "createFromLane", {
        laneId,
        title,
        body,
        draft: true,
      });
      setRightPane({ kind: "details", title: "PR open", body: renderObject(created, 24) });
      addNotice("Created draft PR.", "success");
      await refreshState();
    }
  }, [addNotice, modelState.modelId, modelState.reasoningEffort, refreshState, selectActiveLaneId, selectActiveSessionId]);

  const submitPrompt = useCallback(async (value: string) => {
    const text = value.trim();
    if (!text && rightPane.kind !== "form") return;
    const conn = connectionRef.current;
    if (!conn) return;
    try {
      if (desktopDriving && streaming && !text.startsWith("/") && rightPane.kind !== "form") {
        addNotice("Desktop is driving this chat; draft kept locally until the stream settles.", "info");
        return;
      }
      setPrompt("");
      setError(null);
      if (pendingApproval?.mode === "approval") {
        const lowered = text.toLowerCase();
        if (pendingApproval.highStakes) {
          if (lowered === "approve" || lowered === "deny") {
            await resolvePendingApproval(pendingApproval, lowered === "approve" ? "accept" : "decline");
            return;
          }
          addNotice("Type approve or deny to resolve the high-stakes request.", "error");
          return;
        }
        if (lowered === "approve" || lowered === "a" || lowered === "deny" || lowered === "d") {
          await resolvePendingApproval(pendingApproval, lowered === "approve" || lowered === "a" ? "accept" : "decline");
          return;
        }
        addNotice("Press a to approve or d to deny this request.", "error");
        return;
      }
      if (pendingApproval?.mode === "question") {
        await answerPendingInput(pendingApproval, value);
        return;
      }
      if (rightPane.kind === "form" && !text.startsWith("/")) {
        const field = activeFormField;
        const values = field ? { ...formValues, [field.name]: value } : formValues;
        setFormValues(values);
        await submitRightForm(rightPane, values);
        return;
      }
      const parsed = parseCommand(text, slashCommands);
      if (text.startsWith("/") && parsed && !parsed.spec && !parsed.userCommand && slashRows.length) {
        const selected = slashRows[slashIndex] ?? slashRows[0];
        if (selected) {
          const selectedCommand = parseCommand(selected.name, slashCommands);
          if (selectedCommand?.spec?.placement === "inline") {
            await runInlineCommand(selectedCommand.name, selectedCommand.args);
            return;
          }
          if (selectedCommand?.spec?.placement === "right") {
            await runRightCommand(selectedCommand.name, selectedCommand.args);
            return;
          }
          const sessionId = await ensureActiveSession();
          if (sessionId) {
            await sendChatMessage(conn, sessionId, selected.name);
            await refreshState();
          }
          return;
        }
      }
      if (parsed?.spec?.placement === "inline") {
        await runInlineCommand(parsed.name, parsed.args);
        return;
      }
      if (parsed?.spec?.placement === "right") {
        await runRightCommand(parsed.name, parsed.args);
        return;
      }
      const desktopRoute = desktopRouteForCommand(parsed?.name);
      if (desktopRoute) {
        const result = await navigateDesktop(conn, {
          source: "ade-code",
          target: { kind: "route", route: desktopRoute },
        });
        if (result.ok) {
          addNotice(`Opened ADE desktop for ${parsed?.name}.`, "success");
          return;
        }
        await runInlineCommand("/open", "");
        addNotice(`${parsed?.name} is a desktop-only surface; opened ADE desktop.`, "info");
        return;
      }
      const sessionId = await ensureActiveSession();
      if (!sessionId) {
        addNotice("No active lane is available for chat.", "error");
        return;
      }
      lastLocalSendAtRef.current = Date.now();
      const attachments: AgentChatFileRef[] = selectedMentions
        .filter((mention) => mention.kind === "file" && mention.filePath && text.includes(mention.insertText))
        .map((mention) => ({ type: "file", path: mention.filePath! }));
      await sendChatMessage(conn, sessionId, text, attachments);
      await refreshState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addNotice(message, "error");
    }
  }, [activeFormField, addNotice, answerPendingInput, desktopDriving, ensureActiveSession, formValues, pendingApproval, refreshState, resolvePendingApproval, rightPane, runInlineCommand, runRightCommand, selectedMentions, slashCommands, slashIndex, slashRows, streaming, submitRightForm]);

  const insertMention = useCallback((suggestion: MentionSuggestion) => {
    const range = activeMention(prompt);
    if (!range) return;
    setPrompt(`${prompt.slice(0, range.start)}${suggestion.insertText} ${prompt.slice(range.start + range.query.length + 1)}`);
    setSelectedMentions((prev) => {
      if (prev.some((entry) => entry.insertText === suggestion.insertText)) return prev;
      return [...prev, suggestion].slice(-12);
    });
    setMentionSuggestions([]);
    setMentionIndex(0);
  }, [prompt]);

  const insertSlashCommand = useCallback(() => {
    const selected = slashRows[slashIndex] ?? slashRows[0];
    if (!selected) return;
    setPrompt(`${selected.name}${selected.argumentHint ? " " : ""}`);
  }, [slashIndex, slashRows]);

  useInput((input, key) => {
    if (pendingApproval?.mode === "approval" && !pendingApproval.highStakes && (input === "a" || input === "d")) {
      void resolvePendingApproval(pendingApproval, input === "a" ? "accept" : "decline")
        .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (rightPane.kind === "form" && key.tab) {
      const fields = rightPane.fields;
      const currentField = fields[formFieldIndex] ?? fields[0];
      const nextValues = currentField ? { ...formValues, [currentField.name]: prompt } : formValues;
      const nextIndex = fields.length ? (formFieldIndex + 1) % fields.length : 0;
      setFormValues(nextValues);
      setFormFieldIndex(nextIndex);
      setPrompt(fields[nextIndex] ? nextValues[fields[nextIndex]!.name] ?? "" : "");
      return;
    }
    if (rightOpen && (rightPane.kind === "models" || rightPane.kind === "effort" || (rightPane.kind === "list" && rightPane.action)) && key.upArrow) {
      const max = rightPane.kind === "models"
        ? rightPane.models.length
        : rightPane.kind === "effort"
          ? rightPane.efforts.length
          : rightPane.rows.length;
      setRightSelectionIndex((index) => (index <= 0 ? Math.max(0, max - 1) : index - 1));
      return;
    }
    if (rightOpen && (rightPane.kind === "models" || rightPane.kind === "effort" || (rightPane.kind === "list" && rightPane.action)) && key.downArrow) {
      const max = rightPane.kind === "models"
        ? rightPane.models.length
        : rightPane.kind === "effort"
          ? rightPane.efforts.length
          : rightPane.rows.length;
      setRightSelectionIndex((index) => (max > 0 ? (index + 1) % max : 0));
      return;
    }
    if (rightOpen && rightPane.kind === "list" && rightPane.action && key.return) {
      const selectedId = rightPane.action.ids[rightSelectionIndex] ?? rightPane.action.ids[0] ?? null;
      if (!selectedId) return;
      if (rightPane.action.kind === "switch-lane") {
        const lane = lanes.find((entry) => entry.id === selectedId);
        if (!lane) return;
        selectActiveLaneId(lane.id);
        setDrawerLaneId(lane.id);
        setSelectedDrawerLaneId(lane.id);
        const session = newestSession(sessions.filter((entry) => entry.laneId === lane.id));
        selectActiveSessionId(session?.sessionId ?? null);
        setSelectedDrawerChatId(session?.sessionId ?? null);
        addNotice(`Switched to lane ${lane.name}.`, "success");
        return;
      }
      const session = sessions.find((entry) => entry.sessionId === selectedId);
      if (!session) return;
      selectActiveLaneId(session.laneId);
      setDrawerLaneId(session.laneId);
      setSelectedDrawerLaneId(session.laneId);
      selectActiveSessionId(session.sessionId);
      setSelectedDrawerChatId(session.sessionId);
      addNotice(`Switched to chat ${session.title ?? session.sessionId}.`, "success");
      return;
    }
    if (rightOpen && (rightPane.kind === "models" || rightPane.kind === "effort") && key.return) {
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      if (!conn) {
        return;
      }
      if (rightPane.kind === "models") {
        const model = rightPane.models[rightSelectionIndex] ?? rightPane.models[0];
        if (!model) return;
        const modelId = model.modelId ?? model.id;
        if (!sessionId) {
          setModelState((prev) => ({
            ...prev,
            model: model.id,
            modelId,
            displayName: model.displayName,
          }));
          addNotice(`Default model set to ${model.displayName}.`, "success");
          return;
        }
        void updateChatModel({ connection: conn, sessionId, modelId })
          .then(() => {
            addNotice(`Model set to ${model.displayName}.`, "success");
            return refreshState();
          })
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      const effort = rightPane.efforts[rightSelectionIndex] ?? rightPane.efforts[0];
      if (!effort) return;
      if (!sessionId) {
        setModelState((prev) => ({ ...prev, reasoningEffort: effort }));
        addNotice(`Default effort set to ${effort}.`, "success");
        return;
      }
      void updateChatModel({ connection: conn, sessionId, reasoningEffort: effort })
        .then(() => {
          addNotice(`Effort set to ${effort}.`, "success");
          return refreshState();
        })
        .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (key.upArrow && activeMentionRange && mentionSuggestions.length) {
      setMentionIndex((index) => (index <= 0 ? mentionSuggestions.length - 1 : index - 1));
      return;
    }
    if (key.downArrow && activeMentionRange && mentionSuggestions.length) {
      setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
      return;
    }
    if (key.tab && activeMentionRange && mentionSuggestions.length) {
      insertMention(mentionSuggestions[mentionIndex] ?? mentionSuggestions[0]!);
      return;
    }
    if (key.upArrow && slashRows.length) {
      setSlashIndex((index) => (index <= 0 ? slashRows.length - 1 : index - 1));
      return;
    }
    if (key.downArrow && slashRows.length) {
      setSlashIndex((index) => (index + 1) % slashRows.length);
      return;
    }
    if (key.tab && slashRows.length) {
      insertSlashCommand();
      return;
    }
    if (drawerOpen && key.tab) {
      setDrawerSection((section) => section === "lanes" ? "chats" : "lanes");
      return;
    }
    if (drawerOpen && key.upArrow) {
      if (drawerSection === "lanes") {
        const nextIndex = Math.max(0, selectedLaneIndex - 1);
        setSelectedDrawerLaneId(drawerLaneRows[nextIndex]?.id ?? null);
      } else {
        const nextIndex = Math.max(0, selectedChatIndex - 1);
        setSelectedDrawerChatId(drawerLaneSessions[nextIndex]?.sessionId ?? null);
      }
      return;
    }
    if (drawerOpen && key.downArrow) {
      if (drawerSection === "lanes") {
        const nextIndex = Math.min(Math.max(0, drawerLaneRows.length - 1), selectedLaneIndex + 1);
        setSelectedDrawerLaneId(drawerLaneRows[nextIndex]?.id ?? null);
      } else {
        const nextIndex = Math.min(Math.max(0, drawerLaneSessions.length - 1), selectedChatIndex + 1);
        setSelectedDrawerChatId(drawerLaneSessions[nextIndex]?.sessionId ?? null);
      }
      return;
    }
    if (drawerOpen && key.return) {
      if (drawerSection === "lanes") {
        const lane = drawerLaneRows[selectedLaneIndex];
        if (lane) {
          selectActiveLaneId(lane.id);
          setDrawerLaneId(lane.id);
          setSelectedDrawerLaneId(lane.id);
          const session = newestSession(sessions.filter((entry) => entry.laneId === lane.id));
          selectActiveSessionId(session?.sessionId ?? null);
          setSelectedDrawerChatId(session?.sessionId ?? null);
          setDrawerSection(session ? "chats" : "lanes");
          addNotice(`Switched to lane ${lane.name}.`, "success");
        }
      } else {
        const session = drawerLaneSessions[selectedChatIndex];
        if (session) {
          selectActiveLaneId(session.laneId);
          setDrawerLaneId(session.laneId);
          setSelectedDrawerLaneId(session.laneId);
          selectActiveSessionId(session.sessionId);
          setSelectedDrawerChatId(session.sessionId);
        }
      }
      return;
    }
    if (key.ctrl && input === "b") {
      setDrawerOpen((value) => !value);
      return;
    }
    if (key.ctrl && input === "j") {
      setRightOpen((value) => !value);
      return;
    }
    if (key.escape) {
      if (desktopDriving) setDesktopDriving(false);
      else if (rightOpen) setRightOpen(false);
      else if (drawerOpen) setDrawerOpen(false);
      else setPrompt("");
      return;
    }
    if (key.ctrl && input === "c") {
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      if (streaming && conn && sessionId) {
        void interruptChat(conn, sessionId)
          .then(() => addNotice("Interrupted chat.", "info"))
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      exit();
      return;
    }
    if (key.return && !prompt.trim() && latestFailedLineId && !pendingApproval && rightPane.kind !== "form" && !slashRows.length) {
      setExpandedLineIds((prev) => {
        const next = new Set(prev);
        if (next.has(latestFailedLineId)) next.delete(latestFailedLineId);
        else next.add(latestFailedLineId);
        return next;
      });
      return;
    }
    const linePrefix = inputBeforeLineBreak(input);
    if (key.return || linePrefix != null) {
      const suffix = linePrefix == null ? "" : printableInput(linePrefix);
      void submitPrompt(`${prompt}${suffix}`);
      return;
    }
    if (key.backspace || key.delete) {
      handlePromptChange(prompt.slice(0, -1));
      return;
    }
    if (!key.ctrl && input) {
      const suffix = printableInput(input);
      if (suffix) handlePromptChange(`${prompt}${suffix}`);
    }
  });

  const handlePromptChange = useCallback((value: string) => {
    if (value === "?") {
      setRightPane({ kind: "help", title: "Help" });
      setRightOpen(true);
      setPrompt("");
      return;
    }
    if (rightPane.kind === "form" && activeFormField) {
      setFormValues((prev) => ({ ...prev, [activeFormField.name]: value }));
    }
    setPrompt(value);
  }, [activeFormField, rightPane]);

  const centerWidth = Math.max(40, columns - (drawerOpen ? 30 : 0) - (rightOpen ? 40 : 0));
  const laneName = activeLane?.name ?? "main";
  const chromeRows = 5
    + (desktopDriving ? 1 : 0)
    + (streaming ? 1 : 0)
    + (contextPercent != null ? 1 : 0)
    + (pendingApproval && !pendingApproval.highStakes ? 3 : 0)
    + (error ? 1 : 0);
  const chatMaxRows = Math.max(4, rows - chromeRows);

  if (error && !connection) {
    return (
      <Box flexDirection="column">
        <Text color="red">ade code failed to start</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows}>
      <Header
        projectName={projectName}
        lane={activeLane}
        model={modelState}
        mode={mode}
        tuiCount={tuiCount}
      />
      {desktopDriving ? (
        <Text color="yellow">Desktop is driving this chat; transcript is syncing here.</Text>
      ) : null}
      {streaming ? (
        <Text color={PURPLE}>● streaming live{tokenSummary ? ` · ${tokenSummary}` : ""} · ctrl-c interrupts</Text>
      ) : null}
      {contextPercent != null ? (
        <Text dimColor>
          context {contextPercent}% {"█".repeat(Math.max(1, Math.round(contextPercent / 10))).padEnd(10, "░")}
          {tokenSummary && !streaming ? ` · ${tokenSummary}` : ""}
        </Text>
      ) : null}
      <Box flexGrow={1} minHeight={8}>
        {drawerOpen ? (
          <Drawer
            lanes={lanes}
            sessions={sessions}
            activeLaneId={activeLaneId}
            activeSessionId={activeSessionId}
            browsingLaneId={drawerLaneId ?? activeLaneId}
            selectedLaneIndex={drawerSection === "lanes" ? selectedLaneIndex : -1}
            selectedChatIndex={drawerSection === "chats" ? selectedChatIndex : -1}
          />
        ) : null}
        <Box width={centerWidth} flexDirection="column">
          {pendingApproval?.highStakes ? (
            <ApprovalPrompt approval={pendingApproval} modal />
          ) : (
            <>
              <ChatView
                events={events}
                notices={notices}
                activeSession={activeSession}
                projectName={projectName}
                laneName={laneName}
                expandedLineIds={expandedLineIds}
                maxRows={chatMaxRows}
              />
              <ApprovalPrompt approval={pendingApproval} />
            </>
          )}
        </Box>
        {rightOpen ? (
          <RightPane
            content={rightPane}
            formValues={formValues}
            activeFormField={formFieldIndex}
            selectedIndex={rightSelectionIndex}
          />
        ) : null}
      </Box>
      <MentionPalette suggestions={mentionSuggestions} selectedIndex={mentionIndex} />
      <SlashPalette query={prompt} userCommands={slashCommands} selectedIndex={slashIndex} />
      {error ? <Text color="red">{error}</Text> : null}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color={PURPLE}>› </Text>
        <Text>{prompt}</Text>
        <Text inverse> </Text>
      </Box>
      <Text dimColor>
        [ {drawerOpen ? "▴" : "▾"} lanes & chats ^b ]   [ {rightOpen ? "◂" : "▸"} right pane ^j ]   / commands
      </Text>
    </Box>
  );
}
