import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { PaperPlaneTilt, CaretDown, Robot, TerminalWindow, ChatCircle, Hash, Crown, Wrench, UsersThree } from "@phosphor-icons/react";
import type {
  OrchestratorChatThread,
  OrchestratorChatMessage
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { relativeWhen } from "../../lib/format";
import { useThreadEventRefresh } from "../../hooks/useThreadEventRefresh";

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

export const AgentChannels = React.memo(function AgentChannels({ missionId, threads, onSendMessage }: AgentChannelsProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<OrchestratorChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(true);

  // Track visibility to pause polling when backgrounded
  useEffect(() => {
    const onVisChange = () => { visibleRef.current = document.visibilityState === "visible"; };
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, []);

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
  const refreshMessages = useCallback(async (threadId: string | null) => {
    if (!threadId) {
      setMessages([]);
      return;
    }
    try {
      const msgs = await window.ade.orchestrator.getThreadMessages({
        missionId,
        threadId,
        limit: 200
      });
      setMessages(msgs);
    } catch {
      // ignore
    }
  }, [missionId]);

  useEffect(() => {
    void refreshMessages(selectedThreadId);
    // Only poll for active threads — closed/completed threads won't receive new messages.
    if (selectedThread && selectedThread.status !== "active") return;
    const interval = setInterval(() => {
      if (!visibleRef.current) return;
      void refreshMessages(selectedThreadId);
    }, 6_000);
    return () => clearInterval(interval);
  }, [refreshMessages, selectedThreadId, selectedThread]);

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
            style={{ color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace", letterSpacing: "1px", textTransform: "uppercase" }}
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

          {/* Teammates */}
          {teammates.length > 0 && (
            <>
              <div
                className="px-2 pt-2 pb-0.5 text-[9px] font-medium uppercase tracking-wider"
                style={{ color: "#52525B", letterSpacing: "1px", fontFamily: "JetBrains Mono, monospace" }}
              >
                TEAMMATES
              </div>
              {teammates.map((t) => (
                <ChannelButton
                  key={t.id}
                  thread={t}
                  isSelected={selectedThreadId === t.id}
                  onClick={() => setSelectedThreadId(t.id)}
                />
              ))}
            </>
          )}

          {/* Active workers */}
          {activeWorkers.length > 0 && (
            <>
              <div
                className="px-2 pt-2 pb-0.5 text-[9px] font-medium uppercase tracking-wider"
                style={{ color: "#52525B", letterSpacing: "1px", fontFamily: "JetBrains Mono, monospace" }}
              >
                ACTIVE
              </div>
              {activeWorkers.map((t) => (
                <ChannelButton
                  key={t.id}
                  thread={t}
                  isSelected={selectedThreadId === t.id}
                  onClick={() => setSelectedThreadId(t.id)}
                />
              ))}
            </>
          )}

          {/* Completed workers */}
          {completedWorkers.length > 0 && (
            <>
              <div
                className="px-2 pt-2 pb-0.5 text-[9px] font-medium uppercase tracking-wider"
                style={{ color: "#52525B", letterSpacing: "1px", fontFamily: "JetBrains Mono, monospace" }}
              >
                COMPLETED
              </div>
              {completedWorkers.map((t) => (
                <ChannelButton
                  key={t.id}
                  thread={t}
                  isSelected={selectedThreadId === t.id}
                  onClick={() => setSelectedThreadId(t.id)}
                />
              ))}
            </>
          )}

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
            style={{ color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace" }}
          >
            {channelName}
          </span>
          {selectedThread && (
            <span
              className="ml-1 inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: STATUS_DOT[selectedThread.status] ?? "#52525B" }}
            />
          )}
          {/* Thread identity badge in header */}
          {selectedThread && (
            selectedThread.threadType === "coordinator" ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
                style={{ background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630", borderRadius: 0 }}
              >
                <Crown size={10} weight="fill" />
                Coordinator
              </span>
            ) : selectedThread.threadType === "teammate" ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
                style={{ background: "#06B6D418", color: "#06B6D4", border: "1px solid #06B6D430", borderRadius: 0 }}
              >
                <UsersThree size={10} weight="fill" />
                Teammate
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
                style={{ background: "#8B5CF618", color: "#8B5CF6", border: "1px solid #8B5CF630", borderRadius: 0 }}
              >
                <Wrench size={10} weight="fill" />
                Worker{selectedThread.stepKey ? `: ${selectedThread.stepKey}` : ""}
              </span>
            )
          )}
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-4 py-3 space-y-2 relative"
        >
          {!selectedThread && (
            <div className="flex items-center justify-center h-full text-xs" style={{ color: "#71717A" }}>
              Select a channel to view messages
            </div>
          )}
          {selectedThread && messages.length === 0 && (
            <div className="flex items-center justify-center h-32 text-xs" style={{ color: "#71717A" }}>
              No messages yet in this channel.
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} attemptNameMap={attemptNameMap} />
          ))}

          {/* Jump to latest */}
          {showJumpToLatest && (
            <button
              onClick={jumpToLatest}
              className="sticky bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 font-bold shadow-lg hover:opacity-90 transition-opacity flex items-center gap-1"
              style={{
                background: "#A78BFA",
                color: "#0F0D14",
                borderRadius: 0,
                fontFamily: "JetBrains Mono, monospace",
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
                fontFamily: "JetBrains Mono, monospace",
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

function ChannelButton({
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
  const isPlanner = thread.threadType === "coordinator";
  const isTeammate = thread.threadType === "teammate";
  const threadStepKey = thread.stepKey ?? null;

  return (
    <button
      onClick={onClick}
      className="w-full px-2 py-1.5 text-left transition-colors flex flex-col gap-0.5"
      style={
        isSelected
          ? { background: "#A78BFA12", borderLeft: "3px solid #A78BFA", color: "#FAFAFA", borderRadius: 0 }
          : { color: "#71717A", borderRadius: 0 }
      }
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
      {/* Thread role badge */}
      <div className="flex items-center gap-1 pl-5">
        {isPlanner ? (
          <span
            className="inline-flex items-center gap-0.5 px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
            style={{ background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630", borderRadius: 0 }}
          >
            <Crown size={8} weight="fill" />
            Coordinator
          </span>
        ) : isTeammate ? (
          <span
            className="inline-flex items-center gap-0.5 px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
            style={{ background: "#06B6D418", color: "#06B6D4", border: "1px solid #06B6D430", borderRadius: 0 }}
          >
            <UsersThree size={8} weight="fill" />
            Teammate
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-0.5 px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
            style={{ background: "#8B5CF618", color: "#8B5CF6", border: "1px solid #8B5CF630", borderRadius: 0 }}
          >
            <Wrench size={8} weight="fill" />
            Worker{threadStepKey ? `: ${threadStepKey}` : ""}
          </span>
        )}
      </div>
    </button>
  );
}

const MessageBubble = React.memo(function MessageBubble({ msg, attemptNameMap }: { msg: OrchestratorChatMessage; attemptNameMap: Map<string, string> }) {
  const isUser = msg.role === "user";
  const isAgent = msg.role === "agent";
  const isWorker = msg.role === "worker";

  // Determine if this is an inter-agent message
  const isInterAgent = isAgent && msg.target?.kind === "agent";

  // Tool calls: detect by content pattern (simple heuristic)
  const isToolCall = msg.content.startsWith("Tool call:") || msg.content.startsWith("tool_use:");
  const isFileEdit = msg.content.includes("--- a/") || msg.content.includes("+++ b/");
  const [expanded, setExpanded] = useState(false);

  const roleName = isUser
    ? "You"
    : isAgent
      ? "Agent"
      : isWorker
        ? "Worker"
        : "Orchestrator";

  const roleIcon = isUser ? null : isWorker ? TerminalWindow : Robot;

  const timestampStyle: React.CSSProperties = {
    color: "#52525B",
    fontFamily: "JetBrains Mono, monospace",
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

  if (isToolCall || isFileEdit) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%]">
          <div className="mb-1 flex items-center gap-1 text-[10px]" style={{ color: "#71717A" }}>
            {roleIcon && React.createElement(roleIcon, { size: 12, weight: "regular" })}
            <span>{roleName}</span>
            {msg.stepKey && <span>- {msg.stepKey}</span>}
            <span style={timestampStyle}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full px-3 py-2 text-left text-[11px] transition-colors"
            style={
              isFileEdit
                ? { border: "1px solid #22C55E30", background: "#22C55E08", borderRadius: 0 }
                : { border: "1px solid #F59E0B30", background: "#F59E0B08", borderRadius: 0 }
            }
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = isFileEdit ? "#22C55E14" : "#F59E0B14";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = isFileEdit ? "#22C55E08" : "#F59E0B08";
            }}
          >
            <div className="flex items-center gap-1 text-[11px] font-medium" style={{ color: "#A1A1AA" }}>
              <TerminalWindow size={12} weight="regular" />
              {isFileEdit ? "File Edit" : "Tool Call"}
              <CaretDown size={12} weight="regular" className={cn("ml-auto transition-transform", expanded && "rotate-180")} />
            </div>
            {expanded && (
              <pre
                className="mt-2 max-h-[200px] overflow-auto p-2 text-[10px] whitespace-pre-wrap break-all"
                style={{ background: "#0C0A10", color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace", borderRadius: 0 }}
              >
                {msg.content}
              </pre>
            )}
          </button>
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
          isWorker
            ? "max-w-[85%]"
            : isCoordinator
              ? "w-full"
              : "max-w-[85%]"
        )}
        style={
          isWorker
            ? { background: "#8B5CF618", borderLeft: "2px solid #8B5CF6", border: "1px solid #8B5CF630", borderLeftWidth: "2px", borderLeftColor: "#8B5CF6", color: "#FAFAFA", borderRadius: 0 }
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
