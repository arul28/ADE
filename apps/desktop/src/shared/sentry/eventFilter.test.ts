import { afterEach, describe, expect, it } from "vitest";
import { enableSentryDiagnostics, recordLogTailLine } from "./diagnostics";
import { createSentryEventHooks, setSentryUserResolver } from "./eventFilter";
import { codedError } from "../codedError";
import { AdeExpectedError } from "../expectedError";
import { isExpectedOutcome } from "./expectedFailure";

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
    ["a screenshot cleaned up while a chat still shows it", "Path does not exist: C:\p\.ade\cache\obs-1.png", true],
    ["any other missing file", "Path does not exist: /app/config.json", false],
    ["a path the renderer may not read", "Path is outside allowed directories.", false],
    ["an agent's bad selector", "Invalid element selector: [aria-label=6 more companies:]", true],
    ["an agent driving a lane with no screen", "MAC_DESKTOP_NO_DISPLAY: Lane l1 has no Mac Desktop screen. Start one first.", true],
    ["a desktop driver that crashed", "MAC_DESKTOP_DRIVER_CRASHED: helper exited", false],
    ["a remote machine that is slow to answer", "Remote ADE service timed out waiting for method ade/actions/call pr.refresh (30000ms).", true],
    ["a Mac-only surface asked for before the runtime connected", "Mac Desktop is not available on this machine.", true],
    ["the brain restarting for an update", "ADE is applying an update. The background service is restarting.", true],
    ["a project set to follow another machine", "This project is set to follow another ADE machine at 192.168.1.89:8788, so this machine cannot open it for sync. Open it on that machine, or stop following it on this computer: in Connections, under This computer, choose Stop following.", true],
    ["a sync-host activation overrunning its budget, which is ADE's", "Sync host activation for project_474a1c2f timed out after 10000ms.", false],
    ["a paired machine slow to answer an action", "IPC handler for 'ade.remoteRuntime.callAction' timed out after 75000ms (callId=12593)", true],
    ["a local call that hangs, which is ADE's", "IPC handler for 'ade.accountSettings.sync' timed out after 30000ms (callId=40553)", false],
    ["GitHub auth missing, desktop wording", "GitHub auth missing. Run `gh auth login -h github.com -s repo -s workflow` or add a personal access token in Settings.", true],
    ["GitHub auth missing, CLI wording", "GitHub auth missing. Set ADE_GITHUB_TOKEN/GITHUB_TOKEN, run `gh auth login -h github.com -s repo -s workflow`, or add a PAT in Settings.", true],
    ["a Windows private screen another session holds", "WINDOWS_DESKTOP_HELD: Another lane holds the private screen.", true],
    ["a Windows sign-in that failed", "WINDOWS_DESKTOP_SIGN_IN_FAILED: LogonUser returned 1326", false],
    ["an agent pointing App Control at a closed port", "APP_CONTROL_DEBUG_PORT_CLOSED: Nothing is listening at http://127.0.0.1:9222/json/list.", true],
    ["a local service refusing a connection", "connect ECONNREFUSED 127.0.0.1:64540", false],
    ["a remote machine the user disconnected", "Remote machine was manually disconnected. Connect again to use this remote project.", true],
    ["a Mac without Xcode", 'Command failed: xcrun simctl list devices available --json\nxcrun: error: unable to find utility "simctl", not a developer tool or in PATH', true],
    ["GitHub unreachable offline", "Can't reach GitHub (ENOTFOUND). Check this machine's network connection, then try again.", true],
    ["the account service behind a cut TLS handshake", "ADE can't reach its account service (TLS handshake cut off).", true],
    ["the account service not answering in time", "ADE's account service did not answer in time.", true],
    ["GitHub resetting a connection, which stays an issue", "Can't reach GitHub (ECONNRESET). Check this machine's network connection, then try again.", false],
    ["any other xcrun failure", "Command failed: xcrun simctl boot X\nAn error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60)", false],
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

  // undici reports every network failure as "fetch failed" and names the
  // reason only in its causes. Offline, or a network blocking ADE's relays, is
  // a state; a loopback target is a local ADE service that stopped answering.
  const relayTimeout = "Connect Timeout Error (attempted addresses: 108.160.167.158:443, timeout: 10000ms)";
  it.each([
    ["a relay connect timeout", [["ConnectTimeoutError", relayTimeout]], true],
    ["every relay address unreachable", [["Error", "connect ENETUNREACH 104.21.35.163:443"], ["Error", "connect EHOSTUNREACH 2606:4700:3037::ac43:b1a3:443"], ["AggregateError", ""]], true],
    ["a local service refusing the connection", [["Error", "connect ECONNREFUSED 127.0.0.1:64540"]], false],
    ["a local service on IPv6 loopback", [["Error", "connect ECONNREFUSED ::1:4096"]], false],
    ["a TLS handshake to a relay cut off", [["Error", "Client network socket disconnected before secure TLS connection was established"]], true],
    ["a reset that names no address", [["Error", "read ECONNRESET"]], false],
    ["no cause at all", [], false],
  ])("fetch failed: %s", (_label, causes, dropped) => {
    const hooks = createSentryEventHooks();
    const values = [...causes.map(([type, value]) => ({ type, value })), { type: "TypeError", value: "fetch failed" }];
    expect(hooks.beforeSend({ exception: { values } }) === null).toBe(dropped);
  });

  it.each([
    ["a relay connect timeout", () => Object.assign(new Error(relayTimeout), { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" }), true],
    ["every relay address unreachable", () => new AggregateError([Object.assign(new Error("connect ENETUNREACH 104.21.35.163:443"), { code: "ENETUNREACH" })]), true],
    ["a loopback socket closed mid-request", () => Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET", socket: { remoteAddress: "127.0.0.1" } }), false],
    ["a local service refusing the connection", () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:64540"), { code: "ECONNREFUSED" }), false],
    ["more causes than are read", () => new AggregateError(Array.from({ length: 40 }, () => new Error("connect ENETUNREACH 1.2.3.4:443"))), false],
  ])("a thrown fetch failed is an expected outcome only when offline: %s", (_label, cause, expected) => {
    const error = new TypeError("fetch failed", { cause: cause() });
    expect(isExpectedOutcome(error)).toBe(expected);
    // The same causes under any other message are never expected.
    expect(isExpectedOutcome(new TypeError("Cannot read properties of undefined", { cause: cause() }))).toBe(false);
  });

  // The typed mark (`shared/expectedError.ts`) silences an answer someone
  // caught and reported. It never silences an error nobody caught, or a crash.
  it("drops an error its throw site marked expected only when it was handled", () => {
    const hooks = createSentryEventHooks();
    // A message no pattern knows, so only the mark can drop it.
    const message = "Branch 'feature/x' not found locally or on any remote";
    const marked = new AdeExpectedError(message, "user");
    const handled = { exception: { values: [{ type: "Error", value: message, mechanism: { type: "generic", handled: true } }] } };
    const unhandled = { exception: { values: [{ type: "Error", value: message, mechanism: { type: "onunhandledrejection", handled: false } }] } };

    expect(hooks.beforeSend(handled, { originalException: marked })).toBeNull();
    expect(hooks.beforeSend(unhandled, { originalException: marked })).not.toBeNull();
    expect(hooks.beforeSend({ ...handled, level: "fatal" }, { originalException: marked })).not.toBeNull();
    expect(hooks.beforeSend(handled, { originalException: new Error(message) })).not.toBeNull();
  });

  it("reads an expected state from an error's code as well as its text", () => {
    expect(isExpectedOutcome(codedError("The project folder is gone.", "project_data_missing"))).toBe(true);
    // The same code after crossing the wire as a message prefix.
    expect(isExpectedOutcome(new Error("project_moving: This project is being moved."))).toBe(true);
    expect(isExpectedOutcome(codedError("The project folder is gone.", "project_corrupt"))).toBe(false);
  });

  // Last in the file: it turns diagnostics on for the rest of this process.
  it("attaches the log tail without its secrets, once per issue", () => {
    enableSentryDiagnostics();
    const pushToken = "pt_9f8e7d6c5b4a39281706f5e4"; // gitleaks:allow (a fake token the scrub must remove)
    const machineKey = "mk_live_0a1b2c3d4e5f60718293"; // gitleaks:allow (a fake key the scrub must remove)
    // A line past the cut: only a JSON line is scrubbed by key, and a cut one is no longer JSON.
    recordLogTailLine(JSON.stringify({ ts: "t1", level: "info", event: "sync.paired", meta: { pushToken, machineKey, devices: "d".repeat(4_000) } }));
    recordLogTailLine(JSON.stringify({ ts: "t2", level: "warn", event: "runtime.slow", meta: { action: "lane.list", accessToken: "short-secret-123" } }));
    const hooks = createSentryEventHooks();
    const firstHint: { attachments?: Array<{ filename: string; data: string | Uint8Array }> } = {};
    const repeatHint: typeof firstHint = {};
    const otherIssueHint: typeof firstHint = {};

    hooks.beforeSend(errorEvent("lane list failed"), firstHint);
    hooks.beforeSend(errorEvent("lane list failed"), repeatHint);
    hooks.beforeSend(errorEvent("chat send failed"), otherIssueHint);

    const tail = firstHint.attachments?.find((file) => file.filename.startsWith("ade-log-tail"));
    const text = String(tail?.data ?? "");
    expect(text).toContain('"event":"sync.paired"');
    expect(text).toContain('"action":"lane.list"');
    for (const secret of [pushToken, machineKey, "short-secret-123"]) expect(text).not.toContain(secret);
    expect(repeatHint.attachments).toBeUndefined();
    expect(otherIssueHint.attachments?.some((file) => file.filename.startsWith("ade-log-tail"))).toBe(true);
  });
});
