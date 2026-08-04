import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export type ClaudeKeybinding = {
  context: ClaudeKeybindingContext | "Global";
  key: string;
  action: TuiKeybindingAction | null;
  rawAction?: string | null;
  implemented: boolean;
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
          const implemented = rawAction === null || SUPPORTED_ACTIONS.has(rawAction as TuiKeybindingAction);
          if (typeof rawAction === "string" && !implemented) {
            warnings.push(`Unrecognized action in known Claude namespace: ${rawAction}`);
          }
          if (CONTEXTS.has(context)) {
            bindings.push({
              context: context as ClaudeKeybindingContext,
              key: normalizedKey,
              action: implemented ? rawAction as TuiKeybindingAction | null : null,
              rawAction,
              implemented,
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
): TuiKeybindingAction | null | undefined {
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
