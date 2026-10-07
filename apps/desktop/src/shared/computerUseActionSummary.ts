/**
 * What a computer-use shell command did, in words a reader can follow.
 *
 * Agents drive screens through the ADE CLI from their own shell tool
 * (`ade screen click …`, `ade browser fill …`, `"$ADE_CLI_PATH" apple tap …`).
 * The transcript used to show those as generic shell rows. This module reads
 * the command and its output and returns a small structured summary — the verb,
 * the element actually hit, the app, the surface, and whether the screen
 * changed — that the desktop/web transcript draws as an action row
 * (`computerUseActionPresentation.ts` turns it into words). The iOS app ports
 * both files to Swift: the parser in `apps/ios/ADE/Views/Work/WorkComputerUseSummary.swift`,
 * the words in `WorkComputerUsePresentation.swift`. Keep them in step.
 *
 * Pure and platform-neutral: no DOM, no Node, no renderer imports. It must
 * never throw. Whenever it is unsure (not an ADE computer-use command, a verb
 * it does not know, two acting commands in one shell call, shell control
 * flow) it returns null, and the caller keeps its plain shell row.
 *
 * Output shapes it reads (see `apps/ade-cli/src/cli.ts` `formatActionAnswerLines`
 * and `apps/ade-cli/src/cliMacDesktopFormat.ts`):
 *   - `hit: <role> "<name>" (<handle>)` / `hit: no element; …`
 *   - `effect: observed|unconfirmed|not checked|waiting — <reason>`
 *   - `renderKeyValues` rows: `<label>  <value>` (two or more spaces)
 *   - the Mac Desktop windows footer: `  #12 Notes — Untitled`
 *   - errors on stderr: `ade: <message>`
 *   - the user's own browser: `attached: Google Chrome on <machine>, tab …` and
 *     `target: your Google Chrome on <machine>` (`userBrowserLabels.ts`)
 *   - `--json` (the default when `--text` is absent): the result object.
 */

import {
  clip,
  parseOutput,
  readAppleDevice,
  readString,
  readUserBrowser,
  type ParsedOutput,
} from "./computerUseActionOutput";
import { readRecord } from "./readRecord";

export type ComputerUseSurfaceKind =
  | "lane_screen"
  | "app_control"
  | "ade_browser"
  | "user_browser"
  | "apple_device"
  | "proof";

export type ComputerUseActionOutcome =
  | "running"
  /** The screen visibly changed after the input. */
  | "observed"
  /** The input was sent and nothing ADE can see changed yet. */
  | "unconfirmed"
  /** The surface did not compare before and after (a key press, a wait). */
  | "not_checked"
  | "failed";

export type ComputerUseActionSummary = {
  surface: ComputerUseSurfaceKind;
  /** Canonical CLI domain: `screen`, `app-control`, `browser`, `apple`, `proof`. */
  domain: ComputerUseDomain;
  /** Canonical verb, e.g. `click`, `type`, `proof`. */
  verb: string;
  /** "Clicked". */
  past: string;
  /** "Clicking". */
  progressive: string;
  /** "click" — read as "Couldn't click". */
  infinitive: string;
  /** The emphasized object: the element hit, the text typed, the key pressed. */
  target: string | null;
  /** True when `target` is a name to quote ("Checkout"); false for a URL or host. */
  targetQuoted: boolean;
  /**
   * Where it happened, when that is not already the surface: "in Xcode",
   * "on localhost:5173". Null for the user's browser and the lane screen
   * itself, which the "using …" part names.
   */
  place: ComputerUseActionPlace | null;
  /** App the action drove, for its icon and for folding a run by app. */
  appName: string | null;
  /** The user's own browser, when the action targeted it: "Chrome". */
  browserName: string | null;
  /** Machine label for the user's browser: "studio-mac". */
  hostLabel: string | null;
  /** Apple device, when the command or its output named it. */
  device: { name: string | null; os: string | null } | null;
  /** Which lane screen the command named: `ade mac-desktop` or `ade windows-desktop`; null for `ade screen`. */
  screenProduct: "mac" | "windows" | null;
  outcome: ComputerUseActionOutcome;
  /** Why it failed, or why the effect is unconfirmed, as the CLI said it. */
  reason: string | null;
  /** A filed proof record. */
  proof: { caption: string | null; prNumber: number | null } | null;
};

