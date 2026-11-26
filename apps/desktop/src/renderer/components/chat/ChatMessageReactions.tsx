import React, { useEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import * as Popover from "@radix-ui/react-popover";
import { Smiley } from "@phosphor-icons/react";
import { SmartTooltip } from "../ui/SmartTooltip";
import { Z_LAYERS } from "../ui/zLayers";
import { cn } from "../ui/cn";
import { capitalizeWord } from "../shared/ModelPicker/modelFacts";
import {
  CHAT_REACTION_EMOJIS,
  CHAT_REACTION_MEANINGS,
  CTO_REACTION_MEANINGS,
  type ChatReactionEmoji,
  type CtoReactionEmoji,
} from "../../../shared/types/chat";

export type AgentChatReactHandler = (targetKey: string, emoji: ChatReactionEmoji) => Promise<void>;

const REACTION_POP = { type: "spring", stiffness: 560, damping: 24 } as const;

/**
 * The CTO's reaction on the person's bubble, the way a tapback sits: a round
 * chip on the bubble's top outer corner, cut out of it by a ring in the
 * chat's own colour. Absolute, inside the bubble's height, so landing moves
 * nothing. Keyed on the emoji, so a newer reaction pops in again.
 */
export function UserMessageReaction({ emoji, by }: { emoji: CtoReactionEmoji; by: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <div data-ade-find-skip="" className="absolute -left-[calc(var(--chat-font-size)*20/14)] top-0 z-10">
      <SmartTooltip forceEnabled side="top" content={{ label: `${by} reacted ${emoji}`, description: capitalizeWord(CTO_REACTION_MEANINGS[emoji]) }}>
        <motion.span
          key={emoji}
          data-testid="chat-user-message-reaction"
          role="img"
          aria-label={`${by} reacted: ${CTO_REACTION_MEANINGS[emoji]}`}
          className="flex size-[calc(var(--chat-font-size)*28/14)] select-none items-center justify-center rounded-full border border-fg/[0.12] bg-(--chat-canvas-bg) text-[length:calc(var(--chat-font-size)*14/14)] leading-none shadow-[0_0_0_3px_var(--chat-canvas-bg)]"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0.12 } : REACTION_POP}
        >
          {emoji}
        </motion.span>
      </SmartTooltip>
    </div>
  );
}

export type AssistantReplyReaction = {
  targetKey: string;
  current: ChatReactionEmoji | null;
  /** Absent where the person cannot react (an archived chat): the pill only. */
  onReact?: AgentChatReactHandler;
};

/**
 * The hover line under an assistant reply. `hoverActions` (time, copy) show
 * on hover. On a CTO reply, `reaction` adds the person's side: their reaction
 * as a Slack-style pill that stays in view, or a hover button to pick one.
 */
export function AssistantReplyFooter({
  className,
  hoverActions,
  reaction,
}: {
  className: string;
  hoverActions: ReactNode;
  reaction: AssistantReplyReaction | null;
}) {
  if (reaction?.onReact) {
    return <ReactableReplyFooter className={className} hoverActions={hoverActions} reaction={{ ...reaction, onReact: reaction.onReact }} />;
  }
  const current = reaction?.current ?? null;
  return (
    <div data-testid="assistant-text-hover-footer" className={className}>
      {current ? (
        <SmartTooltip forceEnabled side="top" content={{ label: `You reacted ${current}`, description: capitalizeWord(CHAT_REACTION_MEANINGS[current]) }}>
          <span
            data-testid="chat-assistant-message-reaction"
            role="img"
            aria-label={`You reacted: ${CHAT_REACTION_MEANINGS[current]}`}
            className={cn(REACTION_PILL_CLASS, "cursor-default")}
          >
            <span aria-hidden>{current}</span>
            <span aria-hidden className="font-sans text-[10px] font-medium text-fg/60">1</span>
          </span>
        </SmartTooltip>
      ) : null}
      <HoverActions>{hoverActions}</HoverActions>
    </div>
  );
}

const REACTION_PILL_CLASS = "pointer-events-auto mr-1 inline-flex h-5 items-center gap-1 rounded-full border border-accent/35 bg-accent/12 px-1.5 text-[12px] leading-none opacity-100";

function HoverActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
      {children}
    </div>
  );
}

/**
 * One picker for the reply: the pill and the hover button are its two
 * triggers, and a pick shows in the pill at once. The logged event confirms
 * it, or the error takes it back. The pill keeps the hover line's height, so
 * a reaction moves nothing.
 */
function ReactableReplyFooter({
  className,
  hoverActions,
  reaction: { targetKey, current, onReact },
}: {
  className: string;
  hoverActions: ReactNode;
  reaction: Required<AssistantReplyReaction>;
}) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<ChatReactionEmoji | null>(null);
  useEffect(() => {
    if (pending && current === pending) setPending(null);
  }, [current, pending]);
  const shown = pending ?? current;
  const pick = (emoji: ChatReactionEmoji) => {
    setOpen(false);
    if (emoji === shown) return;
    setPending(emoji);
    onReact(targetKey, emoji).catch(() => setPending(null));
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div data-testid="assistant-text-hover-footer" className={className}>
        {shown ? (
          <SmartTooltip forceEnabled side="top" content={{ label: `You reacted ${shown}`, description: `${capitalizeWord(CHAT_REACTION_MEANINGS[shown])}. Click to change it.` }}>
            <Popover.Trigger asChild>
              <motion.button
                key={shown}
                type="button"
                data-testid="chat-assistant-message-reaction"
                aria-label={`You reacted: ${CHAT_REACTION_MEANINGS[shown]}. Change reaction`}
                className={cn(REACTION_PILL_CLASS, "transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50")}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={reduceMotion ? { duration: 0.12 } : REACTION_POP}
              >
                <span aria-hidden>{shown}</span>
                <span aria-hidden className="font-sans text-[10px] font-medium text-fg/60">1</span>
              </motion.button>
            </Popover.Trigger>
          </SmartTooltip>
        ) : null}
        <HoverActions>
          {hoverActions}
          {shown ? null : (
            <Popover.Trigger asChild>
              <button
                type="button"
                data-testid="chat-assistant-message-react"
                aria-label="React"
                title="React"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-fg/45 transition-colors hover:bg-fg/[0.06] hover:text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/45 data-[state=open]:text-fg/80"
              >
                <Smiley size={13} weight="regular" aria-hidden />
              </button>
            </Popover.Trigger>
          )}
        </HoverActions>
      </div>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
          style={{ zIndex: Z_LAYERS.popover }}
          className="flex gap-0.5 rounded-full border border-fg/[0.12] bg-surface-overlay p-1 shadow-xl"
          data-testid="chat-reaction-picker"
        >
          {CHAT_REACTION_EMOJIS.map((emoji, index) => (
            <motion.button
              key={emoji}
              type="button"
              aria-label={capitalizeWord(CHAT_REACTION_MEANINGS[emoji])}
              title={capitalizeWord(CHAT_REACTION_MEANINGS[emoji])}
              onClick={() => pick(emoji)}
              className={cn(
                "flex size-8 items-center justify-center rounded-full text-[18px] leading-none transition-[background-color,transform] duration-150 hover:scale-125 hover:bg-fg/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50",
                emoji === shown && "bg-accent/18",
              )}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.14, delay: reduceMotion ? 0 : index * 0.015 }}
            >
              {emoji}
            </motion.button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
