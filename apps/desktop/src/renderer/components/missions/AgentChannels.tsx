import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PaperPlaneTilt, CaretDown, Robot, TerminalWindow, ChatCircle, Hash, Crown, Wrench, UsersThree } from "@phosphor-icons/react";
import type {
  OrchestratorChatThread,
  OrchestratorChatMessage
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { useThreadEventRefresh } from "../../hooks/useThreadEventRefresh";
import { useMissionPolling } from "./useMissionPolling";
import { ChatWorkLogBlock } from "../chat/ChatWorkLogBlock";
import {
  readRecord,
  summarizeDiffStats,
  type ChatWorkLogEntry,
  type ChatWorkLogFileChange,
} from "../chat/chatTranscriptRows";

type AgentChannelsProps = {
  missionId: string;
  threads: OrchestratorChatThread[];
  onSendMessage: (threadId: string, content: string) => void;
};

const STATUS_DOT: Record<string, string> = {
  active: "#22C55E",
  closed: "#52525B",
  failed: "#EF4444"
};

const SECTION_HEADER_STYLE: React.CSSProperties = {
  color: "#52525B",
  letterSpacing: "1px",
  fontFamily: "var(--font-sans)",
};
const MESSAGE_PAGE_SIZE = 80;

function ChannelSection({
  label,
  threads,
  selectedThreadId,
  onSelectThread,
}: {
  label: string;
  threads: OrchestratorChatThread[];
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <>
      <div
        className="px-2 pt-2 pb-0.5 text-[9px] font-medium uppercase tracking-wider"
        style={SECTION_HEADER_STYLE}
      >
        {label}
      </div>
      {threads.map((t) => (
        <ChannelButton
          key={t.id}
          thread={t}
          isSelected={selectedThreadId === t.id}
          onClick={() => onSelectThread(t.id)}
        />
      ))}
    </>
  );
}

export const AgentChannels = React.memo(function AgentChannels({ missionId, threads, onSendMessage }: AgentChannelsProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<OrchestratorChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const latestMessagesRequestRef = useRef(0);
  const prependingMessagesRef = useRef(false);
  const messagesRef = useRef<OrchestratorChatMessage[]>([]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Auto-select first thread (coordinator) if nothing selected
  useEffect(() => {
    if (!selectedThreadId && threads.length > 0) {
      const coordThread = threads.find((t) => t.threadType === "coordinator");
      setSelectedThreadId(coordThread?.id ?? threads[0].id);
    }
  }, [threads, selectedThreadId]);

  // Partition threads into coordinator, teammates, and workers
  const { coordinatorThread, teammates, activeWorkers, completedWorkers } = useMemo(() => {
    const coordinator = threads.find((t) => t.threadType === "coordinator") ?? null;
    const teammateThreads = threads.filter((t) => t.threadType === "teammate");
    const workers = threads.filter((t) => t.threadType === "worker");
    return {
      coordinatorThread: coordinator,
      teammates: teammateThreads,
      activeWorkers: workers.filter((t) => t.status === "active"),
      completedWorkers: workers.filter((t) => t.status !== "active")
    };
  }, [threads]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );

  // Map attemptId -> friendly name from threads
  const attemptNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of threads) {
      if (t.attemptId) {
        map.set(t.attemptId, t.title || (t.threadType === "coordinator" ? "Coordinator" : "Worker"));
      }
    }
    return map;
  }, [threads]);

  // Fetch messages for selected thread
  const refreshMessages = useCallback(async (
    threadId: string | null,
    mode: "replace" | "append-older" = "replace",
  ) => {
    if (!threadId) {
      setMessages([]);
      setMessagesError(null);
      setHasOlderMessages(false);
      setMessagesLoading(false);
      setMessagesLoadingMore(false);
      return;
    }
    const requestId = latestMessagesRequestRef.current + 1;
    latestMessagesRequestRef.current = requestId;
    const before = mode === "append-older" ? messagesRef.current[0]?.timestamp ?? null : null;
    if (mode === "replace") {
      setMessagesLoading(true);
      setMessagesError(null);
    } else {
      prependingMessagesRef.current = true;
      setMessagesLoadingMore(true);
    }
    try {
      const msgs = await window.ade.orchestrator.getThreadMessages({
        missionId,
        threadId,
        limit: MESSAGE_PAGE_SIZE,
        before,
      });
      if (latestMessagesRequestRef.current !== requestId) return;
      setMessages((current) => {
        if (mode === "append-older") {
          const seen = new Set(current.map((entry) => entry.id));
          return [...msgs.filter((entry) => !seen.has(entry.id)), ...current];
        }
        return msgs;
      });
      setHasOlderMessages(msgs.length >= MESSAGE_PAGE_SIZE);
    } catch (error) {
      if (latestMessagesRequestRef.current !== requestId) return;
      setMessagesError(error instanceof Error ? error.message : String(error));
    } finally {
      if (latestMessagesRequestRef.current === requestId) {
        setMessagesLoading(false);
        setMessagesLoadingMore(false);
      }
    }
  }, [missionId]);

  // Initial load when thread changes
  useEffect(() => {
    void refreshMessages(selectedThreadId);
  }, [refreshMessages, selectedThreadId]);

  // Polling via shared coordinator (replaces per-component setInterval).
  // Only poll for active threads — closed/completed threads won't receive new messages.
  const isActiveThread = !selectedThread || selectedThread.status === "active";
  const pollMessages = useCallback(() => {
    void refreshMessages(selectedThreadIdRef.current);
  }, [refreshMessages]);

  useMissionPolling(pollMessages, 6_000, isActiveThread && !!selectedThreadId);

  // Listen for thread events
  const handleThreadRefresh = useCallback(() => {
    void refreshMessages(selectedThreadId);
  }, [refreshMessages, selectedThreadId]);

  useThreadEventRefresh({
    missionId,
    threadId: selectedThreadId,
    onRefresh: handleThreadRefresh,
    debounceMs: 120,
  });

  // Auto-scroll
  useEffect(() => {
    if (prependingMessagesRef.current) {
      prependingMessagesRef.current = false;
      return;
    }
    if (scrollRef.current && !showJumpToLatest) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length, selectedThreadId, showJumpToLatest]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowJumpToLatest(scrollHeight - scrollTop - clientHeight > 100);
  }, []);

  const jumpToLatest = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
    setShowJumpToLatest(false);
  }, []);

  const handleSend = useCallback(async () => {
    if (!selectedThreadId || !input.trim() || sending) return;
    const trimmed = input.trim();
    setSending(true);
    setInput("");
    try {
      // onSendMessage may or may not return a promise — await it either way
      await Promise.resolve(onSendMessage(selectedThreadId, trimmed));
      await refreshMessages(selectedThreadId);
    } finally {
      setSending(false);
    }
  }, [selectedThreadId, input, sending, onSendMessage, refreshMessages]);

  const loadOlderMessages = useCallback(() => {
    if (!selectedThreadId || !hasOlderMessages || messagesLoadingMore) return;
    void refreshMessages(selectedThreadId, "append-older");
  }, [hasOlderMessages, messagesLoadingMore, refreshMessages, selectedThreadId]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    initialRect: { width: 0, height: 480 },
    estimateSize: () => 92,
    overscan: 8,
  });
  const shouldVirtualize = messages.length > 40;

  const channelName = selectedThread
    ? selectedThread.threadType === "coordinator"
      ? "coordinator"
      : selectedThread.title
    : "...";

  return (
    <div className="flex h-full min-h-0">
      {/* Channel Sidebar */}
      <aside
        className="w-[200px] shrink-0 flex flex-col"
        style={{ background: "#13101A", borderRight: "1px solid #1E1B26" }}
      >
        <div className="px-3 py-2" style={{ borderBottom: "1px solid #1E1B26" }}>
          <div
            className="text-xs font-semibold"
            style={{ color: "#FAFAFA", fontFamily: "var(--font-sans)", letterSpacing: "1px", textTransform: "uppercase" }}
          >
            CHANNELS
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {/* Coordinator channel */}
          {coordinatorThread && (
            <ChannelButton
              thread={coordinatorThread}
              label="coordinator"
              isSelected={selectedThreadId === coordinatorThread.id}
              onClick={() => setSelectedThreadId(coordinatorThread.id)}
            />
          )}

          <ChannelSection label="TEAMMATES" threads={teammates} selectedThreadId={selectedThreadId} onSelectThread={setSelectedThreadId} />
          <ChannelSection label="ACTIVE" threads={activeWorkers} selectedThreadId={selectedThreadId} onSelectThread={setSelectedThreadId} />
          <ChannelSection label="COMPLETED" threads={completedWorkers} selectedThreadId={selectedThreadId} onSelectThread={setSelectedThreadId} />

          {threads.length === 0 && (
            <div className="px-2 py-4 text-center text-[10px]" style={{ color: "#71717A" }}>
              No channels yet
            </div>
          )}
        </div>
      </aside>

      {/* Conversation Area */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: "#0F0D14" }}>
        {/* Header */}
        <div className="px-4 py-2 flex items-center gap-2" style={{ borderBottom: "1px solid #1E1B26" }}>
          <Hash size={14} weight="regular" style={{ color: "#71717A" }} />
          <span
            className="text-xs font-semibold"
            style={{ color: "#FAFAFA", fontFamily: "var(--font-sans)" }}
          >
            {channelName}
          </span>
          {selectedThread && (
            <span
              className="ml-1 inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: STATUS_DOT[selectedThread.status] ?? "#52525B" }}
            />
          )}
          {selectedThread && (
            <ThreadTypeBadge threadType={selectedThread.threadType} stepKey={selectedThread.stepKey} />
          )}
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-4 py-3 space-y-2 relative"
        >
          {selectedThread && hasOlderMessages ? (
            <div className="sticky top-0 z-10 flex justify-center pb-2">
              <button
                type="button"
                onClick={loadOlderMessages}
                disabled={messagesLoadingMore}
                aria-label={messagesLoadingMore ? "Loading older thread messages" : "Load older thread messages"}
                className="px-3 py-1 text-[10px] font-bold uppercase tracking-[1px] transition-opacity disabled:opacity-50"
                style={{
                  background: "#13101A",
                  border: "1px solid #27272A",
                  color: "#A78BFA",
                  fontFamily: "var(--font-sans)",
                }}
              >
                {messagesLoadingMore ? "Loading older messages..." : "Load older messages"}
              </button>
            </div>
          ) : null}
          {messagesLoading ? (
            <div className="flex items-center justify-center h-32 text-xs" style={{ color: "#71717A" }}>
              Loading channel messages...
            </div>
          ) : null}
          {!messagesLoading && messagesError ? (
            <div className="flex h-32 flex-col items-center justify-center gap-3 text-xs" style={{ color: "#A1A1AA" }}>
              <span>{messagesError}</span>
              <Button variant="outline" size="sm" onClick={() => void refreshMessages(selectedThreadId)}>
                Retry
              </Button>
            </div>
          ) : null}
          {!selectedThread && (
            <div className="flex items-center justify-center h-full text-xs" style={{ color: "#71717A" }}>
              Select a channel to view messages
            </div>
          )}
          {selectedThread && !messagesLoading && !messagesError && messages.length === 0 && (
            <div className="flex items-center justify-center h-32 text-xs" style={{ color: "#71717A" }}>
              No messages yet in this channel.
            </div>
          )}
          {!messagesLoading && !messagesError && messages.length > 0 ? (
            shouldVirtualize ? (
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const msg = messages[virtualRow.index]!;
                  return (
                    <div
                      key={msg.id}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <MessageBubble msg={msg} attemptNameMap={attemptNameMap} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                {messages.map((msg) => (
                  <MessageBubble key={msg.id} msg={msg} attemptNameMap={attemptNameMap} />
                ))}
              </>
            )
          ) : null}

          {/* Jump to latest */}
          {showJumpToLatest && (
            <button
              onClick={jumpToLatest}
              aria-label="Jump to the latest channel message"
              className="sticky bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 font-bold shadow-lg hover:opacity-90 transition-opacity flex items-center gap-1"
              style={{
                background: "#A78BFA",
                color: "#0F0D14",
                borderRadius: 0,
                fontFamily: "var(--font-sans)",
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "1px"
              }}
            >
              <CaretDown size={12} weight="regular" />
              JUMP TO LATEST
            </button>
          )}
        </div>

        {/* Input bar */}
        <div className="px-4 py-2.5" style={{ borderTop: "1px solid #1E1B26" }}>
          <div className="flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              disabled={!selectedThread}
              placeholder={`Message ${channelName}...`}
              className="h-8 flex-1 px-3 text-xs outline-none disabled:opacity-50"
              style={{
                background: "#0C0A10",
                border: inputFocused ? "1px solid #A78BFA" : "1px solid #27272A",
                fontFamily: "var(--font-sans)",
                color: "#FAFAFA",
                borderRadius: 0
              }}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSend()}
              disabled={!selectedThread || !input.trim() || sending}
            >
              <PaperPlaneTilt size={12} weight="regular" />
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});

