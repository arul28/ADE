import { describe, expect, it } from "vitest";
import {
  detectClaudeVersionRejectionInError,
  detectClaudeVersionRejectionInMessage,
  detectClaudeVersionRejectionInOutput,
  decideMuseFloor,
  detectCodexVersionRejection,
  detectCodexVersionRejectionInExecEvents,
  detectCodexVersionRejectionInOutput,
  detectCopilotVersionRejection,
  parseMuseChannelDocument,
} from "./providerVersionRejection";

// The refusals exactly as Claude Code 2.1.300 (SDK 0.3.300) and the Copilot
// SDK runtime 1.0.22 build them (strings read from the shipped binaries).
const STARTUP_TEXT =
  "It looks like your version of Claude Code (2.1.300) needs an update.\nA newer version (2.1.305 or higher) is required to continue.\n\n"
  + "To update, please run:\n    claude update\n\nThis will ensure you have access to the latest features and improvements.";
const MODEL_FLOOR_TEXT =
  "Claude Code 2.1.300 does not support this model; version 2.1.305 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
const ORG_FLOOR_TEXT = "Claude Code 2.1.300 is older than the minimum version required by your organization's policy (2.1.310).";
const CLIENT_DATA_TEXT =
  "Error: --client-data-url: the document requires Claude Code 2.1.305 or newer and this build is 2.1.300; run claude update. "
  + "Claude Code does not start without the configuration it was given; to start without it, remove the flag, or remove "
  + "CLAUDE_CODE_CLIENT_DATA_URL from your environment or settings.";
const COPILOT_TEXT =
  "Update Copilot: your organization's managed settings require version 1.0.40 or newer (this client reports 1.0.22). "
  + "This version cannot enforce that policy, so Copilot cannot be used until you update.";

const apiErrorAssistant = (text: string, fields: Record<string, unknown> = {}) => ({
  type: "assistant",
  is_api_error_message: true,
  api_error_status: 400,
  message: { content: [{ type: "text", text }] },
  ...fields,
});
const errorResult = (fields: Record<string, unknown>) => ({ type: "result", subtype: "error_during_execution", is_error: true, ...fields });

