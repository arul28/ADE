// ---------------------------------------------------------------------------
// The `{prompt}` action-result verb, for the TUI.
//
// A plugin action may answer with one question instead of a finished result —
// "What are you working on?" — and the client re-invokes THE SAME action with
// the same arguments plus the reader's answer under `args.prompt`. Everything
// about the contract (what a well-formed request looks like, what the answer
// frame is, how long an answer may be) lives in `shared/plugins/sdk.ts` and is
// read from there, never restated here: four clients ask this question and a
// handler must not be able to tell which one asked.
//
// What IS this module's is the small amount of policy a terminal has to answer
// for itself, kept pure so it can be tested without a React tree:
//
//   - ONE HOP. A re-invocation's own `{prompt}` is ignored, so a plugin cannot
//     trap the reader in a question it keeps re-opening. Detected from the
//     arguments the invocation carried, not from a counter this module keeps,
//     because the arguments are the same fact every client already has.
//   - The words drawn around the field when the plugin left them out.
//   - The refusal, rather than a truncation, of an over-ceiling answer.
// ---------------------------------------------------------------------------

import {
  buildPluginActionPromptAnswer,
  hasPluginActionPromptRequest,
  readPluginActionPrompt,
  type PluginActionPrompt,
} from "../../../desktop/src/shared/plugins/sdk";

/** What the client needs to ask the question and then re-invoke. */
export type PluginPromptRequest = {
  pluginId: string;
  /** The plugin's display name, for attribution in notices. */
  displayName: string;
  /** The action to call again — the SAME one that asked. */
  actionId: string;
  /** The arguments the first invocation carried, re-sent verbatim. */
  args: Record<string, unknown>;
  /** The control's own label, the fallback when the prompt named no title. */
  label: string;
  prompt: PluginActionPrompt;
};

/**
 * What an action's result means for the prompt verb.
 *
 * `ignored` and `none` differ for the reader, not for the caller: both let the
 * ordinary follow-ups (navigate, openUrl, composer) run, but `ignored` is the
 * one-hop stop and is worth a line in the log so a plugin author sees why their
 * second question never appeared.
 */
export type PluginPromptOutcome =
  | { kind: "none" }
  | { kind: "ask"; request: PluginPromptRequest }
  | { kind: "ignored" }
  | { kind: "unreadable" };

/** The word on the confirm affordance when the plugin named none. */
export const PLUGIN_PROMPT_DEFAULT_SUBMIT_LABEL = "Submit";

/**
 * Whether these arguments are already an answer to a question.
 *
 * The one-hop test. `args.prompt` is only ever written by a client re-invoking
 * an action, so its presence is exactly "this invocation is the second half of
 * a prompt round trip" — and a plugin that hand-writes one into a manifest
 * `args` block gets the same treatment, which is the conservative direction.
 */
export function pluginInvocationCarriesPromptAnswer(args: Record<string, unknown>): boolean {
  const answer = args.prompt;
  return typeof answer === "object" && answer !== null;
}

/**
 * Read the question an action asked, if it is allowed to ask one.
 *
 * `args` are the arguments THIS invocation was made with, which is what decides
 * the hop.
 */
export function pluginPromptOutcome(input: {
  result: unknown;
  pluginId: string;
  displayName: string;
  actionId: string;
  args: Record<string, unknown>;
  label: string;
}): PluginPromptOutcome {
  if (!hasPluginActionPromptRequest(input.result)) return { kind: "none" };
  if (pluginInvocationCarriesPromptAnswer(input.args)) return { kind: "ignored" };
  const prompt = readPluginActionPrompt(input.result);
  if (!prompt) return { kind: "unreadable" };
  return {
    kind: "ask",
    request: {
      pluginId: input.pluginId,
      displayName: input.displayName,
      actionId: input.actionId,
      args: input.args,
      label: input.label,
      prompt,
    },
  };
}

/** The question as a label: the plugin's title, else the control's own words. */
export function pluginPromptTitle(request: PluginPromptRequest): string {
  return request.prompt.title ?? request.label;
}

/** Grey text for the empty field. Empty string means "draw no hint". */
export function pluginPromptPlaceholder(request: PluginPromptRequest): string {
  if (request.prompt.placeholder) return request.prompt.placeholder;
  if ((request.prompt.options ?? []).length > 0) return "type a name from the list";
  return "";
}

export function pluginPromptSubmitLabel(request: PluginPromptRequest): string {
  return request.prompt.submitLabel ?? PLUGIN_PROMPT_DEFAULT_SUBMIT_LABEL;
}

/** The hint line under the field: how to send it and how to back out. */
export function pluginPromptHint(request: PluginPromptRequest): string {
  const options = request.prompt.options ?? [];
  if (options.length > 0) {
    return `type a number or a name · ↵ ${pluginPromptSubmitLabel(request)} · esc cancel`;
  }
  return `↵ ${pluginPromptSubmitLabel(request)} · esc cancel`;
}

