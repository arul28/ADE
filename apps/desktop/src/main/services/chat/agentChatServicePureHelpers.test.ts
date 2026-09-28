import {
  ComputerUseBackendStatus,
  buildComputerUseDirective,
  buildLinearSessionDirective,
  codexServerSupportsForkBeforeTurn,
  computerUseDirectiveFingerprint,
  createAgentChatService,
  fs,
  os,
  parseCodexServerVersion,
  path,
  restartRecoveryStopAttribution,
  startup,
  writeSessionLinearIssueContextFile,
} from "./agentChatService.testHarness";
import { beforeEach, describe, expect, it } from "vitest";

describe("Codex server version gating", () => {
  it.each([
    ["codex/0.144.5 (Mac OS 15.0)", { major: 0, minor: 144, patch: 5 }],
    ["codex/0.145.0-alpha.19", { major: 0, minor: 145, patch: 0 }],
    ["garbage", null],
    [undefined, null],
  ])("parses %s", (userAgent, expected) => {
    expect(parseCodexServerVersion(userAgent)).toEqual(expected);
  });

  it.each([
    [{ major: 0, minor: 144, patch: 5 }, false],
    [{ major: 0, minor: 145, patch: 0 }, true],
    [{ major: 0, minor: 146, patch: 0 }, true],
    [null, false],
  ])("gates fork-before-turn support for %o", (version, expected) => {
    expect(codexServerSupportsForkBeforeTurn(version)).toBe(expected);
  });
});

// ============================================================================
// buildComputerUseDirective (exported standalone)
// ============================================================================

