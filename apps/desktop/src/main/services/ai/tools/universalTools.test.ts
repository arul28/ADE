import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerSandboxConfig } from "../../../../shared/types";
import { DEFAULT_WORKER_SANDBOX_CONFIG } from "../../orchestrator/orchestratorConstants";
import { checkWorkerSandbox, createUniversalToolSet, resolveWorkerShellInvocation } from "./universalTools";

const isWin = process.platform === "win32";

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function createFrontendFixtureRepo(): string {
  const cwd = makeTmpDir("ade-tools-frontend-fixture-");
  writeFixtureFile(cwd, "src/main.tsx", `
    import { createRoot } from "react-dom/client";
    import { RouterProvider } from "react-router-dom";
    import { router } from "./router";

    createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
  `);
  writeFixtureFile(cwd, "src/router.tsx", `
    import { createBrowserRouter } from "react-router-dom";
    import HomePage from "./pages/HomePage";

    export const router = createBrowserRouter([{ path: "/", element: <HomePage /> }]);
  `);
  writeFixtureFile(cwd, "src/pages/HomePage.tsx", `
    export default function HomePage() {
      return <main>Home</main>;
    }
  `);
  writeFixtureFile(cwd, "src/screens/SettingsScreen.tsx", `
    export function SettingsScreen() {
      return <section>Settings</section>;
    }
  `);
  writeFixtureFile(cwd, "src/components/Button.tsx", `
    export function Button() {
      return <button type="button">Click</button>;
    }
  `);
  writeFixtureFile(cwd, "app/layout.tsx", `
    export default function RootLayout({ children }: { children: React.ReactNode }) {
      return <html><body>{children}</body></html>;
    }
  `);
  writeFixtureFile(cwd, "app/dashboard/page.tsx", `
    export default function DashboardPage() {
      return <main>Dashboard</main>;
    }
  `);
  writeFixtureFile(cwd, "pages/_app.tsx", `
    export default function App({ Component, pageProps }: any) {
      return <Component {...pageProps} />;
    }
  `);
  writeFixtureFile(cwd, "node_modules/fake-router/router.tsx", `
    export const router = createBrowserRouter([]);
  `);
  writeFixtureFile(cwd, "dist/router.tsx", `
    export const router = createBrowserRouter([]);
  `);
  return cwd;
}

