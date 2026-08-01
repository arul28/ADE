import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretUp, Check, ListChecks, PencilSimple, X } from "@phosphor-icons/react";
import type { PendingInputQuestion, PendingInputRequest } from "../../../shared/types";
import {
  answerState,
  answeredQuestionCount,
  buildAnswers,
  foldedSummary,
  isQuestionAnswered,
  notePlaceholder,
  optionsForQuestion,
  ownQuestionValue,
  sendLabel,
} from "../../../shared/pendingInputAnswers";
import { pendingInputHeaderLabel } from "../../../shared/pendingInputLabels";
import { ProviderLogo } from "../shared/ProviderLogos";
import { cn } from "../ui/cn";
import { QuestionOptionPreview } from "./questionOptionPreview";

/**
 * The ask-question surface, anchored in the composer.
 *
 * The card is not a card any more — it IS the composer. While a question
 * blocks, this replaces the textarea inside the same prompt-box frame (same
 * border, same radius, same width), so nothing shifts when the question
 * resolves back into a textarea. The old shape put an interactive card in the
 * transcript AND a second "answer in the card above" banner on a composer that
 * was already hard-locked: the composer was dead and wearing a sign saying so.
 *
 * Three behaviours here are load-bearing, each fixing a specific defect:
 *
 * 1. **Select marks; it does not advance.** The previous card submitted
 *    immediately on click for a single single-select question — unless the
 *    freeform field happened to hold text, in which case the same click only
 *    selected. One gesture, two outcomes, no signal. `Next` / `Enter` advances
 *    now, and the note field stays reachable the whole time.
 *
 * 2. **Hover mutates no state.** Options used to set the focused option on
 *    `mouseEnter`, which swapped the preview, which changed the card's height,
 *    which made the virtualizer re-measure and reconcile scroll — so the row
 *    walked out from under the cursor and the click landed on its neighbour.
 *    Nothing here is driven by `:hover`. Previews open on an explicit
 *    disclosure click that neither selects the option nor advances the
 *    question.
 *
 * 3. **Only the option list scrolls.** Header, note row, and footer are pinned
 *    outside the scroll region, so Decline / Next / Send are reachable at any
 *    list length. The list's budget comes from the chat *surface*
 *    (transcript + composer, whose sum is invariant to how the two divide it),
 *    never from the transcript viewport — the viewport shrinks as the card
 *    grows, and feeding that back in is a runaway loop that eats the screen.
 *    iOS learned this the hard way; see `workPendingInputMaxHeight`.
 */

/**
 * Fraction of the chat surface the option viewport may claim.
 *
 * The minimum is deliberately large enough for an ordinary three-option
 * question plus one disclosed preview. Nested scrolling should be the long-
 * list fallback, not the default experience for the common case.
 */
const OPTIONS_HEIGHT_FRACTION = 0.55;
const OPTIONS_MIN_HEIGHT = 260;
const OPTIONS_MAX_HEIGHT = 520;

/**
 * Measure the chat surface — the flex column that holds the transcript and the
 * composer — and derive the option list's budget from it.
 *
 * `[data-chat-appearance-root]` is that column. Its height does not change when
 * the card grows (the transcript simply gets less of it), which is exactly the
 * property that makes it safe to feed back in. Falling back to the window is
 * fine and equally invariant; falling back to the transcript viewport would
 * not be.
 */
function useOptionsMaxHeight(anchor: HTMLElement | null): number {
  const [surfaceHeight, setSurfaceHeight] = useState<number>(() => (
    typeof window === "undefined" ? 720 : window.innerHeight
  ));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const surface = anchor?.closest<HTMLElement>("[data-chat-appearance-root]") ?? null;
    const read = () => {
      const next = surface?.clientHeight || window.innerHeight;
      setSurfaceHeight((prev) => (Math.abs(prev - next) < 2 ? prev : next));
    };
    read();
    window.addEventListener("resize", read);
    let observer: ResizeObserver | null = null;
    if (surface && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(read);
      observer.observe(surface);
    }
    return () => {
      window.removeEventListener("resize", read);
      observer?.disconnect();
    };
  }, [anchor]);

  return Math.round(Math.min(
    OPTIONS_MAX_HEIGHT,
    Math.max(OPTIONS_MIN_HEIGHT, surfaceHeight * OPTIONS_HEIGHT_FRACTION),
  ));
}

