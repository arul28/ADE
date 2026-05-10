#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import YAML from "yaml";
import {
  CURSOR_CLOUD_HELP,
  CursorCloudUsageError,
  runCursorCloud,
} from "./cursorCloud";
import {
  JsonRpcError,
  JsonRpcErrorCode,
  startJsonRpcServer,
  type JsonRpcHandler,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcTransport,
} from "./jsonrpc";
import { isAdeMcpNamedPipePath } from "../../desktop/src/shared/adeMcpIpc";
import {
  isLaunchProfile,
  isTrackedCliPermissionMode,
  LAUNCH_PROFILE_TITLE,
  validateLaunchProfilePermissionMode,
  type LaunchProfile,
} from "../../desktop/src/shared/cliLaunch";

type JsonObject = Record<string, unknown>;

type GlobalOptions = {
  projectRoot: string | null;
  workspaceRoot: string | null;
  role: "cto" | "orchestrator" | "agent" | "external" | "evaluator";
  headless: boolean;
  requireSocket: boolean;
  pretty: boolean;
  text: boolean;
  timeoutMs: number;
};

type ParsedCli = {
  options: GlobalOptions;
  command: string[];
};

type InvocationStep = {
  key: string;
  method: string;
  params?: JsonObject | ((values: JsonObject) => JsonObject);
  unwrapToolResult?: boolean;
  optional?: boolean;
};

type FormatterId =
  | "status"
  | "doctor"
  | "auth"
  | "linear-quick-view"
  | "lanes"
  | "lane-detail"
  | "git-status"
  | "diff-summary"
  | "file-read"
  | "files-tree"
  | "files-search"
  | "prs-list"
  | "pr-detail"
  | "pr-checks"
  | "pr-comments"
  | "mission-list"
  | "mission-detail"
  | "mission-runs"
  | "mission-graph"
  | "mission-watch"
  | "run-defs"
  | "run-runtime"
  | "chat-list"
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
  | "macos-vm-status"
  | "macos-vm-share-policy"
  | "macos-vm-guide"
  | "macos-vm-capture"
  | "macos-vm-selection"
  | "terminal-list"
  | "terminal-read"
  | "actions-list"
  | "action-result"
  | "automation-run-detail";

type CliPlan =
  | { kind: "help"; text: string }
  | { kind: "execute"; label: string; steps: InvocationStep[]; visualizer?: "lanes"; summary?: "status" | "doctor" | "auth"; formatter?: FormatterId; preferHeadless?: boolean }
  | { kind: "cursor-cloud"; rest: string[] }
  | { kind: "mcp" };