describe("detectClaudeVersionRejection*", () => {
  it.each([
    ["startup result", () => detectClaudeVersionRejectionInMessage(errorResult({ errors: [STARTUP_TEXT], startup_failure_reason: "cli_version_too_old" })), "startup_min_version", "2.1.305", "2.1.300"],
    ["startup result, no text", () => detectClaudeVersionRejectionInMessage(errorResult({ errors: [], startup_failure_reason: "cli_version_too_old" })), "startup_min_version", null, null],
    ["startup stderr, exit 1", () => detectClaudeVersionRejectionInOutput({ exitCode: 1, stderr: `\n${STARTUP_TEXT}\n` }), "startup_min_version", "2.1.305", "2.1.300"],
    ["SDK exit error with stderr tail", () => detectClaudeVersionRejectionInError(new Error(`Claude Code process exited with code 1. stderr: ${STARTUP_TEXT}`)), "startup_min_version", "2.1.305", "2.1.300"],
    ["API floor, typed + text", () => detectClaudeVersionRejectionInMessage(apiErrorAssistant(`API Error: 400 ${MODEL_FLOOR_TEXT}`, { api_error: "claude_code_version_too_old" })), "api_min_version", "2.1.305", "2.1.300"],
    ["API floor, typed code only", () => detectClaudeVersionRejectionInMessage(apiErrorAssistant("API Error: 400 This model needs a newer client.", { api_error_code: "claude_code_version_too_old" })), "api_min_version", null, null],
    ["API floor, text only (catalog)", () => detectClaudeVersionRejectionInMessage(apiErrorAssistant(MODEL_FLOOR_TEXT)), "api_min_version", "2.1.305", "2.1.300"],
    ["API floor on the turn's result", () => detectClaudeVersionRejectionInMessage(errorResult({ result: MODEL_FLOOR_TEXT, api_error_status: 400, api_error_code: "claude_code_version_too_old" })), "api_min_version", "2.1.305", "2.1.300"],
    ["print-mode text output, exit 1", () => detectClaudeVersionRejectionInOutput({ exitCode: 1, stdout: `API Error: 400 ${MODEL_FLOOR_TEXT}`, stderr: "" }), "api_min_version", "2.1.305", "2.1.300"],
    ["refused model switch", () => detectClaudeVersionRejectionInError(new Error(MODEL_FLOOR_TEXT)), "api_min_version", "2.1.305", "2.1.300"],
    ["client-data document, exit 1", () => detectClaudeVersionRejectionInOutput({ exitCode: 1, stderr: CLIENT_DATA_TEXT }), "client_data_min_version", "2.1.305", "2.1.300"],
  ])("matches %s", (_label, detect, signal, requiredVersion, rejectedVersion) => {
    expect(detect()).toMatchObject({ signal, requiredVersion, rejectedVersion });
  });

  it.each([
    ["organisation-policy floor (typed)", () => detectClaudeVersionRejectionInMessage(apiErrorAssistant(`API Error: 400 ${ORG_FLOOR_TEXT}`, { api_error: "claude_code_version_too_old" }))],
    ["organisation floor worded otherwise (typed)", () => detectClaudeVersionRejectionInMessage(apiErrorAssistant("Your organization requires a newer Claude Code.", { api_error_code: "claude_code_version_too_old" }))],
    ["organisation floor in print output", () => detectClaudeVersionRejectionInOutput({ exitCode: 1, stdout: ORG_FLOOR_TEXT, stderr: "" })],
    ["network error", () => detectClaudeVersionRejectionInMessage(errorResult({ errors: ["API Error: Connection error."] }))],
    ["network error exit", () => detectClaudeVersionRejectionInError(new Error("Claude Code process exited with code 1. stderr: Error: connect ECONNREFUSED 127.0.0.1:443"))],
    ["auth failure", () => detectClaudeVersionRejectionInMessage(apiErrorAssistant("Invalid API key · Please run /login", { api_error_status: 401, error: "authentication_failed" }))],
    ["rate limit", () => detectClaudeVersionRejectionInMessage(errorResult({ result: "Claude AI usage limit reached|1760000000", api_error_status: 429 }))],
    ["typed code on a non-400 status", () => detectClaudeVersionRejectionInMessage(errorResult({ result: MODEL_FLOOR_TEXT, api_error_status: 429, api_error_code: "claude_code_version_too_old" }))],
    ["crash", () => detectClaudeVersionRejectionInError(new Error("Claude Code process terminated by signal SIGKILL"))],
    ["timeout", () => detectClaudeVersionRejectionInError(new Error("Provider task timed out after 120000ms."))],
    ["local DB migration error", () => detectClaudeVersionRejectionInOutput({ exitCode: 1, stderr: "error: VersionTooOld: migration 42 was applied by a newer version" })],
    ["generic please upgrade", () => detectClaudeVersionRejectionInOutput({ exitCode: 1, stderr: "Please upgrade to the latest version of Claude Code and try again." })],
    ["update available notice, exit 0", () => detectClaudeVersionRejectionInOutput({ exitCode: 0, stderr: "A newer version of Claude Code is available. Run claude update." })],
    ["startup text but exit 0", () => detectClaudeVersionRejectionInOutput({ exitCode: 0, stderr: STARTUP_TEXT })],
    ["startup text but exit 2", () => detectClaudeVersionRejectionInOutput({ exitCode: 2, stderr: STARTUP_TEXT })],
    ["model quoting the sentence", () => detectClaudeVersionRejectionInMessage({ type: "assistant", message: { content: [{ type: "text", text: MODEL_FLOOR_TEXT }] } })],
    ["successful result quoting it", () => detectClaudeVersionRejectionInMessage({ type: "result", is_error: false, result: MODEL_FLOOR_TEXT })],
    ["another startup failure", () => detectClaudeVersionRejectionInMessage(errorResult({ errors: ["Your organization refused this sign-in."], startup_failure_reason: "org_config_refused" }))],
    ["other client-data failure", () => detectClaudeVersionRejectionInOutput({ exitCode: 1, stderr: "Error: --client-data-url: the document could not be parsed (parse_failed)." })],
  ])("ignores %s", (_label, detect) => {
    expect(detect()).toBeNull();
  });
});

describe("detectCopilotVersionRejection", () => {
  it.each([
    ["session error text", { errorType: "policy", message: COPILOT_TEXT }, "1.0.40", "1.0.22"],
    ["failed request", new Error(`Copilot SDK create failed: ${COPILOT_TEXT}`), "1.0.40", "1.0.22"],
    ["stderr line", `${COPILOT_TEXT} Run \`copilot update\` to install a newer version.`, "1.0.40", "1.0.22"],
    ["typed kind", { errorType: "managed_client_update_required", message: "Copilot cannot run." }, null, null],
  ])("matches %s", (_label, input, requiredVersion, reportedVersion) => {
    expect(detectCopilotVersionRejection(input)).toMatchObject({ requiredVersion, reportedVersion });
  });

  it.each([
    ["soft request warning", "Warning: Update Copilot: your organization has requested version 1.0.40 or newer."],
    ["deprecation warning", { errorType: "model", message: "Your Copilot CLI version is outdated and will soon lose access to premium models. Please upgrade to the latest version." }],
    ["rate limit", { errorType: "rate_limit", errorCode: "user_weekly_rate_limited", message: "You have hit your weekly rate limit." }],
    ["auth", { errorType: "authentication", message: "Not signed in to GitHub." }],
    ["network", new Error("Copilot SDK send failed: fetch failed (ECONNRESET)")],
  ])("ignores %s", (_label, input) => {
    expect(detectCopilotVersionRejection(input)).toBeNull();
  });
});

// OpenAI's backend body, exactly as openai/codex #31826 / #32482 report it (the
// sentence is not in the 0.162.1 binary; it arrives as a turn error).
const CODEX_FLOOR_TEXT =
  "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";