/** Where the action happened: an app ("in TextEdit") or a site ("on localhost:5173"). */
export type ComputerUseActionPlace = {
  preposition: "in" | "on";
  label: string;
  kind: "app" | "site" | "other";
};

export type ComputerUseDomain = "screen" | "app-control" | "browser" | "apple" | "proof";

export type ComputerUseCommandInput = {
  command: string | readonly string[] | null | undefined;
  output?: string | null;
  status: "running" | "completed" | "failed" | "interrupted";
  exitCode?: number | null;
};

/* ── Command parsing ─────────────────────────────────────────────────────── */

const DOMAIN_ALIASES: Readonly<Record<string, ComputerUseDomain>> = {
  screen: "screen",
  "mac-desktop": "screen",
  "mac-desk": "screen",
  desk: "screen",
  "windows-desktop": "screen",
  "windows-desk": "screen",
  "app-control": "app-control",
  app: "app-control",
  apps: "app-control",
  electron: "app-control",
  browser: "browser",
  "ade-browser": "browser",
  "built-in-browser": "browser",
  "builtin-browser": "browser",
  apple: "apple",
  "ios-sim": "apple",
  ios: "apple",
  simulator: "apple",
  proof: "proof",
  computer: "proof",
  "computer-use": "proof",
  artifact: "proof",
  artifacts: "proof",
};

/** Flags that never take a value, so a positional after them is not eaten. */
const BOOLEAN_FLAGS = new Set([
  "--text", "--json", "--pretty", "--compact", "--map", "--fast", "--real", "--submit",
  "--follow", "--open-drawer", "--no-build", "--panel", "--no-panel", "--new-tab",
  "--active-tab", "--floating", "--keep", "--plain", "--isolated", "--no-dom",
  "--network-idle", "--double", "--right", "--force", "--no-wait", "--wait",
  "--shared", "--all", "--no-verify", "--har", "--clear", "--help", "-h", "--quiet",
  "--verbose", "--background", "--no-observe", "--observe", "--socket",
]);

/** Global options whose next token is a value (`--socket /tmp/x.sock`). */
const GLOBAL_VALUE_FLAGS = new Set(["--project", "--project-root", "--machine", "--runtime", "--role", "--home"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "pwsh", "powershell", "cmd"]);
const WRAPPERS = new Set(["env", "time", "command", "exec", "nohup", "sudo", "caffeinate"]);
const CONTROL_WORDS = new Set(["for", "while", "until", "if", "then", "else", "elif", "do", "done", "fi", "case", "esac", "function"]);

type ParsedInvocation = {
  domain: ComputerUseDomain;
  /** The domain word as typed: `mac-desktop`, `windows-desktop`, `screen`, … */
  alias: string;
  /** Sub-command words after the domain (`record`, `start`), lowercased. */
  words: string[];
  /** Positional arguments after the verb. */
  positionals: string[];
  flags: Map<string, string | true>;
};

/**
 * Split a shell command into simple-command token lists. Quote-aware, with
 * `&&`, `||`, `;`, `|`, `&` and newlines as separators. Tokens are unquoted
 * but variables are left as written (`$ADE_CLI_PATH`).
 */
function splitShellCommands(source: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | "\"" | null = null;
  const pushToken = () => {
    if (hasToken) tokens.push(current);
    current = "";
    hasToken = false;
  };
  const pushCommand = () => {
    pushToken();
    if (tokens.length) commands.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === "\"" && index + 1 < source.length) {
        const next = source[index + 1]!;
        if (next === "\"" || next === "\\" || next === "$" || next === "`") {
          current += next;
          index += 1;
        } else {
          current += char;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < source.length) {
      const next = source[index + 1]!;
      if (next === "\n") {
        index += 1;
        continue;
      }
      current += next;
      hasToken = true;
      index += 1;
      continue;
    }
    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      pushCommand();
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      pushToken();
      continue;
    }
    current += char;
    hasToken = true;
  }
  pushCommand();
  return commands;
}

function basename(token: string): string {
  const parts = token.split(/[\\/]/);
  return (parts[parts.length - 1] ?? token).toLowerCase();
}

const ADE_CLI_VAR = /^(?:\$\{?(?:env:)?ADE_CLI_PATH\}?|%ADE_CLI_PATH%)$/i;