const ACCENT_TEXT = "text-[color:color-mix(in_srgb,var(--chat-accent)_78%,white_22%)]";
const HAIRLINE = "border-[color:color-mix(in_srgb,white_6.5%,transparent)]";

function OptionRow({
  index,
  option,
  checked,
  multi,
  expanded,
  disabled,
  questionId,
  onToggle,
  onTogglePreview,
}: {
  index: number;
  option: NonNullable<PendingInputQuestion["options"]>[number];
  checked: boolean;
  multi: boolean;
  expanded: boolean;
  disabled: boolean;
  questionId: string;
  onToggle: () => void;
  onTogglePreview: () => void;
}) {
  return (
    <div
      data-ask-question-option-row=""
      className={cn("border-t first:border-t-0", HAIRLINE)}
    >
      <button
        type="button"
        role={multi ? "checkbox" : "radio"}
        aria-checked={checked}
        disabled={disabled}
        data-testid={`ask-question-option-${questionId}-${option.value}`}
        onClick={onToggle}
        className={cn(
          "grid w-full grid-cols-[26px_minmax(0,1fr)_auto] items-baseline gap-2.5 px-3.5 py-2.5 text-left transition-colors",
          "hover:bg-white/[0.028] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[color:color-mix(in_srgb,var(--chat-accent)_55%,transparent)]",
          "disabled:pointer-events-none disabled:opacity-45",
          checked ? "bg-white/[0.038]" : null,
        )}
      >
        <span
          className={cn(
            "text-right font-mono text-[length:calc(var(--chat-font-size)*11/14)] font-semibold",
            checked ? "text-fg/62" : "text-fg/26",
          )}
        >
          {index + 1}
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              "block font-mono text-[length:calc(var(--chat-font-size)*12/14)] font-bold uppercase leading-[1.35] tracking-[0.055em]",
              checked ? "text-fg/92" : "text-fg/62",
            )}
          >
            {option.label}
          </span>
          {option.description ? (
            <span className="mt-0.5 line-clamp-2 block text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.5] text-fg/40">
              {option.description}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          {option.recommended && !checked ? (
            <span className="whitespace-nowrap text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/40">
              Recommended
            </span>
          ) : null}
          {checked ? (
            <Check size={12} weight="bold" className="text-[color:var(--chat-accent)]" />
          ) : null}
        </span>
      </button>
      {option.preview ? (
        <div className="-mt-1.5 pb-1.5 pl-[50px] pr-3.5">
          <button
            type="button"
            aria-expanded={expanded}
            disabled={disabled}
            data-testid={`ask-question-preview-toggle-${questionId}-${option.value}`}
            /* Neither selects nor advances. Preview visibility is a deliberate
               click on its own control, never a hover side-effect — that is
               half the fix for the row running away from the cursor. */
            onClick={(event) => {
              event.stopPropagation();
              onTogglePreview();
            }}
            className="rounded px-1.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.12em] text-fg/26 transition-colors hover:bg-white/[0.05] hover:text-fg/62 disabled:pointer-events-none disabled:opacity-45"
          >
            {expanded ? "▾ hide preview" : "▸ preview"}
          </button>
        </div>
      ) : null}
      {expanded && option.preview ? (
        <div
          data-testid={`ask-question-preview-${questionId}-${option.value}`}
          /* Explicit disclosure may grow the option region up to its cap.
             Hover and focus never open this panel, so that deliberate growth
             cannot recreate the old runaway-row interaction. */
          className={cn("mb-3 ml-[50px] mr-3.5 max-h-[168px] overflow-auto rounded-lg border bg-black/[0.28] px-3 py-2.5", HAIRLINE)}
        >
          <QuestionOptionPreview preview={option.preview} previewFormat={option.previewFormat} />
        </div>
      ) : null}
    </div>
  );
}

