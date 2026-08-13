import {
  isPluginHostCapabilityErrorCode,
  type PluginFilePickerOptions,
  type PluginHostCapabilityErrorCode,
  type PluginNotificationTarget,
} from "../../../../desktop/src/shared/plugins/sdk";

/**
 * The Electron-only half of the plugin SDK, as a hop between the daemon and the
 * desktop.
 *
 * Plugin children run inside the runtime daemon, which is an ordinary Node
 * process: it has no clipboard, no file picker and no notification centre,
 * because all three are Electron APIs that exist only in the desktop's main
 * process. So these verbs travel the same side-channel socket `built_in_browser`
 * and `audio.captureClip` already use (`<adeHome>/sock/desktop-bridge.sock`) —
 * see `desktopBridgeServer.ts` for the server that hosts all of them.
 *
 * This module is the shared half: the method names, the payload shapes and the
 * error encoding, imported by BOTH ends so a rename cannot land on one side.
 */

export const DESKTOP_CLIPBOARD_READ_METHOD = "clipboard.read";
export const DESKTOP_CLIPBOARD_WRITE_METHOD = "clipboard.write";
export const DESKTOP_PICK_FILE_METHOD = "dialogs.pickFile";
export const DESKTOP_NOTIFY_METHOD = "notifications.post";

export const DESKTOP_HOST_BRIDGE_METHODS = [
  DESKTOP_CLIPBOARD_READ_METHOD,
  DESKTOP_CLIPBOARD_WRITE_METHOD,
  DESKTOP_PICK_FILE_METHOD,
  DESKTOP_NOTIFY_METHOD,
] as const;

export type DesktopHostBridgeMethod = (typeof DESKTOP_HOST_BRIDGE_METHODS)[number];

export function isDesktopHostBridgeMethod(method: string): method is DesktopHostBridgeMethod {
  return DESKTOP_HOST_BRIDGE_METHODS.some((known) => known === method);
}

export type DesktopClipboardReadResponse = { text: string };

export type DesktopClipboardWriteRequest = { text: string };

export type DesktopPickFileRequest = {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
};

export type DesktopPickFileResponse = { filePath: string };

/**
 * A notification the desktop shows, already attributed.
 *
 * `requesterLabel` is the plugin's own `displayName` as the SDK server resolved
 * it, never a string the plugin passed in — the same rule the audio pill
 * follows, for the same reason. The desktop decides how to render the
 * attribution, because only it knows which platform it is on: macOS puts it in
 * the notification's subtitle, and platforms with no subtitle fold it into the
 * title instead. Deciding that here would mean the daemon guessing at the
 * desktop's OS.
 */
export type DesktopNotifyRequest = {
  title: string;
  body?: string;
  requesterLabel?: string;
};

export type DesktopNotifyResponse = { shown: boolean };

/**
 * How long one bridge call may take.
 *
 * A file picker is a modal the user may leave open while they go and find
 * something, so it gets its own generous budget; the others are interactions
 * that should answer in milliseconds and share the bridge's ordinary one. A
 * single ceiling would either hang the plugin on a wedged clipboard or expire a
 * picker the user was still using.
 */
export const DESKTOP_PICK_FILE_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Carry the SDK's error code in the message.
 *
 * Identical convention (and identical reason) to
 * `encodeDesktopAudioCaptureError`: `JsonRpcClient.handleResponse` rebuilds a
 * rejection as `new Error(response.error.message)` and drops the JSON-RPC
 * `data` field entirely, so a code put anywhere but the message does not
 * survive the hop, and a plugin branching on `dialog_cancelled` would see a
 * generic bridge failure instead.
 */
export function encodeDesktopHostError(code: PluginHostCapabilityErrorCode, message: string): string {
  return `${code}: ${message}`;
}

export function decodeDesktopHostError(
  raw: string,
): { code: PluginHostCapabilityErrorCode; message: string } | null {
  const separator = raw.indexOf(": ");
  if (separator <= 0) return null;
  const code = raw.slice(0, separator);
  if (!isPluginHostCapabilityErrorCode(code)) return null;
  return { code, message: raw.slice(separator + 2) };
}

/**
 * How much of a requester's name a notification is given.
 *
 * The label is a plugin's own `displayName`, which the manifest parser accepts
 * at any length — so this is the one place between a third party's JSON file
 * and a string rendered in the user's notification centre where that is
 * bounded. A name longer than this is a plugin trying to own the notification,
 * not a plugin with a long name.
 */
export const DESKTOP_NOTIFY_REQUESTER_LABEL_MAX_CHARS = 48;

export type { PluginFilePickerOptions, PluginNotificationTarget };