function displayPaths(matches: Array<{ displayPath: string }>): string[] {
  return matches.map((match) => match.displayPath);
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function sandboxWith(overrides: Partial<WorkerSandboxConfig>): WorkerSandboxConfig {
  return {
    ...DEFAULT_WORKER_SANDBOX_CONFIG,
    ...overrides
  };
}

// ============================================================================
// checkWorkerSandbox
// ============================================================================

describe("checkWorkerSandbox", () => {
  it("blocks protected file writes even when command matches a safe allowlist pattern", () => {
    const result = checkWorkerSandbox("echo hello > .env", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected file pattern");
  });

  it("validates relative paths by resolving them against cwd", () => {
    const cwd = path.join(os.tmpdir(), "ade-sandbox-cwd");
    const result = checkWorkerSandbox("cat ../outside.txt", sandboxWith({ allowedPaths: ["./"] }), cwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });

  it("does not allow safe-listed commands to bypass path checks", () => {
    const cwd = path.join(os.tmpdir(), "ade-sandbox-cwd-safe");
    const result = checkWorkerSandbox("echo hello > ../outside.txt", sandboxWith({ allowedPaths: ["./"] }), cwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });

  it("blocks commands matching explicit blocked patterns", () => {
    const config = sandboxWith({
      blockedCommands: ["\\brm\\s+-rf\\b"],
    });
    const result = checkWorkerSandbox("rm -rf /", config, "/tmp/project");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Blocked command pattern");
  });

  it("allows safe-listed read-only commands inside the project root", () => {
    const result = checkWorkerSandbox("ls -la ./src", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    expect(result.allowed).toBe(true);
  });

  it("allows paths within allowed extra directories", () => {
    const cwd = "/tmp/project";
    const config = sandboxWith({
      allowedPaths: ["./", "/tmp/extra"],
    });
    const result = checkWorkerSandbox("cat /tmp/extra/data.json", config, cwd);
    expect(result.allowed).toBe(true);
  });

  it("allows read-only access to /usr/bin and /usr/local/bin paths", () => {
    const result = checkWorkerSandbox("cat /usr/bin/env", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    expect(result.allowed).toBe(true);
  });

  it("treats POSIX double-slash paths as POSIX paths", () => {
    const result = checkWorkerSandbox(
      "//mnt/shared/tool --version",
      sandboxWith({ allowedPaths: ["/"] }),
      "/tmp/project",
    );

    expect(result.allowed).toBe(true);
  });

  it("rejects mutating writes into /usr/local/bin even under the default sandbox", () => {
    const result = checkWorkerSandbox("cp ./payload /usr/local/bin/tool", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });

  it("blocks Windows registry mutation commands", () => {
    const result = checkWorkerSandbox(
      "reg add HKCU\\Software\\Foo /v Bar /t REG_SZ /d 1",
      DEFAULT_WORKER_SANDBOX_CONFIG,
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Blocked command pattern");
  });

  it("blocks reg.exe mutation commands", () => {
    const result = checkWorkerSandbox(
      "reg.exe add HKCU\\Software\\Foo /v Bar /t REG_SZ /d 1",
      DEFAULT_WORKER_SANDBOX_CONFIG,
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Blocked command pattern");
  });

  it("blocks format.exe drive commands", () => {
    const result = checkWorkerSandbox("format.exe c:", DEFAULT_WORKER_SANDBOX_CONFIG, "C:\\projects\\repo");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Blocked command pattern");
  });

  it("blocks Windows drive paths outside the sandbox", () => {
    const result = checkWorkerSandbox(
      "type C:\\Windows\\win.ini",
      sandboxWith({ allowedPaths: ["./"] }),
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });

  it("blocks Windows copy commands that target protected files", () => {
    const result = checkWorkerSandbox(
      "copy foo .env",
      sandboxWith({ protectedFiles: ["\\.env"] }),
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected file pattern");
  });

  it("blocks PowerShell writes to protected files", () => {
    const result = checkWorkerSandbox(
      'powershell.exe -Command "Set-Content -Path .env -Value secret"',
      sandboxWith({ protectedFiles: ["\\.env"] }),
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected file pattern");
  });

  it("blocks PowerShell writes outside the sandbox root", () => {
    const result = checkWorkerSandbox(
      'pwsh -Command "Add-Content ..\\outside.txt secret"',
      sandboxWith({ allowedPaths: ["./"] }),
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });

  it("blocks PowerShell registry provider mutations", () => {
    const result = checkWorkerSandbox(
      'powershell.exe -Command "Set-ItemProperty -Path HKCU:\\Software\\Foo -Name Bar -Value 1"',
      DEFAULT_WORKER_SANDBOX_CONFIG,
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("non-filesystem provider path");
  });

  it("blocks PowerShell mutations that use non-literal path arguments", () => {
    const result = checkWorkerSandbox(
      'powershell.exe -Command "$path = \'.env\'; Set-Content -Path $path -Value secret"',
      DEFAULT_WORKER_SANDBOX_CONFIG,
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("non-literal path argument");
  });

  it("blocks opaque PowerShell encoded commands", () => {
    const result = checkWorkerSandbox(
      "powershell.exe -EncodedCommand not-base64!!!",
      DEFAULT_WORKER_SANDBOX_CONFIG,
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("EncodedCommand payload is not inspectable");
  });

  it("blocks PowerShell encoded writes to protected files", () => {
    const encoded = Buffer.from("Set-Content -Path .env -Value secret", "utf16le").toString("base64");
    const result = checkWorkerSandbox(
      `powershell.exe -EncodedCommand ${encoded}`,
      sandboxWith({ protectedFiles: ["\\.env"] }),
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected file pattern");
  });

  it("allows read-only PowerShell file reads inside the sandbox", () => {
    const result = checkWorkerSandbox(
      'powershell.exe -Command "Get-Content .\\README.md"',
      DEFAULT_WORKER_SANDBOX_CONFIG,
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(true);
  });

  it("allows git.exe read-only subcommands like Unix git", () => {
    const result = checkWorkerSandbox(
      "git.exe status",
      DEFAULT_WORKER_SANDBOX_CONFIG,
      "C:\\projects\\repo",
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks commands that are not in the safe list when blockByDefault is enabled", () => {
    const config = sandboxWith({
      blockByDefault: true,
      safeCommands: ["^echo\\b"],
    });
    const result = checkWorkerSandbox("curl http://example.com", config, "/tmp/project");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blockByDefault");
  });

  it("allows commands matching safeCommands when blockByDefault is enabled", () => {
    const config = sandboxWith({
      blockByDefault: true,
      safeCommands: ["^echo\\b"],
    });
    const result = checkWorkerSandbox("echo hello", config, "/tmp/project");
    expect(result.allowed).toBe(true);
  });

  it("detects home directory expansion in paths", () => {
    const cwd = "/tmp/project";
    const config = sandboxWith({
      allowedPaths: ["./"],
    });
    const result = checkWorkerSandbox("cat ~/some-file.txt", config, cwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });

  it("rejects symlinked paths that resolve outside the sandbox root", () => {
    const cwd = makeTmpDir("ade-sandbox-symlink-root-");
    const outsideDir = makeTmpDir("ade-sandbox-symlink-outside-");
    const linkedDir = path.join(cwd, "linked-outside");
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret\n", "utf-8");
    fs.symlinkSync(outsideDir, linkedDir, "dir");

    const result = checkWorkerSandbox(
      `cat ${path.join(linkedDir, "secret.txt")}`,
      sandboxWith({ allowedPaths: ["./"] }),
      cwd,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });

  it("detects redirect target paths for write-like commands", () => {
    const cwd = "/tmp/project";
    const config = sandboxWith({
      protectedFiles: ["\\.env"],
    });
    const result = checkWorkerSandbox("echo secret >> .env", config, cwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected file pattern");
  });

  it("allows commands with no path references at all", () => {
    const result = checkWorkerSandbox("echo hello world", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    expect(result.allowed).toBe(true);
  });

  it("handles URL-like tokens without treating them as paths", () => {
    const result = checkWorkerSandbox("curl https://example.com/api", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    // Should not try to resolve URLs as filesystem paths
    if (result.reason) {
      expect(result.reason).not.toContain("Path outside sandbox");
    }
  });

  it("blocks write to protected file via cp command", () => {
    const config = sandboxWith({
      protectedFiles: ["\\.env"],
    });
    const result = checkWorkerSandbox("cp my-secrets .env", config, "/tmp/project");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected file pattern");
  });

  it("blocks symlinked paths that escape the sandbox root", () => {
    const projectRoot = makeTmpDir("ade-sandbox-root-");
    const outsideDir = makeTmpDir("ade-sandbox-outside-");
    const linkPath = path.join(projectRoot, "linked-outside");
    fs.symlinkSync(outsideDir, linkPath, "dir");
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret", "utf8");

    const result = checkWorkerSandbox("cat linked-outside/secret.txt", DEFAULT_WORKER_SANDBOX_CONFIG, projectRoot);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });
});

// ============================================================================
// createUniversalToolSet
// ============================================================================

describe("createUniversalToolSet", () => {
  // ── Tool set structure ──────────────────────────────────────────

  it("returns all expected tool keys in the default configuration", () => {
    const cwd = makeTmpDir("ade-tools-keys-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    expect(tools.readFile).toBeDefined();
    expect(tools.grep).toBeDefined();
    expect(tools.glob).toBeDefined();
    expect(tools.listDir).toBeDefined();
    expect(tools.findRoutingFiles).toBeDefined();
    expect(tools.findPageComponents).toBeDefined();
    expect(tools.findAppEntryPoints).toBeDefined();
    expect(tools.summarizeFrontendStructure).toBeDefined();
    expect(tools.TodoWrite).toBeDefined();
    expect(tools.TodoRead).toBeDefined();
    expect(tools.gitStatus).toBeDefined();
    expect(tools.gitDiff).toBeDefined();
    expect(tools.gitLog).toBeDefined();
    expect(tools.webFetch).toBeDefined();
    expect(tools.webSearch).toBeDefined();
    expect(tools.editFile).toBeDefined();
    expect(tools.writeFile).toBeDefined();
    expect(tools.bash).toBeDefined();
    expect(tools.askUser).toBeDefined();
  });

  it("does not include memory tools when memoryService is not provided", () => {
    const cwd = makeTmpDir("ade-tools-nomem-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    expect(tools.memorySearch).toBeUndefined();
    expect(tools.memoryAdd).toBeUndefined();
  });

  it("finds routing files with repo-aware filesystem heuristics", async () => {
    const cwd = createFrontendFixtureRepo();
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.findRoutingFiles as any).execute({ limit: 10 });
    const paths = displayPaths(result.matches);

    expect(paths).toEqual(expect.arrayContaining([
      "src/router.tsx",
      "app/layout.tsx",
      "app/dashboard/page.tsx",
      "pages/_app.tsx",
    ]));
    expect(paths).not.toContain("node_modules/fake-router/router.tsx");
    expect(paths).not.toContain("dist/router.tsx");
    expect(result.matches.every((match: { path: string }) => path.isAbsolute(match.path))).toBe(true);
    expect(result.frameworkSignals).toEqual(expect.arrayContaining(["Next.js", "React Router"]));
  });

  it("finds page-like components without pulling in generic shared components", async () => {
    const cwd = createFrontendFixtureRepo();
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.findPageComponents as any).execute({ limit: 10 });
    const paths = displayPaths(result.matches);

    expect(paths).toEqual(expect.arrayContaining([
      "src/pages/HomePage.tsx",
      "src/screens/SettingsScreen.tsx",
      "app/dashboard/page.tsx",
    ]));
    expect(paths).not.toContain("src/components/Button.tsx");
  });

  it("finds likely app entry points and framework roots", async () => {
    const cwd = createFrontendFixtureRepo();
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.findAppEntryPoints as any).execute({ limit: 10 });
    const paths = displayPaths(result.matches);

    expect(paths).toEqual(expect.arrayContaining([
      "src/main.tsx",
      "app/layout.tsx",
      "pages/_app.tsx",
    ]));
    expect(result.matches.some((match: { kind: string; displayPath: string }) =>
      match.displayPath === "src/main.tsx" && match.kind === "bootstrap-entry"
    )).toBe(true);
  });

  it("summarizes frontend structure with framework and source-root hints", async () => {
    const cwd = createFrontendFixtureRepo();
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.summarizeFrontendStructure as any).execute({ sampleSize: 3 });

    expect(result.frameworkSignals).toEqual(expect.arrayContaining(["Next.js", "React", "React Router"]));
    expect(result.likelySourceRoots).toEqual(expect.arrayContaining(["src", "app", "pages"]));
    expect(result.topLevelDirectories).toEqual(expect.arrayContaining(["app", "pages", "src"]));
    expect(result.summary).toContain("Likely entry points");
    expect(result.summary).toContain("Routing surfaces");
    expect(result.entryPoints.every((match: { path: string; displayPath: string }) =>
      path.isAbsolute(match.path) && typeof match.displayPath === "string" && match.displayPath.length > 0
    )).toBe(true);
  });

  it("reads files from lane-relative paths and returns absolute plus display paths", async () => {
    const cwd = createFrontendFixtureRepo();
    const realCwd = fs.realpathSync(cwd);
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.readFile as any).execute({ file_path: "src/router.tsx", offset: 1, limit: 5 });

    expect(result.path).toBe(path.join(realCwd, "src/router.tsx"));
    expect(result.displayPath).toBe("src/router.tsx");
    expect(result.content).toContain("createBrowserRouter");
  });

  it("rejects readFile paths outside the lane root", async () => {
    const cwd = createFrontendFixtureRepo();
    const outsideDir = makeTmpDir("ade-tools-read-outside-");
    const outsideFile = path.join(outsideDir, "outside.ts");
    fs.writeFileSync(outsideFile, "export const outside = true;\n", "utf-8");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.readFile as any).execute({ file_path: outsideFile });

    expect(result.error).toContain("outside the repo root");
  });

  it("defaults grep, glob, and listDir to the lane root and returns normalized paths", async () => {
    const cwd = createFrontendFixtureRepo();
    const realCwd = fs.realpathSync(cwd);
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const grepResult = await (tools.grep as any).execute({ pattern: "createBrowserRouter" });
    const globResult = await (tools.glob as any).execute({ pattern: "src/**/*.tsx" });
    const listDirResult = await (tools.listDir as any).execute({});

    expect(grepResult.matches.some((match: { displayPath: string; path: string }) =>
      match.displayPath === "src/router.tsx" && match.path === path.join(realCwd, "src/router.tsx")
    )).toBe(true);
    expect(globResult.matches.some((match: { displayPath: string; path: string }) =>
      match.displayPath === "src/router.tsx" && match.path === path.join(realCwd, "src/router.tsx")
    )).toBe(true);
    expect(listDirResult.root).toBe(realCwd);
    expect(listDirResult.displayRoot).toBe(".");
    expect(listDirResult.entries.some((entry: { displayPath: string; path: string }) =>
      entry.displayPath === "src" && entry.path === path.join(realCwd, "src")
    )).toBe(true);
  });

  it("rejects grep, glob, and listDir paths outside the lane root", async () => {
    const cwd = createFrontendFixtureRepo();
    const outsideDir = makeTmpDir("ade-tools-search-outside-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const grepResult = await (tools.grep as any).execute({ path: outsideDir, pattern: "createBrowserRouter" });
    const globResult = await (tools.glob as any).execute({ path: outsideDir, pattern: "**/*.tsx" });
    const listDirResult = await (tools.listDir as any).execute({ path: outsideDir });

    expect(grepResult.error).toContain("outside the repo root");
    expect(globResult.error).toContain("outside the repo root");
    expect(listDirResult.error).toContain("Path escapes root");
  });

  it("updates and reads unified chat todo state through TodoWrite and TodoRead", async () => {
    const cwd = makeTmpDir("ade-tools-todo-");
    let todoItems: Array<{ id: string; description: string; status: "pending" | "in_progress" | "completed" }> = [];
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      getTodoItems: () => todoItems,
      onTodoUpdate: (items) => {
        todoItems = items;
      },
    });

    const writeResult = await (tools.TodoWrite as any).execute({
      todos: [
        { id: "todo-1", content: "Inspect the nav bar", status: "completed" },
        { id: "todo-2", content: "Add the blank test page", status: "in_progress" },
      ],
    });
    const readResult = await (tools.TodoRead as any).execute({});

    expect(writeResult.updated).toBe(true);
    expect(todoItems).toEqual([
      { id: "todo-1", description: "Inspect the nav bar", status: "completed" },
      { id: "todo-2", description: "Add the blank test page", status: "in_progress" },
    ]);
    expect(readResult.todos).toEqual([
      { id: "todo-1", content: "Inspect the nav bar", status: "completed" },
      { id: "todo-2", content: "Add the blank test page", status: "in_progress" },
    ]);
  });

  it("includes memoryUpdateCore tool when onMemoryUpdateCore is provided", () => {
    const cwd = makeTmpDir("ade-tools-memcore-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onMemoryUpdateCore: () => ({ version: 1, updatedAt: new Date().toISOString() }),
    });

    expect(tools.memoryUpdateCore).toBeDefined();
  });

  it("does not include memoryUpdateCore tool when onMemoryUpdateCore is not provided", () => {
    const cwd = makeTmpDir("ade-tools-nomemcore-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    expect(tools.memoryUpdateCore).toBeUndefined();
  });

  // ── Sandbox enforcement ─────────────────────────────────────────

  it("applies DEFAULT_WORKER_SANDBOX_CONFIG when sandboxConfig is omitted", async () => {
    const cwd = makeTmpDir("ade-tools-default-sandbox-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });
    const bashTool = tools.bash as any;

    const result = await bashTool.execute({
      command: "chmod 777 ./missing-file",
      timeout: 5_000
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("SANDBOX BLOCKED");
  });

  // ── writeFile tool ──────────────────────────────────────────────

  it("blocks writeFile writes outside project root when no explicit allowlist is provided", async () => {
    const cwd = makeTmpDir("ade-tools-write-root-");
    const outsideDir = `${cwd}-outside`;
    fs.mkdirSync(outsideDir, { recursive: true });
    tmpDirs.push(outsideDir);
    const outsidePath = path.join(outsideDir, "blocked.txt");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });
    const writeTool = tools.writeFile as any;

    const result = await writeTool.execute({
      file_path: outsidePath,
      content: "blocked write",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("outside allowed roots");
    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  it("allows writeFile within project root", async () => {
    const cwd = makeTmpDir("ade-tools-write-allowed-");
    const targetPath = path.join(cwd, "notes", "output.txt");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });
    const writeTool = tools.writeFile as any;

    const result = await writeTool.execute({
      file_path: targetPath,
      content: "hello",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("hello");
  });

  it("allows writeFile outside project root when sandbox allowlist explicitly permits it", async () => {
    const cwd = makeTmpDir("ade-tools-write-allowlist-root-");
    const allowlistedDir = makeTmpDir("ade-tools-write-allowlist-extra-");
    const targetPath = path.join(allowlistedDir, "allowed.txt");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      sandboxConfig: sandboxWith({ allowedPaths: ["./", allowlistedDir] }),
    });
    const writeTool = tools.writeFile as any;

    const result = await writeTool.execute({
      file_path: targetPath,
      content: "allowlisted",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("allowlisted");
  });

  it("creates parent directories automatically for writeFile", async () => {
    const cwd = makeTmpDir("ade-tools-write-mkdir-");
    const deepPath = path.join(cwd, "a", "b", "c", "file.txt");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.writeFile as any).execute({
      file_path: deepPath,
      content: "deep write",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(deepPath, "utf-8")).toBe("deep write");
  });

  it("blocks writeFile to protected files when the raw path matches a protected pattern", async () => {
    const cwd = makeTmpDir("ade-tools-write-protected-raw-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      sandboxConfig: sandboxWith({ protectedFiles: ["(^|/)\\.env$"] }),
    });

    const result = await (tools.writeFile as any).execute({
      file_path: ".env",
      content: "SECRET=value\n",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("protected file pattern");
    expect(fs.existsSync(path.join(cwd, ".env"))).toBe(false);
  });

  it("blocks writeFile through symlinked directories that escape the allowed roots", async () => {
    const cwd = makeTmpDir("ade-tools-write-symlink-root-");
    const outsideDir = makeTmpDir("ade-tools-write-symlink-outside-");
    const linkedDir = path.join(cwd, "linked-outside");
    fs.symlinkSync(outsideDir, linkedDir, "dir");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.writeFile as any).execute({
      file_path: path.join(linkedDir, "escape.txt"),
      content: "blocked",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("outside allowed roots");
    expect(fs.existsSync(path.join(outsideDir, "escape.txt"))).toBe(false);
  });

  // ── editFile tool ───────────────────────────────────────────────

  it("performs a single-occurrence edit successfully", async () => {
    const cwd = makeTmpDir("ade-tools-edit-");
    const filePath = path.join(cwd, "target.txt");
    fs.writeFileSync(filePath, "Hello world\nfoo bar\n", "utf-8");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "foo bar",
      new_string: "baz qux",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Hello world\nbaz qux\n");
  });

  it("fails when old_string is not found", async () => {
    const cwd = makeTmpDir("ade-tools-edit-notfound-");
    const filePath = path.join(cwd, "target.txt");
    fs.writeFileSync(filePath, "Hello world\n", "utf-8");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "does not exist",
      new_string: "replacement",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("fails when old_string matches multiple times without replace_all", async () => {
    const cwd = makeTmpDir("ade-tools-edit-multi-");
    const filePath = path.join(cwd, "target.txt");
    fs.writeFileSync(filePath, "foo bar\nfoo bar\n", "utf-8");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "foo bar",
      new_string: "baz",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("multiple times");
  });

  it("replaces all occurrences when replace_all is true", async () => {
    const cwd = makeTmpDir("ade-tools-edit-replaceall-");
    const filePath = path.join(cwd, "target.txt");
    fs.writeFileSync(filePath, "foo bar\nfoo bar\n", "utf-8");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "foo bar",
      new_string: "baz",
      replace_all: true,
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("baz\nbaz\n");
  });

  it("returns an error when the file does not exist for editFile", async () => {
    const cwd = makeTmpDir("ade-tools-edit-missing-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: path.join(cwd, "nonexistent.txt"),
      old_string: "foo",
      new_string: "bar",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("File not found");
  });

  it("blocks editFile outside the configured sandbox roots", async () => {
    const cwd = makeTmpDir("ade-tools-edit-sandbox-");
    const outsideDir = makeTmpDir("ade-tools-edit-sandbox-outside-");
    const filePath = path.join(outsideDir, "target.txt");
    fs.writeFileSync(filePath, "Hello world\n", "utf-8");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      sandboxConfig: sandboxWith({ allowedPaths: ["./"] }),
    });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "Hello",
      new_string: "Goodbye",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("outside allowed roots");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Hello world\n");
  });

  it("blocks editFile when the resolved path matches a protected pattern", async () => {
    const cwd = makeTmpDir("ade-tools-edit-protected-resolved-");
    const filePath = path.join(cwd, ".env");
    fs.writeFileSync(filePath, "TOKEN=one\n", "utf-8");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      sandboxConfig: sandboxWith({ protectedFiles: ["(^|/)\\.env$"] }),
    });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "one",
      new_string: "two",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("protected file pattern");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("TOKEN=one\n");
  });

  it("blocks editFile through symlinked directories that escape the allowed roots", async () => {
    const cwd = makeTmpDir("ade-tools-edit-symlink-root-");
    const outsideDir = makeTmpDir("ade-tools-edit-symlink-outside-");
    const linkedDir = path.join(cwd, "linked-outside");
    const outsideFile = path.join(outsideDir, "escape.txt");
    fs.writeFileSync(outsideFile, "outside\n", "utf-8");
    fs.symlinkSync(outsideDir, linkedDir, "dir");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: path.join(linkedDir, "escape.txt"),
      old_string: "outside",
      new_string: "inside",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("outside allowed roots");
    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside\n");
  });
  // ── Memory guard ────────────────────────────────────────────────

  it("blocks mutating tools on required turns until memory orientation is satisfied", async () => {
    const cwd = makeTmpDir("ade-tools-memory-guard-");
    const targetPath = path.join(cwd, "blocked.txt");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.writeFile as any).execute({
      file_path: targetPath,
      content: "blocked",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Search memory before mutating files");
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("blocks editFile on required turns until memory orientation is satisfied", async () => {
    const cwd = makeTmpDir("ade-tools-memory-guard-edit-");
    const filePath = path.join(cwd, "edit-target.txt");
    fs.writeFileSync(filePath, "original\n", "utf-8");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "original",
      new_string: "modified",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Search memory before mutating files");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original\n");
  });

  it("blocks mutating bash commands on required turns", async () => {
    const cwd = makeTmpDir("ade-tools-memory-guard-bash-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.bash as any).execute({
      command: "rm -rf ./some-dir",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("EXECUTION DENIED");
  });

  it("blocks mutating PowerShell commands on required turns", async () => {
    const cwd = makeTmpDir("ade-tools-memory-guard-powershell-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.bash as any).execute({
      command: 'powershell.exe -Command "Set-Content -Path .\\blocked.txt -Value hi"',
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("EXECUTION DENIED");
  });

  it("does not block read-only bash commands on required turns", async () => {
    const cwd = makeTmpDir("ade-tools-memory-readonly-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.bash as any).execute({
      command: "pwd",
      timeout: 5_000,
    });

    expect(result.stderr).not.toContain("EXECUTION DENIED");
  });

  it("allows mutating tools once memory orientation is satisfied", async () => {
    const cwd = makeTmpDir("ade-tools-memory-satisfied-");
    const targetPath = path.join(cwd, "allowed.txt");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: true,
        explicitSearchPerformed: true,
      },
    });

    const result = await (tools.writeFile as any).execute({
      file_path: targetPath,
      content: "allowed write",
    });

    expect(result.success).toBe(true);
  });

  it("does not block when classification is casual", async () => {
    const cwd = makeTmpDir("ade-tools-memory-casual-");
    const targetPath = path.join(cwd, "casual.txt");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "none",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.writeFile as any).execute({
      file_path: targetPath,
      content: "casual write",
    });

    expect(result.success).toBe(true);
  });

  // ── Permission modes ────────────────────────────────────────────

  it("does not expose write or bash tools in plan mode", async () => {
    const cwd = makeTmpDir("ade-tools-plan-deny-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "plan" });

    expect(tools.bash).toBeUndefined();
    expect(tools.writeFile).toBeUndefined();
    expect(tools.editFile).toBeUndefined();
    expect(tools.exitPlanMode).toBeDefined();
  });

  it("allows bash execution in edit mode when no approval handler is configured", async () => {
    const cwd = makeTmpDir("ade-tools-edit-deny-bash-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "edit" });

    const result = await (tools.bash as any).execute({
      command: "echo hello",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("allows writeFile in edit mode without approval handler", async () => {
    const cwd = makeTmpDir("ade-tools-edit-allow-write-");
    const targetPath = path.join(cwd, "allowed.txt");
    const tools = createUniversalToolSet(cwd, { permissionMode: "edit" });

    const result = await (tools.writeFile as any).execute({
      file_path: targetPath,
      content: "edit-mode write",
    });

    expect(result.success).toBe(true);
  });

  it("invokes the plan approval handler through exitPlanMode and allows if approved", async () => {
    const cwd = makeTmpDir("ade-tools-plan-approval-allow-");
    const onApprovalRequest = vi.fn().mockResolvedValue({ approved: true });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "plan",
      onApprovalRequest,
    });

    const result = await (tools.exitPlanMode as any).execute({
      planDescription: "1. Add the route\n2. Add the blank page",
    });

    expect(onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "exitPlanMode",
        description: "1. Add the route\n2. Add the blank page",
      }),
    );
    expect(result).toEqual({
      approved: true,
      message: "User approved the plan. Proceed with implementation.",
    });
  });

  it("invokes the plan approval handler through exitPlanMode and blocks if rejected", async () => {
    const cwd = makeTmpDir("ade-tools-plan-approval-deny-");
    const onApprovalRequest = vi.fn().mockResolvedValue({ approved: false, reason: "user rejected" });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "plan",
      onApprovalRequest,
    });

    const result = await (tools.exitPlanMode as any).execute({
      planDescription: "review the route change",
    });

    expect(result).toEqual({
      approved: false,
      message: "User rejected the plan. user rejected",
    });
  });

  // ── askUser tool ────────────────────────────────────────────────

  it("returns error when askUser callback is not configured", async () => {
    const cwd = makeTmpDir("ade-tools-askuser-nocb-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.askUser as any).execute({ question: "What?" });

    expect(result.error).toContain("not configured");
  });

  it("returns user answer from askUser callback", async () => {
    const cwd = makeTmpDir("ade-tools-askuser-cb-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onAskUser: async () => "user answer",
    });

    const result = await (tools.askUser as any).execute({ question: "What?" });

    expect(result.answer).toBe("user answer");
  });

  it("accepts structured askUser prompts and returns normalized answers", async () => {
    const cwd = makeTmpDir("ade-tools-askuser-structured-");
    const onAskUser = vi.fn().mockResolvedValue({
      answer: "auth-refactor",
      answers: {
        roadmap: ["auth-refactor", "bug-fixes"],
      },
      responseText: null,
      decision: "accept",
    });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "plan",
      onAskUser,
    });

    const result = await (tools.askUser as any).execute({
      title: "Mock plan question",
      body: "Choose the most important sprint goals.",
      questions: [
        {
          id: "roadmap",
          header: "Sprint scope",
          question: "Which items should we prioritize?",
          multiSelect: true,
          options: [
            { label: "Auth refactor", value: "auth-refactor", recommended: true },
            { label: "Bug fixes", value: "bug-fixes" },
          ],
        },
      ],
    });

    expect(onAskUser).toHaveBeenCalledWith({
      title: "Mock plan question",
      body: "Choose the most important sprint goals.",
      questions: [
        {
          id: "roadmap",
          header: "Sprint scope",
          question: "Which items should we prioritize?",
          multiSelect: true,
          options: [
            { label: "Auth refactor", value: "auth-refactor", recommended: true },
            { label: "Bug fixes", value: "bug-fixes" },
          ],
        },
      ],
    });
    expect(result).toMatchObject({
      answer: "auth-refactor",
      answers: {
        roadmap: ["auth-refactor", "bug-fixes"],
      },
      decision: "accept",
    });
  });

  // ── exitPlanMode tool ───────────────────────────────────────────

  it("does not expose exitPlanMode in non-plan permission modes", async () => {
    const cwd = makeTmpDir("ade-tools-exitplan-nonplan-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });
    expect(tools.exitPlanMode).toBeUndefined();
  });

  it("returns failure when no approval handler is configured for exitPlanMode", async () => {
    const cwd = makeTmpDir("ade-tools-exitplan-nocb-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "plan" });

    const result = await (tools.exitPlanMode as any).execute({});

    expect(result.approved).toBe(false);
    expect(result.message).toContain("No approval handler");
  });

  it("returns approved when user approves plan exit", async () => {
    const cwd = makeTmpDir("ade-tools-exitplan-approve-");
    const onApprovalRequest = vi.fn().mockResolvedValue({ approved: true });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "plan",
      onApprovalRequest,
    });

    const result = await (tools.exitPlanMode as any).execute({
      planDescription: "My plan summary",
    });

    expect(result.approved).toBe(true);
    expect(result.message).toContain("Proceed with implementation");
  });

  it("returns feedback when user rejects plan exit", async () => {
    const cwd = makeTmpDir("ade-tools-exitplan-reject-");
    const onApprovalRequest = vi.fn().mockResolvedValue({
      approved: false,
      reason: "Please add more tests first.",
    });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "plan",
      onApprovalRequest,
    });

    const result = await (tools.exitPlanMode as any).execute({});

    expect(result.approved).toBe(false);
    expect(result.message).toContain("Please add more tests first");
  });

  it("keeps memory search but hides memory mutations in plan mode", () => {
    const cwd = makeTmpDir("ade-tools-plan-memory-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "plan",
      memoryService: {} as any,
      projectId: "project-1",
      onMemoryUpdateCore: () => ({ version: 1, updatedAt: new Date().toISOString() }),
    });

    expect(tools.memorySearch).toBeDefined();
    expect(tools.memoryAdd).toBeUndefined();
    expect(tools.memoryPin).toBeUndefined();
    expect(tools.memoryUpdateCore).toBeUndefined();
  });

  it("fails closed when the plan approval bridge throws", async () => {
    const cwd = makeTmpDir("ade-tools-exitplan-error-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "plan",
      onApprovalRequest: vi.fn().mockRejectedValue(new Error("bridge disconnected")),
    });

    const result = await (tools.exitPlanMode as any).execute({
      planDescription: "Ship the fix",
    });

    expect(result.approved).toBe(false);
    expect(result.message).toContain("bridge disconnected");
  });

  // ── memoryUpdateCore tool ───────────────────────────────────────

  it("invokes onMemoryUpdateCore with patch and returns result", async () => {
    const cwd = makeTmpDir("ade-tools-memcore-exec-");
    const onMemoryUpdateCore = vi.fn().mockReturnValue({
      version: 2,
      updatedAt: "2026-03-26T00:00:00.000Z",
    });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onMemoryUpdateCore,
    });

    const result = await (tools.memoryUpdateCore as any).execute({
      projectSummary: "An ADE desktop application.",
      activeFocus: ["Release 9 stabilization"],
    });

    expect(onMemoryUpdateCore).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSummary: "An ADE desktop application.",
        activeFocus: ["Release 9 stabilization"],
      }),
    );
    expect(result.updated).toBe(true);
    expect(result.version).toBe(2);
  });

  it("returns error from memoryUpdateCore when no fields are provided", async () => {
    const cwd = makeTmpDir("ade-tools-memcore-empty-");
    const onMemoryUpdateCore = vi.fn();
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onMemoryUpdateCore,
    });

    const result = await (tools.memoryUpdateCore as any).execute({});

    expect(result.updated).toBe(false);
    expect(result.error).toContain("At least one core-memory field");
    expect(onMemoryUpdateCore).not.toHaveBeenCalled();
  });

  // ── bash tool ───────────────────────────────────────────────────

  it("resolveWorkerShellInvocation uses cmd on Windows and bash elsewhere", () => {
    const inv = resolveWorkerShellInvocation("echo test");
    if (isWin) {
      expect(inv.file.toLowerCase().endsWith("cmd.exe")).toBe(true);
      expect(inv.args[0]).toBe("/d");
      expect(inv.args[1]).toBe("/s");
      expect(inv.args[2]).toBe("/c");
      expect(inv.args[3]).toBe("echo test");
    } else {
      expect(inv.file).toBe("bash");
      expect(inv.args).toEqual(["-c", "echo test"]);
    }
  });

  it("executes a basic bash command and returns output", async () => {
    const cwd = makeTmpDir("ade-tools-bash-basic-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.bash as any).execute({
      command: isWin ? "echo hello from worker-shell" : "echo hello from bash",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(isWin ? "hello from worker-shell" : "hello from bash");
  });

  it("returns nonzero exit code for failing commands", async () => {
    const cwd = makeTmpDir("ade-tools-bash-fail-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.bash as any).execute({
      command: isWin ? "exit /b 42" : "exit 42",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(42);
  });

  it("clamps timeout to max 600000ms", async () => {
    const cwd = makeTmpDir("ade-tools-bash-timeout-clamp-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    // Just verify it doesn't throw; internally the timeout is clamped
    const result = await (tools.bash as any).execute({
      command: "echo clamped",
      timeout: 9_999_999,
    });

    expect(result.exitCode).toBe(0);
  });
});