function ThreadTypeBadge({
  threadType,
  stepKey,
  iconSize = 10,
  className = "inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]",
}: {
  threadType: OrchestratorChatThread["threadType"];
  stepKey?: string | null;
  iconSize?: number;
  className?: string;
}) {
  switch (threadType) {
    case "coordinator":
      return (
        <span className={className} style={COORDINATOR_BADGE_STYLE}>
          <Crown size={iconSize} weight="fill" />
          Coordinator
        </span>
      );
    case "teammate":
      return (
        <span className={className} style={TEAMMATE_BADGE_STYLE}>
          <UsersThree size={iconSize} weight="fill" />
          Teammate
        </span>
      );
    default:
      return (
        <span className={className} style={WORKER_BADGE_STYLE}>
          <Wrench size={iconSize} weight="fill" />
          Worker{stepKey ? `: ${stepKey}` : ""}
        </span>
      );
  }
}

const CHANNEL_SELECTED_STYLE: React.CSSProperties = {
  background: "#A78BFA12",
  borderLeft: "3px solid #A78BFA",
  color: "#FAFAFA",
  borderRadius: 0,
};

const CHANNEL_UNSELECTED_STYLE: React.CSSProperties = {
  color: "#71717A",
  borderRadius: 0,
};

const COORDINATOR_BADGE_STYLE: React.CSSProperties = {
  background: "#3B82F618",
  color: "#3B82F6",
  border: "1px solid #3B82F630",
  borderRadius: 0,
};

