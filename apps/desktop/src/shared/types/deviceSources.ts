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

export const DEVICE_KINDS = ["ios", "android", "screen", "app"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export type DeviceSource =
  | { kind: "here" }
  | { kind: "machine"; machine: string }
  | { kind: "cloud" };

export type DeviceId = { kind: DeviceKind; source: DeviceSource };

/** The action domain that drives each kind. */
export const DEVICE_KIND_DOMAIN = {
  ios: "ios_simulator",
  android: "android_emulator",
  screen: "mac_desktop",
  app: "app_control",
} as const satisfies Record<DeviceKind, string>;

export type DeviceDomain = (typeof DEVICE_KIND_DOMAIN)[DeviceKind];

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

/** The kind a domain drives, or null for any other domain. */
export function deviceKindForDomain(domain: string): DeviceKind | null {
  for (const kind of DEVICE_KINDS) if (DEVICE_KIND_DOMAIN[kind] === domain) return kind;
  return null;
}

/**
 * Whether a machine on this platform can run the kind. The platform is a Node
 * platform or the account directory's spelling ("macos", "windows"); unknown
 * says yes, and the machine answers for itself.
 */
export function deviceKindRunsOnPlatform(kind: DeviceKind, platform: string | null | undefined): boolean {
  if (kind !== "ios") return true;
  const value = platform?.trim().toLowerCase() ?? "";
  if (!value) return true;
  return value === "darwin" || value === "macos" || value === "mac";
}

/** The product name of the screen on a platform: Mac Desktop, Windows Desktop or Linux Desktop. */
export function screenProductName(platform: string | null | undefined): string {
  const value = platform?.trim().toLowerCase() ?? "";
  if (value === "win32" || value === "windows") return "Windows Desktop";
  if (value === "linux") return "Linux Desktop";
  return "Mac Desktop";
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

export function formatDeviceSource(source: DeviceSource): string {
  if (source.kind === "here") return DEVICE_SOURCE_HERE;
  if (source.kind === "cloud") return DEVICE_SOURCE_CLOUD;
  return source.machine;
}

export function formatDeviceId(id: DeviceId): string {
  return `${id.kind}@${formatDeviceSource(id.source)}`;
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
