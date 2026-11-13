import os from "node:os";
import { looseMachineNameMatches } from "../../desktop/src/shared/accountDirectory";
import { gitRemoteIdentity } from "../../desktop/src/main/services/github/githubSshAlias";
import { desktopProductName } from "../../desktop/src/shared/desktopSeat";
import { remoteMachineHostPlatform } from "../../desktop/src/shared/machineIdentity";
import { SESSION_ACTIVITY_SESSION_ID_ENV } from "../../desktop/src/shared/sessionActivity";
import {
  ADE_CLOUD_IPHONE_UNAVAILABLE,
  DEVICE_KINDS,
  DEVICE_KIND_COMMAND,
  DEVICE_KIND_NOUN,
  deviceKindRunsOnPlatform,
  devicesSubcommand,
  formatDeviceId,
  isDeviceKind,
  normalizeChatDeviceSources,
  parseDeviceId,
  type ChatDeviceSources,
  type DeviceKind,
} from "../../desktop/src/shared/types/deviceSources";
import { flagNamesOutsideFreeText } from "./cliMachineTargeting";
import {
  CLI_COMMAND_ALIASES,
  CliToolError,
  CliUsageError,
  SCREEN_COMMAND_NAMES,
  actionStep,
  asString,
  buildCliPlan,
  connectMachineRuntimeDaemon,
  executePlan,
  firstStandalonePositional,
  formatOutput,
  getGitRemote,
  hasHelpFlag,
  isRecord,
  renderTable,
  resolveRoots,
  unwrapActionEnvelope,
  withoutShellLane,
  type CliPlan,
  type GlobalOptions,
  type JsonObject,
  type ParsedCli,
} from "./cli";

/* ──────────────────────────────────────────────────────────────────────────
   `ade devices` — every device this chat can use, on every machine, and the
   chat's choice of machine per device kind.

   The list reads each machine's lane-free status reads (`ade apple|android|
   screen|app-control status`) through the same `--machine` path the device
   commands use; they put nothing there. `use` stores the choice with the
   chat, in its own brain (`chat.setDeviceSource`), and the device commands
   read it back when they name no `--machine` and no `--lane`
   (`withChatDeviceChoice`). See
   docs/features/sync-and-multi-device/devices-and-machines.md.
   ────────────────────────────────────────────────────────────────────────── */

/** The kind a device command drives (any spelling of it), or null for any other command. */
function deviceKindOfCommand(typed: string): DeviceKind | null {
  const command = CLI_COMMAND_ALIASES[typed] ?? typed;
  if (SCREEN_COMMAND_NAMES.has(command)) return "screen";
  return DEVICE_KINDS.find((kind) => DEVICE_KIND_COMMAND[kind] === command) ?? null;
}

/** How long one machine gets to answer the list. */
const MACHINE_READ_TIMEOUT_MS = 8_000;
/** How long a device command waits for the chat's choice before it stops. */
const CHOICE_READ_TIMEOUT_MS = 4_000;

function errorText(error: unknown): string {
  if (isRecord(error) && isRecord(error.details)) {
    const cause = asString(error.details.cause);
    if (cause) return cause;
  }
  return error instanceof Error ? error.message : String(error);
}