const TEAMMATE_BADGE_STYLE: React.CSSProperties = {
  background: "#06B6D418",
  color: "#06B6D4",
  border: "1px solid #06B6D430",
  borderRadius: 0,
};

const WORKER_BADGE_STYLE: React.CSSProperties = {
  background: "#8B5CF618",
  color: "#8B5CF6",
  border: "1px solid #8B5CF630",
  borderRadius: 0,
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseToolNameFromLegacyContent(content: string): string | null {
  const trimmed = content.trim();
  const toolCallMatch = trimmed.match(/^Tool (?:call|result):\s*([^\n]+)/i);
  if (toolCallMatch?.[1]) return toolCallMatch[1].trim();
  const toolUseMatch = trimmed.match(/^tool_use:\s*([^\s]+)[\s\S]*$/i);
  if (toolUseMatch?.[1]) return toolUseMatch[1].trim();
  return null;
}

function parseDiffChunkPath(chunk: string): { path: string; kind: ChatWorkLogFileChange["kind"] } | null {
  const newPath = chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1]?.trim();
  const oldPath = chunk.match(/^--- a\/(.+)$/m)?.[1]?.trim();
  if (chunk.includes("new file mode")) {
    return { path: newPath ?? oldPath ?? "(pending file)", kind: "create" };
  }
  if (chunk.includes("deleted file mode")) {
    return { path: oldPath ?? newPath ?? "(pending file)", kind: "delete" };
  }
  if (newPath || oldPath) {
    return { path: newPath ?? oldPath ?? "(pending file)", kind: "modify" };
  }
  return null;
}

