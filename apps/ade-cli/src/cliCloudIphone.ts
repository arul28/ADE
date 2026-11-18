import { execFileSync } from "node:child_process";
import path from "node:path";
import { CLOUD_PHONE_BUILD_TIMEOUT_MS, CLOUD_PHONE_CALL_TIMEOUT_MS } from "../../desktop/src/shared/cloudPhone";
import {
  CLI_COMMAND_ALIASES,
  CliToolError,
  CliUsageError,
  actionStep,
  asString,
  executePlan,
  formatOutput,
  isRecord,
  resolveRoots,
  unwrapActionEnvelope,
  type CliPlan,
  type GlobalOptions,
  type JsonObject,
  type ParsedCli,
} from "./cli";

/* ──────────────────────────────────────────────────────────────────────────
   `ade apple …` on the ADE Cloud iPhone (`ios@cloud`).

   A chat that chose `ade devices use ios@cloud` (or one command with
   `--machine cloud`) drives the account's cloud iPhone with the same verbs it
   uses on a Mac's simulator. Each verb becomes one `cloud_phone` action on
   THIS machine's brain, which holds the phone's token and talks to the phone
   (`cloudPhoneService`). The phone reads its screen as text and acts by
   label; a build uploads this checkout and builds it with Xcode there, so a
   Windows or Linux machine builds and runs an iPhone app.

   Verbs a cloud phone has no answer for (iPad windows, the Duo, leases,
   device settings) say so instead of guessing.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * One command's words and flags. `root`: the checkout a build or test run
 * uploads, as every other command resolves it (`--project-root`, an account
 * project, the lane's worktree, else this folder's repository).
 */
type Args = { words: string[]; flags: Map<string, string | true>; afterDashes: string[]; root: () => string };

/** Words, `--flag value` / `--flag=value` / bare `--flag`, and everything after `--` (an app's launch arguments). */
function readArgs(tokens: string[], valueFlags: ReadonlySet<string>, root: () => string): Args {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  const end = tokens.indexOf("--");
  const head = end >= 0 ? tokens.slice(0, end) : tokens;
  for (let index = 0; index < head.length; index += 1) {
    const token = head[index]!;
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      flags.set(token.slice(0, eq), token.slice(eq + 1));
    } else if (valueFlags.has(token) && index + 1 < head.length) {
      flags.set(token, head[index + 1]!);
      index += 1;
    } else {
      flags.set(token, true);
    }
  }
  return { words, flags, afterDashes: end >= 0 ? tokens.slice(end + 1) : [], root };
}

/**
 * Every flag that takes a value. `flag()` reads only these (its type says so),
 * so a flag can't be read without the parser knowing it takes the next word.
 */
const VALUE_FLAGS = [
  "--label", "--id", "--find", "--out", "--caption", "--path", "--project", "--scheme", "--target", "--configuration",
  "--bundle-id", "--app", "--grep", "--since", "--wait-for", "--timeout-ms", "--hold-ms", "--duration-ms", "--device",
  "--only", "--env", "--value", "--url",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const VALUE_FLAG_SET: ReadonlySet<string> = new Set(VALUE_FLAGS);

const flag = (args: Args, name: ValueFlag): string | null => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : null;
};

/** A label or typed text for a step: quoted as JSON so spaces, quotes and `#` stay one value. */
const quoted = (text: string): string => JSON.stringify(text);

function target(args: Args, verb: string): string {
  const id = flag(args, "--id");
  if (id) return `#${/\s/.test(id) ? quoted(id) : id}`;
  const label = flag(args, "--label") ?? args.words.join(" ");
  if (!label.trim()) throw new CliUsageError(`ade apple ${verb} on the ADE Cloud iPhone takes --label "<text>" or --id <accessibility id>.`);
  return quoted(label);
}

function point(args: Args, verb: string): string {
  const [x, y] = args.words.map(Number);
  if (args.words.length < 2 || !Number.isFinite(x) || !Number.isFinite(y)) throw new CliUsageError(`ade apple ${verb} <x> <y> (points, as snapshot prints them).`);
  return `@${x},${y}`;
}

