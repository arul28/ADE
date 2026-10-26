/**
 * Exact detection of a vendor refusing ADE's pinned provider build as too old.
 *
 * ADE runs only its own pinned copy of each provider. The one exception the
 * owner approved: when Anthropic provably refuses the pinned Claude Code as
 * too old, ADE moves to Anthropic's newest build on its own
 * (`claudeFallForward.ts`). A false trigger would replace a tested binary
 * with an untested one, so these matchers recognise only the refusals the
 * shipped binary itself emits (re-checked in CLI 2.1.300, SDK 0.3.300), and
 * nothing else: no network, auth, rate-limit, crash, timeout or local
 * database error, and no vague "please update".
 *
 * Claude has three refusals:
 * - startup floor (a remotely served minimum): the zeroed result with
 *   `startup_failure_reason: "cli_version_too_old"`, or, without that result,
 *   its stderr sentence and exit code 1;
 * - the API's per-model floor: `error.details.error_code`
 *   `claude_code_version_too_old` (the SDK's `api_error` / `api_error_code`),
 *   or the sentence "Claude Code X does not support this model; version Y or
 *   newer is required". The same code also covers a customer organisation's
 *   own policy floor, which is not Anthropic refusing the build, so a message
 *   naming the organisation never matches;
 * - a signed client-data document's minimum ("the document requires Claude
 *   Code X or newer and this build is Y").
 *
 * Copilot has one: its organisation's managed settings require a newer
 * client (`managed_client_update_required`, or the runtime's exact sentence).
 * ADE does not fall forward for it; it only says precisely what happened.
 *
 * Codex has one, from OpenAI's backend and per model (the text is not in the
 * 0.164.0 binary; it arrives as the error of a model request): "The '<model>'
 * model requires a newer version of Codex. Please upgrade to the latest app or
 * CLI and try again." It is known to fire on current clients too (stale
 * caches, openai/codex #31826/#32482), so it only starts a model probe
 * (`codexFallForward.ts`), never a switch on its own.
 *
 * Muse has no refusal; Meta's channel document publishes a floor
 * (`min_version`). `decideMuseFloor` compares it with the pin and the SDK
 * pairing rule.
 *
 * Pure: no I/O. The table-driven test next to it is the contract.
 */

export type ClaudeVersionRejectionSignal = "startup_min_version" | "api_min_version" | "client_data_min_version";

export type ClaudeVersionRejection = {
  signal: ClaudeVersionRejectionSignal;
  /** The Claude Code version Anthropic requires, when it names one. */
  requiredVersion: string | null;
  /** The Claude Code version Anthropic refused, when it names it. */
  rejectedVersion: string | null;
  /** The vendor's own words, on one line, for the log and the notice. */
  message: string;
};

export type CopilotVersionRejection = {
  /** The Copilot version the organisation's managed settings require. */
  requiredVersion: string | null;
  /** The version the runtime reported for itself. */
  reportedVersion: string | null;
  message: string;
};

const CLAUDE_STARTUP_REASON = "cli_version_too_old";
const CLAUDE_API_ERROR_CODE = "claude_code_version_too_old";
const COPILOT_UPDATE_REQUIRED_KIND = "managed_client_update_required";

/** `assertMinVersion`'s message (stderr, and `errors[0]` of the startup result). */
const CLAUDE_STARTUP_TEXT =
  /It looks like your version of Claude Code \(([^)\s]+)\) needs an update\.\s+A newer version \(([^)\s]+) or higher\) is required to continue\./;
/** The API's per-model floor, also produced client-side from the model catalog. */
const CLAUDE_MODEL_FLOOR_TEXT = /\bClaude Code (\S+) does not support this model; version (\S+) or newer is required\b/;
/** The organisation-policy variant of the same API error: never Anthropic refusing the build. */
const CLAUDE_ORG_FLOOR_TEXT = /\bClaude Code \S+ is older than the minimum version required by your organization's policy/;
const CLAUDE_CLIENT_DATA_TEXT = /--client-data-url: the document requires Claude Code (\S+) or newer and this build is ([^\s;]+)/;
/** How the SDK reports a CLI that exited non-zero (`ProcessTransport.getProcessExitError`). */
const CLAUDE_SDK_EXIT_TEXT = /Claude Code process exited with code (\d+)\. stderr: ([\s\S]*)$/;
const COPILOT_UPDATE_REQUIRED_TEXT =
  /Update Copilot: your organization's managed settings require version (\S+) or newer \(this client reports ([^)\s]+)\)/;

