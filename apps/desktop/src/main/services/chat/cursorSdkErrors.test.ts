import { describe, expect, it } from "vitest";
import { cursorSdkResultWithStreamFailure, isCursorSdkSandboxUnsupportedError } from "./cursorSdkErrors";
import { classifyCursorSdkErrorText, isCursorSdkTransportErrorText } from "./cursorSdkProtocol";

describe("isCursorSdkSandboxUnsupportedError", () => {
  it("matches the SDK ConfigurationError when sandboxing is unavailable", () => {
    expect(isCursorSdkSandboxUnsupportedError(new Error(
      "Local SDK sandboxing was requested, but sandboxing is not supported in this environment. Disable local.sandboxOptions.enabled or remove ~/.cursor/sandbox.json to run without sandboxing.",
    ))).toBe(true);
    const named = new Error("sandbox requested");
    named.name = "ConfigurationError";
    expect(isCursorSdkSandboxUnsupportedError(named)).toBe(true);
  });

  it("does not treat unrelated configuration errors as sandbox-unsupported", () => {
    expect(isCursorSdkSandboxUnsupportedError(new Error(
      "Unknown tool name \"not-a-tool\" in AgentOptions.tools",
    ))).toBe(false);
    expect(isCursorSdkSandboxUnsupportedError(new Error("invalid model"))).toBe(false);
  });
});

describe("classifyCursorSdkErrorText", () => {
  it("classifies write ECANCELED as a transport failure", () => {
    // The 2026-08-11 incident: this killed a run and poisoned the agent thread.
    expect(isCursorSdkTransportErrorText("[internal] write ECANCELED")).toBe(true);
    expect(classifyCursorSdkErrorText("[internal] write ECANCELED")).toBe("network");
  });

  it("classifies the other socket teardown errors as transport failures", () => {
    for (const text of ["write EPIPE", "Error [ERR_STREAM_WRITE_AFTER_END]: write after end"]) {
      expect(classifyCursorSdkErrorText(text)).toBe("network");
    }
  });

  it("still prefers backoff classification over transport for rate-limited stream closures", () => {
    expect(classifyCursorSdkErrorText(
      "[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
    )).toBe("rate_limit");
  });
});

describe("cursorSdkResultWithStreamFailure", () => {
  it("marks successful wait results as errors after a stream failure", () => {
    const result = cursorSdkResultWithStreamFailure(
      {
        id: "run-1",
        requestId: "req-1",
        status: "finished",
        result: "partial result",
      },
      { message: "Stream closed with error code NGHTTP2_INTERNAL_ERROR", code: "network" },
      "local",
    );

    expect(result).toMatchObject({
      id: "run-1",
      requestId: "req-1",
      status: "error",
      result: "partial result",
      error: {
        message: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
        code: "network",
      },
    });
  });

  it("leaves existing SDK error results unchanged", () => {
    const result = {
      id: "run-2",
      status: "error",
      error: { message: "SDK failed", code: "resource_exhausted" },
    };

    expect(cursorSdkResultWithStreamFailure(result, { message: "stream failed" }, "cloud")).toBe(result);
  });
});
