import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AgentChatFileRef } from "../../../shared/types/chat";
import { MODEL_REGISTRY_AA_ATTRIBUTION } from "../../../shared/routerRegistry";
import type { UserModelCatalog } from "../../../main/services/router/modelCatalog";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { SmartTooltip } from "../ui/SmartTooltip";
import { reasoningEffortTierLabel } from "../shared/ModelPicker/ReasoningEffortPicker";
import {
  buildModelHintRequest,
  isModelHintPrompt,
  pickModelHint,
  readModelHintAnswers,
  type ModelHint,
  type ModelHintRead,
} from "./modelHint";

const DEBOUNCE_MS = 700;
/** Text that moved less than this share since the last ask keeps that answer. */
const MIN_CHANGE_SHARE = 0.1;
const CATALOG_TTL_MS = 10 * 60_000;
const STATUS_TTL_MS = 60_000;

// Per machine, shared by every composer: the catalogue is the machine's, not the chat's.
const catalogCache = new Map<string, { at: number; value: Promise<UserModelCatalog | null> }>();
const modeCache = new Map<string, { at: number; value: Promise<HintMode> }>();
/**
 * Model suggestions dismissed per chat; at `MODEL_DISMISSALS_TO_PIN` the chat
 * gets effort hints only. A new-chat draft starts its own count.
 */
const modelDismissals = new Map<string, number>();
const MODEL_DISMISSALS_TO_PIN = 2;

type HintMode = "model_and_effort" | "effort_only" | "off";