function isAdeExecutable(token: string, aliasVars: ReadonlySet<string>): boolean {
  if (ADE_CLI_VAR.test(token)) return true;
  const name = basename(token);
  if (name === "ade" || name === "ade.exe" || name === "ade.cmd" || name === "ade.ps1") return true;
  const variable = /^\$\{?(\w+)\}?$/.exec(token)?.[1];
  return Boolean(variable && aliasVars.has(variable));
}

function parseInvocation(tokens: readonly string[], aliasVars: ReadonlySet<string>): ParsedInvocation | null | "control" {
  let index = 0;
  // Leading assignments and wrappers: `FOO=1 env timeout 30 ade …`.
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^\w+=/.test(token)) {
      index += 1;
      continue;
    }
    const name = basename(token);
    if (CONTROL_WORDS.has(name)) return "control";
    if (WRAPPERS.has(name)) {
      index += 1;
      continue;
    }
    if (name === "timeout" || name === "gtimeout") {
      index += 2;
      continue;
    }
    break;
  }
  const executable = tokens[index];
  if (!executable || !isAdeExecutable(executable, aliasVars)) return null;
  index += 1;
  // Global options before the domain.
  while (index < tokens.length && tokens[index]!.startsWith("-")) {
    const flag = tokens[index]!;
    index += 1;
    const next = tokens[index];
    if (!flag.includes("=") && next !== undefined && !next.startsWith("-")) {
      const takesValue = GLOBAL_VALUE_FLAGS.has(flag)
        || (flag === "--socket" && !(next.toLowerCase() in DOMAIN_ALIASES));
      if (takesValue) index += 1;
    }
  }
  const domainToken = tokens[index]?.toLowerCase();
  const domain = domainToken ? DOMAIN_ALIASES[domainToken] : undefined;
  if (!domain) return null;
  index += 1;
  const words: string[] = [];
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  while (index < tokens.length) {
    const token = tokens[index]!;
    index += 1;
    if (token.startsWith("-") && token.length > 1 && !/^-\d/.test(token)) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        flags.set(token.slice(0, eq), token.slice(eq + 1));
        continue;
      }
      const next = tokens[index];
      // `--text` is the output switch, except in `click --text "Deploy"`, where
      // it names the element: a plain word after it is its value.
      const takesValue = !BOOLEAN_FLAGS.has(token) || (token === "--text" && next !== undefined && !next.startsWith("-"));
      if (takesValue && next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
        flags.set(token, next);
        index += 1;
      } else if (!flags.has(token)) {
        // A bare repeat (`--text "Deploy" --text`) keeps the value it already has.
        flags.set(token, true);
      }
      continue;
    }
    // Sub-command words come first and are plain lowercase words.
    if (positionals.length === 0 && words.length < 2 && /^[a-z][a-z-]*$/.test(token) && isSubcommandWord(domain, words, token)) {
      words.push(token);
      continue;
    }
    positionals.push(token);
  }
  return { domain, alias: domainToken!, words, positionals, flags };
}

/** The second word of a two-word verb (`record start`, `proof capture`). */
function isSubcommandWord(domain: ComputerUseDomain, words: readonly string[], token: string): boolean {
  if (words.length === 0) return true;
  const first = words[0]!;
  if (first === "record") return token === "start" || token === "stop" || token === "status";
  if (domain === "proof") return ["capture", "attach", "record", "publish", "step", "list", "status", "rm"].includes(token) && first === "proof";
  if (first === "session") return true;
  if (first === "terminal") return true;
  return false;
}

/* ── Verbs ───────────────────────────────────────────────────────────────── */

type VerbSpec = {
  past: string;
  progressive: string;
  infinitive: string;
  /** How the target is read when the output names no element. */
  target: "element" | "typed" | "key" | "app" | "url" | "caption" | "direction" | "file" | "page" | "none";
  /** An observation, not an action: compact rows still read well. */
  passive?: boolean;
};

