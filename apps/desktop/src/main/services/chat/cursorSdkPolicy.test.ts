import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowCursorHook,
  buildCursorSdkLocalRunOptions,
  cursorProjectSlugForPath,
  CURSOR_SDK_ONESHOT_POLICY,
  denyCursorHook,
  evaluateCursorSdkHook,
  resolveCursorSdkPolicy,
  summarizeCursorHook,
} from "./cursorSdkPolicy";
import { cursorProjectSlug } from "../../../shared/cursorProjectSlug";

const LANE = "/tmp/ade-lane";
const READONLY_TOOLS = ["read", "grep", "glob", "ls"];

type HookContext = Omit<Parameters<typeof evaluateCursorSdkHook>[0], "request" | "policy" | "laneRoot"> & {
  laneRoot?: string;
};

/** Summarize one raw Cursor hook payload and evaluate it under a Cursor mode. */
function decide(modeId: string, toolName: string, toolInput: unknown, context: HookContext = {}) {
  const laneRoot = context.laneRoot ?? LANE;
  const request = summarizeCursorHook({ toolName, toolInput }, laneRoot);
  const decision = evaluateCursorSdkHook({
    ...context,
    request,
    policy: resolveCursorSdkPolicy({ cursorModeId: modeId }),
    laneRoot,
  });
  return { decision, reason: request.reason };
}