type CliConnection = {
  mode: "desktop-socket" | "headless";
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

const VERSION = "0.0.0";
const PROTOCOL_VERSION = "2025-06-18";
const SOURCE_FALLBACK_ENV = "ADE_CLI_SOURCE_FALLBACK_ACTIVE";
const CLI_ENTRY_PATH = typeof process.argv[1] === "string" ? path.resolve(process.argv[1]) : "";
const CLI_PACKAGE_ROOT = resolveCliPackageRoot(CLI_ENTRY_PATH);
const CLI_DIST_PATH = path.join(CLI_PACKAGE_ROOT, "dist", "cli.cjs");
const COORDINATOR_MCP_TOOL_NAMES = new Set([
  "spawn_worker",
  "insert_milestone",
  "request_specialist",
  "delegate_to_subagent",
  "delegate_parallel",
  "stop_worker",
  "send_message",
  "message_worker",
  "broadcast",
  "get_worker_output",
  "list_workers",
  "report_status",
  "report_result",
  "report_validation",
  "read_mission_status",
  "read_mission_state",
  "update_mission_state",
  "revise_plan",
  "update_tool_profiles",
  "transfer_lane",
  "provision_lane",
  "set_current_phase",
  "create_task",
  "update_task",
  "assign_task",
  "list_tasks",
  "skip_step",
  "mark_step_complete",
  "mark_step_failed",
  "retry_step",
  "complete_mission",
  "fail_mission",
  "get_budget_status",
  "request_user_input",
  "read_file",
  "read_step_output",
  "search_files",
  "get_project_context",
]);

const WORKER_MISSION_TOOL_CLI_NAMES = new Set([
  "get_mission",
  "get_run_graph",
  "get_worker_states",
  "get_timeline",
  "get_pending_messages",
  "stream_events",
  "message_worker",
]);

function resolveCliPackageRoot(entryPath: string): string {
  const seen = new Set<string>();
  const starts = [
    entryPath ? path.dirname(entryPath) : null,
    process.cwd(),
  ];
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

function isSourceRuntimeInteropError(value: unknown): boolean {
  const message = typeof value === "string"
    ? value
    : value instanceof Error
      ? value.message
      : "";
  if (!message.length) return false;
  const lower = message.toLowerCase();
  return lower.includes("__filename is not defined in es module scope")
    || lower.includes("__filename is not defined")
    || lower.includes("__dirname is not defined");
}

function formatSpawnFailure(result: ReturnType<typeof spawnSync>, fallbackCommand: string): string {
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

function maybeRunBuiltCliFallback(error: unknown, argv: string[]): { stdout: string; stderr: string; exitCode: number } | null {
  if (!(error instanceof CliExecutionError)) return null;
  if (process.env[SOURCE_FALLBACK_ENV] === "1") return null;
  if (!isSourceCliEntryPath(CLI_ENTRY_PATH)) return null;
  if (!isSourceRuntimeInteropError(asString(error.details.cause) ?? error.message)) return null;

  if (!isBuiltCliFresh()) {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const buildResult = spawnSync(npmCommand, ["run", "build", "--silent"], {
      cwd: CLI_PACKAGE_ROOT,
      env: process.env,
      encoding: "utf8",
    });
    if (buildResult.error || buildResult.status !== 0 || !isBuiltCliFresh()) {
      error.details.nextAction = "Run `npm --prefix apps/ade-cli run build` and retry the command.";
      error.details.fallback = formatSpawnFailure(buildResult, "npm run build --silent");
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
    error.details.nextAction = "Run `node apps/ade-cli/dist/cli.cjs ...` directly to inspect the runtime failure.";
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

  ADE CLI commands operate on the same project database and live desktop socket
  used by the ADE app. By default the CLI connects to the app socket when it is
  running; otherwise it falls back to a headless runtime for local-safe actions.

    $ ade help <command...>                         Display help for a command
    $ ade auth status                               Check local ADE CLI readiness
    $ ade doctor                                    Inspect project, socket, runtime, and tool availability
    $ ade lanes list | show | create | child        Work with lanes and lane stacks
    $ ade git status | commit | push | stash        Run ADE-aware git operations
    $ ade diff changes | file | patch               Inspect lane diffs (including raw git patch text)
    $ ade files tree | read | write | search        Read and edit lane workspaces
    $ ade missions launch | watch | graph           Create, start, and inspect mission runs
    $ ade prs list | create | path-to-merge         Manage PRs, queues, and Path to Merge repair rounds
    $ ade run defs | ps | start | logs              Manage Run tab process definitions and runtime
    $ ade shell start | write | resize | close      Launch and control tracked shell sessions
    $ ade terminal list | read | write | signal     Control the active in-chat terminal
    $ ade chat list | create | send | interrupt     Work with ADE agent chats
    $ ade agent spawn --lane <id> --prompt <text>   Launch an agent session in ADE
    $ ade cto state | chats                         Operate CTO state and Work chats
    $ ade linear workflows | run | sync             Operate Linear routing and sync workflows
    $ ade automations list | create | run | runs    Manage automation rules
    $ ade coordinator <tool>                        Call coordinator runtime tools
    $ ade tests list | run | stop | runs | logs     Run configured test suites
    $ ade proof status | list | screenshot | record Manage proof and computer-use artifacts
    $ ade ios-sim devices | apps | launch | tap    Control iOS Simulator apps, capture, and input
    $ ade app-control launch | snapshot | click    Inspect and drive Electron apps
    $ ade macos-vm status | start | guide          Run lane-tied macOS VMs for agent work
    $ ade browser open | tabs | screenshot         Use ADE's built-in browser pane
    $ ade memory add | search | pin                 Use ADE memory
    $ ade usage snapshot | refresh | budget         Read provider quota usage and edit automation guardrails
    $ ade settings action <method>                  Call project config actions
    $ ade update status | check | install | dismiss Read auto-update state and drive install
    $ ade actions list | run | status               Escape hatch for every ADE service action
    $ ade mcp                                      Expose ADE actions over stdio MCP
    $ ade cursor cloud agents | runs | artifacts | repos | models | me
                                                    Drive Cursor Cloud agents via @cursor/sdk

  Global options:
    --project-root <path>   ADE project root. Inside .ade/worktrees/<lane>, this resolves to the parent project.
    --workspace-root <path> Lane/worktree to treat as the active workspace.
    --headless              Skip the desktop socket and run an in-process ADE runtime.
    --socket                Require the desktop socket; fail instead of falling back to headless.
    --json                  Print machine-readable JSON. This is the default output mode.
    --text                  Print a compact human-readable summary when a formatter exists.
    --timeout-ms <ms>       Per-request timeout. Long agent/PR workflows may need several minutes.

  Common agent flows:
    $ ade doctor --text
    $ ade lanes list --text
    $ ade lanes create --name fix-login --description "Repair login redirect"
    $ ade git status --lane <lane> --text
    $ ade git stage --lane <lane> src/index.ts
    $ ade git commit --lane <lane> -m "Fix login redirect"
    $ ade missions launch --prompt "Fix onboarding" --manual --text
    $ ade prs create --lane <lane> --base main --draft
    $ ade prs path-to-merge <pr-id-or-number-or-url> --model <model> --max-rounds 3 --no-auto-merge
    $ ade proof record --seconds 20
    $ ade ios-sim apps --text
    $ ade ios-sim launch --target <id> --text
    $ ade app-control launch --command "pnpm dev" --text
    $ ade macos-vm start --lane <lane> --create --text
    $ ade macos-vm guide --lane <lane> --text
    $ ade --socket browser open http://localhost:5173 --new-tab --text
    $ ade terminal read --chat-session <id> --text

  Generic ADE action JSON contract:
    Object-shaped call:
      $ ade actions run git.push --input-json '{"laneId":"lane-1","setUpstream":true}'
      $ ade actions run git.push --arg laneId=lane-1 --arg setUpstream=true
    JSON value fields:
      $ ade actions run pr.setLabels --arg prId=123 --arg-json 'labels=["ready","ship"]'
    Multi-parameter service call:
      $ ade actions run issue_inventory.savePipelineSettings --args-list-json '["pr-1",{"maxRounds":3}]'
    Single scalar parameter:
      $ ade actions run mission.get --scalar mission-1

    $ ade actions list --text
    $ ade actions list --domain pr --text
    $ ade actions run <domain.action> --input-json '{"key":"value"}'

  Start with: ade doctor --text
`;

const IOS_SIMULATOR_SUBCOMMAND_HELP: Record<string, string> = {
  status: `${ADE_BANNER}
  iOS Simulator: status

  Shows macOS support, Xcode/idb/ffmpeg readiness, the active booted device,
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
    --foreground                Open and bring Simulator.app forward.
    --arg KEY=VALUE             Extra service args for advanced launch options.
`,
  shutdown: `${ADE_BANNER}
  iOS Simulator: shutdown

  Stops streams, releases the drawer session, and tears down simulator helper processes.
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

  Starts a visual stream. auto resolves to iosurface-indigo first when full
  Xcode supports ADE's private helpers, then Simulator.app window capture when
  visible-window capture is allowed, then idb MJPEG, then simctl screenshot
  polling. The H.264+ffmpeg idb stream is recovery-only after idb MJPEG fails.
  Aliases:
  start-stream, stream, window-start,
  start-window, mirror-start, live-start, start-live, preview-start, start-preview.

    $ ade --socket ios-sim window-start --fps 60 --text
    $ ade --socket ios-sim live-start --fps 30 --text
    $ ade --socket ios-sim preview-start --fps 8 --text

  Flags:
    --device, --udid <id>  Simulator device.
    --fps <n>              Target fps.
    --backend auto|iosurface-indigo|simulator-window-capture|idb-mjpeg|idb-h264-ffmpeg-mjpeg|simctl-screenshot-poll
    --window, --mirror     Force window capture.
    --idb, --live          Use auto backend resolution.
    --simctl, --preview    Force simctl screenshot polling.
`,
  "stream-status": `${ADE_BANNER}
  iOS Simulator: stream-status

  Shows running backend, fallback/degradation reason, helper pid, fps, latency,
  stream URL, frame count, input backend, and last error. Low idle fps is normal
  on iosurface-indigo because frames are event-driven when the simulator is still.

    $ ade --socket ios-sim stream-status --text
`,
  "stream-stop": `${ADE_BANNER}
  iOS Simulator: stream-stop

  Stops the visual stream without necessarily releasing the simulator session.
  Aliases: stop-stream, preview-stop, stop-preview, live-stop, stop-live.

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

  Sends a tap through the active input backend, preferring Indigo with idb fallback.

    $ ade --socket ios-sim tap --x 120 --y 420 --text
    $ ade --socket ios-sim tap 120 420 --text

  Flags:
    --x <n> --y <n>        Required point coordinates.
    --device, --udid <id>  Simulator device.
    --project-root <path>  Project root.
`,
  drag: `${ADE_BANNER}
  iOS Simulator: drag / swipe

  Sends a swipe through the active input backend. "swipe" is an alias of drag.

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

  Types text through idb into the active launched app. Alias: text.

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
  "render-preview": "preview-render",
  preview: "preview-render",
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
  "preview-stop": "stream-stop",
  "stop-preview": "stream-stop",
  "live-stop": "stream-stop",
  "stop-live": "stream-stop",
  swipe: "drag",
  text: "type",
};

const HELP_BY_COMMAND: Record<string, string> = {
  lanes: `${ADE_BANNER}
  Lanes

  Lanes are ADE-managed worktrees and branches. Most commands accept either
  --lane <lane-id> or a positional lane id.

    $ ade lanes list --text                         Show lane stack graph and branch names
    $ ade lanes show <lane> --text                  Inspect one lane status
    $ ade lanes create --name <name>                Create a lane from the current project context
    $ ade lanes create --linear-issue-json '{...}'  Create a lane linked to a Linear issue
    $ ade lanes create --branch-name <branch>       Override the auto-generated branch name
    $ ade lanes child --lane <parent> --name <name> Create a child lane under a parent
    $ ade lanes import --branch <branch>            Register an existing branch/worktree
    $ ade lanes archive <lane>                      Archive a lane in ADE
    $ ade lanes unarchive <lane>                    Restore an archived lane
    $ ade lanes attach --path <worktree> --name <n> Attach an external worktree
    $ ade lanes actions --text                      List callable lane service methods
`,
  git: `${ADE_BANNER}
  Git

  Git commands run in the lane worktree and record ADE operations so the app can
  refresh lane state. Use --lane for anything other than the active workspace.

    $ ade git status --lane <lane> --text           Show ADE-aware sync status
    $ ade git stage --lane <lane> src/file.ts       Stage one file
    $ ade git stage-all --lane <lane>               Stage all current changes
    $ ade git unstage --lane <lane> src/file.ts     Unstage one file
    $ ade git commit --lane <lane> [-m <message>]   Commit, adding Refs <issue-id> on linked Linear lanes
    $ ade git push --lane <lane> --set-upstream     Push through ADE
    $ ade git branches --lane <lane> --text         List branches with last-commit metadata
    $ ade git user-identity --lane <lane> --text    Read lane checkout's git user.name/email
    $ ade git stash push|list|apply|pop             Use ADE lane stash actions
    $ ade git rebase --lane <lane> --ai             Rebase with ADE conflict support
    $ ade diff changes --lane <lane> --text         Inspect changed files
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
    $ ade prs create --lane <lane> --base main      Open and map a GitHub PR from a lane
    $ ade prs create --lane <lane> --close-linear-issue-on-merge
    $ ade prs link --lane <lane> --url <pr-url>     Map an existing GitHub PR to a lane
    $ ade prs checks <pr> --text                    Show check status
    $ ade prs comments <pr> --text                  Show unresolved review work
    $ ade prs inventory <pr>                        Refresh ADE issue inventory
    $ ade prs path-to-merge <pr> --model <model> --max-rounds 3 --no-auto-merge
    $ ade prs path-to-merge <pr> --model <model> --conflict-strategy auto --force-finalize conditional
    $ ade prs path-to-merge <pr> --model <model> --no-early-merge-on-green
    $ ade prs pipeline <pr> save --conflict-strategy rebase --early-merge-on-green
    $ ade prs resolve-thread <pr> --thread <id>     Resolve a review thread
    $ ade prs labels set <pr> ready-to-merge        Replace labels
    $ ade prs reviewers request <pr> alice bob      Request reviewers
`,
  missions: `${ADE_BANNER}
  Missions

  Mission commands are the typed CLI surface for backend mission launch,
  monitoring, and run inspection. They work in --headless mode for local
  service checks, or --socket when you intentionally want the live desktop
  drawer/session state.

    $ ade missions list --text                      List missions
    $ ade missions create --prompt "Fix login"      Create a mission without starting a run
    $ ade missions launch --prompt "Fix login" --manual --text
                                                    Create and start a mission run
    $ ade missions launch --prompt "..." --wait-ms 30000 --text
                                                    Keep headless runtime alive and return graph
    $ ade missions start <mission-id> --manual      Start an existing mission
    $ ade missions resume <run-id> --text           Resume an active/paused run and restart coordinator control
    $ ade missions resume <run-id> --wait-ms 30000 --text
                                                    Keep resumed coordinator alive and return graph
    $ ade missions show <mission-id> --text         Inspect mission detail
    $ ade missions runs <mission-id> --text         List run attempts for a mission
    $ ade missions graph <run-id> --text            Inspect one run graph
    $ ade missions watch <mission-id> --text        Snapshot mission + newest run graph
    $ ade missions watch <mission-id> --wait-ms 5000 --text
                                                    Wait before taking the snapshot

  Phase and planner payloads:
    $ ade missions create --prompt "..." --phase-override-file phases.json
    $ ade missions create --prompt "..." --planned-steps-file steps.json
    $ ade missions create --input-json '{"prompt":"...","phaseOverride":[...]}'
`,
  run: `${ADE_BANNER}
  Run tab

  Run tab commands mirror ADE desktop process definitions and runtime state.
  They require the desktop socket when live process state is needed.

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
  Inside an ADE chat, shell starts attach to the active chat automatically.

    $ ade shell start --lane <lane> -- npm test     Start a tracked shell session
    $ ade shell start --lane <lane> -c "npm test"   Start with a command string
    $ ade shell start-cli codex --lane <lane> --permission-mode edit
    $ ade shell start --provider claude --lane <lane> --message "fix tests"
    $ ade shell start --lane <lane> --chat-session <id> -c "npm test"
    $ ade shell write <pty-id> --data "q"           Write data to a PTY
    $ ade shell resize <pty-id> --cols 120 --rows 36
    $ ade shell close <pty-id>                      Dispose a PTY
`,
  terminal: `${ADE_BANNER}
  Chat terminal

  Terminal commands control the active in-chat terminal for an ADE chat. Use
  desktop socket mode when you want the same terminal the user sees in the app.

    $ ade terminal list --chat-session <id> --text  List terminals for a chat
    $ ade terminal active --chat-session <id> --text Show the active chat terminal
    $ ade terminal read --terminal <id> --text      Read terminal scrollback
    $ ade app-control logs --text                   Read the active App Control launch terminal
    $ ade terminal write --terminal <id> --data "y\\n"
    $ ade terminal signal --terminal <id> --signal SIGINT
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
  requires the desktop socket because the app owns provider/session state.

    $ ade chat list --text                          List chat sessions
    $ ade chat create --lane <lane> --provider codex --model <model> [--fast]
    $ ade chat send <session> --text "next step"    Send a message
    $ ade chat interrupt <session>                  Stop an active turn
    $ ade chat resume <session>                     Resume a session
    $ ade agent spawn --lane <lane> --prompt "fix"  Start a new agent work session
`,
  agent: `${ADE_BANNER}
  Agent sessions

    $ ade agent spawn --lane <lane> --prompt "Fix the failing test"
    $ ade agent spawn --lane <lane> --provider codex --model <model> --permissions workspace-write
    $ ade agent spawn --lane <lane> --context-file docs/context.md --prompt "continue"
    $ ade agent spawn --lane <lane> --tool=git --tool=files --prompt "review changes"
`,
  proof: `${ADE_BANNER}
  Proof and computer use

  Proof commands capture or ingest reviewer-visible evidence for ADE work.
  Prefer screenshots/images, screen recordings, and browser captures/traces.
  Console logs are supporting diagnostics, not a replacement for visual proof.
  Local screenshot/video fallback is macOS-only and runs headless by default
  unless --socket is explicitly requested. Desktop socket mode has the best
  parity for UI-owned proof state.

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
  surface. For drawer/shared session state, prefer desktop socket mode
  (--socket) so launch/select/tap operate on the same long-lived ADE service.
  Launch is headless by default; use --foreground only when you
  need the native Simulator window in front. idb is optional for direct
  pointer/text control and the low-latency MJPEG live stream.

  Single-owner lock: a launched session is owned by one --chat-session at a time.
  If another session tries to launch with a different chatSessionId, the call
  fails with code IOS_SIMULATOR_OWNED_BY_OTHER_SESSION. Run "ios-sim shutdown"
  (or "shutdown --force") to release before re-launching from a different chat.

  Discovery and lifecycle:
    $ ade ios-sim status --text                    Show Xcode/idb readiness (getStatus)
    $ ade ios-sim devices --text                   List installed/available simulators (listDevices)
    $ ade ios-sim apps --device <udid> --text      List launchable apps (listLaunchTargets)
    $ ade --socket ios-sim launch --target <id>    Build/install/launch and update drawer state
    $ ade --socket ios-sim launch --bundle-id com.example Launch installed app
    $ ade --socket ios-sim shutdown                Tear down session, streams, helper processes (alias: stop)
    $ ade --socket ios-sim shutdown --force        Force-release a session owned by another chat
    $ ade ios-sim actions --text                   List every callable ios_simulator action

  Project discovery scans root-level .xcodeproj bundles and apps/*/*.xcodeproj
  projects; do not create symlink shims or fake schemes before checking
  "ios-sim apps --text" and the build output.

  Capture and inspection:
    $ ade ios-sim screenshot --text                One-shot PNG via simctl (screenshot)
    $ ade ios-sim snapshot --text                  Screenshot + selectable elements (getScreenSnapshot)
    $ ade ios-sim inspector --text                 Published ADEInspector frames (getInspectorSnapshot)
    $ ade ios-sim inspect --x 120 --y 420 --text   Hit-test a point in the inspector (inspectPoint)
    $ ade ios-sim preview-status --text           Xcode MCP readiness for Preview Lab
    $ ade ios-sim previews --source <file> --text  List nearby #Preview definitions
    $ ade ios-sim preview-render --source <file>   Render a SwiftUI preview through Xcode MCP

  Streaming:
    $ ade ios-sim live-start --fps 30              Auto live stream (IOSurface first)
    $ ade ios-sim preview-start --fps 8            simctl screenshot-poll fallback
    $ ade ios-sim window-start --fps 60            Native Simulator.app window capture diagnostic
    $ ade ios-sim stream-status --text             Backend/fps/latency/URL (getStreamStatus)
    $ ade ios-sim stream-stop                      Stop preview/live streaming (stopStream)

  Input and selection:
    $ ade --socket ios-sim select --x 120 --y 420  Add UI context to drawer chat (selectPoint)
    $ ade ios-sim tap 120 420                      Tap active simulator app (tap)
    $ ade ios-sim drag 120 700 120 250             Drag active simulator app (drag)
    $ ade ios-sim swipe 120 700 120 250            Swipe active simulator app (swipe)
    $ ade ios-sim type "hello" --text              Type into the launched app (typeText)
`,
  "macos-vm": `${ADE_BANNER}
  macOS VM

  macOS VM commands provision and control lane-tied Apple silicon macOS
  guests through Lume. ADE mounts the lane worktree into the guest with a
  shared directory so host and guest edits stay in sync. Use desktop socket
  mode when the Work sidebar and agents should observe the same live VM state.

  Discovery and lifecycle:
    $ ade macos-vm status --text                  Show provider readiness and lane VMs
    $ ade macos-vm status --lane <lane> --text    Show one lane's VM
    $ ade macos-vm provision --lane <lane>        Pull/create a VM for a lane
    $ ade macos-vm start --lane <lane> --create   Start the VM, provisioning if missing
    $ ade macos-vm stop --lane <lane>             Stop the lane VM
    $ ade macos-vm delete --lane <lane> --force   Delete the VM record and provider VM
    $ ade macos-vm guide --lane <lane> --text     Print agent VM guidance
    $ ade macos-vm focus --lane <lane>            Select the VM GUI target or raise its viewer
    $ ade macos-vm screenshot --lane <lane>        Capture the VM through VNC or its viewer
    $ ade macos-vm select --lane <lane> --x 120 --y 420
                                                    Attach screenshot-backed VM point context
    $ ade macos-vm click --lane <lane> 120 420     Click window-relative coordinates
    $ ade macos-vm type --lane <lane> "hello"      Type into the VM GUI target
    $ ade macos-vm actions --text                 List callable macos_vm actions

  Provisioning flags:
    --mode pull-image|create      Pull a Lume image or create from an IPSW.
    --image, --source-image <id>  Lume image, default macos-tahoe-vanilla:latest.
    --ipsw <path|latest>          Restore image for --mode create.
    --cpu, --cpu-cores <n>        Virtual CPU count.
    --memory <size>               Memory, for example 8GB.
    --disk, --disk-size <size>    Disk size, for example 80GB.
    --display <WxH>               Display size, for example 1920x1200.
    --no-display                  Start without opening the VM display window.
    --window-title <text>          Override the VM window title match.
    --coordinate-space window|screen Coordinates for click; default window.
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

  Launching runs the command in the chat terminal instead of a hidden child
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
    $ ade app-control launch --command "npm run dev" --text
    $ ade app-control launch pnpm dev --text       Launch via the visible chat terminal
    $ ade app-control launch --command "pnpm dev" --cwd apps/desktop --text
    $ ade app-control launch --command "/path/script.sh {ADE_APP_CONTROL_DEBUG_FLAGS}"
    $ ade app-control connect --cdp-port 9222      Attach to an already-running app
    $ ade app-control targets --text               List debuggable CDP targets
    $ ade app-control attach-target --target <id>  Attach to one renderer target
    $ ade app-control logs --text                  Read the active App Control launch terminal
    $ ade app-control terminal write --data "y\\n" Answer a prompt in that terminal
    $ ade app-control stop --text                  Signal the App Control terminal session
    $ ade app-control actions --text               List every callable app_control action
    $ ade terminal read --terminal <id> --text     Read a specific chat terminal
    $ ade terminal write --chat-session <id> --data "y\\n" Answer a prompt

  Capture and context:
    $ ade app-control screenshot --text            Capture the active renderer screenshot
    $ ade app-control snapshot --text              Screenshot + DOM element refs
    $ ade app-control inspect --x 120 --y 420      Hit-test a point without committing context
    $ ade app-control select --x 120 --y 420       Add selected app context to the drawer chat

  Input:
    $ ade app-control click 120 420                Click screenshot coordinates
    $ ade app-control scroll --x 120 --y 420 --delta-y 600
    $ ade app-control key --key Enter
    $ ade app-control type "hello" --text          Type text into the focused element
`,
  browser: `${ADE_BANNER}
  ADE browser

  Browser commands control ADE's global built-in browser pane. Use desktop
  socket mode so CLI calls, chat link clicks, terminal localhost links, and the
  Work sidebar all share the same browser tabs. The browser is global, not
  lane-scoped.

  Tabs and navigation:
    $ ade --socket browser status --text           Show active tab and tab list
    $ ade --socket browser panel --text            Open the Work sidebar Browser panel
    $ ade --socket browser open https://example.com --text
    $ ade --socket browser open localhost:5173 --new-tab --text
    $ ade --socket browser open https://example.com --no-panel
    $ ade --socket browser new-tab --url https://example.com
    $ ade --socket browser switch --tab <tab-id>
    $ ade --socket browser close --tab <tab-id>
    $ ade --socket browser actions --text          List built_in_browser actions

  Page controls:
    $ ade --socket browser reload
    $ ade --socket browser back
    $ ade --socket browser forward
    $ ade --socket browser stop

  Capture and context:
    $ ade --socket browser screenshot --text       Capture the active browser tab
    $ ade --socket browser select --x 120 --y 420  Attach DOM context at a viewport point
    $ ade --socket browser inspect-start           Start DOM inspect mode
    $ ade --socket browser inspect-stop            Stop DOM inspect mode
    $ ade --socket browser select-current --text   Return the selected DOM item
    $ ade --socket browser clear-selection

  Flags:
    --url <url>          URL for panel/open/new-tab. Bare localhost gets http://.
    --new-tab           Open navigation in a new tab instead of active tab.
    --active-tab         Navigate the active tab; aliases: --current-tab, --same-tab.
    --background         Create a new tab without activating it.
    --no-panel           Keep the Work sidebar panel hidden; alias: --hidden.
    --tab, --tab-id <id> Target tab for switch/close/open.
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
  memory: `${ADE_BANNER}
  Memory

    $ ade memory add --category fact --content "User prefers concise summaries"
    $ ade memory search -q "release process" --text
    $ ade memory pin <memory-id>
    $ ade memory core --arg projectSummary="Current focus"
`,
  usage: `${ADE_BANNER}
  Usage and provider quotas

  Reads live provider quota usage (Claude five-hour + weekly, Codex five-hour +
  weekly, Cursor monthly via the team Admin API), pacing, costs, and budget
  guardrails. The desktop app surfaces this same data in the top-bar Usage popup.

    $ ade usage snapshot --text                     Cached snapshot (windows, pacing, costs, errors)
    $ ade usage refresh --text                      Force a fresh poll (invalidates cost cache)
    $ ade usage budget get --text                   Read automation guardrail config
    $ ade usage budget set --from-file budget.json  Save automation guardrail config
    $ ade usage budget check --provider claude --scope global
    $ ade usage budget cumulative --scope global    Cumulative spend for the current week

  Cursor uses the Admin API (https://api.cursor.com/teams/spend) — set
  CURSOR_ADMIN_API_KEY (or CURSOR_API_KEY) so the poll can authenticate.
`,
  cto: `${ADE_BANNER}
  CTO and Work state

    $ ade cto state --text                          Read CTO identity, core memory, and recent sessions
    $ ade cto chats list --text                     List CTO work chats
    $ ade cto chats spawn --lane <lane> --prompt "plan this"
    $ ade cto chats send <session> --text "continue"
    $ ade actions run cto_state.updateCoreMemory --input-json '{"projectSummary":"..."}'
    $ ade actions run worker_agent.listAgents --input-json '{"includeDeleted":false}'
`,
  linear: `${ADE_BANNER}
  Linear workflows

    $ ade --role cto linear quick-view --text      Show connected workspace, projects, and issues
    $ ade --role cto linear picker-data --text     Read projects/users/states for the issue picker
    $ ade --role cto linear search-issues --query "auth" --state-type started,unstarted --first 50
                                                    Search issues for the lane Linear-issue picker
    $ ade linear workflows --text                   List configured workflows
    $ ade linear sync dashboard --text              Show sync dashboard
    $ ade linear sync run                           Trigger a sync run
    $ ade linear sync queue --text                  List sync queue items
    $ ade linear sync resolve --queue-item <id> --action approve
    $ ade linear route worker --input-json '{"issueId":"LIN-123","workerId":"worker-1"}'
`,
  flow: `${ADE_BANNER}
  Flow policy

    $ ade flow policy get --text                    Read current workflow policy
    $ ade flow policy validate --input-json '{...}' Validate policy JSON
    $ ade flow policy save --input-json '{...}'     Save policy JSON
    $ ade flow policy revisions --text              List saved revisions
    $ ade flow policy rollback <revision-id>        Restore a prior revision
`,
  coordinator: `${ADE_BANNER}
  Coordinator runtime tools

  Coordinator tools expose orchestration operations used by mission agents.
  List tool names with:
    $ ade actions call list_ade_actions --input-json '{"domain":"orchestrator_core"}'

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
      $ ade actions run issue_inventory.savePipelineSettings --args-list-json '["pr-1",{"maxRounds":3}]'
    scalar is for one non-object parameter:
      $ ade actions run mission.get --scalar mission-1

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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
    throw new CliUsageError(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseObjectJson(value: string, label: string): JsonObject {
  const parsed = parseJson(value, label);
  if (!isRecord(parsed)) {
    throw new CliUsageError(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseAssignment(value: string, label: string): { key: string; value: string } {
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

const UNSAFE_ARG_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function setPath(target: JsonObject, key: string, value: unknown): void {
  const parts = key.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new CliUsageError("Argument key cannot be empty.");
  }
  const unsafePart = parts.find((part) => UNSAFE_ARG_PATH_SEGMENTS.has(part));
  if (unsafePart) {
    throw new CliUsageError(`Argument key segment "${unsafePart}" is not allowed.`);
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
    const matchedName = names.find((name) => token === name || token.startsWith(`${name}=`));
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
    const matchedName = names.find((name) => token === name || token.startsWith(`${name}=`));
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
      const flagName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      previousTokenWasValueCarrier = !token.includes("=") && VALUE_CARRIER_FLAGS.has(flagName);
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
  while (positionals.length && (positionals[0] === "cursor" || positionals[0] === "cloud")) {
    positionals.shift();
  }
  const group = positionals[0];
  const aliasMap: Record<string, string> = {
    agents: "agents", agent: "agents",
    runs: "runs", run: "runs",
    artifacts: "artifacts", artifact: "artifacts",
    repos: "repos", repo: "repos", repositories: "repos",
    models: "models", model: "models",
    me: "me", whoami: "me", user: "me",
  };
  if (group && aliasMap[group] && CURSOR_CLOUD_HELP[aliasMap[group]]) {
    return `${ADE_BANNER}${CURSOR_CLOUD_HELP[aliasMap[group]]}`;
  }
  return `${ADE_BANNER}${CURSOR_CLOUD_HELP.cloud}`;
}

function buildIosSimulatorHelp(args: string[]): string {
  const rawSubcommand = peekFirstPositional(args)?.toLowerCase() ?? "";
  const canonical = rawSubcommand
    ? IOS_SIMULATOR_HELP_ALIASES[rawSubcommand] ?? rawSubcommand
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

function collectGenericObjectArgs(args: string[], base: JsonObject = {}): JsonObject {
  const input: JsonObject = { ...base };
  while (true) {
    const inputJson = readValue(args, ["--input-json", "--json-input", "--input"]);
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

function readPrId(args: string[]): string | null {
  return readValue(args, ["--pr", "--pr-id"]) ?? null;
}

function readIntOption(args: string[], names: string[], fallback?: number): number | undefined {
  const value = readValue(args, names);
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`${names[0]} must be an integer.`);
  }
  return parsed;
}

function readNumberOption(args: string[], names: string[], fallback?: number): number | undefined {
  const value = readValue(args, names);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`${names[0]} must be a number.`);
  }
  return parsed;
}

function readJsonOption(args: string[], names: string[], label: string): unknown | undefined {
  const value = readValue(args, names);
  return value == null ? undefined : parseJson(value, label);
}

function readJsonFileOption(args: string[], names: string[], label: string): unknown | undefined {
  const filePath = readValue(args, names);
  if (filePath == null) return undefined;
  const resolvedPath = path.resolve(filePath);
  let text: string;
  try {
    text = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`Could not read ${names[0]} file '${filePath}': ${message}`);
  }
  return parseJson(text, label);
}

function readJsonPayloadOption(args: string[], jsonNames: string[], fileNames: string[], label: string): unknown | undefined {
  const inline = readJsonOption(args, jsonNames, label);
  const fromFile = readJsonFileOption(args, fileNames, label);
  if (inline !== undefined && fromFile !== undefined) {
    throw new CliUsageError(`Use either ${jsonNames[0]} or ${fileNames[0]}, not both.`);
  }
  return inline ?? fromFile;
}

function requireValue(value: string | null, label: string): string {
  if (value && value.trim().length > 0) return value.trim();
  throw new CliUsageError(`${label} is required.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCommandTextValue(argv: string[], index: number, command: string[]): boolean {
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
 * Parse the PR pipeline-settings flags shared by `prs path-to-merge` and
 * `prs pipeline` subcommands. Returns a partial `PipelineSettings` patch
 * suitable for `issue_inventory.savePipelineSettings`. Only fields the user
 * explicitly passed are included so the patch never clobbers other settings.
 *
 * The orchestrator reads these from saved settings (not StartPathToMergeArgs),
 * so the path-to-merge command must save them before launching the loop.
 */
function readPipelineSettingsPatch(args: string[]): JsonObject {
  const patch: JsonObject = {};

  const maxRounds = readIntOption(args, ["--max-rounds", "--rounds"]);
  if (maxRounds != null) patch.maxRounds = maxRounds;

  const autoMerge = readFlag(args, ["--auto-merge"]);
  const noAutoMerge = readFlag(args, ["--no-auto-merge"]);
  if (autoMerge || noAutoMerge) patch.autoMerge = autoMerge && !noAutoMerge;

  const mergeMethod = readValue(args, ["--merge-method"]);
  if (mergeMethod) patch.mergeMethod = mergeMethod;

  const conflictStrategy = readValue(args, ["--conflict-strategy"]);
  if (conflictStrategy) {
    if (
      conflictStrategy !== "pause"
      && conflictStrategy !== "rebase"
      && conflictStrategy !== "merge"
      && conflictStrategy !== "auto"
    ) {
      throw new CliUsageError(
        "--conflict-strategy must be one of pause, rebase, merge, or auto.",
      );
    }
    patch.conflictStrategy = conflictStrategy;
  }

  const forceFinalize = readValue(args, ["--force-finalize"]);
  if (forceFinalize) {
    if (
      forceFinalize !== "off"
      && forceFinalize !== "conditional"
      && forceFinalize !== "unconditional"
    ) {
      throw new CliUsageError(
        "--force-finalize must be one of off, conditional, or unconditional.",
      );
    }
    patch.forceFinalizeMode = forceFinalize;
    patch.atCapPolicy = forceFinalize === "off"
      ? "stop"
      : forceFinalize === "unconditional"
        ? "force_merge"
        : "ci_retry_once";
  }

  const requireNoCi = readFlag(args, ["--force-finalize-require-no-ci"]);
  const allowCi = readFlag(args, ["--force-finalize-allow-ci"]);
  if (requireNoCi || allowCi) {
    patch.forceFinalizeRequireNoCiFailures = requireNoCi && !allowCi;
  }

  const earlyMergeOn = readFlag(args, ["--early-merge-on-green"]);
  const earlyMergeOff = readFlag(args, ["--no-early-merge-on-green"]);
  if (earlyMergeOn || earlyMergeOff) {
    patch.earlyMergeOnGreen = earlyMergeOn && !earlyMergeOff;
  }

  const atCapPolicy = readValue(args, ["--at-cap-policy"]);
  if (atCapPolicy) {
    if (
      atCapPolicy !== "stop"
      && atCapPolicy !== "wait_for_ci"
      && atCapPolicy !== "ci_retry_once"
      && atCapPolicy !== "ci_retry_loop"
      && atCapPolicy !== "force_merge"
    ) {
      throw new CliUsageError(
        "--at-cap-policy must be one of stop, wait_for_ci, ci_retry_once, ci_retry_loop, or force_merge.",
      );
    }
    patch.atCapPolicy = atCapPolicy;
    patch.forceFinalizeMode = atCapPolicy === "stop"
      ? "off"
      : atCapPolicy === "force_merge"
        ? "unconditional"
        : "conditional";
  }

  const atCapWaitMinutes = readIntOption(args, ["--at-cap-wait-minutes"]);
  if (atCapWaitMinutes != null) {
    if (atCapWaitMinutes < 1) throw new CliUsageError("--at-cap-wait-minutes must be at least 1.");
    patch.atCapWaitMinutes = atCapWaitMinutes;
  }

  const atCapCiRetryMax = readIntOption(args, ["--at-cap-ci-retry-max"]);
  if (atCapCiRetryMax != null) {
    if (atCapCiRetryMax < 1) throw new CliUsageError("--at-cap-ci-retry-max must be at least 1.");
    patch.atCapCiRetryMax = atCapCiRetryMax;
  }

  const forceMergeConfirm = readFlag(args, ["--force-merge-requires-confirmation"]);
  const noForceMergeConfirm = readFlag(args, ["--no-force-merge-requires-confirmation"]);
  if (forceMergeConfirm || noForceMergeConfirm) {
    patch.forceMergeRequiresConfirmation = forceMergeConfirm && !noForceMergeConfirm;
  }

  return patch;
}

function parseCliArgs(argv: string[]): ParsedCli {
  const command: string[] = [];
  const options: GlobalOptions = {
    projectRoot: null,
    workspaceRoot: null,
    role: (asString(process.env.ADE_DEFAULT_ROLE) as GlobalOptions["role"] | null) ?? "agent",
    headless: parseBooleanEnv(process.env.ADE_CLI_HEADLESS),
    requireSocket: false,
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
      options.projectRoot = path.resolve(requireValue(argv[index + 1] ?? null, "--project-root"));
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--project-root=")) {
      options.projectRoot = path.resolve(requireValue(token.slice("--project-root=".length), "--project-root"));
      continue;
    }
    if (inGlobalPrefix && token === "--workspace-root") {
      options.workspaceRoot = path.resolve(requireValue(argv[index + 1] ?? null, "--workspace-root"));
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--workspace-root=")) {
      options.workspaceRoot = path.resolve(requireValue(token.slice("--workspace-root=".length), "--workspace-root"));
      continue;
    }
    if (inGlobalPrefix && token === "--role") {
      options.role = parseRole(requireValue(argv[index + 1] ?? null, "--role"));
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--role=")) {
      options.role = parseRole(requireValue(token.slice("--role=".length), "--role"));
      continue;
    }
    if (inGlobalPrefix && (token === "--headless" || token === "--no-socket")) {
      options.headless = true;
      continue;
    }
    if (inGlobalPrefix && token === "--socket") {
      options.requireSocket = true;
      options.headless = false;
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
      const parsed = Number.parseInt(requireValue(argv[index + 1] ?? null, "--timeout-ms"), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliUsageError("--timeout-ms must be a positive integer.");
      }
      options.timeoutMs = parsed;
      index += 1;
      continue;
    }
    if (inGlobalPrefix && token.startsWith("--timeout-ms=")) {
      const parsed = Number.parseInt(requireValue(token.slice("--timeout-ms=".length), "--timeout-ms"), 10);
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

function parseRole(value: string): GlobalOptions["role"] {
  if (value === "cto" || value === "orchestrator" || value === "agent" || value === "external" || value === "evaluator") {
    return value;
  }
  throw new CliUsageError("--role must be one of cto, orchestrator, agent, external, or evaluator.");
}

function shellEscapeToken(value: string): string {
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function actionCallStep(key: string, name: string, args: JsonObject = {}): InvocationStep {
  return {
    key,
    method: "ade/actions/call",
    params: { name, arguments: args },
    unwrapToolResult: true,
  };
}

function actionStep(key: string, domain: string, action: string, args: JsonObject = {}): InvocationStep {
  return actionCallStep(key, "run_ade_action", { domain, action, args });
}

function actionArgsListStep(key: string, domain: string, action: string, argsList: unknown[]): InvocationStep {
  return actionCallStep(key, "run_ade_action", { domain, action, argsList });
}

function actionScalarStep(key: string, domain: string, action: string, arg: unknown): InvocationStep {
  return actionCallStep(key, "run_ade_action", { domain, action, arg });
}

function waitRunGraphStep(args: {
  key: string;
  runId: string | ((values: JsonObject) => string);
  waitMs: number | undefined;
  timelineLimit: number;
  untilTerminal: boolean;
}): InvocationStep | null {
  if ((args.waitMs == null || args.waitMs <= 0) && !args.untilTerminal) return null;
  const waitMs = Math.min(30 * 60 * 1000, Math.max(0, Math.floor(args.waitMs ?? 30 * 60 * 1000)));
  return {
    key: args.key,
    method: "ade-cli/wait-run-graph",
    params: (values) => ({
      runId: typeof args.runId === "function" ? args.runId(values) : args.runId,
      waitMs,
      untilTerminal: args.untilTerminal,
      timelineLimit: args.timelineLimit,
    }),
  };
}

function listActionsStep(key: string, domain?: string): InvocationStep {
  return actionCallStep(key, "list_ade_actions", domain ? { domain } : {});
}

function buildActionRunStep(args: string[]): InvocationStep {
  const target = firstPositional(args);
  if (!target) throw new CliUsageError("actions run requires <domain.action> or <domain> <action>.");

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
    if (!Array.isArray(argsList)) throw new CliUsageError("--args-list-json must be a JSON array.");
    return actionCallStep("result", "run_ade_action", { domain, action, argsList });
  }

  const scalarJson = readValue(args, ["--scalar-json", "--arg-value-json"]);
  if (scalarJson != null) {
    return actionCallStep("result", "run_ade_action", { domain, action, arg: parseJson(scalarJson, "--scalar-json") });
  }

  const scalar = readValue(args, ["--scalar", "--arg-value"]);
  if (scalar != null) {
    return actionCallStep("result", "run_ade_action", { domain, action, arg: parsePrimitive(scalar) });
  }

  return actionStep("result", domain, action, collectGenericObjectArgs(args));
}

function buildWorkerMissionToolPlan(name: string, args: string[]): CliPlan {
  const input = (() => {
    if (name === "get_mission") {
      return collectGenericObjectArgs(args, {
        missionId: readValue(args, ["--mission", "--mission-id"]),
      });
    }
    if (name === "get_run_graph") {
      return collectGenericObjectArgs(args, {
        runId: readValue(args, ["--run", "--run-id"]),
        timelineLimit: readIntOption(args, ["--timeline-limit"], 300),
      });
    }
    if (name === "get_worker_states") {
      return collectGenericObjectArgs(args, {
        runId: readValue(args, ["--run", "--run-id"]),
      });
    }
    if (name === "get_timeline") {
      return collectGenericObjectArgs(args, {
        runId: readValue(args, ["--run", "--run-id"]),
        limit: readIntOption(args, ["--limit"], 300),
        stepId: readValue(args, ["--step", "--step-id"]),
      });
    }
    if (name === "get_pending_messages") {
      return collectGenericObjectArgs(args, {
        since_cursor: readValue(args, ["--since-cursor", "--since"]),
        limit: readIntOption(args, ["--limit"], 50),
      });
    }
    if (name === "stream_events") {
      return collectGenericObjectArgs(args, {
        cursor: readIntOption(args, ["--cursor"], 0),
        limit: readIntOption(args, ["--limit"], 100),
        category: readValue(args, ["--category"]),
      });
    }
    if (name === "message_worker") {
      const toWorkerId = readValue(args, ["--to-worker", "--to-worker-id", "--worker", "--worker-id", "--to"])
        ?? firstPositional(args);
      const content = readValue(args, ["--content", "--message", "--body"])
        ?? args.filter((entry) => entry !== "--" && !entry.startsWith("-")).join(" ").trim();
      return collectGenericObjectArgs(args, {
        fromWorkerId: readValue(args, ["--from-worker", "--from-worker-id", "--from"]),
        toWorkerId,
        content,
        priority: readValue(args, ["--priority"]) ?? "normal",
      });
    }
    return collectGenericObjectArgs(args);
  })();
  return {
    kind: "execute",
    label: `worker mission tool ${name}`,
    formatter: "action-result",
    steps: [actionCallStep("result", name, input)],
  };
}

function buildLanePlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") {
    return { kind: "execute", label: "lane actions", steps: [listActionsStep("actions", "lane")] };
  }
  if (sub === "action") {
    return { kind: "execute", label: "lane action", steps: [buildActionRunStep(["lane", ...args])] };
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
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane status", steps: [actionCallStep("result", "get_lane_status", { laneId })] };
  }
  if (sub === "merge") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane merge", steps: [actionCallStep("result", "merge_lane", collectGenericObjectArgs(args, { laneId, message: readValue(args, ["--message", "-m"]), deleteSourceLane: readFlag(args, ["--delete-source-lane", "--delete-source"]) }))] };
  }
  if (sub === "conflicts") {
    const mode = firstPositional(args) ?? "check";
    if (mode !== "check") return { kind: "execute", label: `lane conflicts ${mode}`, steps: [actionStep("result", "conflicts", mode, collectGenericObjectArgs(args, { laneId: readLaneId(args) }))] };
    const ids = args.filter((entry) => !entry.startsWith("-"));
    return { kind: "execute", label: "lane conflicts check", steps: [actionCallStep("result", "check_conflicts", collectGenericObjectArgs(args, { laneId: readLaneId(args), ...(ids.length ? { laneIds: ids } : {}), force: readFlag(args, ["--force"]) }))] };
  }
  if (sub === "create" || sub === "child") {
    const name = readValue(args, ["--name"]) ?? firstPositional(args);
    const input: JsonObject = {};
    input.name = requireValue(name, "name");
    maybePut(input, "description", readValue(args, ["--description", "--desc"]));
    maybePut(input, "parentLaneId", readValue(args, ["--parent", "--parent-lane", "--parent-lane-id"]) ?? (sub === "child" ? readLaneId(args) : null));
    maybePut(input, "baseBranch", readValue(args, ["--base", "--base-branch"]));
    maybePut(input, "branchName", readValue(args, ["--branch-name"]));
    const linearIssueJson = readValue(args, ["--linear-issue-json"]);
    if (linearIssueJson) {
      const parsed = parseJson(linearIssueJson, "--linear-issue-json");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CliUsageError("--linear-issue-json must decode to a non-null JSON object");
      }
      input.linearIssue = parsed as JsonObject;
    }
    if (sub === "child" && !input.parentLaneId) throw new CliUsageError("parent lane is required. Use --lane <parent> or --parent <parent>.");
    return { kind: "execute", label: "lane create", steps: [actionCallStep("result", "create_lane", collectGenericObjectArgs(args, input))] };
  }
  if (sub === "children") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane children", steps: [actionArgsListStep("result", "lane", "getChildren", [laneId])] };
  }
  if (sub === "stack") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane stack", steps: [actionArgsListStep("result", "lane", "getStackChain", [laneId])] };
  }
  if (sub === "refresh") {
    return { kind: "execute", label: "lane refresh", steps: [actionStep("result", "lane", "refreshSnapshots", collectGenericObjectArgs(args, { includeArchived: readFlag(args, ["--archived", "--include-archived"]) }))] };
  }
  if (sub === "rename") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane rename", steps: [actionStep("result", "lane", "rename", collectGenericObjectArgs(args, { laneId, name: readValue(args, ["--name"]) ?? firstPositional(args) }))] };
  }
  if (sub === "reparent") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane reparent", steps: [actionStep("result", "lane", "reparent", collectGenericObjectArgs(args, { laneId, newParentLaneId: readValue(args, ["--parent", "--parent-lane", "--parent-lane-id"]) ?? firstPositional(args) }))] };
  }
  if (sub === "appearance") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane appearance", steps: [actionStep("result", "lane", "updateAppearance", collectGenericObjectArgs(args, { laneId, color: readValue(args, ["--color"]), icon: readValue(args, ["--icon"]) }))] };
  }
  if (sub === "archive" || sub === "unarchive") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: `lane ${sub}`, steps: [actionStep("result", "lane", sub, collectGenericObjectArgs(args, { laneId }))] };
  }
  if (sub === "delete" || sub === "rm") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane delete", steps: [actionStep("result", "lane", "delete", collectGenericObjectArgs(args, { laneId, force: readFlag(args, ["--force"]), deleteBranch: readFlag(args, ["--delete-branch"]), deleteRemoteBranch: readFlag(args, ["--delete-remote-branch"]) }))] };
  }
  if (sub === "attach") {
    return { kind: "execute", label: "lane attach", steps: [actionStep("result", "lane", "attach", collectGenericObjectArgs(args, { worktreePath: readValue(args, ["--path"]) ?? firstPositional(args), name: readValue(args, ["--name"]) }))] };
  }
  if (sub === "adopt-attached") {
    const laneId = requireValue(readLaneId(args) ?? firstPositional(args), "laneId");
    return { kind: "execute", label: "lane adopt attached", steps: [actionStep("result", "lane", "adoptAttached", collectGenericObjectArgs(args, { laneId }))] };
  }
  if (sub === "split-unstaged") {
    return { kind: "execute", label: "lane split unstaged", steps: [actionStep("result", "lane", "createFromUnstaged", collectGenericObjectArgs(args, { sourceLaneId: readValue(args, ["--source", "--source-lane"]) ?? readLaneId(args), name: readValue(args, ["--name"]) ?? firstPositional(args) }))] };
  }
  if (sub === "import" || sub === "import-branch") {
    const input: JsonObject = {};
    input.branchRef = requireValue(readValue(args, ["--branch", "--branch-ref"]) ?? firstPositional(args), "branchRef");
    maybePut(input, "name", readValue(args, ["--name"]));
    maybePut(input, "description", readValue(args, ["--description", "--desc"]));
    maybePut(input, "baseBranch", readValue(args, ["--base", "--base-branch"]));
    return { kind: "execute", label: "lane import", steps: [actionCallStep("result", "import_lane", collectGenericObjectArgs(args, input))] };
  }
  if (sub === "unregistered" || sub === "list-unregistered") {
    return { kind: "execute", label: "unregistered lanes", steps: [actionCallStep("result", "list_unregistered_lanes", collectGenericObjectArgs(args))] };
  }
  return { kind: "execute", label: `lane ${sub}`, steps: [actionStep("result", "lane", sub, collectGenericObjectArgs(args))] };
}

function buildGitPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "actions") {
    return { kind: "execute", label: "git actions", steps: [listActionsStep("actions", "git")] };
  }
  if (sub === "action") {
    return { kind: "execute", label: "git action", steps: [buildActionRunStep(["git", ...args])] };
  }

  const laneId = readLaneId(args);
  const withLane = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(laneId ? { laneId } : {}) });

  if (sub === "status" || sub === "sync-status") return { kind: "execute", label: "git status", steps: [actionCallStep("result", "git_get_sync_status", withLane())] };
  if (sub === "fetch") return { kind: "execute", label: "git fetch", steps: [actionCallStep("result", "git_fetch", withLane())] };
  if (sub === "pull") return { kind: "execute", label: "git pull", steps: [actionCallStep("result", "git_pull", withLane())] };
  if (sub === "push") {
    const forceWithLease = readFlag(args, ["--force", "--force-with-lease"]);
    const setUpstream = readFlag(args, ["--set-upstream", "-u"]);
    return { kind: "execute", label: "git push", steps: [actionCallStep("result", "git_push", withLane({ forceWithLease, setUpstream }))] };
  }
  if (sub === "commit") {
    const input: JsonObject = {};
    maybePut(input, "message", readValue(args, ["--message", "-m"]));
    maybePut(input, "amend", readFlag(args, ["--amend"]));
    input.stageAll = !readFlag(args, ["--no-stage-all"]);
    return { kind: "execute", label: "git commit", steps: [actionCallStep("result", "commit_changes", withLane(input))] };
  }
  if (sub === "generate-message") {
    return { kind: "execute", label: "git commit message", steps: [actionCallStep("result", "generate_commit_message", withLane({ amend: readFlag(args, ["--amend"]) }))] };
  }
  if (sub === "branches" || sub === "branch") return { kind: "execute", label: "git branches", steps: [actionCallStep("result", "git_list_branches", withLane())] };
  if (sub === "user-identity" || sub === "user" || sub === "identity") {
    return { kind: "execute", label: "git user identity", steps: [actionCallStep("result", "git_get_user_identity", withLane())] };
  }
  if (sub === "checkout") {
    const branchName = requireValue(readValue(args, ["--branch", "--branch-name"]) ?? firstPositional(args), "branchName");
    const create = readFlag(args, ["--create", "-b"]);
    const startPoint = readValue(args, ["--start-point", "--from"]);
    const baseRef = readValue(args, ["--base", "--base-ref"]);
    const acknowledgeActiveWork = readFlag(args, ["--ack-active-work"]);
    return {
      kind: "execute",
      label: "git checkout",
      steps: [actionCallStep("result", "git_checkout_branch", withLane({
        branchName,
        mode: create ? "create" : "existing",
        ...(startPoint ? { startPoint } : {}),
        ...(baseRef ? { baseRef } : {}),
        acknowledgeActiveWork,
      }))]
    };
  }
  if (sub === "conflicts") return { kind: "execute", label: "git conflicts", steps: [actionCallStep("result", "get_lane_conflict_state", withLane())] };
  if (sub === "rebase") {
    const mode = firstPositional(args);
    if (mode === "continue") return { kind: "execute", label: "rebase continue", steps: [actionCallStep("result", "rebase_continue", withLane())] };
    if (mode === "abort") return { kind: "execute", label: "rebase abort", steps: [actionCallStep("result", "rebase_abort", withLane())] };
    return { kind: "execute", label: "rebase lane", steps: [actionCallStep("result", "rebase_lane", withLane({ aiAssisted: readFlag(args, ["--ai", "--ai-assisted"]) }))] };
  }
  if (sub === "merge") {
    const mode = requireValue(firstPositional(args), "merge action");
    if (mode !== "continue" && mode !== "abort") throw new CliUsageError("git merge supports continue or abort.");
    return { kind: "execute", label: `merge ${mode}`, steps: [actionStep("result", "git", mode === "continue" ? "mergeContinue" : "mergeAbort", withLane())] };
  }
  if (sub === "stash") {
    const action = firstPositional(args) ?? "list";
    const stashRef = readValue(args, ["--ref", "--stash-ref"]) ?? firstPositional(args);
    const message = readValue(args, ["--message", "-m"]);
    const common = withLane({
      ...(stashRef ? { stashRef } : {}),
      includeUntracked: !readFlag(args, ["--tracked-only"]),
      ...(message ? { message } : {}),
    });
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
    return { kind: "execute", label: `git stash ${action}`, steps: [actionCallStep("result", toolName, common)] };
  }
  if (sub === "diff") {
    return buildDiffPlan([...(laneId ? ["--lane", laneId] : []), ...args]);
  }

  if (sub === "stage" || sub === "unstage" || sub === "discard" || sub === "restore") {
    const pathArg = requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path");
    const actionBySub: Record<string, string> = {
      stage: "stageFile",
      unstage: "unstageFile",
      discard: "discardFile",
      restore: "restoreStagedFile",
    };
    return { kind: "execute", label: `git ${sub}`, steps: [actionStep("result", "git", actionBySub[sub]!, withLane({ path: pathArg }))] };
  }
  if (sub === "stage-all" || sub === "unstage-all") {
    const paths = args.filter((entry) => !entry.startsWith("-"));
    const action = sub === "stage-all" ? "stageAll" : "unstageAll";
    return { kind: "execute", label: `git ${sub}`, steps: [actionStep("result", "git", action, withLane({ paths }))] };
  }
  if (sub === "files" || sub === "commit-files") {
    const commitSha = requireValue(readValue(args, ["--commit", "--sha"]) ?? firstPositional(args), "commitSha");
    return { kind: "execute", label: "git commit files", steps: [actionStep("result", "git", "listCommitFiles", withLane({ commitSha }))] };
  }
  if (sub === "message" || sub === "commit-message" || sub === "show-message") {
    const commitSha = readValue(args, ["--commit", "--sha"]) ?? firstPositional(args);
    if (commitSha) return { kind: "execute", label: "git commit message", steps: [actionStep("result", "git", "getCommitMessage", withLane({ commitSha }))] };
    return { kind: "execute", label: "git commit message", steps: [actionCallStep("result", "generate_commit_message", withLane({ amend: readFlag(args, ["--amend"]) }))] };
  }
  if (sub === "history" || sub === "file-history") {
    const filePath = requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path");
    return { kind: "execute", label: "git file history", steps: [actionStep("result", "git", "getFileHistory", withLane({ path: filePath, limit: readIntOption(args, ["--limit"]) }))] };
  }
  if (sub === "revert" || sub === "cherry-pick") {
    const commitSha = requireValue(readValue(args, ["--commit", "--sha"]) ?? firstPositional(args), "commitSha");
    return { kind: "execute", label: `git ${sub}`, steps: [actionStep("result", "git", sub === "revert" ? "revertCommit" : "cherryPickCommit", withLane({ commitSha }))] };
  }
  const actionAliases: Record<string, string> = {
    commits: "listRecentCommits",
    sync: "sync",
  };
  return { kind: "execute", label: `git ${sub}`, steps: [actionStep("result", "git", actionAliases[sub] ?? sub, withLane())] };
}

function buildDiffPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "changes";
  if (sub === "actions") return { kind: "execute", label: "diff actions", steps: [listActionsStep("actions", "diff")] };
  const laneId = readLaneId(args);
  const withLane = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(laneId ? { laneId } : {}) });
  if (sub === "changes" || sub === "summary") {
    const id = requireValue(laneId ?? readValue(args, ["--lane", "--lane-id"]), "laneId");
    return {
      kind: "execute",
      label: "diff changes",
      steps: [actionArgsListStep("result", "diff", "getChanges", [id])],
    };
  }
  if (sub === "file") {
    const filePath = requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path");
    return {
      kind: "execute",
      label: "diff file",
      steps: [actionStep("result", "diff", "getFileDiff", withLane({
        filePath,
        mode: readValue(args, ["--mode"]) ?? "unstaged",
        compareRef: readValue(args, ["--compare-ref", "--base"]),
        compareTo: readValue(args, ["--compare-to", "--head"]),
      }))],
    };
  }
  if (sub === "patch") {
    const filePath = requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path");
    return {
      kind: "execute",
      label: "diff patch",
      steps: [actionStep("result", "diff", "getFilePatch", withLane({
        filePath,
        mode: readValue(args, ["--mode"]) ?? "unstaged",
        compareRef: readValue(args, ["--compare-ref", "--base"]),
        compareTo: readValue(args, ["--compare-to", "--head"]),
      }))],
    };
  }
  return { kind: "execute", label: `diff ${sub}`, steps: [actionStep("result", "diff", sub, withLane())] };
}

function buildPrPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") return { kind: "execute", label: "PR actions", steps: [listActionsStep("actions", "pr")] };
  if (sub === "action") return { kind: "execute", label: "PR action", steps: [buildActionRunStep(["pr", ...args])] };

  const prId = readPrId(args);
  const withPr = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(prId ? { prId } : {}) });

  if (sub === "list" || sub === "ls") return { kind: "execute", label: "PR list", steps: [actionStep("result", "pr", "listAll", collectGenericObjectArgs(args))] };
  if (sub === "list-open" || sub === "open" || sub === "list-repo-open") {
    return { kind: "execute", label: "PR list open", steps: [actionCallStep("result", "prs_list_open", {})] };
  }
  if (sub === "show" || sub === "detail" || sub === "view") {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR detail", steps: [actionArgsListStep("result", "pr", "getDetail", [id])] };
  }
  if (sub === "refresh") return { kind: "execute", label: "PR refresh", steps: [actionStep("result", "pr", "refresh", withPr({ prId: prId ?? firstPositional(args) }))] };
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
    return { kind: "execute", label: "PR create", steps: [actionCallStep("result", "create_pr_from_lane", collectGenericObjectArgs(args, input))] };
  }
  if (sub === "health") return { kind: "execute", label: "PR health", steps: [actionCallStep("result", "get_pr_health", withPr({ prId: prId ?? firstPositional(args) }))] };
  if (sub === "checks") return { kind: "execute", label: "PR checks", steps: [actionCallStep("result", "pr_get_checks", withPr({ prId: requireValue(prId ?? firstPositional(args), "prId") }))] };
  if (sub === "comments" || sub === "review-comments") return { kind: "execute", label: "PR comments", steps: [actionCallStep("result", "pr_get_review_comments", withPr({ prId: requireValue(prId ?? firstPositional(args), "prId") }))] };
  if (sub === "rerun" || sub === "rerun-failed-checks") return { kind: "execute", label: "PR rerun failed checks", steps: [actionCallStep("result", "pr_rerun_failed_checks", withPr({ prId: prId ?? firstPositional(args) }))] };
  if (sub === "comment") return { kind: "execute", label: "PR comment", steps: [actionCallStep("result", "pr_add_comment", withPr({ prId: prId ?? firstPositional(args), body: readValue(args, ["--body"]) }))] };
  if (sub === "reply") return { kind: "execute", label: "PR thread reply", steps: [actionCallStep("result", "pr_reply_to_review_thread", withPr({ prId: prId ?? firstPositional(args), threadId: readValue(args, ["--thread", "--thread-id"]), body: readValue(args, ["--body"]) }))] };
  if (sub === "resolve-thread") return { kind: "execute", label: "PR resolve thread", steps: [actionCallStep("result", "pr_resolve_review_thread", withPr({ prId: requireValue(prId ?? firstPositional(args), "prId"), threadId: requireValue(readValue(args, ["--thread", "--thread-id"]), "threadId") }))] };
  if (sub === "title" || sub === "update-title") return { kind: "execute", label: "PR update title", steps: [actionCallStep("result", "pr_update_title", withPr({ prId: prId ?? firstPositional(args), title: readValue(args, ["--title"]) }))] };
  if (sub === "body" || sub === "update-body") return { kind: "execute", label: "PR update body", steps: [actionCallStep("result", "pr_update_body", withPr({ prId: prId ?? firstPositional(args), body: readValue(args, ["--body"]) ?? "" }))] };
  if (sub === "link") {
    const laneId = readLaneId(args) ?? firstPositional(args);
    const prUrlOrNumber =
      readValue(args, ["--url", "--pr-url", "--number", "--pr-number"])
      ?? firstPositional(args);
    return {
      kind: "execute",
      label: "PR link",
      steps: [
        actionStep("result", "pr", "linkToLane", collectGenericObjectArgs(args, {
          laneId: requireValue(laneId, "laneId"),
          prUrlOrNumber: requireValue(prUrlOrNumber, "prUrlOrNumber"),
        })),
      ],
    };
  }

  const scalarPrActions: Record<string, string> = {
    status: "getStatus",
    files: "getFiles",
    "action-runs": "getActionRuns",
    activity: "getActivity",
    reviews: "getReviews",
    threads: "getReviewThreads",
    deployments: "getDeployments",
    github: "openInGitHub",
    "conflict-analysis": "getConflictAnalysis",
    "merge-context": "getMergeContext",
  };
  if (scalarPrActions[sub]) {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: `PR ${sub}`, steps: [actionArgsListStep("result", "pr", scalarPrActions[sub]!, [id])] };
  }
  if (sub === "draft-description") return { kind: "execute", label: "PR draft description", steps: [actionStep("result", "pr", "draftDescription", collectGenericObjectArgs(args, { laneId: readLaneId(args) ?? firstPositional(args) }))] };
  if (sub === "update-description") return { kind: "execute", label: "PR update description", steps: [actionStep("result", "pr", "updateDescription", withPr({ prId: prId ?? firstPositional(args), title: readValue(args, ["--title"]), body: readValue(args, ["--body"]) }))] };
  if (sub === "delete" || sub === "land" || sub === "close" || sub === "reopen") {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    const actionBySub: Record<string, string> = { delete: "delete", land: "land", close: "closePr", reopen: "reopenPr" };
    return { kind: "execute", label: `PR ${sub}`, steps: [actionStep("result", "pr", actionBySub[sub]!, collectGenericObjectArgs(args, { prId: id, method: readValue(args, ["--method"]) }))] };
  }
  if (sub === "land-stack" || sub === "land-stack-enhanced") {
    return { kind: "execute", label: `PR ${sub}`, steps: [actionStep("result", "pr", sub === "land-stack" ? "landStack" : "landStackEnhanced", collectGenericObjectArgs(args, { rootLaneId: readValue(args, ["--root", "--root-lane"]) ?? firstPositional(args) }))] };
  }
  if (sub === "labels") {
    const mode = firstPositional(args) ?? "set";
    if (mode !== "set") throw new CliUsageError("prs labels supports set.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR labels set", steps: [actionStep("result", "pr", "setLabels", collectGenericObjectArgs(args, { prId: id, labels: args.filter((entry) => !entry.startsWith("-")) }))] };
  }
  if (sub === "reviewers") {
    const mode = firstPositional(args) ?? "request";
    if (mode !== "request") throw new CliUsageError("prs reviewers supports request.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR reviewers request", steps: [actionStep("result", "pr", "requestReviewers", collectGenericObjectArgs(args, { prId: id, reviewers: args.filter((entry) => !entry.startsWith("-")) }))] };
  }
  if (sub === "review") {
    const mode = firstPositional(args) ?? "submit";
    if (mode !== "submit") throw new CliUsageError("prs review supports submit.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR review submit", steps: [actionStep("result", "pr", "submitReview", collectGenericObjectArgs(args, { prId: id, event: readValue(args, ["--event"]) ?? "comment", body: readValue(args, ["--body"]) ?? "" }))] };
  }
  if (sub === "comment-react") {
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR comment react", steps: [actionStep("result", "pr", "reactToComment", collectGenericObjectArgs(args, { prId: id, commentId: readValue(args, ["--comment", "--comment-id"]), content: readValue(args, ["--content"]) }))] };
  }
  if (sub === "review-comment") {
    const mode = firstPositional(args) ?? "post";
    if (mode !== "post") throw new CliUsageError("prs review-comment supports post.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR review comment post", steps: [actionStep("result", "pr", "postReviewComment", collectGenericObjectArgs(args, { prId: id, threadId: readValue(args, ["--thread", "--thread-id"]), body: readValue(args, ["--body"]) }))] };
  }
  if (sub === "thread") {
    const mode = firstPositional(args) ?? "set-resolved";
    if (mode !== "set-resolved") throw new CliUsageError("prs thread supports set-resolved.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    return { kind: "execute", label: "PR thread set resolved", steps: [actionStep("result", "pr", "setReviewThreadResolved", collectGenericObjectArgs(args, { prId: id, threadId: readValue(args, ["--thread", "--thread-id"]), resolved: !readFlag(args, ["--unresolved"]) }))] };
  }
  if (sub === "ai-review-summary") return { kind: "execute", label: "PR AI review summary", steps: [actionStep("result", "pr", "aiReviewSummary", withPr({ prId: prId ?? firstPositional(args) }))] };
  if (sub === "mobile-snapshot") return { kind: "execute", label: "PR mobile snapshot", steps: [actionArgsListStep("result", "pr", "getMobileSnapshot", [])] };
  if (sub === "snapshots") {
    const mode = firstPositional(args) ?? "list";
    const action = mode === "refresh" ? "refreshSnapshots" : "listSnapshots";
    return { kind: "execute", label: `PR snapshots ${mode}`, steps: [actionStep("result", "pr", action, withPr({ prId: prId ?? firstPositional(args) }))] };
  }
  if (sub === "github-snapshot") return { kind: "execute", label: "PR GitHub snapshot", steps: [actionStep("result", "pr", "getGithubSnapshot", collectGenericObjectArgs(args, { force: readFlag(args, ["--force"]) }))] };
  if (sub === "conflicts") {
    const mode = firstPositional(args) ?? "list";
    if (mode === "list") return { kind: "execute", label: "PR conflicts list", steps: [actionArgsListStep("result", "pr", "listWithConflicts", [])] };
    const id = requireValue(prId ?? firstPositional(args), "prId");
    const action = mode === "analysis" ? "getConflictAnalysis" : "getMergeContext";
    return { kind: "execute", label: `PR conflicts ${mode}`, steps: [actionArgsListStep("result", "pr", action, [id])] };
  }

  if (sub === "path-to-merge" || sub === "resolve" || sub === "issue-resolution") {
    let mode = "start";
    let positionalPrId = firstPositional(args);
    if (positionalPrId === "start" || positionalPrId === "preview") {
      mode = positionalPrId;
      positionalPrId = firstPositional(args);
    }
    const id = requireValue(prId ?? positionalPrId, "prId");
    const scope = readValue(args, ["--scope"]) ?? "both";
    const modelId = requireValue(readValue(args, ["--model", "--model-id"]), "--model");
    const input: JsonObject = {
      prId: id,
      scope,
      modelId,
    };
    maybePut(input, "reasoning", readValue(args, ["--reasoning"]));
    maybePut(input, "permissionMode", readValue(args, ["--permission-mode", "--permissions"]));
    maybePut(input, "additionalInstructions", readValue(args, ["--instructions", "--additional-instructions"]));
    // Path to Merge orchestrator reads conflictStrategy / forceFinalizeMode /
    // earlyMergeOnGreen / autoMerge / maxRounds / mergeMethod from saved
    // PipelineSettings, not from the launch args. Persist any user-supplied
    // overrides before the resolver step so the loop picks them up.
    const pipelinePatch = readPipelineSettingsPatch(args);
    const steps: InvocationStep[] = [];
    if (Object.keys(pipelinePatch).length > 0) {
      steps.push(actionArgsListStep("pipelineSettings", "issue_inventory", "savePipelineSettings", [
        id,
        pipelinePatch,
      ]));
    }
    if (mode === "preview") {
      steps.push(actionCallStep("result", "pr_preview_issue_resolution_prompt", collectGenericObjectArgs(args, input)));
    } else {
      steps.push(actionStep("result", "path_to_merge", "startPathToMerge", collectGenericObjectArgs(args, input)));
    }
    return { kind: "execute", label: `PR path-to-merge ${mode}`, steps };
  }

  if (sub === "pipeline") {
    const mode = firstPositional(args) ?? "get";
    const id = requireValue(prId ?? firstPositional(args), "prId");
    if (mode === "get") return { kind: "execute", label: "PR pipeline", steps: [actionArgsListStep("result", "issue_inventory", "getPipelineSettings", [id])] };
    if (mode === "delete") return { kind: "execute", label: "PR pipeline delete", steps: [actionArgsListStep("result", "issue_inventory", "deletePipelineSettings", [id])] };
    const settings = collectGenericObjectArgs(args, readPipelineSettingsPatch(args));
    return { kind: "execute", label: "PR pipeline save", steps: [actionArgsListStep("result", "issue_inventory", "savePipelineSettings", [id, settings])] };
  }

  if (sub === "queue") {
    const mode = firstPositional(args) ?? "create";
    if (mode === "state" || mode === "list") {
      const groupId = requireValue(readValue(args, ["--group", "--group-id"]) ?? firstPositional(args), "groupId");
      return { kind: "execute", label: `queue ${mode}`, steps: [actionArgsListStep("result", "pr", mode === "state" ? "getQueueState" : "listGroupPrs", [groupId])] };
    }
    if (mode === "reorder") {
      return { kind: "execute", label: "queue reorder", steps: [actionStep("result", "pr", "reorderQueuePrs", collectGenericObjectArgs(args, { groupId: readValue(args, ["--group", "--group-id"]) ?? firstPositional(args) }))] };
    }
    if (mode === "land-next") {
      return { kind: "execute", label: "queue land next", steps: [actionCallStep("result", "land_queue_next", collectGenericObjectArgs(args, { groupId: readValue(args, ["--group", "--group-id"]) ?? firstPositional(args), method: readValue(args, ["--method"]) ?? "squash" }))] };
    }
    return { kind: "execute", label: "queue create", steps: [actionCallStep("result", "create_queue", collectGenericObjectArgs(args))] };
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
      return { kind: "execute", label: `integration ${mode}`, steps: [actionStep("result", "pr", integrationMap[mode]!, collectGenericObjectArgs(args))] };
    }
    if (mode === "lane") {
      const laneMode = firstPositional(args) ?? "create";
      if (laneMode !== "create") throw new CliUsageError("prs integration lane supports create.");
      return { kind: "execute", label: "integration lane create", steps: [actionStep("result", "pr", "createIntegrationLane", collectGenericObjectArgs(args))] };
    }
    if (mode === "cleanup") {
      const cleanupMode = firstPositional(args) ?? "run";
      return { kind: "execute", label: `integration cleanup ${cleanupMode}`, steps: [actionStep("result", "pr", cleanupMode === "dismiss" ? "dismissIntegrationCleanup" : "cleanupIntegrationWorkflow", collectGenericObjectArgs(args))] };
    }
    const tool = mode === "create" ? "create_integration" : "simulate_integration";
    return { kind: "execute", label: `integration ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args))] };
  }

  if (sub === "inventory") {
    const first = firstPositional(args);
    const knownModes = new Set(["refresh", "get", "new", "mark-sent", "mark-fixed", "dismiss", "escalate", "reset"]);
    const mode = first && knownModes.has(first) ? first : "refresh";
    const positionalPrId = mode === "refresh" ? first : firstPositional(args);
    if (mode === "refresh") {
      return { kind: "execute", label: "PR inventory", steps: [actionCallStep("result", "pr_refresh_issue_inventory", withPr({ prId: requireValue(prId ?? positionalPrId, "prId") }))] };
    }
    const actionByMode: Record<string, string> = {
      get: "getInventory",
      new: "getNewItems",
      "mark-sent": "markSentToAgent",
      "mark-fixed": "markFixed",
      dismiss: "markDismissed",
      escalate: "markEscalated",
      reset: "resetInventory",
    };
    const action = actionByMode[mode];
    if (!action) throw new CliUsageError("prs inventory supports get, new, mark-sent, mark-fixed, dismiss, escalate, or reset.");
    const id = requireValue(prId ?? positionalPrId, "prId");
    const itemIds = args.filter((entry) => !entry.startsWith("-"));
    const argsListByMode: Record<string, unknown[]> = {
      get: [id],
      new: [id],
      "mark-sent": [id, itemIds, readValue(args, ["--session", "--session-id"]) ?? "", readIntOption(args, ["--round"], 0) ?? 0],
      "mark-fixed": [id, itemIds],
      dismiss: [id, itemIds, readValue(args, ["--reason"]) ?? ""],
      escalate: [id, itemIds],
      reset: [id],
    };
    return { kind: "execute", label: `PR inventory ${mode}`, steps: [actionArgsListStep("result", "issue_inventory", action, argsListByMode[mode] ?? [id])] };
  }

  if (sub === "convergence") {
    const mode = firstPositional(args) ?? "status";
    const actionByMode: Record<string, string> = {
      status: "getConvergenceStatus",
      runtime: "getConvergenceRuntime",
      get: "getConvergenceRuntime",
      save: "saveConvergenceRuntime",
      reset: "resetConvergenceRuntime",
      reconcile: "reconcileConvergenceSessionExit",
    };
    const action = actionByMode[mode];
    if (!action) throw new CliUsageError("prs convergence supports status, runtime, save, reset, or reconcile.");
    const id = requireValue(prId ?? firstPositional(args), "prId");
    if (mode === "save") {
      return { kind: "execute", label: "PR convergence save", steps: [actionArgsListStep("result", "issue_inventory", action, [id, collectGenericObjectArgs(args)])] };
    }
    if (mode === "reconcile") {
      return { kind: "execute", label: "PR convergence reconcile", steps: [actionStep("result", "issue_inventory", action, collectGenericObjectArgs(args, { prId: id }))] };
    }
    return { kind: "execute", label: `PR convergence ${mode}`, steps: [actionArgsListStep("result", "issue_inventory", action, [id])] };
  }

  return { kind: "execute", label: `PR ${sub}`, steps: [actionStep("result", "pr", sub, withPr())] };
}

function collectMissionCreateArgs(args: string[], base: JsonObject = {}): JsonObject {
  const noAutostart = readFlag(args, ["--no-autostart", "--no-start"]);
  const autostartFlag = readFlag(args, ["--autostart"]);
  const manual = readFlag(args, ["--manual"]);
  const prompt = readValue(args, ["--prompt", "--message"]);
  const createBase: JsonObject = { ...base };
  if (noAutostart) createBase.autostart = false;
  if (autostartFlag) createBase.autostart = true;
  if (manual) createBase.launchMode = "manual";
  const input = collectGenericObjectArgs(args, {
    ...createBase,
    ...(prompt ? { prompt } : {}),
    title: readValue(args, ["--title"]),
    laneId: readLaneId(args),
    priority: readValue(args, ["--priority"]),
    executionMode: readValue(args, ["--execution-mode"]),
    targetMachineId: readValue(args, ["--target-machine", "--target-machine-id"]),
    plannerEngine: readValue(args, ["--planner", "--planner-engine"]),
    planningTimeoutMs: readIntOption(args, ["--planning-timeout-ms"]),
    launchMode: readValue(args, ["--launch-mode", "--run-mode"]) ?? createBase.launchMode,
    autopilotExecutor: readValue(args, ["--executor", "--autopilot-executor", "--default-executor"]),
    autostart: createBase.autostart,
    phaseProfileId: readValue(args, ["--phase-profile", "--phase-profile-id"]),
    employeeAgentId: readValue(args, ["--employee-agent", "--employee-agent-id"]),
  });

  const phaseOverride = readJsonPayloadOption(args, ["--phase-override-json"], ["--phase-override-file"], "--phase-override-json");
  if (phaseOverride !== undefined) {
    if (!Array.isArray(phaseOverride)) throw new CliUsageError("--phase-override-json must be a JSON array.");
    input.phaseOverride = phaseOverride;
  }

  const plannedSteps = readJsonPayloadOption(args, ["--planned-steps-json"], ["--planned-steps-file"], "--planned-steps-json");
  if (plannedSteps !== undefined) {
    if (!Array.isArray(plannedSteps)) throw new CliUsageError("--planned-steps-json must be a JSON array.");
    input.plannedSteps = plannedSteps;
  }

  const jsonObjects: Array<[string, string[], string[], string]> = [
    ["modelConfig", ["--model-config-json"], ["--model-config-file"], "--model-config-json"],
    ["executionPolicy", ["--execution-policy-json"], ["--execution-policy-file"], "--execution-policy-json"],
    ["recoveryLoop", ["--recovery-loop-json"], ["--recovery-loop-file"], "--recovery-loop-json"],
    ["teamRuntime", ["--team-runtime-json"], ["--team-runtime-file"], "--team-runtime-json"],
    ["agentRuntime", ["--agent-runtime-json"], ["--agent-runtime-file"], "--agent-runtime-json"],
    ["permissionConfig", ["--permission-config-json"], ["--permission-config-file"], "--permission-config-json"],
  ];
  for (const [key, inlineNames, fileNames, label] of jsonObjects) {
    const value = readJsonPayloadOption(args, inlineNames, fileNames, label);
    if (value === undefined) continue;
    if (!isRecord(value)) throw new CliUsageError(`${label} must be a JSON object.`);
    input[key] = value;
  }

  if (!asString(input.prompt)) {
    const positionalPrompt = args.filter((entry) => entry !== "--" && !entry.startsWith("-")).join(" ").trim();
    if (positionalPrompt.length > 0) input.prompt = positionalPrompt;
  }
  input.prompt = requireValue(asString(input.prompt) ?? null, "prompt");
  return input;
}

function collectMissionStartArgs(args: string[], base: JsonObject = {}): JsonObject {
  const manual = readFlag(args, ["--manual"]);
  const runMode = manual ? "manual" : readValue(args, ["--run-mode", "--launch-mode"]);
  const executor = readValue(args, ["--executor", "--default-executor", "--executor-kind"]);
  const owner = readValue(args, ["--owner", "--owner-id", "--autopilot-owner"]);
  const input: JsonObject = { ...base };
  if (runMode) input.runMode = runMode;
  if (executor ?? base.defaultExecutorKind) input.defaultExecutorKind = executor ?? base.defaultExecutorKind;
  if (owner) input.autopilotOwnerId = owner;
  return collectGenericObjectArgs(args, input);
}

function buildMissionsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") return { kind: "execute", label: "mission actions", steps: [listActionsStep("actions", "mission")] };
  if (sub === "action") return { kind: "execute", label: "mission action", steps: [buildActionRunStep(["mission", ...args])] };

  if (sub === "list" || sub === "ls") {
    return {
      kind: "execute",
      label: "mission list",
      formatter: "mission-list",
      steps: [actionStep("result", "mission", "list", collectGenericObjectArgs(args, {
        status: readValue(args, ["--status"]),
        laneId: readLaneId(args),
        limit: readIntOption(args, ["--limit"]),
        includeArchived: readFlag(args, ["--include-archived"]),
      }))],
    };
  }

  if (sub === "create" || sub === "new") {
    return {
      kind: "execute",
      label: "mission create",
      formatter: "mission-detail",
      steps: [actionStep("result", "mission", "create", collectMissionCreateArgs(args))],
    };
  }

  if (sub === "launch") {
    const waitUntilTerminal = readFlag(args, ["--wait", "--until-terminal", "--wait-until-terminal"]);
    const waitMs = readIntOption(args, ["--wait-ms", "--hold-ms", "--wait-for-ms"], waitUntilTerminal ? 30 * 60 * 1000 : undefined);
    const timelineLimit = readIntOption(args, ["--timeline-limit"], 120) ?? 120;
    const createArgs = collectMissionCreateArgs(args, { autostart: false });
    const startArgs = collectMissionStartArgs(args, {
      runMode: createArgs.launchMode === "manual" ? "manual" : undefined,
      defaultExecutorKind: createArgs.autopilotExecutor,
    });
    const waitGraphStep = waitRunGraphStep({
      key: "graph",
      runId: (values) => requireValue(asString(runFromStartResult(values.started)?.id) ?? null, "run id"),
      waitMs,
      untilTerminal: waitUntilTerminal,
      timelineLimit,
    });
    const steps: InvocationStep[] = [
      actionStep("created", "mission", "create", createArgs),
      {
        ...actionStep("started", "orchestrator", "startMissionRun", {}),
        params: (values) => ({
          name: "run_ade_action",
          arguments: {
            domain: "orchestrator",
            action: "startMissionRun",
            args: {
              ...startArgs,
              missionId: missionIdFromCreateResult(values.created),
            },
          },
        }),
      },
    ];
    if (waitGraphStep) {
      steps.push({
        ...actionScalarStep("mission", "mission", "get", ""),
        optional: true,
        params: (values) => ({
          name: "run_ade_action",
          arguments: {
            domain: "mission",
            action: "get",
            arg: missionIdFromCreateResult(values.created),
          },
        }),
      });
      steps.push(waitGraphStep);
    }
    return {
      kind: "execute",
      label: "mission launch",
      formatter: "mission-watch",
      steps,
    };
  }

  if (sub === "start" || sub === "run") {
    const missionId = requireValue(readValue(args, ["--mission", "--mission-id"]) ?? firstPositional(args), "missionId");
    return {
      kind: "execute",
      label: "mission start",
      formatter: "mission-watch",
      steps: [actionStep("result", "orchestrator", "startMissionRun", collectMissionStartArgs(args, { missionId }))],
    };
  }

  if (sub === "show" || sub === "get" || sub === "view") {
    const missionId = requireValue(readValue(args, ["--mission", "--mission-id"]) ?? firstPositional(args), "missionId");
    return {
      kind: "execute",
      label: "mission show",
      formatter: "mission-detail",
      steps: [actionScalarStep("result", "mission", "get", missionId)],
    };
  }

  if (sub === "runs" || sub === "attempts") {
    const missionId = readValue(args, ["--mission", "--mission-id"]) ?? firstPositional(args);
    return {
      kind: "execute",
      label: "mission runs",
      formatter: "mission-runs",
      steps: [actionStep("result", "orchestrator_core", "listRuns", collectGenericObjectArgs(args, {
        missionId: missionId ?? undefined,
        status: readValue(args, ["--status"]),
        limit: readIntOption(args, ["--limit"], 20),
      }))],
    };
  }

  if (sub === "graph" || sub === "run-graph") {
    const runId = requireValue(readValue(args, ["--run", "--run-id"]) ?? firstPositional(args), "runId");
    return {
      kind: "execute",
      label: "mission graph",
      formatter: "mission-graph",
      steps: [actionStep("result", "orchestrator_core", "getRunGraph", collectGenericObjectArgs(args, {
        runId,
        timelineLimit: readIntOption(args, ["--timeline-limit"], 80),
      }))],
    };
  }

  if (sub === "watch" || sub === "monitor") {
    const waitUntilTerminal = readFlag(args, ["--wait", "--until-terminal", "--wait-until-terminal"]);
    const waitMs = readIntOption(args, ["--wait-ms", "--hold-ms", "--wait-for-ms"], waitUntilTerminal ? 30 * 60 * 1000 : undefined);
    const runId = readValue(args, ["--run", "--run-id"]);
    const missionId = readValue(args, ["--mission", "--mission-id"]) ?? (runId ? null : firstPositional(args));
    const timelineLimit = readIntOption(args, ["--timeline-limit"], 80) ?? 80;
    const steps: InvocationStep[] = [];
    if (missionId) {
      steps.push(actionScalarStep("mission", "mission", "get", missionId));
      steps.push(actionStep("runs", "orchestrator_core", "listRuns", { missionId, limit: readIntOption(args, ["--limit"], 20) }));
    }
    const waitGraphStep = waitRunGraphStep({
      key: "graph",
      runId: (values) => runId ?? runIdFromWatchValues(values),
      waitMs,
      untilTerminal: waitUntilTerminal,
      timelineLimit,
    });
    if (waitGraphStep) {
      steps.push(waitGraphStep);
    } else {
      steps.push({
        ...actionStep("graph", "orchestrator_core", "getRunGraph", {}),
        optional: !runId,
        params: (values) => ({
          name: "run_ade_action",
          arguments: {
            domain: "orchestrator_core",
            action: "getRunGraph",
            args: {
              runId: runId ?? runIdFromWatchValues(values),
              timelineLimit,
            },
          },
        }),
      });
    }
    return {
      kind: "execute",
      label: "mission watch",
      formatter: "mission-watch",
      steps,
    };
  }

  if (sub === "pause") {
    const runId = requireValue(readValue(args, ["--run", "--run-id"]) ?? firstPositional(args), "runId");
    return { kind: "execute", label: "mission pause", formatter: "mission-graph", steps: [actionStep("result", "orchestrator_core", "pauseRun", collectGenericObjectArgs(args, { runId, reason: readValue(args, ["--reason"]) }))] };
  }

  if (sub === "resume") {
    const runId = requireValue(readValue(args, ["--run", "--run-id"]) ?? firstPositional(args), "runId");
    const waitUntilTerminal = readFlag(args, ["--wait", "--until-terminal", "--wait-until-terminal"]);
    const waitMs = readIntOption(args, ["--wait-ms", "--hold-ms", "--wait-for-ms"], waitUntilTerminal ? 30 * 60 * 1000 : undefined);
    const steps: InvocationStep[] = [
      actionStep("result", "orchestrator", "resumeRun", collectGenericObjectArgs(args, { runId })),
    ];
    const waitGraphStep = waitRunGraphStep({
      key: "graph",
      runId,
      waitMs,
      untilTerminal: waitUntilTerminal,
      timelineLimit: readIntOption(args, ["--timeline-limit"], 120) ?? 120,
    });
    if (waitGraphStep) steps.push(waitGraphStep);
    return {
      kind: "execute",
      label: "mission resume",
      formatter: waitGraphStep ? "mission-watch" : "mission-graph",
      steps,
    };
  }

  if (sub === "cancel") {
    const runId = requireValue(readValue(args, ["--run", "--run-id"]) ?? readValue(args, ["--mission", "--mission-id"]) ?? firstPositional(args), "runId");
    return { kind: "execute", label: "mission cancel", formatter: "mission-detail", steps: [actionStep("result", "orchestrator", "cancelRunGracefully", collectGenericObjectArgs(args, { runId, reason: readValue(args, ["--reason"]) }))] };
  }

  return { kind: "execute", label: `mission ${sub}`, steps: [actionStep("result", "mission", sub, collectGenericObjectArgs(args))] };
}

function buildRunPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "ps";
  if (sub === "actions") return { kind: "execute", label: "run actions", steps: [listActionsStep("actions", "process")] };
  if (sub === "action") return { kind: "execute", label: "run action", steps: [buildActionRunStep(["process", ...args])] };
  if (sub === "defs" || sub === "definitions") return { kind: "execute", label: "process definitions", steps: [actionStep("result", "process", "listDefinitions", collectGenericObjectArgs(args))] };
  const laneId = readLaneId(args);
  const processId = readValue(args, ["--process", "--process-id"]) ?? firstPositional(args);
  const runId = readValue(args, ["--run", "--run-id"]);
  const withProcess = (base: JsonObject = {}) => collectGenericObjectArgs(args, {
    ...base,
    ...(laneId ? { laneId } : {}),
    ...(processId ? { processId } : {}),
    ...(runId ? { runId } : {}),
  });
  if (sub === "ps" || sub === "list" || sub === "runtime") {
    const id = requireValue(laneId, "laneId");
    return { kind: "execute", label: "process runtime", steps: [actionArgsListStep("result", "process", "listRuntime", [id])] };
  }
  if (sub === "start" || sub === "stop" || sub === "restart" || sub === "kill") {
    return { kind: "execute", label: `process ${sub}`, steps: [actionStep("result", "process", sub, withProcess({ laneId: requireValue(laneId, "laneId"), processId: requireValue(processId, "processId") }))] };
  }
  if (sub === "logs" || sub === "log") {
    return { kind: "execute", label: "process logs", steps: [actionStep("result", "process", "getLogTail", withProcess({ laneId: requireValue(laneId, "laneId"), processId: requireValue(processId, "processId"), maxBytes: readIntOption(args, ["--max-bytes", "--tail-bytes"], 80_000) }))] };
  }
  if (sub === "stack") {
    const mode = requireValue(firstPositional(args), "stack action");
    const stackId = requireValue(readValue(args, ["--stack", "--stack-id"]) ?? firstPositional(args), "stackId");
    const methodByMode: Record<string, string> = { start: "startStack", stop: "stopStack", restart: "restartStack" };
    const method = methodByMode[mode];
    if (!method) throw new CliUsageError("run stack supports start, stop, or restart.");
    return { kind: "execute", label: `stack ${mode}`, steps: [actionStep("result", "process", method, collectGenericObjectArgs(args, { laneId: requireValue(laneId, "laneId"), stackId }))] };
  }
  if (sub === "start-all" || sub === "stop-all") return { kind: "execute", label: `process ${sub}`, steps: [actionStep("result", "process", sub === "start-all" ? "startAll" : "stopAll", collectGenericObjectArgs(args, { ...(laneId ? { laneId } : {}) }))] };
  return { kind: "execute", label: `process ${sub}`, steps: [actionStep("result", "process", sub, withProcess())] };
}

function buildShellPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "start";
  if (sub === "actions") return { kind: "execute", label: "shell actions", steps: [listActionsStep("actions", "pty")] };
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
      readValue(args, ["--chat-session", "--chat-session-id", "--session", "--session-id"])
      ?? process.env.ADE_CHAT_SESSION_ID,
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
    return { kind: "execute", label: "shell start", steps: [actionStep("result", "pty", "create", input)] };
  }
  if (sub === "write") return { kind: "execute", label: "shell write", steps: [actionStep("result", "pty", "write", collectGenericObjectArgs(args, { ptyId: requireValue(readValue(args, ["--pty", "--pty-id"]) ?? firstPositional(args), "ptyId"), data: readValue(args, ["--data"]) ?? "" }))] };
  if (sub === "resize") return { kind: "execute", label: "shell resize", steps: [actionStep("result", "pty", "resize", collectGenericObjectArgs(args, { ptyId: requireValue(readValue(args, ["--pty", "--pty-id"]) ?? firstPositional(args), "ptyId"), cols: readIntOption(args, ["--cols"], 120), rows: readIntOption(args, ["--rows"], 36) }))] };
  if (sub === "close" || sub === "dispose") return { kind: "execute", label: "shell close", steps: [actionStep("result", "pty", "dispose", collectGenericObjectArgs(args, { ptyId: requireValue(readValue(args, ["--pty", "--pty-id"]) ?? firstPositional(args), "ptyId"), sessionId: readValue(args, ["--session", "--session-id"]) }))] };
  return { kind: "execute", label: `shell ${sub}`, steps: [actionStep("result", "pty", sub, collectGenericObjectArgs(args))] };
}

function buildCliSessionStartPlan(args: string[], providerArg?: string): CliPlan {
  const laneId = requireValue(readLaneId(args), "laneId");
  const rawProvider = requireValue(
    providerArg ?? readValue(args, ["--provider", "--profile"]) ?? firstStandalonePositional(args),
    "provider",
  );
  if (!isLaunchProfile(rawProvider)) {
    throw new CliUsageError("provider must be one of claude, codex, cursor, droid, opencode, or shell.");
  }
  const provider: LaunchProfile = rawProvider;
  const promptArgs = takeArgsAfterTerminator(args);
  const initialInput = promptArgs
    ? promptArgs.join(" ").trim()
    : readValue(args, ["--message", "--prompt", "--initial-input"]);
  const permissionMode = readValue(args, ["--permission-mode", "--permissions"]) ?? "default";
  if (!isTrackedCliPermissionMode(permissionMode)) {
    throw new CliUsageError("permissionMode must be one of default, plan, edit, full-auto, or config-toml.");
  }
  validateLaunchProfilePermissionMode(provider, permissionMode);

  const input = collectGenericObjectArgs(args, {
    laneId,
    provider,
    permissionMode,
    title: readValue(args, ["--title"]) ?? LAUNCH_PROFILE_TITLE[provider] ?? undefined,
    initialInput,
    cols: readIntOption(args, ["--cols"], 120),
    rows: readIntOption(args, ["--rows"], 36),
    cwd: readValue(args, ["--cwd"]),
    chatSessionId: readValue(args, ["--chat-session", "--chat-session-id"]),
    resumeSessionId: readValue(args, ["--resume-session", "--resume-session-id"]),
    resumeTargetId: readValue(args, ["--resume-target", "--resume-target-id", "--target"]),
    tracked: !readFlag(args, ["--untracked"]),
  });

  return { kind: "execute", label: "shell start cli", steps: [actionCallStep("result", "start_cli_session", input)] };
}

function buildTerminalPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "active";
  if (sub === "actions") return { kind: "execute", label: "terminal actions", steps: [listActionsStep("actions", "terminal")] };
  const chatSessionId = () => readValue(args, ["--chat-session", "--chat-session-id", "--session", "--session-id"]) ?? process.env.ADE_CHAT_SESSION_ID ?? null;
  if (sub === "list" || sub === "ls") {
    return { kind: "execute", label: "terminal list", steps: [actionStep("result", "terminal", "list", collectGenericObjectArgs(args, {
      chatSessionId: chatSessionId(),
      laneId: readValue(args, ["--lane", "--lane-id"]),
      limit: readIntOption(args, ["--limit"], undefined),
    }))] };
  }
  if (sub === "active" || sub === "current") {
    return { kind: "execute", label: "terminal active", steps: [actionStep("result", "terminal", "activeForChat", collectGenericObjectArgs(args, {
      chatSessionId: requireValue(chatSessionId(), "chatSessionId"),
    }))] };
  }
  if (sub === "read" || sub === "tail" || sub === "scrollback") {
    const terminal = readValue(args, ["--terminal", "--terminal-id"]);
    const chat = chatSessionId();
    const maxBytes = readIntOption(args, ["--max-bytes"], undefined);
    const since = readIntOption(args, ["--since"], undefined);
    return { kind: "execute", label: "terminal read", steps: [actionStep("result", "terminal", "read", collectGenericObjectArgs(args, {
      terminalId: terminal ?? firstPositional(args),
      chatSessionId: chat,
      maxBytes,
      since,
    }))] };
  }
  if (sub === "write" || sub === "send" || sub === "input") {
    const terminal = readValue(args, ["--terminal", "--terminal-id"]);
    const ptyId = readValue(args, ["--pty", "--pty-id"]);
    const chat = chatSessionId();
    const data = readValue(args, ["--data", "--value", "--text"]) ?? args.join(" ");
    if (!data.length) throw new CliUsageError("data is required.");
    return { kind: "execute", label: "terminal write", steps: [actionStep("result", "terminal", "write", collectGenericObjectArgs(args, {
      terminalId: terminal ?? firstPositional(args),
      ptyId,
      chatSessionId: chat,
      data,
    }))] };
  }
  if (sub === "signal" || sub === "interrupt" || sub === "stop") {
    const terminal = readValue(args, ["--terminal", "--terminal-id"]);
    const ptyId = readValue(args, ["--pty", "--pty-id"]);
    const chat = chatSessionId();
    const signal = readValue(args, ["--signal"]) ?? (sub === "stop" ? "SIGTERM" : "SIGINT");
    return { kind: "execute", label: "terminal signal", steps: [actionStep("result", "terminal", "signal", collectGenericObjectArgs(args, {
      terminalId: terminal ?? firstPositional(args),
      ptyId,
      chatSessionId: chat,
      signal,
    }))] };
  }
  return { kind: "execute", label: `terminal ${sub}`, steps: [actionStep("result", "terminal", sub, collectGenericObjectArgs(args))] };
}

function buildChatPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") return { kind: "execute", label: "chat actions", steps: [listActionsStep("actions", "chat")] };
  const sessionId = readValue(args, ["--session", "--session-id"]) ?? (sub !== "create" && sub !== "list" ? firstPositional(args) : null);
  const withSession = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(sessionId ? { sessionId } : {}) });
  if (sub === "list" || sub === "ls") return { kind: "execute", label: "chat list", steps: [actionStep("result", "chat", "listSessions", collectGenericObjectArgs(args))] };
  if (sub === "show" || sub === "status") return { kind: "execute", label: "chat status", steps: [actionArgsListStep("result", "chat", "getSessionSummary", [requireValue(sessionId, "sessionId")])] };
  if (sub === "create" || sub === "spawn") {
    const modelArg = readValue(args, ["--model", "--model-id"]);
    const fastRequested = readFlag(args, ["--fast", "--codex-fast"]);
    const standardRequested = readFlag(args, ["--standard", "--no-fast", "--no-codex-fast"]);
    if (fastRequested && standardRequested) {
      throw new CliUsageError(
        "Use either --fast/--codex-fast or --standard/--no-fast/--no-codex-fast, not both.",
      );
    }
    const codexFastMode: boolean | undefined = fastRequested ? true : standardRequested ? false : undefined;
    return { kind: "execute", label: "chat create", steps: [actionStep("result", "chat", "createSession", collectGenericObjectArgs(args, { laneId: readLaneId(args), provider: readValue(args, ["--provider"]), model: modelArg, modelId: modelArg, permissionMode: readValue(args, ["--permission-mode", "--permissions"]), droidPermissionMode: readValue(args, ["--droid-permission-mode", "--droid-autonomy", "--autonomy"]), title: readValue(args, ["--title"]), surface: readValue(args, ["--surface"]) ?? "work", ...(codexFastMode !== undefined ? { codexFastMode } : {}) }))] };
  }
  if (sub === "send") return { kind: "execute", label: "chat send", steps: [actionStep("result", "chat", "sendMessage", withSession({ sessionId: requireValue(sessionId, "sessionId"), text: requireValue(readValue(args, ["--text", "--message"]) ?? args.join(" "), "message text") }))] };
  if (sub === "interrupt") return { kind: "execute", label: "chat interrupt", steps: [actionStep("result", "chat", "interrupt", withSession({ sessionId: requireValue(sessionId, "sessionId") }))] };
  if (sub === "resume") return { kind: "execute", label: "chat resume", steps: [actionStep("result", "chat", "resumeSession", withSession())] };
  if (sub === "delete" || sub === "rm") return { kind: "execute", label: "chat delete", steps: [actionStep("result", "chat", "deleteSession", withSession())] };
  if (sub === "models") return { kind: "execute", label: "chat models", steps: [actionStep("result", "chat", "getAvailableModels", collectGenericObjectArgs(args))] };
  if (sub === "slash") return { kind: "execute", label: "chat slash commands", steps: [actionStep("result", "chat", "getSlashCommands", collectGenericObjectArgs(args))] };
  return { kind: "execute", label: `chat ${sub}`, steps: [actionStep("result", "chat", sub, withSession())] };
}

function buildTestsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "actions") return { kind: "execute", label: "test actions", steps: [listActionsStep("actions", "tests")] };
  if (sub === "list" || sub === "suites") return { kind: "execute", label: "test suites", steps: [actionStep("result", "tests", "listSuites", collectGenericObjectArgs(args))] };
  if (sub === "run") {
    const laneId = requireValue(readLaneId(args), "laneId");
    const suiteId = readValue(args, ["--suite", "--suite-id"]) ?? firstPositional(args);
    const command = readValue(args, ["--command", "-c"]);
    if (!suiteId && !command) throw new CliUsageError("tests run requires --suite <id> or --command <command>.");
    const input = collectGenericObjectArgs(args, {
      laneId,
      suiteId,
      command,
      waitForCompletion: readFlag(args, ["--wait"]),
      timeoutMs: readIntOption(args, ["--timeout-ms"]),
      maxLogBytes: readIntOption(args, ["--max-log-bytes"]),
    });
    return { kind: "execute", label: "test run", steps: [actionCallStep("result", "run_tests", input)] };
  }
  if (sub === "stop") return { kind: "execute", label: "test stop", steps: [actionStep("result", "tests", "stop", collectGenericObjectArgs(args, { runId: requireValue(readValue(args, ["--run", "--run-id"]) ?? firstPositional(args), "runId") }))] };
  if (sub === "runs") return { kind: "execute", label: "test runs", steps: [actionStep("result", "tests", "listRuns", collectGenericObjectArgs(args, { laneId: readLaneId(args), suiteId: readValue(args, ["--suite", "--suite-id"]), limit: readIntOption(args, ["--limit"]) }))] };
  if (sub === "logs" || sub === "log") return { kind: "execute", label: "test logs", steps: [actionStep("result", "tests", "getLogTail", collectGenericObjectArgs(args, { runId: requireValue(readValue(args, ["--run", "--run-id"]) ?? firstPositional(args), "runId"), maxBytes: readIntOption(args, ["--max-bytes"], 220_000) }))] };
  return { kind: "execute", label: `tests ${sub}`, steps: [actionStep("result", "tests", sub, collectGenericObjectArgs(args))] };
}