function parseLegacyFileChanges(content: string): ChatWorkLogFileChange[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const chunks = normalized.includes("diff --git ")
    ? normalized.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim().length > 0)
    : [normalized];
  const changes: ChatWorkLogFileChange[] = [];

  for (const chunk of chunks) {
    const parsed = parseDiffChunkPath(chunk);
    if (!parsed) continue;
    const stats = summarizeDiffStats(chunk);
    changes.push({
      path: parsed.path,
      kind: parsed.kind,
      additions: stats.additions,
      deletions: stats.deletions,
      diff: chunk,
    });
  }

  return changes;
}

function deriveLegacyWorkLogEntry(msg: OrchestratorChatMessage): ChatWorkLogEntry | null {
  const content = msg.content.trim();
  if (!content.length) return null;
  const metadata = readRecord(msg.metadata);
  const toolName = readString(metadata?.toolName) ?? parseToolNameFromLegacyContent(content);
  const toolArgs = metadata?.toolArgs;
  const toolResult = metadata?.toolResult;
  const toolFailed = readString(readRecord(toolResult)?.error) != null || /\bfailed\b/i.test(content);

  if (toolName) {
    const isResult = /^Tool result:/i.test(content);
    return {
      id: msg.id,
      createdAt: msg.timestamp,
      label: toolName,
      detail: content,
      tone: toolFailed ? "error" : "tool",
      status: toolFailed ? "failed" : (isResult ? "completed" : "running"),
      entryKind: "tool",
      toolName,
      ...(toolArgs !== undefined ? { args: toolArgs } : {}),
      ...(toolResult !== undefined ? { result: toolResult } : {}),
    };
  }

  const changedFiles = parseLegacyFileChanges(content);
  if (changedFiles.length > 0) {
    return {
      id: msg.id,
      createdAt: msg.timestamp,
      label: changedFiles[0]!.path,
      detail: content,
      tone: "info",
      status: "completed",
      entryKind: "file_change",
      changedFiles,
    };
  }

  return null;
}

