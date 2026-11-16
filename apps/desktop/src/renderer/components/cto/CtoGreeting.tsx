import React, { useCallback } from "react";
import type { CtoAvatarLook } from "../../../shared/types";
import { SuggestionChips, type SuggestionPrompt } from "../personalChats/SuggestionChips";
import { CtoAvatar } from "./avatar/CtoAvatar";

/** Ways to start with the CTO. A chip fills the draft; the person finishes it. */
const CTO_STARTERS: ReadonlyArray<SuggestionPrompt> = [
  { label: "What's going on?", prefill: "What's going on in this project right now?" },
  { label: "Every morning…", prefill: "Every weekday at 9am, " },
  { label: "Remember that…", prefill: "Remember that " },
  { label: "Get a chat on it", prefill: "Start a chat to " },
];

/**
 * What the CTO's empty thread shows: it says hi and offers a start. It goes
 * away with the first message.
 */
export function CtoGreeting({
  look,
  name,
  sessionId,
}: {
  look: CtoAvatarLook;
  name: string;
  sessionId: string;
}) {
  const fillDraft = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent("ade:agent-chat:insert-draft", { detail: { sessionId, text } }));
  }, [sessionId]);
  return (
    <div className="ade-cto-greeting" data-testid="cto-greeting">
      <div className="ade-cto-welcome-avatar">
        <div className="ade-cto-profile-halo" aria-hidden />
        <CtoAvatar look={look} state="idle" size={96} motion="live" title={name} />
      </div>
      <div className="ade-cto-welcome-title">Hey, I'm {name}</div>
      <p className="ade-cto-status-word">
        <span>Ask me anything, or give me something to do on a schedule.</span>
      </p>
      <div className="ade-cto-greeting-starters">
        <SuggestionChips prompts={CTO_STARTERS} onSelect={fillDraft} />
      </div>
    </div>
  );
}
