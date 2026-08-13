import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCoreChordIndex,
  parsePluginChord,
  pluginKeybindingRequests,
  resolvePluginKeybindings,
  type PluginChord,
  type PluginKeybindingRefusal,
} from "../../../../desktop/src/shared/plugins/keybindings";
import type { PluginManifestKeybinding } from "../../../../desktop/src/shared/plugins/manifest";

export const CLAUDE_KEYBINDING_CONTEXTS = [
  "Global",
  "Chat",
  "Autocomplete",
  "Settings",
  "Confirmation",
  "Tabs",
  "Help",
  "Transcript",
  "HistorySearch",
  "Task",
  "ThemePicker",
  "Attachments",
  "Footer",
  "MessageSelector",
  "DiffDialog",
  "ModelPicker",
  "Select",
  "Plugin",
  "Scroll",
  "Doctor",
] as const;

export type ClaudeKeybindingContext = typeof CLAUDE_KEYBINDING_CONTEXTS[number];

const SUPPORTED_ACTION_VALUES = [
  "app:interrupt",
  "app:exit",
  "app:redraw",
  "app:toggleTodos",
  "app:toggleTranscript",
  "app:help",
  "app:clear",
  "app:quit",
  "app:copyAdeDeeplink",
  "app:copyAdeWebLink",
  "app:openCommandPalette",
  "history:search",
  "history:previous",
  "history:next",
  "chat:cancel",
  "chat:clearInput",
  "chat:clearScreen",
  "chat:killAgents",
  "chat:cycleMode",
  "chat:modelPicker",
  "chat:fastMode",
  "chat:thinkingToggle",
  "chat:submit",
  "chat:launchBackground",
  "chat:newline",
  "chat:new-line",
  "chat:undo",
  "chat:externalEditor",
  "chat:open-editor",
  "chat:stash",
  "chat:imagePaste",
  "chat:paste-image",
  "autocomplete:accept",
  "autocomplete:dismiss",
  "autocomplete:previous",
  "autocomplete:next",
  "confirm:yes",
  "confirm:no",
  "confirm:previous",
  "confirm:next",
  "confirm:nextField",
  "confirm:previousField",
  "confirm:toggle",
  "confirm:cycleMode",
  "confirm:toggleExplanation",
  "permission:toggleDebug",
  "transcript:toggleShowAll",
  "transcript:exit",
  "historySearch:next",
  "historySearch:accept",
  "historySearch:cancel",
  "historySearch:execute",
  "historySearch:cycleScope",
  "task:background",
  "theme:toggleSyntaxHighlighting",
  "help:dismiss",
  "tabs:next",
  "tabs:previous",
  "attachments:next",
  "attachments:previous",
  "attachments:remove",
  "attachments:exit",
  "footer:next",
  "footer:previous",
  "footer:up",
  "footer:down",
  "footer:openSelected",
  "footer:clearSelection",
  "messageSelector:up",
  "messageSelector:down",
  "messageSelector:top",
  "messageSelector:bottom",
  "messageSelector:select",
  "diff:dismiss",
  "diff:previousSource",
  "diff:nextSource",
  "diff:previousFile",
  "diff:nextFile",
  "diff:viewDetails",
  "diff:back",
  "modelPicker:decreaseEffort",
  "modelPicker:increaseEffort",
  "select:next",
  "select:previous",
  "select:accept",
  "select:cancel",
  "plugin:toggle",
  "plugin:install",
  "plugin:favorite",
  "pane:toggle",
  "pane:agents",
  "pane:close",
  "settings:search",
  "settings:retry",
  "settings:close",
  "doctor:fix",
  "voice:pushToTalk",
  "scroll:lineUp",
  "scroll:lineDown",
  "scroll:pageUp",
  "scroll:pageDown",
  "scroll:halfPageUp",
  "scroll:halfPageDown",
  "scroll:fullPageUp",
  "scroll:fullPageDown",
  "scroll:top",
  "scroll:bottom",
  "selection:copy",
  "selection:clear",
  "selection:extendLeft",
  "selection:extendRight",
  "selection:extendUp",
  "selection:extendDown",
  "selection:extendLineStart",
  "selection:extendLineEnd",
  "scroll:up",
  "scroll:down",
] as const;