function cached<T>(cache: Map<string, { at: number; value: Promise<T> }>, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function loadCatalog(pin: OpenProjectBinding | null): Promise<UserModelCatalog | null> {
  return cached(catalogCache, pin?.key ?? "", CATALOG_TTL_MS, async () => {
    const result = await window.ade.usage.getModelCatalog?.({}, pin).catch(() => null);
    const catalog = result?.catalog ?? null;
    return catalog?.models.length ? catalog : null;
  });
}

/** `off` unless Jev answers on that machine (Smart decisions on, signed in) and the hint setting allows it. */
function hintMode(pin: OpenProjectBinding | null): Promise<HintMode> {
  return cached(modeCache, pin?.key ?? "", STATUS_TTL_MS, async () => {
    const [status, config] = await Promise.all([
      window.ade.ai.jevStatus(pin),
      window.ade.projectConfig.get(pin).catch(() => null),
    ]);
    if (status?.available !== true) return "off";
    return config?.effective.ai?.chat?.modelHintMode ?? "model_and_effort";
  });
}

/** The share of the longer text that differs, from the common prefix and suffix. */
function changeShare(a: string, b: string): number {
  const length = Math.max(a.length, b.length);
  if (!length) return 0;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return (length - start - end) / length;
}

function shortModelName(name: string): string {
  return name.replace(/^Claude\s+/, "");
}

function effortWord(effort: string | null): string {
  return effort ? reasoningEffortTierLabel(effort).toLowerCase() : "";
}

type Answered = { text: string; read: ModelHintRead; catalog: UserModelCatalog; mode: HintMode };

export type ComposerModelHintChipProps = {
  draft: string;
  attachments: readonly AgentChatFileRef[];
  laneName: string | null;
  chatHasHistory: boolean;
  modelId: string;
  reasoningEffort: string | null;
  /** The picker's own narrowed list, when this chat can switch only to some models. */
  allowedModelIds: readonly string[] | null;
  /** The machine the chat runs on: its catalogue, its Jev. */
  pin: OpenProjectBinding | null;
  sessionId: string | null;
  /**
   * The user chose this model (picked it by hand, or the chat already ran
   * turns on it): only its effort is suggested.
   */
  modelChosen: boolean;
  /** True whenever the picker itself could not change the model (a turn running, a locked or fixed model). */
  hidden: boolean;
  /**
   * Bumped each time the user picks an effort by hand: that choice stands for
   * the prompt being typed, so the chip stays down until the text moves on.
   */
  effortPickedByHand: number;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (effort: string | null) => void;
};

/**
 * Jev's suggestion beside the model and effort controls: shown only when the
 * cheapest model and effort that do this prompt well differ from the current
 * pick. A click applies it through the picker's own handlers; nothing changes
 * on its own. Any failure shows nothing.
 */
export const ComposerModelHintChip = memo(function ComposerModelHintChip({
  draft,
  attachments,
  laneName,
  chatHasHistory,
  modelId,
  reasoningEffort,
  allowedModelIds,
  pin,
  sessionId,
  modelChosen,
  hidden,
  effortPickedByHand,
  onModelChange,
  onReasoningEffortChange,
}: ComposerModelHintChipProps) {
  const [answered, setAnswered] = useState<Answered | null>(null);
  /** The prompt a hint was taken or dismissed on; it stays down until the text moves on. */
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const askedTextRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const contextRef = useRef({ attachments, laneName, chatHasHistory });
  contextRef.current = { attachments, laneName, chatHasHistory };
  const text = draft.trim();
  const active = !hidden && isModelHintPrompt(text);

  // A new machine reads another catalogue and Jev.
  useEffect(() => {
    seqRef.current++;
    askedTextRef.current = null;
    setAnswered(null);
  }, [pin?.key]);

  useEffect(() => {
    if (!active) return;
    const asked = askedTextRef.current;
    if (asked != null && changeShare(asked, text) < MIN_CHANGE_SHARE) return;
    const timer = window.setTimeout(() => {
      const seq = ++seqRef.current;
      askedTextRef.current = text;
      const target = pinRef.current;
      const { attachments: files, laneName: lane, chatHasHistory: history } = contextRef.current;
      const imageCount = files.filter((file) => file.type === "image" || file.type === "image-url").length;
      void (async () => {
        const mode = await hintMode(target);
        if (mode === "off") return;
        const catalog = await loadCatalog(target);
        if (!catalog || seq !== seqRef.current) return;
        const answers = await window.ade.ai.jevDecide(buildModelHintRequest({
          prompt: text,
          laneName: lane,
          chatHasHistory: history,
          fileCount: files.length - imageCount,
          imageCount,
        }), target);
        if (seq !== seqRef.current) return;
        const read = readModelHintAnswers(answers, imageCount);
        setAnswered(read ? { text, read, catalog, mode } : null);
      })().catch(() => {});
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, text]);

  const dismissalKey = `${pin?.key ?? ""}|${sessionId ?? "draft"}`;
  const [dismissalTick, setDismissalTick] = useState(0);
  // Every draft shares the "draft" key, so arriving at one is a new chat:
  // dismissals in an earlier draft must not pin this one.
  useEffect(() => {
    if (sessionId == null) modelDismissals.delete(dismissalKey);
  }, [dismissalKey, sessionId]);

  // An effort picked by hand is the user's answer for this prompt.
  const textRef = useRef(text);
  textRef.current = text;
  const effortPicksSeenRef = useRef(effortPickedByHand);
  useEffect(() => {
    if (effortPicksSeenRef.current === effortPickedByHand) return;
    effortPicksSeenRef.current = effortPickedByHand;
    if (textRef.current) setDismissedFor(textRef.current);
  }, [effortPickedByHand]);
  const hint: ModelHint | null = useMemo(() => {
    if (!answered || !modelId) return null;
    return pickModelHint({
      catalog: answered.catalog,
      read: answered.read,
      currentModelId: modelId,
      currentEffort: reasoningEffort,
      allowedModelIds,
      modelPinned: modelChosen
        || answered.mode === "effort_only"
        || (modelDismissals.get(dismissalKey) ?? 0) >= MODEL_DISMISSALS_TO_PIN,
    });
    // `dismissalTick` re-reads the per-chat dismissal count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, modelId, reasoningEffort, allowedModelIds, modelChosen, dismissalKey, dismissalTick]);

  // An answer about other text never shows under this text.
  const fresh = answered != null && changeShare(answered.text, text) < MIN_CHANGE_SHARE;
  const dismissed = dismissedFor != null && changeShare(dismissedFor, text) < MIN_CHANGE_SHARE;
  const visible = active && fresh && !dismissed && hint != null;

  // Outcome log: what the hint offered and what the user did with it.
  const shownRef = useRef<{ hint: ModelHint; from: { modelId: string; effort: string | null } } | null>(null);
  if (visible && hint) shownRef.current = { hint, from: { modelId, effort: reasoningEffort } };
  const logOutcome = (outcome: "accept" | "dismiss" | "ignore") => {
    const shown = shownRef.current;
    shownRef.current = null;
    if (!shown) return;
    logRendererDebugEvent("model_hint.outcome", {
      outcome,
      difficulty: shown.hint.read.difficulty,
      kind: shown.hint.read.kind,
      fromModel: shown.from.modelId,
      fromEffort: shown.from.effort,
      toModel: shown.hint.modelId,
      toEffort: shown.hint.effort,
      effortOnly: shown.hint.effortOnly,
    });
  };

  // An emptied composer is a sent (or cleared) prompt: a hint still up was ignored.
  const empty = text.length === 0;
  useEffect(() => {
    if (!empty) return;
    logOutcome("ignore");
    setDismissedFor(null);
    askedTextRef.current = null;
    setAnswered(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on the empty edge only
  }, [empty]);

  // The effort lands after the model does, as when the user picks them one after the other.
  const pendingEffortRef = useRef<{ modelId: string; effort: string | null } | null>(null);
  useEffect(() => {
    const pending = pendingEffortRef.current;
    if (!pending || pending.modelId !== modelId) return;
    pendingEffortRef.current = null;
    onReasoningEffortChange(pending.effort);
  }, [modelId, onReasoningEffortChange]);

  if (!visible || !hint) return null;

  const apply = () => {
    logOutcome("accept");
    // Taken: like a dismissal, it stays down for the rest of this prompt.
    setDismissedFor(text);
    if (hint.effortOnly) {
      onReasoningEffortChange(hint.effort);
      return;
    }
    if (hint.effort != null) pendingEffortRef.current = { modelId: hint.modelId, effort: hint.effort };
    onModelChange(hint.modelId);
  };
  const Arrow = hint.direction === "up" ? ArrowUp : ArrowDown;
  const label = hint.effortOnly
    ? `${effortWord(hint.effort)} effort?`
    : `${shortModelName(hint.displayName)}${hint.effort ? ` · ${effortWord(hint.effort)}` : ""}?`;

  return (
    <SmartTooltip
      forceEnabled
      content={{ label: hint.effortOnly ? "Suggested effort" : "Suggested model", description: hint.reason, effect: MODEL_REGISTRY_AA_ATTRIBUTION }}
    >
      <span
        data-chat-composer-model-hint=""
        className="inline-flex h-6 min-w-0 shrink items-center rounded-md border border-dashed border-violet-400/30 font-sans text-[length:calc(var(--chat-font-size)*9/14)] leading-none text-fg/70"
      >
        <button
          type="button"
          aria-label={`Use ${hint.displayName}${hint.effort ? ` at ${effortWord(hint.effort)} effort` : ""}`}
          className="inline-flex h-full min-w-0 items-center gap-0.5 rounded-l-md pl-1.5 pr-1 hover:bg-violet-500/[0.08] hover:text-fg"
          onClick={apply}
        >
          {hint.effortOnly ? <Arrow size={10} weight="bold" /> : null}
          <span className="max-w-32 truncate">{label}</span>
        </button>
        <button
          type="button"
          aria-label="Dismiss suggestion"
          className="inline-flex h-full items-center rounded-r-md px-1 text-fg/40 hover:bg-fg/[0.06] hover:text-fg"
          onClick={() => {
            logOutcome("dismiss");
            setDismissedFor(text);
            if (!hint.effortOnly) {
              modelDismissals.set(dismissalKey, (modelDismissals.get(dismissalKey) ?? 0) + 1);
              setDismissalTick((tick) => tick + 1);
            }
          }}
        >
          <X size={9} weight="bold" />
        </button>
      </span>
    </SmartTooltip>
  );
});