type Call = { action: string; args: JsonObject; timeoutMs: number; label: string };

/** The chat and lane this command runs for, so a capture is theirs in the proof drawer. */
function proofOwners(): JsonObject {
  const chatSessionId = process.env.ADE_CHAT_SESSION_ID?.trim();
  const laneId = process.env.ADE_LANE_ID?.trim();
  return { ...(chatSessionId ? { chatSessionId } : {}), ...(laneId ? { laneId } : {}) };
}

const KEY_STEPS: Readonly<Record<string, string>> = { return: "return", enter: "return", escape: "escape", esc: "escape", delete: "delete", backspace: "delete", tab: "tab", space: "space" };
const DIRECTIONS = new Set(["up", "down", "left", "right"]);

/** `launch` (and `install` with no `--app`): pack this checkout and build it there. */
function launchCall(args: Args): Call {
  if (args.flags.has("--no-build")) {
    const app = flag(args, "--bundle-id");
    if (!app) throw new CliUsageError("ade apple launch --no-build --bundle-id <id> on the ADE Cloud iPhone.");
    return { action: "control", args: { action: "launch", app, ...(args.afterDashes.length ? { value: args.afterDashes.join(" ") } : {}) }, timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS, label: "launch" };
  }
  const sub = flag(args, "--path") ?? flag(args, "--project");
  const scheme = flag(args, "--scheme") ?? flag(args, "--target");
  const configuration = flag(args, "--configuration");
  const env = flag(args, "--env");
  return {
    action: "launch",
    args: { root: args.root(), ...(sub ? { path: sub } : {}), ...(scheme ? { scheme } : {}), ...(configuration ? { configuration } : {}), ...(env ? { env } : {}), ...(args.flags.has("--clean") ? { clean: true } : {}) },
    timeoutMs: CLOUD_PHONE_BUILD_TIMEOUT_MS,
    label: "build and run on the cloud iPhone",
  };
}

const act = (steps: string[], label: string): Call => ({ action: "act", args: { steps }, timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS, label });

/** A Simulator `.app` built elsewhere (`install --app`, `install-app`), uploaded and installed. */
function installAppCall(args: Args, app: string): Call {
  return {
    action: "installApp",
    args: { appPath: path.resolve(app), ...(args.flags.has("--no-launch") ? { launch: false } : {}) },
    timeoutMs: CLOUD_PHONE_BUILD_TIMEOUT_MS,
    label: "install the app on the cloud iPhone",
  };
}

function swipeCall(args: Args, verb: string): Call {
  const direction = (args.words[0] ?? "").toLowerCase();
  if (!DIRECTIONS.has(direction)) throw new CliUsageError(`ade apple ${verb} <up|down|left|right> [--label "<on this element>"] on the ADE Cloud iPhone.`);
  const on = flag(args, "--label") || flag(args, "--id") ? ` ${target(args, verb)}` : "";
  return act([`${verb} ${direction}${on}`], verb);
}

function testsCall(args: Args): Call {
  const sub = flag(args, "--path");
  const scheme = flag(args, "--scheme");
  const only = flag(args, "--only");
  return { action: "runTests", args: { root: args.root(), ...(sub ? { path: sub } : {}), ...(scheme ? { scheme } : {}), ...(only ? { only } : {}) }, timeoutMs: CLOUD_PHONE_BUILD_TIMEOUT_MS, label: "tests" };
}