export type TuiKeybindingAction = typeof SUPPORTED_ACTION_VALUES[number];

/**
 * A plugin's action as a binding target: `plugin:<pluginId>:<actionId>`.
 *
 * The closed union above is the whole point of this reader — an action ADE has
 * not implemented is a warning, not a silent no-op — and plugins would break it,
 * because their verbs are not knowable at build time. So they get an escape with
 * exactly one shape, parameterized rather than open: three segments, both ids
 * validated. `plugin:toggle` and friends stay in the closed union and keep
 * meaning what they meant; nothing about the two forms can be confused, because
 * one has a second colon and the other does not.
 */
export type TuiPluginKeybindingAction = `plugin:${string}:${string}`;

/** What {@link dispatchKeybinding} can hand back for the caller to run. */
export type TuiResolvedKeybindingAction = TuiKeybindingAction | TuiPluginKeybindingAction;

/** The two ids inside a {@link TuiPluginKeybindingAction}. */
export type PluginKeybindingTarget = { pluginId: string; actionId: string };

/**
 * Plugin and action ids, as the manifest writes them.
 *
 * Deliberately narrow: an id is a machine name and it rides inside a
 * colon-delimited string, so anything with a colon, a space or a leading dot
 * would make the parse ambiguous rather than merely ugly.
 */
const PLUGIN_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Read `plugin:<pluginId>:<actionId>`, or null for anything else — including
 * `plugin:toggle` (two segments, a core action) and `plugin:a:b:c` (a typo the
 * caller must warn about rather than guess at).
 */
export function parsePluginKeybindingAction(value: string): PluginKeybindingTarget | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  const [namespace, pluginId, actionId] = parts;
  if (namespace !== "plugin") return null;
  if (!PLUGIN_ID_SEGMENT.test(pluginId) || !PLUGIN_ID_SEGMENT.test(actionId)) return null;
  return { pluginId, actionId };
}

export function isPluginKeybindingAction(value: string): value is TuiPluginKeybindingAction {
  return parsePluginKeybindingAction(value) != null;
}

export type ClaudeKeybinding = {
  context: ClaudeKeybindingContext | "Global";
  key: string;
  action: TuiResolvedKeybindingAction | null;
  rawAction?: string | null;
  implemented: boolean;
  /**
   * Set on rows this client synthesized from a plugin's manifest rather than
   * read from the user's file. Load-bearing for the merge: a plugin default is
   * the LOWEST priority thing in the set, and the only way to tell it from a
   * user binding that happens to name the same action is to have marked it.
   */
  source?: "user" | "plugin";
  /** Plugin rows only: who to attribute the chord to in `/help`. */
  pluginName?: string;
  /** Plugin rows only: the manifest's own label for the action. */
  label?: string;
};

export type ClaudeKeybindingDiagnostics = {
  filePath: string;
  created: boolean;
  bindingCount: number;
  warnings: string[];
  bindings: ClaudeKeybinding[];
  body: string;
};

export type KeypressLike = {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  tab?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
};

export type KeybindingDispatchState = {
  prefix: string | null;
  prefixAt: number;
};

const CONTEXTS = new Set<string>(CLAUDE_KEYBINDING_CONTEXTS);
const RESERVED_KEYS = new Set(["ctrl+c", "ctrl+d", "ctrl+m", "capslock"]);

