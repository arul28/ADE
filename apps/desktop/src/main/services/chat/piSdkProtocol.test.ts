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
