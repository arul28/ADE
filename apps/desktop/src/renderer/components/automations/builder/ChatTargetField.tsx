import { useEffect, useState } from "react";
import { ChatCircleText, ChatsCircle } from "@phosphor-icons/react";
import type { AgentChatSessionSummary, OpenProjectBinding } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { selectCls } from "../designTokens";
import { choiceCls, eyebrowCls, toneTextCls } from "../webhookSurface";

/**
 * "Where each run goes": a fresh chat per run (the default), or one chat that
 * receives every run as a new message. One chat keeps a running conversation,
 * e.g. a triage thread that hears about every webhook delivery and remembers
 * the earlier ones.
 */
export function ChatTargetField({
  chatSessionId,
  suggestedChatId = null,
  runtimePin = null,
  onChange,
}: {
  chatSessionId: string | null;
  /** The chat this rule was created from, offered first. */
  suggestedChatId?: string | null;
  runtimePin?: OpenProjectBinding | null;
  onChange: (chatSessionId: string | null) => void;
}) {
  const [chats, setChats] = useState<AgentChatSessionSummary[] | null>(null);
  // Local, so "Keep it in one chat" can be chosen before a chat is picked
  // without a placeholder id ever reaching the rule.
  const [mode, setMode] = useState<"new" | "one">(chatSessionId ? "one" : "new");
  const oneChat = mode === "one";

  useEffect(() => {
    if (!oneChat) return;
    let cancelled = false;
    void window.ade?.agentChat
      ?.list({}, runtimePin)
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => Date.parse(b.lastActivityAt ?? "") - Date.parse(a.lastActivityAt ?? ""));
        setChats(sorted.slice(0, 40));
      })
      .catch(() => {
        if (!cancelled) setChats([]);
      });
    return () => {
      cancelled = true;
    };
  }, [oneChat, runtimePin]);

  const options: Array<{ value: "new" | "one"; label: string; hint: string; icon: typeof ChatCircleText }> = [
    { value: "new", label: "A new chat each time", hint: "Each run starts fresh in its own chat.", icon: ChatCircleText },
    { value: "one", label: "Keep it in one chat", hint: "Every run arrives as a new message in the same chat, which remembers the earlier ones.", icon: ChatsCircle },
  ];
  const known = chats?.some((chat) => chat.sessionId === chatSessionId);

  return (
    <div className="space-y-2">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {options.map((option) => {
          const active = (option.value === "one") === oneChat;
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              data-testid={`automation-chat-target-${option.value}`}
              onClick={() => {
                setMode(option.value);
                if (option.value === "new") onChange(null);
                else if (!chatSessionId && suggestedChatId) onChange(suggestedChatId);
              }}
              className={cn(choiceCls(active), "flex items-start gap-2 px-3 py-2.5 text-left")}
            >
              <Icon size={14} weight={active ? "fill" : "regular"} className={cn("mt-0.5 shrink-0", active ? "text-fg" : "text-muted-fg")} />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-fg">{option.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-fg">{option.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {oneChat ? (
        <label className="block space-y-1">
          <span className={eyebrowCls}>Chat</span>
          <select
            className={selectCls}
            value={chatSessionId ?? ""}
            onChange={(event) => onChange(event.target.value || null)}
          >
            <option value="" disabled>
              {chats === null ? "Loading chats…" : "Pick a chat"}
            </option>
            {chatSessionId && chats && !known ? (
              <option value={chatSessionId}>This automation's chat ({chatSessionId.slice(0, 8)})</option>
            ) : null}
            {(chats ?? []).map((chat) => (
              <option key={chat.sessionId} value={chat.sessionId}>
                {(chat.title?.trim() || "Untitled chat") + (chat.sessionId === suggestedChatId ? " · where you made this" : "")}
              </option>
            ))}
          </select>
          {!chatSessionId ? (
            <span className={cn("block text-[11px]", toneTextCls.warn)}>Until you pick a chat, each run still starts a new one.</span>
          ) : null}
          <span className="block text-[11px] text-muted-fg">
            Runs wait their turn: if the chat is busy or waiting on you, the next one starts when it is free.
          </span>
        </label>
      ) : null}
    </div>
  );
}
