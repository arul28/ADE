import { describe, expect, it } from "vitest";
import {
  PI_SDK_PROTOCOL_VERSION,
  normalizePiSdkModelRef,
  validatePiSdkWorkerResponse,
  validatePiSdkWorkerResult,
  toPiSdkJson,
  validatePiSdkWorkerRequest,
} from "./piSdkProtocol";

describe("Pi SDK protocol", () => {
  it("rejects malformed and unsupported worker messages without throwing", () => {
    expect(validatePiSdkWorkerRequest(null)).toContain("object");
    expect(validatePiSdkWorkerRequest({ type: "send", requestId: "x" })).toContain("protocol version");
    expect(validatePiSdkWorkerRequest({
      protocolVersion: PI_SDK_PROTOCOL_VERSION,
      type: "send",
      requestId: "x",
      payload: { prompt: "" },
    })).toContain("non-empty prompt");
  });

  it("accepts an init message without requiring Pi types", () => {
    expect(validatePiSdkWorkerRequest({
      protocolVersion: PI_SDK_PROTOCOL_VERSION,
      type: "init",
      requestId: "init-1",
      payload: {
        packageRoot: "/Users/example/.npm/pi",
        cwd: "/Users/example/project",
        agentDir: "/Users/example/.pi/agent",
        modelRef: "anthropic/claude-sonnet",
        thinkingLevel: "medium",
      },
    })).toBeNull();
  });

  it("rejects malformed worker responses before they reach the pool", () => {
    expect(validatePiSdkWorkerResponse({
      protocolVersion: PI_SDK_PROTOCOL_VERSION,
      type: "response",
      requestId: "request-1",
      ok: false,
    })).toContain("missing error");
    expect(validatePiSdkWorkerResponse({
      protocolVersion: PI_SDK_PROTOCOL_VERSION,
      type: "ready",
      ready: {
        protocolVersion: PI_SDK_PROTOCOL_VERSION,
        packageRoot: "/pi",
        packageEntry: "/pi/index.js",
        version: null,
        sessionFile: null,
        sessionId: null,
        currentModel: null,
        thinkingLevel: null,
        availableModels: "bad",
      },
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
    expect(validatePiSdkWorkerResult("init", {
      protocolVersion: PI_SDK_PROTOCOL_VERSION,
      packageRoot: "/pi",
      packageEntry: "/pi/index.js",
      version: null,
      sessionFile: null,
      sessionId: null,
      currentModel: null,
      thinkingLevel: null,
      availableModels: [],
    })).toBeNull();
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
});

describe("protocol v2 message validation", () => {
  const base = { protocolVersion: PI_SDK_PROTOCOL_VERSION, requestId: "r1" };

  it("accepts the new worker requests and rejects malformed ones", () => {
    expect(validatePiSdkWorkerRequest({ ...base, type: "login", payload: { providerId: "anthropic" } })).toBeNull();
    expect(validatePiSdkWorkerRequest({ ...base, type: "login_cancel" })).toBeNull();
    expect(validatePiSdkWorkerRequest({ ...base, type: "ui_response", payload: { ok: true, value: "x" } })).toBeNull();

    expect(validatePiSdkWorkerRequest({ ...base, type: "login", payload: { providerId: "  " } })).toMatch(/providerId/u);
    expect(validatePiSdkWorkerRequest({ ...base, type: "login", payload: { providerId: "a", method: "" } })).toMatch(/method/u);
    expect(validatePiSdkWorkerRequest({ ...base, type: "ui_response", payload: { value: "x" } })).toMatch(/ok/u);
    expect(validatePiSdkWorkerRequest({ ...base, type: "ui_response", payload: { ok: true, value: 5 } })).toMatch(/value/u);
  });

  it("rejects init options that would widen the tool surface", () => {
    const init = {
      ...base,
      type: "init",
      payload: { protocolVersion: PI_SDK_PROTOCOL_VERSION, packageRoot: "/pkg", cwd: "/w", agentDir: "/a" },
    };
    expect(validatePiSdkWorkerRequest(init)).toBeNull();
    expect(validatePiSdkWorkerRequest({ ...init, payload: { ...init.payload, extensions: "yes" } })).toMatch(/extensions/u);
    expect(validatePiSdkWorkerRequest({ ...init, payload: { ...init.payload, askUserTool: 1 } })).toMatch(/askUserTool/u);
    expect(validatePiSdkWorkerRequest({ ...init, payload: { ...init.payload, approvalTools: ["bash", ""] } })).toMatch(/approvalTools/u);
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

  it("keeps extension metadata on ready payloads JSON-safe", () => {
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
    expect(validatePiSdkWorkerResult("init", { ...ready, extensions: [{ id: "/a/b.js", name: "b" }] })).toBeNull();
    expect(validatePiSdkWorkerResult("init", { ...ready, extensions: [{ name: "b" }] })).toMatch(/extensions/u);
    expect(validatePiSdkWorkerResult("init", { ...ready, extensionsError: 3 })).toMatch(/extensionsError/u);
    expect(validatePiSdkWorkerResult("login", { ok: true, providerId: "anthropic" })).toBeNull();
    expect(validatePiSdkWorkerResult("login", { providerId: "anthropic" })).toMatch(/ok/u);
  });
});
