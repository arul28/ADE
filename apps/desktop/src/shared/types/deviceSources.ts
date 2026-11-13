/* ──────────────────────────────────────────────────────────────────────────
   DEVICES AND WHERE THEY COME FROM.

   A device is something an agent drives and watches: an iPhone simulator, an
   Android emulator, a screen (Mac, Windows or Linux Desktop), an app under
   App Control. Its source is where it runs: here (this machine), another
   machine on the account, or ADE Cloud (a cloud iPhone, reserved: none is on
   any account yet). A device id is `<kind>@<source>`: `ios@here`,
   `android@Windows PC`, `screen@build-box`, later `ios@cloud`.

   `ade devices` lists ids, `ade devices use <id>` keeps a chat's choice per
   kind (in the chat's own persisted state, see agentChatService), and the
   device commands follow that choice the way `--machine` does.
   See docs/features/sync-and-multi-device/devices-and-machines.md.
   ────────────────────────────────────────────────────────────────────────── */

import { remoteMachineHostPlatform } from "../machineIdentity";

export const DEVICE_KINDS = ["ios", "android", "screen", "app"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export type DeviceSource =
  | { kind: "here" }
  | { kind: "machine"; machine: string }
  | { kind: "cloud" };

export type DeviceId = { kind: DeviceKind; source: DeviceSource };

/** The `ade` command that drives each kind. */
export const DEVICE_KIND_COMMAND: Readonly<Record<DeviceKind, string>> = {
  ios: "apple",
  android: "android",
  screen: "screen",
  app: "app-control",
};

/** What each kind is called in prose. */
export const DEVICE_KIND_NOUN: Readonly<Record<DeviceKind, string>> = {
  ios: "iPhone simulator",
  android: "Android emulator",
  screen: "screen",
  app: "App Control",
};

/** The source word for this machine, and for ADE Cloud. */
export const DEVICE_SOURCE_HERE = "here";
export const DEVICE_SOURCE_CLOUD = "cloud";

export const ADE_CLOUD_IPHONE_UNAVAILABLE = "ADE Cloud iPhone is not on this account yet.";

export function isDeviceKind(value: unknown): value is DeviceKind {
  return typeof value === "string" && (DEVICE_KINDS as readonly string[]).includes(value);
}

/**
 * Whether a machine on this platform can run the kind. The platform is read by
 * {@link remoteMachineHostPlatform} (a Node platform or the account
 * directory's spelling); an unknown one says yes, and the machine answers for
 * itself.
 */
export function deviceKindRunsOnPlatform(kind: DeviceKind, platform: string | null | undefined): boolean {
  if (kind !== "ios") return true;
  const host = remoteMachineHostPlatform(platform);
  return host === null || host === "darwin";
}

export type DeviceIdParse = { ok: true; id: DeviceId } | { ok: false; error: string };

/**
 * `<kind>@<source>`. The kind is one of `ios`, `android`, `screen`, `app`
 * (any case); the source is `here`, `cloud`, or a machine's name or key
 * (everything after the first `@`, so a name may hold one).
 */
export function parseDeviceId(text: string): DeviceIdParse {
  const value = text.trim();
  const at = value.indexOf("@");
  const usage = `A device id is <kind>@<source>: ${DEVICE_KINDS.join(", ")} @ here, a machine's name, or cloud (e.g. "ios@MacBook Pro").`;
  if (at <= 0) return { ok: false, error: `"${value}" is not a device id. ${usage}` };
  const kind = value.slice(0, at).trim().toLowerCase();
  const source = value.slice(at + 1).trim();
  if (!isDeviceKind(kind)) return { ok: false, error: `"${kind}" is not a device kind. ${usage}` };
  if (!source) return { ok: false, error: `"${value}" names no source. ${usage}` };
  const word = source.toLowerCase();
  if (word === DEVICE_SOURCE_HERE) return { ok: true, id: { kind, source: { kind: "here" } } };
  if (word === DEVICE_SOURCE_CLOUD) return { ok: true, id: { kind, source: { kind: "cloud" } } };
  return { ok: true, id: { kind, source: { kind: "machine", machine: source } } };
}

/**
 * How a device id names a machine: its name, or its key when the name is a
 * source word (`here`, `cloud`), which {@link parseDeviceId} would read as
 * this machine or ADE Cloud.
 */
export function deviceIdMachineSource(machine: { name: string; key: string }): string {
  const word = machine.name.trim().toLowerCase();
  return word === DEVICE_SOURCE_HERE || word === DEVICE_SOURCE_CLOUD ? machine.key : machine.name;
}

export function formatDeviceId(id: DeviceId): string {
  const source = id.source.kind === "machine" ? id.source.machine : id.source.kind === "here" ? DEVICE_SOURCE_HERE : DEVICE_SOURCE_CLOUD;
  return `${id.kind}@${source}`;
}

/** `ade devices` subcommands, by the words that name them. */
const DEVICES_SUBCOMMANDS: Readonly<Record<string, "list" | "use" | "current">> = {
  list: "list",
  ls: "list",
  use: "use",
  current: "current",
};

export type DevicesSubcommand = {
  /** The subcommand: `list` when no word names one; null when the first word is not one. */
  sub: "list" | "use" | "current" | null;
  /** The first word as typed (lower case), or null. */
  first: string | null;
  /** The words after the subcommand (all of them for a list with no `list` word). */
  rest: string[];
  /** `--kind`'s value, or null. */
  kind: string | null;
  /** Every other flag, as typed. */
  otherFlags: string[];
};

/**
 * The words of `ade devices …` after the command word: the subcommand, its
 * other words and `--kind`. The CLI and ADE MCP's command check both read
 * it, so they never disagree on what a call does.
 */
export function devicesSubcommand(args: readonly string[]): DevicesSubcommand {
  const words: string[] = [];
  const otherFlags: string[] = [];
  let kind: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--kind") {
      kind = args[index + 1] ?? "";
      index += 1;
    } else if (token.startsWith("--kind=")) {
      kind = token.slice("--kind=".length);
    } else if (token.startsWith("-")) {
      otherFlags.push(token);
    } else {
      words.push(token);
    }
  }
  const first = words[0]?.toLowerCase() ?? null;
  if (first === null) return { sub: "list", first, rest: [], kind, otherFlags };
  const sub = Object.hasOwn(DEVICES_SUBCOMMANDS, first) ? DEVICES_SUBCOMMANDS[first]! : null;
  return { sub, first, rest: words.slice(1), kind, otherFlags };
}