/**
 * Chords `ade code` binds in its own input handler, as `holder -> chord`.
 *
 * This client ships no defaults in the *keybindings file* — that file is opt-in
 * and starts empty — but it very much ships defaults in CODE: `useInput` tests
 * `isCtrlInput(input, key, "p")` and friends directly, and those branches are
 * every bit as much "core" as a registry row would be. Without this table the
 * collision matrix believes core owns nothing but the four reserved keys, and a
 * plugin declaring `Ctrl+P` is happily bound, dispatched *before* the handler
 * that opens the details pane, and silently takes it over — exactly the "a
 * plugin cannot take a chord ADE ships" rule the shared matrix exists to hold.
 * The chords handled ahead of the dispatch (`ctrl+k`, `ctrl+u`, …) fail the
 * other way and are just as wrong: the plugin's shortcut is listed in `/help`
 * and can never fire, because core consumed the keystroke first.
 *
 * Alt chords are listed under BOTH spellings on purpose. The shared grammar
 * calls Cmd `meta` and Option `alt`, while a terminal has no Cmd at all and Ink
 * reports Option as `meta` — so `pluginChordToTuiKey` folds the two together,
 * and only listing both catches a manifest that spelled it either way.
 */
const TUI_CORE_CHORDS: readonly (readonly [string, string])[] = [
  ["the command palette", "ctrl+k"],
  ["the drawer", "ctrl+o"],
  ["the details pane", "ctrl+p"],
  ["the agents pane", "ctrl+a"],
  ["clearing the viewport", "ctrl+l"],
  ["copying the ADE deeplink", "ctrl+y"],
  ["grid view", "ctrl+g"],
  ["prompt history recall", "ctrl+r"],
  ["attaching a clipboard image", "ctrl+v"],
  ["submitting a form", "ctrl+s"],
  ["the terminal control toggle", "ctrl+t"],
  ["deleting the previous word", "ctrl+w"],
  ["deleting to the start of the line", "ctrl+u"],
  ["backspace", "ctrl+h"],
  ["moving the cursor a word left", "alt+b"],
  ["moving the cursor a word left", "meta+b"],
  ["moving the cursor a word right", "alt+f"],
  ["moving the cursor a word right", "meta+f"],
];
const SUPPORTED_ACTIONS = new Set<TuiKeybindingAction>(SUPPORTED_ACTION_VALUES);
const CLAUDE_ACTION_NAMESPACES = new Set([
  "autocomplete",
  "app",
  "chat",
  "confirm",
  "permission",
  "history",
  "historySearch",
  "pane",
  "scroll",
  "selection",
  "model",
  "modelPicker",
  "plugin",
  "task",
  "tabs",
  "theme",
  "transcript",
  "diff",
  "footer",
  "help",
  "vim",
  "attachments",
  "messageSelector",
  "select",
  "settings",
  "doctor",
  "voice",
]);

const DEFAULT_CONFIG = {
  $schema: "https://www.schemastore.org/claude-code-keybindings.json",
  $docs: "https://code.claude.com/docs/en/keybindings",
  bindings: [],
};

export function claudeHomePath(...segments: string[]): string {
  return path.join(os.homedir(), ".claude", ...segments);
}

export function defaultKeybindingsPath(): string {
  return claudeHomePath("keybindings.json");
}

function readJsonFile(filePath: string): { value: unknown | null; error: string | null } {
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeSingleKeystroke(value: string): string {
  const trimmed = value.trim();
  const lowered = trimmed
    .replace(/escape/gi, "esc")
    .replace(/return/gi, "enter")
    .replace(/control/gi, "ctrl")
    .replace(/option/gi, "alt")
    .replace(/opt/gi, "alt")
    .replace(/command/gi, "cmd")
    .replace(/super/gi, "cmd")
    .replace(/win/gi, "cmd");
  if (/^[A-Z]$/.test(trimmed)) return `shift+${trimmed.toLowerCase()}`;
  const parts = lowered
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/cmd/g, "meta")
    .split("+")
    .filter(Boolean)
    .map((part) => part === " " ? "space" : part);
  return parts.join("+");
}

export function normalizeKeyChord(value: string): string {
  return value
    .trim()
    .replace(/\s*\+\s*/g, "+")
    .split(/\s+/)
    .map(normalizeSingleKeystroke)
    .filter(Boolean)
    .join(" ");
}