/** These options, for this machine only (the chat's choice, the roster, this machine's devices). */
function thisMachineOnly(options: GlobalOptions): GlobalOptions {
  return { ...options, machine: null, allMachines: false, machineProject: null, machineWorkCopy: null };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** What an ADE MCP app does with a device: `use` and `--machine` are refused over MCP. */
const MCP_DEVICE_HINT = "Device commands here take --lane <lane there> (lanes_list names them).";

/** Under ADE MCP the app picks the machine per call; the CLI never reaches another one. */
function underRemoteMcp(): boolean {
  return Boolean(process.env.ADE_REMOTE_MCP_SCOPE?.trim() || process.env.ADE_REMOTE_MCP_CONNECTION_ID?.trim());
}

/**
 * The chat this shell belongs to, or null: a person's terminal, an ADE MCP
 * call, or a shell another machine's chat started here (its `remote:` id
 * names a chat this brain does not keep).
 */
function chatIdentity(): string | null {
  const id = process.env.ADE_CHAT_SESSION_ID?.trim() || null;
  if (!id || id.startsWith("remote:") || underRemoteMcp()) return null;
  return id;
}

/**
 * The session is an agent CLI in a terminal (a tracked Claude Code, Codex, …
 * session), not an ADE chat: its terminal names it as the activity target too
 * (ptyService). It keeps no device choice, so none is read for it.
 */
function isAgentCliTerminal(chat: string): boolean {
  return process.env[SESSION_ACTIVITY_SESSION_ID_ENV]?.trim() === chat;
}

const AGENT_CLI_KEEPS_NO_CHOICE =
  "A device choice is kept for ADE chats; this session is an agent CLI in a terminal. Pass --machine <name> on each device command instead.";

export function isDevicesCommand(command: readonly string[]): boolean {
  const typed = command[0]?.toLowerCase() ?? "";
  return (CLI_COMMAND_ALIASES[typed] ?? typed) === "devices" && !hasHelpFlag([...command]);
}

/* ── the chat's choice ─────────────────────────────────────────────────── */

async function callChatDeviceAction(
  options: GlobalOptions,
  action: "getDeviceSources" | "setDeviceSource",
  args: JsonObject,
  timeoutMs = options.timeoutMs,
): Promise<ChatDeviceSources> {
  const plan: CliPlan & { kind: "execute" } = {
    kind: "execute",
    label: `devices ${action === "getDeviceSources" ? "current" : "use"}`,
    steps: [actionStep("result", "chat", action, args)],
    needsLiveRuntime: "this chat's device choice",
    shapeResult: (values) => values.result,
  };
  const answer = await executePlan(plan, { ...thisMachineOnly(options), timeoutMs: Math.min(options.timeoutMs, timeoutMs) });
  const value = unwrapActionEnvelope(answer);
  return normalizeChatDeviceSources(isRecord(value) ? value.sources : null) ?? {};
}

/** The brain here is older than device choices: it has no such action. */
function isOlderBrainAnswer(reason: string): boolean {
  return /not callable|unknown action|not allowed/i.test(reason);
}

/**
 * `ade devices use|current`: the chat's choice, with an older brain said as
 * such (an update fixes it).
 */
async function chatDeviceAction(
  options: GlobalOptions,
  action: "getDeviceSources" | "setDeviceSource",
  args: JsonObject,
): Promise<ChatDeviceSources> {
  try {
    return await callChatDeviceAction(options, action, args);
  } catch (error) {
    if (isOlderBrainAnswer(errorText(error))) {
      throw new CliToolError("The ADE running on this machine is older than device choices (ade devices use). Update ADE, then run it again.", { action: `chat.${action}` });
    }
    throw error;
  }
}

/**
 * A device command (`ade apple|android|screen|app-control …`) from a chat
 * that named no `--machine` and no `--lane`: when the chat chose another
 * machine for that kind (`ade devices use`), the command goes there exactly
 * as `--machine <its key>` would. Anything else runs as typed. Where no
 * choice can exist (an older brain, an agent CLI in a terminal, a session
 * this brain does not keep as a chat) it runs here; a choice that may exist
 * but cannot be read stops the command rather than run it on the wrong
 * machine.
 */
export async function withChatDeviceChoice(parsed: ParsedCli): Promise<ParsedCli> {
  const kind = deviceKindOfCommand(parsed.command[0]?.toLowerCase() ?? "");
  const chat = chatIdentity();
  if (!kind || !chat || isAgentCliTerminal(chat)) return parsed;
  const options = parsed.options;
  if (options.headless || options.machine || options.allMachines) return parsed;
  const flags = flagNamesOutsideFreeText(parsed.command);
  if (["--machine", "--all-machines", "--machine-project", "--lane", "--lane-id"].some((flag) => flags.has(flag))) return parsed;
  if (hasHelpFlag([...parsed.command])) return parsed;
  const sub = firstStandalonePositional(parsed.command.slice(1))?.toLowerCase() ?? "";
  if (!sub || sub === "help") return parsed;
  let sources: ChatDeviceSources;
  try {
    sources = await withTimeout(callChatDeviceAction(options, "getDeviceSources", {}, CHOICE_READ_TIMEOUT_MS), CHOICE_READ_TIMEOUT_MS + 1_000, "This machine's ADE");
  } catch (error) {
    const reason = errorText(error);
    // No choice can exist: an older brain, a session that is no ADE chat here.
    if (isOlderBrainAnswer(reason) || /device choice is kept for ADE chats|sessionId is required|was not found|is not an agent chat session/i.test(reason)) {
      return parsed;
    }
    // Not "devices use …@here": that would undo the person's choice for a
    // brain that was only slow.
    throw new CliToolError(
      `Could not read this chat's device choice (${firstSentence(reason)}), so the command did not run. Run it again, or pass --machine <name> for this one command.`,
      { action: "chat.getDeviceSources" },
    );
  }
  const choice = sources[kind];
  if (!choice) return parsed;
  process.stderr.write(`· ${formatDeviceId({ kind, source: { kind: "machine", machine: choice.machineName } })} (this chat's device; ade devices use ${kind}@here for this machine)\n`);
  const end = parsed.command.indexOf("--");
  const command = end >= 0
    ? [...parsed.command.slice(0, end), "--machine", choice.machineKey, ...parsed.command.slice(end)]
    : [...parsed.command, "--machine", choice.machineKey];
  return { ...parsed, command };
}

/* ── the account's machines ────────────────────────────────────────────── */

type RosterMachine = {
  key: string;
  name: string;
  isThisMachine: boolean;
  online: boolean;
  platform: string | null;
  lastSeenAt: string | null;
  projects: JsonObject[] | null;
  note: string | null;
};

type Roster = { machines: RosterMachine[]; note: string | null };

async function readRoster(options: GlobalOptions, includeProjects: boolean): Promise<Roster> {
  let client;
  try {
    client = await connectMachineRuntimeDaemon(options, options.socketPath?.trim() || null, { allowSpawn: false });
  } catch (error) {
    throw new CliUsageError(`ADE's brain is not running on this machine, so no device can be read (${errorText(error)}). Open ADE, or run \`ade brain start\`.`);
  }
  try {
    const roster = await client.request("machines.list", { includeProjects }).catch((error: unknown) => ({ state: "unavailable", message: errorText(error) }));
    if (!isRecord(roster) || roster.state !== "ok") {
      const state = isRecord(roster) ? asString(roster.state) : null;
      return {
        machines: [],
        note: state === "signed_out"
          ? "Not signed in to an ADE account here, so only this machine is listed (ade login)."
          : `Other machines are unavailable: ${asString(isRecord(roster) ? roster.message : null) ?? "no answer"}.`,
      };
    }
    const machines = (Array.isArray(roster.machines) ? roster.machines.filter(isRecord) : []).flatMap((machine): RosterMachine[] => {
      const key = asString(machine.machineKey);
      if (!key) return [];
      return [{
        key,
        name: asString(machine.name) ?? key,
        isThisMachine: machine.isThisMachine === true,
        online: machine.online === true,
        platform: asString(machine.platform),
        lastSeenAt: asString(machine.lastSeenAt),
        projects: Array.isArray(machine.projects) ? machine.projects.filter(isRecord) : null,
        note: asString(machine.note),
      }];
    });
    return { machines, note: null };
  } finally {
    client.close();
  }
}

/** One machine on the account by key or name: exact key, then the name with typing differences folded, then whole words. */
function matchMachine(machines: readonly RosterMachine[], query: string): RosterMachine {
  const needle = query.trim().toLowerCase();
  const byKey = machines.filter((machine) => machine.key.toLowerCase() === needle);
  if (byKey.length === 1) return byKey[0]!;
  const hits = looseMachineNameMatches(machines, query, (machine) => [machine.name]);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new CliUsageError(`"${query}" names more than one machine: ${hits.map((machine) => `${machine.name} (${machine.key})`).join(", ")}. Use the key.`);
  }
  throw new CliUsageError(`No machine on your ADE account is called "${query}". ade machines list --text names them.`);
}

