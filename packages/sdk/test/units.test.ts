import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findOnPath, resolveBinary } from "../src/binary.js";
import {
  assetUrl,
  downloadRuntime,
  isTransientRemoveError,
  parseChannelMarker,
  parseChecksums,
  REMOVE_RETRY_ATTEMPTS,
  REMOVE_RETRY_DELAY_MS,
  resolveRuntimeTarget,
  runtimePaths,
  runtimeSpawnEnv,
  serializeChannelMarker,
} from "../src/download.js";
import { chatEnvelopeFromBufferedEvent, isBufferedEvent } from "../src/eventStream.js";
import {
  individualMcpToolEntries,
  isPermissionPolicy,
  mcpServersNotCoveredByPolicy,
  normalizePermissionPolicy,
  permissionArgs,
  resolvePermissionArgs,
} from "../src/permissions.js";
import {
  approvalFromObserved,
  approvalFromPendingInput,
  engineApprovalDecision,
  isApprovalShaped,
  observedApprovalFromEvent,
  readPendingInputKind,
} from "../src/approvals.js";
import {
  normalizeInstructions,
  normalizeInstructionsCapability,
  normalizePermissionCapability,
  normalizeSettingSources,
  normalizeSettingSourcesCapability,
  isFilesystemRoot,
  validateThreadCwd,
} from "../src/hostConfig.js";
import { ADE_ERROR_CODES, AdeError, readAdeErrorCode } from "../src/errors.js";
import { probeRuntimeSignature } from "../src/runtimeSignature.js";
import { mergeHistoryWithBuffer } from "../src/electron/protocol.js";
import { SDK_VERSION } from "../src/version.js";
import {
  createExitHooks,
  DEFAULT_ADE_ROLE,
  scrubAdeEnv,
  stopChild,
  TERMINATION_SIGNALS,
  waitForExit,
  windowsTreeKillInvocation,
} from "../src/sidecar.js";
import {
  resolveTrustedWindowsTool,
  TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT,
  trustedWindowsToolKernelPath,
} from "../src/windowsSystemTools.js";
import {
  quoteWindowsCmdArg,
  resolveSpawnInvocation,
  shouldUseWindowsCmdWrapper,
} from "../src/windowsInvocation.js";
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  currentUserIdentity,
  endpointComparisonKey,
  ensurePrivateSocketDirectory,
  isNamedPipePath,
  resolveRuntimeSocketPath,
  sanitizeIdentitySegment,
} from "../src/socketPath.js";
import { ThreadStore } from "../src/threadStore.js";
import { defaultCatalog } from "./mockRuntime.js";

describe("socket path derivation", () => {
  it("derives a hashed named pipe on Windows without touching the filesystem", () => {
    const derived = resolveRuntimeSocketPath(
      "C:\\Users\\me\\AppData\\ade",
      "win32",
      "/tmp",
      "corp\\me",
    );
    const expectedId = createHash("sha256")
      .update(`${path.win32.resolve("C:\\Users\\me\\AppData\\ade").toLowerCase()}\ncorp\\me`)
      .digest("hex")
      .slice(0, 24);
    expect(derived).toBe(`\\\\.\\pipe\\ade-sdk-${expectedId}`);
    expect(isNamedPipePath(derived)).toBe(true);
  });

  it("gives the same Windows pipe for case-variant spellings of one home", () => {
    expect(resolveRuntimeSocketPath("C:\\Repo\\Ade", "win32")).toBe(
      resolveRuntimeSocketPath("c:\\repo\\ade", "win32"),
    );
  });

  it("gives different Windows pipes for different homes", () => {
    expect(resolveRuntimeSocketPath("C:\\a", "win32")).not.toBe(
      resolveRuntimeSocketPath("C:\\b", "win32"),
    );
  });

  it("uses a socket file under the home on POSIX", () => {
    expect(resolveRuntimeSocketPath("/tmp/app-home", "darwin")).toBe(
      path.join("/tmp/app-home", "sock", "ade.sock"),
    );
  });

  it("falls back to a short temp path when the home would blow past sun_path", () => {
    const deep = `/tmp/${"nested-directory-segment/".repeat(12)}home`;
    const derived = resolveRuntimeSocketPath(deep, "darwin", "/tmp");
    expect(Buffer.byteLength(derived, "utf8")).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES);
    expect(derived.startsWith("/tmp/ade-sdk-")).toBe(true);
  });

  it("collapses both Windows pipe spellings onto one comparison key", () => {
    expect(endpointComparisonKey("\\\\.\\pipe\\ade-sdk-AB")).toBe(
      endpointComparisonKey("//./pipe/ade-sdk-ab"),
    );
    expect(isNamedPipePath("/tmp/ade.sock")).toBe(false);
  });
});

describe("release asset resolution", () => {
  it("names the platform assets the release publishes", () => {
    expect(resolveRuntimeTarget("darwin", "arm64")).toEqual({
      target: "darwin-arm64",
      binaryAsset: "ade-darwin-arm64",
      archiveAsset: "ade-darwin-arm64.native.tar.gz",
    });
    expect(resolveRuntimeTarget("win32", "x64").binaryAsset).toBe("ade-win32-x64.exe");
    expect(resolveRuntimeTarget("linux", "x64").target).toBe("linux-x64");
  });

  it("refuses platforms and architectures ADE does not publish", () => {
    expect(() => resolveRuntimeTarget("freebsd" as NodeJS.Platform, "x64")).toThrow();
    expect(() => resolveRuntimeTarget("darwin", "ia32")).toThrow();
    expect(() => resolveRuntimeTarget("win32", "arm64")).toThrow();
  });

  it("builds latest and tagged asset URLs", () => {
    expect(assetUrl("arul28/ADE", "latest", "SHA256SUMS")).toBe(
      "https://github.com/arul28/ADE/releases/latest/download/SHA256SUMS",
    );
    expect(assetUrl("arul28/ADE", "v1.2.69", "ade-linux-x64")).toBe(
      "https://github.com/arul28/ADE/releases/download/v1.2.69/ade-linux-x64",
    );
  });

  it("parses SHA256SUMS in both coreutils spellings", () => {
    const digest = "a".repeat(64);
    const parsed = parseChecksums(
      [`${digest}  ade-darwin-arm64`, `${"b".repeat(64)} *dist/ade-linux-x64`, "garbage"].join("\n"),
    );
    expect(parsed.get("ade-darwin-arm64")).toBe(digest);
    expect(parsed.get("ade-linux-x64")).toBe("b".repeat(64));
    expect(parsed.size).toBe(2);
  });

  it("puts the archive's node_modules first on NODE_PATH", () => {
    const env = runtimeSpawnEnv("/opt/ade/runtime/darwin-arm64", { NODE_PATH: "/existing" });
    expect(env.ADE_RUNTIME_ROOT).toBe("/opt/ade/runtime/darwin-arm64");
    expect(env.NODE_PATH).toBe(
      `/opt/ade/runtime/darwin-arm64/node_modules${path.delimiter}/existing`,
    );
    expect(runtimeSpawnEnv("/r", {}).NODE_PATH).toBe("/r/node_modules");
  });
});