function withTempRoot(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("Cursor SDK policy", () => {
  it("runs every one-shot with an empty tool allowlist so the SDK does not advertise tools", () => {
    expect(CURSOR_SDK_ONESHOT_POLICY).toMatchObject({ approvalPolicy: "read-only", fullAuto: false });
    expect(buildCursorSdkLocalRunOptions(CURSOR_SDK_ONESHOT_POLICY)).toEqual({
      mode: "plan",
      tools: [],
      autoReview: false,
    });
  });

  // Exact `toEqual` on both objects: a policy must never grow an SDK `force`
  // (run expiry) or `disallowedTools` key, and a mode is never named "auto".
  it.each([
    [
      { cursorModeId: "ask" },
      { chatMode: "ask", approvalPolicy: "read-only", fullAuto: false, hardGuards: true, autoReview: false, tools: READONLY_TOOLS },
      { mode: "plan", tools: READONLY_TOOLS, autoReview: false },
    ],
    [
      { cursorModeId: "plan" },
      { chatMode: "plan", approvalPolicy: "read-only", fullAuto: false, hardGuards: true, autoReview: false, tools: READONLY_TOOLS },
      { mode: "plan", tools: READONLY_TOOLS, autoReview: false },
    ],
    [
      { cursorModeId: "agent" },
      { chatMode: "agent", approvalPolicy: "on-request", fullAuto: false, hardGuards: true, autoReview: true },
      { mode: "agent", autoReview: true },
    ],
    [
      { cursorModeId: "full-auto" },
      { chatMode: "agent", approvalPolicy: "never", fullAuto: true, hardGuards: true, autoReview: false },
      { mode: "agent", autoReview: false },
    ],
    // An explicit Cursor clear must not resurrect an OpenCode full-auto value.
    [
      { cursorModeId: null, permissionMode: "default", opencodePermissionMode: "full-auto" },
      { chatMode: "agent", approvalPolicy: "on-request", fullAuto: false, hardGuards: true, autoReview: true },
      { mode: "agent", autoReview: true },
    ],
  ] as const)("maps Cursor mode %j to an ADE policy and SDK local run options", (session, policy, local) => {
    const resolved = resolveCursorSdkPolicy(session as Parameters<typeof resolveCursorSdkPolicy>[0]);
    expect(resolved).toEqual(policy);
    expect(buildCursorSdkLocalRunOptions(resolved)).toEqual(local);
  });

  it("copies disallowedTools onto local run options when the policy sets them", () => {
    const local = buildCursorSdkLocalRunOptions({
      ...resolveCursorSdkPolicy({ cursorModeId: "ask" }),
      disallowedTools: ["shell", "edit", "task"],
    });
    expect(local.tools).toEqual(READONLY_TOOLS);
    expect(local.disallowedTools).toEqual(["shell", "edit", "task"]);
  });

  it("formats hook decisions for Cursor hooks", () => {
    expect(allowCursorHook()).toEqual({ permission: "allow" });
    expect(denyCursorHook("nope")).toEqual({
      permission: "deny",
      user_message: "nope",
      agent_message: "nope",
    });
  });

  it.each([
    ["agent", "read", { path: "src/app.ts" }, "allow", null],
    ["agent", "shell", { command: "npm test" }, "ask", null],
    ["agent", "write", { path: ".ade/secrets/key.json" }, "deny", "protected"],
    ["full-auto", "shell", { command: "npm install", cwd: LANE }, "allow", null],
    // Read-only modes deny side effects, and do not special-case model-visible planning tools.
    ["plan", "write", { path: "src/app.ts", content: "x" }, "deny", null],
    ["plan", "TodoWrite", { todos: [{ content: "Inspect wiring", status: "in_progress" }] }, "deny", null],
    ["plan", "mcp", { serverName: "stale-planning-tools", toolName: "update_plan", arguments: { steps: [] } }, "deny", null],
  ] as const)("%s mode: %s %j -> %s", (modeId, toolName, toolInput, expected, reason) => {
    const result = decide(modeId, toolName, toolInput);
    expect(result.decision).toBe(expected);
    if (reason) expect(result.reason).toContain(reason);
  });

  it.each([
    ["read", { path: "/etc/passwd" }],
    ["read", { path: "../../etc/passwd" }],
    ...[
      "cat /etc/passwd",
      "git -C /tmp status",
      "npm --prefix ../other test",
      "npm --prefix=/tmp/outside test",
      "npm --prefix=C:\\Users\\admin\\outside test",
      "git -C C:\\Users\\admin\\outside status",
      "AWS_SHARED_CREDENTIALS_FILE=/Users/admin/.aws/credentials aws sts get-caller-identity",
      "cd /outside && ls",
      "echo ok > /tmp/ade-outside.txt",
      "cat ~/.aws/credentials",
      "cat $HOME/.aws/credentials",
    ].map((command) => ["shell", { command }] as const),
    // Hook payloads whose input is a raw command string.
    ["shell", "cd /etc && cat /etc/passwd"],
    // A shell cwd outside the lane, with otherwise safe command text.
    ["shell", { command: "npm test", cwd: "/tmp/outside-lane" }],
  ] as const)("denies lane escapes even in full-auto: %s %j", (toolName, toolInput) => {
    expect(decide("full-auto", toolName, toolInput, { userHomeDir: "/Users/admin" }).decision).toBe("deny");
  });

  it.each([
    'ade chat note "/ship"',
    "ade chat note --session abc /quality",
    'ade chat scheduled-work create --in 12m --prompt "/ship" --reason "ci"',
    "ade chat scheduled-work create --prompt=/test",
  ])("allows a slash command in an ade prompt: %s", (command) => {
    expect(decide("full-auto", "shell", { command }).decision).toBe("allow");
  });

  it.each([
    'ade chat note "/etc/passwd"',
    'ade chat scheduled-work create --prompt "/etc/passwd"',
    'ade chat note "/ship" && cat /etc/passwd',
  ])("still denies a real path inside an ade prompt: %s", (command) => {
    expect(decide("full-auto", "shell", { command }).decision).toBe("deny");
  });

  // The guard deliberately leaves backslash tokens alone on POSIX, where `\` is
  // a legal filename character, so these escape shapes have no POSIX analogue.
  // WINDOWS-GATE: Windows-only shell path syntax; verified green on a native Windows host.
  it.runIf(process.platform === "win32")("denies Windows-shell lane escapes written with backslashes or %VAR% expansion", () => {
    const laneRoot = path.join(path.parse(path.resolve("/")).root, "Users", "admin", "lane");
    const userHomeDir = path.join(path.parse(path.resolve("/")).root, "Users", "admin");
    const cases: Array<[string, string]> = [
      ["type ..\\..\\..\\.ssh\\id_rsa", "outside the active lane"],
      ["type .\\..\\..\\secret.txt", "outside the active lane"],
      ["type %USERPROFILE%\\.ssh\\id_rsa", "outside the active lane"],
      ["Get-Content $env:USERPROFILE\\.aws\\credentials", "outside the active lane"],
      ["type .ade\\secrets\\token", "protected by ADE"],
    ];
    for (const [command, reason] of cases) {
      const result = decide("full-auto", "shell", { command }, { laneRoot, userHomeDir });
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain(reason);
    }
  });

  it("allows Cursor SDK transcript and terminal reads for the active lane only", () => {
    // Build the lane root from the platform's own filesystem root: on Windows
    // `path.resolve` prefixes the current drive, so a hard-coded POSIX path
    // yields a different (drive-prefixed) slug there.
    const fsRoot = path.parse(path.resolve("/")).root;
    const userHomeDir = path.join(fsRoot, "Users", "admin");
    const laneRoot = path.join(userHomeDir, "Projects", "Versic", ".ade", "worktrees", "private-sharing-5d14c47a");
    const slug = cursorProjectSlugForPath(laneRoot);
    // Cursor's own rule: every non-alphanumeric character becomes a dash, runs
    // collapse, leading/trailing dashes are trimmed. The Windows drive letter
    // therefore survives as a leading `C-` segment.
    expect(slug).toBe(cursorProjectSlug(path.resolve(laneRoot)));
    expect(slug).toMatch(/Users-admin-Projects-Versic-ade-worktrees-private-sharing-5d14c47a$/u);

    const support = (...parts: string[]) => path.join(userHomeDir, ".cursor", "projects", ...parts);
    const run = (toolName: string, toolInput: unknown) =>
      decide("full-auto", toolName, toolInput, { laneRoot, userHomeDir }).decision;
    expect(run("read", { path: support(slug, "agent-transcripts", "run.jsonl") })).toBe("allow");
    expect(run("glob", { pattern: "*.json", targetDirectory: support(slug, "terminals") })).toBe("allow");
    expect(run("write", { path: support(slug, "agent-transcripts", "run.jsonl") })).toBe("deny");
    expect(run("read", { path: support(slug, "assets", "shot.png") })).toBe("allow");
    expect(run("write", { path: support(slug, "assets", "shot.png"), contents: "x" })).toBe("deny");
    expect(run("read", { path: support(`${slug}-other`, "assets", "shot.png") })).toBe("deny");
  });

  it("allows read-only access to the ADE-owned Cursor skill shim, and nothing more", () => {
    withTempRoot("ade-cursor-skill-dirs-", (root) => {
      const laneRoot = path.join(root, "repo");
      const shimRoot = path.join(root, "ade-home", "agent-skill-shims", "cursor");
      const skillFile = path.join(shimRoot, ".agents", "skills", "ade-browser", "SKILL.md");
      const outside = path.join(root, "elsewhere", "secret.txt");
      fs.mkdirSync(laneRoot, { recursive: true });
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(skillFile, "skill");
      fs.writeFileSync(outside, "secret");

      const withShim = { laneRoot, agentSkillDirs: [shimRoot] };
      expect(decide("full-auto", "read", { path: skillFile }, withShim).decision).toBe("allow");
      // A session that was never given the shim keeps the old denial.
      expect(decide("full-auto", "read", { path: skillFile }, { laneRoot }).decision).toBe("deny");
      // Read-only: the shim is ADE's copy, not a scratch directory.
      expect(decide("full-auto", "write", { path: skillFile, contents: "x" }, withShim).decision).toBe("deny");
      // The grant does not widen past the shim root.
      expect(decide("full-auto", "read", { path: outside }, withShim).decision).toBe("deny");
    });
  });

  it("allows read-only access to staged project attachments from a lane worktree", () => {
    withTempRoot("ade-cursor-attach-", (root) => {
      const projectRoot = path.join(root, "repo");
      const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane");
      const attachmentsDir = path.join(projectRoot, ".ade", "attachments");
      const secretsDir = path.join(projectRoot, ".ade", "secrets");
      const imagePath = path.join(attachmentsDir, "00000000-0000-4000-8000-000000000001.png");
      const otherImage = path.join(root, "other-repo", ".ade", "attachments", "shot.png");
      fs.mkdirSync(laneRoot, { recursive: true });
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.mkdirSync(path.dirname(otherImage), { recursive: true });
      fs.writeFileSync(imagePath, "png");
      fs.writeFileSync(path.join(secretsDir, "token"), "secret");
      fs.writeFileSync(otherImage, "png");

      const withProject = { laneRoot, projectRoot };
      expect(decide("full-auto", "read", { path: imagePath }, withProject).decision).toBe("allow");
      expect(decide("full-auto", "read", { path: imagePath }, { laneRoot }).decision).toBe("deny");
      expect(decide("full-auto", "write", { path: imagePath, contents: "x" }, withProject).decision).toBe("deny");
      expect(decide("full-auto", "read", { path: path.join(secretsDir, "token") }, withProject).decision).toBe("deny");
      expect(decide("full-auto", "read", { path: otherImage }, withProject).decision).toBe("deny");
      expect(decide("full-auto", "shell", { command: `cat ${imagePath}`, cwd: laneRoot }, withProject).decision)
        .toBe("deny");
    });
  });

  it.skipIf(process.platform === "win32").each([
    ["onto secrets", "token"],
    ["outside the project", "shot.png"],
  ])("denies project attachment reads when attachments is symlinked %s", (target, fileName) => {
    withTempRoot("ade-cursor-attach-link-", (root) => {
      const projectRoot = path.join(root, "repo");
      const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane");
      const linkTarget = target === "onto secrets" ? path.join(projectRoot, ".ade", "secrets") : path.join(root, "outside");
      const attachmentsLink = path.join(projectRoot, ".ade", "attachments");
      fs.mkdirSync(laneRoot, { recursive: true });
      fs.mkdirSync(linkTarget, { recursive: true });
      fs.writeFileSync(path.join(linkTarget, fileName), "secret");
      fs.symlinkSync(linkTarget, attachmentsLink, "dir");

      expect(decide("full-auto", "read", { path: path.join(attachmentsLink, fileName) }, { laneRoot, projectRoot }).decision)
        .toBe("deny");
    });
  });

  it.skipIf(process.platform === "win32")("denies Cursor support reads when the active project support root is symlinked outside Cursor projects", () => {
    withTempRoot("ade-cursor-support-", (root) => {
      const home = path.join(root, "home");
      const laneRoot = path.join(root, "repo", ".ade", "worktrees", "lane");
      const outside = path.join(root, "outside");
      const slug = cursorProjectSlugForPath(laneRoot);
      fs.mkdirSync(path.join(home, ".cursor", "projects"), { recursive: true });
      fs.mkdirSync(laneRoot, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(home, ".cursor", "projects", slug), "dir");

      const transcript = path.join(home, ".cursor", "projects", slug, "agent-transcripts", "run.jsonl");
      expect(decide("full-auto", "read", { path: transcript }, { laneRoot, userHomeDir: home }).decision).toBe("deny");
    });
  });

  it.skipIf(process.platform === "win32")("denies symlink escapes through paths that appear to be inside the lane", () => {
    withTempRoot("ade-cursor-policy-", (root) => {
      const laneRoot = path.join(root, "lane");
      const outside = path.join(root, "outside");
      fs.mkdirSync(laneRoot, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
      fs.symlinkSync(outside, path.join(laneRoot, "linked-outside"), "dir");

      expect(decide("full-auto", "read", { path: "linked-outside/secret.txt" }, { laneRoot }).decision).toBe("deny");
    });
  });
});