/* ── one device per kind and source ────────────────────────────────────── */

/** One device of one machine. */
type DeviceEntry = {
  id: string;
  kind: DeviceKind;
  what: string;
  source: "here" | "machine";
  machine: string;
  machineKey: string | null;
  state: string;
  needs: string | null;
  chosen?: boolean;
};

/** A machine whose devices could not be read (offline, no answer, no project there). */
type UnreadMachine = {
  id: null;
  kind: null;
  what: "-";
  source: "machine";
  machine: string;
  machineKey: string;
  state: string;
  needs: null;
};

type DeviceRow = DeviceEntry | UnreadMachine;

type StatusRead = { ok: true; value: JsonObject } | { ok: false; error: string };

/** Whether a holder id is this chat: its own id here, `remote:<device>:<chat>` there. */
function isThisChat(holder: string | null, chat: string | null): boolean {
  if (!holder || !chat) return false;
  return holder === chat || holder.endsWith(`:${chat}`);
}

function inUseBy(holder: string | null, chat: string | null): string {
  return isThisChat(holder, chat) ? "in use by this chat" : "in use by a chat";
}

function missingThere(here: boolean, what: string): string {
  return here ? `${what} missing` : `${what} missing there`;
}

/** The row for one kind, from that machine's status read. */
function deviceRow(
  kind: DeviceKind,
  read: StatusRead,
  where: { here: boolean; machine: string; machineKey: string | null; idSource: string; platform: string | null },
  chat: string | null,
): DeviceEntry {
  const base: Pick<DeviceEntry, "id" | "kind" | "source" | "machine" | "machineKey"> = {
    id: formatDeviceId({ kind, source: where.here ? { kind: "here" } : { kind: "machine", machine: where.idSource } }),
    kind,
    source: where.here ? "here" : "machine",
    machine: where.machine,
    machineKey: where.machineKey,
  };
  if (!read.ok) {
    return { ...base, what: DEVICE_KIND_NOUN[kind], state: "unknown", needs: firstSentence(read.error) };
  }
  const status = read.value;
  if (kind === "ios") {
    const device = isRecord(status.activeDevice) ? status.activeDevice : null;
    const session = isRecord(status.activeSession) ? status.activeSession : null;
    const remoteHolder = isRecord(status.remoteHolder) ? status.remoteHolder : null;
    const name = asString(device?.name) ?? asString(session?.deviceName);
    const tools = Array.isArray(status.tools) ? status.tools.filter(isRecord) : [];
    const missing = tools.filter((tool) => tool.available === false && (tool.name === "xcrun" || tool.name === "xcodebuild"));
    const state = status.supported === false
      ? "can't run"
      : session
        ? remoteHolder ? `in use by a chat on ${asString(remoteHolder.machineName) ?? "another machine"}` : inUseBy(asString(session.chatSessionId), chat)
        : asString(device?.state)?.toLowerCase() === "booted" ? "on" : "off";
    return {
      ...base,
      what: name ? `${name} simulator` : "iPhone simulator",
      state,
      needs: missing.length ? missingThere(where.here, "Xcode") : null,
    };
  }
  if (kind === "android") {
    const lane = isRecord(status.lane) ? status.lane : null;
    const avd = lane && isRecord(lane.avd) ? lane.avd : null;
    const device = lane && isRecord(lane.device) ? lane.device : null;
    const avdName = asString(avd?.displayName) ?? asString(avd?.name) ?? asString(device?.avdName);
    const sdk = isRecord(status.sdk) ? status.sdk : null;
    const laneState = asString(lane?.state);
    const state = status.platformSupported === false
      ? "can't run"
      : laneState === "booted" || laneState === "starting" ? "on" : laneState === "crashed" ? "crashed" : "off";
    return {
      ...base,
      what: avdName ? `Android emulator · ${avdName}` : "Android emulator",
      state,
      needs: status.platformSupported === false
        ? asString(status.unsupportedReason) ?? "this machine can't run the Android emulator"
        : sdk && sdk.found === false ? missingThere(where.here, "Android SDK") : null,
    };
  }
  if (kind === "screen") {
    const platform = asString(status.platform) ?? where.platform;
    const lease = isRecord(status.lease) ? status.lease : null;
    const linux = isRecord(status.linuxDesktop) ? status.linuxDesktop : null;
    const missing = linux && Array.isArray(linux.missing) ? linux.missing.filter((name) => typeof name === "string") : [];
    const state = status.supported === false && !missing.length
      ? "can't run"
      : lease ? inUseBy(asString(lease.holderId), chat) : status.display ? "on" : "off";
    return {
      ...base,
      what: desktopProductName(remoteMachineHostPlatform(platform)),
      state,
      needs: missing.length
        ? missingThere(where.here, "screen packages")
        : status.supported === false ? firstSentence(asString(status.unsupportedReason) ?? "not supported") : null,
    };
  }
  const session = isRecord(status.activeSession) ? status.activeSession : null;
  const live = session && !["exited", "stopped", "failed"].includes(asString(session.status) ?? "");
  return {
    ...base,
    what: session && asString(session.label) ? `App Control · ${asString(session.label)}` : "App Control",
    state: status.supported === false ? "can't run" : live ? inUseBy(asString(session?.chatSessionId), chat) : "off",
    needs: null,
  };
}