describe("buildComputerUseDirective", () => {
  function makeBackendStatus(
    overrides: Partial<{ ghostOs: boolean; agentBrowser: boolean; localFallback: boolean }> = {},
  ): ComputerUseBackendStatus {
    const backends: ComputerUseBackendStatus["backends"] = [];
    if (overrides.ghostOs) {
      backends.push({
        name: "Ghost OS",
        available: true,
        state: "installed",
        detail: "Ghost OS connected.",
        supportedKinds: ["screenshot"],
      });
    }
    if (overrides.agentBrowser) {
      backends.push({
        name: "agent-browser",
        available: true,
        state: "installed",
        detail: "agent-browser CLI installed.",
        supportedKinds: ["screenshot"],
      });
    }
    return {
      backends,
      localFallback: {
        available: overrides.localFallback ?? false,
        detail: overrides.localFallback
          ? "ADE local computer-use tools available."
          : "ADE local fallback missing.",
        supportedKinds: overrides.localFallback ? ["screenshot"] : [],
      },
    };
  }

  it("returns null when no backends, no local fallback, and status is non-null", () => {
    const status = makeBackendStatus({});
    const result = buildComputerUseDirective(status);
    expect(result).toBeNull();
  });

  it("tells every agent the user's own apps are not its to close or reset", () => {
    // 2026-09-23: a plain "record opening Safari" quit the user's own Safari
    // with ⌘Q to get a "clean" start.
    const result = buildComputerUseDirective(makeBackendStatus({ localFallback: true }))!;
    expect(result).toMatch(/Never close, quit, hide, minimize or reset an app or window you did not open/);
  });

  it("sends a Mac host's agent to the lane screen first, and fences the real-screen tools", () => {
    const result = buildComputerUseDirective(makeBackendStatus({ localFallback: true }), {
      macDesktopAvailable: true,
    })!;
    expect(result).toContain("### Mac Desktop — this lane's own screen (use it for desktop apps)");
    // Web work goes to ADE's browser unless the user names a desktop browser.
    expect(result).toContain("use ADE's built-in browser (`ade browser`, the **ade-browser** skill) by default");
    expect(result).toContain("only when the user names that app or asks for the Mac Desktop");
    // `open` is a blank copy that shares the app's data; `stop` quits what the lane opened.
    expect(result).toContain("`open` starts a separate, blank copy of the app");
    expect(result).toContain("shares that app's data (cookies, history) with the user");
    expect(result).toContain("`ade mac-desktop stop` quits the apps the lane opened");
    expect(result).toContain("ade mac-desktop record start --caption");
    expect(result).toMatch(/do not fall back to the user's real screen/);
    // Same words as the Apple lane hint: an ok result is not a confirmed step,
    // and a failed recording is reported, never swapped for an older one.
    expect(result).toContain("an ok result only means the input was sent");
    expect(result).toContain("Confirm the final state before `record stop`");
    expect(result).toContain("Never attach an older recording or a file you did not just record.");
    expect(result).toContain("`type \"<text>\" --submit`");
    expect(result).toContain("`ade mac-desktop show`");
    // Viewing the screen no longer starts it.
    expect(result).toContain("viewing the screen does not start it");
    // A login shell can put an installed, older `ade` first on PATH.
    expect(result).toContain("$ADE_CLI_PATH");
    // The Codex/OpenAI computer-use plugin drives the real screen: only on request.
    expect(result).toMatch(/`mcp__computer_use`[^\n]*drives the user's real screen/);
    // Proof of desktop work is the lane screen. The user's screen is an explicit flag.
    expect(result).toMatch(/capture the lane's screen/);
    expect(result).toMatch(/--real-screen/);
    expect(result).not.toMatch(/`ade proof capture` and `ade proof record` capture the user's whole real screen/);
  });

  it("says nothing about a lane screen on a host that cannot give one", () => {
    const result = buildComputerUseDirective(makeBackendStatus({ localFallback: true }))!;
    expect(result).not.toContain("Mac Desktop");
    expect(result).toMatch(/`ade proof capture` and `ade proof record` are refused/);
    expect(result).toMatch(/--real-screen/);
  });

  it("emits no directive when no artifact broker is attached", () => {
    // `getBackendStatus()` is synchronous and never returns null, so a null
    // status means the session has no artifact broker — no backends, no local
    // fallback, no capability. This used to default `hasLocalFallback` to true
    // and emit the full 2KB directive anyway, telling the agent it could
    // capture proof on a session that could not. The broker attaches later in
    // startup, and the fingerprint gate re-sends the directive at that point.
    expect(buildComputerUseDirective(null)).toBeNull();
  });

  it("still describes the local fallback when it is the only capability", () => {
    const result = buildComputerUseDirective(
      makeBackendStatus({ ghostOs: false, agentBrowser: false, localFallback: true }),
    );
    expect(result).not.toBeNull();
    expect(result).toContain("Computer Use");
    expect(result).toContain("get_computer_use_backend_status");
    expect(result).toContain("If it is not exposed, do not stall");
    expect(result).toContain("Respect the backend the user requested");
    expect(result).toContain("mcp__computer_use");
    expect(result).toContain("do not bootstrap `@oai/sky`");
    expect(result).toContain("does not passively ingest");
  });

  it("gives one rendering one fingerprint, and a changed capability set a new one", () => {
    const localOnly = buildComputerUseDirective(
      makeBackendStatus({ ghostOs: false, agentBrowser: false, localFallback: true }),
    );
    const withGhostOs = buildComputerUseDirective(makeBackendStatus({ ghostOs: true }));
    expect(localOnly).not.toBeNull();
    expect(withGhostOs).not.toBeNull();
    expect(computerUseDirectiveFingerprint(localOnly!)).toBe(
      computerUseDirectiveFingerprint(localOnly!),
    );
    expect(computerUseDirectiveFingerprint(localOnly!)).not.toBe(
      computerUseDirectiveFingerprint(withGhostOs!),
    );
  });

  it("includes Ghost OS section when Ghost OS backend is available", () => {
    const status = makeBackendStatus({ ghostOs: true });
    const result = buildComputerUseDirective(status);
    expect(result).toContain("Ghost OS (Desktop Automation)");
    expect(result).toContain("ghost_context");
    expect(result).toContain("ghost_annotate");
  });

  it("includes agent-browser section when agent-browser is available", () => {
    const status = makeBackendStatus({ agentBrowser: true });
    const result = buildComputerUseDirective(status);
    expect(result).toContain("agent-browser (Browser Automation)");
    expect(result).not.toContain("Ghost OS (Desktop Automation)");
  });

  it("includes ADE Local fallback section when local fallback is enabled", () => {
    const status = makeBackendStatus({ localFallback: true });
    const result = buildComputerUseDirective(status);
    expect(result).toContain("ADE Local (Fallback)");
    expect(result).toContain("Proof Capture");
  });

  it("always includes Proof Capture section when directive is non-null", () => {
    const status = makeBackendStatus({ ghostOs: true });
    const result = buildComputerUseDirective(status);
    expect(result).toContain("Proof Capture");
    expect(result).toContain("ade proof");
    expect(result).toContain("ingest_computer_use_artifacts");
    expect(result).toContain("capture visual proof first");
    expect(result).toContain("Console logs and text files are supporting diagnostics only");
  });
});

describe("writeSessionLinearIssueContextFile", () => {
  function makeSessionLink(overrides: Record<string, unknown> = {}) {
    return {
      id: "link-1",
      sessionId: "sess-1",
      laneId: null,
      role: "worked",
      source: "chat_attach",
      includeInPr: true,
      closeOnMerge: false,
      evidence: null,
      createdAt: "2026-05-20T10:00:00.000Z",
      updatedAt: "2026-05-20T10:00:00.000Z",
      issue: {
        id: "issue-1",
        identifier: "ENG-431",
        title: "Fix OAuth refresh",
        url: "https://linear.app/acme/issue/ENG-431",
        stateName: "In Progress",
        teamKey: "ENG",
      },
      ...overrides,
    } as any;
  }

  let contextRoot: string;
  beforeEach(() => {
    contextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-linear-context-"));
  });

  it("writes a context file and returns env-ready ids when links exist", () => {
    const result = writeSessionLinearIssueContextFile({
      contextDir: contextRoot,
      sessionId: "sess-1",
      links: [
        makeSessionLink(),
        makeSessionLink({ id: "link-2", issue: { ...makeSessionLink().issue, id: "issue-2", identifier: "ENG-440" } }),
      ],
      now: "2026-05-20T11:00:00.000Z",
    });

    expect(result).not.toBeNull();
    expect(result!.identifiers).toBe("ENG-431,ENG-440");
    expect(result!.issueIds).toBe("issue-1,issue-2");
    expect(result!.filePath).toBe(path.join(contextRoot, "sess-1", "linear-issues.json"));

    const written = JSON.parse(fs.readFileSync(result!.filePath, "utf8"));
    expect(written.sessionId).toBe("sess-1");
    expect(written.updatedAt).toBe("2026-05-20T11:00:00.000Z");
    expect(written.issues).toHaveLength(2);
    expect(written.issues[0]).toEqual(expect.objectContaining({
      id: "issue-1",
      identifier: "ENG-431",
      role: "worked",
      teamKey: "ENG",
    }));
  });

  it("returns null and removes a stale file when there are no links", () => {
    const filePath = path.join(contextRoot, "sess-1", "linear-issues.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{\"stale\":true}");

    const result = writeSessionLinearIssueContextFile({
      contextDir: contextRoot,
      sessionId: "sess-1",
      links: [],
      now: "2026-05-20T11:00:00.000Z",
    });

    expect(result).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe("buildLinearSessionDirective", () => {
  function makeLink(identifier: string) {
    return { issue: { identifier } } as any;
  }

  it("returns null when there are no attached issues", () => {
    expect(buildLinearSessionDirective([])).toBeNull();
  });

  it("returns null when no link carries a usable identifier", () => {
    expect(buildLinearSessionDirective([{ issue: { identifier: "" } } as any])).toBeNull();
  });

  it("steers the agent to `ade linear` over MCP and lists the deduped identifiers", () => {
    const directive = buildLinearSessionDirective([
      makeLink("ENG-12"),
      makeLink("ENG-34"),
      makeLink("ENG-12"),
    ]);
    expect(directive).toContain("Linear-tracked work");
    expect(directive).toContain("ENG-12, ENG-34");
    // Deduped — the repeated identifier appears once.
    expect(directive?.match(/ENG-12/g)).toHaveLength(1);
    expect(directive).toContain("ade linear");
    expect(directive).toContain("Prefer `ade linear`");
    expect(directive).toContain("ade-linear");
    expect(directive).toContain("ade-deeplinks");
  });
});

// ============================================================================
// createAgentChatService factory
// ============================================================================

describe("restartRecoveryStopAttribution", () => {
  it("marks a different bound socket as a foreign-brain takeover", () => {
    expect(restartRecoveryStopAttribution({
      ownerSocketPath: "/tmp/ade-primary.sock",
      selfSocketPath: "/tmp/ade-secondary.sock",
    })).toEqual({
      stopSource: "foreign-brain",
      stopReason: "another ADE brain took over this chat",
    });
  });

  it("marks the same bound socket as a restarted system runtime", () => {
    expect(restartRecoveryStopAttribution({
      ownerSocketPath: "/tmp/ade.sock",
      selfSocketPath: "/tmp/ade.sock",
    })).toEqual({
      stopSource: "system",
      stopReason: "the ADE brain restarted",
    });
  });

  it("folds case differences in Windows named-pipe paths", () => {
    const previousPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(restartRecoveryStopAttribution({
        ownerSocketPath: String.raw`\\.\PIPE\ADE`,
        selfSocketPath: String.raw`\\.\pipe\ade`,
      })).toEqual({
        stopSource: "system",
        stopReason: "the ADE brain restarted",
      });
    } finally {
      Object.defineProperty(process, "platform", { value: previousPlatform, configurable: true });
    }
  });
});