const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function version(raw: string | undefined): string | null {
  const trimmed = raw?.replace(/[.,;:]+$/, "").replace(/^v/i, "") ?? "";
  return VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function textsOf(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => textsOf(entry));
  const record = asRecord(value);
  if (!record) return [];
  // Content blocks carry their words in `text`.
  return typeof record.text === "string" && record.text.trim() ? [record.text] : [];
}

function startupFromText(text: string): ClaudeVersionRejection | null {
  const match = CLAUDE_STARTUP_TEXT.exec(text);
  if (!match) return null;
  return {
    signal: "startup_min_version",
    rejectedVersion: version(match[1]),
    requiredVersion: version(match[2]),
    message: oneLine(match[0]),
  };
}

/**
 * The API floor, from the error's words and whether it carried the typed
 * code. The code alone is enough unless the words say the floor is the
 * organisation's.
 */
function apiFloor(text: string, typed: boolean): ClaudeVersionRejection | null {
  if (CLAUDE_ORG_FLOOR_TEXT.test(text)) return null;
  const match = CLAUDE_MODEL_FLOOR_TEXT.exec(text);
  if (match) {
    return {
      signal: "api_min_version",
      rejectedVersion: version(match[1]),
      requiredVersion: version(match[2]),
      message: oneLine(match[0]),
    };
  }
  // Typed, but the words are not the model-floor sentence: an organisation
  // floor worded differently must still never count.
  if (!typed || /\borgani[sz]ation/i.test(text)) return null;
  return {
    signal: "api_min_version",
    rejectedVersion: null,
    requiredVersion: null,
    message: oneLine(text) || CLAUDE_API_ERROR_CODE,
  };
}

/**
 * A message from the Claude SDK stream, or the JSON result of a print-mode
 * run: the startup result, an API-error assistant message, or the error
 * result of a turn that ended on one. Anything the model wrote never counts:
 * only messages the CLI marks as errors are read.
 */
export function detectClaudeVersionRejectionInMessage(message: unknown): ClaudeVersionRejection | null {
  const record = asRecord(message);
  if (!record) return null;
  if (record.type === "result") {
    if (record.is_error !== true) return null;
    const text = [...textsOf(record.errors), ...textsOf(record.result)].join("\n");
    if (record.startup_failure_reason === CLAUDE_STARTUP_REASON) {
      return startupFromText(text) ?? {
        signal: "startup_min_version",
        requiredVersion: null,
        rejectedVersion: null,
        message: oneLine(text) || CLAUDE_STARTUP_REASON,
      };
    }
    if (record.startup_failure_reason !== undefined) return null;
    const status = record.api_error_status;
    if (typeof status === "number" && status !== 400) return null;
    return apiFloor(text, record.api_error_code === CLAUDE_API_ERROR_CODE);
  }
  if (record.type === "assistant") {
    if (record.is_api_error_message !== true) return null;
    const status = record.api_error_status;
    if (typeof status === "number" && status !== 400) return null;
    const text = textsOf(asRecord(record.message)?.content).join("\n");
    const typed = record.api_error === CLAUDE_API_ERROR_CODE || record.api_error_code === CLAUDE_API_ERROR_CODE;
    return apiFloor(text, typed);
  }
  return null;
}

/**
 * A Claude Code process that ended: its exit code and output. The startup
 * floor exits 1; the client-data floor exits non-zero; a print-mode run that
 * hit the API floor exits non-zero with the sentence in its output.
 */
export function detectClaudeVersionRejectionInOutput(output: {
  exitCode: number | null;
  stderr: string;
  stdout?: string;
}): ClaudeVersionRejection | null {
  if (output.exitCode == null || output.exitCode === 0) return null;
  if (output.exitCode === 1) {
    const startup = startupFromText(output.stderr);
    if (startup) return startup;
  }
  const clientData = CLAUDE_CLIENT_DATA_TEXT.exec(output.stderr);
  if (clientData) {
    return {
      signal: "client_data_min_version",
      requiredVersion: version(clientData[1]),
      rejectedVersion: version(clientData[2]),
      message: oneLine(clientData[0]),
    };
  }
  return apiFloor(`${output.stdout ?? ""}\n${output.stderr}`, false);
}

/**
 * An error the Claude SDK threw: a non-zero exit carries the CLI's stderr
 * tail; anything else counts only when its words are the API floor sentence
 * (a refused model switch reports it that way).
 */
export function detectClaudeVersionRejectionInError(error: unknown): ClaudeVersionRejection | null {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!text) return null;
  const exit = CLAUDE_SDK_EXIT_TEXT.exec(text);
  if (exit) return detectClaudeVersionRejectionInOutput({ exitCode: Number(exit[1]), stderr: exit[2] ?? "" });
  return apiFloor(text, false);
}