function firstSentence(text: string): string {
  const line = text.split("\n")[0]!.trim();
  const end = line.search(/\.(\s|$)/);
  return end > 0 ? line.slice(0, end) : line;
}

/**
 * The status reads of `kinds` on one machine, each through the device
 * command's own `status` plan (here, or `--machine` there: the same path
 * every device command takes). A failed read is that kind's answer.
 */
async function readStatuses(kinds: readonly DeviceKind[], options: GlobalOptions): Promise<Map<DeviceKind, StatusRead>> {
  const reads = await Promise.all(kinds.map(async (kind): Promise<[DeviceKind, StatusRead]> => {
    const build = () => buildCliPlan([DEVICE_KIND_COMMAND[kind], "status"], options);
    // This shell's lane is a lane here; a plan for another machine must not name it.
    const plan = options.machine ? withoutShellLane(build) : build();
    if (plan.kind !== "execute") return [kind, { ok: false, error: "no status read" }];
    try {
      const value = unwrapActionEnvelope(await executePlan({ ...plan, shapeResult: (values) => values.result ?? values.status }, options));
      return [kind, isRecord(value) ? { ok: true, value } : { ok: false, error: "no status in the answer" }];
    } catch (error) {
      return [kind, { ok: false, error: errorText(error) }];
    }
  }));
  return new Map(reads);
}