export function AskQuestionComposer({
  request,
  responding = false,
  onSubmit,
  onDecline,
}: {
  request: PendingInputRequest;
  responding?: boolean;
  onSubmit: (answers: Record<string, string | string[]>) => void;
  onDecline: () => void;
}) {
  const questions = request.questions;
  const [page, setPage] = useState(0);
  const [picksById, setPicks] = useState<Record<string, string[]>>({});
  const [notesById, setNotes] = useState<Record<string, string>>({});
  const [openPreview, setOpenPreview] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [folded, setFolded] = useState(false);
  const [rootNode, setRootNode] = useState<HTMLDivElement | null>(null);

  const optionsMaxHeight = useOptionsMaxHeight(rootNode);

  const safePage = Math.min(Math.max(page, 0), Math.max(questions.length - 1, 0));
  const question = questions[safePage];
  const picks = useMemo(() => (question ? ownQuestionValue(picksById, question.id) ?? [] : []), [picksById, question]);
  const note = question ? ownQuestionValue(notesById, question.id) ?? "" : "";
  const isLast = safePage === questions.length - 1;
  const options = useMemo(
    () => optionsForQuestion(request, question, safePage),
    [question, request, safePage],
  );

  const answered = answeredQuestionCount(questions, picksById, notesById);
  const canProceed = answerState(picks, note) !== "EMPTY";
  const canSend = questions.length > 1 ? answered === questions.length : canProceed;

  /* Select MARKS. It never advances — the note field is right below it, and
     yanking the card away mid-thought is the behaviour being deleted. */
  const toggle = useCallback((value: string) => {
    if (!question) return;
    setPicks((prev) => {
      const current = ownQuestionValue(prev, question.id) ?? [];
      if (question.multiSelect) {
        return {
          ...prev,
          [question.id]: current.includes(value)
            ? current.filter((entry) => entry !== value)
            : [...current, value],
        };
      }
      return { ...prev, [question.id]: current.includes(value) ? [] : [value] };
    });
  }, [question]);

  const submit = useCallback(() => {
    onSubmit(buildAnswers(questions, picksById, notesById));
  }, [notesById, onSubmit, picksById, questions]);

  const advance = useCallback(() => {
    if (!isLast) {
      setPage(safePage + 1);
      setOpenPreview(null);
      return;
    }
    if (canSend) submit();
  }, [canSend, isLast, safePage, submit]);

  /* Whether the list has more below the fold, and how many rows fall fully
     under it. Measured, not guessed, so a short list gets no false affordance —
     and rendered on its own line rather than floating, so the count can never
     cover a row the user meant to click. */
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const [optionsNode, setOptionsNode] = useState<HTMLDivElement | null>(null);
  const [hiddenBelow, setHiddenBelow] = useState(0);
  const attachOptions = useCallback((node: HTMLDivElement | null) => {
    optionsRef.current = node;
    setOptionsNode(node);
  }, []);
  // An effect rather than work inside the ref callback: the callback's teardown
  // call passes `null`, so anything registered against the old node has to be
  // torn down from a closure that still holds it. Registering there once leaked
  // a live ResizeObserver and scroll listener per resolved question, each still
  // calling setState on an unmounted tree.
  useEffect(() => {
    if (!optionsNode || typeof window === "undefined") return;
    const check = () => {
      const fold = optionsNode.getBoundingClientRect().bottom;
      const rows = [...optionsNode.querySelectorAll("[data-ask-question-option-row]")];
      setHiddenBelow(rows.filter((row) => row.getBoundingClientRect().top >= fold - 4).length);
    };
    check();
    optionsNode.addEventListener("scroll", check, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    observer?.observe(optionsNode);
    return () => {
      optionsNode.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, [optionsNode, options, question?.id]);

  const previewable = options.filter((option) => option.preview);
  const canCompare = previewable.length >= 2;
  const comparePair = comparing ? previewable.slice(0, 2) : [];

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (responding) return;
    const target = event.target as HTMLElement | null;
    const inField = target?.tagName?.toLowerCase() === "input" || target?.isContentEditable === true;
    if (event.key === "Escape") {
      event.preventDefault();
      onDecline();
      return;
    }
    if (!inField && /^[1-9]$/.test(event.key)) {
      const option = options[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        toggle(option.value);
      }
      return;
    }
    if (!inField && questions.length > 1 && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      setOpenPreview(null);
      setPage((prev) => (event.key === "ArrowRight"
        ? Math.min(prev + 1, questions.length - 1)
        : Math.max(prev - 1, 0)));
      return;
    }
    // `!inField` is load-bearing, not symmetry with the branches above: the note
    // input handles its own Enter, and `preventDefault` does not stop
    // propagation — without this guard the same keystroke advances twice and
    // sends two `chat.respondToInput` for one itemId (Codex answers the second
    // with "That request is no longer active"; OpenCode throws).
    if (event.key === "Enter" && !event.shiftKey && !inField) {
      event.preventDefault();
      if (isLast ? canSend : canProceed) advance();
    }
  };

  if (!question) return null;

  /* FOLDED. The gate is still open and still blocking — it has just collapsed
     to one line so the transcript gets the screen back. Deliberately NOT a
     dismiss: `×` declines, this only hides. */
  if (folded) {
    const { label, text } = foldedSummary(question, safePage);
    return (
      <div data-testid="ask-question-composer-folded" className="px-1 py-0.5">
        <button
          type="button"
          onClick={() => setFolded(false)}
          className="grid w-full grid-cols-[17px_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
        >
          <span className="inline-flex h-[17px] w-[17px] items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--chat-accent)_16%,transparent)]">
            <ProviderLogo family={request.source} size={10} />
          </span>
          <span className="min-w-0 truncate text-[length:calc(var(--chat-font-size)*12.5/14)] text-fg/62">
            <b className="font-medium text-fg/90">{label}</b> — {text}
          </span>
          <span
            className={cn(
              "whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] font-bold uppercase tracking-[0.12em]",
              "border-[color:color-mix(in_srgb,var(--chat-accent)_32%,transparent)]",
              ACCENT_TEXT,
            )}
          >
            {questions.length > 1 ? `${answered}/${questions.length}` : "Answer"}
          </span>
          <CaretUp size={11} weight="bold" className="text-fg/26" />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={setRootNode}
      role="group"
      aria-label={pendingInputHeaderLabel(request.source, request.kind)}
      data-testid="ask-question-composer"
      onKeyDown={onKeyDown}
      /* The one structural use of accent: a hairline top edge saying "you are
         in answer mode". Not a glow, not a fill. */
      className="border-t-[1.5px] border-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)]"
    >
      <div className="flex items-center gap-2.5 px-3.5 pt-3">
        <span className="inline-flex h-[17px] w-[17px] flex-none items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--chat-accent)_16%,transparent)]">
          <ProviderLogo family={request.source} size={10} />
        </span>
        <span className={cn("font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-[0.15em]", ACCENT_TEXT)}>
          {pendingInputHeaderLabel(request.source, request.kind)}
        </span>
        <span className="flex-1" />
        {questions.length > 1 ? (
          <span role="tablist" aria-label="Questions" className="flex items-center gap-1.5">
            {questions.map((entry, index) => {
              const entryAnswered = isQuestionAnswered(
                ownQuestionValue(picksById, entry.id) ?? [],
                ownQuestionValue(notesById, entry.id) ?? "",
              );
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={index === safePage}
                  aria-label={`Question ${index + 1}: ${entry.header ?? entry.question}`}
                  title={entry.header ?? entry.question}
                  data-testid={`ask-question-dot-${entry.id}`}
                  onClick={() => { setPage(index); setOpenPreview(null); }}
                  className={cn(
                    "h-[5px] w-[5px] rounded-full transition-transform hover:scale-[1.35]",
                    index === safePage
                      ? "bg-[color:var(--chat-accent)]"
                      : entryAnswered
                        ? "bg-emerald-300"
                        : "bg-fg/26",
                  )}
                />
              );
            })}
          </span>
        ) : null}
        <button
          type="button"
          title="Minimize — keeps the question open so you can scroll the chat"
          aria-label="Minimize question"
          data-testid="ask-question-minimize"
          onClick={() => setFolded(true)}
          className="rounded px-1 py-0.5 text-fg/26 transition-colors hover:bg-white/[0.05] hover:text-fg/62"
        >
          <CaretDown size={13} weight="bold" />
        </button>
        <button
          type="button"
          title="Decline"
          aria-label="Decline question"
          disabled={responding}
          data-testid="ask-question-decline-x"
          onClick={onDecline}
          className="rounded px-1 py-0.5 text-fg/26 transition-colors hover:bg-white/[0.05] hover:text-fg/62 disabled:pointer-events-none disabled:opacity-40"
        >
          <X size={13} weight="bold" />
        </button>
      </div>

      {question.header ? (
        <div className="px-3.5 pt-3 font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] font-bold uppercase tracking-[0.17em] text-fg/26">
          {question.header}
        </div>
      ) : null}
      <div className="px-3.5 pb-3 pt-1.5 text-[length:calc(var(--chat-font-size)*15/14)] font-semibold leading-[1.42] tracking-[-0.008em] text-fg/92">
        {question.question}
      </div>
      {/* The request-level description renders only when it adds something the
          question text does not already say. */}
      {request.description && !questions.some((entry) => entry.question.trim() === request.description?.trim()) ? (
        <div className="-mt-1.5 px-3.5 pb-3 text-[length:calc(var(--chat-font-size)*12.5/14)] leading-[1.55] text-fg/62">
          {request.description}
        </div>
      ) : null}
      {question.impact ? (
        <div data-testid="ask-question-impact" className="-mt-1.5 px-3.5 pb-2.5 text-[length:calc(var(--chat-font-size)*11.5/14)] leading-relaxed text-fg/55">
          {question.impact}
        </div>
      ) : null}
      {question.defaultAssumption ? (
        <div data-testid="ask-question-default-assumption" className="-mt-1 px-3.5 pb-2.5 text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/40">
          Default: {question.defaultAssumption}
        </div>
      ) : null}
      {question.multiSelect ? (
        <div className={cn("mx-3.5 mb-2.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.14em] text-fg/40", HAIRLINE)}>
          <ListChecks size={10} weight="bold" /> Pick all that apply
        </div>
      ) : null}

      <div className={cn("border-t", HAIRLINE)}>
        <div
          data-testid={`ask-question-options-viewport-${question.id}`}
          className="flex flex-col overflow-hidden"
          /* Natural height avoids a blank reserved preview well. Explicitly
             opened previews may grow this region once, up to the invariant
             surface-derived cap; genuinely long content scrolls inside it. */
          style={{ maxHeight: optionsMaxHeight }}
        >
          {/* Only this region scrolls. Note row and footer stay pinned below it. */}
          <div
            ref={attachOptions}
            role={question.multiSelect ? "group" : "radiogroup"}
            aria-label={question.question}
            data-testid={`ask-question-options-${question.id}`}
            className="min-h-0 flex-auto overflow-y-auto overscroll-contain"
          >
            {options.map((option, index) => (
              <OptionRow
                key={option.value}
                index={index}
                option={option}
                questionId={question.id}
                multi={question.multiSelect === true}
                checked={picks.includes(option.value)}
                expanded={openPreview === option.value && !comparing}
                disabled={responding}
                onToggle={() => toggle(option.value)}
                onTogglePreview={() => setOpenPreview((prev) => (prev === option.value ? null : option.value))}
              />
            ))}
            {comparing && comparePair.length === 2 ? (
              <div
                data-testid="ask-question-compare"
                className={cn("m-3 ml-[50px] grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-[color:color-mix(in_srgb,white_6.5%,transparent)]", HAIRLINE)}
              >
                {comparePair.map((option) => (
                  <div key={option.value} className="min-w-0 bg-black/[0.28]">
                    <div className={cn("truncate border-b px-2.5 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.13em] text-fg/26", HAIRLINE)}>
                      {option.label}
                    </div>
                    <div className="max-h-[140px] overflow-auto px-2.5 py-2">
                      <QuestionOptionPreview preview={option.preview ?? ""} previewFormat={option.previewFormat} />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {hiddenBelow > 0 ? (
            <button
              type="button"
              data-testid="ask-question-more-options"
              onClick={() => optionsRef.current?.scrollBy({
                top: optionsRef.current.clientHeight - 40,
                behavior: "smooth",
              })}
              className={cn("block w-full flex-none border-t py-1.5 pl-[50px] pr-3.5 text-left font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] font-bold uppercase tracking-[0.14em] text-fg/26 transition-colors hover:bg-white/[0.03] hover:text-fg/62", HAIRLINE)}
            >
              ⌄ {hiddenBelow} more {hiddenBelow === 1 ? "option" : "options"}
            </button>
          ) : null}
        </div>

        {question.allowsFreeform !== false ? (
          <div className={cn("grid grid-cols-[26px_minmax(0,1fr)] items-center gap-2.5 border-t px-3.5 py-1", HAIRLINE)}>
            <PencilSimple size={12} weight="regular" className="justify-self-end text-fg/26" />
            <input
              type={question.isSecret ? "password" : "text"}
              value={note}
              disabled={responding}
              data-testid={`ask-question-note-${question.id}`}
              /* The field has two jobs and the placeholder says which one is
                 live: an ANSWER when nothing is picked, a QUALIFIER once
                 something is. No disabled state, no mode switch. */
              placeholder={notePlaceholder({
                hasOptions: options.length > 0,
                picks,
                multi: question.multiSelect === true,
              })}
              onChange={(event) => setNotes((prev) => ({ ...prev, [question.id]: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (isLast ? canSend : canProceed) advance();
              }}
              className="w-full bg-transparent py-2.5 text-[length:calc(var(--chat-font-size)*12.5/14)] text-fg/85 outline-none placeholder:text-fg/26"
            />
          </div>
        ) : null}
      </div>

      <div className={cn("flex items-center gap-2.5 border-t px-3 py-2.5", HAIRLINE)}>
        <button
          type="button"
          disabled={responding}
          data-testid="ask-question-decline"
          onClick={onDecline}
          className="rounded-lg px-3 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-[0.11em] text-fg/40 transition-colors hover:bg-white/[0.05] hover:text-fg/62 disabled:pointer-events-none disabled:opacity-40"
        >
          Decline
        </button>
        {canCompare ? (
          <button
            type="button"
            disabled={responding}
            data-testid="ask-question-compare-toggle"
            onClick={() => setComparing((prev) => !prev)}
            className="rounded-lg px-3 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-[0.11em] text-fg/40 transition-colors hover:bg-white/[0.05] hover:text-fg/62 disabled:pointer-events-none disabled:opacity-40"
          >
            {comparing ? "⇄ Single" : "⇄ Compare"}
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="hidden font-mono text-[length:calc(var(--chat-font-size)*10/14)] tracking-[0.04em] text-fg/26 sm:inline">
          <kbd className="text-fg/40">1-9</kbd> pick · <kbd className="text-fg/40">↵</kbd> {isLast ? "send" : "next"} · <kbd className="text-fg/40">esc</kbd> decline
        </span>
        {questions.length > 1 ? (
          <span className="font-mono text-[length:calc(var(--chat-font-size)*10/14)] tracking-[0.1em] text-fg/26">
            {safePage + 1} / {questions.length}
          </span>
        ) : null}
        <button
          type="button"
          disabled={responding || (isLast ? !canSend : !canProceed)}
          data-testid="ask-question-send"
          onClick={advance}
          className={cn(
            "rounded-lg px-3 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-[0.11em] transition-colors",
            "bg-[color:color-mix(in_srgb,var(--chat-accent)_92%,black_8%)] text-black",
            "hover:bg-[color:var(--chat-accent)]",
            "disabled:pointer-events-none disabled:bg-white/[0.055] disabled:text-fg/26",
          )}
        >
          {responding ? "Sending…" : sendLabel({
            picks,
            note,
            isLast,
            totalAnswered: answered,
            totalQuestions: questions.length,
          })}
        </button>
      </div>
    </div>
  );
}
