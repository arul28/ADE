import { describe, expect, it } from "vitest";
import {
  PI_SDK_PROTOCOL_VERSION,
  normalizePiSdkModelRef,
  piSupportedThinkingLevels,
  validatePiSdkWorkerResponse,
  validatePiSdkWorkerResult,
  toPiSdkJson,
  validatePiSdkWorkerRequest,
} from "./piSdkProtocol";

const base = { protocolVersion: PI_SDK_PROTOCOL_VERSION, requestId: "r1" };
const ready = {
  protocolVersion: PI_SDK_PROTOCOL_VERSION,
  packageRoot: "/pkg",
  packageEntry: "/pkg/dist/index.js",
  version: "0.84.0",
  sessionFile: null,
  sessionId: null,
  currentModel: null,
  thinkingLevel: null,
  availableModels: [],
};

describe("Pi SDK protocol", () => {
  it("rejects malformed and unsupported worker messages without throwing", () => {
    expect(validatePiSdkWorkerRequest(null)).toContain("object");
    expect(validatePiSdkWorkerRequest({ type: "send", requestId: "x" })).toContain("protocol version");
    expect(validatePiSdkWorkerRequest({ ...base, type: "send", payload: { prompt: "" } })).toContain("non-empty prompt");
  });

  // Path images carry the attachment root so the worker re-opens them; bytes
  // are only inlined for data images.
  it.each([
    ["send", { path: "/repo/.ade/attachments/shot.png", mimeType: "image/png", rootPath: "/repo" }, null],
    ["steer", { data: "abc", mimeType: "image/jpeg" }, null],
    ["send", { url: "https://example.com/ui.png", mimeType: "image/png" }, /path or data/u],
    ["follow_up", { path: "/shot.png", data: "abc", mimeType: "image/png" }, /path or data/u],
    ["send", { path: "/repo/.ade/attachments/shot.png", mimeType: "image/png" }, /path or data/u],
  ] as const)("validates a %s image %j", (type, image, expected) => {
    const result = validatePiSdkWorkerRequest({ ...base, type, payload: { prompt: "look", images: [image] } });
    if (expected === null) expect(result).toBeNull();
    else expect(result).toMatch(expected);
  });

  // The store root and the directory Pi writes into are separate fields; both
  // must be validated, or a rename can silently unhook one of them. The tool
  // options must not widen the tool surface through a malformed value.
  it.each([
    [{ sessionRoot: "/a/sessions", sessionStorageDir: "/pi-sessions", modelRef: "anthropic/claude", thinkingLevel: "medium" }, null],
    [{ sessionRoot: 5 }, /sessionRoot/u],
    [{ sessionStorageDir: 5 }, /sessionStorageDir/u],
    [{ extensions: "yes" }, /extensions/u],
    [{ askUserTool: 1 }, /askUserTool/u],
    [{ approvalTools: ["bash", ""] }, /approvalTools/u],
  ] as const)("validates init payload %j", (extra, expected) => {
    const result = validatePiSdkWorkerRequest({
      ...base,
      type: "init",
      payload: { packageRoot: "/p", cwd: "/c", agentDir: "/a", ...extra },
    });
    if (expected === null) expect(result).toBeNull();
    else expect(result).toMatch(expected);
  });

  it("rejects malformed worker responses before they reach the pool", () => {
    expect(validatePiSdkWorkerResponse({ ...base, type: "response", ok: false })).toContain("missing error");
    expect(validatePiSdkWorkerResponse({
      protocolVersion: PI_SDK_PROTOCOL_VERSION,
      type: "ready",
      ready: { ...ready, availableModels: "bad" },
    })).toContain("availableModels");
    expect(validatePiSdkWorkerResponse({
      protocolVersion: PI_SDK_PROTOCOL_VERSION,
      type: "lifecycle",
      event: "not-a-lifecycle",
    })).toContain("lifecycle event");
  });

  it("validates successful results against the request that produced them", () => {
    expect(validatePiSdkWorkerResult("models", {})).toContain("array");
    expect(validatePiSdkWorkerResult("auth", [{ id: "openai" }])).toBeNull();
    expect(validatePiSdkWorkerResult("set_thinking", { protocolVersion: PI_SDK_PROTOCOL_VERSION })).toContain("package paths");
    expect(validatePiSdkWorkerResult("init", ready)).toBeNull();
    expect(validatePiSdkWorkerResult("init", { ...ready, account: { kind: "subscription", upstream: "openai-codex", accountId: "acct-1" } })).toBeNull();
    expect(validatePiSdkWorkerResult("init", { ...ready, account: { kind: "subscription", upstream: "openai-codex", accountId: 4 } })).toMatch(/account/u);
    expect(validatePiSdkWorkerResult("init", { ...ready, extensions: [{ id: "/a/b.js", name: "b" }] })).toBeNull();
    expect(validatePiSdkWorkerResult("init", { ...ready, extensions: [{ name: "b" }] })).toMatch(/extensions/u);
    expect(validatePiSdkWorkerResult("init", { ...ready, extensionsError: 3 })).toMatch(/extensionsError/u);
    expect(validatePiSdkWorkerResult("login", { ok: true, providerId: "anthropic" })).toBeNull();
    expect(validatePiSdkWorkerResult("login", { providerId: "anthropic" })).toMatch(/ok/u);
    expect(validatePiSdkWorkerResult("context_usage", { tokens: 120, contextWindow: 1_000, percent: 12 })).toBeNull();
    // "No sample": Pi has no reading right after a compaction or for a model with no window.
    expect(validatePiSdkWorkerResult("context_usage", null)).toBeNull();
    expect(validatePiSdkWorkerResult("context_usage", { tokens: "120", contextWindow: 1_000, percent: 12 })).toMatch(/context_usage/u);
  });

  it("normalizes model references and makes hostile SDK values JSON-safe", () => {
    expect(normalizePiSdkModelRef("openai/gpt-5")).toEqual({ provider: "openai", id: "gpt-5" });
    expect(normalizePiSdkModelRef({ provider: "anthropic", modelId: "claude" })).toEqual({ provider: "anthropic", id: "claude" });
    const circular: Record<string, unknown> = { value: 1 };
    circular.self = circular;
    expect(toPiSdkJson({ circular, nan: Number.NaN, bigint: BigInt(3) })).toEqual({
      circular: { value: 1, self: "[circular]" },
      nan: null,
      bigint: "3",
    });
  });

  it("accepts the login, ui_response, and context_usage requests and rejects malformed ones", () => {
    expect(validatePiSdkWorkerRequest({ ...base, type: "login", payload: { providerId: "anthropic" } })).toBeNull();
    expect(validatePiSdkWorkerRequest({ ...base, type: "login_cancel" })).toBeNull();
    expect(validatePiSdkWorkerRequest({ ...base, type: "ui_response", payload: { ok: true, value: "x" } })).toBeNull();
    expect(validatePiSdkWorkerRequest({ ...base, type: "context_usage" })).toBeNull();
    expect(validatePiSdkWorkerRequest({ ...base, type: "login", payload: { providerId: "  " } })).toMatch(/providerId/u);
    expect(validatePiSdkWorkerRequest({ ...base, type: "login", payload: { providerId: "a", method: "" } })).toMatch(/method/u);
    expect(validatePiSdkWorkerRequest({ ...base, type: "ui_response", payload: { value: "x" } })).toMatch(/ok/u);
    expect(validatePiSdkWorkerRequest({ ...base, type: "ui_response", payload: { ok: true, value: 5 } })).toMatch(/value/u);
  });

  it("validates ui_request and ui_notice coming back from the worker", () => {
    const ok = {
      protocolVersion: PI_SDK_PROTOCOL_VERSION,
      type: "ui_request",
      requestId: "u1",
      payload: { origin: "tool", kind: "select", message: "Which?", options: [{ value: "0", label: "A" }] },
    };
    expect(validatePiSdkWorkerResponse(ok)).toBeNull();
    expect(validatePiSdkWorkerResponse({ ...ok, payload: { ...ok.payload, origin: "elsewhere" } })).toMatch(/origin/u);
    expect(validatePiSdkWorkerResponse({ ...ok, payload: { ...ok.payload, kind: "slider" } })).toMatch(/kind/u);
    expect(validatePiSdkWorkerResponse({ ...ok, payload: { ...ok.payload, message: 7 } })).toMatch(/message/u);
    expect(validatePiSdkWorkerResponse({ ...ok, payload: { ...ok.payload, options: [{ value: "0" }] } })).toMatch(/options/u);
    expect(validatePiSdkWorkerResponse({ ...ok, requestId: "" })).toMatch(/requestId/u);

    const notice = {
      protocolVersion: PI_SDK_PROTOCOL_VERSION,
      type: "ui_notice",
      payload: { origin: "extension", level: "warn", message: "hi" },
    };
    expect(validatePiSdkWorkerResponse(notice)).toBeNull();
    expect(validatePiSdkWorkerResponse({ ...notice, payload: { ...notice.payload, level: "fatal" } })).toMatch(/level/u);
  });
});

describe("Pi thinking levels", () => {
  // Clearing the effort in ADE sends null: the session goes back to Pi's default.
  it("accepts null on set_thinking as a reset, and still rejects a blank level", () => {
    const setThinking = (payload: Record<string, unknown>) => validatePiSdkWorkerRequest({ ...base, type: "set_thinking", payload });
    expect(setThinking({ thinkingLevel: null })).toBeNull();
    expect(setThinking({ thinkingLevel: "high" })).toBeNull();
    expect(setThinking({ thinkingLevel: " " })).toMatch(/thinkingLevel/u);
    expect(setThinking({})).toMatch(/thinkingLevel/u);
  });

  // Pi's own rule (pi-ai getSupportedThinkingLevels): these are the effort
  // choices ADE offers for a Pi model.
  it("offers exactly the levels Pi supports for the model", () => {
    expect(piSupportedThinkingLevels({ reasoning: false })).toEqual(["off"]);
    expect(piSupportedThinkingLevels({})).toEqual(["off"]);
    expect(piSupportedThinkingLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(piSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }))
      .toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    // A null entry hides a level; xhigh and max can be separated by a hole.
    expect(piSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: null, max: "max" } }))
      .toEqual(["low", "medium", "high", "max"]);
  });
});
