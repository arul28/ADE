import { ChatsCircle } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { WorkToolEmptyLine } from "../terminals/workToolChrome";
import { SIDE_CHAT_TOOL_COLOR, SIDE_CHAT_TOOL_UNAVAILABLE_REASON } from "../terminals/workTools";
import { Banner } from "../ui/notice";
import { AgentChatPane } from "./AgentChatPane";
import { SideChatTranscriptContext, useSideChatView } from "./sideChatState";

/**
 * The Side chat tool: the read-only side chat of the chat the pane serves.
 *
 * The side chat is an ordinary chat session on the main chat's machine, so the
 * pane is the same `AgentChatPane` locked to it, with the model and permission
 * controls locked (a side chat stays read-only, on its main chat's model). Its
 * transcript starts blank: the forked history lives only on the provider.
 */
export function SideChatToolPanel({
  mainSessionId,
  rowSideChatSessionId,
  laneId,
  runtimePin,
}: {
  mainSessionId: string | null;
  /** The main chat's row value; this window's newer answer wins (`sideChatState`). */
  rowSideChatSessionId: string | null;
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
}) {
  const view = useSideChatView(mainSessionId, rowSideChatSessionId);
  if (view.kind === "none") return <WorkToolEmptyLine title={SIDE_CHAT_TOOL_UNAVAILABLE_REASON} />;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-work-tool="side-chat">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2 font-sans text-[11px] text-fg/55">
        <ChatsCircle size={13} weight="bold" className="shrink-0" style={{ color: SIDE_CHAT_TOOL_COLOR }} />
        <span className="shrink-0 whitespace-nowrap font-medium text-fg/80">Side chat</span>
        <span className="shrink-0 whitespace-nowrap rounded-full border border-border/60 px-1.5 py-px text-[10px] text-fg/55">read-only</span>
        <span className="min-w-0 truncate" title="Knows this conversation. Ask it to send something to the main chat.">
          Knows this conversation. Ask it to send something to the main chat.
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {view.kind === "open" ? (
          <SideChatTranscriptContext.Provider value>
            <AgentChatPane
              key={view.sideSessionId}
              laneId={laneId}
              runtimePin={runtimePin ?? undefined}
              lockSessionId={view.sideSessionId}
              hideSessionTabs
              hideSurfaceHeader
              hideLaneToolDrawers
              modelSelectionLocked
              permissionModeLocked
              presentation={{
                mode: "standard",
                title: "Side chat",
                messagePlaceholder: "Ask a quick question…",
              }}
            />
          </SideChatTranscriptContext.Provider>
        ) : (
          <div className="flex h-full min-h-0 flex-col justify-end gap-2 px-4 pb-4">
            {view.prompt ? (
              <div className="ml-auto max-w-[85%] rounded-2xl bg-[color:color-mix(in_srgb,var(--color-fg)_8%,transparent)] px-3 py-2 text-[13px] text-fg/85">
                {view.prompt}
              </div>
            ) : null}
            {view.error ? (
              <Banner layout="inline" model={{ id: "side-chat-start-failed", tone: "error", title: "Couldn't open the side chat", detail: view.error }} />
            ) : (
              <div className="text-[12px] text-fg/50">Starting the side chat…</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
