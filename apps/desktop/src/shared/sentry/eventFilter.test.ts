import { afterEach, describe, expect, it } from "vitest";
import { createSentryEventHooks, setSentryUserResolver } from "./eventFilter";

type TestEvent = Record<string, any>;

function errorEvent(value: string, extra: Partial<TestEvent> = {}): TestEvent {
  return { exception: { values: [{ type: "Error", value }] }, ...extra };
}

afterEach(() => setSentryUserResolver(null));

describe("createSentryEventHooks", () => {
  it("keeps what makes a report actionable and removes secrets, user content and personal data", () => {
    setSentryUserResolver(() => "install-123");
    const hooks = createSentryEventHooks();
    const event = errorEvent("push failed for ghp_abcdefghijklmnopqrstuvwxyz0123 in src/host/tunnel.ts", {
      exception: {
        values: [{
          type: "Error",
          value: "push failed for ghp_abcdefghijklmnopqrstuvwxyz0123 in src/host/tunnel.ts",
          stacktrace: { frames: [{ filename: "app.js", vars: { apiKey: "secret-value" } }] },
        }],
      },
      extra: { prompt: "write me a poem", inputTokens: 42, accessToken: "abc", laneId: "lane-1" },
      request: {
        url: "https://relay.ade-app.dev/host/MACHINEKEY123/ws?token=t0k&lane=1",
        cookies: { session: "s" },
        data: "body",
        query_string: "token=t0k",
      },
      user: { id: "ignored", email: "a@b.c", ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "GET https://hooks.ade-app.dev/hooks/abc/def-token", data: { authorization: "Bearer x" } }],
    });

    const sent = hooks.beforeSend(event) as TestEvent;

    const value = sent.exception.values[0];
    expect(value.value).toBe("push failed for [redacted] in src/host/tunnel.ts");
    expect(value.stacktrace.frames[0]).toEqual({ filename: "app.js" });
    expect(sent.extra).toEqual({ prompt: "[content: 15 chars]", inputTokens: 42, accessToken: "[redacted]", laneId: "lane-1" });
    expect(sent.request).toEqual({ url: "https://relay.ade-app.dev/host/[key]/ws?token=[redacted]&lane=1" });
    expect(sent.user).toEqual({ id: "install-123" });
    expect(sent.breadcrumbs[0]).toEqual({
      message: "GET https://hooks.ade-app.dev/hooks/[id]/[token]",
      data: { authorization: "[redacted]" },
    });
  });

  it("scrubs spans and breadcrumbs, which never pass beforeSend", () => {
    const hooks = createSentryEventHooks();
    const span = hooks.beforeSendSpan({
      name: "GET https://relay.ade-app.dev/machines/MACHINEKEY123/status",
      attributes: {
        "url.path": "/connect/MACHINEKEY123",
        "http.route": { value: "/hooks/hook-id/hook-token" },
        "code.filepath": "src/host/tunnel.ts",
        "http.response.status_code": 200,
      },
    });
    expect(span).toEqual({
      name: "GET https://relay.ade-app.dev/machines/[key]/status",
      attributes: {
        "url.path": "/connect/[key]",
        "http.route": { value: "/hooks/[id]/[token]" },
        "code.filepath": "src/host/tunnel.ts",
        "http.response.status_code": 200,
      },
    });

    expect(hooks.beforeBreadcrumb({ category: "console", message: "anything a library printed" })).toBeNull();
    expect(hooks.beforeBreadcrumb({ category: "fetch", data: { url: "https://x.dev/a?api_key=k123" } }))
      .toEqual({ category: "fetch", data: { url: "https://x.dev/a?api_key=[redacted]" } });
  });

  it("sends the first copies of a problem, not the thousandth, and gives crashes their own budget", () => {
    const hooks = createSentryEventHooks();
    const send = (fingerprint: string, level?: string) =>
      hooks.beforeSend(errorEvent("boom", { fingerprint: [fingerprint], ...(level ? { level } : {}) })) !== null;

    expect(Array.from({ length: 7 }, () => send("repeat"))).toEqual([true, true, true, true, true, false, false]);
    // Fill the hourly total with distinct problems; a new one is then dropped.
    const distinct = Array.from({ length: 60 }, (_, index) => send(`distinct-${index}`));
    expect(distinct.filter(Boolean)).toHaveLength(55);
    expect(send("brand-new")).toBe(false);
    // Crashes still go through, up to their own per-problem limit.
    const crashes = Array.from({ length: 12 }, () => send("crash", "fatal"));
    expect(crashes.filter(Boolean)).toHaveLength(10);
  });

  it.each([
    ["the renderer's copy of a failed IPC call", "Error invoking remote method 'ade.lanes.list': Error: boom", true],
    ["an IPC call that has no handler in main", "Error invoking remote method 'ade.x': Error: No handler registered for 'ade.x'", false],
    ["a ResizeObserver loop", "ResizeObserver loop completed with undelivered notifications.", true],
    ["an aborted navigation", "ERR_ABORTED (-3) loading 'https://example.com/'", true],
    ["sync being off", "Sync service is not available", true],
    ["too many open files", "EMFILE: too many open files, watch", false],
    ["an ordinary error", "Cannot read properties of undefined (reading 'id')", false],
    ["a lane deleted while a view held its id", "Lane not found: 6f2c0b1e", true],
    ["a paired machine that is asleep", "Can't reach MacBook Pro — it may be asleep or ADE may be stopped there.", true],
    ["a dirty worktree, wherever it is quoted", "Error: DIRTY_WORKTREE: Uncommitted changes detected in a.ts.", true],
    ["a GitHub outage", "GitHub API request failed (HTTP 502)", true],
    ["a GitHub client error, which is ADE's", "GitHub API request failed (HTTP 422)", false],
  ])("drops expected outcomes: %s", (_label, value, dropped) => {
    const hooks = createSentryEventHooks();
    expect(hooks.beforeSend(errorEvent(value)) === null).toBe(dropped);
  });

  it("keeps a crash whose cause is an expected outcome", () => {
    const hooks = createSentryEventHooks();
    const crash = {
      level: "fatal",
      exception: { values: [
        { type: "Error", value: "Lane not found: 6f2c0b1e" },
        { type: "TypeError", value: "Cannot read properties of undefined (reading 'worktreePath')" },
      ] },
    };
    expect(hooks.beforeSend(crash)).not.toBeNull();
    expect(hooks.beforeSend({ level: "fatal", message: "Lane not found: 6f2c0b1e" })).toBeNull();
  });
});