function readFileTextInput(args: string[]): string | undefined {
  const text = readValue(args, ["--text"]);
  if (text != null) return text;
  const filePath = readValue(args, ["--from-file"]);
  if (filePath != null) return fs.readFileSync(path.resolve(filePath), "utf8");
  if (readFlag(args, ["--stdin"])) return fs.readFileSync(0, "utf8");
  return undefined;
}

function buildFilesPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "workspaces";
  if (sub === "actions") return { kind: "execute", label: "file actions", steps: [listActionsStep("actions", "file")] };
  const workspaceId = readValue(args, ["--workspace", "--workspace-id"]);
  const withWorkspace = (base: JsonObject = {}) => collectGenericObjectArgs(args, { ...base, ...(workspaceId ? { workspaceId } : {}) });

  if (sub === "workspaces" || sub === "workspace" || sub === "roots") {
    return { kind: "execute", label: "file workspaces", steps: [actionStep("result", "file", "listWorkspaces", collectGenericObjectArgs(args, { laneId: readLaneId(args) }))] };
  }
  if (sub === "tree" || sub === "ls") {
    return { kind: "execute", label: "file tree", steps: [actionStep("result", "file", "listTree", withWorkspace({ parentPath: readValue(args, ["--path"]) ?? firstPositional(args), depth: readIntOption(args, ["--depth"]), includeIgnored: readFlag(args, ["--include-ignored"]) }))] };
  }
  if (sub === "read" || sub === "cat") {
    return { kind: "execute", label: "file read", steps: [actionStep("result", "file", "readFile", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path") }))] };
  }
  if (sub === "write") {
    const text = readFileTextInput(args);
    if (text == null) throw new CliUsageError("files write requires --text, --from-file, or --stdin.");
    return { kind: "execute", label: "file write", steps: [actionStep("result", "file", "writeWorkspaceText", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path"), text }))] };
  }
  if (sub === "create") {
    return { kind: "execute", label: "file create", steps: [actionStep("result", "file", "createFile", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path"), content: readFileTextInput(args) ?? "" }))] };
  }
  if (sub === "mkdir") {
    return { kind: "execute", label: "file mkdir", steps: [actionStep("result", "file", "createDirectory", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path") }))] };
  }
  if (sub === "rename" || sub === "mv") {
    return { kind: "execute", label: "file rename", steps: [actionStep("result", "file", "rename", withWorkspace({ oldPath: readValue(args, ["--old", "--old-path"]) ?? firstPositional(args), newPath: readValue(args, ["--new", "--new-path"]) ?? firstPositional(args) }))] };
  }
  if (sub === "delete" || sub === "rm") {
    return { kind: "execute", label: "file delete", steps: [actionStep("result", "file", "deletePath", withWorkspace({ path: requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path") }))] };
  }
  if (sub === "quick-open") {
    return { kind: "execute", label: "file quick-open", steps: [actionStep("result", "file", "quickOpen", withWorkspace({ query: readValue(args, ["--query", "-q"]) ?? args.join(" "), limit: readIntOption(args, ["--limit"]), includeIgnored: readFlag(args, ["--include-ignored"]) }))] };
  }
  if (sub === "search") {
    return { kind: "execute", label: "file search", steps: [actionStep("result", "file", "searchText", withWorkspace({ query: requireValue(readValue(args, ["--query", "-q"]) ?? args.join(" "), "query"), limit: readIntOption(args, ["--limit"]), includeIgnored: readFlag(args, ["--include-ignored"]) }))] };
  }
  return { kind: "execute", label: `files ${sub}`, steps: [actionStep("result", "file", sub, withWorkspace())] };
}

function buildProofPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  const proofOwnerBase = () => {
    const ownerKind = readValue(args, ["--owner-kind", "--owner"]);
    const ownerId = readValue(args, ["--owner-id"]);
    return {
      ...(ownerKind ? { ownerKind } : {}),
      ...(ownerId ? { ownerId } : {}),
    };
  };
  const inferAttachedProofKind = (filePath: string): string => {
    const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "tif", "tiff"].includes(ext)) return "screenshot";
    if (["mov", "mp4", "m4v", "webm"].includes(ext)) return "video_recording";
    if (["zip", "har"].includes(ext)) return "browser_trace";
    return "browser_verification";
  };
  if (sub === "actions") return { kind: "execute", label: "proof actions", steps: [listActionsStep("actions", "computer_use_artifacts")] };
  if (sub === "status" || sub === "backends") return { kind: "execute", label: "proof backend status", steps: [actionCallStep("result", "get_computer_use_backend_status", collectGenericObjectArgs(args))] };
  if (sub === "environment") return { kind: "execute", label: "computer-use environment", steps: [actionCallStep("result", "get_environment_info", collectGenericObjectArgs(args, proofOwnerBase()))], preferHeadless: true };
  if (sub === "list" || sub === "ls") return { kind: "execute", label: "proof list", steps: [actionCallStep("result", "list_computer_use_artifacts", collectGenericObjectArgs(args))] };
  if (sub === "ingest") return { kind: "execute", label: "proof ingest", steps: [actionCallStep("result", "ingest_computer_use_artifacts", collectGenericObjectArgs(args))] };
  if (sub === "attach") {
    const caption = readValue(args, ["--caption", "--description", "--desc"]);
    const attachedPath = requireValue(readValue(args, ["--path"]) ?? firstPositional(args), "path");
    const title = readValue(args, ["--title", "--name"]) ?? caption ?? path.basename(attachedPath);
    return {
      kind: "execute",
      label: "proof attach",
      steps: [actionCallStep("result", "ingest_computer_use_artifacts", collectGenericObjectArgs(args, {
        backendStyle: "manual",
        backendName: "ade-cli",
        toolName: "proof attach",
        ...proofOwnerBase(),
        inputs: [{
          kind: inferAttachedProofKind(attachedPath),
          title,
          ...(caption ? { description: caption } : {}),
          path: attachedPath,
        }],
      }))],
    };
  }
  if (sub === "screenshot" || sub === "capture") {
    const caption = readValue(args, ["--caption", "--description", "--desc"]);
    return { kind: "execute", label: "computer-use screenshot", steps: [actionCallStep("result", "screenshot_environment", collectGenericObjectArgs(args, { ...proofOwnerBase(), name: readValue(args, ["--name", "--title"]) ?? caption }))], preferHeadless: true };
  }
  if (sub === "record") return { kind: "execute", label: "computer-use record", steps: [actionCallStep("result", "record_environment", collectGenericObjectArgs(args, { ...proofOwnerBase(), name: readValue(args, ["--name", "--title"]) ?? readValue(args, ["--caption", "--description", "--desc"]), durationSec: readNumberOption(args, ["--seconds", "--duration-sec"]) }))], preferHeadless: true };
  if (sub === "launch") return { kind: "execute", label: "computer-use launch", steps: [actionCallStep("result", "launch_app", collectGenericObjectArgs(args, { app: readValue(args, ["--app"]) ?? firstPositional(args) }))], preferHeadless: true };
  if (sub === "interact") return { kind: "execute", label: "computer-use interact", steps: [actionCallStep("result", "interact_gui", collectGenericObjectArgs(args, proofOwnerBase()))], preferHeadless: true };
  return { kind: "execute", label: `proof ${sub}`, steps: [actionStep("result", "computer_use_artifacts", sub, collectGenericObjectArgs(args))] };
}

function buildIosSimulatorPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "help") return { kind: "help", text: buildIosSimulatorHelp(args) };
  const numericPositionals = () => args.filter((value) => /^\d+(\.\d+)?$/.test(value));
  const readCoordinate = (flag: string, index: number): number => {
    const value = readNumberOption(args, [flag]) ?? Number(numericPositionals()[index]);
    if (!Number.isFinite(value)) throw new CliUsageError(`${flag} is required and must be a number.`);
    return value;
  };
  if (sub === "actions") return { kind: "execute", label: "iOS simulator actions", steps: [listActionsStep("actions", "ios_simulator")] };
  if (sub === "status") return { kind: "execute", label: "iOS simulator status", steps: [actionStep("result", "ios_simulator", "getStatus", collectGenericObjectArgs(args))] };
  if (sub === "devices" || sub === "list" || sub === "ls") return { kind: "execute", label: "iOS simulator devices", steps: [actionStep("result", "ios_simulator", "listDevices", collectGenericObjectArgs(args))] };
  if (sub === "apps" || sub === "targets" || sub === "launchable" || sub === "launchables") {
    return { kind: "execute", label: "iOS simulator launchable apps", steps: [actionStep("result", "ios_simulator", "listLaunchTargets", collectGenericObjectArgs(args, { deviceUdid: readValue(args, ["--device", "--udid"]), projectRoot: readValue(args, ["--project-root", "--root"]) }))] };
  }
  if (sub === "launch" || sub === "open") {
    return {
      kind: "execute",
      label: "iOS simulator launch",
      steps: [actionStep("result", "ios_simulator", "launch", collectGenericObjectArgs(args, {
        deviceUdid: readValue(args, ["--device", "--udid"]),
        projectRoot: readValue(args, ["--project-root", "--root"]),
        laneId: readValue(args, ["--lane", "--lane-id"]),
        targetId: readValue(args, ["--target", "--target-id"]),
        bundleId: readValue(args, ["--bundle-id", "--bundle"]),
        appBundlePath: readValue(args, ["--app-bundle", "--app"]),
        projectPath: readValue(args, ["--project", "--xcodeproj"]),
        scheme: readValue(args, ["--scheme"]),
        chatSessionId: readValue(args, ["--chat-session", "--session"]) ?? process.env.ADE_CHAT_SESSION_ID,
        build: !readFlag(args, ["--no-build"]),
        mode: readValue(args, ["--mode"]) ?? "live",
        keepSimulatorInBackground: !readFlag(args, ["--foreground"]),
      }))],
    };
  }
  if (sub === "screenshot" || sub === "capture") {
    return { kind: "execute", label: "iOS simulator screenshot", steps: [actionStep("result", "ios_simulator", "screenshot", collectGenericObjectArgs(args, { deviceUdid: readValue(args, ["--device", "--udid"]) }))] };
  }
  if (sub === "inspector") {
    return { kind: "execute", label: "iOS simulator inspector snapshot", steps: [actionStep("result", "ios_simulator", "getInspectorSnapshot", collectGenericObjectArgs(args, { deviceUdid: readValue(args, ["--device", "--udid"]) }))] };
  }
  if (sub === "preview-status" || sub === "preview-doctor") {
    return { kind: "execute", label: "iOS simulator preview status", steps: [actionStep("result", "ios_simulator", "getPreviewCapability", collectGenericObjectArgs(args, { projectRoot: readValue(args, ["--project-root", "--root"]), sourceFile: readValue(args, ["--source", "--file"]), sourceLine: readNumberOption(args, ["--line"]) }))] };
  }
  if (sub === "previews" || sub === "preview-list" || sub === "list-previews") {
    return { kind: "execute", label: "iOS simulator previews", steps: [actionStep("result", "ios_simulator", "listPreviewTargets", collectGenericObjectArgs(args, { projectRoot: readValue(args, ["--project-root", "--root"]), sourceFile: readValue(args, ["--source", "--file"]), sourceLine: readNumberOption(args, ["--line"]) }))] };
  }
  if (sub === "preview-render" || sub === "render-preview" || sub === "preview") {
    return { kind: "execute", label: "iOS simulator preview render", steps: [actionStep("result", "ios_simulator", "renderPreview", collectGenericObjectArgs(args, {
      projectRoot: readValue(args, ["--project-root", "--root"]),
      sourceFilePath: requireValue(readValue(args, ["--source", "--file"]), "sourceFilePath"),
      previewDefinitionIndexInFile: readNumberOption(args, ["--index"], 0),
      tabIdentifier: readValue(args, ["--tab", "--tab-identifier"]),
      timeoutSec: readNumberOption(args, ["--timeout"], 120),
    }))] };
  }
  if (sub === "preview-open" || sub === "open-preview-workspace" || sub === "open-xcode") {
    return { kind: "execute", label: "iOS simulator preview open", steps: [actionStep("result", "ios_simulator", "openPreviewWorkspace", collectGenericObjectArgs(args, { projectRoot: readValue(args, ["--project-root", "--root"]) }))] };
  }
  if (sub === "snapshot" || sub === "screen" || sub === "elements") {
    return { kind: "execute", label: "iOS simulator screen snapshot", steps: [actionStep("result", "ios_simulator", "getScreenSnapshot", collectGenericObjectArgs(args, { deviceUdid: readValue(args, ["--device", "--udid"]), projectRoot: readValue(args, ["--project-root", "--root"]) }))] };
  }
  if (sub === "inspect" || sub === "hit-test" || sub === "hover") {
    return { kind: "execute", label: "iOS simulator inspect point", steps: [actionStep("result", "ios_simulator", "inspectPoint", collectGenericObjectArgs(args, {
      deviceUdid: readValue(args, ["--device", "--udid"]),
      projectRoot: readValue(args, ["--project-root", "--root"]),
      x: readCoordinate("--x", 0),
      y: readCoordinate("--y", 1),
      includeScreenshot: readFlag(args, ["--screenshot", "--include-screenshot"]),
    }))] };
  }
  if (sub === "stream-start" || sub === "start-stream" || sub === "stream" || sub === "preview-start" || sub === "start-preview" || sub === "live-start" || sub === "start-live" || sub === "window-start" || sub === "start-window" || sub === "mirror-start" || sub === "start-mirror") {
    const forcedBackend = sub === "preview-start" || sub === "start-preview"
      ? "simctl-screenshot-poll"
      : sub === "window-start" || sub === "start-window" || sub === "mirror-start" || sub === "start-mirror"
        ? "simulator-window-capture"
        : sub === "live-start" || sub === "start-live"
        ? "auto"
        : undefined;
    const requestedBackend = forcedBackend
      ?? (readFlag(args, ["--window", "--mirror"]) ? "simulator-window-capture" : readFlag(args, ["--idb", "--live"]) ? "auto" : readFlag(args, ["--simctl", "--preview"]) ? "simctl-screenshot-poll" : readValue(args, ["--backend"]) ?? "auto");
    const defaultFps = requestedBackend === "simulator-window-capture"
      ? 60
      : requestedBackend === "iosurface-indigo" || requestedBackend === "idb-mjpeg" || requestedBackend === "idb-h264-ffmpeg-mjpeg"
        ? 30
        : requestedBackend === "simctl-screenshot-poll"
          ? 8
          : undefined;
    return { kind: "execute", label: "iOS simulator stream start", steps: [actionStep("result", "ios_simulator", "startStream", collectGenericObjectArgs(args, {
      deviceUdid: readValue(args, ["--device", "--udid"]),
      fps: readNumberOption(args, ["--fps"], defaultFps),
      backend: requestedBackend,
    }))] };
  }
  if (sub === "stream-stop" || sub === "stop-stream" || sub === "preview-stop" || sub === "stop-preview" || sub === "live-stop" || sub === "stop-live") {
    return { kind: "execute", label: "iOS simulator stream stop", steps: [actionStep("result", "ios_simulator", "stopStream", collectGenericObjectArgs(args))] };
  }
  if (sub === "stream-status") {
    return { kind: "execute", label: "iOS simulator stream status", steps: [actionStep("result", "ios_simulator", "getStreamStatus", collectGenericObjectArgs(args))] };
  }
  if (sub === "tap") {
    return { kind: "execute", label: "iOS simulator tap", steps: [actionStep("result", "ios_simulator", "tap", collectGenericObjectArgs(args, {
      deviceUdid: readValue(args, ["--device", "--udid"]),
      projectRoot: readValue(args, ["--project-root", "--root"]),
      x: readCoordinate("--x", 0),
      y: readCoordinate("--y", 1),
    }))] };
  }
  if (sub === "drag" || sub === "swipe") {
    return { kind: "execute", label: `iOS simulator ${sub}`, steps: [actionStep("result", "ios_simulator", sub, collectGenericObjectArgs(args, {
      deviceUdid: readValue(args, ["--device", "--udid"]),
      projectRoot: readValue(args, ["--project-root", "--root"]),
      startX: readCoordinate("--start-x", 0),
      startY: readCoordinate("--start-y", 1),
      endX: readCoordinate("--end-x", 2),
      endY: readCoordinate("--end-y", 3),
      durationMs: readNumberOption(args, ["--duration-ms", "--duration"]),
    }))] };
  }
  if (sub === "select") {
    return { kind: "execute", label: "iOS simulator select", steps: [actionStep("result", "ios_simulator", "selectPoint", collectGenericObjectArgs(args, {
      deviceUdid: readValue(args, ["--device", "--udid"]),
      projectRoot: readValue(args, ["--project-root", "--root"]),
      x: readCoordinate("--x", 0),
      y: readCoordinate("--y", 1),
    }))] };
  }
  if (sub === "type" || sub === "text") {
    return { kind: "execute", label: "iOS simulator type", steps: [actionStep("result", "ios_simulator", "typeText", collectGenericObjectArgs(args, {
      deviceUdid: readValue(args, ["--device", "--udid"]),
      projectRoot: readValue(args, ["--project-root", "--root"]),
      text: requireValue(
        readValue(args, ["--value", "--message", "--input-text"])
          ?? readCommandTextValue(args, ["--text"])
          ?? args.filter((arg) => arg !== "--text").join(" "),
        "text",
      ),
    }))] };
  }
  if (sub === "shutdown" || sub === "stop" || sub === "teardown" || sub === "end" || sub === "end-session") {
    return { kind: "execute", label: "iOS simulator shutdown", steps: [actionStep("result", "ios_simulator", "shutdown", collectGenericObjectArgs(args, {
      deviceUdid: readValue(args, ["--device", "--udid"]),
      force: readFlag(args, ["--force", "-f"]) ? true : undefined,
    }))] };
  }
  return { kind: "execute", label: `ios-sim ${sub}`, steps: [actionStep("result", "ios_simulator", sub, collectGenericObjectArgs(args))] };
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
  const numericPositionals = () => args.filter((value) => /^\d+(\.\d+)?$/.test(value));
  const readCoordinate = (flag: string, index: number): number => {
    const value = readNumberOption(args, [flag]) ?? Number(numericPositionals()[index]);
    if (!Number.isFinite(value)) throw new CliUsageError(`${flag} is required and must be a number.`);
    return value;
  };
  if (sub === "actions") return { kind: "execute", label: "App Control actions", steps: [listActionsStep("actions", "app_control")] };
  if (sub === "status") return { kind: "execute", label: "App Control status", steps: [actionStep("result", "app_control", "getStatus", collectGenericObjectArgs(args))] };
  if (sub === "logs" || sub === "log" || sub === "read" || sub === "tail") {
    return { kind: "execute", label: "terminal read", steps: [actionStep("result", "app_control", "readTerminal", collectGenericObjectArgs(args, {
      maxBytes: readIntOption(args, ["--max-bytes"], undefined),
      since: readIntOption(args, ["--since"], undefined),
    }))] };
  }
  if (sub === "terminal") {
    const mode = firstPositional(args) ?? "read";
    if (mode === "read" || mode === "logs" || mode === "tail") {
      return { kind: "execute", label: "terminal read", steps: [actionStep("result", "app_control", "readTerminal", collectGenericObjectArgs(args, {
        maxBytes: readIntOption(args, ["--max-bytes"], undefined),
        since: readIntOption(args, ["--since"], undefined),
      }))] };
    }
    if (mode === "write" || mode === "send" || mode === "input") {
      const data = readValue(args, ["--data", "--value", "--text"]) ?? args.join(" ");
      if (!data.length) throw new CliUsageError("data is required.");
      return { kind: "execute", label: "terminal write", steps: [actionStep("result", "app_control", "writeTerminal", collectGenericObjectArgs(args, { data }))] };
    }
    if (mode === "signal" || mode === "interrupt" || mode === "stop") {
      return { kind: "execute", label: "terminal signal", steps: [actionStep("result", "app_control", "signalTerminal", collectGenericObjectArgs(args, {
        signal: readValue(args, ["--signal"]) ?? (mode === "stop" ? "SIGTERM" : "SIGINT"),
      }))] };
    }
    throw new CliUsageError("app-control terminal supports read, write, or signal.");
  }
  if (sub === "launch" || sub === "open" || sub === "start") {
    const trailingCommand = readTrailingCommand(args);
    const command = readValue(args, ["--command", "--cmd"]) ?? trailingCommand;
    const appKind = readValue(args, ["--kind", "--app-kind"]) ?? "electron";
    const projectRoot = readValue(args, ["--project-root", "--root"]);
    const laneId = readValue(args, ["--lane", "--lane-id"]);
    const cwd = readValue(args, ["--cwd", "--working-directory"]);
    const debugPort = readNumberOption(args, ["--debug-port", "--port"]);
    const cdpPort = readNumberOption(args, ["--cdp-port"]);
    const label = readValue(args, ["--label", "--name"]);
    const chatSessionId = readValue(args, ["--chat-session", "--chat-session-id", "--session", "--session-id"]) ?? process.env.ADE_CHAT_SESSION_ID;
    const force = readFlag(args, ["--force", "-f"]) ? true : undefined;
    const positionalCommand = args.filter((arg) => arg !== "--" && !arg.startsWith("-")).join(" ").trim();
    const launchCommand = command ?? (positionalCommand.length ? positionalCommand : null);
    if (!launchCommand) throw new CliUsageError("app-control launch requires a command, for example: ade app-control launch --command \"pnpm dev\".");
    return {
      kind: "execute",
      label: "App Control launch",
      steps: [actionStep("result", "app_control", "launch", collectGenericObjectArgs(args, {
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
      }))],
    };
  }
  if (sub === "connect" || sub === "attach") {
    return { kind: "execute", label: "App Control connect", steps: [actionStep("result", "app_control", "connect", collectGenericObjectArgs(args, {
      appKind: readValue(args, ["--kind", "--app-kind"]) ?? "electron",
      projectRoot: readValue(args, ["--project-root", "--root"]),
      laneId: readValue(args, ["--lane", "--lane-id"]),
      cdpPort: readNumberOption(args, ["--cdp-port", "--port"]) ?? Number(numericPositionals()[0]),
      label: readValue(args, ["--label", "--name"]),
      chatSessionId: readValue(args, ["--chat-session", "--session"]) ?? process.env.ADE_CHAT_SESSION_ID,
      force: readFlag(args, ["--force", "-f"]) ? true : undefined,
    }))] };
  }
  if (sub === "targets" || sub === "list-targets") {
    return { kind: "execute", label: "App Control targets", steps: [actionStep("result", "app_control", "listTargets", collectGenericObjectArgs(args))] };
  }
  if (sub === "attach-target" || sub === "target") {
    const targetId = requireValue(readValue(args, ["--target", "--target-id"]) ?? firstPositional(args), "targetId");
    return { kind: "execute", label: "App Control attach target", steps: [actionArgsListStep("result", "app_control", "attachToTarget", [targetId])] };
  }
  if (sub === "stop" || sub === "shutdown" || sub === "teardown" || sub === "close") {
    return { kind: "execute", label: "App Control stop", steps: [actionStep("result", "app_control", "stop", collectGenericObjectArgs(args, { force: readFlag(args, ["--force", "-f"]) ? true : undefined }))] };
  }
  if (sub === "screenshot" || sub === "capture") {
    return { kind: "execute", label: "App Control screenshot", steps: [actionStep("result", "app_control", "screenshot", collectGenericObjectArgs(args))] };
  }
  if (sub === "snapshot" || sub === "screen" || sub === "elements") {
    return { kind: "execute", label: "App Control snapshot", steps: [actionStep("result", "app_control", "getSnapshot", collectGenericObjectArgs(args, { projectRoot: readValue(args, ["--project-root", "--root"]) }))] };
  }
  if (sub === "inspect" || sub === "hit-test" || sub === "hover") {
    return { kind: "execute", label: "App Control inspect point", steps: [actionStep("result", "app_control", "inspectPoint", collectGenericObjectArgs(args, {
      projectRoot: readValue(args, ["--project-root", "--root"]),
      x: readCoordinate("--x", 0),
      y: readCoordinate("--y", 1),
      includeScreenshot: readFlag(args, ["--screenshot", "--include-screenshot"]),
    }))] };
  }
  if (sub === "select") {
    return { kind: "execute", label: "App Control select", steps: [actionStep("result", "app_control", "selectPoint", collectGenericObjectArgs(args, {
      projectRoot: readValue(args, ["--project-root", "--root"]),
      x: readCoordinate("--x", 0),
      y: readCoordinate("--y", 1),
    }))] };
  }
  if (sub === "click" || sub === "tap") {
    return { kind: "execute", label: "App Control click", steps: [actionStep("result", "app_control", "click", collectGenericObjectArgs(args, {
      x: readCoordinate("--x", 0),
      y: readCoordinate("--y", 1),
    }))] };
  }
  if (sub === "scroll" || sub === "wheel") {
    return { kind: "execute", label: "App Control scroll", steps: [actionStep("result", "app_control", "scroll", collectGenericObjectArgs(args, {
      x: readCoordinate("--x", 0),
      y: readCoordinate("--y", 1),
      deltaX: readNumberOption(args, ["--delta-x", "--dx"]) ?? 0,
      deltaY: readNumberOption(args, ["--delta-y", "--dy"]) ?? 0,
      scale: readNumberOption(args, ["--scale"]),
    }))] };
  }
  if (sub === "key" || sub === "dispatch-key") {
    const key = readValue(args, ["--key"]) ?? firstPositional(args);
    return { kind: "execute", label: "App Control key", steps: [actionStep("result", "app_control", "dispatchKey", collectGenericObjectArgs(args, {
      type: readValue(args, ["--event-type", "--type"]) ?? "keyDown",
      key: requireValue(key, "key"),
      code: readValue(args, ["--code"]),
      text: readValue(args, ["--text"]),
      modifiers: readNumberOption(args, ["--modifiers"]),
    }))] };
  }
  if (sub === "type" || sub === "text") {
    return { kind: "execute", label: "App Control type", steps: [actionStep("result", "app_control", "typeText", collectGenericObjectArgs(args, {
      text: requireValue(
        readValue(args, ["--value", "--message", "--input-text"])
          ?? readCommandTextValue(args, ["--text"])
          ?? args.filter((arg) => arg !== "--text").join(" "),
        "text",
      ),
    }))] };
  }
  return { kind: "execute", label: `app-control ${sub}`, steps: [actionStep("result", "app_control", sub, collectGenericObjectArgs(args))] };
}

function buildMacosVmPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "help") return { kind: "help", text: HELP_BY_COMMAND["macos-vm"] };
  const numericPositionals = () => args.filter((value) => /^\d+(\.\d+)?$/.test(value));
  const readCoordinate = (flag: string, index: number): number => {
    const value = readNumberOption(args, [flag]) ?? Number(numericPositionals()[index]);
    if (!Number.isFinite(value)) throw new CliUsageError(`${flag} is required and must be a number.`);
    return value;
  };

  const readVmLaneId = (required: boolean): string | null => {
    const laneId = readValue(args, ["--lane", "--lane-id"]) ?? firstPositional(args);
    if (required) return requireValue(laneId, "laneId");
    return laneId;
  };

  const readProvisionOptions = (): JsonObject => {
    const options: JsonObject = {
      name: readValue(args, ["--name", "--vm-name"]),
      cpuCores: readIntOption(args, ["--cpu", "--cpu-cores"]),
      memory: readValue(args, ["--memory"]),
      diskSize: readValue(args, ["--disk", "--disk-size"]),
      display: readValue(args, ["--display"]),
      mode: readValue(args, ["--mode"]),
      ipsw: readValue(args, ["--ipsw"]),
      sourceImage: readValue(args, ["--image", "--source-image"]),
      unattendedPreset: readValue(args, ["--unattended", "--unattended-preset"]),
    };
    return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && value !== null && value !== ""));
  };

  if (sub === "actions") return { kind: "execute", label: "macOS VM actions", steps: [listActionsStep("actions", "macos_vm")] };
  if (sub === "status" || sub === "list" || sub === "ls") {
    return { kind: "execute", label: "macOS VM status", steps: [actionStep("result", "macos_vm", "getStatus", collectGenericObjectArgs(args, { laneId: readVmLaneId(false) }))] };
  }
  if (sub === "share" || sub === "share-policy") {
    return { kind: "execute", label: "macOS VM share policy", steps: [actionStep("result", "macos_vm", "getSharePolicy", collectGenericObjectArgs(args, { laneId: readVmLaneId(true) }))] };
  }
  if (sub === "provision" || sub === "create" || sub === "pull") {
    const provisionOptions = readProvisionOptions();
    const mode = sub === "create" ? "create" : sub === "pull" ? "pull-image" : provisionOptions.mode;
    return { kind: "execute", label: "macOS VM provision", steps: [actionStep("result", "macos_vm", "provision", collectGenericObjectArgs(args, {
      laneId: readVmLaneId(true),
      ...provisionOptions,
      mode,
      force: readFlag(args, ["--force", "-f"]) ? true : undefined,
    }))] };
  }
  if (sub === "start" || sub === "run" || sub === "open") {
    const noDisplay = readFlag(args, ["--no-display", "--headless"]);
    const openDisplay = noDisplay ? false : readFlag(args, ["--open-display", "--display-window"]) ? true : undefined;
    return { kind: "execute", label: "macOS VM start", steps: [actionStep("result", "macos_vm", "start", collectGenericObjectArgs(args, {
      laneId: readVmLaneId(true),
      ...readProvisionOptions(),
      openDisplay,
      createIfMissing: readFlag(args, ["--create", "--create-if-missing"]) ? true : undefined,
    }))] };
  }
  if (sub === "stop" || sub === "shutdown") {
    return { kind: "execute", label: "macOS VM stop", steps: [actionStep("result", "macos_vm", "stop", collectGenericObjectArgs(args, {
      laneId: readVmLaneId(true),
      force: readFlag(args, ["--force", "-f"]) ? true : undefined,
    }))] };
  }
  if (sub === "delete" || sub === "rm" || sub === "remove" || sub === "destroy") {
    return { kind: "execute", label: "macOS VM delete", steps: [actionStep("result", "macos_vm", "delete", collectGenericObjectArgs(args, {
      laneId: readVmLaneId(true),
      force: readFlag(args, ["--force", "-f"]) ? true : undefined,
    }))] };
  }
  if (sub === "guide" || sub === "agent-guide" || sub === "handoff" || sub === "target") {
    return { kind: "execute", label: "macOS VM guide", steps: [actionStep("result", "macos_vm", "getAgentGuide", collectGenericObjectArgs(args, { laneId: readVmLaneId(true) }))] };
  }
  if (sub === "focus" || sub === "focus-window") {
    return { kind: "execute", label: "macOS VM focus", steps: [actionStep("result", "macos_vm", "focusWindow", collectGenericObjectArgs(args, {
      laneId: readVmLaneId(true),
      windowTitleQuery: readValue(args, ["--window-title", "--title-query"]),
    }))] };
  }
  if (sub === "screenshot" || sub === "capture") {
    return { kind: "execute", label: "macOS VM screenshot", steps: [actionStep("result", "macos_vm", "captureScreenshot", collectGenericObjectArgs(args, {
      laneId: readVmLaneId(true),
      windowTitleQuery: readValue(args, ["--window-title", "--title-query"]),
      outputPath: readValue(args, ["--output", "--path"]),
    }))] };
  }
  if (sub === "select" || sub === "select-point" || sub === "inspect") {
    return { kind: "execute", label: "macOS VM select", steps: [actionStep("result", "macos_vm", "selectPoint", collectGenericObjectArgs(args, {
      laneId: readVmLaneId(true),
      x: readCoordinate("--x", 0),
      y: readCoordinate("--y", 1),
      coordinateSpace: readValue(args, ["--coordinate-space", "--coords"]),
      windowTitleQuery: readValue(args, ["--window-title", "--title-query"]),
      includeScreenshot: readFlag(args, ["--no-screenshot"]) ? false : undefined,
    }))] };
  }
  if (sub === "click" || sub === "tap") {
    return { kind: "execute", label: "macOS VM click", steps: [actionStep("result", "macos_vm", "click", collectGenericObjectArgs(args, {
      laneId: readVmLaneId(true),
      x: readCoordinate("--x", 0),
      y: readCoordinate("--y", 1),
      coordinateSpace: readValue(args, ["--coordinate-space", "--coords"]),
      windowTitleQuery: readValue(args, ["--window-title", "--title-query"]),
    }))] };
  }
  if (sub === "type" || sub === "text") {
    return { kind: "execute", label: "macOS VM type", steps: [actionStep("result", "macos_vm", "typeText", collectGenericObjectArgs(args, {
      laneId: readVmLaneId(true),
      text: requireValue(
        readValue(args, ["--value", "--message", "--input-text"])
          ?? readCommandTextValue(args, ["--text"])
          ?? args.filter((arg) => arg !== "--text").join(" "),
        "text",
      ),
      windowTitleQuery: readValue(args, ["--window-title", "--title-query"]),
    }))] };
  }
  return { kind: "execute", label: `macos-vm ${sub}`, steps: [actionStep("result", "macos_vm", sub, collectGenericObjectArgs(args))] };
}

function buildBrowserPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "help") return { kind: "help", text: HELP_BY_COMMAND.browser };
  if (sub === "actions") return { kind: "execute", label: "browser actions", steps: [listActionsStep("actions", "built_in_browser")] };
  if (sub === "status" || sub === "tabs" || sub === "list") {
    return { kind: "execute", label: "browser status", steps: [actionStep("result", "built_in_browser", "getStatus", collectGenericObjectArgs(args))] };
  }
  if (sub === "panel" || sub === "show" || sub === "open-panel" || sub === "reveal") {
    const panelArgs: JsonObject = {};
    maybePut(panelArgs, "url", readValue(args, ["--url"]));
    maybePut(panelArgs, "tabId", readValue(args, ["--tab", "--tab-id"]));
    return { kind: "execute", label: "browser panel", steps: [actionStep("result", "built_in_browser", "showPanel", collectGenericObjectArgs(args, panelArgs))] };
  }
  if (sub === "open" || sub === "navigate" || sub === "go") {
    const explicitUrl = readValue(args, ["--url"]);
    const tabId = readValue(args, ["--tab", "--tab-id"]);
    const activeTab = readFlag(args, ["--active-tab", "--current-tab", "--same-tab"]);
    const newTab = readFlag(args, ["--new-tab"]);
    const noPanel = readFlag(args, ["--no-panel", "--hidden"]);
    const genericArgs = collectGenericObjectArgs(args);
    const genericUrl = typeof genericArgs.url === "string" ? genericArgs.url : null;
    const url = explicitUrl ?? genericUrl ?? args.join(" ");
    if (!url.trim()) throw new CliUsageError("browser open requires a URL.");
    return { kind: "execute", label: "browser open", steps: [actionStep("result", "built_in_browser", "navigate", {
      url,
      tabId,
      newTab: newTab && !activeTab ? true : undefined,
      openPanel: !noPanel,
      ...genericArgs,
    })] };
  }
  if (sub === "new-tab" || sub === "tab" || sub === "new") {
    const background = readFlag(args, ["--background"]);
    const noPanel = readFlag(args, ["--no-panel", "--hidden"]);
    const explicitUrl = readValue(args, ["--url"]);
    const genericArgs = collectGenericObjectArgs(args);
    const genericUrl = typeof genericArgs.url === "string" ? genericArgs.url : null;
    const url = explicitUrl ?? genericUrl ?? (args.length ? args.join(" ") : undefined);
    return { kind: "execute", label: "browser new tab", steps: [actionStep("result", "built_in_browser", "createTab", {
      url,
      activate: background ? false : undefined,
      openPanel: !noPanel,
      ...genericArgs,
    })] };
  }
  if (sub === "switch" || sub === "activate") {
    const noPanel = readFlag(args, ["--no-panel", "--hidden"]);
    const explicitTabId = readValue(args, ["--tab", "--tab-id"]);
    const genericArgs = collectGenericObjectArgs(args);
    const genericTabId = typeof genericArgs.tabId === "string" ? genericArgs.tabId : null;
    return { kind: "execute", label: "browser switch", steps: [actionStep("result", "built_in_browser", "switchTab", {
      tabId: requireValue(explicitTabId ?? genericTabId ?? firstPositional(args), "tabId"),
      openPanel: !noPanel,
      ...genericArgs,
    })] };
  }
  if (sub === "close" || sub === "close-tab") {
    const explicitTabId = readValue(args, ["--tab", "--tab-id"]);
    const genericArgs = collectGenericObjectArgs(args);
    const genericTabId = typeof genericArgs.tabId === "string" ? genericArgs.tabId : null;
    return { kind: "execute", label: "browser close", steps: [actionStep("result", "built_in_browser", "closeTab", {
      tabId: requireValue(explicitTabId ?? genericTabId ?? firstPositional(args), "tabId"),
      ...genericArgs,
    })] };
  }
  if (sub === "reload" || sub === "refresh") return { kind: "execute", label: "browser reload", steps: [actionStep("result", "built_in_browser", "reload", collectGenericObjectArgs(args))] };
  if (sub === "back") return { kind: "execute", label: "browser back", steps: [actionStep("result", "built_in_browser", "goBack", collectGenericObjectArgs(args))] };
  if (sub === "forward") return { kind: "execute", label: "browser forward", steps: [actionStep("result", "built_in_browser", "goForward", collectGenericObjectArgs(args))] };
  if (sub === "stop") return { kind: "execute", label: "browser stop", steps: [actionStep("result", "built_in_browser", "stop", collectGenericObjectArgs(args))] };
  if (sub === "screenshot" || sub === "capture") return { kind: "execute", label: "browser screenshot", steps: [actionStep("result", "built_in_browser", "captureScreenshot", collectGenericObjectArgs(args))] };
  if (sub === "select" || sub === "select-point" || sub === "point") {
    const x = readNumberOption(args, ["--x"]);
    const y = readNumberOption(args, ["--y"]);
    if (x == null || y == null) throw new CliUsageError("browser select requires --x and --y.");
    return { kind: "execute", label: "browser selection", steps: [actionStep("result", "built_in_browser", "selectPoint", collectGenericObjectArgs(args, {
      x,
      y,
      includeScreenshot: readFlag(args, ["--no-screenshot"]) ? false : undefined,
    }))] };
  }
  if (sub === "inspect-start" || sub === "start-inspect" || sub === "inspect") return { kind: "execute", label: "browser inspect start", steps: [actionStep("result", "built_in_browser", "startInspect", collectGenericObjectArgs(args))] };
  if (sub === "inspect-stop" || sub === "stop-inspect") return { kind: "execute", label: "browser inspect stop", steps: [actionStep("result", "built_in_browser", "stopInspect", collectGenericObjectArgs(args))] };
  if (sub === "select-current" || sub === "selection" || sub === "selected") return { kind: "execute", label: "browser selection", steps: [actionStep("result", "built_in_browser", "selectCurrent", collectGenericObjectArgs(args))] };
  if (sub === "clear-selection" || sub === "clear") return { kind: "execute", label: "browser clear selection", steps: [actionStep("result", "built_in_browser", "clearSelection", collectGenericObjectArgs(args))] };
  return { kind: "execute", label: `browser ${sub}`, steps: [actionStep("result", "built_in_browser", sub, collectGenericObjectArgs(args))] };
}

function buildMemoryPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "search";
  if (sub === "actions") return { kind: "execute", label: "memory actions", steps: [listActionsStep("actions", "memory")] };
  if (sub === "add") return { kind: "execute", label: "memory add", steps: [actionCallStep("result", "memory_add", collectGenericObjectArgs(args, { content: requireValue(readValue(args, ["--content"]) ?? args.join(" "), "content"), category: requireValue(readValue(args, ["--category"]), "category"), scope: readValue(args, ["--scope"]) }))] };
  if (sub === "search") return { kind: "execute", label: "memory search", steps: [actionCallStep("result", "memory_search", collectGenericObjectArgs(args, { query: requireValue(readValue(args, ["--query", "-q"]) ?? args.join(" "), "query") }))] };
  if (sub === "pin") return { kind: "execute", label: "memory pin", steps: [actionCallStep("result", "memory_pin", collectGenericObjectArgs(args, { id: requireValue(readValue(args, ["--memory", "--memory-id", "--id"]) ?? firstPositional(args), "memory id") }))] };
  if (sub === "core") return { kind: "execute", label: "memory core", steps: [actionCallStep("result", "memory_update_core", collectGenericObjectArgs(args))] };
  return { kind: "execute", label: `memory ${sub}`, steps: [actionStep("result", "memory", sub, collectGenericObjectArgs(args))] };
}

function buildSettingsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "get";
  if (sub === "actions") return { kind: "execute", label: "settings actions", steps: [listActionsStep("actions", "project_config")] };
  if (sub === "action") return { kind: "execute", label: "settings action", steps: [buildActionRunStep(["project_config", ...args])] };
  return { kind: "execute", label: `settings ${sub}`, steps: [actionStep("result", "project_config", sub, collectGenericObjectArgs(args))] };
}

function buildUsagePlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "snapshot";
  if (sub === "actions") return { kind: "execute", label: "usage actions", steps: [listActionsStep("actions", "usage")] };
  if (sub === "action") return { kind: "execute", label: "usage action", steps: [buildActionRunStep(["usage", ...args])] };
  if (sub === "snapshot" || sub === "get" || sub === "status") {
    return { kind: "execute", label: "usage snapshot", steps: [actionStep("result", "usage", "getUsageSnapshot", {})] };
  }
  if (sub === "refresh" || sub === "poll") {
    return { kind: "execute", label: "usage refresh", steps: [actionStep("result", "usage", "forceRefresh", {})] };
  }
  if (sub === "budget") {
    const mode = firstPositional(args) ?? "get";
    if (mode === "get") {
      return { kind: "execute", label: "usage budget get", steps: [actionStep("result", "budget", "getConfig", {})] };
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
      return { kind: "execute", label: "usage budget update", steps: [actionStep("result", "budget", "updateConfig", parsed as JsonObject)] };
    }
    if (mode === "check") {
      return { kind: "execute", label: "usage budget check", steps: [actionStep("result", "budget", "checkBudget", collectGenericObjectArgs(args, {
        scope: readValue(args, ["--scope"]) ?? "global",
        scopeId: readValue(args, ["--scope-id"]),
        provider: readValue(args, ["--provider"]) ?? "any",
      }))] };
    }
    if (mode === "cumulative" || mode === "totals") {
      return { kind: "execute", label: "usage budget cumulative", steps: [actionStep("result", "budget", "getCumulativeUsage", collectGenericObjectArgs(args, {
        scope: readValue(args, ["--scope"]) ?? "global",
        scopeId: readValue(args, ["--scope-id"]),
        provider: readValue(args, ["--provider"]),
      }))] };
    }
    throw new CliUsageError("usage budget supports get, set, check, or cumulative.");
  }
  return { kind: "execute", label: `usage ${sub}`, steps: [actionStep("result", "usage", sub, collectGenericObjectArgs(args))] };
}

function buildActionsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";
  if (sub === "list" || sub === "ls") return { kind: "execute", label: "actions list", steps: [listActionsStep("result", readValue(args, ["--domain"]) ?? firstPositional(args) ?? undefined)] };
  if (sub === "call" || sub === "direct" || sub === "tool") {
    const toolName = requireValue(firstPositional(args), "toolName");
    return { kind: "execute", label: "action call", steps: [actionCallStep("result", toolName, collectGenericObjectArgs(args))] };
  }
  if (sub === "run") return { kind: "execute", label: "action run", steps: [buildActionRunStep(args)] };
  if (sub === "status") return { kind: "execute", label: "action status", steps: [actionCallStep("result", "get_ade_action_status", collectGenericObjectArgs(args))] };
  throw new CliUsageError("actions supports list, run, call, or status.");
}

function buildAgentPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "spawn";
  if (sub === "spawn" || sub === "start") {
    const toolWhitelist = args
      .filter((entry) => entry.startsWith("--tool=") || entry.startsWith("--allow-tool="))
      .map((entry) => entry.slice(entry.indexOf("=") + 1).trim())
      .filter(Boolean);
    const laneId = requireValue(readLaneId(args), "laneId");
    const prompt = requireValue(readValue(args, ["--prompt"]) ?? args.join(" "), "prompt");
    return {
      kind: "execute",
      label: "agent spawn",
      steps: [actionCallStep("result", "spawn_agent", collectGenericObjectArgs(args, {
        laneId,
        provider: readValue(args, ["--provider"]) ?? "codex",
        model: readValue(args, ["--model"]),
        title: readValue(args, ["--title"]),
        prompt,
        permissionMode: readValue(args, ["--permission-mode", "--permissions"]),
        contextFilePath: readValue(args, ["--context-file"]),
        runId: readValue(args, ["--run", "--run-id"]),
        stepId: readValue(args, ["--step", "--step-id"]),
        attemptId: readValue(args, ["--attempt", "--attempt-id"]),
        maxPromptChars: readIntOption(args, ["--max-prompt-chars"]),
        ...(toolWhitelist.length ? { toolWhitelist } : {}),
      }))],
    };
  }
  return { kind: "execute", label: `agent ${sub}`, steps: [actionCallStep("result", sub.replace(/-/g, "_"), collectGenericObjectArgs(args))] };
}

function buildCtoPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "state";
  if (sub === "state") return { kind: "execute", label: "CTO state", steps: [actionCallStep("result", "get_cto_state", collectGenericObjectArgs(args, { recentLimit: readIntOption(args, ["--recent-limit", "--limit"]) }))] };
  if (sub === "chats" || sub === "chat") {
    const mode = firstPositional(args) ?? "list";
    const toolByMode: Record<string, string> = {
      list: "listChats",
      spawn: "spawnChat",
      status: "getChatStatus",
      transcript: "readChatTranscript",
      send: "sendChatMessage",
      interrupt: "interruptChat",
      resume: "resumeChat",
      end: "endChat",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("cto chats supports list, spawn, status, transcript, send, interrupt, resume, or end.");
    return { kind: "execute", label: `CTO chats ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args, { sessionId: readValue(args, ["--session", "--session-id"]) ?? firstPositional(args), text: readValue(args, ["--text", "--message"]) ?? args.join(" "), laneId: readLaneId(args), modelId: readValue(args, ["--model", "--model-id"]), initialPrompt: readValue(args, ["--prompt"]) }))] };
  }
  return { kind: "execute", label: `CTO ${sub}`, steps: [actionCallStep("result", sub.replace(/-/g, "_"), collectGenericObjectArgs(args))] };
}

function parseDraftInput(args: string[]): JsonObject {
  const text = readFileTextInput(args);
  if (text == null) {
    throw new CliUsageError("Provide a rule body via --from-file, --stdin, or --text.");
  }
  const trimmed = text.trim();
  if (!trimmed.length) {
    throw new CliUsageError("Rule body is empty.");
  }
  let parsed: unknown;
  try {
    parsed = trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : YAML.parse(trimmed);
  } catch (error) {
    throw new CliUsageError(`Failed to parse rule body: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new CliUsageError("Rule body must be an object.");
  }
  return parsed;
}

const AUTOMATION_LANE_MODES = ["create", "reuse", "require-on-trigger"] as const;
const AUTOMATION_LANE_NAME_PRESETS = ["issue-title", "issue-num-title", "pr-title-author", "custom"] as const;
const AUTOMATION_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled", "paused", "all"] as const;

type AutomationLaneModeFlag = (typeof AUTOMATION_LANE_MODES)[number];
type AutomationLaneNamePresetFlag = (typeof AUTOMATION_LANE_NAME_PRESETS)[number];

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
  const laneMode = readEnumOption<AutomationLaneModeFlag>(args, ["--lane-mode"], AUTOMATION_LANE_MODES, "--lane-mode");
  const laneId = readLaneId(args);
  const preset = readEnumOption<AutomationLaneNamePresetFlag>(args, ["--lane-name-preset"], AUTOMATION_LANE_NAME_PRESETS, "--lane-name-preset");
  const template = readValue(args, ["--lane-name-template"]);

  if (laneMode == null && laneId == null && preset == null && template == null) {
    return draft;
  }

  const existingExecution = isRecord(draft.execution) ? draft.execution : {};
  const effectiveLaneMode =
    laneMode
    ?? (asString(existingExecution.laneMode) as AutomationLaneModeFlag | null);

  if (laneId != null && effectiveLaneMode != null && effectiveLaneMode !== "reuse") {
    throw new CliUsageError("--lane is only valid with --lane-mode reuse.");
  }
  if (preset != null && effectiveLaneMode !== "create") {
    throw new CliUsageError("--lane-name-preset is only valid with --lane-mode create.");
  }
  if (template != null && preset != null && preset !== "custom") {
    throw new CliUsageError("--lane-name-template is only valid with --lane-name-preset custom.");
  }
  if (template != null && preset == null && effectiveLaneMode !== "create") {
    throw new CliUsageError("--lane-name-template requires --lane-mode create (with --lane-name-preset custom).");
  }

  const execution: JsonObject = { ...existingExecution };
  if (laneMode != null) execution.laneMode = laneMode;
  if (laneId != null) execution.targetLaneId = laneId;
  if (preset != null) execution.laneNamePreset = preset;
  if (template != null) execution.laneNameTemplate = template;

  return { ...draft, execution };
}

