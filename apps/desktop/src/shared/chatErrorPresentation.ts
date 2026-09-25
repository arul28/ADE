import { providerDisplayLabel } from "./pendingInputLabels";

/**
 * Host-emitted failed-turn copy. Clients (desktop, iOS, hosted web, CLI/TUI)
 * render this instead of inventing "Error" / "Unknown" titles or dumping the
 * raw SDK sentence as the card body.
 *
 * `technicalDetail` is the only place raw SDK/host text is allowed. Never copy
 * `body` into a bullet list — that duplication is what made the phone card
 * unreadable.
 */
export type ChatErrorPresentation = {
  title: string;
  body: string;
  nextAction?: string;
  technicalDetail?: string;
};

export type ChatErrorPresentationKind =
  | "auth"
  | "rate_limit"
  | "network"
  | "busy"
  | "not_found"
  | "configuration"
  | "unknown";

const TITLE_COULDNT_START = "Couldn't start this turn";

/** Matches the ACP host's capture cap, so a card can never show more than was kept. */
export const ACP_STDERR_TAIL_LIMIT = 4_000;
const ACP_STDERR_HEADLINE_MAX_LINES = 2;
const ACP_STDERR_HEADLINE_LINE_LIMIT = 400;

// Terminal control sequences an agent CLI writes to stderr. Stripped before any
// of the text is shown or copied: a raw ANSI escape in a card is noise, and a
// `\r`-driven progress redraw would otherwise collapse into one unreadable line.
const ACP_ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ACP_ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ACP_ANSI_SIMPLE = /\x1b[@-Z\\-_]/g;
// Keep `\n` and `\t`; drop every other C0/C1 control, including NUL.
const ACP_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// Conservative secret redaction. stderr routinely echoes the argv or config an
// agent was handed, so a token can land in the tail verbatim; the card and its
// Copy button must never be a way to lift a credential out of ADE.
const ACP_SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\b(\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
    "$1$2$3[redacted]",
  ],
  [/\b(sk-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{16})\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, "[redacted]"],
];

/**
 * Last-line-of-defence cleaning for an agent process's captured stderr. ANSI
 * escapes and control characters come out, secret-shaped values are redacted,
 * the whole thing stays inside the host's 4 KB cap, and no single line is
 * allowed to grow without bound. Returns `""` for input with nothing usable.
 */
export function sanitizeAcpStderrTail(tail: string | null | undefined): string {
  if (typeof tail !== "string" || !tail) return "";
  let text = tail
    .replace(/\r\n?/g, "\n")
    .replace(ACP_ANSI_CSI, "")
    .replace(ACP_ANSI_OSC, "")
    .replace(ACP_ANSI_SIMPLE, "")
    .replace(ACP_CONTROL_CHARS, "");
  if (text.length > ACP_STDERR_TAIL_LIMIT) text = text.slice(-ACP_STDERR_TAIL_LIMIT);
  for (const [pattern, replacement] of ACP_SECRET_RULES) text = text.replace(pattern, replacement);
  // A redaction can be longer than the value it replaces, so re-bound the
  // result rather than trusting the pre-redaction cap to hold.
  if (text.length > ACP_STDERR_TAIL_LIMIT) text = text.slice(-ACP_STDERR_TAIL_LIMIT);
  return text.trim();
}

