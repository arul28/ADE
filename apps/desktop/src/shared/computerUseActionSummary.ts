/**
 * What a computer-use shell command did, in words a reader can follow.
 *
 * Agents drive screens through the ADE CLI from their own shell tool
 * (`ade screen click …`, `ade browser fill …`, `"$ADE_CLI_PATH" apple tap …`).
 * The transcript used to show those as generic shell rows. This module reads
 * the command and its output and returns a small structured summary — the verb,
 * the element actually hit, the app, the surface, and whether the screen
 * changed — that the desktop/web transcript and the iOS app (which ports this
 * file to Swift in `WorkComputerUseSummary.swift`) draw as an action row.
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
 *   - `--json` (the default when `--text` is absent): the result object.
 */

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
  /** Where it happened: "in Xcode", "on localhost:5173", "in your Chrome". */
  where: string | null;
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
  target: "element" | "typed" | "key" | "app" | "url" | "caption" | "direction" | "file" | "command" | "page" | "none";
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

/* ── Output parsing ──────────────────────────────────────────────────────── */

type ParsedOutput = {
  hitName: string | null;
  hitNone: boolean;
  effect: "observed" | "unconfirmed" | "not_checked" | "waiting" | null;
  effectReason: string | null;
  values: Map<string, string>;
  windows: Array<{ id: string; app: string; title: string | null }>;
  errorMessage: string | null;
  okFalse: boolean;
  openedUrl: string | null;
  json: Record<string, unknown> | null;
  attached: { line: string } | null;
  prNumber: number | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

/** A JSON-quoted name right after the role: `AXButton "Sign in" (obs-1:e:3)`. */
function readQuotedName(text: string): string | null {
  const start = text.indexOf("\"");
  if (start < 0) return null;
  let index = start + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\"") break;
    index += 1;
  }
  const literal = text.slice(start, Math.min(index + 1, text.length));
  try {
    const parsed = JSON.parse(literal);
    return typeof parsed === "string" && parsed.trim().length ? parsed.trim() : null;
  } catch {
    const raw = text.slice(start + 1, index).trim();
    return raw.length ? raw : null;
  }
}

function elementName(element: Record<string, unknown> | null): string | null {
  if (!element) return null;
  for (const key of ["title", "label", "text", "name", "value", "placeholder", "identifier", "ariaLabel"]) {
    const value = readString(element[key]);
    if (value) return value;
  }
  return null;
}

function tryParseJson(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  const start = trimmed.indexOf("{");
  if (start < 0 || start > 200) return null;
  const end = trimmed.lastIndexOf("}");
  if (end <= start) return null;
  try {
    const parsed = readRecord(JSON.parse(trimmed.slice(start, end + 1)));
    if (!parsed) return null;
    // An action envelope (`{ domain, action, result }`) wraps the result.
    const inner = typeof parsed.domain === "string" ? readRecord(parsed.result) : null;
    return inner ?? parsed;
  } catch {
    return null;
  }
}

const KEY_VALUE_LINE = /^([a-z][a-z0-9 ]{0,30}?)\s{2,}(\S.*)$/;
const WINDOW_LINE = /^\s+#(\d+)\s+(.+?)(?:\s+—\s+(.*))?$/;

