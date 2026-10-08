/**
 * The output half of `computerUseActionSummary.ts`: what a computer-use
 * command printed — the element it hit, the effect it saw, `renderKeyValues`
 * rows, the Mac Desktop windows footer, `ade:` errors, the user's own browser,
 * an Apple device — read from its text or its `--json` result. The iOS port
 * lives in `apps/ios/ADE/Views/Work/WorkComputerUseSummary.swift`; keep them in
 * step.
 *
 * Pure and platform-neutral, and it never throws.
 */

import {
  USER_BROWSER_ATTACHED_PREFIX,
  USER_BROWSER_IDS,
  USER_BROWSER_SHORT_NAMES,
  USER_BROWSER_TARGET_PREFIX,
} from "./userBrowserLabels";
import { readRecord } from "./readRecord";

/* ── Output parsing ──────────────────────────────────────────────────────── */

export type ParsedOutput = {
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
  /** `attached: …` (or the JSON attach result): "Google Chrome on studio-mac, tab …"; "" when only the flag was seen. */
  attachedLine: string | null;
  /** `target: …` (or JSON `userBrowserTarget`): "your Google Chrome on studio-mac". */
  userBrowserTarget: string | null;
  prNumber: number | null;
};

export function readString(value: unknown): string | null {
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

export function parseOutput(output: string): ParsedOutput {
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
    attachedLine: null,
    userBrowserTarget: null,
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
    if (lower.startsWith(USER_BROWSER_ATTACHED_PREFIX) && parsed.attachedLine === null) {
      parsed.attachedLine = trimmed.slice(USER_BROWSER_ATTACHED_PREFIX.length).trim();
      continue;
    }
    if (lower.startsWith(USER_BROWSER_TARGET_PREFIX) && parsed.userBrowserTarget === null) {
      parsed.userBrowserTarget = trimmed.slice(USER_BROWSER_TARGET_PREFIX.length).trim();
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
      parsed.attachedLine ??= readString(readRecord(json.attached)?.label) ?? "";
    }
    parsed.userBrowserTarget ??= readString(json.userBrowserTarget);
  }
  return parsed;
}

/* ── Readers ─────────────────────────────────────────────────────────────── */

export function clip(value: string, max = 60): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** "Google Chrome" → "Chrome": the short name of the first browser the text names. */
const USER_BROWSER_NAME_PATTERNS = USER_BROWSER_IDS.map((id) => [new RegExp(`\\b${id}\\b`, "i"), USER_BROWSER_SHORT_NAMES[id]] as const);

function userBrowserShortName(text: string | null | undefined): string | null {
  if (!text) return null;
  return USER_BROWSER_NAME_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

const USER_BROWSER_TARGET_LINE = /^your\s+(.+?)\s+on\s+(.+?)$/i;
const USER_BROWSER_ATTACHED_LINE = /^(.+?)\s+on\s+(.+?)(?:,\s*tab\b.*)?$/i;

/**
 * The user's own browser, when the output says the command reached it: an
 * `attached:` line, a `target: your … on …` line, or their JSON fields. Page
 * text that happens to say "your browser" is not a sign.
 */
export function readUserBrowser(parsed: ParsedOutput): { browserName: string | null; hostLabel: string | null } | null {
  const target = parsed.userBrowserTarget ? USER_BROWSER_TARGET_LINE.exec(parsed.userBrowserTarget) : null;
  if (parsed.attachedLine === null && !target) return null;
  const attached = parsed.attachedLine ? USER_BROWSER_ATTACHED_LINE.exec(parsed.attachedLine) : null;
  const json = parsed.json;
  const browserName = userBrowserShortName(target?.[1] ?? attached?.[1] ?? (parsed.attachedLine || null))
    ?? userBrowserShortName(parsed.values.get("browser"))
    ?? userBrowserShortName(readString(json?.browserLabel))
    ?? userBrowserShortName(readString(json?.browser));
  const hostLabel = target?.[2]
    ?? attached?.[2]
    ?? parsed.values.get("machine")
    ?? parsed.values.get("host")
    ?? readString(json?.machine)
    ?? null;
  return { browserName, hostLabel: hostLabel ? clip(hostLabel, 40) : null };
}

const APPLE_DEVICE_PATTERN = /\b(iPhone|iPad|Apple Watch|Apple TV|Apple Vision Pro)\b((?:[ ](?!(?:iOS|iPadOS|watchOS|tvOS|visionOS|xrOS)\b)[A-Za-z0-9-]+){0,4})/;
const APPLE_OS_PATTERN = /\b(iOS|iPadOS|watchOS|tvOS|visionOS|xrOS)[ -](\d+(?:[.-]\d+)?)/;

/**
 * The Apple device and OS a command names: `deviceFlag` is its
 * `--device-type`/`--device-name`/`--simulator` value, `runtime` its
 * `--runtime`.
 */
export function readAppleDevice(
  deviceFlag: string | null,
  runtime: string | null,
  output: string,
): { name: string | null; os: string | null } | null {
  const sources = [deviceFlag, output]
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
  if (!os && runtime) {
    const match = APPLE_OS_PATTERN.exec(runtime);
    if (match) os = `${match[1]} ${match[2]!.replace("-", ".")}`;
  }
  return name || os ? { name, os } : null;
}
