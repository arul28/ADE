import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AgentChatFileRef } from "../../../shared/types/chat";
import type { UserModelCatalog } from "../../../main/services/router/modelCatalog";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { HARNESS_LABELS } from "../../../shared/modelMentions";
import {
  buildModelHintRequest,
  hintChoices,
  hintFromAnswer,
  isModelHintPrompt,
  makerOf,
  resolveCurrentModel,
  shortName,
  type HintChoice,
  type ModelHint,
  type ModelHintAnswers,
} from "./modelHint";
import { readCheaperHintOutcomes, readModelHintHistory, recordCheaperHintOutcome, recordModelHintHistory } from "./modelHintHistory";

const DEBOUNCE_MS = 700;
/** Text that moved less than this share since the last ask keeps that answer. */
const MIN_CHANGE_SHARE = 0.1;
const CATALOG_TTL_MS = 10 * 60_000;
const STATUS_TTL_MS = 60_000;

// Per machine, shared by every composer: the catalogue is the machine's, not the chat's.
const catalogCache = new Map<string, { at: number; value: Promise<UserModelCatalog | null> }>();
const modeCache = new Map<string, { at: number; value: Promise<HintMode> }>();

type HintMode = "model_and_effort" | "effort_only" | "off";

function cached<T>(cache: Map<string, { at: number; value: Promise<T> }>, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function loadCatalog(pin: OpenProjectBinding | null, scopeKey: string): Promise<UserModelCatalog | null> {
  return cached(catalogCache, scopeKey, CATALOG_TTL_MS, async () => {
    const result = await window.ade.usage.getModelCatalog?.({}, pin).catch(() => null);
    const catalog = result?.catalog ?? null;
    return catalog?.models.length ? catalog : null;
  });
}

/** `off` unless Jev answers on that machine (Smart decisions on) and the hint setting allows it. */
function hintMode(pin: OpenProjectBinding | null, scopeKey: string): Promise<HintMode> {
  return cached(modeCache, scopeKey, STATUS_TTL_MS, async () => {
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

type Answered = {
  text: string;
  catalog: UserModelCatalog;
  choices: HintChoice[];
  answers: ModelHintAnswers | null;
  fromHistory: boolean;
};

export type ComposerModelHintArgs = {
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
  /**
   * The project tab's own runtime. An unpinned call goes to it, so the caches
   * are keyed by it: two tabs on two machines (or two projects, whose hint
   * settings differ) must not share one answer.
   */
  ownerBinding: OpenProjectBinding | null;
  /** The user picked this model by hand: it is only ever suggested a stronger model. */
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

export type ComposerModelHint = {
  /** The chip, when Jev's pick is clearly off from the current one. */
  chip: { hint: ModelHint; apply: () => void; dismiss: () => void } | null;
  /** Call as a new chat's first prompt is sent: it joins the history Jev reads. */
  recordSend: () => void;
};

/**
 * Jev's model and effort hint for a new chat: a chip beside the controls when
 * Jev's pick, read from the prompt and how this user started similar chats,
 * is clearly off from the current one. A click applies it through the
 * picker's own handlers; nothing changes on its own. Any failure shows
 * nothing. A chat that already has turns gets no hint.
 */
export function useComposerModelHint({
  draft,
  attachments,
  laneName,
  chatHasHistory,
  modelId,
  reasoningEffort,
  allowedModelIds,
  pin,
  ownerBinding,
  modelChosen,
  hidden,
  effortPickedByHand,
  onModelChange,
  onReasoningEffortChange,
}: ComposerModelHintArgs): ComposerModelHint {
  const [answered, setAnswered] = useState<Answered | null>(null);
  /** The prompt a hint was taken or dismissed on; it stays down until the text moves on. */
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const askedTextRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const ownerKeyRef = useRef("");
  ownerKeyRef.current = ownerBinding?.key ?? "";
  const contextRef = useRef({ attachments, laneName, modelId, allowedModelIds });
  contextRef.current = { attachments, laneName, modelId, allowedModelIds };
  // The machine's catalogue, for the history entry a send records.
  const catalogRef = useRef<UserModelCatalog | null>(null);
  const text = draft.trim();
  const active = !hidden && !chatHasHistory && isModelHintPrompt(text);
  // Jev chose among one provider's and maker's models; another model is another question.
  const outsideChoices = answered != null && !answered.choices.some((choice) => choice.modelId === modelId);

  // A new machine reads another catalogue and Jev.
  useEffect(() => {
    seqRef.current++;
    askedTextRef.current = null;
    catalogRef.current = null;
    setAnswered(null);
  }, [pin?.key]);

  useEffect(() => {
    if (!active) return;
    const asked = askedTextRef.current;
    if (!outsideChoices && asked != null && changeShare(asked, text) < MIN_CHANGE_SHARE) return;
    const timer = window.setTimeout(() => {
      const seq = ++seqRef.current;
      askedTextRef.current = text;
      const target = pinRef.current;
      const scopeKey = target?.key ?? ownerKeyRef.current;
      const { attachments: files, laneName: lane, modelId: currentModelId, allowedModelIds: allowed } = contextRef.current;
      const imageCount = files.filter((file) => file.type === "image" || file.type === "image-url").length;
      void (async () => {
        const mode = await hintMode(target, scopeKey);
        if (mode === "off") return;
        const catalog = await loadCatalog(target, scopeKey);
        if (!catalog || seq !== seqRef.current) return;
        catalogRef.current = catalog;
        const current = resolveCurrentModel(catalog, currentModelId);
        if (!current) return;
        const maker = makerOf(current);
        const history = readModelHintHistory(current.harness, maker);
        const outcomes = readCheaperHintOutcomes(current.harness, maker);
        const choices = hintChoices({
          catalog,
          current,
          history,
          allowedModelIds: allowed,
          effortOnly: mode === "effort_only",
          needsImages: imageCount > 0,
        });
        if (choices.length < 2) return;
        const answers = await window.ade.ai.jevDecide(buildModelHintRequest({
          prompt: text,
          laneName: lane,
          fileCount: files.length - imageCount,
          imageCount,
          provider: HARNESS_LABELS[current.harness] ?? current.harness,
          maker,
          history,
          outcomes,
          choices,
        }), target);
        if (seq !== seqRef.current) return;
        setAnswered({
          text,
          catalog,
          choices,
          answers,
          fromHistory: history.some((entry) => choices.some((choice) => choice.modelId === entry.modelId)),
        });
      })().catch(() => {});
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, text, outsideChoices]);

  // An effort picked by hand is the user's answer for this prompt.
  const textRef = useRef(text);
  textRef.current = text;
  const effortPicksSeenRef = useRef(effortPickedByHand);
  useEffect(() => {
    if (effortPicksSeenRef.current === effortPickedByHand) return;
    effortPicksSeenRef.current = effortPickedByHand;
    if (textRef.current) setDismissedFor(textRef.current);
  }, [effortPickedByHand]);
  const hint = useMemo(() => {
    if (!answered || !modelId || outsideChoices) return null;
    const current = resolveCurrentModel(answered.catalog, modelId);
    if (!current) return null;
    return hintFromAnswer({
      answers: answered.answers,
      choices: answered.choices,
      catalog: answered.catalog,
      current,
      currentEffort: reasoningEffort,
      modelChosen,
      fromHistory: answered.fromHistory,
    });
  }, [answered, modelId, reasoningEffort, modelChosen, outsideChoices]);

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
      fromModel: shown.from.modelId,
      fromEffort: shown.from.effort,
      toModel: shown.hint.modelId,
      toEffort: shown.hint.effort,
      effortOnly: shown.hint.effortOnly,
      fromHistory: answered?.fromHistory ?? false,
    });
    if (outcome !== "ignore") {
      // Product analytics: the kind of chip and the answer, once per kind and answer a day.
      const action = shown.hint.cheaper ? "hint_cheaper" : shown.hint.effortOnly ? "hint_effort" : "hint_model";
      const result = outcome === "accept" ? "hint_accepted" : "hint_dismissed";
      void window.ade?.analytics?.capture({
        event: "ade_feature_used",
        properties: { feature: "model_hint", action, outcome: result, source: "renderer_route" },
        dedupeKey: `model_hint:${action}:${result}`,
        minimumIntervalMs: 24 * 60 * 60_000,
      }).catch(() => undefined);
    }
    // Jev reads what the user did with cheaper-model chips; a chip left alone says nothing.
    const current = answered ? resolveCurrentModel(answered.catalog, shown.from.modelId) : null;
    if (shown.hint.cheaper && outcome !== "ignore" && current) {
      recordCheaperHintOutcome({
        harness: current.harness,
        maker: makerOf(current),
        suggested: shown.hint.effort ? `${shortName(shown.hint.displayName)} · ${shown.hint.effort}` : shortName(shown.hint.displayName),
        outcome: outcome === "accept" ? "accepted" : "dismissed",
        prompt: textRef.current,
      });
    }
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

  const recordSend = () => {
    const catalog = catalogRef.current;
    if (chatHasHistory || !catalog || !modelId) return;
    const current = resolveCurrentModel(catalog, modelId);
    if (!current) return;
    recordModelHintHistory({
      harness: current.harness,
      maker: makerOf(current),
      modelId,
      displayName: current.displayName,
      effort: reasoningEffort,
      prompt: textRef.current,
    });
  };

  if (!visible || !hint) return { chip: null, recordSend };

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
  const dismiss = () => {
    logOutcome("dismiss");
    setDismissedFor(text);
  };
  return { chip: { hint, apply, dismiss }, recordSend };
}