function parseOutput(output: string): ParsedOutput {
  const parsed: ParsedOutput = {
    hitName: null,
    hitNone: false,
    effect: null,
    effectReason: null,
    values: new Map(),
    windows: [],
    errorMessage: null,
    okFalse: false,
    openedUrl: null,
    json: null,
    attached: null,
    prNumber: null,
  };
  if (!output) return parsed;
  const lines = output.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("hit:") && parsed.hitName === null && !parsed.hitNone) {
      const rest = trimmed.slice(4).trim();
      if (/^no element/i.test(rest)) parsed.hitNone = true;
      else parsed.hitName = readQuotedName(rest);
      continue;
    }
    if (lower.startsWith("effect:") && parsed.effect === null) {
      const rest = trimmed.slice(7).trim();
      const [head, ...tail] = rest.split(/\s+—\s+|\s+-\s+/);
      const status = (head ?? "").toLowerCase();
      parsed.effect = status.startsWith("observed")
        ? "observed"
        : status.startsWith("unconfirmed")
          ? "unconfirmed"
          : status.startsWith("waiting")
            ? "waiting"
            : status.startsWith("not checked") || status.startsWith("not_checked")
              ? "not_checked"
              : null;
      parsed.effectReason = tail.join(" — ").trim() || null;
      continue;
    }
    if (/^ade:\s/.test(trimmed) && parsed.errorMessage === null) {
      parsed.errorMessage = trimmed.slice(4).trim().replace(/^[A-Z][A-Z0-9_]{3,}:\s*/, "") || null;
      continue;
    }
    if (/^attached:\s*/i.test(trimmed) && !parsed.attached) {
      parsed.attached = { line: trimmed.replace(/^attached:\s*/i, "") };
      continue;
    }
    const opened = /^(?:opened|navigated):\s+\S+\s+(\S+)/i.exec(trimmed);
    if (opened && !parsed.openedUrl) {
      parsed.openedUrl = opened[1]!;
      continue;
    }
    const pr = /\/pull\/(\d+)\b/.exec(trimmed);
    if (pr && parsed.prNumber === null && /^posted\b/i.test(trimmed)) parsed.prNumber = Number(pr[1]);
    const windowLine = WINDOW_LINE.exec(line);
    if (windowLine) {
      parsed.windows.push({ id: windowLine[1]!, app: windowLine[2]!.trim(), title: windowLine[3]?.trim() || null });
      continue;
    }
    const kv = KEY_VALUE_LINE.exec(trimmed);
    if (kv && !parsed.values.has(kv[1]!)) parsed.values.set(kv[1]!, kv[2]!.trim());
  }
  if (parsed.values.get("ok") === "false") parsed.okFalse = true;
  const json = tryParseJson(output);
  if (json) {
    parsed.json = json;
    const match = readRecord(json.match);
    const resolved = readRecord(json.resolved) ?? readRecord(json.matched) ?? readRecord(match?.element);
    if (parsed.hitName === null) parsed.hitName = elementName(resolved);
    const effect = readRecord(json.effect);
    const status = readString(effect?.status);
    if (parsed.effect === null && status) {
      parsed.effect = status === "observed" || status === "unconfirmed" || status === "not_checked"
        ? status
        : status === "waiting_for_approval" ? "waiting" : null;
      parsed.effectReason = readString(effect?.reason);
    }
    if (json.ok === false) parsed.okFalse = true;
    const error = json.error;
    if (parsed.errorMessage === null) {
      parsed.errorMessage = readString(error) ?? readString(readRecord(error)?.message) ?? null;
    }
    if (json.attached === true || readString(json.browserKind) === "user" || readRecord(json.attached)) {
      parsed.attached = parsed.attached ?? { line: readString(readRecord(json.attached)?.label) ?? "" };
    }
  }
  return parsed;
}

/* ── Field readers ───────────────────────────────────────────────────────── */

function flagValue(invocation: ParsedInvocation, ...names: string[]): string | null {
  for (const name of names) {
    const value = invocation.flags.get(name);
    if (typeof value === "string" && value.trim().length) return value.trim();
  }
  return null;
}

function clip(value: string, max = 60): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
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

const USER_BROWSER_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/\bchrome\b/i, "Chrome"],
  [/\bedge\b/i, "Edge"],
  [/\bbrave\b/i, "Brave"],
  [/\barc\b/i, "Arc"],
  [/\bhelium\b/i, "Helium"],
  [/\bsafari\b/i, "Safari"],
  [/\bfirefox\b/i, "Firefox"],
  [/\bvivaldi\b/i, "Vivaldi"],
  [/\bopera\b/i, "Opera"],
  [/\bchromium\b/i, "Chromium"],
  [/\bzen\b/i, "Zen"],
];

function readUserBrowser(parsed: ParsedOutput, output: string): { browserName: string | null; hostLabel: string | null } | null {
  // `ade browser attach` prints `attached: Google Chrome on Arul's Mac Studio, tab "…" (…)`;
  // every command made while attached leads with `target: your Google Chrome on Arul's Mac Studio`.
  const targetMatch = /^\s*target:\s*your\s+(.+?)\s+on\s+(.+?)\s*$/im.exec(output);
  const attachedMatch = parsed.attached ? /^(.+?)\s+on\s+(.+?)(?:,\s*tab\b.*)?$/i.exec(parsed.attached.line) : null;
  const yourMatch = /\byour (chrome|edge|brave|arc|helium|safari|firefox|vivaldi|opera|chromium|zen|browser)\b/i.exec(output);
  if (!parsed.attached && !targetMatch && !yourMatch) return null;
  const source = targetMatch?.[1] ?? attachedMatch?.[1] ?? parsed.attached?.line ?? yourMatch?.[0] ?? "";
  const browserName = USER_BROWSER_NAMES.find(([pattern]) => pattern.test(source))?.[1]
    ?? USER_BROWSER_NAMES.find(([pattern]) => pattern.test(parsed.values.get("browser") ?? ""))?.[1]
    ?? null;
  const hostFromLine = targetMatch?.[2] ?? attachedMatch?.[2] ?? null;
  const hostLabel = hostFromLine
    ?? parsed.values.get("machine")
    ?? parsed.values.get("host")
    ?? readString(parsed.json?.machine)
    ?? null;
  return { browserName, hostLabel: hostLabel ? clip(hostLabel, 40) : null };
}