export function keypressToChord(input: string, key: KeypressLike): string | null {
  const named = key.upArrow ? "up"
    : key.downArrow ? "down"
      : key.leftArrow ? "left"
        : key.rightArrow ? "right"
          : key.return ? "enter"
            : key.tab ? "tab"
              : key.escape ? "esc"
                : key.backspace ? "backspace"
                  : key.delete ? "delete"
                    : key.pageUp ? "pageup"
                      : key.pageDown ? "pagedown"
                        : key.home ? "home"
                          : key.end ? "end"
                            : input === " " ? "space"
                              : input.length === 1 ? input.toLowerCase()
                              : null;
  if (!named) return null;
  const mods = [
    key.ctrl ? "ctrl" : null,
    key.meta ? "meta" : null,
    key.shift && named !== input.toLowerCase() ? "shift" : null,
  ].filter((part): part is string => Boolean(part));
  return normalizeKeyChord([...mods, named].join("+"));
}

function isKnownClaudeAction(value: string): boolean {
  if (SUPPORTED_ACTIONS.has(value as TuiKeybindingAction)) return true;
  // The parameterized plugin escape is checked BEFORE the namespace fallback,
  // and strictly. `plugin` is a known namespace, so without this a malformed
  // `plugin:a:b:c` would be waved through as known-but-unimplemented and then
  // silently swallowed at dispatch — which is precisely the failure the closed
  // union exists to prevent.
  if (value.startsWith("plugin:") && value.indexOf(":", "plugin:".length) !== -1) {
    return isPluginKeybindingAction(value);
  }
  const [namespace] = value.split(":", 1);
  return namespace ? CLAUDE_ACTION_NAMESPACES.has(namespace) : false;
}

export function validateClaudeKeybindingsConfig(value: unknown, filePath = defaultKeybindingsPath()): ClaudeKeybindingDiagnostics {
  const warnings: string[] = [];
  const bindings: ClaudeKeybinding[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Configuration must be a JSON object.");
  } else {
    const blocks = (value as { bindings?: unknown }).bindings;
    if (!Array.isArray(blocks)) {
      warnings.push("Missing bindings array.");
    } else {
      for (const block of blocks) {
        const record = block && typeof block === "object" && !Array.isArray(block) ? block as Record<string, unknown> : null;
        const context = typeof record?.context === "string" ? record.context : "Global";
        if (!CONTEXTS.has(context)) warnings.push(`Unknown context: ${context}`);
        const blockBindings = record?.bindings;
        if (!blockBindings || typeof blockBindings !== "object" || Array.isArray(blockBindings)) {
          warnings.push(`Missing bindings object for ${context}.`);
          continue;
        }
        for (const [key, rawAction] of Object.entries(blockBindings)) {
          const normalizedKey = normalizeKeyChord(key);
          if (RESERVED_KEYS.has(normalizedKey)) warnings.push(`Reserved shortcut cannot be rebound: ${key}`);
          if (rawAction !== null && typeof rawAction !== "string") {
            warnings.push(`Invalid action for ${key}; expected string or null.`);
            continue;
          }
          if (rawAction !== null && !isKnownClaudeAction(rawAction)) {
            warnings.push(`Unsupported action for ${key}: ${rawAction}`);
            continue;
          }
          const implemented = rawAction === null
            || SUPPORTED_ACTIONS.has(rawAction as TuiKeybindingAction)
            || isPluginKeybindingAction(rawAction);
          if (typeof rawAction === "string" && !implemented) {
            warnings.push(`Unrecognized action in known Claude namespace: ${rawAction}`);
          }
          if (CONTEXTS.has(context)) {
            bindings.push({
              context: context as ClaudeKeybindingContext,
              key: normalizedKey,
              action: implemented ? rawAction as TuiResolvedKeybindingAction | null : null,
              rawAction,
              implemented,
              source: "user",
            });
          }
        }
      }
    }
  }
  return {
    filePath,
    created: false,
    bindingCount: bindings.length,
    warnings,
    bindings,
    body: formatKeybindingDiagnostics(filePath, false, bindings.length, warnings),
  };
}