/**
 * A chat's chosen source for one kind, as its brain keeps it. Only another
 * machine is stored: `here` is no entry, and the cloud source is reserved.
 * The key routes; the name is what the chat is shown.
 */
export type ChatDeviceSourceChoice = {
  kind: "machine";
  machineKey: string;
  machineName: string;
  chosenAt: string;
};

export type ChatDeviceSources = Partial<Record<DeviceKind, ChatDeviceSourceChoice>>;

/** `chat.getDeviceSources` / `chat.setDeviceSource` answer. */
export type ChatDeviceSourcesResult = {
  sessionId: string;
  sources: ChatDeviceSources;
};

export type ChatSetDeviceSourceArgs = {
  sessionId: string;
  kind: DeviceKind;
  /** `here` clears the kind's choice. */
  source: { kind: "here" } | { kind: "machine"; machineKey: string; machineName: string };
};

/** A stored record read back: unknown kinds and malformed entries are dropped. */
export function normalizeChatDeviceSources(value: unknown): ChatDeviceSources | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: ChatDeviceSources = {};
  for (const [kind, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isDeviceKind(kind) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const machineKey = typeof record.machineKey === "string" ? record.machineKey.trim() : "";
    const machineName = typeof record.machineName === "string" ? record.machineName.trim() : "";
    if (record.kind !== "machine" || !machineKey) continue;
    out[kind] = {
      kind: "machine",
      machineKey,
      machineName: machineName || machineKey,
      chosenAt: typeof record.chosenAt === "string" ? record.chosenAt : new Date(0).toISOString(),
    };
  }
  return Object.keys(out).length ? out : undefined;
}
