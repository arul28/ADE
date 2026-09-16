import { describe, expect, it } from "vitest";
import {
  classifyProviderRetryCause,
  formatLegacyProviderRetryActivityDetail,
  formatProviderRetryActivityDetail,
  isLegacyProviderRetryNotice,
  isProviderRetryActivityEvent,
} from "./providerRetryPresentation";

describe("provider retry presentation", () => {
  it("uses compact provider-neutral copy for structured retry metadata", () => {
    expect(formatProviderRetryActivityDetail({
      provider: "claude",
      attempt: 6,
      maxAttempts: 10,
      retryDelayMs: 8_000,
      cause: "network",
    })).toBe("Reconnecting to Claude · attempt 6 of 10 · retrying in 8s");
  });

  it("does not invent counts when a provider omits them", () => {
    expect(formatProviderRetryActivityDetail({ provider: "qwen", cause: "unknown" }))
      .toBe("Retrying Qwen");
  });

  it("classifies transport, quota, and server failures without copying raw errors", () => {
    expect(classifyProviderRetryCause("Falling back from WebSockets to HTTPS transport, request timed out")).toBe("transport");
    expect(classifyProviderRetryCause("request rejected", 429)).toBe("rate_limit");
    expect(classifyProviderRetryCause("rate_limit")).toBe("rate_limit");
    expect(classifyProviderRetryCause("upstream unavailable", 503)).toBe("server");
  });

  it("recognizes and compacts legacy retry notices for replay", () => {
    const event = {
      type: "system_notice" as const,
      noticeKind: "provider_health" as const,
      message: "Codex hit a provider error and is retrying automatically.",
      detail: "Temporary upstream failure.",
    };
    expect(isLegacyProviderRetryNotice(event)).toBe(true);
    expect(formatLegacyProviderRetryActivityDetail(event)).toBe("Retrying Codex");
    expect(isLegacyProviderRetryNotice({
      ...event,
      message: "Context limit reached — OpenCode will try to compact the conversation.",
    })).toBe(false);
    expect(isLegacyProviderRetryNotice({
      ...event,
      noticeKind: "rate_limit",
      message: "Rate limited. Retrying in 30s...",
    })).toBe(false);
    expect(isLegacyProviderRetryNotice({
      ...event,
      message: "Provider health retrying",
    })).toBe(false);
    expect(isLegacyProviderRetryNotice({
      ...event,
      message: "ACP hit a provider error and is retrying automatically.",
    })).toBe(false);
    expect(isLegacyProviderRetryNotice({
      ...event,
      message: "OpenCode hit a provider error and is retrying automatically (attempt 2).",
    })).toBe(true);
  });

  it("requires an explicit marker instead of guessing from free-form activity text", () => {
    expect(isProviderRetryActivityEvent({
      type: "activity",
      activity: "working",
      detail: "Reconnecting to GitHub Copilot · attempt 2",
      providerRetry: true,
    })).toBe(true);
    expect(isProviderRetryActivityEvent({
      type: "activity",
      activity: "running_command",
      detail: "Retrying failed test shard",
    })).toBe(false);
    expect(isProviderRetryActivityEvent({
      type: "activity",
      activity: "working",
      detail: "Reconnecting to GitHub Copilot · attempt 2",
    })).toBe(false);
  });
});