/** Each `ade apple` verb the cloud iPhone answers, as one `cloud_phone` call. The refusal lists these keys. */
const VERBS: Readonly<Record<string, (args: Args, verb: string) => Call>> = {
  status: () => ({ action: "getStatus", args: {}, timeoutMs: 20_000, label: "cloud iPhone status" }),
  start: (args) => {
    const device = flag(args, "--device");
    return { action: "start", args: device ? { device } : {}, timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS, label: "start the cloud iPhone" };
  },
  stop: () => ({ action: "stop", args: {}, timeoutMs: 30_000, label: "stop the cloud iPhone" }),
  snapshot: (args) => {
    const find = flag(args, "--find");
    return { action: "look", args: { ...(find ? { find } : {}) }, timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS, label: "read the screen" };
  },
  "tap-element": (args, verb) => {
    const hold = Number(flag(args, "--hold-ms"));
    return act([Number.isFinite(hold) && hold > 0 ? `hold ${target(args, verb)} ${Math.min(10, Math.max(0.1, hold / 1000))}` : `tap ${target(args, verb)}`], "tap");
  },
  tap: (args, verb) => act([`tap ${point(args, verb)}`], "tap"),
  "long-press": (args, verb) => {
    const ms = Number(flag(args, "--duration-ms") ?? 1000);
    return act([`hold ${point(args, verb)} ${Math.min(10, Math.max(0.1, (Number.isFinite(ms) ? ms : 1000) / 1000))}`], "long press");
  },
  type: (args) => {
    const text = args.words.join(" ");
    if (!text) throw new CliUsageError("ade apple type \"<text>\" [--submit]");
    return act(args.flags.has("--submit") ? [`type ${quoted(text)}`, "key return"] : [`type ${quoted(text)}`], "type");
  },
  key: (args, verb) => {
    const key = KEY_STEPS[(args.words[0] ?? "").toLowerCase()];
    if (!key || args.flags.has("--cmd") || args.flags.has("--shift") || args.flags.has("--alt") || args.flags.has("--ctrl")) {
      throw new CliToolError("The ADE Cloud iPhone presses return, escape, delete, tab and space (no shortcuts). Type text with ade apple type.", { verb });
    }
    return act([`key ${key}`], "key");
  },
  swipe: swipeCall,
  scroll: swipeCall,
  button: (args, verb) => {
    const which = (args.words[0] ?? "").toLowerCase();
    if (which !== "home") throw new CliToolError("The ADE Cloud iPhone has the home button (ade apple button home).", { verb });
    return act(["home"], "home");
  },
  "wait-for-element": (args, verb) => {
    const seconds = Math.min(30, Math.max(1, Math.round(Number(flag(args, "--timeout-ms") ?? 5000) / 1000) || 5));
    return act([`wait ${target(args, verb)} ${seconds}`], "wait");
  },
  screenshot: (args) => {
    const out = flag(args, "--out");
    const caption = flag(args, "--caption");
    return {
      action: "screenshot",
      args: { ...proofOwners(), ...(out ? { outPath: path.resolve(out) } : {}), ...(caption ? { caption } : {}), ...(args.flags.has("--no-proof") ? { noProof: true } : {}) },
      timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS,
      label: "screenshot",
    };
  },
  launch: launchCall,
  open: launchCall,
  // With no --app, `install` builds this checkout there, like `launch`.
  install: (args) => {
    const app = flag(args, "--app");
    return app ? installAppCall(args, app) : launchCall(args);
  },
  "install-app": (args) => {
    const app = flag(args, "--app");
    if (!app) throw new CliUsageError("ade apple install-app --app <path to a Simulator .app> on the ADE Cloud iPhone.");
    return installAppCall(args, app);
  },
  relaunch: (args) => {
    const app = flag(args, "--bundle-id");
    const value = args.afterDashes.length ? args.afterDashes.join(" ") : undefined;
    return { action: "control", args: { action: "launch", ...(app ? { app } : {}), ...(value ? { value } : {}) }, timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS, label: "relaunch" };
  },
  terminate: (args) => {
    const app = flag(args, "--bundle-id");
    return { action: "control", args: { action: "terminate", ...(app ? { app } : {}) }, timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS, label: "terminate" };
  },
  "open-url": (args) => {
    const url = args.words[0] ?? flag(args, "--url");
    if (!url) throw new CliUsageError("ade apple open-url <url or deep link>");
    return { action: "control", args: { action: "open_url", value: url }, timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS, label: "open a link" };
  },
  logs: (args) => {
    const app = flag(args, "--bundle-id") ?? flag(args, "--app");
    const since = flag(args, "--since");
    const grep = flag(args, "--grep");
    const waitFor = flag(args, "--wait-for");
    return {
      action: "logs",
      args: { ...(app ? { app } : {}), ...(since ? { since } : {}), ...(grep ? { grep } : {}), ...(waitFor ? { waitFor } : {}), ...(args.flags.has("--crashes") ? { crashes: true } : {}) },
      timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS,
      label: "logs",
    };
  },
  record: (args) => {
    const action = (args.words[0] ?? "").toLowerCase();
    if (action !== "start" && action !== "stop") throw new CliUsageError("ade apple record start|stop on the ADE Cloud iPhone (stop answers a link to the MP4).");
    const caption = flag(args, "--caption");
    return {
      action: "record",
      args: { action, ...proofOwners(), ...(caption ? { caption } : {}), ...(args.flags.has("--no-proof") ? { noProof: true } : {}) },
      timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS,
      label: `record ${action}`,
    };
  },
  test: testsCall,
  tests: testsCall,
  act: (args) => {
    const steps = args.words.filter((step) => step.trim());
    if (!steps.length) throw new CliUsageError("ade apple act \"<step>\" [\"<step>\" …], e.g. ade apple act 'fill #email a@b.c' 'tap \"Sign In\"' 'wait \"Welcome\" 10'");
    return act(steps, "act");
  },
  control: (args) => {
    const action = args.words[0];
    if (!action) throw new CliUsageError("ade apple control <action> [value] [--app <bundle id>]: launch, terminate, uninstall, open_url, grant, revoke, location, push, appearance, locale, timezone, text_size, status_bar, storekit.");
    const value = flag(args, "--value") ?? (args.words.length > 1 ? args.words.slice(1).join(" ") : undefined);
    const app = flag(args, "--app") ?? flag(args, "--bundle-id");
    return { action: "control", args: { action, ...(value !== undefined ? { value } : {}), ...(app ? { app } : {}) }, timeoutMs: CLOUD_PHONE_CALL_TIMEOUT_MS, label: `control ${action}` };
  },
};