const VERBS: Readonly<Record<string, VerbSpec>> = {
  click: { past: "Clicked", progressive: "Clicking", infinitive: "click", target: "element" },
  "double-click": { past: "Double-clicked", progressive: "Double-clicking", infinitive: "double-click", target: "element" },
  dblclick: { past: "Double-clicked", progressive: "Double-clicking", infinitive: "double-click", target: "element" },
  "right-click": { past: "Right-clicked", progressive: "Right-clicking", infinitive: "right-click", target: "element" },
  tap: { past: "Tapped", progressive: "Tapping", infinitive: "tap", target: "element" },
  "tap-element": { past: "Tapped", progressive: "Tapping", infinitive: "tap", target: "element" },
  hover: { past: "Hovered over", progressive: "Hovering over", infinitive: "hover over", target: "element" },
  drag: { past: "Dragged", progressive: "Dragging", infinitive: "drag", target: "element" },
  swipe: { past: "Swiped", progressive: "Swiping", infinitive: "swipe", target: "direction" },
  scroll: { past: "Scrolled", progressive: "Scrolling", infinitive: "scroll", target: "direction" },
  type: { past: "Typed", progressive: "Typing", infinitive: "type", target: "typed" },
  fill: { past: "Filled", progressive: "Filling", infinitive: "fill", target: "element" },
  clear: { past: "Cleared", progressive: "Clearing", infinitive: "clear", target: "element" },
  select: { past: "Selected", progressive: "Selecting", infinitive: "select", target: "element" },
  "select-option": { past: "Selected", progressive: "Selecting", infinitive: "select", target: "element" },
  press: { past: "Pressed", progressive: "Pressing", infinitive: "press", target: "key" },
  key: { past: "Pressed", progressive: "Pressing", infinitive: "press", target: "key" },
  button: { past: "Pressed", progressive: "Pressing", infinitive: "press", target: "key" },
  upload: { past: "Uploaded", progressive: "Uploading", infinitive: "upload", target: "file" },
  open: { past: "Opened", progressive: "Opening", infinitive: "open", target: "app" },
  "open-url": { past: "Opened", progressive: "Opening", infinitive: "open", target: "url" },
  navigate: { past: "Opened", progressive: "Opening", infinitive: "open", target: "url" },
  "new-tab": { past: "Opened", progressive: "Opening", infinitive: "open", target: "url" },
  back: { past: "Went back", progressive: "Going back", infinitive: "go back", target: "none" },
  forward: { past: "Went forward", progressive: "Going forward", infinitive: "go forward", target: "none" },
  reload: { past: "Reloaded", progressive: "Reloading", infinitive: "reload", target: "none" },
  launch: { past: "Launched", progressive: "Launching", infinitive: "launch", target: "app" },
  relaunch: { past: "Opened", progressive: "Opening", infinitive: "open", target: "app" },
  terminate: { past: "Closed", progressive: "Closing", infinitive: "close", target: "app" },
  focus: { past: "Focused", progressive: "Focusing", infinitive: "focus", target: "app" },
  close: { past: "Closed", progressive: "Closing", infinitive: "close", target: "app" },
  wait: { past: "Waited for", progressive: "Waiting for", infinitive: "find", target: "element", passive: true },
  "wait-for-element": { past: "Waited for", progressive: "Waiting for", infinitive: "find", target: "element", passive: true },
  "assert-visible": { past: "Saw", progressive: "Checking for", infinitive: "see", target: "element", passive: true },
  observe: { past: "Looked at", progressive: "Looking at", infinitive: "look at", target: "page", passive: true },
  snapshot: { past: "Looked at", progressive: "Looking at", infinitive: "look at", target: "page", passive: true },
  screenshot: { past: "Took a screenshot of", progressive: "Taking a screenshot of", infinitive: "take a screenshot of", target: "page", passive: true },
  "record start": { past: "Started recording", progressive: "Starting a recording", infinitive: "start recording", target: "caption" },
  "record-start": { past: "Started recording", progressive: "Starting a recording", infinitive: "start recording", target: "caption" },
  "record stop": { past: "Stopped recording", progressive: "Stopping the recording", infinitive: "stop recording", target: "caption" },
  "record-stop": { past: "Stopped recording", progressive: "Stopping the recording", infinitive: "stop recording", target: "caption" },
  proof: { past: "Filed proof", progressive: "Filing proof", infinitive: "file proof", target: "caption" },
  "proof capture": { past: "Filed proof", progressive: "Filing proof", infinitive: "file proof", target: "caption" },
  "proof attach": { past: "Filed proof", progressive: "Filing proof", infinitive: "file proof", target: "caption" },
  "proof record": { past: "Filed proof", progressive: "Recording proof", infinitive: "record proof", target: "caption" },
  "proof publish": { past: "Posted proof", progressive: "Posting proof", infinitive: "post proof", target: "caption" },
  attach: { past: "Connected to", progressive: "Connecting to", infinitive: "connect to", target: "none" },
};