type DevicesList = { devices: DeviceRow[]; notes: string[]; chosen: ChatDeviceSources | null };

async function listDevices(options: GlobalOptions, only: DeviceKind | null): Promise<DevicesList> {
  const chat = chatIdentity();
  const notes: string[] = [];
  const kindsFor = (platform: string | null) => DEVICE_KINDS.filter((kind) => (!only || kind === only) && deviceKindRunsOnPlatform(kind, platform));
  // Under ADE MCP the app picks the machine itself; the list is this machine's.
  const roster: Roster = underRemoteMcp() ? { machines: [], note: null } : await readRoster(options, true);
  if (roster.note) notes.push(roster.note);
  const self = roster.machines.find((machine) => machine.isThisMachine) ?? null;
  const hereName = self?.name ?? os.hostname();
  const others = roster.machines.filter((machine) => !machine.isThisMachine);
  // A device id names a machine by its name; two machines with one name by
  // key. Counted over the whole roster, this machine too: `devices use`
  // matches a name against all of it.
  const nameCount = new Map<string, number>();
  for (const machine of roster.machines) nameCount.set(machine.name.toLowerCase(), (nameCount.get(machine.name.toLowerCase()) ?? 0) + 1);
  const idSourceOf = (machine: RosterMachine) => (nameCount.get(machine.name.toLowerCase()) ?? 0) > 1 ? machine.key : machine.name;
  const localIdentity = (() => {
    try {
      return gitRemoteIdentity(getGitRemote(resolveRoots(options).projectRoot));
    } catch {
      return null;
    }
  })();
  const single = thisMachineOnly(options);
  const choicePromise: Promise<ChatDeviceSources | null> = chat && !isAgentCliTerminal(chat)
    ? callChatDeviceAction(single, "getDeviceSources", {}, CHOICE_READ_TIMEOUT_MS).catch(() => null)
    : Promise.resolve(null);

  const hereRows = (async (): Promise<DeviceRow[]> => {
    const kinds = kindsFor(process.platform);
    // A live brain only: a status read must never start an in-process one per kind.
    const reads = await readStatuses(kinds, { ...single, requireSocket: true });
    return kinds.map((kind) => deviceRow(kind, reads.get(kind)!, {
      here: true, machine: `${hereName} (here)`, machineKey: self?.key ?? null, idSource: "here", platform: process.platform,
    }, chat));
  })();

  const machineRows = others.map(async (machine): Promise<DeviceRow[]> => {
    const unavailable = (state: string): UnreadMachine[] => [{
      id: null, kind: null, what: "-", source: "machine", machine: machine.name, machineKey: machine.key, state, needs: null,
    }];
    const kinds = kindsFor(machine.platform);
    if (!kinds.length) return [];
    if (!machine.online) {
      return unavailable(`offline${machine.lastSeenAt ? ` (last seen ${new Date(machine.lastSeenAt).toLocaleString()})` : ""}`);
    }
    // Which project there answers: this repository's checkout, else the one
    // opened most recently (the devices are the machine's; your code is not).
    let machineProject: string | null = null;
    let repoMissing = false;
    if (machine.projects) {
      const live = machine.projects.filter((project) => project.exists !== false);
      const repo = localIdentity ? live.find((project) => asString(project.origin) === localIdentity) : undefined;
      if (!repo) {
        const latest = [...live].sort((a, b) => Number(b.lastOpenedAt ?? 0) - Number(a.lastOpenedAt ?? 0))[0];
        const projectId = latest ? asString(latest.projectId) : null;
        if (!projectId) return unavailable("no project open in ADE there, so its devices can't be read");
        machineProject = projectId;
        // With no origin here, nobody can tell whether the repository is there.
        repoMissing = localIdentity != null;
      }
    }
    let reads: Map<DeviceKind, StatusRead>;
    try {
      reads = await withTimeout(
        readStatuses(kinds, { ...single, machine: machine.key, machineProject, timeoutMs: MACHINE_READ_TIMEOUT_MS }),
        MACHINE_READ_TIMEOUT_MS + 2_000,
        machine.name,
      );
    } catch (error) {
      return unavailable(`did not answer: ${firstSentence(errorText(error))}`);
    }
    // One sentence that is the machine's, not a device's (an older ADE there,
    // no route): one row, not one per kind.
    const failures = [...reads.values()].filter((read): read is { ok: false; error: string } => !read.ok);
    if (failures.length === kinds.length && new Set(failures.map((read) => read.error)).size === 1) {
      return unavailable(`did not answer: ${firstSentence(failures[0]!.error)}`);
    }
    return kinds.map((kind) => {
      const row = deviceRow(kind, reads.get(kind)!, {
        here: false, machine: machine.name, machineKey: machine.key, idSource: idSourceOf(machine), platform: machine.platform,
      }, chat);
      if (repoMissing && row.state !== "can't run") {
        row.needs = row.needs ? `${row.needs}; repository missing there: --clone` : "repository missing there: --clone";
      }
      return row;
    });
  });

  const [here, ...there] = await Promise.all([hereRows, ...machineRows]);
  const chosen = await choicePromise;
  const devices = [...here!, ...there.flat()].map((row) => {
    const choice = row.kind ? chosen?.[row.kind] : undefined;
    const picked = row.kind != null && (choice ? row.machineKey === choice.machineKey && row.source === "machine" : row.source === "here");
    // Marked only when the choice was read: an older brain keeps none.
    return chat && chosen && picked ? { ...row, chosen: true } : row;
  });
  // The ADE Cloud iPhone joins the list once an account has it; none does yet.
  return { devices, notes, chosen };
}

