import { useCallback, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CaretDown } from "@phosphor-icons/react";
import {
  chatTaskItemDisplayLabel,
  chatTaskListCurrentLabel,
  chatTaskListProgress,
  type ChatTaskItem,
  type ChatTaskListSnapshot,
} from "../../../shared/chatTaskList";
import { cn } from "../ui/cn";
import { CHAT_CARD_WIDTH_CLASS } from "./chatCardPrimitives";

/**
 * The chat's one task list (`shared/chatTaskList.ts`), drawn two ways from one
 * component:
 *
 * - `ChatTaskListView` — the full list: `label  4/7` header, then one row per
 *   item. The Chat Info pane shows this, always expanded.
 * - `ChatTaskListCard` — the thread card: one collapsed line
 *   (`label · 4/7 · current item` plus a thin progress bar) that expands to the
 *   same `ChatTaskListView` on click and collapses on the next.
 *
 * Counts always come from the items (`chatTaskListProgress`); nothing passes
 * them in.
 */

const SUCCESS = "var(--color-success, #22c55e)";
const ERROR = "var(--color-error, #ef4444)";

/** Open state of each chat's card, in memory for the app session. */
const openBySession = new Map<string, boolean>();

export function resetChatTaskListCardStateForTests(): void {
  openBySession.clear();
}

function TaskBox({ item }: { item: ChatTaskItem }) {
  const reduceMotion = useReducedMotion();
  const done = item.status === "done" && !item.skipped;
  const failed = item.status === "failed";
  return (
    <span
      aria-hidden
      data-task-box={item.skipped ? "skipped" : item.status}
      className={cn(
        "relative flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-200",
        !done && !failed && "border-fg/35",
      )}
      style={
        done
          ? { borderColor: `color-mix(in srgb, ${SUCCESS} 60%, transparent)`, backgroundColor: `color-mix(in srgb, ${SUCCESS} 16%, transparent)` }
          : failed
            ? { borderColor: `color-mix(in srgb, ${ERROR} 70%, transparent)`, backgroundColor: `color-mix(in srgb, ${ERROR} 14%, transparent)` }
            : undefined
      }
    >
      {done ? (
        <svg viewBox="0 0 14 14" className="h-[10px] w-[10px]" fill="none">
          <motion.path
            d="M3 7.4 L5.9 10 L11 4.2"
            stroke={SUCCESS}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduceMotion ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
          />
        </svg>
      ) : failed ? (
        <svg viewBox="0 0 14 14" className="h-[9px] w-[9px]" fill="none">
          <path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" stroke={ERROR} strokeWidth={1.8} strokeLinecap="round" />
        </svg>
      ) : item.skipped ? (
        <span className="h-px w-[7px] rounded-full bg-fg/45" />
      ) : null}
    </span>
  );
}

/** A 1px line that travels under the running row only. */
function RunningUnderline() {
  const reduceMotion = useReducedMotion();
  return (
    <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden" data-task-running-line>
      {reduceMotion ? (
        <span className="absolute inset-0 bg-[color:var(--color-accent,#A78BFA)] opacity-40" />
      ) : (
        <motion.span
          className="absolute inset-y-0 w-1/3"
          style={{ background: "linear-gradient(90deg, transparent, var(--color-accent, #A78BFA), transparent)" }}
          initial={{ left: "-33%" }}
          animate={{ left: "100%" }}
          transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity }}
        />
      )}
    </span>
  );
}

function TaskRow({ item, depth }: { item: ChatTaskItem; depth: number }) {
  const settled = item.status === "done";
  const running = item.status === "running";
  const label = chatTaskItemDisplayLabel(item);
  return (
    <>
      <motion.li
        layout="position"
        data-task-status={item.skipped ? "skipped" : item.status}
        className="relative flex min-w-0 items-center gap-2 py-[3px]"
        style={{ paddingLeft: depth * 20 }}
        animate={{ opacity: settled ? 0.65 : 1, y: settled ? 1 : 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <TaskBox item={item} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[length:calc(var(--chat-font-size)*12.5/14)] leading-5",
            running ? "text-fg/92" : settled ? "text-fg/70" : "text-fg/80",
            item.skipped && "line-through decoration-fg/30",
          )}
          title={item.label}
        >
          {label}
        </span>
        {item.note ? (
          <span className="shrink-0 pl-2 text-[length:calc(var(--chat-font-size)*11/14)] text-muted-fg">{item.note}</span>
        ) : null}
        {running ? <RunningUnderline /> : null}
      </motion.li>
    </>
  );
}

export function ChatTaskListView({
  list,
  showHeader = true,
  className,
}: {
  list: ChatTaskListSnapshot;
  showHeader?: boolean;
  className?: string;
}) {
  const progress = chatTaskListProgress(list.items);
  return (
    <div className={cn("min-w-0 font-sans", className)} data-testid="chat-task-list">
      {showHeader ? (
        <div className="mb-1 flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-[length:calc(var(--chat-font-size)*12.5/14)] font-semibold text-fg/90">
            {list.label}
          </span>
          <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*11/14)] tabular-nums text-muted-fg">
            {progress.done}/{progress.total}
          </span>
        </div>
      ) : null}
      <ul className="flex min-w-0 flex-col">
        {list.items.map((item) => <TaskRow key={item.id} item={item} depth={0} />)}
      </ul>
    </div>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <span aria-hidden className="relative block h-[3px] w-10 shrink-0 overflow-hidden rounded-full bg-fg/10">
      <motion.span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ backgroundColor: SUCCESS }}
        initial={false}
        animate={{ width: `${percent}%` }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      />
    </span>
  );
}

/**
 * The thread's one task-list card. Collapsed by default to one line; the open
 * state is kept per chat in memory, so it survives the row moving to a later
 * turn and the virtualizer unmounting it.
 */
export function ChatTaskListCard({
  list,
  sessionId,
}: {
  list: ChatTaskListSnapshot;
  sessionId?: string | null;
}) {
  const stateKey = sessionId ?? "";
  const [open, setOpen] = useState(() => openBySession.get(stateKey) === true);
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      openBySession.set(stateKey, next);
      return next;
    });
  }, [stateKey]);
  const progress = chatTaskListProgress(list.items);
  const current = chatTaskListCurrentLabel(progress);
  return (
    <div
      className={cn(
        CHAT_CARD_WIDTH_CLASS,
        "rounded-[calc(var(--chat-radius-card)-6px)] border border-white/[0.06] bg-white/[0.03]",
      )}
      data-testid="chat-task-list-card"
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[length:calc(var(--chat-font-size)*12/14)]"
      >
        <span className="shrink-0 font-medium text-fg/85">{list.label}</span>
        <span className="shrink-0 text-fg/30">·</span>
        <span className="shrink-0 font-mono tabular-nums text-fg/65">{progress.done}/{progress.total}</span>
        <ProgressBar done={progress.done} total={progress.total} />
        {current && !open ? (
          <>
            <span className="shrink-0 text-fg/30">·</span>
            <span className="min-w-0 flex-1 truncate text-fg/55" data-testid="chat-task-list-current">{current}</span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        <CaretDown
          aria-hidden
          size={11}
          weight="bold"
          className={cn("shrink-0 text-fg/35 transition-transform duration-150", open && "rotate-180")}
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <ChatTaskListView list={list} showHeader={false} className="px-3 pb-2.5" />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
