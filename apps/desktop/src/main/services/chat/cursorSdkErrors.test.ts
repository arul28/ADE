import { describe, expect, it } from "vitest";
import { cursorSdkResultWithStreamFailure, isCursorSdkSandboxUnsupportedError } from "./cursorSdkErrors";
import {
  CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT,
  classifyCursorSdkErrorText,
  isCursorSdkStaleAccessTokenText,
  isCursorSdkTransportErrorText,
  readCursorSdkStaleTokenFailure,
} from "./cursorSdkProtocol";

describe("readCursorSdkStaleTokenFailure", () => {
  it("reads the worker's terminal ERROR event into the failure the turn re-throws", () => {
    expect(readCursorSdkStaleTokenFailure({
      type: "status",
      status: "ERROR",
      adeErrorCode: CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT,
      adeErrorDetail: {
        message: `${CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT} Cursor request ID: req-9`,
        code: "unauthenticated",
        requestId: "req-9",
      },
    }, "turn-1")).toEqual({
      turnId: "turn-1",
      message: `${CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT} Cursor request ID: req-9`,
      code: "unauthenticated",
      requestId: "req-9",
    });
  });

  it("falls back to the code, then to the canonical text, when the detail is thin", () => {
    expect(readCursorSdkStaleTokenFailure({
      adeErrorCode: CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT,
    }, "turn-2")).toEqual({ turnId: "turn-2", message: CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT });
  });

  it("returns null for any other terminal error, so it is surfaced normally", () => {
    expect(readCursorSdkStaleTokenFailure({
      adeErrorCode: "Invalid API key",
      adeErrorDetail: { message: "Invalid API key", code: "unauthenticated" },
    }, "turn-3")).toBeNull();
    expect(readCursorSdkStaleTokenFailure(null, "turn-4")).toBeNull();
  });
});

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

describe("isCursorSdkStaleAccessTokenText", () => {
  it("matches the SDK's expired-access-token signature", () => {
    // Verbatim from the incidents: the SDK never re-exchanges the token for
    // this shape, so every later send on the same worker repeats it.
    const message = "Authentication error If you are logged in, try logging out and back in.";
    expect(isCursorSdkStaleAccessTokenText(message)).toBe(true);
    // It arrives as the structured `code` as often as the message, and the
    // detail carries a request id alongside it.
    expect(isCursorSdkStaleAccessTokenText(null, `Code: ${message}`, "Cursor request ID: abc-123")).toBe(true);
    // The category renderers see is unchanged.
    expect(classifyCursorSdkErrorText(message)).toBe("auth");
  });

  it("does not match auth failures a fresh worker cannot fix", () => {
    for (const text of [
      "Authentication failed: Invalid API key",
      "unauthorized",
      "403 Forbidden",
      "Authentication error",
    ]) {
      expect(isCursorSdkStaleAccessTokenText(text)).toBe(false);
    }
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