function formatDevicesList(value: DevicesList): string {
  const table = renderTable(
    ["id", "what", "state", "needs"],
    value.devices.map((row) => [
      row.id ? `${row.chosen ? "* " : ""}${row.id}` : row.machine,
      row.what,
      row.state,
      row.needs ?? "",
    ]),
    "ADE devices\n(no devices)",
    { fullColumns: ["id", "state"] },
  );
  const footer = [
    ...value.notes,
    value.devices.some((row) => row.id !== null && row.chosen) ? "* this chat's device for that kind." : null,
    underRemoteMcp() ? MCP_DEVICE_HINT : "Pick one for this chat: ade devices use <id>. One command: --machine <name>.",
  ].filter(Boolean).join("\n");
  return `${table}\n${footer}\n`;
}

/* ── the command ───────────────────────────────────────────────────────── */

/**
 * The chat whose choice `use` and `current` keep, or a refusal: a terminal
 * with no chat, or an agent CLI in a terminal, keeps none. (An ADE MCP app
 * never gets here: its command check refuses `devices use`.)
 */
function choiceChat(): { chat: string } | { refusal: string } {
  const chat = chatIdentity();
  if (!chat) {
    return { refusal: "ade devices use keeps a choice for a chat, and this terminal has no chat (ADE_CHAT_SESSION_ID is not set). Name the machine on each command instead: --machine <name>." };
  }
  return isAgentCliTerminal(chat) ? { refusal: AGENT_CLI_KEEPS_NO_CHOICE } : { chat };
}

