#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import {
  CURSOR_CLOUD_HELP,
  CursorCloudUsageError,
  runCursorCloud,
} from "./cursorCloud";
import {
  CliDeeplinkUsageError,
  openUrlViaOs,
  runDeeplinkCommandAsync,
  type LinkEnvelopeContext,
} from "./commands/deeplinks";
import {
  CliSkillUsageError,
  runSkillCommand,
} from "./commands/skill";
import { buildDeeplink, type DeeplinkEnvelope } from "../../desktop/src/shared/deeplinks";
import { buildPairingQrPayload } from "../../desktop/src/shared/pairingQr";
import { buildWebClientPairUrl } from "../../desktop/src/shared/webClientUrl";
import {
  accountMachineConnectionState,
  parseAccountMachine,
} from "../../desktop/src/shared/accountDirectory";
import { SEARCH_DOC_KINDS } from "../../desktop/src/shared/types/search";
import { PERSONAL_CHAT_ACTIONS } from "../../desktop/src/shared/types/personalChats";
import { deriveDeterministicLaneNameFromPrompt } from "../../desktop/src/shared/laneNameFallback";
import {
  AUTOMATIONS_COMING_SOON_MESSAGE,
  readAutomationsEnvOverride,
} from "../../desktop/src/shared/automationAvailability";
import { parseLinearGraphQLInput } from "../../desktop/src/main/services/cto/linearGraphQLInput";
import { browseProjectDirectories } from "../../desktop/src/main/services/projects/projectBrowserService";
import { createProjectScaffoldService } from "../../desktop/src/main/services/projects/projectScaffoldService";
import { resolveRepoRoot } from "../../desktop/src/main/services/projects/projectService";
import type { Logger } from "../../desktop/src/main/services/logging/logger";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ListMyGitHubReposInput,
  ProjectBrowseInput,
} from "../../desktop/src/shared/types/core";
import { resolveMachineAdeLayout } from "./services/projects/machineLayout";
import {
  findAdeManagedWorktreeRoot,
  normalizeProjectRootPath,
  realpathIfExists,
} from "./services/projects/projectRoots";
import { createHeadlessGitHubService } from "./headlessLinearServices";
import type { SyncProjectCatalogProvider } from "./services/sync/syncHostService";
import {
  JsonRpcError,
  JsonRpcErrorCode,
  startJsonRpcServer,
  type JsonRpcHandler,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcServerErrorContext,
  type JsonRpcTransport,
} from "./jsonrpc";
import {
  ADE_RPC_AUTH_PARAM,
  generateRpcAuthToken,
  parseRpcUrlAuthToken,
  safeRpcAuthTokenEquals,
  withRpcAuthParam,
} from "./rpcAuth";
import { isAdeRuntimeNamedPipePath } from "../../desktop/src/shared/adeRuntimeIpc";
import {
  isLaunchProfile,
  isTrackedCliPermissionMode,
  LAUNCH_PROFILE_TITLE,
  validateLaunchProfilePermissionMode,
  type LaunchProfile,
} from "../../desktop/src/shared/cliLaunch";
import {
  createSyncAccountDirectoryHealth,
  type SyncMobileProjectSummary,
  type SyncAccountDirectoryHealth,
  type SyncPairingConnectInfo,
  type SyncProjectForgetRequestPayload,
  type SyncProjectForgetResultPayload,
  type SyncProjectOpenRequestPayload,
  type SyncProjectSwitchRequestPayload,
  type SyncProjectSwitchResultPayload,
  type SyncRoleSnapshot,
} from "../../desktop/src/shared/types/sync";
import {
  isCurrentProcessDescendantOfPid,
  type AdeServiceCommand,
} from "./serviceManager/common";
import { normalizeAdeRuntimeRole, resolveAdeDefaultRole } from "./runtimeRoles";
import type { AdeRuntime } from "./bootstrap";
import { reseedBundledAdeSkillsForCli } from "./bootstrap";
import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";
import type { AccountMachinePublisherService } from "./services/account/accountMachinePublisherService";
import { shouldRejectDevelopmentEnvCredential } from "./services/account/accountAuthService";
import { DEFAULT_SYNC_HOST_PORT } from "./services/sync/syncProtocol";
import {
  runAdeCodeRemote,
  takeAdeCodeRemoteArgs,
} from "./tuiClient/remoteLauncher";
import { copyToClipboard } from "./lib/clipboard";
import {
  clearLastFailure,
  computeStartupBackoffMs,
  lastFailurePathForMachine,
  readLastFailure,
  recordLastFailure,
} from "../../desktop/src/main/services/runtime/lastFailureStore";
import type { AdeLastFailureReport, AdeRecoveryErrorCode } from "../../desktop/src/shared/types/recovery";
import { createDiskPressureMonitor } from "../../desktop/src/main/services/storage/diskPressure";
import { isUrgentDiskPressure } from "../../desktop/src/shared/types/storage";
import { boundLaunchdLogs } from "./services/runtime/runtimeLogMaintenance";

type JsonObject = Record<string, unknown>;

type SyncWebPairingCliOutput = {
  pairingUrl: string | null;
  code: string | null;
  pinConfigured: boolean;
  machineName: string;
  relayEnabled: boolean;
};

type GlobalOptions = {
  projectRoot: string | null;
  workspaceRoot: string | null;
  role: "cto" | "orchestrator" | "agent" | "external" | "evaluator";
  headless: boolean;
  requireSocket: boolean;
  socketPath: string | null;
  pretty: boolean;
  text: boolean;
  timeoutMs: number;
};

async function withAdeDefaultRole<T>(
  role: GlobalOptions["role"],
  run: () => Promise<T> | T,
): Promise<T> {
  const previousRole = process.env.ADE_DEFAULT_ROLE;
  process.env.ADE_DEFAULT_ROLE = role;
  try {
    return await run();
  } finally {
    if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
    else process.env.ADE_DEFAULT_ROLE = previousRole;
  }
}

type ParsedCli = {
  options: GlobalOptions;
  command: string[];
};

const DEFAULT_EPHEMERAL_RUNTIME_IDLE_EXIT_MS = 5 * 60 * 1000;
const MIN_RUNTIME_IDLE_EXIT_MS = 5_000;

type InvocationStep = {
  key: string;
  method: string;
  params?: JsonObject | ((values: JsonObject) => JsonObject);
  unwrapToolResult?: boolean;
  optional?: boolean;
  injectProjectRootIntoArgs?: boolean;
};

type FormatterId =
  | "status"
  | "doctor"
  | "auth"
  | "account-auth"
  | "account-token"
  | "account-machines"
  | "projects-list"
  | "linear-quick-view"
  | "lanes"
  | "lane-detail"
  | "git-status"
  | "diff-summary"
  | "file-read"
  | "files-tree"
  | "files-search"
  | "prs-list"
  | "pr-create"
  | "pr-detail"
  | "pr-checks"
  | "pr-comments"
  | "run-defs"
  | "run-runtime"
  | "chat-list"
  | "chat-read"
  | "tests-runs"
  | "proof-list"
  | "ios-sim-status"
  | "ios-sim-devices"
  | "ios-sim-apps"
  | "ios-sim-stream"
  | "ios-sim-snapshot"
  | "ios-sim-selection"
  | "ios-sim-preview"
  | "app-control-status"
  | "app-control-snapshot"
  | "app-control-selection"
  | "browser-status"
  | "browser-sessions"
  | "browser-observation"
  | "browser-trace"
  | "pty-create"
  | "terminal-list"
  | "terminal-read"
  | "project-secrets"
  | "history-list"
  | "history-commits"
  | "history-show"
  | "actions-list"
  | "action-result"
  | "automation-run-detail"
  | "automation-ingress"
  | "automation-linear-ingress"
  | "automation-cleanups"
  | "search-results"
  | "search-status"
  | "external-sessions"
  | "storage-snapshot"
  | "storage-compress"
  | "sync-status"
  | "sync-web";

type ChatWaitTarget =
  | "idle"
  | "active"
  | "awaiting-input"
  | "terminal";

type CliPlan =
  | { kind: "help"; text: string }
  | { kind: "static"; value: unknown; formatter?: FormatterId }
  | {
      kind: "execute";
      label: string;
      steps: InvocationStep[];
      visualizer?: "lanes";
      summary?: "status" | "doctor" | "auth";
      formatter?: FormatterId;
      preferHeadless?: boolean;
      machineOnly?: boolean;
      machineAutoStart?: boolean;
      /**
       * Force the connection for this plan to assert a specific runtime role
       * instead of the global CLI default. Used by `ade logout`, whose `signOut`
       * account action is CTO-only, so it must connect as the machine operator.
       */
      connectRole?: GlobalOptions["role"];
      historyOperationId?: string;
      historyStatusFilter?: string;
      historyListFilters?: {
        laneId?: string | null;
        kind?: string | null;
        status?: string;
      };
      writeResultPath?: string;
      syncWebOpen?: boolean;
      syncWebNoClipboard?: boolean;
      laneCreationNudge?: { newLaneName: string };
      /**
       * Derive a nonzero exit code from the executed result (e.g. `ade search`
       * exits 1 when a query returns no results, so scripts can branch on it).
       */
      exitCodeFromResult?: (result: unknown) => number;
    }
  | { kind: "ade-code"; rest: string[] }
  | { kind: "desktop"; rest: string[] }
  | { kind: "runtime"; rest: string[] }
  | { kind: "brain"; rest: string[] }
  | { kind: "serve"; rest: string[] }
  | { kind: "rpc-stdio"; rest: string[] }
  | { kind: "pty-host-worker" }
  | { kind: "init"; targetPath: string | null }
  | { kind: "cursor-cloud"; rest: string[] }
  | { kind: "deeplink"; rest: string[] }
  | { kind: "skill"; rest: string[] }
  | {
      kind: "chat-wait";
      sessionId: string;
      waitFor: ChatWaitTarget;
      timeoutMs: number;
      pollIntervalMs: number;
    }
  | { kind: "github-app-login"; maxWaitSec: number | null }
  | { kind: "account-login"; maxWaitSec: number | null; explicitHeadless: boolean }
  | { kind: "account-machine-connect"; machine: string; remoteArgs: string[] };

type CliConnection = {
  mode: "desktop-socket" | "runtime-socket" | "headless";
  projectRoot: string;
  workspaceRoot: string;
  socketPath: string;
  request: (method: string, params?: JsonObject) => Promise<unknown>;
  close: () => Promise<void> | void;
};

class CliUsageError extends Error {}

class CliToolError extends Error {
  details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

class CliExecutionError extends Error {
  details: JsonObject;

  constructor(message: string, details: JsonObject) {
    super(message);
    this.details = details;
  }
}

type ReadinessCheck = {
  ready: boolean;
  status: "ready" | "warning" | "missing" | "unavailable";
  message: string;
  nextAction?: string;
  details?: JsonObject;
};

declare const __ADE_VERSION__: string | undefined;

const BUNDLED_VERSION =
  typeof __ADE_VERSION__ === "string" ? __ADE_VERSION__.trim() : "";
const ENV_VERSION = process.env.ADE_CLI_VERSION?.trim() ?? "";
const VERSION =
  BUNDLED_VERSION && BUNDLED_VERSION !== "0.0.0"
    ? BUNDLED_VERSION
    : ENV_VERSION || BUNDLED_VERSION || "0.0.0";
const PLACEHOLDER_VERSION = "0.0.0";
const PROTOCOL_VERSION = "2025-06-18";
const SOURCE_FALLBACK_ENV = "ADE_CLI_SOURCE_FALLBACK_ACTIVE";
const CLI_ENTRY_PATH =
  typeof process.argv[1] === "string" ? path.resolve(process.argv[1]) : "";
const CLI_PACKAGE_ROOT = resolveCliPackageRoot(CLI_ENTRY_PATH);
const CLI_DIST_PATH = path.join(CLI_PACKAGE_ROOT, "dist", "cli.cjs");
function resolveCliPackageRoot(entryPath: string): string {
  const seen = new Set<string>();
  const starts = [entryPath ? path.dirname(entryPath) : null, process.cwd()];
  for (const start of starts) {
    if (!start) continue;
    let cursor = path.resolve(start);
    while (!seen.has(cursor)) {
      seen.add(cursor);
      const packageJson = path.join(cursor, "package.json");
      const srcCli = path.join(cursor, "src", "cli.ts");
      if (fs.existsSync(packageJson) && fs.existsSync(srcCli)) {
        return cursor;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return path.resolve(process.cwd(), "apps", "ade-cli");
}

function isSourceCliEntryPath(modulePath: string): boolean {
  return /[/\\]src[/\\]cli\.ts$/i.test(modulePath);
}

function isSourceCheckoutCliEntryPath(modulePath: string): boolean {
  return (
    isSourceCliEntryPath(modulePath) ||
    /[/\\]apps[/\\]ade-cli[/\\]dist[/\\]cli\.cjs$/i.test(modulePath)
  );
}

function isPackagedElectronCliRuntime(): boolean {
  return Boolean(process.versions.electron) && !isSourceCheckoutCliEntryPath(CLI_ENTRY_PATH);
}

function automationsCliEnabled(): boolean {
  const override = readAutomationsEnvOverride(process.env);
  if (override !== null) return override;
  return true;
}

function internalFeatureUnavailableHelp(title: string, message: string, enableEnv: string): string {
  return `${ADE_BANNER}
  ${title}

  ${message}
  Internal testing can opt in with ${enableEnv}=1.
`;
}

function assertAutomationsCliEnabled(): void {
  if (automationsCliEnabled()) return;
  throw new CliUsageError(
    `${AUTOMATIONS_COMING_SOON_MESSAGE} Internal testing can opt in with ADE_ENABLE_AUTOMATIONS=1.`,
  );
}

function isSourceRuntimeInteropError(value: unknown): boolean {
  const message =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : "";
  if (!message.length) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("__filename is not defined in es module scope") ||
    lower.includes("__filename is not defined") ||
    lower.includes("__dirname is not defined")
  );
}

function formatSpawnFailure(
  result: ReturnType<typeof spawnSync>,
  fallbackCommand: string,
): string {
  if (result.error) {
    return result.error.message;
  }
  const status = typeof result.status === "number" ? result.status : "unknown";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const detail = stderr || stdout || "No output captured.";
  return `${fallbackCommand} exited with status ${status}: ${detail}`;
}

function latestMtimeMs(root: string): number {
  let latest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestMtimeMs(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      latest = Math.max(latest, fs.statSync(fullPath).mtimeMs);
    } catch {
      // Ignore files that disappear while checking freshness.
    }
  }
  return latest;
}

function isBuiltCliFresh(): boolean {
  try {
    const distMtime = fs.statSync(CLI_DIST_PATH).mtimeMs;
    const sourceMtime = latestMtimeMs(path.join(CLI_PACKAGE_ROOT, "src"));
    return distMtime >= sourceMtime;
  } catch {
    return false;
  }
}

function maybeRunBuiltCliFallback(
  error: unknown,
  argv: string[],
): { stdout: string; stderr: string; exitCode: number } | null {
  if (!(error instanceof CliExecutionError)) return null;
  if (process.env[SOURCE_FALLBACK_ENV] === "1") return null;
  if (!isSourceCliEntryPath(CLI_ENTRY_PATH)) return null;
  if (
    !isSourceRuntimeInteropError(asString(error.details.cause) ?? error.message)
  )
    return null;

  if (!isBuiltCliFresh()) {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const buildResult = spawnSync(npmCommand, ["run", "build", "--silent"], {
      cwd: CLI_PACKAGE_ROOT,
      env: process.env,
      encoding: "utf8",
    });
    if (buildResult.error || buildResult.status !== 0 || !isBuiltCliFresh()) {
      error.details.nextAction =
        "Run `npm --prefix apps/ade-cli run build` and retry the command.";
      error.details.fallback = formatSpawnFailure(
        buildResult,
        "npm run build --silent",
      );
      return null;
    }
  }

  const rerun = spawnSync(process.execPath, [CLI_DIST_PATH, ...argv], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [SOURCE_FALLBACK_ENV]: "1",
    },
    encoding: "utf8",
  });
  if (rerun.error) {
    error.details.nextAction =
      "Run `node apps/ade-cli/dist/cli.cjs ...` directly to inspect the runtime failure.";
    error.details.fallback = rerun.error.message;
    return null;
  }

  return {
    stdout: typeof rerun.stdout === "string" ? rerun.stdout : "",
    stderr: typeof rerun.stderr === "string" ? rerun.stderr : "",
    exitCode: rerun.status ?? 1,
  };
}

const ADE_BANNER = String.raw`
     _    ____  _____
    / \  |  _ \| ____|
   / _ \ | | | |  _|
  / ___ \| |_| | |___
 /_/   \_\____/|_____|
`;

const TOP_LEVEL_HELP = `${ADE_BANNER}
  Agent-focused command-line interface for ADE.

  ADE CLI commands operate through the machine ADE brain by default.
  The brain is the always-on ADE process for this machine: it owns the project
  catalog, sync endpoint, and execution authority for the channel.

    $ ade help <command...>                         Display help for a command
    $ ade login [--headless] [--max-wait <seconds>] Sign in to the optional ADE account
    $ ade logout                                    Sign out of the ADE account
    $ ade auth status                               Show ADE account sign-in status
    $ ade account token create                      Print a durable token for ADE_ACCOUNT_TOKEN
    $ ade machines list                             List machines from the ADE account directory
    $ ade machines connect <id|name>                Connect ADE Code to an online account machine
    $ ade code                                      Open ADE Work chat in the terminal
    $ ade new chat --mode chat|cli --prompt "fix"   Start an ADE Work chat or tracked CLI session
    $ ade desktop                                   Launch the installed desktop app
    $ ade open <url>                                Open an ade:// or ade-app.dev deeplink via the OS
    $ ade link lane | session | file | commit | artifact | branch | pr | linear-issue
                                                     Build a shareable deeplink (copies to clipboard)
    $ ade linear install                            Register ADE as Linear's "Open in coding tool" target
    $ ade skill list | show <name>                  Browse ADE's bundled agent skills (local)
    $ ade brain start | stop | status               Manage the background ADE brain
    $ ade runtime run --socket <path>               Run a manual runtime for dev/test work
    $ ade rpc --stdio                               Speak ADE JSON-RPC over stdin/stdout
    $ ade init [path]                               Register a project with this machine brain
    $ ade projects list                             List projects registered on this machine
    $ ade sync web [--open] [--no-clipboard]        Print (and copy) the web client pairing link + code
    $ ade sync status | pin generate                Manage machine sync and phone pairing
    $ ade doctor                                    Inspect project, brain, runtime, and tool availability
    $ ade lanes list | show | create | child        Work with lanes and lane stacks
    $ ade git status | commit | push | stash        Run ADE-aware git operations
    $ ade operations status | wait                  Poll operation/test/chat/run status
    $ ade diff changes | file | patch               Inspect lane diffs (including raw git patch text)
    $ ade files tree | read | write | search        Read and edit lane workspaces
    $ ade search "<query>" --text                    Search chats, terminals, PRs, commits, lanes, files, Linear
    $ ade prs list | create | show | checks          Manage PRs, queues, and GitHub integration
    $ ade run defs | ps | start | logs              Manage Run tab process definitions and runtime
    $ ade shell start | write | resize | close      Launch and control tracked shell sessions
    $ ade terminal list | resume | read | write | signal
                                                    Control an attached session terminal
    $ ade history list | show | commits | export     Inspect ADE operation timeline and lane commits
    $ ade chat list | create | send | interrupt     Work with ADE agent chats
    $ ade linear attach | comment | set-state | issue | graphql
                                                    Read and write attached Linear issues
    $ ade github app-auth login | status | clear    Authorize the machine ADE GitHub App (device flow)
    $ ade automations list | create | run | runs    Manage automation rules
    $ ade coordinator <tool>                        Call coordinator runtime tools
    $ ade tests list | run | stop | runs | logs     Run configured test suites
    $ ade proof status | list | screenshot | record Manage proof and computer-use artifacts
    $ ade ios-sim devices | apps | launch | tap    Control iOS Simulator apps, capture, and input
    $ ade app-control launch | snapshot | click    Inspect and drive Electron apps
    $ ade browser open | tabs | screenshot         Use ADE's built-in browser pane
    $ ade usage snapshot | refresh | budget         Read provider quota usage and budget guardrails
    $ ade storage snapshot | compress               Inspect ADE disk usage and compress old history
    $ ade secrets list | get | set | delete          Manage encrypted ADE project secrets for agents
    $ ade settings pr-transcript-gists enable      Attach ADE chat transcript links to new PRs
    $ ade settings action <method>                  Call project config actions
    $ ade update status | check | install | dismiss Read auto-update state and drive install
    $ ade actions list | run | status | wait        Escape hatch for every ADE service action
    $ ade cursor cloud agents | runs | artifacts | repos | models | me
                                                    Drive Cursor Cloud agents via @cursor/sdk

  Global options:
    --project-root <path>   ADE project root. Inside .ade/worktrees/<lane>, this resolves to the parent project.
    --workspace-root <path> Lane/worktree to treat as the active workspace.
    --headless              Skip the machine brain and run an in-process ADE runtime.
    --socket                Require a live ADE endpoint; fail instead of falling back to headless.
    --json                  Print machine-readable JSON. This is the default output mode.
    --text                  Print a compact human-readable summary when a formatter exists.
    --timeout-ms <ms>       Per-request timeout. Long agent/PR workflows may need several minutes.

  Common agent flows:
    $ ade doctor --text
    $ ade lanes list --text
    $ ade lanes create --name fix-login --description "Repair login redirect"
    $ ade git status --lane <lane> --text
    $ ade git status --full --lane <lane> --text
    $ ade git sync --lane <lane> --rebase --base main
    $ ade git stage --lane <lane> src/index.ts
    $ ade git commit --lane <lane> -m "Fix login redirect"
    $ ade prs create --lane <lane> --base main --draft
    $ ade prs checks <pr-id-or-number-or-url> --text
    $ ade proof record --seconds 20
    $ ade ios-sim apps --text
    $ ade ios-sim launch --target <id> --text
    $ ade app-control launch --command "pnpm dev" --text
    $ ade --socket browser open http://localhost:5173 --new-tab --text
    $ ade terminal read --chat-session <owner-session-id> --text
    $ ade terminal read --pty <pty-id> --text
    $ ade new chat --mode chat --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the tests"
    $ ade new chat --mode cli --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the tests"

  Generic ADE action JSON contract:
    Object-shaped call:
      $ ade actions run git.push --input-json '{"laneId":"lane-1","setUpstream":true}'
      $ ade actions run git.push --arg laneId=lane-1 --arg setUpstream=true
    JSON value fields:
      $ ade actions run pr.setLabels --arg prId=123 --arg-json 'labels=["ready","ship"]'
    Multi-parameter service call:
      $ ade actions run pr.submitReview --args-list-json '["pr-1",{"event":"APPROVE"}]'
    $ ade actions list --text
    $ ade actions list --domain pr --text
    $ ade actions run <domain.action> --input-json '{"key":"value"}'

  Start with: ade doctor --text
`;

function topLevelHelpText(): string {
  let text = TOP_LEVEL_HELP;
  if (!automationsCliEnabled()) {
    text = text.replace(
      /    \$ ade automations list \| create \| run \| runs    Manage automation rules\n/,
      "",
    );
  }
  return text;
}

function commandHelpText(key: string): string | undefined {
  if (key === "automations" && !automationsCliEnabled()) {
    return internalFeatureUnavailableHelp(
      "Automations",
      AUTOMATIONS_COMING_SOON_MESSAGE,
      "ADE_ENABLE_AUTOMATIONS",
    );
  }
  return HELP_BY_COMMAND[key];
}

function helpKeyWithSubcommand(primaryKey: string, args: readonly string[]): string {
  const subcommand = args.find((arg) => arg !== "--" && !arg.startsWith("-"));
  if (!subcommand) return primaryKey;
  const normalizedSubcommand = subcommand.toLowerCase();
  if (primaryKey === "chat" && normalizedSubcommand === "spawn") return "chat create";
  if (primaryKey === "agent" && normalizedSubcommand === "start") return "agent spawn";
  if (primaryKey === "new" && normalizedSubcommand === "cli") return "new chat";
  return `${primaryKey} ${normalizedSubcommand}`;
}

const IOS_SIMULATOR_SUBCOMMAND_HELP: Record<string, string> = {
  status: `${ADE_BANNER}
  iOS Simulator: status

  Shows macOS support, Xcode and simulator-control readiness, the active booted device,
  and the drawer's active simulator session. Start here when a simulator action
  fails or when an agent needs to know whether ADE owns a running session.

    $ ade --socket ios-sim status --text

  Flags:
    --text                 Compact human-readable readiness summary.
    --json                 Full JSON payload with tool install hints.
`,
  devices: `${ADE_BANNER}
  iOS Simulator: devices

  Lists available iOS simulator devices. Aliases: list, ls.

    $ ade --socket ios-sim devices --text

  Flags:
    --text                 Compact table.
    --json                 Full device records.
`,
  apps: `${ADE_BANNER}
  iOS Simulator: apps

  Lists launchable app targets from root-level .xcodeproj bundles,
  apps/*/*.xcodeproj projects, DerivedData, and apps already installed on the
  selected simulator. Aliases: targets, launchable, launchables.

    $ ade --socket ios-sim apps --device <udid> --text

  Flags:
    --device, --udid <id>  Simulator device to inspect.
    --project-root <path>  ADE project root to scan for iOS projects.
    --text                 Compact table with target ids.
`,
  launch: `${ADE_BANNER}
  iOS Simulator: launch

  Boots the simulator, resolves/builds/installs a target, launches the app, and
  claims the ADE drawer session. Use --socket when the drawer and agents should
  share one long-lived simulator service. Alias: open.

    $ ade --socket ios-sim launch --target <id> --text
    $ ade --socket ios-sim launch --bundle-id com.example.app --no-build --text

  Flags:
    --device, --udid <id>       Simulator device.
    --target, --target-id <id>  Target id from "ios-sim apps".
    --bundle-id, --bundle <id>  Launch an installed app by bundle id.
    --app-bundle, --app <path>  Install/launch a built .app bundle.
    --project, --xcodeproj <p>  Xcode project path.
    --scheme <name>             Xcode scheme.
    --project-root <path>       ADE project root.
    --lane, --lane-id <id>      Lane to bind this simulator session to.
    --chat-session <id>         Owner chat session for the single-owner lock.
    --no-build                  Skip xcodebuild.
    --mode snapshot|live        Inspector launch mode; default live.
    --background                Leave Simulator.app in the background without parking it under ADE.
    --arg KEY=VALUE             Extra service args for advanced launch options.
`,
  shutdown: `${ADE_BANNER}
  iOS Simulator: shutdown

  Stops live view state, releases the drawer session, and clears related simulator work.
  Aliases: stop, teardown, end, end-session.

    $ ade --socket ios-sim shutdown --text
    $ ade --socket ios-sim shutdown --force --text

  Flags:
    --force, -f            Release a session owned by another chat.
    --device, --udid <id>  Optional device context for cleanup.
`,
  actions: `${ADE_BANNER}
  iOS Simulator: actions

  Lists every callable ios_simulator action exposed through ADE's generic action
  bridge. Use this when a typed subcommand is missing a niche argument.

    $ ade --socket ios-sim actions --text
    $ ade actions run ios_simulator.getStatus --text
`,
  screenshot: `${ADE_BANNER}
  iOS Simulator: screenshot

  Captures a one-shot PNG from the simulator via simctl. Alias: capture.

    $ ade --socket ios-sim screenshot --device <udid> --text

  Flags:
    --device, --udid <id>  Simulator device; defaults to the active session or booted device.
`,
  snapshot: `${ADE_BANNER}
  iOS Simulator: snapshot

  Captures screenshot + ADEInspector/accessibility elements for the current
  simulator screen. Use this before asking an agent to find the current screen
  in SwiftUI code. Aliases: screen, elements.

    $ ade --socket ios-sim snapshot --text

  Flags:
    --device, --udid <id>  Simulator device.
    --project-root <path>  Project root for source matching.
    --arg x=<n> --arg y=<n> Optional hit-test point in screenshot pixels.
`,
  inspector: `${ADE_BANNER}
  iOS Simulator: inspector

  Reads the DEBUG ADEInspector snapshot published by the launched app. This is
  lower-level than "snapshot" and does not include screenshot/accessibility fallback.

    $ ade --socket ios-sim inspector --text

  Flags:
    --device, --udid <id>  Simulator device.
`,
  inspect: `${ADE_BANNER}
  iOS Simulator: inspect

  Hit-tests a point and returns the best matching context item without committing
  it to the drawer composer. Aliases: hit-test, hover.

    $ ade --socket ios-sim inspect --x 120 --y 420 --screenshot --text

  Flags:
    --x <n> --y <n>        Required screenshot-pixel coordinates.
    --device, --udid <id>  Simulator device.
    --project-root <path>  Project root for Swift source matching.
    --screenshot           Include screenshot data in the context result.
`,
  "preview-status": `${ADE_BANNER}
  iOS Simulator: preview-status

  Checks Xcode Preview Lab readiness: Xcode version, mcpbridge availability,
  Xcode running state, selected project window, setup warnings, and docs URL.
  Alias: preview-doctor.

    $ ade --socket ios-sim preview-status --source apps/ios/ADE/Views/Home.swift --line 42 --text

  Flags:
    --project-root <path>  ADE project root.
    --source, --file <p>   Swift file used to bias preview discovery.
    --line <n>             Source line used to bias preview discovery.
`,
  previews: `${ADE_BANNER}
  iOS Simulator: previews

  Lists discoverable #Preview and PreviewProvider definitions, ranked around a
  selected Swift file when supplied. Aliases: preview-list, list-previews.

    $ ade --socket ios-sim previews --source apps/ios/ADE/Views/Home.swift --text

  Flags:
    --project-root <path>  ADE project root.
    --source, --file <p>   Swift file to rank nearby previews.
    --line <n>             Optional source line.
`,
  "preview-match": `${ADE_BANNER}
  iOS Simulator: preview-match

  Resolves the best Preview Lab target for the current simulator/source context.
  Aliases: match-preview, resolve-preview.

    $ ade --socket ios-sim preview-match --source apps/ios/ADE/Views/Home.swift --line 42 --text

  Flags:
    --project-root <path>  ADE project root.
    --source, --file <p>   Selected Swift file.
    --line <n>             Optional source line.
    --label <text>         Visible element label used for a suggested preview title.
    --component-id <id>    ADEInspector component id used for a suggested preview.
`,
  "preview-ensure": `${ADE_BANNER}
  iOS Simulator: preview-ensure

  Opens this lane's iOS project in Xcode when needed and waits briefly for
  Xcode MCP Preview Lab readiness. Aliases: ensure-preview, preview-workspace.

    $ ade --socket ios-sim preview-ensure --text

  Flags:
    --project-root <path>  ADE project root.
    --source, --file <p>   Optional Swift file context.
    --line <n>             Optional source line.
    --no-open              Check readiness without opening Xcode.
    --timeout-ms <n>       Wait time for Xcode readiness; default 12000.
`,
  "preview-render": `${ADE_BANNER}
  iOS Simulator: preview-render

  Renders a SwiftUI preview through Xcode MCP and returns the snapshot path/data.
  This is the final command agents should run after finding or adding a preview.
  Aliases: render-preview, preview.

    $ ade --socket ios-sim preview-render --source apps/ios/ADE/Views/Home.swift --index 0 --text

  Flags:
    --source, --file <p>   Required Swift source file. Absolute, project-relative,
                           or Xcode-project-relative paths are accepted.
    --index <n>            Preview definition index in the file; default 0.
    --tab, --tab-identifier <id> Xcode window tab from preview-status.
    --timeout <sec>        Render timeout, 5-240 seconds; default 120.
    --project-root <path>  ADE project root.
`,
  "preview-current": `${ADE_BANNER}
  iOS Simulator: preview-current

  Resolves and renders the Preview Lab target for the current simulator
  selection. Run "select" first, or pass --source/--line explicitly.
  Aliases: current-preview, preview-open-current, open-current-preview.

    $ ade --socket ios-sim select --x 120 --y 420 --text
    $ ade --socket ios-sim preview-current --text
    $ ade --socket ios-sim preview-current --source apps/ios/ADE/Views/Home.swift --line 42 --text

  Flags:
    --source, --file <p>   Optional Swift source file; defaults to last selected element.
    --line <n>             Optional source line; defaults to last selected element.
    --label <text>         Visible element label used for a suggested preview title.
    --component-id <id>    ADEInspector component id used for a suggested preview.
    --tab, --tab-identifier <id> Xcode window tab from preview-status.
    --timeout <sec>        Render timeout, 5-240 seconds; default 120.
    --project-root <path>  ADE project root.
`,
  "preview-open": `${ADE_BANNER}
  iOS Simulator: preview-open

  Opens apps/ios/ADE.xcodeproj in Xcode so Xcode MCP Preview Lab can connect.
  Aliases: open-preview-workspace, open-xcode.

    $ ade ios-sim preview-open --project-root <path> --text

  Flags:
    --project-root <path>  ADE project root.
`,
  "stream-start": `${ADE_BANNER}
  iOS Simulator: stream-start

  Starts ADE's live view for the running simulator. Simulator control tools
  enable tap, drag, type, and inspect actions when available.
  Aliases:
  start-stream, stream, window-start,
  start-window, mirror-start, live-start, start-live.

    $ ade --socket ios-sim window-start --fps 60 --text
    $ ade --socket ios-sim live-start --fps 60 --text

  Flags:
    --device, --udid <id>  Simulator device.
    --fps <n>              Target fps.
`,
  "stream-status": `${ADE_BANNER}
  iOS Simulator: stream-status

  Shows whether the live view is active, the refresh rate, simulator control
  status, and last error.

    $ ade --socket ios-sim stream-status --text
`,
  "stream-stop": `${ADE_BANNER}
  iOS Simulator: stream-stop

  Stops the live view without necessarily releasing the simulator session.
  Aliases: stop-stream, live-stop, stop-live.

    $ ade --socket ios-sim stream-stop --text
`,
  select: `${ADE_BANNER}
  iOS Simulator: select

  Hit-tests a point, emits a drawer selection event, and attaches the resulting
  iOS context to the active chat composer. Use --socket so the drawer receives it.

    $ ade --socket ios-sim select --x 120 --y 420 --text

  Flags:
    --x <n> --y <n>        Required screenshot-pixel coordinates.
    --device, --udid <id>  Simulator device.
    --project-root <path>  Project root for Swift source matching.
`,
  tap: `${ADE_BANNER}
  iOS Simulator: tap

  Sends a tap when simulator controls are available.

    $ ade --socket ios-sim tap --x 120 --y 420 --text
    $ ade --socket ios-sim tap 120 420 --text

  Flags:
    --x <n> --y <n>        Required point coordinates.
    --device, --udid <id>  Simulator device.
    --project-root <path>  Project root.
`,
  drag: `${ADE_BANNER}
  iOS Simulator: drag / swipe

  Sends a swipe to the active launched app. "swipe" is an alias of drag.

    $ ade --socket ios-sim drag --start-x 120 --start-y 700 --end-x 120 --end-y 250 --text
    $ ade --socket ios-sim swipe 120 700 120 250 --duration-ms 250 --text

  Flags:
    --start-x <n> --start-y <n> Required start coordinates.
    --end-x <n> --end-y <n>     Required end coordinates.
    --duration-ms <n>           Swipe duration in milliseconds.
    --device, --udid <id>       Simulator device.
    --project-root <path>       Project root.
`,
  type: `${ADE_BANNER}
  iOS Simulator: type

  Types text into the active launched app. Alias: text.

    $ ade --socket ios-sim type "hello" --text
    $ ade --socket ios-sim type --value "hello" --text

  Flags:
    --value, --message <v> Text to type. --text <value> is also accepted for
                           compatibility, but --text by itself controls ADE's
                           human-readable output mode.
    --device, --udid <id>  Simulator device.
    --project-root <path>  Project root.
`,
};

const IOS_SIMULATOR_HELP_ALIASES: Record<string, string> = {
  list: "devices",
  ls: "devices",
  targets: "apps",
  launchable: "apps",
  launchables: "apps",
  open: "launch",
  stop: "shutdown",
  teardown: "shutdown",
  end: "shutdown",
  "end-session": "shutdown",
  capture: "screenshot",
  screen: "snapshot",
  elements: "snapshot",
  "hit-test": "inspect",
  hover: "inspect",
  "preview-doctor": "preview-status",
  "preview-list": "previews",
  "list-previews": "previews",
  "match-preview": "preview-match",
  "resolve-preview": "preview-match",
  "ensure-preview": "preview-ensure",
  "preview-workspace": "preview-ensure",
  "render-preview": "preview-render",
  preview: "preview-render",
  "current-preview": "preview-current",
  "preview-open-current": "preview-current",
  "open-current-preview": "preview-current",
  "render-current-preview": "preview-current",
  "open-preview-workspace": "preview-open",
  "open-xcode": "preview-open",
  "start-stream": "stream-start",
  stream: "stream-start",
  "window-start": "stream-start",
  "start-window": "stream-start",
  "mirror-start": "stream-start",
  "start-mirror": "stream-start",
  "live-start": "stream-start",
  "start-live": "stream-start",
  "preview-start": "stream-start",
  "start-preview": "stream-start",
  "stop-stream": "stream-stop",
  "live-stop": "stream-stop",
  "stop-live": "stream-stop",
  "preview-stop": "stream-stop",
  "stop-preview": "stream-stop",
  swipe: "drag",
  text: "type",
};

const HELP_BY_COMMAND: Record<string, string> = {
  auth: `${ADE_BANNER}
  ADE Account

  ADE accounts are optional. Signing in unlocks remote-machine and account
  directory features; every local ADE workflow continues to work signed out.

    $ ade login                    Sign in with loopback OAuth or auto-detected device flow
    $ ade login --headless         Print a verification URL + code for another browser
    $ ade logout                   Clear the shared machine account session
    $ ade auth status --text       Show the shared machine account status
    $ ade account token create     Print a self-contained durable token once for agent/CI setup

  Flags (login):
    --headless                     Force the copy-paste device authorization flow.
    --max-wait <seconds>           Give up waiting before the authorization
                                   session expires.
`,
  machines: `${ADE_BANNER}
  ADE account machines

  The machine directory is optional. Local ADE, PIN pairing, saved SSH targets,
  and explicit remote addresses continue to work while signed out.

    $ ade machines list --text
    $ ade machines connect <machine-key>
    $ ade machines connect <device-id> --project <project-id|name|path>
    $ ade machines hop <unambiguous-name> --session <session-id|title>

  Machine keys and device ids are stable selectors. An exact display name is
  accepted only when it identifies one machine; ambiguous names fail with the
  stable machine keys to choose from. Offline machines are listed but cannot be
  connected.

  Sign in with \`ade login\`. \`connect\` and its \`hop\` alias securely save the
  selected machine for that account, then launch ADE Code. Signing out removes
  machines added through the account from this ADE install. Machines you pair
  directly with a PIN, SSH, or an address stay saved after sign-out.
`,
  search: `${ADE_BANNER}
  ADE Search

  Search across everything ADE indexes — chat transcripts, terminal scrollback,
  CLI sessions, PRs, commits, branches, lanes, files, Linear issues, and proof
  artifacts — from one deterministic full-text index. Returns ranked matches
  with a deep link per result. Prefer this over grepping .ade/ internals.

    $ ade search "login redirect" --text
    $ ade search "flaky test" --kind chat,terminal --text
    $ ade search "auth" --lane fix-login --limit 10 --json
    $ ade search "rate limit" --cursor <nextCursor> --text
    $ ade search --status --text
    $ ade search --rebuild --text

  Query syntax (passed through to the index):
    bare terms         AND-ed together        ade search "retry backoff"
    "quoted phrase"    exact phrase           ade search '"connection refused"'
    kind:<kind>        restrict to a kind     ade search "kind:pr merge queue"
    lane:<name>        restrict to a lane     ade search "lane:fix-login timeout"
    session:<id>       restrict to a session  ade search "session:abc123 panic"
    since:<date>       recency floor          ade search "since:2026-06-01 crash"

  Flags:
    --kind, --kinds <a,b>   Comma-separated kinds to include. One or more of:
                            lane, chat, terminal, pr, commit, branch, file,
                            linear, artifact. Unknown kinds are rejected.
    --lane, --lane-id <id>  Restrict to a lane (id or name; the service resolves names).
    --limit <n>             Max results to return.
    --cursor <c>            Continue from a previous query's nextCursor.
    --actions               List the raw search service actions exposed via ADE actions.
    --status                Show index doc counts, backfill state, and index path.
    --rebuild               Rebuild the whole index from scratch (CTO-only).
    --text                  Aligned KIND/TITLE/SNIPPET/ID rows plus a count summary.
    --json                  Full SearchQueryResult payload (default).

  Exit codes:
    0  query returned at least one result
    1  query returned no results (script-friendly)
    2  usage error (e.g. unknown --kind)
`,
  desktop: `${ADE_BANNER}
  ADE Desktop

  Launch the installed ADE desktop app. The desktop app attaches to the normal
  machine brain and starts it if needed.

    $ ade desktop
    $ ade desktop open

  Flags:
    --app-name <name>       macOS app name to open. Defaults to ADE, ADE Beta,
                            or ADE Alpha based on the installed CLI wrapper.
`,
  github: `${ADE_BANNER}
  ADE GitHub

  Authorize the machine-scoped ADE GitHub App so headless / brain setups (which
  have no Settings panel) can use the hosted PR-sync webhook relay. Uses GitHub's
  device flow: ADE prints a short user code and a verification URL, you approve
  in a browser, and ADE stores the resulting user token in the machine credential
  store. The token itself is never printed.

    $ ade --role cto github app-auth login     Start device flow and wait for approval
    $ ade github app-auth status --text        Show whether a token is stored (login, expiry)
    $ ade --role cto github app-auth clear      Remove the stored authorization
    $ ade github actions --text                 List raw github service actions

  Notes:
    - login, clear (and the raw start/poll actions) require --role cto.
    - login keeps one connection open for the whole device flow because the
      device-auth session lives in runtime memory; do not split start and poll
      across separate invocations in headless mode.

  Flags (login):
    --max-wait <seconds>    Give up waiting after N seconds (default: GitHub's
                            device-code expiry, ~15 min).
`,
  open: `${ADE_BANNER}
  ADE Open

  Hand an "ade://" or "https://ade-app.dev/open?..." deeplink to the OS so the
  installed ADE desktop receives it (single-instance lock focuses the existing
  window). Also accepts the Linear coding-tool hand-off form.

    $ ade open ade://lane/<lane-uuid>
    $ ade open ade://session/<session-id>
    $ ade open ade://repo/<owner>/<repo>/branch/<branch>?pr=42
    $ ade open ade://pr/<owner>/<repo>/<number>
    $ ade open ade://linear-issue/ADE-123?branch=arul/ade-123-fix
    $ ade open https://ade-app.dev/open?type=lane&id=<lane-uuid>
    $ ade open --linear-issue ADE-123 --branch arul/ade-123-fix

  Flags:
    --linear-issue <id>     Linear issue identifier; routes to the matching lane.
    --branch <branch>       Linear-generated branch hint passed alongside --linear-issue.
`,
  link: `${ADE_BANNER}
  ADE Link

  Build a shareable deeplink URL for a lane, Work session, file, commit, artifact, branch, PR, or Linear issue.
  The URL is printed and (unless --no-clipboard) copied to the clipboard.

    $ ade link lane <lane-uuid>
    $ ade link session <session-id> [--lane <lane-uuid>]
    $ ade link file <path> [--line <number>] [--lane <lane-uuid>]
    $ ade link commit <sha> [--lane <lane-uuid>]
    $ ade link artifact <id>
    $ ade link branch <owner/repo> <branch> [--pr <number>]
    $ ade link pr <owner/repo> <number>
    $ ade link linear-issue <ADE-123> [--branch <branch>]
    $ ade link <url>                                Round-trip parse + re-emit a deeplink

  Flags:
    --ade           Emit the custom "ade://" form. Defaults to the https mirror.
    --no-envelope   Skip best-effort repo/branch/PR envelope lookup.
    --web           Emit the hosted web client URL (app.ade-app.dev).
    --no-clipboard  Print the URL but do not copy it to the system clipboard.
`,
  skill: `${ADE_BANNER}
  ADE Skills

  Browse ADE's bundled, version-locked agent skills directly from the bundled
  resources. This is a local command that does NOT require the machine brain —
  it is the tamper-proof backstop for agents that can't natively discover
  ADE's skills.

    $ ade skill list                                List bundled skills (JSON: name, description, path)
    $ ade skill list --text                         One "name — description" line per skill
    $ ade skill show <name>                         Print a skill's SKILL.md (JSON: name, description, content, path)
    $ ade skill show <name> --text                  Print just the skill's markdown body

  Flags:
    --text          Human-readable output.
    --json          Structured JSON output (default).
`,
  runtime: `${ADE_BANNER}
  ADE Runtime Compatibility

  Run an explicit manual runtime, or use compatibility endpoint commands for
  older scripts. Prefer "ade brain" for the automated always-on service.

    $ ade runtime run --socket /tmp/ade-dev.sock
    $ ade runtime status --text
    $ ade runtime start
    $ ade runtime stop

  Notes:
    "run" starts a foreground manual runtime on the selected endpoint.
    Manual runtimes always run with sync off so they cannot claim brain
    authority.
    "start" and "stop" are compatibility endpoint commands; use "ade brain"
    for service-managed lifecycle commands.
`,
  brain: `${ADE_BANNER}
  ADE Brain

  Manage the always-on, machine-owned ADE brain for this channel. The brain is
  the background ADE process that carries the local RPC endpoint, sync
  websocket, project catalog, and executor authority. Clients attach to it.

    $ ade brain status --text
    $ ade brain show --text
    $ ade brain start
    $ ade brain stop
    $ ade brain restart
    $ ade brain update --text
    $ ade brain update status --text
    $ ade brain pin generate
    $ ade brain pin set 123456
    $ ade brain pin clear

  Notes:
    "start" enables and loads the login service.
    "stop" disables and unloads the login service.
    "update" downloads the standalone runtime for this channel, stages it under
    ADE_HOME, then hands off to a detached helper that restarts the brain.
    Pairing PIN commands are aliases for the machine sync PIN.
`,
  serve: `${ADE_BANNER}
  ADE Internal Brain Process

  Internal/debug command that runs the brain process in the foreground. Most
  users should use "ade brain start", "ade brain stop", and "ade brain status".

  Flags:
    --socket <path>         Local RPC endpoint to listen on.
    --port <n>              Also listen for local TCP JSON-RPC on 127.0.0.1:n.
    --no-sync               Disable machine sync discovery for this foreground brain process.
    --install-service       Register the per-user login service and exit.
    --uninstall-service     Remove the per-user login service and exit.
    --service-status        Print per-user login service status and exit.
`,
  rpc: `${ADE_BANNER}
  ADE JSON-RPC

  Attaches to the machine ADE brain and speaks ADE JSON-RPC over stdio.
  If the brain is not running, ADE starts it before accepting requests. This
  mode is used by SSH transports.

    $ ade rpc --stdio
`,
  init: `${ADE_BANNER}
  ADE Project Init

  Registers a project with this machine brain and creates its .ade directory
  if needed.

    $ ade init
    $ ade init /path/to/project
`,
  projects: `${ADE_BANNER}
  ADE projects

  Manage the machine-scoped ADE project registry used by the ADE runtime.

    $ ade projects list --text
    $ ade projects add /path/to/project
    $ ade projects remove <project-id>
    $ ade projects touch <project-id>
    $ ade projects inspect /path/to/checkout --json Classify a path (repo root vs linked/ADE-managed worktree) and find its owning project + existing lane
`,
  code: `${ADE_BANNER}
  ADE Code

  Launch the terminal-native ADE Work chat. It uses the same project lanes,
  chat sessions, transcript state, and slash commands as desktop ADE, but it
  does not require the desktop app to be running.

    $ ade code                                      Start the TUI for the current project
    $ ade code --print-state                       Smoke-test attach/embed state
    $ ade code --embedded                          Force the embedded runtime fallback
    $ ade code --require-socket                    Fail instead of starting an embedded runtime when no runtime endpoint exists
    $ ade code --socket /tmp/ade.sock              Attach to a specific local endpoint
    $ ade code --lane <id|name|branch>             Launch focused on a specific lane
    $ ade code remote --target <machine> --project <project>
                                                     Launch against a saved desktop remote machine
    $ ade code remote session --target <machine> --project <project> --session <session>
                                                     Open a specific remote chat or provider CLI terminal session
    $ ade code remote --list-targets               List saved remote machines
    $ ade code remote --target <machine> --list-projects
                                                     List ADE projects available on the remote machine
    $ ade code remote session --target <machine> --project <project> --list-sessions
                                                     List remote chat and provider CLI terminal sessions
    $ ade --project-root <path> code                Launch against a specific ADE project

  Keys:
    ctrl-o        Open or focus lanes and chats
    ctrl-p        Open or focus details
    ctrl-g        Split chat: add another chat tile
    ctrl-w        Split chat: close focused tile
    tab           Split chat: cycle focused tile
    shift-tab     Cycle pane focus
    esc           Return or cancel the active pane
    ?             Help when it is the first prompt character
    /             Command palette
  `,
  new: `${ADE_BANNER}
  New ADE work session

  Start either a persistent ADE Work chat or a tracked provider CLI session
  with one command. This mirrors the desktop New Chat mode toggle.

    $ ade new chat --mode chat --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the tests"
    $ ade new chat --mode cli --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the tests"
    $ ade new chat --mode chat --auto-create-lane --prompt "Fix login"
    $ ade new cli --lane <lane> --provider claude --model anthropic/claude-opus-4-8 --effort ultracode --prompt "Review the diff"

  Flags:
    --mode <chat|cli>      Select a persistent ADE chat or tracked provider CLI session.
    --lane <lane|auto>     Target lane. "auto" is the same as --auto-create-lane.
    --auto-create-lane     Create a new lane first, then launch there.
    --lane-name <name>     Explicit name for an auto-created lane.
    --base <branch>        Optional base branch for an auto-created lane.
    --type <subagent|peer|none>
                           Cosmetic relationship + completion-report policy; a typed agent is a full agent. subagent = ADE wakes you when it finishes; peer = quiet note; none (default) = no report.
    --provider <name>      claude | codex | cursor | droid | opencode. CLI mode also accepts shell.
    --model <id>           Runtime model id.
    --reasoning-effort <v> Reasoning tier. Alias: --effort.
    --permissions <mode>   default | auto | plan | edit | full-auto | config-toml.
    --fast                 Request fast service tier when supported.
    --no-fast, --standard  Disable fast service tier explicitly.
    --prompt <text>        First chat message or CLI initial input.

  Compatibility:
    ade chat create still creates persistent Work chats.
    ade shell start-cli still starts tracked provider CLI sessions.
    ade agent spawn is the older agent launcher and should not be used for new flows.
`,
  "new chat": `${ADE_BANNER}
  New chat / CLI session

  One entry point for ADE's desktop New Chat toggle:
    --mode chat creates a persistent ADE Work chat.
    --mode cli starts a tracked provider CLI terminal.

    $ ade new chat --mode chat --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the tests"
    $ ade new chat --mode cli --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --permissions full-auto --no-fast --prompt "Fix the tests"
    $ ade new chat --mode chat --lane auto --lane-name fix-login --prompt "Fix login"

  The command defaults to the current ADE lane when ADE_LANE_ID is set. Use
  --auto-create-lane or --lane auto to create a lane before launching.
  --type <subagent|peer|none> sets only the cosmetic relationship and completion-report policy; a typed agent is a full agent. subagent wakes the parent, peer leaves a quiet note, and none (default) sends no report.
`,
  lanes: `${ADE_BANNER}
  Lanes

  Lanes are ADE-managed worktrees and branches. Most commands accept either
  --lane <lane-id> or a positional lane id.

    $ ade lanes list --text                         Show lane stack graph and branch names
    $ ade lanes show <lane> --text                  Inspect one lane status
    $ ade lanes create --name <name>                Create a lane from the current project context
    $ ade lanes create --linear-issue-json '{...}'  Create a lane linked to a Linear issue
    $ ade lanes link-linear-issue <lane> --linear-issue-json '{...}'
                                                    Link an existing lane to a Linear issue (alias: attach-linear-issue)
    $ ade lanes detach-linear-issue <lane> [--issue-id ENG-431]
                                                    Unlink one issue (or all non-primary links) from a lane
    $ ade lanes create-from-linear --linear-issue-json '{...}' [--start-chat --provider codex --model <m>]
                                                    Create a lane from an issue, optionally auto-launching an agent
    $ ade lanes batch-create-from-linear --linear-issues-json '[{...},{...}]'
                                                    Create one lane per issue (partial success, no orphans)
    $ ade lanes create --base <ref>                 Override the base ref (omit to use the configured new-lane base, remote-first by default)
    $ ade lanes create --parent <lane> --name <name>
                                                    Create from a parent lane's HEAD
    $ ade lanes create --branch-name <branch>       Override the auto-generated branch name
    $ ade lanes child --lane <parent> --name <name> Create a child lane under a parent
                                                    Child lanes carry the parent's unmerged work
    $ ade lanes import --branch <branch>            Register an existing branch/worktree
    $ ade lanes archive <lane>                      Archive a lane in ADE
    $ ade lanes unarchive <lane>                    Restore an archived lane
    $ ade lanes delete <lane> --force               Delete a lane and clean up its worktree
    $ ade lanes attach --path <worktree> --name <n> Attach an external worktree
    $ ade lanes reparent <lane> --parent <parent>   Move lane onto a new parent (runs git rebase)
    $ ade lanes reparent <lane> --parent <parent> --stack-base-branch <branch>
                                                    Reparent and stack onto a specific branch (e.g. origin/main)
    $ ade lanes actions --text                      List callable lane service methods
`,
  git: `${ADE_BANNER}
  Git

  Git commands run in the lane worktree and record ADE operations so the app can
  refresh lane state. Use --lane for anything other than the active workspace.

    $ ade git status --lane <lane> --text           Show ADE-aware sync status
    $ ade git status --full --lane <lane> --text    Show full lane status, diff, and conflict state
    $ ade git fetch --lane <lane>                   Fetch remote refs
    $ ade git pull --lane <lane>                    Pull with ADE's ff-only lane operation
    $ ade git pull --lane <lane> --rebase           Pull and replay local commits on upstream
    $ ade git pull --lane <lane> --merge            Pull and merge upstream into the lane
    $ ade git undo --lane <lane>                    Reset to the previous recorded HEAD
    $ ade git redo --lane <lane>                    Restore the last undone HEAD
    $ ade git sync --lane <lane> --rebase --base main
                                                    Sync the lane with its base branch
    $ ade git stage --lane <lane> src/file.ts       Stage one file
    $ ade git stage-all --lane <lane>               Stage all current changes
    $ ade git unstage --lane <lane> src/file.ts     Unstage one file
    $ ade git commit --lane <lane> [-m <message>]   Commit, adding Refs <issue-id> on linked Linear lanes
    $ ade git push --lane <lane> --set-upstream     Push through ADE
    $ ade git push --lane <lane> --force-with-lease Force-push through ADE with lease
    $ ade git branches --lane <lane> --text         List branches with last-commit metadata
    $ ade git user-identity --lane <lane> --text    Read lane checkout's git user.name/email
    $ ade git stash push|list|apply|pop|drop        Use ADE lane stash actions
                                                    pop/drop resolve the saved stash OID before changing it
    $ ade git rebase --lane <lane> --ai             Rebase with ADE conflict support
    $ ade git rebase continue --lane <lane>         Continue an in-progress rebase
    $ ade git conflict show --lane <lane> --text    Inspect merge/rebase conflict state
    $ ade git conflict resolve --kind rebase        Continue after manual conflict resolution
    $ ade git tag <sha> --name v1.0.0 --lane <lane> Create a tag on a commit
    $ ade git reset <sha> --soft --lane <lane>      Reset HEAD to a commit (soft/mixed/hard)
    $ ade git is-reachable <sha> --lane <lane>      Check if a commit is in the lane history
    $ ade diff changes --lane <lane> --text         Inspect changed files
`,
  operations: `${ADE_BANNER}
  Operations

  Poll status for long-running ADE operations that returned an operation,
  test run, chat session, run graph, or PR id.

    $ ade operations status --operation <id> --text
    $ ade operations wait --operation <id> --wait-ms 30000 --text
    $ ade actions wait --test-run <id> --wait-ms 30000 --text

  Generic operation logs are not persisted by the operation table. Use
  "ade tests logs", "ade run logs", or terminal/app-control log commands for
  surfaces that own logs.
`,
  history: `${ADE_BANNER}
  History

  Inspect ADE's persisted operation timeline and lane commit history.

    $ ade history list --text                        List recent operations (default limit 50)
    $ ade history list --lane <lane> --kind push     Filter operations by lane and kind
    $ ade history list --status succeeded --text     Filter by terminal status
    $ ade history show --id <operation-id> --text    Show one operation record
    $ ade history commits --lane <lane> --text       List recent git commits for a lane
    $ ade history export --out history.json          Export filtered operations as JSON
    $ ade history export --lane <lane>               Print export JSON to stdout

  Flags:
    --lane, --lane-id       Filter or scope to one lane
    --kind                  Filter operations by kind (push, commit, merge, ...)
    --status                Filter operations: running|succeeded|failed|canceled|all
    --limit                 Max rows (default 50; export default 1000)
    --id                    Operation id for show
    --out                   Write export JSON to a file instead of stdout
    --text                  Human-readable table output when a formatter exists
    --json                  Machine-readable JSON (default; pretty unless --no-pretty)
`,
  diff: `${ADE_BANNER}
  Diffs

    $ ade diff changes --lane <lane> --text         Summarize staged/unstaged file changes
    $ ade diff file --lane <lane> <path> --text     Show one file diff (side-by-side text)
    $ ade diff patch --lane <lane> <path> --text    Raw unified diff / patch for one file
    $ ade diff file --mode staged <path>            Inspect staged diff for one file
    $ ade diff actions --text                       List diff service actions
`,
  prs: `${ADE_BANNER}
  Pull requests

  PR identifiers may be ADE PR ids, GitHub PR numbers, #numbers, or full PR URLs.
  Creating or linking a PR persists the lane mapping in ADE so the PR tab tracks it.

    $ ade prs list --text                           List PRs known to ADE
    $ ade prs list-open --text                      List every open GitHub PR in the repo, keyed by head branch
    $ ade prs create --lane <lane> --base main      Open and map a GitHub PR; prints GitHub + ADE URLs
    $ ade prs create --lane <lane> --close-linear-issue-on-merge
    $ ade prs link --lane <lane> --url <pr-url>     Map an existing GitHub PR to a lane
    $ ade prs checks <pr> --text                    Show check status
    $ ade prs comments <pr> --text                  Show unresolved review work
    $ ade prs github-snapshot --include-external-closed
                                                    Include closed external PR history in the GitHub snapshot
    $ ade prs resolve-thread <pr> --thread <id>     Resolve a review thread
    $ ade prs labels set <pr> ready-to-merge        Replace labels
    $ ade prs reviewers request <pr> alice bob      Request reviewers
`,
  run: `${ADE_BANNER}
  Run tab

  Run tab commands mirror ADE process definitions and runtime state. They use
  the machine ADE brain when live process state is needed.

    $ ade run defs --text                           List configured run commands
    $ ade run ps --lane <lane> --text               List process runtime state
    $ ade run start <process> --lane <lane>         Start a process in a lane
    $ ade run stop <process> --lane <lane>          Stop a process in a lane
    $ ade run logs <process> --run <run> --text     Tail process logs
    $ ade run stack start --stack <id> --lane <lane> Start a process stack
    $ ade run start-all --lane <lane>               Start all configured processes
`,
  shell: `${ADE_BANNER}
  Shell sessions

  Shell commands create tracked PTY sessions that ADE can display and audit.
  Inside an ADE chat or tracked agent CLI session, shell starts attach to the
  active owner session automatically.

    $ ade shell start --lane <lane> -- npm test     Start a tracked shell session
    $ ade shell start --lane <lane> -c "npm test"   Start with a command string
    $ ade new chat --mode cli --lane <lane> --provider codex --permission-mode edit --prompt "fix tests"
    $ ade shell start-cli codex --lane <lane> --permission-mode edit
    $ ade shell start-cli claude --lane <lane> --reasoning-effort ultracode --prompt "fix tests"
    $ ade shell start --provider claude --lane <lane> --message "fix tests"
    $ ade shell start --lane <lane> --chat-session <owner-session-id> -c "npm test"
    $ ade shell write <pty-id> --data "q"           Write data to a PTY
    $ ade shell resize <pty-id> --cols 120 --rows 36
    $ ade shell close <pty-id>                      Dispose a PTY

  After start, use the returned session id with:
    $ ade terminal read --terminal <session-id> --text

  Prefer ade new chat --mode cli for new tracked provider CLI sessions. start-cli
  remains as the compatibility command behind that mode.
`,
  terminal: `${ADE_BANNER}
  Attached terminal

  Terminal commands control the active terminal attached to an ADE chat or
  tracked agent CLI session. Use attached runtime mode when you want the same
  terminal the app is viewing.

    $ ade terminal list --chat-session <owner-session-id> --text  List running and ended terminals for a session
    $ ade terminal active --chat-session <owner-session-id> --text Show the active terminal
    $ ade terminal resume --terminal <session-id> --text Resume an ended provider CLI terminal
    $ ade terminal read --terminal <session-id> --text Read terminal scrollback
    $ ade terminal read --pty <pty-id> --text       Read by PTY id
    $ ade app-control logs --text                   Read the active App Control launch terminal
    $ ade terminal write --terminal <session-id> --data "y\\n"
    $ ade terminal signal --terminal <session-id> --signal SIGINT
`,
  files: `${ADE_BANNER}
  Files

  File commands operate inside an ADE workspace id, usually a lane id.

    $ ade files workspaces --text                   List workspace roots
    $ ade files tree --workspace <lane> --path src  Show a workspace tree
    $ ade files read --workspace <lane> <path> --text Read a file
    $ ade files write --workspace <lane> <path> --stdin
    $ ade files write --workspace <lane> <path> --text "new content"
    $ ade files create --workspace <lane> <path> --text "content"
    $ ade files mkdir --workspace <lane> src/new
    $ ade files search --workspace <lane> -q <text> Search text in a workspace
    $ ade files quick-open --workspace <lane> -q app
`,
  chat: `${ADE_BANNER}
  Work chats

  Chat commands use ADE agent chat sessions. Live provider-backed chat normally
  requires an attached runtime because it owns provider/session state.

    $ ade chat list --lane <lane> --text            List chat sessions
    $ ade chat list --personal --text               List machine personal chats (no project required)
    $ ade chat actions --personal --text            List machine personal-chat actions
    $ ade chat action --personal models --input-json '{"provider":"codex"}'
    $ ade chat list --include-automation --no-archived --text
    $ ade chat create --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --no-fast --permissions full-auto
    $ ade chat create --personal --provider codex --model openai/gpt-5.6-sol --prompt "Plan my trip"
    $ ade chat create --lane <lane> --provider claude --model anthropic/claude-opus-4-8 --prompt "fix the tests"
    $ ade chat create --from-linear-issue ENG-431   Start a chat with an attached issue + kickoff (alias: --linear-issue-json)
    $ ade chat send <session> --text "next step"    Send a message; steers automatically if the turn is active
    $ ade chat steer <session> --personal --text "focus on the tradeoffs"
    $ ade chat models --personal --provider codex
    $ ade chat update <session> --personal --title "Trip planning"
    $ ade chat update <session> --personal --tag "review-ready"
                                                    Claude-only; --tag "" clears it
    $ ade chat message <session> --kind auto --text "status"
                                                    Deliver via auto | queue | wake | interrupt-replace
    $ ade chat steer <session> --text "context"     Steer/queue context into an active turn
    $ ade chat wait <session> --for idle --timeout-ms 600000
                                                    Wait for idle, active, awaiting-input, or terminal
    $ ade chat recover <session> --turn <turn-id> --action nudge
                                                    Recover a stalled Codex turn: wait, nudge, retry, or resume
    $ ade chat models --provider codex --json       List models and supported reasoning tiers
    $ ade chat read <session> --limit 20 --text     Read recent chat messages
    $ ade chat goal <session> --objective "Ship it" Set or inspect a Codex goal
    $ ade chat goal <session> --status paused       Update a Codex goal status
    $ ade chat handoff <session> --model openai/gpt-5.6-sol --note "focus on tests"
                                                    Start a new chat with an extra handoff note
    $ ade chat handoff <session> --model openai/gpt-5.6-sol --target-lane <lane-id>
                                                    Brief handoff into a different lane (same project)
    $ ade chat fork <session> --model openai/gpt-5.6-sol
                                                    Fork full provider history into a new chat
    $ ade chat rewind-files <session> --message <user-message-id> --dry-run
                                                    Preview or apply file/context rewind
    $ ade chat subagents <session> --text           List child agents for a chat
    $ ade chat schedules <session> --pause           Pause this agent session's durable wakeups/cron/loops
    $ ade chat schedules <session>                   Inspect pause state + next armed wake (--resume to re-arm)
    $ ade chat scheduled-work list [session]         List durable jobs (--all includes recent history)
    $ ade chat scheduled-work create --cron "<expr>" --prompt "<text>" [--once]
                                                    Optional: --reason "<text>" --session <id>
    $ ade chat scheduled-work cancel <session> <id>  Cancel one job; Claude crons also request CronDelete
    $ ade new chat --mode cli --lane <lane> --provider claude --reasoning-effort ultracode --prompt "fix"
                                                    Start a tracked provider CLI session
    $ ade chat attach-linear-issue <session> --issue-id ENG-431
                                                    Attach a Linear issue to a chat/CLI session
    $ ade chat detach-linear-issue <session> [--issue-id ENG-431]
                                                    Detach one issue (or all) from a session
    $ ade chat linear-issues <session> --text       List issues attached to a session
    $ ade chat interrupt <session>                  Stop an active turn
    $ ade chat slash <session> --text               List slash commands for a session
    $ ade new chat --mode cli --lane <lane> --prompt "fix"
                                                    Start a tracked provider CLI session

  Create flags:
    --provider <name>       claude | codex | cursor | droid | opencode.
    --model <id>            Model id, also sent as modelId for runtime parity.
    --reasoning-effort <v>  Reasoning tier when the selected model supports it.
                            Common tiers: minimal, low, medium, high, xhigh, ultra, ultracode.
    --prompt <text>         Create the chat, then send this as the first message.
    --permissions <mode>    Alias for --permission-mode.
    --permission-mode <m>   default | auto | plan | edit | full-auto | config-toml.
    --fast                  Request fast service tier when the model advertises it.
    --no-fast, --standard   Disable fast mode explicitly.
    --print-config          Print the createSession payload and permission mapping.
    --dry-run               Alias for --print-config; does not create a chat.
    --parent <sessionId>    Link the new chat as a child of that session.
                            Defaults to $ADE_CHAT_SESSION_ID in tracked agent shells.
    --no-parent             Create the chat without a parent link.

  Permission notes:
    full-auto maps Codex to sandbox=danger-full-access and approval=never.
    config-toml is only meaningful for Codex/OpenCode provider-native config.
    Use ade actions run chat.modelCatalog --json to inspect model-specific
    reasoning tiers and fast-mode support.

  Personal chats attach to the machine-owned ADE brain and never register a
  project. They work with a desktopless brain and through the same
  'ade rpc --stdio' transport used by remote desktops. One-shot '--headless'
  is intentionally unsupported because it would dispose the agent runtime when
  the command exits.
`,
  "chat create": `${ADE_BANNER}
  Chat create

  Create a persistent ADE Work chat session with provider/model/runtime settings.

    $ ade chat create --lane <lane> --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --no-fast --permissions full-auto
    $ ade chat create --lane <lane> --provider claude --model anthropic/claude-opus-4-8 --effort high --permissions plan
    $ ade chat create --lane <lane> --provider claude --model anthropic/claude-opus-4-8 --effort ultracode --prompt "fix"
    $ ade chat create --lane <lane> --provider cursor --model cursor/<model> --standard --print-config --json
    $ ade chat create --from-linear-issue ENG-431 --provider codex --model openai/gpt-5.6-sol --prompt "Work this issue"

  Flags:
    --personal              Use machine-owned chats instead of a project/lane chat.
    --lane <lane>           Lane/worktree for the chat.
    --provider <name>       claude | codex | cursor | droid | opencode.
    --model <id>            Model id, also sent as modelId for runtime parity.
    --reasoning-effort <v>  Reasoning tier when supported by the model.
    --effort <v>            Alias for --reasoning-effort.
                            Common tiers: minimal, low, medium, high, xhigh, ultra, ultracode.
    --prompt <text>         Create the chat, then send this as the first message.
    --kickoff <text>        Alias for --prompt.
    --permissions <mode>    Alias for --permission-mode.
    --permission-mode <m>   default | auto | plan | edit | full-auto | config-toml.
    --fast                  Request fast service tier when supported.
    --no-fast, --standard   Disable fast mode explicitly.
    --print                 Start the session runtime in print mode.
    --print-config          Print the resolved CLI launch config.
    --dry-run               Alias for --print-config; no session is created.
    --parent <sessionId>    Link the new chat as a child of that session.
                            Defaults to $ADE_CHAT_SESSION_ID when run from a
                            tracked agent shell (the spawning chat).
    --no-parent             Create the chat without a parent link.

  Permission mapping highlights:
    codex full-auto   -> codexSandbox=danger-full-access, codexApprovalPolicy=never.
    codex plan        -> codexSandbox=read-only, codexApprovalPolicy=on-request.
    codex edit        -> codexSandbox=workspace-write, codexApprovalPolicy=untrusted.
    codex default     -> codexSandbox=workspace-write, codexApprovalPolicy=on-request.
    claude full-auto  -> bypassPermissions.
    cursor full-auto  -> full-auto native mode.
    droid full-auto   -> auto-high autonomy.
    opencode full-auto -> allow permissions.

  Discovery:
    $ ade actions run chat.modelCatalog --input-json '{"mode":"cached"}' --json
    $ ade actions run chat.getAvailableModels --input-json '{"provider":"codex"}' --json

  CLI sessions:
    Use ade new chat --mode cli ... when you want a tracked provider CLI terminal
    instead of a persistent Work chat.
`,
  "chat recover": `${ADE_BANNER}
  Chat recovery

  Recover a stalled Codex Work-chat turn using the same actions as the desktop
  recovery card. The session and turn must still be the active Codex turn.

    $ ade chat recover <session> --turn <turn-id> --action wait
    $ ade chat recover <session> --turn <turn-id> --action nudge
    $ ade chat recover <session> --turn <turn-id> --action retry
    $ ade chat recover <session> --turn <turn-id> --action resume

  Actions:
    wait    Keep the current turn alive and restart its stalled-turn watchdog.
    nudge   Steer a short status request into the current turn.
    retry   Interrupt, then retry on the same Codex thread.
    resume  Restart the app server, resume the thread, then retry the turn.
`,
  agent: `${ADE_BANNER}
  Agent sessions

  Compatibility path for older agent launches. Prefer:
    $ ade new chat --mode cli --lane <lane> --provider codex --prompt "Fix the failing test"

    $ ade agent spawn --lane <lane> --prompt "Fix the failing test"
    $ ade agent spawn --lane <lane> --provider codex --model openai/gpt-5.6-sol --permissions full-auto
    $ ade agent spawn --lane <lane> --context-file docs/context.md --prompt "continue"
    $ ade agent spawn --lane <lane> --tool=git --tool=files --prompt "review changes"

  Spawn flags:
    --provider <name>       codex | claude. Defaults to codex.
    --model <id>            Provider CLI model id.
    --permissions <mode>    Alias for --permission-mode.
    --permission-mode <m>   default | auto | plan | edit | full-auto | config-toml.
                            auto is Claude-only; config-toml is Codex-only here.
    --context-file <path>   Include a file as extra context for the prompt.
    --tool <name>           Add an allowlisted tool hint.

  Reasoning effort:
    ade agent spawn launches the older CLI-session agent tool and does not
    support reasoning effort. Use ade new chat --mode chat for persistent Work
    chats or ade new chat --mode cli for tracked CLI sessions.
`,
  "agent spawn": `${ADE_BANNER}
  Agent spawn

  Compatibility path for older Codex or Claude CLI-session agents. Prefer
  ade new chat --mode cli, which supports the desktop New Chat CLI mode and
  reasoning/fast launch settings. This command does not support reasoning effort.

    $ ade agent spawn --lane <lane> --provider codex --model openai/gpt-5.6-sol --permissions full-auto --prompt "Fix the failing test"
    $ ade agent spawn --lane <lane> --provider claude --model claude-opus-4-8 --permissions plan --prompt "Review the diff"

  Flags:
    --lane <lane>           Required lane/worktree.
    --prompt <text>         Initial task prompt.
    --provider <name>       codex | claude. Defaults to codex.
    --model <id>            Provider CLI model id.
    --permissions <mode>    Alias for --permission-mode.
    --permission-mode <m>   default | auto | plan | edit | full-auto | config-toml.
    --context-file <path>   Include a file as extra context for the prompt.
    --tool <name>           Add an allowlisted tool hint.

  Permission mode values:
    default, plan, edit, full-auto work for Codex and Claude.
    auto is Claude-only. config-toml is Codex-only.

  Not supported:
    --reasoning-effort / --effort. Use ade chat create or
    ade shell start-cli when the launch must set a reasoning tier.
`,
  proof: `${ADE_BANNER}
  Proof and computer use

  Proof commands capture or ingest reviewer-visible evidence for ADE work.
  Prefer screenshots/images, screen recordings, and browser captures/traces.
  Console logs are supporting diagnostics, not a replacement for visual proof.
  Local screenshot/video fallback is macOS-only and runs headless by default
  unless --socket is explicitly requested. Attached runtime mode has the best
  parity for shared proof state.

    $ ade proof status --text                       Show proof backend capabilities
    $ ade proof list --text                         List captured artifacts
    $ ade proof capture --caption "Done"            Capture a screenshot artifact
    $ ade proof attach /tmp/proof.png --caption "Done" Attach an existing image/video
    $ ade proof record --seconds 20                 Capture a short video proof
    $ ade proof launch --app "ADE"                  Launch an app for proof capture
    $ ade proof ingest --input-json '{"artifacts":[]}' Ingest external visual proof artifacts
`,
  "ios-sim": `${ADE_BANNER}
  iOS Simulator

  iOS simulator commands build, launch, mirror, inspect, and control the ADE
  drawer simulator. Aliases: \`ade ios\` and \`ade simulator\` route to the same
  surface. For drawer/shared session state, prefer attached runtime mode
  (--socket) so launch/select/tap operate on the same long-lived ADE service.
  Launch opens Simulator by default and ADE shows it in the drawer. Optional
  simulator control tools enable tap, drag, type, and inspect actions.

  A launched simulator session belongs to one chat at a time. Run
  "ios-sim shutdown" before launching it from a different chat, or use
  "shutdown --force" when you intentionally want to take over. Use
  "ios-sim claim --lane <lane-id>" to attach the drawer session to a lane.

  Discovery and lifecycle:
    $ ade ios-sim status --text                    Show simulator readiness
    $ ade ios-sim devices --text                   List available simulators
    $ ade ios-sim apps --device <udid> --text      List launchable apps
    $ ade --socket ios-sim launch --target <id>    Build, install, and launch an app
    $ ade --socket ios-sim claim --lane <lane-id>  Attribute the drawer session to a lane
    $ ade --socket ios-sim launch --bundle-id com.example Launch installed app
    $ ade --socket ios-sim shutdown                Tear down the active simulator session (alias: stop)
    $ ade --socket ios-sim shutdown --force        Force-release a session owned by another chat
    $ ade ios-sim actions --text                   List every callable ios_simulator action

  ADE discovers Xcode projects from the project root and apps/* folders.

  Capture and inspection:
    $ ade ios-sim screenshot --text                Capture a screenshot
    $ ade ios-sim snapshot --text                  Capture selectable UI context
    $ ade ios-sim inspector --text                 Show current inspector data
    $ ade ios-sim inspect --x 120 --y 420 --text   Inspect a point in the simulator
    $ ade ios-sim preview-status --text           Xcode MCP readiness for Preview Lab
    $ ade ios-sim previews --source <file> --text  List nearby #Preview definitions
    $ ade ios-sim preview-match --source <file>    Resolve best Preview Lab match
    $ ade ios-sim preview-ensure --text            Open/wait for Xcode Preview Lab
    $ ade ios-sim preview-current --text           Render preview for the selected simulator UI
    $ ade ios-sim preview-render --source <file>   Render a SwiftUI preview through Xcode MCP

  Live view:
    $ ade ios-sim live-start --fps 60              Show the running simulator in ADE
    $ ade ios-sim window-start --fps 60            Same live view, explicit alias
    $ ade ios-sim stream-status --text             Show live view and input state
    $ ade ios-sim stream-stop                      Stop the live view

  Input and selection:
    $ ade --socket ios-sim select --x 120 --y 420  Add simulator UI context to chat
    $ ade ios-sim tap 120 420                      Tap in the simulator
    $ ade ios-sim drag 120 700 120 250             Drag in the simulator
    $ ade ios-sim swipe 120 700 120 250            Swipe in the simulator
    $ ade ios-sim type "hello" --text              Type into the launched app
`,
  "app-control": `${ADE_BANNER}
  App Control

  App Control is ADE's bridge for developer-owned app sessions. The first
  supported kind is Electron: ADE can launch or connect to an Electron renderer
  that exposes a Chrome DevTools Protocol port, then capture screenshots, DOM
  elements, selected UI context, and basic input in the same style as the iOS
  simulator drawer. App Control is intentionally a bridge: Playwright,
  agent-browser, Computer Use, and other tools may also attach to the same app;
  ADE keeps the launch/session state and turns snapshots into chat context.

  Launching runs the command in the attached terminal instead of a hidden child
  process. ADE sets ADE_APP_CONTROL_CDP_PORT and ADE_APP_CONTROL_DEBUG_FLAGS in
  the environment and auto-forwards debug flags for common npm/pnpm/yarn/bun
  script launches and direct electron commands. Custom launchers should forward
  ADE_APP_CONTROL_DEBUG_FLAGS or ADE_APP_CONTROL_CDP_PORT. You can also put
  {ADE_APP_CONTROL_DEBUG_FLAGS} in the command string for explicit substitution.

  Reuse a Run-tab command: list configured processes with
  \`ade settings get --text\`, then pass \`--cwd\` so the launch runs from the
  same directory the Run tab uses. Relative cwds resolve against the lane root.

  Discovery and lifecycle:
    $ ade app-control status --text                Show active session and provider readiness
    $ ade app-control claim --lane <lane-id>       Attribute the active renderer to a lane
    $ ade app-control launch --command "npm run dev" --text
    $ ade app-control launch pnpm dev --text       Launch via the visible attached terminal
    $ ade app-control launch --command "pnpm dev" --cwd apps/desktop --text
    $ ade app-control launch --command "/path/script.sh {ADE_APP_CONTROL_DEBUG_FLAGS}"
    $ ade app-control connect --cdp-port 9222      Attach to an already-running app
    $ ade app-control targets --text               List debuggable CDP targets
    $ ade app-control attach-target --target <id>  Attach to one renderer target
    $ ade app-control logs --text                  Read the active App Control launch terminal
    $ ade app-control terminal write --data "y\\n" Answer a prompt in that terminal
    $ ade app-control focus --text                 Raise the controlled app window on demand
    $ ade app-control minimize --text              Minimize the controlled app window
    $ ade app-control stop --text                  Signal the App Control terminal session
    $ ade app-control actions --text               List every callable app_control action
    $ ade terminal read --terminal <session-id> --text Read a specific attached terminal
    $ ade terminal read --pty <pty-id> --text      Read by PTY id
    $ ade terminal write --chat-session <owner-session-id> --data "y\\n" Answer a prompt

  Capture and context:
    $ ade app-control screenshot --text            Capture the active renderer screenshot
    $ ade app-control snapshot --text              Screenshot + DOM element refs
    $ ade app-control inspect --x 120 --y 420      Hit-test a point without committing context
    $ ade app-control select --x 120 --y 420       Return/select app context (owned sessions auto-attach)

  Input:
    $ ade app-control click 120 420                Click screenshot coordinates
    $ ade app-control click 120 420 --coords viewport
    $ ade app-control scroll --x 120 --y 420 --delta-y 600
    $ ade app-control key --key Enter
    $ ade app-control type "hello" --text          Type text into the focused element
`,
  browser: `${ADE_BANNER}
  ADE browser

  Browser commands control ADE's built-in browser pane. ADE uses one persistent
  authentication profile per installation/channel, so cookies and site storage
  are shared across projects. Visible tabs remain independent per ADE
  window/project (with a separate personal-chat collection). Desktop bridge
  calls use the project root only to route to the right tab collection.
  Ownership is per tab/session:
  tab creation, explicit claims, sessions, and page actions read
  ADE_LANE_ID/ADE_CHAT_SESSION_ID for agent CLI calls. Panel reveal and plain
  tab switching are passive view operations; use
  "browser claim --tab <tab-id> --lane <lane-id>" to claim an already-open tab.
  ADE-launched agents should list tabs first and use only a tab/session owned
  by their current chat. Plain "browser open <url>" reuses that owned tab for
  ADE-launched agents and creates one only when none exists, without revealing
  the Browser panel unless --panel is passed. Use --new-tab only when the task
  truly needs another tab; --active-tab and --tab stay explicit. The runtime
  accepts browser commands only from ADE-launched chat/terminal sessions with
  a browser capability, validates lane/chat identity, and rejects agent force
  takeovers. Profile diagnostics and remembered-permission administration stay
  in the trusted ADE renderer.

  Tabs and navigation:
    $ ade --socket browser status --text           Show active tab and tab list
    $ ade --socket browser authorize --tab <id>    Request human access to an authenticated origin
    $ ade --socket browser claim --lane <lane-id>  Attribute the active browser tab to a lane
    $ ade --socket browser panel --text            Open the Work sidebar Browser panel
    $ ade --socket browser open https://example.com --text
    $ ade --socket browser open https://example.com --panel --text
    $ ade --socket browser open localhost:5173 --new-tab --text
    $ ade --socket browser open localhost:5173 --active-tab --text
    $ ade --socket browser open https://example.com --no-panel
    $ ade --socket browser new-tab --url https://example.com
    $ ade --socket browser switch --tab <tab-id>
    $ ade --socket browser close --tab <tab-id>
    $ ade --socket browser actions --text          List built_in_browser actions

  Agent sessions:
    $ ade --socket browser session start --tab <tab-id> --text
    $ ade --socket browser sessions --text
    $ ade --socket browser observe --browser-session <session-id> --map --text
    $ ade --socket browser click --browser-session <session-id> --handle obs-...:e:1
    $ ade --socket browser session click <session-id> --handle obs-...:e:1
    $ ade --socket browser session wait <session-id> --network-idle
    $ ade --socket browser session trace <session-id> --text
    $ ade --socket browser session proof <session-id> --caption "Verified"
    $ ade --socket browser session end <session-id>

  Page controls:
    $ ade --socket browser observe --tab <tab-id>  Save scratch screenshot + DOM observation
    $ ade --socket browser observe --tab <tab-id> --map
    $ ade --socket browser trace --tab <tab-id> --text
    $ ade --socket browser click --tab <tab-id> --x 120 --y 420
    $ ade --socket browser click --tab <tab-id> --selector "button[type=submit]"
    $ ade --socket browser click --tab <tab-id> --text-match "Sign in"
    $ ade --socket browser click --tab <tab-id> --handle obs-...:e:1
    $ ade --socket browser wait --tab <tab-id> --selector ".ready"
    $ ade --socket browser wait --tab <tab-id> --load-state network-idle --network-idle-ms 750
    $ ade --socket browser fill --tab <tab-id> --selector "input[name=email]" "me@example.com"
    $ ade --socket browser fill --tab <tab-id> --handle obs-...:e:2 --value ""
    $ ade --socket browser clear-field --tab <tab-id> --selector "input[name=q]"
    $ ade --socket browser press --tab <tab-id> --selector "input[name=q]" Enter
    $ ade --socket browser type --tab <tab-id> "hello"
    $ ade --socket browser key --tab <tab-id> Enter
    $ ade --socket browser scroll --tab <tab-id> --dy 700
    $ ade --socket browser proof --tab <tab-id> --caption "Verified"
    $ ade --socket browser reload --tab <tab-id>
    $ ade --socket browser back --tab <tab-id>
    $ ade --socket browser forward --tab <tab-id>
    $ ade --socket browser stop --tab <tab-id>

  Capture and context:
    $ ade --socket browser screenshot --tab <tab-id> --text
    $ ade --socket browser select --x 120 --y 420  Attach DOM context at a viewport point
    $ ade --socket browser inspect-start           Start DOM inspect mode
    $ ade --socket browser inspect-stop            Stop DOM inspect mode
    $ ade --socket browser select-current --text   Return the selected DOM item
    $ ade --socket browser clear-selection

  Flags:
    --url <url>          URL for panel/open/new-tab. Bare localhost gets http://.
    --new-tab           Always open navigation in a new tab.
    --active-tab         Navigate the active tab; aliases: --current-tab, --same-tab.
    --background         Create a new tab without activating it.
    --panel, --show-panel
                         Reveal the Work sidebar Browser panel for this command.
    --no-panel           Keep the Work sidebar panel hidden; alias: --hidden.
    --tab, --tab-id <id> Target tab for switch/close/open/control/capture/claim.
    --browser-session <id>
                         Target the tab bound to a browser agent session.
    --x, --y <n>         Viewport coordinates for browser click/select/scroll origin.
    --selector <css>     Click the first matching visible element.
    --text-match <text>  Click a visible element by accessible text/label.
    --test-id <id>       Click by data-testid/data-test-id/data-cy.
    --element <n>        Click an element index from the current DOM observation.
    --handle <ref>       Click/fill/press/wait via a saved observation element handle.
    --value <text>       Explicit value for browser fill, including an empty string.
    --map, --ui-map      Add a numbered visual element map image to observations.
    --keep <n>           Keep only the latest n scratch observations per tab (default 3).
    --dom, --no-dom      Include or skip the DOM element list in observations.
    --diagnostics, --no-diagnostics
                         Include or skip console/network diagnostics in observations.
    --max-elements <n>   Cap DOM elements captured per observation (default 80).
    --limit <n>          Trace entries to show for browser trace (default 20).
    --include-ended, --all
                         Include ended browser sessions in browser sessions output.
    --timeout-ms <n>     Wait timeout for browser wait/fill/click readiness.
    --network-idle       Alias for browser wait --load-state network-idle.
    --network-idle-ms <n>
                         Quiet window required for network-idle wait (default 500).
    --wait-after-ms <n>  Delay before post-action observation (default 150).
    --fast               Alias for --wait-after-ms 0 on browser actions.
    --no-observe         Do not capture the post-action scratch observation.
    --force              Reserved takeover flag; ADE agent calls are rejected.
    --lease-ttl-ms <n>   Override tab lease TTL for lane-owned actions.
    --lane, --lane-id <id> Claim lane for open/new-tab/claim/session/actions.
                         On panel/switch, claims only when passed explicitly.
    --chat-session <id>  Claim chat/session for open/new-tab/claim/session/actions.
                         On panel/switch, claims only when passed explicitly.
`,
  tests: `${ADE_BANNER}
  Tests

    $ ade tests list --text                         List configured test suites
    $ ade tests run --lane <lane> --suite unit      Run a configured suite
    $ ade tests run --lane <lane> --command "npm test" --wait
    $ ade tests runs --lane <lane> --text           List recent test runs
    $ ade tests logs <run-id> --text                Tail a test run log
    $ ade tests stop <run-id>                       Stop an active test run
`,
  usage: `${ADE_BANNER}
  Usage and provider quotas

  Reads authoritative Claude and Codex quota windows, pacing, cached local
  history, and budget guardrails. Live quota refresh is intentionally separate
  from local provider-ledger scans.

    $ ade usage snapshot --text                     Cached quota, source/stale state, and history
    $ ade --role cto usage refresh --text           Refresh live provider quota only
    $ ade --role cto usage refresh --history --text Scan local provider history and costs
    $ ade usage budget get --text                   Read budget guardrail config
    $ ade usage budget set --from-file budget.json  Save budget guardrail config
    $ ade usage budget check --provider claude --scope global
    $ ade usage budget cumulative --scope global    Cumulative spend for the current week
`,
  storage: `${ADE_BANNER}
  ADE storage insights and disk hygiene

  Reports what ADE is holding on disk (chats/terminal history, lane worktrees,
  build output, caches, proof attachments, recovery backups, database) and the
  volume's free space, mirroring the desktop Settings storage dashboard. The
  snapshot is read-only; compression is lossless and safe. Target-scoped cleanup
  (which deletes files) is intentionally left to the action bridge.

    $ ade storage snapshot --text                   Categorized ADE disk usage + free-space summary
    $ ade storage snapshot --refresh --text         Force a fresh scan (skip the cached snapshot)
    $ ade storage compress --text                   Losslessly compress old chat/terminal history
    $ ade storage actions --text                    List raw storage service actions
    $ ade storage action cleanupPreview --input-json '{"targets":[...]}'   Preview a target-scoped cleanup
    $ ade --role cto storage action cleanup --input-json '{"targets":[...],"preview":{...}}'   Delete previewed targets (CTO)
`,
  secrets: `${ADE_BANNER}
  ADE project secrets

  Secrets are encrypted under the active project's .ade/secrets directory and
  are shared by every ADE lane/agent for that project. List output never reveals
  values; use get only for the specific secret you need.

    $ ade secrets list --text                       List secret names and metadata
    $ ade secrets get STRIPE_API_KEY                Print one secret value as JSON
    $ ade secrets get STRIPE_API_KEY --text         Print only the secret value
    $ ade secrets set STRIPE_API_KEY --value sk_... Save or replace a secret
    $ printf %s "$TOKEN" | ade secrets set TOKEN --stdin
    $ ade secrets set TOKEN --value-file token.txt
    $ ade secrets delete STRIPE_API_KEY             Delete a secret
`,
  linear: `${ADE_BANNER}
  Linear workflows

  Daemon bridge (for an agent running inside a tracked ADE CLI session):
  these commands route over the ADE runtime to the desktop runtime, which holds
  the Linear credentials — the CLI never needs a Linear token. When ADE launches
  an agent with an attached issue it injects \$ADE_CHAT_SESSION_ID and
  \$ADE_LINEAR_ISSUE_IDS, so the agent can read and write its issue with no ids.

    $ ade linear attach --this-session --issue-id ENG-431
                                                    Attach an issue to the current CLI session
    $ ade linear issues --this-session --text       List issues attached to this session
    $ ade linear issue ENG-431 --text               Read one issue (defaults to the session's attached issue)
    $ ade linear comment "Pushed a fix, running CI" Comment on the attached issue (or pass an id first)
    $ ade linear comment ENG-431 "Done"             Comment on a specific issue
    $ ade linear set-state ENG-431 <state-id>       Move an issue to a workflow state
    $ ade linear assign ENG-431 <user-id|none>      Assign or clear an issue assignee
    $ ade linear label ENG-431 "needs-review"       Add a label to an issue
    $ ade linear graphql --query 'query { viewer { id name } }'
                                                    Run Linear GraphQL through the project connection
    $ ade linear graphql --query-file query.graphql --variables-file vars.json
                                                    Use files for larger GraphQL operations
    $ ade linear detach --this-session [--issue-id ENG-431]
                                                    Detach one issue (or all) from this session

  Workspace + automation (typically run with --role cto):
    $ ade --role cto linear quick-view --text      Show connected workspace, projects, and issues
    $ ade --role cto linear picker-data --text     Read projects/users/states for the issue picker
    $ ade --role cto linear search-issues --query "auth" --state-type started,unstarted --first 50
                                                    Search issues for the lane Linear-issue picker
    $ ade --role cto linear issue-comments --issue-id <id>
                                                    Fetch comments on a Linear issue
`,
  coordinator: `${ADE_BANNER}
  Coordinator runtime tools

  Coordinator tools expose orchestration operations used by agent runtimes.
  List available tool names with:
    $ ade actions list --text

    $ ade coordinator <tool-name> --input-json '{"key":"value"}'
`,
  actions: `${ADE_BANNER}
  ADE actions

  Escape hatch for any exposed ADE service method. Use typed commands first
  when they exist; use actions when an agent needs exact service coverage.

  Argument shapes:
    Object args become one object parameter:
      $ ade actions run git.push --input-json '{"laneId":"lane-1","setUpstream":true}'
      $ ade actions run git.push --arg laneId=lane-1 --arg setUpstream=true
    --arg parses true/false/null/numbers; --arg-json parses a JSON value:
      $ ade actions run pr.setLabels --arg prId=123 --arg-json 'labels=["ready","ship"]'
    argsList is for service methods with multiple positional parameters:
      $ ade actions run pr.submitReview --args-list-json '["pr-1",{"event":"APPROVE"}]'
    $ ade actions list --text                       Domain-grouped action catalog
    $ ade actions list --domain git --text          Narrow the catalog
    $ ade actions run <domain.action> --input-json '{"key":"value"}'
    $ ade actions run <domain> <action> --input-json '{"key":"value"}'
    $ ade actions status --text                     Runtime action availability
`,
  automations: `${ADE_BANNER}
  Automations

    $ ade automations list [--json]                 List automation rules
    $ ade automations show <id> [--json]            Inspect a rule
    $ ade automations create --from-file <path>     Create from YAML (also accepts --stdin)
    $ ade automations update <id> --from-file <path>
    $ ade automations delete <id>                   Remove a local rule
    $ ade automations toggle <id> --enabled true|false
    $ ade automations run <id> [--lane <id>] [--dry-run]
    $ ade automations trigger <id> [--lane <id>]
                                                     Trigger a rule manually
    $ ade automations ingress status [--text]        Show webhook gateway status
    $ ade automations ingress start [--text]         Start the local webhook listener
    $ ade automations ingress refresh [--text]       Re-detect Tailscale/gateway status
    $ ade --role cto automations ingress set-url <https-url>
                                                     Save the public gateway URL
    $ ade --role cto automations ingress clear-url   Clear the public gateway URL
    $ ade automations linear-ingress status [--text]  Show Linear webhook ingress status
    $ ade --role cto automations linear-ingress connect
                                                     Register the Linear webhook (CTO only)
    $ ade --role cto automations linear-ingress disconnect
                                                     Remove the Linear webhook (CTO only)
    $ ade automations linear-ingress poll [--text]    Drain queued Linear events now
    $ ade automations cleanups list [--text]          List scheduled lane cleanups
    $ ade automations cleanups cancel <id>            Cancel a scheduled lane cleanup
    $ ade automations runs [--rule <id>] [--status <s>] [--limit 50]
    $ ade automations run-show <runId> [--json]     Inspect a run
    $ ade automations example                       Print an example rule (stdout)

  Lane mode flags (apply to create/update on top of --from-file/--stdin/--text):
    --lane-mode <create|reuse|require-on-trigger>   Create, reuse, or require lane at trigger time
    --lane <id>                                     Target lane (only with --lane-mode reuse)
    --lane-name-preset <issue-title|issue-num-title|pr-title-author|custom>
    --lane-name-template <string>                   Template (only with preset custom)
    --allow-legacy                                  Pass legacy create-lane action through
                                                    unchanged (default: auto-migrate to laneMode)

  Run filter:
    --status <queued|running|succeeded|failed|cancelled|paused|all>
`,
  cursor: `${ADE_BANNER}
${CURSOR_CLOUD_HELP.cloud}`,
  update: `${ADE_BANNER}
  Auto-update

  Auto-update commands query and drive ADE desktop's auto-updater. The desktop
  app owns the updater process; CLI parity exists so agents can read state and,
  when explicitly requested by the user, trigger a check, install, or dismiss
  the post-install notice. quitAndInstall relaunches the desktop app and only
  succeeds when status is "ready".

    $ ade --socket update status --text             Read AutoUpdateSnapshot (status, version, progress)
    $ ade --socket update check --text              Trigger a background update check
    $ ade --socket update install --text            Refresh latest, then quit and install when ready
    $ ade --socket update dismiss --text            Clear the recently-installed banner
    $ ade --socket update actions --text            List callable update actions

  Snapshot status values: idle, checking, downloading, ready, installing, error.
  "installing" appears between quitAndInstall and the desktop relaunch; if the
  install fails, status falls back to error and the pending-install record is
  cleared automatically.
`,
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePrimitive(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CliUsageError(
      `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseObjectJson(value: string, label: string): JsonObject {
  const parsed = parseJson(value, label);
  if (!isRecord(parsed)) {
    throw new CliUsageError(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseAssignment(
  value: string,
  label: string,
): { key: string; value: string } {
  const index = value.indexOf("=");
  if (index <= 0) {
    throw new CliUsageError(`${label} must use key=value syntax.`);
  }
  const key = value.slice(0, index).trim();
  if (!key.length) {
    throw new CliUsageError(`${label} is missing a key.`);
  }
  return { key, value: value.slice(index + 1) };
}

const UNSAFE_ARG_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function setPath(target: JsonObject, key: string, value: unknown): void {
  const parts = key
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new CliUsageError("Argument key cannot be empty.");
  }
  const unsafePart = parts.find((part) => UNSAFE_ARG_PATH_SEGMENTS.has(part));
  if (unsafePart) {
    throw new CliUsageError(
      `Argument key segment "${unsafePart}" is not allowed.`,
    );
  }
  let cursor: JsonObject = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!isRecord(existing)) {
      const next: JsonObject = {};
      cursor[part] = next;
      cursor = next;
      continue;
    }
    cursor = existing;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function readValue(args: string[], names: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    const matchedName = names.find(
      (name) => token === name || token.startsWith(`${name}=`),
    );
    if (!matchedName) continue;
    if (token.includes("=")) {
      args.splice(index, 1);
      return token.slice(token.indexOf("=") + 1);
    }
    const value = args[index + 1];
    if (value == null) {
      throw new CliUsageError(`${token} requires a value.`);
    }
    args.splice(index, 2);
    return value;
  }
  return null;
}

function readFlag(args: string[], names: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    if (!names.includes(args[index]!)) continue;
    args.splice(index, 1);
    return true;
  }
  return false;
}

function readCommandTextValue(args: string[], names: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    const matchedName = names.find(
      (name) => token === name || token.startsWith(`${name}=`),
    );
    if (!matchedName) continue;
    if (token.includes("=")) {
      args.splice(index, 1);
      return token.slice(token.indexOf("=") + 1);
    }
    const value = args[index + 1];
    if (value == null || value === "--" || value.startsWith("-")) {
      continue;
    }
    args.splice(index, 2);
    return value;
  }
  return null;
}

function firstPositional(args: string[]): string | null {
  const index = args.findIndex((arg) => arg !== "--" && !arg.startsWith("-"));
  if (index < 0) return null;
  const [value] = args.splice(index, 1);
  return value ?? null;
}

function firstStandalonePositional(args: string[]): string | null {
  let previousTokenWasValueCarrier = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") return null;
    if (previousTokenWasValueCarrier) {
      previousTokenWasValueCarrier = false;
      continue;
    }
    if (token.startsWith("-")) {
      const flagName = token.includes("=")
        ? token.slice(0, token.indexOf("="))
        : token;
      previousTokenWasValueCarrier =
        !token.includes("=") && VALUE_CARRIER_FLAGS.has(flagName);
      continue;
    }
    const [value] = args.splice(index, 1);
    return value ?? null;
  }
  return null;
}

function takeArgsAfterTerminator(args: string[]): string[] | null {
  const index = args.indexOf("--");
  if (index < 0) return null;
  const rest = args.slice(index + 1);
  args.splice(index);
  return rest.length > 0 ? rest : null;
}

function peekFirstPositional(args: string[]): string | null {
  return args.find((arg) => arg !== "--" && !arg.startsWith("-")) ?? null;
}

function buildCursorHelp(args: string[]): string {
  // Accepts forms like:
  //   ade cursor --help                  -> top-level cloud help
  //   ade cursor cloud --help            -> top-level cloud help
  //   ade cursor cloud agents --help     -> agents group help
  //   ade help cursor cloud agents       -> agents group help
  const positionals: string[] = [];
  for (const token of args) {
    if (token === "--" || token.startsWith("-")) continue;
    positionals.push(token.toLowerCase());
  }
  // Drop a leading "cursor" / "cloud" if present so we land on the group token.
  while (
    positionals.length &&
    (positionals[0] === "cursor" || positionals[0] === "cloud")
  ) {
    positionals.shift();
  }
  const group = positionals[0];
  const aliasMap: Record<string, string> = {
    agents: "agents",
    agent: "agents",
    runs: "runs",
    run: "runs",
    artifacts: "artifacts",
    artifact: "artifacts",
    repos: "repos",
    repo: "repos",
    repositories: "repos",
    models: "models",
    model: "models",
    me: "me",
    whoami: "me",
    user: "me",
  };
  if (group && aliasMap[group] && CURSOR_CLOUD_HELP[aliasMap[group]]) {
    return `${ADE_BANNER}${CURSOR_CLOUD_HELP[aliasMap[group]]}`;
  }
  return `${ADE_BANNER}${CURSOR_CLOUD_HELP.cloud}`;
}

function buildIosSimulatorHelp(args: string[]): string {
  const rawSubcommand = peekFirstPositional(args)?.toLowerCase() ?? "";
  const canonical = rawSubcommand
    ? (IOS_SIMULATOR_HELP_ALIASES[rawSubcommand] ?? rawSubcommand)
    : "";
  if (canonical && IOS_SIMULATOR_SUBCOMMAND_HELP[canonical]) {
    return IOS_SIMULATOR_SUBCOMMAND_HELP[canonical];
  }
  if (rawSubcommand && !IOS_SIMULATOR_SUBCOMMAND_HELP[canonical]) {
    return `${HELP_BY_COMMAND["ios-sim"]}\n  Unknown iOS simulator subcommand '${rawSubcommand}'. Run 'ade ios-sim actions --text' to list raw service actions.\n`;
  }
  return HELP_BY_COMMAND["ios-sim"];
}

function buildAppControlHelp(args: string[]): string {
  const rawSubcommand = peekFirstPositional(args)?.toLowerCase() ?? "";
  if (!rawSubcommand) return HELP_BY_COMMAND["app-control"];
  const focused = `${HELP_BY_COMMAND["app-control"]}
  Focused help for '${rawSubcommand}':
    Most subcommands accept --input-json and --arg/--arg-json as escape hatches.
    Use "ade app-control actions --text" to inspect the exact service methods.
    Use --socket when you want the desktop drawer and CLI to share the same live App Control session.
`;
  return focused;
}

function collectGenericObjectArgs(
  args: string[],
  base: JsonObject = {},
): JsonObject {
  const input: JsonObject = { ...base };
  while (true) {
    const inputJson = readValue(args, [
      "--input-json",
      "--json-input",
      "--input",
    ]);
    if (inputJson != null) {
      Object.assign(input, parseObjectJson(inputJson, "--input-json"));
      continue;
    }

    const rawArg = readValue(args, ["--arg", "--set"]);
    if (rawArg != null) {
      const { key, value } = parseAssignment(rawArg, "--arg");
      setPath(input, key, parsePrimitive(value));
      continue;
    }

    const jsonArg = readValue(args, ["--arg-json", "--set-json"]);
    if (jsonArg != null) {
      const { key, value } = parseAssignment(jsonArg, "--arg-json");
      setPath(input, key, parseJson(value, `--arg-json ${key}`));
      continue;
    }

    break;
  }
  return input;
}

function readLaneId(args: string[]): string | null {
  return readValue(args, ["--lane", "--lane-id"]) ?? null;
}

/**
 * Parent chat-session lineage for spawned chat sessions. Defaults to the
 * spawning agent's own session — ADE injects ADE_CHAT_SESSION_ID into every
 * tracked agent shell (chat runtimes and tracked CLI/PTY sessions) — so a
 * child created via `ade chat create` links back to the chat that spawned it
 * instead of becoming an orphan. `--parent <sessionId>` overrides the
 * default; `--no-parent` opts out entirely.
 */
function readParentSessionId(args: string[]): string | undefined {
  const override = readValue(args, ["--parent", "--parent-session", "--parent-session-id"]);
  const noParent = readFlag(args, ["--no-parent"]);
  if (override && noParent) {
    throw new CliUsageError("--parent cannot be combined with --no-parent.");
  }
  if (noParent) return undefined;
  const explicit = override?.trim();
  if (explicit) return explicit;
  const env = process.env.ADE_CHAT_SESSION_ID?.trim();
  return env?.length ? env : undefined;
}

type LaneNudgeGitResult = {
  status: number | null;
  stdout: string | Buffer;
};

type LaneNudgeGitRunner = (args: string[], cwd: string) => LaneNudgeGitResult;

function detectUnmergedLaneCreateNudge(
  args: {
    newLaneName: string;
    cwd?: string;
    currentLaneId?: string | null;
  },
  runGit: LaneNudgeGitRunner = (gitArgs, cwd) => spawnSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
): string | null {
  const cwd = args.cwd ?? process.cwd();
  const readGit = (gitArgs: string[]): string | null => {
    const result = runGit(gitArgs, cwd);
    if (result.status !== 0) return null;
    return Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8").trim()
      : result.stdout.trim();
  };
  const remoteHead = readGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = remoteHead?.replace(/^origin\//, "").trim() || "main";
  const countRaw = readGit(["rev-list", "--count", `origin/${defaultBranch}..HEAD`]);
  const commitCount = Number.parseInt(countRaw ?? "", 10);
  if (!Number.isFinite(commitCount) || commitCount <= 0) return null;

  const currentBranch = readGit(["branch", "--show-current"]);
  const currentLaneId = args.currentLaneId?.trim() || process.env.ADE_LANE_ID?.trim() || "";
  const currentLabel = currentBranch || currentLaneId || "current";
  const currentLane = currentLaneId || currentBranch || "current";
  return [
    `⚠ Lane "${currentLabel}" has ${commitCount} commit(s) not on ${defaultBranch}.`,
    "  To carry them into the new lane instead:",
    `    ade lanes child --lane ${currentLane} --name ${args.newLaneName}`,
    `  Continuing off remote main (origin/${defaultBranch}).`,
  ].join("\n");
}

type ToolClaimArgs = {
  laneId?: string;
  chatSessionId?: string;
};

type CodexGoalCliStatus = "active" | "paused" | "blocked" | "complete";

type CodexRecoveryCliAction =
  | "wait"
  | "steer"
  | "interrupt_retry_same_thread"
  | "restart_resume_thread";

function isCodexGoalCliStatus(value: string | null): value is CodexGoalCliStatus {
  return value === "active" || value === "paused" || value === "blocked" || value === "complete";
}

function normalizeCodexRecoveryCliAction(value: string | null): CodexRecoveryCliAction {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_") ?? "";
  if (normalized === "wait") return "wait";
  if (normalized === "nudge" || normalized === "steer") return "steer";
  if (
    normalized === "retry"
    || normalized === "interrupt_retry"
    || normalized === "interrupt_retry_same_thread"
  ) {
    return "interrupt_retry_same_thread";
  }
  if (
    normalized === "resume"
    || normalized === "restart_resume"
    || normalized === "restart_resume_thread"
  ) {
    return "restart_resume_thread";
  }
  throw new CliUsageError(
    "chat recover --action must be wait, nudge, retry, or resume.",
  );
}

function readToolClaimArgs(args: string[]): ToolClaimArgs {
  const laneId = asString(
    readValue(args, ["--lane", "--lane-id"]) ?? process.env.ADE_LANE_ID,
  );
  const chatSessionId = asString(
    readValue(args, [
      "--chat-session",
      "--chat-session-id",
      "--session",
      "--session-id",
    ]) ?? process.env.ADE_CHAT_SESSION_ID,
  );
  return {
    ...(laneId ? { laneId } : {}),
    ...(chatSessionId ? { chatSessionId } : {}),
  };
}

function readExplicitToolClaimArgs(args: string[]): ToolClaimArgs {
  const laneId = asString(readValue(args, ["--lane", "--lane-id"]));
  const chatSessionId = asString(
    readValue(args, [
      "--chat-session",
      "--chat-session-id",
      "--session",
      "--session-id",
    ]),
  );
  return {
    ...(laneId ? { laneId } : {}),
    ...(chatSessionId ? { chatSessionId } : {}),
  };
}

function readRequiredToolClaimArgs(args: string[], label: string): ToolClaimArgs {
  const claimArgs = readToolClaimArgs(args);
  if (!claimArgs.laneId) {
    throw new CliUsageError(`${label} claim requires --lane <lane-id> or ADE_LANE_ID.`);
  }
  return claimArgs;
}

function readBrowserTabTargetArgs(args: string[]): JsonObject {
  const tabId = readValue(args, ["--tab", "--tab-id"]);
  const sessionId = readValue(args, ["--browser-session", "--browser-session-id"]);
  return {
    ...(tabId ? { tabId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function readBrowserLeaseArgs(args: string[]): JsonObject {
  const leaseTtlMs = readNumberOption(args, ["--lease-ttl-ms", "--lease-ms"]);
  return {
    ...(readFlag(args, ["--force"]) ? { force: true } : {}),
    ...(leaseTtlMs == null ? {} : { leaseTtlMs }),
  };
}

function readBrowserSessionStartArgs(args: string[]): JsonObject {
  return {
    ...readBrowserTabTargetArgs(args),
    ...readToolClaimArgs(args),
    ...readBrowserLeaseArgs(args),
  };
}

function readBrowserSessionsArgs(args: string[]): JsonObject {
  return {
    ...readBrowserOwnedTabTargetArgs(args),
    ...(readFlag(args, ["--include-ended", "--all"]) ? { includeEnded: true } : {}),
  };
}

function readBrowserObservationArgs(args: string[]): JsonObject {
  const keepCount = readNumberOption(args, ["--keep", "--keep-count"]);
  const includeDom = readFlag(args, ["--dom", "--include-dom", "--elements"]);
  const skipDom = readFlag(args, ["--no-dom", "--no-elements"]);
  const includeDiagnostics = readFlag(args, ["--diagnostics", "--include-diagnostics"]);
  const skipDiagnostics = readFlag(args, ["--no-diagnostics", "--without-diagnostics"]);
  const includeElementMap = readFlag(args, ["--map", "--ui-map", "--element-map"]);
  const maxElements = readNumberOption(args, ["--max-elements", "--element-limit"]);
  return {
    ...readBrowserOwnedTabTargetArgs(args),
    ...(keepCount == null ? {} : { keepCount }),
    ...(includeDom ? { includeDom: true } : {}),
    ...(skipDom ? { includeDom: false } : {}),
    ...(includeDiagnostics ? { includeDiagnostics: true } : {}),
    ...(skipDiagnostics ? { includeDiagnostics: false } : {}),
    ...(includeElementMap ? { includeElementMap: true } : {}),
    ...(maxElements == null ? {} : { maxElements }),
  };
}

function readBrowserTraceArgs(args: string[]): JsonObject {
  const limit = readNumberOption(args, ["--limit", "--entries"]);
  return {
    ...readBrowserOwnedTabTargetArgs(args),
    ...(limit == null ? {} : { limit }),
  };
}

function readBrowserOwnedTabTargetArgs(args: string[]): JsonObject {
  return {
    ...readBrowserTabTargetArgs(args),
    ...readToolClaimArgs(args),
    ...readBrowserLeaseArgs(args),
  };
}

function readBrowserAgentActionArgs(args: string[]): JsonObject {
  const waitAfterMs = readNumberOption(args, ["--wait-after-ms", "--settle-ms"]);
  const fast = readFlag(args, ["--fast"]);
  return {
    ...readBrowserObservationArgs(args),
    observe: readFlag(args, ["--no-observe"]) ? false : undefined,
    ...(waitAfterMs == null ? (fast ? { waitAfterMs: 0 } : {}) : { waitAfterMs }),
  };
}

function readBrowserClickTargetArgs(args: string[]): JsonObject {
  const selector = readValue(args, ["--selector", "--css"]);
  const text = readValue(args, ["--text-match", "--label", "--name"]);
  const handle = readValue(args, ["--handle", "--element-handle", "--ref"]);
  const testId = readValue(args, [
    "--test-id",
    "--testid",
    "--data-testid",
    "--data-test-id",
    "--data-cy",
  ]);
  const elementIndex = readNumberOption(args, [
    "--element",
    "--element-index",
    "--index",
  ]);
  return {
    ...(selector ? { selector } : {}),
    ...(text ? { text } : {}),
    ...(testId ? { testId } : {}),
    ...(elementIndex == null ? {} : { elementIndex }),
    ...(handle ? { handle } : {}),
  };
}

function hasBrowserClickTargetFlag(args: string[]): boolean {
  const flags = new Set([
    "--selector",
    "--css",
    "--text-match",
    "--label",
    "--name",
    "--test-id",
    "--testid",
    "--data-testid",
    "--data-test-id",
    "--data-cy",
    "--element",
    "--element-index",
    "--index",
    "--handle",
    "--element-handle",
    "--ref",
  ]);
  return args.some((arg) => {
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    return flags.has(flag);
  });
}

function readPrId(args: string[]): string | null {
  return readValue(args, ["--pr", "--pr-id"]) ?? null;
}

function parseReviewerRequestValues(args: string[]): {
  reviewers: string[];
  teamReviewers: string[];
} {
  const reviewers: string[] = [];
  const teamReviewers: string[] = [];
  let teamValue: string | null;
  while ((teamValue = readValue(args, ["--team", "--team-reviewer"])) != null) {
    for (const part of teamValue.split(",")) {
      const slug = part.trim();
      if (slug) teamReviewers.push(slug);
    }
  }
  for (const entry of args.filter((value) => !value.startsWith("-"))) {
    for (const part of entry.split(",")) {
      const value = part.trim();
      if (!value) continue;
      if (value.toLowerCase().startsWith("team:")) {
        const slug = value.slice("team:".length).trim();
        if (slug) teamReviewers.push(slug);
      } else if (value.includes("/")) {
        teamReviewers.push(value);
      } else {
        reviewers.push(value);
      }
    }
  }
  return { reviewers, teamReviewers };
}

function readIntOption(
  args: string[],
  names: string[],
  fallback?: number,
): number | undefined {
  const value = readValue(args, names);
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`${names[0]} must be an integer.`);
  }
  return parsed;
}

function readNumberOption(
  args: string[],
  names: string[],
  fallback?: number,
): number | undefined {
  const value = readValue(args, names);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`${names[0]} must be a number.`);
  }
  return parsed;
}

function readJsonOption(
  args: string[],
  names: string[],
  label: string,
): unknown | undefined {
  const value = readValue(args, names);
  return value == null ? undefined : parseJson(value, label);
}

function readJsonFileOption(
  args: string[],
  names: string[],
  label: string,
): unknown | undefined {
  const filePath = readValue(args, names);
  if (filePath == null) return undefined;
  const resolvedPath = path.resolve(filePath);
  let text: string;
  try {
    text = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(
      `Could not read ${names[0]} file '${filePath}': ${message}`,
    );
  }
  return parseJson(text, label);
}

function readTextFileOption(args: string[], names: string[], label: string): string | null {
  const filePath = readValue(args, names);
  if (filePath == null) return null;
  const resolvedPath = path.resolve(filePath);
  try {
    return fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`Could not read ${label} file '${filePath}': ${message}`);
  }
}

function readSecretValueInput(args: string[]): string {
  const inline = readValue(args, ["--value", "--secret"]);
  const fromFile = readTextFileOption(args, ["--value-file", "--secret-file"], "--value-file");
  const fromStdin = readFlag(args, ["--stdin"]);
  const providedCount = [inline != null, fromFile != null, fromStdin].filter(Boolean).length;
  if (providedCount > 1) {
    throw new CliUsageError("Use only one of --value, --value-file, or --stdin.");
  }
  if (inline != null) return inline;
  if (fromFile != null) return fromFile;
  if (fromStdin) return fs.readFileSync(0, "utf8");
  const positionalValue = firstPositional(args);
  if (positionalValue != null) return positionalValue;
  throw new CliUsageError("Secret value is required. Pass --value, --value-file, --stdin, or a positional value.");
}

function readJsonPayloadOption(
  args: string[],
  jsonNames: string[],
  fileNames: string[],
  label: string,
): unknown | undefined {
  const inline = readJsonOption(args, jsonNames, label);
  const fromFile = readJsonFileOption(args, fileNames, label);
  if (inline !== undefined && fromFile !== undefined) {
    throw new CliUsageError(
      `Use either ${jsonNames[0]} or ${fileNames[0]}, not both.`,
    );
  }
  return inline ?? fromFile;
}

function requireValue(value: string | null, label: string): string {
  if (value && value.trim().length > 0) return value.trim();
  throw new CliUsageError(`${label} is required.`);
}

function normalizeChatMessageKind(value: string | null): "auto" | "queue" | "wake" | "interrupt-replace" {
  const normalized = (value ?? "auto").trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "queue" || normalized === "steer") return "queue";
  if (normalized === "wake" || normalized === "send") return "wake";
  if (
    normalized === "interrupt-replace" ||
    normalized === "interrupt" ||
    normalized === "replace"
  ) {
    return "interrupt-replace";
  }
  throw new CliUsageError(
    "chat message --kind must be auto, queue, wake, or interrupt-replace.",
  );
}

function normalizeChatWaitTarget(value: string | null): ChatWaitTarget {
  const normalized = (value ?? "idle").trim().toLowerCase();
  if (normalized === "idle" || normalized === "done" || normalized === "complete") return "idle";
  if (normalized === "active" || normalized === "running") return "active";
  if (
    normalized === "awaiting-input" ||
    normalized === "awaiting_input" ||
    normalized === "input" ||
    normalized === "blocked"
  ) {
    return "awaiting-input";
  }
  if (
    normalized === "terminal" ||
    normalized === "ended" ||
    normalized === "failed" ||
    normalized === "interrupted"
  ) {
    return "terminal";
  }
  throw new CliUsageError(
    "chat wait --for must be idle, active, awaiting-input, or terminal.",
  );
}

function chatWaitTargetMatches(summary: JsonObject, waitFor: ChatWaitTarget): boolean {
  const status = asString(summary.status);
  if (waitFor === "idle") return status === "idle";
  if (waitFor === "active") return status === "active" && summary.awaitingInput !== true;
  if (waitFor === "awaiting-input") return summary.awaitingInput === true;
  return status === "failed" || status === "interrupted" || status === "completed" || summary.endedAt != null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCommandTextValue(
  argv: string[],
  index: number,
  command: string[],
): boolean {
  if (command.length === 0) return false;
  const token = argv[index];
  if (token?.startsWith("--text=")) return true;
  if (token !== "--text") return false;
  const next = argv[index + 1];
  return Boolean(next && next !== "--" && !next.startsWith("-"));
}

function maybePut(target: JsonObject, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") {
    target[key] = value;
  }
}

/**
 * Foundation-owned daemon action names for Linear issue ↔ lane/session linking.
 * Centralized here so any rename in the foundation registry is a one-line patch
 * in the CLI. The lane domain owns lane-scoped and session-scoped attachment;
 * the linear_issue_tracker domain owns the read/write bridge an attached CLI
 * agent uses via `ade linear ...` (creds live in the desktop runtime).
 */
const LINEAR_ATTACH_ACTIONS = {
  domain: "lane",
  /** Lane-scoped link: linkLinearIssues({ laneId, issues: [...] }). */
  linkLane: "linkLinearIssues",
  /** Lane-scoped unlink (issueId omitted = remove all non-primary links): unlinkLinearIssues({ laneId, issueId? }). */
  unlinkLane: "unlinkLinearIssues",
  /** Attach issues to a session: attachLinearIssueToSession({ chatSessionId, issues: [...] }). */
  attachSession: "attachLinearIssueToSession",
  /** Detach one issue (or all if issueId omitted): detachLinearIssueFromSession({ chatSessionId, issueId? }). */
  detachSession: "detachLinearIssueFromSession",
  /** List issues for a session: listLinearIssuesForSession({ chatSessionId }). */
  listSession: "listLinearIssuesForSession",
} as const;

/**
 * Read the session id for session-scoped Linear commands. Prefers explicit
 * flags, then the agent-environment session id ($ADE_CHAT_SESSION_ID) so an
 * agent running inside a tracked CLI session can self-reference. `--this-session`
 * forces the env path and errors if it is unset.
 */
function readSessionId(args: string[], options: { thisSession?: boolean } = {}): string | null {
  const explicit = asString(
    readValue(args, [
      "--chat-session",
      "--chat-session-id",
      "--session",
      "--session-id",
    ]),
  );
  if (explicit) return explicit;
  const envSession = asString(process.env.ADE_CHAT_SESSION_ID);
  if (options.thisSession && !envSession) {
    throw new CliUsageError(
      "--this-session requires ADE_CHAT_SESSION_ID, which ADE sets inside a tracked CLI session.",
    );
  }
  return envSession;
}

/**
 * Parse `--linear-issue-json` (a single object or an array of objects) plus the
 * `--issue-id`/`--linear-issue-id` shorthands (repeatable) into a normalized
 * array of Linear issue objects. At least one issue must resolve.
 */
function parseLinearIssuesInput(args: string[], label = "--linear-issue-json"): JsonObject[] {
  const issues: JsonObject[] = [];
  const json = readValue(args, ["--linear-issue-json", "--issue-json", "--linear-issues-json"]);
  if (json != null) {
    const parsed = parseJson(json, label);
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    if (candidates.length === 0 || candidates.some((entry) => !isRecord(entry))) {
      throw new CliUsageError(`${label} must decode to an object or a non-empty array of objects.`);
    }
    issues.push(...(candidates as JsonObject[]));
  }
  // `--issue-id`/`--linear-issue-id` may be repeated; each becomes a minimal
  // issue object the daemon can hydrate from its identifier.
  const idFlags = ["--issue-id", "--linear-issue-id", "--issue", "--from-linear-issue"];
  let idShorthand = readValue(args, idFlags);
  while (idShorthand != null) {
    issues.push({ id: idShorthand, identifier: idShorthand });
    idShorthand = readValue(args, idFlags);
  }
  if (issues.length === 0) {
    throw new CliUsageError(`${label} or --issue-id <id> is required.`);
  }
  // Cheap pre-flight so the daemon never receives an unresolvable issue: every
  // issue must carry an id or identifier.
  const invalid = issues.findIndex(
    (issue) => !asString(issue.id) && !asString(issue.identifier),
  );
  if (invalid >= 0) {
    throw new CliUsageError(
      `${label} entry ${invalid + 1} is missing both "id" and "identifier".`,
    );
  }
  return issues;
}

/** First Linear issue id ADE injected into the session via $ADE_LINEAR_ISSUE_IDS. */
function sessionLinearIssueId(): string | null {
  const envIds = asString(process.env.ADE_LINEAR_ISSUE_IDS);
  return (
    envIds
      ?.split(",")
      .map((entry) => entry.trim())
      .find(Boolean) ?? null
  );
}

/** Consume the single-issue-id flag (`--issue-id`/`--linear-issue-id`/`--issue`) from args. */
function readIssueIdFlag(args: string[]): string | null {
  return readValue(args, ["--issue-id", "--linear-issue-id", "--issue"]);
}

function normalizeLinearGraphQLInput(input: JsonObject): JsonObject {
  try {
    return parseLinearGraphQLInput(input) as JsonObject;
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function readLinearGraphQLArgs(args: string[]): JsonObject {
  const inlineQuery = readValue(args, ["--query", "--graphql", "--gql"]);
  const fileQuery = readTextFileOption(args, ["--query-file", "--graphql-file", "--gql-file"], "--query-file");
  if (inlineQuery != null && fileQuery != null) {
    throw new CliUsageError("Use either --query or --query-file, not both.");
  }
  const positionalQuery = inlineQuery == null && fileQuery == null ? firstPositional(args) : null;
  const query = requireValue(inlineQuery ?? fileQuery ?? positionalQuery, "GraphQL query");
  const variables = readJsonPayloadOption(
    args,
    ["--variables-json", "--vars-json"],
    ["--variables-file", "--vars-file"],
    "--variables-json",
  );
  const input: JsonObject = { query };
  if (variables !== undefined) input.variables = variables;
  maybePut(input, "operationName", readValue(args, ["--operation-name", "--operation"]));
  const maxRetries = readNumberOption(args, ["--max-retries"]);
  if (maxRetries !== undefined) input.maxRetries = maxRetries;
  return normalizeLinearGraphQLInput(collectGenericObjectArgs(args, input));
}

/**
 * Resolve a Linear write-bridge command's issue id when the command takes no
 * positional value (e.g. `ade linear issue [<id>]`). Precedence: --issue-id flag
 * → leading positional → the session's injected issue id.
 */
function requireLinearIssueId(args: string[]): string {
  const explicit = asString(readIssueIdFlag(args));
  if (explicit) return explicit;
  const positional = asString(firstPositional(args));
  if (positional) return positional;
  const fromSession = sessionLinearIssueId();
  if (fromSession) return fromSession;
  throw new CliUsageError(
    "Linear issue id is required. Pass --issue-id <id> or run inside a session with an attached issue (ADE sets $ADE_LINEAR_ISSUE_IDS).",
  );
}

/**
 * Resolve the issue id + a single positional value for write commands that take
 * both (comment/set-state/label). Handles the ambiguity of one positional:
 *  - `comment ENG-431 "done"` → issueId=ENG-431, value="done"
 *  - `comment "done"` (session has an attached issue) → issueId from session, value="done"
 *  - `comment ENG-431` (no value flag) → issueId=ENG-431, value missing (caller errors)
 * An explicit --issue-id flag or value flag always wins over positionals.
 */
function resolveLinearWriteCommand(
  args: string[],
  valueFlagNames: string[],
): { issueId: string; value: string | null } {
  const explicitIssueId = asString(readIssueIdFlag(args));
  const explicitValue = asString(readValue(args, valueFlagNames));
  const positionals: string[] = [];
  let next = firstPositional(args);
  while (next != null) {
    positionals.push(next);
    next = firstPositional(args);
  }
  const sessionId = sessionLinearIssueId();

  let issueId = explicitIssueId;
  let value = explicitValue;

  if (!issueId) {
    // With no explicit id: if the session injected one and exactly one positional
    // remains for the value, treat that positional as the value. Otherwise the
    // first positional is the issue id.
    if (sessionId && (positionals.length <= 1 || explicitValue)) {
      issueId = sessionId;
    } else {
      issueId = asString(positionals.shift() ?? null);
    }
  }
  if (!issueId) {
    throw new CliUsageError(
      "Linear issue id is required. Pass --issue-id <id> or run inside a session with an attached issue (ADE sets $ADE_LINEAR_ISSUE_IDS).",
    );
  }
  if (!value) {
    value = positionals.length ? positionals.join(" ").trim() : null;
  }
  return { issueId, value };
}

/** Shared link/attachment flags (source, include-in-pr, close-on-merge, role). */
function readLinearAttachmentFlags(args: string[]): JsonObject {
  const flags: JsonObject = {};
  maybePut(flags, "role", readValue(args, ["--role"]));
  maybePut(flags, "source", readValue(args, ["--source"]));
  if (readFlag(args, ["--no-include-in-pr"])) flags.includeInPr = false;
  if (readFlag(args, ["--include-in-pr"])) flags.includeInPr = true;
  if (readFlag(args, ["--close-on-merge"])) flags.closeOnMerge = true;
  if (readFlag(args, ["--no-close-on-merge"])) flags.closeOnMerge = false;
  return flags;
}

/**
 * Build args for lane.attachLinearIssueToSession({ chatSessionId, issues: [...] }).
 * The runtime accepts an array, so one or many issues attach in a single call.
 */
function buildSessionAttachArgs(
  chatSessionId: string,
  issues: JsonObject[],
  flags: JsonObject,
): JsonObject {
  return { chatSessionId, issues, ...flags };
}

/**
 * Derive a kickoff prompt for a `--start-chat` / `--from-linear-issue` launch
 * from the issue's identifier/title/url when the caller did not pass an explicit
 * `--prompt`/`--kickoff`. Keeps the agent's first turn grounded in the issue.
 */
function deriveLinearKickoffPrompt(issue: JsonObject): string {
  const identifier = asString(issue.identifier) ?? asString(issue.id) ?? "the linked issue";
  const title = asString(issue.title);
  const url = asString(issue.url);
  const lines = [
    `Work on Linear issue ${identifier}${title ? `: ${title}` : ""}.`,
    "Read the attached issue context, then implement the change end-to-end.",
    "Use `ade linear` to read comments and post status/comments back to the issue as you progress.",
  ];
  if (url) lines.push(`Issue: ${url}`);
  return lines.join("\n");
}

function parseCliArgs(argv: string[]): ParsedCli {
  const command: string[] = [];
  const options: GlobalOptions = {
    projectRoot: null,
    workspaceRoot: null,
    role: resolveAdeDefaultRole(process.env.ADE_DEFAULT_ROLE, "agent"),
    headless: parseBooleanEnv(process.env.ADE_CLI_HEADLESS),
    requireSocket: false,
    socketPath: null,
    pretty: true,
    text: false,
    timeoutMs: 10 * 60 * 1000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const inGlobalPrefix = command.length === 0;
    if (token === "--") {
      command.push(token, ...argv.slice(index + 1));
      break;
    }
    if (inGlobalPrefix && token === "--project-root") {
      options.projectRoot = path.resolve(
        requireValue(argv[index + 1] ?? null, "--project-root"),
      );
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--project-root=")) {
      options.projectRoot = path.resolve(
        requireValue(token.slice("--project-root=".length), "--project-root"),
      );
      continue;
    }
    if (inGlobalPrefix && token === "--workspace-root") {
      options.workspaceRoot = path.resolve(
        requireValue(argv[index + 1] ?? null, "--workspace-root"),
      );
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--workspace-root=")) {
      options.workspaceRoot = path.resolve(
        requireValue(
          token.slice("--workspace-root=".length),
          "--workspace-root",
        ),
      );
      continue;
    }
    if (inGlobalPrefix && token === "--role") {
      options.role = parseRole(requireValue(argv[index + 1] ?? null, "--role"));
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--role=")) {
      options.role = parseRole(
        requireValue(token.slice("--role=".length), "--role"),
      );
      continue;
    }
    if (inGlobalPrefix && (token === "--headless" || token === "--no-socket")) {
      options.headless = true;
      continue;
    }
    if (inGlobalPrefix && token === "--socket") {
      options.requireSocket = true;
      options.headless = false;
      const maybeSocketPath = argv[index + 1] ?? "";
      if (looksLikeSocketPathOverride(maybeSocketPath)) {
        options.socketPath = maybeSocketPath;
        index += 1;
      }
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--socket=")) {
      options.requireSocket = true;
      options.headless = false;
      options.socketPath = requireValue(token.slice("--socket=".length), "--socket");
      continue;
    }
    if (token === "--compact") {
      options.pretty = false;
      continue;
    }
    if (token === "--pretty") {
      options.pretty = true;
      continue;
    }
    if (isCommandTextValue(argv, index, command)) {
      command.push(token);
      continue;
    }
    if (token === "--text") {
      options.text = true;
      continue;
    }
    if (token === "--json") {
      options.text = false;
      continue;
    }
    if (inGlobalPrefix && token === "--timeout-ms") {
      const parsed = Number.parseInt(
        requireValue(argv[index + 1] ?? null, "--timeout-ms"),
        10,
      );
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliUsageError("--timeout-ms must be a positive integer.");
      }
      options.timeoutMs = parsed;
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--timeout-ms=")) {
      const parsed = Number.parseInt(
        requireValue(token.slice("--timeout-ms=".length), "--timeout-ms"),
        10,
      );
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliUsageError("--timeout-ms must be a positive integer.");
      }
      options.timeoutMs = parsed;
      continue;
    }
    command.push(token);
  }

  return { options, command };
}

function looksLikeSocketPathOverride(value: string): boolean {
  if (!value || value.startsWith("-")) return false;
  return (
    value.startsWith("tcp://") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    isAdeRuntimeNamedPipePath(value) ||
    value.endsWith(".sock")
  );
}

function parseRole(value: string): GlobalOptions["role"] {
  const role = normalizeAdeRuntimeRole(value);
  if (role) return role;
  throw new CliUsageError(
    "--role must be one of cto, orchestrator, agent, external, or evaluator.",
  );
}

function shellEscapeToken(value: string): string {
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function actionCallStep(
  key: string,
  name: string,
  args: JsonObject = {},
): InvocationStep {
  return {
    key,
    method: "ade/actions/call",
    params: { name, arguments: args },
    unwrapToolResult: true,
  };
}

function actionStep(
  key: string,
  domain: string,
  action: string,
  args: JsonObject = {},
): InvocationStep {
  return actionCallStep(key, "run_ade_action", { domain, action, args });
}

function accountActionStep(
  key: string,
  action: string,
  args: JsonObject = {},
): InvocationStep {
  return {
    key,
    method: "account.call",
    params: { action, args },
  };
}

function actionArgsListStep(
  key: string,
  domain: string,
  action: string,
  argsList: unknown[],
): InvocationStep {
  return actionCallStep(key, "run_ade_action", { domain, action, argsList });
}

function actionScalarStep(
  key: string,
  domain: string,
  action: string,
  arg: unknown,
): InvocationStep {
  return actionCallStep(key, "run_ade_action", { domain, action, arg });
}


function listActionsStep(key: string, domain?: string): InvocationStep {
  return actionCallStep(key, "list_ade_actions", domain ? { domain } : {});
}

function buildActionRunStep(args: string[]): InvocationStep {
  const target = firstPositional(args);
  if (!target)
    throw new CliUsageError(
      "actions run requires <domain.action> or <domain> <action>.",
    );

  let domain: string;
  let action: string;
  if (target.includes(".")) {
    const parts = target.split(".");
    domain = requireValue(parts.shift() ?? null, "domain");
    action = requireValue(parts.join("."), "action");
  } else {
    domain = target;
    action = requireValue(firstPositional(args), "action");
  }

  const argsListJson = readValue(args, ["--args-list-json", "--params-json"]);
  if (argsListJson != null) {
    const argsList = parseJson(argsListJson, "--args-list-json");
    if (!Array.isArray(argsList))
      throw new CliUsageError("--args-list-json must be a JSON array.");
    if (domain === "account") {
      if (
        (action === "pollLogin" || action === "pollDeviceLogin")
        && argsList.length === 1
        && typeof argsList[0] === "string"
      ) {
        return accountActionStep("result", action, { sessionId: argsList[0] });
      }
      if (argsList.length === 0) return accountActionStep("result", action);
      throw new CliUsageError("account actions accept object input; polling actions also accept [sessionId].");
    }
    return actionCallStep("result", "run_ade_action", {
      domain,
      action,
      argsList,
    });
  }

  const scalarJson = readValue(args, ["--scalar-json", "--arg-value-json"]);
  if (scalarJson != null) {
    if (domain === "account") {
      const scalar = parseJson(scalarJson, "--scalar-json");
      if ((action === "pollLogin" || action === "pollDeviceLogin") && typeof scalar === "string") {
        return accountActionStep("result", action, { sessionId: scalar });
      }
      throw new CliUsageError("Only account polling actions accept scalar input.");
    }
    return actionCallStep("result", "run_ade_action", {
      domain,
      action,
      arg: parseJson(scalarJson, "--scalar-json"),
    });
  }

  const scalar = readValue(args, ["--scalar", "--arg-value"]);
  if (scalar != null) {
    if (domain === "account") {
      if (action === "pollLogin" || action === "pollDeviceLogin") {
        return accountActionStep("result", action, { sessionId: scalar });
      }
      throw new CliUsageError("Only account polling actions accept scalar input.");
    }
    return actionCallStep("result", "run_ade_action", {
      domain,
      action,
      arg: parsePrimitive(scalar),
    });
  }

  const objectArgs = collectGenericObjectArgs(args);
  return domain === "account"
    ? accountActionStep("result", action, objectArgs)
    : actionStep("result", domain, action, objectArgs);
}

function buildLanePlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") {
    return {
      kind: "execute",
      label: "lane actions",
      steps: [listActionsStep("actions", "lane")],
    };
  }
  if (sub === "action") {
    return {
      kind: "execute",
      label: "lane action",
      steps: [buildActionRunStep(["lane", ...args])],
    };
  }
  if (sub === "list" || sub === "ls") {
    const input = collectGenericObjectArgs(args, {
      includeArchived: readFlag(args, ["--archived", "--include-archived"]),
    });
    const visual = readFlag(args, ["--visual", "--graph"]);
    const noVisual = readFlag(args, ["--no-visual"]);
    return {
      kind: "execute",
      label: "lanes list",
      steps: [actionCallStep("result", "list_lanes", input)],
      visualizer: visual || !noVisual ? "lanes" : undefined,
    };
  }
  if (sub === "show" || sub === "status") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    return {
      kind: "execute",
      label: "lane status",
      steps: [actionCallStep("result", "get_lane_status", { laneId })],
    };
  }
  if (sub === "merge") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    return {
      kind: "execute",
      label: "lane merge",
      steps: [
        actionCallStep(
          "result",
          "merge_lane",
          collectGenericObjectArgs(args, {
            laneId,
            message: readValue(args, ["--message", "-m"]),
            deleteSourceLane: readFlag(args, [
              "--delete-source-lane",
              "--delete-source",
            ]),
          }),
        ),
      ],
    };
  }
  if (sub === "conflicts") {
    const mode = firstPositional(args) ?? "check";
    if (mode !== "check")
      return {
        kind: "execute",
        label: `lane conflicts ${mode}`,
        steps: [
          actionStep(
            "result",
            "conflicts",
            mode,
            collectGenericObjectArgs(args, { laneId: readLaneId(args) }),
          ),
        ],
      };
    const ids = args.filter((entry) => !entry.startsWith("-"));
    return {
      kind: "execute",
      label: "lane conflicts check",
      steps: [
        actionCallStep(
          "result",
          "check_conflicts",
          collectGenericObjectArgs(args, {
            laneId: readLaneId(args),
            ...(ids.length ? { laneIds: ids } : {}),
            force: readFlag(args, ["--force"]),
          }),
        ),
      ],
    };
  }
  if (sub === "create" || sub === "child") {
    const name = readValue(args, ["--name"]) ?? firstPositional(args);
    const input: JsonObject = {};
    input.name = requireValue(name, "name");
    maybePut(
      input,
      "description",
      readValue(args, ["--description", "--desc"]),
    );
    maybePut(
      input,
      "parentLaneId",
      readValue(args, ["--parent", "--parent-lane", "--parent-lane-id"]) ??
        (sub === "child" ? readLaneId(args) : null),
    );
    maybePut(input, "baseBranch", readValue(args, ["--base", "--base-branch"]));
    maybePut(input, "branchName", readValue(args, ["--branch-name"]));
    const linearIssueJson = readValue(args, ["--linear-issue-json"]);
    if (linearIssueJson) {
      const parsed = parseJson(linearIssueJson, "--linear-issue-json");
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new CliUsageError(
          "--linear-issue-json must decode to a non-null JSON object",
        );
      }
      input.linearIssue = parsed as JsonObject;
    }
    if (sub === "child" && !input.parentLaneId)
      throw new CliUsageError(
        "parent lane is required. Use --lane <parent> or --parent <parent>.",
      );
    const createArgs = collectGenericObjectArgs(args, input);
    return {
      kind: "execute",
      label: "lane create",
      ...(!createArgs.parentLaneId && !createArgs.baseBranch && typeof createArgs.name === "string" && createArgs.name.trim()
        ? { laneCreationNudge: { newLaneName: createArgs.name.trim() } }
        : {}),
      steps: [
        actionCallStep(
          "result",
          "create_lane",
          createArgs,
        ),
      ],
    };
  }
  if (sub === "children") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    return {
      kind: "execute",
      label: "lane children",
      steps: [actionArgsListStep("result", "lane", "getChildren", [laneId])],
    };
  }
  if (
    sub === "link-linear-issue" ||
    sub === "link-linear" ||
    sub === "linear-link" ||
    sub === "attach-linear-issue" ||
    sub === "attach-linear"
  ) {
    // `link-*` and `attach-*` are aliases for lane-scoped linking; the
    // session-scoped attach lives under `ade chat attach-linear-issue`.
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    const issues = parseLinearIssuesInput(args);
    const input: JsonObject = {
      laneId,
      issues,
      ...readLinearAttachmentFlags(args),
    };
    return {
      kind: "execute",
      label: "lane link Linear issue",
      steps: [
        actionStep(
          "result",
          LINEAR_ATTACH_ACTIONS.domain,
          LINEAR_ATTACH_ACTIONS.linkLane,
          collectGenericObjectArgs(args, input),
        ),
      ],
    };
  }
  if (
    sub === "detach-linear-issue" ||
    sub === "detach-linear" ||
    sub === "unlink-linear-issue" ||
    sub === "unlink-linear"
  ) {
    // Lane-scoped unlink: omitting --issue-id removes all non-primary lane links;
    // the lane's primary (lane-create) issue is never removed by this action.
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    const issueId = asString(readIssueIdFlag(args));
    const input: JsonObject = { laneId };
    maybePut(input, "issueId", issueId);
    return {
      kind: "execute",
      label: "lane detach Linear issue",
      steps: [
        actionStep(
          "result",
          LINEAR_ATTACH_ACTIONS.domain,
          LINEAR_ATTACH_ACTIONS.unlinkLane,
          collectGenericObjectArgs(args, input),
        ),
      ],
    };
  }
  if (
    sub === "create-from-linear" ||
    sub === "create-from-linear-issue" ||
    sub === "create-from-issue"
  ) {
    // Create a lane from a Linear issue, optionally auto-launching a chat agent
    // grounded in the issue. Accepts a single issue (object or single-element
    // array); batching across many issues is `ade lanes batch-create-from-linear`.
    const issues = parseLinearIssuesInput(args);
    if (issues.length !== 1) {
      throw new CliUsageError(
        "lanes create-from-linear expects exactly one issue. Use `ade lanes batch-create-from-linear` for multiple.",
      );
    }
    return buildCreateLaneFromLinearPlan(args, issues[0]!);
  }
  if (
    sub === "batch-create-from-linear" ||
    sub === "batch-create-from-linear-issue" ||
    sub === "batch-create-from-issue"
  ) {
    const issues = parseLinearIssuesInput(args, "--linear-issues-json");
    return buildBatchCreateLanesFromLinearPlan(args, issues);
  }
  if (sub === "stack") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    return {
      kind: "execute",
      label: "lane stack",
      steps: [actionArgsListStep("result", "lane", "getStackChain", [laneId])],
    };
  }
  if (sub === "refresh") {
    return {
      kind: "execute",
      label: "lane refresh",
      steps: [
        actionStep(
          "result",
          "lane",
          "refreshSnapshots",
          collectGenericObjectArgs(args, {
            includeArchived: readFlag(args, [
              "--archived",
              "--include-archived",
            ]),
          }),
        ),
      ],
    };
  }
  if (sub === "rename") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    return {
      kind: "execute",
      label: "lane rename",
      steps: [
        actionStep(
          "result",
          "lane",
          "rename",
          collectGenericObjectArgs(args, {
            laneId,
            name: readValue(args, ["--name"]) ?? firstPositional(args),
          }),
        ),
      ],
    };
  }
  if (sub === "reparent") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    const reparentArgs: JsonObject = {
      laneId,
      newParentLaneId:
        readValue(args, [
          "--parent",
          "--parent-lane",
          "--parent-lane-id",
        ]) ?? firstPositional(args),
    };
    const stackBaseBranchRef = readValue(args, [
      "--stack-base-branch",
      "--stack-base",
      "--base-branch-ref",
    ]);
    if (stackBaseBranchRef != null) {
      reparentArgs.stackBaseBranchRef = stackBaseBranchRef;
    }
    return {
      kind: "execute",
      label: "lane reparent",
      steps: [
        actionStep(
          "result",
          "lane",
          "reparent",
          collectGenericObjectArgs(args, reparentArgs),
        ),
      ],
    };
  }
  if (sub === "appearance") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    return {
      kind: "execute",
      label: "lane appearance",
      steps: [
        actionStep(
          "result",
          "lane",
          "updateAppearance",
          collectGenericObjectArgs(args, {
            laneId,
            color: readValue(args, ["--color"]),
            icon: readValue(args, ["--icon"]),
          }),
        ),
      ],
    };
  }
  if (sub === "archive" || sub === "unarchive") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    return {
      kind: "execute",
      label: `lane ${sub}`,
      steps: [
        actionStep(
          "result",
          "lane",
          sub,
          collectGenericObjectArgs(args, { laneId }),
        ),
      ],
    };
  }
  if (sub === "delete" || sub === "rm") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    return {
      kind: "execute",
      label: "lane delete",
      steps: [
        actionStep(
          "result",
          "lane",
          "delete",
          collectGenericObjectArgs(args, {
            laneId,
            force: readFlag(args, ["--force"]),
            deleteBranch: readFlag(args, ["--delete-branch"]),
            deleteRemoteBranch: readFlag(args, ["--delete-remote-branch"]),
          }),
        ),
      ],
    };
  }
  if (sub === "attach") {
    return {
      kind: "execute",
      label: "lane attach",
      steps: [
        actionStep(
          "result",
          "lane",
          "attach",
          collectGenericObjectArgs(args, {
            worktreePath: readValue(args, ["--path"]) ?? firstPositional(args),
            name: readValue(args, ["--name"]),
          }),
        ),
      ],
    };
  }
  if (sub === "adopt-attached") {
    const laneId = requireValue(
      readLaneId(args) ?? firstPositional(args),
      "laneId",
    );
    return {
      kind: "execute",
      label: "lane adopt attached",
      steps: [
        actionStep(
          "result",
          "lane",
          "adoptAttached",
          collectGenericObjectArgs(args, { laneId }),
        ),
      ],
    };
  }
  if (sub === "split-unstaged") {
    return {
      kind: "execute",
      label: "lane split unstaged",
      steps: [
        actionStep(
          "result",
          "lane",
          "createFromUnstaged",
          collectGenericObjectArgs(args, {
            sourceLaneId:
              readValue(args, ["--source", "--source-lane"]) ??
              readLaneId(args),
            name: readValue(args, ["--name"]) ?? firstPositional(args),
          }),
        ),
      ],
    };
  }
  if (sub === "import" || sub === "import-branch") {
    const input: JsonObject = {};
    input.branchRef = requireValue(
      readValue(args, ["--branch", "--branch-ref"]) ?? firstPositional(args),
      "branchRef",
    );
    maybePut(input, "name", readValue(args, ["--name"]));
    maybePut(
      input,
      "description",
      readValue(args, ["--description", "--desc"]),
    );
    maybePut(input, "baseBranch", readValue(args, ["--base", "--base-branch"]));
    return {
      kind: "execute",
      label: "lane import",
      steps: [
        actionCallStep(
          "result",
          "import_lane",
          collectGenericObjectArgs(args, input),
        ),
      ],
    };
  }
  if (sub === "unregistered" || sub === "list-unregistered") {
    return {
      kind: "execute",
      label: "unregistered lanes",
      steps: [
        actionCallStep(
          "result",
          "list_unregistered_lanes",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  return {
    kind: "execute",
    label: `lane ${sub}`,
    steps: [actionStep("result", "lane", sub, collectGenericObjectArgs(args))],
  };
}

/**
 * Read the model/provider/effort launch config shared by `--start-chat` and
 * `ade chat create`. Returns only the keys the caller explicitly set so the
 * daemon can fall back to its own defaults.
 */
function readChatLaunchConfig(args: string[]): JsonObject {
  const modelArg = readValue(args, ["--model", "--model-id"]);
  const fastMode = readFastModeFlag(args);
  const config: JsonObject = {};
  maybePut(config, "provider", readValue(args, ["--provider"]));
  maybePut(config, "model", modelArg);
  maybePut(config, "modelId", modelArg);
  maybePut(config, "reasoningEffort", readValue(args, ["--reasoning-effort", "--effort"]));
  maybePut(
    config,
    "permissionMode",
    readValue(args, ["--permission-mode", "--permissions"]),
  );
  if (fastMode !== undefined) {
    config.fastMode = fastMode;
    // Mirror to the deprecated alias so older daemons (pre-rename) still see the selection.
    config.codexFastMode = fastMode;
  }
  return config;
}

function readFastModeFlag(args: string[]): boolean | undefined {
  const fastRequested = readFlag(args, ["--fast", "--codex-fast"]);
  const standardRequested = readFlag(args, [
    "--standard",
    "--no-fast",
    "--no-codex-fast",
  ]);
  if (fastRequested && standardRequested) {
    throw new CliUsageError(
      "Use either --fast/--codex-fast or --standard/--no-fast/--no-codex-fast, not both.",
    );
  }
  return fastRequested ? true : standardRequested ? false : undefined;
}

function autoLaneGenericSuffix(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function readNewChatPrompt(args: string[]): string | null {
  const promptArgs = takeArgsAfterTerminator(args);
  const prompt = promptArgs
    ? promptArgs.join(" ").trim()
    : readValue(args, ["--prompt", "--message", "--initial-input", "--kickoff"]);
  return prompt?.trim() || null;
}

function isAutoLaneSelector(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "auto" ||
    normalized === "new" ||
    normalized === "auto-create" ||
    normalized === "__ade_auto_create_lane__"
  );
}

function readNewChatMode(args: string[], defaultMode: "chat" | "cli"): "chat" | "cli" {
  const explicitMode = readValue(args, ["--mode", "--kind"])?.trim().toLowerCase();
  const chatFlag = readFlag(args, ["--chat"]);
  const cliFlag = readFlag(args, ["--cli", "--terminal"]);
  const requested = explicitMode ?? (chatFlag ? "chat" : cliFlag ? "cli" : defaultMode);
  if (chatFlag && cliFlag) {
    throw new CliUsageError("Use either --chat or --cli, not both.");
  }
  if (explicitMode && (chatFlag || cliFlag)) {
    const flagMode = chatFlag ? "chat" : "cli";
    if (explicitMode !== flagMode) {
      throw new CliUsageError("Use one mode selector: --mode chat|cli, --chat, or --cli.");
    }
  }
  if (requested !== "chat" && requested !== "cli") {
    throw new CliUsageError("--mode must be either chat or cli.");
  }
  return requested;
}

function resolveNewChatLaneArgs(args: string[], prompt: string | null): {
  laneId: string | null;
  autoCreateLane: boolean;
  createLaneArgs: JsonObject | null;
} {
  const laneValue = readLaneId(args);
  const autoCreateLane =
    readFlag(args, ["--auto-create-lane", "--create-lane", "--new-lane"]) ||
    isAutoLaneSelector(laneValue);
  if (!autoCreateLane) {
    const laneId = laneValue ?? process.env.ADE_LANE_ID ?? null;
    if (!laneId) {
      throw new CliUsageError("Provide --lane <lane> or --auto-create-lane.");
    }
    return { laneId, autoCreateLane: false, createLaneArgs: null };
  }

  const explicitName = readValue(args, ["--lane-name", "--name"]);
  const namingSeed = prompt || explicitName || "New chat task";
  const laneName =
    explicitName?.trim() ||
    deriveDeterministicLaneNameFromPrompt(namingSeed, {
      genericSuffix: autoLaneGenericSuffix(),
    });
  const createLaneArgs: JsonObject = { name: laneName };
  maybePut(createLaneArgs, "description", readValue(args, ["--description", "--desc"]));
  maybePut(createLaneArgs, "baseBranch", readValue(args, ["--base", "--base-branch"]));
  maybePut(createLaneArgs, "branchName", readValue(args, ["--branch-name"]));
  maybePut(createLaneArgs, "parentLaneId", readValue(args, ["--parent", "--parent-lane", "--parent-lane-id"]));
  return { laneId: null, autoCreateLane: true, createLaneArgs };
}

function buildNewPlan(args: string[]): CliPlan {
  const surface = firstStandalonePositional(args) ?? "chat";
  if (surface !== "chat" && surface !== "cli") {
    throw new CliUsageError("ade new supports `chat` or `cli`. Try `ade new chat --mode chat|cli ...`.");
  }
  return buildNewChatPlan(args, surface === "cli" ? "cli" : "chat");
}

function buildNewChatPlan(args: string[], defaultMode: "chat" | "cli"): CliPlan {
  const mode = readNewChatMode(args, defaultMode);
  const prompt = readNewChatPrompt(args);
  const lane = resolveNewChatLaneArgs(args, prompt);
  const provider = readValue(args, ["--provider"])?.trim().toLowerCase() || "codex";
  const modelArg = readValue(args, ["--model", "--model-id"]);
  const reasoningEffort = readValue(args, ["--reasoning-effort", "--effort", "--reasoning"]);
  const permissionMode = readValue(args, ["--permission-mode", "--permissions"]);
  const spawnTypeArg = readValue(args, ["--type", "--spawn-type"]);
  const spawnKind = mode === "chat" ? spawnTypeArg?.trim().toLowerCase() : undefined;
  const fastMode = readFastModeFlag(args);
  const title = readValue(args, ["--title"]);
  const printConfig = readFlag(args, ["--print-config", "--dry-run"]);

  if (!isLaunchProfile(provider)) {
    throw new CliUsageError("Provider must be claude, codex, cursor, droid, opencode, or shell.");
  }
  if (mode === "chat" && provider === "shell") {
    throw new CliUsageError("Chat mode provider must be claude, codex, cursor, droid, or opencode.");
  }
  if (spawnKind && spawnKind !== "subagent" && spawnKind !== "peer" && spawnKind !== "none") {
    throw new CliUsageError("--type must be subagent, peer, or none.");
  }
  if (mode === "cli") {
    const effectivePermissionMode = permissionMode ?? "default";
    if (!isTrackedCliPermissionMode(effectivePermissionMode)) {
      throw new CliUsageError(
        "permissionMode must be one of default, auto, plan, edit, full-auto, or config-toml.",
      );
    }
    validateLaunchProfilePermissionMode(provider, effectivePermissionMode);
  }

  const laneIdFor = (values: JsonObject): string => {
    if (!lane.autoCreateLane && lane.laneId) return lane.laneId;
    const createdLaneId = laneIdFromCreateLaneValue(values.lane);
    if (!createdLaneId) {
      throw new CliUsageError("ade new chat could not resolve the auto-created lane id.");
    }
    return createdLaneId;
  };

  // Consume the flags in both modes so they never leak into the generic arg
  // bag; lineage only applies to chat mode (a PTY session is not a chat
  // record, so there is nothing to link).
  const parentSessionId = readParentSessionId(args);
  const orchestrationParentSessionId = mode === "chat" ? parentSessionId : undefined;
  const launchArgs = mode === "chat"
    ? collectGenericObjectArgs(args, {
        provider,
        model: modelArg,
        modelId: modelArg,
        reasoningEffort,
        permissionMode,
        ...(orchestrationParentSessionId ? { orchestrationParentSessionId } : {}),
        ...(spawnKind ? { spawnKind } : {}),
        droidPermissionMode: readValue(args, [
          "--droid-permission-mode",
          "--droid-autonomy",
          "--autonomy",
        ]),
        title,
        surface: readValue(args, ["--surface"]) ?? "work",
        ...(fastMode !== undefined ? { fastMode, codexFastMode: fastMode } : {}),
      })
    : collectGenericObjectArgs(args, {
        provider,
        permissionMode: permissionMode ?? "default",
        title,
        initialInput: prompt,
        model: modelArg,
        modelId: modelArg,
        reasoningEffort,
        ...(fastMode !== undefined ? { fastMode, codexFastMode: fastMode } : {}),
        cols: readIntOption(args, ["--cols"], 120),
        rows: readIntOption(args, ["--rows"], 36),
        cwd: readValue(args, ["--cwd"]),
        tracked: !readFlag(args, ["--untracked"]),
      });

  if (printConfig) {
    return {
      kind: "static",
      formatter: "action-result",
      value: {
        ok: true,
        dryRun: true,
        action: "new.chat",
        mode,
        autoCreateLane: lane.autoCreateLane,
        ...(lane.createLaneArgs ? { createLane: lane.createLaneArgs } : { laneId: lane.laneId }),
        launch: compactPreviewObject(launchArgs),
        ...(mode === "chat" && prompt ? { afterCreate: [{ action: "chat.sendMessage", text: prompt }] } : {}),
      },
    };
  }

  const steps: InvocationStep[] = [];
  const laneCreationNudge = lane.autoCreateLane
    && lane.createLaneArgs
    && !lane.createLaneArgs.parentLaneId
    && !lane.createLaneArgs.baseBranch
    && typeof lane.createLaneArgs.name === "string"
    && lane.createLaneArgs.name.trim()
    ? { newLaneName: lane.createLaneArgs.name.trim() }
    : null;
  if (lane.autoCreateLane) {
    steps.push(actionCallStep("lane", "create_lane", lane.createLaneArgs ?? {}));
  }

  if (mode === "cli") {
    steps.push({
      key: "result",
      method: "ade/actions/call",
      params: (values) => ({
        name: "start_cli_session",
        arguments: {
          ...launchArgs,
          laneId: laneIdFor(values),
        },
      }),
      unwrapToolResult: true,
    });
    return {
      kind: "execute",
      label: "new chat cli",
      formatter: "pty-create",
      steps,
      ...(laneCreationNudge ? { laneCreationNudge } : {}),
    };
  }

  steps.push({
    key: prompt ? "session" : "result",
    method: "ade/actions/call",
    params: (values) => ({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "createSession",
        args: {
          ...launchArgs,
          laneId: laneIdFor(values),
        },
      },
    }),
    unwrapToolResult: true,
  });

  if (prompt) {
    steps.push({
      key: "result",
      method: "ade/actions/call",
      params: (values) => {
        const targetSession = sessionIdFromCreateChatValue(values.session);
        if (!targetSession) {
          throw new CliUsageError("ade new chat could not resolve the new session id to send the prompt.");
        }
        return {
          name: "run_ade_action",
          arguments: {
            domain: "chat",
            action: "sendMessage",
            args: {
              sessionId: targetSession,
              text: prompt,
            },
          },
        };
      },
      unwrapToolResult: true,
    });
  }

  return {
    kind: "execute",
    label: "new chat",
    steps,
    ...(laneCreationNudge ? { laneCreationNudge } : {}),
  };
}

function codexPermissionPreview(permissionMode: string): JsonObject | null {
  if (permissionMode === "config-toml") {
    return { codexConfigSource: "config-toml" };
  }
  if (permissionMode === "full-auto") {
    return {
      codexConfigSource: "flags",
      codexSandbox: "danger-full-access",
      codexApprovalPolicy: "never",
    };
  }
  if (permissionMode === "edit") {
    return {
      codexConfigSource: "flags",
      codexSandbox: "workspace-write",
      codexApprovalPolicy: "untrusted",
    };
  }
  if (permissionMode === "plan" || permissionMode === "auto") {
    return {
      codexConfigSource: "flags",
      codexSandbox: "read-only",
      codexApprovalPolicy: "on-request",
    };
  }
  return {
    codexConfigSource: "flags",
    codexSandbox: "workspace-write",
    codexApprovalPolicy: "on-request",
  };
}

function permissionModePreview(permissionMode: string): JsonObject {
  const mode = permissionMode || "default";
  return {
    permissionMode: mode,
    claudePermissionMode: mode === "full-auto"
      ? "bypassPermissions"
      : mode === "edit"
        ? "acceptEdits"
        : mode === "plan"
          ? "plan"
          : mode === "auto"
            ? "auto"
            : "default",
    codex: codexPermissionPreview(mode),
    cursorMode: mode === "full-auto"
      ? "full-auto"
      : mode === "plan"
        ? "plan"
        : mode === "edit"
          ? "ask"
          : "agent",
    droidPermissionMode: mode === "full-auto"
      ? "auto-high"
      : mode === "edit"
        ? "auto-low"
        : mode === "plan"
          ? "read-only"
          : "auto-medium",
    opencodePermissionMode: mode === "default" ? "edit" : mode,
  };
}

function compactPreviewValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactPreviewValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return compactPreviewObject(value as JsonObject);
}

function compactPreviewObject(input: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    output[key] = compactPreviewValue(value);
  }
  return output;
}

function buildChatCreateConfigPreview(
  args: JsonObject,
  options: {
    linearIssue?: JsonObject | null;
    attachmentFlags?: JsonObject;
    kickoffText?: string | null;
    noKickoff?: boolean;
  } = {},
): JsonObject {
  const input = compactPreviewObject(args);
  const permissionMode = asString(input.permissionMode) ?? "default";
  const afterCreate: JsonObject[] = [];
  if (options.linearIssue) {
    afterCreate.push({
      action: "lane.attachLinearIssueToSession",
      input: compactPreviewObject({
        chatSessionId: "<created-session-id>",
        issues: [options.linearIssue],
        ...(options.attachmentFlags ?? {}),
      }),
    });
  }
  if (!options.noKickoff && options.kickoffText) {
    afterCreate.push({
      action: "chat.sendMessage",
      input: {
        sessionId: "<created-session-id>",
        text: options.kickoffText,
      },
    });
  }
  return {
    ok: true,
    dryRun: true,
    action: "chat.createSession",
    input,
    ...(afterCreate.length ? { afterCreate } : {}),
    resolved: {
      provider: asString(input.provider) ?? null,
      model: asString(input.model) ?? asString(input.modelId) ?? null,
      reasoningEffort: asString(input.reasoningEffort) ?? null,
      fastMode: typeof input.fastMode === "boolean" ? input.fastMode : null,
      ...permissionModePreview(permissionMode),
    },
  };
}

/**
 * Build a `lanes create-from-linear` plan: create a lane linked to the issue and,
 * when `--start-chat` is set, chain a chat session + an issue-grounded kickoff
 * message. Steps share results through the executor's `values` map (step.key),
 * so the chat session is created against the lane that step one just made.
 */
function buildCreateLaneFromLinearPlan(args: string[], issue: JsonObject): CliPlan {
  const explicitName = readValue(args, ["--name"]);
  const derivedName =
    asString(issue.title) ??
    asString(issue.identifier) ??
    asString(issue.id) ??
    "Linear lane";
  const createInput: JsonObject = {
    name: explicitName ?? derivedName,
    linearIssue: issue,
  };
  maybePut(createInput, "description", readValue(args, ["--description", "--desc"]));
  maybePut(createInput, "baseBranch", readValue(args, ["--base", "--base-branch"]));
  maybePut(createInput, "branchName", readValue(args, ["--branch-name"]));
  maybePut(createInput, "parentLaneId", readValue(args, ["--parent", "--parent-lane", "--parent-lane-id"]));

  const startChat = readFlag(args, ["--start-chat", "--launch", "--start-agent"]);
  const kickoff =
    readValue(args, ["--prompt", "--kickoff", "--kickoff-prompt"]) ??
    deriveLinearKickoffPrompt(issue);
  // Launch config is read before collectGenericObjectArgs sees the lane-create
  // args so `--provider`/`--model`/`--fast` go to the chat, not the lane.
  const launchConfig = startChat ? readChatLaunchConfig(args) : {};
  const surface = startChat ? readValue(args, ["--surface"]) ?? "work" : null;

  const steps: InvocationStep[] = [
    actionCallStep("lane", "create_lane", collectGenericObjectArgs(args, createInput)),
  ];

  if (startChat) {
    steps.push({
      key: "chat",
      method: "ade/actions/call",
      params: (values) => {
        const laneId = laneIdFromCreateLaneValue(values.lane);
        if (!laneId) {
          throw new CliUsageError("create-from-linear could not resolve the new lane id to launch a chat.");
        }
        return {
          name: "run_ade_action",
          arguments: {
            domain: "chat",
            action: "createSession",
            args: { laneId, surface, ...launchConfig },
          },
        };
      },
      unwrapToolResult: true,
    });
    steps.push({
      key: "attach",
      method: "ade/actions/call",
      params: (values) => {
        const sessionId = sessionIdFromCreateChatValue(values.chat);
        if (!sessionId) {
          throw new CliUsageError("create-from-linear launched a chat but could not resolve its session id to attach the issue.");
        }
        return {
          name: "run_ade_action",
          arguments: {
            domain: LINEAR_ATTACH_ACTIONS.domain,
            action: LINEAR_ATTACH_ACTIONS.attachSession,
            args: { chatSessionId: sessionId, issues: [issue], role: "worked", source: "chat_attach" },
          },
        };
      },
      unwrapToolResult: true,
    });
    steps.push({
      key: "result",
      method: "ade/actions/call",
      params: (values) => {
        const sessionId = sessionIdFromCreateChatValue(values.chat);
        if (!sessionId) {
          throw new CliUsageError("create-from-linear launched a chat but could not resolve its session id.");
        }
        return {
          name: "run_ade_action",
          arguments: {
            domain: "chat",
            action: "sendMessage",
            args: { sessionId, text: kickoff },
          },
        };
      },
      unwrapToolResult: true,
    });
  }

  return {
    kind: "execute",
    label: startChat ? "lane create-from-linear + chat" : "lane create-from-linear",
    steps,
  };
}

/**
 * Build a batch `lanes batch-create-from-linear` plan: one create_lane step per
 * issue. Failures are isolated (`optional: true`) so a bad issue does not orphan
 * the lanes already created for its siblings — mirroring the renderer's
 * bounded-parallel "partial success, no orphans" contract. Each step is keyed by
 * the issue identifier so the JSON output reports per-issue success/failure.
 * `--start-chat` is intentionally rejected here: auto-launching N agents belongs
 * to the desktop BatchLaunchModal; the CLI batch path only creates lanes.
 */
function buildBatchCreateLanesFromLinearPlan(args: string[], issues: JsonObject[]): CliPlan {
  if (readFlag(args, ["--start-chat", "--launch", "--start-agent"])) {
    throw new CliUsageError(
      "batch-create-from-linear creates lanes only. Use the desktop launch modal, or `ade lanes create-from-linear --start-chat` per issue, to auto-launch agents.",
    );
  }
  const baseBranch = readValue(args, ["--base", "--base-branch"]);
  const parentLaneId = readValue(args, ["--parent", "--parent-lane", "--parent-lane-id"]);
  const steps: InvocationStep[] = issues.map((issue, index) => {
    const key =
      asString(issue.identifier) ?? asString(issue.id) ?? `issue-${index + 1}`;
    const createInput: JsonObject = {
      name:
        asString(issue.title) ??
        asString(issue.identifier) ??
        asString(issue.id) ??
        `Linear lane ${index + 1}`,
      linearIssue: issue,
    };
    maybePut(createInput, "baseBranch", baseBranch);
    maybePut(createInput, "parentLaneId", parentLaneId);
    return {
      ...actionCallStep(key, "create_lane", createInput),
      optional: true,
    };
  });
  return {
    kind: "execute",
    label: `lane batch-create-from-linear (${issues.length})`,
    steps,
  };
}

/** Extract a lane id from an unwrapped `create_lane` run_ade_action result. */
function laneIdFromCreateLaneValue(value: unknown): string | null {
  const result = unwrapActionEnvelope(value);
  if (!isRecord(result)) return null;
  const lane = isRecord(result.lane) ? result.lane : result;
  return asString(lane.id) ?? asString(lane.laneId);
}

/** Extract a session id from an unwrapped `chat.createSession` result. */
function sessionIdFromCreateChatValue(value: unknown): string | null {
  const result = unwrapActionEnvelope(value);
  if (!isRecord(result)) return null;
  const session = isRecord(result.session) ? result.session : result;
  return asString(session.id) ?? asString(session.sessionId);
}

function resolveStashSelectionForCli(listResult: unknown, stashRef: string | null, stashOid: string | null): {
  stashRef: string;
  stashOid: string;
} {
  const stashes = firstArray(listResult, ["stashes"]);
  const match = stashRef
    ? stashes.find((stash) => asString(stash.ref) === stashRef)
    : stashOid
      ? stashes.find((stash) => asString(stash.oid) === stashOid)
      : stashes[0];
  const selectedRef = asString(match?.ref);
  const selectedOid = asString(match?.oid);
  if (selectedRef && selectedOid) return { stashRef: selectedRef, stashOid: selectedOid };
  if (!stashRef && !stashOid) {
    throw new CliUsageError("No saved stashes were found for this lane.");
  }
  if (stashOid) {
    throw new CliUsageError(
      `Stash OID ${stashOid} is not saved for this lane. Run ade git stash list --lane <lane>.`,
    );
  }
  throw new CliUsageError(
    `Stash ${stashRef} is not saved for this lane. Run ade git stash list --lane <lane>.`,
  );
}

function buildGitPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "actions") {
    return {
      kind: "execute",
      label: "git actions",
      steps: [listActionsStep("actions", "git")],
    };
  }
  if (sub === "action") {
    return {
      kind: "execute",
      label: "git action",
      steps: [buildActionRunStep(["git", ...args])],
    };
  }

  const laneId = readLaneId(args);
  const withLane = (base: JsonObject = {}) =>
    collectGenericObjectArgs(args, { ...base, ...(laneId ? { laneId } : {}) });

  if (sub === "status" || sub === "sync-status") {
    const full =
      readFlag(args, ["--full"]) || peekFirstPositional(args) === "full";
    if (full && peekFirstPositional(args) === "full") firstPositional(args);
    if (full)
      return {
        kind: "execute",
        label: "lane status",
        steps: [actionCallStep("result", "get_lane_status", withLane())],
      };
    return {
      kind: "execute",
      label: "git status",
      steps: [actionCallStep("result", "git_get_sync_status", withLane())],
    };
  }
  if (sub === "fetch")
    return {
      kind: "execute",
      label: "git fetch",
      steps: [actionCallStep("result", "git_fetch", withLane())],
    };
  if (sub === "pull") {
    const explicitMode = readValue(args, ["--mode"]);
    const flagModes: Array<"ff-only" | "rebase" | "merge"> = [];
    if (readFlag(args, ["--ff-only"])) flagModes.push("ff-only");
    if (readFlag(args, ["--rebase"])) flagModes.push("rebase");
    if (readFlag(args, ["--merge"])) flagModes.push("merge");
    if (flagModes.length > 1) {
      throw new CliUsageError("Choose only one pull mode: --ff-only, --rebase, or --merge.");
    }
    if (explicitMode && flagModes.length > 0) {
      throw new CliUsageError("Choose pull mode with either --mode or a mode flag, not both.");
    }
    const rawMode: string | undefined = flagModes[0] ?? explicitMode;
    const mode = rawMode === "ff_only" ? "ff-only" : rawMode;
    if (mode && mode !== "ff-only" && mode !== "rebase" && mode !== "merge") {
      throw new CliUsageError("--mode must be ff-only, rebase, or merge.");
    }
    return {
      kind: "execute",
      label: "git pull",
      steps: [actionCallStep("result", "git_pull", withLane(mode ? { mode } : {}))],
    };
  }
  if (sub === "undo")
    return {
      kind: "execute",
      label: "git undo",
      steps: [actionCallStep("result", "git_undo_last_head_change", withLane())],
    };
  if (sub === "redo")
    return {
      kind: "execute",
      label: "git redo",
      steps: [actionCallStep("result", "git_redo_last_head_change", withLane())],
    };
  if (sub === "sync") {
    const explicitMode = readValue(args, ["--mode"]);
    const mode = readFlag(args, ["--rebase"])
      ? "rebase"
      : readFlag(args, ["--merge"])
        ? "merge"
        : explicitMode;
    if (mode && mode !== "merge" && mode !== "rebase") {
      throw new CliUsageError("--mode must be either merge or rebase.");
    }
    const baseRef = readValue(args, ["--base", "--base-ref"]);
    return {
      kind: "execute",
      label: "git sync",
      steps: [
        actionStep(
          "result",
          "git",
          "sync",
          withLane({
            ...(mode ? { mode } : {}),
            ...(baseRef ? { baseRef } : {}),
          }),
        ),
      ],
    };
  }
  if (sub === "push") {
    const forceWithLease = readFlag(args, ["--force", "--force-with-lease"]);
    const setUpstream = readFlag(args, ["--set-upstream", "-u"]);
    return {
      kind: "execute",
      label: "git push",
      steps: [
        actionCallStep(
          "result",
          "git_push",
          withLane({ forceWithLease, setUpstream }),
        ),
      ],
    };
  }
  if (sub === "commit") {
    const input: JsonObject = {};
    maybePut(input, "message", readValue(args, ["--message", "-m"]));
    maybePut(input, "amend", readFlag(args, ["--amend"]));
    input.stageAll = !readFlag(args, ["--no-stage-all"]);
    return {
      kind: "execute",
      label: "git commit",
      steps: [actionCallStep("result", "commit_changes", withLane(input))],
    };
  }
  if (sub === "generate-message") {
    return {
      kind: "execute",
      label: "git commit message",
      steps: [
        actionCallStep(
          "result",
          "generate_commit_message",
          withLane({ amend: readFlag(args, ["--amend"]) }),
        ),
      ],
    };
  }
  if (sub === "branches" || sub === "branch")
    return {
      kind: "execute",
      label: "git branches",
      steps: [actionCallStep("result", "git_list_branches", withLane())],
    };
  if (sub === "user-identity" || sub === "user" || sub === "identity") {
    return {
      kind: "execute",
      label: "git user identity",
      steps: [actionCallStep("result", "git_get_user_identity", withLane())],
    };
  }
  if (sub === "checkout") {
    const branchName = requireValue(
      readValue(args, ["--branch", "--branch-name"]) ?? firstPositional(args),
      "branchName",
    );
    const create = readFlag(args, ["--create", "-b"]);
    const startPoint = readValue(args, ["--start-point", "--from"]);
    const baseRef = readValue(args, ["--base", "--base-ref"]);
    const acknowledgeActiveWork = readFlag(args, ["--ack-active-work"]);
    return {
      kind: "execute",
      label: "git checkout",
      steps: [
        actionCallStep(
          "result",
          "git_checkout_branch",
          withLane({
            branchName,
            mode: create ? "create" : "existing",
            ...(startPoint ? { startPoint } : {}),
            ...(baseRef ? { baseRef } : {}),
            acknowledgeActiveWork,
          }),
        ),
      ],
    };
  }
  if (sub === "conflict" || sub === "conflicts") {
    const action = firstPositional(args) ?? "show";
    if (action === "show" || action === "status") {
      return {
        kind: "execute",
        label: "git conflicts",
        steps: [
          actionCallStep("result", "get_lane_conflict_state", withLane()),
        ],
      };
    }
    if (action === "resolve" || action === "continue") {
      const kind =
        readValue(args, ["--kind"]) ??
        (readFlag(args, ["--merge"])
          ? "merge"
          : readFlag(args, ["--rebase"])
            ? "rebase"
            : null);
      if (kind === "rebase")
        return {
          kind: "execute",
          label: "rebase continue",
          steps: [actionCallStep("result", "rebase_continue", withLane())],
        };
      if (kind === "merge")
        return {
          kind: "execute",
          label: "merge continue",
          steps: [actionStep("result", "git", "mergeContinue", withLane())],
        };
      throw new CliUsageError(
        "git conflict resolve requires --kind rebase or --kind merge.",
      );
    }
    if (action === "abort") {
      const kind =
        readValue(args, ["--kind"]) ??
        (readFlag(args, ["--merge"])
          ? "merge"
          : readFlag(args, ["--rebase"])
            ? "rebase"
            : null);
      if (kind === "rebase")
        return {
          kind: "execute",
          label: "rebase abort",
          steps: [actionCallStep("result", "rebase_abort", withLane())],
        };
      if (kind === "merge")
        return {
          kind: "execute",
          label: "merge abort",
          steps: [actionStep("result", "git", "mergeAbort", withLane())],
        };
      throw new CliUsageError(
        "git conflict abort requires --kind rebase or --kind merge.",
      );
    }
    throw new CliUsageError(
      "git conflict supports show, resolve, continue, or abort.",
    );
  }
  if (sub === "rebase") {
    const mode = firstPositional(args);
    if (mode === "continue")
      return {
        kind: "execute",
        label: "rebase continue",
        steps: [actionCallStep("result", "rebase_continue", withLane())],
      };
    if (mode === "abort")
      return {
        kind: "execute",
        label: "rebase abort",
        steps: [actionCallStep("result", "rebase_abort", withLane())],
      };
    return {
      kind: "execute",
      label: "rebase lane",
      steps: [
        actionCallStep(
          "result",
          "rebase_lane",
          withLane({ aiAssisted: readFlag(args, ["--ai", "--ai-assisted"]) }),
        ),
      ],
    };
  }
  if (sub === "merge") {
    const mode = requireValue(firstPositional(args), "merge action");
    if (mode !== "continue" && mode !== "abort")
      throw new CliUsageError("git merge supports continue or abort.");
    return {
      kind: "execute",
      label: `merge ${mode}`,
      steps: [
        actionStep(
          "result",
          "git",
          mode === "continue" ? "mergeContinue" : "mergeAbort",
          withLane(),
        ),
      ],
    };
  }
  if (sub === "stash") {
    const action = firstPositional(args) ?? "list";
    const stashOid = readValue(args, ["--oid", "--stash-oid"]);
    const stashRef = readValue(args, ["--ref", "--stash-ref"]) ?? firstPositional(args);
    const message = readValue(args, ["--message", "-m"]);
    const includeUntracked = !readFlag(args, ["--tracked-only"]);
    const toolNameByAction: Record<string, string> = {
      push: "stash_push",
      save: "stash_push",
      list: "list_stashes",
      ls: "list_stashes",
      apply: "stash_apply",
      pop: "stash_pop",
      drop: "stash_drop",
      clear: "stash_clear",
    };
    const toolName = toolNameByAction[action];
    if (!toolName) throw new CliUsageError(`Unknown stash action '${action}'.`);
    const stashRefTool =
      toolName === "stash_apply" || toolName === "stash_pop" || toolName === "stash_drop";
    const common = withLane({
      ...(stashRef && stashRefTool ? { stashRef } : {}),
      ...(stashOid && stashRefTool ? { stashOid } : {}),
      ...(toolName === "stash_push"
        ? { includeUntracked, ...(message ? { message } : {}) }
        : {}),
    });
    const needsStashSelection = stashRefTool && (
      !stashRef || ((toolName === "stash_pop" || toolName === "stash_drop") && !stashOid)
    );
    if (needsStashSelection) {
      const listArgs: JsonObject = {};
      if (typeof common.laneId === "string") listArgs.laneId = common.laneId;
      return {
        kind: "execute",
        label: `git stash ${action}`,
        steps: [
          actionCallStep("stashes", "list_stashes", listArgs),
          {
            key: "result",
            method: "ade/actions/call",
            params: (values) => {
              const selection = resolveStashSelectionForCli(values.stashes, stashRef, stashOid);
              return {
                name: toolName,
                arguments: {
                  ...common,
                  stashRef: selection.stashRef,
                  stashOid: selection.stashOid,
                },
              };
            },
            unwrapToolResult: true,
          },
        ],
      };
    }
    return {
      kind: "execute",
      label: `git stash ${action}`,
      steps: [actionCallStep("result", toolName, common)],
    };
  }
  if (sub === "diff") {
    return buildDiffPlan([...(laneId ? ["--lane", laneId] : []), ...args]);
  }

  if (
    sub === "stage" ||
    sub === "unstage" ||
    sub === "discard" ||
    sub === "restore"
  ) {
    const pathArg = requireValue(
      readValue(args, ["--path"]) ?? firstPositional(args),
      "path",
    );
    const actionBySub: Record<string, string> = {
      stage: "stageFile",
      unstage: "unstageFile",
      discard: "discardFile",
      restore: "restoreStagedFile",
    };
    return {
      kind: "execute",
      label: `git ${sub}`,
      steps: [
        actionStep(
          "result",
          "git",
          actionBySub[sub]!,
          withLane({ path: pathArg }),
        ),
      ],
    };
  }
  if (sub === "stage-all" || sub === "unstage-all") {
    const paths = args.filter((entry) => !entry.startsWith("-"));
    const action = sub === "stage-all" ? "stageAll" : "unstageAll";
    return {
      kind: "execute",
      label: `git ${sub}`,
      steps: [actionStep("result", "git", action, withLane({ paths }))],
    };
  }
  if (sub === "files" || sub === "commit-files") {
    const commitSha = requireValue(
      readValue(args, ["--commit", "--sha"]) ?? firstPositional(args),
      "commitSha",
    );
    return {
      kind: "execute",
      label: "git commit files",
      steps: [
        actionStep("result", "git", "listCommitFiles", withLane({ commitSha })),
      ],
    };
  }
  if (sub === "message" || sub === "commit-message" || sub === "show-message") {
    const commitSha =
      readValue(args, ["--commit", "--sha"]) ?? firstPositional(args);
    if (commitSha)
      return {
        kind: "execute",
        label: "git commit message",
        steps: [
          actionStep(
            "result",
            "git",
            "getCommitMessage",
            withLane({ commitSha }),
          ),
        ],
      };
    return {
      kind: "execute",
      label: "git commit message",
      steps: [
        actionCallStep(
          "result",
          "generate_commit_message",
          withLane({ amend: readFlag(args, ["--amend"]) }),
        ),
      ],
    };
  }
  if (sub === "history" || sub === "file-history") {
    const filePath = requireValue(
      readValue(args, ["--path"]) ?? firstPositional(args),
      "path",
    );
    return {
      kind: "execute",
      label: "git file history",
      steps: [
        actionStep(
          "result",
          "git",
          "getFileHistory",
          withLane({ path: filePath, limit: readIntOption(args, ["--limit"]) }),
        ),
      ],
    };
  }
  if (sub === "revert" || sub === "cherry-pick") {
    const commitSha = requireValue(
      readValue(args, ["--commit", "--sha"]) ?? firstPositional(args),
      "commitSha",
    );
    return {
      kind: "execute",
      label: `git ${sub}`,
      steps: [
        actionStep(
          "result",
          "git",
          sub === "revert" ? "revertCommit" : "cherryPickCommit",
          withLane({ commitSha }),
        ),
      ],
    };
  }
  if (sub === "tag" || sub === "create-tag") {
    const commitSha = requireValue(
      readValue(args, ["--commit", "--sha"]) ?? firstPositional(args),
      "commitSha",
    );
    const tagName = requireValue(
      readValue(args, ["--name", "--tag", "--tag-name"]) ?? firstPositional(args),
      "tagName",
    );
    const message = readValue(args, ["--message", "-m"]);
    return {
      kind: "execute",
      label: "git tag",
      steps: [
        actionStep(
          "result",
          "git",
          "createTag",
          withLane({ commitSha, tagName, ...(message ? { message } : {}) }),
        ),
      ],
    };
  }
  if (sub === "reset" || sub === "reset-to-commit") {
    const commitSha = requireValue(
      readValue(args, ["--commit", "--sha"]) ?? firstPositional(args),
      "commitSha",
    );
    const mode =
      readValue(args, ["--mode"]) ??
      (readFlag(args, ["--soft"]) ? "soft" : readFlag(args, ["--hard"]) ? "hard" : "mixed");
    if (mode !== "soft" && mode !== "mixed" && mode !== "hard") {
      throw new CliUsageError("git reset --mode must be soft, mixed, or hard.");
    }
    return {
      kind: "execute",
      label: "git reset",
      steps: [
        actionStep(
          "result",
          "git",
          "resetToCommit",
          withLane({ commitSha, mode }),
        ),
      ],
    };
  }
  if (sub === "is-reachable" || sub === "is-commit-reachable" || sub === "commit-reachable") {
    const commitSha = requireValue(
      readValue(args, ["--commit", "--sha"]) ?? firstPositional(args),
      "commitSha",
    );
    return {
      kind: "execute",
      label: "git is-reachable",
      steps: [
        actionStep(
          "result",
          "git",
          "isCommitInLaneHistory",
          withLane({ commitSha }),
        ),
      ],
    };
  }
  const actionAliases: Record<string, string> = {
    commits: "listRecentCommits",
    sync: "sync",
  };
  return {
    kind: "execute",
    label: `git ${sub}`,
    steps: [actionStep("result", "git", actionAliases[sub] ?? sub, withLane())],
  };
}

function buildDiffPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "changes";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "diff actions",
      steps: [listActionsStep("actions", "diff")],
    };
  const laneId = readLaneId(args);
  const withLane = (base: JsonObject = {}) =>
    collectGenericObjectArgs(args, { ...base, ...(laneId ? { laneId } : {}) });
  if (sub === "changes" || sub === "summary") {
    const id = requireValue(
      laneId ?? readValue(args, ["--lane", "--lane-id"]),
      "laneId",
    );
    return {
      kind: "execute",
      label: "diff changes",
      steps: [actionArgsListStep("result", "diff", "getChanges", [id])],
    };
  }
  if (sub === "file") {
    const filePath = requireValue(
      readValue(args, ["--path"]) ?? firstPositional(args),
      "path",
    );
    return {
      kind: "execute",
      label: "diff file",
      steps: [
        actionStep(
          "result",
          "diff",
          "getFileDiff",
          withLane({
            filePath,
            mode: readValue(args, ["--mode"]) ?? "unstaged",
            compareRef: readValue(args, ["--compare-ref", "--base"]),
            compareTo: readValue(args, ["--compare-to", "--head"]),
          }),
        ),
      ],
    };
  }
  if (sub === "patch") {
    const filePath = requireValue(
      readValue(args, ["--path"]) ?? firstPositional(args),
      "path",
    );
    return {
      kind: "execute",
      label: "diff patch",
      steps: [
        actionStep(
          "result",
          "diff",
          "getFilePatch",
          withLane({
            filePath,
            mode: readValue(args, ["--mode"]) ?? "unstaged",
            compareRef: readValue(args, ["--compare-ref", "--base"]),
            compareTo: readValue(args, ["--compare-to", "--head"]),
          }),
        ),
      ],
    };
  }
  return {
    kind: "execute",
    label: `diff ${sub}`,
    steps: [actionStep("result", "diff", sub, withLane())],
  };
}

function buildPrPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "PR actions",
      steps: [listActionsStep("actions", "pr")],
    };
  if (sub === "action")
    return {
      kind: "execute",
      label: "PR action",
      steps: [buildActionRunStep(["pr", ...args])],
    };

  const prId = readPrId(args);
  const withPr = (base: JsonObject = {}) =>
    collectGenericObjectArgs(args, { ...base, ...(prId ? { prId } : {}) });

  if (sub === "list" || sub === "ls")
    return {
      kind: "execute",
      label: "PR list",
      steps: [
        actionStep("result", "pr", "listAll", collectGenericObjectArgs(args)),
      ],
    };
  if (sub === "list-open" || sub === "open" || sub === "list-repo-open") {
    return {
      kind: "execute",
      label: "PR list open",
      steps: [actionCallStep("result", "prs_list_open", {})],
    };
  }
  if (sub === "show" || sub === "detail" || sub === "view") {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return {
      kind: "execute",
      label: "PR detail",
      steps: [actionArgsListStep("result", "pr", "getDetail", [id])],
    };
  }
  if (sub === "refresh")
    return {
      kind: "execute",
      label: "PR refresh",
      steps: [
        actionStep(
          "result",
          "pr",
          "refresh",
          withPr({ prId: prId ?? firstPositional(args) }),
        ),
      ],
    };
  if (sub === "create") {
    const laneId = readLaneId(args) ?? readValue(args, ["--lane-id"]);
    const input: JsonObject = {};
    input.laneId = requireValue(laneId, "laneId");
    maybePut(input, "baseBranch", readValue(args, ["--base", "--base-branch"]));
    maybePut(input, "title", readValue(args, ["--title"]));
    maybePut(input, "body", readValue(args, ["--body"]));
    input.draft = readFlag(args, ["--draft"]);
    input.closeLinearIssueOnMerge = readFlag(args, [
      "--close-linear-issue-on-merge",
      "--close-linear",
      "--fixes-linear-issue",
    ]);
    return {
      kind: "execute",
      label: "PR create",
      steps: [
        actionCallStep(
          "result",
          "create_pr_from_lane",
          collectGenericObjectArgs(args, input),
        ),
      ],
    };
  }
  if (sub === "health")
    return {
      kind: "execute",
      label: "PR health",
      steps: [
        actionCallStep(
          "result",
          "get_pr_health",
          withPr({ prId: prId ?? firstPositional(args) }),
        ),
      ],
    };
  if (sub === "checks")
    return {
      kind: "execute",
      label: "PR checks",
      steps: [
        actionCallStep(
          "result",
          "pr_get_checks",
          withPr({ prId: requireValue(prId ?? firstPositional(args), "prId") }),
        ),
      ],
    };
  if (sub === "comments" || sub === "review-comments")
    return {
      kind: "execute",
      label: "PR comments",
      steps: [
        actionCallStep(
          "result",
          "pr_get_review_comments",
          withPr({ prId: requireValue(prId ?? firstPositional(args), "prId") }),
        ),
      ],
    };
  if (sub === "rerun" || sub === "rerun-failed-checks")
    return {
      kind: "execute",
      label: "PR rerun failed checks",
      steps: [
        actionCallStep(
          "result",
          "pr_rerun_failed_checks",
          withPr({ prId: prId ?? firstPositional(args) }),
        ),
      ],
    };
  if (sub === "comment")
    return {
      kind: "execute",
      label: "PR comment",
      steps: [
        actionCallStep(
          "result",
          "pr_add_comment",
          withPr({
            prId: prId ?? firstPositional(args),
            body: readValue(args, ["--body"]),
          }),
        ),
      ],
    };
  if (sub === "reply")
    return {
      kind: "execute",
      label: "PR thread reply",
      steps: [
        actionCallStep(
          "result",
          "pr_reply_to_review_thread",
          withPr({
            prId: prId ?? firstPositional(args),
            threadId: readValue(args, ["--thread", "--thread-id"]),
            body: readValue(args, ["--body"]),
          }),
        ),
      ],
    };
  if (sub === "resolve-thread")
    return {
      kind: "execute",
      label: "PR resolve thread",
      steps: [
        actionCallStep(
          "result",
          "pr_resolve_review_thread",
          withPr({
            prId: requireValue(prId ?? firstPositional(args), "prId"),
            threadId: requireValue(
              readValue(args, ["--thread", "--thread-id"]),
              "threadId",
            ),
          }),
        ),
      ],
    };
  if (sub === "title" || sub === "update-title")
    return {
      kind: "execute",
      label: "PR update title",
      steps: [
        actionCallStep(
          "result",
          "pr_update_title",
          withPr({
            prId: prId ?? firstPositional(args),
            title: readValue(args, ["--title"]),
          }),
        ),
      ],
    };
  if (sub === "body" || sub === "update-body")
    return {
      kind: "execute",
      label: "PR update body",
      steps: [
        actionCallStep(
          "result",
          "pr_update_body",
          withPr({
            prId: prId ?? firstPositional(args),
            body: readValue(args, ["--body"]) ?? "",
          }),
        ),
      ],
    };
  if (sub === "link") {
    const laneId = readLaneId(args) ?? firstPositional(args);
    const prUrlOrNumber =
      readValue(args, ["--url", "--pr-url", "--number", "--pr-number"]) ??
      firstPositional(args);
    return {
      kind: "execute",
      label: "PR link",
      steps: [
        actionStep(
          "result",
          "pr",
          "linkToLane",
          collectGenericObjectArgs(args, {
            laneId: requireValue(laneId, "laneId"),
            prUrlOrNumber: requireValue(prUrlOrNumber, "prUrlOrNumber"),
          }),
        ),
      ],
    };
  }

  const scalarPrActions: Record<string, string> = {
    status: "getStatus",
    files: "getFiles",
    "action-runs": "getActionRuns",
    reviews: "getReviews",
    threads: "getReviewThreads",
    deployments: "getDeployments",
    github: "openInGitHub",
    "conflict-analysis": "getConflictAnalysis",
    "merge-context": "getMergeContext",
  };
  if (scalarPrActions[sub]) {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return {
      kind: "execute",
      label: `PR ${sub}`,
      steps: [actionArgsListStep("result", "pr", scalarPrActions[sub]!, [id])],
    };
  }
  if (sub === "draft-description")
    return {
      kind: "execute",
      label: "PR draft description",
      steps: [
        actionStep(
          "result",
          "pr",
          "draftDescription",
          collectGenericObjectArgs(args, {
            laneId: readLaneId(args) ?? firstPositional(args),
          }),
        ),
      ],
    };
  if (sub === "update-description")
    return {
      kind: "execute",
      label: "PR update description",
      steps: [
        actionStep(
          "result",
          "pr",
          "updateDescription",
          withPr({
            prId: prId ?? firstPositional(args),
            title: readValue(args, ["--title"]),
            body: readValue(args, ["--body"]),
          }),
        ),
      ],
    };
  if (
    sub === "delete" ||
    sub === "land" ||
    sub === "close" ||
    sub === "reopen"
  ) {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    const actionBySub: Record<string, string> = {
      delete: "delete",
      land: "land",
      close: "closePr",
      reopen: "reopenPr",
    };
    return {
      kind: "execute",
      label: `PR ${sub}`,
      steps: [
        actionStep(
          "result",
          "pr",
          actionBySub[sub]!,
          collectGenericObjectArgs(args, {
            prId: id,
            method: readValue(args, ["--method"]),
          }),
        ),
      ],
    };
  }
  if (sub === "land-stack" || sub === "land-stack-enhanced") {
    return {
      kind: "execute",
      label: `PR ${sub}`,
      steps: [
        actionStep(
          "result",
          "pr",
          sub === "land-stack" ? "landStack" : "landStackEnhanced",
          collectGenericObjectArgs(args, {
            rootLaneId:
              readValue(args, ["--root", "--root-lane"]) ??
              firstPositional(args),
          }),
        ),
      ],
    };
  }
  if (sub === "labels") {
    const mode = firstPositional(args) ?? "set";
    if (mode !== "set") throw new CliUsageError("prs labels supports set.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return {
      kind: "execute",
      label: "PR labels set",
      steps: [
        actionStep(
          "result",
          "pr",
          "setLabels",
          collectGenericObjectArgs(args, {
            prId: id,
            labels: args.filter((entry) => !entry.startsWith("-")),
          }),
        ),
      ],
    };
  }
  if (sub === "reviewers") {
    const mode = firstPositional(args) ?? "request";
    if (mode !== "request")
      throw new CliUsageError("prs reviewers supports request.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    const reviewerRequest = parseReviewerRequestValues(args);
    return {
      kind: "execute",
      label: "PR reviewers request",
      steps: [
        actionStep(
          "result",
          "pr",
          "requestReviewers",
          collectGenericObjectArgs(args, {
            prId: id,
            reviewers: reviewerRequest.reviewers,
            teamReviewers: reviewerRequest.teamReviewers,
          }),
        ),
      ],
    };
  }
  if (sub === "review") {
    const mode = firstPositional(args) ?? "submit";
    if (mode !== "submit")
      throw new CliUsageError("prs review supports submit.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return {
      kind: "execute",
      label: "PR review submit",
      steps: [
        actionStep(
          "result",
          "pr",
          "submitReview",
          collectGenericObjectArgs(args, {
            prId: id,
            event: readValue(args, ["--event"]) ?? "comment",
            body: readValue(args, ["--body"]) ?? "",
          }),
        ),
      ],
    };
  }
  if (sub === "comment-react") {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return {
      kind: "execute",
      label: "PR comment react",
      steps: [
        actionStep(
          "result",
          "pr",
          "reactToComment",
          collectGenericObjectArgs(args, {
            prId: id,
            commentId: readValue(args, ["--comment", "--comment-id"]),
            content: readValue(args, ["--content"]),
          }),
        ),
      ],
    };
  }
  if (sub === "review-comment") {
    const mode = firstPositional(args) ?? "post";
    if (mode !== "post")
      throw new CliUsageError("prs review-comment supports post.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return {
      kind: "execute",
      label: "PR review comment post",
      steps: [
        actionStep(
          "result",
          "pr",
          "postReviewComment",
          collectGenericObjectArgs(args, {
            prId: id,
            threadId: readValue(args, ["--thread", "--thread-id"]),
            body: readValue(args, ["--body"]),
          }),
        ),
      ],
    };
  }
  if (sub === "thread") {
    const mode = firstPositional(args) ?? "set-resolved";
    if (mode !== "set-resolved")
      throw new CliUsageError("prs thread supports set-resolved.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return {
      kind: "execute",
      label: "PR thread set resolved",
      steps: [
        actionStep(
          "result",
          "pr",
          "setReviewThreadResolved",
          collectGenericObjectArgs(args, {
            prId: id,
            threadId: readValue(args, ["--thread", "--thread-id"]),
            resolved: !readFlag(args, ["--unresolved"]),
          }),
        ),
      ],
    };
  }
  if (sub === "ai-review-summary")
    return {
      kind: "execute",
      label: "PR AI review summary",
      steps: [
        actionStep(
          "result",
          "pr",
          "aiReviewSummary",
          withPr({ prId: prId ?? firstPositional(args) }),
        ),
      ],
    };
  if (sub === "mobile-snapshot")
    return {
      kind: "execute",
      label: "PR mobile snapshot",
      steps: [actionArgsListStep("result", "pr", "getMobileSnapshot", [])],
    };
  if (sub === "github-snapshot") {
    const snapshotArgs: JsonObject = {
      force: readFlag(args, ["--force"]),
    };
    if (readFlag(args, ["--include-external-closed", "--include-closed-external"])) {
      snapshotArgs.includeExternalClosed = true;
    }
    return {
      kind: "execute",
      label: "PR GitHub snapshot",
      steps: [
        actionStep(
          "result",
          "pr",
          "getGithubSnapshot",
          collectGenericObjectArgs(args, snapshotArgs),
        ),
      ],
    };
  }
  if (sub === "conflicts") {
    const mode = firstPositional(args) ?? "list";
    if (mode === "list")
      return {
        kind: "execute",
        label: "PR conflicts list",
        steps: [actionArgsListStep("result", "pr", "listWithConflicts", [])],
      };
    const id = requireValue(prId ?? firstPositional(args), "prId");
    const action =
      mode === "analysis" ? "getConflictAnalysis" : "getMergeContext";
    return {
      kind: "execute",
      label: `PR conflicts ${mode}`,
      steps: [actionArgsListStep("result", "pr", action, [id])],
    };
  }

  if (sub === "queue") {
    const mode = firstPositional(args) ?? "create";
    if (mode === "state" || mode === "list") {
      const groupId = requireValue(
        readValue(args, ["--group", "--group-id"]) ?? firstPositional(args),
        "groupId",
      );
      return {
        kind: "execute",
        label: `queue ${mode}`,
        steps: [
          actionArgsListStep(
            "result",
            "pr",
            mode === "state" ? "getQueueState" : "listGroupPrs",
            [groupId],
          ),
        ],
      };
    }
    if (mode === "reorder") {
      return {
        kind: "execute",
        label: "queue reorder",
        steps: [
          actionStep(
            "result",
            "pr",
            "reorderQueuePrs",
            collectGenericObjectArgs(args, {
              groupId:
                readValue(args, ["--group", "--group-id"]) ??
                firstPositional(args),
            }),
          ),
        ],
      };
    }
    if (mode === "land-next") {
      return {
        kind: "execute",
        label: "queue land next",
        steps: [
          actionCallStep(
            "result",
            "land_queue_next",
            collectGenericObjectArgs(args, {
              groupId:
                readValue(args, ["--group", "--group-id"]) ??
                firstPositional(args),
              method: readValue(args, ["--method"]) ?? "squash",
            }),
          ),
        ],
      };
    }
    return {
      kind: "execute",
      label: "queue create",
      steps: [
        actionCallStep(
          "result",
          "create_queue",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }

  if (sub === "integration") {
    const mode = firstPositional(args) ?? "simulate";
    const integrationMap: Record<string, string> = {
      proposals: "listIntegrationProposals",
      workflows: "listIntegrationWorkflows",
      update: "updateIntegrationProposal",
      delete: "deleteIntegrationProposal",
      commit: "commitIntegration",
      "resolve-start": "startIntegrationResolution",
      "resolve-state": "getIntegrationResolutionState",
      "recheck-step": "recheckIntegrationStep",
    };
    if (integrationMap[mode]) {
      return {
        kind: "execute",
        label: `integration ${mode}`,
        steps: [
          actionStep(
            "result",
            "pr",
            integrationMap[mode]!,
            collectGenericObjectArgs(args),
          ),
        ],
      };
    }
    if (mode === "lane") {
      const laneMode = firstPositional(args) ?? "create";
      if (laneMode !== "create")
        throw new CliUsageError("prs integration lane supports create.");
      return {
        kind: "execute",
        label: "integration lane create",
        steps: [
          actionStep(
            "result",
            "pr",
            "createIntegrationLane",
            collectGenericObjectArgs(args),
          ),
        ],
      };
    }
    if (mode === "cleanup") {
      const cleanupMode = firstPositional(args) ?? "run";
      return {
        kind: "execute",
        label: `integration cleanup ${cleanupMode}`,
        steps: [
          actionStep(
            "result",
            "pr",
            cleanupMode === "dismiss"
              ? "dismissIntegrationCleanup"
              : "cleanupIntegrationWorkflow",
            collectGenericObjectArgs(args),
          ),
        ],
      };
    }
    const tool =
      mode === "create" ? "create_integration" : "simulate_integration";
    return {
      kind: "execute",
      label: `integration ${mode}`,
      steps: [actionCallStep("result", tool, collectGenericObjectArgs(args))],
    };
  }

  return {
    kind: "execute",
    label: `PR ${sub}`,
    steps: [actionStep("result", "pr", sub, withPr())],
  };
}

function buildRunPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "ps";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "run actions",
      steps: [listActionsStep("actions", "process")],
    };
  if (sub === "action")
    return {
      kind: "execute",
      label: "run action",
      steps: [buildActionRunStep(["process", ...args])],
    };
  if (sub === "defs" || sub === "definitions")
    return {
      kind: "execute",
      label: "process definitions",
      steps: [
        actionStep(
          "result",
          "process",
          "listDefinitions",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  const laneId = readLaneId(args);
  const processId =
    readValue(args, ["--process", "--process-id"]) ?? firstPositional(args);
  const runId = readValue(args, ["--run", "--run-id"]);
  const withProcess = (base: JsonObject = {}) =>
    collectGenericObjectArgs(args, {
      ...base,
      ...(laneId ? { laneId } : {}),
      ...(processId ? { processId } : {}),
      ...(runId ? { runId } : {}),
    });
  if (sub === "ps" || sub === "list" || sub === "runtime") {
    const id = requireValue(laneId, "laneId");
    return {
      kind: "execute",
      label: "process runtime",
      steps: [actionArgsListStep("result", "process", "listRuntime", [id])],
    };
  }
  if (
    sub === "start" ||
    sub === "stop" ||
    sub === "restart" ||
    sub === "kill"
  ) {
    return {
      kind: "execute",
      label: `process ${sub}`,
      steps: [
        actionStep(
          "result",
          "process",
          sub,
          withProcess({
            laneId: requireValue(laneId, "laneId"),
            processId: requireValue(processId, "processId"),
          }),
        ),
      ],
    };
  }
  if (sub === "logs" || sub === "log") {
    return {
      kind: "execute",
      label: "process logs",
      steps: [
        actionStep(
          "result",
          "process",
          "getLogTail",
          withProcess({
            laneId: requireValue(laneId, "laneId"),
            processId: requireValue(processId, "processId"),
            maxBytes: readIntOption(
              args,
              ["--max-bytes", "--tail-bytes"],
              80_000,
            ),
          }),
        ),
      ],
    };
  }
  if (sub === "stack") {
    const mode = requireValue(firstPositional(args), "stack action");
    const stackId = requireValue(
      readValue(args, ["--stack", "--stack-id"]) ?? firstPositional(args),
      "stackId",
    );
    const methodByMode: Record<string, string> = {
      start: "startStack",
      stop: "stopStack",
      restart: "restartStack",
    };
    const method = methodByMode[mode];
    if (!method)
      throw new CliUsageError("run stack supports start, stop, or restart.");
    return {
      kind: "execute",
      label: `stack ${mode}`,
      steps: [
        actionStep(
          "result",
          "process",
          method,
          collectGenericObjectArgs(args, {
            laneId: requireValue(laneId, "laneId"),
            stackId,
          }),
        ),
      ],
    };
  }
  if (sub === "start-all" || sub === "stop-all")
    return {
      kind: "execute",
      label: `process ${sub}`,
      steps: [
        actionStep(
          "result",
          "process",
          sub === "start-all" ? "startAll" : "stopAll",
          collectGenericObjectArgs(args, { ...(laneId ? { laneId } : {}) }),
        ),
      ],
    };
  return {
    kind: "execute",
    label: `process ${sub}`,
    steps: [actionStep("result", "process", sub, withProcess())],
  };
}

function buildShellPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "start";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "shell actions",
      steps: [listActionsStep("actions", "pty")],
    };
  if (sub === "start-cli" || sub === "cli" || sub === "agent-cli") {
    return buildCliSessionStartPlan(args);
  }
  if (sub === "start" || sub === "create") {
    const provider = readValue(args, ["--provider", "--profile"]);
    if (provider) {
      return buildCliSessionStartPlan(args, provider);
    }
    const laneId = readLaneId(args);
    const chatSessionId = asString(
      readValue(args, [
        "--chat-session",
        "--chat-session-id",
        "--session",
        "--session-id",
      ]) ?? process.env.ADE_CHAT_SESSION_ID,
    );
    const startupCommandArgs = takeArgsAfterTerminator(args);
    const startupCommand = startupCommandArgs
      ? startupCommandArgs.map(shellEscapeToken).join(" ")
      : readValue(args, ["--command", "-c"]);
    const input = collectGenericObjectArgs(args, {
      ...(laneId ? { laneId } : {}),
      ...(chatSessionId ? { chatSessionId } : {}),
      cwd: readValue(args, ["--cwd"]),
      title: readValue(args, ["--title"]),
      startupCommand,
      toolType: readValue(args, ["--tool-type"]) ?? "shell",
      cols: readIntOption(args, ["--cols"], 120),
      rows: readIntOption(args, ["--rows"], 36),
      tracked: !readFlag(args, ["--untracked"]),
    });
    return {
      kind: "execute",
      label: "shell start",
      formatter: "pty-create",
      steps: [actionStep("result", "pty", "create", input)],
    };
  }
  if (sub === "write")
    return {
      kind: "execute",
      label: "shell write",
      steps: [
        actionStep(
          "result",
          "pty",
          "write",
          collectGenericObjectArgs(args, {
            ptyId: requireValue(
              readValue(args, ["--pty", "--pty-id"]) ?? firstPositional(args),
              "ptyId",
            ),
            data: readValue(args, ["--data"]) ?? "",
          }),
        ),
      ],
    };
  if (sub === "resize")
    return {
      kind: "execute",
      label: "shell resize",
      steps: [
        actionStep(
          "result",
          "pty",
          "resize",
          collectGenericObjectArgs(args, {
            ptyId: requireValue(
              readValue(args, ["--pty", "--pty-id"]) ?? firstPositional(args),
              "ptyId",
            ),
            cols: readIntOption(args, ["--cols"], 120),
            rows: readIntOption(args, ["--rows"], 36),
          }),
        ),
      ],
    };
  if (sub === "close" || sub === "dispose")
    return {
      kind: "execute",
      label: "shell close",
      steps: [
        actionStep(
          "result",
          "pty",
          "dispose",
          collectGenericObjectArgs(args, {
            ptyId: requireValue(
              readValue(args, ["--pty", "--pty-id"]) ?? firstPositional(args),
              "ptyId",
            ),
            sessionId: readValue(args, ["--session", "--session-id"]),
          }),
        ),
      ],
    };
  return {
    kind: "execute",
    label: `shell ${sub}`,
    steps: [actionStep("result", "pty", sub, collectGenericObjectArgs(args))],
  };
}

function buildCliSessionStartPlan(
  args: string[],
  providerArg?: string,
): CliPlan {
  const laneId = requireValue(readLaneId(args), "laneId");
  const rawProvider = requireValue(
    providerArg ??
      readValue(args, ["--provider", "--profile"]) ??
      firstStandalonePositional(args),
    "provider",
  );
  if (!isLaunchProfile(rawProvider)) {
    throw new CliUsageError(
      "provider must be one of claude, codex, cursor, droid, opencode, or shell.",
    );
  }
  const provider: LaunchProfile = rawProvider;
  const promptArgs = takeArgsAfterTerminator(args);
  const initialInput = promptArgs
    ? promptArgs.join(" ").trim()
    : readValue(args, ["--message", "--prompt", "--initial-input"]);
  const permissionMode =
    readValue(args, ["--permission-mode", "--permissions"]) ?? "default";
  if (!isTrackedCliPermissionMode(permissionMode)) {
    throw new CliUsageError(
      "permissionMode must be one of default, auto, plan, edit, full-auto, or config-toml.",
    );
  }
  validateLaunchProfilePermissionMode(provider, permissionMode);

  const input = collectGenericObjectArgs(args, {
    laneId,
    provider,
    permissionMode,
    title:
      readValue(args, ["--title"]) ??
      LAUNCH_PROFILE_TITLE[provider] ??
      undefined,
    initialInput,
    model: readValue(args, ["--model"]),
    modelId: readValue(args, ["--model-id"]),
    reasoningEffort: readValue(args, ["--reasoning", "--reasoning-effort"]),
    fastMode: readFastModeFlag(args),
    cols: readIntOption(args, ["--cols"], 120),
    rows: readIntOption(args, ["--rows"], 36),
    cwd: readValue(args, ["--cwd"]),
    chatSessionId: readValue(args, ["--chat-session", "--chat-session-id"]),
    tracked: !readFlag(args, ["--untracked"]),
  });

  return {
    kind: "execute",
    label: "shell start cli",
    steps: [actionCallStep("result", "start_cli_session", input)],
  };
}

function collectHistoryListArgs(
  args: string[],
  filters: { laneId?: string | null; kind?: string | null; status?: string | null } = {},
): JsonObject {
  return collectGenericObjectArgs(args, {
    ...(filters.laneId ? { laneId: filters.laneId } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.status && filters.status !== "all" ? { status: filters.status } : {}),
    limit: readIntOption(args, ["--limit"], 50),
  });
}

function buildHistoryPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "history actions",
      steps: [listActionsStep("actions", "operation")],
    };
  const laneId = readLaneId(args);
  const kind = readValue(args, ["--kind"]);
  const statusFilter = readValue(args, ["--status"]) ?? undefined;
  const historyListFilters = {
    laneId: laneId ?? null,
    kind: kind ?? null,
    status: statusFilter ?? "all",
  };
  const historyMeta = {
    historyListFilters,
    ...(statusFilter ? { historyStatusFilter: statusFilter } : {}),
  };
  const listFilters = { laneId, kind, status: statusFilter };
  if (sub === "list" || sub === "ls")
    return {
      kind: "execute",
      label: "history list",
      formatter: "history-list",
      steps: [
        actionStep(
          "result",
          "operation",
          "list",
          collectHistoryListArgs(args, listFilters),
        ),
      ],
      ...historyMeta,
    };
  if (sub === "show" || sub === "get" || sub === "view") {
    const operationId = requireValue(
      readValue(args, ["--id", "--operation", "--operation-id"]) ??
        firstPositional(args),
      "id",
    );
    return {
      kind: "execute",
      label: "history show",
      formatter: "history-show",
      historyOperationId: operationId,
      steps: [
        actionStep("result", "operation", "get", {
          operationId,
        }),
      ],
    };
  }
  if (sub === "commits" || sub === "log") {
    const commitsLaneId = requireValue(laneId, "laneId");
    return {
      kind: "execute",
      label: "history commits",
      formatter: "history-commits",
      steps: [
        actionStep(
          "result",
          "git",
          "listRecentCommits",
          collectGenericObjectArgs(args, {
            laneId: commitsLaneId,
            limit: readIntOption(args, ["--limit"], 50),
          }),
        ),
      ],
    };
  }
  if (sub === "export") {
    const outPath = readValue(args, ["--out", "--output"]);
    const exportLimit = Math.max(
      1,
      Math.min(1000, readIntOption(args, ["--limit"], 1000) ?? 1000),
    );
    const listArgs = collectHistoryListArgs(args, listFilters);
    listArgs.limit = exportLimit;
    return {
      kind: "execute",
      label: "history export",
      steps: [actionStep("result", "operation", "list", listArgs)],
      ...(outPath ? { writeResultPath: outPath } : {}),
      ...historyMeta,
    };
  }
  throw new CliUsageError(
    "history supports list, show, commits, export, or actions.",
  );
}

const SEARCH_KIND_VALUES = SEARCH_DOC_KINDS;

function searchResultCount(result: unknown): number {
  if (!isRecord(result)) return 0;
  const results = result.results;
  return Array.isArray(results) ? results.length : 0;
}

function buildSearchPlan(args: string[]): CliPlan {
  if (readFlag(args, ["--actions"])) {
    return {
      kind: "execute",
      label: "search actions",
      steps: [listActionsStep("actions", "search")],
    };
  }
  if (readFlag(args, ["--status", "--index-status"])) {
    return {
      kind: "execute",
      label: "search status",
      formatter: "search-status",
      steps: [actionStep("result", "search", "indexStatus", {})],
    };
  }
  if (readFlag(args, ["--rebuild", "--rebuild-index"])) {
    return {
      kind: "execute",
      label: "search rebuild",
      formatter: "search-status",
      steps: [actionStep("result", "search", "rebuildIndex", {})],
    };
  }

  // Consume option flags before grabbing the positional query so a flag value
  // (e.g. the argument to --lane) can never be mistaken for the query itself.
  const limit = readIntOption(args, ["--limit"], undefined);
  const cursor = readValue(args, ["--cursor"]);
  const laneId = readValue(args, ["--lane", "--lane-id"]);
  const kindRaw = readValue(args, ["--kind", "--kinds"]);
  let kinds: string[] | undefined;
  if (kindRaw != null) {
    kinds = kindRaw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const invalid = kinds.filter(
      (entry) => !(SEARCH_KIND_VALUES as readonly string[]).includes(entry),
    );
    if (invalid.length) {
      throw new CliUsageError(
        `Unknown search kind(s): ${invalid.join(", ")}. Valid kinds: ${SEARCH_KIND_VALUES.join(", ")}.`,
      );
    }
  }

  const query = firstPositional(args) ?? readValue(args, ["--query", "-q"]);
  if (!query || !query.trim()) {
    throw new CliUsageError(
      'search requires a query, e.g. ade search "login redirect" --text (or --status / --rebuild).',
    );
  }

  const queryArgs: JsonObject = { query };
  if (kinds && kinds.length) queryArgs.kinds = kinds;
  if (laneId) queryArgs.laneId = laneId;
  if (limit != null) queryArgs.limit = limit;
  if (cursor) queryArgs.cursor = cursor;

  return {
    kind: "execute",
    label: "search query",
    formatter: "search-results",
    steps: [actionStep("result", "search", "query", queryArgs)],
    // Script-friendly: a query that matches nothing exits nonzero so callers
    // can branch on `ade search ... && ...` without parsing the payload.
    exitCodeFromResult: (result) => (searchResultCount(result) > 0 ? 0 : 1),
  };
}

function buildTerminalPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "active";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "terminal actions",
      steps: [listActionsStep("actions", "terminal")],
    };
  const chatSessionId = () =>
    readValue(args, [
      "--chat-session",
      "--chat-session-id",
      "--session",
      "--session-id",
    ]) ??
    process.env.ADE_CHAT_SESSION_ID ??
    null;
  if (sub === "list" || sub === "ls") {
    return {
      kind: "execute",
      label: "terminal list",
      formatter: "terminal-list",
      steps: [
        actionStep(
          "result",
          "terminal",
          "list",
          collectGenericObjectArgs(args, {
            chatSessionId: chatSessionId(),
            laneId: readValue(args, ["--lane", "--lane-id"]),
            limit: readIntOption(args, ["--limit"], undefined),
          }),
        ),
      ],
    };
  }
  if (sub === "resume" || sub === "reattach") {
    const terminal =
      readValue(args, ["--terminal", "--terminal-id", "--session", "--session-id"]) ??
      firstStandalonePositional(args);
    return {
      kind: "execute",
      label: "terminal resume",
      formatter: "pty-create",
      steps: [
        actionStep(
          "result",
          "pty",
          "resumeSession",
          collectGenericObjectArgs(args, {
            sessionId: requireValue(terminal, "terminalId"),
            cols: readIntOption(args, ["--cols"], 120),
            rows: readIntOption(args, ["--rows"], 36),
            model: readValue(args, ["--model", "--model-id"]),
            reasoningEffort: readValue(args, ["--reasoning", "--reasoning-effort"]),
            permissionMode: readValue(args, ["--permission-mode", "--permissions"]),
          }),
        ),
      ],
    };
  }
  if (sub === "active" || sub === "current") {
    return {
      kind: "execute",
      label: "terminal active",
      steps: [
        actionStep(
          "result",
          "terminal",
          "activeForChat",
          collectGenericObjectArgs(args, {
            chatSessionId: requireValue(chatSessionId(), "chatSessionId"),
          }),
        ),
      ],
    };
  }
  if (sub === "read" || sub === "tail" || sub === "scrollback") {
    const terminal = readValue(args, ["--terminal", "--terminal-id"]);
    const ptyId = readValue(args, ["--pty", "--pty-id"]);
    const chat = chatSessionId();
    const maxBytes = readIntOption(args, ["--max-bytes"], undefined);
    const since = readIntOption(args, ["--since"], undefined);
    return {
      kind: "execute",
      label: "terminal read",
      steps: [
        actionStep(
          "result",
          "terminal",
          "read",
          collectGenericObjectArgs(args, {
            terminalId: terminal ?? firstPositional(args),
            ptyId,
            chatSessionId: chat,
            maxBytes,
            since,
          }),
        ),
      ],
    };
  }
  if (sub === "write" || sub === "send" || sub === "input") {
    const terminal = readValue(args, ["--terminal", "--terminal-id"]);
    const ptyId = readValue(args, ["--pty", "--pty-id"]);
    const chat = chatSessionId();
    const data =
      readValue(args, ["--data", "--value", "--text"]) ?? args.join(" ");
    if (!data.length) throw new CliUsageError("data is required.");
    return {
      kind: "execute",
      label: "terminal write",
      steps: [
        actionStep(
          "result",
          "terminal",
          "write",
          collectGenericObjectArgs(args, {
            terminalId: terminal ?? firstPositional(args),
            ptyId,
            chatSessionId: chat,
            data,
          }),
        ),
      ],
    };
  }
  if (sub === "signal" || sub === "interrupt" || sub === "stop") {
    const terminal = readValue(args, ["--terminal", "--terminal-id"]);
    const ptyId = readValue(args, ["--pty", "--pty-id"]);
    const chat = chatSessionId();
    const signal =
      readValue(args, ["--signal"]) ?? (sub === "stop" ? "SIGTERM" : "SIGINT");
    return {
      kind: "execute",
      label: "terminal signal",
      steps: [
        actionStep(
          "result",
          "terminal",
          "signal",
          collectGenericObjectArgs(args, {
            terminalId: terminal ?? firstPositional(args),
            ptyId,
            chatSessionId: chat,
            signal,
          }),
        ),
      ],
    };
  }
  return {
    kind: "execute",
    label: `terminal ${sub}`,
    steps: [
      actionStep("result", "terminal", sub, collectGenericObjectArgs(args)),
    ],
  };
}

function buildChatPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (readFlag(args, ["--personal"])) {
    return buildPersonalChatPlan(sub, args);
  }
  if (sub === "actions")
    return {
      kind: "execute",
      label: "chat actions",
      steps: [listActionsStep("actions", "chat")],
    };
  // Linear session-scoped subcommands resolve their own session id AFTER
  // consuming --issue-id (so firstPositional can't mistake an issue id flag value
  // for the session), so they opt out of the shared positional grab here.
  const linearSessionSub =
    sub === "attach-linear-issue" ||
    sub === "attach-linear" ||
    sub === "attach-issue" ||
    sub === "detach-linear-issue" ||
    sub === "detach-linear" ||
    sub === "detach-issue" ||
    sub === "linear-issues" ||
    sub === "list-linear-issues" ||
    sub === "issues";
  const scheduledWorkOperation = (
    sub === "scheduled-work"
    || sub === "schedules"
    || sub === "schedule"
  )
    && (args[0] === "list" || args[0] === "create" || args[0] === "cancel")
    ? firstStandalonePositional(args)
    : null;
  const sessionId =
    readValue(args, ["--session", "--session-id"]) ??
    (sub !== "create" && sub !== "list" && !linearSessionSub
      ? firstStandalonePositional(args)
      : null);
  const withSession = (base: JsonObject = {}) =>
    collectGenericObjectArgs(args, {
      ...base,
      ...(sessionId ? { sessionId } : {}),
    });
  const requireSession = () => requireValue(sessionId, "sessionId");
  if (sub === "list" || sub === "ls") {
    const includeArchived = readFlag(args, ["--archived", "--include-archived"]);
    const excludeArchived = readFlag(args, [
      "--active",
      "--no-archived",
      "--exclude-archived",
    ]);
    if (includeArchived && excludeArchived) {
      throw new CliUsageError(
        "Use either --include-archived or --no-archived, not both.",
      );
    }
    const laneId = readLaneId(args);
    const input = collectGenericObjectArgs(args, {
      ...(laneId ? { laneId } : {}),
      ...(includeArchived ? { includeArchived: true } : {}),
      ...(excludeArchived ? { includeArchived: false } : {}),
      ...(readFlag(args, ["--automation", "--include-automation"])
        ? { includeAutomation: true }
        : {}),
      ...(readFlag(args, ["--identity", "--include-identity"])
        ? { includeIdentity: true }
        : {}),
    });
    return {
      kind: "execute",
      label: "chat list",
      steps: [
        actionStep(
          "result",
          "chat",
          "listSessions",
          input,
        ),
      ],
    };
  }
  if (sub === "show" || sub === "status")
    return {
      kind: "execute",
      label: "chat status",
      steps: [
        actionArgsListStep("result", "chat", "getSessionSummary", [
          requireValue(sessionId, "sessionId"),
        ]),
      ],
    };
  if (sub === "read" || sub === "messages" || sub === "transcript") {
    const targetSession = requireValue(sessionId, "sessionId");
    const limit = readIntOption(args, ["--limit"], 50);
    const since = readValue(args, ["--since"]);
    return {
      kind: "execute",
      label: "chat read",
      formatter: "chat-read",
      steps: [
        actionStep(
          "result",
          "chat",
          "readTranscript",
          collectGenericObjectArgs(args, {
            sessionId: targetSession,
            ...(limit !== undefined ? { limit } : {}),
            ...(since ? { since } : {}),
          }),
        ),
      ],
    };
  }
  if (
    sub === "attach-linear-issue" ||
    sub === "attach-linear" ||
    sub === "attach-issue"
  ) {
    // Session-scoped attach: links an issue to a chat / CLI session (standalone
    // or lane-backed). The agent inside the session then reads it via injected
    // context and reads/writes back through `ade linear ...`. Parse issues first
    // so --issue-id is consumed before the positional session id is resolved.
    const issues = parseLinearIssuesInput(args);
    const targetSession = requireValue(
      sessionId ?? firstPositional(args) ?? readSessionId(args),
      "sessionId",
    );
    const input = buildSessionAttachArgs(
      targetSession,
      issues,
      readLinearAttachmentFlags(args),
    );
    return {
      kind: "execute",
      label: "chat attach Linear issue",
      steps: [
        actionStep(
          "result",
          LINEAR_ATTACH_ACTIONS.domain,
          LINEAR_ATTACH_ACTIONS.attachSession,
          collectGenericObjectArgs(args, input),
        ),
      ],
    };
  }
  if (
    sub === "detach-linear-issue" ||
    sub === "detach-linear" ||
    sub === "detach-issue"
  ) {
    // Consume --issue-id before resolving the positional session id. Omitting
    // --issue-id detaches every issue from the session.
    const issueId = asString(readIssueIdFlag(args));
    const targetSession = requireValue(
      sessionId ?? firstPositional(args) ?? readSessionId(args),
      "sessionId",
    );
    const input: JsonObject = { chatSessionId: targetSession };
    maybePut(input, "issueId", issueId);
    return {
      kind: "execute",
      label: "chat detach Linear issue",
      steps: [
        actionStep(
          "result",
          LINEAR_ATTACH_ACTIONS.domain,
          LINEAR_ATTACH_ACTIONS.detachSession,
          collectGenericObjectArgs(args, input),
        ),
      ],
    };
  }
  if (
    sub === "linear-issues" ||
    sub === "list-linear-issues" ||
    sub === "issues"
  ) {
    const targetSession = requireValue(
      sessionId ?? firstPositional(args) ?? readSessionId(args),
      "sessionId",
    );
    return {
      kind: "execute",
      label: "chat Linear issues",
      steps: [
        actionStep(
          "result",
          LINEAR_ATTACH_ACTIONS.domain,
          LINEAR_ATTACH_ACTIONS.listSession,
          collectGenericObjectArgs(args, { chatSessionId: targetSession }),
        ),
      ],
    };
  }
  if (sub === "create" || sub === "spawn") {
    const modelArg = readValue(args, ["--model", "--model-id"]);
    const reasoningEffort = readValue(args, ["--reasoning-effort", "--effort"]);
    const fastMode = readFastModeFlag(args);
    // `--print` opts the session's app-server initialize handshake into
    // print-mode (suppresses delta notification streams). Must be set at create
    // time because the handshake runs once when the runtime starts.
    const createRuntimeMode = readFlag(args, ["--print"]) ? "print" : undefined;
    const printConfig = readFlag(args, ["--print-config", "--dry-run"]);
    // `--from-linear-issue <id>` / `--linear-issue-json` start the chat with an
    // attached issue: create the session, attach the issue to it, then send an
    // issue-grounded kickoff (skipped with --no-kickoff). Read these before
    // collectGenericObjectArgs consumes the remaining args.
    const fromLinear =
      args.some((t) =>
        t === "--from-linear-issue" ||
        t.startsWith("--from-linear-issue=") ||
        t === "--linear-issue-json" ||
        t.startsWith("--linear-issue-json="),
      );
    let linearIssue: JsonObject | null = null;
    if (fromLinear) {
      const issues = parseLinearIssuesInput(args, "--from-linear-issue");
      if (issues.length !== 1) {
        throw new CliUsageError("chat create accepts exactly one Linear issue to attach.");
      }
      linearIssue = issues[0]!;
    }
    const noKickoff = readFlag(args, ["--no-kickoff"]);
    const explicitKickoff = readValue(args, ["--prompt", "--kickoff", "--kickoff-prompt"]);
    if (noKickoff && explicitKickoff) {
      throw new CliUsageError("--no-kickoff cannot be used with --prompt/--kickoff.");
    }
    const attachmentFlags = linearIssue ? readLinearAttachmentFlags(args) : {};
    const orchestrationParentSessionId = readParentSessionId(args);
    const createStep = actionStep(
      "result",
      "chat",
      "createSession",
      collectGenericObjectArgs(args, {
        laneId: readLaneId(args),
        ...(orchestrationParentSessionId ? { orchestrationParentSessionId } : {}),
        provider: readValue(args, ["--provider"]),
        model: modelArg,
        modelId: modelArg,
        reasoningEffort,
        permissionMode: readValue(args, [
          "--permission-mode",
          "--permissions",
        ]),
        droidPermissionMode: readValue(args, [
          "--droid-permission-mode",
          "--droid-autonomy",
          "--autonomy",
        ]),
        title: readValue(args, ["--title"]),
        surface: readValue(args, ["--surface"]) ?? "work",
        ...(fastMode !== undefined ? { fastMode, codexFastMode: fastMode } : {}),
        ...(createRuntimeMode ? { runtimeMode: createRuntimeMode } : {}),
      }),
    );
    const createArgs = (createStep.params as JsonObject).arguments as JsonObject;
    const actionArgs = createArgs.args as JsonObject;
    const kickoffText =
      explicitKickoff ??
      (linearIssue && !noKickoff ? deriveLinearKickoffPrompt(linearIssue) : null);
    if (printConfig) {
      return {
        kind: "static",
        value: buildChatCreateConfigPreview(actionArgs, {
          linearIssue,
          attachmentFlags,
          kickoffText,
          noKickoff,
        }),
        formatter: "action-result",
      };
    }
    if (!linearIssue) {
      if (explicitKickoff) {
        return {
          kind: "execute",
          label: "chat create",
          steps: [
            { ...createStep, key: "session" },
            {
              key: "result",
              method: "ade/actions/call",
              params: (values) => {
                const targetSession = sessionIdFromCreateChatValue(values.session);
                if (!targetSession) {
                  throw new CliUsageError("chat create could not resolve the new session id to send the prompt.");
                }
                return {
                  name: "run_ade_action",
                  arguments: {
                    domain: "chat",
                    action: "sendMessage",
                    args: {
                      sessionId: targetSession,
                      text: explicitKickoff,
                    },
                  },
                };
              },
              unwrapToolResult: true,
            },
          ],
        };
      }
      return { kind: "execute", label: "chat create", steps: [createStep] };
    }
    const issueForKickoff = linearIssue;
    const steps: InvocationStep[] = [
      // First step keyed "session" so attach/kickoff can read the new id.
      { ...createStep, key: "session" },
      {
        key: "attach",
        method: "ade/actions/call",
        params: (values) => {
          const targetSession = sessionIdFromCreateChatValue(values.session);
          if (!targetSession) {
            throw new CliUsageError("chat create could not resolve the new session id to attach the issue.");
          }
          return {
            name: "run_ade_action",
            arguments: {
              domain: LINEAR_ATTACH_ACTIONS.domain,
              action: LINEAR_ATTACH_ACTIONS.attachSession,
              args: { chatSessionId: targetSession, issues: [issueForKickoff], ...attachmentFlags },
            },
          };
        },
        unwrapToolResult: true,
      },
    ];
    if (!noKickoff) {
      steps.push({
        key: "result",
        method: "ade/actions/call",
        params: (values) => {
          const targetSession = sessionIdFromCreateChatValue(values.session);
          if (!targetSession) {
            throw new CliUsageError("chat create could not resolve the new session id to send the kickoff.");
          }
          return {
            name: "run_ade_action",
            arguments: {
              domain: "chat",
              action: "sendMessage",
              args: {
                sessionId: targetSession,
                text: explicitKickoff ?? deriveLinearKickoffPrompt(issueForKickoff),
              },
            },
          };
        },
        unwrapToolResult: true,
      });
    }
    return { kind: "execute", label: "chat create from Linear issue", steps };
  }
  if (sub === "send") {
    const imageUrl = readValue(args, ["--image-url"]);
    // `--print` is honored at session create time only — the app-server
    // initialize handshake runs once per session, so setting it per-message
    // would be a silent no-op. Reject explicitly so users move it to
    // `ade chat create --print`.
    const hasPrintFlag = args.some((token) => token === "--print" || token.startsWith("--print="));
    if (hasPrintFlag) {
      throw new CliUsageError(
        "--print must be set at session creation time. Use `ade chat create --print ...`.",
      );
    }
    const sendText = requireValue(
      readValue(args, ["--text", "--message"]) ?? args.join(" "),
      "message text",
    );
    const targetSession = requireValue(sessionId, "sessionId");
    const messageArgs = withSession({
      sessionId: targetSession,
      text: sendText,
      kind: "auto",
      ...(imageUrl ? { attachments: [{ type: "image-url", url: imageUrl, path: imageUrl }] } : {}),
    });
    return {
      kind: "execute",
      label: "chat send",
      steps: [
        actionStep("result", "chat", "messageSession", messageArgs),
      ],
    };
  }
  if (sub === "message" || sub === "tell" || sub === "notify") {
    const imageUrl = readValue(args, ["--image-url"]);
    const kindFlag = readValue(args, ["--kind", "--delivery"]);
    const queueFlag = readFlag(args, ["--queue", "--steer"]);
    const wakeFlag = readFlag(args, ["--wake"]);
    const interruptFlag = readFlag(args, ["--interrupt", "--replace"]);
    const selectedKinds = [
      kindFlag,
      queueFlag ? "queue" : null,
      wakeFlag ? "wake" : null,
      interruptFlag ? "interrupt-replace" : null,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (selectedKinds.length > 1) {
      throw new CliUsageError("Use only one of --kind, --queue, --wake, or --interrupt.");
    }
    const messageText = requireValue(
      readValue(args, ["--text", "--message"]) ?? args.join(" "),
      "message text",
    );
    return {
      kind: "execute",
      label: "chat message",
      steps: [
        actionStep(
          "result",
          "chat",
          "messageSession",
          withSession({
            sessionId: requireValue(sessionId, "sessionId"),
            text: messageText,
            kind: normalizeChatMessageKind(selectedKinds[0] ?? null),
            ...(imageUrl ? { attachments: [{ type: "image-url", url: imageUrl, path: imageUrl }] } : {}),
          }),
        ),
      ],
    };
  }
  if (sub === "steer") {
    const imageUrl = readValue(args, ["--image-url"]);
    const steerText = requireValue(
      readValue(args, ["--text", "--message"]) ?? args.join(" "),
      "message text",
    );
    return {
      kind: "execute",
      label: "chat steer",
      steps: [
        actionStep(
          "result",
          "chat",
          "steer",
          withSession({
            sessionId: requireValue(sessionId, "sessionId"),
            text: steerText,
            ...(imageUrl ? { attachments: [{ type: "image-url", url: imageUrl, path: imageUrl }] } : {}),
          }),
        ),
      ],
    };
  }
  if (sub === "wait" || sub === "watch") {
    const timeoutMs = readIntOption(args, ["--timeout-ms", "--timeout"], 10 * 60 * 1000) ?? 10 * 60 * 1000;
    const pollIntervalMs = readIntOption(args, ["--poll-interval-ms", "--interval-ms"], 2_000) ?? 2_000;
    if (timeoutMs <= 0) throw new CliUsageError("chat wait --timeout-ms must be greater than zero.");
    if (pollIntervalMs <= 0) throw new CliUsageError("chat wait --poll-interval-ms must be greater than zero.");
    return {
      kind: "chat-wait",
      sessionId: requireValue(sessionId, "sessionId"),
      waitFor: normalizeChatWaitTarget(
        readValue(args, ["--for", "--state", "--until"]) ?? firstStandalonePositional(args),
      ),
      timeoutMs,
      pollIntervalMs,
    };
  }
  if (sub === "interrupt")
    return {
      kind: "execute",
      label: "chat interrupt",
      steps: [
        actionStep(
          "result",
          "chat",
          "interrupt",
          withSession({ sessionId: requireValue(sessionId, "sessionId") }),
        ),
      ],
    };
  if (sub === "recover" || sub === "recovery") {
    const turnId = requireValue(readValue(args, ["--turn", "--turn-id"]), "turnId");
    const action = normalizeCodexRecoveryCliAction(
      readValue(args, ["--action", "--recovery-action"])
        ?? firstStandalonePositional(args),
    );
    return {
      kind: "execute",
      label: "chat recover",
      steps: [
        actionStep(
          "result",
          "chat",
          "recoverCodexTurn",
          withSession({
            sessionId: requireValue(sessionId, "sessionId"),
            turnId,
            action,
          }),
        ),
      ],
    };
  }
  if (sub === "goal" || sub === "codex-goal") {
    const clear = readFlag(args, ["--clear", "--delete", "--rm"]);
    const statusFlag = readValue(args, ["--status"]);
    const objectiveFlag = readValue(args, ["--objective", "--goal", "--text", "--set"]);
    const positional = firstStandalonePositional(args);
    const positionalStatus = isCodexGoalCliStatus(positional) ? positional : null;
    const status = statusFlag ?? positionalStatus;
    const objective = objectiveFlag ?? (positional && !positionalStatus ? positional : null);
    if (clear && (status || objective)) {
      throw new CliUsageError("Use either --clear, --status, or --objective for chat goal.");
    }
    if (status && objective) {
      throw new CliUsageError("Use either --status or --objective for chat goal.");
    }
    if (status && !isCodexGoalCliStatus(status)) {
      throw new CliUsageError("chat goal --status must be active, paused, blocked, or complete.");
    }
    if (clear) {
      return {
        kind: "execute",
        label: "chat clear Codex goal",
        steps: [actionStep("result", "chat", "clearCodexGoal", withSession({ sessionId: requireSession() }))],
      };
    }
    if (status) {
      return {
        kind: "execute",
        label: "chat Codex goal status",
        steps: [actionStep("result", "chat", "setCodexGoalStatus", withSession({ sessionId: requireSession(), status }))],
      };
    }
    if (objective) {
      return {
        kind: "execute",
        label: "chat Codex goal",
        steps: [actionStep("result", "chat", "setCodexGoal", withSession({ sessionId: requireSession(), objective }))],
      };
    }
    return {
      kind: "execute",
      label: "chat Codex goal",
      steps: [actionStep("result", "chat", "getCodexGoal", withSession({ sessionId: requireSession() }))],
    };
  }
  if (sub === "goal-status" || sub === "codex-goal-status") {
    const status = readValue(args, ["--status"]) ?? firstStandalonePositional(args);
    if (!isCodexGoalCliStatus(status)) {
      throw new CliUsageError("chat goal-status requires status active, paused, blocked, or complete.");
    }
    return {
      kind: "execute",
      label: "chat Codex goal status",
      steps: [actionStep("result", "chat", "setCodexGoalStatus", withSession({ sessionId: requireSession(), status }))],
    };
  }
  if (sub === "clear-goal" || sub === "goal-clear" || sub === "delete-goal") {
    return {
      kind: "execute",
      label: "chat clear Codex goal",
      steps: [actionStep("result", "chat", "clearCodexGoal", withSession({ sessionId: requireSession() }))],
    };
  }
  if (sub === "handoff" || sub === "fork") {
    const modeArg = readValue(args, ["--mode"]);
    const forkFlag = readFlag(args, ["--fork"]);
    const briefFlag = readFlag(args, ["--brief"]);
    if ((forkFlag && briefFlag) || (modeArg && (forkFlag || briefFlag))) {
      throw new CliUsageError("Use either --mode, --fork, or --brief for chat handoff.");
    }
    const mode = sub === "fork" || forkFlag ? "fork" : briefFlag ? "brief" : modeArg ?? "brief";
    if (mode !== "brief" && mode !== "fork") {
      throw new CliUsageError("chat handoff --mode must be brief or fork.");
    }
    const targetModelId = requireValue(
      readValue(args, ["--target-model", "--target-model-id", "--model", "--model-id", "--target"]) ??
        firstStandalonePositional(args),
      "targetModelId",
    );
    const targetLaneId = readValue(args, ["--target-lane", "--target-lane-id"]);
    if (targetLaneId !== null && mode === "fork") {
      throw new CliUsageError("chat fork stays in the source lane; --target-lane is only valid for brief handoffs.");
    }
    const reasoningEffort = readValue(args, ["--reasoning-effort", "--effort"]);
    const fastMode = readFastModeFlag(args);
    const permissionMode = readValue(args, ["--permission-mode", "--permissions"]);
    const codexApprovalPolicy = readValue(args, ["--codex-approval-policy", "--approval-policy"]);
    const codexSandbox = readValue(args, ["--codex-sandbox", "--sandbox"]);
    const codexConfigSource = readValue(args, ["--codex-config-source", "--config-source"]);
    const handoffNote = readValue(args, ["--handoff-note", "--note"]);
    return {
      kind: "execute",
      label: mode === "fork" ? "chat fork" : "chat handoff",
      steps: [
        actionStep(
          "result",
          "chat",
          "handoffSession",
          collectGenericObjectArgs(args, {
            sourceSessionId: requireSession(),
            targetModelId,
            mode,
            ...(targetLaneId !== null ? { targetLaneId } : {}),
            ...(reasoningEffort !== null ? { reasoningEffort } : {}),
            ...(fastMode !== undefined ? { fastMode, codexFastMode: fastMode } : {}),
            ...(permissionMode !== null ? { permissionMode } : {}),
            ...(codexApprovalPolicy !== null ? { codexApprovalPolicy } : {}),
            ...(codexSandbox !== null ? { codexSandbox } : {}),
            ...(codexConfigSource !== null ? { codexConfigSource } : {}),
            ...(handoffNote !== null ? { handoffNote } : {}),
          }),
        ),
      ],
    };
  }
  if (sub === "rewind" || sub === "rewind-files" || sub === "file-rewind") {
    const userMessageId = requireValue(
      readValue(args, ["--user-message-id", "--message-id", "--message", "--item-id"]) ??
        firstStandalonePositional(args),
      "userMessageId",
    );
    const dryRun = readFlag(args, ["--dry-run", "--preview"]);
    return {
      kind: "execute",
      label: "chat rewind files",
      steps: [
        actionStep(
          "result",
          "chat",
          "rewindFiles",
          collectGenericObjectArgs(args, {
            sessionId: requireSession(),
            userMessageId,
            ...(dryRun ? { dryRun: true } : {}),
          }),
        ),
      ],
    };
  }
  if (sub === "subagents" || sub === "list-subagents") {
    return {
      kind: "execute",
      label: "chat subagents",
      steps: [actionStep("result", "chat", "listSubagents", withSession({ sessionId: requireSession() }))],
    };
  }
  if (sub === "subagent" || sub === "subagent-transcript") {
    const agentId = requireValue(
      readValue(args, ["--agent-id", "--agent", "--task-id", "--task"]) ?? firstStandalonePositional(args),
      "agentId",
    );
    const taskId = readValue(args, ["--task-id", "--task"]);
    const laneId = readLaneId(args);
    const limit = readValue(args, ["--limit"]);
    const offset = readValue(args, ["--offset"]);
    return {
      kind: "execute",
      label: "chat subagent transcript",
      steps: [
        actionStep(
          "result",
          "chat",
          "getSubagentTranscript",
          collectGenericObjectArgs(args, {
            sessionId: requireSession(),
            agentId,
            ...(taskId ? { taskId } : {}),
            ...(laneId ? { laneId } : {}),
            ...(limit ? { limit: Number(limit) } : {}),
            ...(offset ? { offset: Number(offset) } : {}),
          }),
        ),
      ],
    };
  }
  if (
    sub === "schedules" ||
    sub === "schedule" ||
    sub === "scheduled-work"
  ) {
    if (scheduledWorkOperation === "create") {
      const cron = requireValue(readValue(args, ["--cron"]), "cron");
      const prompt = requireValue(readValue(args, ["--prompt", "--text"]), "prompt");
      const reason = readValue(args, ["--reason"]);
      return {
        kind: "execute",
        label: "chat scheduled-work create",
        steps: [
          actionStep(
            "result",
            "chat",
            "createScheduledWork",
            collectGenericObjectArgs(args, {
              ...(sessionId ? { sessionId } : {}),
              cron,
              prompt,
              recurring: !readFlag(args, ["--once"]),
              ...(reason ? { reason } : {}),
            }),
          ),
        ],
      };
    }
    if (scheduledWorkOperation === "list") {
      return {
        kind: "execute",
        label: "chat scheduled-work list",
        steps: [
          actionStep(
            "result",
            "chat",
            "listScheduledWork",
            collectGenericObjectArgs(args, {
              ...(sessionId ? { sessionId } : {}),
              ...(readFlag(args, ["--all", "--include-terminal"]) ? { includeTerminal: true } : {}),
            }),
          ),
        ],
      };
    }
    if (scheduledWorkOperation === "cancel") {
      const targetSession = requireValue(sessionId, "sessionId");
      const scheduleId = requireValue(firstStandalonePositional(args), "scheduleId");
      return {
        kind: "execute",
        label: "chat scheduled-work cancel",
        steps: [
          actionStep(
            "result",
            "chat",
            "cancelScheduledWork",
            collectGenericObjectArgs(args, {
              sessionId: targetSession,
              scheduleId,
            }),
          ),
        ],
      };
    }
    // Per-session scheduled-work control. The state query works for both chat
    // sessions and tracked provider CLI terminals.
    const targetSession = requireValue(sessionId, "sessionId");
    const pause = readFlag(args, ["--pause", "--pause-scheduled-work"]);
    const resume = readFlag(args, ["--resume", "--unpause"]);
    if (pause && resume) {
      throw new CliUsageError("Use either --pause or --resume, not both.");
    }
    if (!pause && !resume) {
      return {
        kind: "execute",
        label: "chat schedules",
        steps: [
          actionStep("result", "chat", "getScheduledWorkState", {
            sessionId: targetSession,
          }),
        ],
      };
    }
    return {
      kind: "execute",
      label: pause ? "chat schedules pause" : "chat schedules resume",
      steps: [
        actionStep(
          "result",
          "chat",
          "setScheduledWorkPaused",
          collectGenericObjectArgs(args, {
            sessionId: targetSession,
            paused: pause,
          }),
        ),
      ],
    };
  }
  if (sub === "delete" || sub === "rm")
    return {
      kind: "execute",
      label: "chat delete",
      steps: [actionStep("result", "chat", "deleteSession", withSession())],
    };
  if (sub === "models") {
    const provider = readValue(args, ["--provider"]);
    return {
      kind: "execute",
      label: "chat models",
      steps: [
        actionStep(
          "result",
          "chat",
          "getAvailableModels",
          collectGenericObjectArgs(args, provider ? { provider } : {}),
        ),
      ],
    };
  }
  if (sub === "slash")
    return {
      kind: "execute",
      label: "chat slash commands",
      steps: [
        actionStep(
          "result",
          "chat",
          "getSlashCommands",
          withSession({ sessionId: requireValue(sessionId, "sessionId") }),
        ),
      ],
    };
  return {
    kind: "execute",
    label: `chat ${sub}`,
    steps: [actionStep("result", "chat", sub, withSession())],
  };
}

function personalChatStep(action: string, args: JsonObject = {}): InvocationStep {
  return {
    key: "result",
    method: "personalChats.call",
    params: { action, args },
  };
}

function buildPersonalChatPlan(sub: string, args: string[]): CliPlan {
  const laneId = readLaneId(args);
  if (laneId) {
    throw new CliUsageError("--personal cannot be combined with --lane.");
  }
  if (
    args.some((token) =>
      token === "--from-linear-issue" ||
      token.startsWith("--from-linear-issue=") ||
      token === "--linear-issue-json" ||
      token.startsWith("--linear-issue-json="),
    )
  ) {
    throw new CliUsageError("Personal chats cannot attach project Linear issues.");
  }

  const base = {
    kind: "execute" as const,
    machineOnly: true,
  };
  if (sub === "actions") {
    return {
      kind: "static",
      formatter: "actions-list",
      value: {
        actions: PERSONAL_CHAT_ACTIONS.map((action) => ({
          name: `personalChats.${action}`,
          description: "Machine-scoped personal chat action.",
          example: `ade chat action --personal ${action} --input-json '{...}'`,
        })),
      },
    };
  }
  if (sub === "action" || sub === "call") {
    const action = requireValue(
      readValue(args, ["--action"]) ?? firstStandalonePositional(args),
      "personal chat action",
    );
    if (!(PERSONAL_CHAT_ACTIONS as readonly string[]).includes(action)) {
      throw new CliUsageError(
        `Unknown personal chat action '${action}'. Use \`ade chat actions --personal --text\` to list actions.`,
      );
    }
    return {
      ...base,
      label: `personal chat ${action}`,
      steps: [personalChatStep(action, collectGenericObjectArgs(args))],
    };
  }
  if (sub === "list" || sub === "ls") {
    const includeArchived = readFlag(args, ["--archived", "--include-archived"]);
    const excludeArchived = readFlag(args, ["--active", "--no-archived", "--exclude-archived"]);
    if (includeArchived && excludeArchived) {
      throw new CliUsageError("Use either --include-archived or --no-archived, not both.");
    }
    return {
      ...base,
      label: "personal chat list",
      formatter: "chat-list",
      steps: [personalChatStep("list", {
        ...(includeArchived ? { includeArchived: true } : {}),
        ...(excludeArchived ? { includeArchived: false } : {}),
      })],
    };
  }

  if (sub === "create" || sub === "spawn") {
    const model = readValue(args, ["--model", "--model-id"]);
    const provider = readValue(args, ["--provider"]);
    const prompt = readValue(args, ["--prompt", "--kickoff", "--kickoff-prompt"]);
    const fastMode = readFastModeFlag(args);
    const createArgs = collectGenericObjectArgs(args, {
      provider,
      model,
      modelId: model,
      title: readValue(args, ["--title"]),
      reasoningEffort: readValue(args, ["--reasoning-effort", "--effort"]),
      permissionMode: readValue(args, ["--permission-mode", "--permissions"]),
      ...(fastMode !== undefined ? { fastMode, codexFastMode: fastMode } : {}),
      ...(prompt ? { kickoffText: prompt } : {}),
    });
    requireValue(asString(createArgs.provider), "provider");
    requireValue(asString(createArgs.model), "model");
    return {
      ...base,
      label: "personal chat create",
      steps: [personalChatStep("create", createArgs)],
    };
  }

  if (sub === "models") {
    const provider = readValue(args, ["--provider"]);
    return {
      ...base,
      label: "personal chat models",
      steps: [personalChatStep("models", collectGenericObjectArgs(args, {
        ...(provider ? { provider } : {}),
      }))],
    };
  }
  if (sub === "model-catalog" || sub === "catalog") {
    const mode = readValue(args, ["--mode"]);
    return {
      ...base,
      label: "personal chat model catalog",
      steps: [personalChatStep("modelCatalog", collectGenericObjectArgs(args, {
        ...(mode ? { mode } : {}),
      }))],
    };
  }

  const sessionSubcommands = new Set([
    "read",
    "messages",
    "transcript",
    "send",
    "steer",
    "update",
    "configure",
    "interrupt",
    "stop",
    "archive",
    "unarchive",
    "delete",
    "rm",
    "show",
    "status",
  ]);
  if (!sessionSubcommands.has(sub)) {
    throw new CliUsageError(`Personal chats support actions, action, list, create, show, read, send, steer, update, models, model-catalog, interrupt, archive, unarchive, or delete; got '${sub}'.`);
  }

  const sessionId = requireValue(
    readValue(args, ["--session", "--session-id"]) ?? firstStandalonePositional(args),
    "sessionId",
  );
  if (sub === "read" || sub === "messages" || sub === "transcript") {
    const limit = readIntOption(args, ["--limit"], 50);
    const since = readValue(args, ["--since"]);
    return {
      ...base,
      label: "personal chat read",
      formatter: "chat-read",
      steps: [personalChatStep("read", collectGenericObjectArgs(args, {
        sessionId,
        ...(limit !== undefined ? { limit } : {}),
        ...(since ? { since } : {}),
      }))],
    };
  }
  if (sub === "send") {
    const text = requireValue(readValue(args, ["--text", "--message"]) ?? args.join(" "), "message text");
    const imageUrl = readValue(args, ["--image-url"]);
    return {
      ...base,
      label: "personal chat send",
      steps: [personalChatStep("send", collectGenericObjectArgs(args, {
        sessionId,
        text,
        ...(imageUrl ? { attachments: [{ type: "image-url", url: imageUrl, path: imageUrl }] } : {}),
      }))],
    };
  }
  if (sub === "steer") {
    const text = requireValue(readValue(args, ["--text", "--message"]) ?? args.join(" "), "message text");
    const imageUrl = readValue(args, ["--image-url"]);
    return {
      ...base,
      label: "personal chat steer",
      steps: [personalChatStep("steer", collectGenericObjectArgs(args, {
        sessionId,
        text,
        ...(imageUrl ? { attachments: [{ type: "image-url", url: imageUrl, path: imageUrl }] } : {}),
      }))],
    };
  }
  if (sub === "update" || sub === "configure") {
    const model = readValue(args, ["--model", "--model-id"]);
    const title = readValue(args, ["--title"]);
    // Claude-only session tag mirrored to the SDK. Pass `--tag ""` to clear it.
    // Rejected at runtime for non-Claude sessions or before a Claude turn exists.
    const tag = readValue(args, ["--tag"]);
    const provider = readValue(args, ["--provider"]);
    const reasoningEffort = readValue(args, ["--reasoning-effort", "--effort"]);
    const permissionMode = readValue(args, ["--permission-mode", "--permissions"]);
    const fastMode = readFastModeFlag(args);
    return {
      ...base,
      label: "personal chat update",
      steps: [personalChatStep("updateSession", collectGenericObjectArgs(args, {
        sessionId,
        ...(title !== null ? { title } : {}),
        ...(tag !== null ? { tag } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model, modelId: model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(fastMode !== undefined ? { fastMode } : {}),
      }))],
    };
  }
  if (sub === "interrupt" || sub === "stop") {
    return {
      ...base,
      label: "personal chat interrupt",
      steps: [personalChatStep("interrupt", collectGenericObjectArgs(args, { sessionId }))],
    };
  }
  if (sub === "archive" || sub === "unarchive" || sub === "delete" || sub === "rm") {
    const action = sub === "rm" ? "delete" : sub;
    return {
      ...base,
      label: `personal chat ${action}`,
      steps: [personalChatStep(action, collectGenericObjectArgs(args, { sessionId }))],
    };
  }
  if (sub === "show" || sub === "status") {
    return {
      ...base,
      label: "personal chat status",
      steps: [personalChatStep("getSummary", { sessionId })],
    };
  }
  throw new CliUsageError(`Unhandled personal chat subcommand '${sub}'.`);
}

function buildTestsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "test actions",
      steps: [listActionsStep("actions", "tests")],
    };
  if (sub === "list" || sub === "suites")
    return {
      kind: "execute",
      label: "test suites",
      steps: [
        actionStep(
          "result",
          "tests",
          "listSuites",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "run") {
    const laneId = requireValue(readLaneId(args), "laneId");
    const suiteId =
      readValue(args, ["--suite", "--suite-id"]) ?? firstPositional(args);
    const command = readValue(args, ["--command", "-c"]);
    if (!suiteId && !command)
      throw new CliUsageError(
        "tests run requires --suite <id> or --command <command>.",
      );
    const input = collectGenericObjectArgs(args, {
      laneId,
      suiteId,
      command,
      waitForCompletion: readFlag(args, ["--wait"]),
      timeoutMs: readIntOption(args, ["--timeout-ms"]),
      maxLogBytes: readIntOption(args, ["--max-log-bytes"]),
    });
    return {
      kind: "execute",
      label: "test run",
      steps: [actionCallStep("result", "run_tests", input)],
    };
  }
  if (sub === "stop")
    return {
      kind: "execute",
      label: "test stop",
      steps: [
        actionStep(
          "result",
          "tests",
          "stop",
          collectGenericObjectArgs(args, {
            runId: requireValue(
              readValue(args, ["--run", "--run-id"]) ?? firstPositional(args),
              "runId",
            ),
          }),
        ),
      ],
    };
  if (sub === "runs")
    return {
      kind: "execute",
      label: "test runs",
      steps: [
        actionStep(
          "result",
          "tests",
          "listRuns",
          collectGenericObjectArgs(args, {
            laneId: readLaneId(args),
            suiteId: readValue(args, ["--suite", "--suite-id"]),
            limit: readIntOption(args, ["--limit"]),
          }),
        ),
      ],
    };
  if (sub === "logs" || sub === "log")
    return {
      kind: "execute",
      label: "test logs",
      steps: [
        actionStep(
          "result",
          "tests",
          "getLogTail",
          collectGenericObjectArgs(args, {
            runId: requireValue(
              readValue(args, ["--run", "--run-id"]) ?? firstPositional(args),
              "runId",
            ),
            maxBytes: readIntOption(args, ["--max-bytes"], 220_000),
          }),
        ),
      ],
    };
  return {
    kind: "execute",
    label: `tests ${sub}`,
    steps: [actionStep("result", "tests", sub, collectGenericObjectArgs(args))],
  };
}

function readFileTextInput(args: string[]): string | undefined {
  const text = readValue(args, ["--text"]);
  if (text != null) return text;
  const filePath = readValue(args, ["--from-file"]);
  if (filePath != null) return fs.readFileSync(path.resolve(filePath), "utf8");
  if (readFlag(args, ["--stdin"])) return fs.readFileSync(0, "utf8");
  return undefined;
}

function readAllStdinSync(): string {
  return fs.readFileSync(0, "utf8");
}

function readBoundedStdinSync(maxBytes: number, label: string): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(8_192, maxBytes + 1 - total));
    const bytes = fs.readSync(0, chunk, 0, chunk.length, null);
    if (bytes === 0) break;
    total += bytes;
    if (total > maxBytes) {
      throw new CliUsageError(`${label} must be ${maxBytes} bytes or fewer.`);
    }
    chunks.push(chunk.subarray(0, bytes));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readLineFromStdinSync(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(1);
  while (true) {
    let bytes = 0;
    try {
      bytes = fs.readSync(0, buf, 0, 1, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EINTR") continue;
      break;
    }
    if (bytes === 0) break;
    if (buf[0] === 0x0a) break;
    if (buf[0] === 0x0d) continue;
    chunks.push(Buffer.from(buf.subarray(0, 1)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function promptPasswordSync(prompt: string): string {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  process.stderr.write(prompt);
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return readLineFromStdinSync();
  }
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(1);
    while (true) {
      let bytes = 0;
      try {
        bytes = fs.readSync(0, buf, 0, 1, null);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN" || code === "EINTR") continue;
        break;
      }
      if (bytes === 0) break;
      const byte = buf[0]!;
      if (byte === 0x03) {
        process.stderr.write("\n");
        throw new CliUsageError("password entry cancelled.");
      }
      if (byte === 0x0a || byte === 0x0d) break;
      if (byte === 0x7f || byte === 0x08) {
        if (chunks.length > 0) chunks.pop();
        continue;
      }
      chunks.push(Buffer.from(buf.subarray(0, 1)));
    }
    process.stderr.write("\n");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    try {
      stdin.setRawMode(wasRaw);
    } catch {}
  }
}

function buildFilesPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "workspaces";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "file actions",
      steps: [listActionsStep("actions", "file")],
    };
  const workspaceId = readValue(args, ["--workspace", "--workspace-id"]);
  const withWorkspace = (base: JsonObject = {}) =>
    collectGenericObjectArgs(args, {
      ...base,
      ...(workspaceId ? { workspaceId } : {}),
    });

  if (sub === "workspaces" || sub === "workspace" || sub === "roots") {
    return {
      kind: "execute",
      label: "file workspaces",
      steps: [
        actionStep(
          "result",
          "file",
          "listWorkspaces",
          collectGenericObjectArgs(args, { laneId: readLaneId(args) }),
        ),
      ],
    };
  }
  if (sub === "tree" || sub === "ls") {
    return {
      kind: "execute",
      label: "file tree",
      steps: [
        actionStep(
          "result",
          "file",
          "listTree",
          withWorkspace({
            parentPath: readValue(args, ["--path"]) ?? firstPositional(args),
            depth: readIntOption(args, ["--depth"]),
            includeIgnored: readFlag(args, ["--include-ignored"]),
          }),
        ),
      ],
    };
  }
  if (sub === "read" || sub === "cat") {
    return {
      kind: "execute",
      label: "file read",
      steps: [
        actionStep(
          "result",
          "file",
          "readFile",
          withWorkspace({
            path: requireValue(
              readValue(args, ["--path"]) ?? firstPositional(args),
              "path",
            ),
          }),
        ),
      ],
    };
  }
  if (sub === "write") {
    const text = readFileTextInput(args);
    if (text == null)
      throw new CliUsageError(
        "files write requires --text, --from-file, or --stdin.",
      );
    return {
      kind: "execute",
      label: "file write",
      steps: [
        actionStep(
          "result",
          "file",
          "writeWorkspaceText",
          withWorkspace({
            path: requireValue(
              readValue(args, ["--path"]) ?? firstPositional(args),
              "path",
            ),
            text,
          }),
        ),
      ],
    };
  }
  if (sub === "create") {
    return {
      kind: "execute",
      label: "file create",
      steps: [
        actionStep(
          "result",
          "file",
          "createFile",
          withWorkspace({
            path: requireValue(
              readValue(args, ["--path"]) ?? firstPositional(args),
              "path",
            ),
            content: readFileTextInput(args) ?? "",
          }),
        ),
      ],
    };
  }
  if (sub === "mkdir") {
    return {
      kind: "execute",
      label: "file mkdir",
      steps: [
        actionStep(
          "result",
          "file",
          "createDirectory",
          withWorkspace({
            path: requireValue(
              readValue(args, ["--path"]) ?? firstPositional(args),
              "path",
            ),
          }),
        ),
      ],
    };
  }
  if (sub === "rename" || sub === "mv") {
    return {
      kind: "execute",
      label: "file rename",
      steps: [
        actionStep(
          "result",
          "file",
          "rename",
          withWorkspace({
            oldPath:
              readValue(args, ["--old", "--old-path"]) ?? firstPositional(args),
            newPath:
              readValue(args, ["--new", "--new-path"]) ?? firstPositional(args),
          }),
        ),
      ],
    };
  }
  if (sub === "delete" || sub === "rm") {
    return {
      kind: "execute",
      label: "file delete",
      steps: [
        actionStep(
          "result",
          "file",
          "deletePath",
          withWorkspace({
            path: requireValue(
              readValue(args, ["--path"]) ?? firstPositional(args),
              "path",
            ),
          }),
        ),
      ],
    };
  }
  if (sub === "quick-open") {
    return {
      kind: "execute",
      label: "file quick-open",
      steps: [
        actionStep(
          "result",
          "file",
          "quickOpen",
          withWorkspace({
            query: readValue(args, ["--query", "-q"]) ?? args.join(" "),
            limit: readIntOption(args, ["--limit"]),
            includeIgnored: readFlag(args, ["--include-ignored"]),
          }),
        ),
      ],
    };
  }
  if (sub === "search") {
    return {
      kind: "execute",
      label: "file search",
      steps: [
        actionStep(
          "result",
          "file",
          "searchText",
          withWorkspace({
            query: requireValue(
              readValue(args, ["--query", "-q"]) ?? args.join(" "),
              "query",
            ),
            limit: readIntOption(args, ["--limit"]),
            includeIgnored: readFlag(args, ["--include-ignored"]),
          }),
        ),
      ],
    };
  }
  return {
    kind: "execute",
    label: `files ${sub}`,
    steps: [actionStep("result", "file", sub, withWorkspace())],
  };
}

function readProofOwnerBase(args: string[]): JsonObject {
  const ownerKind = readValue(args, ["--owner-kind", "--owner"]);
  const ownerId = readValue(args, ["--owner-id"]);
  return {
    ...(ownerKind ? { ownerKind } : {}),
    ...(ownerId ? { ownerId } : {}),
  };
}

function buildProofPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  const proofOwnerBase = () => readProofOwnerBase(args);
  const inferAttachedProofKind = (filePath: string): string => {
    const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
    if (
      [
        "png",
        "jpg",
        "jpeg",
        "webp",
        "gif",
        "heic",
        "heif",
        "tif",
        "tiff",
      ].includes(ext)
    )
      return "screenshot";
    if (["mov", "mp4", "m4v", "webm"].includes(ext)) return "video_recording";
    if (["zip", "har"].includes(ext)) return "browser_trace";
    return "browser_verification";
  };
  if (sub === "actions")
    return {
      kind: "execute",
      label: "proof actions",
      steps: [listActionsStep("actions", "computer_use_artifacts")],
    };
  if (sub === "status" || sub === "backends")
    return {
      kind: "execute",
      label: "proof backend status",
      steps: [
        actionCallStep(
          "result",
          "get_computer_use_backend_status",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "environment")
    return {
      kind: "execute",
      label: "computer-use environment",
      steps: [
        actionCallStep(
          "result",
          "get_environment_info",
          collectGenericObjectArgs(args, proofOwnerBase()),
        ),
      ],
      preferHeadless: true,
    };
  if (sub === "list" || sub === "ls")
    return {
      kind: "execute",
      label: "proof list",
      steps: [
        actionCallStep(
          "result",
          "list_computer_use_artifacts",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "ingest")
    return {
      kind: "execute",
      label: "proof ingest",
      steps: [
        actionCallStep(
          "result",
          "ingest_computer_use_artifacts",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "attach") {
    const caption = readValue(args, ["--caption", "--description", "--desc"]);
    const attachedPath = requireValue(
      readValue(args, ["--path"]) ?? firstPositional(args),
      "path",
    );
    const title =
      readValue(args, ["--title", "--name"]) ??
      caption ??
      path.basename(attachedPath);
    return {
      kind: "execute",
      label: "proof attach",
      steps: [
        actionCallStep(
          "result",
          "ingest_computer_use_artifacts",
          collectGenericObjectArgs(args, {
            backendStyle: "manual",
            backendName: "ade-cli",
            toolName: "proof attach",
            ...proofOwnerBase(),
            inputs: [
              {
                kind: inferAttachedProofKind(attachedPath),
                title,
                ...(caption ? { description: caption } : {}),
                path: attachedPath,
              },
            ],
          }),
        ),
      ],
    };
  }
  if (sub === "screenshot" || sub === "capture") {
    const caption = readValue(args, ["--caption", "--description", "--desc"]);
    return {
      kind: "execute",
      label: "computer-use screenshot",
      steps: [
        actionCallStep(
          "result",
          "screenshot_environment",
          collectGenericObjectArgs(args, {
            ...proofOwnerBase(),
            name: readValue(args, ["--name", "--title"]) ?? caption,
          }),
        ),
      ],
      preferHeadless: true,
    };
  }
  if (sub === "record")
    return {
      kind: "execute",
      label: "computer-use record",
      steps: [
        actionCallStep(
          "result",
          "record_environment",
          collectGenericObjectArgs(args, {
            ...proofOwnerBase(),
            name:
              readValue(args, ["--name", "--title"]) ??
              readValue(args, ["--caption", "--description", "--desc"]),
            durationSec: readNumberOption(args, [
              "--seconds",
              "--duration-sec",
            ]),
          }),
        ),
      ],
      preferHeadless: true,
    };
  if (sub === "launch")
    return {
      kind: "execute",
      label: "computer-use launch",
      steps: [
        actionCallStep(
          "result",
          "launch_app",
          collectGenericObjectArgs(args, {
            app: readValue(args, ["--app"]) ?? firstPositional(args),
          }),
        ),
      ],
      preferHeadless: true,
    };
  if (sub === "interact")
    return {
      kind: "execute",
      label: "computer-use interact",
      steps: [
        actionCallStep(
          "result",
          "interact_gui",
          collectGenericObjectArgs(args, proofOwnerBase()),
        ),
      ],
      preferHeadless: true,
    };
  return {
    kind: "execute",
    label: `proof ${sub}`,
    steps: [
      actionStep(
        "result",
        "computer_use_artifacts",
        sub,
        collectGenericObjectArgs(args),
      ),
    ],
  };
}

function buildIosSimulatorPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "help")
    return { kind: "help", text: buildIosSimulatorHelp(args) };
  const numericPositionals = () =>
    args.filter((value) => /^\d+(\.\d+)?$/.test(value));
  const readCoordinate = (flag: string, index: number): number => {
    const value =
      readNumberOption(args, [flag]) ?? Number(numericPositionals()[index]);
    if (!Number.isFinite(value))
      throw new CliUsageError(`${flag} is required and must be a number.`);
    return value;
  };
  if (sub === "actions")
    return {
      kind: "execute",
      label: "iOS simulator actions",
      steps: [listActionsStep("actions", "ios_simulator")],
    };
  if (sub === "status")
    return {
      kind: "execute",
      label: "iOS simulator status",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "getStatus",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "devices" || sub === "list" || sub === "ls")
    return {
      kind: "execute",
      label: "iOS simulator devices",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "listDevices",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "claim") {
    const claimArgs = readRequiredToolClaimArgs(args, "iOS simulator");
    return {
      kind: "execute",
      label: "iOS simulator claim",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "claim",
          collectGenericObjectArgs(args, claimArgs),
        ),
      ],
    };
  }
  if (
    sub === "apps" ||
    sub === "targets" ||
    sub === "launchable" ||
    sub === "launchables"
  ) {
    return {
      kind: "execute",
      label: "iOS simulator launchable apps",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "listLaunchTargets",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
            projectRoot: readValue(args, ["--project-root", "--root"]),
          }),
        ),
      ],
    };
  }
  if (sub === "launch" || sub === "open") {
    const claimArgs = readToolClaimArgs(args);
    const keepSimulatorInBackground = readFlag(args, ["--background", "--keep-background"]);
    const openSimulator = readFlag(args, ["--foreground", "--open-simulator"]);
    const launchArgs: JsonObject = {
      deviceUdid: readValue(args, ["--device", "--udid"]),
      projectRoot: readValue(args, ["--project-root", "--root"]),
      laneId: claimArgs.laneId,
      targetId: readValue(args, ["--target", "--target-id"]),
      bundleId: readValue(args, ["--bundle-id", "--bundle"]),
      appBundlePath: readValue(args, ["--app-bundle", "--app"]),
      projectPath: readValue(args, ["--project", "--xcodeproj"]),
      scheme: readValue(args, ["--scheme"]),
      chatSessionId: claimArgs.chatSessionId,
      build: !readFlag(args, ["--no-build"]),
      mode: readValue(args, ["--mode"]) ?? "live",
    };
    if (keepSimulatorInBackground) {
      launchArgs.keepSimulatorInBackground = true;
    } else if (openSimulator) {
      launchArgs.keepSimulatorInBackground = false;
    }
    return {
      kind: "execute",
      label: "iOS simulator launch",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "launch",
          collectGenericObjectArgs(args, launchArgs),
        ),
      ],
    };
  }
  if (sub === "screenshot" || sub === "capture") {
    return {
      kind: "execute",
      label: "iOS simulator screenshot",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "screenshot",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
          }),
        ),
      ],
    };
  }
  if (sub === "inspector") {
    return {
      kind: "execute",
      label: "iOS simulator inspector snapshot",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "getInspectorSnapshot",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
          }),
        ),
      ],
    };
  }
  if (sub === "preview-status" || sub === "preview-doctor") {
    return {
      kind: "execute",
      label: "iOS simulator preview status",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "getPreviewCapability",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
            sourceFile: readValue(args, ["--source", "--file"]),
            sourceLine: readNumberOption(args, ["--line"]),
          }),
        ),
      ],
    };
  }
  if (sub === "previews" || sub === "preview-list" || sub === "list-previews") {
    return {
      kind: "execute",
      label: "iOS simulator previews",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "listPreviewTargets",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
            sourceFile: readValue(args, ["--source", "--file"]),
            sourceLine: readNumberOption(args, ["--line"]),
          }),
        ),
      ],
    };
  }
  if (
    sub === "preview-match" ||
    sub === "match-preview" ||
    sub === "resolve-preview"
  ) {
    return {
      kind: "execute",
      label: "iOS simulator preview match",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "resolvePreviewMatch",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
            sourceFile: readValue(args, ["--source", "--file"]),
            sourceLine: readNumberOption(args, ["--line"]),
            elementLabel: readValue(args, ["--label"]),
            componentId: readValue(args, ["--component-id", "--component"]),
          }),
        ),
      ],
    };
  }
  if (
    sub === "preview-ensure" ||
    sub === "ensure-preview" ||
    sub === "preview-workspace"
  ) {
    return {
      kind: "execute",
      label: "iOS simulator preview workspace",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "ensurePreviewWorkspace",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
            sourceFile: readValue(args, ["--source", "--file"]),
            sourceLine: readNumberOption(args, ["--line"]),
            openIfNeeded: readFlag(args, ["--no-open"]) ? false : undefined,
            timeoutMs: readNumberOption(args, ["--timeout-ms"]),
          }),
        ),
      ],
    };
  }
  if (
    sub === "preview-render" ||
    sub === "render-preview" ||
    sub === "preview"
  ) {
    return {
      kind: "execute",
      label: "iOS simulator preview render",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "renderPreview",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
            sourceFilePath: requireValue(
              readValue(args, ["--source", "--file"]),
              "sourceFilePath",
            ),
            previewDefinitionIndexInFile: readNumberOption(
              args,
              ["--index"],
              0,
            ),
            tabIdentifier: readValue(args, ["--tab", "--tab-identifier"]),
            timeoutSec: readNumberOption(args, ["--timeout"], 120),
          }),
        ),
      ],
    };
  }
  if (
    sub === "preview-current" ||
    sub === "current-preview" ||
    sub === "preview-open-current" ||
    sub === "open-current-preview" ||
    sub === "render-current-preview"
  ) {
    return {
      kind: "execute",
      label: "iOS simulator current preview render",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "renderCurrentPreview",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
            sourceFile: readValue(args, ["--source", "--file"]),
            sourceLine: readNumberOption(args, ["--line"]),
            elementLabel: readValue(args, ["--label"]),
            componentId: readValue(args, ["--component-id", "--component"]),
            tabIdentifier: readValue(args, ["--tab", "--tab-identifier"]),
            timeoutSec: readNumberOption(args, ["--timeout"], 120),
          }),
        ),
      ],
    };
  }
  if (
    sub === "preview-open" ||
    sub === "open-preview-workspace" ||
    sub === "open-xcode"
  ) {
    return {
      kind: "execute",
      label: "iOS simulator preview open",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "openPreviewWorkspace",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
          }),
        ),
      ],
    };
  }
  if (sub === "snapshot" || sub === "screen" || sub === "elements") {
    return {
      kind: "execute",
      label: "iOS simulator screen snapshot",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "getScreenSnapshot",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
            projectRoot: readValue(args, ["--project-root", "--root"]),
          }),
        ),
      ],
    };
  }
  if (sub === "inspect" || sub === "hit-test" || sub === "hover") {
    return {
      kind: "execute",
      label: "iOS simulator inspect point",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "inspectPoint",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
            projectRoot: readValue(args, ["--project-root", "--root"]),
            x: readCoordinate("--x", 0),
            y: readCoordinate("--y", 1),
            includeScreenshot: readFlag(args, [
              "--screenshot",
              "--include-screenshot",
            ]),
          }),
        ),
      ],
    };
  }
  if (
    sub === "stream-start" ||
    sub === "start-stream" ||
    sub === "stream" ||
    sub === "live-start" ||
    sub === "start-live" ||
    sub === "preview-start" ||
    sub === "start-preview" ||
    sub === "window-start" ||
    sub === "start-window" ||
    sub === "mirror-start" ||
    sub === "start-mirror"
  ) {
    const backendFlag = readValue(args, ["--backend"]);
    if (backendFlag && backendFlag !== "auto" && backendFlag !== "simulator-window-capture") {
      throw new Error("ios-sim live-start received an unsupported live view option.");
    }
    const requestedBackend = backendFlag ?? "simulator-window-capture";
    return {
      kind: "execute",
      label: "iOS simulator live view start",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "startStream",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
            fps: readNumberOption(args, ["--fps"], 60),
            backend: requestedBackend,
          }),
        ),
      ],
    };
  }
  if (
    sub === "stream-stop" ||
    sub === "stop-stream" ||
    sub === "live-stop" ||
    sub === "stop-live" ||
    sub === "preview-stop" ||
    sub === "stop-preview"
  ) {
    return {
      kind: "execute",
      label: "iOS simulator live view stop",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "stopStream",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "stream-status") {
    return {
      kind: "execute",
      label: "iOS simulator live view status",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "getStreamStatus",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "tap") {
    return {
      kind: "execute",
      label: "iOS simulator tap",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "tap",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
            projectRoot: readValue(args, ["--project-root", "--root"]),
            x: readCoordinate("--x", 0),
            y: readCoordinate("--y", 1),
          }),
        ),
      ],
    };
  }
  if (sub === "drag" || sub === "swipe") {
    return {
      kind: "execute",
      label: `iOS simulator ${sub}`,
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          sub,
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
            projectRoot: readValue(args, ["--project-root", "--root"]),
            startX: readCoordinate("--start-x", 0),
            startY: readCoordinate("--start-y", 1),
            endX: readCoordinate("--end-x", 2),
            endY: readCoordinate("--end-y", 3),
            durationMs: readNumberOption(args, ["--duration-ms", "--duration"]),
          }),
        ),
      ],
    };
  }
  if (sub === "select") {
    return {
      kind: "execute",
      label: "iOS simulator select",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "selectPoint",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
            projectRoot: readValue(args, ["--project-root", "--root"]),
            x: readCoordinate("--x", 0),
            y: readCoordinate("--y", 1),
          }),
        ),
      ],
    };
  }
  if (sub === "type" || sub === "text") {
    return {
      kind: "execute",
      label: "iOS simulator type",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "typeText",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
            projectRoot: readValue(args, ["--project-root", "--root"]),
            text: requireValue(
              readValue(args, ["--value", "--message", "--input-text"]) ??
                readCommandTextValue(args, ["--text"]) ??
                args.filter((arg) => arg !== "--text").join(" "),
              "text",
            ),
          }),
        ),
      ],
    };
  }
  if (
    sub === "shutdown" ||
    sub === "stop" ||
    sub === "teardown" ||
    sub === "end" ||
    sub === "end-session"
  ) {
    return {
      kind: "execute",
      label: "iOS simulator shutdown",
      steps: [
        actionStep(
          "result",
          "ios_simulator",
          "shutdown",
          collectGenericObjectArgs(args, {
            deviceUdid: readValue(args, ["--device", "--udid"]),
            force: readFlag(args, ["--force", "-f"]) ? true : undefined,
          }),
        ),
      ],
    };
  }
  return {
    kind: "execute",
    label: `ios-sim ${sub}`,
    steps: [
      actionStep(
        "result",
        "ios_simulator",
        sub,
        collectGenericObjectArgs(args),
      ),
    ],
  };
}

function readTrailingCommand(args: string[]): string | null {
  const index = args.indexOf("--");
  if (index < 0) return null;
  const tokens = args.slice(index + 1);
  args.splice(index);
  if (tokens.length === 0) return null;
  // Preserve quoted-token boundaries by shell-escaping each token before
  // joining. The downstream consumer (appControlService) shell-parses this
  // string, so naive `join(" ")` would let `--flag "a b"` be re-tokenized as
  // three args. Shell-escaping per token preserves the original boundaries.
  const command = tokens.map(shellEscapeToken).join(" ").trim();
  return command.length ? command : null;
}

function buildAppControlPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "help") return { kind: "help", text: buildAppControlHelp(args) };
  const numericPositionals = () =>
    args.filter((value) => /^\d+(\.\d+)?$/.test(value));
  const readCoordinate = (flag: string, index: number): number => {
    const value =
      readNumberOption(args, [flag]) ?? Number(numericPositionals()[index]);
    if (!Number.isFinite(value))
      throw new CliUsageError(`${flag} is required and must be a number.`);
    return value;
  };
  if (sub === "actions")
    return {
      kind: "execute",
      label: "App Control actions",
      steps: [listActionsStep("actions", "app_control")],
    };
  if (sub === "status")
    return {
      kind: "execute",
      label: "App Control status",
      steps: [
        actionStep(
          "result",
          "app_control",
          "getStatus",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "logs" || sub === "log" || sub === "read" || sub === "tail") {
    return {
      kind: "execute",
      label: "terminal read",
      steps: [
        actionStep(
          "result",
          "app_control",
          "readTerminal",
          collectGenericObjectArgs(args, {
            maxBytes: readIntOption(args, ["--max-bytes"], undefined),
            since: readIntOption(args, ["--since"], undefined),
          }),
        ),
      ],
    };
  }
  if (sub === "claim") {
    const claimArgs = readRequiredToolClaimArgs(args, "App Control");
    return {
      kind: "execute",
      label: "App Control claim",
      steps: [
        actionStep(
          "result",
          "app_control",
          "claim",
          collectGenericObjectArgs(args, claimArgs),
        ),
      ],
    };
  }
  if (sub === "terminal") {
    const mode = firstPositional(args) ?? "read";
    if (mode === "read" || mode === "logs" || mode === "tail") {
      return {
        kind: "execute",
        label: "terminal read",
        steps: [
          actionStep(
            "result",
            "app_control",
            "readTerminal",
            collectGenericObjectArgs(args, {
              maxBytes: readIntOption(args, ["--max-bytes"], undefined),
              since: readIntOption(args, ["--since"], undefined),
            }),
          ),
        ],
      };
    }
    if (mode === "write" || mode === "send" || mode === "input") {
      const data =
        readValue(args, ["--data", "--value", "--text"]) ?? args.join(" ");
      if (!data.length) throw new CliUsageError("data is required.");
      return {
        kind: "execute",
        label: "terminal write",
        steps: [
          actionStep(
            "result",
            "app_control",
            "writeTerminal",
            collectGenericObjectArgs(args, { data }),
          ),
        ],
      };
    }
    if (mode === "signal" || mode === "interrupt" || mode === "stop") {
      return {
        kind: "execute",
        label: "terminal signal",
        steps: [
          actionStep(
            "result",
            "app_control",
            "signalTerminal",
            collectGenericObjectArgs(args, {
              signal:
                readValue(args, ["--signal"]) ??
                (mode === "stop" ? "SIGTERM" : "SIGINT"),
            }),
          ),
        ],
      };
    }
    throw new CliUsageError(
      "app-control terminal supports read, write, or signal.",
    );
  }
  if (sub === "launch" || sub === "open" || sub === "start") {
    const claimArgs = readToolClaimArgs(args);
    const trailingCommand = readTrailingCommand(args);
    const command = readValue(args, ["--command", "--cmd"]) ?? trailingCommand;
    const appKind = readValue(args, ["--kind", "--app-kind"]) ?? "electron";
    const projectRoot = readValue(args, ["--project-root", "--root"]);
    const laneId = claimArgs.laneId;
    const cwd = readValue(args, ["--cwd", "--working-directory"]);
    const debugPort = readNumberOption(args, ["--debug-port", "--port"]);
    const cdpPort = readNumberOption(args, ["--cdp-port"]);
    const label = readValue(args, ["--label", "--name"]);
    const chatSessionId = claimArgs.chatSessionId;
    const force = readFlag(args, ["--force", "-f"]) ? true : undefined;
    const positionalCommand = args
      .filter((arg) => arg !== "--" && !arg.startsWith("-"))
      .join(" ")
      .trim();
    const launchCommand =
      command ?? (positionalCommand.length ? positionalCommand : null);
    if (!launchCommand)
      throw new CliUsageError(
        'app-control launch requires a command, for example: ade app-control launch --command "pnpm dev".',
      );
    return {
      kind: "execute",
      label: "App Control launch",
      steps: [
        actionStep(
          "result",
          "app_control",
          "launch",
          collectGenericObjectArgs(args, {
            appKind,
            projectRoot,
            laneId,
            command: launchCommand,
            cwd,
            debugPort,
            cdpPort,
            label,
            chatSessionId,
            force,
          }),
        ),
      ],
    };
  }
  if (sub === "connect" || sub === "attach") {
    const claimArgs = readToolClaimArgs(args);
    return {
      kind: "execute",
      label: "App Control connect",
      steps: [
        actionStep(
          "result",
          "app_control",
          "connect",
          collectGenericObjectArgs(args, {
            appKind: readValue(args, ["--kind", "--app-kind"]) ?? "electron",
            projectRoot: readValue(args, ["--project-root", "--root"]),
            laneId: claimArgs.laneId,
            cdpPort:
              readNumberOption(args, ["--cdp-port", "--port"]) ??
              Number(numericPositionals()[0]),
            label: readValue(args, ["--label", "--name"]),
            chatSessionId: claimArgs.chatSessionId,
            force: readFlag(args, ["--force", "-f"]) ? true : undefined,
          }),
        ),
      ],
    };
  }
  if (sub === "targets" || sub === "list-targets") {
    return {
      kind: "execute",
      label: "App Control targets",
      steps: [
        actionStep(
          "result",
          "app_control",
          "listTargets",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "attach-target" || sub === "target") {
    const targetId = requireValue(
      readValue(args, ["--target", "--target-id"]) ?? firstPositional(args),
      "targetId",
    );
    return {
      kind: "execute",
      label: "App Control attach target",
      steps: [
        actionArgsListStep("result", "app_control", "attachToTarget", [
          targetId,
        ]),
      ],
    };
  }
  if (
    sub === "stop" ||
    sub === "shutdown" ||
    sub === "teardown" ||
    sub === "close"
  ) {
    return {
      kind: "execute",
      label: "App Control stop",
      steps: [
        actionStep(
          "result",
          "app_control",
          "stop",
          collectGenericObjectArgs(args, {
            force: readFlag(args, ["--force", "-f"]) ? true : undefined,
          }),
        ),
      ],
    };
  }
  if (sub === "focus" || sub === "reveal" || sub === "front") {
    return {
      kind: "execute",
      label: "App Control focus window",
      steps: [
        actionStep(
          "result",
          "app_control",
          "focusWindow",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "minimize" || sub === "hide") {
    return {
      kind: "execute",
      label: "App Control minimize window",
      steps: [
        actionStep(
          "result",
          "app_control",
          "minimizeWindow",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "screenshot" || sub === "capture") {
    return {
      kind: "execute",
      label: "App Control screenshot",
      steps: [
        actionStep(
          "result",
          "app_control",
          "screenshot",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "snapshot" || sub === "screen" || sub === "elements") {
    return {
      kind: "execute",
      label: "App Control snapshot",
      steps: [
        actionStep(
          "result",
          "app_control",
          "getSnapshot",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
            coordinateSpace: readValue(args, ["--coordinate-space", "--coords"]),
          }),
        ),
      ],
    };
  }
  if (sub === "inspect" || sub === "hit-test" || sub === "hover") {
    return {
      kind: "execute",
      label: "App Control inspect point",
      steps: [
        actionStep(
          "result",
          "app_control",
          "inspectPoint",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
            x: readCoordinate("--x", 0),
            y: readCoordinate("--y", 1),
            scale: readNumberOption(args, ["--scale"]),
            coordinateSpace: readValue(args, ["--coordinate-space", "--coords"]),
            includeScreenshot: readFlag(args, [
              "--screenshot",
              "--include-screenshot",
            ]),
          }),
        ),
      ],
    };
  }
  if (sub === "select") {
    return {
      kind: "execute",
      label: "App Control select",
      steps: [
        actionStep(
          "result",
          "app_control",
          "selectPoint",
          collectGenericObjectArgs(args, {
            projectRoot: readValue(args, ["--project-root", "--root"]),
            x: readCoordinate("--x", 0),
            y: readCoordinate("--y", 1),
            scale: readNumberOption(args, ["--scale"]),
            coordinateSpace: readValue(args, ["--coordinate-space", "--coords"]),
          }),
        ),
      ],
    };
  }
  if (sub === "click" || sub === "tap") {
    return {
      kind: "execute",
      label: "App Control click",
      steps: [
        actionStep(
          "result",
          "app_control",
          "click",
          collectGenericObjectArgs(args, {
            x: readCoordinate("--x", 0),
            y: readCoordinate("--y", 1),
            scale: readNumberOption(args, ["--scale"]),
            coordinateSpace: readValue(args, ["--coordinate-space", "--coords"]),
          }),
        ),
      ],
    };
  }
  if (sub === "scroll" || sub === "wheel") {
    return {
      kind: "execute",
      label: "App Control scroll",
      steps: [
        actionStep(
          "result",
          "app_control",
          "scroll",
          collectGenericObjectArgs(args, {
            x: readCoordinate("--x", 0),
            y: readCoordinate("--y", 1),
            deltaX: readNumberOption(args, ["--delta-x", "--dx"]) ?? 0,
            deltaY: readNumberOption(args, ["--delta-y", "--dy"]) ?? 0,
            scale: readNumberOption(args, ["--scale"]),
            coordinateSpace: readValue(args, ["--coordinate-space", "--coords"]),
          }),
        ),
      ],
    };
  }
  if (sub === "key" || sub === "dispatch-key") {
    const key = readValue(args, ["--key"]) ?? firstPositional(args);
    return {
      kind: "execute",
      label: "App Control key",
      steps: [
        actionStep(
          "result",
          "app_control",
          "dispatchKey",
          collectGenericObjectArgs(args, {
            type: readValue(args, ["--event-type", "--type"]) ?? "keyDown",
            key: requireValue(key, "key"),
            code: readValue(args, ["--code"]),
            text: readValue(args, ["--text"]),
            modifiers: readNumberOption(args, ["--modifiers"]),
          }),
        ),
      ],
    };
  }
  if (sub === "type" || sub === "text") {
    return {
      kind: "execute",
      label: "App Control type",
      steps: [
        actionStep(
          "result",
          "app_control",
          "typeText",
          collectGenericObjectArgs(args, {
            text: requireValue(
              readValue(args, ["--value", "--message", "--input-text"]) ??
                readCommandTextValue(args, ["--text"]) ??
                args.filter((arg) => arg !== "--text").join(" "),
              "text",
            ),
          }),
        ),
      ],
    };
  }
  return {
    kind: "execute",
    label: `app-control ${sub}`,
    steps: [
      actionStep("result", "app_control", sub, collectGenericObjectArgs(args)),
    ],
  };
}

const BROWSER_SESSION_ACTION_MODES = new Set([
  "observe",
  "snapshot",
  "click",
  "type",
  "type-text",
  "fill",
  "clear",
  "clear-field",
  "clear-input",
  "clear-value",
  "key",
  "press",
  "dispatch-key",
  "scroll",
  "wheel",
  "wait",
  "wait-for",
  "trace",
  "action-trace",
  "timeline",
  "proof",
  "promote",
  "reload",
  "refresh",
  "back",
  "forward",
  "screenshot",
  "capture",
  "select",
  "select-point",
  "point",
]);

function isBrowserSessionActionMode(value: string): boolean {
  return BROWSER_SESSION_ACTION_MODES.has(value);
}

function buildBrowserPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "help") return { kind: "help", text: HELP_BY_COMMAND.browser };
  if (sub === "actions")
    return {
      kind: "execute",
      label: "browser actions",
      steps: [listActionsStep("actions", "built_in_browser")],
    };
  if (sub === "authorize" || sub === "approve-origin" || sub === "request-access") {
    return {
      kind: "execute",
      label: "browser origin access",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "requestOriginAccess",
          collectGenericObjectArgs(args, readBrowserOwnedTabTargetArgs(args)),
        ),
      ],
    };
  }
  if (sub === "status" || sub === "tabs" || sub === "list") {
    return {
      kind: "execute",
      label: "browser status",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "getStatus",
          collectGenericObjectArgs(args, readBrowserOwnedTabTargetArgs(args)),
        ),
      ],
    };
  }
  if (sub === "session" || sub === "sessions") {
    const mode = sub === "sessions" ? "list" : firstPositional(args) ?? "list";
    if (mode === "start" || mode === "begin" || mode === "claim") {
      return {
        kind: "execute",
        label: "browser session start",
        steps: [
          actionStep(
            "result",
            "built_in_browser",
            "startSession",
            collectGenericObjectArgs(args, readBrowserSessionStartArgs(args)),
          ),
        ],
      };
    }
    if (mode === "end" || mode === "stop" || mode === "close") {
      const explicitSessionId = readValue(args, ["--browser-session", "--browser-session-id"]);
      const genericArgs = collectGenericObjectArgs(args, readBrowserOwnedTabTargetArgs(args));
      const genericSessionId = typeof genericArgs.sessionId === "string" ? genericArgs.sessionId : null;
      return {
        kind: "execute",
        label: "browser session end",
        steps: [
          actionStep("result", "built_in_browser", "endSession", {
            sessionId: requireValue(
              explicitSessionId ?? genericSessionId ?? firstPositional(args),
              "sessionId",
            ),
            ...genericArgs,
          }),
        ],
      };
    }
    if (mode === "list" || mode === "ls" || mode === "status") {
      return {
        kind: "execute",
        label: "browser sessions",
        steps: [
          actionStep(
            "result",
            "built_in_browser",
            "listSessions",
            collectGenericObjectArgs(args, readBrowserSessionsArgs(args)),
          ),
        ],
      };
    }
    if (isBrowserSessionActionMode(mode)) {
      const explicitSessionId = readValue(args, ["--browser-session", "--browser-session-id"]);
      const sessionId = requireValue(explicitSessionId ?? firstPositional(args), "sessionId");
      return buildBrowserPlan([mode, "--browser-session", sessionId, ...args]);
    }
    throw new CliUsageError(`Unknown browser session command: ${mode}`);
  }
  if (sub === "claim") {
    const claimArgs: JsonObject = readRequiredToolClaimArgs(args, "browser");
    Object.assign(claimArgs, readBrowserTabTargetArgs(args));
    Object.assign(claimArgs, readBrowserLeaseArgs(args));
    return {
      kind: "execute",
      label: "browser claim",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "claim",
          collectGenericObjectArgs(args, claimArgs),
        ),
      ],
    };
  }
  if (
    sub === "panel" ||
    sub === "show" ||
    sub === "open-panel" ||
    sub === "reveal"
  ) {
    const panelArgs: JsonObject = {};
    Object.assign(panelArgs, readExplicitToolClaimArgs(args));
    Object.assign(panelArgs, readBrowserLeaseArgs(args));
    maybePut(panelArgs, "url", readValue(args, ["--url"]));
    maybePut(panelArgs, "tabId", readValue(args, ["--tab", "--tab-id"]));
    return {
      kind: "execute",
      label: "browser panel",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "showPanel",
          collectGenericObjectArgs(args, panelArgs),
        ),
      ],
    };
  }
  if (sub === "open" || sub === "navigate" || sub === "go") {
    const explicitUrl = readValue(args, ["--url"]);
    const tabId = readValue(args, ["--tab", "--tab-id"]);
    const activeTab = readFlag(args, [
      "--active-tab",
      "--current-tab",
      "--same-tab",
    ]);
    const newTab = readFlag(args, ["--new-tab"]);
    const showPanel = readFlag(args, ["--panel", "--show-panel", "--reveal-panel"]);
    const noPanel = readFlag(args, ["--no-panel", "--hidden"]);
    const claimArgs = {
      ...readToolClaimArgs(args),
      ...readBrowserLeaseArgs(args),
    };
    const genericArgs = collectGenericObjectArgs(args);
    const genericUrl =
      typeof genericArgs.url === "string" ? genericArgs.url : null;
    const url = explicitUrl ?? genericUrl ?? args.join(" ");
    if (!url.trim()) throw new CliUsageError("browser open requires a URL.");
    const autoReuseOwnedTab =
      !newTab && !activeTab && !tabId && Boolean(claimArgs.laneId || claimArgs.chatSessionId);
    const agentOwnedCall = Boolean(claimArgs.laneId || claimArgs.chatSessionId);
    return {
      kind: "execute",
      label: "browser open",
      steps: [
        actionStep("result", "built_in_browser", "navigate", {
          url,
          tabId,
          newTab: newTab && !activeTab ? true : undefined,
          activate: agentOwnedCall && !activeTab && !showPanel ? false : undefined,
          reuseOwnedTab: autoReuseOwnedTab ? true : undefined,
          openPanel: showPanel || (!noPanel && !agentOwnedCall),
          ...claimArgs,
          ...genericArgs,
        }),
      ],
    };
  }
  if (sub === "new-tab" || sub === "tab" || sub === "new") {
    const background = readFlag(args, ["--background"]);
    const showPanel = readFlag(args, ["--panel", "--show-panel", "--reveal-panel"]);
    const noPanel = readFlag(args, ["--no-panel", "--hidden"]);
    const explicitUrl = readValue(args, ["--url"]);
    const claimArgs = {
      ...readToolClaimArgs(args),
      ...readBrowserLeaseArgs(args),
    };
    const genericArgs = collectGenericObjectArgs(args);
    const genericUrl =
      typeof genericArgs.url === "string" ? genericArgs.url : null;
    const url =
      explicitUrl ?? genericUrl ?? (args.length ? args.join(" ") : undefined);
    return {
      kind: "execute",
      label: "browser new tab",
      steps: [
        actionStep("result", "built_in_browser", "createTab", {
          url,
          activate: background || (Boolean(claimArgs.laneId || claimArgs.chatSessionId) && !showPanel) ? false : undefined,
          openPanel: showPanel || (!noPanel && !claimArgs.laneId && !claimArgs.chatSessionId),
          ...claimArgs,
          ...genericArgs,
        }),
      ],
    };
  }
  if (sub === "switch" || sub === "activate") {
    const noPanel = readFlag(args, ["--no-panel", "--hidden"]);
    const explicitTabId = readValue(args, ["--tab", "--tab-id"]);
    const claimArgs = {
      ...readExplicitToolClaimArgs(args),
      ...readBrowserLeaseArgs(args),
    };
    const genericArgs = collectGenericObjectArgs(args);
    const genericTabId =
      typeof genericArgs.tabId === "string" ? genericArgs.tabId : null;
    return {
      kind: "execute",
      label: "browser switch",
      steps: [
        actionStep("result", "built_in_browser", "switchTab", {
          tabId: requireValue(
            explicitTabId ?? genericTabId ?? firstPositional(args),
            "tabId",
          ),
          openPanel: !noPanel,
          ...claimArgs,
          ...genericArgs,
        }),
      ],
    };
  }
  if (sub === "close" || sub === "close-tab") {
    const explicitTabId = readValue(args, ["--tab", "--tab-id"]);
    const genericArgs = collectGenericObjectArgs(args, readBrowserOwnedTabTargetArgs(args));
    const genericTabId =
      typeof genericArgs.tabId === "string" ? genericArgs.tabId : null;
    return {
      kind: "execute",
      label: "browser close",
      steps: [
        actionStep("result", "built_in_browser", "closeTab", {
          tabId: requireValue(
            explicitTabId ?? genericTabId ?? firstPositional(args),
            "tabId",
          ),
          ...genericArgs,
        }),
      ],
    };
  }
  if (sub === "observe" || sub === "snapshot")
    return {
      kind: "execute",
      label: "browser observe",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "observe",
          collectGenericObjectArgs(args, readBrowserObservationArgs(args)),
        ),
      ],
    };
  if (sub === "click") {
    const x = readNumberOption(args, ["--x"]);
    const y = readNumberOption(args, ["--y"]);
    const targetArgs = readBrowserClickTargetArgs(args);
    const hasCoordinates = x != null || y != null;
    if (hasCoordinates && (x == null || y == null)) {
      throw new CliUsageError("browser click requires both --x and --y when using coordinates.");
    }
    if (!hasCoordinates && Object.keys(targetArgs).length === 0) {
      throw new CliUsageError("browser click requires --x/--y, --selector, --text-match, --test-id, --element, or --handle.");
    }
    return {
      kind: "execute",
      label: "browser click",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "click",
          collectGenericObjectArgs(args, {
            ...readBrowserAgentActionArgs(args),
            ...(x == null ? {} : { x }),
            ...(y == null ? {} : { y }),
            ...targetArgs,
            button: readValue(args, ["--button"]),
            clickCount: readNumberOption(args, ["--click-count", "--count"]),
          }),
        ),
      ],
    };
  }
  if (sub === "type" || sub === "type-text") {
    const actionArgs = readBrowserAgentActionArgs(args);
    const text = readValue(args, ["--text"]) ?? args.join(" ");
    if (!text.trim()) throw new CliUsageError("browser type requires text.");
    return {
      kind: "execute",
      label: "browser type",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "typeText",
          collectGenericObjectArgs(args, {
            ...actionArgs,
            text,
          }),
        ),
      ],
    };
  }
  if (sub === "fill") {
    const actionArgs = readBrowserAgentActionArgs(args);
    const targetArgs = readBrowserClickTargetArgs(args);
    if (Object.keys(targetArgs).length === 0) {
      throw new CliUsageError("browser fill requires --selector, --text-match, --test-id, --element, or --handle.");
    }
    const explicitValue = readValue(args, ["--value"]);
    const text = explicitValue ?? args.join(" ");
    if (explicitValue == null && !text.length) throw new CliUsageError("browser fill requires text.");
    const fillPayloadKey = typeof targetArgs.text === "string" ? "value" : "text";
    return {
      kind: "execute",
      label: "browser fill",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "fill",
          collectGenericObjectArgs(args, {
            ...actionArgs,
            ...targetArgs,
            [fillPayloadKey]: text,
          }),
        ),
      ],
    };
  }
  if (
    sub === "clear-field" ||
    sub === "clear-input" ||
    sub === "clear-value" ||
    (sub === "clear" && hasBrowserClickTargetFlag(args))
  ) {
    const actionArgs = readBrowserAgentActionArgs(args);
    const targetArgs = readBrowserClickTargetArgs(args);
    if (Object.keys(targetArgs).length === 0) {
      throw new CliUsageError("browser clear requires --selector, --text-match, --test-id, --element, or --handle.");
    }
    return {
      kind: "execute",
      label: "browser clear",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "clear",
          collectGenericObjectArgs(args, {
            ...actionArgs,
            ...targetArgs,
          }),
        ),
      ],
    };
  }
  if (sub === "key" || sub === "press" || sub === "dispatch-key") {
    const actionArgs = readBrowserAgentActionArgs(args);
    const targetArgs = readBrowserClickTargetArgs(args);
    const key = readValue(args, ["--key"]) ?? firstPositional(args);
    if (!key) throw new CliUsageError("browser key requires a key.");
    return {
      kind: "execute",
      label: "browser key",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "dispatchKey",
          collectGenericObjectArgs(args, {
            ...actionArgs,
            ...targetArgs,
            key,
          }),
        ),
      ],
    };
  }
  if (sub === "scroll" || sub === "wheel") {
    const deltaX = readNumberOption(args, ["--dx", "--delta-x"]) ?? 0;
    const deltaY = readNumberOption(args, ["--dy", "--delta-y"]) ?? 0;
    if (deltaX === 0 && deltaY === 0)
      throw new CliUsageError("browser scroll requires --dy or --dx.");
    return {
      kind: "execute",
      label: "browser scroll",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "scroll",
          collectGenericObjectArgs(args, {
            ...readBrowserAgentActionArgs(args),
            x: readNumberOption(args, ["--x"]),
            y: readNumberOption(args, ["--y"]),
            deltaX,
            deltaY,
          }),
        ),
      ],
    };
  }
  if (sub === "wait" || sub === "wait-for") {
    const actionArgs = readBrowserAgentActionArgs(args);
    const targetArgs = readBrowserClickTargetArgs(args);
    const url = readValue(args, ["--url"]);
    const loadState = readValue(args, ["--load-state", "--state"]) ?? (readFlag(args, ["--network-idle"]) ? "network-idle" : null);
    if (!url && !loadState && Object.keys(targetArgs).length === 0) {
      throw new CliUsageError("browser wait requires --selector, --text-match, --test-id, --element, --handle, --url, or --load-state.");
    }
    return {
      kind: "execute",
      label: "browser wait",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "wait",
          collectGenericObjectArgs(args, {
            ...actionArgs,
            ...targetArgs,
            ...(url ? { url } : {}),
            ...(loadState ? { loadState } : {}),
            timeoutMs: readNumberOption(args, ["--timeout-ms", "--timeout"]),
            networkIdleMs: readNumberOption(args, ["--network-idle-ms", "--idle-ms"]),
          }),
        ),
      ],
    };
  }
  if (sub === "trace" || sub === "action-trace" || sub === "timeline")
    return {
      kind: "execute",
      label: "browser trace",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "getTrace",
          collectGenericObjectArgs(args, readBrowserTraceArgs(args)),
        ),
      ],
    };
  if (sub === "proof" || sub === "promote") {
    const caption = readValue(args, ["--caption", "--description", "--desc"]);
    const title = readValue(args, ["--title", "--name"]) ?? caption ?? "ADE browser proof";
    const ownerBase = readProofOwnerBase(args);
    const observeArgs = collectGenericObjectArgs(args, {
      ...readBrowserObservationArgs(args),
      includeDom: false,
    });
    return {
      kind: "execute",
      label: "browser proof",
      steps: [
        actionStep("observation", "built_in_browser", "observe", observeArgs),
        {
          key: "result",
          method: "ade/actions/call",
          unwrapToolResult: true,
          params: (values) => {
            const observation = isRecord(values.observation) ? values.observation : {};
            const filePath = asString(observation.filePath);
            if (!filePath) {
              throw new CliUsageError("Browser proof could not find an observation file path.");
            }
            return {
              name: "ingest_computer_use_artifacts",
              arguments: {
                backendStyle: "manual",
                backendName: "ade-browser",
                toolName: "browser proof",
                ...ownerBase,
                inputs: [
                  {
                    kind: "screenshot",
                    title,
                    ...(caption ? { description: caption } : {}),
                    path: filePath,
                  },
                ],
              },
            };
          },
        },
      ],
    };
  }
  if (sub === "reload" || sub === "refresh")
    return {
      kind: "execute",
      label: "browser reload",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "reload",
          collectGenericObjectArgs(args, readBrowserOwnedTabTargetArgs(args)),
        ),
      ],
    };
  if (sub === "back")
    return {
      kind: "execute",
      label: "browser back",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "goBack",
          collectGenericObjectArgs(args, readBrowserOwnedTabTargetArgs(args)),
        ),
      ],
    };
  if (sub === "forward")
    return {
      kind: "execute",
      label: "browser forward",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "goForward",
          collectGenericObjectArgs(args, readBrowserOwnedTabTargetArgs(args)),
        ),
      ],
    };
  if (sub === "stop")
    return {
      kind: "execute",
      label: "browser stop",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "stop",
          collectGenericObjectArgs(args, readBrowserOwnedTabTargetArgs(args)),
        ),
      ],
    };
  if (sub === "screenshot" || sub === "capture")
    return {
      kind: "execute",
      label: "browser screenshot",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "captureScreenshot",
          collectGenericObjectArgs(args, readBrowserOwnedTabTargetArgs(args)),
        ),
      ],
    };
  if (sub === "select" || sub === "select-point" || sub === "point") {
    const x = readNumberOption(args, ["--x"]);
    const y = readNumberOption(args, ["--y"]);
    const targetArgs = readBrowserOwnedTabTargetArgs(args);
    if (x == null || y == null)
      throw new CliUsageError("browser select requires --x and --y.");
    return {
      kind: "execute",
      label: "browser selection",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "selectPoint",
          collectGenericObjectArgs(args, {
            ...targetArgs,
            x,
            y,
            includeScreenshot: readFlag(args, ["--no-screenshot"])
              ? false
              : undefined,
          }),
        ),
      ],
    };
  }
  if (sub === "inspect-start" || sub === "start-inspect" || sub === "inspect")
    return {
      kind: "execute",
      label: "browser inspect start",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "startInspect",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "inspect-stop" || sub === "stop-inspect")
    return {
      kind: "execute",
      label: "browser inspect stop",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "stopInspect",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "select-current" || sub === "selection" || sub === "selected")
    return {
      kind: "execute",
      label: "browser selection",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "selectCurrent",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  if (sub === "clear-selection" || sub === "clear")
    return {
      kind: "execute",
      label: "browser clear selection",
      steps: [
        actionStep(
          "result",
          "built_in_browser",
          "clearSelection",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  return {
    kind: "execute",
    label: `browser ${sub}`,
    steps: [
      actionStep(
        "result",
        "built_in_browser",
        sub,
        collectGenericObjectArgs(args),
      ),
    ],
  };
}

function buildSettingsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "get";
  if (sub === "pr-transcript-gists" || sub === "transcript-gists" || sub === "gist-transcripts") {
    const mode = (firstPositional(args) ?? "status").toLowerCase();
    if (mode === "status") {
      return {
        kind: "execute",
        label: "settings PR chat transcripts",
        steps: [
          actionStep("result", "project_config", "get"),
        ],
      };
    }
    if (mode === "enable" || mode === "on" || mode === "true") {
      return {
        kind: "execute",
        label: "enable PR chat transcripts",
        steps: [
          actionStep("result", "project_config", "setPrTranscriptGists", { enabled: true }),
        ],
      };
    }
    if (mode === "disable" || mode === "off" || mode === "false") {
      return {
        kind: "execute",
        label: "disable PR chat transcripts",
        steps: [
          actionStep("result", "project_config", "setPrTranscriptGists", { enabled: false }),
        ],
      };
    }
    throw new CliUsageError("settings pr-transcript-gists expects enable, disable, or status.");
  }
  if (sub === "actions")
    return {
      kind: "execute",
      label: "settings actions",
      steps: [listActionsStep("actions", "project_config")],
    };
  if (sub === "action")
    return {
      kind: "execute",
      label: "settings action",
      steps: [buildActionRunStep(["project_config", ...args])],
    };
  return {
    kind: "execute",
    label: `settings ${sub}`,
    steps: [
      actionStep(
        "result",
        "project_config",
        sub,
        collectGenericObjectArgs(args),
      ),
    ],
  };
}

function buildActionStatusArgs(
  args: string[],
  defaults: { waitForMs?: number } = {},
): JsonObject {
  const input: JsonObject = {};
  maybePut(
    input,
    "operationId",
    readValue(args, ["--operation", "--operation-id"]),
  );
  maybePut(
    input,
    "testRunId",
    readValue(args, ["--test-run", "--test-run-id"]),
  );
  maybePut(
    input,
    "chatSessionId",
    readValue(args, ["--chat-session", "--chat-session-id"]),
  );
  maybePut(input, "runId", readValue(args, ["--run", "--run-id"]));
  maybePut(input, "prId", readValue(args, ["--pr", "--pr-id"]));
  maybePut(input, "previousHash", readValue(args, ["--previous-hash"]));
  maybePut(
    input,
    "waitForMs",
    readIntOption(args, ["--wait-ms"], defaults.waitForMs),
  );
  maybePut(
    input,
    "pollIntervalMs",
    readIntOption(args, ["--poll-interval-ms"]),
  );
  return collectGenericObjectArgs(args, input);
}

function buildOperationsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "status" || sub === "show") {
    return {
      kind: "execute",
      label: "action status",
      steps: [
        actionCallStep(
          "result",
          "get_ade_action_status",
          buildActionStatusArgs(args),
        ),
      ],
    };
  }
  if (sub === "wait" || sub === "watch") {
    return {
      kind: "execute",
      label: "action status",
      steps: [
        actionCallStep(
          "result",
          "get_ade_action_status",
          buildActionStatusArgs(args, { waitForMs: 30_000 }),
        ),
      ],
    };
  }
  if (sub === "logs" || sub === "log") {
    throw new CliUsageError(
      "Generic operation logs are not available; use tests logs, run logs, terminal read, or app-control logs for log-owning surfaces.",
    );
  }
  throw new CliUsageError("operations supports status or wait.");
}

function buildUsagePlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "snapshot";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "usage actions",
      steps: [listActionsStep("actions", "usage")],
    };
  if (sub === "action")
    return {
      kind: "execute",
      label: "usage action",
      steps: [buildActionRunStep(["usage", ...args])],
    };
  if (sub === "snapshot" || sub === "get" || sub === "status") {
    return {
      kind: "execute",
      label: "usage snapshot",
      steps: [actionStep("result", "usage", "getUsageSnapshot", {})],
    };
  }
  if (sub === "refresh" || sub === "poll") {
    const history = args.includes("--history");
    return {
      kind: "execute",
      label: history ? "usage history refresh" : "usage refresh",
      steps: [actionStep("result", "usage", history ? "refreshHistory" : "forceRefresh", {})],
    };
  }
  if (sub === "budget") {
    const mode = firstPositional(args) ?? "get";
    if (mode === "get") {
      return {
        kind: "execute",
        label: "usage budget get",
        steps: [actionStep("result", "budget", "getConfig", {})],
      };
    }
    if (mode === "set" || mode === "update") {
      const text = readFileTextInput(args);
      let parsed: unknown;
      if (text != null) {
        const trimmed = text.trim();
        if (!trimmed.length) {
          throw new CliUsageError("Budget config must be a non-empty JSON object.");
        }
        try {
          parsed = JSON.parse(trimmed);
        } catch (error) {
          throw new CliUsageError(`Failed to parse budget config: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        parsed = collectGenericObjectArgs(args);
      }
      if (!isRecord(parsed)) throw new CliUsageError("Budget config must be a JSON object.");
      if (Object.keys(parsed).length === 0) throw new CliUsageError("Budget config must contain at least one field.");
      return {
        kind: "execute",
        label: "usage budget update",
        steps: [actionStep("result", "budget", "updateConfig", parsed as JsonObject)],
      };
    }
    if (mode === "check") {
      return {
        kind: "execute",
        label: "usage budget check",
        steps: [
          actionStep("result", "budget", "checkBudget", collectGenericObjectArgs(args, {
            scope: readValue(args, ["--scope"]) ?? "global",
            scopeId: readValue(args, ["--scope-id"]),
            provider: readValue(args, ["--provider"]) ?? "any",
          })),
        ],
      };
    }
    if (mode === "cumulative" || mode === "totals") {
      return {
        kind: "execute",
        label: "usage budget cumulative",
        steps: [
          actionStep("result", "budget", "getCumulativeUsage", collectGenericObjectArgs(args, {
            scope: readValue(args, ["--scope"]) ?? "global",
            scopeId: readValue(args, ["--scope-id"]),
            provider: readValue(args, ["--provider"]),
          })),
        ],
      };
    }
    throw new CliUsageError("usage budget supports get, set, check, or cumulative.");
  }
  return {
    kind: "execute",
    label: `usage ${sub}`,
    steps: [actionStep("result", "usage", sub, collectGenericObjectArgs(args))],
  };
}

function buildStoragePlan(args: string[]): CliPlan {
  if (hasHelpFlag(args)) {
    return { kind: "help", text: HELP_BY_COMMAND.storage ?? topLevelHelpText() };
  }
  const sub = firstPositional(args) ?? "snapshot";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "storage actions",
      steps: [listActionsStep("actions", "storage")],
    };
  if (sub === "action") {
    const action = requireValue(firstPositional(args), "storage action");
    return {
      kind: "execute",
      label: "storage action",
      steps: [buildActionRunStep(["storage", action, ...args])],
    };
  }
  if (sub === "snapshot" || sub === "get" || sub === "status" || sub === "scan") {
    const forceRefresh = readFlag(args, ["--refresh", "--force-refresh"]);
    return {
      kind: "execute",
      label: "storage snapshot",
      formatter: "storage-snapshot",
      steps: [
        actionStep(
          "result",
          "storage",
          "getSnapshot",
          forceRefresh ? { forceRefresh: true } : {},
        ),
      ],
    };
  }
  if (sub === "compress") {
    return {
      kind: "execute",
      label: "storage compress",
      formatter: "storage-compress",
      steps: [actionStep("result", "storage", "compressNow", {})],
    };
  }
  throw new CliUsageError(
    "storage supports snapshot, compress, actions, or action <name>. Use 'ade actions run storage.cleanupPreview' / 'storage.cleanup' for target-scoped cleanup.",
  );
}

function buildSecretsPlan(args: string[]): CliPlan {
  if (hasHelpFlag(args)) {
    return { kind: "help", text: HELP_BY_COMMAND.secrets ?? topLevelHelpText() };
  }
  const sub = firstPositional(args) ?? "list";
  if (sub === "list" || sub === "ls") {
    return {
      kind: "execute",
      label: "secrets list",
      formatter: "project-secrets",
      steps: [actionStep("result", "project_secret", "list", {})],
    };
  }
  if (sub === "get" || sub === "show" || sub === "view" || sub === "read") {
    const name = readValue(args, ["--name"]) ?? firstPositional(args);
    if (!name) throw new CliUsageError("Secret name is required.");
    return {
      kind: "execute",
      label: "secrets get",
      formatter: "project-secrets",
      steps: [actionStep("result", "project_secret", "get", { name })],
    };
  }
  if (sub === "set" || sub === "put" || sub === "add") {
    const name = readValue(args, ["--name"]) ?? firstPositional(args);
    if (!name) throw new CliUsageError("Secret name is required.");
    const value = readSecretValueInput(args);
    return {
      kind: "execute",
      label: "secrets set",
      formatter: "project-secrets",
      steps: [actionStep("result", "project_secret", "set", { name, value })],
    };
  }
  if (sub === "delete" || sub === "remove" || sub === "rm") {
    const name = readValue(args, ["--name"]) ?? firstPositional(args);
    if (!name) throw new CliUsageError("Secret name is required.");
    return {
      kind: "execute",
      label: "secrets delete",
      formatter: "project-secrets",
      steps: [actionStep("result", "project_secret", "delete", { name, confirmName: name })],
    };
  }
  if (sub === "actions") {
    return {
      kind: "execute",
      label: "secrets actions",
      formatter: "actions-list",
      steps: [listActionsStep("result", "project_secret")],
    };
  }
  throw new CliUsageError("secrets supports list, get, set, delete, or actions.");
}

function buildActionsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "list" || sub === "ls")
    return {
      kind: "execute",
      label: "actions list",
      steps: [
        listActionsStep(
          "result",
          readValue(args, ["--domain"]) ?? firstPositional(args) ?? undefined,
        ),
      ],
    };
  if (sub === "call" || sub === "direct" || sub === "tool") {
    const toolName = requireValue(firstPositional(args), "toolName");
    return {
      kind: "execute",
      label: "action call",
      steps: [
        actionCallStep("result", toolName, collectGenericObjectArgs(args)),
      ],
    };
  }
  if (sub === "run")
    return {
      kind: "execute",
      label: "action run",
      steps: [buildActionRunStep(args)],
    };
  if (sub === "status")
    return {
      kind: "execute",
      label: "action status",
      steps: [
        actionCallStep(
          "result",
          "get_ade_action_status",
          buildActionStatusArgs(args),
        ),
      ],
    };
  if (sub === "wait" || sub === "watch")
    return {
      kind: "execute",
      label: "action status",
      steps: [
        actionCallStep(
          "result",
          "get_ade_action_status",
          buildActionStatusArgs(args, { waitForMs: 30_000 }),
        ),
      ],
    };
  throw new CliUsageError("actions supports list, run, call, status, or wait.");
}

function buildAgentPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "spawn";
  if (sub === "spawn" || sub === "start") {
    const toolWhitelist = args
      .filter(
        (entry) =>
          entry.startsWith("--tool=") || entry.startsWith("--allow-tool="),
      )
      .map((entry) => entry.slice(entry.indexOf("=") + 1).trim())
      .filter(Boolean);
    const laneId = requireValue(readLaneId(args), "laneId");
    const prompt = requireValue(
      readValue(args, ["--prompt"]) ?? args.join(" "),
      "prompt",
    );
    const unsupportedReasoningEffort = readValue(args, ["--reasoning-effort", "--reasoning", "--effort"]);
    if (unsupportedReasoningEffort != null) {
      throw new CliUsageError(
        "agent spawn does not support reasoning effort. Use `ade chat create --reasoning-effort <tier>` for Work chats or `ade shell start-cli ... --reasoning-effort <tier>` for tracked CLI sessions.",
      );
    }
    return {
      kind: "execute",
      label: "agent spawn",
      steps: [
        actionCallStep(
          "result",
          "spawn_agent",
          collectGenericObjectArgs(args, {
            laneId,
            provider: readValue(args, ["--provider"]) ?? "codex",
            model: readValue(args, ["--model"]),
            title: readValue(args, ["--title"]),
            prompt,
            permissionMode: readValue(args, [
              "--permission-mode",
              "--permissions",
            ]),
            contextFilePath: readValue(args, ["--context-file"]),
            runId: readValue(args, ["--run", "--run-id"]),
            stepId: readValue(args, ["--step", "--step-id"]),
            attemptId: readValue(args, ["--attempt", "--attempt-id"]),
            maxPromptChars: readIntOption(args, ["--max-prompt-chars"]),
            ...(toolWhitelist.length ? { toolWhitelist } : {}),
          }),
        ),
      ],
    };
  }
  return {
    kind: "execute",
    label: `agent ${sub}`,
    steps: [
      actionCallStep(
        "result",
        sub.replace(/-/g, "_"),
        collectGenericObjectArgs(args),
      ),
    ],
  };
}

function parseDraftInput(args: string[]): JsonObject {
  const text = readFileTextInput(args);
  if (text == null) {
    throw new CliUsageError(
      "Provide a rule body via --from-file, --stdin, or --text.",
    );
  }
  const trimmed = text.trim();
  if (!trimmed.length) {
    throw new CliUsageError("Rule body is empty.");
  }
  let parsed: unknown;
  try {
    parsed =
      trimmed.startsWith("{") || trimmed.startsWith("[")
        ? JSON.parse(trimmed)
        : YAML.parse(trimmed);
  } catch (error) {
    throw new CliUsageError(
      `Failed to parse rule body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new CliUsageError("Rule body must be an object.");
  }
  return parsed;
}

const AUTOMATION_LANE_MODES = [
  "create",
  "reuse",
  "require-on-trigger",
] as const;
const AUTOMATION_LANE_NAME_PRESETS = [
  "issue-title",
  "issue-num-title",
  "pr-title-author",
  "custom",
] as const;
const AUTOMATION_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "paused",
  "all",
] as const;

type AutomationLaneModeFlag = (typeof AUTOMATION_LANE_MODES)[number];
type AutomationLaneNamePresetFlag =
  (typeof AUTOMATION_LANE_NAME_PRESETS)[number];

function readEnumOption<T extends string>(
  args: string[],
  names: string[],
  allowed: readonly T[],
  label: string,
): T | null {
  const raw = readValue(args, names);
  if (raw == null) return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new CliUsageError(`${label} must be one of ${allowed.join(", ")}.`);
  }
  return raw as T;
}

function applyLaneFlagsToDraft(draft: JsonObject, args: string[]): JsonObject {
  const laneMode = readEnumOption<AutomationLaneModeFlag>(
    args,
    ["--lane-mode"],
    AUTOMATION_LANE_MODES,
    "--lane-mode",
  );
  const laneId = readLaneId(args);
  const preset = readEnumOption<AutomationLaneNamePresetFlag>(
    args,
    ["--lane-name-preset"],
    AUTOMATION_LANE_NAME_PRESETS,
    "--lane-name-preset",
  );
  const template = readValue(args, ["--lane-name-template"]);

  if (
    laneMode == null &&
    laneId == null &&
    preset == null &&
    template == null
  ) {
    return draft;
  }

  const existingExecution = isRecord(draft.execution) ? draft.execution : {};
  const effectiveLaneMode =
    laneMode ??
    (asString(existingExecution.laneMode) as AutomationLaneModeFlag | null);

  if (
    laneId != null &&
    effectiveLaneMode != null &&
    effectiveLaneMode !== "reuse"
  ) {
    throw new CliUsageError("--lane is only valid with --lane-mode reuse.");
  }
  if (preset != null && effectiveLaneMode !== "create") {
    throw new CliUsageError(
      "--lane-name-preset is only valid with --lane-mode create.",
    );
  }
  if (template != null && preset != null && preset !== "custom") {
    throw new CliUsageError(
      "--lane-name-template is only valid with --lane-name-preset custom.",
    );
  }
  if (template != null && preset == null && effectiveLaneMode !== "create") {
    throw new CliUsageError(
      "--lane-name-template requires --lane-mode create (with --lane-name-preset custom).",
    );
  }

  const execution: JsonObject = { ...existingExecution };
  if (laneMode != null) execution.laneMode = laneMode;
  if (laneId != null) execution.targetLaneId = laneId;
  if (preset != null) execution.laneNamePreset = preset;
  if (template != null) execution.laneNameTemplate = template;

  return { ...draft, execution };
}

function migrateLegacyCreateLane(
  draft: JsonObject,
  opts: { allowLegacy: boolean },
): JsonObject {
  const actions = Array.isArray(draft.actions) ? draft.actions : null;
  if (!actions || actions.length === 0) return draft;
  const first = actions[0];
  if (!isRecord(first) || first.type !== "create-lane") return draft;
  if (opts.allowLegacy) return draft;
  const execution = isRecord(draft.execution) ? draft.execution : {};
  const template =
    typeof first.laneNameTemplate === "string"
      ? first.laneNameTemplate
      : undefined;
  const migratedExecution: JsonObject = {
    ...execution,
    laneMode: "create",
    ...(template
      ? { laneNamePreset: "custom", laneNameTemplate: template }
      : {}),
  };
  return { ...draft, execution: migratedExecution, actions: actions.slice(1) };
}

function automationsExampleText(): string {
  return JSON.stringify(
    {
      id: "example-rule",
      name: "Open lane per GitHub issue",
      enabled: true,
      trigger: {
        kind: "github.issue",
        event: "opened",
      },
      execution: {
        kind: "agent-session",
        laneMode: "create",
        laneNamePreset: "issue-num-title",
        session: {
          title: "Issue fix",
          fastMode: true,
        },
      },
      prompt: "Investigate and propose a fix for {{trigger.issue.title}}.",
      modelConfig: {
        orchestratorModel: {
          modelId: "openai/gpt-5.6-sol",
          thinkingLevel: "xhigh",
        },
      },
    },
    null,
    2,
  );
}

function buildAutomationsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";

  if (sub === "list") {
    return {
      kind: "execute",
      label: "automations list",
      steps: [actionStep("result", "automations", "list")],
    };
  }

  if (sub === "show" || sub === "get") {
    const id = requireValue(
      readValue(args, ["--id"]) ?? firstPositional(args),
      "rule id",
    );
    return {
      kind: "execute",
      label: `automations show ${id}`,
      steps: [actionStep("result", "automations", "get", { id })],
    };
  }

  if (sub === "example") {
    return { kind: "help", text: automationsExampleText() };
  }

  if (sub === "ingress" || sub === "webhook" || sub === "webhook-gateway") {
    const mode = firstPositional(args) ?? "status";
    if (mode === "status" || mode === "show") {
      return {
        kind: "execute",
        label: "automations ingress status",
        formatter: "automation-ingress",
        steps: [actionStep("result", "automations", "getIngressStatus")],
      };
    }
    if (mode === "start" || mode === "listen") {
      return {
        kind: "execute",
        label: "automations ingress start",
        formatter: "automation-ingress",
        steps: [actionStep("result", "automations", "startIngress")],
      };
    }
    if (mode === "refresh" || mode === "detect") {
      return {
        kind: "execute",
        label: "automations ingress refresh",
        formatter: "automation-ingress",
        steps: [actionStep("result", "automations", "refreshWebhookGatewayStatus")],
      };
    }
    if (mode === "set-url" || mode === "set" || mode === "configure") {
      const publicUrl = requireValue(
        readValue(args, ["--url", "--public-url", "--webhook-url"]) ?? firstPositional(args),
        "public webhook gateway URL",
      );
      return {
        kind: "execute",
        label: "automations ingress set-url",
        formatter: "automation-ingress",
        steps: [actionStep("result", "automations", "setWebhookGatewayPublicUrl", { publicUrl })],
      };
    }
    if (mode === "clear-url" || mode === "clear" || mode === "disable") {
      return {
        kind: "execute",
        label: "automations ingress clear-url",
        formatter: "automation-ingress",
        steps: [actionStep("result", "automations", "setWebhookGatewayPublicUrl", { publicUrl: null })],
      };
    }
    if (mode === "events") {
      const limit = readIntOption(args, ["--limit"]);
      return {
        kind: "execute",
        label: "automations ingress events",
        steps: [
          actionStep("result", "automations", "listIngressEvents", {
            ...(typeof limit === "number" ? { limit } : {}),
          }),
        ],
      };
    }
    throw new CliUsageError(
      "automations ingress supports status, start, refresh, set-url, clear-url, or events.",
    );
  }

  if (sub === "linear-ingress" || sub === "linear") {
    const mode = firstPositional(args) ?? "status";
    if (mode === "status" || mode === "show") {
      return {
        kind: "execute",
        label: "automations linear-ingress status",
        formatter: "automation-linear-ingress",
        steps: [actionStep("result", "automations", "linearIngressGetStatus")],
      };
    }
    if (mode === "connect" || mode === "setup" || mode === "enable") {
      return {
        kind: "execute",
        label: "automations linear-ingress connect",
        formatter: "automation-linear-ingress",
        steps: [actionStep("result", "automations", "linearIngressSetup")],
      };
    }
    if (mode === "disconnect" || mode === "teardown" || mode === "disable") {
      return {
        kind: "execute",
        label: "automations linear-ingress disconnect",
        formatter: "automation-linear-ingress",
        steps: [actionStep("result", "automations", "linearIngressTeardown")],
      };
    }
    if (mode === "poll" || mode === "poll-now" || mode === "sync") {
      return {
        kind: "execute",
        label: "automations linear-ingress poll",
        formatter: "automation-linear-ingress",
        steps: [actionStep("result", "automations", "linearIngressPollNow")],
      };
    }
    throw new CliUsageError(
      "automations linear-ingress supports status, connect, disconnect, or poll.",
    );
  }

  if (sub === "cleanups" || sub === "cleanup") {
    const mode = firstPositional(args) ?? "list";
    if (mode === "list" || mode === "ls") {
      return {
        kind: "execute",
        label: "automations cleanups list",
        formatter: "automation-cleanups",
        steps: [actionStep("result", "automations", "listScheduledCleanups")],
      };
    }
    if (mode === "cancel" || mode === "remove") {
      const id = requireValue(
        readValue(args, ["--id"]) ?? firstPositional(args),
        "scheduled cleanup id",
      );
      return {
        kind: "execute",
        label: `automations cleanups cancel ${id}`,
        steps: [actionStep("result", "automations", "cancelScheduledCleanup", { id })],
      };
    }
    throw new CliUsageError(
      "automations cleanups supports list or cancel <id>.",
    );
  }

  if (sub === "create") {
    const allowLegacy = readFlag(args, ["--allow-legacy"]);
    const raw = parseDraftInput(args);
    const draft = applyLaneFlagsToDraft(
      migrateLegacyCreateLane(raw, { allowLegacy }),
      args,
    );
    return {
      kind: "execute",
      label: "automations create",
      steps: [actionStep("result", "automations", "saveRule", { draft })],
    };
  }

  if (sub === "update") {
    const id = requireValue(
      readValue(args, ["--id"]) ?? firstPositional(args),
      "rule id",
    );
    const allowLegacy = readFlag(args, ["--allow-legacy"]);
    const raw = parseDraftInput(args);
    const draft = applyLaneFlagsToDraft(
      migrateLegacyCreateLane(raw, { allowLegacy }),
      args,
    );
    return {
      kind: "execute",
      label: `automations update ${id}`,
      steps: [
        actionStep("result", "automations", "saveRule", {
          draft: { ...draft, id },
        }),
      ],
    };
  }

  if (sub === "delete") {
    const id = requireValue(
      readValue(args, ["--id"]) ?? firstPositional(args),
      "rule id",
    );
    return {
      kind: "execute",
      label: `automations delete ${id}`,
      steps: [actionStep("result", "automations", "deleteRule", { id })],
    };
  }

  if (sub === "toggle") {
    const id = requireValue(
      readValue(args, ["--id"]) ?? firstPositional(args),
      "rule id",
    );
    const enabledRaw = readValue(args, ["--enabled"]);
    if (enabledRaw == null) {
      throw new CliUsageError(
        "automations toggle requires --enabled <true|false>.",
      );
    }
    if (enabledRaw !== "true" && enabledRaw !== "false") {
      throw new CliUsageError(
        "automations toggle --enabled must be true or false.",
      );
    }
    const enabled = enabledRaw === "true";
    return {
      kind: "execute",
      label: `automations toggle ${id}`,
      steps: [
        actionStep("result", "automations", "toggleRule", { id, enabled }),
      ],
    };
  }

  if (sub === "run" || sub === "trigger") {
    const id = requireValue(
      readValue(args, ["--id"]) ?? firstPositional(args),
      "rule id",
    );
    const dryRun = readFlag(args, ["--dry-run"]);
    const laneId = readLaneId(args);
    return {
      kind: "execute",
      label: `automations run ${id}`,
      steps: [
        actionStep("result", "automations", "triggerManually", {
          id,
          ...(dryRun ? { dryRun: true } : {}),
          ...(laneId ? { laneId } : {}),
        }),
      ],
    };
  }

  if (sub === "runs") {
    const automationId = readValue(args, ["--rule", "--automation", "--id"]);
    const limit = readIntOption(args, ["--limit"]);
    const status = readEnumOption(
      args,
      ["--status"],
      AUTOMATION_RUN_STATUSES,
      "--status",
    );
    return {
      kind: "execute",
      label: "automations runs",
      steps: [
        actionStep("result", "automations", "listRuns", {
          ...(automationId ? { automationId } : {}),
          ...(typeof limit === "number" ? { limit } : {}),
          ...(status ? { status } : {}),
        }),
      ],
    };
  }

  if (sub === "run-show" || sub === "run-detail") {
    const runId = requireValue(
      readValue(args, ["--run", "--run-id"]) ?? firstPositional(args),
      "run id",
    );
    return {
      kind: "execute",
      label: `automations run-show ${runId}`,
      formatter: "automation-run-detail",
      steps: [actionStep("result", "automations", "getRunDetail", { runId })],
    };
  }

  throw new CliUsageError(
    "automations supports list, show, create, update, delete, toggle, run, ingress, linear-ingress, cleanups, runs, run-show, or example.",
  );
}

function buildLinearPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "quick-view";
  // --- Daemon-bridge commands for a CLI-session agent ---
  // These let an agent running inside a tracked ADE CLI session read and write
  // its attached Linear issue without holding Linear credentials: every call is
  // routed over the ADE runtime to the desktop runtime, which owns the creds. The
  // issue id defaults to the session's first attached issue ($ADE_LINEAR_ISSUE_IDS)
  // so an agent can run `ade linear comment "done"` with no id.
  if (
    sub === "attach" ||
    sub === "attach-issue" ||
    sub === "attach-linear-issue"
  ) {
    // `ade linear attach --this-session` attaches an issue to the current CLI
    // session (the agent's own session). Explicit --session/--lane override.
    const thisSession = readFlag(args, ["--this-session", "--self", "--current-session"]);
    const laneId = readLaneId(args);
    const targetSession = readSessionId(args, { thisSession });
    const issues = parseLinearIssuesInput(args);
    const flags = readLinearAttachmentFlags(args);
    if (laneId && !targetSession) {
      // No session in scope: fall back to a lane-scoped link.
      return {
        kind: "execute",
        label: "linear attach (lane)",
        steps: [
          actionStep(
            "result",
            LINEAR_ATTACH_ACTIONS.domain,
            LINEAR_ATTACH_ACTIONS.linkLane,
            collectGenericObjectArgs(args, { laneId, issues, ...flags }),
          ),
        ],
      };
    }
    const sessionId = requireValue(
      targetSession,
      thisSession ? "ADE_CHAT_SESSION_ID" : "session id (use --this-session, --session <id>, or --lane <id>)",
    );
    return {
      kind: "execute",
      label: "linear attach (session)",
      steps: [
        actionStep(
          "result",
          LINEAR_ATTACH_ACTIONS.domain,
          LINEAR_ATTACH_ACTIONS.attachSession,
          collectGenericObjectArgs(args, buildSessionAttachArgs(sessionId, issues, flags)),
        ),
      ],
    };
  }
  if (sub === "detach" || sub === "detach-issue" || sub === "detach-linear-issue") {
    const thisSession = readFlag(args, ["--this-session", "--self", "--current-session"]);
    const chatSessionId = requireValue(
      readSessionId(args, { thisSession }),
      thisSession ? "ADE_CHAT_SESSION_ID" : "session id (use --this-session or --session <id>)",
    );
    // Omitting an issue id detaches every issue from the session; default a
    // positional / the session's injected issue when one is available.
    const issueId = asString(
      readIssueIdFlag(args) ?? firstPositional(args) ?? sessionLinearIssueId(),
    );
    const input: JsonObject = { chatSessionId };
    maybePut(input, "issueId", issueId);
    return {
      kind: "execute",
      label: "linear detach (session)",
      steps: [
        actionStep(
          "result",
          LINEAR_ATTACH_ACTIONS.domain,
          LINEAR_ATTACH_ACTIONS.detachSession,
          collectGenericObjectArgs(args, input),
        ),
      ],
    };
  }
  if (sub === "issues" || sub === "attached" || sub === "my-issues") {
    // `issues` always targets the current session; consume the alias flags so
    // they don't linger, but the session id always resolves via --session/env.
    readFlag(args, ["--this-session", "--self", "--current-session"]);
    const chatSessionId = requireValue(
      readSessionId(args, { thisSession: true }),
      "ADE_CHAT_SESSION_ID",
    );
    return {
      kind: "execute",
      label: "linear attached issues",
      steps: [
        actionStep(
          "result",
          LINEAR_ATTACH_ACTIONS.domain,
          LINEAR_ATTACH_ACTIONS.listSession,
          collectGenericObjectArgs(args, { chatSessionId }),
        ),
      ],
    };
  }
  if (sub === "comment") {
    const { issueId, value } = resolveLinearWriteCommand(args, ["--body", "--text", "-m", "--message"]);
    const body = requireValue(value, "comment body");
    return {
      kind: "execute",
      label: "linear comment",
      steps: [actionArgsListStep("result", "linear_issue_tracker", "createComment", [issueId, body])],
    };
  }
  if (sub === "set-state" || sub === "status" || sub === "state" || sub === "move") {
    const { issueId, value } = resolveLinearWriteCommand(args, ["--state-id", "--state", "--status"]);
    const stateId = requireValue(value, "state id");
    return {
      kind: "execute",
      label: "linear set-state",
      steps: [actionArgsListStep("result", "linear_issue_tracker", "updateIssueState", [issueId, stateId])],
    };
  }
  if (sub === "assign") {
    const { issueId, value } = resolveLinearWriteCommand(args, ["--assignee", "--assignee-id", "--user"]);
    // `none`/`null`/`unassigned` (or an omitted assignee) clears the assignee.
    const normalized = (value ?? "").trim().toLowerCase();
    const assigneeId =
      value == null || normalized === "none" || normalized === "null" || normalized === "unassigned"
        ? null
        : value.trim();
    return {
      kind: "execute",
      label: "linear assign",
      steps: [actionArgsListStep("result", "linear_issue_tracker", "updateIssueAssignee", [issueId, assigneeId])],
    };
  }
  if (sub === "label" || sub === "add-label") {
    const { issueId, value } = resolveLinearWriteCommand(args, ["--label", "--label-name", "--name"]);
    const labelName = requireValue(value, "label name");
    return {
      kind: "execute",
      label: "linear add-label",
      steps: [actionArgsListStep("result", "linear_issue_tracker", "addLabel", [issueId, labelName])],
    };
  }
  if (sub === "issue" || sub === "show-issue" || sub === "get-issue") {
    const issueId = requireLinearIssueId(args);
    return {
      kind: "execute",
      label: "linear issue",
      steps: [actionArgsListStep("result", "linear_issue_tracker", "fetchIssueById", [issueId])],
    };
  }
  if (sub === "graphql" || sub === "gql") {
    return {
      kind: "execute",
      label: "Linear GraphQL",
      steps: [actionStep("result", "linear_issue_tracker", "graphql", readLinearGraphQLArgs(args))],
    };
  }
  if (sub === "quick-view" || sub === "quick" || sub === "overview") {
    return {
      kind: "execute",
      label: "Linear quick view",
      formatter: "linear-quick-view",
      steps: [
        actionStep(
          "result",
          "linear_issue_tracker",
          "getQuickView",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "picker-data" || sub === "picker") {
    return {
      kind: "execute",
      label: "Linear picker data",
      steps: [
        actionStep(
          "result",
          "linear_issue_tracker",
          "getIssuePickerData",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "search-issues" || sub === "search") {
    const stateTypesValue = readValue(args, [
      "--state-type",
      "--state-types",
      "--state",
    ]);
    const stateTypes = stateTypesValue
      ? stateTypesValue
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    const input: JsonObject = {};
    maybePut(input, "projectId", readValue(args, ["--project-id"]));
    maybePut(
      input,
      "projectSlug",
      readValue(args, ["--project-slug", "--project"]),
    );
    maybePut(input, "teamKey", readValue(args, ["--team-key", "--team"]));
    if (stateTypes.length) input.stateTypes = stateTypes;
    maybePut(
      input,
      "assigneeId",
      readValue(args, ["--assignee", "--assignee-id"]),
    );
    const priority = readNumberOption(args, ["--priority"]);
    if (priority !== undefined) input.priority = priority;
    maybePut(input, "query", readValue(args, ["--query", "-q"]));
    const first = readNumberOption(args, ["--first", "--limit"]);
    if (first !== undefined) input.first = first;
    maybePut(input, "after", readValue(args, ["--after", "--cursor"]));
    if (readFlag(args, ["--include-archived"])) input.includeArchived = true;
    return {
      kind: "execute",
      label: "Linear search issues",
      steps: [
        actionStep(
          "result",
          "linear_issue_tracker",
          "searchIssues",
          collectGenericObjectArgs(args, input),
        ),
      ],
    };
  }
  if (sub === "issue-comments" || sub === "comments") {
    const issueId = readValue(args, ["--issue-id", "--issue"]) ?? firstPositional(args);
    if (!issueId) throw new CliUsageError("linear issue-comments requires --issue-id <id> or a positional issue ID.");
    return {
      kind: "execute",
      label: "Linear issue comments",
      steps: [
        actionScalarStep(
          "result",
          "linear_issue_tracker",
          "fetchIssueComments",
          issueId,
        ),
      ],
    };
  }
  throw new CliUsageError(
    `Unknown linear command '${sub}'. Supported: quick-view, picker-data, issues, my-issues, `
      + `search-issues, issue, comments, attach, detach, comment, assign, label, set-state, graphql.`,
  );
}

function buildCoordinatorPlan(args: string[]): CliPlan {
  const toolName = requireValue(
    firstPositional(args),
    "coordinator tool",
  ).replace(/-/g, "_");
  return {
    kind: "execute",
    label: `coordinator ${toolName}`,
    steps: [actionCallStep("result", toolName, collectGenericObjectArgs(args))],
  };
}

function buildUpdatePlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "actions")
    return {
      kind: "execute",
      label: "update actions",
      steps: [listActionsStep("actions", "update")],
    };
  if (
    sub === "status" ||
    sub === "state" ||
    sub === "snapshot" ||
    sub === "show"
  ) {
    return {
      kind: "execute",
      label: "update status",
      steps: [
        actionStep(
          "result",
          "update",
          "getSnapshot",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "check" || sub === "check-for-updates" || sub === "check-now") {
    return {
      kind: "execute",
      label: "update check",
      steps: [
        actionStep(
          "result",
          "update",
          "checkForUpdates",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (sub === "install" || sub === "quit-and-install" || sub === "apply") {
    return {
      kind: "execute",
      label: "update install",
      steps: [
        actionStep(
          "result",
          "update",
          "quitAndInstall",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  if (
    sub === "dismiss" ||
    sub === "dismiss-installed" ||
    sub === "dismiss-installed-notice"
  ) {
    return {
      kind: "execute",
      label: "update dismiss",
      steps: [
        actionStep(
          "result",
          "update",
          "dismissInstalledNotice",
          collectGenericObjectArgs(args),
        ),
      ],
    };
  }
  return {
    kind: "execute",
    label: `update ${sub}`,
    steps: [
      actionStep("result", "update", sub, collectGenericObjectArgs(args)),
    ],
  };
}

const VALUE_CARRIER_FLAGS: ReadonlySet<string> = new Set([
  // Only flags that actually take a following value (readValue / readIntOption
  // callers) belong here. Boolean-only flags consumed via readFlag must be
  // excluded, otherwise the next positional would be swallowed as their value.
  "-b",
  "-m",
  "-q",
  "-t",
  "--additional-instructions",
  "--app",
  "--action",
  "--app-bundle",
  "--arg",
  "--arg-json",
  "--arg-value",
  "--arg-value-json",
  "--args-list-json",
  "--attempt",
  "--attempt-id",
  "--automation",
  "--autonomy",
  "--backend",
  "--base",
  "--base-branch",
  "--base-branch-ref",
  "--base-ref",
  "--body",
  "--branch",
  "--branch-name",
  "--branch-ref",
  "--bundle",
  "--bundle-id",
  "--category",
  "--color",
  "--cols",
  "--command",
  "--comment",
  "--comment-id",
  "--commit",
  "--compare-ref",
  "--caption",
  "--cdp-port",
  "--chat-session",
  "--chat-session-id",
  "--compare-to",
  "--content",
  "--context-file",
  "--cron",
  "--cwd",
  "--data",
  "--cpu",
  "--cpu-cores",
  "--debug-port",
  "--depth",
  "--desc",
  "--device",
  "--disk",
  "--disk-size",
  "--display",
  "--duration",
  "--duration-ms",
  "--description",
  "--domain",
  "--droid-autonomy",
  "--droid-permission-mode",
  "--duration-sec",
  "--enabled",
  "--event",
  "--end-x",
  "--end-y",
  "--delivery",
  "--file",
  "--for",
  "--fps",
  "--from",
  "--from-file",
  "--group",
  "--group-id",
  "--head",
  "--icon",
  "--id",
  "--image",
  "--image-url",
  "--index",
  "--initial-input",
  "--input",
  "--input-json",
  "--input-text",
  "--interval-ms",
  "--instructions",
  "--kind",
  "--json-input",
  "--lane",
  "--lane-id",
  "--limit",
  "--max-bytes",
  "--line",
  "--max-log-bytes",
  "--max-prompt-chars",
  "--max-rounds",
  "--memory",
  "--merge-method",
  "--message",
  "--method",
  "--mode",
  "--model",
  "--model-id",
  "--name",
  "--new",
  "--new-path",
  "--number",
  "--old",
  "--old-path",
  "--owner",
  "--owner-id",
  "--owner-kind",
  "--output",
  "--oid",
  "--params-json",
  "--parent",
  "--parent-lane",
  "--parent-lane-id",
  "--path",
  "--permission-mode",
  "--permissions",
  "--port",
  "--pr",
  "--pr-id",
  "--pr-number",
  "--pr-url",
  "--process",
  "--process-id",
  "--project",
  "--project-root",
  "--poll-interval-ms",
  "--prompt",
  "--provider",
  "--pty",
  "--pty-id",
  "--query",
  "--question",
  "--reason",
  "--reasoning",
  "--recovery-action",
  "--recent-limit",
  "--ref",
  "--require-dpop",
  "--role",
  "--root",
  "--root-lane",
  "--round",
  "--rounds",
  "--rows",
  "--rule",
  "--run",
  "--run-id",
  "--scalar",
  "--scalar-json",
  "--scope",
  "--seconds",
  "--session",
  "--session-id",
  "--set",
  "--set-json",
  "--sha",
  "--signal",
  "--since",
  "--source",
  "--source-lane",
  "--spawn-type",
  "--stack",
  "--stack-base",
  "--stack-base-branch",
  "--stack-id",
  "--scheme",
  "--socket",
  "--start-point",
  "--start-x",
  "--start-y",
  "--stash-oid",
  "--stash-ref",
  "--step",
  "--step-id",
  "--suite",
  "--suite-id",
  "--surface",
  "--state",
  "--tab",
  "--tab-identifier",
  "--target",
  "--target-id",
  "--terminal",
  "--terminal-id",
  "--thread",
  "--thread-id",
  "--turn",
  "--turn-id",
  "--timeout",
  "--timeout-ms",
  "--title",
  "--tool-type",
  "--title-query",
  "--type",
  "--udid",
  "--url",
  "--until",
  "--value",
  "--window-title",
  "--workspace",
  "--workspace-id",
  "--workspace-root",
  "--coordinate-space",
  "--coords",
  "--x",
  "--xcodeproj",
  "--y",
]);

function hasHelpFlag(args: string[]): boolean {
  const terminatorIndex = args.indexOf("--");
  const searchable =
    terminatorIndex >= 0 ? args.slice(0, terminatorIndex) : args;
  const valueCarrierFlags = VALUE_CARRIER_FLAGS;
  for (let i = 0; i < searchable.length; i++) {
    const token = searchable[i]!;
    if (token === "--help") {
      if (valueCarrierFlags.has(searchable[i - 1] ?? "")) continue;
      return true;
    }
    if (token === "-h") {
      if (valueCarrierFlags.has(searchable[i - 1] ?? "")) continue;
      return true;
    }
  }
  return false;
}

function buildCliPlan(
  command: string[],
  options: Pick<GlobalOptions, "socketPath"> = { socketPath: null },
): CliPlan {
  const args = [...command];
  if (args[0] === "--version" || args[0] === "-v") {
    return { kind: "help", text: `ade ${VERSION}\n` };
  }
  const primary = firstPositional(args);
  if (!primary) {
    return { kind: "help", text: topLevelHelpText() };
  }
  if (primary === "-h" || primary === "--help") {
    return { kind: "help", text: topLevelHelpText() };
  }
  const aliases: Record<string, string> = {
    lane: "lanes",
    diff: "diff",
    diffs: "diff",
    file: "files",
    pr: "prs",
    process: "run",
    processes: "run",
    pty: "shell",
    term: "terminal",
    chats: "chat",
    work: "chat",
    agents: "agent",
    test: "tests",
    computer: "proof",
    "computer-use": "proof",
    artifact: "proof",
    artifacts: "proof",
    ios: "ios-sim",
    simulator: "ios-sim",
    app: "app-control",
    apps: "app-control",
    electron: "app-control",
    "ade-browser": "browser",
    "built-in-browser": "browser",
    "builtin-browser": "browser",
    setting: "settings",
    config: "settings",
    action: "actions",
    coord: "coordinator",
    automation: "automations",
    "auto-update": "update",
    updates: "update",
    operation: "operations",
    project: "projects",
    machine: "machines",
    quota: "usage",
    quotas: "usage",
    disk: "storage",
    skills: "skill",
    gh: "github",
    create: "new",
    login: "auth",
    logout: "auth",
  };
  const primaryHelpKey = aliases[primary] ?? primary;
  // Remote ADE Code owns a dedicated, beginner-facing help surface in the TUI
  // client. Keep ordinary `ade code --help` on the established top-level help
  // page, but let the remote subcommand render its actual connection guidance.
  if (
    primary === "code"
    && firstStandalonePositional([...args]) === "remote"
    && hasHelpFlag(args)
  ) {
    return { kind: "ade-code", rest: args };
  }
  if (hasHelpFlag(args)) {
    const helpKey = helpKeyWithSubcommand(primaryHelpKey, args);
    if (primaryHelpKey === "ios-sim") {
      return { kind: "help", text: buildIosSimulatorHelp(args) };
    }
    if (primaryHelpKey === "cursor") {
      return { kind: "help", text: buildCursorHelp(args) };
    }
    if (primaryHelpKey === "app-control") {
      return { kind: "help", text: buildAppControlHelp(args) };
    }
    return {
      kind: "help",
      text: commandHelpText(helpKey) ?? commandHelpText(primaryHelpKey) ?? topLevelHelpText(),
    };
  }
  if (primary === "help") {
    const topics = args
      .filter((arg) => arg !== "--" && !arg.startsWith("-"))
      .map((arg) => arg.toLowerCase());
    const topic = topics[0] ?? "";
    const key = aliases[topic] ?? topic;
    const subtopic = topics[1];
    const helpKey = subtopic ? helpKeyWithSubcommand(key, [subtopic]) : key;
    const nestedHelpArgs = subtopic ? topics.slice(1) : [];
    if (key === "ios-sim") {
      return { kind: "help", text: buildIosSimulatorHelp(nestedHelpArgs) };
    }
    if (key === "cursor") {
      return { kind: "help", text: buildCursorHelp(nestedHelpArgs) };
    }
    if (key === "app-control") {
      return { kind: "help", text: buildAppControlHelp(nestedHelpArgs) };
    }
    return {
      kind: "help",
      text: key
        ? commandHelpText(helpKey) ?? commandHelpText(key) ?? topLevelHelpText()
        : topLevelHelpText(),
    };
  }
  if (primary === "version" || primary === "--version" || primary === "-v") {
    return { kind: "help", text: `ade ${VERSION}\n` };
  }
  if (primary === "__ade-pty-host-worker") {
    return { kind: "pty-host-worker" };
  }
  if (primary === "code") {
    const rest = args;
    return { kind: "ade-code", rest };
  }
  if (primary === "desktop") {
    return { kind: "desktop", rest: args };
  }
  if (primary === "open" || primary === "link") {
    // Deeplink-related subcommands. We need the verb back so the inner
    // dispatcher can branch on it; reconstruct rest accordingly.
    return { kind: "deeplink", rest: [primary, ...args] };
  }
  if (primary === "skill" || primary === "skills") {
    // Local (non-RPC) bundled-agent-skill browser; no runtime required.
    return { kind: "skill", rest: args };
  }
  if (primary === "linear") {
    // `ade linear install` is the deeplink installer; every other `ade linear`
    // subcommand (quick-view, issues, comment, set-state, picker-data, ...) belongs
    // to buildLinearPlan below. Only route to the deeplink handler when the
    // first positional looks like "install". Use a non-mutating peek so
    // buildLinearPlan still sees the original args.
    const linearSubPeek = args.find((arg) => arg !== "--" && !arg.startsWith("-"));
    if (linearSubPeek === "install") {
      return { kind: "deeplink", rest: [primary, ...args] };
    }
  }
  if (primary === "runtime") {
    const runtimeArgs = [...args];
    const sub = firstStandalonePositional(runtimeArgs) ?? "status";
    if (sub === "run" || sub === "foreground") {
      const socketPath = readValue([...runtimeArgs], ["--socket"]) ?? options.socketPath;
      if (!socketPath) {
        throw new CliUsageError("ade runtime run requires --socket <path>.");
      }
      if (!readValue([...runtimeArgs], ["--socket"])) {
        runtimeArgs.push("--socket", socketPath);
      }
      const syncDisabled = readFlag([...runtimeArgs], ["--no-sync"]);
      if (!syncDisabled) {
        runtimeArgs.push("--no-sync");
      }
      return { kind: "serve", rest: runtimeArgs };
    }
    return { kind: "runtime", rest: args };
  }
  if (primary === "brain") {
    const sub = firstStandalonePositional([...args]) ?? "status";
    if (sub === "pin") {
      return buildSyncPlan(args);
    }
    return { kind: "brain", rest: args };
  }
  if (primary === "serve") {
    return { kind: "serve", rest: args };
  }
  if (primary === "rpc") {
    const sub = firstPositional(args);
    if (sub === "stdio" || readFlag(args, ["--stdio"])) {
      return { kind: "rpc-stdio", rest: args };
    }
    throw new CliUsageError("rpc currently supports only --stdio.");
  }
  if (primary === "init") {
    return { kind: "init", targetPath: firstPositional(args) };
  }
  if (primary === "projects" || primary === "project") {
    return buildProjectsPlan(args);
  }
  if (primary === "machines" || primary === "machine") {
    return buildMachinesPlan(args);
  }
  if (primary === "new" || primary === "create") {
    return buildNewPlan(args);
  }
  if (primary === "sync") {
    return buildSyncPlan(args);
  }
  if (primary === "status") {
    return {
      kind: "execute",
      label: "status",
      summary: "status",
      steps: [{ key: "ping", method: "ping" }],
    };
  }
  if (primary === "login") {
    const maxWaitSec = readIntOption(args, ["--max-wait", "--timeout-sec"]);
    const explicitHeadless = readFlag(args, ["--headless"]);
    return {
      kind: "account-login",
      maxWaitSec: typeof maxWaitSec === "number" ? maxWaitSec : null,
      explicitHeadless,
    };
  }
  if (primary === "logout") {
    return {
      kind: "execute",
      label: "account logout",
      formatter: "account-auth",
      machineOnly: true,
      machineAutoStart: true,
      // signOut is a CTO-only account action; connect as the machine operator.
      connectRole: "cto",
      steps: [accountActionStep("result", "signOut")],
    };
  }
  if (primary === "doctor") {
    return {
      kind: "execute",
      label: "doctor",
      summary: "doctor",
      steps: [
        { key: "ping", method: "ping" },
        { key: "rpcActions", method: "ade/actions/list" },
        listActionsStep("actions"),
        {
          ...actionStep("projectConfig", "project_config", "get"),
          optional: true,
        },
        {
          key: "syncStatus",
          method: "sync.getStatus",
          params: { includeTransferReadiness: false },
          optional: true,
        },
      ],
    };
  }
  if (primary === "auth") {
    const sub = firstPositional(args) ?? "status";
    if (sub !== "status")
      throw new CliUsageError("auth currently supports status.");
    return {
      kind: "execute",
      label: "auth status",
      formatter: "account-auth",
      machineOnly: true,
      machineAutoStart: true,
      // This first-party typed command intentionally shows the operator their
      // account identity; generic agent actions keep the redacted status view.
      connectRole: "cto",
      steps: [accountActionStep("result", "status")],
    };
  }
  if (primary === "account") {
    const [sub, mode] = args.filter(
      (arg) => arg !== "--" && !arg.startsWith("-"),
    );
    if (sub !== "token" || mode !== "create") {
      throw new CliUsageError("account currently supports token create.");
    }
    return {
      kind: "execute",
      label: "account token create",
      formatter: "account-token",
      machineOnly: true,
      machineAutoStart: true,
      connectRole: "cto",
      steps: [{
        ...accountActionStep("result", "createToken"),
        injectProjectRootIntoArgs: true,
      }],
    };
  }
  if (primary === "lanes" || primary === "lane") return buildLanePlan(args);
  if (primary === "git") return buildGitPlan(args);
  if (primary === "diff" || primary === "diffs") return buildDiffPlan(args);
  if (primary === "files" || primary === "file") return buildFilesPlan(args);
  if (primary === "search") return buildSearchPlan(args);
  if (primary === "prs" || primary === "pr") return buildPrPlan(args);
  if (primary === "run" || primary === "process" || primary === "processes")
    return buildRunPlan(args);
  if (primary === "shell" || primary === "pty") return buildShellPlan(args);
  if (primary === "terminal" || primary === "term")
    return buildTerminalPlan(args);
  if (primary === "history") return buildHistoryPlan(args);
  if (primary === "chat" || primary === "chats" || primary === "work")
    return buildChatPlan(args);
  if (primary === "agent" || primary === "agents") return buildAgentPlan(args);
  if (primary === "linear") return buildLinearPlan(args);
  if (primary === "automations" || primary === "automation") {
    assertAutomationsCliEnabled();
    return buildAutomationsPlan(args);
  }
  if (primary === "coordinator" || primary === "coord")
    return buildCoordinatorPlan(args);
  if (primary === "ask")
    return {
      kind: "execute",
      label: "ask user",
      steps: [
        actionCallStep(
          "result",
          "ask_user",
          collectGenericObjectArgs(args, {
            title: readValue(args, ["--title"]) ?? "ADE question",
            body: readValue(args, ["--body", "--question"]) ?? args.join(" "),
          }),
        ),
      ],
    };
  if (primary === "tests" || primary === "test") return buildTestsPlan(args);
  if (
    primary === "proof" ||
    primary === "computer-use" ||
    primary === "artifacts" ||
    primary === "computer" ||
    primary === "artifact"
  ) {
    return buildProofPlan(args);
  }
  if (primary === "ios-sim" || primary === "ios" || primary === "simulator")
    return buildIosSimulatorPlan(args);
  if (
    primary === "app-control" ||
    primary === "app" ||
    primary === "apps" ||
    primary === "electron"
  )
    return buildAppControlPlan(args);
  if (
    primary === "browser" ||
    primary === "ade-browser" ||
    primary === "built-in-browser" ||
    primary === "builtin-browser"
  )
    return buildBrowserPlan(args);
  if (primary === "usage" || primary === "quota" || primary === "quotas")
    return buildUsagePlan(args);
  if (primary === "storage" || primary === "disk")
    return buildStoragePlan(args);
  if (primary === "secrets" || primary === "secret")
    return buildSecretsPlan(args);
  if (primary === "settings" || primary === "config" || primary === "setting")
    return buildSettingsPlan(args);
  if (primary === "operation" || primary === "operations")
    return buildOperationsPlan(args);
  if (primary === "actions" || primary === "action")
    return buildActionsPlan(args);
  if (
    primary === "update" ||
    primary === "auto-update" ||
    primary === "updates"
  )
    return buildUpdatePlan(args);
  if (primary === "cursor") return buildCursorPlan(args);
  if (primary === "github" || primary === "gh") return buildGithubPlan(args);
  throw new CliUsageError(`Unknown command '${primary}'. Run 'ade help'.`);
}

function buildGithubPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "app-auth";
  if (sub === "help") {
    return { kind: "help", text: HELP_BY_COMMAND.github ?? topLevelHelpText() };
  }
  if (sub === "actions") {
    return {
      kind: "execute",
      label: "github actions",
      formatter: "actions-list",
      steps: [listActionsStep("actions", "github")],
    };
  }
  if (sub === "app-auth" || sub === "app" || sub === "auth") {
    const mode = firstPositional(args) ?? "status";
    if (mode === "status" || mode === "show") {
      return {
        kind: "execute",
        label: "github app-auth status",
        steps: [actionStep("result", "github", "getAppUserAuthStatus")],
      };
    }
    if (mode === "login" || mode === "authorize" || mode === "start") {
      const maxWaitSec = readIntOption(args, ["--max-wait", "--timeout-sec"]);
      return {
        kind: "github-app-login",
        maxWaitSec: typeof maxWaitSec === "number" ? maxWaitSec : null,
      };
    }
    if (mode === "clear" || mode === "logout" || mode === "sign-out") {
      return {
        kind: "execute",
        label: "github app-auth clear",
        steps: [actionStep("result", "github", "clearAppUserAuth")],
      };
    }
    throw new CliUsageError(
      "github app-auth supports status, login, or clear.",
    );
  }
  throw new CliUsageError(
    "github supports app-auth (status | login | clear) and actions.",
  );
}

function buildCursorPlan(args: string[]): CliPlan {
  // ade cursor <surface> <group> <sub> ... — only "cloud" is wired today.
  const surface = firstPositional(args);
  if (!surface || surface === "help" || hasHelpFlag([surface])) {
    return { kind: "help", text: HELP_BY_COMMAND.cursor ?? topLevelHelpText() };
  }
  if (surface !== "cloud") {
    throw new CliUsageError(
      `Unknown 'ade cursor' surface '${surface}'. The only supported surface is 'cloud'.`,
    );
  }
  if (hasHelpFlag(args)) {
    const group = peekFirstPositional(args)?.toLowerCase();
    if (group && CURSOR_CLOUD_HELP[group]) {
      return { kind: "help", text: `${ADE_BANNER}${CURSOR_CLOUD_HELP[group]}` };
    }
    return { kind: "help", text: HELP_BY_COMMAND.cursor ?? topLevelHelpText() };
  }
  return { kind: "cursor-cloud", rest: args };
}

function findProjectRoots(startDir: string): {
  projectRoot: string;
  workspaceRoot: string;
} {
  const canonicalStart = realpathIfExists(startDir);
  const managedWorktree = findAdeManagedWorktreeRoot(canonicalStart);
  if (managedWorktree) return managedWorktree;

  let cursor = canonicalStart;
  while (true) {
    if (fs.existsSync(path.join(cursor, ".ade"))) {
      return { projectRoot: cursor, workspaceRoot: cursor };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const gitRoot = git.status === 0 ? git.stdout.trim() : "";
  const fallback = gitRoot ? path.resolve(gitRoot) : path.resolve(startDir);
  return { projectRoot: fallback, workspaceRoot: fallback };
}

function resolveRoots(options: GlobalOptions): {
  projectRoot: string;
  workspaceRoot: string;
} {
  const discovered = findProjectRoots(process.cwd());
  const projectFromEnv = process.env.ADE_PROJECT_ROOT?.trim()
    ? path.resolve(process.env.ADE_PROJECT_ROOT.trim())
    : null;
  const workspaceFromEnv = process.env.ADE_WORKSPACE_ROOT?.trim()
    ? path.resolve(process.env.ADE_WORKSPACE_ROOT.trim())
    : null;

  const projectRoot =
    options.projectRoot ?? projectFromEnv ?? discovered.projectRoot;
  const projectExplicitlyOverridden =
    options.projectRoot != null || projectFromEnv != null;

  const workspaceRoot =
    options.workspaceRoot ??
    workspaceFromEnv ??
    (projectExplicitlyOverridden ? projectRoot : discovered.workspaceRoot);

  return { projectRoot, workspaceRoot };
}

function commandExists(command: string): boolean {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function resolveAdeCodeSocketPath(projectRoot: string, socketPathOverride?: string | null): string {
  return (
    socketPathOverride?.trim() ||
    process.env.ADE_RPC_URL?.trim() ||
    process.env.ADE_RPC_SOCKET_PATH?.trim() ||
    process.env.ADE_RUNTIME_SOCKET_PATH?.trim() ||
    resolveMachineAdeLayout().socketPath ||
    path.join(projectRoot, ".ade", "ade.sock")
  );
}

function buildAdeCodeArgs(rest: string[], options: GlobalOptions): string[] {
  const roots = resolveRoots(options);
  return [
    "--project-root",
    roots.projectRoot,
    "--workspace-root",
    roots.workspaceRoot,
    ...(options.headless ? ["--embedded"] : []),
    ...(options.requireSocket
      ? [
          "--socket",
          resolveAdeCodeSocketPath(roots.projectRoot, options.socketPath),
          "--require-socket",
        ]
      : []),
    ...(isPackagedElectronCliRuntime() ? ["--prefer-service-repair"] : []),
    ...rest,
  ];
}

function resolveAdeCodeModulePath(): string {
  const sourceModule = path.join(
    CLI_PACKAGE_ROOT,
    "src",
    "tuiClient",
    "cli.tsx",
  );
  const builtModule = CLI_ENTRY_PATH
    ? path.join(path.dirname(CLI_ENTRY_PATH), "tuiClient", "cli.mjs")
    : path.join(CLI_PACKAGE_ROOT, "dist", "tuiClient", "cli.mjs");
  const runtimeRoot =
    process.env.ADE_RUNTIME_ROOT?.trim() ||
    process.env.ADE_RESOLVED_RUNTIME_ROOT?.trim() ||
    null;
  const runtimeModule = runtimeRoot
    ? path.join(runtimeRoot, "tuiClient", "cli.mjs")
    : null;
  const candidates = [
    runtimeModule,
    builtModule,
    isSourceCliEntryPath(CLI_ENTRY_PATH) ? sourceModule : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "ADE Code TUI module is missing. Run `npm --prefix apps/ade-cli run build` " +
      "or reinstall ADE so the packaged runtime includes tuiClient/cli.mjs.",
  );
}

async function runAdeCode(
  rest: string[],
  options: GlobalOptions,
): Promise<{ output: string; exitCode: number }> {
  const modulePath = resolveAdeCodeModulePath();
  const { runAdeCodeCli } = await import(pathToFileURL(modulePath).href);
  const remoteArgs = takeAdeCodeRemoteArgs(rest);
  if (remoteArgs) {
    const roots = resolveRoots(options);
    const exitCode = await runAdeCodeRemote(remoteArgs, runAdeCodeCli, {
      accountProjectRoots: [roots.projectRoot],
    });
    return { output: "", exitCode };
  }
  const exitCode = await runAdeCodeCli(buildAdeCodeArgs(rest, options));
  return { output: "", exitCode };
}

async function runAccountMachineConnect(
  plan: CliPlan & { kind: "account-machine-connect" },
  options: GlobalOptions,
): Promise<{ output: string; exitCode: number }> {
  let connection: CliConnection;
  try {
    connection = await createConnection(
      { ...options, headless: false, role: "cto" },
      { autoRegisterProject: false, machineRuntimeOnly: true },
    );
  } catch (error) {
    throw new CliExecutionError("Failed to initialize the ADE brain for account machine connection.", {
      cause: error instanceof Error ? error.message : String(error),
      nextAction: "Start the machine ADE brain with `ade brain start`, then retry.",
    });
  }

  let targetId: string;
  try {
    const raw = await connection.request("account.call", {
      action: "pairMachine",
      args: { machine: plan.machine },
    });
    const paired = unwrapActionEnvelope(raw);
    targetId = isRecord(paired) ? asString(paired.targetId) ?? "" : "";
    if (!targetId) {
      throw new CliExecutionError("Account machine pairing did not return a saved remote target.", {
        machine: plan.machine,
      });
    }
  } finally {
    await connection.close();
  }

  const modulePath = resolveAdeCodeModulePath();
  const { runAdeCodeCli } = await import(pathToFileURL(modulePath).href);
  const exitCode = await runAdeCodeRemote(
    ["--target", targetId, ...plan.remoteArgs],
    runAdeCodeCli,
    { accountProjectRoots: [resolveRoots(options).projectRoot] },
  );
  return { output: "", exitCode };
}

function runLocalCommand(
  command: string,
  args: string[],
  cwd: string,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function checkGitReadiness(projectRoot: string): ReadinessCheck {
  if (!commandExists("git")) {
    return {
      ready: false,
      status: "missing",
      message: "git is not available on PATH.",
      nextAction: "Install git and rerun ade doctor.",
    };
  }
  const inside = runLocalCommand(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    projectRoot,
  );
  if (!inside.ok || inside.stdout !== "true") {
    return {
      ready: false,
      status: "missing",
      message: "Project root is not inside a git worktree.",
      nextAction: "Run ade with --project-root pointing at a git repository.",
    };
  }
  const root = runLocalCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    projectRoot,
  );
  const branch = runLocalCommand(
    "git",
    ["branch", "--show-current"],
    projectRoot,
  );
  return {
    ready: true,
    status: "ready",
    message: `Git repository detected${branch.stdout ? ` on ${branch.stdout}` : ""}.`,
    details: {
      gitRoot: root.ok ? root.stdout : null,
      branch: branch.ok ? branch.stdout || null : null,
    },
  };
}

function getGitRemote(projectRoot: string): string | null {
  const remote = runLocalCommand(
    "git",
    ["config", "--get", "remote.origin.url"],
    projectRoot,
  );
  return remote.ok && remote.stdout ? remote.stdout : null;
}

function checkGitHubReadiness(projectRoot: string): ReadinessCheck {
  const remote = getGitRemote(projectRoot);
  const hasGitHubRemote = Boolean(remote && /github\.com[:/]/i.test(remote));
  const ghInstalled = commandExists("gh");
  const envTokenPresent = Boolean(
    process.env.ADE_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim(),
  );
  const ready = hasGitHubRemote && (ghInstalled || envTokenPresent);
  return {
    ready,
    status: ready ? "ready" : hasGitHubRemote ? "warning" : "unavailable",
    message: hasGitHubRemote
      ? ready
        ? "GitHub remote detected and a local auth mechanism is available."
        : "GitHub remote detected, but no gh CLI or environment GitHub token was found locally."
      : "No GitHub origin remote detected.",
    nextAction: ready
      ? undefined
      : hasGitHubRemote
        ? "Run gh auth login or set ADE_GITHUB_TOKEN/GITHUB_TOKEN for headless PR workflows."
        : "Add a GitHub origin remote if this project should use ADE PR workflows.",
    details: {
      ghInstalled,
      tokenEnvPresent: envTokenPresent,
      githubRemoteDetected: hasGitHubRemote,
    },
  };
}

function checkLinearReadiness(projectRoot: string): ReadinessCheck {
  const { resolveAdeLayout } = requireAdeLayout();
  const layout = resolveAdeLayout(projectRoot);
  const legacyEncryptedTokenPresent = fs.existsSync(
    path.join(layout.secretsDir, "linear-token.v1.bin"),
  );
  const projectCredentialStoreTokenPresent = hasProjectCredentialStoreValue(
    layout.secretsDir,
    "linear.token.v1",
  );
  const envTokenPresent = Boolean(
    process.env.ADE_LINEAR_API?.trim() ||
    process.env.LINEAR_API_KEY?.trim() ||
    process.env.ADE_LINEAR_TOKEN?.trim() ||
    process.env.LINEAR_TOKEN?.trim(),
  );
  const ready =
    legacyEncryptedTokenPresent ||
    projectCredentialStoreTokenPresent ||
    envTokenPresent;
  return {
    ready,
    status: ready ? "ready" : "warning",
    message: ready
      ? "Linear credentials are present locally."
      : "No Linear token was detected in local stores or environment variables.",
    nextAction: ready
      ? undefined
      : "Configure Linear in ADE desktop or set ADE_LINEAR_API/LINEAR_API_KEY for headless mode.",
    details: {
      encryptedTokenPresent:
        legacyEncryptedTokenPresent || projectCredentialStoreTokenPresent,
      legacyEncryptedTokenPresent,
      projectCredentialStoreTokenPresent,
      tokenEnvPresent: envTokenPresent,
    },
  };
}

function hasProjectCredentialStoreValue(
  secretsDir: string,
  key: string,
): boolean {
  const credentialsPath = path.join(secretsDir, "credentials.json.enc");
  const machineKeyPath = path.join(secretsDir, ".machine-key");
  if (!fs.existsSync(credentialsPath) || !fs.existsSync(machineKeyPath)) {
    return false;
  }
  try {
    const credentialStore = new EncryptedFileCredentialStore({
      credentialsPath,
      machineKeyPath,
    });
    return Boolean(credentialStore.getSync(key)?.trim());
  } catch {
    return false;
  }
}

function checkProviderReadiness(value: unknown): ReadinessCheck {
  const configResult =
    isRecord(value) && isRecord(value.result) ? value.result : value;
  const effective =
    isRecord(configResult) && isRecord(configResult.effective)
      ? configResult.effective
      : {};
  const ai = isRecord(effective.ai) ? effective.ai : {};
  const defaultProvider = asString(ai.defaultProvider) ?? asString(ai.mode);
  const defaultModel = asString(ai.defaultModel);
  const apiKeys = isRecord(ai.apiKeys) ? ai.apiKeys : {};
  const cliProviders = {
    claude: commandExists("claude"),
    codex: commandExists("codex"),
    opencode: commandExists("opencode"),
    cursor: commandExists("agent") || commandExists("cursor-agent"),
    droid: commandExists("droid"),
  };
  const apiKeyProviders = Object.keys(apiKeys).filter((key) =>
    Boolean(asString(apiKeys[key])),
  );
  const ready = Boolean(
    defaultProvider ||
    defaultModel ||
    apiKeyProviders.length ||
    Object.values(cliProviders).some(Boolean),
  );
  return {
    ready,
    status: ready ? "ready" : "warning",
    message: ready
      ? "AI provider configuration or provider CLI availability was detected locally."
      : "No AI provider configuration or provider CLI was detected locally.",
    nextAction: ready
      ? undefined
      : "Configure AI providers in ADE desktop or install/sign in to a provider CLI.",
    details: {
      defaultProvider,
      defaultModel,
      apiKeyProviders,
      cliProviders,
    },
  };
}

function checkComputerUseReadiness(): ReadinessCheck {
  const isDarwin = process.platform === "darwin";
  const screenshotReady = isDarwin && commandExists("screencapture");
  const appLaunchReady = isDarwin && commandExists("open");
  const guiReady =
    isDarwin && (commandExists("swift") || commandExists("osascript"));
  const ready = isDarwin && screenshotReady && appLaunchReady && guiReady;
  return {
    ready,
    status: ready ? "ready" : isDarwin ? "warning" : "unavailable",
    message: ready
      ? "Local macOS computer-use fallback commands are available."
      : isDarwin
        ? "One or more local macOS computer-use fallback commands are missing."
        : "Local computer-use fallback is macOS-only.",
    nextAction: ready
      ? undefined
      : isDarwin
        ? "Install or expose screencapture/open/swift/osascript on PATH, or use an external proof backend."
        : "Use ADE desktop on macOS or an external proof backend for computer-use capture.",
    details: {
      platform: process.platform,
      screenshotReady,
      appLaunchReady,
      guiReady,
    },
  };
}

function checkPathReadiness(): ReadinessCheck {
  const lookup =
    process.platform === "win32"
      ? runLocalCommand("where", ["ade"], process.cwd())
      : runLocalCommand("which", ["ade"], process.cwd());
  const current = path.resolve(process.argv[1] ?? "");
  const whichPath =
    lookup.ok && lookup.stdout
      ? path.resolve(lookup.stdout.split(/\r?\n/)[0]!)
      : null;
  const onPath = Boolean(whichPath);
  return {
    ready: onPath,
    status: onPath ? "ready" : "warning",
    message: onPath
      ? "ade is available on PATH."
      : "ade is not available on PATH.",
    nextAction: onPath
      ? undefined
      : process.platform === "win32"
        ? "Install ade from ADE desktop General settings or run the packaged install-path.cmd script."
        : "Run npm link in apps/ade-cli or the packaged install-path.sh script.",
    details: {
      currentCliPath: current || null,
      pathAde: whichPath,
      sameBinary: Boolean(whichPath && current && whichPath === current),
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === "1",
      electronVersion: process.versions.electron ?? null,
      lookupCommand: process.platform === "win32" ? "where" : "which",
    },
  };
}

function checkStorageReadiness(projectRoot: string): ReadinessCheck {
  // The disk-pressure module is brain-safe (fs/statfs only), so doctor can take a
  // one-shot reading without a running brain. maxAgeMs: 0 forces a fresh sample.
  try {
    const monitor = createDiskPressureMonitor({
      roots: [projectRoot, resolveMachineAdeLayout().adeDir],
    });
    const snap = monitor.getSnapshot({ maxAgeMs: 0 });
    const urgent = isUrgentDiskPressure(snap.state);
    const summary = `${snap.state} · ${formatBytes(snap.freeBytes)} free of ${formatBytes(snap.totalBytes)}`;
    return {
      ready: !urgent,
      status: snap.state === "normal"
        ? "ready"
        : snap.state === "warning"
          ? "warning"
          : "missing",
      message: snap.state === "normal"
        ? `Disk has headroom (${summary}).`
        : `Disk pressure is ${summary}.`,
      nextAction: urgent
        ? "Free up disk space; ADE pauses new agent work and CLI launches when storage is critical."
        : snap.state === "warning"
          ? "Disk is getting low; run 'ade storage snapshot --text' to see what ADE is holding."
          : undefined,
      details: {
        state: snap.state,
        freeBytes: snap.freeBytes,
        totalBytes: snap.totalBytes,
        freeFraction: snap.freeFraction,
      },
    };
  } catch (error) {
    return {
      ready: true,
      status: "unavailable",
      message: "Disk pressure state is unavailable on this platform.",
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function checkSyncReadiness(value: unknown): ReadinessCheck & {
  enabled: boolean;
  usable: boolean;
  failingRoutes: string[];
} {
  const snapshot = isRecord(value) ? value : null;
  const routeHealth = snapshot && isRecord(snapshot.routeHealth) ? snapshot.routeHealth : null;
  const listener = routeHealth && isRecord(routeHealth.listener) ? routeHealth.listener : null;
  const tailscale = routeHealth && isRecord(routeHealth.tailscale) ? routeHealth.tailscale : null;
  const relay = routeHealth && isRecord(routeHealth.relay) ? routeHealth.relay : null;
  const enabled = Boolean(snapshot?.pairingConnectInfo) || relay?.enabled === true;
  if (!snapshot || !routeHealth) {
    return {
      ready: false,
      enabled: false,
      usable: false,
      status: "unavailable",
      message: "Sync route health is unavailable.",
      nextAction: "Run 'ade sync status --text' against the live ADE runtime.",
      failingRoutes: [],
    };
  }
  if (!enabled) {
    return {
      ready: true,
      enabled: false,
      usable: false,
      status: "unavailable",
      message: "Phone sync hosting is not enabled in this runtime.",
      failingRoutes: [],
      details: { routeHealth },
    };
  }

  const failures: string[] = [];
  if (listener?.listenerBound !== true || listener?.loopbackAdeValidated !== true) {
    failures.push(`listener: ${asString(listener?.reason) ?? "loopback listener mismatch"}`);
  }
  if (tailscale?.enabled === true && tailscale?.tailscaleReachable !== true) {
    failures.push(`tailscale: ${asString(tailscale.reason) ?? "published route is not reachable"}`);
  }
  if (
    relay?.enabled === true
    && (relay?.relayControlConnected !== true || asString(relay?.skipReason) != null)
  ) {
    failures.push(`relay: ${asString(relay.skipReason)
      ?? asString(relay.lastControlError)
      ?? "control channel is not connected"}`);
  }
  const usable = failures.length === 0;
  return {
    ready: usable,
    enabled: true,
    usable,
    status: usable ? "ready" : "warning",
    message: usable
      ? "Enabled sync routes are usable."
      : `Sync route failure: ${failures.join("; ")}`,
    nextAction: usable
      ? undefined
      : "Run 'ade sync status --text' and resolve the named listener or route failure.",
    failingRoutes: failures,
    details: { routeHealth },
  };
}

function requireAdeLayout(): {
  resolveAdeLayout: (projectRoot: string) => { secretsDir: string };
} {
  // The CLI loads the shared layout dynamically elsewhere; this CommonJS fallback
  // keeps readiness checks synchronous and local-only.
  return {
    resolveAdeLayout: (projectRoot: string) => ({
      secretsDir: path.join(projectRoot, ".ade", "secrets"),
    }),
  };
}

function actionDomainCounts(value: unknown): Record<string, number> {
  const actions =
    isRecord(value) && Array.isArray(value.actions)
      ? value.actions.filter(isRecord)
      : [];
  return actions.reduce<Record<string, number>>((acc, action) => {
    const domain = asString(action.domain) ?? "core";
    acc[domain] = (acc[domain] ?? 0) + 1;
    return acc;
  }, {});
}

function buildReadinessSnapshot(args: {
  connection: CliConnection;
  values: JsonObject;
  summary: "doctor" | "auth";
}): JsonObject {
  const { connection, values, summary } = args;
  const rpcActions =
    isRecord(values.rpcActions) && Array.isArray(values.rpcActions.actions)
      ? values.rpcActions.actions
      : [];
  const actions =
    isRecord(values.actions) && Array.isArray(values.actions.actions)
      ? values.actions.actions
      : [];
  const projectConfig = values.projectConfig;
  const adeDir = path.join(connection.projectRoot, ".ade");
  const sharedConfigPath = path.join(adeDir, "ade.yaml");
  const localConfigPath = path.join(adeDir, "local.yaml");
  const attachedSocketAvailable =
    connection.mode === "runtime-socket" ||
    connection.mode === "desktop-socket";
  const desktopSocketAvailable = connection.mode === "desktop-socket";
  const socketExists = isAdeRuntimeNamedPipePath(connection.socketPath)
    ? attachedSocketAvailable
    : fs.existsSync(connection.socketPath);
  const checks = {
    git: checkGitReadiness(connection.projectRoot),
    github: checkGitHubReadiness(connection.projectRoot),
    linear: checkLinearReadiness(connection.projectRoot),
    providers: checkProviderReadiness(projectConfig),
    computerUse: checkComputerUseReadiness(),
    path: checkPathReadiness(),
    storage: checkStorageReadiness(connection.projectRoot),
    sync: checkSyncReadiness(values.syncStatus),
  };
  const recommendations = Object.entries(checks)
    .filter(([, check]) => check.nextAction)
    .map(([key, check]) => `${key}: ${check.nextAction}`);
  if (!attachedSocketAvailable) {
    recommendations.unshift(
      "runtime: Start ADE runtime or remove --headless when Work chat, Run tab state, or shared proof state is required.",
    );
  }
  const projectInitialized = fs.existsSync(adeDir);
  if (!projectInitialized) {
    recommendations.unshift(
      "project: Run ade doctor from an ADE project or pass --project-root <repo>.",
    );
  }
  const actionCountsByDomain = actionDomainCounts(values.actions);
  const ready = projectInitialized && checks.git.ready && actions.length > 0;

  return {
    ok: ready,
    cliVersion: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    mode: connection.mode,
    selectedMode: connection.mode,
    requestedMode:
      connection.mode === "runtime-socket"
        ? "runtime-socket"
        : desktopSocketAvailable
          ? "desktop-socket"
          : "headless",
    runtime: {
      node: process.version,
      execPath: process.execPath,
      electron: process.versions.electron ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    projectRoot: connection.projectRoot,
    workspaceRoot: connection.workspaceRoot,
    project: {
      projectRoot: connection.projectRoot,
      workspaceRoot: connection.workspaceRoot,
      adeDir,
      projectInitialized,
      sharedConfigPath,
      sharedConfigPresent: fs.existsSync(sharedConfigPath),
      localConfigPath,
      localConfigPresent: fs.existsSync(localConfigPath),
    },
    desktop: {
      socketPath: connection.socketPath,
      socketExists,
      socketAvailable: attachedSocketAvailable,
      socketMode: connection.mode,
      message:
        connection.mode === "runtime-socket"
          ? "Connected to ADE runtime endpoint."
          : desktopSocketAvailable
            ? "Connected to legacy ADE desktop socket."
            : socketExists
              ? "Socket path exists but CLI is running in headless mode; the socket may be stale or unavailable."
              : "No live ADE runtime endpoint was detected.",
    },
    actions: {
      rpcActionCount: rpcActions.length,
      actionCount: actions.length,
      byDomain: actionCountsByDomain,
    },
    git: checks.git,
    github: checks.github,
    linear: checks.linear,
    providers: checks.providers,
    computerUse: checks.computerUse,
    path: checks.path,
    storage: checks.storage,
    sync: checks.sync,
    auth: {
      localProjectAccess: projectInitialized && actions.length > 0,
      providerSecretsExposed: false,
      note: "ADE CLI auth is local project access. Provider and integration readiness is reported as presence-only metadata.",
    },
    networkChecks: {
      performed: false,
      message:
        "Default doctor/auth checks do not call provider, GitHub, or Linear networks.",
    },
    recommendations,
    recommendation:
      recommendations[0] ??
      (attachedSocketAvailable
        ? "Using live ADE runtime state."
        : "Headless mode is ready for local ADE actions; start ADE runtime for shared runtime state."),
    summary,
  };
}

function createSocketConnection(socketPath: string): net.Socket {
  if (socketPath.startsWith("tcp://")) {
    const parsed = new URL(socketPath);
    return net.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port),
    });
  }
  return net.createConnection(socketPath);
}

async function probeLocalSocketForLiveness(socketPath: string): Promise<"live" | "stale" | "unknown"> {
  if (socketPath.startsWith("tcp://") || isAdeRuntimeNamedPipePath(socketPath)) {
    return "unknown";
  }
  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: "live" | "stale" | "unknown") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    timer = setTimeout(() => finish("unknown"), 500);
    socket.once("connect", () => finish("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        finish("stale");
        return;
      }
      finish("unknown");
    });
  });
}

function isRetryableSocketConnectError(error: NodeJS.ErrnoException): boolean {
  return (
    error.code === "ENOENT" ||
    error.code === "ECONNREFUSED" ||
    error.code === "EACCES" ||
    error.code === "EPERM"
  );
}

function connectSocket(
  socketPath: string,
  timeoutMs: number,
  label: string,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const connectTimeoutMs = Math.min(timeoutMs, 5000);
    const deadline = Date.now() + connectTimeoutMs;
    const attempt = () => {
      const socket = createSocketConnection(socketPath);
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        fn();
      };
      connectTimer = setTimeout(
        () => {
          finish(() => {
            socket.destroy();
            reject(
              new Error(
                `Timed out connecting to ${label} after ${connectTimeoutMs}ms.`,
              ),
            );
          });
        },
        Math.max(1, deadline - Date.now()),
      );
      socket.once("connect", () => {
        finish(() => resolve(socket));
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        finish(() => {
          socket.destroy();
          if (isRetryableSocketConnectError(error) && Date.now() < deadline) {
            setTimeout(attempt, 100);
            return;
          }
          reject(error);
        });
      });
    };
    attempt();
  });
}

class SocketJsonRpcClient {
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private closedError: Error | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private notificationHandlers = new Map<
    string,
    Set<(params: unknown) => void>
  >();
  private anyNotificationHandlers = new Set<
    (method: string, params: unknown) => void
  >();
  private closeHandlers = new Set<(error: Error) => void>();

  private constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
    private readonly authToken: string | null,
  ) {
    socket.on("data", (chunk) => this.onData(Buffer.from(chunk)));
    socket.on("error", (error) =>
      this.rejectAll(error instanceof Error ? error : new Error(String(error))),
    );
    socket.on("close", () =>
      this.failConnection(new Error("ADE runtime endpoint closed.")),
    );
  }

  static async connect(
    socketPath: string,
    timeoutMs: number,
    label = "ADE endpoint",
  ): Promise<SocketJsonRpcClient> {
    const socket = await connectSocket(socketPath, timeoutMs, label);
    return new SocketJsonRpcClient(
      socket,
      timeoutMs,
      parseRpcUrlAuthToken(socketPath),
    );
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId;
    this.nextId += 1;
    const authedParams = withRpcAuthParam(params, this.authToken);
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(authedParams !== undefined ? { params: authedParams } : {}),
    };
    const body = `${JSON.stringify(payload)}\n`;
    return new Promise((resolve, reject) => {
      const pendingKey = String(id);
      const timer = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, this.timeoutMs);
      this.pending.set(pendingKey, { resolve, reject, timer });
      this.socket.write(body, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(pendingKey);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) return;
    const authedParams = withRpcAuthParam(params, this.authToken);
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      ...(authedParams !== undefined ? { params: authedParams } : {}),
    };
    this.socket.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  onClose(handler: (error: Error) => void): () => void {
    if (this.closedError) {
      const error = this.closedError;
      queueMicrotask(() => handler(error));
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void {
    const handlers =
      this.notificationHandlers.get(method) ??
      new Set<(params: unknown) => void>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.notificationHandlers.delete(method);
    };
  }

  onAnyNotification(
    handler: (method: string, params: unknown) => void,
  ): () => void {
    this.anyNotificationHandlers.add(handler);
    return () => {
      this.anyNotificationHandlers.delete(handler);
    };
  }

  close(): void {
    this.socket.end();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.rejectAll(
        new Error(
          `Failed to parse ADE endpoint response: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    if (!isRecord(parsed)) return;
    const id = typeof parsed.id === "number" || typeof parsed.id === "string" ? parsed.id : null;
    if (id == null) {
      const method = asString(parsed.method);
      if (!method) return;
      for (const handler of this.notificationHandlers.get(method) ?? []) {
        handler(parsed.params);
      }
      for (const handler of this.anyNotificationHandlers) {
        handler(method, parsed.params);
      }
      return;
    }
    const pendingKey = String(id);
    const pending = this.pending.get(pendingKey);
    if (!pending) return;
    this.pending.delete(pendingKey);
    clearTimeout(pending.timer);
    if (isRecord(parsed.error)) {
      pending.reject(
        new Error(
          asString(parsed.error.message) ?? "ADE JSON-RPC request failed.",
        ),
      );
      return;
    }
    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private failConnection(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.rejectAll(error);
    for (const handler of this.closeHandlers) {
      handler(error);
    }
    this.closeHandlers.clear();
  }
}

class InProcessJsonRpcClient {
  private nextId = 1;

  constructor(
    private readonly handler: JsonRpcHandler & { dispose?: () => void },
    private readonly runtime: { dispose: () => void },
    private readonly previousRole: string | undefined,
  ) {}

  async request(method: string, params?: JsonObject): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId as JsonRpcId,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.nextId += 1;
    return await this.handler(request);
  }

  close(): void {
    try {
      this.handler.dispose?.();
    } catch {}
    try {
      this.runtime.dispose();
    } catch {}
    if (this.previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
    else process.env.ADE_DEFAULT_ROLE = this.previousRole;
  }
}

async function startHeadlessRpcSocketServer(args: {
  socketPath: string;
  createHandler: () => JsonRpcHandler & { dispose?: () => void };
}): Promise<(() => void) | null> {
  if (
    isAdeRuntimeNamedPipePath(args.socketPath) ||
    fs.existsSync(args.socketPath)
  ) {
    return null;
  }
  fs.mkdirSync(path.dirname(args.socketPath), { recursive: true, mode: 0o700 });
  const serverState = createHeadlessRpcServer(args.createHandler);
  const { server } = serverState;

  await new Promise<void>((resolve, reject) => {
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    server.once("listening", handleListening);
    server.once("error", handleError);
    server.listen(args.socketPath);
  });

  if (!isAdeRuntimeNamedPipePath(args.socketPath)) {
    try {
      fs.chmodSync(args.socketPath, 0o600);
    } catch {}
  }

  return () => {
    stopHeadlessRpcServer(serverState);
    try {
      fs.unlinkSync(args.socketPath);
    } catch {}
  };
}

// CONTRACT: every request reaching the TCP listener must carry the per-boot
// bearer token in its params. The unix socket relies on 0600 file permissions,
// but 127.0.0.1 TCP is reachable by every local user, so the token is the only
// boundary there. Mirrors desktopBridgeServer.ts (built-in browser bridge).
function withRpcAuthTokenGate(
  createHandler: () => JsonRpcHandler & { dispose?: () => void },
  authToken: string,
): () => JsonRpcHandler & { dispose?: () => void } {
  return () => {
    const handler = createHandler();
    const wrapped: JsonRpcHandler & { dispose?: () => void } = async (
      request,
    ) => {
      const params = isRecord(request.params) ? { ...request.params } : null;
      const provided =
        params && typeof params[ADE_RPC_AUTH_PARAM] === "string"
          ? (params[ADE_RPC_AUTH_PARAM] as string).trim()
          : "";
      if (!params || !safeRpcAuthTokenEquals(provided, authToken)) {
        throw new JsonRpcError(
          JsonRpcErrorCode.policyDenied,
          "ADE RPC TCP authentication failed.",
        );
      }
      delete params[ADE_RPC_AUTH_PARAM];
      return handler({ ...request, params });
    };
    if (handler.dispose) {
      wrapped.dispose = () => handler.dispose!();
    }
    const notifiable = handler as NotifiableJsonRpcHandler;
    if (typeof notifiable.setNotifier === "function") {
      (wrapped as NotifiableJsonRpcHandler).setNotifier = (notify) =>
        notifiable.setNotifier!(notify);
    }
    return wrapped;
  };
}

async function startHeadlessRpcTcpServer(args: {
  createHandler: () => JsonRpcHandler & { dispose?: () => void };
}): Promise<{ url: string; stop: () => void }> {
  const authToken = generateRpcAuthToken();
  const serverState = createHeadlessRpcServer(
    withRpcAuthTokenGate(args.createHandler, authToken),
  );
  const { server } = serverState;

  const port = await new Promise<number>((resolve, reject) => {
    const handleListening = () => {
      server.off("error", handleError);
      const address = server.address();
      if (
        typeof address === "object" &&
        address &&
        typeof address.port === "number"
      ) {
        resolve(address.port);
      } else {
        reject(new Error("Headless RPC TCP server did not expose a port."));
      }
    };
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    server.once("listening", handleListening);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1");
  });

  return {
    // The token rides in the URL so every existing ADE_RPC_URL consumer
    // (child `ade` processes, the TUI's --socket flag) receives it without a
    // second env var; parseRpcUrlAuthToken extracts it client-side.
    url: `tcp://127.0.0.1:${port}?token=${authToken}`,
    stop: () => stopHeadlessRpcServer(serverState),
  };
}

type HeadlessRpcServerState = {
  activeConnections: Set<net.Socket>;
  activeStops: Set<ReturnType<typeof startJsonRpcServer>>;
  server: net.Server;
};

type NotifiableJsonRpcHandler = JsonRpcHandler & {
  setNotifier?: (
    notify: ((method: string, params?: unknown) => void) | null,
  ) => void;
};

function reportContainedJsonRpcError(
  error: unknown,
  context: JsonRpcServerErrorContext,
): void {
  const message = formatDiagnosticError(error);
  try {
    process.stderr.write(`ade jsonrpc ${context} error: ${message}\n`);
  } catch {
    // Stderr may be gone during shutdown; contained errors should stay contained.
  }
}

function formatDiagnosticError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function installRuntimeProcessErrorBoundary(label: string): () => void {
  const rejectionWindowMs = 60_000;
  const rejectionLogLimit = 5;
  let rejectionWindowStart = 0;
  let rejectionCount = 0;
  let suppressedRejectionCount = 0;
  const write = (kind: string, error: unknown): void => {
    try {
      process.stderr.write(`${label} contained ${kind}: ${formatDiagnosticError(error)}\n`);
    } catch {
      // Nothing useful can be done if stderr is already gone.
    }
  };
  const onUnhandledRejection = (reason: unknown): void => {
    const now = Date.now();
    if (now - rejectionWindowStart > rejectionWindowMs) {
      if (suppressedRejectionCount > 0) {
        write("unhandled rejection summary", `${suppressedRejectionCount} additional rejection(s) suppressed`);
      }
      rejectionWindowStart = now;
      rejectionCount = 0;
      suppressedRejectionCount = 0;
    }
    rejectionCount += 1;
    // A single late async rejection must not tear down the project runtime:
    // this process owns active Work chats, PTYs, and managed processes.
    // JSON-RPC dispatch already returns per-request errors; anything that
    // still reaches here is logged for diagnosis while the runtime stays up.
    if (rejectionCount <= rejectionLogLimit) {
      write("unhandled rejection", reason);
      return;
    }
    suppressedRejectionCount += 1;
    if (rejectionCount === rejectionLogLimit + 1) {
      write("unhandled rejection rate limit", `suppressing additional rejections for ${rejectionWindowMs}ms`);
    }
  };
  const onUncaughtException = (error: Error): void => {
    write("fatal uncaught exception", error);
    process.exit(1);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  return () => {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
  };
}

function createHeadlessRpcServer(
  createHandler: () => JsonRpcHandler & { dispose?: () => void },
): HeadlessRpcServerState {
  const activeConnections = new Set<net.Socket>();
  const activeStops = new Set<ReturnType<typeof startJsonRpcServer>>();
  const server = net.createServer((conn) => {
    activeConnections.add(conn);
    const handler = createHandler();
    const transport: JsonRpcTransport = {
      onData(callback) {
        conn.on("data", (chunk) =>
          callback(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
      },
      write(data) {
        conn.write(data);
      },
      close() {
        if (!conn.destroyed) conn.destroy();
      },
    };
    const stop = startJsonRpcServer(handler, transport, {
      nonFatal: true,
      onError: reportContainedJsonRpcError,
    });
    (handler as NotifiableJsonRpcHandler).setNotifier?.((method, params) =>
      stop.notify(method, params),
    );
    activeStops.add(stop);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      activeConnections.delete(conn);
      activeStops.delete(stop);
      try {
        stop();
      } catch {}
      try {
        handler.dispose?.();
      } catch {}
    };
    conn.once("close", cleanup);
    conn.once("end", cleanup);
    conn.once("error", cleanup);
    conn.on("error", () => {});
  });
  return { activeConnections, activeStops, server };
}

function stopHeadlessRpcServer(state: HeadlessRpcServerState): void {
  for (const conn of state.activeConnections) {
    try {
      conn.destroy();
    } catch {}
  }
  for (const stop of state.activeStops) {
    try {
      stop();
    } catch {}
  }
  try {
    state.server.close();
  } catch {}
}

function discoverHeadlessWorktreeSocketPaths(projectRoot: string): string[] {
  const worktreesDir = path.join(projectRoot, ".ade", "worktrees");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(worktreesDir);
  } catch {
    return [];
  }
  const socketPaths: string[] = [];
  for (const entry of entries) {
    const worktreePath = path.join(worktreesDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(worktreePath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const worktreeAdeDir = path.join(worktreePath, ".ade");
    try {
      fs.mkdirSync(worktreeAdeDir, { recursive: true });
    } catch {
      continue;
    }
    socketPaths.push(path.join(worktreeAdeDir, "ade.sock"));
  }
  return socketPaths;
}

async function startHeadlessRpcSocketServers(args: {
  projectRoot: string;
  socketPath: string;
  createHandler: () => JsonRpcHandler & { dispose?: () => void };
}): Promise<() => void> {
  const stops = new Map<string, () => void>();
  const pending = new Set<string>();
  let stopped = false;

  const ensure = async (socketPath: string) => {
    if (stopped || stops.has(socketPath) || pending.has(socketPath)) return;
    pending.add(socketPath);
    try {
      const stop = await startHeadlessRpcSocketServer({
        socketPath,
        createHandler: args.createHandler,
      });
      if (stop) stops.set(socketPath, stop);
    } catch {
      // Keep the primary in-process client usable even when a mirror socket
      // cannot be created yet. The next scan will retry missing sockets.
    } finally {
      pending.delete(socketPath);
    }
  };

  const scan = async () => {
    await ensure(args.socketPath);
    await Promise.all(
      discoverHeadlessWorktreeSocketPaths(args.projectRoot).map((socketPath) =>
        ensure(socketPath),
      ),
    );
  };

  await scan();
  const interval = setInterval(() => {
    void scan();
  }, 500);
  interval.unref?.();

  return () => {
    stopped = true;
    clearInterval(interval);
    for (const stop of stops.values()) {
      try {
        stop();
      } catch {}
    }
    stops.clear();
  };
}

export function shouldAttemptDesktopSocketConnection(
  socketPath: string,
): boolean {
  return isAdeRuntimeNamedPipePath(socketPath) || fs.existsSync(socketPath);
}

async function initializeConnection(
  connection: CliConnection,
  options: GlobalOptions,
): Promise<void> {
  await connection.request(
    "ade/initialize",
    buildInitializeParams(options, "ade-cli"),
  );
}

function isMachineRuntimeScopedMethod(method: string): boolean {
  return (
    method === "ade/initialize" ||
    method === "ade/initialized" ||
    method === "ping" ||
    method === "shutdown" ||
    method === "exit" ||
    method === "runtime/info" ||
    method === "machineInfo.get" ||
    method.startsWith("account.") ||
    method.startsWith("sync.") ||
    method.startsWith("projects.") ||
    method.startsWith("personalChats.")
  );
}

export function shouldAutoRegisterProjectForPlan(
  plan: CliPlan & { kind: "execute" },
): boolean {
  return plan.steps.some((step) => !isMachineRuntimeScopedMethod(step.method));
}

export function automaticProjectRegistrationParams(rootPath: string): {
  rootPath: string;
  catalogVisibility: "system";
  registrationSource: "runtime-auto";
} {
  return {
    rootPath,
    catalogVisibility: "system",
    registrationSource: "runtime-auto",
  };
}

function buildMachinesPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "list" || sub === "ls") {
    if (firstStandalonePositional(args)) {
      throw new CliUsageError("machines list does not accept a machine selector.");
    }
    return {
      kind: "execute",
      label: "account machines list",
      formatter: "account-machines",
      machineOnly: true,
      machineAutoStart: true,
      connectRole: "cto",
      steps: [accountActionStep("result", "listMachines")],
    };
  }
  if (sub === "connect" || sub === "hop" || sub === "code") {
    const machine = readValue(args, ["--machine", "--target"])
      ?? firstStandalonePositional(args);
    if (!machine?.trim()) {
      throw new CliUsageError(
        `machines ${sub} requires a stable machine key, device id, or unambiguous display name.`,
      );
    }
    return {
      kind: "account-machine-connect",
      machine: machine.trim(),
      remoteArgs: args,
    };
  }
  throw new CliUsageError("machines supports list, connect, or hop.");
}

function buildSyncPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "help") {
    return {
      kind: "help",
      text: `${ADE_BANNER}
Usage:
  ade sync status [--include-transfer-readiness]
  ade sync web [--open] [--no-clipboard]   Print (and copy) the web client pairing link + code
  ade sync refresh
  ade sync devices
  ade sync pin get
  ade sync pin generate
  ade sync pin set <6-digit-pin>
  ade sync pin clear
  ade sync name <name>              Name this runtime for easy identification
  ade sync name get
  ade sync name clear
  ade sync security status          Machine sync security posture (require-DPoP)
  ade sync security require-dpop <on|off>
  ade sync pair-device --json-stdin Advanced: authorize pairing through a trusted local/SSH session
`,
    };
  }
  if (sub === "web" || sub === "web-pair" || sub === "webclient") {
    const open = readFlag(args, ["--open"]);
    const noClipboard = readFlag(args, ["--no-clipboard"]);
    return {
      kind: "execute",
      label: "sync web",
      formatter: "sync-web",
      syncWebOpen: open,
      syncWebNoClipboard: noClipboard,
      steps: [{ key: "result", method: "sync.getStatus" }],
    };
  }
  if (sub === "status") {
    return {
      kind: "execute",
      label: "sync status",
      formatter: "sync-status",
      steps: [
        {
          key: "result",
          method: "sync.getStatus",
          params: {
            includeTransferReadiness: readFlag(args, [
              "--include-transfer-readiness",
            ]),
            forceTransferReadiness: readFlag(args, [
              "--force-transfer-readiness",
            ]),
          },
        },
      ],
    };
  }
  if (sub === "pair-device") {
    if (!readFlag(args, ["--json-stdin"])) {
      throw new CliUsageError("sync pair-device requires --json-stdin; pairing secrets are never accepted in arguments.");
    }
    if (args.length > 0) {
      throw new CliUsageError(
        "sync pair-device accepts only --json-stdin; put the complete pairing request on stdin so secrets never appear in command arguments.",
      );
    }
    const request = parseObjectJson(
      readBoundedStdinSync(64 * 1024, "SSH pairing request"),
      "SSH pairing request",
    );
    return {
      kind: "execute",
      label: "sync pair-device",
      machineOnly: true,
      machineAutoStart: true,
      steps: [{ key: "result", method: "sync.authorizeSshPairing", params: request }],
    };
  }
  if (sub === "refresh" || sub === "refresh-discovery") {
    return {
      kind: "execute",
      label: "sync refresh",
      steps: [{ key: "result", method: "sync.refreshDiscovery" }],
    };
  }
  if (sub === "devices" || sub === "list-devices") {
    return {
      kind: "execute",
      label: "sync devices",
      steps: [{ key: "result", method: "sync.listDevices" }],
    };
  }
  if (sub === "pin") {
    const action = firstPositional(args) ?? "get";
    if (action === "get" || action === "show") {
      return {
        kind: "execute",
        label: "sync pin get",
        steps: [{ key: "result", method: "sync.getPin" }],
      };
    }
    if (action === "set") {
      const pin = requireValue(
        readValue(args, ["--pin"]) ?? firstPositional(args),
        "pin",
      );
      return {
        kind: "execute",
        label: "sync pin set",
        steps: [{ key: "result", method: "sync.setPin", params: { pin } }],
      };
    }
    if (action === "generate" || action === "new") {
      return {
        kind: "execute",
        label: "sync pin generate",
        steps: [{ key: "result", method: "sync.generatePin" }],
      };
    }
    if (action === "clear" || action === "remove") {
      return {
        kind: "execute",
        label: "sync pin clear",
        steps: [{ key: "result", method: "sync.clearPin" }],
      };
    }
    throw new CliUsageError(`Unsupported sync pin action: ${action}`);
  }
  if (sub === "name") {
    // `ade sync name <name>` names THIS runtime for easy identification (so two
    // runtimes on one machine are distinguishable on the phone). `get`/`clear`
    // read/remove it; a bare value (or `set <name>`) sets it.
    const action = firstPositional(args) ?? "get";
    if (action === "get" || action === "show") {
      return {
        kind: "execute",
        label: "sync name get",
        steps: [{ key: "result", method: "sync.getRuntimeName" }],
      };
    }
    if (action === "clear" || action === "remove") {
      return {
        kind: "execute",
        label: "sync name clear",
        steps: [{ key: "result", method: "sync.clearRuntimeName" }],
      };
    }
    const name =
      action === "set"
        ? requireValue(readValue(args, ["--name"]) ?? firstPositional(args), "name")
        : action;
    return {
      kind: "execute",
      label: "sync name set",
      steps: [{ key: "result", method: "sync.setRuntimeName", params: { name } }],
    };
  }
  if (sub === "security") {
    // Machine-level sync security posture. Today the only knob is require-DPoP,
    // otherwise reachable solely via ADE_SYNC_REQUIRE_DPOP; headless operators
    // need a persistent CLI toggle.
    const action = firstPositional(args) ?? "status";
    if (action === "status" || action === "show" || action === "get") {
      return {
        kind: "execute",
        label: "sync security status",
        steps: [{ key: "result", method: "sync.getRequireDpop" }],
      };
    }
    if (action === "require-dpop" || action === "dpop") {
      const raw = requireValue(
        readValue(args, ["--require-dpop"]) ?? firstPositional(args),
        "on|off",
      );
      const normalized = raw.toLowerCase();
      const enabled =
        normalized === "on" ||
        normalized === "true" ||
        normalized === "enable" ||
        normalized === "1";
      const disabled =
        normalized === "off" ||
        normalized === "false" ||
        normalized === "disable" ||
        normalized === "0";
      if (!enabled && !disabled) {
        throw new CliUsageError(
          "sync security require-dpop expects on or off.",
        );
      }
      return {
        kind: "execute",
        label: `sync security require-dpop ${enabled ? "on" : "off"}`,
        steps: [
          {
            key: "result",
            method: "sync.setRequireDpop",
            params: { requireDpop: enabled },
          },
        ],
      };
    }
    throw new CliUsageError(`Unsupported sync security action: ${action}`);
  }
  throw new CliUsageError(`Unsupported sync command: ${sub}`);
}

function buildProjectsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "list" || sub === "ls") {
    return {
      kind: "execute",
      label: "projects list",
      formatter: "projects-list",
      steps: [{ key: "result", method: "projects.list" }],
    };
  }
  if (sub === "add" || sub === "register") {
    const rootPath = requireValue(
      readValue(args, ["--path", "--root"]) ?? firstPositional(args),
      "project path",
    );
    return {
      kind: "execute",
      label: "projects add",
      formatter: "projects-list",
      steps: [{
        key: "result",
        method: "projects.add",
        params: {
          rootPath,
          catalogVisibility: "recent",
          registrationSource: "cli-explicit",
        },
      }],
    };
  }
  if (sub === "remove" || sub === "rm" || sub === "delete") {
    const projectId = requireValue(
      readValue(args, ["--project-id", "--id"]) ?? firstPositional(args),
      "project id",
    );
    return {
      kind: "execute",
      label: "projects remove",
      steps: [
        { key: "result", method: "projects.remove", params: { projectId } },
      ],
    };
  }
  if (sub === "touch") {
    const projectId = requireValue(
      readValue(args, ["--project-id", "--id"]) ?? firstPositional(args),
      "project id",
    );
    return {
      kind: "execute",
      label: "projects touch",
      formatter: "projects-list",
      steps: [
        { key: "result", method: "projects.touch", params: { projectId } },
      ],
    };
  }
  if (sub === "inspect") {
    const targetPath = requireValue(
      readValue(args, ["--path"]) ?? firstPositional(args),
      "path",
    );
    return {
      kind: "execute",
      label: "projects inspect",
      steps: [
        {
          key: "result",
          method: "projects.inspectPath",
          params: { path: targetPath },
        },
      ],
    };
  }
  throw new CliUsageError(
    `projects supports list, add, remove, touch, or inspect; got '${sub}'.`,
  );
}

function withProjectId(
  params: JsonObject | undefined,
  projectId: string,
): JsonObject {
  return {
    ...(params ?? {}),
    projectId,
  };
}

async function createConnection(
  options: GlobalOptions,
  args: { autoRegisterProject?: boolean; machineRuntimeOnly?: boolean } = {},
): Promise<CliConnection> {
  const roots = resolveRoots(options);
  const { resolveAdeLayout } =
    await import("../../desktop/src/shared/adeLayout");
  const layout = resolveAdeLayout(roots.projectRoot);
  const socketPathOverride = options.socketPath?.trim() || null;
  const legacySocketPath =
    socketPathOverride ||
    process.env.ADE_RPC_URL?.trim() ||
    process.env.ADE_RPC_SOCKET_PATH?.trim() ||
    layout.socketPath;
  const autoRegisterProject = args.autoRegisterProject ?? true;

  if (!options.headless) {
    let socketClient: SocketJsonRpcClient | null = null;
    try {
      const machineSocketPath = await resolveMachineRuntimeSocketPath(socketPathOverride);
      socketClient = await connectMachineRuntimeDaemon(options, socketPathOverride);
      let activeProjectId: string | null = null;
      const connection: CliConnection = {
        mode: "runtime-socket",
        projectRoot: roots.projectRoot,
        workspaceRoot: roots.workspaceRoot,
        socketPath: machineSocketPath,
        request: (method, params) =>
          socketClient!.request(
            method,
            activeProjectId && !isMachineRuntimeScopedMethod(method)
              ? withProjectId(params, activeProjectId)
              : params,
          ),
        close: () => socketClient?.close(),
      };
      if (autoRegisterProject) {
        const registered = await connection.request(
          "projects.add",
          automaticProjectRegistrationParams(roots.projectRoot),
        );
        const registeredProjectId = isRecord(registered)
          ? asString(registered.projectId)
          : null;
        if (!registeredProjectId) {
          throw new Error(
            "Machine runtime did not return a projectId from projects.add.",
          );
        }
        activeProjectId = registeredProjectId;
      }
      return connection;
    } catch (error) {
      try {
        socketClient?.close();
      } catch {}
      if (args.machineRuntimeOnly) throw error;
      if (
        options.requireSocket &&
        !shouldAttemptDesktopSocketConnection(legacySocketPath)
      ) {
        throw error;
      }
    }
  }

  if (
    !options.headless &&
    (shouldAttemptDesktopSocketConnection(legacySocketPath) ||
      options.requireSocket)
  ) {
    try {
      const socketClient = await SocketJsonRpcClient.connect(
        legacySocketPath,
        options.timeoutMs,
      );
      const connection: CliConnection = {
        mode: "desktop-socket",
        projectRoot: roots.projectRoot,
        workspaceRoot: roots.workspaceRoot,
        socketPath: legacySocketPath,
        request: (method, params) => socketClient.request(method, params),
        close: () => socketClient.close(),
      };
      await initializeConnection(connection, options);
      return connection;
    } catch (error) {
      if (options.requireSocket) throw error;
    }
  }

  if (options.requireSocket) {
    throw new Error(`ADE endpoint is not available at ${legacySocketPath}.`);
  }

  const previousRole = process.env.ADE_DEFAULT_ROLE;
  const previousRpcUrl = process.env.ADE_RPC_URL;
  let roleOwnedByConnection = false;
  process.env.ADE_DEFAULT_ROLE = options.role;
  const restoreRole = () => {
    if (roleOwnedByConnection) return;
    if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
    else process.env.ADE_DEFAULT_ROLE = previousRole;
  };
  const restoreRpcUrl = () => {
    if (previousRpcUrl == null) delete process.env.ADE_RPC_URL;
    else process.env.ADE_RPC_URL = previousRpcUrl;
  };
  let runtime: AdeRuntime | null = null;
  let handler: (JsonRpcHandler & { dispose?: () => void }) | null = null;
  let stopHeadlessSocket: (() => void) | null = null;
  let stopHeadlessTcp: (() => void) | null = null;
  try {
    const [{ createAdeRuntime }, { createAdeRpcRequestHandler }] =
      await Promise.all([import("./bootstrap"), import("./adeRpcServer")]);
    runtime = await createAdeRuntime({
      projectRoot: roots.projectRoot,
      workspaceRoot: roots.workspaceRoot,
    });
    const createHandler = () =>
      createAdeRpcRequestHandler({
        runtime: runtime!,
        serverVersion: VERSION,
      });
    handler = createHandler();
    try {
      const tcp = await startHeadlessRpcTcpServer({ createHandler });
      process.env.ADE_RPC_URL = tcp.url;
      stopHeadlessTcp = tcp.stop;
    } catch {
      stopHeadlessTcp = null;
    }
    try {
      stopHeadlessSocket = await startHeadlessRpcSocketServers({
        projectRoot: roots.projectRoot,
        socketPath: legacySocketPath,
        createHandler,
      });
    } catch {
      stopHeadlessSocket = null;
    }

    const inProcess = new InProcessJsonRpcClient(handler, runtime, previousRole);
    const connection: CliConnection = {
      mode: "headless",
      projectRoot: roots.projectRoot,
      workspaceRoot: roots.workspaceRoot,
      socketPath: legacySocketPath,
      request: (method, params) => inProcess.request(method, params),
      close: () => {
        try {
          stopHeadlessSocket?.();
        } catch {}
        try {
          stopHeadlessTcp?.();
        } catch {}
        restoreRpcUrl();
        inProcess.close();
      },
    };
    roleOwnedByConnection = true;
    try {
      await initializeConnection(connection, options);
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  } catch (error) {
    try {
      stopHeadlessSocket?.();
    } catch {}
    try {
      stopHeadlessTcp?.();
    } catch {}
    try {
      handler?.dispose?.();
    } catch {}
    try {
      runtime?.dispose();
    } catch {}
    restoreRpcUrl();
    restoreRole();
    throw error;
  }
}

function buildInitializeParams(
  options: GlobalOptions,
  clientName: string,
): JsonObject {
  const envChatSessionId = asString(process.env.ADE_CHAT_SESSION_ID);
  const envRunId = asString(process.env.ADE_RUN_ID);
  const envStepId = asString(process.env.ADE_STEP_ID);
  const envAttemptId = asString(process.env.ADE_ATTEMPT_ID);
  const envOwnerId = asString(process.env.ADE_OWNER_ID);
  const browserActorToken = asString(process.env.ADE_BROWSER_ACTOR_TOKEN);
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: clientName, version: VERSION },
    identity: {
      callerId:
        envChatSessionId ?? envAttemptId ?? `${clientName}:${process.pid}`,
      role: options.role,
      ...(envChatSessionId ? { chatSessionId: envChatSessionId } : {}),
      ...(envRunId ? { runId: envRunId } : {}),
      ...(envStepId ? { stepId: envStepId } : {}),
      ...(envAttemptId ? { attemptId: envAttemptId } : {}),
      ...(envOwnerId ? { ownerId: envOwnerId } : {}),
      ...(browserActorToken ? { browserActorToken } : {}),
      computerUsePolicy: {
        mode: "auto",
        allowLocalFallback: options.role !== "external",
        retainArtifacts: true,
      },
    },
  };
}

function parseOptionalPort(value: string | null, label: string): number | null {
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new CliUsageError(`${label} must be a TCP port between 1 and 65535.`);
  }
  return parsed;
}

function normalizeRuntimeSocketPath(rawSocketPath: string): string {
  return rawSocketPath.startsWith("tcp://") ||
    isAdeRuntimeNamedPipePath(rawSocketPath)
    ? rawSocketPath
    : path.resolve(rawSocketPath);
}

function isEphemeralRuntimeSocketPath(socketPath: string): boolean {
  if (socketPath.startsWith("tcp://") || isAdeRuntimeNamedPipePath(socketPath)) {
    return false;
  }
  const normalizedSocketPath = path.resolve(socketPath);
  const tmpDirs = Array.from(new Set(
    [os.tmpdir(), realpathSyncSafe(os.tmpdir()), "/tmp", realpathSyncSafe("/tmp")]
      .map((dir) => path.resolve(dir)),
  ));
  for (const tmpDir of tmpDirs) {
    const relativeToTmp = path.relative(tmpDir, normalizedSocketPath);
    if (relativeToTmp.startsWith("..") || path.isAbsolute(relativeToTmp)) continue;
    return /(^|[/\\])ade-(stdio-rpc|code|local-runtime)[^/\\]*/.test(relativeToTmp);
  }
  return false;
}

function realpathSyncSafe(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

async function resolveMachineRuntimeSocketPath(
  rawOverride?: string | null,
): Promise<string> {
  const { resolveMachineAdeLayout } =
    await import("./services/projects/machineLayout");
  const rawSocketPath =
    rawOverride?.trim() ||
    process.env.ADE_RUNTIME_SOCKET_PATH?.trim() ||
    resolveMachineAdeLayout().socketPath;
  return normalizeRuntimeSocketPath(rawSocketPath);
}

type MachineRuntimeInfo = {
  version: string | null;
  buildHash: string | null;
  defaultRole: string | null;
  packageChannel: string | null;
  projectRoot: string | null;
  pid: number | null;
};

function readMachineRuntimeInfo(value: unknown): MachineRuntimeInfo {
  if (!isRecord(value) || !isRecord(value.runtimeInfo)) {
    return {
      version: null,
      buildHash: null,
      defaultRole: null,
      packageChannel: null,
      projectRoot: null,
      pid: null,
    };
  }
  const pid = value.runtimeInfo.pid;
  return {
    version: asString(value.runtimeInfo.version),
    buildHash: asString(value.runtimeInfo.buildHash),
    defaultRole: normalizeAdeRuntimeRole(value.runtimeInfo.defaultRole),
    packageChannel: asString(value.runtimeInfo.packageChannel),
    projectRoot: asString(value.runtimeInfo.projectRoot),
    pid:
      typeof pid === "number" && Number.isFinite(pid) && pid > 0
        ? Math.floor(pid)
        : null,
  };
}

function canRuntimeDefaultRoleServe(
  defaultRole: MachineRuntimeInfo["defaultRole"],
  requestedRole: GlobalOptions["role"],
): boolean {
  if (requestedRole === "external") return true;
  if (!defaultRole) return false;
  if (defaultRole === "cto") return true;
  if (defaultRole === "orchestrator") return requestedRole !== "cto";
  if (defaultRole === "agent") return requestedRole === "agent";
  if (defaultRole === "evaluator") return requestedRole === "evaluator";
  return false;
}

function machineRuntimeMismatchReason(
  runtimeInfo: MachineRuntimeInfo,
  expectedBuildHash: string | null,
  expectedDefaultRole: GlobalOptions["role"],
  options: { enforceBuildCompatibility?: boolean } = {},
): string | null {
  const enforceBuildCompatibility =
    options.enforceBuildCompatibility ?? true;
  if (enforceBuildCompatibility) {
    const runtimeVersion = runtimeInfo.version;
    const sourceCliTalkingToReleasedRuntime =
      VERSION === PLACEHOLDER_VERSION &&
      Boolean(runtimeVersion) &&
      runtimeVersion !== PLACEHOLDER_VERSION;
    if (VERSION !== PLACEHOLDER_VERSION) {
      const versionMatches = runtimeVersion === VERSION;
      const placeholderBuildMatches =
        runtimeVersion === PLACEHOLDER_VERSION &&
        expectedBuildHash != null &&
        runtimeInfo.buildHash === expectedBuildHash;
      if (!versionMatches && !placeholderBuildMatches) {
        return `version ${runtimeVersion ?? "missing"} does not match CLI version ${VERSION}`;
      }
    }

    if (
      !sourceCliTalkingToReleasedRuntime &&
      expectedBuildHash &&
      runtimeInfo.buildHash !== expectedBuildHash
    ) {
      return runtimeInfo.buildHash ? "build hash changed" : "build hash missing";
    }
  }
  if (!canRuntimeDefaultRoleServe(runtimeInfo.defaultRole, expectedDefaultRole)) {
    return `default role ${runtimeInfo.defaultRole ?? "missing"} cannot serve CLI role ${expectedDefaultRole}`;
  }
  return null;
}

export function shouldEnforceMachineRuntimeBuildCompatibility(
  socketPathOverride?: string | null,
): boolean {
  return !socketPathOverride?.trim();
}

function computeRuntimeBuildHash(filePath: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function prepareMachineRuntimeDaemonCommand(serviceCommand: AdeServiceCommand): {
  args: string[];
  buildHash: string | null;
} {
  const args = [...serviceCommand.args];
  let buildHash: string | null = null;
  if (
    serviceCommand.command === process.execPath &&
    args.length === 1 &&
    args[0] === "serve" &&
    fs.existsSync(CLI_DIST_PATH)
  ) {
    args.splice(0, 1, CLI_DIST_PATH, "serve");
    buildHash = computeRuntimeBuildHash(CLI_DIST_PATH);
  } else if (serviceCommand.command === process.execPath && args[0]) {
    buildHash = computeRuntimeBuildHash(path.resolve(args[0]));
  } else if (fs.existsSync(serviceCommand.command)) {
    buildHash = computeRuntimeBuildHash(path.resolve(serviceCommand.command));
  }
  return { args, buildHash };
}

async function resolveExpectedMachineRuntimeBuildHash(): Promise<string | null> {
  const { resolveAdeServeCommand } = await import("./serviceManager/common");
  return prepareMachineRuntimeDaemonCommand(resolveAdeServeCommand()).buildHash;
}

async function initializeMachineRuntimeDaemon(
  client: SocketJsonRpcClient,
  options: GlobalOptions,
): Promise<MachineRuntimeInfo> {
  const result = await client.request(
    "ade/initialize",
    buildInitializeParams(options, "ade-rpc-stdio-proxy"),
  );
  return readMachineRuntimeInfo(result);
}

async function shutdownMachineRuntimeDaemon(
  client: SocketJsonRpcClient,
): Promise<void> {
  try {
    await client.request("shutdown");
  } catch (error) {
    if (!isRuntimeShutdownCloseError(error)) throw error;
  } finally {
    try {
      client.close();
    } catch {}
  }
}

function isRuntimeShutdownCloseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("socket closed") || message.includes("runtime endpoint closed");
}

function shouldAllowRuntimeSelfShutdown(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION === "1";
}

class RuntimeSelfShutdownBlockedError extends Error {}

function isLocalRuntimeSocketPath(socketPath: string): boolean {
  return !socketPath.startsWith("tcp://");
}

function runtimeSelfShutdownMessage(
  runtimePid: number,
  action: "repair" | "stop",
): string {
  const verb = action === "repair" ? "repair/restart" : "stop";
  return (
    `Refusing to ${verb} ADE runtime from a command running inside that runtime ` +
    `(pid ${runtimePid}). Run this from an external terminal, or set ` +
    "ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1 if you intentionally want to tear down active ADE sessions."
  );
}

function runtimeSelfShutdownBlock(
  runtimeInfo: MachineRuntimeInfo,
  action: "repair" | "stop",
  options: { localRuntime?: boolean } = {},
): string | null {
  if (options.localRuntime === false) return null;
  const runtimePid = runtimeInfo.pid;
  if (!runtimePid || shouldAllowRuntimeSelfShutdown()) return null;
  if (!isCurrentProcessDescendantOfPid({ targetPid: runtimePid })) return null;
  return runtimeSelfShutdownMessage(runtimePid, action);
}

function runtimeSelfShutdownBlockedError(
  runtimeInfo: MachineRuntimeInfo,
  action: "repair" | "stop",
  options: { localRuntime?: boolean } = {},
): RuntimeSelfShutdownBlockedError | null {
  const message = runtimeSelfShutdownBlock(runtimeInfo, action, options);
  return message ? new RuntimeSelfShutdownBlockedError(message) : null;
}

async function runtimeServiceSelfShutdownBlock(
  socketPath: string,
  action: "repair" | "stop",
): Promise<string | null> {
  if (!isLocalRuntimeSocketPath(socketPath) || shouldAllowRuntimeSelfShutdown()) {
    return null;
  }
  const { getRuntimeServiceMainPid } = await import("./serviceManager");
  const runtimePid = getRuntimeServiceMainPid();
  if (!runtimePid) return null;
  if (!isCurrentProcessDescendantOfPid({ targetPid: runtimePid })) return null;
  return runtimeSelfShutdownMessage(runtimePid, action);
}

function isRuntimeSelfShutdownBlockedResult(result: unknown): boolean {
  // Branch on the typed discriminator, not the human-readable message — the
  // wording of the block message lives in serviceManager and must be free to
  // change without silently defeating the brain-restart guard here.
  return isRecord(result) && result.selfMutationBlocked === true;
}

function shouldRepairMachineRuntimeServiceBeforeSpawn(
  socketPath: string,
  socketPathOverride?: string | null,
): boolean {
  return !socketPathOverride?.trim()
    && process.env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL !== "1"
    && isPackagedElectronCliRuntime()
    && !socketPath.startsWith("tcp://")
    && !isAdeRuntimeNamedPipePath(socketPath)
    && !isEphemeralRuntimeSocketPath(socketPath);
}

export function shouldBlockManualMachineRuntimeSpawn(
  socketPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL === "1"
    && !socketPath.startsWith("tcp://")
    && !isAdeRuntimeNamedPipePath(socketPath)
    && !isEphemeralRuntimeSocketPath(socketPath);
}

function manualMachineRuntimeSpawnBlockedError(socketPath: string): Error {
  return new Error(
    `ADE runtime is unavailable at ${socketPath}, and ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 forbids starting a manual replacement for this service-managed socket.`,
  );
}

async function repairMachineRuntimeServiceConnection(args: {
  socketPath: string;
  options: GlobalOptions;
  expectedBuildHash: string | null;
  enforceBuildCompatibility: boolean;
}): Promise<SocketJsonRpcClient | null> {
  let client: SocketJsonRpcClient | null = null;
  try {
    const { installRuntimeService, uninstallRuntimeService } = await import("./serviceManager");
    const result = await withAdeDefaultRole(
      args.options.role,
      () => installRuntimeService(),
    );
    if (!result.ok) return null;
    client = await SocketJsonRpcClient.connect(
      args.socketPath,
      args.options.timeoutMs,
      "ADE runtime endpoint",
    );
    const runtimeInfo = await initializeMachineRuntimeDaemon(
      client,
      args.options,
    );
    const mismatch = machineRuntimeMismatchReason(
      runtimeInfo,
      args.expectedBuildHash,
      args.options.role,
      { enforceBuildCompatibility: args.enforceBuildCompatibility },
    );
    if (mismatch) {
      const selfShutdownBlock = runtimeSelfShutdownBlockedError(runtimeInfo, "repair", {
        localRuntime: isLocalRuntimeSocketPath(args.socketPath),
      });
      if (selfShutdownBlock) throw selfShutdownBlock;
      uninstallRuntimeService();
      client.close();
      return null;
    }
    const repaired = client;
    client = null;
    return repaired;
  } catch (error) {
    if (error instanceof RuntimeSelfShutdownBlockedError) throw error;
    return null;
  } finally {
    try {
      client?.close();
    } catch {}
  }
}

async function spawnMachineRuntimeDaemon(
  socketPath: string,
  options: GlobalOptions,
): Promise<boolean> {
  if (socketPath.startsWith("tcp://")) return false;

  const { resolveAdeServeCommand } = await import("./serviceManager/common");
  const serviceCommand = resolveAdeServeCommand();
  const { args, buildHash: runtimeBuildHash } =
    prepareMachineRuntimeDaemonCommand(serviceCommand);
  args.push("--socket", socketPath);
  if (isEphemeralRuntimeSocketPath(socketPath) && !args.includes("--no-sync")) {
    args.push("--no-sync");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(serviceCommand.env ?? {}),
    ADE_DEFAULT_ROLE: options.role,
    ADE_RPC_SOCKET_PATH: socketPath,
    ADE_RUNTIME_SOCKET_PATH: socketPath,
  };
  if (
    isEphemeralRuntimeSocketPath(socketPath) &&
    !env.ADE_RUNTIME_IDLE_EXIT_MS
  ) {
    env.ADE_RUNTIME_IDLE_EXIT_MS = String(DEFAULT_EPHEMERAL_RUNTIME_IDLE_EXIT_MS);
  }
  if (runtimeBuildHash) {
    env.ADE_RUNTIME_BUILD_HASH = runtimeBuildHash;
  } else {
    delete env.ADE_RUNTIME_BUILD_HASH;
  }

  const child = spawn(serviceCommand.command, args, {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.once("error", () => {});
  child.unref();
  return true;
}

async function connectMachineRuntimeDaemon(
  options: GlobalOptions,
  socketPathOverride?: string | null,
  connectOptions: { allowSpawn?: boolean } = {},
): Promise<SocketJsonRpcClient> {
  const socketPath = await resolveMachineRuntimeSocketPath(socketPathOverride);
  const label = "ADE runtime endpoint";
  const allowSpawn = connectOptions.allowSpawn ?? !options.requireSocket;
  const isTcpSocket = socketPath.startsWith("tcp://");
  const isLocalRuntime = isLocalRuntimeSocketPath(socketPath);
  const enforceBuildCompatibility =
    shouldEnforceMachineRuntimeBuildCompatibility(socketPathOverride);
  const expectedBuildHash = isTcpSocket || !enforceBuildCompatibility
    ? null
    : await resolveExpectedMachineRuntimeBuildHash();
  const preferServiceRepair = shouldRepairMachineRuntimeServiceBeforeSpawn(
    socketPath,
    socketPathOverride,
  );
  const repairServiceConnection = async (): Promise<SocketJsonRpcClient | null> => {
    if (!preferServiceRepair) return null;
    return repairMachineRuntimeServiceConnection({
      socketPath,
      options,
      expectedBuildHash,
      enforceBuildCompatibility,
    });
  };
  try {
    const client = await SocketJsonRpcClient.connect(
      socketPath,
      options.timeoutMs,
      label,
    );
    const runtimeInfo = await initializeMachineRuntimeDaemon(
      client,
      options,
    );
    const mismatch = machineRuntimeMismatchReason(
      runtimeInfo,
      expectedBuildHash,
      options.role,
      { enforceBuildCompatibility },
    );
    if (mismatch) {
      if (!allowSpawn || isTcpSocket) {
        client.close();
        throw new Error(
          `ADE runtime ${mismatch}.`,
        );
      }
      const selfShutdownBlock = runtimeSelfShutdownBlockedError(runtimeInfo, "repair", {
        localRuntime: isLocalRuntime,
      });
      if (selfShutdownBlock) {
        client.close();
        throw selfShutdownBlock;
      }
      if (shouldBlockManualMachineRuntimeSpawn(socketPath)) {
        client.close();
        throw manualMachineRuntimeSpawnBlockedError(socketPath);
      }
      await shutdownMachineRuntimeDaemon(client);
      const repaired = await repairServiceConnection();
      if (repaired) return repaired;
      const spawned = await spawnMachineRuntimeDaemon(socketPath, options);
      if (!spawned) {
        throw new Error(
          `ADE runtime ${mismatch}.`,
        );
      }
      const restarted = await SocketJsonRpcClient.connect(
        socketPath,
        options.timeoutMs,
        label,
      );
      const restartedInfo = await initializeMachineRuntimeDaemon(
        restarted,
        options,
      );
      const restartedMismatch = machineRuntimeMismatchReason(
        restartedInfo,
        expectedBuildHash,
        options.role,
        { enforceBuildCompatibility },
      );
      if (restartedMismatch) {
        const selfShutdownBlock = runtimeSelfShutdownBlockedError(restartedInfo, "repair", {
          localRuntime: isLocalRuntime,
        });
        if (selfShutdownBlock) {
          restarted.close();
          throw selfShutdownBlock;
        }
        await shutdownMachineRuntimeDaemon(restarted);
        throw new Error(
          `ADE runtime ${restartedMismatch}.`,
        );
      }
      return restarted;
    }
    return client;
  } catch (firstError) {
    if (firstError instanceof RuntimeSelfShutdownBlockedError) throw firstError;
    if (!allowSpawn) throw firstError;
    const repaired = await repairServiceConnection();
    if (repaired) return repaired;
    if (shouldBlockManualMachineRuntimeSpawn(socketPath)) {
      throw manualMachineRuntimeSpawnBlockedError(socketPath);
    }
    const spawned = await spawnMachineRuntimeDaemon(socketPath, options);
    if (!spawned) throw firstError;
    try {
      const client = await SocketJsonRpcClient.connect(
        socketPath,
        options.timeoutMs,
        label,
      );
      const runtimeInfo = await initializeMachineRuntimeDaemon(
        client,
        options,
      );
      const mismatch = machineRuntimeMismatchReason(
        runtimeInfo,
        expectedBuildHash,
        options.role,
        { enforceBuildCompatibility },
      );
      if (mismatch) {
        const selfShutdownBlock = runtimeSelfShutdownBlockedError(runtimeInfo, "repair", {
          localRuntime: isLocalRuntime,
        });
        if (selfShutdownBlock) {
          client.close();
          throw selfShutdownBlock;
        }
        await shutdownMachineRuntimeDaemon(client);
        throw new Error(
          `ADE runtime ${mismatch}.`,
        );
      }
      return client;
    } catch (secondError) {
      if (secondError instanceof RuntimeSelfShutdownBlockedError) throw secondError;
      const firstMessage =
        firstError instanceof Error ? firstError.message : String(firstError);
      const secondMessage =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);
      throw new Error(
        `Unable to attach to ADE runtime at ${socketPath}: ${secondMessage} (initial attempt: ${firstMessage})`,
      );
    }
  }
}

async function runRuntimeCommand(
  rest: string[],
  options: GlobalOptions,
): Promise<unknown> {
  const args = [...rest];
  const sub = firstStandalonePositional(args) ?? "status";
  const socketOverride = readValue(args, ["--socket"]);
  const socketPath = await resolveMachineRuntimeSocketPath(socketOverride);

  if (sub === "status") {
    try {
      const client = await SocketJsonRpcClient.connect(
        socketPath,
        Math.min(options.timeoutMs, 3_000),
        "ADE runtime endpoint",
      );
      try {
        const runtimeInfo = await initializeMachineRuntimeDaemon(
          client,
          options,
        );
        return {
          ok: true,
          running: true,
          socketPath,
          version: runtimeInfo.version,
          buildHash: runtimeInfo.buildHash,
          defaultRole: runtimeInfo.defaultRole,
          packageChannel: runtimeInfo.packageChannel,
          projectRoot: runtimeInfo.projectRoot,
          pid: runtimeInfo.pid,
          message: "ADE runtime endpoint is running.",
        };
      } finally {
        client.close();
      }
    } catch (error) {
      return {
        ok: false,
        running: false,
        socketPath,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (sub === "start") {
    const client = await connectMachineRuntimeDaemon(options, socketOverride, {
      allowSpawn: true,
    });
    try {
      const runtimeInfo = await initializeMachineRuntimeDaemon(
        client,
        options,
      ).catch(() => null);
      return {
        ok: true,
        running: true,
        socketPath,
        version: runtimeInfo?.version ?? null,
        buildHash: runtimeInfo?.buildHash ?? null,
        defaultRole: runtimeInfo?.defaultRole ?? null,
        packageChannel: runtimeInfo?.packageChannel ?? null,
        projectRoot: runtimeInfo?.projectRoot ?? null,
        pid: runtimeInfo?.pid ?? null,
        message: "ADE runtime endpoint is running.",
      };
    } finally {
      client.close();
    }
  }

  if (sub === "stop" || sub === "shutdown") {
    try {
      const client = await SocketJsonRpcClient.connect(
        socketPath,
        Math.min(options.timeoutMs, 3_000),
        "ADE runtime endpoint",
      );
      try {
        const runtimeInfo = await initializeMachineRuntimeDaemon(client, options).catch(() => null);
        if (runtimeInfo) {
          const selfShutdownBlock = runtimeSelfShutdownBlock(runtimeInfo, "stop", {
            localRuntime: isLocalRuntimeSocketPath(socketPath),
          });
          if (selfShutdownBlock) {
            return {
              ok: false,
              running: true,
              socketPath,
              message: selfShutdownBlock,
            };
          }
        } else if (!socketOverride?.trim()) {
          const selfShutdownBlock = await runtimeServiceSelfShutdownBlock(socketPath, "stop");
          if (selfShutdownBlock) {
            return {
              ok: false,
              running: true,
              socketPath,
              message: selfShutdownBlock,
            };
          }
        }
        await shutdownMachineRuntimeDaemon(client);
      } finally {
        client.close();
      }
      return {
        ok: true,
        running: false,
        socketPath,
        message: "ADE runtime endpoint stopped.",
      };
    } catch (error) {
      return {
        ok: false,
        running: false,
        socketPath,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (sub === "install-service") {
    const { installRuntimeService } = await import("./serviceManager");
    return withAdeDefaultRole(options.role, () => installRuntimeService());
  }
  if (sub === "uninstall-service") {
    const { uninstallRuntimeService } = await import("./serviceManager");
    return uninstallRuntimeService();
  }
  if (sub === "service-status") {
    const { getRuntimeServiceStatus } = await import("./serviceManager");
    return getRuntimeServiceStatus();
  }

  throw new CliUsageError(
    "runtime supports status, start, stop, install-service, uninstall-service, or service-status. Prefer ade brain for the service-managed lifecycle.",
  );
}

async function readBrainSyncStatus(
  options: GlobalOptions,
  socketOverride: string | null,
): Promise<unknown | null> {
  let client: SocketJsonRpcClient | null = null;
  try {
    client = await connectMachineRuntimeDaemon(options, socketOverride, {
      allowSpawn: false,
    });
    return await client.request("sync.getStatus", {
      includeTransferReadiness: false,
    });
  } catch {
    return null;
  } finally {
    try {
      client?.close();
    } catch {}
  }
}

async function runBrainCommand(
  rest: string[],
  options: GlobalOptions,
): Promise<unknown> {
  const args = [...rest];
  const sub = firstPositional(args) ?? "status";
  const socketOverride = readValue(args, ["--socket"]);

  if (sub === "status" || sub === "show") {
    const [{ getRuntimeServiceStatus }] = await Promise.all([
      import("./serviceManager"),
    ]);
    const service = getRuntimeServiceStatus();
    const runtime = await runRuntimeCommand(
      ["status", ...(socketOverride ? ["--socket", socketOverride] : [])],
      options,
    );
    const sync = isRecord(runtime) && runtime.running === true
      ? await readBrainSyncStatus(options, socketOverride)
      : null;
    const pairing = isRecord(sync) ? sync.pairingConnectInfo : null;
    // A present machine last-failure report means the most recent brain
    // startup/serve (or a project DB open) failed and has not recovered — the
    // serve path clears it on a successful listen. Surface it as a plain
    // one-liner so `ade brain status --text` matches the Desktop recovery screen.
    const lastFailure = readLastFailure({ kind: "machine" });
    return {
      ok: service.ok && (!isRecord(runtime) || runtime.ok !== false),
      service,
      runtime,
      sync,
      port: isRecord(pairing) ? pairing.port ?? null : null,
      connectedPeers: isRecord(sync) ? sync.connectedPeers ?? null : null,
      lastFailure: lastFailure ? formatLastFailureLine(lastFailure) : null,
      message: isRecord(runtime) && typeof runtime.message === "string"
        ? runtime.message
        : service.message,
    };
  }

  if (sub === "start") {
    const { installRuntimeService } = await import("./serviceManager");
    return withAdeDefaultRole("cto", () => installRuntimeService());
  }

  if (sub === "stop") {
    const { uninstallRuntimeService } = await import("./serviceManager");
    return uninstallRuntimeService();
  }

  if (sub === "restart") {
    const { installRuntimeService, uninstallRuntimeService } = await import("./serviceManager");
    const stopped = uninstallRuntimeService();
    if (isRuntimeSelfShutdownBlockedResult(stopped)) {
      return {
        ok: false,
        action: "restart",
        stopped,
        started: null,
        message: stopped.message,
      };
    }
    const started = await withAdeDefaultRole("cto", () => installRuntimeService());
    return {
      ok: stopped.ok && started.ok,
      action: "restart",
      stopped,
      started,
      message: !stopped.ok
        ? `ADE brain restart attempted after stop warning: ${stopped.message}`
        : started.ok
          ? "ADE brain restarted."
          : started.message,
    };
  }

  if (sub === "update") {
    const { BrainUpdateUsageError, runBrainUpdateCommand } = await import("./commands/brainUpdate");
    try {
      return await runBrainUpdateCommand(args, { currentVersion: VERSION });
    } catch (error) {
      if (error instanceof BrainUpdateUsageError) {
        throw new CliUsageError(error.message);
      }
      throw error;
    }
  }

  throw new CliUsageError(
    "brain supports status, show, start, stop, restart, update, or pin.",
  );
}

async function runDesktopCommand(rest: string[]): Promise<unknown> {
  const args = [...rest];
  const sub = firstPositional(args) ?? "open";
  const appName =
    readValue(args, ["--app-name"]) ?? resolveDefaultDesktopAppName();
  if (sub !== "open" && sub !== "launch" && sub !== "start") {
    throw new CliUsageError("desktop supports open.");
  }

  if (process.platform === "darwin") {
    const result = spawnSync("open", ["-a", appName], { encoding: "utf8" });
    const detail =
      typeof result.stderr === "string" && result.stderr.trim()
        ? result.stderr.trim()
        : typeof result.stdout === "string" && result.stdout.trim()
          ? result.stdout.trim()
          : `Unable to open ${appName}.`;
    return {
      ok: result.status === 0,
      platform: process.platform,
      appName,
      message: result.status === 0 ? `Opened ${appName}.` : detail,
    };
  }

  return {
    ok: false,
    platform: process.platform,
    appName,
    message:
      "Launching ADE desktop from the CLI is currently supported on macOS.",
  };
}

function resolveDefaultDesktopAppName(): string {
  const explicit = process.env.ADE_DESKTOP_APP_NAME?.trim();
  if (explicit) return explicit;
  const channel = process.env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  if (channel === "alpha") return "ADE Alpha";
  if (channel === "beta") return "ADE Beta";
  return "ADE";
}

async function runNativeRpcStdio(options: GlobalOptions): Promise<void> {
  const previousRole = process.env.ADE_DEFAULT_ROLE;
  process.env.ADE_DEFAULT_ROLE = options.role;
  const [{ createStdioTransport }] = await Promise.all([
    import("./transports/stdioTransport"),
  ]);
  let client: SocketJsonRpcClient | null = null;
  let stop: ReturnType<typeof startJsonRpcServer> | null = null;
  let unsubscribeNotifications: (() => void) | null = null;
  try {
    client = await connectMachineRuntimeDaemon(options);
    const handler: JsonRpcHandler = async (request) => {
      const method = typeof request.method === "string" ? request.method : "";
      if (!method) return null;
      if (request.id === undefined) {
        client?.notify(method, request.params);
        return null;
      }
      if (!client) {
        throw new Error("ADE runtime is not connected.");
      }
      try {
        return await client.request(method, request.params);
      } catch (error) {
        if (
          (method === "shutdown" || method === "exit") &&
          isRuntimeShutdownCloseError(error)
        ) {
          return {};
        }
        throw error;
      }
    };
    stop = startJsonRpcServer(handler, createStdioTransport(), {
      nonFatal: true,
      onError: reportContainedJsonRpcError,
    });
    unsubscribeNotifications = client.onAnyNotification((method, params) =>
      stop?.notify(method, params),
    );
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const finishAfterActiveDispatches = () => {
        void (stop?.waitForIdle() ?? Promise.resolve()).finally(finish);
      };
      client?.onClose(finishAfterActiveDispatches);
      process.stdin.once("end", finishAfterActiveDispatches);
      process.stdin.once("close", finishAfterActiveDispatches);
    });
  } finally {
    unsubscribeNotifications?.();
    try {
      stop?.();
    } catch {}
    try {
      client?.close();
    } catch {}
    if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
    else process.env.ADE_DEFAULT_ROLE = previousRole;
  }
}

export function includeHostProjectInCatalog<T extends { projectId: string }>(
  recentProjects: T[],
  hostProject: T | null,
): T[] {
  if (
    !hostProject ||
    recentProjects.some((project) => project.projectId === hostProject.projectId)
  ) {
    return recentProjects;
  }
  return [...recentProjects, hostProject];
}

async function runServe(
  rest: string[],
  options: GlobalOptions,
): Promise<unknown | null> {
  const args = [...rest];
  if (readFlag(args, ["--install-service"])) {
    const { installRuntimeService } = await import("./serviceManager");
    return withAdeDefaultRole(options.role, () => installRuntimeService());
  }
  if (readFlag(args, ["--uninstall-service"])) {
    const { uninstallRuntimeService } = await import("./serviceManager");
    return uninstallRuntimeService();
  }
  if (readFlag(args, ["--service-status"])) {
    const { getRuntimeServiceStatus } = await import("./serviceManager");
    return getRuntimeServiceStatus();
  }
  boundLaunchdLogs(path.dirname(lastFailurePathForMachine()));
  const previousFailure = readLastFailure({ kind: "machine" });
  const startupBackoffMs = computeStartupBackoffMs(previousFailure, Date.now());
  if (startupBackoffMs > 0 && previousFailure) {
    process.stderr.write(
      `ADE brain delaying startup ${startupBackoffMs / 1_000}s after repeated failures: ${previousFailure.code}\n`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, startupBackoffMs));
  }
  let serveStarted = false;
  try {
  const removeRuntimeProcessErrorBoundary = installRuntimeProcessErrorBoundary("ADE brain");
  const [
    { resolveMachineAdeLayout },
    { ProjectRegistry },
    { ProjectScopeRegistry },
    { PersonalChatScope },
    { createMultiProjectRpcRequestHandler },
    { createSharedSyncListener },
    { resolveMobileProjectIconDataUrl },
    { createBrainProjectActionsSyncHandler },
    { buildRosterSnapshot, createForeignChatTranscriptResolver },
    { createSyncCloudRelayStore },
    { setSyncRuntimeRpcHandlerFactory },
  ] = await Promise.all([
    import("./services/projects/machineLayout"),
    import("./services/projects/projectRegistry"),
    import("./services/projects/projectScope"),
    import("./services/personalChats/personalChatScope"),
    import("./multiProjectRpcServer"),
    import("./services/sync/sharedSyncListener"),
    import("../../desktop/src/main/services/projects/projectIconThumbnail"),
    import("./services/sync/brainProjectActionsSyncHandler"),
    import("./services/sync/rosterBuilder"),
    import("./services/sync/syncCloudRelayStore"),
    import("./services/sync/syncPairedChannelService"),
  ]);

  const layout = resolveMachineAdeLayout();
  const rawSocketPath =
    readValue(args, ["--socket"]) ??
    process.env.ADE_RPC_SOCKET_PATH?.trim() ??
    layout.socketPath;
  const socketPath = isAdeRuntimeNamedPipePath(rawSocketPath)
    ? rawSocketPath
    : path.resolve(rawSocketPath);
  const port = parseOptionalPort(readValue(args, ["--port"]), "--port");
  const syncEnabled = !readFlag(args, ["--no-sync"]);
  const projectRegistry = new ProjectRegistry(layout);
  const personalChatScope = new PersonalChatScope();
  let preferredSyncProjectId: string | null = null;
  const preferredSyncProjectRoot = process.env.ADE_PROJECT_ROOT?.trim();
  if (preferredSyncProjectRoot) {
    try {
      preferredSyncProjectId = projectRegistry.add(
        path.resolve(preferredSyncProjectRoot),
        {
          catalogVisibility: "system",
          registrationSource: "runtime-auto",
        },
      ).projectId;
    } catch (error) {
      process.stderr.write(
        `ADE brain could not register ADE_PROJECT_ROOT for phone sync: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  type ProjectRecord = ReturnType<
    InstanceType<typeof ProjectRegistry>["list"]
  >[number];
  const toMobileProjectSummary = (
    record: ProjectRecord,
    overrides: Partial<SyncMobileProjectSummary> = {},
  ): SyncMobileProjectSummary => ({
    id: record.projectId,
    displayName: record.displayName,
    rootPath: record.rootPath,
    defaultBaseRef: null,
    lastOpenedAt:
      record.lastOpenedAt > 0
        ? new Date(record.lastOpenedAt).toISOString()
        : null,
    iconDataUrl: resolveMobileProjectIconDataUrl(record.rootPath),
    laneCount: 0,
    isAvailable: true,
    isCached: true,
    isOpen: false,
    ...overrides,
  });
  let scopeRegistry: InstanceType<typeof ProjectScopeRegistry>;
  const headlessProjectLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (event, meta) =>
      process.stderr.write(`${event} ${JSON.stringify(meta ?? {})}\n`),
    error: (event, meta) =>
      process.stderr.write(`${event} ${JSON.stringify(meta ?? {})}\n`),
  };
  const createHeadlessProjectScaffoldService = () => {
    const githubService = createHeadlessGitHubService(
      process.cwd(),
      headlessProjectLogger,
    );
    return createProjectScaffoldService({
      logger: headlessProjectLogger,
      githubService,
    });
  };
  const getHeadlessDefaultParentDir = (): string => {
    const firstProjectRoot = projectRegistry.list()[0]?.rootPath;
    if (firstProjectRoot) return path.dirname(firstProjectRoot);
    return path.join(os.homedir(), "Projects");
  };
  const resolveHeadlessMobileProjectRoot = async (
    rootPath: string | null | undefined,
  ): Promise<string> => {
    const requestedRoot = typeof rootPath === "string" ? rootPath.trim() : "";
    if (!requestedRoot) {
      throw new Error("Project path is required.");
    }
    const resolvedRoot = path.resolve(requestedRoot);
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error("Project is no longer available on this machine.");
    }
    try {
      return normalizeProjectRootPath(await resolveRepoRoot(resolvedRoot));
    } catch {
      throw new Error("Choose a Git repository folder.");
    }
  };
  const mobileProjectSummaryForHeadlessRecord = async (
    record: ProjectRecord,
    overrides: Partial<SyncMobileProjectSummary> = {},
  ): Promise<SyncMobileProjectSummary> => {
    const scope = await scopeRegistry.get(record.projectId);
    const lanes = await scope.runtime.laneService
      .list({ includeArchived: false, includeStatus: false })
      .catch(() => []);
    const laneCount = lanes.length;
    return toMobileProjectSummary(record, {
      laneCount,
      isOpen: true,
      ...overrides,
    });
  };
  const registerHeadlessMobileProject = async (
    rootPath: string,
  ): Promise<SyncMobileProjectSummary> => {
    const record = projectRegistry.add(rootPath, {
      catalogVisibility: "recent",
      registrationSource: "mobile",
    });
    return await mobileProjectSummaryForHeadlessRecord(record);
  };
  const openHeadlessMobileProject = async (
    input: SyncProjectOpenRequestPayload,
  ): Promise<SyncMobileProjectSummary> => {
    const projectRoot = await resolveHeadlessMobileProjectRoot(input.rootPath);
    return await registerHeadlessMobileProject(projectRoot);
  };
  const createHeadlessMobileProject = async (
    input: CreateProjectInput,
  ): Promise<SyncMobileProjectSummary> => {
    const result =
      await createHeadlessProjectScaffoldService().createLocalProject(input);
    return await registerHeadlessMobileProject(result.rootPath);
  };
  const cloneHeadlessMobileProject = async (
    input: CloneProjectInput,
  ): Promise<SyncMobileProjectSummary> => {
    const result =
      await createHeadlessProjectScaffoldService().cloneRepository(input);
    return await registerHeadlessMobileProject(result.rootPath);
  };
  const resolveHeadlessMobileProjectRequest = (
    input: SyncProjectForgetRequestPayload | SyncProjectSwitchRequestPayload,
  ): {
    requestedId: string;
    requestedRootPath: string;
    record: ProjectRecord | null;
    conflict: boolean;
  } => {
    const requestedId =
      typeof input.projectId === "string" && input.projectId.trim()
        ? input.projectId.trim()
        : "";
    const requestedRootPath =
      typeof input.rootPath === "string" && input.rootPath.trim()
        ? path.resolve(input.rootPath)
        : "";
    const records = projectRegistry.list();
    const idRecord =
      requestedId.length > 0
        ? records.find((candidate) => candidate.projectId === requestedId) ?? null
        : null;
    const rootRecord =
      requestedRootPath.length > 0
        ? records.find((candidate) => path.resolve(candidate.rootPath) === requestedRootPath) ?? null
        : null;
    const conflict = Boolean(idRecord && rootRecord && idRecord.projectId !== rootRecord.projectId);
    return { requestedId, requestedRootPath, record: conflict ? null : idRecord ?? rootRecord, conflict };
  };
  const forgetHeadlessMobileProject = async (
    input: SyncProjectForgetRequestPayload,
  ): Promise<SyncProjectForgetResultPayload> => {
    const { requestedId, requestedRootPath, record, conflict } = resolveHeadlessMobileProjectRequest(input);
    if (!requestedId && !requestedRootPath) {
      return {
        ok: false,
        message: "Project id or path is required.",
      };
    }
    if (conflict) {
      return {
        ok: false,
        message: "projectId and rootPath refer to different projects.",
      };
    }
    if (!record) {
      return {
        ok: true,
        message: "Project is already removed from this ADE machine.",
        projectId: requestedId || null,
        rootPath: requestedRootPath || null,
      };
    }
    projectRegistry.remove(record.projectId);
    const disposeTimer = setImmediate(() => {
      void scopeRegistry.dispose(record.projectId).catch((error) => {
        headlessProjectLogger.warn("headless_project_forget_dispose_failed", {
          projectId: record.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    disposeTimer.unref?.();
    return {
      ok: true,
      projectId: record.projectId,
      rootPath: record.rootPath,
    };
  };
  const machineProjectCatalogProvider: SyncProjectCatalogProvider = {
    listProjects: async () => ({
      projects: includeHostProjectInCatalog(
        projectRegistry.listRecent(),
        preferredSyncProjectId
          ? projectRegistry.get(preferredSyncProjectId)
          : null,
      )
        .map((record) =>
          toMobileProjectSummary(record, {
            isAvailable: fs.existsSync(record.rootPath),
          })),
    }),
    prepareProjectConnection: async (
      request: SyncProjectSwitchRequestPayload,
    ): Promise<SyncProjectSwitchResultPayload> => {
      const { record, conflict } = resolveHeadlessMobileProjectRequest(request);
      const project = record
        ? toMobileProjectSummary(record, { isOpen: true })
        : null;
      if (conflict) {
        return {
          ok: false,
          message: "projectId and rootPath refer to different projects.",
          project,
        };
      }
      if (!record) {
        return {
          ok: false,
          message: "That project is not registered on this ADE machine.",
          project,
        };
      }
      try {
        // Prepare must not start the new project's sync host yet: the old host
        // or the machine-wide fallback still owns the socket. Reply first,
        // then completion activates the project host so the phone can
        // reconnect cleanly when needed.
        const scope = await scopeRegistry.get(record.projectId);
        const syncService = scope?.runtime.syncService ?? null;
        if (!scope || !syncService) {
          return {
            ok: false,
            message: "Phone sync is not available for that project.",
            project,
          };
        }
        const lanes = await scope.runtime.laneService
          .list({ includeArchived: false, includeStatus: false })
          .catch(() => []);
        const laneCount = lanes.length;
        const readyProject = toMobileProjectSummary(record, {
          isOpen: true,
          laneCount,
        });
        const activeScope = await scopeRegistry.resolveActiveSyncHost();
        const activeStatus = await activeScope?.runtime.syncService?.getStatus();
        const connectInfo = activeStatus?.pairingConnectInfo ?? null;
        if (!connectInfo) {
          return {
            ok: true,
            project: readyProject,
            connection: null,
          };
        }
        return {
          ok: true,
          project: readyProject,
          connection: {
            authKind: "paired",
            token: null,
            pairedDeviceId: null,
            hostIdentity: connectInfo.hostIdentity,
            port: connectInfo.port,
            addressCandidates: connectInfo.addressCandidates,
          },
        };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Unable to prepare phone sync for that project.",
          project,
        };
      }
    },
    completeProjectConnection: async (
      request: SyncProjectSwitchRequestPayload,
      result: SyncProjectSwitchResultPayload,
    ): Promise<void> => {
      if (!result.ok) return;
      const projectId =
        typeof result.project?.id === "string" && result.project.id.trim()
          ? result.project.id.trim()
          : typeof request.projectId === "string" &&
              request.projectId.trim()
            ? request.projectId.trim()
            : null;
      if (!projectId) return;
      try {
        projectRegistry.touch(projectId);
      } catch {
        // The mobile handoff already succeeded; a stale registry touch should
        // not fail the sync protocol completion.
      }
      await scopeRegistry.switchSyncHost(projectId, {
        deactivatePreviousHost: true,
      });
      await scopeRegistry.deactivateInactiveSyncHosts();
    },
    browseDirectories: async (input: ProjectBrowseInput) =>
      browseProjectDirectories(input),
    getDefaultParentDir: async () => getHeadlessDefaultParentDir(),
    openProject: openHeadlessMobileProject,
    createProject: createHeadlessMobileProject,
    cloneProject: cloneHeadlessMobileProject,
    forgetProject: forgetHeadlessMobileProject,
    listMyGitHubRepos: async (input: ListMyGitHubReposInput) =>
      createHeadlessProjectScaffoldService().listMyGitHubRepos(input),
  };
  // ONE websocket listener for the whole brain: every project scope's sync
  // host attaches to it instead of binding its own server, so the hosted
  // project can change without paired phones ever seeing a disconnect.
  const sharedSyncListener = syncEnabled
    ? createSharedSyncListener({
        logger: {
          warn: (message, fields) =>
            process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
        },
      })
    : null;
  const machineCredentialStore = new EncryptedFileCredentialStore({
    secretsDir: layout.secretsDir,
  });
  // Same file the per-scope sync services read; another store instance is fine
  // because every read reloads the file.
  const machineCloudRelayStore = createSyncCloudRelayStore({
    filePath: path.join(layout.secretsDir, "sync-cloud-relay.json"),
  });
  let accountMachinePublisher: AccountMachinePublisherService | null = null;
  const getAccountDirectoryHealth = (): SyncAccountDirectoryHealth =>
    accountMachinePublisher?.getPublisherHealth() ?? createSyncAccountDirectoryHealth(
      "sync_disabled",
      "Account-directory publishing has not started.",
    );
  sharedSyncListener?.setFallbackConnectionHandler(
    createBrainProjectActionsSyncHandler({
      logger: headlessProjectLogger,
      projectCatalogProvider: machineProjectCatalogProvider,
      bootstrapCredentialStore: machineCredentialStore,
      legacyBootstrapTokenPath: path.join(layout.secretsDir, "sync-bootstrap-token"),
      pairingSecretsPath: path.join(layout.secretsDir, "sync-paired-devices.json"),
      pinPath: path.join(layout.secretsDir, "sync-pin.json"),
      localDeviceIdPath: path.join(layout.secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(layout.secretsDir, "sync-site-id"),
      getCloudRelayWssUrl: () => machineCloudRelayStore.getRelayWssUrl(),
      personalChatScope,
    }),
  );
  scopeRegistry = new ProjectScopeRegistry(projectRegistry, {
    syncRuntime: {
      enabled: syncEnabled,
      sharedSyncListener,
      hostStartupEnabled: true,
      hostDiscoveryEnabled: true,
      forceHostRole: false,
      runtimeKind: "headless",
      appVersion: VERSION,
      localDeviceIdPath: path.join(layout.secretsDir, "sync-device-id"),
      phonePairingStateDir: layout.secretsDir,
      getAccountDirectoryHealth,
      requestAccountMachinePublish: () =>
        accountMachinePublisher?.requestPublishAfterCurrentAttempt(),
      projectCatalogProvider: machineProjectCatalogProvider,
      // All-projects chat roster (mobile hub). Closes over `scopeRegistry`,
      // which is assigned by this very `new ProjectScopeRegistry(...)` call —
      // safe because `buildSnapshot` only runs later (on `roster_subscribe`),
      // by which point the binding is set (mirrors machineProjectCatalogProvider).
      rosterProvider: {
        buildSnapshot: () =>
          buildRosterSnapshot({
            projectRegistry,
            scopeRegistry,
            hostProjectId: preferredSyncProjectId,
            logger: headlessProjectLogger,
          }),
      },
      // Cross-project chat "quick look": lets the phone stream a foreign
      // project's chat transcript read-only without a project switch. Reads
      // straight off that project's `.ade` transcripts dir (registry-validated,
      // no runtime boot) — the counterpart to the roster feed above.
      foreignChatProvider: createForeignChatTranscriptResolver({ projectRegistry }),
      personalChatScope,
    },
  });
  const previousRole = process.env.ADE_DEFAULT_ROLE;
  let clearSyncRuntimeRpcHandlerFactory: (() => void) | null = null;
  process.env.ADE_DEFAULT_ROLE = options.role;
  try {

  const states: HeadlessRpcServerState[] = [];
  let done = false;
  let resolveDone: (() => void) | null = null;

  const finish = () => {
    if (done) return;
    done = true;
    resolveDone?.();
  };

  const createHandler = () =>
    createMultiProjectRpcRequestHandler({
      serverVersion: VERSION,
      projectRegistry,
      scopeRegistry,
      personalChatScope,
      getAccountDirectoryHealth,
      disposeScopesOnDispose: false,
      onShutdown: finish,
    });
  clearSyncRuntimeRpcHandlerFactory = setSyncRuntimeRpcHandlerFactory(createHandler);
  const startSyncHost = async () => {
    let activeScope: Awaited<
      ReturnType<InstanceType<typeof ProjectScopeRegistry>["resolveActiveSyncHost"]>
    >;
    if (preferredSyncProjectId) {
      activeScope = await scopeRegistry.switchSyncHost(preferredSyncProjectId);
    } else {
      activeScope = await scopeRegistry.resolveActiveSyncHost();
    }
    if (!activeScope && sharedSyncListener) {
      await sharedSyncListener.ensureListening([DEFAULT_SYNC_HOST_PORT]);
    }
    if (activeScope) {
      const prewarmTimer = setImmediate(() => {
        void scopeRegistry.prewarmRecentScopes({
          excludeProjectId: activeScope?.registryProjectId,
          limit: 2,
        });
      });
      prewarmTimer.unref?.();
    }
    return activeScope ?? null;
  };
  const disposeServeResources = async () => {
    accountMachinePublisher?.dispose();
    accountMachinePublisher = null;
    // Before scopes detach (which clears the run map): best-effort Live
    // Activity `end` so the lock screen doesn't show dead agents until the
    // stale-date dim. Bounded by the publisher's internal timeout.
    try {
      const { peekSharedPushPublisherService, resolvePushRelayStateFile } = await import("./services/push/pushPublisherService");
      await peekSharedPushPublisherService(
        resolvePushRelayStateFile(layout.secretsDir),
      )?.shutdown();
    } catch {
      // Shutdown must never hang or fail on push cleanup.
    }
    try {
      const { peekSharedSyncTunnelClientService } = await import("./services/sync/syncTunnelClientService");
      await peekSharedSyncTunnelClientService(
        path.join(layout.secretsDir, "sync-cloud-relay.json"),
      )?.dispose();
    } catch {
      // Best-effort tunnel teardown; the process exit closes sockets anyway.
    }
    await scopeRegistry.disposeAll();
    await personalChatScope.dispose();
    try {
      const {
        defaultProductAnalyticsStateFile,
        peekSharedProductAnalyticsService,
      } = await import("../../desktop/src/main/services/analytics/productAnalyticsService");
      await peekSharedProductAnalyticsService(
        defaultProductAnalyticsStateFile(layout.adeDir),
      )?.shutdown();
    } catch {
      // Analytics is best-effort and must never delay or fail daemon shutdown.
    }
    if (sharedSyncListener) {
      await sharedSyncListener.close().catch(() => {});
    }
    clearSyncRuntimeRpcHandlerFactory?.();
    clearSyncRuntimeRpcHandlerFactory = null;
  };

  const listen = async (
    server: net.Server,
    target: string | { port: number; host: string },
  ): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const handleListening = () => {
        server.off("error", handleError);
        resolve();
      };
      const handleError = (error: Error) => {
        server.off("listening", handleListening);
        reject(error);
      };
      server.once("listening", handleListening);
      server.once("error", handleError);
      if (typeof target === "string") {
        server.listen(target);
      } else {
        server.listen(target.port, target.host);
      }
    });
  };

  if (syncEnabled) {
    try {
      const [{ runSyncHostStartupLoop }, { getRuntimeServiceMainPid }] = await Promise.all([
        import("./services/sync/syncHostStartupLoop"),
        import("./serviceManager"),
      ]);
      await runSyncHostStartupLoop({
        startSyncHost,
        isDone: () => done,
        log: (message) => process.stderr.write(`${message}\n`),
        getServiceMainPid: getRuntimeServiceMainPid,
      });
    } catch (error: unknown) {
      // Cross-channel conflict (another build's live brain owns mobile sync):
      // real builds never run sync-less, so fail before publishing ade.sock.
      const { SyncHostSingletonConflictError } = await import("./services/sync/syncHostSingleton");
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SyncHostSingletonConflictError) {
        await disposeServeResources();
        throw new CliExecutionError("ADE brain refusing to run without mobile sync.", {
          cause: message,
          socketPath,
          nextAction:
            "Stop the other ADE brain that owns mobile sync, then start this build again.",
        });
      }
      process.stderr.write(`ADE brain sync host startup loop failed: ${message}\n`);
      await disposeServeResources();
      throw error;
    }
  }

  fs.mkdirSync(layout.adeDir, { recursive: true, mode: 0o700 });
  if (!isAdeRuntimeNamedPipePath(socketPath)) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(socketPath)) {
      const liveness = await probeLocalSocketForLiveness(socketPath);
      if (liveness === "live" || liveness === "unknown") {
        throw Object.assign(new CliExecutionError("ADE brain socket is already in use.", {
          socketPath,
          cause: liveness === "live"
            ? "Another ADE brain is accepting connections on this socket."
            : "ADE could not prove the existing socket is stale.",
          nextAction: "Stop the existing ADE brain or choose a different --socket path.",
        }), { code: "socket_owned_by_other" as const });
      }
      try {
        fs.unlinkSync(socketPath);
      } catch {}
    }
  }

  const socketState = createHeadlessRpcServer(createHandler);
  states.push(socketState);
  await listen(socketState.server, socketPath);
  if (!isAdeRuntimeNamedPipePath(socketPath)) {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {}
  }

  let tcpUrl: string | null = null;
  if (port != null) {
    const tcpState = createHeadlessRpcServer(createHandler);
    states.push(tcpState);
    await listen(tcpState.server, { port, host: "127.0.0.1" });
    tcpUrl = `tcp://127.0.0.1:${port}`;
  }

  if (syncEnabled) {
    const { createBrainAccountMachinePublisherService } = await import(
      "./services/account/accountMachinePublisherService"
    );
    // Match the active sync-host/desktop project priority so a project Clerk
    // issuer cannot send the brain to a different directory Worker.
    const accountProjectRoots = () => {
      const activeProjectId = scopeRegistry.getActiveSyncHostProjectId();
      if (!activeProjectId) return [];
      const activeProject = projectRegistry.get(activeProjectId);
      return activeProject ? [activeProject.rootPath] : [];
    };
    accountMachinePublisher = createBrainAccountMachinePublisherService({
      secretsDir: layout.secretsDir,
      projectRoots: accountProjectRoots,
      isSyncEnabled: () => syncEnabled,
      logger: headlessProjectLogger,
      getSnapshot: async () => {
        const activeScope = await scopeRegistry.resolveActiveSyncHost();
        return await activeScope?.runtime.syncService?.getStatus({
          includeTransferReadiness: false,
        }) ?? null;
      },
      getMachineKey: () => machineCloudRelayStore.getMachineIdentity().machineKey,
      directoryBaseUrl: () => process.env.ADE_ACCOUNT_DIRECTORY_URL?.trim() || undefined,
    });
    accountMachinePublisher.start();
  }

  process.stderr.write(
    `ADE brain listening on ${socketPath}${tcpUrl ? ` and ${tcpUrl}` : ""}\n`,
  );
  clearLastFailure({ kind: "machine" });
  serveStarted = true;

  const stopParentMonitor = monitorRuntimeParentProcess(finish);
  const stopIdleMonitor = monitorRuntimeIdleExit(states, finish);
  try {
    await new Promise<void>((resolve) => {
      if (done) {
        resolve();
        return;
      }
      resolveDone = resolve;
      // A signal means launchd/systemd or an installer wants this brain gone.
      // Graceful disposal can wedge on live agent/PTY children; a wedged brain
      // outlives its service registration and squats on the channel socket and
      // sync singleton, so force the exit if disposal does not finish in time.
      const finishFromSignal = () => {
        finish();
        const timer = setTimeout(() => process.exit(0), 10_000);
        timer.unref();
      };
      process.once("SIGINT", finishFromSignal);
      process.once("SIGTERM", finishFromSignal);
    });
  } finally {
    stopParentMonitor();
    stopIdleMonitor();
  }

  for (const state of states) {
    stopHeadlessRpcServer(state);
  }
  await disposeServeResources();
  if (!isAdeRuntimeNamedPipePath(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  }
  return null;
  } finally {
    clearSyncRuntimeRpcHandlerFactory?.();
    removeRuntimeProcessErrorBoundary();
    if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
    else process.env.ADE_DEFAULT_ROLE = previousRole;
  }
  } catch (error) {
    const errorRecord = error && typeof error === "object"
      ? error as { code?: unknown; details?: unknown }
      : null;
    const rawCode = typeof errorRecord?.code === "string" ? errorRecord.code : "";
    const message = error instanceof Error ? error.message : String(error);
    const details = errorRecord?.details == null
      ? message
      : `${message}\n${JSON.stringify(errorRecord.details)}`;
    const knownCodes = new Set<AdeRecoveryErrorCode>([
      "disk_full", "insufficient_headroom", "db_integrity", "migration_incomplete",
      "migration_unknown_state", "brain_not_installed", "brain_crash_looping",
      "socket_stale_no_owner", "socket_owned_by_other", "provider_thread_missing",
      "provider_resume_failed", "optional_mcp_failed", "continuity_reconstruction_required",
      "unknown",
    ]);
    const code: AdeRecoveryErrorCode = knownCodes.has(rawCode as AdeRecoveryErrorCode)
      ? rawCode as AdeRecoveryErrorCode
      : /ENOSPC|disk is full|SQLITE_FULL/i.test(details)
        ? "disk_full"
        : /malformed|not a database|integrity/i.test(details)
          ? "db_integrity"
          : /socket is already in use|mobile sync/i.test(details)
            ? "socket_owned_by_other"
            : "unknown";
    if (!serveStarted) {
      recordLastFailure({ kind: "machine" }, {
        code,
        message: "ADE's background service could not start.",
        detail: details,
        component: /sync host|mobile sync/i.test(details) ? "sync_host" : "brain_startup",
      });
    }
    throw error;
  }
}

function readRuntimeParentPid(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.ADE_RUNTIME_PARENT_PID?.trim();
  if (!raw) return null;
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function monitorRuntimeParentProcess(onGone: () => void): () => void {
  const parentPid = readRuntimeParentPid();
  if (parentPid == null || parentPid === process.pid) return () => {};
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onGone();
  };
  const timer = setInterval(() => {
    if (done) return;
    if (process.ppid === 1 && parentPid !== 1) {
      finish();
      return;
    }
    if (!isPidAlive(parentPid)) {
      finish();
    }
  }, 2_000);
  timer.unref?.();
  process.once("disconnect", finish);
  return () => {
    done = true;
    clearInterval(timer);
    process.off("disconnect", finish);
  };
}

function readRuntimeIdleExitMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.ADE_RUNTIME_IDLE_EXIT_MS?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(MIN_RUNTIME_IDLE_EXIT_MS, parsed);
}

function hasActiveHeadlessConnections(states: readonly HeadlessRpcServerState[]): boolean {
  return states.some((state) => state.activeConnections.size > 0);
}

function monitorRuntimeIdleExit(
  states: readonly HeadlessRpcServerState[],
  onIdle: () => void,
): () => void {
  const idleExitMs = readRuntimeIdleExitMs();
  if (idleExitMs == null) return () => {};
  let stopped = false;
  let lastActiveAt = Date.now();
  const intervalMs = Math.max(1_000, Math.min(10_000, Math.floor(idleExitMs / 4)));
  const check = () => {
    if (stopped) return;
    if (hasActiveHeadlessConnections(states)) {
      lastActiveAt = Date.now();
      return;
    }
    if (Date.now() - lastActiveAt >= idleExitMs) {
      onIdle();
    }
  };
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function isFailedServiceManagerResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.ok === false &&
    (record.action === "install" || record.action === "uninstall") &&
    typeof record.serviceName === "string"
  );
}

async function runInit(
  targetPath: string | null,
): Promise<{ project: unknown; registryPath: string }> {
  const [{ resolveMachineAdeLayout }, { ProjectRegistry }] = await Promise.all([
    import("./services/projects/machineLayout"),
    import("./services/projects/projectRegistry"),
  ]);
  const layout = resolveMachineAdeLayout();
  const registry = new ProjectRegistry(layout);
  const project = registry.add(path.resolve(targetPath ?? process.cwd()), {
    catalogVisibility: "recent",
    registrationSource: "cli-explicit",
  });
  return {
    project,
    registryPath: registry.path,
  };
}

function unwrapToolResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result.isError === true) {
    const structured = result.structuredContent;
    const message =
      isRecord(structured) && isRecord(structured.error)
        ? (asString(structured.error.message) ?? "ADE tool call failed.")
        : "ADE tool call failed.";
    throw new CliToolError(message, structured ?? result);
  }
  if (result.ok === false && isRecord(result.error)) {
    const message = asString(result.error.message) ?? "ADE action call failed.";
    throw new CliToolError(message, result.error);
  }
  if (Object.prototype.hasOwnProperty.call(result, "structuredContent")) {
    return result.structuredContent;
  }
  return result;
}

function unwrapActionEnvelope(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (
    Object.prototype.hasOwnProperty.call(value, "result") &&
    (asString(value.domain) ||
      asString(value.action) ||
      Object.prototype.hasOwnProperty.call(value, "statusHint"))
  ) {
    return value.result;
  }
  return value;
}

function graphFromResult(value: unknown): JsonObject | null {
  const result = unwrapActionEnvelope(value);
  if (!isRecord(result)) return null;
  if (hasRunGraphShape(result)) return result;
  const nestedGraph = isRecord(result.graph) ? result.graph : null;
  const graph =
    nestedGraph && hasRunGraphShape(nestedGraph)
      ? nestedGraph
      : (nestedGraph ?? result);
  return isRecord(graph) ? graph : null;
}

function runFromGraphResult(value: unknown): JsonObject | null {
  const graph = graphFromResult(value);
  return firstRecord(graph, ["run"]);
}

function hasRunGraphShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    (isRecord(value.run) ||
      Array.isArray(value.steps) ||
      Array.isArray(value.attempts) ||
      Array.isArray(value.timeline))
  );
}

function runIdFromWatchValues(values: JsonObject): string {
  const explicitGraph = unwrapActionEnvelope(values.graph);
  if (isRecord(explicitGraph)) {
    const graphRun = firstRecord(explicitGraph, ["run"]);
    const graphRunId = asString(graphRun?.id);
    if (graphRunId) return graphRunId;
  }
  return requireValue(null, "run id");
}

function renderLaneGraph(result: unknown): string {
  const lanesRaw =
    isRecord(result) && Array.isArray(result.lanes) ? result.lanes : [];
  const lanes = lanesRaw.filter(isRecord);
  if (lanes.length === 0) return "ADE lanes\n(no lanes)";

  const byParent = new Map<string, JsonObject[]>();
  const byId = new Map<string, JsonObject>();
  for (const lane of lanes) {
    const id = asString(lane.id);
    if (!id) continue;
    byId.set(id, lane);
  }
  for (const lane of lanes) {
    const parentId = asString(lane.parentLaneId);
    const key = parentId && byId.has(parentId) ? parentId : "";
    const children = byParent.get(key) ?? [];
    children.push(lane);
    byParent.set(key, children);
  }
  for (const children of byParent.values()) {
    children.sort((left, right) => {
      const leftDepth =
        typeof left.stackDepth === "number" ? left.stackDepth : 0;
      const rightDepth =
        typeof right.stackDepth === "number" ? right.stackDepth : 0;
      if (leftDepth !== rightDepth) return leftDepth - rightDepth;
      return String(left.name ?? left.id ?? "").localeCompare(
        String(right.name ?? right.id ?? ""),
      );
    });
  }

  const lines = ["ADE lanes"];
  const visit = (lane: JsonObject, prefix: string, isLast: boolean): void => {
    const name = asString(lane.name) ?? asString(lane.id) ?? "(unknown)";
    const branch = asString(lane.branchRef) ?? "";
    const status = asString(lane.status) ?? "";
    const archived = asString(lane.archivedAt) ? " archived" : "";
    const id = asString(lane.id);
    const idSuffix = id ? ` (id: ${id})` : "";
    const linearIdentifiers = linearIssueIdentifiers(lane);
    const linearSuffix = linearIdentifiers.length ? ` {${linearIdentifiers.join(", ")}}` : "";
    lines.push(
      `${prefix}${isLast ? "\\- " : "|- "}${name}${idSuffix}${branch ? ` [${branch}]` : ""}${linearSuffix}${status ? ` ${status}` : ""}${archived}`,
    );
    const children = id ? (byParent.get(id) ?? []) : [];
    children.forEach((child, index) =>
      visit(
        child,
        `${prefix}${isLast ? "   " : "|  "}`,
        index === children.length - 1,
      ),
    );
  };
  const roots = byParent.get("") ?? [];
  roots.forEach((lane, index) => visit(lane, "", index === roots.length - 1));
  return lines.join("\n");
}

function linearIssueIdentifiers(lane: JsonObject): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();
  const add = (issue: unknown): void => {
    if (!isRecord(issue)) return;
    const identifier = asString(issue.identifier) ?? asString(issue.id);
    if (!identifier || seen.has(identifier)) return;
    seen.add(identifier);
    identifiers.push(identifier);
  };
  add(lane.linearIssue);
  const links = Array.isArray(lane.linearIssueLinks) ? lane.linearIssueLinks : [];
  for (const link of links) {
    if (!isRecord(link)) continue;
    add(link.issue);
  }
  return identifiers;
}

function linearIssueLabels(lane: JsonObject): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const add = (issue: unknown): void => {
    if (!isRecord(issue)) return;
    const identifier = asString(issue.identifier) ?? asString(issue.id);
    if (!identifier || seen.has(identifier)) return;
    seen.add(identifier);
    const title = asString(issue.title);
    labels.push(title ? `${identifier}: ${title}` : identifier);
  };
  add(lane.linearIssue);
  const links = Array.isArray(lane.linearIssueLinks) ? lane.linearIssueLinks : [];
  for (const link of links) {
    if (!isRecord(link)) continue;
    add(link.issue);
  }
  return labels;
}

function truncateCell(value: string, width = 42): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= width) return normalized;
  if (width <= 3) return normalized.slice(0, width);
  return `${normalized.slice(0, width - 3)}...`;
}

function cell(value: unknown, width = 42): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return truncateCell(value, width);
  if (Array.isArray(value))
    return truncateCell(
      value
        .map((entry) => cell(entry, 18))
        .filter(Boolean)
        .join(", "),
      width,
    );
  if (isRecord(value)) {
    const id =
      asString(value.id) ?? asString(value.name) ?? asString(value.title);
    return id
      ? truncateCell(id, width)
      : truncateCell(JSON.stringify(value), width);
  }
  return truncateCell(String(value), width);
}

function positiveInteger(value: unknown): number | null {
  let parsed = NaN;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string") parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getPrCreateLinks(value: unknown): {
  pr: JsonObject;
  githubUrl: string | null;
  adeUrl: string | null;
} {
  const result = unwrapActionEnvelope(value);
  const root = isRecord(result) ? result : {};
  const pr = firstRecord(root, ["pr"]) ?? root;
  const githubUrl =
    asString(root.githubUrl) ??
    asString(root.githubPrUrl) ??
    asString(pr.githubUrl) ??
    asString(pr.url);
  const explicitAdeUrl = asString(root.adeUrl) ?? asString(root.adePrUrl);
  const repoOwner = asString(pr.repoOwner);
  const repoName = asString(pr.repoName);
  const prNumber = positiveInteger(pr.githubPrNumber ?? pr.prNumber ?? pr.number);
  const derivedAdeUrl = repoOwner && repoName && prNumber
    ? buildDeeplink({ kind: "pr", repoOwner, repoName, prNumber })
    : null;
  return { pr, githubUrl, adeUrl: explicitAdeUrl ?? derivedAdeUrl };
}

function summarizePrCreateResult(value: unknown): unknown {
  const result = unwrapActionEnvelope(value);
  if (!isRecord(result)) return result;
  const { githubUrl, adeUrl } = getPrCreateLinks(result);
  return {
    ...result,
    ...(githubUrl ? { githubUrl } : {}),
    ...(adeUrl ? { adeUrl } : {}),
  };
}

function buildSyncWebPairingOutput(value: unknown): SyncWebPairingCliOutput {
  const status = isRecord(value) ? value as Partial<SyncRoleSnapshot> : {};
  const connectInfo = isRecord(status.pairingConnectInfo)
    ? status.pairingConnectInfo
    : null;
  const rawCandidates = Array.isArray(connectInfo?.addressCandidates)
    ? connectInfo.addressCandidates
    : [];
  const addressCandidates = rawCandidates
    .filter((candidate): candidate is NonNullable<SyncRoleSnapshot["pairingConnectInfo"]>["addressCandidates"][number] =>
      isRecord(candidate) && Boolean(asString(candidate.host)))
    .map((candidate) => ({
      host: asString(candidate.host) ?? "",
      kind: candidate.kind,
    }));
  const hostIdentity = isRecord(connectInfo?.hostIdentity)
    ? connectInfo.hostIdentity
    : null;
  const machineName =
    asString(hostIdentity?.name) ??
    asString(status.localDevice?.name) ??
    asString(status.currentRuntime?.name) ??
    "this machine";
  const port =
    typeof connectInfo?.port === "number"
      ? connectInfo.port
      : Number(connectInfo?.port);
  const pinConfigured = status.pairingPinConfigured === true;
  const code = pinConfigured ? asString(status.pairingPin) : null;
  const relayEnabled =
    addressCandidates.some((candidate) =>
      candidate.kind === "relay" && candidate.host.trim().length > 0) ||
    Boolean(connectInfo && asString((connectInfo as JsonObject).relayUrl));

  if (!connectInfo || addressCandidates.length === 0 || !hostIdentity || !Number.isFinite(port)) {
    return {
      pairingUrl: null,
      code,
      pinConfigured,
      machineName,
      relayEnabled,
    };
  }

  const normalizedConnectInfo: SyncPairingConnectInfo = {
    hostIdentity: hostIdentity as SyncPairingConnectInfo["hostIdentity"],
    port,
    addressCandidates,
  };

  return {
    pairingUrl: buildWebClientPairUrl(buildPairingQrPayload({ connectInfo: normalizedConnectInfo })),
    code,
    pinConfigured,
    machineName,
    relayEnabled,
  };
}

function isSyncWebPairingCliOutput(value: unknown): value is SyncWebPairingCliOutput {
  return (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "pairingUrl") &&
    Object.prototype.hasOwnProperty.call(value, "pinConfigured") &&
    Object.prototype.hasOwnProperty.call(value, "machineName") &&
    Object.prototype.hasOwnProperty.call(value, "relayEnabled")
  );
}

function formatSyncStatus(value: unknown): string {
  const snapshot = isRecord(value) ? value : {};
  const routeHealth = isRecord(snapshot.routeHealth) ? snapshot.routeHealth : {};
  const listener = isRecord(routeHealth.listener) ? routeHealth.listener : {};
  const tailscale = isRecord(routeHealth.tailscale) ? routeHealth.tailscale : {};
  const relay = isRecord(routeHealth.relay) ? routeHealth.relay : {};
  const accountDirectory = isRecord(routeHealth.accountDirectory)
    ? routeHealth.accountDirectory
    : {};
  const accountParts = [asString(accountDirectory.state) ?? "unavailable"];
  const reachableEndpointCount = typeof accountDirectory.reachableEndpointCount === "number"
    ? accountDirectory.reachableEndpointCount
    : null;
  if (reachableEndpointCount != null) {
    accountParts.push(`${reachableEndpointCount} reachable endpoint${reachableEndpointCount === 1 ? "" : "s"}`);
  }
  if (typeof accountDirectory.lastHttpStatus === "number") {
    accountParts.push(`HTTP ${accountDirectory.lastHttpStatus}`);
  }
  const origin = asString(accountDirectory.directoryOrigin);
  if (origin) accountParts.push(origin);
  const skipReason = asString(accountDirectory.skipReason);
  let lastAttempt: string | null = null;
  if (
    typeof accountDirectory.lastAttemptAt === "number"
    && Number.isFinite(accountDirectory.lastAttemptAt)
  ) {
    lastAttempt = new Date(accountDirectory.lastAttemptAt).toISOString();
  }
  const lastSuccess = typeof accountDirectory.lastSuccessAt === "number"
    && Number.isFinite(accountDirectory.lastSuccessAt)
    ? new Date(accountDirectory.lastSuccessAt).toISOString()
    : null;

  const peers = Array.isArray(snapshot.connectedPeers)
    ? snapshot.connectedPeers.length
    : null;
  const listenerState = listener.listenerBound === true
    ? listener.loopbackAdeValidated === true
      ? `ready${typeof listener.port === "number" ? ` on ${listener.port}` : ""}`
      : asString(listener.reason) ?? "bound but not validated"
    : asString(listener.reason) ?? "not bound";
  const tailscaleState = tailscale.tailscaleReachable === true
    ? "reachable"
    : asString(tailscale.reason) ?? (tailscale.enabled === true ? "not reachable" : "disabled");
  const relaySkipReason = asString(relay.skipReason)
    ?? asString(relay.lastControlError);
  const relayState = relay.relayControlConnected === true && relay.relayBridgeValidated === true
    ? "reachable"
    : relaySkipReason ?? (relay.enabled === true ? "not reachable" : "disabled");
  const transferReadiness = isRecord(snapshot.transferReadiness)
    ? snapshot.transferReadiness
    : null;
  const transferBlockers = Array.isArray(transferReadiness?.blockers)
    ? transferReadiness.blockers.filter(isRecord)
    : [];
  const transferState = transferReadiness?.ready === true
    ? "ready"
    : transferReadiness
      ? transferBlockers.length > 0
        ? `blocked by ${transferBlockers.length} active item${transferBlockers.length === 1 ? "" : "s"}`
        : "not ready"
      : null;
  const transferRows: Array<[string, unknown]> = transferBlockers.map((blocker, index) => {
    const label = asString(blocker.label) ?? asString(blocker.kind) ?? `blocker ${index + 1}`;
    const detail = asString(blocker.detail);
    return [`transfer blocker ${index + 1}`, detail ? `${label}: ${detail}` : label];
  });

  return renderKeyValues("ADE sync status", [
    ["mode", snapshot.mode],
    ["role", snapshot.role],
    ["runtime role", snapshot.runtimeRole],
    ["runtime name", snapshot.runtimeName],
    ["connected peers", peers],
    ["listener", listenerState],
    ["tailscale", tailscaleState],
    ["relay", relayState],
    ["relay control error", relay.lastControlError],
    ["relay control opened", relay.lastControlOpenAt],
    ["relay bridge validated", relay.lastBridgeValidationAt],
    ["account directory", accountParts.join(" · ")],
    ["directory reason", skipReason],
    ["directory attempt", lastAttempt],
    ["directory success", lastSuccess],
    ["transfer readiness", transferState],
    ...transferRows,
    ["survivable state", snapshot.survivableStateText],
    ["blocking state", snapshot.blockingStateText],
  ]);
}

function formatSyncWebPairing(value: unknown): string {
  const info = isSyncWebPairingCliOutput(value)
    ? value
    : buildSyncWebPairingOutput(value);
  if (!info.pairingUrl) {
    return "No machine addresses are published yet — is the sync host running? (ade sync status)";
  }
  const hasVisibleCode = info.pinConfigured && Boolean(info.code);
  let codeLines: string[];
  let nextStep: string;
  if (hasVisibleCode) {
    codeLines = [`  Code   ${info.code}`];
    nextStep = "Open the link in any browser and enter the code to pair.";
  } else if (info.pinConfigured) {
    codeLines = [
      "  Code   (PIN configured but hidden after runtime restart)",
      "  Known  Use the existing code if you already know it.",
      "  New    ade sync pin generate",
      "  Set    ade sync pin set <6-digit-code>",
    ];
    nextStep =
      "Open the link and enter the existing code if you know it. " +
      "Generate or set a new code only if you need ADE to display or copy one.";
  } else {
    codeLines = ["  Code   (no PIN set — run: ade sync pin generate)"];
    nextStep = "Generate or set a new code on this machine, then run ade sync web again.";
  }
  return [
    "Web client pairing",
    "",
    `  Link   ${info.pairingUrl}`,
    ...codeLines,
    "",
    nextStep,
    "Off your LAN or tailnet? Sign in to ADE so the browser can reach this machine through the relay.",
  ].join("\n");
}

function formatAutomationRunDetail(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  const run = isRecord(value.run) ? value.run : value;
  const actions = Array.isArray(value.actions)
    ? value.actions
    : Array.isArray(run.actions)
      ? run.actions
      : [];
  const header = renderKeyValues("ADE automation run", [
    ["id", run.id],
    ["rule", run.automationId ?? run.ruleId],
    ["status", run.status],
    ["startedAt", run.startedAt],
    ["finishedAt", run.finishedAt],
    ["lane", run.laneId ?? run.targetLaneId],
    ["error", run.errorMessage],
  ]);
  const rows = actions
    .filter((action): action is JsonObject => isRecord(action))
    .map((action) => {
      const kind =
        typeof action.kind === "string"
          ? action.kind
          : typeof action.type === "string"
            ? action.type
            : "action";
      const status = typeof action.status === "string" ? action.status : "?";
      const error =
        typeof action.errorMessage === "string" ? action.errorMessage : "";
      const output = typeof action.output === "string" ? action.output : "";
      const isLaneSetup = kind === "lane-setup";
      const note = error
        ? isLaneSetup
          ? `FAILED: ${error}`
          : error
        : isLaneSetup && output
          ? `created lane: ${output}`
          : output;
      const label = isLaneSetup ? "lane-setup" : kind;
      return [label, status, note];
    });
  const table = renderTable(["step", "status", "detail"], rows, "(no actions)");
  return [header, "", "Actions", table].join("\n");
}

function formatAutomationIngress(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  if (!isRecord(result)) return JSON.stringify(result, null, 2);
  const gateway = isRecord(result.webhookGateway) ? result.webhookGateway : result;
  const tailscale = isRecord(gateway.tailscale) ? gateway.tailscale : {};
  const localWebhook = isRecord(result.localWebhook) ? result.localWebhook : null;
  const githubRelay = isRecord(result.githubRelay) ? result.githubRelay : null;
  const gatewayLines = renderKeyValues("ADE automation ingress", [
    ["gateway", gateway.ready === true ? "online" : asString(gateway.status) ?? "not ready"],
    ["publicUrl", gateway.publicUrl],
    ["localUrl", gateway.localUrl],
    ["provider", gateway.provider],
    ["tailscale", tailscale.available === true ? "available" : "not available"],
    ["tailscaleHost", tailscale.hostname],
    ["lastCheckedAt", gateway.lastCheckedAt],
    ["error", gateway.lastError],
  ]);
  const localLines = localWebhook
    ? renderKeyValues("Local webhook", [
        ["status", localWebhook.status],
        ["url", localWebhook.url],
        ["githubUrl", localWebhook.githubUrl],
        ["port", localWebhook.port],
        ["lastDeliveryAt", localWebhook.lastDeliveryAt],
        ["error", localWebhook.lastError],
      ])
    : "";
  const relayLines = githubRelay
    ? renderKeyValues("Legacy GitHub relay", [
        ["status", githubRelay.status],
        ["configured", githubRelay.configured],
        ["healthy", githubRelay.healthy],
        ["lastDeliveryAt", githubRelay.lastDeliveryAt],
        ["error", githubRelay.lastError],
      ])
    : "";
  // `delivery` is optional; remote runtimes built before per-trigger delivery
  // reporting omit it. renderKeyValues drops empty rows, so missing sub-status
  // entries simply don't render.
  const delivery = isRecord(result.delivery) ? result.delivery : null;
  const deliveryLines = delivery
    ? renderKeyValues("Trigger delivery", [
        ["github", formatDeliveryStatus(delivery.github)],
        ["githubWebhook", formatDeliveryStatus(delivery.githubWebhook)],
        ["webhook", formatDeliveryStatus(delivery.webhook)],
        ["linear", formatDeliveryStatus(delivery.linear)],
      ])
    : "";
  return [gatewayLines, localLines, relayLines, deliveryLines]
    .filter(Boolean)
    .join("\n\n");
}

function formatDeliveryStatus(value: unknown): string {
  if (!isRecord(value)) return "";
  if (value.ready === true) {
    const via = asString(value.via);
    return via ? `ready (${via})` : "ready";
  }
  const setupError = asString(value.setupError);
  return setupError ? `not ready — ${setupError}` : "not ready";
}

function formatAutomationLinearIngress(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  if (!isRecord(result)) return JSON.stringify(result, null, 2);
  return renderKeyValues("ADE Linear ingress", [
    ["state", result.state],
    ["appManaged", result.appManaged],
    ["webhookId", result.webhookId],
    ["organizationId", result.organizationId],
    ["relayBaseUrl", result.relayBaseUrl],
    ["lastEventAt", result.lastEventAt],
    ["error", result.lastError],
  ]);
}

function formatAutomationCleanups(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  const cleanups = Array.isArray(result) ? result : [];
  const rows = cleanups
    .filter((entry): entry is JsonObject => isRecord(entry))
    .map((entry) => [
      entry.id,
      entry.status,
      entry.laneId,
      entry.dueAt,
      typeof entry.error === "string" ? entry.error : "",
    ]);
  return renderTable(
    ["id", "status", "lane", "dueAt", "error"],
    rows,
    "(no scheduled cleanups)",
  );
}

function formatBytes(bytes: unknown): string {
  const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
  const abs = Math.abs(value);
  if (abs < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let scaled = value / 1024;
  let unitIndex = 0;
  while (Math.abs(scaled) >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const rounded = Math.abs(scaled) >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function formatStorageSnapshot(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  const volume = isRecord(value.volume) ? value.volume : {};
  const freeBytes = typeof volume.freeBytes === "number" ? volume.freeBytes : null;
  const totalBytes = typeof volume.totalBytes === "number" ? volume.totalBytes : null;
  const volumeSummary = freeBytes != null && totalBytes != null
    ? `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)}`
    : null;
  const header = renderKeyValues("ADE storage", [
    ["project", value.projectRoot],
    ["ade data", formatBytes(value.totalAdeBytes)],
    ["volume", volumeSummary],
    ["scanned", value.generatedAt],
    ["truncated", value.truncated === true ? "yes (scan incomplete)" : undefined],
  ]);
  const categories = Array.isArray(value.categories) ? value.categories : [];
  const rows = categories
    .filter(isRecord)
    .sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0))
    .map((category) => [
      cell(category.id, 24),
      formatBytes(category.bytes),
      typeof category.fileCount === "number" ? String(category.fileCount) : "-",
      cell(category.safety, 16),
      typeof category.compressibleBytes === "number" && category.compressibleBytes > 0
        ? `${formatBytes(category.compressibleBytes)} compressible`
        : "",
    ]);
  const table = renderTable(
    ["CATEGORY", "SIZE", "FILES", "SAFETY", "NOTE"],
    rows,
    "No ADE-managed storage categories were found.",
  );
  return `${header}\n\n${table}`;
}

function formatStorageCompression(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  return renderKeyValues("ADE storage compression", [
    ["files compressed", value.filesCompressed],
    ["reclaimed", formatBytes(value.savedBytes)],
  ]);
}

function formatLastFailureLine(report: AdeLastFailureReport): string {
  const repeat = report.count > 1 ? ` x${report.count}` : "";
  const scope = report.projectRoot ? ` [${report.projectRoot}]` : "";
  return `${report.code} (${report.component}${repeat}) at ${report.at}${scope} — ${report.message}`;
}

function renderKeyValues(
  title: string,
  entries: Array<[string, unknown]>,
): string {
  const rows = entries.filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));
  return [
    title,
    ...rows.map(
      ([label, value]) => `${label.padEnd(labelWidth)}  ${cell(value, 96)}`,
    ),
  ].join("\n");
}

function renderTable(
  headers: string[],
  rows: unknown[][],
  emptyMessage: string,
): string {
  if (rows.length === 0) return emptyMessage;
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map(
        (row) =>
          cell(row[index], index === headers.length - 1 ? 64 : 28).length,
      ),
    ),
  );
  const renderRow = (row: unknown[]) =>
    row
      .map((entry, index) =>
        cell(entry, index === headers.length - 1 ? 64 : 28).padEnd(
          widths[index] ?? 0,
        ),
      )
      .join("  ")
      .trimEnd();
  return [
    renderRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(renderRow),
  ].join("\n");
}

function firstArray(value: unknown, keys: string[]): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const entry = value[key];
    if (Array.isArray(entry)) return entry.filter(isRecord);
  }
  return [];
}

function firstRecord(value: unknown, keys: string[]): JsonObject | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const entry = value[key];
    if (isRecord(entry)) return entry;
  }
  return null;
}

function statusWord(value: unknown): string {
  const raw = cell(value, 24).toLowerCase();
  if (!raw) return "";
  if (
    [
      "success",
      "passing",
      "passed",
      "completed",
      "ready",
      "clean",
      "ok",
    ].includes(raw)
  )
    return "OK";
  if (
    ["failure", "failed", "failing", "error", "blocked", "dirty"].includes(raw)
  )
    return "FAIL";
  if (["pending", "running", "in_progress", "queued", "active"].includes(raw))
    return "WAIT";
  return raw.toUpperCase();
}

function formatActionsList(value: unknown): string {
  const actionResult =
    isRecord(value) && isRecord(value.actions) ? value.actions : value;
  const actions = firstArray(actionResult, ["actions"]);
  if (actions.length === 0) return "ADE actions\n(no actions)";
  const byDomain = new Map<string, JsonObject[]>();
  for (const action of actions) {
    const name = asString(action.name);
    const domain =
      asString(action.domain) ??
      (name?.includes(".") ? name.split(".")[0] : null) ??
      "core";
    const list = byDomain.get(domain) ?? [];
    list.push(action);
    byDomain.set(domain, list);
  }
  const personalOnly = actions.every((action) => asString(action.name)?.startsWith("personalChats."));
  const lines = personalOnly
    ? [
        "ADE personal chat actions",
        'Use: ade chat action --personal <action> --input-json \'{"key":"value"}\'',
      ]
    : [
        "ADE actions",
        'Use: ade actions run <domain.action> --input-json \'{"key":"value"}\'',
        'For multi-parameter methods: --args-list-json \'["first",{"second":true}]\'',
      ];
  for (const [domain, list] of [...byDomain.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push("", `${domain}:`);
    for (const action of list.sort((left, right) =>
      cell(left.action ?? left.name).localeCompare(
        cell(right.action ?? right.name),
      ),
    )) {
      const name =
        asString(action.action) ?? asString(action.name) ?? "(unknown)";
      const description = asString(action.description) ?? "";
      const input = asString(action.input) ?? "";
      const example = asString(action.example) ?? "";
      lines.push(
        `  ${name}${description ? ` - ${truncateCell(description, 86)}` : ""}`,
      );
      if (input) lines.push(`    input: ${input}`);
      if (example) lines.push(`    example: ${example}`);
    }
  }
  return lines.join("\n");
}

function formatLaneDetail(value: unknown): string {
  const root = isRecord(value) ? value : {};
  const lane = firstRecord(value, ["lane"]) ?? (isRecord(value) ? value : {});
  const linearLabels = linearIssueLabels(lane);
  return renderKeyValues("ADE lane", [
    ["id", lane.id],
    ["name", lane.name],
    ["branch", lane.branchRef ?? lane.branch],
    ["base", lane.baseBranch ?? lane.baseRef],
    ["linear issue", linearLabels[0] ?? null],
    ["linear links", linearLabels.length > 1 ? linearLabels.slice(1).join(", ") : null],
    ["status", lane.status ?? root.rebaseStatus],
    ["worktree", lane.worktreePath],
  ]);
}

function formatPrList(value: unknown): string {
  const prs = firstArray(value, ["prs", "pullRequests", "items", "results"]);
  return renderTable(
    ["PR", "state", "lane", "branch", "title"],
    prs.map((pr) => [
      pr.githubPrNumber ?? pr.number ?? pr.prNumber ?? pr.id,
      pr.state ?? pr.status,
      pr.laneId ?? pr.laneName,
      pr.headBranch ?? pr.headRefName ?? pr.branchRef ?? pr.branch,
      pr.title,
    ]),
    "ADE pull requests\n(no PRs)",
  );
}

function formatPrCreate(value: unknown): string {
  const { pr, githubUrl, adeUrl } = getPrCreateLinks(value);
  const prNumber = positiveInteger(pr.githubPrNumber ?? pr.prNumber ?? pr.number);
  return renderKeyValues("ADE pull request created", [
    ["id", pr.id],
    ["number", prNumber ? `#${prNumber}` : null],
    ["title", pr.title],
    ["state", pr.state ?? pr.status],
    ["lane", pr.laneId],
    ["GitHub URL", githubUrl],
    ["ADE URL", adeUrl],
  ]);
}

function formatPrChecks(value: unknown): string {
  const checks = firstArray(value, ["checks", "items"]);
  const summary = isRecord(value) ? value.summary : null;
  const header = summary
    ? `ADE PR checks - ${cell(summary, 80)}`
    : "ADE PR checks";
  return `${header}\n${renderTable(
    ["status", "name", "details"],
    checks.map((check) => [
      statusWord(check.conclusion ?? check.status),
      check.name,
      check.detailsUrl ?? check.url ?? check.completedAt,
    ]),
    "(no checks)",
  )}`;
}

function formatPrComments(value: unknown): string {
  const threads = firstArray(value, ["reviewThreads", "threads"]);
  const comments = firstArray(value, ["comments", "issueComments"]);
  const lines = ["ADE PR comments"];
  if (threads.length > 0) {
    lines.push(
      "",
      renderTable(
        ["thread", "state", "file", "comment"],
        threads.map((thread) => {
          const threadComments = Array.isArray(thread.comments)
            ? thread.comments.filter(isRecord)
            : [];
          const first = threadComments[0] ?? {};
          return [
            thread.id,
            thread.isResolved ? "resolved" : "open",
            `${cell(thread.path, 34)}${thread.line ? `:${thread.line}` : ""}`,
            first.body ?? thread.body,
          ];
        }),
        "(no review threads)",
      ),
    );
  }
  if (comments.length > 0) {
    lines.push(
      "",
      renderTable(
        ["id", "author", "comment"],
        comments.map((comment) => [
          comment.id,
          comment.author ?? comment.user,
          comment.body,
        ]),
        "(no issue comments)",
      ),
    );
  }
  if (threads.length === 0 && comments.length === 0)
    lines.push("(no comments)");
  return lines.join("\n");
}

function formatFileTree(value: unknown): string {
  const entries = firstArray(value, ["entries", "nodes", "items", "children"]);
  return renderTable(
    ["type", "path", "size"],
    entries.map((entry) => [
      entry.type ?? (entry.isDirectory ? "dir" : "file"),
      entry.path ?? entry.name,
      entry.sizeBytes ?? entry.size,
    ]),
    "ADE files\n(no entries)",
  );
}

function formatFileRead(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  const text =
    typeof value.text === "string"
      ? value.text
      : typeof value.content === "string"
        ? value.content
        : null;
  return text ?? JSON.stringify(value, null, 2);
}

function formatFilesSearch(value: unknown): string {
  const matches = firstArray(value, ["matches", "results", "items"]);
  return renderTable(
    ["file", "line", "match"],
    matches.map((match) => [
      match.path ?? match.filePath,
      match.line ?? match.lineNumber,
      match.preview ?? match.text ?? match.match,
    ]),
    "ADE file search\n(no matches)",
  );
}

function formatDiffSummary(value: unknown): string {
  const files = firstArray(value, ["files", "changes", "items"]);
  return renderTable(
    ["status", "file", "+", "-"],
    files.map((file) => [
      file.status ?? file.changeType ?? file.type,
      file.path ?? file.filePath ?? file.newPath ?? file.oldPath,
      file.additions ?? file.added ?? "",
      file.deletions ?? file.deleted ?? "",
    ]),
    "ADE diff\n(no changed files)",
  );
}

function formatRunTable(value: unknown, title: string): string {
  const rows = firstArray(value, [
    "processes",
    "definitions",
    "runtime",
    "runs",
    "items",
  ]);
  return `${title}\n${renderTable(
    ["id", "status", "lane", "command"],
    rows.map((row) => [
      row.id ?? row.processId ?? row.runId ?? row.name,
      row.status ?? row.state,
      row.laneId ?? row.laneName,
      row.command ?? row.startupCommand ?? row.title,
    ]),
    "(none)",
  )}`;
}

function formatSearchResults(value: unknown): string {
  const record = isRecord(value) ? value : {};
  const results = firstArray(value, ["results", "items"]);
  if (results.length === 0) return "ADE search\n(no results)";
  const rows = results.map((item) => ({
    kind: truncateCell(asString(item.kind) ?? "", 10),
    title: truncateCell(asString(item.title) ?? "", 40),
    snippet: truncateCell(asString(item.snippet) ?? "", 60),
    id: truncateCell(asString(item.id) ?? "", 60),
  }));
  const kindWidth = Math.max(4, ...rows.map((row) => row.kind.length));
  const titleWidth = Math.max(5, ...rows.map((row) => row.title.length));
  const snippetWidth = Math.max(7, ...rows.map((row) => row.snippet.length));
  const renderRow = (kind: string, title: string, snippet: string, id: string) =>
    [
      kind.padEnd(kindWidth),
      title.padEnd(titleWidth),
      snippet.padEnd(snippetWidth),
      id,
    ]
      .join("  ")
      .trimEnd();
  const lines = [
    "ADE search",
    renderRow("KIND", "TITLE", "SNIPPET", "ID"),
    ...rows.map((row) => renderRow(row.kind, row.title, row.snippet, row.id)),
  ];
  const totalByKind = isRecord(record.totalByKind) ? record.totalByKind : {};
  const breakdown = Object.entries(totalByKind)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
  const summary = `${results.length} result${results.length === 1 ? "" : "s"}${
    breakdown ? ` (${breakdown})` : ""
  }`;
  lines.push("", summary);
  const nextCursor = asString(record.nextCursor);
  if (nextCursor) lines.push(`more: --cursor ${nextCursor}`);
  return lines.join("\n");
}

function formatSearchStatus(value: unknown): string {
  const record = isRecord(value) ? value : {};
  if (record.docCount === undefined && record.started !== undefined) {
    return renderKeyValues("ADE search index", [
      ["rebuild started", record.started],
    ]);
  }
  const byKind = isRecord(record.docCountByKind) ? record.docCountByKind : {};
  const kindLine = Object.entries(byKind)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
  return renderKeyValues("ADE search index", [
    ["ready", record.ready],
    ["docs", record.docCount],
    ["by kind", kindLine],
    ["backfill complete", record.backfillComplete],
    ["pending sources", record.pendingSources],
    ["schema version", record.schemaVersion],
    ["last updated", record.lastUpdatedAt],
    ["index path", record.indexPath],
  ]);
}

function formatExternalSessions(value: unknown): string {
  if (isRecord(value) && (value.kind === "cli" || value.kind === "chat")) {
    return renderKeyValues("ADE external session import", [
      ["kind", value.kind],
      ["session", value.sessionId ?? value.chatSessionId],
      ["pty", value.ptyId],
      ["lane", value.laneId],
    ]);
  }

  const sessions = Array.isArray(value)
    ? value.filter(isRecord)
    : firstArray(value, ["sessions", "results", "items"]);
  return renderTable(
    ["provider", "id", "cwd", "status", "title"],
    sessions.map((session) => [
      session.provider,
      session.id,
      session.cwd,
      session.alreadyImported ? "imported" : session.possiblyActive ? "active" : "",
      session.title ?? session.preview,
    ]),
    "ADE external sessions\n(no sessions)",
  );
}

function formatChatList(value: unknown): string {
  const sessions = firstArray(value, ["sessions", "chats", "items"]);
  return renderTable(
    ["session", "provider", "lane", "title"],
    sessions.map((session) => [
      session.id ?? session.sessionId,
      session.provider ?? session.modelId,
      session.laneId,
      session.title,
    ]),
    "ADE chats\n(no sessions)",
  );
}

function formatChatRead(value: unknown): string {
  const entries = Array.isArray(value)
    ? value.filter(isRecord)
    : firstArray(value, ["entries", "messages", "items"]);
  if (!entries.length) return "ADE chat transcript\n(no messages)";
  const lines = ["ADE chat transcript"];
  for (const entry of entries) {
    const role = asString(entry.role) ?? "message";
    const timestamp = asString(entry.timestamp);
    const text = asString(entry.displayText) ?? asString(entry.text) ?? "";
    lines.push("");
    lines.push(timestamp ? `${role} ${timestamp}` : role);
    lines.push(text.length ? text : "(empty)");
  }
  return lines.join("\n");
}

function formatTestsRuns(value: unknown): string {
  const runs = firstArray(value, ["runs", "items"]);
  return renderTable(
    ["run", "status", "suite", "duration"],
    runs.map((run) => [
      run.id ?? run.runId,
      statusWord(run.status),
      run.suiteId ?? run.suiteName,
      run.durationMs,
    ]),
    "ADE test runs\n(no runs)",
  );
}

function formatProofList(value: unknown): string {
  const artifacts = firstArray(value, ["artifacts", "items"]);
  return renderTable(
    ["kind", "created", "title", "path"],
    artifacts.map((artifact) => [
      artifact.kind ?? artifact.type,
      artifact.createdAt,
      artifact.title ?? artifact.name,
      artifact.path ?? artifact.uri,
    ]),
    "ADE proof artifacts\n(no artifacts)",
  );
}

function formatIosSimStatus(value: unknown): string {
  const status = isRecord(value) ? value : {};
  const tools = Array.isArray(status.tools)
    ? status.tools.filter(isRecord)
    : [];
  const activeDevice = isRecord(status.activeDevice) ? status.activeDevice : {};
  const activeSession = isRecord(status.activeSession)
    ? status.activeSession
    : {};
  return [
    renderKeyValues("ADE iOS simulator", [
      ["supported", status.supported],
      ["platform", status.platform],
      [
        "active device",
        activeDevice.name
          ? `${activeDevice.name} (${activeDevice.state})`
          : null,
      ],
      ["active app", activeSession.bundleId],
      ["lane", activeSession.laneId],
      ["mode", activeSession.mode],
      ["chat session", activeSession.chatSessionId],
      ["claimed", activeSession.claimedAt],
    ]),
    "",
    renderTable(
      ["tool", "ready", "detail"],
      tools.map((tool) => [
        tool.name,
        tool.available ? "yes" : "no",
        tool.detail,
      ]),
      "Tools\n(none)",
    ),
  ].join("\n");
}

function formatIosSimDevices(value: unknown): string {
  const devices = Array.isArray(value)
    ? value.filter(isRecord)
    : firstArray(value, ["devices", "items"]);
  return renderTable(
    ["udid", "device", "runtime", "state"],
    devices.map((device) => [
      device.udid,
      device.name,
      device.runtime,
      device.state,
    ]),
    "ADE iOS simulators\n(no installed simulators)",
  );
}

function formatIosSimApps(value: unknown): string {
  const targets = Array.isArray(value)
    ? value.filter(isRecord)
    : firstArray(value, ["targets", "apps", "items"]);
  return renderTable(
    ["target", "kind", "name", "bundle"],
    targets.map((target) => [
      target.id,
      target.kind,
      target.name,
      target.bundleId ?? target.detail,
    ]),
    "ADE iOS launchable apps\n(no apps)",
  );
}

function formatIosSimStream(value: unknown): string {
  const status = isRecord(value) ? value : {};
  return renderKeyValues("ADE iOS simulator live view", [
    ["running", status.running],
    ["device", status.deviceUdid],
    ["refresh rate", status.fps ?? status.targetFps],
    ["input", status.inputBackend],
    ["error code", isRecord(status.error) ? status.error.code : null],
    ["started", status.startedAt],
    ["error", status.lastError],
  ]);
}

function formatIosSimSnapshot(value: unknown): string {
  const snapshot = isRecord(value) ? value : {};
  const screenshot = isRecord(snapshot.screenshot)
    ? snapshot.screenshot
    : snapshot;
  const screen = isRecord(snapshot.screen) ? snapshot.screen : {};
  const providers = Array.isArray(snapshot.providers)
    ? snapshot.providers.filter(isRecord)
    : [];
  const elements = Array.isArray(snapshot.elements)
    ? snapshot.elements.filter(isRecord)
    : [];
  const providerSummary = providers
    .map(
      (provider) =>
        `${provider.source}:${provider.available ? (provider.elementCount ?? "ok") : "unavailable"}`,
    )
    .join(", ");
  return [
    renderKeyValues("ADE iOS simulator snapshot", [
      ["device", snapshot.deviceUdid],
      ["captured", snapshot.capturedAt],
      [
        "screenshot",
        screenshot.width && screenshot.height
          ? `${screenshot.width}x${screenshot.height}`
          : null,
      ],
      [
        "screen",
        screen.width && screen.height
          ? `${screen.width}x${screen.height} @${screen.scale ?? 1}x`
          : null,
      ],
      ["elements", elements.length],
      ["providers", providerSummary],
    ]),
    elements.length ? "" : "",
    elements.length
      ? renderTable(
          ["id", "source", "label", "source file"],
          elements
            .slice(0, 20)
            .map((element) => [
              element.id,
              element.source,
              element.label ?? element.identifier ?? element.componentId,
              element.sourceFile
                ? `${element.sourceFile}${element.sourceLine ? `:${element.sourceLine}` : ""}`
                : "",
            ]),
          "",
        )
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatIosSimSelection(value: unknown): string {
  const item =
    firstRecord(value, ["item", "selection"]) ?? (isRecord(value) ? value : {});
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  return renderKeyValues("ADE iOS simulator selection", [
    ["component", item.componentId],
    [
      "source",
      isRecord(value)
        ? (value.source ?? metadata.screenElementSource)
        : metadata.screenElementSource,
    ],
    [
      "file",
      item.sourceFile
        ? `${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}`
        : null,
    ],
    ["identifier", item.accessibilityIdentifier],
    ["chat session", metadata.chatSessionId],
    ["selected", item.selectedAt],
  ]);
}

function formatIosSimPreview(value: unknown): string {
  if (Array.isArray(value)) {
    const targets = value.filter(isRecord);
    return renderTable(
      ["index", "title", "file", "kind"],
      targets.map((target) => [
        target.previewDefinitionIndexInFile,
        target.title,
        target.sourceFilePath ?? target.sourceFile,
        target.kind,
      ]),
      "ADE iOS previews\n(no #Preview definitions found)",
    );
  }
  const record = isRecord(value) ? value : {};
  if (isRecord(record.match)) {
    const match = record.match;
    const target = isRecord(record.target)
      ? record.target
      : isRecord(match.target)
        ? match.target
        : null;
    const render = isRecord(record.render) ? record.render : null;
    return renderKeyValues("ADE iOS Preview current", [
      ["ok", record.ok],
      ["status", match.status],
      ["confidence", match.confidence],
      [
        "selected",
        match.selectedSourceFile
          ? `${match.selectedSourceFile}${match.selectedSourceLine ? `:${match.selectedSourceLine}` : ""}`
          : null,
      ],
      [
        "target",
        target
          ? `${target.title ?? "Preview"} · ${target.sourceFilePath ?? target.sourceFile ?? "unknown"}`
          : null,
      ],
      ["snapshot", render?.previewSnapshotPath],
      ["rendered", render?.renderedAt],
      ["reason", match.reason],
      ["error", record.error ?? render?.error],
    ]);
  }
  if (typeof record.status === "string" && "confidence" in record) {
    const target = isRecord(record.target) ? record.target : null;
    return renderKeyValues("ADE iOS Preview match", [
      ["status", record.status],
      ["confidence", record.confidence],
      [
        "selected",
        record.selectedSourceFile
          ? `${record.selectedSourceFile}${record.selectedSourceLine ? `:${record.selectedSourceLine}` : ""}`
          : null,
      ],
      [
        "target",
        target
          ? `${target.title ?? "Preview"} · ${target.sourceFilePath ?? target.sourceFile ?? "unknown"}`
          : null,
      ],
      ["suggested file", record.suggestedSourceFilePath ?? record.suggestedSourceFile],
      ["suggested title", record.suggestedTitle],
      ["reason", record.reason],
    ]);
  }
  const capability = isRecord(record.capability) ? record.capability : record;
  const steps = Array.isArray(capability.setupSteps)
    ? capability.setupSteps.join("; ")
    : null;
  const selectedWindow = isRecord(capability.selectedWindow)
    ? capability.selectedWindow
    : {};
  return renderKeyValues("ADE iOS Preview Lab", [
    ["supported", capability.supported ?? record.ok],
    ["xcode", capability.xcodeVersion],
    ["mcpbridge", capability.mcpbridgeAvailable],
    ["xcode running", capability.xcodeRunning],
    ["xcode tab", selectedWindow.tabIdentifier],
    ["snapshot", record.previewSnapshotPath],
    ["rendered", record.renderedAt],
    ["setup", steps],
    ["error", record.error ?? capability.error],
  ]);
}

function formatAppControlStatus(value: unknown): string {
  const status = isRecord(value) ? value : {};
  const providers = Array.isArray(status.providers)
    ? status.providers.filter(isRecord)
    : [];
  const session = isRecord(status.activeSession)
    ? status.activeSession
    : typeof status.status === "string" && status.label
      ? status
      : {};
  return [
    renderKeyValues("ADE App Control", [
      ["supported", status.supported],
      ["platform", status.platform],
      ["active app", session.label],
      ["session", session.id],
      ["status", session.status],
      ["lane", session.laneId],
      ["cdp port", session.cdpPort],
      ["terminal", session.terminalSessionId],
      ["pty", session.terminalPtyId],
      ["chat session", session.chatSessionId],
      ["pid", session.pid],
      ["command", session.command],
      ["error", session.lastError],
    ]),
    "",
    renderTable(
      ["provider", "ready", "detail"],
      providers.map((provider) => [
        provider.provider,
        provider.available ? "yes" : "no",
        provider.detail,
      ]),
      "Providers\n(none)",
    ),
  ].join("\n");
}

function formatBrowserStatus(value: unknown): string {
  const status = isRecord(value) ? value : {};
  const tabs = Array.isArray(status.tabs) ? status.tabs.filter(isRecord) : [];
  const activeTabId = asString(status.activeTabId);
  const ownerForTab = (tab: Record<string, unknown>): string => {
    const lane = asString(tab.ownerLaneId);
    const chat = asString(tab.ownerChatSessionId);
    return [lane, chat].filter(Boolean).join(" / ");
  };
  return [
    renderKeyValues("ADE browser", [
      ["visible", status.visible],
      ["attached", status.attached],
      ["active tab", activeTabId],
      ["url", status.url],
      ["title", status.title],
      ["loading", status.isLoading ?? status.loading],
      ["back", status.canGoBack],
      ["forward", status.canGoForward],
      ["inspecting", status.isInspecting ?? status.inspecting],
      ["selection", status.hasSelection],
      ["active tab owner lane", status.ownerLaneId],
      ["active tab owner chat", status.ownerChatSessionId],
      ["active tab owner claimed", status.ownerClaimedAt],
    ]),
    "",
    renderTable(
      ["active", "tab", "owner", "title", "url"],
      tabs.map((tab) => [
        asString(tab.id) === activeTabId ? "*" : "",
        tab.id,
        ownerForTab(tab),
        tab.title,
        tab.url,
      ]),
      "Browser tabs\n(no browser tabs)",
    ),
  ].join("\n");
}

function formatBrowserSessions(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const session = firstRecord(result, ["session"]);
  const sessions = session
    ? [session]
    : firstArray(result, ["sessions"]);
  const activeSessions = sessions.filter((entry) => !entry.endedAt);
  return [
    renderKeyValues(session ? "ADE browser session" : "ADE browser sessions", [
      ["session", session?.id],
      ["tab", session?.tabId],
      ["created", session?.createdAt],
      ["updated", session?.updatedAt],
      ["ended", session?.endedAt],
      ["owner lane", session?.ownerLaneId],
      ["owner chat", session?.ownerChatSessionId],
      ["last observation", session?.lastObservationId],
      ["last trace", session?.lastTraceEntryId],
      ["active sessions", session ? null : activeSessions.length],
      ["total sessions", session ? null : sessions.length],
    ]),
    "",
    renderTable(
      ["active", "session", "tab", "owner", "last observation", "last trace", "updated"],
      sessions.map((entry) => [
        entry.endedAt ? "" : "*",
        entry.id,
        entry.tabId,
        [entry.ownerLaneId, entry.ownerChatSessionId].filter(Boolean).join(" / "),
        entry.lastObservationId,
        entry.lastTraceEntryId,
        entry.updatedAt,
      ]),
      "Browser sessions\n(no browser sessions)",
    ),
  ].join("\n");
}

function formatBrowserObservation(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const observation = firstRecord(result, ["observation"]) ?? result;
  const status = firstRecord(result, ["status"]);
  const trace = firstRecord(result, ["trace"]);
  const session = firstRecord(result, ["session"]);
  const cleanup = firstRecord(observation, ["cleanup"]);
  const dom = firstRecord(observation, ["dom"]);
  const elementMap = firstRecord(observation, ["elementMap"]);
  const diagnostics = firstRecord(observation, ["diagnostics"]);
  const consoleDiagnostics = firstArray(diagnostics ?? {}, ["console"]);
  const networkDiagnostics = firstArray(diagnostics ?? {}, ["network"]);
  const elements = firstArray(dom ?? {}, ["elements"]);
  const header = renderKeyValues("ADE browser observation", [
    ["ok", result.ok ?? true],
    ["session", session?.id ?? observation.sessionId ?? trace?.sessionId],
    ["tab", observation.tabId ?? status?.activeTabId],
    ["url", observation.url ?? status?.url],
    ["title", observation.title ?? status?.title],
    ["image", observation.filePath ?? observation.relativePath],
    ["element map", elementMap?.filePath ?? elementMap?.relativePath],
    [
      "size",
      observation.width && observation.height
        ? `${observation.width}x${observation.height}`
        : null,
    ],
    ["captured", observation.capturedAt],
    ["tab owner lane", observation.ownerLaneId ?? status?.ownerLaneId],
    ["tab owner chat", observation.ownerChatSessionId ?? status?.ownerChatSessionId],
    ["trace", trace?.id],
    ["trace status", trace?.status],
    ["trace error", trace?.error],
    ["pending requests", diagnostics?.pendingRequestCount],
    ["console issues", consoleDiagnostics.length || null],
    ["network issues", networkDiagnostics.length || null],
    [
      "dom elements",
      dom
        ? `${elements.length}/${dom.elementCount ?? elements.length}`
        : null,
    ],
    [
      "scratch kept",
      cleanup
        ? `${cleanup.keptCount ?? "?"}/${cleanup.keepCount ?? "?"}`
        : null,
    ],
    ["scratch deleted", cleanup?.deletedCount],
  ]);
  const rows = elements.slice(0, 12).map((element) => {
    const center = firstRecord(element, ["center"]);
    const x = typeof center?.x === "number" ? Math.round(center.x) : "";
    const y = typeof center?.y === "number" ? Math.round(center.y) : "";
    return [
      element.index,
      element.handle,
      element.role ?? element.tagName,
      element.label ?? element.text ?? element.value,
      x === "" || y === "" ? "" : `${x},${y}`,
      element.selector,
    ];
  });
  const sections = [header];
  if (elements.length) {
    sections.push(
      "",
      renderTable(
        ["#", "handle", "role/tag", "label", "center", "selector"],
        rows,
        "(no DOM elements)",
      ),
    );
  }
  if (consoleDiagnostics.length) {
    sections.push(
      "",
      renderTable(
        ["level", "message", "source"],
        consoleDiagnostics.slice(-6).map((entry) => [
          entry.level,
          entry.message,
          [entry.sourceId, entry.line].filter(Boolean).join(":"),
        ]),
        "(no console diagnostics)",
      ),
    );
  }
  if (networkDiagnostics.length) {
    sections.push(
      "",
      renderTable(
        ["status", "method", "url", "error"],
        networkDiagnostics.slice(-6).map((entry) => [
          entry.statusCode,
          entry.method,
          entry.url,
          entry.error,
        ]),
        "(no network diagnostics)",
      ),
    );
  }
  return sections.join("\n");
}

function formatBrowserTrace(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const entries = firstArray(result, ["entries"]);
  return [
    renderKeyValues("ADE browser trace", [
      ["session", result.sessionId],
      ["tab", result.tabId],
      ["entries", entries.length],
    ]),
    "",
    renderTable(
      ["status", "action", "ms", "target", "url", "error"],
      entries.map((entry) => {
        const target = isRecord(entry.target) ? entry.target : null;
        const before = firstRecord(entry, ["before"]);
        const after = firstRecord(entry, ["after"]);
        return [
          entry.status,
          entry.action,
          entry.durationMs,
          target ? JSON.stringify(target) : "",
          after?.url ?? before?.url,
          entry.error,
        ];
      }),
      "(no browser trace entries)",
    ),
  ].join("\n");
}

function formatAppControlSnapshot(value: unknown): string {
  const snapshot = isRecord(value) ? value : {};
  const screenshot = isRecord(snapshot.screenshot)
    ? snapshot.screenshot
    : snapshot;
  const screen = isRecord(snapshot.screen) ? snapshot.screen : {};
  const providers = Array.isArray(snapshot.providers)
    ? snapshot.providers.filter(isRecord)
    : [];
  const elements = Array.isArray(snapshot.elements)
    ? snapshot.elements.filter(isRecord)
    : [];
  const providerSummary = providers
    .map(
      (provider) =>
        `${provider.provider}:${provider.available ? (provider.elementCount ?? "ok") : "unavailable"}`,
    )
    .join(", ");
  return [
    renderKeyValues("ADE App Control snapshot", [
      ["title", snapshot.title],
      ["url", snapshot.url],
      ["captured", snapshot.capturedAt],
      [
        "screenshot",
        screenshot.width && screenshot.height
          ? `${screenshot.width}x${screenshot.height}`
          : null,
      ],
      [
        "screen",
        screen.width && screen.height
          ? `${screen.width}x${screen.height} @${screen.scale ?? 1}x`
          : null,
      ],
      ["elements", elements.length],
      ["providers", providerSummary],
    ]),
    elements.length ? "" : "",
    elements.length
      ? renderTable(
          ["ref", "role", "label", "selector"],
          elements
            .slice(0, 24)
            .map((element) => [
              element.ref ?? element.id,
              element.role ?? element.tagName,
              element.label ?? element.value ?? element.testId,
              element.selector,
            ]),
          "",
        )
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function asOperationRows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function filterHistoryOperations(
  rows: JsonObject[],
  statusFilter: string | undefined,
): JsonObject[] {
  if (!statusFilter || statusFilter === "all") return rows;
  return rows.filter((row) => row.status === statusFilter);
}

function formatHistoryList(value: unknown): string {
  const operations = asOperationRows(value);
  return renderTable(
    ["id", "lane", "kind", "status", "started", "ended", "pre", "post"],
    operations.map((operation) => [
      operation.id,
      operation.laneName ?? operation.laneId,
      operation.kind,
      operation.status,
      operation.startedAt,
      operation.endedAt,
      operation.preHeadSha,
      operation.postHeadSha,
    ]),
    "ADE operation history\n(no operations found)",
  );
}

function formatHistoryCommits(value: unknown): string {
  const commits = Array.isArray(value)
    ? value.filter(isRecord)
    : firstArray(value, ["commits", "items"]);
  return renderTable(
    ["sha", "subject", "author", "authored", "pushed"],
    commits.map((commit) => [
      commit.shortSha ?? commit.sha,
      commit.subject,
      commit.authorName,
      commit.authoredAt,
      commit.pushed,
    ]),
    "ADE lane commits\n(no commits found)",
  );
}

function formatHistoryShow(value: unknown): string {
  const operation = isRecord(value) ? value : {};
  return renderKeyValues("ADE operation", [
    ["id", operation.id],
    ["lane", operation.laneName ?? operation.laneId],
    ["kind", operation.kind],
    ["status", operation.status],
    ["started", operation.startedAt],
    ["ended", operation.endedAt],
    ["pre head", operation.preHeadSha],
    ["post head", operation.postHeadSha],
    ["metadata", operation.metadataJson],
  ]);
}

function formatTerminalList(value: unknown): string {
  const terminals = Array.isArray(value)
    ? value.filter(isRecord)
    : isRecord(value) && value.terminalId
      ? [value]
      : firstArray(value, ["terminals", "items"]);
  return renderTable(
    ["terminal", "pty", "chat", "status", "runtime", "ended", "resume", "title"],
    terminals.map((terminal) => [
      terminal.terminalId,
      terminal.ptyId,
      terminal.chatSessionId,
      terminal.status,
      terminal.runtimeState,
      terminal.endedAt,
      terminal.endedAt && (terminal.resumeCommand || terminal.resumeMetadata) ? "yes" : "",
      terminal.title,
    ]),
    "ADE attached terminals\n(no terminals found)",
  );
}

function formatPtyCreate(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const sessionId = typeof result.sessionId === "string" ? result.sessionId : null;
  const ptyId = typeof result.ptyId === "string" ? result.ptyId : null;
  const readCommand = sessionId ? `ade terminal read --terminal ${sessionId} --text` : null;
  return renderKeyValues("ADE shell session", [
    ["session", sessionId],
    ["pty", ptyId],
    ["pid", result.pid],
    ["read with", readCommand],
  ]);
}

function formatTerminalRead(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const data = typeof result.data === "string" ? result.data : "";
  const header = renderKeyValues("ADE terminal scrollback", [
    ["terminal", result.terminalId],
    ["nextSince", result.nextSince],
    ["bytes", Buffer.byteLength(data, "utf8")],
  ]);
  return data.length ? `${header}\n\n${data}` : `${header}\n\n(no output)`;
}

function formatProjectSecrets(value: unknown): string {
  const record = isRecord(value) ? value : {};
  if (typeof record.value === "string") {
    return record.value;
  }
  if (typeof record.name === "string" && typeof record.deleted === "boolean") {
    return record.deleted
      ? `Deleted ADE secret ${record.name}.`
      : `No ADE secret named ${record.name} was found.`;
  }
  if (typeof record.name === "string") {
    return `Saved ADE secret ${record.name} (${cell(record.valueLength)} chars).`;
  }
  const secrets = Array.isArray(record.secrets)
    ? record.secrets.filter(isRecord)
    : Array.isArray(value)
      ? value.filter(isRecord)
      : [];
  const rows = secrets.map((secret) => [
    secret.name,
    secret.valueLength,
    secret.updatedAt,
  ]);
  const storage = isRecord(record.storage) ? record.storage : {};
  const header = renderTable(
    ["name", "chars", "updated"],
    rows,
    "ADE project secrets\n(no secrets found)",
  );
  const pathLine = typeof storage.path === "string" ? `\n\nStore: ${storage.path}` : "";
  return `${header}${pathLine}`;
}

function formatProjectsList(value: unknown): string {
  const projects = Array.isArray(value)
    ? value.filter(isRecord)
    : isRecord(value) && value.projectId
      ? [value]
      : firstArray(value, ["projects", "items"]);
  return renderTable(
    ["project", "name", "path", "visibility", "git origin", "last opened"],
    projects.map((project) => [
      project.projectId,
      project.displayName,
      project.rootPath,
      project.catalogVisibility === "system" ? "system" : "recent",
      project.gitOriginUrl,
      typeof project.lastOpenedAt === "number" && project.lastOpenedAt > 0
        ? new Date(project.lastOpenedAt).toISOString()
        : "",
    ]),
    "ADE projects\n(no projects registered)",
  );
}

function formatLinearQuickView(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  const connection = isRecord(value.connection) ? value.connection : {};
  const organization = isRecord(value.organization) ? value.organization : null;
  const viewer = isRecord(value.viewer) ? value.viewer : null;
  const projects = firstArray(value, ["projects"]);
  const assignedIssues = firstArray(value, ["assignedIssues"]);
  const recentIssues = firstArray(value, ["recentIssues"]);
  const teams = firstArray(value, ["teams"]);
  const header = renderKeyValues("Linear quick view", [
    ["connected", connection.connected],
    ["auth", connection.authMode],
    ["workspace", organization?.name ?? organization?.urlKey],
    ["viewer", viewer?.displayName ?? viewer?.name ?? connection.viewerName],
    ["projects", projects.length],
    ["teams", teams.length],
    ["assigned issues", assignedIssues.length],
    ["recent issues", recentIssues.length],
    ["checked", value.fetchedAt ?? connection.checkedAt],
    ["message", connection.message],
  ]);
  const projectRows = projects.map((project) => [
    project.name,
    project.statusName ?? project.statusType,
    typeof project.progress === "number"
      ? `${Math.round(project.progress * 100)}%`
      : "",
    project.issueCount,
  ]);
  const issueRows = [...assignedIssues, ...recentIssues]
    .filter(
      (issue, index, all) =>
        all.findIndex((candidate) => candidate.id === issue.id) === index,
    )
    .slice(0, 12)
    .map((issue) => [
      issue.identifier,
      issue.title,
      issue.stateName,
      issue.projectName ?? issue.teamName ?? issue.teamKey,
    ]);
  return [
    header,
    "",
    "Projects",
    renderTable(
      ["project", "status", "progress", "issues"],
      projectRows,
      "(no projects)",
    ),
    "",
    "Issues",
    renderTable(["id", "title", "state", "area"], issueRows, "(no issues)"),
  ].join("\n");
}

function formatAppControlSelection(value: unknown): string {
  const item =
    firstRecord(value, ["item", "selection"]) ?? (isRecord(value) ? value : {});
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const selected = isRecord(metadata.selectedElement)
    ? metadata.selectedElement
    : {};
  return renderKeyValues("ADE App Control selection", [
    ["component", item.componentId],
    [
      "source",
      isRecord(value) ? (value.source ?? item.provider) : item.provider,
    ],
    [
      "file",
      item.sourceFile
        ? `${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}`
        : null,
    ],
    ["selector", selected.selector],
    ["label", selected.label ?? metadata.label],
    ["selected", item.selectedAt],
  ]);
}

function formatAccountMachines(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const state = asString(result.state) ?? "unavailable";
  if (state === "signed_out") {
    return "Not signed in — run `ade login`. Local, PIN, and explicit remote paths still work.";
  }
  if (state === "auth_expired") {
    const message = asString(result.message)
      ?? "ADE account session expired — run `ade login` again.";
    return `${message} Local and explicit remote paths still work.`;
  }
  if (state !== "ok") {
    return asString(result.message) ?? "The ADE account machine directory is unavailable.";
  }
  const machines = Array.isArray(result.machines)
    ? result.machines.flatMap((entry) => {
        const machine = parseAccountMachine(entry);
        return machine ? [machine] : [];
      })
    : [];
  const rows = machines.map((machine) => {
    const connectionState = accountMachineConnectionState(machine);
    const lastSeenAt = typeof machine.lastSeenAt === "number" && Number.isFinite(machine.lastSeenAt)
      ? new Date(machine.lastSeenAt).toLocaleString()
      : "never";
    return [
      asString(machine.machineKey) ?? "—",
      asString(machine.name) ?? asString(machine.deviceId) ?? "Unnamed machine",
      connectionState,
      lastSeenAt,
    ];
  });
  return [
    renderTable(
      ["machine key", "name", "status", "last seen"],
      rows,
      "No machines are registered to this ADE account.",
    ),
    "",
    "Connect with: ade machines connect <machine-key>",
  ].join("\n");
}

function formatTextOutput(
  value: unknown,
  formatter: FormatterId | undefined,
): string {
  if (typeof value === "string") return value;
  if (
    isRecord(value) &&
    typeof value.visual === "string" &&
    (!formatter || formatter === "lanes")
  )
    return value.visual;
  switch (formatter) {
    case "status":
      return renderKeyValues("ADE status", [
        ["ok", isRecord(value) ? value.ok : null],
        ["mode", isRecord(value) ? value.mode : null],
        ["project", isRecord(value) ? value.projectRoot : null],
        ["workspace", isRecord(value) ? value.workspaceRoot : null],
        ["socket", isRecord(value) ? value.socketPath : null],
      ]);
    case "doctor": {
      const project =
        isRecord(value) && isRecord(value.project) ? value.project : {};
      const desktop =
        isRecord(value) && isRecord(value.desktop) ? value.desktop : {};
      const actions =
        isRecord(value) && isRecord(value.actions) ? value.actions : {};
      const git = isRecord(value) && isRecord(value.git) ? value.git : {};
      const github =
        isRecord(value) && isRecord(value.github) ? value.github : {};
      const linear =
        isRecord(value) && isRecord(value.linear) ? value.linear : {};
      const providers =
        isRecord(value) && isRecord(value.providers) ? value.providers : {};
      const computerUse =
        isRecord(value) && isRecord(value.computerUse) ? value.computerUse : {};
      const pathStatus =
        isRecord(value) && isRecord(value.path) ? value.path : {};
      const storage =
        isRecord(value) && isRecord(value.storage) ? value.storage : {};
      const sync =
        isRecord(value) && isRecord(value.sync) ? value.sync : {};
      const recommendations =
        isRecord(value) && Array.isArray(value.recommendations)
          ? value.recommendations
          : [];
      return [
        renderKeyValues("ADE doctor", [
          ["ok", isRecord(value) ? value.ok : null],
          ["cli version", isRecord(value) ? value.cliVersion : null],
          ["mode", isRecord(value) ? value.mode : null],
          ["project", isRecord(value) ? value.projectRoot : null],
          ["workspace", isRecord(value) ? value.workspaceRoot : null],
          ["project initialized", project.projectInitialized],
          ["runtime endpoint", desktop.socketAvailable],
          ["socket path", desktop.socketPath],
          ["rpc actions", actions.rpcActionCount],
          ["service actions", actions.actionCount],
          ["git", git.message],
          ["github", github.message],
          ["linear", linear.message],
          ["providers", providers.message],
          ["computer use", computerUse.message],
          ["path", pathStatus.message],
          ["storage", storage.message],
          ["sync", sync.message],
          ["recommendation", isRecord(value) ? value.recommendation : null],
        ]),
        ...(recommendations.length
          ? [
              "",
              "Next actions",
              ...recommendations.map((entry) => `- ${cell(entry, 120)}`),
            ]
          : []),
      ].join("\n");
    }
    case "auth": {
      const checks =
        isRecord(value) && isRecord(value.checks) ? value.checks : {};
      const git = isRecord(checks.git) ? checks.git : {};
      const github = isRecord(checks.github) ? checks.github : {};
      const linear = isRecord(checks.linear) ? checks.linear : {};
      const providers = isRecord(checks.providers) ? checks.providers : {};
      return renderKeyValues("ADE auth", [
        ["authenticated", isRecord(value) ? value.authenticated : null],
        ["mode", isRecord(value) ? value.authMode : null],
        ["role", isRecord(value) ? value.role : null],
        ["project", isRecord(value) ? value.projectRoot : null],
        ["actions", isRecord(value) ? value.availableActionCount : null],
        ["git", git.message],
        ["github", github.message],
        ["linear", linear.message],
        ["providers", providers.message],
        ["note", isRecord(value) ? value.note : null],
      ]);
    }
    case "account-auth": {
      if (!isRecord(value) || value.signedIn !== true) {
        return "Not signed in — local use does not require an account.";
      }
      const identity = asString(value.email)
        ?? asString(value.name)
        ?? asString(value.userId)
        ?? "ADE account";
      const source = asString(value.source);
      return `Signed in as ${identity}${source ? ` (${source})` : ""}`;
    }
    case "account-token": {
      const token = isRecord(value) ? asString(value.token) : null;
      if (!token) return "No durable ADE account token is available. Run `ade login` and retry.";
      return `${token}\n\nSet this secret as ADE_ACCOUNT_TOKEN in the agent or CI environment. ` +
        "It grants ADE account access; store it in your secret manager and do not commit or log it.";
    }
    case "account-machines":
      return formatAccountMachines(value);
    case "projects-list":
      return formatProjectsList(value);
    case "linear-quick-view":
      return formatLinearQuickView(value);
    case "lanes":
      return renderLaneGraph(value);
    case "lane-detail":
      return formatLaneDetail(value);
    case "git-status":
      return renderKeyValues(
        "ADE git status",
        Object.entries(isRecord(value) ? value : {}),
      );
    case "diff-summary":
      return formatDiffSummary(value);
    case "file-read":
      return formatFileRead(value);
    case "files-tree":
      return formatFileTree(value);
    case "files-search":
      return formatFilesSearch(value);
    case "prs-list":
      return formatPrList(value);
    case "pr-create":
      return formatPrCreate(value);
    case "pr-detail":
      return renderKeyValues(
        "ADE pull request",
        Object.entries(
          firstRecord(value, ["pr", "detail"]) ??
            (isRecord(value) ? value : {}),
        ).slice(0, 16),
      );
    case "pr-checks":
      return formatPrChecks(value);
    case "pr-comments":
      return formatPrComments(value);
    case "run-defs":
      return formatRunTable(value, "ADE run definitions");
    case "run-runtime":
      return formatRunTable(value, "ADE process runtime");
    case "chat-list":
      return formatChatList(value);
    case "chat-read":
      return formatChatRead(value);
    case "tests-runs":
      return formatTestsRuns(value);
    case "proof-list":
      return formatProofList(value);
    case "ios-sim-status":
      return formatIosSimStatus(value);
    case "ios-sim-devices":
      return formatIosSimDevices(value);
    case "ios-sim-apps":
      return formatIosSimApps(value);
    case "ios-sim-stream":
      return formatIosSimStream(value);
    case "ios-sim-snapshot":
      return formatIosSimSnapshot(value);
    case "ios-sim-selection":
      return formatIosSimSelection(value);
    case "ios-sim-preview":
      return formatIosSimPreview(value);
    case "app-control-status":
      return formatAppControlStatus(value);
    case "app-control-snapshot":
      return formatAppControlSnapshot(value);
    case "app-control-selection":
      return formatAppControlSelection(value);
    case "browser-status":
      return formatBrowserStatus(value);
    case "browser-sessions":
      return formatBrowserSessions(value);
    case "browser-observation":
      return formatBrowserObservation(value);
    case "browser-trace":
      return formatBrowserTrace(value);
    case "pty-create":
      return formatPtyCreate(value);
    case "terminal-list":
      return formatTerminalList(value);
    case "terminal-read":
      return formatTerminalRead(value);
    case "project-secrets":
      return formatProjectSecrets(value);
    case "history-list":
      return formatHistoryList(value);
    case "history-commits":
      return formatHistoryCommits(value);
    case "history-show":
      return formatHistoryShow(value);
    case "actions-list":
      return formatActionsList(value);
    case "automation-run-detail":
      return formatAutomationRunDetail(value);
    case "automation-ingress":
      return formatAutomationIngress(value);
    case "automation-linear-ingress":
      return formatAutomationLinearIngress(value);
    case "automation-cleanups":
      return formatAutomationCleanups(value);
    case "search-results":
      return formatSearchResults(value);
    case "search-status":
      return formatSearchStatus(value);
    case "external-sessions":
      return formatExternalSessions(value);
    case "sync-status":
      return formatSyncStatus(value);
    case "sync-web":
      return formatSyncWebPairing(value);
    case "storage-snapshot":
      return formatStorageSnapshot(value);
    case "storage-compress":
      return formatStorageCompression(value);
    case "action-result":
    default:
      if (isRecord(value))
        return renderKeyValues(
          "ADE result",
          Object.entries(value).slice(0, 24),
        );
      return JSON.stringify(value, null, 2);
  }
}

function inferFormatter(
  plan: CliPlan & { kind: "execute" },
): FormatterId | undefined {
  if (plan.formatter) return plan.formatter;
  if (plan.summary) return plan.summary;
  if (plan.visualizer === "lanes") return "lanes";
  const label = plan.label.toLowerCase();
  if (
    label === "projects list" ||
    label === "projects add" ||
    label === "projects touch"
  )
    return "projects-list";
  if (label === "lane status") return "lane-detail";
  if (label === "git status") return "git-status";
  if (label === "diff changes") return "diff-summary";
  if (label === "file read") return "file-read";
  if (label === "file tree" || label === "file workspaces") return "files-tree";
  if (label === "file search" || label === "file quick-open")
    return "files-search";
  if (label === "pr list" || label === "pr list open") return "prs-list";
  if (label === "pr create") return "pr-create";
  if (label === "pr detail" || label === "pr health") return "pr-detail";
  if (label === "pr checks") return "pr-checks";
  if (label === "pr comments") return "pr-comments";
  if (label === "process definitions") return "run-defs";
  if (label === "process runtime") return "run-runtime";
  if (label === "chat list") return "chat-list";
  if (label === "test runs") return "tests-runs";
  if (label === "proof list") return "proof-list";
  if (label === "ios simulator status") return "ios-sim-status";
  if (label === "ios simulator devices") return "ios-sim-devices";
  if (label === "ios simulator launchable apps") return "ios-sim-apps";
  if (
    label === "ios simulator live view start" ||
    label === "ios simulator live view status" ||
    label === "ios simulator live view stop"
  )
    return "ios-sim-stream";
  if (
    label === "ios simulator screen snapshot" ||
    label === "ios simulator inspector snapshot" ||
    label === "ios simulator screenshot"
  )
    return "ios-sim-snapshot";
  if (
    label === "ios simulator select" ||
    label === "ios simulator inspect point"
  )
    return "ios-sim-selection";
  if (
    label === "ios simulator preview status" ||
    label === "ios simulator previews" ||
    label === "ios simulator preview match" ||
    label === "ios simulator preview workspace" ||
    label === "ios simulator current preview render" ||
    label === "ios simulator preview render" ||
    label === "ios simulator preview open"
  )
    return "ios-sim-preview";
  if (
    label === "app control status" ||
    label === "app control launch" ||
    label === "app control connect" ||
    label === "app control stop"
  )
    return "app-control-status";
  if (label === "app control snapshot" || label === "app control screenshot")
    return "app-control-snapshot";
  if (label === "app control select" || label === "app control inspect point")
    return "app-control-selection";
  if (
    label === "browser status" ||
    label === "browser claim" ||
    label === "browser panel" ||
    label === "browser open" ||
    label === "browser new tab" ||
    label === "browser switch" ||
    label === "browser close"
  )
    return "browser-status";
  if (
    label === "browser session start" ||
    label === "browser session end" ||
    label === "browser sessions"
  )
    return "browser-sessions";
  if (
    label === "browser observe" ||
    label === "browser click" ||
    label === "browser type" ||
    label === "browser key" ||
    label === "browser scroll" ||
    label === "browser fill" ||
    label === "browser clear" ||
    label === "browser wait"
  )
    return "browser-observation";
  if (label === "browser trace") return "browser-trace";
  if (label === "shell start") return "pty-create";
  if (label === "terminal list" || label === "terminal active")
    return "terminal-list";
  if (label === "terminal read") return "terminal-read";
  if (label === "history list") return "history-list";
  if (label === "history commits") return "history-commits";
  if (label === "history show") return "history-show";
  if (label === "actions list") return "actions-list";
  if (label.endsWith("actions")) return "actions-list";
  const firstStep = plan.steps[0];
  const params = typeof firstStep?.params === "object" && firstStep.params != null
    ? firstStep.params as Record<string, unknown>
    : null;
  const actionArgs = isRecord(params?.arguments) ? params.arguments as Record<string, unknown> : null;
  if (
    firstStep?.method === "ade/actions/call"
    && params?.name === "run_ade_action"
    && actionArgs?.domain === "external-sessions"
  ) {
    return "external-sessions";
  }
  return "action-result";
}

function summarizeExecution(args: {
  plan: CliPlan & { kind: "execute" };
  connection: CliConnection;
  values: JsonObject;
}): unknown {
  const { plan, connection, values } = args;
  if (plan.summary === "status") {
    return {
      ok: true,
      mode: connection.mode,
      projectRoot: connection.projectRoot,
      workspaceRoot: connection.workspaceRoot,
      socketPath: connection.socketPath,
      ping: values.ping,
    };
  }
  if (plan.summary === "doctor") {
    return buildReadinessSnapshot({ connection, values, summary: "doctor" });
  }
  if (plan.summary === "auth") {
    const readiness = buildReadinessSnapshot({
      connection,
      values,
      summary: "auth",
    });
    const actions = isRecord(readiness.actions) ? readiness.actions : {};
    return {
      ok: readiness.ok,
      authenticated: isRecord(readiness.auth)
        ? readiness.auth.localProjectAccess
        : false,
      authMode:
        connection.mode === "desktop-socket"
          ? "local-desktop-socket"
          : "local-headless-project",
      role: resolveAdeDefaultRole(process.env.ADE_DEFAULT_ROLE, "agent"),
      projectRoot: connection.projectRoot,
      workspaceRoot: connection.workspaceRoot,
      socketPath: connection.socketPath,
      availableActionCount: actions.actionCount,
      checks: {
        git: readiness.git,
        github: readiness.github,
        linear: readiness.linear,
        providers: readiness.providers,
        computerUse: readiness.computerUse,
        path: readiness.path,
      },
      recommendations: readiness.recommendations,
      note: isRecord(readiness.auth)
        ? readiness.auth.note
        : "ADE CLI auth is local project access.",
    };
  }

  if (plan.label === "PR create") {
    return summarizePrCreateResult(values.result ?? values);
  }

  if (
    plan.label === "new chat" &&
    (values.session !== undefined || values.result !== undefined)
  ) {
    const session = values.session ?? values.result;
    return {
      ok: true,
      ...(values.lane !== undefined ? { lane: unwrapActionEnvelope(values.lane) } : {}),
      session: unwrapActionEnvelope(session),
      ...(values.session !== undefined && values.result !== undefined
        ? { kickoff: unwrapActionEnvelope(values.result) }
        : {}),
    };
  }

  if (
    (plan.label === "chat create" ||
      plan.label === "chat create from Linear issue") &&
    values.session !== undefined
  ) {
    return {
      ok: true,
      session: unwrapActionEnvelope(values.session),
      ...(values.attach !== undefined ? { attach: unwrapActionEnvelope(values.attach) } : {}),
      ...(values.result !== undefined ? { kickoff: unwrapActionEnvelope(values.result) } : {}),
    };
  }

  if (plan.label === "chat send" || plan.label === "chat steer" || plan.label === "chat message") {
    const raw = unwrapActionEnvelope(values.result);
    if (isRecord(raw)) return raw;
    return {
      ok: true,
      accepted: true,
      note: plan.label === "chat steer"
        ? "Message accepted by the ADE chat steer path."
        : "Message accepted by the ADE chat message path; provider dispatch continues asynchronously.",
    };
  }

  if (
    plan.label === "history list" ||
    plan.label === "history export" ||
    plan.label === "history show"
  ) {
    const raw = unwrapActionEnvelope(values.result);
    if (plan.label === "history show") {
      const match = isRecord(raw) ? raw : null;
      if (!match) {
        const operationId = plan.historyOperationId;
        throw new CliExecutionError(
          operationId
            ? `Operation '${operationId}' was not found.`
            : "Operation id is required.",
          { operationId: operationId ?? null },
        );
      }
      return match;
    }
    const rows = filterHistoryOperations(
      asOperationRows(raw),
      plan.historyStatusFilter,
    );
    if (plan.label === "history export") {
      return {
        exportedAt: new Date().toISOString(),
        filters: plan.historyListFilters ?? {
          laneId: null,
          kind: null,
          status: plan.historyStatusFilter ?? "all",
        },
        rowCount: rows.length,
        rows,
      };
    }
    return rows;
  }

  if (plan.label === "sync web") {
    return buildSyncWebPairingOutput(values.result);
  }

  if (plan.label.startsWith("personal chat ") && isRecord(values.result)) {
    return values.result.result;
  }

  const result = values.result ?? values;
  if (
    isRecord(result) &&
    Object.prototype.hasOwnProperty.call(result, "result") &&
    asString(result.domain) &&
    asString(result.action) &&
    !plan.label.toLowerCase().startsWith("action ") &&
    !plan.label.toLowerCase().endsWith(" action")
  ) {
    return result.result;
  }
  if (plan.visualizer === "lanes" && isRecord(result)) {
    return {
      ...result,
      visual: renderLaneGraph(result),
    };
  }
  return result;
}

function graphWaitState(value: unknown): {
  status: string;
  activeCount: number;
} {
  const graph = graphFromResult(value) ?? {};
  const run = firstRecord(graph, ["run"]) ?? {};
  const status = (asString(run.status) ?? "").trim().toLowerCase();
  const steps = firstArray(graph, ["steps"]);
  const attempts = firstArray(graph, ["attempts"]);
  const activeStepCount = steps.filter(
    (step) => asString(step.status)?.trim().toLowerCase() === "running",
  ).length;
  const activeAttemptCount = attempts.filter(
    (attempt) => asString(attempt.status)?.trim().toLowerCase() === "running",
  ).length;
  return {
    status,
    activeCount: Math.max(activeStepCount, activeAttemptCount),
  };
}

export type AccountLoginMode = "loopback" | "device" | "env-token";

export function detectAccountLoginMode(args: {
  explicitHeadless?: boolean;
  browserOpenFailed?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
} = {}): AccountLoginMode {
  const env = args.env ?? process.env;
  if (args.explicitHeadless) return "device";
  const envCredential = env.ADE_ACCOUNT_TOKEN?.trim();
  if (
    envCredential
    && !shouldRejectDevelopmentEnvCredential(env, envCredential)
  ) {
    return "env-token";
  }
  if (args.browserOpenFailed) return "device";
  if (env.SSH_TTY?.trim() || env.SSH_CONNECTION?.trim() || env.SSH_CLIENT?.trim()) {
    return "device";
  }
  const platform = args.platform ?? process.platform;
  const displayBasedPlatform = ["linux", "freebsd", "openbsd", "sunos", "aix"].includes(platform);
  if (displayBasedPlatform && !env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim()) {
    return "device";
  }
  return "loopback";
}

/**
 * Interactive machine-account authorization. The daemon owns either the
 * loopback listener or the device-code secret, token exchange, and credential
 * persistence; the CLI only presents the browser instructions and polls over
 * one live CTO connection.
 */
async function runAccountLogin(
  plan: CliPlan & { kind: "account-login" },
  options: GlobalOptions,
): Promise<{ output: string; exitCode: number }> {
  let connection: CliConnection;
  try {
    // `ade login` drives the CTO-only account actions (startLogin/pollLogin),
    // so it connects as the machine operator at cto role. This also ensures the
    // machine brain it attaches to runs at defaultRole cto (the runtime-role
    // mismatch check respawns an under-privileged brain), so the account gate
    // resolves the caller to cto.
    connection = await createConnection(
      { ...options, headless: false, role: "cto" },
      { autoRegisterProject: false, machineRuntimeOnly: true },
    );
  } catch (error) {
    throw new CliExecutionError(
      "Failed to initialize the ADE brain for account login.",
      {
        cause: error instanceof Error ? error.message : String(error),
        nextAction: "Start the machine ADE brain with `ade brain start`, then retry `ade login`.",
      },
    );
  }

  const runAccountAction = async (
    action: string,
    actionArgs: JsonObject = {},
  ): Promise<JsonObject> => {
    const raw = await connection.request("account.call", { action, args: actionArgs });
    const result = unwrapActionEnvelope(raw);
    if (!isRecord(result)) {
      throw new CliExecutionError(`account.${action} returned an unexpected result.`, { action });
    }
    return result;
  };

  // Register the invoking project's root so the daemon can read this project's
  // CLERK_* secrets when it starts the login. `ade login` connects with
  // autoRegisterProject:false, so the config root is otherwise never registered
  // and startLogin reports "unconfigured" even when the project has the secrets.
  const { projectRoot } = resolveRoots(options);

  // Track either pending flow so every non-success exit drops daemon-held
  // verifier/secret state. Cleared on success so a completed login is not cancelled.
  let pendingSessionId: string | null = null;

  try {
    const explicitHeadless = plan.explicitHeadless || options.headless;
    const mode = detectAccountLoginMode({
      explicitHeadless,
    });
    if (!explicitHeadless) {
      let status = await runAccountAction("status");
      const source = asString(status.source);
      if (status.signedIn === true && source === "env-token") {
        process.stderr.write("Using ADE_ACCOUNT_TOKEN; no interactive sign-in is required.\n");
        return { output: formatOutput(status, options, "account-auth"), exitCode: 0 };
      }
      if (source === "env-token") {
        try {
          const raw = await connection.request("account.call", { action: "getToken", args: {} });
          const token = unwrapActionEnvelope(raw);
          if (typeof token !== "string" || !token.trim()) throw new Error("empty account token");
          status = await runAccountAction("status");
          if (status.signedIn === true && asString(status.source) === "env-token") {
            process.stderr.write("Using ADE_ACCOUNT_TOKEN; no interactive sign-in is required.\n");
            return { output: formatOutput(status, options, "account-auth"), exitCode: 0 };
          }
        } catch {
          // Report only fixed guidance. Credential values and upstream token errors
          // must not cross the CLI boundary.
        }
        throw new CliExecutionError(
          "ADE_ACCOUNT_TOKEN is expired or invalid.",
          { nextAction: "Replace it with a current access token or durable refresh token, then restart the ADE brain." },
        );
      }
    }
    if (mode === "env-token") {
      throw new CliExecutionError(
        "ADE_ACCOUNT_TOKEN is set in this shell, but the running ADE brain did not inherit it.",
        { nextAction: "Restart the ADE brain from this environment, then retry `ade login`." },
      );
    }

    const finishSignedIn = (authStatus: JsonObject): { output: string; exitCode: number } => {
      const identity = asString(authStatus.email)
        ?? asString(authStatus.name)
        ?? asString(authStatus.userId)
        ?? "ADE account";
      process.stderr.write(`Signed in as ${identity}\n`);
      pendingSessionId = null;
      return { output: formatOutput(authStatus, options, "account-auth"), exitCode: 0 };
    };

    const deadlineFor = (expiresAt: string | null): number => {
      const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
      const maxWaitDeadlineMs = plan.maxWaitSec != null
        ? Date.now() + plan.maxWaitSec * 1000
        : Number.NaN;
      return Math.min(
        Number.isFinite(expiresAtMs) ? expiresAtMs : Number.POSITIVE_INFINITY,
        Number.isFinite(maxWaitDeadlineMs) ? maxWaitDeadlineMs : Number.POSITIVE_INFINITY,
      );
    };

    const timedOut = async (
      pollAction: "pollLogin" | "pollDeviceLogin",
      sessionId: string,
    ): Promise<{ output: string; exitCode: number }> => {
      const finalPoll = await runAccountAction(pollAction, { sessionId });
      const finalPollStatus = asString(finalPoll.status);
      const authStatus = isRecord(finalPoll.authStatus) ? finalPoll.authStatus : finalPoll;
      if (finalPollStatus === "signed_in") return finishSignedIn(authStatus);
      process.stderr.write("ADE account sign-in timed out.\n");
      return {
        output: formatOutput({ signedIn: false }, options, "account-auth"),
        exitCode: 1,
      };
    };

    const runDeviceFlow = async (
      onStarted?: () => Promise<void>,
    ): Promise<{ output: string; exitCode: number }> => {
      const start = await runAccountAction("startDeviceLogin", {
        projectRoot,
        ignoreEnvCredential: plan.explicitHeadless || options.headless,
      });
      const sessionId = asString(start.sessionId);
      const userCode = asString(start.userCode);
      const verificationUri = asString(start.verificationUri);
      const verificationUriComplete = asString(start.verificationUriComplete);
      const expiresAt = asString(start.expiresAt);
      if (!sessionId || !userCode || !verificationUri) {
        throw new CliExecutionError("ADE account device login did not start.", { start });
      }
      await onStarted?.();
      pendingSessionId = sessionId;
      let intervalSec = typeof start.intervalSec === "number" && start.intervalSec > 0
        ? start.intervalSec
        : 5;
      const deadlineMs = deadlineFor(expiresAt);
      process.stderr.write(
        `\nTo finish signing in, open ${verificationUri} and enter code: ${userCode}\n` +
        (verificationUriComplete ? `Or open: ${verificationUriComplete}\n` : "") +
        "\nWaiting for sign-in…\n",
      );
      while (true) {
        const sleepMs = Math.max(1, intervalSec) * 1000;
        await sleep(Number.isFinite(deadlineMs)
          ? Math.min(sleepMs, Math.max(1, deadlineMs - Date.now()))
          : sleepMs);
        const poll = await runAccountAction("pollDeviceLogin", { sessionId });
        const pollStatus = asString(poll.status);
        const authStatus = isRecord(poll.authStatus) ? poll.authStatus : poll;
        if (pollStatus === "signed_in") return finishSignedIn(authStatus);
        if (pollStatus === "pending" || pollStatus === "slow_down") {
          if (typeof poll.intervalSec === "number" && poll.intervalSec > 0) {
            intervalSec = poll.intervalSec;
          }
          if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
            return timedOut("pollDeviceLogin", sessionId);
          }
          continue;
        }
        const message = asString(poll.message) ?? "ADE account device sign-in failed.";
        process.stderr.write(`${message}\n`);
        return { output: formatOutput(authStatus, options, "account-auth"), exitCode: 1 };
      }
    };

    if (mode === "device") return await runDeviceFlow();

    const start = await runAccountAction("startLogin", { projectRoot });
    const sessionId = asString(start.sessionId);
    const authorizeUrl = asString(start.authorizeUrl);
    const expiresAt = asString(start.expiresAt);
    if (!sessionId || !authorizeUrl) {
      throw new CliExecutionError("ADE account login did not start.", { start });
    }
    pendingSessionId = sessionId;
    const openResult = openUrlViaOs(authorizeUrl);
    if (detectAccountLoginMode({ browserOpenFailed: openResult.failed }) === "device") {
      process.stderr.write(
        `Could not open the browser automatically: ${openResult.message}\nTrying device sign-in.\n`,
      );
      let deviceFlowStarted = false;
      try {
        return await runDeviceFlow(async () => {
          deviceFlowStarted = true;
          try {
            await runAccountAction("cancelLogin", { sessionId });
          } catch {
            // The loopback session expires on its own; a ready device flow can continue.
          }
        });
      } catch (error) {
        if (deviceFlowStarted) throw error;
        process.stderr.write(
          "Device sign-in is unavailable; continuing with manual browser sign-in.\n",
        );
      }
    }
    process.stderr.write(
      `\nSign in to ADE in your browser. If it did not open, visit:\n  ${authorizeUrl}\n\nWaiting for sign-in…\n`,
    );
    const deadlineMs = deadlineFor(expiresAt);
    while (true) {
      await sleep(Number.isFinite(deadlineMs)
        ? Math.min(500, Math.max(1, deadlineMs - Date.now()))
        : 500);
      const poll = await runAccountAction("pollLogin", { sessionId });
      const pollStatus = asString(poll.status);
      const authStatus = isRecord(poll.authStatus) ? poll.authStatus : poll;
      if (pollStatus === "signed_in") return finishSignedIn(authStatus);
      if (pollStatus === "pending") {
        if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
          return timedOut("pollLogin", sessionId);
        }
        continue;
      }
      const message = asString(poll.message) ?? "ADE account sign-in failed.";
      process.stderr.write(`${message}\n`);
      return { output: formatOutput(authStatus, options, "account-auth"), exitCode: 1 };
    }
  } finally {
    // Best-effort and idempotent: cancellation must not mask the real result.
    if (pendingSessionId) {
      try {
        await runAccountAction("cancelLogin", { sessionId: pendingSessionId });
      } catch {
        // The pending session may already be gone; the exit result is what matters.
      }
    }
    await connection.close();
  }
}

/**
 * Interactive GitHub App (device-flow) authorization for headless / brain
 * setups that have no Settings panel. Device-auth session state lives in the
 * runtime process memory, so start-then-poll must happen over a single live
 * connection — a two-process `start` + `poll` split cannot share the session in
 * headless mode. start/poll are CTO-only, so run this with `--role cto`.
 * Progress is written to stderr; only the final auth status (never the token)
 * is emitted on stdout.
 */
async function runGithubAppLogin(
  plan: CliPlan & { kind: "github-app-login" },
  options: GlobalOptions,
): Promise<{ output: string; exitCode: number }> {
  let connection: CliConnection;
  try {
    connection = await createConnection(options);
  } catch (error) {
    throw new CliExecutionError(
      "Failed to initialize ADE CLI connection for github app-auth login.",
      {
        cause: error instanceof Error ? error.message : String(error),
        nextAction:
          "Verify --project-root points at an ADE project and run ade doctor --json.",
      },
    );
  }
  const runGithubAction = async (
    action: string,
    actionArgs: JsonObject = {},
  ): Promise<JsonObject> => {
    let result: unknown;
    try {
      const raw = await connection.request("ade/actions/call", {
        name: "run_ade_action",
        arguments: { domain: "github", action, args: actionArgs },
      });
      // `ade/actions/call` returns an `{ ok: false, error }` envelope on the
      // CTO gate rather than throwing; unwrapToolResult converts that to a throw.
      result = unwrapActionEnvelope(unwrapToolResult(raw));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/elevated role/i.test(message)) {
        throw new CliUsageError(
          "github app-auth login authorizes the machine GitHub App and requires --role cto (e.g. `ade --role cto github app-auth login`).",
        );
      }
      throw error;
    }
    if (!isRecord(result)) {
      throw new CliExecutionError(
        `github.${action} returned an unexpected result.`,
        { action },
      );
    }
    return result;
  };
  try {
    const start = await runGithubAction("startAppUserDeviceAuth");
    const sessionId = asString(start.sessionId);
    const userCode = asString(start.userCode);
    const verificationUri = asString(start.verificationUri);
    const verificationUriComplete = asString(start.verificationUriComplete);
    const expiresAt = asString(start.expiresAt);
    if (!sessionId || !userCode || !verificationUri) {
      throw new CliExecutionError(
        "GitHub device authorization did not start.",
        { start },
      );
    }
    let intervalSec =
      typeof start.intervalSec === "number" && start.intervalSec > 0
        ? start.intervalSec
        : 5;
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    const maxWaitDeadlineMs =
      plan.maxWaitSec != null ? Date.now() + plan.maxWaitSec * 1000 : Number.NaN;
    const deadlineMs = Math.min(
      Number.isFinite(expiresAtMs) ? expiresAtMs : Number.POSITIVE_INFINITY,
      Number.isFinite(maxWaitDeadlineMs)
        ? maxWaitDeadlineMs
        : Number.POSITIVE_INFINITY,
    );
    process.stderr.write(
      `\nAuthorize the ADE GitHub App:\n` +
        `  1. Open ${verificationUri}\n` +
        `  2. Enter code: ${userCode}\n` +
        (verificationUriComplete
          ? `  (or open ${verificationUriComplete} to skip step 2)\n`
          : "") +
        `\nWaiting for authorization…\n`,
    );

    while (true) {
      if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
        process.stderr.write("GitHub device authorization timed out.\n");
        const status = await runGithubAction("getAppUserAuthStatus");
        return {
          output: formatOutput(
            { ...status, status: "expired", error: "timed_out" },
            options,
          ),
          exitCode: 1,
        };
      }
      const sleepMs = Math.max(1, intervalSec) * 1000;
      await sleep(
        Number.isFinite(deadlineMs)
          ? Math.min(sleepMs, Math.max(1, deadlineMs - Date.now()))
          : sleepMs,
      );
      const poll = await runGithubAction("pollAppUserDeviceAuth", { sessionId });
      const status = asString(poll.status);
      const authStatus = isRecord(poll.authStatus) ? poll.authStatus : poll;
      if (status === "authorized") {
        process.stderr.write("GitHub App authorized.\n");
        return { output: formatOutput(authStatus, options), exitCode: 0 };
      }
      if (status === "pending" || status === "slow_down") {
        if (typeof poll.intervalSec === "number" && poll.intervalSec > 0) {
          intervalSec = poll.intervalSec;
        }
        continue;
      }
      // expired | denied | error
      const message =
        asString(poll.message) ??
        `GitHub device authorization ${status ?? "failed"}.`;
      process.stderr.write(`${message}\n`);
      return { output: formatOutput(authStatus, options), exitCode: 1 };
    }
  } finally {
    await connection.close();
  }
}

function createLinkEnvelopeResolver(
  options: GlobalOptions,
): (context: LinkEnvelopeContext) => Promise<DeeplinkEnvelope | null> {
  const action = async (
    connection: CliConnection,
    domain: string,
    name: string,
    args: JsonObject = {},
  ): Promise<unknown> => {
    const raw = await connection.request("ade/actions/call", {
      name: "run_ade_action",
      arguments: { domain, action: name, args },
    });
    return unwrapActionEnvelope(unwrapToolResult(raw));
  };

  const directAction = async (
    connection: CliConnection,
    name: string,
    args: JsonObject = {},
  ): Promise<unknown> => {
    const raw = await connection.request("ade/actions/call", { name, arguments: args });
    return unwrapToolResult(raw);
  };

  const records = (value: unknown, keys: string[]): Record<string, unknown>[] => {
    const unwrapped = unwrapActionEnvelope(value);
    if (Array.isArray(unwrapped)) return unwrapped.filter(isRecord);
    if (!isRecord(unwrapped)) return [];
    for (const key of keys) {
      const nested = unwrapped[key];
      if (Array.isArray(nested)) return nested.filter(isRecord);
    }
    return [];
  };

  return async (context) => {
    let connection: CliConnection | null = null;
    try {
      connection = await createConnection(
        { ...options, headless: false, requireSocket: true },
        { autoRegisterProject: false },
      );
      const lanesValue = await directAction(connection, "list_lanes", { includeArchived: false }).catch(() => null);
      const lane = records(lanesValue, ["lanes", "items", "result"])
        .find((candidate) => asString(candidate.id) === context.laneId) ?? null;
      const githubValue = await action(connection, "github", "getRemoteStatus").catch(() => null);
      const repo = isRecord(githubValue) && isRecord(githubValue.repo) ? githubValue.repo : null;
      const prsValue = await action(connection, "pr", "listAll", { laneId: context.laneId }).catch(() => null);
      const pr = records(prsValue, ["prs", "items", "result"])
        .find((candidate) => asString(candidate.laneId) === context.laneId) ?? null;

      const branch = asString(lane?.branchRef)?.replace(/^refs\/heads\//, "") ?? null;
      const laneIssue = isRecord(lane?.linearIssue) ? lane.linearIssue : null;
      const linearIssue = asString(laneIssue?.identifier);
      const prNumber = typeof pr?.githubPrNumber === "number" && Number.isSafeInteger(pr.githubPrNumber)
        ? pr.githubPrNumber
        : null;
      const envelope: DeeplinkEnvelope = {};
      const owner = asString(repo?.owner);
      const name = asString(repo?.name);
      if (owner) envelope.repoOwner = owner;
      if (name) envelope.repoName = name;
      if (branch) envelope.branch = branch;
      if (prNumber && prNumber > 0) envelope.prNumber = prNumber;
      if (linearIssue) envelope.linearIssue = linearIssue;
      return Object.keys(envelope).length > 0 ? envelope : null;
    } catch {
      return null;
    } finally {
      if (connection) await Promise.resolve(connection.close()).catch(() => undefined);
    }
  };
}

async function executePlan(
  plan: CliPlan & { kind: "execute" },
  options: GlobalOptions,
): Promise<unknown> {
  let connection: CliConnection;
  const baseConnectionOptions =
    plan.machineOnly
      ? {
          ...options,
          headless: false,
          requireSocket: plan.machineAutoStart ? false : true,
        }
      : plan.preferHeadless && !options.requireSocket
        ? { ...options, headless: true }
        : options;
  // A plan may force a specific runtime role for its connection (e.g. `ade
  // logout`, whose signOut account action is CTO-only). Honor it so the caller
  // asserts the operator role and the machine account gate resolves to cto.
  const connectionOptions =
    plan.connectRole
      ? { ...baseConnectionOptions, role: plan.connectRole }
      : baseConnectionOptions;
  try {
    connection = await createConnection(connectionOptions, {
      autoRegisterProject: shouldAutoRegisterProjectForPlan(plan),
      machineRuntimeOnly: plan.machineAutoStart === true,
    });
  } catch (error) {
    const roots = resolveRoots(options);
    let socketPath = path.join(roots.projectRoot, ".ade", "ade.sock");
    try {
      const { resolveAdeLayout } =
        await import("../../desktop/src/shared/adeLayout");
      socketPath = resolveAdeLayout(roots.projectRoot).socketPath;
    } catch {
      // Keep the conventional Unix fallback if shared layout loading fails.
    }
    const requestedMode = connectionOptions.requireSocket
      ? "socket"
      : connectionOptions.headless
        ? "headless"
        : "auto";
    const cause = error instanceof Error ? error.message : String(error);
    const sourceRuntimeInterop = isSourceRuntimeInteropError(cause);
    throw new CliExecutionError(
      `Failed to initialize ADE CLI connection for ${plan.label}.`,
      {
        cause,
        requestedMode,
        projectRoot: roots.projectRoot,
        workspaceRoot: roots.workspaceRoot,
        socketPath,
        nextAction: plan.machineOnly
          ? "Start the machine-owned ADE brain with `ade brain start`, then retry the personal chat command."
          : options.requireSocket
            ? "Start the ADE runtime for this project or remove --socket to allow headless mode."
          : sourceRuntimeInterop
            ? "Run `npm --prefix apps/ade-cli run build` and retry, or use `npm --prefix apps/ade-cli run cli:dev -- ...`."
            : "Verify --project-root points at an ADE project and run ade doctor --json.",
      },
    );
  }
  try {
    const values: JsonObject = {};
    for (const step of plan.steps) {
      try {
        const resolvedParams =
          typeof step.params === "function" ? step.params(values) : step.params;
        const params = step.injectProjectRootIntoArgs
          ? {
              ...(resolvedParams ?? {}),
              args: {
                ...(isRecord(resolvedParams?.args) ? resolvedParams.args : {}),
                projectRoot: connection.projectRoot,
              },
            }
          : resolvedParams;
        const raw = await connection.request(step.method, params);
        values[step.key] = step.unwrapToolResult ? unwrapToolResult(raw) : raw;
      } catch (error) {
        if (!step.optional) throw error;
        values[step.key] = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return summarizeExecution({ plan, connection, values });
  } catch (error) {
    if (
      error instanceof CliToolError ||
      error instanceof CliUsageError ||
      error instanceof CliExecutionError
    )
      throw error;
    throw new CliExecutionError(`Failed while running ${plan.label}.`, {
      cause: error instanceof Error ? error.message : String(error),
      mode: connection.mode,
      projectRoot: connection.projectRoot,
      workspaceRoot: connection.workspaceRoot,
      socketPath: connection.socketPath,
      nextAction:
        connection.mode === "desktop-socket"
          ? "Check ADE desktop logs or retry with --headless if the workflow does not need UI-owned state."
          : "Run ade doctor --json to inspect local project readiness, or start ADE desktop and retry with --socket.",
    });
  } finally {
    await connection.close();
  }
}

async function runChatWaitCommand(
  plan: CliPlan & { kind: "chat-wait" },
  options: GlobalOptions,
): Promise<{ output: string; exitCode: number }> {
  let connection: CliConnection;
  try {
    connection = await createConnection(options, { autoRegisterProject: true });
  } catch (error) {
    throw new CliExecutionError(
      "Failed to initialize ADE CLI connection for chat wait.",
      {
        cause: error instanceof Error ? error.message : String(error),
        nextAction:
          "Verify --project-root points at an ADE project and run ade doctor --json.",
      },
    );
  }

  const startedAt = Date.now();
  const readSummary = async (): Promise<JsonObject | null> => {
    const raw = await connection.request("ade/actions/call", {
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "getSessionSummary",
        argsList: [plan.sessionId],
      },
    });
    const unwrapped = unwrapActionEnvelope(unwrapToolResult(raw));
    if (unwrapped == null) return null;
    if (!isRecord(unwrapped)) {
      throw new CliExecutionError("chat.getSessionSummary returned an unexpected result.", {
        sessionId: plan.sessionId,
        result: unwrapped,
      });
    }
    return unwrapped;
  };

  try {
    while (true) {
      const summary = await readSummary();
      const elapsedMs = Date.now() - startedAt;
      if (!summary) {
        const result = {
          ok: false,
          error: "session_not_found",
          sessionId: plan.sessionId,
          waitFor: plan.waitFor,
          elapsedMs,
        };
        return { output: formatOutput(result, options), exitCode: 1 };
      }
      if (chatWaitTargetMatches(summary, plan.waitFor)) {
        const result = {
          ok: true,
          sessionId: plan.sessionId,
          waitFor: plan.waitFor,
          elapsedMs,
          summary,
        };
        return { output: formatOutput(result, options), exitCode: 0 };
      }
      if (elapsedMs >= plan.timeoutMs) {
        const result = {
          ok: false,
          error: "timed_out",
          sessionId: plan.sessionId,
          waitFor: plan.waitFor,
          timeoutMs: plan.timeoutMs,
          elapsedMs,
          summary,
        };
        return { output: formatOutput(result, options), exitCode: 1 };
      }
      await sleep(Math.min(plan.pollIntervalMs, Math.max(1, plan.timeoutMs - elapsedMs)));
    }
  } finally {
    await connection.close();
  }
}

function formatOutput(
  value: unknown,
  options: GlobalOptions,
  formatter?: FormatterId,
): string {
  if (options.text) {
    return `${formatTextOutput(value, formatter)}\n`;
  }
  return `${JSON.stringify(value, null, options.pretty ? 2 : 0)}\n`;
}

function appendOutputSuffix(output: string, suffix: string): string {
  if (!suffix) return output;
  if (output.endsWith("\n")) return `${output.slice(0, -1)}${suffix}\n`;
  return `${output}${suffix}\n`;
}

function applySyncWebPairingFlags(
  plan: CliPlan & { kind: "execute" },
  options: GlobalOptions,
  result: unknown,
  deps: {
    copy?: (text: string) => boolean;
    open?: (url: string) => { failed: boolean; message: string };
  } = {},
): { outputSuffix: string; exitCode: number | null } {
  if (plan.label !== "sync web" || !isSyncWebPairingCliOutput(result)) {
    return { outputSuffix: "", exitCode: null };
  }
  if (!result.pairingUrl) {
    return { outputSuffix: "", exitCode: null };
  }

  let outputSuffix = "";
  if (options.text && !plan.syncWebNoClipboard) {
    const copy = deps.copy ?? copyToClipboard;
    if (copy(result.pairingUrl)) {
      outputSuffix += "\n(copied to clipboard)";
    }
  }

  if (plan.syncWebOpen) {
    const open = deps.open ?? openUrlViaOs;
    const openResult = open(result.pairingUrl);
    if (openResult.failed) {
      if (options.text) {
        outputSuffix += `\nCould not invoke OS opener: ${openResult.message}`;
      }
      return { outputSuffix, exitCode: 1 };
    }
  }

  return { outputSuffix, exitCode: null };
}

async function runCli(
  argv: string[],
): Promise<{ output: string; exitCode: number }> {
  const parsed = parseCliArgs(argv);
  const plan = buildCliPlan(parsed.command, parsed.options);
  if (plan.kind === "help")
    return {
      output: plan.text.endsWith("\n") ? plan.text : `${plan.text}\n`,
      exitCode: 0,
    };
  if (plan.kind === "static")
    return {
      output: formatOutput(plan.value, parsed.options, plan.formatter),
      exitCode: 0,
    };
  if (plan.kind === "execute" && plan.laneCreationNudge) {
    const notice = detectUnmergedLaneCreateNudge(plan.laneCreationNudge);
    if (notice) process.stderr.write(`${notice}\n`);
  }
  if (
    plan.kind === "execute"
    && plan.machineOnly
    && !plan.machineAutoStart
    && parsed.options.headless
  ) {
    throw new CliUsageError(
      "Personal chats require the machine-owned ADE brain; remove --headless and run `ade brain start` if the brain is not already available.",
    );
  }
  // Ensure ADE's bundled skills are seeded into the home-level dirs every runtime
  // discovers, but only on the paths that actually launch an agent/runtime/skill —
  // cheap commands like `ade help` and `ade --version` must not pay the scan/hash
  // cost (cheap no-op when already current).
  if (
    plan.kind === "skill" ||
    plan.kind === "ade-code" ||
    plan.kind === "account-machine-connect" ||
    plan.kind === "brain" ||
    plan.kind === "runtime" ||
    plan.kind === "serve" ||
    (plan.kind === "execute" &&
      /^(agent spawn|chat create|personal chat create|new chat|shell start cli)\b/.test(plan.label))
  ) {
    reseedBundledAdeSkillsForCli();
  }
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  const writeDiagnostic = (...args: unknown[]) => {
    process.stderr.write(
      `${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}\n`,
    );
  };
  console.log = writeDiagnostic;
  console.info = writeDiagnostic;
  console.warn = writeDiagnostic;
  try {
    if (plan.kind === "cursor-cloud") {
      // Cursor Cloud talks to @cursor/sdk directly. No ADE runtime endpoint / no headless
      // RPC. The function handles its own --json/--text/--compact parsing on
      // the remaining tokens.
      try {
        const result = await runCursorCloud(
          plan.rest,
          parsed.options.text ? "text" : "json",
        );
        return result;
      } catch (error) {
        if (error instanceof CursorCloudUsageError)
          throw new CliUsageError(error.message);
        throw error;
      }
    }
    if (plan.kind === "rpc-stdio") {
      await runNativeRpcStdio(parsed.options);
      return { output: "", exitCode: 0 };
    }
    if (plan.kind === "pty-host-worker") {
      await import("../../desktop/src/main/services/pty/ptyHostWorker");
      await new Promise<void>((resolve) => {
        if (typeof process.send !== "function") {
          resolve();
          return;
        }
        process.once("disconnect", resolve);
      });
      return { output: "", exitCode: 0 };
    }
    if (plan.kind === "desktop") {
      const result = await runDesktopCommand(plan.rest);
      return {
        output: formatOutput(result, parsed.options, undefined),
        exitCode: isRecord(result) && result.ok === false ? 1 : 0,
      };
    }
    if (plan.kind === "deeplink") {
      try {
        const result = await runDeeplinkCommandAsync(plan.rest, {
          resolveEnvelope: createLinkEnvelopeResolver(parsed.options),
        });
        return { output: result.output, exitCode: result.exitCode };
      } catch (error) {
        if (error instanceof CliDeeplinkUsageError) {
          throw new CliUsageError(error.message);
        }
        throw error;
      }
    }
    if (plan.kind === "skill") {
      try {
        // The global parser folds --text/--json into parsed.options.text;
        // forward that choice to the local skill command (default = JSON).
        const rest = [...plan.rest, parsed.options.text ? "--text" : "--json"];
        const result = runSkillCommand(rest);
        return { output: result.output, exitCode: result.exitCode };
      } catch (error) {
        if (error instanceof CliSkillUsageError) {
          throw new CliUsageError(error.message);
        }
        throw error;
      }
    }
    if (plan.kind === "runtime") {
      const result = await runRuntimeCommand(plan.rest, parsed.options);
      return {
        output: formatOutput(result, parsed.options, undefined),
        exitCode: isRecord(result) && result.ok === false ? 1 : 0,
      };
    }
    if (plan.kind === "brain") {
      const result = await runBrainCommand(plan.rest, parsed.options);
      return {
        output: formatOutput(result, parsed.options, undefined),
        exitCode: isRecord(result) && result.ok === false ? 1 : 0,
      };
    }
    if (plan.kind === "serve") {
      const result = await runServe(plan.rest, parsed.options);
      return {
        output:
          result == null ? "" : formatOutput(result, parsed.options, undefined),
        exitCode: isFailedServiceManagerResult(result) ? 1 : 0,
      };
    }
    if (plan.kind === "chat-wait") {
      return await runChatWaitCommand(plan, parsed.options);
    }
    if (plan.kind === "init") {
      const result = await runInit(plan.targetPath);
      return {
        output: formatOutput(result, parsed.options, undefined),
        exitCode: 0,
      };
    }
    if (plan.kind === "ade-code") {
      return await runAdeCode(plan.rest, parsed.options);
    }
    if (plan.kind === "account-login") {
      return await runAccountLogin(plan, parsed.options);
    }
    if (plan.kind === "account-machine-connect") {
      return await runAccountMachineConnect(plan, parsed.options);
    }
    if (plan.kind === "github-app-login") {
      return await runGithubAppLogin(plan, parsed.options);
    }
    const result = await executePlan(plan, parsed.options);
    if (plan.writeResultPath) {
      const payload = JSON.stringify(
        result,
        null,
        parsed.options.pretty ? 2 : 0,
      );
      fs.writeFileSync(plan.writeResultPath, `${payload}\n`, "utf8");
      const saved = {
        savedPath: plan.writeResultPath,
        rowCount: isRecord(result) ? result.rowCount : null,
        exportedAt: isRecord(result) ? result.exportedAt : null,
      };
      return {
        output: formatOutput(saved, parsed.options, undefined),
        exitCode: 0,
      };
    }
    const formatter = inferFormatter(plan);
    const flagEffects = applySyncWebPairingFlags(plan, parsed.options, result);
    return {
      output: appendOutputSuffix(
        formatOutput(result, parsed.options, formatter),
        flagEffects.outputSuffix,
      ),
      exitCode:
        flagEffects.exitCode ??
        (plan.exitCodeFromResult ? plan.exitCodeFromResult(result) : 0),
    };
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
  }
}

async function writeProcessOutput(
  stream: NodeJS.WriteStream,
  output: string,
): Promise<void> {
  if (!output.length) return;
  await new Promise<void>((resolve) => {
    stream.write(output, () => resolve());
  });
}

async function main(): Promise<void> {
  const writeDiagnostic = (...args: unknown[]) => {
    process.stderr.write(
      `${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}\n`,
    );
  };
  console.log = writeDiagnostic;
  console.info = writeDiagnostic;
  console.warn = writeDiagnostic;
  try {
    const result = await runCli(process.argv.slice(2));
    await writeProcessOutput(process.stdout, result.output);
    process.exitCode = result.exitCode;
  } catch (error) {
    const fallback = maybeRunBuiltCliFallback(error, process.argv.slice(2));
    if (fallback) {
      await writeProcessOutput(process.stderr, fallback.stderr);
      await writeProcessOutput(process.stdout, fallback.stdout);
      process.exitCode = fallback.exitCode;
      return;
    }
    if (error instanceof CliUsageError) {
      await writeProcessOutput(
        process.stderr,
        `ade: ${error.message}\nRun 'ade help'.\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (error instanceof CliToolError) {
      await writeProcessOutput(process.stderr, `ade: ${error.message}\n`);
      if (error.details !== undefined) {
        await writeProcessOutput(
          process.stderr,
          `${JSON.stringify(error.details, null, 2)}\n`,
        );
      }
      process.exitCode = 1;
      return;
    }
    if (error instanceof CliExecutionError) {
      await writeProcessOutput(process.stderr, `ade: ${error.message}\n`);
      await writeProcessOutput(
        process.stderr,
        `${JSON.stringify(error.details, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    await writeProcessOutput(
      process.stderr,
      `ade: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (/(^|[/\\])cli\.(?:ts|js|cjs)$/.test(process.argv[1] ?? "")) {
  void main().finally(async () => {
    try {
      const { shutdownAllSharedProductAnalyticsServices } = await import(
        "../../desktop/src/main/services/analytics/productAnalyticsService"
      );
      await shutdownAllSharedProductAnalyticsServices();
    } catch {
      // Product analytics is best-effort and must not change CLI exit status.
    }
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  });
}

export {
  buildCliPlan,
  buildAdeCodeArgs,
  checkLinearReadiness,
  detectUnmergedLaneCreateNudge,
  findProjectRoots,
  formatOutput,
  graphWaitState,
  inferFormatter,
  applySyncWebPairingFlags,
  isEphemeralRuntimeSocketPath,
  isFailedServiceManagerResult,
  machineRuntimeMismatchReason,
  parseCliArgs,
  readRuntimeIdleExitMs,
  renderLaneGraph,
  resolveAdeCodeModulePath,
  resolveRoots,
  runCli,
  startHeadlessRpcSocketServer,
  startHeadlessRpcTcpServer,
  summarizeExecution,
  unwrapToolResult,
};