export function readClaudeKeybindingsFile(options: { create: boolean; filePath?: string }): ClaudeKeybindingDiagnostics {
  const filePath = options.filePath ?? defaultKeybindingsPath();
  let created = false;
  if (!fs.existsSync(filePath)) {
    if (!options.create) {
      return {
        filePath,
        created: false,
        body: `Claude keybindings file is not configured.\n${filePath}`,
        warnings: [],
        bindingCount: 0,
        bindings: [],
      };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { mode: 0o600 });
    created = true;
  }
  const { value, error } = readJsonFile(filePath);
  const diagnostics = error
    ? {
        filePath,
        created,
        bindingCount: 0,
        warnings: [`Invalid JSON: ${error}`],
        bindings: [],
        body: "",
      }
    : { ...validateClaudeKeybindingsConfig(value, filePath), created };
  return {
    ...diagnostics,
    body: formatKeybindingDiagnostics(filePath, created, diagnostics.bindingCount, diagnostics.warnings),
  };
}

export function formatKeybindingDiagnostics(filePath: string, created: boolean, bindingCount: number, warnings: string[]): string {
  return [
    created ? "Created Claude keybindings file." : "Claude keybindings file found.",
    filePath,
    "",
    `${bindingCount} binding${bindingCount === 1 ? "" : "s"}`,
    warnings.length ? `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "No keybinding warnings found.",
  ].join("\n");
}

export function dispatchKeybinding(
  bindings: ClaudeKeybinding[],
  context: ClaudeKeybindingContext,
  input: string,
  key: KeypressLike,
  state?: KeybindingDispatchState,
): TuiResolvedKeybindingAction | null | undefined {
  const chord = keypressToChord(input, key);
  if (!chord) return undefined;
  const now = Date.now();
  const activeBindings = [...bindings].reverse().filter((binding) => binding.context === context || binding.context === "Global");
  const activePrefix = state?.prefix && now - state.prefixAt < 1_500 ? state.prefix : null;
  const candidate = activePrefix ? `${activePrefix} ${chord}` : chord;
  const match = activeBindings.find((binding) => binding.key === candidate);
  if (state) {
    const hasLongerChord = activeBindings.some((binding) => binding.key.startsWith(`${candidate} `));
    if (!match && hasLongerChord) {
      state.prefix = candidate;
      state.prefixAt = now;
      return undefined;
    }
    state.prefix = null;
    state.prefixAt = 0;
  }
  if (!match) return undefined;
  if (!match.implemented) return undefined;
  return match.action;
}

/* ── Plugin-declared defaults ───────────────────────────────────────────── */

/**
 * The part of a plugin's summary this merge reads.
 *
 * Structural rather than an import of `PluginSummary`, so the merge is testable
 * from an inline literal and does not drag the whole plugin SDK into a pure
 * function's test.
 */
export type PluginKeybindingPlugin = {
  pluginId: string;
  displayName: string;
  enabled: boolean;
  /** ISO install timestamp; the matrix's tie-break. Absent sorts first. */
  installedAt?: string;
  keybindings?: readonly PluginManifestKeybinding[];
};

export type PluginKeybindingMerge = {
  /** The user's bindings, plus every plugin default that survived. */
  bindings: ClaudeKeybinding[];
  /** Only the plugin rows, for `/help` and for attributing a dispatch. */
  pluginBindings: ClaudeKeybinding[];
  /** Everything refused, with the matrix's own sentence for each. */
  refusals: PluginKeybindingRefusal[];
};

/**
 * A plugin chord in the terminal's spelling, or null when the terminal cannot
 * see that keystroke at all.
 *
 * Three mappings that look like losses and are not:
 *
 * - `mod` becomes Ctrl. A terminal emulator does not deliver Cmd to the
 *   process, so resolving it the mac way would produce a chord nothing can
 *   ever press.
 * - `alt` becomes `meta`, which is Ink's name for the Escape-prefixed sequences
 *   a terminal actually sends for Option/Alt.
 * - `shift` is DROPPED on a single-character key. A terminal reports a shifted
 *   letter by sending the letter, and a control sequence carries no shift bit
 *   at all — {@link keypressToChord} therefore never emits `shift+p`, so
 *   spelling it would produce a binding that is silently unpressable. Shift
 *   survives on named keys (`shift+tab`), where Ink does report it.
 *
 * Modifier ORDER matters and is not cosmetic: the dispatcher compares against
 * {@link keypressToChord}'s output, which emits ctrl, meta, shift, key — a
 * chord spelled in any other order is simply a chord that never fires.
 */
export function pluginChordToTuiKey(chord: PluginChord): string | null {
  if (!chord.key) return null;
  const parts = [
    chord.ctrl || chord.mod ? "ctrl" : null,
    chord.meta || chord.alt ? "meta" : null,
    chord.shift && chord.key.length > 1 ? "shift" : null,
    chord.key,
  ].filter((part): part is string => Boolean(part));
  const key = normalizeKeyChord(parts.join("+"));
  return key || null;
}

/**
 * Fold plugin-declared chords into the user's bindings, lowest priority.
 *
 * Pure, and that is the requirement rather than a preference: this is where the
 * TUI's answer either matches the desktop's or does not, and it must be
 * provable without an Ink render. The precedence is the same sentence in both
 * clients with one word changed — on the desktop core always wins, and here
 * "core" is whatever the user's own file binds plus {@link RESERVED_KEYS},
 * because ADE ships no defaults of its own in this client.
 *
 * A multi-stroke user chord (`"ctrl+x ctrl+e"`) claims EVERY stroke it names.
 * The shared grammar refuses multi-stroke plugin chords outright, so the only
 * way the two can meet is a plugin taking a sequence's prefix — and a plugin
 * that owns `ctrl+x` outright means the user's `ctrl+x ctrl+e` can never
 * complete.
 */
export function mergePluginKeybindings(
  plugins: readonly PluginKeybindingPlugin[],
  userBindings: readonly ClaudeKeybinding[],
): PluginKeybindingMerge {
  const coreEntries: [string, string][] = [];
  for (const reserved of RESERVED_KEYS) coreEntries.push(["a reserved terminal shortcut", reserved]);
  for (const binding of userBindings) {
    if (!binding.key) continue;
    // `rawAction` is what the user wrote; an explicit `null` (unbind) still
    // holds the chord, because unbinding is a decision about that keystroke.
    const holder = binding.rawAction ?? binding.action ?? "your keybindings file";
    for (const stroke of binding.key.split(" ")) {
      if (stroke) coreEntries.push([holder, stroke]);
    }
  }
  // LAST, so a chord the user rebound is attributed to their own action rather
  // than to the built-in it displaced — the user's file is dispatched ahead of
  // the in-code handler, so their name for it is the true one. Either way the
  // plugin is refused, which is the part that matters.
  for (const [holder, chord] of TUI_CORE_CHORDS) coreEntries.push([holder, chord]);

  const requests = plugins
    .filter((plugin) => plugin.enabled && (plugin.keybindings?.length ?? 0) > 0)
    .flatMap((plugin) => pluginKeybindingRequests(
      {
        pluginId: plugin.pluginId,
        displayName: plugin.displayName || plugin.pluginId,
        installedAt: plugin.installedAt ?? "",
      },
      [...(plugin.keybindings ?? [])],
    ));

  if (requests.length === 0) {
    return { bindings: [...userBindings], pluginBindings: [], refusals: [] };
  }

  const coreChords = buildCoreChordIndex(coreEntries);

  // Pass one, in the shared grammar: validity, and the cross-client agreement.
  // `Mod+G` expands to ctrl AND meta here, so a manifest this client would
  // otherwise accept is refused for the same stated reason the desktop refuses
  // it — which is the entire point of the chord grammar living above both.
  const { bindings: resolved, refusals } = resolvePluginKeybindings(requests, coreChords);

  // Pass two, in the TERMINAL's spelling, because the two are not one-to-one:
  // `Ctrl+Shift+P` and `Ctrl+P` are distinct chords to the matrix and the same
  // keystroke to a terminal. Without this, one of them would bind a key the
  // other already owns and the loser would be a shortcut that silently does
  // nothing — the failure the matrix exists to prevent, reintroduced by the
  // spelling change. Run through the same resolver so the refusals are written
  // in the same voice rather than invented here.
  const tuiRequests = resolved
    .map((binding) => {
      const chord = parsePluginChord(binding.binding);
      const key = chord ? pluginChordToTuiKey(chord) : null;
      return key ? { ...binding, binding: key } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  const terminal = resolvePluginKeybindings(tuiRequests, coreChords);
  refusals.push(...terminal.refusals);

  const pluginBindings: ClaudeKeybinding[] = [];
  for (const binding of terminal.bindings) {
    const key = binding.binding;
    const action = `plugin:${binding.pluginId}:${binding.action}`;
    // The two ids have to survive the round trip through the colon-delimited
    // form, because `runKeybindingAction` reads them back out of it. A host that
    // hands us an id with a space or a colon in it (an older daemon, a manifest
    // parser that disagreed) would otherwise mint a chord that binds, lists
    // itself in `/help`, and does nothing when pressed — the silent no-op the
    // closed action union exists to prevent. Refuse it here instead.
    if (!isPluginKeybindingAction(action)) {
      refusals.push({
        pluginId: binding.pluginId,
        pluginName: binding.pluginName,
        action: binding.action,
        binding: binding.binding,
        reason: "invalid",
        heldBy: null,
        message: `${binding.pluginName} (${binding.pluginId}) declares an action id this client cannot address from a keyboard shortcut.`,
      });
      continue;
    }
    pluginBindings.push({
      // Global: a plugin action is reachable wherever the user is, the same way
      // the desktop's listener is on the window rather than on a tab.
      context: "Global",
      key,
      action,
      rawAction: action,
      implemented: true,
      source: "plugin",
      pluginName: binding.pluginName,
      label: binding.label,
    });
  }

  // Plugin rows FIRST, so the user's file wins: `dispatchKeybinding` reverses
  // the list and takes the last match, which makes later entries higher
  // priority. Putting plugin defaults at the front is the whole precedence
  // rule, and it is one line — which is exactly why it is commented.
  return { bindings: [...pluginBindings, ...userBindings], pluginBindings, refusals };
}

export function openKeybindingsFile(filePath = defaultKeybindingsPath()): { command: string; args: string[] } {
  const editor = process.env.VISUAL || process.env.EDITOR;
  const { command, args } = keybindingsEditorCommand(filePath, editor, process.platform);
  const child = spawn(command, args, { stdio: "ignore", detached: true, shell: false });
  child.on("error", () => undefined);
  child.unref();
  return { command, args };
}

export function keybindingsEditorCommand(
  filePath: string,
  editor: string | undefined,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  const editorParts = editor ? splitEditorCommand(editor) : [];
  if (editorParts.length) {
    return { command: editorParts[0], args: [...editorParts.slice(1), filePath] };
  }
  if (platform === "darwin") return { command: "open", args: [filePath] };
  // Windows has no xdg-open. Hand the file to the native shell association the
  // same way `ade open` does, as a single argv value (spawn runs shell:false).
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", filePath] };
  }
  return { command: "xdg-open", args: [filePath] };
}

// Quote-aware split so VISUAL/EDITOR values like `emacsclient -a ""` or
// `"/Applications/Visual Studio Code.app/..." --wait` keep their quoted
// segments as single argv entries (spawn runs with shell:false, so nothing
// re-tokenizes downstream). Supports '..', "..", and backslash escapes;
// an explicitly quoted empty string is preserved as an argument.
export function splitEditorCommand(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && value[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < value.length) {
      current += value[i + 1];
      hasToken = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken || current) {
        parts.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken || current) parts.push(current);
  return parts;
}