async function useDevice(options: GlobalOptions, typed: string): Promise<{ value: JsonObject; text: string }> {
  const owner = choiceChat();
  if ("refusal" in owner) throw new CliUsageError(owner.refusal);
  if (!typed.trim()) throw new CliUsageError("ade devices use <kind>@<source>, e.g. ade devices use \"ios@MacBook Pro\" (ade devices --text lists them).");
  const parsed = parseDeviceId(typed);
  if (!parsed.ok) throw new CliUsageError(parsed.error);
  const { kind, source } = parsed.id;
  const single = thisMachineOnly(options);
  if (source.kind === "cloud") {
    const id = formatDeviceId(parsed.id);
    throw new CliToolError(kind === "ios" ? ADE_CLOUD_IPHONE_UNAVAILABLE : `ADE Cloud has no ${DEVICE_KIND_NOUN[kind]}; ${id} is not a device.`, { id });
  }
  let target: RosterMachine | null = null;
  if (source.kind === "machine") {
    const roster = await readRoster(single, false);
    if (!roster.machines.length) throw new CliUsageError(roster.note ?? "No machines on your ADE account answered.");
    const machine = matchMachine(roster.machines, source.machine);
    if (!machine.isThisMachine) target = machine;
  }
  if (target && !deviceKindRunsOnPlatform(kind, target.platform)) {
    throw new CliUsageError(`${target.name} can't run an ${DEVICE_KIND_NOUN[kind]}: they run on a Mac. ade devices --kind ${kind} --text lists the ones you can use.`);
  }
  const sources = await chatDeviceAction(single, "setDeviceSource", {
    kind,
    source: target ? { kind: "machine", machineKey: target.key, machineName: target.name } : { kind: "here" },
  });
  const command = DEVICE_KIND_COMMAND[kind];
  const noun = DEVICE_KIND_NOUN[kind];
  const text = target
    ? `This chat's ${noun} is on ${target.name} from now on: ade ${command} … goes there with no other flag.`
      + `${target.online ? "" : ` ${target.name} is offline right now.`} ade devices use ${kind}@here brings it back.`
    : `This chat's ${noun} is on this machine.`;
  const id = formatDeviceId({ kind, source: target ? { kind: "machine", machine: target.name } : { kind: "here" } });
  return { value: { ok: true, id, sources }, text };
}