function migrateLegacyCreateLane(draft: JsonObject, opts: { allowLegacy: boolean }): JsonObject {
  const actions = Array.isArray(draft.actions) ? draft.actions : null;
  if (!actions || actions.length === 0) return draft;
  const first = actions[0];
  if (!isRecord(first) || first.type !== "create-lane") return draft;
  if (opts.allowLegacy) return draft;
  const execution = isRecord(draft.execution) ? draft.execution : {};
  const template = typeof first.laneNameTemplate === "string" ? first.laneNameTemplate : undefined;
  const migratedExecution: JsonObject = {
    ...execution,
    laneMode: "create",
    ...(template ? { laneNamePreset: "custom", laneNameTemplate: template } : {}),
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
          prompt: "Investigate and propose a fix for {{trigger.issue.title}}.",
        },
      },
      actions: [
        {
          type: "agent-session",
          modelId: "claude-opus-4-7",
        },
      ],
    },
    null,
    2,
  );
}

function buildAutomationsPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "list";

  if (sub === "list") {
    return { kind: "execute", label: "automations list", steps: [actionStep("result", "automations", "list")] };
  }

  if (sub === "show" || sub === "get") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    return { kind: "execute", label: `automations show ${id}`, steps: [actionStep("result", "automations", "get", { id })] };
  }

  if (sub === "example") {
    return { kind: "help", text: automationsExampleText() };
  }

  if (sub === "create") {
    const allowLegacy = readFlag(args, ["--allow-legacy"]);
    const raw = parseDraftInput(args);
    const draft = applyLaneFlagsToDraft(migrateLegacyCreateLane(raw, { allowLegacy }), args);
    return {
      kind: "execute",
      label: "automations create",
      steps: [actionStep("result", "automations", "saveRule", { draft })],
    };
  }

  if (sub === "update") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    const allowLegacy = readFlag(args, ["--allow-legacy"]);
    const raw = parseDraftInput(args);
    const draft = applyLaneFlagsToDraft(migrateLegacyCreateLane(raw, { allowLegacy }), args);
    return {
      kind: "execute",
      label: `automations update ${id}`,
      steps: [actionStep("result", "automations", "saveRule", { draft: { ...draft, id } })],
    };
  }

  if (sub === "delete") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    return { kind: "execute", label: `automations delete ${id}`, steps: [actionStep("result", "automations", "deleteRule", { id })] };
  }

  if (sub === "toggle") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    const enabledRaw = readValue(args, ["--enabled"]);
    if (enabledRaw == null) {
      throw new CliUsageError("automations toggle requires --enabled <true|false>.");
    }
    if (enabledRaw !== "true" && enabledRaw !== "false") {
      throw new CliUsageError("automations toggle --enabled must be true or false.");
    }
    const enabled = enabledRaw === "true";
    return {
      kind: "execute",
      label: `automations toggle ${id}`,
      steps: [actionStep("result", "automations", "toggleRule", { id, enabled })],
    };
  }

  if (sub === "run" || sub === "trigger") {
    const id = requireValue(readValue(args, ["--id"]) ?? firstPositional(args), "rule id");
    const dryRun = readFlag(args, ["--dry-run"]);
    const laneId = readLaneId(args);
    return {
      kind: "execute",
      label: `automations run ${id}`,
      steps: [actionStep("result", "automations", "triggerManually", {
        id,
        ...(dryRun ? { dryRun: true } : {}),
        ...(laneId ? { laneId } : {}),
      })],
    };
  }

  if (sub === "runs") {
    const automationId = readValue(args, ["--rule", "--automation", "--id"]);
    const limit = readIntOption(args, ["--limit"]);
    const status = readEnumOption(args, ["--status"], AUTOMATION_RUN_STATUSES, "--status");
    return {
      kind: "execute",
      label: "automations runs",
      steps: [actionStep("result", "automations", "listRuns", {
        ...(automationId ? { automationId } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        ...(status ? { status } : {}),
      })],
    };
  }

  if (sub === "run-show" || sub === "run-detail") {
    const runId = requireValue(readValue(args, ["--run", "--run-id"]) ?? firstPositional(args), "run id");
    return {
      kind: "execute",
      label: `automations run-show ${runId}`,
      formatter: "automation-run-detail",
      steps: [actionStep("result", "automations", "getRunDetail", { runId })],
    };
  }

  throw new CliUsageError(
    "automations supports list, show, create, update, delete, toggle, run, runs, run-show, or example.",
  );
}

function buildLinearPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "workflows";
  if (sub === "quick-view" || sub === "quick" || sub === "overview") {
    return { kind: "execute", label: "Linear quick view", formatter: "linear-quick-view", steps: [actionCallStep("result", "getLinearQuickView", collectGenericObjectArgs(args))] };
  }
  if (sub === "picker-data" || sub === "picker") {
    return { kind: "execute", label: "Linear picker data", steps: [actionCallStep("result", "getLinearIssuePickerData", collectGenericObjectArgs(args))] };
  }
  if (sub === "search-issues" || sub === "search") {
    const stateTypesValue = readValue(args, ["--state-type", "--state-types", "--state"]);
    const stateTypes = stateTypesValue
      ? stateTypesValue.split(",").map((entry) => entry.trim()).filter(Boolean)
      : [];
    const input: JsonObject = {};
    maybePut(input, "projectId", readValue(args, ["--project-id"]));
    maybePut(input, "projectSlug", readValue(args, ["--project-slug", "--project"]));
    maybePut(input, "teamKey", readValue(args, ["--team-key", "--team"]));
    if (stateTypes.length) input.stateTypes = stateTypes;
    maybePut(input, "assigneeId", readValue(args, ["--assignee", "--assignee-id"]));
    const priority = readNumberOption(args, ["--priority"]);
    if (priority !== undefined) input.priority = priority;
    maybePut(input, "query", readValue(args, ["--query", "-q"]));
    const first = readNumberOption(args, ["--first", "--limit"]);
    if (first !== undefined) input.first = first;
    maybePut(input, "after", readValue(args, ["--after", "--cursor"]));
    if (readFlag(args, ["--include-archived"])) input.includeArchived = true;
    return { kind: "execute", label: "Linear search issues", steps: [actionCallStep("result", "searchLinearIssues", collectGenericObjectArgs(args, input))] };
  }
  if (sub === "workflows") return { kind: "execute", label: "Linear workflows", steps: [actionCallStep("result", "listLinearWorkflows", collectGenericObjectArgs(args))] };
  if (sub === "run") {
    const mode = firstPositional(args) ?? "status";
    const toolByMode: Record<string, string> = {
      status: "getLinearRunStatus",
      resolve: "resolveLinearRunAction",
      cancel: "cancelLinearRun",
      reroute: "rerouteLinearRun",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("linear run supports status, resolve, cancel, or reroute.");
    return { kind: "execute", label: `Linear run ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args, { runId: readValue(args, ["--run", "--run-id"]) ?? firstPositional(args) }))] };
  }
  if (sub === "route") {
    const mode = firstPositional(args) ?? "cto";
    const toolByMode: Record<string, string> = {
      cto: "routeLinearIssueToCto",
      mission: "routeLinearIssueToMission",
      worker: "routeLinearIssueToWorker",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("linear route supports cto, mission, or worker.");
    return { kind: "execute", label: `Linear route ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args))] };
  }
  if (sub === "sync") {
    const mode = firstPositional(args) ?? "dashboard";
    const toolByMode: Record<string, string> = {
      dashboard: "getLinearSyncDashboard",
      run: "runLinearSyncNow",
      queue: "listLinearSyncQueue",
      resolve: "resolveLinearSyncQueueItem",
      detail: "getLinearWorkflowRunDetail",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("linear sync supports dashboard, run, queue, resolve, or detail.");
    return { kind: "execute", label: `Linear sync ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args))] };
  }
  if (sub === "ingress") {
    const mode = firstPositional(args) ?? "status";
    const toolByMode: Record<string, string> = {
      status: "getLinearIngressStatus",
      events: "listLinearIngressEvents",
      webhook: "ensureLinearWebhook",
    };
    const tool = toolByMode[mode];
    if (!tool) throw new CliUsageError("linear ingress supports status, events, or webhook.");
    return { kind: "execute", label: `Linear ingress ${mode}`, steps: [actionCallStep("result", tool, collectGenericObjectArgs(args))] };
  }
  return { kind: "execute", label: `Linear ${sub}`, steps: [actionStep("result", "linear_dispatcher", sub, collectGenericObjectArgs(args))] };
}

function buildFlowPlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "policy";
  if (sub !== "policy") return { kind: "execute", label: `flow ${sub}`, steps: [actionStep("result", "flow_policy", sub, collectGenericObjectArgs(args))] };
  const mode = firstPositional(args) ?? "get";
  const actionByMode: Record<string, string> = {
    get: "getPolicy",
    save: "savePolicy",
    validate: "validatePolicy",
    normalize: "normalizePolicy",
    revisions: "listRevisions",
    rollback: "rollbackRevision",
    diff: "diffPolicyPaths",
  };
  const action = actionByMode[mode];
  if (!action) throw new CliUsageError("flow policy supports get, save, validate, normalize, revisions, rollback, or diff.");
  return { kind: "execute", label: `flow policy ${mode}`, steps: [actionStep("result", "flow_policy", action, collectGenericObjectArgs(args))] };
}

function buildCoordinatorPlan(args: string[]): CliPlan {
  const toolName = requireValue(firstPositional(args), "coordinator tool").replace(/-/g, "_");
  return { kind: "execute", label: `coordinator ${toolName}`, steps: [actionCallStep("result", toolName, collectGenericObjectArgs(args))] };
}

function buildUpdatePlan(args: string[]): CliPlan {
  const sub = firstPositional(args) ?? "status";
  if (sub === "actions") return { kind: "execute", label: "update actions", steps: [listActionsStep("actions", "update")] };
  if (sub === "status" || sub === "state" || sub === "snapshot" || sub === "show") {
    return { kind: "execute", label: "update status", steps: [actionStep("result", "update", "getSnapshot", collectGenericObjectArgs(args))] };
  }
  if (sub === "check" || sub === "check-for-updates" || sub === "check-now") {
    return { kind: "execute", label: "update check", steps: [actionStep("result", "update", "checkForUpdates", collectGenericObjectArgs(args))] };
  }
  if (sub === "install" || sub === "quit-and-install" || sub === "apply") {
    return { kind: "execute", label: "update install", steps: [actionStep("result", "update", "quitAndInstall", collectGenericObjectArgs(args))] };
  }
  if (sub === "dismiss" || sub === "dismiss-installed" || sub === "dismiss-installed-notice") {
    return { kind: "execute", label: "update dismiss", steps: [actionStep("result", "update", "dismissInstalledNotice", collectGenericObjectArgs(args))] };
  }
  return { kind: "execute", label: `update ${sub}`, steps: [actionStep("result", "update", sub, collectGenericObjectArgs(args))] };
}

const VALUE_CARRIER_FLAGS: ReadonlySet<string> = new Set([
  // Only flags that actually take a following value (readValue / readIntOption
  // callers) belong here. Boolean-only flags consumed via readFlag must be
  // excluded, otherwise the next positional would be swallowed as their value.
  "-b", "-m", "-q", "-t",
  "--additional-instructions", "--app", "--app-bundle", "--arg", "--arg-json", "--arg-value",
  "--arg-value-json", "--args-list-json", "--attempt", "--attempt-id",
  "--automation", "--autonomy", "--backend", "--base", "--base-branch", "--base-ref", "--body", "--branch",
  "--branch-name", "--branch-ref", "--bundle", "--bundle-id", "--category", "--color", "--cols",
  "--command", "--comment", "--comment-id", "--commit", "--compare-ref",
  "--caption", "--cdp-port", "--chat-session", "--chat-session-id", "--compare-to", "--content", "--context-file", "--cwd", "--data",
  "--cpu", "--cpu-cores",
  "--debug-port",
  "--depth", "--desc", "--device", "--disk", "--disk-size", "--display", "--duration", "--duration-ms",
  "--description", "--domain", "--droid-autonomy", "--droid-permission-mode",
  "--duration-sec", "--enabled", "--event",
  "--end-x", "--end-y", "--file", "--fps", "--from", "--from-file", "--group", "--group-id", "--head", "--icon", "--id",
  "--image", "--index", "--initial-input", "--input", "--input-json", "--input-text", "--instructions",
  "--ipsw", "--kind",
  "--json-input", "--lane", "--lane-id", "--limit", "--max-bytes",
  "--line",
  "--max-log-bytes", "--max-prompt-chars", "--max-rounds", "--memory",
  "--memory-id", "--merge-method", "--message", "--method", "--mode", "--model",
  "--model-id", "--name", "--new", "--new-path", "--number", "--old",
  "--old-path", "--owner", "--owner-id", "--owner-kind",
  "--output",
  "--params-json", "--parent", "--parent-lane", "--parent-lane-id",
  "--path", "--permission-mode", "--permissions", "--port", "--pr", "--pr-id",
  "--pr-number", "--pr-url", "--process", "--process-id", "--project-root",
  "--prompt", "--provider", "--pty", "--pty-id", "--query", "--question",
  "--reason", "--reasoning", "--recent-limit", "--ref", "--resume-session", "--resume-session-id",
  "--resume-target", "--resume-target-id", "--role", "--root",
  "--root-lane", "--round", "--rounds", "--rows", "--rule", "--run", "--run-id", "--scalar",
  "--scalar-json", "--scope", "--seconds", "--session", "--session-id", "--set",
  "--set-json", "--sha", "--signal", "--since", "--source", "--source-lane", "--stack", "--stack-id",
  "--scheme", "--start-point", "--start-x", "--start-y", "--stash-ref", "--step", "--step-id", "--suite", "--suite-id", "--surface",
  "--tab", "--tab-identifier", "--target", "--target-id", "--terminal", "--terminal-id", "--thread", "--thread-id", "--timeout", "--timeout-ms", "--title", "--tool-type",
  "--title-query",
  "--udid", "--unattended", "--unattended-preset", "--url", "--value", "--vm-name", "--window-title", "--workspace", "--workspace-id", "--workspace-root",
  "--coordinate-space", "--coords",
  "--x", "--xcodeproj", "--y",
]);

function hasHelpFlag(args: string[]): boolean {
  const terminatorIndex = args.indexOf("--");
  const searchable = terminatorIndex >= 0 ? args.slice(0, terminatorIndex) : args;
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

function buildCliPlan(command: string[]): CliPlan {
  const args = [...command];
  const primary = firstPositional(args);
  if (!primary || primary === "-h" || primary === "--help") {
    return { kind: "help", text: TOP_LEVEL_HELP };
  }
  const aliases: Record<string, string> = {
    lane: "lanes",
    diff: "diff",
    diffs: "diff",
    file: "files",
    mission: "missions",
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
    macos: "macos-vm",
    "mac-vm": "macos-vm",
    macvm: "macos-vm",
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
    quota: "usage",
    quotas: "usage",
  };
  const primaryHelpKey = aliases[primary] ?? primary;
  if (hasHelpFlag(args)) {
    if (primaryHelpKey === "ios-sim") {
      return { kind: "help", text: buildIosSimulatorHelp(args) };
    }
    if (primaryHelpKey === "cursor") {
      return { kind: "help", text: buildCursorHelp(args) };
    }
    if (primaryHelpKey === "app-control") {
      return { kind: "help", text: buildAppControlHelp(args) };
    }
    return { kind: "help", text: HELP_BY_COMMAND[primaryHelpKey] ?? TOP_LEVEL_HELP };
  }
  if (primary === "help") {
    const topic = (firstPositional(args) ?? "").toLowerCase();
    const key = aliases[topic] ?? topic;
    if (key === "ios-sim") {
      return { kind: "help", text: buildIosSimulatorHelp(args) };
    }
    if (key === "cursor") {
      return { kind: "help", text: buildCursorHelp(args) };
    }
    if (key === "app-control") {
      return { kind: "help", text: buildAppControlHelp(args) };
    }
    return { kind: "help", text: key && HELP_BY_COMMAND[key] ? HELP_BY_COMMAND[key] : TOP_LEVEL_HELP };
  }
  if (primary === "version" || primary === "--version" || primary === "-v") {
    return { kind: "help", text: `ade ${VERSION}\n` };
  }
  if (primary === "status") {
    return { kind: "execute", label: "status", summary: "status", steps: [{ key: "ping", method: "ping" }] };
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
        { ...actionStep("projectConfig", "project_config", "get"), optional: true },
      ],
    };
  }
  if (primary === "auth") {
    const sub = firstPositional(args) ?? "status";
    if (sub !== "status") throw new CliUsageError("auth currently supports status.");
    return {
      kind: "execute",
      label: "auth status",
      summary: "auth",
      steps: [
        { key: "actions", method: "ade/actions/list" },
        { ...actionStep("projectConfig", "project_config", "get"), optional: true },
      ],
    };
  }
  if (WORKER_MISSION_TOOL_CLI_NAMES.has(primary)) {
    return buildWorkerMissionToolPlan(primary, args);
  }
  if (primary === "lanes" || primary === "lane") return buildLanePlan(args);
  if (primary === "git") return buildGitPlan(args);
  if (primary === "diff" || primary === "diffs") return buildDiffPlan(args);
  if (primary === "files" || primary === "file") return buildFilesPlan(args);
  if (primary === "missions" || primary === "mission") return buildMissionsPlan(args);
  if (primary === "prs" || primary === "pr") return buildPrPlan(args);
  if (primary === "run" || primary === "process" || primary === "processes") return buildRunPlan(args);
  if (primary === "shell" || primary === "pty") return buildShellPlan(args);
  if (primary === "terminal" || primary === "term") return buildTerminalPlan(args);
  if (primary === "chat" || primary === "chats" || primary === "work") return buildChatPlan(args);
  if (primary === "agent" || primary === "agents") return buildAgentPlan(args);
  if (primary === "cto") return buildCtoPlan(args);
  if (primary === "linear") return buildLinearPlan(args);
  if (primary === "automations" || primary === "automation") return buildAutomationsPlan(args);
  if (primary === "flow") return buildFlowPlan(args);
  if (primary === "coordinator" || primary === "coord") return buildCoordinatorPlan(args);
  if (primary === "ask") return { kind: "execute", label: "ask user", steps: [actionCallStep("result", "ask_user", collectGenericObjectArgs(args, { title: readValue(args, ["--title"]) ?? "ADE question", body: readValue(args, ["--body", "--question"]) ?? args.join(" ") }))] };
  if (primary === "tests" || primary === "test") return buildTestsPlan(args);
  if (primary === "proof" || primary === "computer-use" || primary === "artifacts" || primary === "computer" || primary === "artifact") {
    return buildProofPlan(args);
  }
  if (primary === "ios-sim" || primary === "ios" || primary === "simulator") return buildIosSimulatorPlan(args);
  if (primary === "app-control" || primary === "app" || primary === "apps" || primary === "electron") return buildAppControlPlan(args);
  if (primary === "macos-vm" || primary === "macos" || primary === "mac-vm" || primary === "macvm") return buildMacosVmPlan(args);
  if (primary === "browser" || primary === "ade-browser" || primary === "built-in-browser" || primary === "builtin-browser") return buildBrowserPlan(args);
  if (primary === "memory") return buildMemoryPlan(args);
  if (primary === "usage" || primary === "quota" || primary === "quotas") return buildUsagePlan(args);
  if (primary === "settings" || primary === "config" || primary === "setting") return buildSettingsPlan(args);
  if (primary === "actions" || primary === "action") return buildActionsPlan(args);
  if (primary === "update" || primary === "auto-update" || primary === "updates") return buildUpdatePlan(args);
  if (primary === "mcp" || primary === "mcp-server") return { kind: "mcp" };
  if (primary === "cursor") return buildCursorPlan(args);
  throw new CliUsageError(`Unknown command '${primary}'. Run 'ade help'.`);
}

function buildCursorPlan(args: string[]): CliPlan {
  // ade cursor <surface> <group> <sub> ... — only "cloud" is wired today.
  const surface = firstPositional(args);
  if (!surface || surface === "help" || hasHelpFlag([surface])) {
    return { kind: "help", text: HELP_BY_COMMAND.cursor ?? TOP_LEVEL_HELP };
  }
  if (surface !== "cloud") {
    throw new CliUsageError(`Unknown 'ade cursor' surface '${surface}'. The only supported surface is 'cloud'.`);
  }
  if (hasHelpFlag(args)) {
    const group = peekFirstPositional(args)?.toLowerCase();
    if (group && CURSOR_CLOUD_HELP[group]) {
      return { kind: "help", text: `${ADE_BANNER}${CURSOR_CLOUD_HELP[group]}` };
    }
    return { kind: "help", text: HELP_BY_COMMAND.cursor ?? TOP_LEVEL_HELP };
  }
  return { kind: "cursor-cloud", rest: args };
}

function findAdeManagedWorktreeRoot(startDir: string): { projectRoot: string; workspaceRoot: string } | null {
  let resolved = path.resolve(startDir);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // path may not yet exist on disk; use the lexical resolution.
  }
  const segments = resolved.split(path.sep);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] !== ".ade" || segments[index + 1] !== "worktrees") continue;
    const projectRoot = segments.slice(0, index).join(path.sep) || path.sep;
    const worktreeName = segments[index + 2];
    if (!worktreeName) continue;
    const workspaceRoot = segments.slice(0, index + 3).join(path.sep) || path.sep;
    if (!fs.existsSync(path.join(projectRoot, ".ade"))) continue;
    return { projectRoot: path.resolve(projectRoot), workspaceRoot: path.resolve(workspaceRoot) };
  }
  return null;
}

function findProjectRoots(startDir: string): { projectRoot: string; workspaceRoot: string } {
  let canonicalStart = path.resolve(startDir);
  try {
    canonicalStart = fs.realpathSync.native(canonicalStart);
  } catch {
    // path may not yet exist on disk; use the lexical resolution.
  }
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

function resolveRoots(options: GlobalOptions): { projectRoot: string; workspaceRoot: string } {
  const discovered = findProjectRoots(process.cwd());
  const projectFromEnv = process.env.ADE_PROJECT_ROOT?.trim()
    ? path.resolve(process.env.ADE_PROJECT_ROOT.trim())
    : null;
  const workspaceFromEnv = process.env.ADE_WORKSPACE_ROOT?.trim()
    ? path.resolve(process.env.ADE_WORKSPACE_ROOT.trim())
    : null;

  const projectRoot = options.projectRoot ?? projectFromEnv ?? discovered.projectRoot;
  const projectExplicitlyOverridden = options.projectRoot != null || projectFromEnv != null;

  const workspaceRoot =
    options.workspaceRoot
    ?? workspaceFromEnv
    ?? (projectExplicitlyOverridden ? projectRoot : discovered.workspaceRoot);

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

function runLocalCommand(command: string, args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
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
  const inside = runLocalCommand("git", ["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (!inside.ok || inside.stdout !== "true") {
    return {
      ready: false,
      status: "missing",
      message: "Project root is not inside a git worktree.",
      nextAction: "Run ade with --project-root pointing at a git repository.",
    };
  }
  const root = runLocalCommand("git", ["rev-parse", "--show-toplevel"], projectRoot);
  const branch = runLocalCommand("git", ["branch", "--show-current"], projectRoot);
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
  const remote = runLocalCommand("git", ["config", "--get", "remote.origin.url"], projectRoot);
  return remote.ok && remote.stdout ? remote.stdout : null;
}

function checkGitHubReadiness(projectRoot: string): ReadinessCheck {
  const remote = getGitRemote(projectRoot);
  const hasGitHubRemote = Boolean(remote && /github\.com[:/]/i.test(remote));
  const ghInstalled = commandExists("gh");
  const envTokenPresent = Boolean(process.env.ADE_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim());
  const ready = hasGitHubRemote && (ghInstalled || envTokenPresent);
  return {
    ready,
    status: ready ? "ready" : hasGitHubRemote ? "warning" : "unavailable",
    message: hasGitHubRemote
      ? ready
        ? "GitHub remote detected and a local auth mechanism is available."
        : "GitHub remote detected, but no gh CLI or GitHub token was found locally."
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
  const encryptedTokenPresent = fs.existsSync(path.join(layout.secretsDir, "linear-token.v1.bin"));
  const envTokenPresent = Boolean(
    process.env.ADE_LINEAR_API?.trim()
    || process.env.LINEAR_API_KEY?.trim()
    || process.env.ADE_LINEAR_TOKEN?.trim()
    || process.env.LINEAR_TOKEN?.trim()
  );
  const ready = encryptedTokenPresent || envTokenPresent;
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
      encryptedTokenPresent,
      tokenEnvPresent: envTokenPresent,
    },
  };
}

function checkProviderReadiness(value: unknown): ReadinessCheck {
  const configResult = isRecord(value) && isRecord(value.result) ? value.result : value;
  const effective = isRecord(configResult) && isRecord(configResult.effective) ? configResult.effective : {};
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
  const apiKeyProviders = Object.keys(apiKeys).filter((key) => Boolean(asString(apiKeys[key])));
  const ready = Boolean(defaultProvider || defaultModel || apiKeyProviders.length || Object.values(cliProviders).some(Boolean));
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
  const guiReady = isDarwin && (commandExists("swift") || commandExists("osascript"));
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
  const lookup = process.platform === "win32"
    ? runLocalCommand("where", ["ade"], process.cwd())
    : runLocalCommand("which", ["ade"], process.cwd());
  const current = path.resolve(process.argv[1] ?? "");
  const whichPath = lookup.ok && lookup.stdout ? path.resolve(lookup.stdout.split(/\r?\n/)[0]!) : null;
  const onPath = Boolean(whichPath);
  return {
    ready: onPath,
    status: onPath ? "ready" : "warning",
    message: onPath ? "ade is available on PATH." : "ade is not available on PATH.",
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

function requireAdeLayout(): { resolveAdeLayout: (projectRoot: string) => { secretsDir: string } } {
  // The CLI loads the shared layout dynamically elsewhere; this CommonJS fallback
  // keeps readiness checks synchronous and local-only.
  return { resolveAdeLayout: (projectRoot: string) => ({ secretsDir: path.join(projectRoot, ".ade", "secrets") }) };
}

function actionDomainCounts(value: unknown): Record<string, number> {
  const actions = isRecord(value) && Array.isArray(value.actions) ? value.actions.filter(isRecord) : [];
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
  const rpcActions = isRecord(values.rpcActions) && Array.isArray(values.rpcActions.actions) ? values.rpcActions.actions : [];
  const actions = isRecord(values.actions) && Array.isArray(values.actions.actions) ? values.actions.actions : [];
  const projectConfig = values.projectConfig;
  const adeDir = path.join(connection.projectRoot, ".ade");
  const sharedConfigPath = path.join(adeDir, "ade.yaml");
  const localConfigPath = path.join(adeDir, "local.yaml");
  const desktopSocketAvailable = connection.mode === "desktop-socket";
  const socketExists = isAdeMcpNamedPipePath(connection.socketPath)
    ? desktopSocketAvailable
    : fs.existsSync(connection.socketPath);
  const checks = {
    git: checkGitReadiness(connection.projectRoot),
    github: checkGitHubReadiness(connection.projectRoot),
    linear: checkLinearReadiness(connection.projectRoot),
    providers: checkProviderReadiness(projectConfig),
    computerUse: checkComputerUseReadiness(),
    path: checkPathReadiness(),
  };
  const recommendations = Object.entries(checks)
    .filter(([, check]) => check.nextAction)
    .map(([key, check]) => `${key}: ${check.nextAction}`);
  if (!desktopSocketAvailable) {
    recommendations.unshift("desktop: Start ADE desktop or pass --socket when Work chat, Path to Merge, Run tab state, or UI-owned proof state is required.");
  }
  const projectInitialized = fs.existsSync(adeDir);
  if (!projectInitialized) {
    recommendations.unshift("project: Run ade doctor from an ADE project or pass --project-root <repo>.");
  }
  const actionCountsByDomain = actionDomainCounts(values.actions);
  const ready = projectInitialized && checks.git.ready && actions.length > 0;

  return {
    ok: ready,
    cliVersion: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    mode: connection.mode,
    selectedMode: connection.mode,
    requestedMode: desktopSocketAvailable ? "desktop-socket" : "headless",
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
      socketAvailable: desktopSocketAvailable,
      message: desktopSocketAvailable
        ? "Connected to live ADE desktop socket."
        : socketExists
          ? "Socket path exists but CLI is running in headless mode; the socket may be stale or unavailable."
          : "No live ADE desktop socket was detected.",
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
    auth: {
      localProjectAccess: projectInitialized && actions.length > 0,
      providerSecretsExposed: false,
      note: "ADE CLI auth is local project access. Provider and integration readiness is reported as presence-only metadata.",
    },
    networkChecks: {
      performed: false,
      message: "Default doctor/auth checks do not call provider, GitHub, or Linear networks.",
    },
    recommendations,
    recommendation: recommendations[0] ?? (connection.mode === "desktop-socket"
      ? "Using live ADE desktop state."
      : "Headless mode is ready for local ADE actions; start ADE desktop for UI-owned runtime state."),
    summary,
  };
}

class SocketJsonRpcClient {
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(private readonly socket: net.Socket, private readonly timeoutMs: number) {
    socket.on("data", (chunk) => this.onData(Buffer.from(chunk)));
    socket.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => this.rejectAll(new Error("ADE desktop socket closed.")));
  }

  static connect(socketPath: string, timeoutMs: number): Promise<SocketJsonRpcClient> {
    return new Promise((resolve, reject) => {
      const connectTimeoutMs = Math.min(timeoutMs, 5000);
      const deadline = Date.now() + connectTimeoutMs;
      const retryable = (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EACCES" || error.code === "EPERM";
      const attempt = () => {
        const socket = (() => {
          if (socketPath.startsWith("tcp://")) {
            const parsed = new URL(socketPath);
            return net.createConnection({
              host: parsed.hostname,
              port: Number(parsed.port),
            });
          }
          return net.createConnection(socketPath);
        })();
        let settled = false;
        let connectTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (connectTimer) clearTimeout(connectTimer);
          fn();
        };
        connectTimer = setTimeout(() => {
          finish(() => {
            socket.destroy();
            reject(new Error(`Timed out connecting to ADE desktop socket after ${connectTimeoutMs}ms.`));
          });
        }, Math.max(1, deadline - Date.now()));
        socket.once("connect", () => {
          finish(() => resolve(new SocketJsonRpcClient(socket, timeoutMs)));
        });
        socket.once("error", (error: NodeJS.ErrnoException) => {
          finish(() => {
            socket.destroy();
            if (retryable(error) && Date.now() < deadline) {
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

  request(method: string, params?: JsonObject): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const body = `${JSON.stringify(payload)}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(body, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    this.socket.end();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
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
      this.rejectAll(new Error(`Failed to parse ADE socket response: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!isRecord(parsed)) return;
    const id = typeof parsed.id === "number" ? parsed.id : null;
    if (id == null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(parsed.error)) {
      pending.reject(new Error(asString(parsed.error.message) ?? "ADE JSON-RPC request failed."));
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
    try { this.handler.dispose?.(); } catch {}
    try { this.runtime.dispose(); } catch {}
    if (this.previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
    else process.env.ADE_DEFAULT_ROLE = this.previousRole;
  }
}

async function startHeadlessRpcSocketServer(args: {
  socketPath: string;
  createHandler: () => JsonRpcHandler & { dispose?: () => void };
}): Promise<(() => void) | null> {
  if (isAdeMcpNamedPipePath(args.socketPath) || fs.existsSync(args.socketPath)) {
    return null;
  }
  fs.mkdirSync(path.dirname(args.socketPath), { recursive: true });
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

  return () => {
    stopHeadlessRpcServer(serverState);
    try { fs.unlinkSync(args.socketPath); } catch {}
  };
}

async function startHeadlessRpcTcpServer(args: {
  createHandler: () => JsonRpcHandler & { dispose?: () => void };
}): Promise<{ url: string; stop: () => void }> {
  const serverState = createHeadlessRpcServer(args.createHandler);
  const { server } = serverState;

  const port = await new Promise<number>((resolve, reject) => {
    const handleListening = () => {
      server.off("error", handleError);
      const address = server.address();
      if (typeof address === "object" && address && typeof address.port === "number") {
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
    url: `tcp://127.0.0.1:${port}`,
    stop: () => stopHeadlessRpcServer(serverState),
  };
}

type HeadlessRpcServerState = {
  activeConnections: Set<net.Socket>;
  activeStops: Set<ReturnType<typeof startJsonRpcServer>>;
  server: net.Server;
};

function createHeadlessRpcServer(createHandler: () => JsonRpcHandler & { dispose?: () => void }): HeadlessRpcServerState {
  const activeConnections = new Set<net.Socket>();
  const activeStops = new Set<ReturnType<typeof startJsonRpcServer>>();
  const server = net.createServer((conn) => {
    activeConnections.add(conn);
    const handler = createHandler();
    const transport: JsonRpcTransport = {
      onData(callback) {
        conn.on("data", (chunk) => callback(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      },
      write(data) {
        conn.write(data);
      },
      close() {
        if (!conn.destroyed) conn.destroy();
      },
    };
    const stop = startJsonRpcServer(handler, transport, { nonFatal: true });
    activeStops.add(stop);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      activeConnections.delete(conn);
      activeStops.delete(stop);
      try { stop(); } catch {}
      try { handler.dispose?.(); } catch {}
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
    try { conn.destroy(); } catch {}
  }
  for (const stop of state.activeStops) {
    try { stop(); } catch {}
  }
  try { state.server.close(); } catch {}
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
    await Promise.all(discoverHeadlessWorktreeSocketPaths(args.projectRoot).map((socketPath) => ensure(socketPath)));
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
      try { stop(); } catch {}
    }
    stops.clear();
  };
}

export function shouldAttemptDesktopSocketConnection(socketPath: string): boolean {
  return isAdeMcpNamedPipePath(socketPath) || fs.existsSync(socketPath);
}

async function initializeConnection(connection: CliConnection, options: GlobalOptions): Promise<void> {
  await connection.request("ade/initialize", buildInitializeParams(options, "ade-cli"));
}

async function createConnection(options: GlobalOptions): Promise<CliConnection> {
  const roots = resolveRoots(options);
  const { resolveAdeLayout } = await import("../../desktop/src/shared/adeLayout");
  const layout = resolveAdeLayout(roots.projectRoot);
  const socketPath = process.env.ADE_RPC_URL?.trim() || process.env.ADE_RPC_SOCKET_PATH?.trim() || layout.socketPath;

  if (!options.headless && (shouldAttemptDesktopSocketConnection(socketPath) || options.requireSocket)) {
    try {
      const socketClient = await SocketJsonRpcClient.connect(socketPath, options.timeoutMs);
      const connection: CliConnection = {
        mode: "desktop-socket",
        projectRoot: roots.projectRoot,
        workspaceRoot: roots.workspaceRoot,
        socketPath,
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
    throw new Error(`ADE desktop socket is not available at ${socketPath}.`);
  }

  const previousRole = process.env.ADE_DEFAULT_ROLE;
  process.env.ADE_DEFAULT_ROLE = options.role;
  const [{ createAdeRuntime }, { createAdeRpcRequestHandler }] = await Promise.all([
    import("./bootstrap"),
    import("./adeRpcServer"),
  ]);
  const runtime = await createAdeRuntime({ projectRoot: roots.projectRoot, workspaceRoot: roots.workspaceRoot });
  const createHandler = () => createAdeRpcRequestHandler({
    runtime,
    serverVersion: VERSION,
    onActionsListChanged: () => {},
  });
  const handler = createHandler();
  const previousRpcUrl = process.env.ADE_RPC_URL;
  let stopHeadlessSocket: (() => void) | null = null;
  let stopHeadlessTcp: (() => void) | null = null;
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
      socketPath,
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
    socketPath,
    request: (method, params) => inProcess.request(method, params),
    close: () => {
      try { stopHeadlessSocket?.(); } catch {}
      try { stopHeadlessTcp?.(); } catch {}
      if (previousRpcUrl == null) delete process.env.ADE_RPC_URL;
      else process.env.ADE_RPC_URL = previousRpcUrl;
      inProcess.close();
    },
  };
  await initializeConnection(connection, options);
  return connection;
}

function buildInitializeParams(options: GlobalOptions, clientName: string): JsonObject {
  const envChatSessionId = asString(process.env.ADE_CHAT_SESSION_ID);
  const envMissionId = asString(process.env.ADE_MISSION_ID);
  const envRunId = asString(process.env.ADE_RUN_ID);
  const envStepId = asString(process.env.ADE_STEP_ID);
  const envAttemptId = asString(process.env.ADE_ATTEMPT_ID);
  const envOwnerId = asString(process.env.ADE_OWNER_ID);
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: clientName, version: VERSION },
    identity: {
      callerId: envChatSessionId ?? envAttemptId ?? `${clientName}:${process.pid}`,
      role: options.role,
      ...(envChatSessionId ? { chatSessionId: envChatSessionId } : {}),
      ...(envMissionId ? { missionId: envMissionId } : {}),
      ...(envRunId ? { runId: envRunId } : {}),
      ...(envStepId ? { stepId: envStepId } : {}),
      ...(envAttemptId ? { attemptId: envAttemptId } : {}),
      ...(envOwnerId ? { ownerId: envOwnerId } : {}),
      computerUsePolicy: {
        mode: "auto",
        allowLocalFallback: options.role !== "external",
        retainArtifacts: true,
      },
    },
  };
}

function normalizeMcpAdeToolName(name: string): string {
  const trimmed = name.trim();
  const prefixPatterns = [
    /^ade[_:.](.+)$/i,
    /^mcp[_:.]ade[_:.](.+)$/i,
    /^mcp__ade__(.+)$/i,
  ];
  for (const pattern of prefixPatterns) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) return match[1].trim();
  }
  return trimmed;
}

function mcpToolScope(): "all" | "coordinator" {
  return process.env.ADE_MCP_TOOL_SCOPE === "coordinator" ? "coordinator" : "all";
}

function isMcpToolVisible(name: string): boolean {
  if (mcpToolScope() !== "coordinator") return true;
  return COORDINATOR_MCP_TOOL_NAMES.has(normalizeMcpAdeToolName(name));
}

function formatMcpToolText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

async function runMcpServer(options: GlobalOptions): Promise<void> {
  const roots = resolveRoots({ ...options, headless: true, requireSocket: false });
  const previousRole = process.env.ADE_DEFAULT_ROLE;
  process.env.ADE_DEFAULT_ROLE = options.role;
  const [{ createAdeRuntime }, { createAdeRpcRequestHandler }] = await Promise.all([
    import("./bootstrap"),
    import("./adeRpcServer"),
  ]);
  const runtime = await createAdeRuntime({ projectRoot: roots.projectRoot, workspaceRoot: roots.workspaceRoot });
  const adeHandler = createAdeRpcRequestHandler({
    runtime,
    serverVersion: VERSION,
    onActionsListChanged: () => {},
  });
  let initialized = false;
  let nextAdeRequestId = 1;
  const callAde = async (method: string, params?: JsonObject): Promise<unknown> => {
    return await adeHandler({
      jsonrpc: "2.0",
      id: nextAdeRequestId++,
      method,
      ...(params !== undefined ? { params } : {}),
    });
  };
  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    await callAde("ade/initialize", buildInitializeParams(options, "ade-mcp"));
    initialized = true;
  };

  const mcpHandler: JsonRpcHandler = async (request) => {
    const method = typeof request.method === "string" ? request.method : "";
    const params = isRecord(request.params) ? request.params : {};
    if (method === "initialize") {
      await ensureInitialized();
      const requestedVersion = asString(params.protocolVersion) ?? PROTOCOL_VERSION;
      return {
        protocolVersion: requestedVersion,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: "ade",
          version: VERSION,
        },
      };
    }
    if (method === "notifications/initialized" || method === "initialized") {
      await ensureInitialized();
      return null;
    }
    await ensureInitialized();
    if (method === "tools/list") {
      const listed = await callAde("ade/actions/list");
      const actions = isRecord(listed) && Array.isArray(listed.actions)
        ? listed.actions.filter(isRecord)
        : [];
      return {
        tools: actions
          .map((action) => ({
            name: asString(action.name) ?? "",
            description: asString(action.description) ?? "",
            inputSchema: isRecord(action.inputSchema) ? action.inputSchema : { type: "object", properties: {} },
          }))
          .filter((tool) => tool.name.length > 0 && isMcpToolVisible(tool.name)),
      };
    }
    if (method === "tools/call") {
      const rawName = asString(params.name);
      if (!rawName) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "tools/call requires a tool name.");
      }
      if (!isMcpToolVisible(rawName)) {
        throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Tool not available in this MCP scope: ${rawName}`);
      }
      const result = await callAde("ade/actions/call", {
        name: normalizeMcpAdeToolName(rawName),
        arguments: isRecord(params.arguments) ? params.arguments : {},
      });
      const isError = isRecord(result) && result.ok === false;
      return {
        content: [
          {
            type: "text",
            text: formatMcpToolText(result),
          },
        ],
        structuredContent: result ?? null,
        isError,
      };
    }
    if (method === "shutdown") {
      return {};
    }
    if (method === "exit") {
      process.nextTick(() => process.exit(0));
      return {};
    }
    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Method not found: ${method}`);
  };

  const transport: JsonRpcTransport = {
    onData(callback) {
      process.stdin.on("data", (chunk) => callback(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    },
    write(data) {
      process.stdout.write(data);
    },
    close() {
      process.stdin.pause();
    },
  };
  const stop = startJsonRpcServer(mcpHandler, transport, { nonFatal: true });
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
  });
  stop();
  try { adeHandler.dispose?.(); } catch {}
  try { runtime.dispose(); } catch {}
  if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
  else process.env.ADE_DEFAULT_ROLE = previousRole;
}

function unwrapToolResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result.isError === true) {
    const structured = result.structuredContent;
    const message = isRecord(structured) && isRecord(structured.error)
      ? asString(structured.error.message) ?? "ADE tool call failed."
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
    Object.prototype.hasOwnProperty.call(value, "result")
    && (asString(value.domain) || asString(value.action) || Object.prototype.hasOwnProperty.call(value, "statusHint"))
  ) {
    return value.result;
  }
  return value;
}

function missionIdFromCreateResult(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  const mission = firstRecord(result, ["mission"]);
  const id = asString(mission?.id) ?? (isRecord(result) ? asString(result.id) : null);
  return requireValue(id ?? null, "created mission id");
}

function newestRunFromListResult(value: unknown): JsonObject | null {
  const result = unwrapActionEnvelope(value);
  const runs = firstArray(result, ["runs", "items", "results"]);
  if (runs.length === 0) return null;
  return [...runs].sort((left, right) => {
    const leftAt = asString(left.startedAt) ?? asString(left.createdAt) ?? "";
    const rightAt = asString(right.startedAt) ?? asString(right.createdAt) ?? "";
    return rightAt.localeCompare(leftAt);
  })[0] ?? null;
}

function runFromStartResult(value: unknown): JsonObject | null {
  const result = unwrapActionEnvelope(value);
  const direct = firstRecord(result, ["run"]);
  if (direct && asString(direct.id)) return direct;
  const started = firstRecord(result, ["started"]);
  const nested = firstRecord(started, ["run"]);
  if (nested && asString(nested.id)) return nested;
  if (started && asString(started.id)) return started;
  return null;
}

function missionFromResult(value: unknown): JsonObject | null {
  const result = unwrapActionEnvelope(value);
  const mission = firstRecord(result, ["mission"]);
  if (mission && asString(mission.id)) return mission;
  if (isRecord(result) && asString(result.id)) return result;
  return null;
}

function graphFromResult(value: unknown): JsonObject | null {
  const result = unwrapActionEnvelope(value);
  if (!isRecord(result)) return null;
  if (hasRunGraphShape(result)) return result;
  const nestedGraph = isRecord(result.graph) ? result.graph : null;
  const graph = nestedGraph && hasRunGraphShape(nestedGraph) ? nestedGraph : nestedGraph ?? result;
  return isRecord(graph) ? graph : null;
}

function runFromGraphResult(value: unknown): JsonObject | null {
  const graph = graphFromResult(value);
  return firstRecord(graph, ["run"]);
}

function hasRunGraphShape(value: unknown): boolean {
  return isRecord(value) && (
    isRecord(value.run)
    || Array.isArray(value.steps)
    || Array.isArray(value.attempts)
    || Array.isArray(value.timeline)
  );
}

function runIdFromWatchValues(values: JsonObject): string {
  const explicitGraph = unwrapActionEnvelope(values.graph);
  if (isRecord(explicitGraph)) {
    const graphRun = firstRecord(explicitGraph, ["run"]);
    const graphRunId = asString(graphRun?.id);
    if (graphRunId) return graphRunId;
  }
  const run = newestRunFromListResult(values.runs);
  return requireValue(asString(run?.id) ?? null, "run id");
}

function renderLaneGraph(result: unknown): string {
  const lanesRaw = isRecord(result) && Array.isArray(result.lanes) ? result.lanes : [];
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
      const leftDepth = typeof left.stackDepth === "number" ? left.stackDepth : 0;
      const rightDepth = typeof right.stackDepth === "number" ? right.stackDepth : 0;
      if (leftDepth !== rightDepth) return leftDepth - rightDepth;
      return String(left.name ?? left.id ?? "").localeCompare(String(right.name ?? right.id ?? ""));
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
    lines.push(`${prefix}${isLast ? "\\- " : "|- "}${name}${idSuffix}${branch ? ` [${branch}]` : ""}${status ? ` ${status}` : ""}${archived}`);
    const children = id ? byParent.get(id) ?? [] : [];
    children.forEach((child, index) => visit(child, `${prefix}${isLast ? "   " : "|  "}`, index === children.length - 1));
  };
  const roots = byParent.get("") ?? [];
  roots.forEach((lane, index) => visit(lane, "", index === roots.length - 1));
  return lines.join("\n");
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
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return truncateCell(value, width);
  if (Array.isArray(value)) return truncateCell(value.map((entry) => cell(entry, 18)).filter(Boolean).join(", "), width);
  if (isRecord(value)) {
    const id = asString(value.id) ?? asString(value.name) ?? asString(value.title);
    return id ? truncateCell(id, width) : truncateCell(JSON.stringify(value), width);
  }
  return truncateCell(String(value), width);
}

function formatAutomationRunDetail(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  const run = isRecord(value.run) ? value.run : value;
  const actions = Array.isArray(value.actions)
    ? value.actions
    : Array.isArray(run.actions) ? run.actions : [];
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
      const kind = typeof action.kind === "string" ? action.kind
        : typeof action.type === "string" ? action.type
        : "action";
      const status = typeof action.status === "string" ? action.status : "?";
      const error = typeof action.errorMessage === "string" ? action.errorMessage : "";
      const output = typeof action.output === "string" ? action.output : "";
      const isLaneSetup = kind === "lane-setup";
      const note = error
        ? (isLaneSetup ? `FAILED: ${error}` : error)
        : isLaneSetup && output
          ? `created lane: ${output}`
          : output;
      const label = isLaneSetup ? "lane-setup" : kind;
      return [label, status, note];
    });
  const table = renderTable(["step", "status", "detail"], rows, "(no actions)");
  return [header, "", "Actions", table].join("\n");
}

