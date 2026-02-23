import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { PaperPlaneTilt, CaretDown, Robot, TerminalWindow, ChatCircle, Hash } from "@phosphor-icons/react";
import type {
  OrchestratorChatThread,
  OrchestratorChatMessage
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";

type AgentChannelsProps = {
  missionId: string;
  threads: OrchestratorChatThread[];
  onSendMessage: (threadId: string, content: string) => void;
};

function relativeWhen(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const delta = Math.max(0, Date.now() - ts);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const STATUS_DOT: Record<string, string> = {
  active: "bg-green-400",
  closed: "bg-gray-500",
  failed: "bg-red-400"
};

export function AgentChannels({ missionId, threads, onSendMessage }: AgentChannelsProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<OrchestratorChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageRefreshTimerRef = useRef<number | null>(null);

  // Auto-select first thread (coordinator) if nothing selected
  useEffect(() => {
    if (!selectedThreadId && threads.length > 0) {
      const missionThread = threads.find((t) => t.threadType === "mission");
      setSelectedThreadId(missionThread?.id ?? threads[0].id);
    }
  }, [threads, selectedThreadId]);

  // Partition threads into coordinator and workers
  const { coordinatorThread, activeWorkers, completedWorkers } = useMemo(() => {
    const coordinator = threads.find((t) => t.threadType === "mission") ?? null;
    const workers = threads.filter((t) => t.threadType === "worker");
    return {
      coordinatorThread: coordinator,
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
        map.set(t.attemptId, t.title || (t.threadType === "mission" ? "Coordinator" : "Worker"));
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
    const interval = setInterval(() => void refreshMessages(selectedThreadId), 6_000);
    return () => clearInterval(interval);
  }, [refreshMessages, selectedThreadId, selectedThread]);

  // Listen for thread events
  useEffect(() => {
    const unsub = window.ade.orchestrator.onThreadEvent((event) => {
      if (event.missionId !== missionId) return;
      if (
        event.type === "message_appended" ||
        event.type === "message_updated" ||
        event.type === "worker_replay"
      ) {
        if (!event.threadId || event.threadId === selectedThreadId) {
          if (messageRefreshTimerRef.current !== null) {
            window.clearTimeout(messageRefreshTimerRef.current);
          }
          messageRefreshTimerRef.current = window.setTimeout(() => {
            messageRefreshTimerRef.current = null;
            void refreshMessages(selectedThreadId);
          }, 120);
        }
      }
    });
    return () => {
      unsub();
      if (messageRefreshTimerRef.current !== null) {
        window.clearTimeout(messageRefreshTimerRef.current);
      }
    };
  }, [missionId, selectedThreadId, refreshMessages]);

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
    ? selectedThread.threadType === "mission"
      ? "coordinator"
      : selectedThread.title
    : "...";

  return (
    <div className="flex h-full min-h-0">
      {/* Channel Sidebar */}
      <aside className="w-[200px] shrink-0 border-r border-border/10 bg-[#16213e]/60 flex flex-col">
        <div className="border-b border-border/10 px-3 py-2">
          <div className="text-xs font-semibold text-fg">Channels</div>
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

          {/* Active workers */}
          {activeWorkers.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-fg/60">
                Active
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
              <div className="px-2 pt-2 pb-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-fg/60">
                Completed
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
            <div className="px-2 py-4 text-center text-[10px] text-muted-fg">
              No channels yet
            </div>
          )}
        </div>
      </aside>

      {/* Conversation Area */}
      <div className="flex min-w-0 flex-1 flex-col bg-[#1a1a2e]/40">
        {/* Header */}
        <div className="border-b border-border/10 px-4 py-2 flex items-center gap-2">
          <Hash size={14} weight="regular" className="text-muted-fg" />
          <span className="text-xs font-semibold text-fg">{channelName}</span>
          {selectedThread && (
            <span className={cn(
              "ml-1 inline-block h-2 w-2 rounded-full",
              STATUS_DOT[selectedThread.status] ?? "bg-gray-500"
            )} />
          )}
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-4 py-3 space-y-2 relative"
        >
          {!selectedThread && (
            <div className="flex items-center justify-center h-full text-xs text-muted-fg">
              Select a channel to view messages
            </div>
          )}
          {selectedThread && messages.length === 0 && (
            <div className="flex items-center justify-center h-32 text-xs text-muted-fg">
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
              className="sticky bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-accent/90 px-3 py-1 text-[10px] font-medium text-accent-fg shadow-lg hover:bg-accent transition-colors flex items-center gap-1"
            >
              <CaretDown size={12} weight="regular" />
              Jump to latest
            </button>
          )}
        </div>

        {/* Input bar */}
        <div className="border-t border-border/10 px-4 py-2.5">
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
              disabled={!selectedThread}
              placeholder={`Message ${channelName}...`}
              className="h-8 flex-1 rounded-lg border border-border/30 font-mono bg-surface-recessed px-3 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 disabled:opacity-50"
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
}

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
  const statusColor = STATUS_DOT[thread.status] ?? "bg-gray-500";

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full rounded px-2 py-1.5 text-left transition-colors flex items-center gap-1.5",
        isSelected
          ? "bg-accent/15 text-fg"
          : "text-muted-fg hover:bg-card/60 hover:text-fg"
      )}
    >
      <span className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", statusColor)} />
      <Hash size={12} weight="regular" className="shrink-0 text-muted-fg/60" />
      <span className="truncate text-xs">{displayName}</span>
      {thread.unreadCount > 0 && (
        <span className="ml-auto shrink-0 rounded bg-accent px-1 py-0.5 text-[9px] font-semibold text-accent-fg">
          {thread.unreadCount}
        </span>
      )}
    </button>
  );
}