/**
 * How many choices the terminal draws before it stops and counts the rest.
 *
 * A picker is a question, not a pane: a plugin that hands the reader forty lanes
 * would push the composer off the screen, and the field still accepts a typed
 * name for any of them, drawn or not.
 */
export const PLUGIN_PROMPT_MAX_VISIBLE_CHOICES = 8;

/** One drawn choice row: its number, its words, and whether the typed text hits it. */
export type PluginPromptChoiceLine = {
  value: string;
  /** 1-based, and the number the reader may type instead of the name. */
  number: number;
  text: string;
  selected: boolean;
};

/**
 * The choices to draw under a closed question, with the current typing marked.
 *
 * A closed question that draws only its title and its hint is unanswerable: the
 * reader is told to type a name from a list they were never shown. So the list
 * is drawn, numbered, and the number is an answer in its own right — a terminal
 * has no click, and asking someone to retype "staging-europe-west" to pick the
 * third of four is not a picker.
 *
 * Returns an empty array for a free-text question, which draws no list at all.
 */
export function pluginPromptChoiceLines(
  request: PluginPromptRequest,
  input?: { text?: string; maxVisible?: number },
): PluginPromptChoiceLine[] {
  const options = request.prompt.options ?? [];
  if (options.length === 0) return [];
  const maxVisible = input?.maxVisible ?? PLUGIN_PROMPT_MAX_VISIBLE_CHOICES;
  const typed = (input?.text ?? "").trim();
  const resolved = typed ? pluginPromptResolveChoice(request, typed) : null;
  return options.slice(0, Math.max(0, maxVisible)).map((option, index) => ({
    value: option.value,
    number: index + 1,
    text: option.label ?? option.value,
    selected: resolved != null && resolved === option.value,
  }));
}

/** How many choices exist beyond the drawn ones. Zero when all of them fit. */
export function pluginPromptHiddenChoiceCount(
  request: PluginPromptRequest,
  input?: { maxVisible?: number },
): number {
  const options = request.prompt.options ?? [];
  const maxVisible = input?.maxVisible ?? PLUGIN_PROMPT_MAX_VISIBLE_CHOICES;
  return Math.max(0, options.length - Math.max(0, maxVisible));
}

/**
 * Resolve typed text against a picker's options.
 *
 * Exact value, then exact label (case-insensitive), then a unique prefix.
 * `null` when the question is a picker and the typed text is not one of the
 * choices — sending a free-text string a handler will treat as a lane id is
 * how "link to a lane" used to pick the wrong one.
 */
export function pluginPromptResolveChoice(request: PluginPromptRequest, text: string): string | null {
  const options = request.prompt.options ?? [];
  if (options.length === 0) return text;
  const typed = text.trim();
  if (!typed) return null;
  const lower = typed.toLowerCase();
  const exactValue = options.find((option) => option.value === typed);
  if (exactValue) return exactValue.value;
  const exactLabel = options.find((option) => (option.label ?? option.value).toLowerCase() === lower);
  if (exactLabel) return exactLabel.value;
  // The drawn number, and only AFTER the two exact matches: an option whose own
  // value or label is "2" still wins its own digit, so numbering a list can
  // never change what an existing answer means.
  if (/^\d+$/.test(typed)) {
    const picked = options[Number(typed) - 1];
    if (picked) return picked.value;
  }
  const prefixed = options.filter((option) => {
    const label = (option.label ?? option.value).toLowerCase();
    return option.value.toLowerCase().startsWith(lower) || label.startsWith(lower);
  });
  return prefixed.length === 1 ? prefixed[0]?.value ?? null : null;
}

/** What the reader is told when they typed something that is not a choice. */
export function pluginPromptUnknownChoiceNotice(request: PluginPromptRequest): string {
  return `${pluginPromptTitle(request)}: that is not one of the choices. Type a number or a name from the list and press enter.`;
}

/**
 * The arguments the re-invocation carries, or `null` when the answer is too
 * long.
 *
 * Null is a refusal, never a truncation: a note cut in half and then saved is
 * worse than one the reader was asked to shorten. The caller says so and does
 * not invoke.
 */
export function pluginPromptAnswerArgs(
  request: PluginPromptRequest,
  text: string,
): Record<string, unknown> | null {
  const resolved = pluginPromptResolveChoice(request, text);
  if (resolved === null) return null;
  const answer = buildPluginActionPromptAnswer(request.prompt, resolved);
  if (!answer) return null;
  return { ...request.args, prompt: answer };
}

/** What the reader is told when their answer is over the ceiling. */
export function pluginPromptTooLongNotice(request: PluginPromptRequest): string {
  return `${pluginPromptTitle(request)}: that answer is too long to send. Shorten it and press enter again.`;
}