function renderKeyValues(title: string, entries: Array<[string, unknown]>): string {
  const rows = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));
  return [
    title,
    ...rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${cell(value, 96)}`),
  ].join("\n");
}

function renderTable(headers: string[], rows: unknown[][], emptyMessage: string): string {
  if (rows.length === 0) return emptyMessage;
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => cell(row[index], index === headers.length - 1 ? 64 : 28).length),
  ));
  const renderRow = (row: unknown[]) => row.map((entry, index) => cell(entry, index === headers.length - 1 ? 64 : 28).padEnd(widths[index] ?? 0)).join("  ").trimEnd();
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
  if (["success", "passing", "passed", "completed", "ready", "clean", "ok"].includes(raw)) return "OK";
  if (["failure", "failed", "failing", "error", "blocked", "dirty"].includes(raw)) return "FAIL";
  if (["pending", "running", "in_progress", "queued", "active"].includes(raw)) return "WAIT";
  return raw.toUpperCase();
}

function formatActionsList(value: unknown): string {
  const actionResult = isRecord(value) && isRecord(value.actions) ? value.actions : value;
  const actions = firstArray(actionResult, ["actions"]);
  if (actions.length === 0) return "ADE actions\n(no actions)";
  const byDomain = new Map<string, JsonObject[]>();
  for (const action of actions) {
    const name = asString(action.name);
    const domain = asString(action.domain) ?? (name?.includes(".") ? name.split(".")[0] : null) ?? "core";
    const list = byDomain.get(domain) ?? [];
    list.push(action);
    byDomain.set(domain, list);
  }
  const lines = [
    "ADE actions",
    "Use: ade actions run <domain.action> --input-json '{\"key\":\"value\"}'",
    "For multi-parameter methods: --args-list-json '[\"first\",{\"second\":true}]'",
  ];
  for (const [domain, list] of [...byDomain.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push("", `${domain}:`);
    for (const action of list.sort((left, right) => cell(left.action ?? left.name).localeCompare(cell(right.action ?? right.name)))) {
      const name = asString(action.action) ?? asString(action.name) ?? "(unknown)";
      const description = asString(action.description) ?? "";
      lines.push(`  ${name}${description ? ` - ${truncateCell(description, 86)}` : ""}`);
    }
  }
  return lines.join("\n");
}

function formatLaneDetail(value: unknown): string {
  const root = isRecord(value) ? value : {};
  const lane = firstRecord(value, ["lane"]) ?? (isRecord(value) ? value : {});
  return renderKeyValues("ADE lane", [
    ["id", lane.id],
    ["name", lane.name],
    ["branch", lane.branchRef ?? lane.branch],
    ["base", lane.baseBranch ?? lane.baseRef],
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

function formatPrChecks(value: unknown): string {
  const checks = firstArray(value, ["checks", "items"]);
  const summary = isRecord(value) ? value.summary : null;
  const header = summary ? `ADE PR checks - ${cell(summary, 80)}` : "ADE PR checks";
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
    lines.push("", renderTable(
      ["thread", "state", "file", "comment"],
      threads.map((thread) => {
        const threadComments = Array.isArray(thread.comments) ? thread.comments.filter(isRecord) : [];
        const first = threadComments[0] ?? {};
        return [
          thread.id,
          thread.isResolved ? "resolved" : "open",
          `${cell(thread.path, 34)}${thread.line ? `:${thread.line}` : ""}`,
          first.body ?? thread.body,
        ];
      }),
      "(no review threads)",
    ));
  }
  if (comments.length > 0) {
    lines.push("", renderTable(
      ["id", "author", "comment"],
      comments.map((comment) => [comment.id, comment.author ?? comment.user, comment.body]),
      "(no issue comments)",
    ));
  }
  if (threads.length === 0 && comments.length === 0) lines.push("(no comments)");
  return lines.join("\n");
}

function phaseKeysFromMission(mission: JsonObject): string {
  const metadata = isRecord(mission.metadata) ? mission.metadata : {};
  const phaseConfiguration = isRecord(metadata.phaseConfiguration) ? metadata.phaseConfiguration : {};
  const phaseKeys = Array.isArray(phaseConfiguration.phaseKeys)
    ? phaseConfiguration.phaseKeys
    : Array.isArray(phaseConfiguration.phases)
      ? phaseConfiguration.phases.filter(isRecord).map((phase) => phase.phaseKey)
      : [];
  return phaseKeys.map((key) => cell(key, 24)).filter(Boolean).join(" -> ");
}

function formatMissionDetail(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  const mission = firstRecord(result, ["mission"]) ?? (isRecord(result) ? result : {});
  const steps = firstArray(mission, ["steps"]);
  const phaseKeys = phaseKeysFromMission(mission);
  return [
    renderKeyValues("ADE mission", [
      ["id", mission.id],
      ["title", mission.title],
      ["status", mission.status],
      ["priority", mission.priority],
      ["lane", mission.laneId ?? mission.laneName],
      ["mission lane", mission.missionLaneId ?? mission.missionLaneName],
      ["result lane", mission.resultLaneId ?? mission.resultLaneName],
      ["steps", steps.length || mission.totalSteps],
      ["phases", phaseKeys],
      ["error", mission.lastError],
    ]),
    steps.length
      ? `\nSteps\n${renderTable(
          ["#", "status", "phase", "title"],
          steps.map((step) => [
            step.index ?? step.stepIndex,
            step.status,
            step.phaseKey ?? (isRecord(step.metadata) ? step.metadata.phaseKey : null),
            step.title,
          ]),
          "(no steps)",
        )}`
      : "",
  ].filter(Boolean).join("\n");
}

function formatMissionList(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  const missions = firstArray(result, ["missions", "items", "results"]);
  return `ADE missions\n${renderTable(
    ["mission", "status", "lane", "steps", "title"],
    missions.map((mission) => [
      mission.id,
      mission.status,
      mission.laneId ?? mission.laneName ?? mission.missionLaneId,
      `${cell(mission.completedSteps, 8)}/${cell(mission.totalSteps, 8)}`,
      mission.title,
    ]),
    "(no missions)",
  )}`;
}

function formatMissionRuns(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  const runs = firstArray(result, ["runs", "items", "results"]);
  return `ADE mission runs\n${renderTable(
    ["run", "status", "mission", "mode", "started"],
    runs.map((run) => {
      const metadata = isRecord(run.metadata) ? run.metadata : {};
      return [
        run.id,
        run.status,
        run.missionId,
        metadata.runMode ?? run.runMode,
        run.startedAt ?? run.createdAt,
      ];
    }),
    "(no runs)",
  )}`;
}

function formatMissionGraph(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  const graph = isRecord(result) && isRecord(result.graph) ? result.graph : result;
  const run = firstRecord(graph, ["run"]) ?? {};
  const steps = firstArray(graph, ["steps"]);
  const attempts = firstArray(graph, ["attempts"]);
  const timeline = firstArray(graph, ["timeline", "events"]);
  return [
    renderKeyValues("ADE mission run graph", [
      ["run", run.id],
      ["mission", run.missionId],
      ["status", run.status],
      ["steps", steps.length],
      ["attempts", attempts.length],
      ["timeline events", timeline.length],
      ["started", run.startedAt ?? run.createdAt],
      ["error", run.lastError],
    ]),
    steps.length
      ? `\nSteps\n${renderTable(
          ["step", "status", "phase", "title"],
          steps.map((step) => [
            step.id ?? step.stepKey,
            step.status,
            step.phaseKey ?? (isRecord(step.metadata) ? step.metadata.phaseKey : null),
            step.title,
          ]),
          "(no steps)",
        )}`
      : "",
  ].filter(Boolean).join("\n");
}

function formatMissionWatch(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const created = unwrapActionEnvelope(result.created);
  const started = unwrapActionEnvelope(result.started ?? result.result);
  const mission = missionFromResult(result.mission)
    ?? missionFromResult(created)
    ?? missionFromResult(started)
    ?? {};
  const runsResult = unwrapActionEnvelope(result.runs);
  const newestRun = newestRunFromListResult(runsResult) ?? runFromStartResult(started);
  const graphResult = unwrapActionEnvelope(result.graph);
  const graph = graphFromResult(graphResult) ?? {};
  const wait = firstRecord(graphResult, ["wait"]);
  const graphRun = runFromGraphResult(graphResult) ?? newestRun ?? {};
  const graphSteps = firstArray(graph, ["steps"]);
  const parts = [
    renderKeyValues("ADE mission watch", [
      ["mission", mission.id],
      ["title", mission.title],
      ["mission status", mission.status],
      ["run", graphRun.id],
      ["run status", graphRun.status],
      ["steps", graphSteps.length || mission.totalSteps],
      ["mission lane", mission.missionLaneId ?? mission.missionLaneName],
      ["result lane", mission.resultLaneId ?? mission.resultLaneName],
      ["wait timed out", wait?.timedOut],
      ["wait extended", wait?.extendedForActiveHeadlessWork],
      ["error", mission.lastError ?? graphRun.lastError],
    ]),
  ];
  if (graphSteps.length > 0) {
    parts.push("", renderTable(
      ["step", "status", "phase", "title"],
      graphSteps.map((step) => [
        step.id ?? step.stepKey,
        step.status,
        step.phaseKey ?? (isRecord(step.metadata) ? step.metadata.phaseKey : null),
        step.title,
      ]),
      "(no steps)",
    ));
  }
  return parts.join("\n");
}

function formatFileTree(value: unknown): string {
  const entries = firstArray(value, ["entries", "nodes", "items", "children"]);
  return renderTable(
    ["type", "path", "size"],
    entries.map((entry) => [entry.type ?? (entry.isDirectory ? "dir" : "file"), entry.path ?? entry.name, entry.sizeBytes ?? entry.size]),
    "ADE files\n(no entries)",
  );
}

function formatFileRead(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  const text = typeof value.text === "string" ? value.text : typeof value.content === "string" ? value.content : null;
  return text ?? JSON.stringify(value, null, 2);
}

function formatFilesSearch(value: unknown): string {
  const matches = firstArray(value, ["matches", "results", "items"]);
  return renderTable(
    ["file", "line", "match"],
    matches.map((match) => [match.path ?? match.filePath, match.line ?? match.lineNumber, match.preview ?? match.text ?? match.match]),
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
  const rows = firstArray(value, ["processes", "definitions", "runtime", "runs", "items"]);
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

function formatChatList(value: unknown): string {
  const sessions = firstArray(value, ["sessions", "chats", "items"]);
  return renderTable(
    ["session", "provider", "lane", "title"],
    sessions.map((session) => [session.id ?? session.sessionId, session.provider ?? session.modelId, session.laneId, session.title]),
    "ADE chats\n(no sessions)",
  );
}

function formatTestsRuns(value: unknown): string {
  const runs = firstArray(value, ["runs", "items"]);
  return renderTable(
    ["run", "status", "suite", "duration"],
    runs.map((run) => [run.id ?? run.runId, statusWord(run.status), run.suiteId ?? run.suiteName, run.durationMs]),
    "ADE test runs\n(no runs)",
  );
}

function formatProofList(value: unknown): string {
  const artifacts = firstArray(value, ["artifacts", "items"]);
  return renderTable(
    ["kind", "created", "title", "path"],
    artifacts.map((artifact) => [artifact.kind ?? artifact.type, artifact.createdAt, artifact.title ?? artifact.name, artifact.path ?? artifact.uri]),
    "ADE proof artifacts\n(no artifacts)",
  );
}

function formatIosSimStatus(value: unknown): string {
  const status = isRecord(value) ? value : {};
  const tools = Array.isArray(status.tools) ? status.tools.filter(isRecord) : [];
  const activeDevice = isRecord(status.activeDevice) ? status.activeDevice : {};
  const activeSession = isRecord(status.activeSession) ? status.activeSession : {};
  return [
    renderKeyValues("ADE iOS simulator", [
      ["supported", status.supported],
      ["platform", status.platform],
      ["active device", activeDevice.name ? `${activeDevice.name} (${activeDevice.state})` : null],
      ["active app", activeSession.bundleId],
      ["mode", activeSession.mode],
      ["chat session", activeSession.chatSessionId],
    ]),
    "",
    renderTable(
      ["tool", "ready", "detail"],
      tools.map((tool) => [tool.name, tool.available ? "yes" : "no", tool.detail]),
      "Tools\n(none)",
    ),
  ].join("\n");
}

function formatIosSimDevices(value: unknown): string {
  const devices = Array.isArray(value) ? value.filter(isRecord) : firstArray(value, ["devices", "items"]);
  return renderTable(
    ["udid", "device", "runtime", "state"],
    devices.map((device) => [device.udid, device.name, device.runtime, device.state]),
    "ADE iOS simulators\n(no installed simulators)",
  );
}

function formatIosSimApps(value: unknown): string {
  const targets = Array.isArray(value) ? value.filter(isRecord) : firstArray(value, ["targets", "apps", "items"]);
  return renderTable(
    ["target", "kind", "name", "bundle"],
    targets.map((target) => [target.id, target.kind, target.name, target.bundleId ?? target.detail]),
    "ADE iOS launchable apps\n(no apps)",
  );
}

function formatIosSimStream(value: unknown): string {
  const status = isRecord(value) ? value : {};
  return renderKeyValues("ADE iOS simulator stream", [
    ["running", status.running],
    ["requested backend", status.requestedBackend],
    ["resolved backend", status.backend],
    ["fallback reason", status.fallbackReason],
    ["degradation reason", status.degradationReason],
    ["device", status.deviceUdid],
    ["fps", status.fps ?? status.targetFps],
    ["frames", status.frameCount],
    ["avg latency ms", status.averageLatencyMs],
    ["latency p50 ms", status.latencyP50Ms],
    ["latency p95 ms", status.latencyP95Ms],
    ["helper pid", status.helperPid],
    ["input backend", status.inputBackend],
    ["error code", isRecord(status.error) ? status.error.code : null],
    ["started", status.startedAt],
    ["last frame", status.lastFrameAt],
    ["stream url", status.streamUrl],
    ["error", status.lastError],
  ]);
}

function formatIosSimSnapshot(value: unknown): string {
  const snapshot = isRecord(value) ? value : {};
  const screenshot = isRecord(snapshot.screenshot) ? snapshot.screenshot : snapshot;
  const screen = isRecord(snapshot.screen) ? snapshot.screen : {};
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers.filter(isRecord) : [];
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements.filter(isRecord) : [];
  const providerSummary = providers.map((provider) => `${provider.source}:${provider.available ? provider.elementCount ?? "ok" : "unavailable"}`).join(", ");
  return [
    renderKeyValues("ADE iOS simulator snapshot", [
      ["device", snapshot.deviceUdid],
      ["captured", snapshot.capturedAt],
      ["screenshot", screenshot.width && screenshot.height ? `${screenshot.width}x${screenshot.height}` : null],
      ["screen", screen.width && screen.height ? `${screen.width}x${screen.height} @${screen.scale ?? 1}x` : null],
      ["elements", elements.length],
      ["providers", providerSummary],
    ]),
    elements.length ? "" : "",
    elements.length
      ? renderTable(
          ["id", "source", "label", "source file"],
          elements.slice(0, 20).map((element) => [
            element.id,
            element.source,
            element.label ?? element.identifier ?? element.componentId,
            element.sourceFile ? `${element.sourceFile}${element.sourceLine ? `:${element.sourceLine}` : ""}` : "",
          ]),
          "",
        )
      : "",
  ].filter(Boolean).join("\n");
}

function formatIosSimSelection(value: unknown): string {
  const item = firstRecord(value, ["item", "selection"]) ?? (isRecord(value) ? value : {});
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  return renderKeyValues("ADE iOS simulator selection", [
    ["component", item.componentId],
    ["source", isRecord(value) ? value.source ?? metadata.screenElementSource : metadata.screenElementSource],
    ["file", item.sourceFile ? `${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}` : null],
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
      targets.map((target) => [target.previewDefinitionIndexInFile, target.title, target.sourceFilePath ?? target.sourceFile, target.kind]),
      "ADE iOS previews\n(no #Preview definitions found)",
    );
  }
  const record = isRecord(value) ? value : {};
  const capability = isRecord(record.capability) ? record.capability : record;
  const steps = Array.isArray(capability.setupSteps) ? capability.setupSteps.join("; ") : null;
  const selectedWindow = isRecord(capability.selectedWindow) ? capability.selectedWindow : {};
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

function formatMacosVmStatus(value: unknown): string {
  const status = isRecord(value) ? value : {};
  if (isRecord(status.previous) || status.name || status.laneId) {
    const vm = isRecord(status.previous) ? status.previous : status;
    return renderKeyValues("ADE macOS VM", [
      ["deleted", "deleted" in status ? status.deleted : null],
      ["lane", vm.laneName ?? vm.laneId],
      ["vm", vm.name],
      ["state", vm.state],
      ["guest path", vm.guestSharedPath],
      ["host path", vm.sharedDirectory ?? vm.laneRoot],
      ["ssh", vm.sshCommand],
      ["vnc", vm.vncUrl],
      ["ip", vm.ipAddress],
      ["share mode", isRecord(vm.metadata) ? vm.metadata.shareMode : null],
      ["last error", vm.lastError],
    ]);
  }
  const provider = isRecord(status.activeProvider) ? status.activeProvider : {};
  const tools = Array.isArray(status.tools) ? status.tools.filter(isRecord) : [];
  const laneVm = isRecord(status.laneVm) ? status.laneVm : null;
  const vms = Array.isArray(status.vms) ? status.vms.filter(isRecord) : [];
  const lines = [
    renderKeyValues("ADE macOS VM", [
      ["supported", status.supported],
      ["platform", status.platform],
      ["arch", status.arch],
      ["provider", provider.kind],
      ["provider ready", provider.available],
      ["provider detail", provider.detail],
      ["lane VM", laneVm ? `${laneVm.name ?? laneVm.id} (${laneVm.state ?? "unknown"})` : null],
      ["guest path", laneVm?.guestSharedPath],
      ["host path", laneVm?.sharedDirectory ?? laneVm?.laneRoot],
      ["ssh", laneVm?.sshCommand],
      ["vnc", laneVm?.vncUrl],
    ]),
    "",
    renderTable(
      ["lane", "vm", "state", "host path"],
      vms.map((vm) => [vm.laneName ?? vm.laneId, vm.name, vm.state, vm.sharedDirectory ?? vm.laneRoot]),
      "Lane VMs\n(none)",
    ),
    "",
    renderTable(
      ["tool", "ready", "detail"],
      tools.map((tool) => [tool.name, tool.available ? "yes" : "no", tool.detail]),
      "Tools\n(none)",
    ),
  ];
  return lines.join("\n");
}

function formatMacosVmSharePolicy(value: unknown): string {
  const policy = isRecord(value) ? value : {};
  const excludedPaths = Array.isArray(policy.excludedPaths) ? policy.excludedPaths.filter((entry) => typeof entry === "string") : [];
  return renderKeyValues("ADE macOS VM share policy", [
    ["allowed", policy.allowed],
    ["mode", policy.syncMode],
    ["host path", policy.hostPath],
    ["original host path", policy.originalHostPath],
    ["guest path", policy.guestPath],
    ["mirror path", policy.mirrorPath],
    ["read only", policy.readOnly],
    ["detail", policy.detail],
    ["blocked", policy.blockedReason],
    ["excluded", excludedPaths.length ? excludedPaths.join(", ") : null],
  ]);
}

function formatMacosVmGuide(value: unknown): string {
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return renderKeyValues("ADE macOS VM guide", Object.entries(isRecord(value) ? value : {}).slice(0, 24));
}

function formatMacosVmCapture(value: unknown): string {
  const capture = isRecord(value) ? value : {};
  const window = isRecord(capture.window) ? capture.window : {};
  const frame = isRecord(window.frame) ? window.frame : null;
  return renderKeyValues("ADE macOS VM capture", [
    ["ok", capture.ok],
    ["lane", capture.laneId],
    ["vm", capture.vmName],
    ["path", capture.path],
    ["mode", capture.captureMode],
    ["window", window.windowTitle],
    ["process", window.processName],
    ["frame", frame ? `${frame.x},${frame.y} ${frame.width}x${frame.height}` : null],
    ["captured", capture.capturedAt],
    ["image data", capture.dataUrl ? "included" : null],
  ]);
}

function formatMacosVmSelection(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const item = isRecord(result.item) ? result.item : {};
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const selectedPoint = isRecord(metadata.selectedPoint) ? metadata.selectedPoint : {};
  const screenshot = isRecord(result.screenshot) ? result.screenshot : {};
  return renderKeyValues("ADE macOS VM selection", [
    ["source", result.source],
    ["lane", item.laneId],
    ["vm", item.vmName],
    ["point", selectedPoint.x != null && selectedPoint.y != null ? `${selectedPoint.x},${selectedPoint.y}` : null],
    ["coordinate space", selectedPoint.coordinateSpace],
    ["guest path", item.guestLanePath],
    ["host path", item.hostLanePath],
    ["screenshot", screenshot.path ?? metadata.screenshotPath],
    ["image data", item.screenshotDataUrl ? "included" : null],
  ]);
}

function formatAppControlStatus(value: unknown): string {
  const status = isRecord(value) ? value : {};
  const providers = Array.isArray(status.providers) ? status.providers.filter(isRecord) : [];
  const session = isRecord(status.activeSession)
    ? status.activeSession
    : typeof status.status === "string" && status.label ? status : {};
  return [
    renderKeyValues("ADE App Control", [
      ["supported", status.supported],
      ["platform", status.platform],
      ["active app", session.label],
      ["session", session.id],
      ["status", session.status],
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
      providers.map((provider) => [provider.provider, provider.available ? "yes" : "no", provider.detail]),
      "Providers\n(none)",
    ),
  ].join("\n");
}

function formatBrowserStatus(value: unknown): string {
  const status = isRecord(value) ? value : {};
  const tabs = Array.isArray(status.tabs) ? status.tabs.filter(isRecord) : [];
  const activeTabId = asString(status.activeTabId);
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
    ]),
    "",
    renderTable(
      ["active", "tab", "title", "url"],
      tabs.map((tab) => [
        asString(tab.id) === activeTabId ? "*" : "",
        tab.id,
        tab.title,
        tab.url,
      ]),
      "Browser tabs\n(no browser tabs)",
    ),
  ].join("\n");
}

function formatAppControlSnapshot(value: unknown): string {
  const snapshot = isRecord(value) ? value : {};
  const screenshot = isRecord(snapshot.screenshot) ? snapshot.screenshot : snapshot;
  const screen = isRecord(snapshot.screen) ? snapshot.screen : {};
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers.filter(isRecord) : [];
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements.filter(isRecord) : [];
  const providerSummary = providers.map((provider) => `${provider.provider}:${provider.available ? provider.elementCount ?? "ok" : "unavailable"}`).join(", ");
  return [
    renderKeyValues("ADE App Control snapshot", [
      ["title", snapshot.title],
      ["url", snapshot.url],
      ["captured", snapshot.capturedAt],
      ["screenshot", screenshot.width && screenshot.height ? `${screenshot.width}x${screenshot.height}` : null],
      ["screen", screen.width && screen.height ? `${screen.width}x${screen.height} @${screen.scale ?? 1}x` : null],
      ["elements", elements.length],
      ["providers", providerSummary],
    ]),
    elements.length ? "" : "",
    elements.length
      ? renderTable(
          ["ref", "role", "label", "selector"],
          elements.slice(0, 24).map((element) => [
            element.ref ?? element.id,
            element.role ?? element.tagName,
            element.label ?? element.value ?? element.testId,
            element.selector,
          ]),
          "",
        )
      : "",
  ].filter(Boolean).join("\n");
}

function formatTerminalList(value: unknown): string {
  const terminals = Array.isArray(value)
    ? value.filter(isRecord)
    : isRecord(value) && value.terminalId
      ? [value]
      : firstArray(value, ["terminals", "items"]);
  return renderTable(
    ["terminal", "pty", "chat", "status", "runtime", "title"],
    terminals.map((terminal) => [
      terminal.terminalId,
      terminal.ptyId,
      terminal.chatSessionId,
      terminal.status,
      terminal.runtimeState,
      terminal.title,
    ]),
    "ADE chat terminals\n(no terminals found)",
  );
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
    typeof project.progress === "number" ? `${Math.round(project.progress * 100)}%` : "",
    project.issueCount,
  ]);
  const issueRows = [...assignedIssues, ...recentIssues]
    .filter((issue, index, all) => all.findIndex((candidate) => candidate.id === issue.id) === index)
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
    renderTable(["project", "status", "progress", "issues"], projectRows, "(no projects)"),
    "",
    "Issues",
    renderTable(["id", "title", "state", "area"], issueRows, "(no issues)"),
  ].join("\n");
}

function formatAppControlSelection(value: unknown): string {
  const item = firstRecord(value, ["item", "selection"]) ?? (isRecord(value) ? value : {});
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const selected = isRecord(metadata.selectedElement) ? metadata.selectedElement : {};
  return renderKeyValues("ADE App Control selection", [
    ["component", item.componentId],
    ["source", isRecord(value) ? value.source ?? item.provider : item.provider],
    ["file", item.sourceFile ? `${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}` : null],
    ["selector", selected.selector],
    ["label", selected.label ?? metadata.label],
    ["selected", item.selectedAt],
  ]);
}

function formatTextOutput(value: unknown, formatter: FormatterId | undefined): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.visual === "string" && (!formatter || formatter === "lanes")) return value.visual;
  switch (formatter) {
    case "status":
      return renderKeyValues("ADE status", [
        ["ok", isRecord(value) ? value.ok : null],
        ["mode", isRecord(value) ? value.mode : null],
        ["project", isRecord(value) ? value.projectRoot : null],
        ["workspace", isRecord(value) ? value.workspaceRoot : null],
        ["socket", isRecord(value) ? value.socketPath : null],
      ]);
    case "doctor":
      {
        const project = isRecord(value) && isRecord(value.project) ? value.project : {};
        const desktop = isRecord(value) && isRecord(value.desktop) ? value.desktop : {};
        const actions = isRecord(value) && isRecord(value.actions) ? value.actions : {};
        const git = isRecord(value) && isRecord(value.git) ? value.git : {};
        const github = isRecord(value) && isRecord(value.github) ? value.github : {};
        const linear = isRecord(value) && isRecord(value.linear) ? value.linear : {};
        const providers = isRecord(value) && isRecord(value.providers) ? value.providers : {};
        const computerUse = isRecord(value) && isRecord(value.computerUse) ? value.computerUse : {};
        const pathStatus = isRecord(value) && isRecord(value.path) ? value.path : {};
        const recommendations = isRecord(value) && Array.isArray(value.recommendations) ? value.recommendations : [];
        return [
          renderKeyValues("ADE doctor", [
            ["ok", isRecord(value) ? value.ok : null],
            ["cli version", isRecord(value) ? value.cliVersion : null],
            ["mode", isRecord(value) ? value.mode : null],
            ["project", isRecord(value) ? value.projectRoot : null],
            ["workspace", isRecord(value) ? value.workspaceRoot : null],
            ["project initialized", project.projectInitialized],
            ["desktop socket", desktop.socketAvailable],
            ["socket path", desktop.socketPath],
            ["rpc actions", actions.rpcActionCount],
            ["service actions", actions.actionCount],
            ["git", git.message],
            ["github", github.message],
            ["linear", linear.message],
            ["providers", providers.message],
            ["computer use", computerUse.message],
            ["path", pathStatus.message],
            ["recommendation", isRecord(value) ? value.recommendation : null],
          ]),
          ...(recommendations.length ? ["", "Next actions", ...recommendations.map((entry) => `- ${cell(entry, 120)}`)] : []),
        ].join("\n");
      }
    case "auth":
      {
        const checks = isRecord(value) && isRecord(value.checks) ? value.checks : {};
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
    case "linear-quick-view":
      return formatLinearQuickView(value);
    case "lanes":
      return renderLaneGraph(value);
    case "lane-detail":
      return formatLaneDetail(value);
    case "git-status":
      return renderKeyValues("ADE git status", Object.entries(isRecord(value) ? value : {}));
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
    case "pr-detail":
      return renderKeyValues("ADE pull request", Object.entries(firstRecord(value, ["pr", "detail"]) ?? (isRecord(value) ? value : {})).slice(0, 16));
    case "pr-checks":
      return formatPrChecks(value);
    case "pr-comments":
      return formatPrComments(value);
    case "mission-list":
      return formatMissionList(value);
    case "mission-detail":
      return formatMissionDetail(value);
    case "mission-runs":
      return formatMissionRuns(value);
    case "mission-graph":
      return formatMissionGraph(value);
    case "mission-watch":
      return formatMissionWatch(value);
    case "run-defs":
      return formatRunTable(value, "ADE run definitions");
    case "run-runtime":
      return formatRunTable(value, "ADE process runtime");
    case "chat-list":
      return formatChatList(value);
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
    case "macos-vm-status":
      return formatMacosVmStatus(value);
    case "macos-vm-share-policy":
      return formatMacosVmSharePolicy(value);
    case "macos-vm-guide":
      return formatMacosVmGuide(value);
    case "macos-vm-capture":
      return formatMacosVmCapture(value);
    case "macos-vm-selection":
      return formatMacosVmSelection(value);
    case "terminal-list":
      return formatTerminalList(value);
    case "terminal-read":
      return formatTerminalRead(value);
    case "actions-list":
      return formatActionsList(value);
    case "automation-run-detail":
      return formatAutomationRunDetail(value);
    case "action-result":
    default:
      if (isRecord(value)) return renderKeyValues("ADE result", Object.entries(value).slice(0, 24));
      return JSON.stringify(value, null, 2);
  }
}

function inferFormatter(plan: CliPlan & { kind: "execute" }): FormatterId | undefined {
  if (plan.formatter) return plan.formatter;
  if (plan.summary) return plan.summary;
  if (plan.visualizer === "lanes") return "lanes";
  const label = plan.label.toLowerCase();
  if (label === "lane status") return "lane-detail";
  if (label === "git status") return "git-status";
  if (label === "diff changes") return "diff-summary";
  if (label === "file read") return "file-read";
  if (label === "file tree" || label === "file workspaces") return "files-tree";
  if (label === "file search" || label === "file quick-open") return "files-search";
  if (label === "pr list" || label === "pr list open") return "prs-list";
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
  if (label === "ios simulator stream start" || label === "ios simulator stream status" || label === "ios simulator stream stop") return "ios-sim-stream";
  if (label === "ios simulator screen snapshot" || label === "ios simulator inspector snapshot" || label === "ios simulator screenshot") return "ios-sim-snapshot";
  if (label === "ios simulator select" || label === "ios simulator inspect point") return "ios-sim-selection";
  if (label === "ios simulator preview status" || label === "ios simulator previews" || label === "ios simulator preview render" || label === "ios simulator preview open") return "ios-sim-preview";
  if (label === "app control status" || label === "app control launch" || label === "app control connect" || label === "app control stop") return "app-control-status";
  if (label === "app control snapshot" || label === "app control screenshot") return "app-control-snapshot";
  if (label === "app control select" || label === "app control inspect point") return "app-control-selection";
  if (label === "browser status" || label === "browser panel" || label === "browser open" || label === "browser new tab" || label === "browser switch" || label === "browser close") return "browser-status";
  if (label === "macos vm status" || label === "macos vm start" || label === "macos vm stop" || label === "macos vm provision" || label === "macos vm delete") return "macos-vm-status";
  if (label === "macos vm share policy") return "macos-vm-share-policy";
  if (label === "macos vm guide") return "macos-vm-guide";
  if (label === "macos vm screenshot") return "macos-vm-capture";
  if (label === "macos vm select") return "macos-vm-selection";
  if (label === "terminal list" || label === "terminal active") return "terminal-list";
  if (label === "terminal read") return "terminal-read";
  if (label === "actions list") return "actions-list";
  if (label.endsWith("actions")) return "actions-list";
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
    const readiness = buildReadinessSnapshot({ connection, values, summary: "auth" });
    const actions = isRecord(readiness.actions) ? readiness.actions : {};
    return {
      ok: readiness.ok,
      authenticated: isRecord(readiness.auth) ? readiness.auth.localProjectAccess : false,
      authMode: connection.mode === "desktop-socket" ? "local-desktop-socket" : "local-headless-project",
      role: process.env.ADE_DEFAULT_ROLE ?? "agent",
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
      note: isRecord(readiness.auth) ? readiness.auth.note : "ADE CLI auth is local project access.",
    };
  }

  if (plan.label === "mission launch") {
    const created = unwrapActionEnvelope(values.created);
    const started = unwrapActionEnvelope(values.started);
    const refreshedMission = missionFromResult(values.mission);
    const graph = unwrapActionEnvelope(values.graph);
    return {
      created,
      started,
      mission: refreshedMission ?? missionFromResult(started) ?? missionFromResult(created) ?? created,
      run: runFromGraphResult(graph) ?? runFromStartResult(started),
      graph,
    };
  }

  if (plan.label === "mission watch") {
    return {
      mission: unwrapActionEnvelope(values.mission),
      runs: unwrapActionEnvelope(values.runs),
      graph: unwrapActionEnvelope(values.graph),
    };
  }

  if (plan.label === "mission resume") {
    const graph = unwrapActionEnvelope(values.graph);
    if (graph) {
      return {
        run: runFromGraphResult(graph),
        graph,
      };
    }
    const resumed = unwrapActionEnvelope(values.result);
    return {
      run: resumed,
      steps: [],
      attempts: [],
      timeline: [],
    };
  }

  const result = values.result ?? values;
  if (
    isRecord(result)
    && Object.prototype.hasOwnProperty.call(result, "result")
    && asString(result.domain)
    && asString(result.action)
    && !plan.label.toLowerCase().startsWith("action ")
    && !plan.label.toLowerCase().endsWith(" action")
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

const TERMINAL_MISSION_RUN_STATUSES = new Set(["succeeded", "failed", "canceled", "cancelled"]);
const HEADLESS_ACTIVE_ATTEMPT_DRAIN_MS = 30 * 60 * 1000;

function graphWaitState(value: unknown): { status: string; activeCount: number } {
  const graph = graphFromResult(value) ?? {};
  const run = firstRecord(graph, ["run"]) ?? {};
  const status = (asString(run.status) ?? "").trim().toLowerCase();
  const steps = firstArray(graph, ["steps"]);
  const attempts = firstArray(graph, ["attempts"]);
  const activeStepCount = steps.filter((step) => asString(step.status)?.trim().toLowerCase() === "running").length;
  const activeAttemptCount = attempts.filter((attempt) => asString(attempt.status)?.trim().toLowerCase() === "running").length;
  return {
    status,
    activeCount: Math.max(activeStepCount, activeAttemptCount),
  };
}

async function requestRunGraph(args: {
  connection: CliConnection;
  runId: string;
  timelineLimit: number;
}): Promise<unknown> {
  return await args.connection.request("ade/actions/call", {
    name: "run_ade_action",
    arguments: {
      domain: "orchestrator_core",
      action: "getRunGraph",
      args: {
        runId: args.runId,
        timelineLimit: args.timelineLimit,
      },
    },
  });
}

async function waitForRunGraph(args: {
  connection: CliConnection;
  runId: string;
  waitMs: number;
  timelineLimit: number;
  untilTerminal: boolean;
}): Promise<JsonObject> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, args.waitMs);
  const headlessDrainDeadline = deadline + HEADLESS_ACTIVE_ATTEMPT_DRAIN_MS;
  let raw: unknown = null;
  let timedOut = false;
  let extendedForActiveHeadlessWork = false;

  while (true) {
    raw = await requestRunGraph({
      connection: args.connection,
      runId: args.runId,
      timelineLimit: args.timelineLimit,
    });
    const unwrapped = unwrapActionEnvelope(raw);
    const waitState = graphWaitState(unwrapped);
    const terminal = TERMINAL_MISSION_RUN_STATUSES.has(waitState.status);
    if (terminal) break;

    const now = Date.now();
    const pastDeadline = now >= deadline;
    if (pastDeadline) {
      timedOut = true;
      const shouldDrainActiveHeadlessWork =
        args.connection.mode === "headless"
        && waitState.activeCount > 0
        && now < headlessDrainDeadline;
      if (!shouldDrainActiveHeadlessWork) break;
      extendedForActiveHeadlessWork = true;
    }

    await sleep(1_000);
  }

  const graph = graphFromResult(raw) ?? {};
  const waitState = graphWaitState(raw);
  return {
    graph,
    wait: {
      runId: args.runId,
      waitedMs: Math.max(0, Date.now() - startedAt),
      requestedWaitMs: args.waitMs,
      untilTerminal: args.untilTerminal,
      timedOut,
      extendedForActiveHeadlessWork,
      mode: args.connection.mode,
      runStatus: waitState.status || null,
      activeCount: waitState.activeCount,
    },
  };
}

async function executePlan(plan: CliPlan & { kind: "execute" }, options: GlobalOptions): Promise<unknown> {
  let connection: CliConnection;
  const isWorkerMissionToolPlan = plan.label.startsWith("worker mission tool ");
  const workerRpcUrl = process.env.ADE_RPC_URL?.trim();
  const workerSocketOverride = process.env.ADE_RPC_SOCKET_PATH?.trim();
  const connectionOptions = isWorkerMissionToolPlan && !options.requireSocket
    ? { ...options, headless: false, requireSocket: Boolean(workerRpcUrl || workerSocketOverride) }
    : plan.preferHeadless && !options.requireSocket
    ? { ...options, headless: true }
    : options;
  try {
    connection = await createConnection(connectionOptions);
  } catch (error) {
    const roots = resolveRoots(options);
    let socketPath = path.join(roots.projectRoot, ".ade", "ade.sock");
    try {
      const { resolveAdeLayout } = await import("../../desktop/src/shared/adeLayout");
      socketPath = resolveAdeLayout(roots.projectRoot).socketPath;
    } catch {
      // Keep the conventional Unix fallback if shared layout loading fails.
    }
    const requestedMode = connectionOptions.requireSocket ? "desktop-socket" : connectionOptions.headless ? "headless" : "auto";
    const cause = error instanceof Error ? error.message : String(error);
    const sourceRuntimeInterop = isSourceRuntimeInteropError(cause);
    throw new CliExecutionError(`Failed to initialize ADE CLI connection for ${plan.label}.`, {
      cause,
      requestedMode,
      projectRoot: roots.projectRoot,
      workspaceRoot: roots.workspaceRoot,
      socketPath,
      nextAction: options.requireSocket
        ? "Start ADE desktop for this project or remove --socket to allow headless mode."
        : sourceRuntimeInterop
          ? "Run `npm --prefix apps/ade-cli run build` and retry, or use `npm --prefix apps/ade-cli run cli:dev -- ...`."
          : "Verify --project-root points at an ADE project and run ade doctor --json.",
    });
  }
  try {
    const values: JsonObject = {};
    for (const step of plan.steps) {
      try {
        const params = typeof step.params === "function" ? step.params(values) : step.params;
        if (step.method === "ade-cli/wait-run-graph") {
          const runId = requireValue(asString(params?.runId) ?? null, "run id");
          const waitMs = Math.max(0, Math.floor(typeof params?.waitMs === "number" ? params.waitMs : 0));
          const timelineLimit = Math.max(0, Math.floor(typeof params?.timelineLimit === "number" ? params.timelineLimit : 120));
          values[step.key] = await waitForRunGraph({
            connection,
            runId,
            waitMs,
            timelineLimit,
            untilTerminal: params?.untilTerminal === true,
          });
          continue;
        }
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
    if (error instanceof CliToolError || error instanceof CliUsageError || error instanceof CliExecutionError) throw error;
    throw new CliExecutionError(`Failed while running ${plan.label}.`, {
      cause: error instanceof Error ? error.message : String(error),
      mode: connection.mode,
      projectRoot: connection.projectRoot,
      workspaceRoot: connection.workspaceRoot,
      socketPath: connection.socketPath,
      nextAction: connection.mode === "desktop-socket"
        ? "Check ADE desktop logs or retry with --headless if the workflow does not need UI-owned state."
        : "Run ade doctor --json to inspect local project readiness, or start ADE desktop and retry with --socket.",
    });
  } finally {
    await connection.close();
  }
}

function formatOutput(value: unknown, options: GlobalOptions, formatter?: FormatterId): string {
  if (options.text) {
    return `${formatTextOutput(value, formatter)}\n`;
  }
  return `${JSON.stringify(value, null, options.pretty ? 2 : 0)}\n`;
}

async function runCli(argv: string[]): Promise<{ output: string; exitCode: number }> {
  const parsed = parseCliArgs(argv);
  const plan = buildCliPlan(parsed.command);
  if (plan.kind === "help") return { output: plan.text.endsWith("\n") ? plan.text : `${plan.text}\n`, exitCode: 0 };
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  const writeDiagnostic = (...args: unknown[]) => {
    process.stderr.write(`${args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")}\n`);
  };
  console.log = writeDiagnostic;
  console.info = writeDiagnostic;
  console.warn = writeDiagnostic;
  try {
    if (plan.kind === "cursor-cloud") {
      // Cursor Cloud talks to @cursor/sdk directly. No ADE socket / no headless
      // RPC. The function handles its own --json/--text/--compact parsing on
      // the remaining tokens.
      try {
        const result = await runCursorCloud(plan.rest, parsed.options.text ? "text" : "json");
        return result;
      } catch (error) {
        if (error instanceof CursorCloudUsageError) throw new CliUsageError(error.message);
        throw error;
      }
    }
    if (plan.kind === "mcp") {
      await runMcpServer({ ...parsed.options, headless: true, requireSocket: false });
      return { output: "", exitCode: 0 };
    }
    const result = await executePlan(plan, parsed.options);
    return { output: formatOutput(result, parsed.options, inferFormatter(plan)), exitCode: 0 };
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
  }
}

async function main(): Promise<void> {
  const writeDiagnostic = (...args: unknown[]) => {
    process.stderr.write(`${args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")}\n`);
  };
  console.log = writeDiagnostic;
  console.info = writeDiagnostic;
  console.warn = writeDiagnostic;
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  } catch (error) {
    const fallback = maybeRunBuiltCliFallback(error, process.argv.slice(2));
    if (fallback) {
      if (fallback.stderr.length) process.stderr.write(fallback.stderr);
      if (fallback.stdout.length) process.stdout.write(fallback.stdout);
      process.exitCode = fallback.exitCode;
      return;
    }
    if (error instanceof CliUsageError) {
      process.stderr.write(`ade: ${error.message}\nRun 'ade help'.\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof CliToolError) {
      process.stderr.write(`ade: ${error.message}\n`);
      if (error.details !== undefined) {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      }
      process.exitCode = 1;
      return;
    }
    if (error instanceof CliExecutionError) {
      process.stderr.write(`ade: ${error.message}\n`);
      process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`ade: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (/(^|[/\\])cli\.(?:ts|js|cjs)$/.test(process.argv[1] ?? "")) {
  void main();
}

export {
  buildCliPlan,
  findProjectRoots,
  formatOutput,
  graphWaitState,
  parseCliArgs,
  renderLaneGraph,
  resolveRoots,
  runCli,
  summarizeExecution,
  unwrapToolResult,
};