/** Verbs that only make sense on some surfaces (`open` on a phone is `relaunch`). */
function resolveVerb(invocation: ParsedInvocation): { key: string; spec: VerbSpec } | null {
  const [first, second] = invocation.words;
  if (!first) return null;
  if (invocation.flags.has("--help") || invocation.flags.has("-h") || first === "help") return null;
  if (invocation.domain === "proof") {
    const key = `proof ${second ?? ""}`.trim();
    if (first !== "proof" && first !== "capture" && first !== "attach" && first !== "record" && first !== "publish") return null;
    const normalized = first === "proof" ? key : `proof ${first}`;
    const spec = VERBS[normalized];
    return spec ? { key: normalized, spec } : null;
  }
  if (first === "record") {
    const key = `record ${second ?? ""}`.trim();
    const spec = VERBS[key];
    return spec ? { key, spec } : null;
  }
  if (first === "attach" && invocation.domain !== "browser") return null;
  // `screen open` names an app; `browser open` a URL.
  if (first === "open" && invocation.domain === "browser") return { key: "open", spec: VERBS.navigate! };
  if (first === "open" && invocation.domain === "apple") return { key: "open", spec: VERBS["open-url"]! };
  // Reading a page is "Read “Payments · Stripe”"; a screen is looked at.
  if ((first === "observe" || first === "snapshot") && invocation.domain === "browser") {
    return { key: first, spec: { past: "Read", progressive: "Reading", infinitive: "read", target: "page", passive: true } };
  }
  // `apple start` names the device, which later rows in the run borrow.
  if (first === "start" && invocation.domain === "apple") {
    return { key: "start", spec: { past: "Started", progressive: "Starting", infinitive: "start", target: "none", passive: true } };
  }
  const spec = VERBS[first];
  return spec ? { key: first, spec } : null;
}

/* ── Field readers ───────────────────────────────────────────────────────── */

function flagValue(invocation: ParsedInvocation, ...names: string[]): string | null {
  for (const name of names) {
    const value = invocation.flags.get(name);
    if (typeof value === "string" && value.trim().length) return value.trim();
  }
  return null;
}

function urlHost(value: string | null): string | null {
  if (!value) return null;
  const raw = value.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (url.protocol === "about:" || url.protocol === "data:") return null;
    return url.host || null;
  } catch {
    return null;
  }
}