/** `show` answers here, with no call: the phone shows in the chat's tools pane. */
const SHOW_VERB = "show";

/** One `ade apple` verb as a `cloud_phone` call. */
function callFor(verb: string, tokens: string[], root: () => string): Call {
  const handler = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (!handler) {
    throw new CliToolError(
      `ade apple ${verb} isn't on the ADE Cloud iPhone. It takes: ${[...Object.keys(VERBS), SHOW_VERB].join(", ")}. ade devices use ios@here (or a Mac) for the rest.`,
      { verb },
    );
  }
  return handler(readArgs(tokens, VALUE_FLAG_SET, root), verb);
}

function textOf(action: string, value: unknown): string {
  if (!isRecord(value)) return `${String(value ?? "")}\n`;
  if (action === "getStatus") {
    const minutes = isRecord(value.minutes) ? ` · ${value.minutes.left} of ${value.minutes.included} min left this period` : "";
    const phone = isRecord(value.phone) ? `phone: ${asString(value.phone.state)} (${asString(value.phone.device)})` : "phone: off (ade apple start, or any command, starts it)";
    return value.access === "on"
      ? `ADE Cloud iPhone · on${minutes}\n${phone}\ncapabilities: ${Array.isArray(value.capabilities) ? value.capabilities.join(", ") : ""}\n`
      : `ADE Cloud iPhone · ${asString(value.reason) ?? "not available"}\n`;
  }
  if (action === "screenshot") return `Saved ${asString(value.path)} (${value.bytes} bytes). Link for 7 days: ${asString(value.link)}\n`;
  if (action === "start") {
    const phone = isRecord(value.phone) ? value.phone : null;
    const minutes = isRecord(value.minutes) ? ` · ${value.minutes.left} of ${value.minutes.included} min left` : "";
    return `ADE Cloud iPhone ${asString(phone?.state) ?? "ready"} (${asString(phone?.device) ?? "iphone"})${minutes}\n`;
  }
  if (action === "stop") return value.stopped ? "Stopped the ADE Cloud iPhone.\n" : "The ADE Cloud iPhone was not running.\n";
  const text = asString(value.text) ?? "";
  const notice = asString(value.stopNotice);
  return `${text}${text.endsWith("\n") ? "" : "\n"}${notice ? `! ${notice}\n` : ""}`;
}