/**
 * Copilot refusing to run because the organisation's managed settings
 * require a newer client: the session error's kind, or the runtime's exact
 * sentence (the error message of a failed request, or its stderr). The soft
 * "has requested version X" warning and every other error never count.
 */
export function detectCopilotVersionRejection(input: unknown): CopilotVersionRejection | null {
  const record = asRecord(input);
  const text = input instanceof Error
    ? input.message
    : typeof input === "string"
      ? input
      : typeof record?.message === "string" ? record.message : "";
  const typed = record != null
    && (record.errorType === COPILOT_UPDATE_REQUIRED_KIND || record.errorCode === COPILOT_UPDATE_REQUIRED_KIND
      || record.kind === COPILOT_UPDATE_REQUIRED_KIND);
  const match = COPILOT_UPDATE_REQUIRED_TEXT.exec(text);
  if (!match && !typed) return null;
  return {
    requiredVersion: version(match?.[1]),
    reportedVersion: version(match?.[2]),
    message: oneLine(match?.[0] ?? text) || COPILOT_UPDATE_REQUIRED_KIND,
  };
}

/**
 * What ADE tells the user when Copilot refuses on an organisation policy:
 * the versions, and that only an ADE update brings a newer Copilot (ADE runs
 * its own tested copy and does not update it by itself).
 */
export function copilotVersionRejectionMessage(rejection: CopilotVersionRejection, pinnedVersion: string | null): string {
  const running = rejection.reportedVersion ?? pinnedVersion;
  const required = rejection.requiredVersion
    ? `Copilot ${rejection.requiredVersion} or newer`
    : "a newer Copilot";
  return `Your organization's GitHub Copilot policy requires ${required}. ADE runs its own tested copy`
    + `${running ? ` (${running})` : ""} and does not update it on its own, so Copilot cannot run until ADE is updated.`;
}

export type CodexVersionRejection = {
  signal: "model_min_version";
  /** The model OpenAI named as needing a newer Codex. */
  model: string;
  message: string;
};

/** OpenAI's per-model floor, exactly as its backend words it. */
const CODEX_MODEL_FLOOR_TEXT =
  /The '([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})' model requires a newer version of Codex\. Please upgrade to the latest app or CLI and try again\./;
/**
 * Codex error kinds (`codexErrorInfo`) the floor can arrive under. A request
 * refusal is a bad request (or unclassified); a usage limit, an auth failure,
 * a connection failure or a full context is never this refusal, whatever its
 * words.
 */
const CODEX_FLOOR_ERROR_KINDS = new Set(["badrequest", "other"]);

function codexErrorKind(errorInfo: unknown): string | null {
  if (errorInfo == null) return null;
  if (typeof errorInfo === "string") return errorInfo.replace(/[_\s-]/g, "").toLowerCase();
  const record = asRecord(errorInfo);
  const keys = record ? Object.keys(record) : [];
  return keys.length === 1 ? keys[0]!.replace(/[_\s-]/g, "").toLowerCase() : "unknown";
}

function codexFloorIn(text: string): CodexVersionRejection | null {
  const match = CODEX_MODEL_FLOOR_TEXT.exec(text);
  if (!match) return null;
  return { signal: "model_min_version", model: match[1]!, message: oneLine(match[0]) };
}

/**
 * A Codex turn error (the app-server `error` notification, a failed turn's
 * `turn.error`, or a one-shot `codex exec` that exited non-zero): only an
 * error ADE received as an error, never an assistant message. `requestedModel`,
 * when known, must be the model OpenAI named.
 */
export function detectCodexVersionRejection(input: {
  message: unknown;
  errorInfo?: unknown;
  detail?: unknown;
  requestedModel?: string | null;
}): CodexVersionRejection | null {
  const kind = codexErrorKind(input.errorInfo);
  if (kind !== null && !CODEX_FLOOR_ERROR_KINDS.has(kind)) return null;
  const text = [input.message, input.detail].filter((part): part is string => typeof part === "string").join("\n");
  const rejection = codexFloorIn(text);
  if (!rejection) return null;
  const requested = input.requestedModel?.trim();
  if (requested && requested.toLowerCase() !== rejection.model.toLowerCase()) return null;
  return rejection;
}

