/**
 * "<chat> in lane <lane> wants to use the ADE browser" — the one question ADE
 * asks when "Agents can use the ADE browser" is set to lanes or chats the user
 * approves and nothing covers the agent yet.
 *
 * App-level, next to `DialogHost`: an agent asks from wherever it runs, and the
 * person may be on any tab. Every window shows the same open prompt; the first
 * answer closes it everywhere, because the answer is pushed back from main.
 *
 * Keyboard: Enter is the primary answer, Esc is Block. Neither counts for a
 * short moment after the dialog appears, so a person mid-sentence in the
 * composer who presses Enter to send does not allow an agent by accident.
 * What they had typed stays in the composer, and focus goes back there after.
 */
import { useEffect, useRef } from "react";
import { Globe } from "@phosphor-icons/react";
import type { BuiltInBrowserAgentAccessAnswer, BuiltInBrowserAgentAccessPrompt } from "../../../shared/types/builtInBrowser";
import { Dialog, type DialogAction } from "../ui/dialog";
import {
  browserAgentAccessActions,
  shortAgentId,
  useBrowserAgentAccess,
} from "../chat/browser/browserAgentAccess";

/** Keys pressed this soon after the prompt appears were meant for something else. */
const KEY_ARM_DELAY_MS = 600;
const PROMPT_TEST_ID = "browser-agent-access-prompt";

export function BrowserAgentAccessPromptHost(): JSX.Element | null {
  const snapshot = useBrowserAgentAccess();
  const prompt = snapshot?.prompts[0] ?? null;
  if (!snapshot || !prompt) return null;
  return (
    <BrowserAgentAccessPromptDialog
      key={prompt.id}
      prompt={prompt}
      mode={snapshot.mode}
      waitingCount={snapshot.prompts.length - 1}
    />
  );
}

/** "“Fix sign-in” in lane auth-refactor wants to use the ADE browser". */
export function browserAgentAccessPromptTitle(prompt: BuiltInBrowserAgentAccessPrompt): string {
  const lane = prompt.laneName ?? (prompt.laneId ? shortAgentId(prompt.laneId) : null);
  const chat = prompt.chatTitle
    ? `“${prompt.chatTitle}”`
    : prompt.chatSessionId
      ? "A chat"
      : "An agent";
  return lane ? `${chat} in lane ${lane} wants to use the ADE browser` : `${chat} wants to use the ADE browser`;
}

function BrowserAgentAccessPromptDialog({
  prompt,
  mode,
  waitingCount,
}: {
  prompt: BuiltInBrowserAgentAccessPrompt;
  mode: "all" | "lanes" | "chats";
  waitingCount: number;
}): JSX.Element {
  const openedAt = useRef(Date.now());
  const answered = useRef(false);

  // The scoped answer the current setting is about: a lane in "lanes I
  // approve", a chat in "chats I approve" — or whichever one this caller has.
  const primary: "lane" | "chat" | null = mode === "lanes"
    ? (prompt.canAllowLane ? "lane" : prompt.canAllowChat ? "chat" : null)
    : (prompt.canAllowChat ? "chat" : prompt.canAllowLane ? "lane" : null);

  const answer = (value: BuiltInBrowserAgentAccessAnswer) => {
    if (answered.current) return;
    answered.current = true;
    void browserAgentAccessActions.answer(prompt.id, value).catch(() => {
      // The answer did not land; let the person try again.
      answered.current = false;
    });
  };
  const armed = () => Date.now() - openedAt.current >= KEY_ARM_DELAY_MS;

  const answerRef = useRef(answer);
  answerRef.current = answer;
  const primaryRef = useRef(primary);
  primaryRef.current = primary;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(`[data-testid="${PROMPT_TEST_ID}"]`)) return;
      // A focused button answers for itself (Tab then Enter).
      if (target.closest("button")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!armed() || !primaryRef.current) return;
      answerRef.current(primaryRef.current);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const actions: DialogAction[] = [
    { label: "Allow all agents", variant: "link", onClick: () => answer("all") },
    { label: "Block", variant: "secondary", onClick: () => answer("block") },
  ];
  const secondary = primary === "lane" ? "chat" : "lane";
  const offered = (value: "lane" | "chat") =>
    value === "lane" ? prompt.canAllowLane : prompt.canAllowChat;
  if (primary && offered(secondary)) {
    actions.push({
      label: secondary === "lane" ? "Allow this lane" : "Allow this chat",
      variant: "secondary",
      onClick: () => answer(secondary),
    });
  }
  if (primary) {
    actions.push({
      label: primary === "lane" ? "Allow this lane" : "Allow this chat",
      variant: "solid",
      onClick: () => answer(primary),
    });
  }

  const description = [
    "It shares your signed-in browser profile, so it can act as you on any site.",
    waitingCount > 0 ? `${waitingCount} more ${waitingCount === 1 ? "agent is" : "agents are"} waiting.` : null,
  ].filter(Boolean).join("\n");

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) answer("block");
      }}
      role="alertdialog"
      size="md"
      tone="accent"
      icon={<Globe size={16} weight="fill" />}
      title={browserAgentAccessPromptTitle(prompt)}
      description={description}
      hideClose
      closeOnScrimClick={false}
      // Focus the panel, not a button: a stray Enter must reach the armed
      // handler above rather than click whatever happened to be focused.
      preventAutoFocus
      onEscapeKeyDown={(event) => {
        // Too soon: the Escape was meant for whatever was on screen before.
        if (!armed()) event.preventDefault();
      }}
      testId={PROMPT_TEST_ID}
      actions={actions}
    />
  );
}
