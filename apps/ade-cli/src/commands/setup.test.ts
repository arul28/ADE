/**
 * One suite for the whole `ade setup` feature — orchestration (./setup),
 * terminal rendering (./setupRender), and desktop-app acquisition
 * (./setupDesktop). Kept in a single file rather than three siblings because
 * `src/commands/` is already over its per-folder test-file budget and these are
 * one feature, not three.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  SetupReporter,
  detectTerminalCapabilities,
  formatActiveLine,
  formatCompletedLine,
  renderSummary,
  type SetupStep,
  type TerminalCapabilities,
} from "./setupRender";
import {
  assetUrl,
  downloadWithResume,
  parseDesktopManifest,
  sha512Base64,
} from "./setupDesktop";
import { parseSetupArgs, runSetupCommand, type SetupDeps } from "./setup";

const scriptsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts",
);

const plain: TerminalCapabilities = {
  interactive: true,
  ansi: true,
  color: false,
  unicode: false,
  columns: 80,
};

function step(overrides: Partial<SetupStep> = {}): SetupStep {
  return {
    id: "tools",
    label: "Agent CLIs",
    state: "ok",
    detail: "codex, claude-code",
    ...overrides,
  };
}

function reporter(chunks: string[], overrides: Partial<TerminalCapabilities> = {}) {
  return new SetupReporter((text) => chunks.push(text), {
    ...plain,
    ansi: false,
    ...overrides,
  });
}

function deps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    platform: "linux",
    env: {},
    now: () => 0,
    ask: async () => 0,
    ensureAgentTools: async () => ({ ok: true, detail: "codex, claude-code" }),
    getAccountStatus: async () => ({ signedIn: true, identity: "arul@example.com" }),
    runConnect: async () => ({ ok: true, detail: "linked" }),
    readInstalledDesktop: () => ({ version: null, path: null }),
    verify: async () => ({ ok: true, detail: "brain running" }),
    ...overrides,
  };
}

function tempFile(contents: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-setup-test-"));
  const file = path.join(dir, "artifact.bin");
  fs.writeFileSync(file, contents);
  return file;
}

// ---------------------------------------------------------------------------
// Terminal capabilities + rendering
// ---------------------------------------------------------------------------

describe("detectTerminalCapabilities", () => {
  it("treats a pipe as non-interactive so nothing tries to redraw a log file", () => {
    const caps = detectTerminalCapabilities({ isTTY: false }, {}, "linux");
    expect(caps.ansi).toBe(false);
    expect(caps.interactive).toBe(false);
  });

  it("treats CI as a pipe even when it passes isTTY", () => {
    expect(
      detectTerminalCapabilities({ isTTY: true }, { CI: "true" }, "linux").ansi,
    ).toBe(false);
  });

  it("honours NO_COLOR and TERM=dumb", () => {
    expect(
      detectTerminalCapabilities({ isTTY: true }, { NO_COLOR: "1" }, "linux").color,
    ).toBe(false);
    expect(
      detectTerminalCapabilities({ isTTY: true }, { TERM: "dumb" }, "linux").ansi,
    ).toBe(false);
  });

  it("falls back to ASCII on a Windows host that advertises nothing modern", () => {
    expect(detectTerminalCapabilities({ isTTY: true }, {}, "win32").unicode).toBe(false);
    expect(
      detectTerminalCapabilities({ isTTY: true }, { WT_SESSION: "1" }, "win32").unicode,
    ).toBe(true);
  });
});

describe("setup step lines", () => {
  it("shows a bar with byte counts when the total is known", () => {
    const line = formatActiveLine(
      step({ label: "Desktop app" }),
      { fraction: 0.5, receivedBytes: 512 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 },
      plain,
    );
    expect(line).toContain("50%");
    // Sizes over 10 MB drop the decimal; a gigabyte rolls over to GB.
    expect(line).toContain("512 MB/1.0 GB");
  });

  it("never exceeds the terminal width, so one clear-line always erases it", () => {
    const line = formatActiveLine(
      step({ label: "x".repeat(200) }),
      { fraction: 0.5, item: "y".repeat(200) },
      plain,
    );
    expect(line.length).toBeLessThan(plain.columns);
  });

  it("puts the fix inline underneath a failure and nowhere else", () => {
    const failed = formatCompletedLine(
      step({ state: "failed", detail: "couldn't reach the ADE brain", nextAction: "ade connect" }),
      plain,
    );
    expect(failed).toContain("couldn't reach the ADE brain");
    expect(failed).toContain("fix later with:  ade connect");
    expect(formatCompletedLine(step(), plain)).not.toContain("fix later");
  });
});

describe("renderSummary", () => {
  const totals = { elapsedMs: 134_000, downloadedBytes: 1_288_490_188 };

  it("omits 'What's left' entirely on a clean install", () => {
    const out = renderSummary([step()], totals, plain);
    expect(out).toContain("ADE is ready");
    expect(out).not.toContain("What's left");
  });

  it("names the failed step and what its recovery command achieves", () => {
    const out = renderSummary(
      [
        step(),
        step({
          id: "account",
          label: "Account",
          state: "failed",
          detail: "sign-in didn't finish",
          nextAction: "ade connect",
        }),
      ],
      totals,
      plain,
    );
    expect(out).toContain("1 step needs you");
    expect(out).toContain("What's left");
    // The command, and what it gets you -- not a second copy of the failure.
    expect(out).toContain("ade connect          link this machine to your account");
  });

  it("reports elapsed time and bytes downloaded", () => {
    expect(renderSummary([step()], totals, plain)).toContain(
      "Installed in 2m 14s, 1.2 GB downloaded",
    );
  });

  it("skips steps that never ran", () => {
    const out = renderSummary([step({ state: "pending", label: "Desktop app" })], totals, plain);
    expect(out).not.toContain("Desktop app");
  });
});

describe("SetupReporter", () => {
  it("appends one line per step and emits no escape codes without ANSI", () => {
    const chunks: string[] = [];
    const r = reporter(chunks);
    const active = step({ state: "active" });
    r.beginStep(active);
    r.updateStep(active, { fraction: 0.4 });
    r.completeStep(step());

    const output = chunks.join("");
    expect(output).not.toContain(String.fromCharCode(27));
    expect(output).not.toContain("\r");
    expect(output).toContain("Agent CLIs...");
  });

  it("erases the live line before printing anything static", () => {
    const chunks: string[] = [];
    const r = new SetupReporter((text) => chunks.push(text), plain);
    r.beginStep(step({ state: "active" }));
    r.line("  prompt goes here");
    // The clear must land between the drawn line and the static one, or the
    // prompt renders on top of a half-drawn progress bar.
    expect(chunks[chunks.length - 2]).toContain("2K");
    expect(chunks[chunks.length - 1]).toBe("  prompt goes here\n");
  });
});

// ---------------------------------------------------------------------------
// Desktop-app acquisition
// ---------------------------------------------------------------------------

const WINDOWS_MANIFEST = `version: 1.2.54
files:
  - url: ADE-1.2.54-win-x64.exe.blockmap
    sha512: blockmapdigest
    size: 1234
  - url: ADE-1.2.54-win-x64.exe
    sha512: installerdigest
    size: 1084000000
path: ADE-1.2.54-win-x64.exe
sha512: installerdigest
`;

const MAC_MANIFEST = `version: 1.2.54
files:
  - url: ADE-1.2.54-x64.zip
    sha512: intelzip
  - url: ADE-1.2.54-arm64.zip
    sha512: armzip
path: ADE-1.2.54-arm64.zip
`;

describe("parseDesktopManifest", () => {
  it("picks the .exe on Windows and ignores the blockmap that precedes it", () => {
    expect(parseDesktopManifest(WINDOWS_MANIFEST, "win32")).toEqual({
      name: "ADE-1.2.54-win-x64.exe",
      sha512: "installerdigest",
    });
  });

  it("picks the zip matching this Mac's architecture", () => {
    expect(parseDesktopManifest(MAC_MANIFEST, "darwin", "arm64")?.name)
      .toBe("ADE-1.2.54-arm64.zip");
    expect(parseDesktopManifest(MAC_MANIFEST, "darwin", "x64")?.name)
      .toBe("ADE-1.2.54-x64.zip");
  });

  it("returns null rather than guessing when nothing matches", () => {
    expect(parseDesktopManifest("version: 1.0.0\nfiles:\n", "win32")).toBeNull();
  });
});

describe("release asset helpers", () => {
  it("delegates to the canonical release-feed URL shape", () => {
    expect(assetUrl("latest.yml")).toBe(
      "https://github.com/arul28/ADE/releases/latest/download/latest.yml",
    );
    expect(assetUrl("latest.yml", "arul28/ADE", "v1.2.54")).toBe(
      "https://github.com/arul28/ADE/releases/download/v1.2.54/latest.yml",
    );
  });

  it("produces the base64 SHA-512 electron-updater manifests carry, not hex", () => {
    expect(sha512Base64(tempFile(""))).toBe(
      "z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
    );
  });
});

describe("downloadWithResume", () => {
  function response(body: string, status = 200, headers: Record<string, string> = {}) {
    return new Response(body, { status, headers });
  }

  it("requests only the remainder when a partial file is already on disk", async () => {
    const destination = tempFile("HELLO");
    const fetchImpl = vi.fn(async () =>
      response("WORLD", 206, { "content-length": "5" })
    ) as unknown as typeof fetch;

    const total = await downloadWithResume(
      "https://example.invalid/ADE.exe",
      destination,
      () => {},
      { fetchImpl },
    );
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(init?.headers?.Range).toBe("bytes=5-");
    expect(total).toBe(10);
    expect(fs.readFileSync(destination, "utf8")).toBe("HELLOWORLD");
  });

  it("restarts cleanly when the server ignores the range request", async () => {
    // A 200 answer to a ranged request means the whole body: appending it to the
    // partial file would silently corrupt the download.
    const destination = tempFile("HELLO");
    const fetchImpl = vi.fn(async () =>
      response("FULLBODY", 200, { "content-length": "8" })
    ) as unknown as typeof fetch;

    await downloadWithResume("https://example.invalid/ADE.exe", destination, () => {}, {
      fetchImpl,
    });
    expect(fs.readFileSync(destination, "utf8")).toBe("FULLBODY");
  });

  it("retries a transient failure instead of failing the step", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-setup-test-"));
    const destination = path.join(dir, "out.bin");
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNRESET");
      return response("OK", 200, { "content-length": "2" });
    }) as unknown as typeof fetch;

    await downloadWithResume("https://example.invalid/ADE.exe", destination, () => {}, {
      fetchImpl,
    });
    expect(attempts).toBe(2);
    expect(fs.readFileSync(destination, "utf8")).toBe("OK");
  });

  it("reports progress with a total when content-length is known", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-setup-test-"));
    const destination = path.join(dir, "out.bin");
    const seen: Array<{ receivedBytes: number; totalBytes: number | null }> = [];
    const fetchImpl = vi.fn(async () =>
      response("ABCDEFGH", 200, { "content-length": "8" })
    ) as unknown as typeof fetch;

    await downloadWithResume(
      "https://example.invalid/ADE.exe",
      destination,
      (progress) => seen.push({
        receivedBytes: progress.receivedBytes,
        totalBytes: progress.totalBytes,
      }),
      { fetchImpl },
    );
    expect(seen.at(-1)).toEqual({ receivedBytes: 8, totalBytes: 8 });
  });
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

describe("parseSetupArgs", () => {
  it("carries the shell's step 1-2 results so the summary covers all five", () => {
    const options = parseSetupArgs(
      [
        "--continue",
        "--runtime-version", "1.2.54",
        "--runtime-path", "/home/a/.ade/bin/ade",
        "--native-path", "/home/a/.ade/runtime/darwin-arm64",
        "--elapsed-ms", "12000",
        "--downloaded-bytes", "1024",
      ],
      {},
    );
    expect(options.continueFromInstaller).toBe(true);
    expect(options.runtimeVersion).toBe("1.2.54");
    expect(options.nativePath).toBe("/home/a/.ade/runtime/darwin-arm64");
    expect(options.elapsedMs).toBe(12_000);
    expect(options.downloadedBytes).toBe(1024);
  });

  it("treats ADE_INSTALL_NO_PROMPT=1 the same as --no-prompt", () => {
    expect(parseSetupArgs([], { ADE_INSTALL_NO_PROMPT: "1" }).prompt).toBe(false);
    expect(parseSetupArgs(["--no-prompt"], {}).prompt).toBe(false);
  });

  it("rejects unknown flags rather than silently ignoring them", () => {
    expect(() => parseSetupArgs(["--wat"], {})).toThrow(/Unknown option/);
  });
});

describe("runSetupCommand", () => {
  it("summarises all five steps, including the two the shell already ran", async () => {
    // The shell prints the runtime and native-dependency steps live before this
    // process exists; the summary must still recap them or it drops a step the
    // user just watched succeed.
    const result = await runSetupCommand(
      ["--continue", "--no-desktop", "--no-prompt", "--runtime-version", "1.2.54"],
      deps({ reporter: reporter([], { interactive: false }) }),
    );
    expect(result.steps.map((s) => s.id)).toEqual([
      "runtime",
      "native",
      "tools",
      "account",
      "desktop",
    ]);
  });

  it("never claims success after a failed sign-in", async () => {
    const chunks: string[] = [];
    const result = await runSetupCommand(["--continue", "--no-desktop"], deps({
      reporter: reporter(chunks),
      getAccountStatus: async () => ({ signedIn: false, identity: null }),
      runConnect: async () => ({ ok: false, detail: "sign-in didn't finish" }),
      verify: async () => ({
        ok: false,
        detail: "sign-in didn't finish",
        nextAction: "ade connect",
      }),
    }));

    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    const account = result.steps.find((s) => s.id === "account");
    expect(account?.state).toBe("failed");
    expect(account?.nextAction).toBe("ade connect");
    expect(chunks.join("")).toContain("What's left");
  });

  it("downgrades a step that reported ok when verification disagrees", async () => {
    // This is the exact shape of the bug: the sign-in step believed it worked
    // and the installer printed a next step, while the machine was not linked.
    const result = await runSetupCommand(["--continue", "--no-desktop"], deps({
      reporter: reporter([]),
      verify: async () => ({
        ok: false,
        detail: "the ADE brain is not running",
        nextAction: "ade brain start",
      }),
    }));

    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.id === "account")?.nextAction).toBe("ade brain start");
  });

  it("keeps going after the agent CLIs fail -- one bad step must not cost the rest", async () => {
    const result = await runSetupCommand(["--continue", "--no-desktop"], deps({
      reporter: reporter([]),
      ensureAgentTools: async () => {
        throw new Error("network unreachable");
      },
    }));

    expect(result.steps.find((s) => s.id === "tools")?.state).toBe("failed");
    expect(result.steps.find((s) => s.id === "account")?.state).toBe("ok");
  });

  it("confirms an existing account with a numbered menu instead of re-prompting blind", async () => {
    // Typed explicitly: a zero-arg arrow loses the args tuple, and this test
    // asserts on the choices argument.
    const ask = vi.fn(async (_question: string, _choices: readonly string[]) => 0);
    const runConnect = vi.fn(async () => ({ ok: true, detail: "linked" }));
    const result = await runSetupCommand(["--continue", "--no-desktop"], deps({
      reporter: reporter([]),
      ask,
      runConnect,
    }));

    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]?.[1]).toEqual([
      "Keep this account",
      "Sign in as someone else",
      "Skip for now",
    ]);
    // Keeping the existing account must not re-run the whole sign-in flow.
    expect(runConnect).not.toHaveBeenCalled();
    expect(result.steps.find((s) => s.id === "account")?.detail).toContain("arul@example.com");
  });

  it("re-runs sign-in when the user picks a different account", async () => {
    const runConnect = vi.fn(async () => ({ ok: true, detail: "linked" }));
    await runSetupCommand(["--continue", "--no-desktop"], deps({
      reporter: reporter([]),
      ask: async () => 1,
      runConnect,
    }));
    expect(runConnect).toHaveBeenCalledOnce();
  });

  it("asks nothing and prompts for nothing without a terminal", async () => {
    const ask = vi.fn(async (_question: string, _choices: readonly string[]) => 0);
    const result = await runSetupCommand(["--continue", "--no-prompt"], deps({
      reporter: reporter([], { interactive: false }),
      ask,
      getAccountStatus: async () => ({ signedIn: false, identity: null }),
    }));

    expect(ask).not.toHaveBeenCalled();
    const account = result.steps.find((s) => s.id === "account");
    expect(account?.state).toBe("skipped");
    expect(account?.nextAction).toBe("ade connect");
  });

  it("skips the 1 GB download when that exact version is already installed", async () => {
    const launchDesktop = vi.fn();
    const fetchImpl = vi.fn(async () =>
      new Response("version: 1.2.54\nfiles:\n  - url: ADE-1.2.54-win-x64.exe\n    sha512: abc\n")
    ) as unknown as typeof fetch;

    const result = await runSetupCommand(["--continue"], deps({
      platform: "win32",
      reporter: reporter([]),
      fetchImpl,
      launchDesktop,
      readInstalledDesktop: () => ({ version: "1.2.54", path: process.execPath }),
    }));

    const desktop = result.steps.find((s) => s.id === "desktop");
    expect(desktop?.state).toBe("ok");
    expect(desktop?.detail).toContain("already installed");
    // Manifest only -- the artifact itself was never requested.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(launchDesktop).toHaveBeenCalledOnce();
  });
});

// The bug that made this whole pass necessary: the installers registered the
// machine brain with no ADE_DEFAULT_ROLE, so it came up as `agent`, and
// `ade connect` (which runs at `cto`) could never be served by it. `brain start`
// pins `cto`; `serve --install-service` inherits whatever is set.
describe("installer brain registration (regression)", () => {
  for (const script of ["install-runtime.ps1", "install-runtime.sh"]) {
    it(`${script} registers the brain via 'brain start', not 'serve --install-service'`, () => {
      const source = fs.readFileSync(path.join(scriptsDir, script), "utf8");
      expect(source).toMatch(/\bbrain start\b/);
      // Match the invocation, not the word: both scripts explain this bug in a
      // comment, and asserting on the bare string would only find the prose.
      expect(source).not.toMatch(
        /(?:\$destinationBinary|\$dest_dir\/ade")\s+serve\s+--install-service/,
      );
    });

    it(`${script} hands the remaining steps to 'ade setup'`, () => {
      const source = fs.readFileSync(path.join(scriptsDir, script), "utf8");
      expect(source).toMatch(/"setup"|setup --continue/);
    });
  }
});