const ChannelButton = React.memo(function ChannelButton({
  thread,
  label,
  isSelected,
  onClick
}: {
  thread: OrchestratorChatThread;
  label?: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const displayName = label ?? thread.title;
  const statusColor = STATUS_DOT[thread.status] ?? "#52525B";
  const threadStepKey = thread.stepKey ?? null;

  return (
    <button
      onClick={onClick}
      className="w-full px-2 py-1.5 text-left transition-colors flex flex-col gap-0.5"
      style={isSelected ? CHANNEL_SELECTED_STYLE : CHANNEL_UNSELECTED_STYLE}
      onMouseEnter={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLButtonElement).style.background = "#1A1720";
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        }
      }}
    >
      <div className="flex items-center gap-1.5 w-full">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
          style={{ backgroundColor: statusColor }}
        />
        <Hash size={12} weight="regular" className="shrink-0" style={{ color: "#71717A" }} />
        <span className="truncate text-xs">{displayName}</span>
        {thread.unreadCount > 0 && (
          <span
            className="ml-auto shrink-0 px-1 py-0.5 text-[9px] font-semibold"
            style={{ background: "#A78BFA", color: "#0F0D14", borderRadius: 0 }}
          >
            {thread.unreadCount}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 pl-5">
        <ThreadTypeBadge
          threadType={thread.threadType}
          stepKey={threadStepKey}
          iconSize={8}
          className="inline-flex items-center gap-0.5 px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
        />
      </div>
    </button>
  );
});