/** A line that is only decoration carries no diagnosis at all. */
function isStderrDecorationLine(line: string): boolean {
  return /^[=\-_*#~.·•\s]+$/.test(line);
}

/** A stack frame is real content but never the line that names the failure. */
function isStderrStackFrameLine(line: string): boolean {
  return /^at\s/.test(line) || /^\.{3}/.test(line);
}

function clampStderrHeadlineLine(line: string): string {
  return line.length > ACP_STDERR_HEADLINE_LINE_LIMIT
    ? `${line.slice(0, ACP_STDERR_HEADLINE_LINE_LIMIT)}…`
    : line;
}

export type AcpStderrSummary = {
  /** Last meaningful stderr line(s), one line, or null when there are none. */
  headline: string | null;
  /** Sanitized, bounded full tail for the technical fold; null when empty. */
  technicalDetail: string | null;
};

/**
 * Turn an ACP stderr tail into card-ready copy. The headline is the last
 * meaningful line(s) — a trailing stack frame is skipped so a thrown error's
 * own message survives — and the full sanitized tail rides along for the fold.
 * Empty or noise-only input yields no headline, which is what keeps the generic
 * card in place instead of inventing text from nothing.
 */
export function summarizeAcpStderrTail(tail: string | null | undefined): AcpStderrSummary {
  const cleaned = sanitizeAcpStderrTail(tail);
  if (!cleaned) return { headline: null, technicalDetail: null };
  const lines = cleaned.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  // Decoration is dropped outright. If nothing but stack frames is left, a
  // frame still beats an empty card, so fall back to those rather than null.
  const contentLines = lines.filter((line) => !isStderrDecorationLine(line));
  const meaningful = contentLines.filter((line) => !isStderrStackFrameLine(line));
  const headlineSource = meaningful.length ? meaningful : contentLines;
  const headline = headlineSource
    .slice(-ACP_STDERR_HEADLINE_MAX_LINES)
    .map(clampStderrHeadlineLine)
    .join(" ");
  return {
    headline: headline || null,
    technicalDetail: cleaned,
  };
}

/**
 * Card copy for one failure kind. Every call site is provider-agnostic now
 * (Droid, Codex and the ACP dialects all land here), so no sentence may
 * hardcode one provider's name — `provider` is substituted where it is known
 * and the sentence reads provider-neutral where it is not.
 */
function failureCopy(
  kind: ChatErrorPresentationKind,
  provider: string | undefined,
): { title: string; fallbackBody: string; nextAction: string } {
  switch (kind) {
    case "rate_limit":
      return {
        title: "Usage limit reached",
        fallbackBody: "The provider ended this turn at a usage limit.",
        nextAction: "Retry after the limit resets, or choose another model.",
      };
    case "auth":
      return {
        title: "Authentication issue",
        fallbackBody: "Sign in again, then retry this turn.",
        nextAction: "Check credentials and retry.",
      };
    case "network":
      return {
        title: "Connection issue",
        fallbackBody: provider
          ? `The connection to ${provider} dropped mid-run.`
          : "The connection dropped mid-run.",
        nextAction: "Retry the turn.",
      };
    case "busy":
      return {
        title: provider ? `${provider} is already working` : "This chat is already working",
        fallbackBody: "Wait for the active turn to finish, or cancel it before sending another message.",
        nextAction: "Wait, then retry.",
      };
    case "configuration":
      // Only Cursor's card may name Cursor's sandbox or ADE's hook fallback; a
      // Codex seatbelt/landlock failure reaches this case too.
      return {
        title: TITLE_COULDNT_START,
        fallbackBody: isCursorProviderLabel(provider)
          ? "This ADE runtime can't use Cursor's sandbox. ADE still blocks writes through its own hooks."
          : provider
            ? `This ADE runtime can't provide the sandbox ${provider} asked for.`
            : "This ADE runtime can't provide the sandbox this agent asked for.",
        nextAction: "Retry the turn.",
      };
    // `not_found` lands here on purpose: ADE recycles the agent and resumes
    // after `agent_not_found`, so the card says exactly what any other stopped
    // turn says.
    default:
      return {
        title: TITLE_COULDNT_START,
        fallbackBody: provider
          ? `${provider} stopped this turn before it could finish.`
          : "This turn stopped before it could finish.",
        nextAction: "Retry, or switch model.",
      };
  }
}

const PRESENTABLE_ERROR_CATEGORIES = new Set(["rate_limit", "auth", "network", "busy"]);

/**
 * Narrow a chat event's `errorInfo.category` to the kind `presentChatFailure`
 * takes. Anything the card has no dedicated copy for reads as `unknown`.
 */
export function chatErrorKindFromCategory(category: unknown): ChatErrorPresentationKind {
  return typeof category === "string" && PRESENTABLE_ERROR_CATEGORIES.has(category)
    ? category as ChatErrorPresentationKind
    : "unknown";
}

function trimText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isSandboxUnsupportedText(text: string): boolean {
  const lowered = text.toLowerCase();
  if (!lowered.includes("sandbox")) return false;
  return lowered.includes("not supported")
    || lowered.includes("sandboxoptions.enabled")
    || lowered.includes("sandboxing was requested");
}

export function isSandboxUnsupportedFailureText(
  ...texts: Array<string | null | undefined>
): boolean {
  // Each field is matched on its own. Joining them let "Sandbox startup failed"
  // in `message` pair with an unrelated "not supported" in `detail` and steal
  // the sandbox-configuration card.
  return texts.some((text) => (text ? isSandboxUnsupportedText(text) : false));
}

/**
 * Card label for the provider that failed. Call sites pass either a display
 * label ("Factory Droid") or a provider key ("codex"); only the key form is
 * normalized, so labels that are not plain title case ("GitHub Copilot")
 * survive intact.
 */
function providerCardLabel(provider: string | null | undefined): string | undefined {
  const raw = trimText(provider);
  if (!raw) return undefined;
  return raw === raw.toLowerCase() ? providerDisplayLabel(raw, raw) : raw;
}

function isCursorProviderLabel(label: string | undefined): boolean {
  return label?.toLowerCase().startsWith("cursor") ?? false;
}

/**
 * Rewrite a provider failure into the shared card contract. `provider` names
 * the provider that actually failed; without it the copy stays provider-neutral
 * rather than guessing. Raw text lands only in `technicalDetail`.
 */
export function presentChatFailure(args: {
  kind?: ChatErrorPresentationKind | null;
  message?: string | null;
  detail?: string | null;
  errorCode?: string | null;
  provider?: string | null;
  /**
   * A captured agent process stderr tail. Only the failure path that owns the
   * process passes this, so it is already known to be related to the failure.
   * When it yields a headline, that headline leads the card (the generic
   * sentence was hiding the one line that explained the failure) and the full
   * sanitized tail rides in `technicalDetail` behind Copy.
   */
  stderrTail?: string | null;
}): ChatErrorPresentation {
  const provider = providerCardLabel(args.provider);
  const message = trimText(args.message);
  const detail = trimText(args.detail);
  const errorCode = trimText(args.errorCode);
  const stderr = summarizeAcpStderrTail(args.stderrTail);
  const technical = uniqueTechnicalLines([
    message && !isFriendlyHostCopy(message) ? message : undefined,
    detail && detail !== message ? detail : undefined,
    errorCode
      && errorCode !== message
      && !detail?.includes(errorCode)
      && !message?.includes(errorCode)
      ? errorCode
      : undefined,
    stderr.technicalDetail ?? undefined,
  ]);
  // Sandbox-unsupported text outranks any caller-supplied kind, which is how a
  // provider that reports the failure as a plain error still gets the card.
  const kind = isSandboxUnsupportedFailureText(message, detail, errorCode)
    ? "configuration"
    : args.kind ?? "unknown";
  const copy = failureCopy(kind, provider);
  // `configuration` is the one kind that discards the host message: the raw SDK
  // sentence tells the user to edit `local.sandboxOptions` /
  // `~/.cursor/sandbox.json`, which is never card copy.
  const hostBody = kind === "configuration" ? undefined : message;
  return {
    title: copy.title,
    body: stderr.headline
      ?? (hostBody && isFriendlyHostCopy(hostBody) ? hostBody : copy.fallbackBody),
    nextAction: copy.nextAction,
    ...(technical ? { technicalDetail: technical } : {}),
  };
}

function isFriendlyHostCopy(text: string): boolean {
  const lowered = text.toLowerCase();
  if (isSandboxUnsupportedText(text)) return false;
  if (lowered.includes("disable local.sandboxoptions")) return false;
  if (lowered.includes("remove ~/.cursor/sandbox.json")) return false;
  if (lowered === "error" || lowered === "unknown") return false;
  if (/^error \(unknown/i.test(text)) return false;
  return true;
}

function uniqueTechnicalLines(lines: Array<string | undefined>): string | undefined {
  const out: string[] = [];
  for (const line of lines) {
    if (!line || out.includes(line)) continue;
    out.push(line);
  }
  return out.length ? out.join("\n") : undefined;
}

export function readChatErrorPresentation(
  errorInfo: unknown,
): ChatErrorPresentation | null {
  if (!errorInfo || typeof errorInfo !== "object" || Array.isArray(errorInfo)) return null;
  const presentation = (errorInfo as { presentation?: unknown }).presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) {
    return null;
  }
  const record = presentation as Record<string, unknown>;
  const title = trimText(typeof record.title === "string" ? record.title : undefined);
  const body = trimText(typeof record.body === "string" ? record.body : undefined);
  if (!title || !body) return null;
  const nextAction = trimText(typeof record.nextAction === "string" ? record.nextAction : undefined);
  const technicalDetail = trimText(typeof record.technicalDetail === "string" ? record.technicalDetail : undefined);
  return {
    title,
    body,
    ...(nextAction ? { nextAction } : {}),
    ...(technicalDetail ? { technicalDetail } : {}),
  };
}