const APPLE_DEVICE_PATTERN = /\b(iPhone|iPad|Apple Watch|Apple TV|Apple Vision Pro)\b((?:[ ](?!(?:iOS|iPadOS|watchOS|tvOS|visionOS|xrOS)\b)[A-Za-z0-9-]+){0,4})/;
const APPLE_OS_PATTERN = /\b(iOS|iPadOS|watchOS|tvOS|visionOS|xrOS)[ -](\d+(?:[.-]\d+)?)/;

function readAppleDevice(invocation: ParsedInvocation, output: string): { name: string | null; os: string | null } | null {
  const sources = [
    flagValue(invocation, "--device-type", "--device-name", "--simulator"),
    output,
  ]
    .filter((value): value is string => Boolean(value))
    // Simulator type ids spell the name with hyphens: `SimDeviceType.iPhone-16-Pro`.
    .map((value) => value.replace(/\b(iPhone|iPad)((?:-[A-Za-z0-9]+)+)/g, (match) => match.replace(/-/g, " ")));
  let name: string | null = null;
  let os: string | null = null;
  for (const source of sources) {
    if (!name) {
      const match = APPLE_DEVICE_PATTERN.exec(source);
      if (match) name = `${match[1]}${match[2] ?? ""}`.trim();
    }
    if (!os) {
      const match = APPLE_OS_PATTERN.exec(source);
      if (match) os = `${match[1]} ${match[2]!.replace("-", ".")}`;
    }
  }
  const runtime = flagValue(invocation, "--runtime");
  if (!os && runtime) {
    const match = APPLE_OS_PATTERN.exec(runtime);
    if (match) os = `${match[1]} ${match[2]!.replace("-", ".")}`;
  }
  return name || os ? { name, os } : null;
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

function commandText(command: ComputerUseCommandInput["command"]): string | null {
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

const SUMMARY_CACHE_LIMIT = 2000;
const summaryCache = new Map<string, ComputerUseActionSummary | null>();

/**
 * Summarize one shell command, or null when it is not an ADE computer-use
 * action this module can describe with confidence.
 */
export function summarizeComputerUseCommand(input: ComputerUseCommandInput): ComputerUseActionSummary | null {
  const source = commandText(input.command);
  if (!source || !/ade|ADE_CLI_PATH/i.test(source)) return null;
  const output = typeof input.output === "string" ? input.output : "";
  const cacheKey = `${input.status}\u0000${input.exitCode ?? ""}\u0000${source}\u0000${output.length}\u0000${output.slice(0, 2048)}`;
  const cached = summaryCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let summary: ComputerUseActionSummary | null = null;
  try {
    summary = buildSummary(source, output, input);
  } catch {
    summary = null;
  }
  if (summaryCache.size >= SUMMARY_CACHE_LIMIT) summaryCache.clear();
  summaryCache.set(cacheKey, summary);
  return summary;
}

function buildSummary(source: string, output: string, input: ComputerUseCommandInput): ComputerUseActionSummary | null {
  const invocations = findInvocations(source);
  if (!invocations || invocations.length === 0) return null;
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
    const user = readUserBrowser(parsed, output);
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

  /* Target. */
  let target: string | null = null;
  let targetQuoted = true;
  const elementFlag = flagValue(invocation, "--label", "--text-match", "--text", "--name", "--title", "--test-id", "--element", "--placeholder", "--role-name");
  switch (spec.target) {
    case "element":
      target = parsed.hitName
        ?? elementFlag
        ?? (verb.key === "wait" || verb.key === "wait-for-element" ? flagValue(invocation, "--selector", "--window-title") : null)
        ?? flagValue(invocation, "--selector");
      if (!target && (verb.key === "fill" || verb.key === "select" || verb.key === "select-option")) {
        target = flagValue(invocation, "--value", "--option") ?? invocation.positionals.at(-1) ?? null;
      }
      if (!target) {
        const x = flagValue(invocation, "--x");
        const y = flagValue(invocation, "--y");
        if (x && y && /^-?\d+(\.\d+)?$/.test(x) && /^-?\d+(\.\d+)?$/.test(y)) {
          // "Clicked at 412, 300": a point, not a name.
          return finish(null, `${Math.round(Number(x))}, ${Math.round(Number(y))}`);
        }
      }
      break;
    case "typed":
      target = invocation.positionals.join(" ") || flagValue(invocation, "--value", "--string");
      break;
    case "key":
      target = invocation.positionals[0] ?? flagValue(invocation, "--key", "--button");
      break;
    case "direction": {
      const direction = (invocation.positionals[0] ?? flagValue(invocation, "--direction") ?? "").toLowerCase();
      target = parsed.hitName ?? elementFlag;
      return finish(direction && ["up", "down", "left", "right"].includes(direction) ? direction : null);
    }
    case "app":
      target = verb.key === "launch" && domain === "app-control"
        ? flagValue(invocation, "--command", "--app") ?? invocation.positionals.join(" ") ?? null
        : invocation.positionals[0] ?? flagValue(invocation, "--app", "--bundle-id") ?? appName;
      if (domain === "apple" && target && /^[\w-]+(\.[\w-]+){2,}$/.test(target)) target = appNameFromBundleId(target);
      break;
    case "url": {
      const url = invocation.positionals[0] ?? flagValue(invocation, "--url") ?? parsed.openedUrl;
      target = urlHost(url) ?? (url ? clip(url, 48) : null);
      targetQuoted = false;
      break;
    }
    case "caption":
      target = flagValue(invocation, "--caption", "--title", "--description");
      break;
    case "file": {
      const file = flagValue(invocation, "--file") ?? invocation.positionals[0] ?? null;
      target = file ? file.split(/[\\/]/).pop() ?? file : null;
      break;
    }
    case "page":
      target = domain === "browser"
        ? parsed.values.get("title") ?? readString(readRecord(json?.observation)?.title) ?? null
        : null;
      break;
    case "command":
    case "none":
      target = null;
      break;
  }
  return finish(null);

  function finish(direction: string | null, point: string | null = null): ComputerUseActionSummary {
    let past = spec.past;
    let progressive = spec.progressive;
    let infinitive = spec.infinitive;
    if (point) {
      target = point;
      targetQuoted = false;
      past += " at";
      progressive += " at";
      infinitive += " at";
    }
    if (verb.key === "start" && domain === "apple") {
      target = readAppleDevice(invocation, output)?.name ?? null;
      targetQuoted = false;
    }
    const cleanTarget = target ? clip(target) : null;
    if (direction) {
      // "Scrolled down in “Notes list”", or plain "Scrolled down".
      const suffix = cleanTarget ? ` ${direction} in` : ` ${direction}`;
      past += suffix;
      progressive += suffix;
      infinitive += suffix;
    }

    /* Where. */
    let where: string | null = null;
    if (surface === "user_browser") {
      where = verb.key === "attach" ? null : `in your ${browserName ?? "browser"}`;
    } else if (domain === "browser") {
      const host = urlHost(parsed.values.get("url") ?? readString(readRecord(json?.observation)?.url) ?? readString(json?.url) ?? parsed.openedUrl);
      if (host && host !== cleanTarget) where = `on ${host}`;
    } else if (domain === "screen") {
      if (verb.key === "open") where = "on the lane screen";
      else if (appName && appName !== cleanTarget) where = `in ${appName}`;
    } else if ((domain === "app-control" || domain === "apple") && appName && appName !== cleanTarget) {
      where = `in ${appName}`;
    }
    // "Scrolled down in “Notes list”" already says where.
    if (direction && cleanTarget) where = null;
    /* Connected to your browser: the browser is the object. */
    let finalTarget = cleanTarget;
    let finalQuoted = targetQuoted;
    if (verb.key === "attach") {
      finalTarget = `your ${browserName ?? "browser"}`;
      finalQuoted = false;
    }
    /* A look at the whole screen names the app, not a page: "Looked at TextEdit". */
    if ((verb.key === "observe" || verb.key === "snapshot") && !finalTarget && appName && domain !== "browser") {
      finalTarget = appName;
      finalQuoted = false;
      where = null;
    }

    const proof = verb.key.startsWith("proof")
      ? {
          caption: cleanTarget,
          prNumber: parsed.prNumber ?? numberFlag(invocation, "--pr"),
        }
      : null;

    return {
      surface,
      domain,
      verb: verb.key,
      past,
      progressive,
      infinitive,
      target: finalTarget,
      targetQuoted: finalQuoted,
      where,
      appName,
      browserName,
      hostLabel,
      device: domain === "apple" ? readAppleDevice(invocation, output) : null,
      screenProduct: /^windows/.test(invocation.alias) ? "windows" : /^(mac|desk)/.test(invocation.alias) ? "mac" : null,
      outcome,
      reason: reason ? clip(reason, 240) : null,
      proof,
    };
  }
}

function numberFlag(invocation: ParsedInvocation, name: string): number | null {
  const value = flagValue(invocation, name);
  if (!value) return null;
  const match = /(\d+)\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

/* ── Presentation helpers (shared with iOS) ─────────────────────────────── */

export type ComputerUseSentence = {
  /** "Clicked", "Clicking", "Couldn't click". */
  lead: string;
  target: string | null;
  targetQuoted: boolean;
  /** Muted tail: "in Xcode", "on localhost:5173 · on PR #12". */
  trailing: string | null;
};

/** The sentence for one action: what it did, to what, and where. */
export function computerUseActionSentence(summary: ComputerUseActionSummary): ComputerUseSentence {
  const lead = summary.outcome === "running"
    ? summary.progressive
    : summary.outcome === "failed"
      ? `Couldn't ${summary.infinitive}`
      : summary.past;
  const tails: string[] = [];
  if (summary.where) tails.push(summary.where);
  let trailing = tails.length ? tails.join(" ") : null;
  if (summary.proof?.prNumber != null) {
    trailing = [trailing, `· on PR #${summary.proof.prNumber}`].filter(Boolean).join(" ");
  }
  return { lead, target: summary.target, targetQuoted: summary.targetQuoted, trailing };
}

/** The sentence as plain text, for titles, labels, and accessibility. */
export function computerUseActionText(summary: ComputerUseActionSummary): string {
  const parts = computerUseActionParts(summary);
  const target = parts.target ? (parts.targetQuoted ? `“${parts.target}”` : parts.target) : null;
  const place = parts.place ? `${parts.place.preposition} ${parts.place.label}` : null;
  const using = parts.using ? `using ${parts.using.label}` : null;
  const text = [parts.lead, target, place, using, parts.suffix].filter(Boolean).join(" ");
  return summary.outcome === "running" ? `${text}…` : text;
}

/** Where the action happened: an app ("in TextEdit") or a site ("on localhost:5173"). */
export type ComputerUseActionPlace = {
  preposition: "in" | "on";
  label: string;
  kind: "app" | "site" | "other";
};

/**
 * One action as one line: "Clicked “Save” in TextEdit using Mac Desktop".
 * Each part carries what a renderer needs to draw its icon.
 */
export type ComputerUseActionParts = {
  lead: string;
  target: string | null;
  targetQuoted: boolean;
  place: ComputerUseActionPlace | null;
  using: { label: string; glyph: ComputerUseSurfaceGlyph; warning: boolean } | null;
  /** "· on PR #12". */
  suffix: string | null;
};

export function computerUseActionParts(summary: ComputerUseActionSummary): ComputerUseActionParts {
  const sentence = computerUseActionSentence(summary);
  let place: ComputerUseActionPlace | null = null;
  const where = summary.where?.trim() ?? "";
  const placeMatch = /^(in|on)\s+(.+)$/.exec(where);
  // "on the lane screen" and "in your Chrome" say what the "using" part says.
  if (placeMatch && summary.surface !== "user_browser" && where !== "on the lane screen") {
    const preposition = placeMatch[1] as "in" | "on";
    const label = placeMatch[2]!;
    const kind = label === summary.appName ? "app" : preposition === "on" ? "site" : "other";
    place = { preposition, label, kind };
  }
  const surface = computerUseSurfaceLabel(summary);
  // "Connected to your Chrome on studio-mac": the browser is already the object.
  if (summary.verb === "attach") {
    return {
      lead: sentence.lead,
      target: sentence.target,
      targetQuoted: sentence.targetQuoted,
      place: summary.hostLabel ? { preposition: "on", label: summary.hostLabel, kind: "other" } : null,
      using: null,
      suffix: null,
    };
  }
  return {
    lead: sentence.lead,
    target: sentence.target,
    targetQuoted: sentence.targetQuoted,
    place,
    using: surface,
    suffix: summary.proof?.prNumber != null ? `· on PR #${summary.proof.prNumber}` : null,
  };
}

export type ComputerUseSurfaceGlyph = "screen" | "app" | "globe" | "user" | "apple" | "proof";

/** The "using …" part of a row: which surface, in whose hands. */
export function computerUseSurfaceLabel(summary: ComputerUseActionSummary): {
  label: string;
  glyph: ComputerUseSurfaceGlyph;
  /** The user's own browser: amber, because the agent acted outside its lane. */
  warning: boolean;
} {
  switch (summary.surface) {
    case "lane_screen":
      return {
        label: summary.screenProduct === "windows"
          ? "Windows Desktop"
          : summary.screenProduct === "mac" ? "Mac Desktop" : "the lane screen",
        glyph: "screen",
        warning: false,
      };
    case "app_control":
      return { label: "App Control", glyph: "app", warning: false };
    case "ade_browser":
      return { label: "ADE browser", glyph: "globe", warning: false };
    case "user_browser": {
      const browser = `your ${summary.browserName ?? "browser"}`;
      return {
        label: summary.hostLabel ? `${browser} on ${summary.hostLabel}` : browser,
        glyph: "user",
        warning: true,
      };
    }
    case "apple_device":
      return { label: summary.device?.name || "the simulator", glyph: "apple", warning: false };
    case "proof":
      return { label: "ADE proof", glyph: "proof", warning: false };
  }
}

/** The one-line note under a full row, when there is something to say. */
export function computerUseOutcomeNote(summary: ComputerUseActionSummary): { text: string; tone: "danger" | "warning" } | null {
  if (summary.outcome === "failed") {
    return summary.reason ? { text: summary.reason, tone: "danger" } : null;
  }
  if (summary.outcome === "unconfirmed") {
    return { text: "Sent, but no change seen yet", tone: "warning" };
  }
  return null;
}

/** Status dot of a compact row. */
export function computerUseDotState(summary: ComputerUseActionSummary): "neutral" | "warn" | "crit" {
  if (summary.outcome === "failed") return "crit";
  if (summary.outcome === "unconfirmed") return "warn";
  return "neutral";
}

export type ComputerUseRunItem<T> =
  | { kind: "action"; action: T; summary: ComputerUseActionSummary }
  | { kind: "app_fold"; appName: string; actions: Array<{ action: T; summary: ComputerUseActionSummary }> };

/**
 * Lay out one run of actions: every earlier action as a compact line, with
 * consecutive confirmed actions in the same app folded into one
 * "Notes · 4 actions" line, and the latest action drawn in full. A failed or
 * unconfirmed action never folds: it is the line a reader must see.
 *
 * Apple actions that named no device borrow the last device named earlier in
 * the run (the device is usually printed once, by `apple start`).
 */
export function layoutComputerUseRun<T>(
  actions: ReadonlyArray<{ action: T; summary: ComputerUseActionSummary }>,
): { earlier: Array<ComputerUseRunItem<T>>; latest: { action: T; summary: ComputerUseActionSummary } | null } {
  if (actions.length === 0) return { earlier: [], latest: null };
  let lastDevice: ComputerUseActionSummary["device"] = null;
  const withDevices = actions.map((entry) => {
    const { summary } = entry;
    if (summary.surface !== "apple_device") return entry;
    if (summary.device?.name) {
      lastDevice = summary.device;
      return entry;
    }
    if (!lastDevice) return entry;
    return { ...entry, summary: { ...summary, device: { name: lastDevice.name, os: summary.device?.os ?? lastDevice.os } } };
  });
  const latest = withDevices[withDevices.length - 1]!;
  const earlier: Array<ComputerUseRunItem<T>> = [];
  const foldable = (summary: ComputerUseActionSummary) =>
    Boolean(summary.appName) && summary.outcome !== "failed" && summary.outcome !== "unconfirmed";
  let index = 0;
  const compact = withDevices.slice(0, -1);
  while (index < compact.length) {
    const first = compact[index]!;
    if (!foldable(first.summary)) {
      earlier.push({ kind: "action", ...first });
      index += 1;
      continue;
    }
    const key = first.summary.appName!.toLowerCase();
    let end = index + 1;
    while (end < compact.length && foldable(compact[end]!.summary) && compact[end]!.summary.appName!.toLowerCase() === key) end += 1;
    if (end - index >= 2) {
      earlier.push({ kind: "app_fold", appName: first.summary.appName!, actions: compact.slice(index, end) });
    } else {
      earlier.push({ kind: "action", ...first });
    }
    index = end;
  }
  return { earlier, latest };
}