/**
 * The folder a cloud build uploads. A project named for this command
 * (`--project-root`, `--workspace-root`, an account project; `runCli` applied
 * them) wins; otherwise the git checkout the command runs in, so an agent that
 * is in its app's folder builds that app; else the resolved workspace.
 */
function buildRoot(options: GlobalOptions): string {
  if (options.projectRoot || options.workspaceRoot) return resolveRoots(options).workspaceRoot;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) return path.resolve(top);
  } catch {
    // Not in a git checkout: the resolved workspace below.
  }
  return resolveRoots(options).workspaceRoot;
}

/**
 * Runs one `ade apple` command on the cloud iPhone. `command` starts with the
 * verb (the `ade apple` primary already taken off).
 */
export async function runCloudIphoneCommand(parsed: ParsedCli, command: string[]): Promise<{ output: string; exitCode: number }> {
  const options: GlobalOptions = { ...parsed.options, machine: null, allMachines: false, machineProject: null, machineWorkCopy: null };
  const verb = (command[0] ?? "status").toLowerCase();
  if (verb === SHOW_VERB) {
    const text = "The ADE Cloud iPhone shows in this chat's tools pane: open the iPhone tool there and pick ADE Cloud.\n";
    return { output: options.text ? text : formatOutput({ ok: true, note: text.trim() }, options, undefined), exitCode: 0 };
  }
  const call = callFor(verb, command.slice(1), () => buildRoot(parsed.options));
  const plan: CliPlan & { kind: "execute" } = {
    kind: "execute",
    label: `ade apple ${verb} (ADE Cloud iPhone)`,
    steps: [actionStep("result", "cloud_phone", call.action, call.args)],
    needsLiveRuntime: "the ADE Cloud iPhone",
    shapeResult: (values) => values.result,
  };
  const value = unwrapActionEnvelope(await executePlan(plan, { ...options, timeoutMs: Math.max(options.timeoutMs, call.timeoutMs) }));
  // The brain files screenshots and recordings to the proof drawer itself, owned by this chat and lane.
  const filed = isRecord(value) && typeof value.artifactId === "string" ? `Filed in the proof drawer (${value.artifactId}).` : null;
  const failed = isRecord(value) && value.failed === true;
  if (!options.text) return { output: formatOutput(value, options, undefined), exitCode: failed ? 1 : 0 };
  return { output: `${textOf(call.action, value)}${filed ? `${filed}\n` : ""}`, exitCode: failed ? 1 : 0 };
}

/**
 * `ade apple … --machine cloud` for one command, like a chat's `ios@cloud`
 * choice: the verb and its arguments with the flag taken out, or null for any
 * other command. Read before machine targeting, which knows no machine "cloud".
 */
export function cloudMachineAppleCommand(command: readonly string[]): string[] | null {
  const primary = (command[0] ?? "").toLowerCase();
  if ((CLI_COMMAND_ALIASES[primary] ?? primary) !== "apple") return null;
  const end = command.indexOf("--");
  const head = end >= 0 ? command.slice(1, end) : command.slice(1);
  const tail = end >= 0 ? command.slice(end) : [];
  for (let index = 0; index < head.length; index += 1) {
    const token = head[index]!;
    if (token === "--machine" && head[index + 1]?.trim().toLowerCase() === "cloud") {
      return [...head.slice(0, index), ...head.slice(index + 2), ...tail];
    }
    if (token.toLowerCase() === "--machine=cloud") return [...head.slice(0, index), ...head.slice(index + 1), ...tail];
  }
  return null;
}