/** A finished `codex exec` (one-shot task): non-zero exit and the floor in its output. */
export function detectCodexVersionRejectionInOutput(output: {
  exitCode: number | null;
  stdout?: string;
  stderr: string;
  requestedModel?: string | null;
}): CodexVersionRejection | null {
  if (output.exitCode == null || output.exitCode === 0) return null;
  return detectCodexVersionRejection({
    message: `${output.stderr}\n${output.stdout ?? ""}`,
    requestedModel: output.requestedModel,
  });
}

/**
 * The error events of a `codex exec --json` run (`{"type":"error"}`,
 * `{"type":"turn.failed"}`, an `error` item) that carry the floor. Used to ask
 * whether a probe reproduced the refusal; agent messages never count.
 */
export function detectCodexVersionRejectionInExecEvents(jsonl: string): CodexVersionRejection | null {
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event: Record<string, unknown> | null = null;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!event) continue;
    const item = asRecord(event.item);
    const message = event.type === "error"
      ? event.message
      : event.type === "turn.failed"
        ? asRecord(event.error)?.message
        : event.type === "item.completed" && item?.type === "error" ? item.message : null;
    if (typeof message !== "string") continue;
    const rejection = codexFloorIn(message);
    if (rejection) return rejection;
  }
  return null;
}

/** Meta's `muse-stable` channel document, the fields ADE reads. */
export type MuseChannelDocument = {
  version: string | null;
  minVersion: string | null;
  urgency: string | null;
  manifestUrl: string | null;
};

/** The channel document's fields, or null when it is not one (wrong channel, not an object). */
export function parseMuseChannelDocument(raw: unknown, channel = "muse-stable"): MuseChannelDocument | null {
  const record = asRecord(raw);
  if (!record || record.channel !== channel) return null;
  const text = (key: string): string | null => typeof record[key] === "string" && (record[key] as string).trim() ? (record[key] as string).trim() : null;
  if (record.min_version !== null && record.min_version !== undefined && typeof record.min_version !== "string") return null;
  return { version: text("version"), minVersion: text("min_version"), urgency: text("urgency"), manifestUrl: text("manifest_url") };
}

type MuseVersion = { base: [number, number, number]; build: number[] | null };

/** `1.4.7-R6101.1` (or a bare `1.4.10`); null for anything else. */
function parseMuseVersion(raw: string | null | undefined): MuseVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-R(\d+(?:\.\d+)*))?$/.exec(raw?.trim() ?? "");
  if (!match) return null;
  return {
    base: [Number(match[1]), Number(match[2]), Number(match[3])],
    build: match[4] ? match[4].split(".").map(Number) : null,
  };
}

function compareNumbers(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * Whether `version` meets `floor`. A floor without a build (`1.4.10`) is met
 * by every build of that release; with one, builds compare numerically.
 */
function meetsMuseFloor(version: MuseVersion, floor: MuseVersion): boolean {
  const base = compareNumbers(version.base, floor.base);
  if (base !== 0) return base > 0;
  if (!floor.build) return true;
  return compareNumbers(version.build ?? [], floor.build) >= 0;
}

export type MuseFloorDecision =
  /** No floor, the pin meets it, or anything ADE cannot read for sure. */
  | { action: "none" }
  /** The channel's build meets the floor and pairs with ADE's SDK. */
  | { action: "fall-forward"; version: string; minVersion: string; urgency: string | null }
  /** Meta requires a build this ADE's SDK cannot pair with: only an ADE update helps. */
  | { action: "update-ade"; minVersion: string; urgency: string | null };

/**
 * Meta's published floor against ADE's pinned Muse. Pure. The pairing rule
 * (`pin-muse-release.mjs`): SDK `X.Y.Z` drives binary `X.Y.Z-R<build>` only,
 * so a newer build of the same release can replace the pin and anything else
 * needs an ADE with a newer SDK.
 */
export function decideMuseFloor(args: {
  channel: MuseChannelDocument;
  pinnedVersion: string;
  sdkVersion: string;
}): MuseFloorDecision {
  const floor = parseMuseVersion(args.channel.minVersion);
  const pinned = parseMuseVersion(args.pinnedVersion);
  const sdk = parseMuseVersion(args.sdkVersion);
  if (!floor || !pinned || !sdk || sdk.build) return { action: "none" };
  if (meetsMuseFloor(pinned, floor)) return { action: "none" };
  const minVersion = args.channel.minVersion!;
  const urgency = args.channel.urgency;
  const channel = parseMuseVersion(args.channel.version);
  const pairs = channel?.build != null && compareNumbers(channel.base, sdk.base) === 0;
  if (!channel || !pairs || !meetsMuseFloor(channel, floor)) return { action: "update-ade", minVersion, urgency };
  return { action: "fall-forward", version: args.channel.version!, minVersion, urgency };
}