const MessageBubble = React.memo(function MessageBubble({ msg, attemptNameMap }: { msg: OrchestratorChatMessage; attemptNameMap: Map<string, string> }) {
  const isUser = msg.role === "user";
  const isAgent = msg.role === "agent";
  const isWorker = msg.role === "worker";

  // Determine if this is an inter-agent message
  const isInterAgent = isAgent && msg.target?.kind === "agent";

  const legacyWorkLogEntry = useMemo(() => deriveLegacyWorkLogEntry(msg), [msg]);

  let roleName: string;
  if (isUser) roleName = "You";
  else if (isAgent) roleName = "Agent";
  else if (isWorker) roleName = "Worker";
  else roleName = "Orchestrator";

  const roleIcon = isUser ? null : isWorker ? TerminalWindow : Robot;

  const timestampStyle: React.CSSProperties = {
    color: "#52525B",
    fontFamily: "var(--font-sans)",
    fontSize: "9px"
  };

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[75%] px-3 py-2 text-xs"
          style={{ background: "#A78BFA18", border: "1px solid #A78BFA30", color: "#FAFAFA", borderRadius: 0 }}
        >
          <div className="whitespace-pre-wrap">{msg.content}</div>
          <div className="mt-1 text-right" style={timestampStyle}>
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }

  if (isInterAgent) {
    return (
      <div className="flex justify-start ml-4">
        <div
          className="max-w-[75%] px-3 py-2 text-xs"
          style={{ borderLeft: "2px solid #A78BFA30", background: "#13101A", borderRadius: 0 }}
        >
          <div className="mb-1 flex items-center gap-1 text-[10px]" style={{ color: "#A78BFA" }}>
            <ChatCircle size={12} weight="regular" />
            <span>
              {(() => {
                const srcId = msg.target && "sourceAttemptId" in msg.target ? msg.target.sourceAttemptId : null;
                const dstId = msg.target && "targetAttemptId" in msg.target ? msg.target.targetAttemptId : null;
                const srcName = (srcId && attemptNameMap.get(srcId)) || msg.stepKey || "Worker";
                const dstName = (dstId && attemptNameMap.get(dstId)) || "Worker";
                return `${srcName} \u2192 ${dstName}`;
              })()}
            </span>
          </div>
          <div className="whitespace-pre-wrap" style={{ color: "#A1A1AA" }}>{msg.content}</div>
          <div className="mt-1" style={timestampStyle}>
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }

  if (legacyWorkLogEntry) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%]">
          <div className="mb-1 flex items-center gap-1 text-[10px]" style={{ color: "#71717A" }}>
            {roleIcon && React.createElement(roleIcon, { size: 12, weight: "regular" })}
            <span>{roleName}</span>
            {msg.stepKey && <span>- {msg.stepKey}</span>}
            <span style={timestampStyle}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
          </div>
          <ChatWorkLogBlock
            entries={[legacyWorkLogEntry]}
            className="border-white/[0.08] bg-[#13101A]"
          />
        </div>
      </div>
    );
  }

  // System events (orchestrator non-conversational)
  if (msg.role === "orchestrator" && msg.content.length < 80 && !msg.content.includes("\n")) {
    return (
      <div className="flex justify-center py-1">
        <span
          className="px-3 py-0.5 text-[10px]"
          style={{ background: "#13101A", color: "#71717A", borderRadius: 0 }}
        >
          {msg.content}
        </span>
      </div>
    );
  }

  // Standard agent/worker/orchestrator message
  // Coordinator/orchestrator messages: full-width
  // Worker messages: indented with color-coded left border
  const isCoordinator = msg.role === "orchestrator" || msg.role === "agent";
  return (
    <div className={cn("flex justify-start", isWorker && "ml-4")}>
      <div
        className={cn(
          "px-3 py-2 text-xs",
          isCoordinator ? "w-full" : "max-w-[85%]",
        )}
        style={
          isWorker
            ? {
                background: "#8B5CF618",
                borderTop: "1px solid #8B5CF630",
                borderRight: "1px solid #8B5CF630",
                borderBottom: "1px solid #8B5CF630",
                borderLeft: "2px solid #8B5CF6",
                color: "#FAFAFA",
                borderRadius: 0
              }
            : { background: "#13101A", border: "1px solid #1E1B26", color: "#FAFAFA", borderRadius: 0 }
        }
      >
        <div className="mb-1 flex items-center gap-1 text-[10px]" style={{ color: "#71717A" }}>
          {roleIcon && React.createElement(roleIcon, { size: 12, weight: "regular" })}
          <span>{roleName}</span>
          {msg.stepKey && <span>- {msg.stepKey}</span>}
          <span className="ml-auto" style={timestampStyle}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
        </div>
        <div className="whitespace-pre-wrap">{msg.content}</div>
      </div>
    </div>
  );
});