function MessageBubble({ msg, attemptNameMap }: { msg: OrchestratorChatMessage; attemptNameMap: Map<string, string> }) {
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

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-lg border border-accent/40 bg-accent/15 px-3 py-2 text-xs text-fg">
          <div className="whitespace-pre-wrap">{msg.content}</div>
          <div className="mt-1 text-right text-[9px] text-muted-fg">
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }

  if (isInterAgent) {
    return (
      <div className="flex justify-start ml-4">
        <div className="max-w-[75%] rounded-lg border-l-2 border-violet-500/30 bg-card/60 px-3 py-2 text-xs">
          <div className="mb-1 flex items-center gap-1 text-[10px] text-violet-300/80">
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
          <div className="whitespace-pre-wrap text-muted-fg">{msg.content}</div>
          <div className="mt-1 text-[9px] text-muted-fg">
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
          <div className="mb-1 flex items-center gap-1 text-[10px] text-muted-fg">
            {roleIcon && React.createElement(roleIcon, { size: 12, weight: "regular" })}
            <span>{roleName}</span>
            {msg.stepKey && <span>- {msg.stepKey}</span>}
            <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className={cn(
              "w-full rounded-lg border px-3 py-2 text-left text-[11px] transition-colors",
              isFileEdit
                ? "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10"
                : "border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10"
            )}
          >
            <div className="flex items-center gap-1 text-[11px] font-medium text-muted-fg">
              <TerminalWindow size={12} weight="regular" />
              {isFileEdit ? "File Edit" : "Tool Call"}
              <CaretDown size={12} weight="regular" className={cn("ml-auto transition-transform", expanded && "rotate-180")} />
            </div>
            {expanded && (
              <pre className="mt-2 max-h-[200px] overflow-auto rounded bg-surface-recessed p-2 text-[10px] font-mono text-muted-fg whitespace-pre-wrap break-all">
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
        <span className="rounded-full bg-card/60 px-3 py-0.5 text-[10px] text-muted-fg">
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
      <div className={cn(
        "rounded-lg border px-3 py-2 text-xs",
        isWorker
          ? "border-l-2 border-l-violet-500 border-violet-500/35 bg-violet-500/10 text-violet-100 max-w-[85%]"
          : isCoordinator
            ? "w-full border-border/30 bg-card/80 text-fg"
            : "max-w-[85%] border-border/30 bg-card/80 text-fg"
      )}>
        <div className="mb-1 flex items-center gap-1 text-[10px] text-muted-fg">
          {roleIcon && React.createElement(roleIcon, { size: 12, weight: "regular" })}
          <span>{roleName}</span>
          {msg.stepKey && <span>- {msg.stepKey}</span>}
          <span className="ml-auto">{new Date(msg.timestamp).toLocaleTimeString()}</span>
        </div>
        <div className="whitespace-pre-wrap">{msg.content}</div>
      </div>
    </div>
  );
}