function appNameFromBundleId(bundleId: string | null): string | null {
  if (!bundleId) return null;
  const last = bundleId.split(".").pop() ?? "";
  if (!last) return null;
  const known: Record<string, string> = {
    mobilesafari: "Safari",
    preferences: "Settings",
    mobileslideshow: "Photos",
    mobilenotes: "Notes",
    mobilemail: "Mail",
    mobilecal: "Calendar",
    mobiletimer: "Clock",
    maps: "Maps",
  };
  return known[last.toLowerCase()] ?? `${last.charAt(0).toUpperCase()}${last.slice(1)}`;
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

function surfaceFor(domain: ComputerUseDomain): ComputerUseSurfaceKind {
  switch (domain) {
    case "screen": return "lane_screen";
    case "app-control": return "app_control";
    case "browser": return "ade_browser";
    case "apple": return "apple_device";
    case "proof": return "proof";
  }
}

/** The command as one line of shell: an argv array is joined with its spaced parts quoted. */
export function computerUseCommandText(command: ComputerUseCommandInput["command"]): string | null {
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.map((part) => (/\s/.test(part) ? `'${part.replace(/'/g, "'\\''")}'` : part)).join(" ");
  return null;
}

/** Variables assigned the ADE CLI path in this command: `A="$ADE_CLI_PATH"`. */
function collectAliasVars(source: string): Set<string> {
  const vars = new Set<string>();
  const pattern = /\b(\w+)=["']?\$\{?ADE_CLI_PATH\}?["']?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) vars.add(match[1]!);
  return vars;
}

function findInvocations(source: string, depth = 0): ParsedInvocation[] | null {
  const aliasVars = collectAliasVars(source);
  const found: ParsedInvocation[] = [];
  for (const tokens of splitShellCommands(source)) {
    const head = basename(tokens[0] ?? "");
    // `bash -lc '<script>'`: read the script.
    if (SHELLS.has(head) && depth < 2) {
      const scriptIndex = tokens.findIndex((token, index) => index > 0 && /^-[a-z]*c$/i.test(token));
      const script = scriptIndex > 0 ? tokens[scriptIndex + 1] : undefined;
      if (script) {
        const inner = findInvocations(script, depth + 1);
        if (inner === null) return null;
        found.push(...inner);
        continue;
      }
    }
    const invocation = parseInvocation(tokens, aliasVars);
    if (invocation === "control") return null;
    if (invocation) found.push(invocation);
  }
  return found;
}

/**
 * A cheap first look: the command names an `ade` executable (`ade`,
 * `/usr/local/bin/ade`, `ade.exe`, …) or the ADE CLI path variable. Everything
 * else is an ordinary shell command and is not parsed at all.
 */
const ADE_COMMAND_HINT = /(?:^|[\s"'`/\\;&|(=])ade(?:\.(?:exe|cmd|ps1))?(?=$|[\s"'`;&|)])|ADE_CLI_PATH/i;

const SUMMARY_CACHE_LIMIT = 300;
const SUMMARY_CACHE_OUTPUT_EDGE = 2048;
const summaryCache = new Map<string, ComputerUseActionSummary | null>();

/**
 * The output's length plus its head and tail, not the whole text: two runs can
 * share a long observation and differ only in a later `effect:` or error line,
 * which lands in the tail.
 */
function summaryCacheKey(input: ComputerUseCommandInput, source: string, output: string): string {
  const edges = output.length <= SUMMARY_CACHE_OUTPUT_EDGE * 2
    ? output
    : `${output.slice(0, SUMMARY_CACHE_OUTPUT_EDGE)}\u0000${output.slice(-SUMMARY_CACHE_OUTPUT_EDGE)}`;
  return `${input.status}\u0000${input.exitCode ?? ""}\u0000${source}\u0000${output.length}\u0000${edges}`;
}

/**
 * Summarize one shell command, or null when it is not an ADE computer-use
 * action this module can describe with confidence.
 */
export function summarizeComputerUseCommand(input: ComputerUseCommandInput): ComputerUseActionSummary | null {
  const source = computerUseCommandText(input.command);
  if (!source || !ADE_COMMAND_HINT.test(source)) return null;
  const output = typeof input.output === "string" ? input.output : "";
  // A running command's output still grows; summarize it fresh every time.
  const cacheable = input.status !== "running";
  const cacheKey = cacheable ? summaryCacheKey(input, source, output) : "";
  if (cacheable) {
    const cached = summaryCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  let invocations: ParsedInvocation[] | null;
  try {
    invocations = findInvocations(source);
  } catch {
    invocations = null;
  }
  // No ADE invocation at all: not worth a cache slot.
  if (!invocations || invocations.length === 0) return null;
  let summary: ComputerUseActionSummary | null = null;
  try {
    summary = buildSummary(invocations, output, input);
  } catch {
    summary = null;
  }
  if (!cacheable) return summary;
  if (summaryCache.size >= SUMMARY_CACHE_LIMIT) summaryCache.clear();
  summaryCache.set(cacheKey, summary);
  return summary;
}

/** The object of the sentence, and how the verb reads around it. */
type TargetShape = {
  target: string | null;
  quoted: boolean;
  /** "up", "down", …: "Scrolled down in “Notes list”". */
  direction: string | null;
  /** A screen point, not a name: "Clicked at 412, 300". */
  point: boolean;
};

const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const NUMBER = /^-?\d+(\.\d+)?$/;

function describeTarget(
  spec: VerbSpec,
  verbKey: string,
  invocation: ParsedInvocation,
  parsed: ParsedOutput,
  appName: string | null,
): TargetShape {
  const shape: TargetShape = { target: null, quoted: true, direction: null, point: false };
  const elementFlag = flagValue(invocation, "--label", "--text-match", "--text", "--name", "--title", "--test-id", "--element", "--placeholder", "--role-name");
  switch (spec.target) {
    case "element": {
      shape.target = parsed.hitName
        ?? elementFlag
        ?? (verbKey === "wait" || verbKey === "wait-for-element" ? flagValue(invocation, "--selector", "--window-title") : null)
        ?? flagValue(invocation, "--selector");
      if (!shape.target && (verbKey === "fill" || verbKey === "select" || verbKey === "select-option")) {
        shape.target = flagValue(invocation, "--value", "--option") ?? invocation.positionals.at(-1) ?? null;
      }
      const x = flagValue(invocation, "--x");
      const y = flagValue(invocation, "--y");
      if (!shape.target && x && y && NUMBER.test(x) && NUMBER.test(y)) {
        return { target: `${Math.round(Number(x))}, ${Math.round(Number(y))}`, quoted: false, direction: null, point: true };
      }
      return shape;
    }
    case "typed":
      shape.target = invocation.positionals.join(" ") || flagValue(invocation, "--value", "--string");
      return shape;
    case "key":
      shape.target = invocation.positionals[0] ?? flagValue(invocation, "--key", "--button");
      return shape;
    case "direction": {
      const direction = (invocation.positionals[0] ?? flagValue(invocation, "--direction") ?? "").toLowerCase();
      shape.direction = DIRECTIONS.has(direction) ? direction : null;
      shape.target = parsed.hitName ?? elementFlag;
      return shape;
    }
    case "app": {
      let target: string | null = verbKey === "launch" && invocation.domain === "app-control"
        ? flagValue(invocation, "--command", "--app") ?? invocation.positionals.join(" ")
        : invocation.positionals[0] ?? flagValue(invocation, "--app", "--bundle-id") ?? appName;
      if (invocation.domain === "apple" && target && /^[\w-]+(\.[\w-]+){2,}$/.test(target)) target = appNameFromBundleId(target);
      shape.target = target;
      return shape;
    }
    case "url": {
      const url = invocation.positionals[0] ?? flagValue(invocation, "--url") ?? parsed.openedUrl;
      return { target: urlHost(url) ?? (url ? clip(url, 48) : null), quoted: false, direction: null, point: false };
    }
    case "caption":
      shape.target = flagValue(invocation, "--caption", "--title", "--description");
      return shape;
    case "file": {
      const file = flagValue(invocation, "--file") ?? invocation.positionals[0] ?? null;
      shape.target = file ? file.split(/[\\/]/).pop() ?? file : null;
      return shape;
    }
    case "page":
      shape.target = invocation.domain === "browser"
        ? parsed.values.get("title") ?? readString(readRecord(parsed.json?.observation)?.title) ?? null
        : null;
      return shape;
    case "none":
      return shape;
  }
}

function buildSummary(invocations: ParsedInvocation[], output: string, input: ComputerUseCommandInput): ComputerUseActionSummary | null {
  const described = invocations
    .map((invocation) => ({ invocation, verb: resolveVerb(invocation) }))
    .filter((entry): entry is { invocation: ParsedInvocation; verb: { key: string; spec: VerbSpec } } => entry.verb !== null);
  // Two acting commands in one call: whose output is whose is a guess.
  const acting = described.filter((entry) => !entry.verb.spec.passive);
  if (acting.length > 1 || described.length === 0) return null;
  const chosen = acting[0] ?? (described.length === 1 ? described[0]! : null);
  if (!chosen) return null;
  const { invocation, verb } = chosen;
  const { spec } = verb;
  const parsed = parseOutput(output);
  const json = parsed.json;
  const domain = invocation.domain;

  /* Outcome. */
  const exitFailed = typeof input.exitCode === "number" && input.exitCode !== 0;
  const outputFailed = parsed.okFalse || (parsed.errorMessage !== null && parsed.hitName === null && parsed.effect === null);
  let outcome: ComputerUseActionOutcome;
  if (input.status === "failed" || input.status === "interrupted" || exitFailed || outputFailed) outcome = "failed";
  else if (input.status === "running" && !parsed.effect) outcome = "running";
  else if (parsed.effect === "observed") outcome = "observed";
  else if (parsed.effect === "unconfirmed" || parsed.effect === "waiting") outcome = "unconfirmed";
  else outcome = "not_checked";
  const failureReason = outcome === "failed"
    ? parsed.errorMessage
      ?? (parsed.okFalse ? parsed.values.get("message") ?? readString(json?.message) : null)
      ?? (input.status === "interrupted" ? "Stopped before it finished." : null)
    : null;
  const reason = outcome === "failed"
    ? failureReason
    : outcome === "unconfirmed" ? parsed.effectReason : null;

  /* Surface and browser. */
  let surface = surfaceFor(domain);
  let browserName: string | null = null;
  let hostLabel: string | null = null;
  if (domain === "browser") {
    const user = readUserBrowser(parsed);
    if (user || verb.key === "attach") {
      surface = "user_browser";
      browserName = user?.browserName ?? null;
      hostLabel = user?.hostLabel ?? null;
    }
  }

  /* App name. */
  let appName: string | null = null;
  if (domain === "screen") {
    const windowId = flagValue(invocation, "--window", "--window-id");
    const fromWindow = windowId ? parsed.windows.find((window) => window.id === windowId)?.app ?? null : null;
    const distinctApps = [...new Set(parsed.windows.map((window) => window.app))];
    appName = flagValue(invocation, "--app")
      ?? fromWindow
      ?? parsed.values.get("app")
      ?? (verb.key === "open" ? invocation.positionals[0] ?? null : null)
      ?? (distinctApps.length === 1 ? distinctApps[0]! : null)
      ?? readString(json?.appName);
  } else if (domain === "app-control") {
    appName = parsed.values.get("title")
      ?? readString(readRecord(json?.observation)?.title)
      ?? readString(json?.title)
      ?? null;
  } else if (domain === "apple") {
    appName = parsed.values.get("app name")
      ?? readString(json?.appName)
      ?? appNameFromBundleId(flagValue(invocation, "--bundle-id", "--bundle") ?? parsed.values.get("active app") ?? null);
  } else if (surface === "user_browser" && browserName) {
    appName = browserName;
  }
  if (appName) appName = clip(appName, 48);

  /* Target and the words around it. */
  const device = domain === "apple" ? readAppleDevice(
      flagValue(invocation, "--device-type", "--device-name", "--simulator"),
      flagValue(invocation, "--runtime"),
      output,
    ) : null;
  // `apple start` names the device it booted.
  const shape: TargetShape = verb.key === "start" && domain === "apple"
    ? { target: device?.name ?? null, quoted: false, direction: null, point: false }
    : describeTarget(spec, verb.key, invocation, parsed, appName);
  let target = shape.target ? clip(shape.target) : null;
  let targetQuoted = shape.quoted;
  const at = shape.point ? " at" : "";
  // "Scrolled down in “Notes list”", or plain "Scrolled down".
  const toward = shape.direction ? (target ? ` ${shape.direction} in` : ` ${shape.direction}`) : "";

  /* Where, when the surface does not already say it. */
  let place: ComputerUseActionPlace | null = null;
  if (surface === "user_browser") {
    place = null;
  } else if (domain === "browser") {
    const host = urlHost(parsed.values.get("url") ?? readString(readRecord(json?.observation)?.url) ?? readString(json?.url) ?? parsed.openedUrl);
    if (host && host !== target) place = { preposition: "on", label: host, kind: "site" };
  } else if (domain === "screen" || domain === "app-control" || domain === "apple") {
    // `screen open` happens on the lane screen, which "using …" names.
    const opensApp = domain === "screen" && verb.key === "open";
    if (!opensApp && appName && appName !== target) place = { preposition: "in", label: appName, kind: "app" };
  }
  // "Scrolled down in “Notes list”" already says where.
  if (shape.direction && target) place = null;
  // Connected to your browser: the browser is the object.
  if (verb.key === "attach") {
    target = `your ${browserName ?? "browser"}`;
    targetQuoted = false;
  }
  // A look at the whole screen names the app, not a page: "Looked at TextEdit".
  if ((verb.key === "observe" || verb.key === "snapshot") && !target && appName && domain !== "browser") {
    target = appName;
    targetQuoted = false;
    place = null;
  }

  return {
    surface,
    domain,
    verb: verb.key,
    past: `${spec.past}${at}${toward}`,
    progressive: `${spec.progressive}${at}${toward}`,
    infinitive: `${spec.infinitive}${at}${toward}`,
    target,
    targetQuoted,
    place,
    appName,
    browserName,
    hostLabel,
    device,
    screenProduct: /^windows/.test(invocation.alias) ? "windows" : /^(mac|desk)/.test(invocation.alias) ? "mac" : null,
    outcome,
    reason: reason ? clip(reason, 240) : null,
    proof: verb.key.startsWith("proof")
      ? { caption: shape.target ? clip(shape.target) : null, prNumber: parsed.prNumber ?? numberFlag(invocation, "--pr") }
      : null,
  };
}

function numberFlag(invocation: ParsedInvocation, name: string): number | null {
  const value = flagValue(invocation, name);
  if (!value) return null;
  const match = /(\d+)\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}