describe("detectCodexVersionRejection*", () => {
  it.each([
    ["app-server error notification", () => detectCodexVersionRejection({ message: CODEX_FLOOR_TEXT, requestedModel: "gpt-5.6-sol" })],
    ["wrapped backend body (bad request)", () => detectCodexVersionRejection({ message: `unexpected status 400 Bad Request: {"detail":"${CODEX_FLOOR_TEXT}"}`, errorInfo: "badRequest" })],
    ["remote compact task error", () => detectCodexVersionRejection({ message: `Error running remote compact task: {"detail":"${CODEX_FLOOR_TEXT}"}`, errorInfo: { other: null } })],
    ["sentence in additionalDetails", () => detectCodexVersionRejection({ message: "Request failed", detail: CODEX_FLOOR_TEXT })],
    ["one-shot exec, exit 1", () => detectCodexVersionRejectionInOutput({ exitCode: 1, stderr: `ERROR: ${CODEX_FLOOR_TEXT}`, requestedModel: "gpt-5.6-sol" })],
    ["exec --json turn.failed", () => detectCodexVersionRejectionInExecEvents(`{"type":"turn.started"}\n{"type":"turn.failed","error":{"message":${JSON.stringify(CODEX_FLOOR_TEXT)}}}`)],
  ])("matches %s", (_label, detect) => {
    expect(detect()).toMatchObject({ signal: "model_min_version", model: "gpt-5.6-sol" });
  });

  it.each([
    ["SQLite migration VersionTooOld", () => detectCodexVersionRejection({ message: "failed to open state db: VersionTooOld: migration 12 was applied by a newer version" })],
    ["rate limit", () => detectCodexVersionRejection({ message: "You've hit your usage limit. Upgrade to Pro or try again later.", errorInfo: "usageLimitExceeded" })],
    ["floor words under a usage-limit kind", () => detectCodexVersionRejection({ message: CODEX_FLOOR_TEXT, errorInfo: "usageLimitExceeded" })],
    ["auth", () => detectCodexVersionRejection({ message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", errorInfo: "unauthorized" })],
    ["network", () => detectCodexVersionRejection({ message: "stream disconnected before completion: error sending request", errorInfo: { httpConnectionFailed: { httpStatusCode: null } } })],
    ["generic please upgrade", () => detectCodexVersionRejection({ message: "Please upgrade to the latest version of Codex and try again." })],
    ["local app-server skew", () => detectCodexVersionRejection({ message: "Permission selection requires a newer app server." })],
    ["another model than the chat's", () => detectCodexVersionRejection({ message: CODEX_FLOOR_TEXT, requestedModel: "gpt-5.5" })],
    ["exit 0 with the sentence", () => detectCodexVersionRejectionInOutput({ exitCode: 0, stdout: CODEX_FLOOR_TEXT, stderr: "" })],
    ["assistant reply quoting it", () => detectCodexVersionRejectionInExecEvents(`{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":${JSON.stringify(CODEX_FLOOR_TEXT)}}}\n{"type":"turn.completed"}`)],
  ])("ignores %s", (_label, detect) => {
    expect(detect()).toBeNull();
  });
});

describe("decideMuseFloor", () => {
  const channel = (fields: Record<string, unknown>) =>
    parseMuseChannelDocument({ channel: "muse-stable", version: "1.4.7-R6200.1", urgency: "none", state: "public", min_version: null, ...fields })!;
  it.each([
    ["no floor (today's document)", channel({}), "1.4.7-R6101.1", "none"],
    ["pin meets the floor", channel({ min_version: "1.4.7-R6101.1" }), "1.4.7-R6101.1", "none"],
    ["floor without a build, same release", channel({ min_version: "1.4.7" }), "1.4.7-R6101.1", "none"],
    ["unparseable floor", channel({ min_version: "latest" }), "1.4.7-R6101.1", "none"],
    ["newer build of the same release", channel({ min_version: "1.4.7-R6150.1" }), "1.4.7-R6101.1", "fall-forward"],
    ["builds compare numerically", channel({ min_version: "1.4.7-R10000", version: "1.4.7-R10001.1" }), "1.4.7-R9999.1", "fall-forward"],
    ["channel build of another release", channel({ min_version: "1.4.10", version: "1.4.10-R6427.1" }), "1.4.7-R6101.1", "update-ade"],
    ["channel build below the floor", channel({ min_version: "1.4.7-R6300.1" }), "1.4.7-R6101.1", "update-ade"],
  ])("%s", (_label, doc, pinnedVersion, action) => {
    expect(decideMuseFloor({ channel: doc, pinnedVersion, sdkVersion: "1.4.7" }).action).toBe(action);
  });

  it.each([
    ["another channel", { channel: "muse-beta", version: "1.4.7-R1.1", min_version: "1.4.7-R9" }],
    ["a min_version that is not a string", { channel: "muse-stable", version: "1.4.7-R1.1", min_version: 7 }],
    ["not an object", ["muse-stable"]],
  ])("rejects the document: %s", (_label, raw) => {
    expect(parseMuseChannelDocument(raw)).toBeNull();
  });
});