async function currentDevices(options: GlobalOptions): Promise<{ value: JsonObject; text: string }> {
  const owner = choiceChat();
  if ("refusal" in owner) {
    const text = underRemoteMcp()
      ? `An ADE MCP app keeps no device choice: the devices are those of the machine the tool's \`machine\` input picks. ${MCP_DEVICE_HINT}`
      : "This terminal keeps no device choice, so its devices are this machine's unless a command names --machine <name>.";
    return { value: { chat: null, sources: {} }, text };
  }
  const sources = await chatDeviceAction(thisMachineOnly(options), "getDeviceSources", {});
  const table = renderTable(
    ["kind", "device", "since"],
    DEVICE_KINDS.map((kind) => {
      const choice = sources[kind];
      const id = formatDeviceId({ kind, source: choice ? { kind: "machine", machine: choice.machineName } : { kind: "here" } });
      return [kind, id, choice ? new Date(choice.chosenAt).toLocaleString() : ""];
    }),
    "This chat's devices",
  );
  return { value: { chat: owner.chat, sources }, text: `${table}\nChange one: ade devices use <kind>@<machine|here>.\n` };
}

export async function runDevicesCommand(parsed: ParsedCli): Promise<{ output: string; exitCode: number }> {
  const options = parsed.options;
  if (options.machine || options.allMachines) {
    throw new CliUsageError("ade devices already lists every machine; leave out --machine.");
  }
  // Global flags are already out of the command here.
  const { sub, first, rest, kind, otherFlags } = devicesSubcommand(parsed.command.slice(1));
  if (otherFlags.length) throw new CliUsageError(`ade devices does not take ${otherFlags[0]}. ade devices --help shows its options.`);
  const print = (value: unknown, text: string) => (options.text ? `${text.endsWith("\n") ? text : `${text}\n`}` : formatOutput(value, options, undefined));
  if (sub === "use") {
    if (kind) throw new CliUsageError("ade devices use takes one device id, e.g. ade devices use android@here.");
    const result = await useDevice(options, rest.join(" "));
    return { output: print(result.value, result.text), exitCode: 0 };
  }
  if (sub === "current") {
    const result = await currentDevices(options);
    return { output: print(result.value, result.text), exitCode: 0 };
  }
  if (sub === null || rest.length) {
    throw new CliUsageError(`ade devices: unknown command "${sub === null ? first : rest[0]}". Use ade devices [--kind <kind>], use <id> or current.`);
  }
  const only = kind == null ? null : kind.trim().toLowerCase();
  if (only !== null && !isDeviceKind(only)) {
    throw new CliUsageError(`--kind takes ${DEVICE_KINDS.join(", ")}.`);
  }
  const value = await listDevices(options, only);
  return { output: print(value, formatDevicesList(value)), exitCode: 0 };
}
