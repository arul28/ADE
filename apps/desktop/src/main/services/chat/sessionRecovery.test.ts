import { describe, expect, it, vi } from "vitest";
import {
  canAttemptRecovery,
  createRecoveryNoticeEvent,
  createRecoveryState,
  getRecoveryBackoffMs,
  isRecoverableError,
  markRecoveryAttempt,
  markRecoveryComplete,
  markRecoverySuccess,
  resetRecoveryState,
  type RecoveryState,
} from "./sessionRecovery";

describe("createRecoveryState", () => {
  it("returns a fresh state with zero attempts and no error", () => {
    const state = createRecoveryState();
    expect(state).toEqual({
      attempts: 0,
      lastAttemptAt: 0,
      recovering: false,
      lastError: null,
    });
  });

  it("returns a new object on each call", () => {
    const a = createRecoveryState();
    const b = createRecoveryState();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("canAttemptRecovery", () => {
  it("allows recovery on a fresh state", () => {
    expect(canAttemptRecovery(createRecoveryState())).toBe(true);
  });

  it("disallows recovery when already recovering", () => {
    const state: RecoveryState = {
      attempts: 0,
      lastAttemptAt: 0,
      recovering: true,
      lastError: null,
    };
    expect(canAttemptRecovery(state)).toBe(false);
  });

  it("disallows recovery after max attempts (3)", () => {
    const state: RecoveryState = {
      attempts: 3,
      lastAttemptAt: Date.now(),
      recovering: false,
      lastError: "some error",
    };
    expect(canAttemptRecovery(state)).toBe(false);
  });

  it("allows recovery with 1 or 2 attempts used", () => {
    expect(canAttemptRecovery({ attempts: 1, lastAttemptAt: Date.now(), recovering: false, lastError: "err" })).toBe(true);
    expect(canAttemptRecovery({ attempts: 2, lastAttemptAt: Date.now(), recovering: false, lastError: "err" })).toBe(true);
  });

  it("disallows recovery when attempts exceed max and cooldown has not elapsed", () => {
    const state: RecoveryState = {
      attempts: 5,
      lastAttemptAt: Date.now(),
      recovering: false,
      lastError: "old error",
    };
    expect(canAttemptRecovery(state)).toBe(false);
  });

  it("allows recovery after max attempts once cooldown has elapsed", () => {
    const state: RecoveryState = {
      attempts: 3,
      lastAttemptAt: Date.now() - 31_000, // past the 30s cooldown
      recovering: false,
      lastError: "some error",
    };
    expect(canAttemptRecovery(state)).toBe(true);
  });
});

describe("getRecoveryBackoffMs", () => {
  it("returns base backoff (2000ms) on first attempt", () => {
    expect(getRecoveryBackoffMs({ attempts: 0, lastAttemptAt: 0, recovering: false, lastError: null })).toBe(2000);
  });

  it("doubles each attempt via exponential backoff", () => {
    expect(getRecoveryBackoffMs({ attempts: 1, lastAttemptAt: 0, recovering: false, lastError: null })).toBe(4000);
    expect(getRecoveryBackoffMs({ attempts: 2, lastAttemptAt: 0, recovering: false, lastError: null })).toBe(8000);
    expect(getRecoveryBackoffMs({ attempts: 3, lastAttemptAt: 0, recovering: false, lastError: null })).toBe(16000);
  });

  it("caps the exponent at 4 regardless of attempt count", () => {
    const at4 = getRecoveryBackoffMs({ attempts: 4, lastAttemptAt: 0, recovering: false, lastError: null });
    const at10 = getRecoveryBackoffMs({ attempts: 10, lastAttemptAt: 0, recovering: false, lastError: null });
    expect(at4).toBe(32000);
    expect(at10).toBe(32000);
  });
});

describe("markRecoveryAttempt", () => {
  it("increments attempts and sets recovering to true", () => {
    const before = createRecoveryState();
    const after = markRecoveryAttempt(before, "connection lost");
    expect(after.attempts).toBe(1);
    expect(after.recovering).toBe(true);
    expect(after.lastError).toBe("connection lost");
    expect(after.lastAttemptAt).toBeGreaterThan(0);
  });

  it("returns a new object without mutating the original", () => {
    const before = createRecoveryState();
    const after = markRecoveryAttempt(before, "fail");
    expect(before.attempts).toBe(0);
    expect(before.recovering).toBe(false);
    expect(after).not.toBe(before);
  });

  it("correctly increments from existing attempts", () => {
    let state = createRecoveryState();
    state = markRecoveryAttempt(state, "err1");
    state = markRecoveryComplete(state);
    state = markRecoveryAttempt(state, "err2");
    expect(state.attempts).toBe(2);
    expect(state.lastError).toBe("err2");
  });
});

describe("markRecoveryComplete", () => {
  it("sets recovering to false without changing attempts", () => {
    const recovering: RecoveryState = {
      attempts: 2,
      lastAttemptAt: Date.now(),
      recovering: true,
      lastError: "timeout",
    };
    const done = markRecoveryComplete(recovering);
    expect(done.recovering).toBe(false);
    expect(done.attempts).toBe(2);
    expect(done.lastError).toBe("timeout");
  });

  it("returns a new object", () => {
    const before: RecoveryState = { attempts: 1, lastAttemptAt: 0, recovering: true, lastError: "x" };
    const after = markRecoveryComplete(before);
    expect(after).not.toBe(before);
    expect(before.recovering).toBe(true);
  });
});

describe("markRecoverySuccess", () => {
  it("resets attempts to 0, clears error, and stops recovering", () => {
    const state: RecoveryState = {
      attempts: 3,
      lastAttemptAt: Date.now(),
      recovering: true,
      lastError: "was broken",
    };
    const success = markRecoverySuccess(state);
    expect(success.attempts).toBe(0);
    expect(success.recovering).toBe(false);
    expect(success.lastError).toBeNull();
    // lastAttemptAt is preserved from original state
    expect(success.lastAttemptAt).toBe(state.lastAttemptAt);
  });
});

describe("resetRecoveryState", () => {
  it("returns the same object when already clean", () => {
    const clean = createRecoveryState();
    const result = resetRecoveryState(clean);
    expect(result).toBe(clean);
  });

  it("returns a fresh state when attempts > 0", () => {
    const dirty: RecoveryState = { attempts: 2, lastAttemptAt: 500, recovering: false, lastError: "err" };
    const result = resetRecoveryState(dirty);
    expect(result).toEqual(createRecoveryState());
    expect(result).not.toBe(dirty);
  });

  it("returns a fresh state when recovering is true", () => {
    const busy: RecoveryState = { attempts: 0, lastAttemptAt: 0, recovering: true, lastError: null };
    const result = resetRecoveryState(busy);
    expect(result).toEqual(createRecoveryState());
  });
});

describe("isRecoverableError", () => {
  describe("terminal errors (not recoverable)", () => {
    it.each([
      "Authentication failed for API",
      "Unauthorized access to resource",
      "Invalid API key provided",
      "Billing issue: payment required",
      "Quota exceeded for this model",
      "Rate limit reached, try later",
      "Permission denied: cannot access",
      "Access denied to this resource",
      "Model not found in registry",
      "Command not found: claude-cli",
    ])("returns false for terminal error: %s", (msg) => {
      expect(isRecoverableError(msg)).toBe(false);
    });
  });

  describe("recoverable errors (transient)", () => {
    it.each([
      "ECONNRESET: connection was reset",
      "ECONNREFUSED: server not available",
      "EPIPE: broken pipe in stream",
      "spawn ENOENT: process not found",
      "Process received SIGTERM",
      "Process received SIGKILL",
      "Process exited with code 1",
      "Child process crashed unexpectedly",
      "Request timeout exceeded 30s",
      "Connection timed out after 10s",
      "Stream closed unexpectedly",
      "Stream ended prematurely",
      "Stream was destroyed by peer",
      "Unexpected end of JSON input",
      "Connection closed by server",
    ])("returns true for recoverable error: %s", (msg) => {
      expect(isRecoverableError(msg)).toBe(true);
    });
  });

  it("accepts Error objects in addition to strings", () => {
    expect(isRecoverableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRecoverableError(new Error("Authentication failed"))).toBe(false);
  });

  it("defaults to recoverable for unknown errors", () => {
    expect(isRecoverableError("Some unknown internal error occurred")).toBe(true);
    expect(isRecoverableError("")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isRecoverableError("AUTHENTICATION FAILED")).toBe(false);
    expect(isRecoverableError("econnreset")).toBe(true);
  });
});

describe("createRecoveryNoticeEvent", () => {
  it("creates an 'attempting' notice with attempt count", () => {
    const event = createRecoveryNoticeEvent({
      attempt: 1,
      maxAttempts: 3,
      error: "connection lost",
      status: "attempting",
    });
    expect(event).toEqual({
      type: "system_notice",
      noticeKind: "provider_health",
      message: "Reconnecting to agent (attempt 1/3)...",
      detail: undefined,
    });
  });

  it("creates a 'succeeded' notice", () => {
    const event = createRecoveryNoticeEvent({
      attempt: 2,
      maxAttempts: 3,
      error: "timeout",
      status: "succeeded",
    });
    expect(event).toEqual({
      type: "system_notice",
      noticeKind: "provider_health",
      message: "Successfully reconnected to agent.",
      detail: undefined,
    });
  });

  it("creates a 'failed' notice with error detail", () => {
    const event = createRecoveryNoticeEvent({
      attempt: 3,
      maxAttempts: 3,
      error: "ECONNREFUSED",
      status: "failed",
    });
    expect(event).toEqual({
      type: "system_notice",
      noticeKind: "provider_health",
      message: "Failed to reconnect after 3 attempts: ECONNREFUSED",
      detail: "ECONNREFUSED",
    });
  });

  it("only includes detail for failed status", () => {
    const attempting = createRecoveryNoticeEvent({ attempt: 1, maxAttempts: 3, error: "err", status: "attempting" });
    const succeeded = createRecoveryNoticeEvent({ attempt: 1, maxAttempts: 3, error: "err", status: "succeeded" });
    const failed = createRecoveryNoticeEvent({ attempt: 1, maxAttempts: 3, error: "err", status: "failed" });
    expect(attempting.detail).toBeUndefined();
    expect(succeeded.detail).toBeUndefined();
    expect(failed.detail).toBe("err");
  });
});