describe("PATH discovery", () => {
  it("finds an executable without shelling out", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-path-"));
    try {
      fs.writeFileSync(path.join(dir, "ade"), "#!/bin/sh\n", { mode: 0o755 });
      expect(findOnPath("ade", { PATH: dir }, "darwin")).toBe(path.join(dir, "ade"));
      expect(findOnPath("nope", { PATH: dir }, "darwin")).toBeNull();
      expect(findOnPath("ade", {}, "darwin")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies PATHEXT on Windows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-path-"));
    try {
      fs.writeFileSync(path.join(dir, "ade.EXE"), "");
      expect(findOnPath("ade", { PATH: dir, PATHEXT: ".COM;.EXE" }, "win32")).toBe(
        path.join(dir, "ade.EXE"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("permission presets", () => {
  it("gives every provider a full-auto shape for always-allow", () => {
    for (const provider of ["claude", "codex", "cursor", "droid", "opencode", "pi"] as const) {
      expect(permissionArgs(provider, "always-allow").permissionMode).toBe("full-auto");
    }
    expect(permissionArgs("opencode", "always-allow").opencodePermissionMode).toBe("full-auto");
    expect(permissionArgs("droid", "always-allow").droidPermissionMode).toBe("auto-high");
  });

  it("leaves the default preset alone", () => {
    expect(permissionArgs("claude", "default")).toEqual({ permissionMode: "default" });
  });
});

describe("permission policy", () => {
  it("tells a policy object apart from the two presets", () => {
    expect(isPermissionPolicy("default")).toBe(false);
    expect(isPermissionPolicy("always-allow")).toBe(false);
    expect(isPermissionPolicy(undefined)).toBe(false);
    expect(isPermissionPolicy({ fallback: "deny" })).toBe(true);
  });

  it("requires a fallback, because guessing one would reintroduce the hang", () => {
    // A policy with no fallback has no answer for an unmatched tool. Guessing
    // "ask" parks the turn for a host that built no approval card, which is the
    // exact failure the policy surface exists to remove.
    expect(() => normalizePermissionPolicy({} as never)).toThrow(AdeError);
    expect(() => normalizePermissionPolicy({ fallback: "maybe" } as never)).toThrow(/fallback/);
  });

  it("refuses a relative or tilde sandboxRoot rather than resolving it", () => {
    expect(() => normalizePermissionPolicy({ fallback: "ask", sandboxRoot: "./work" })).toThrow(
      /absolute/,
    );
    expect(() => normalizePermissionPolicy({ fallback: "ask", sandboxRoot: "~/work" })).toThrow(
      /absolute/,
    );
  });

  it("refuses a tool list that is not strings", () => {
    expect(() =>
      normalizePermissionPolicy({ fallback: "ask", allowedTools: ["ok", ""] }),
    ).toThrow(/allowedTools/);
    expect(() =>
      normalizePermissionPolicy({ fallback: "ask", deniedTools: [7] as never }),
    ).toThrow(/deniedTools/);
  });

  it("trims names and keeps only the fields that were supplied", () => {
    expect(
      normalizePermissionPolicy({
        fallback: "deny",
        allowedTools: [" mcp:tools:* "],
        sandboxRoot: "/tmp/work",
      }),
    ).toEqual({
      allowedTools: ["mcp:tools:*"],
      sandboxRoot: path.resolve("/tmp/work"),
      fallback: "deny",
    });
  });

  it("sends a policy as permissionMode default plus the policy", () => {
    // NOT full-auto. A runtime that ignores `permissionPolicy` then behaves
    // like today's "default" — more prompting — rather than like always-allow.
    expect(resolvePermissionArgs("claude", { fallback: "deny" })).toEqual({
      permissionMode: "default",
      permissionPolicy: { fallback: "deny" },
    });
    expect(resolvePermissionArgs("codex", "always-allow")).toMatchObject({
      permissionMode: "full-auto",
      codexSandbox: "danger-full-access",
    });
  });

  it("refuses an unknown preset string", () => {
    expect(() => resolvePermissionArgs("claude", "yolo" as never)).toThrow(AdeError);
  });

  it("finds the supplied MCP servers a policy never names", () => {
    const policy = {
      fallback: "deny" as const,
      allowedTools: ["mcp:catalog:*", "mcp:studio:render", "Read", "Bash"],
      autoApproveMcpServers: ["metrics"],
    };
    // A single-tool entry still counts: the caller clearly knows the server
    // exists, so the "you injected this and denied all of it" warning does not
    // apply to it.
    expect(
      mcpServersNotCoveredByPolicy(policy, ["catalog", "studio", "metrics", "archive"]),
    ).toEqual(["archive"]);
    expect(mcpServersNotCoveredByPolicy({ fallback: "deny" }, ["a", "b"])).toEqual(["a", "b"]);
    expect(mcpServersNotCoveredByPolicy(policy, [])).toEqual([]);
  });

  it("finds the allowed-tool entries that name one MCP tool rather than a server", () => {
    expect(
      individualMcpToolEntries({
        fallback: "deny",
        allowedTools: ["mcp:catalog:search", "mcp:studio:*", "Edit", "mcp:studio:render"],
      }),
    ).toEqual(["mcp:catalog:search", "mcp:studio:render"]);
    // A whole-server entry and a built-in name are not tool-level entries.
    expect(
      individualMcpToolEntries({ fallback: "deny", allowedTools: ["mcp:studio:*", "Bash"] }),
    ).toEqual([]);
    expect(individualMcpToolEntries({ fallback: "deny" })).toEqual([]);
  });
});

describe("host instructions and setting sources", () => {
  it("reads a bare string as an append", () => {
    expect(normalizeInstructions("be brief")).toEqual({ mode: "append", text: "be brief" });
    expect(normalizeInstructions({ mode: "replace", text: "X" })).toEqual({
      mode: "replace",
      text: "X",
    });
    expect(normalizeInstructions(undefined)).toBeUndefined();
  });

  it("refuses empty text and an unknown mode", () => {
    expect(() => normalizeInstructions("   ")).toThrow(/empty/);
    expect(() => normalizeInstructions({ mode: "prepend", text: "X" } as never)).toThrow(/mode/);
    expect(() => normalizeInstructions({ mode: "append", text: "" })).toThrow(/text/);
  });

  it("accepts exactly the four setting-source layers", () => {
    for (const value of ["none", "project", "user", "all"] as const) {
      expect(normalizeSettingSources(value)).toBe(value);
    }
    expect(normalizeSettingSources(undefined)).toBeUndefined();
    expect(() => normalizeSettingSources("local")).toThrow(/settingSources/);
  });
});

describe("cwd validation", () => {
  const home = path.join(os.tmpdir(), "ade-sdk-cwd-home");

  it("passes an absolute path through, resolved and canonicalized", () => {
    // Canonicalized, not merely resolved. The engine realpaths `requestedCwd`
    // before it stores it and the SDK records what the engine stored, so a
    // client that kept the caller's spelling would compare two names for one
    // directory on the next resume and report the caller's own `cwd` as
    // ignored. On macOS everything under the temp root has two spellings, so
    // that is the ordinary path, not an exotic one.
    const dir = path.join(os.tmpdir(), "ade-cwd", "work");
    expect(validateThreadCwd(dir, home)).toBe(
      path.join(fs.realpathSync.native(os.tmpdir()), "ade-cwd", "work"),
    );
  });

  it("returns the same answer for both spellings of one directory", () => {
    // The round trip that the resume comparison depends on: create with one
    // spelling, reopen with the same string, and the two must agree. A raw
    // string compare of an unresolved path against a stored realpath is the
    // bug this pins.
    const viaLink = path.join(os.tmpdir(), "ade-cwd-roundtrip", "work");
    const viaReal = path.join(fs.realpathSync.native(os.tmpdir()), "ade-cwd-roundtrip", "work");
    expect(validateThreadCwd(viaLink, home)).toBe(validateThreadCwd(viaReal, home));
  });

  it("still refuses the SDK home reached through a symlinked spelling", () => {
    // The reason canonicalization happens BEFORE the refusals rather than
    // after: the containment check compares strings, so an unresolved spelling
    // of the state root would walk straight past the guard that exists to keep
    // an agent out of it.
    const realHome = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ade-cwd-home-"));
    try {
      const linkedInside = path.join(os.tmpdir(), path.basename(realHome), "chats");
      expect(() => validateThreadCwd(linkedInside, realHome)).toThrow(/inside the SDK home/);
    } finally {
      fs.rmSync(realHome, { recursive: true, force: true });
    }
  });

  it("refuses a relative path rather than resolving it against the runtime", () => {
    // The runtime's own working directory is not the caller's, and is not
    // something the caller can see. Resolving quietly would put the agent
    // somewhere nobody chose.
    expect(() => validateThreadCwd("work", home)).toThrow(/absolute/);
    expect(() => validateThreadCwd("./work", home)).toThrow(/absolute/);
  });

  it("refuses `~` rather than expanding it", () => {
    expect(() => validateThreadCwd("~/work", home)).toThrow(/not expanded/);
    expect(() => validateThreadCwd("~", home)).toThrow(/not expanded/);
    expect(() => validateThreadCwd("~\\work", home)).toThrow(/not expanded/);
  });

  it("accepts a directory whose NAME merely starts with a tilde", () => {
    // The engine refuses `~`, `~/` and `~\\` only. A bare `startsWith("~")`
    // refused `~backup`, a real directory name the runtime accepts, so the two
    // copies of this rule disagreed on a path the agent could have run in.
    const target = path.join(path.parse(process.cwd()).root, "srv", "~backup");
    expect(validateThreadCwd(target, home)).toBe(path.resolve(target));
  });

  it("refuses a filesystem root and the user's home directory itself", () => {
    expect(() => validateThreadCwd(path.parse(process.cwd()).root, home)).toThrow(/root/);
    expect(() => validateThreadCwd(os.homedir(), home)).toThrow(/home directory/);
  });

  it("refuses a path inside the SDK home, which holds the runtime's own state", () => {
    expect(() => validateThreadCwd(path.join(home, "scratch"), home)).toThrow(/SDK home/);
    expect(() => validateThreadCwd(home, home)).toThrow(/SDK home/);
  });

  it("refuses an empty value", () => {
    expect(() => validateThreadCwd("", home)).toThrow(AdeError);
  });

  it("refuses a bare UNC share root on Windows, which is a whole file server", () => {
    // `path.win32.parse("\\\\srv\\share").root` is "\\", so the ordinary root
    // comparison reads a share root as an ordinary folder and admits it. The
    // engine already refuses this; the client-side check now matches.
    expect(isFilesystemRoot("\\\\srv\\share", path.win32)).toBe(true);
    expect(isFilesystemRoot("\\\\srv\\share\\", path.win32)).toBe(true);
    expect(isFilesystemRoot("\\\\srv", path.win32)).toBe(true);
    expect(isFilesystemRoot("\\\\srv\\share\\team", path.win32)).toBe(false);
  });

  it("still refuses a Windows drive root and admits an ordinary Windows folder", () => {
    expect(isFilesystemRoot("C:\\", path.win32)).toBe(true);
    expect(isFilesystemRoot("C:\\work", path.win32)).toBe(false);
  });

  it("refuses a Windows extended-length spelling of a drive root or UNC share root", () => {
    expect(isFilesystemRoot("\\\\?\\C:\\", path.win32)).toBe(true);
    expect(isFilesystemRoot("\\\\?\\UNC\\server\\share", path.win32)).toBe(true);
    expect(isFilesystemRoot("\\\\?\\C:\\work", path.win32)).toBe(false);
  });

  it("refuses the POSIX root and admits an ordinary POSIX folder", () => {
    expect(isFilesystemRoot("/", path.posix)).toBe(true);
    expect(isFilesystemRoot("/srv/app", path.posix)).toBe(false);
  });

  const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

  it("folds case on win32 and darwin, so a capitalised home is still the home", () => {
    // macOS volumes are case-insensitive by default, so `/USERS/alice` IS the
    // user's home directory. Comparing raw let a capital letter walk straight
    // past the refusal.
    const shouted = os.homedir().toUpperCase();
    if (CASE_INSENSITIVE) {
      expect(() => validateThreadCwd(shouted, home)).toThrow(/home directory/);
    } else {
      expect(validateThreadCwd(shouted, home)).toBe(path.resolve(shouted));
    }
  });

  it("folds case when testing containment in the SDK home", () => {
    const shouted = path.join(home.toUpperCase(), "SCRATCH");
    if (CASE_INSENSITIVE) {
      expect(() => validateThreadCwd(shouted, home)).toThrow(/SDK home/);
    } else {
      expect(validateThreadCwd(shouted, home)).toBe(path.resolve(shouted));
    }
  });
});

describe("host config capability normalization", () => {
  it("reports null for a capability nobody asked for", () => {
    const report = { level: "applied", mode: "append", mechanism: "x", detail: null };
    expect(normalizeInstructionsCapability(report, false)).toBeNull();
    expect(normalizeSettingSourcesCapability({ level: "applied", value: "all" }, false)).toBeNull();
    expect(normalizePermissionCapability({ level: "enforced" }, false)).toBeNull();
  });

  it("reports null when the request was made and the runtime said nothing", () => {
    // An older runtime omits the field. Inventing "applied" here would promise
    // a guarantee that was never verified.
    expect(normalizeInstructionsCapability(undefined, true)).toBeNull();
    expect(normalizeInstructionsCapability({ mechanism: "x" }, true)).toBeNull();
    expect(normalizeSettingSourcesCapability({ level: "nope" }, true)).toBeNull();
    expect(normalizePermissionCapability({ level: "best" }, true)).toBeNull();
  });

  it("normalizes a real report and defaults the soft fields", () => {
    expect(
      normalizeInstructionsCapability(
        { level: "best-effort", mode: "replace", detail: "merged into the prefix" },
        true,
      ),
    ).toEqual({
      requested: true,
      level: "best-effort",
      mode: "replace",
      mechanism: "",
      detail: "merged into the prefix",
    });
    expect(
      normalizeSettingSourcesCapability({ level: "ignored", value: "weird", detail: "" }, true),
    ).toEqual({
      requested: true,
      level: "ignored",
      // An unrecognised layer reads back as "none": the conservative direction,
      // because it understates what loaded rather than overstating it.
      value: "none",
      mechanism: "",
      detail: null,
    });
    expect(
      normalizePermissionCapability({ level: "unsupported", mechanism: "none" }, true),
    ).toEqual({ level: "unsupported", mechanism: "none", residual: null });
  });
});

describe("approvals", () => {
  it("maps the SDK's three decisions onto the engine's spelling", () => {
    expect(engineApprovalDecision("accept")).toBe("accept");
    expect(engineApprovalDecision("accept_always")).toBe("accept_for_session");
    expect(engineApprovalDecision("reject")).toBe("decline");
    expect(engineApprovalDecision("cancel" as never)).toBeNull();
  });

  it("names the two kinds approve() can actually settle", () => {
    expect(isApprovalShaped("approval")).toBe(true);
    expect(isApprovalShaped("permissions")).toBe(true);
    for (const kind of ["question", "structured_question", "plan_approval", "model_selection"] as const) {
      expect(isApprovalShaped(kind)).toBe(false);
    }
  });

  it("reads an approval_request event and ignores everything else", () => {
    expect(
      observedApprovalFromEvent({
        type: "approval_request",
        itemId: "i1",
        logicalItemId: "L1",
        kind: "command",
        description: "Run ls",
        detail: { command: "ls" },
        requestKind: "approval",
      }),
    ).toEqual({
      itemId: "i1",
      logicalItemId: "L1",
      kind: "command",
      description: "Run ls",
      detail: { command: "ls" },
      requestKind: "approval",
    });
    expect(observedApprovalFromEvent({ type: "text", text: "hi" })).toBeNull();
    // No itemId means nothing can be answered, so there is nothing to record.
    expect(observedApprovalFromEvent({ type: "approval_request", kind: "command" })).toBeNull();
  });

  it("infers a kind from the provider payload when no event was seen", () => {
    const base = {
      requestId: "r1",
      source: "codex" as const,
      kind: "approval" as const,
      questions: [],
      allowsFreeform: false,
      blocking: true,
      canProceedWithoutAnswer: false,
    };
    expect(
      approvalFromPendingInput({ ...base, providerMetadata: { command: "ls" } }, "codex").kind,
    ).toBe("command");
    expect(
      approvalFromPendingInput({ ...base, providerMetadata: { path: "/tmp/a" } }, "codex").kind,
    ).toBe("file_change");
    expect(approvalFromPendingInput(base, "codex").kind).toBe("tool_call");
  });

  it("prefers the engine's own kind from the observed event over the inference", () => {
    const request = {
      requestId: "r1",
      itemId: "i1",
      source: "codex" as const,
      kind: "approval" as const,
      description: "Apply a patch",
      questions: [],
      allowsFreeform: false,
      blocking: true,
      canProceedWithoutAnswer: false,
      providerMetadata: { command: "patch" },
    };
    const mapped = approvalFromPendingInput(request, "codex", {
      itemId: "i1",
      logicalItemId: "L1",
      kind: "file_change",
      description: "Apply a patch",
    });
    expect(mapped.kind).toBe("file_change");
    expect(mapped.logicalItemId).toBe("L1");
    expect(mapped.requestKind).toBe("approval");
  });

  it("attributes an acp or ade request to the thread's own provider", () => {
    // `AdeProvider` is closed and "acp" covers four dialects at once, so the
    // thread's provider is the only honest answer available.
    const mapped = approvalFromPendingInput(
      {
        requestId: "r1",
        source: "acp",
        kind: "permissions",
        title: "Grant filesystem access",
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
      },
      "opencode",
    );
    expect(mapped.provider).toBe("opencode");
    expect(mapped.description).toBe("Grant filesystem access");
    expect(mapped.itemId).toBe("r1");
  });

  it("keeps a question's requestKind so a host can render it read-only", () => {
    const mapped = approvalFromPendingInput(
      {
        requestId: "q1",
        source: "claude",
        kind: "question",
        questions: [{ id: "a", question: "Which branch?" }],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
      },
      "claude",
    );
    expect(mapped.requestKind).toBe("question");
    expect(mapped.description).toBe("Which branch?");
  });

  it("maps an observed event straight through for the no-RPC path", () => {
    expect(
      approvalFromObserved(
        { itemId: "i1", kind: "command", description: "Run ls", turnId: "t1" },
        "codex",
      ),
    ).toEqual({
      itemId: "i1",
      kind: "command",
      description: "Run ls",
      turnId: "t1",
      provider: "codex",
    });
  });
});

describe("buffered event decoding", () => {
  it("accepts a runtime-category event carrying a chat envelope", () => {
    const buffered = {
      id: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
      category: "runtime" as const,
      payload: {
        sessionId: "s1",
        timestamp: "2026-01-01T00:00:00.000Z",
        event: { type: "text", text: "hi" },
      },
    };
    expect(isBufferedEvent(buffered)).toBe(true);
    expect(chatEnvelopeFromBufferedEvent(buffered)?.sessionId).toBe("s1");
  });

  it("ignores non-runtime categories and malformed payloads", () => {
    expect(
      chatEnvelopeFromBufferedEvent({
        id: 1,
        timestamp: "t",
        category: "pty",
        payload: { sessionId: "s", timestamp: "t", event: { type: "text" } },
      }),
    ).toBeNull();
    expect(
      chatEnvelopeFromBufferedEvent({
        id: 1,
        timestamp: "t",
        category: "runtime",
        payload: { nope: true },
      }),
    ).toBeNull();
    expect(isBufferedEvent({ id: "1", timestamp: "t", category: "runtime", payload: {} })).toBe(false);
  });
});

describe("thread store", () => {
  it("round-trips records and survives a corrupt file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-store-"));
    try {
      const file = path.join(dir, "threads.json");
      const store = new ThreadStore(file);
      await store.put({
        key: "a",
        sessionId: "s1",
        provider: "claude",
        model: "m",
        createdAt: "t",
        lastOpenedAt: "t",
      });
      expect((await store.get("a"))?.sessionId).toBe("s1");
      await store.remove("a");
      expect(await store.get("a")).toBeNull();

      fs.writeFileSync(file, "{ not json");
      const reopened = new ThreadStore(file);
      expect(await reopened.all()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serialises concurrent writes so no mapping is lost", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-store-"));
    try {
      const store = new ThreadStore(path.join(dir, "threads.json"));
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.put({
            key: `k${index}`,
            sessionId: `s${index}`,
            provider: "claude",
            model: "m",
            createdAt: "t",
            lastOpenedAt: "t",
          }),
        ),
      );
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "threads.json"), "utf8"));
      expect(Object.keys(onDisk.threads)).toHaveLength(20);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips the host configuration a recreate has to rebuild", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-store-"));
    try {
      const file = path.join(dir, "threads.json");
      const store = new ThreadStore(file);
      await store.put({
        key: "a",
        sessionId: "s1",
        provider: "claude",
        model: "m",
        createdAt: "t",
        lastOpenedAt: "t",
        instructions: { mode: "replace", text: "You are Ada." },
        cwd: "/tmp/work",
        settingSources: "project",
        permissionPolicy: { fallback: "deny", allowedTools: ["mcp:tools:*"] },
      });
      const reopened = await new ThreadStore(file).get("a");
      expect(reopened).toMatchObject({
        instructions: { mode: "replace", text: "You are Ada." },
        cwd: "/tmp/work",
        settingSources: "project",
        permissionPolicy: { fallback: "deny", allowedTools: ["mcp:tools:*"] },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a malformed host configuration rather than replaying it", async () => {
    // This file is written by older SDKs and edited by hand. A policy that lost
    // its `fallback` is not a narrower policy — it is one with no answer for an
    // unmatched tool, so it must not reach a create call.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-store-"));
    try {
      const file = path.join(dir, "threads.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          threads: {
            a: {
              key: "a",
              sessionId: "s1",
              provider: "claude",
              model: "m",
              instructions: { mode: "sideways", text: "x" },
              settingSources: "local",
              permissionPolicy: { allowedTools: ["Bash"] },
              cwd: 42,
            },
          },
        }),
      );
      const record = await new ThreadStore(file).get("a");
      expect(record).toBeTruthy();
      expect(record!.instructions).toBeUndefined();
      expect(record!.settingSources).toBeUndefined();
      expect(record!.permissionPolicy).toBeUndefined();
      expect(record!.cwd).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("windows invocation (CVE-2024-27980)", () => {
  it("is the identity on POSIX and for a real .exe", () => {
    expect(resolveSpawnInvocation("/usr/bin/ade", ["runtime"], {}, "darwin")).toEqual({
      command: "/usr/bin/ade",
      args: ["runtime"],
      windowsVerbatimArguments: false,
    });
    expect(resolveSpawnInvocation("C:\\ade\\ade.exe", ["runtime"], {}, "win32")).toMatchObject({
      command: "C:\\ade\\ade.exe",
      windowsVerbatimArguments: false,
    });
  });

  it("routes .cmd and .bat through ComSpec, which Node otherwise refuses to spawn", () => {
    for (const shim of ["C:\\npm\\ade.cmd", "C:\\npm\\ade.bat", "C:\\npm\\ade"]) {
      expect(shouldUseWindowsCmdWrapper(shim, "win32")).toBe(true);
    }
    const invocation = resolveSpawnInvocation(
      "C:\\npm\\ade.cmd",
      ["runtime", "run", "--socket", "\\\\.\\pipe\\ade-sdk-1"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    );
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.windowsVerbatimArguments).toBe(true);
    // One outer pair of quotes around the whole line is what /s expects.
    expect(invocation.args[3]!.startsWith('""')).toBe(true);
    expect(invocation.args[3]).toContain("ade.cmd");
  });

  it("falls back to cmd.exe when ComSpec is unset", () => {
    expect(resolveSpawnInvocation("a.cmd", [], {}, "win32").command).toBe("cmd.exe");
  });

  it("quotes arguments without corrupting percent signs", () => {
    // Doubling `%%` is a batch-FILE rule; on a command line it corrupts the
    // value without preventing expansion, so percent must round-trip untouched.
    expect(quoteWindowsCmdArg("100% done")).toBe('"100% done"');
    // A quote with no preceding backslash doubles to "" — cmd.exe's own rule,
    // matching the desktop helper this mirrors.
    expect(quoteWindowsCmdArg('say "hi"')).toBe(`"say ""hi"""`);
    expect(quoteWindowsCmdArg("C:\\dir\\")).toBe('"C:\\dir\\\\"');
    // A newline would otherwise terminate the command line mid-argument.
    expect(quoteWindowsCmdArg("a\nb")).toBe('"a b"');
  });
});

describe("sidecar environment", () => {
  it("drops the host's ADE_* config but keeps what the sidecar sets", () => {
    const scrubbed = scrubAdeEnv({
      PATH: "/usr/bin",
      ADE_HOME: "/keep",
      ADE_RUNTIME_ROOT: "/keep/runtime",
      ADE_EMBEDDED_PARENT_PID: "42",
      ADE_DEFAULT_ROLE: "agent",
      // The host's own configuration, which would otherwise point an isolated
      // runtime at the developer's real state.
      ADE_PROJECT_ROOT: "/leak",
      ADE_SOCKET: "/leak.sock",
      ADE_LINEAR_ISSUE_IDS: "ADE-1",
    });
    expect(scrubbed).toEqual({
      PATH: "/usr/bin",
      ADE_HOME: "/keep",
      ADE_RUNTIME_ROOT: "/keep/runtime",
      ADE_EMBEDDED_PARENT_PID: "42",
      ADE_DEFAULT_ROLE: "agent",
    });
  });

  it("defaults to the least-privilege role", () => {
    expect(DEFAULT_ADE_ROLE).toBe("agent");
  });
});

describe("download retry and channel cache", () => {
  it("classifies only the transient Windows lock errors as retryable", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]) {
      expect(isTransientRemoveError(Object.assign(new Error("x"), { code }))).toBe(true);
    }
    for (const code of ["ENOENT", "EROFS", "EINVAL"]) {
      expect(isTransientRemoveError(Object.assign(new Error("x"), { code }))).toBe(false);
    }
    expect(isTransientRemoveError(new Error("no code"))).toBe(false);
    // Enough attempts to outlast an antivirus scan of a fresh executable.
    expect(REMOVE_RETRY_ATTEMPTS * REMOVE_RETRY_DELAY_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("Windows system tools are kernel-resolved", () => {
  const CANONICAL_ROOT = "C:\\Windows\\System32";

  /** A host whose System32 resolves normally through the GLOBALROOT alias. */
  function healthyHost(tool: string) {
    return {
      platform: "win32" as NodeJS.Platform,
      realpathNative: (filePath: string) =>
        filePath === TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT
          ? CANONICAL_ROOT
          : path.win32.join(CANONICAL_ROOT, tool),
      statSync: () => ({ isFile: () => true }),
    };
  }

  it("resolves through the kernel SystemRoot alias, never SystemRoot or PATH", () => {
    // PATH, cwd, SystemRoot and windir are all chosen by whoever launched this
    // process. GLOBALROOT names the real OS tree and cannot be redirected.
    expect(trustedWindowsToolKernelPath("taskkill")).toBe(
      `${TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT}\\taskkill.exe`,
    );
    expect(trustedWindowsToolKernelPath("powershell")).toBe(
      `${TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT}\\WindowsPowerShell\\v1.0\\powershell.exe`,
    );
    expect(trustedWindowsToolKernelPath("tar")).toBe(`${TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT}\\tar.exe`);
  });

  it("returns the canonical Win32 path a spawn can actually use", () => {
    expect(resolveTrustedWindowsTool("taskkill", healthyHost("taskkill.exe"))).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(
      resolveTrustedWindowsTool("powershell", {
        platform: "win32",
        realpathNative: (filePath: string) =>
          filePath === TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT
            ? CANONICAL_ROOT
            : path.win32.join(CANONICAL_ROOT, "WindowsPowerShell", "v1.0", "powershell.exe"),
        statSync: () => ({ isFile: () => true }),
      }),
    ).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("refuses a tool that a junction redirected outside System32", () => {
    // The whole point of canonicalizing: the alias resolved, but to somewhere
    // an attacker controls.
    expect(() =>
      resolveTrustedWindowsTool("taskkill", {
        platform: "win32",
        realpathNative: (filePath: string) =>
          filePath === TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT
            ? CANONICAL_ROOT
            : "C:\\evil\\taskkill.exe",
        statSync: () => ({ isFile: () => true }),
      }),
    ).toThrowError(/untrusted/i);
  });

  it("refuses when the alias itself does not land in System32", () => {
    expect(() =>
      resolveTrustedWindowsTool("tar", {
        platform: "win32",
        realpathNative: () => "C:\\evil",
        statSync: () => ({ isFile: () => true }),
      }),
    ).toThrowError(/untrusted/i);
  });

  it("refuses rather than falling back when System32 cannot be reached", () => {
    // A PATH fallback would hand the choice of binary to whoever made the
    // lookup fail, which is worse than not running the tool at all.
    let error: unknown = null;
    try {
      resolveTrustedWindowsTool("taskkill", {
        platform: "win32",
        realpathNative: () => {
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "spawn_failed" });
  });

  it("refuses a path that is not a file", () => {
    expect(() =>
      resolveTrustedWindowsTool("tar", {
        ...healthyHost("tar.exe"),
        statSync: () => ({ isFile: () => false }),
      }),
    ).toThrowError(/not a file/i);
  });
});

describe("Windows tree kill", () => {
  it("tears down the whole tree through a kernel-resolved taskkill", () => {
    // POSIX gets descendants from the process group; Windows has none, so
    // without /T the runtime's provider CLIs survive every dispose.
    const invocation = windowsTreeKillInvocation(4242, () => "C:\\Windows\\System32\\taskkill.exe");
    expect(invocation).toEqual({
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/T", "/F", "/PID", "4242"],
    });
  });

  it("skips the tree kill entirely when no trusted taskkill exists", () => {
    // Degrades to the leader-only kill rather than running an untrusted binary.
    expect(
      windowsTreeKillInvocation(7, () => {
        throw new Error("untrusted");
      }),
    ).toBeNull();
  });

  it("refuses a pid that is not a single real process", () => {
    // 0 and negatives address process groups on POSIX and are meaningless here;
    // a /T kill on a mis-typed pid takes a whole tree with it.
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(windowsTreeKillInvocation(pid, () => "taskkill.exe")).toBeNull();
    }
  });
});

describe("signal hooks give the host its Ctrl-C back", () => {
  type Listener = (...args: never[]) => void;

  function fakeHost(preexisting: Record<string, number> = {}) {
    const listeners = new Map<string, Set<Listener>>();
    const raised: Array<{ pid: number; signal: string }> = [];
    for (const [event, count] of Object.entries(preexisting)) {
      const set = new Set<Listener>();
      for (let i = 0; i < count; i += 1) set.add((() => {}) as Listener);
      listeners.set(event, set);
    }
    return {
      raised,
      listeners,
      host: {
        pid: 999,
        listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
        on: (event: string, listener: Listener) => {
          const set = listeners.get(event) ?? new Set<Listener>();
          set.add(listener);
          listeners.set(event, set);
        },
        off: (event: string, listener: Listener) => {
          listeners.get(event)?.delete(listener);
        },
        kill: (pid: number, signal: NodeJS.Signals) => {
          raised.push({ pid, signal });
        },
      },
      fire(event: string): void {
        for (const listener of [...(listeners.get(event) ?? [])]) {
          (listener as () => void)();
        }
      },
    };
  }

  it("re-raises the signal when the SDK was the only listener", () => {
    // Attaching a listener suppresses Node's default termination. A plain host
    // that embeds the SDK would otherwise kill its children on Ctrl-C and then
    // keep running.
    const env = fakeHost();
    let killed = 0;
    const hooks = createExitHooks(env.host, () => {
      killed += 1;
    });
    hooks.install();
    env.fire("SIGINT");
    expect(killed).toBe(1);
    expect(env.raised).toEqual([{ pid: 999, signal: "SIGINT" }]);
    // Detached before re-raising, or the re-raise would recurse into us.
    expect(env.host.listenerCount("SIGINT")).toBe(0);
    expect(env.host.listenerCount("exit")).toBe(0);
  });

  it("leaves the decision alone when the host already listened", () => {
    const env = fakeHost({ SIGINT: 1, SIGTERM: 1, SIGHUP: 1 });
    let killed = 0;
    const hooks = createExitHooks(env.host, () => {
      killed += 1;
    });
    hooks.install();
    env.fire("SIGINT");
    expect(killed).toBe(1);
    // Someone else owns the suppression; forcing an exit would override them.
    expect(env.raised).toEqual([]);
  });

  it("does not double-fire a host handler registered AFTER the SDK", () => {
    // An install-time snapshot would say "I am the only listener", we would
    // re-raise, and this handler would run a second time — while the default
    // exit still did not apply, because the handler is attached. The count has
    // to be taken at signal time, after our own handlers are detached.
    const env = fakeHost();
    const hooks = createExitHooks(env.host, () => {});
    hooks.install();
    let hostHandlerRuns = 0;
    env.host.on("SIGINT", () => {
      hostHandlerRuns += 1;
    });

    env.fire("SIGINT");
    expect(hostHandlerRuns).toBe(1);
    expect(env.raised).toEqual([]);
  });

  it("still re-raises when the late listener is on a different signal", () => {
    // Per-signal, not global: a host that wires SIGTERM has said nothing about
    // what Ctrl-C should do.
    const env = fakeHost();
    const hooks = createExitHooks(env.host, () => {});
    hooks.install();
    env.host.on("SIGTERM", () => {});

    env.fire("SIGINT");
    expect(env.raised).toEqual([{ pid: 999, signal: "SIGINT" }]);
  });

  it("removes every listener it added, on every signal", () => {
    const env = fakeHost();
    const hooks = createExitHooks(env.host, () => {});
    hooks.install();
    for (const signal of TERMINATION_SIGNALS) {
      expect(env.host.listenerCount(signal)).toBe(1);
    }
    hooks.remove();
    for (const signal of [...TERMINATION_SIGNALS, "exit"]) {
      expect(env.host.listenerCount(signal)).toBe(0);
    }
    // Re-installable: a host that opens a second client gets hooks again.
    hooks.install();
    expect(env.host.listenerCount("exit")).toBe(1);
    hooks.remove();
  });
});

describe("tmpdir socket is per-user", () => {
  it("puts the shared-tmpdir fallback in a per-user subdirectory", () => {
    // /tmp is world-writable on Linux. A guessable `ade-sdk-<hash>.sock`
    // directly in it can be pre-planted by another local user, who then answers
    // the SDK's connect.
    const deep = `/tmp/${"nested-directory-segment/".repeat(12)}home`;
    const derived = resolveRuntimeSocketPath(deep, "linux", "/tmp", "1000");
    expect(path.dirname(derived)).toBe("/tmp/ade-sdk-1000");
    expect(Buffer.byteLength(derived, "utf8")).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES);
  });

  it("separates two users sharing one tmpdir", () => {
    const deep = `/tmp/${"nested-directory-segment/".repeat(12)}home`;
    expect(resolveRuntimeSocketPath(deep, "linux", "/tmp", "1000")).not.toBe(
      resolveRuntimeSocketPath(deep, "linux", "/tmp", "1001"),
    );
  });

  it("keeps a hostile identity inside one path segment", () => {
    expect(sanitizeIdentitySegment("../../etc")).toBe("etc");
    expect(sanitizeIdentitySegment("a/b c")).toBe("a-b-c");
    expect(sanitizeIdentitySegment("")).toBe("anon");
    expect(sanitizeIdentitySegment("x".repeat(80)).length).toBe(32);
  });

  it("gives two Windows users different pipes for one machine-wide home", () => {
    // Named pipes are a flat machine-wide namespace, so a home path shared by
    // two accounts would otherwise derive one endpoint and collide.
    expect(resolveRuntimeSocketPath("C:\\ProgramData\\ade", "win32", "/tmp", "corp\\alice")).not.toBe(
      resolveRuntimeSocketPath("C:\\ProgramData\\ade", "win32", "/tmp", "corp\\bob"),
    );
  });

  it("still ignores case in the Windows user and home", () => {
    expect(resolveRuntimeSocketPath("C:\\Repo\\Ade", "win32", "/tmp", "CORP\\Me")).toBe(
      resolveRuntimeSocketPath("c:\\repo\\ade", "win32", "/tmp", "corp\\me"),
    );
  });

  it("reads the POSIX identity from the uid, which is what the filesystem enforces", () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    expect(currentUserIdentity("linux", {})).toBe(String(uid));
  });

  it("folds domain and username together on Windows", () => {
    expect(currentUserIdentity("win32", { USERDOMAIN: "CORP", USERNAME: "Me" })).toBe("corp\\me");
  });

  it("creates the socket directory private, and refuses one owned by somebody else", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-sockdir-"));
    try {
      const directory = path.join(parent, "ade-sdk-test");
      await ensurePrivateSocketDirectory(directory);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);

      // A directory left group/other-readable is tightened rather than rejected
      // — we own it, so we can fix it.
      fs.chmodSync(directory, 0o755);
      await ensurePrivateSocketDirectory(directory);
      expect(fs.statSync(directory).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses a socket directory owned by another uid", async () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    // /tmp itself is root-owned on every CI image and every dev mac, so it is a
    // real instance of the thing this check exists to catch.
    const rootOwned = "/tmp";
    if (fs.statSync(rootOwned).uid === uid) return;
    await expect(ensurePrivateSocketDirectory(rootOwned)).rejects.toMatchObject({
      code: "connect_failed",
    });
  });
});

describe("cached install provenance", () => {
  it("round-trips the verification outcome through the channel marker", () => {
    const marker = { channel: "v1.2.3", checksumVerified: true };
    expect(parseChannelMarker(serializeChannelMarker(marker))).toEqual(marker);
  });

  it("reads a legacy bare-channel marker as unverified, never as verified", () => {
    // "we do not know" must not collapse into "we checked" on a provenance flag.
    expect(parseChannelMarker("v1.0.0\n")).toEqual({
      channel: "v1.0.0",
      checksumVerified: false,
    });
    expect(parseChannelMarker("  ")).toBeNull();
    expect(parseChannelMarker("{not json")).toBeNull();
  });

  it("reports a cache reuse with the verification the install actually did", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-marker-"));
    try {
      const target = resolveRuntimeTarget();
      const { binaryPath, runtimeRoot } = runtimePaths(home, target);
      fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
      fs.writeFileSync(binaryPath, "", { mode: 0o755 });
      fs.mkdirSync(path.join(runtimeRoot, "node_modules"), { recursive: true });
      fs.writeFileSync(
        path.join(runtimeRoot, ".ade-sdk-channel"),
        serializeChannelMarker({ channel: "v1.0.0", checksumVerified: true }),
      );

      const reused = await downloadRuntime({
        home,
        channel: "v1.0.0",
        repo: "example/repo",
        target,
        logger: () => {},
      });
      expect(reused).toMatchObject({ binaryPath, checksumVerified: true });

      // And the same fact reaches doctor() through resolveBinary's own cache
      // branch, which is the one the SDK actually takes.
      const resolved = await resolveBinary({
        home,
        logger: () => {},
        download: async () => {
          throw new Error("must not download");
        },
      });
      expect(resolved).toMatchObject({ source: "cached-download", checksumVerified: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("PATH discovery requires an executable", () => {
  it("skips a non-executable candidate and keeps looking", () => {
    if (process.platform === "win32") return;
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-path-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-path-b-"));
    try {
      // A stray text file, a half-written install, a shim that lost its +x:
      // taking it would fail at spawn with EACCES while a good `ade` sat one
      // directory further along.
      fs.writeFileSync(path.join(first, "ade"), "not executable", { mode: 0o644 });
      const good = path.join(second, "ade");
      fs.writeFileSync(good, "", { mode: 0o755 });
      expect(findOnPath("ade", { PATH: `${first}:${second}` })).toBe(good);
      expect(findOnPath("ade", { PATH: first })).toBeNull();
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});

describe("stopChild teardown per platform", () => {
  type FakeChild = { signals: string[]; kill(signal: string): boolean };

  function fakeChild(): FakeChild {
    const signals: string[] = [];
    return {
      signals,
      kill(signal: string) {
        signals.push(signal);
        return true;
      },
    };
  }

  /** An exit promise the test resolves when it wants the child to be gone. */
  function deferredExit(): { promise: Promise<void>; exit: () => void } {
    let exit = (): void => {};
    const promise = new Promise<void>((resolve) => {
      exit = resolve;
    });
    return { promise, exit };
  }

  it("resolves true only when the child exits inside the window", async () => {
    const { promise, exit } = deferredExit();
    exit();
    expect(await waitForExit(promise, 1000)).toBe(true);
    expect(await waitForExit(new Promise<void>(() => {}), 5)).toBe(false);
  });

  it("lets a Windows child unwind on its own before touching it", async () => {
    // The RPC connection is already closed and the parent-death watchdog is
    // polling, so a clean exit inside the window needs no kill at all.
    const child = fakeChild();
    const { promise, exit } = deferredExit();
    exit();
    let hardKills = 0;
    await stopChild(child as never, promise, "win32", {
      hardKill: () => {
        hardKills += 1;
      },
      gracefulExitMs: 50,
      hardKillWaitMs: 50,
    });
    // No SIGTERM either: on Windows that is TerminateProcess on the leader
    // only, which is neither graceful nor complete.
    expect(child.signals).toEqual([]);
    expect(hardKills).toBe(0);
  });

  it("escalates a Windows child that will not leave, and still resolves", async () => {
    const child = fakeChild();
    const { promise, exit } = deferredExit();
    const seen: NodeJS.Platform[] = [];
    // A taskkill that fails or is blocked must not hang dispose(), so the
    // post-kill wait is bounded — this test never resolves `exit`.
    await stopChild(child as never, promise, "win32", {
      hardKill: (_child, platform) => seen.push(platform),
      gracefulExitMs: 20,
      hardKillWaitMs: 20,
    });
    expect(seen).toEqual(["win32"]);
    expect(child.signals).toEqual([]);
    void exit;
  });

  it("still sends SIGTERM first on POSIX, and escalates only on timeout", async () => {
    const child = fakeChild();
    const { promise, exit } = deferredExit();
    let hardKills = 0;
    const stopping = stopChild(child as never, promise, "linux", {
      hardKill: () => {
        hardKills += 1;
      },
    });
    exit();
    await stopping;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(hardKills).toBe(0);
  });
});

describe("SDK_VERSION", () => {
  // A published build gets this value from tsup's `define`, reading
  // package.json at build time. The source literal is what a repo-local
  // consumer (this suite, tsx, the demo app) sees, so it has to be pinned to
  // the same package.json or the two answers to "which SDK is this?" diverge
  // the moment someone bumps one and forgets the other.
  it("matches the version in package.json", () => {
    const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(manifest.version);
  });

  it("is a plain semver string, not a placeholder", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});


describe("runtime signature probe honesty", () => {
  const ok = (stderr: string) => ({ code: 0, stdout: "", stderr });

  it("reports a signed binary from codesign's stderr report", async () => {
    const signature = await probeRuntimeSignature("/bin/whatever", {
      platform: "darwin",
      spawn: async (command) =>
        command.endsWith("codesign")
          ? ok("Authority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345")
          : { code: 0, stdout: "", stderr: "" },
    });
    expect(signature).toEqual({
      signed: true,
      authority: "Developer ID Application: Example",
      accepted: true,
    });
  });

  it("still reports `not signed` for a codesign run that answered non-zero", async () => {
    const signature = await probeRuntimeSignature("/bin/whatever", {
      platform: "darwin",
      spawn: async () => ({ code: 1, stdout: "", stderr: "code object is not signed at all" }),
    });
    expect(signature).toEqual({ signed: false });
  });

  it("reports `not known` (null) when codesign timed out rather than answered", async () => {
    // The failure this exists for: `codesign` taking more than 10 s on a large
    // binary used to read back as `signed: false`, and an embedder concluded
    // their signing pipeline was broken when it was not.
    const signature = await probeRuntimeSignature("/bin/whatever", {
      platform: "darwin",
      spawn: async () => ({ code: 1, stdout: "", stderr: "", failed: true }),
    });
    expect(signature).toBeNull();
  });

  it("leaves acceptance unknown when Gatekeeper could not be consulted", async () => {
    const signature = await probeRuntimeSignature("/bin/whatever", {
      platform: "darwin",
      spawn: async (command) =>
        command.endsWith("codesign")
          ? ok("Authority=Example")
          : { code: 1, stdout: "", stderr: "", failed: true },
    });
    expect(signature).toEqual({ signed: true, authority: "Example" });
  });

  it("reports `not known` for a Windows probe that did not run", async () => {
    const signature = await probeRuntimeSignature("C:\\ade.exe", {
      platform: "win32",
      spawn: async () => ({ code: 0, stdout: "status=Valid", stderr: "", failed: true }),
    });
    expect(signature).toBeNull();
  });
});

describe("envelope merge keeps un-numbered envelopes", () => {
  const envelope = (over: Record<string, unknown> = {}) => ({
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:00.000Z",
    event: { type: "text", text: "x" },
    ...over,
  }) as never;

  it("keeps two sequence-less envelopes that share a timestamp and type", () => {
    // Two text deltas in one millisecond from a runtime that does not number
    // its envelopes used to collapse to one, leaving a hole in the transcript.
    const merged = mergeHistoryWithBuffer([envelope(), envelope()], []);
    expect(merged).toHaveLength(2);
  });

  it("still collapses the history/live overlap the key exists for", () => {
    const shared = envelope();
    expect(mergeHistoryWithBuffer([shared], [shared])).toHaveLength(1);
  });

  it("still collapses an overlap that carries a sequence", () => {
    const shared = envelope({ sequence: 7 });
    expect(mergeHistoryWithBuffer([shared], [shared])).toHaveLength(1);
  });

  it("orders the merged list by sequence, then timestamp", () => {
    const merged = mergeHistoryWithBuffer(
      [envelope({ sequence: 3 })],
      [envelope({ sequence: 1 }), envelope({ sequence: 2 })],
    );
    expect(merged.map((item) => (item as { sequence: number }).sequence)).toEqual([1, 2, 3]);
  });
});

describe("error codes", () => {
  it("validates a code that crossed a process boundary instead of casting it", () => {
    expect(readAdeErrorCode("approval_not_found")).toBe("approval_not_found");
    expect(readAdeErrorCode("not_a_code")).toBeNull();
    expect(readAdeErrorCode(undefined)).toBeNull();
  });

  it("lists every declared code", () => {
    expect(ADE_ERROR_CODES).toContain("unauthorized");
    expect(new Set(ADE_ERROR_CODES).size).toBe(ADE_ERROR_CODES.length);
  });
});

describe("pending input kinds", () => {
  it("reads a known kind and rejects anything else", () => {
    expect(readPendingInputKind("plan_approval")).toBe("plan_approval");
    expect(readPendingInputKind("something_new")).toBeUndefined();
    expect(readPendingInputKind(7)).toBeUndefined();
  });

  it("drops an unknown kind from a pending request too", () => {
    const mapped = approvalFromPendingInput(
      {
        requestId: "r1",
        itemId: "i1",
        source: "codex",
        kind: "something_new" as never,
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
      },
      "codex",
    );
    expect(mapped.requestKind).toBeUndefined();
  });

  it("drops an unknown requestKind rather than putting it in the union", () => {
    const observed = observedApprovalFromEvent({
      type: "approval_request",
      itemId: "i1",
      description: "d",
      requestKind: "something_new",
    });
    expect(observed?.requestKind).toBeUndefined();
  });
});
